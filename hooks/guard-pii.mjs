#!/usr/bin/env node
// 주민등록번호가 저장소에 남는 것을 막는다.
//
// 말투 린터(guard-artifact.mjs)와 따로 둔 이유가 있다. 세 가지가 다르다.
//
//   대상       말투는 한국어 문서만. 이 훅은 **모든 파일**. 유출은 코드와 시험 자료에서 난다
//   기본값     말투는 경고. 이 훅은 **차단**. 밀어 버린 번호는 커밋을 지워도 사라지지 않는다
//   되돌리기   말투는 고치면 된다. 유출은 되돌릴 수 없다
//
// 한 훅에 합치면 어느 한쪽 기본값이 틀린다.
//
// 설정:
//   기본값             위반이 있으면 막는다
//   KIMCHI_PII=warn    막지 않고 알려만 준다
//   KIMCHI_PII=off     아무것도 하지 않는다
//   KIMCHI_DISABLE=1   플러그인 훅 전체를 끈다

import { readFileSync } from "node:fs";
import { findResidentNumbers, formatLeak, GENERATED_FILES } from "./lib/pii.mjs";

// 이 확장자는 검사하지 않는다. 사람이 쓴 것이 아니거나 통째로 생성된 것들이다.
const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|woff2?|ttf|eot|mp[34]|mov|wasm|lock)$/i;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * 검사할 글을 뽑는다. 말투 린터와 달리 확장자를 가리지 않는다.
 *
 * @returns {{label: string, text: string}[]}
 */
export function extractTargets(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];

  if (toolName === "Bash") {
    // 명령 전체를 본다. 커밋 메시지뿐 아니라 heredoc 으로 파일을 만드는 경우도 걸린다.
    const command = toolInput.command;
    return typeof command === "string" ? [{ label: "명령", text: command }] : [];
  }

  const filePath = toolInput.file_path || "";
  if (SKIP_EXTENSIONS.test(filePath) || GENERATED_FILES.test(filePath)) return [];
  const label = filePath || "파일";

  if (toolName === "Write" && typeof toolInput.content === "string") {
    return [{ label, text: toolInput.content }];
  }
  if (toolName === "Edit" && typeof toolInput.new_string === "string") {
    return [{ label, text: toolInput.new_string }];
  }
  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .filter((edit) => typeof edit?.new_string === "string")
      .map((edit) => ({ label, text: edit.new_string }));
  }

  return [];
}

function main() {
  if (process.env.KIMCHI_DISABLE === "1") return;
  const mode = process.env.KIMCHI_PII ?? "block";
  if (mode === "off") return;

  const raw = readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload.tool_name) return;

  const targets = extractTargets(payload.tool_name, payload.tool_input);
  const found = targets.flatMap((target) =>
    findResidentNumbers(target.text).map((hit) => ({ ...hit, label: target.label }))
  );
  if (found.length === 0) return;

  const message = formatLeak(found, found[0].label);

  if (mode === "warn") {
    process.stdout.write(
      JSON.stringify({
        systemMessage: message,
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      })
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    })
  );
}

// 직접 실행될 때만 돈다. 시험에서 불러 쓸 때 프로세스를 끝내 버리면 안 된다.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch {
    // 조용히 넘어간다. 훅이 깨져서 작업이 막히면 그것이 더 큰 실패다.
    //
    // 차단이 기본값인 훅이 오류로 통과시키는 것이 옳은지 고민할 자리다.
    // 그래도 통과시킨다. 훅이 깨진 채로 모든 파일 쓰기가 막히면 아무도 이 플러그인을 쓰지 않고,
    // 그러면 검사도 사라진다. 탐지기는 시험으로 지키고, 실행 실패는 무해하게 둔다.
  }
  process.exit(0);
}
