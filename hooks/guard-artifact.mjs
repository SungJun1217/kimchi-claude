#!/usr/bin/env node
// 저장소에 남는 산출물의 한국어를 검사한다. 커밋 메시지와 한국어 문서 파일이 대상이다.
//
// 이 훅은 말투를 다듬는 부가 기능이고 작업에 필요한 부품이 아니다.
// 그래서 어떤 오류가 나도 조용히 아무 일도 하지 않고 종료 코드 0으로 끝낸다.
// 훅이 깨져서 작업이 막히면 그것이 더 큰 실패다.
//
// 동작 (환경변수로 고른다):
//   기본값            경고만 한다. 클로드가 직접 고치게 맡긴다
//   KIMCHI_AUTOFIX=1  치환 규칙을 PreToolUse에서 자동 교정한다
//   KIMCHI_BLOCK=1    위반이 있으면 PreToolUse에서 막는다
//   KIMCHI_DISABLE=1  아무것도 하지 않는다

import { readFileSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules } from "./lib/rules.mjs";
import { lint, applyFixes, formatFindings } from "./lib/lint.mjs";
import { looksKorean } from "./lib/detect.mjs";
import { isIgnoredFile } from "./lib/segment.mjs";

const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");

// 문서 파일만 본다. 소스 파일을 검사하면 코드 주석까지 건드리게 되고, 그것은 적용 범위 밖이다.
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"]);

/**
 * 파일이 스스로를 검사 예외로 선언했는지 디스크에서 확인한다.
 * 읽을 수 없으면(새 파일 등) 선언이 없는 것으로 본다.
 */
