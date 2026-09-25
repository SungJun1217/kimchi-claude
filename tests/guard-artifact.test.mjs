import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCommitMessages, extractTargets, autofixOrBlock, loadToneRules } from "../hooks/lib/artifact.mjs";
import { fastestMs } from "./helpers.mjs";

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

test("항목B: 문서의 들여쓰기 코드·<pre> 안 조사는 PostToolUse도, KIMCHI_AUTOFIX도 건드리지 않는다", () => {
  // fixOne/warnAboutTone 이 findParticleErrors·fixParticles 에 ext 를 안 넘기면 이 두 블록형
  // 가리개가 빠져 코드 예시의 "commit를"·"json를" 까지 고치거나 지적한다(0.14.11 이전 버그).
  const payload = {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: {
      file_path: "/tmp/kimchi-ext-test.md",
      content: "빈 줄 뒤:\n\n    git commit를 실행한다\n\n<pre>json를 출력</pre>",
    },
  };
  assert.equal(runHook(payload), null, "코드 예시 안의 조사까지 경고했다");

  const autofixPayload = { ...payload, hook_event_name: "PreToolUse" };
  assert.equal(runHook(autofixPayload, { KIMCHI_AUTOFIX: "1" }), null, "코드 예시 안의 조사까지 고쳤다");
});

test("항목F: CMakeLists.txt/requirements-dev.txt 같은 빌드 도구 파일은 말투 검사에서 빠진다", () => {
  const content = "리팩토링과 컨텐츠를 정리해야 합니다.";
  for (const file of ["CMakeLists.txt", "requirements-dev.txt", "dev-requirements.txt", "constraints.txt", "robots.txt"]) {
    const output = runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: `/tmp/${file}`, content },
    });
    assert.equal(output, null, file);
  }
});

test("항목F: notes.txt 처럼 이름이 걸리지 않는 .txt 는 여전히 경고한다", () => {
  const output = runHook({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/notes.txt", content: "리팩토링과 컨텐츠를 정리해야 합니다." },
  });
  assert.match(output.hookSpecificOutput.additionalContext, /리팩터링/);
});

test("항목F: 말투 검사에서 빠지는 파일이어도 주민등록번호는 여전히 막는다", () => {
  const output = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/CMakeLists.txt", content: "# 900101-1234567" },
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("항목1: Edit 조각 밖에 있는 참조식 링크 정의도 파일에서 읽어 라벨을 보호한다", () => {
  // Edit의 new_string은 조각일 뿐이다 — 정의 줄([타겟]: ./setup.md)이 조각 밖에 있으면
  // 조각만 보고 판정하는 쪽은 그 정의를 모른 채 라벨을 자동 교정해 죽은 링크를 만든다.
  const dir = mkdtempSync(join(tmpdir(), "kimchi-"));
  const file = join(dir, "doc.md");
  const oldFragment = "문서는 [설정 안내][타겟]을 보세요.";
  writeFileSync(file, [oldFragment, "", "[타겟]: ./setup.md"].join("\n"), "utf8");
  try {
    const newFragment = "타겟 문서는 [설정 안내][타겟]을 보세요.";
    const output = runHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: file, old_string: oldFragment, new_string: newFragment },
      },
      { KIMCHI_AUTOFIX: "1" }
    );
    assert.ok(output, "자동 교정이 전혀 동작하지 않았다");
    assert.match(output.hookSpecificOutput.updatedInput.new_string, /\[설정 안내\]\[타겟\]/, "라벨이 바뀌어 링크가 죽었다");
    assert.match(output.hookSpecificOutput.updatedInput.new_string, /^타깃 문서는/, "라벨 밖의 낱말은 정상적으로 고쳐야 한다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("항목1: 파일을 못 읽으면(새 파일 등) old_string 위치를 못 찾아 애초에 자동 교정하지 않는다", () => {
  const output = runHook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: "/tmp/kimchi-없는-파일.md",
        old_string: "예전",
        new_string: "안내는 [설정][타겟]을 보고 타겟 문서도 확인합니다.",
      },
    },
    { KIMCHI_AUTOFIX: "1" }
  );
  assert.equal(output, null);
});

