// 훅이 "직접 실행됐는지" 스스로 판단하는 로직.
//
// `import.meta.url === \`file://${process.argv[1]}\`` 비교는 경로에 공백이나 한글이
// 섞이거나 심볼릭 링크를 통해 실행되면 어긋난다. 그러면 main() 이 돌지 않고 훅이 조용히
// 아무 일도 하지 않는다 — 주민등록번호 차단이 통째로 꺼지는 것과 같다. isEntrypoint() 가
// 그런 경로에서도 실제로 동작하는지를 이 시험이 확인한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  cpSync,
  symlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntrypoint } from "../hooks/lib/entrypoint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── isEntrypoint 단위 시험 ──────────────────────────────────
//
// process.argv[1] 은 프로세스 전체에서 하나뿐이라 시험이 끝나면 반드시 되돌린다.

// file:// 문자열을 손으로 적으면 윈도우에서 드라이브 문자가 없어 fileURLToPath 가
// 던진다. pathToFileURL 로 만들어야 플랫폼을 가리지 않는다.
const nonexistentPath = (...segments) => join(tmpdir(), "kimchi-nonexistent", ...segments);

test("argv[1] 과 같은 경로면 참이다", () => {
  const path = nonexistentPath("guard.mjs");
  const original = process.argv[1];
  process.argv[1] = path;
  try {
    assert.equal(isEntrypoint(pathToFileURL(path).href), true);
  } finally {
    process.argv[1] = original;
  }
});

test("argv[1] 이 없으면 거짓이다", () => {
  const original = process.argv[1];
  delete process.argv[1];
  try {
    assert.equal(isEntrypoint(pathToFileURL(nonexistentPath("x", "guard.mjs")).href), false);
  } finally {
    process.argv[1] = original;
  }
});

test("다른 파일을 가리키면 거짓이다", () => {
  const original = process.argv[1];
  process.argv[1] = nonexistentPath("other", "other-nonexistent.mjs");
  try {
    assert.equal(isEntrypoint(pathToFileURL(nonexistentPath("x", "x-nonexistent.mjs")).href), false);
  } finally {
    process.argv[1] = original;
  }
});

test("공백과 한글이 섞인 경로도 realpath 로 맞춰 본다", () => {
  // file://+argv[1] 문자열 비교는 여기서 어긋난다. import.meta.url 은 퍼센트 인코딩되지만
  // argv[1] 은 사용자가 입력한 그대로이기 때문이다.
  const dir = mkdtempSync(join(tmpdir(), "kimchi-공백 "));
  const file = join(dir, "hook.mjs");
  writeFileSync(file, "");
  const original = process.argv[1];
  process.argv[1] = file;
  try {
    assert.equal(isEntrypoint(pathToFileURL(file).href), true);
  } finally {
    process.argv[1] = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

// 윈도우는 개발자 모드나 관리자 권한이 없으면 symlinkSync 가 EPERM/EACCES 로 던진다.
// 그 환경에서는 심볼릭 링크 자체를 시험할 수 없으니 건너뛴다.
function trySymlink(t, target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip(`이 환경은 심볼릭 링크를 만들 권한이 없다 (${error.code})`);
      return false;
    }
    throw error;
  }
}

test("심볼릭 링크를 거쳐 실행돼도 참이다", (t) => {
  // 플러그인 설치가 훅 디렉터리를 심볼릭 링크로 두는 경우가 흔하다.
  const dir = mkdtempSync(join(tmpdir(), "kimchi-link-"));
  const file = join(dir, "hook.mjs");
  writeFileSync(file, "");
  const link = join(dir, "hook-link.mjs");
  try {
    if (!trySymlink(t, file, link)) return;
    const original = process.argv[1];
    process.argv[1] = link;
    try {
      assert.equal(isEntrypoint(pathToFileURL(file).href), true);
    } finally {
      process.argv[1] = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 실제 훅을 이상한 경로에서 돌려 본다 ─────────────────────

/** hooks/ 와 rules/ 를 이상한 이름의 디렉터리로 복사한다. 정리는 부른 쪽이 한다. */
function copyPlugin(name) {
  const base = mkdtempSync(join(tmpdir(), "kimchi-plugin-"));
  const dir = join(base, name);
  cpSync(join(ROOT, "hooks"), join(dir, "hooks"), { recursive: true });
  cpSync(join(ROOT, "rules"), join(dir, "rules"), { recursive: true });
  return dir;
}

const PII_PAYLOAD = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path: "/tmp/a.txt", content: "주민번호 900101-1234568" },
});

function runGuard(pluginDir, payload) {
  const stdout = execFileSync("node", [join(pluginDir, "hooks", "guard.mjs")], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, KIMCHI_DISABLE: "", KIMCHI_PII: "" },
  });
  return stdout.trim() === "" ? null : JSON.parse(stdout);
}

test("공백과 한글이 섞인 경로에 놓여도 주민등록번호를 막는다", () => {
  const dir = copyPlugin("dir with space 한글");
  try {
    const output = runGuard(dir, PII_PAYLOAD);
    assert.ok(output, "훅이 조용히 아무 일도 하지 않았다 — main() 이 안 돈 것이다");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test("심볼릭 링크로 실행돼도 주민등록번호를 막는다", (t) => {
  const real = copyPlugin("real");
  const base = dirname(real);
  const link = join(base, "linked");
  try {
    if (!trySymlink(t, real, link)) return;
    const output = runGuard(link, PII_PAYLOAD);
    assert.ok(output, "훅이 조용히 아무 일도 하지 않았다 — main() 이 안 돈 것이다");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── session-language.mjs 도 같은 결함을 안고 있었다 ─────────

const ENGLISH_DOC = [
  "# Project",
  "",
  "This project does a thing. The documentation is written in English for contributors",
  "who may not read Korean. Everything here follows that convention consistently.",
  "",
  "Another paragraph explains how to build and test the project on a local machine",
  "without any additional setup beyond a recent version of the runtime.",
  "",
].join("\n");

function makeEnglishRepo() {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-lang-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  for (const subject of ["Add cache", "Fix bug", "Bump deps"]) {
    appendFileSync(join(dir, "f.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", subject], { cwd: dir });
  }
  writeFileSync(join(dir, "README.md"), ENGLISH_DOC, "utf8");
  return dir;
}

function runSessionLanguage(scriptPath, cwd) {
  return execFileSync("node", [scriptPath], {
    input: JSON.stringify({ cwd }),
    encoding: "utf8",
    env: { ...process.env, KIMCHI_DISABLE: "", KIMCHI_REPO_LANG: "" },
  }).trim();
}

test("공백과 한글이 섞인 경로에서도 session-language 가 평소와 같은 결과를 낸다", () => {
  const repo = makeEnglishRepo();
  const weird = copyPlugin("공백 있는 한글 경로");
  try {
    const normal = runSessionLanguage(join(ROOT, "hooks", "session-language.mjs"), repo);
    const fromWeirdPath = runSessionLanguage(join(weird, "hooks", "session-language.mjs"), repo);
    assert.notEqual(normal, "", "정상 경로에서도 출력이 있어야 견줄 수 있다");
    assert.equal(fromWeirdPath, normal);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dirname(weird), { recursive: true, force: true });
  }
});
