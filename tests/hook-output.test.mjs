// stdout 이 파이프일 때 macOS/Linux 는 쓰기가 비동기다. process.exit(0) 을 바로 부르면
// OS 파이프 버퍼를 넘는 출력이 잘려 잘못된 JSON 이 나간다(불변식 2 가 조용히 새는 구멍).
//
// 이 파일은 그 구멍이 막혔는지, 그리고 같은 불변식 1 위반 경로 — lib/ 정적 import 가
// try/catch 밖에서 죽는 것 — 이 막혔는지를 본다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, cpSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(ROOT, "hooks", "guard.mjs");
const SESSION_LANGUAGE = join(ROOT, "hooks", "session-language.mjs");

function runHook(hook, payload, env = {}) {
  const stdout = execFileSync("node", [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, KIMCHI_DISABLE: "", KIMCHI_PII: "", KIMCHI_AUTOFIX: "", KIMCHI_BLOCK: "", ...env },
  });
  return stdout.trim() === "" ? null : JSON.parse(stdout);
}

// ── (a) 유출 메시지의 나열 한도 ──────────────────────────────

test("2000줄 주민등록번호 CSV 에서도 메시지는 20건까지만 나열하고 나머지는 건수로 묶는다", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => `홍길동${i},900101-1234567`).join("\n");
  const output = runHook(GUARD, {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "leak.csv", content: rows },
  });

  assert.ok(output, "출력이 잘려서 훅이 아무 결정도 못 내렸다");
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  const reason = output.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /주민등록번호로 보이는 값 2000건을 찾았습니다/, "전체 건수는 그대로 정확해야 한다");

  const listedLines = reason.split("\n").filter((line) => /^- \d+번째 줄/.test(line));
  assert.equal(listedLines.length, 20, "목록은 앞쪽 20건만 나열해야 한다");
  assert.match(reason, /- 외 1980건/, "나머지는 건수로만 말해야 한다");
});

// ── (b) KIMCHI_AUTOFIX=1 의 큰 한국어 문서 ──────────────────

test("KIMCHI_AUTOFIX=1 로 200KB 문서를 고쳐도 updatedInput 이 잘리지 않는다", () => {
  const filler = "이 문단은 내용을 채우기 위한 자리표시자 문장입니다. ".repeat(3500);
  // rules/observed.md 의 치환 규칙을 확실히 하나 건드려 실제 교정이 일어나게 한다.
  const content = `${filler}\n\n계약이 얇습니다.\n`;
  assert.ok(Buffer.byteLength(content, "utf8") > 200 * 1024 * 0.9, "표본이 충분히 커야 한다");

  const output = runHook(
    GUARD,
    {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "notes.md", content },
    },
    { KIMCHI_AUTOFIX: "1" }
  );

  assert.ok(output, "출력이 잘려서 자동 교정 결과가 안 나왔다");
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined, "자동 교정은 권한 프롬프트를 건너뛰면 안 된다");
  const updated = output.hookSpecificOutput.updatedInput.content;
  assert.equal(typeof updated, "string");
  // 원문 꼬리(필러 반복 뒤에 붙인 표시)가 온전히 남아 있어야 한다 — 잘렸다면 여기서 사라진다.
  assert.match(updated, /결합도가 낮습니다\.\s*$/, "출력 꼬리가 잘렸다, 또는 치환이 적용되지 않았다");
});

// ── (c) 느린 리더 ────────────────────────────────────────────

function runHookSlow(hook, payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [hook], {
      env: { ...process.env, KIMCHI_DISABLE: "", KIMCHI_PII: "", ...env },
    });

    let out = "";
    // 조각을 받을 때마다 잠깐 멈췄다가 다시 흘려보낸다. 그동안 훅 쪽은 계속 쓰려고 한다.
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), 5);
    });
    child.stdout.on("end", () => resolve(out));
    child.on("error", reject);

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

test("느린 리더에게도 64KiB 를 넘는 출력이 완전하게 도착한다", async () => {
  // formatLeak 은 20건까지만 나열하므로 개인정보 경고로는 64KiB 를 채울 수 없다(위 (a)).
  // 대신 KIMCHI_AUTOFIX 로 큰 문서를 통째로 되돌려 받는 경로를 써서, 잘리면 곧바로
  // JSON.parse 가 던지도록 만든다 — 이 시험이 없으면 (a)/(c) 모두 실제로는 OS 파이프
  // 버퍼(64KiB) 밑에서만 돌아 truncation 수정 없이도 green 이 나올 수 있었다.
  const filler = "이 문단은 내용을 채우기 위한 자리표시자 문장입니다. ".repeat(3500);
  const content = `${filler}\n\n계약이 얇습니다.\n`;

  const out = await runHookSlow(
    GUARD,
    {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "slow.md", content },
    },
    { KIMCHI_AUTOFIX: "1" }
  );

  assert.ok(out.length > 65536, `표본이 OS 파이프 버퍼보다 커야 한다 (실제 ${out.length}바이트)`);
  const parsed = JSON.parse(out); // 잘렸으면 여기서 던진다
  assert.equal(parsed.hookSpecificOutput.permissionDecision, undefined);
  assert.match(parsed.hookSpecificOutput.updatedInput.content, /결합도가 낮습니다\.\s*$/, "출력 꼬리가 잘렸다");
});

