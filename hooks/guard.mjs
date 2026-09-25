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

// 프로세스가 시작된 시점. 안전 타이머(아래 writeAndExit)를 여기서부터 재서, 도구
// 로딩에 시간이 걸려도 전체 실행이 훅 제한 시간(5초) 안에 들도록 한다.
const PROCESS_START = Date.now();

// lib/ 안의 파일은 정적 import 를 쓰지 않는다. 설치가 깨져 그중 하나라도
// 없거나 문법 오류가 있으면, 정적 import 는 이 파일을 불러오는 시점에 바로
// 던져서 아래 try/catch 를 거치지 못하고 스택 트레이스와 함께 종료 코드 1로
// 끝난다(불변식 1 위반). 동적 import 로 감싸 try/catch 안에서만 실패하게 한다.
//
// pii.mjs 는 따로, 가장 먼저 불러온다. 말투 쪽(artifact.mjs → particle/lint/rules/segment)이
// 깨져도 주민등록번호 차단(불변식 2)은 살아있어야 한다 — 개인정보 검사가 말투 검사의
// 성공에 기대면 안 된다.

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
function checkPii(pii, toolName, toolInput) {
  const mode = process.env.KIMCHI_PII ?? "block";
  if (mode === "off") return null;

  const targets = pii.extractPiiTargets(toolName, toolInput);
  const found = targets.flatMap((target) =>
    pii.findResidentNumbers(target.text, { pathOnly: target.kind === "path" }).map((hit) => ({
      ...hit,
      label: target.label,
      kind: target.kind,
      editIndex: target.editIndex,
    }))
  );
  if (found.length === 0) return null;

  // 대상 이름(파일 경로)에도 번호가 실려 올 수 있다 — 메시지가 그대로 유출 경로가
  // 되지 않도록 가린다. label 은 항상 경로이거나("명령"처럼) 대시 형태가 아니면
  // 애초에 안 걸리는 짧은 문자열이라 pathOnly 규칙을 그대로 써도 안전하다.
  const label = pii.redactText(found[0].label, { pathOnly: true });
  return { message: pii.formatLeak(found, label), block: mode !== "warn" };
}

/**
 * 말투 검사. 이 훅 단계에서 할 일이 없으면 null.
 */
function checkTone(libs, event, toolName, toolInput) {
  const { looksKorean, artifact } = libs;
  // 기본 설정에서 PreToolUse 는 아무 일도 하지 않는다. 규칙을 읽기 전에 빠져나간다.
  if (event === "PreToolUse" && !artifact.autofixEnabled() && !artifact.blockEnabled()) return null;

  const targets = artifact.extractTargets(toolName, toolInput).filter((target) => looksKorean(target.text));
  if (targets.length === 0) return null;

  const rules = artifact.loadToneRules();
  if (rules.length === 0) return null;

  return event === "PreToolUse"
    ? artifact.autofixOrBlock(toolName, toolInput, targets, rules)
    : artifact.warnAboutTone(targets, rules);
}

/**
 * @returns {string|undefined} 내보낼 JSON 문자열. 낼 것이 없으면 undefined.
 */
