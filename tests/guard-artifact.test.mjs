import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCommitMessages, extractTargets } from "../hooks/guard-artifact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "hooks", "guard-artifact.mjs");

function runHook(payload, env = {}) {
  const stdout = execFileSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, KIMCHI_DISABLE: "", KIMCHI_AUTOFIX: "", KIMCHI_BLOCK: "", ...env },
  });
  return stdout.trim() === "" ? null : JSON.parse(stdout);
}

const commit = (message) => ({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: `git commit -m "${message}"` },
});

test("커밋 메시지에서 -m 형태를 뽑는다", () => {
  assert.deepEqual(extractCommitMessages('git commit -m "메시지입니다"'), ["메시지입니다"]);
  assert.deepEqual(extractCommitMessages("git commit -m '메시지입니다'"), ["메시지입니다"]);
});

test("heredoc 형태를 뽑는다", () => {
  const command = ["git commit -m \"$(cat <<'EOF'", "제목입니다", "", "본문입니다", "EOF", ')"'].join("\n");
  assert.deepEqual(extractCommitMessages(command), ["제목입니다\n\n본문입니다"]);
});

test("git commit이 아닌 명령은 보지 않는다", () => {
  assert.deepEqual(extractCommitMessages('echo -m "메시지"'), []);
  assert.deepEqual(extractCommitMessages("git status"), []);
});

test("문서 확장자만 검사 대상으로 잡는다", () => {
  const content = "리팩토링이 필요합니다.";
  assert.equal(extractTargets("Write", { file_path: "a.md", content }).length, 1);
  assert.equal(extractTargets("Write", { file_path: "a.js", content }).length, 0);
  assert.equal(extractTargets("Write", { file_path: "a.PY", content }).length, 0);
  assert.equal(extractTargets("Write", { file_path: "a.TXT", content }).length, 1);
});

test("MultiEdit의 편집마다 대상을 만든다", () => {
  const targets = extractTargets("MultiEdit", {
    file_path: "a.md",
    edits: [{ new_string: "하나" }, { new_string: "둘" }, { old_string: "셋" }],
  });
  assert.equal(targets.length, 2);
  assert.equal(targets[1].editIndex, 1);
});

test("한국어 커밋 메시지의 위반을 알려준다", () => {
  const output = runHook(commit("리팩토링 후 컨텐츠를 정리했습니다"));
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(output.hookSpecificOutput.additionalContext, /리팩터링/);
  assert.match(output.hookSpecificOutput.additionalContext, /콘텐츠/);
});

test("깨끗한 한국어 커밋 메시지에는 침묵한다", () => {
  assert.equal(runHook(commit("캐시를 한 번만 계산하도록 고쳤습니다")), null);
});

test("영어 커밋 메시지에는 개입하지 않는다", () => {
  assert.equal(runHook(commit("Fix the cache invalidation bug in the resolver")), null);
});

test("소스 파일에는 개입하지 않는다", () => {
  const payload = {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/a.js", content: "// 리팩토링이 필요한 컨텐츠입니다" },
  };
  assert.equal(runHook(payload), null);
});

test("기본값에서는 PreToolUse가 아무것도 하지 않는다", () => {
  const payload = { ...commit("리팩토링 후 컨텐츠 정리"), hook_event_name: "PreToolUse" };
  assert.equal(runHook(payload), null);
});

test("KIMCHI_AUTOFIX가 켜지면 입력을 고쳐 준다", () => {
  const payload = { ...commit("리팩토링 후 컨텐츠 정리"), hook_event_name: "PreToolUse" };
  const output = runHook(payload, { KIMCHI_AUTOFIX: "1" });
  assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
  assert.match(output.hookSpecificOutput.updatedInput.command, /리팩터링 후 콘텐츠 정리/);
  assert.match(output.systemMessage, /2건을 고쳤습니다/);
});

test("KIMCHI_BLOCK이 켜지면 막는다", () => {
  const payload = { ...commit("리팩토링 후 컨텐츠 정리"), hook_event_name: "PreToolUse" };
  const output = runHook(payload, { KIMCHI_BLOCK: "1" });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /리팩터링/);
});

test("KIMCHI_DISABLE이 모든 것을 끈다", () => {
  assert.equal(runHook(commit("리팩토링 후 컨텐츠 정리"), { KIMCHI_DISABLE: "1" }), null);
});

test("망가진 입력에도 종료 코드 0으로 조용히 끝난다", () => {
  for (const input of ["", "not json", "{}", '{"tool_name":"Bash"}', "null"]) {
    const stdout = execFileSync("node", [HOOK], { input, encoding: "utf8" });
    assert.equal(stdout.trim(), "", `입력 "${input}" 에서 출력이 나왔다`);
  }
});

test("쓸 것을 적힌 그대로 보여 준다", () => {
  // "~될", "~습니다"처럼 어미를 적는 물결표는 한국어에서 자연스러운 표기다.
  const output = runHook(commit("이 값은 곧 수정되어질 예정입니다"));
  assert.match(output.hookSpecificOutput.additionalContext, /"되어질" → "~될"/);
});

test("스스로를 예외로 선언한 문서는 Write든 Edit든 검사하지 않는다", () => {
  // 경로 이름이 아니라 문서에 실린 선언으로 판단해야 한다. 경로로 판단하면 사용자의
  // docs/rules/*.md 까지 조용히 빠지고, 우리 파일을 옮기면 보호가 사라진다.
  const content = "리팩토링과 컨텐츠를 고쳐야 합니다.";
  const dir = mkdtempSync(join(tmpdir(), "kimchi-"));
  const declared = join(dir, "guide.md");
  const plain = join(dir, "plain.md");
  writeFileSync(declared, `<!-- kimchi-ignore-file 대조 예시를 싣는다 -->
${content}`, "utf8");
  writeFileSync(plain, content, "utf8");

  try {
    // Write: 넘어온 글 안에 선언이 있으면 lint 가 알아서 걸러 낸다
    assert.equal(runHook({
      hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: declared, content: `<!-- kimchi-ignore-file -->
${content}` },
    }), null);

    // Edit: 조각에는 선언이 없다. 파일을 읽어 확인해야 한다
    assert.equal(extractTargets("Edit", { file_path: declared, new_string: content }).length, 0);

    // 선언이 없는 문서는 그대로 검사한다
    assert.equal(extractTargets("Edit", { file_path: plain, new_string: content }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("이 저장소의 생성물과 규칙 자료는 선언으로 걸러진다", () => {
  const content = "리팩토링과 컨텐츠를 고쳐야 합니다.";
  for (const file of ["output-styles/natural-korean.md", "rules/terms.md", "rules/observed.md"]) {
    assert.equal(extractTargets("Edit", { file_path: join(ROOT, file), new_string: content }).length, 0, file);
  }
});