// ── (d) lib/ 이 깨진 설치 ────────────────────────────────────

/** hooks/ 와 rules/ 를 임시 위치로 복사한다. */
function copyPlugin() {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-broken-"));
  cpSync(join(ROOT, "hooks"), join(dir, "hooks"), { recursive: true });
  cpSync(join(ROOT, "rules"), join(dir, "rules"), { recursive: true });
  return dir;
}

/** hooks/lib/<relPath> 를 없애거나 문법 오류를 심는다. */
function breakLib(dir, relPath, how) {
  const target = join(dir, "hooks", "lib", relPath);
  if (how === "missing") unlinkSync(target);
  else writeFileSync(target, "export function broken( {\n", "utf8");
}

const PII_PAYLOAD = {
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path: "a.txt", content: "주민번호 900101-1234568" },
};

// 이 저장소 자체가 한국어로 쓰는 저장소라 session-language.mjs 는 평소에도 아무 말을
// 하지 않는다. particle.mjs 는 애초에 session-language.mjs 의 의존성도 아니므로, 이
// 시험은 "particle.mjs 가 깨져도 무관한 훅까지 조용히 죽지 않는다"를 확인하는 것이다.
const SESSION_PAYLOAD = { cwd: process.cwd() };

const HOW = [
  ["없어졌을 때", "missing"],
  ["문법 오류가 있을 때", "syntax"],
];

// 말투 체인(artifact.mjs → particle/lint/rules/segment)만 걸린 파일들이다. 개인정보
// 검사는 이 체인에 기대지 않으므로, 이 파일들이 깨져도 주민등록번호는 여전히 막혀야 한다.
for (const relPath of ["particle.mjs", "artifact.mjs", "lint.mjs"]) {
  for (const [name, how] of HOW) {
    test(`hooks/lib/${relPath} 가 ${name} guard.mjs 는 그래도 주민등록번호를 막는다`, () => {
      const dir = copyPlugin();
      try {
        breakLib(dir, relPath, how);
        const result = spawnSync("node", [join(dir, "hooks", "guard.mjs")], {
          input: JSON.stringify(PII_PAYLOAD),
          encoding: "utf8",
          env: { ...process.env, KIMCHI_DISABLE: "", KIMCHI_PII: "" },
        });
        assert.equal(result.status, 0);
        assert.equal(result.stderr, "");
        const output = JSON.parse(result.stdout);
        assert.equal(
          output.hookSpecificOutput.permissionDecision,
          "deny",
          "말투 체인 고장이 개인정보 차단까지 끌고 내려가면 안 된다"
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test(`hooks/lib/${relPath} 가 깨져도 session-language.mjs 는 종료 코드 0, 빈 stdout/stderr 로 끝난다`, () => {
    const dir = copyPlugin();
    try {
      breakLib(dir, relPath, "missing");
      const result = spawnSync("node", [join(dir, "hooks", "session-language.mjs")], {
        input: JSON.stringify(SESSION_PAYLOAD),
        encoding: "utf8",
        env: { ...process.env, KIMCHI_DISABLE: "", KIMCHI_REPO_LANG: "" },
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// pii.mjs 는 개인정보 검사 그 자체다. 이게 깨지면 훅은 아무 결정도 못 내려야 한다 —
// 대신 판단하지 않는 것이 불변식 1 이고, 그래서 종료 코드 0, 빈 stdout/stderr 이 맞다.
for (const [name, how] of HOW) {
  test(`hooks/lib/pii.mjs 가 ${name} guard.mjs 는 종료 코드 0, 빈 stdout/stderr 로 끝난다`, () => {
    const dir = copyPlugin();
    try {
      breakLib(dir, "pii.mjs", how);
      const result = spawnSync("node", [join(dir, "hooks", "guard.mjs")], {
        input: JSON.stringify(PII_PAYLOAD),
        encoding: "utf8",
        env: { ...process.env, KIMCHI_DISABLE: "", KIMCHI_PII: "" },
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