test("이 저장소의 생성물과 규칙 자료는 선언으로 걸러진다", () => {
  const content = "리팩토링과 컨텐츠를 고쳐야 합니다.";
  for (const file of ["output-styles/natural-korean.md", "rules/terms.md", "rules/observed.md"]) {
    assert.equal(extractTargets("Edit", { file_path: join(ROOT, file), new_string: content }).length, 0, file);
  }
});

// ── 대량 반복 문서에서 메시지 크기와 처리 시간(결함 4, 5) ────────

test("자동 교정 메시지는 같은 교정이 수천 번 반복돼도 종류별로 묶고 건수만 센다", () => {
  // 실제 훅 프로세스(runHook)를 거치면 큰 출력이 execFileSync 의 기본 stdout 버퍼
  // 한도를 넘어 ENOBUFS 로 죽는다 — 여기서 재는 것은 메시지 크기 자체이므로 라이브러리를
  // 직접 부른다.
  const rules = loadToneRules();
  const content = "commit를 올렸습니다.\n".repeat(1000);
  const toolInput = { file_path: "notes.md", content };
  const targets = extractTargets("Write", toolInput);
  let output;
  process.env.KIMCHI_AUTOFIX = "1";
  try {
    output = autofixOrBlock("Write", toolInput, targets, rules);
  } finally {
    delete process.env.KIMCHI_AUTOFIX;
  }
  assert.ok(output, "자동 교정이 전혀 동작하지 않았다");

  const bullets = output.systemMessage.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(bullets.length, 1, "교정 종류가 하나면 줄도 하나여야 한다");
  assert.match(bullets[0], /총 1000곳/);
  assert.match(output.systemMessage, /1가지\(총 1000건\)/);
  // 모델에게 닿는 목록도 같은 크기로 줄어야 한다 — additionalContext 가 systemMessage 를
  // 그대로 옮긴 값이라 여기서 부풀면 3.6MB짜리 훅 JSON(실측)으로 되돌아간다.
  assert.ok(
    output.hookSpecificOutput.additionalContext.length < 2000,
    "additionalContext 가 여전히 건수에 비례해 커진다"
  );
});

test("자동 교정 메시지의 건수는 실제로 고친 건수와 같다(규칙당 보고 상한과 무관하게 전부 고친다)", () => {
  // lint()의 규칙당 보고 상한(3건)을 자동 교정에도 그대로 쓰면 "디렉토리" 10번 중
  // 3번만 고치고도 메시지는 "10건을 고쳤습니다"라고 말하는 불일치가 생긴다.
  const rules = loadToneRules();
  const content = Array.from({ length: 10 }, (_, i) => `${i}번째 디렉토리를 만든다.`).join(" ");
  const toolInput = { file_path: "notes.md", content };
  const targets = extractTargets("Write", toolInput);
  let output;
  process.env.KIMCHI_AUTOFIX = "1";
  try {
    output = autofixOrBlock("Write", toolInput, targets, rules);
  } finally {
    delete process.env.KIMCHI_AUTOFIX;
  }

  assert.ok(output, "자동 교정이 전혀 동작하지 않았다");
  // 매치 문자열("디렉토리"→"디렉터리")이 전부 같아 한 줄로 묶이지만, 괄호 안 건수는
  // 실제로 고친 건수(10)와 같아야 한다.
  assert.match(output.systemMessage, /\(총 10건\)/);
  assert.match(output.systemMessage, /총 10곳/);
  assert.equal((output.hookSpecificOutput.updatedInput.content.match(/디렉토리/g) || []).length, 0, "안 고친 디렉토리가 남았다");
  assert.equal((output.hookSpecificOutput.updatedInput.content.match(/디렉터리/g) || []).length, 10);
});