function declaresIgnore(filePath) {
  try {
    return isIgnoredFile(readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * git commit 명령에서 메시지로 보이는 부분을 뽑는다.
 *
 * 클로드는 heredoc으로 여러 줄 메시지를 쓰는 일이 많아 두 형태를 모두 다룬다.
 */
function extractCommitMessages(command) {
  if (typeof command !== "string") return [];
  // 두 낱말을 따로 찾는다. /\bgit\b[\s\S]*\bcommit\b/ 처럼 사이를 탐욕적으로 잡으면
  // git 이 나올 때마다 역추적해서 비용이 이차로 커진다. 132KB 명령에서 1965ms 였다.
  // 순서를 잃지만 뒤의 추출기가 메시지를 못 찾으면 어차피 빈 결과다.
  if (!/\bgit\b/.test(command) || !/\bcommit\b/.test(command)) return [];

  const messages = [];

  const heredoc = /<<-?\s*['"]?(\w+)['"]?\r?\n([\s\S]*?)\r?\n\1\b/g;
  let match;
  while ((match = heredoc.exec(command)) !== null) messages.push(match[2]);

  const flagged = /-m\s+(['"])([\s\S]*?)\1/g;
  while ((match = flagged.exec(command)) !== null) messages.push(match[2]);

  const longForm = /--message[= ]+(['"])([\s\S]*?)\1/g;
  while ((match = longForm.exec(command)) !== null) messages.push(match[2]);

  // -m "$(cat <<'EOF' ... )" 형태에서는 heredoc 본문과 그것을 감싼 덩어리가 둘 다 잡힌다.
  // 같은 내용을 두 번 지적하지 않도록 다른 메시지를 품고 있는 쪽을 버린다.
  const unique = [...new Set(messages.filter((message) => message.trim().length > 0))];
  return unique.filter(
    (message) => !unique.some((other) => other !== message && message.includes(other))
  );
}

/**
 * 검사 대상 문자열들을 뽑는다. 대상이 아니면 빈 배열.
 * @returns {{label: string, text: string, field: string, editIndex?: number}[]}
 */
function extractTargets(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];

  if (toolName === "Bash") {
    return extractCommitMessages(toolInput.command).map((text) => ({
      label: "커밋 메시지",
      text,
      field: "command",
    }));
  }

  const filePath = toolInput.file_path || "";
  if (filePath && !DOC_EXTENSIONS.has(extname(filePath).toLowerCase())) return [];
  // 파일이 스스로를 예외로 선언했으면 조각만 넘어와도 존중한다.
  //
  // lint() 는 넘겨받은 글에서 표시를 찾으므로, Edit 처럼 조각만 오면 파일 수준 선언이
  // 보이지 않는다. 그래서 여기서 파일을 읽어 확인한다. 이 덕분에 사용자가 자기 문서에
  // 표시를 붙여 Edit 로 고칠 때도 동작한다.
  if (filePath && declaresIgnore(filePath)) return [];

  if (toolName === "Write" && typeof toolInput.content === "string") {
    return [{ label: filePath || "문서", text: toolInput.content, field: "content" }];
  }

  if (toolName === "Edit" && typeof toolInput.new_string === "string") {
    return [{ label: filePath || "문서", text: toolInput.new_string, field: "new_string" }];
  }

  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((edit, editIndex) =>
        typeof edit?.new_string === "string"
          ? { label: filePath || "문서", text: edit.new_string, field: "new_string", editIndex }
          : null
      )
      .filter(Boolean);
  }

  return [];
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function describeFixes(applied) {
  const lines = applied.map((item) => `- "${item.matched}" → "${item.replacement}"`);
  return [`한국어 표현 ${applied.length}건을 고쳤습니다.`, ...lines].join("\n");
}

function handlePreToolUse(toolName, toolInput, targets, rules) {
  if (blockEnabled()) {
    // F8: 막을 때만 전체 위반 목록이 필요하다. 자동 교정 경로에서는 applyFixes 가
    // 안에서 다시 검사하므로 미리 훑으면 같은 일을 두 번 한다.
    const allFindings = targets.flatMap((target) => lint(target.text, rules));
    if (allFindings.length === 0) return;
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: formatFindings(allFindings, targets[0]?.label || ""),
      },
    });
    return;
  }

  // 자동 교정. 원본을 그대로 유지한 채 필드별로 바꿔 넣는다.
  const updatedInput = { ...toolInput };
  const applied = [];
  let changed = false;

  for (const target of targets) {
    const result = applyFixes(target.text, rules);
    if (result.text === target.text) continue;

    if (toolName === "Bash") {
      // 명령 전체에서 해당 메시지 부분만 갈아 끼운다.
      const next = String(updatedInput.command).split(target.text).join(result.text);
      if (next !== updatedInput.command) {
        updatedInput.command = next;
        changed = true;
      }
    } else if (target.editIndex !== undefined) {
      updatedInput.edits = (updatedInput.edits || []).map((edit, index) =>
        index === target.editIndex ? { ...edit, new_string: result.text } : edit
      );
      changed = true;
    } else {
      updatedInput[target.field] = result.text;
      changed = true;
    }
    applied.push(...result.applied);
  }

  if (!changed || applied.length === 0) return;

  emit({
    systemMessage: describeFixes(applied),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  });
}

function handlePostToolUse(targets, rules) {
  const findings = targets.flatMap((target) =>
    lint(target.text, rules).map((finding) => ({ ...finding, label: target.label }))
  );
  if (findings.length === 0) return;

  const label = targets[0]?.label || "";
  emit({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: [
        formatFindings(findings, label),
        "",
        "저장소에 남는 글이므로 위 표현을 고쳐 주십시오. 코드와 식별자는 그대로 두십시오.",
      ].join("\n"),
    },
  });
}

const autofixEnabled = () => process.env.KIMCHI_AUTOFIX === "1";
const blockEnabled = () => process.env.KIMCHI_BLOCK === "1";

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

  const toolName = payload.tool_name;
  const event = payload.hook_event_name;
  if (!toolName || !event) return;

  // 기본값에서 PreToolUse 는 아무 일도 하지 않는다. 경고는 PostToolUse 가 맡는다.
  // 규칙 575개를 읽기 전에 빠져나가야 한다. 그 적재가 8ms 다.
  if (event === "PreToolUse" && !autofixEnabled() && !blockEnabled()) return;

  const targets = extractTargets(toolName, payload.tool_input).filter((target) =>
    looksKorean(target.text)
  );
  if (targets.length === 0) return;

  const { rules } = loadRules(join(PLUGIN_ROOT, "rules"));
  if (rules.length === 0) return;

  if (event === "PreToolUse") handlePreToolUse(toolName, payload.tool_input, targets, rules);
  else if (event === "PostToolUse") handlePostToolUse(targets, rules);
}

export { extractCommitMessages, extractTargets };

// 직접 실행될 때만 돈다. 시험에서 불러 쓸 때 프로세스를 끝내 버리면 안 된다.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch {
    // 조용히 넘어간다. 이 훅이 작업을 막아서는 안 된다.
  }
  process.exit(0);
}
