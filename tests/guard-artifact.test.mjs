import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCommitMessages, extractTargets } from "../hooks/lib/artifact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "hooks", "guard.mjs");

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
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined, "자동 교정은 권한 프롬프트를 건너뛰면 안 된다");
  assert.match(output.hookSpecificOutput.updatedInput.command, /리팩터링 후 콘텐츠 정리/);
  assert.match(output.systemMessage, /2건을 고쳤습니다/);
  assert.match(output.hookSpecificOutput.additionalContext, /입력을 고쳤습니다/);
  assert.match(output.hookSpecificOutput.additionalContext, /"리팩토링" → "리팩터링"/);
  assert.match(output.hookSpecificOutput.additionalContext, /"컨텐츠" → "콘텐츠"/);
});

test("자동 교정 additionalContext 는 systemMessage 와 같은 교정 목록을 담는다", () => {
  // 모델에게는 additionalContext 로만 닿는다(systemMessage 는 사용자 전용). 둘이 갈라지면
  // 모델이 실제로 반영된 내용을 모른 채 보고하거나 되돌릴 수 있다.
  const payload = { ...commit("리팩토링 후 컨텐츠 정리"), hook_event_name: "PreToolUse" };
  const output = runHook(payload, { KIMCHI_AUTOFIX: "1" });
  const fixLines = (text) => text.split("\n").filter((line) => line.startsWith("- "));
  assert.deepEqual(
    fixLines(output.hookSpecificOutput.additionalContext),
    fixLines(output.systemMessage),
    "모델에게 닿는 교정 목록이 사용자에게 보이는 목록과 달라졌다"
  );
});

test("KIMCHI_AUTOFIX/KIMCHI_BLOCK/KIMCHI_PII 조합 어디에서도 permissionDecision 이 allow 나 ask 로는 나오지 않는다", () => {
  const combos = [
    {},
    { KIMCHI_AUTOFIX: "1" },
    { KIMCHI_BLOCK: "1" },
    { KIMCHI_AUTOFIX: "1", KIMCHI_BLOCK: "1" },
    { KIMCHI_PII: "warn" },
    { KIMCHI_AUTOFIX: "1", KIMCHI_PII: "warn" },
    { KIMCHI_BLOCK: "1", KIMCHI_PII: "warn" },
  ];
  const payload = { ...commit("리팩토링 후 컨텐츠 정리"), hook_event_name: "PreToolUse" };
  for (const env of combos) {
    const output = runHook(payload, env);
    const decision = output?.hookSpecificOutput?.permissionDecision;
    assert.ok(
      decision === undefined || decision === "deny",
      `${JSON.stringify(env)} 에서 permissionDecision 이 "${decision}" 이었다 — 권한 프롬프트를 건너뛸 수 있다`
    );
  }
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

test("F2: 경로에 나온 같은 문자열은 그대로 두고 커밋 메시지만 고친다", () => {
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: 'git add docs/리팩토링.md && git commit -m "리팩토링"' },
  };
  const output = runHook(payload, { KIMCHI_AUTOFIX: "1" });
  assert.match(output.hookSpecificOutput.updatedInput.command, /docs\/리팩토링\.md/);
  assert.match(output.hookSpecificOutput.updatedInput.command, /-m "리팩터링"/);
});

test("F4: -m 이 두 번이면 둘 다 고친다", () => {
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: 'git commit -m "컨텐츠" -m "리팩토링 컨텐츠"' },
  };
  const output = runHook(payload, { KIMCHI_AUTOFIX: "1" });
  assert.match(output.hookSpecificOutput.updatedInput.command, /-m "콘텐츠" -m "리팩터링 콘텐츠"/);
});

test("F5: 실제로 바뀐 건수만 보고한다", () => {
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: 'git commit -m "컨텐츠 정리"' },
  };
  const output = runHook(payload, { KIMCHI_AUTOFIX: "1" });
  const dashCount = (output.systemMessage.match(/^- /gm) || []).length;
  const stated = Number(output.systemMessage.match(/(\d+)건을 고쳤습니다/)[1]);
  assert.equal(dashCount, stated);
});

test("F3: git commit -am 도 자동 교정한다", () => {
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: 'git commit -am "리팩토링"' },
  };
  const output = runHook(payload, { KIMCHI_AUTOFIX: "1" });
  assert.match(output.hookSpecificOutput.updatedInput.command, /-am "리팩터링"/);
});