test("자동 교정은 문서가 너무 크면 건드리지 않고 원본 그대로 둔다", () => {
  // updatedInput 이 고친 파일 전체를 되싣기 때문에, 상한 없이 큰 문서를 교정하면 훅
  // JSON 자체가 그만큼 커진다(실측: 2.48MB 문서 → 2.6MB JSON). 상한을 넘는 문서는
  // 자동 교정을 건너뛰고 PostToolUse 경고에 맡긴다.
  const rules = loadToneRules();
  const content = "commit를 올렸습니다. 디렉토리를 만든다.\n".repeat(100000); // 약 2.5MB
  const toolInput = { file_path: "notes.md", content };
  const targets = extractTargets("Write", toolInput);
  let output;
  process.env.KIMCHI_AUTOFIX = "1";
  try {
    output = autofixOrBlock("Write", toolInput, targets, rules);
  } finally {
    delete process.env.KIMCHI_AUTOFIX;
  }
  assert.equal(output, null, "상한을 넘는 문서인데 자동 교정이 실행됐다");
});

test("자동 교정 상한은 대상 하나가 아니라 호출 전체(대상을 다 합친 길이)로 본다", () => {
  // MultiEdit처럼 대상이 여럿이면, 편집 하나하나는 상한(200만자) 밑이어도 다 더하면
  // 넘을 수 있다 — 훅 JSON 크기를 결정하는 것은 호출 전체다. 대상별 검사만 있으면
  // 이 경우를 놓친다.
  const rules = loadToneRules();
  const chunk = "commit를 확인. ".repeat(90000); // 약 108만자, 개별로는 상한 밑
  assert.ok(chunk.length < 2_000_000, "개별 대상이 상한을 넘으면 시험 전제가 깨진다");
  assert.ok(chunk.length * 2 > 2_000_000, "둘을 합쳐도 상한을 안 넘으면 시험 전제가 깨진다");

  const targets = [
    { label: "notes.md", text: chunk, field: "content" },
    { label: "notes.md", text: chunk, field: "content2" },
  ];
  let output;
  process.env.KIMCHI_AUTOFIX = "1";
  try {
    output = autofixOrBlock("Write", { file_path: "notes.md" }, targets, rules);
  } finally {
    delete process.env.KIMCHI_AUTOFIX;
  }
  assert.equal(output, null, "대상 각각은 상한 밑인데 합쳐서 상한을 넘겨도 자동 교정이 실행됐다");
});

test("타이밍: 자동 교정은 큰 문서에서도 선형에 가깝게 끝난다(이차 비용 회귀 방지)", () => {
  const rules = loadToneRules();
  const unit = "commit를 올렸습니다. 디렉토리를 만든다.\n";
  const timeFor = (mb) => {
    const reps = Math.round((mb * 1_000_000) / unit.length);
    const content = unit.repeat(reps);
    const toolInput = { file_path: "notes.md", content };
    const targets = extractTargets("Write", toolInput);
    // runs=1: 비율만 보면 되고, 다른 시험과 병렬로 돌 때의 흔들림보다 시험 전체
    // 실행 시간을 줄이는 쪽이 낫다(재측정 없이도 이차 비용 회귀는 비율에 그대로 남는다).
    return fastestMs(() => autofixOrBlock("Write", toolInput, targets, rules), 1);
  };
  let small;
  let large;
  process.env.KIMCHI_AUTOFIX = "1";
  try {
    small = timeFor(0.1);
    large = timeFor(0.4); // 4배 큰 입력
  } finally {
    delete process.env.KIMCHI_AUTOFIX;
  }
  console.log(`    자동 교정 0.1MB: ${small}ms, 0.4MB: ${large}ms`);
  // 이차 비용이면 4배 입력이 16배 가까이 걸린다. 선형이면 4배 안팎에 머문다.
  assert.ok(large < small * 8 + 200, `0.4MB(${large}ms)가 0.1MB(${small}ms)에 견줘 이차 비용처럼 늘었다`);
});