async function main() {
  if (process.env.KIMCHI_DISABLE === "1") return undefined;

  const raw = readStdin();
  if (!raw.trim()) return undefined;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const { tool_name: toolName, hook_event_name: event, tool_input: toolInput } = payload ?? {};
  if (!toolName || !event) return undefined;

  // 개인정보 검사는 그 자체로 완결돼야 한다. pii.mjs 만 불러온다 — 여기서 던지면(모듈이
  // 없거나 깨졌으면) main() 전체가 던지고 run() 이 조용히 종료한다. 그 이상은 못 한다.
  const pii = await import("./lib/pii.mjs");
  const piiResult = event === "PreToolUse" ? checkPii(pii, toolName, toolInput) : null;

  // 차단이 이긴다. 주민등록번호가 들어 있으면 말투는 따질 일이 아니다.
  if (piiResult?.block) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: piiResult.message,
      },
    });
  }

  // 말투 검사는 따로 불러온다. 이 체인이 깨져도(예: particle.mjs 문법 오류) 이미 정해진
  // 개인정보 결과는 그대로 살려서 내보낸다 — 말투 부가 기능 하나 때문에 경고까지 잃지 않는다.
  let tone = null;
  try {
    const [{ looksKorean }, artifact] = await Promise.all([
      import("./lib/detect.mjs"),
      import("./lib/artifact.mjs"),
    ]);
    tone = checkTone({ looksKorean, artifact }, event, toolName, toolInput);
  } catch {
    tone = null;
  }

  // 막지 않는 개인정보 경고는 말투 결과에 얹어 함께 내보낸다. 훅은 한 번만 답할 수 있다.
  //
  // 여기서 permissionDecision 을 싣지 않는다. 경고는 "막지 않는다"는 뜻이지 "숨긴다"는
  // 뜻이 아닌데, "allow" 를 실으면 Claude Code 가 사용자의 권한 프롬프트를 건너뛴다
  // ("Hook approved tool use ... bypassing permission prompt", 2.1.282 실측). 결정은 정상
  // 권한 파이프라인에 맡기고, systemMessage(사용자)와 additionalContext(모델) 로만 알린다.
  if (piiResult !== null && tone === null) {
    return JSON.stringify({
      systemMessage: piiResult.message,
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: piiResult.message },
    });
  }
  if (tone === null) return undefined;

  if (piiResult !== null) {
    tone.systemMessage = [piiResult.message, tone.systemMessage].filter(Boolean).join("\n\n");
    // 말투 쪽 결과(차단이든 자동 교정이든)에도 개인정보 경고를 꽂는다. additionalContext 는
    // 결정이 deny 여도 모델에게 전달되므로(2.1.282 실측), 이미 있으면 앞에 붙이고 없으면
    // 새로 만든다 — deny 응답에는 원래 additionalContext 가 없어서 없으면 건너뛰던 것이
    // 차단 + 경고 조합에서 경고를 모델에게서 감추는 버그였다.
    if (tone.hookSpecificOutput) {
      tone.hookSpecificOutput.additionalContext = [piiResult.message, tone.hookSpecificOutput.additionalContext]
        .filter(Boolean)
        .join("\n\n");
    }
  }
  return JSON.stringify(tone);
}

/**
 * stdout 이 파이프일 때 macOS/Linux 는 쓰기가 비동기다. write() 를 fire-and-forget 으로
 * 부르고 바로 exit(0) 하면 OS 파이프 버퍼(64KiB)를 넘는 출력이 잘린다. 콜백을 받아
 * 실제로 다 나간 뒤에만 종료한다.
 *
 * 느린 리더나 막힌 파이프에서 무한히 기다리지 않도록 안전 타이머로 상한을 둔다. 프로세스
 * 시작 시각(PROCESS_START)부터 재서, 그 앞의 동적 import 나 검사에 걸린 시간까지 합쳐
 * 훅 제한 시간(5초)보다 한참 짧게 끝나도록 한다. 타이머가 먼저 울리면 그때까지 파이프에
 * 실제로 들어간 만큼만 나가고 나머지는 버려진다 — 이미 쓴 바이트는 물릴 수 없으니 받아들인다.
 * Claude Code 쪽이 멈춰야만 일어나는 일이고, 그때는 훅이 뭘 하든 5초 뒤 강제 종료된다.
 */
function writeAndExit(json) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    process.exit(0);
  };

  const remaining = Math.max(0, 4000 - (Date.now() - PROCESS_START));
  const timer = setTimeout(finish, remaining);
  timer.unref?.();

  try {
    process.stdout.write(json, () => {
      clearTimeout(timer);
      finish();
    });
  } catch {
    clearTimeout(timer);
    finish();
  }
}

async function run() {
  // 직접 실행될 때만 돈다. entrypoint.mjs 도 동적으로 불러온다 — 설치가
  // 깨져 이 파일조차 없으면 아무 일도 하지 않고 조용히 끝나야 한다.
  try {
    const { isEntrypoint } = await import("./lib/entrypoint.mjs");
    if (!isEntrypoint(import.meta.url)) return;
  } catch {
    return;
  }

  let output;
  try {
    output = await main();
  } catch {
    // 조용히 넘어간다. 훅이 깨져서 작업이 막히면 그것이 더 큰 실패다.
    output = undefined;
  }

  if (!output) {
    process.exit(0);
    return;
  }
  writeAndExit(output);
}

run();
