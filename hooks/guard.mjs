#!/usr/bin/env node
// 산출물 검사의 단일 진입점이다.
//
// 검사가 둘이다. 성격이 정반대라 판정은 따로 두고, **프로세스는 하나로 합친다.**
//
//   개인정보  모든 파일. 기본 차단. 밀어 버린 주민등록번호는 되돌릴 수 없다
//   말투      한국어 문서와 커밋 메시지. 기본 경고. 문체가 작업을 막으면 실패다
//
// 따로 등록하면 도구 호출마다 Node 프로세스가 하나 더 뜬다. 실측 38ms 이고, 기본 설정에서는
// 말투 훅이 PreToolUse 에서 바로 빠져나오므로 그 38ms 가 순수 낭비다.
//
// 합치면서 결정 우선순위도 명시된다. 훅 둘이 각자 permissionDecision 을 돌려줄 때 무엇이
// 이기는지는 정해져 있지 않다. 여기서는 **차단이 이긴다.**
//
// 설정:
//   KIMCHI_DISABLE=1   전부 끈다
//   KIMCHI_PII=warn    주민등록번호를 찾아도 막지 않고 알려만 준다
//   KIMCHI_PII=off     주민등록번호 검사를 끈다
//   KIMCHI_AUTOFIX=1   말투 치환을 자동 교정한다
//   KIMCHI_BLOCK=1     말투 위반이 있으면 막는다

import { readFileSync } from "node:fs";
import { isEntrypoint } from "./lib/entrypoint.mjs";
import { looksKorean } from "./lib/detect.mjs";
import { findResidentNumbers, formatLeak, extractPiiTargets } from "./lib/pii.mjs";
import {
  extractTargets,
  autofixEnabled,
  blockEnabled,
  loadToneRules,
  autofixOrBlock,
  warnAboutTone,
} from "./lib/artifact.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * 주민등록번호 검사. 막을 이유가 있으면 메시지를, 없으면 null 을 돌려준다.
 *
 * @returns {{message: string, block: boolean}|null}
 */
function checkPii(toolName, toolInput) {
  const mode = process.env.KIMCHI_PII ?? "block";
  if (mode === "off") return null;

  const targets = extractPiiTargets(toolName, toolInput);
  const found = targets.flatMap((target) =>
    findResidentNumbers(target.text).map((hit) => ({ ...hit, label: target.label }))
  );
  if (found.length === 0) return null;

  return { message: formatLeak(found, found[0].label), block: mode !== "warn" };
}

/**
 * 말투 검사. 이 훅 단계에서 할 일이 없으면 null.
 */
function checkTone(event, toolName, toolInput) {
  // 기본 설정에서 PreToolUse 는 아무 일도 하지 않는다. 규칙을 읽기 전에 빠져나간다.
  if (event === "PreToolUse" && !autofixEnabled() && !blockEnabled()) return null;

  const targets = extractTargets(toolName, toolInput).filter((target) => looksKorean(target.text));
  if (targets.length === 0) return null;

  const rules = loadToneRules();
  if (rules.length === 0) return null;

  return event === "PreToolUse"
    ? autofixOrBlock(toolName, toolInput, targets, rules)
    : warnAboutTone(targets, rules);
}

function main() {
  if (process.env.KIMCHI_DISABLE === "1") return;

  const raw = readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const { tool_name: toolName, hook_event_name: event, tool_input: toolInput } = payload ?? {};
  if (!toolName || !event) return;

  const pii = event === "PreToolUse" ? checkPii(toolName, toolInput) : null;

  // 차단이 이긴다. 주민등록번호가 들어 있으면 말투는 따질 일이 아니다.
  if (pii?.block) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: pii.message,
        },
      })
    );
    return;
  }

  const tone = checkTone(event, toolName, toolInput);

  // 막지 않는 개인정보 경고는 말투 결과에 얹어 함께 내보낸다. 훅은 한 번만 답할 수 있다.
  if (pii !== null && tone === null) {
    process.stdout.write(
      JSON.stringify({
        systemMessage: pii.message,
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      })
    );
    return;
  }
  if (tone === null) return;

  if (pii !== null) {
    tone.systemMessage = [pii.message, tone.systemMessage].filter(Boolean).join("\n\n");
  }
  process.stdout.write(JSON.stringify(tone));
}

// 직접 실행될 때만 돈다.
if (isEntrypoint(import.meta.url)) {
  try {
    main();
  } catch {
    // 조용히 넘어간다. 훅이 깨져서 작업이 막히면 그것이 더 큰 실패다.
  }
  process.exit(0);
}