test("F6: 울타리 코드 블록 안의 Edit은 건드리지 않는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-"));
  const file = join(dir, "guide.md");
  const oldFragment = 'const msg = "메세지 컨텐츠";';
  writeFileSync(
    file,
    ["설명입니다.", "```js", oldFragment, "```", "끝입니다."].join("\n"),
    "utf8"
  );
  try {
    const newFragment = 'const msg = "메세지 컨텐츠 수정";';
    assert.equal(extractTargets("Edit", { file_path: file, old_string: oldFragment, new_string: newFragment }).length, 0);

    const output = runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: file, old_string: oldFragment, new_string: newFragment },
      },
      { KIMCHI_AUTOFIX: "1" }
    );
    assert.equal(output, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F6: kimchi-ignore 구간 안의 Edit은 건드리지 않는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-"));
  const file = join(dir, "guide.md");
  const oldFragment = "얇은 계약을 인용합니다.";
  writeFileSync(
    file,
    ["여기는 검사합니다.", "<!-- kimchi-ignore-start -->", oldFragment, "<!-- kimchi-ignore-end -->"].join("\n"),
    "utf8"
  );
  try {
    assert.equal(
      extractTargets("Edit", { file_path: file, old_string: oldFragment, new_string: "얇은 계약을 다시 인용합니다." }).length,
      0
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F6: 본문 안의 Edit은 그대로 고친다", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-"));
  const file = join(dir, "guide.md");
  const oldFragment = "여기는 리팩토링이 필요합니다.";
  writeFileSync(file, oldFragment, "utf8");
  try {
    const targets = extractTargets("Edit", {
      file_path: file,
      old_string: oldFragment,
      new_string: "여기는 리팩토링과 컨텐츠 정리가 필요합니다.",
    });
    assert.equal(targets.length, 1);
    assert.equal(targets[0].autofixSafe, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F6: old_string을 하나로 못 정하면(중복, 파일 없음) 자동 교정은 보류하고 경고는 조각으로 계속한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-"));
  const file = join(dir, "guide.md");
  writeFileSync(file, ["리팩토링이 필요합니다.", "리팩토링이 필요합니다."].join("\n"), "utf8");
  try {
    const dup = extractTargets("Edit", {
      file_path: file,
      old_string: "리팩토링이 필요합니다.",
      new_string: "리팩토링과 컨텐츠 정리가 필요합니다.",
    });
    assert.equal(dup.length, 1);
    assert.equal(dup[0].autofixSafe, false);

    const missingFile = extractTargets("Edit", {
      file_path: join(dir, "없음.md"),
      old_string: "아무거나",
      new_string: "리팩토링과 컨텐츠",
    });
    assert.equal(missingFile.length, 1);
    assert.equal(missingFile[0].autofixSafe, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("항목3: PostToolUse에서는 파일에 이미 반영된 new_string으로 울타리 안쪽을 알아본다", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-"));
  const file = join(dir, "guide.md");
  const newFragment = 'const msg = "메세지 컨텐츠 수정";';
  // PostToolUse 시점: 파일은 이미 편집이 반영된 상태다(old_string은 더 이상 없다).
  writeFileSync(file, ["설명입니다.", "```js", newFragment, "```", "끝입니다."].join("\n"), "utf8");
  try {
    const targets = extractTargets("Edit", {
      file_path: file,
      old_string: 'const msg = "메세지 컨텐츠";',
      new_string: newFragment,
    });
    assert.equal(targets.length, 0);

    const output = runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: file, old_string: 'const msg = "메세지 컨텐츠";', new_string: newFragment },
    });
    assert.equal(output, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("항목4: replace_all로 바뀐 자리 일부만 울타리 안이면 자동 교정은 보류하고 경고는 계속한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-"));
  const file = join(dir, "guide.md");
  const oldFragment = "리팩토링이 필요합니다.";
  writeFileSync(
    file,
    ["```", oldFragment, "```", "", oldFragment].join("\n"),
    "utf8"
  );
  try {
    const targets = extractTargets("Edit", {
      file_path: file,
      old_string: oldFragment,
      new_string: "리팩토링과 컨텐츠 정리가 필요합니다.",
      replace_all: true,
    });
    assert.equal(targets.length, 1);
    assert.equal(targets[0].autofixSafe, false); // 일부만 예외 구간 — 하나로 못 정한 것과 같다
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("항목5: 괄호나 조사가 바로 붙은 한글 경로도 손대지 않는다", () => {
  const cases = [
    "이 파일은 (docs/컨텐츠.md) 을 봅니다.",
    "src/컨텐츠/index.ts, 그리고 나머지.",
    '"docs/메세지.md" 를 확인합니다.',
    "docs/메세지.md: 여기를 보십시오.",
    "메세지_컨텐츠.md를 고쳤습니다.",
  ];
  for (const content of cases) {
    const output = runHook(
      { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/tmp/x.md", content } },
      { KIMCHI_AUTOFIX: "1" }
    );
    assert.equal(output, null, content);
  }
});

test("항목A: 들여쓰기·AsciiDoc 가리개가 커밋 메시지 지적까지 지우지 않는다", () => {
  const indented = runHook(commit("    컨텐츠 메세지 정리"));
  assert.match(indented.hookSpecificOutput.additionalContext, /콘텐츠/);

  const heredocPayload = {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: ["git commit -F - <<-EOF", "\t- 컨텐츠 항목", "EOF"].join("\n") },
  };
  const heredoc = runHook(heredocPayload);
  assert.match(heredoc.hookSpecificOutput.additionalContext, /콘텐츠/);
});

test("이 저장소의 생성물과 규칙 자료는 선언으로 걸러진다", () => {
  const content = "리팩토링과 컨텐츠를 고쳐야 합니다.";
  for (const file of ["output-styles/natural-korean.md", "rules/terms.md", "rules/observed.md"]) {
    assert.equal(extractTargets("Edit", { file_path: join(ROOT, file), new_string: content }).length, 0, file);
  }
});
