// 주민등록번호 유출 검사.
//
// 이 시험의 절반은 오탐을 막는 것이다. 13자리 숫자를 무조건 막으면 정상 작업이 방해받고,
// 그러면 사람들이 훅을 끈다. 훅이 꺼지면 검사도 사라진다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findResidentNumbers, redact, formatLeak } from "../hooks/lib/pii.mjs";
import { extractPiiTargets as extractTargets } from "../hooks/lib/pii.mjs";
import { findResidentNumbers as skillFind } from "../skills/korean-identifiers/examples/resident-number.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "hooks", "guard.mjs");

function runHook(payload, env = {}) {
  const stdout = execFileSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, KIMCHI_DISABLE: "", KIMCHI_PII: "", ...env },
  });
  return stdout.trim() === "" ? null : JSON.parse(stdout);
}

const write = (content, filePath = "src/seed.ts") => ({
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path: filePath, content },
});

// 한글 문서에서 복사한 번호는 전각으로 온다. 형식만 맞는 가짜 번호다.
const FULLWIDTH_SAMPLE = "９００１０１－１２３４５６７"; // kimchi-allow-rrn

// ── 탐지 ────────────────────────────────────────────────────

test("전각 숫자와 전각 하이픈으로 적은 번호도 찾는다", () => {
  // \d 는 ASCII 숫자만 받는다. 전각이 한 글자만 섞여도 차단을 빠져나갔다.
  const mixed = ["９００１０１-1234567", "900101－1234567"]; // kimchi-allow-rrn
  for (const text of [FULLWIDTH_SAMPLE, ...mixed]) {
    assert.equal(findResidentNumbers(text).length, 1, `${text} 를 놓쳤다`);
  }
  assert.equal(redact(FULLWIDTH_SAMPLE), "900101-*******", "가린 값도 읽을 수 있어야 한다");
  const glued = "x９００１０１１２３４５６７"; // kimchi-allow-rrn
  assert.equal(findResidentNumbers(glued).length, 0, "글자 뒤 경계는 전각에서도 지킨다");
});

test("주민등록번호를 찾는다", () => {
  const found = findResidentNumbers("사용자 900101-1234567 를 넣었습니다.");
  assert.equal(found.length, 1);
  assert.equal(found[0].matched, "900101-1234567");
  assert.equal(found[0].line, 1);
});

test("하이픈이 없거나 공백이어도 찾는다", () => {
  assert.equal(findResidentNumbers("9001011234567").length, 1);
  assert.equal(findResidentNumbers("900101 1234567").length, 1);
});

test("줄 번호와 칸 번호를 알려준다", () => {
  const text = ["첫 줄", "둘째 줄에 900101-1234567 있음"].join("\n");
  const found = findResidentNumbers(text);
  assert.equal(found[0].line, 2);
  assert.equal(found[0].column, "둘째 줄에 ".length + 1);
});

test("여러 건을 모두 찾는다", () => {
  const text = ["900101-1234567", "850315-2345678"].join("\n");
  assert.equal(findResidentNumbers(text).length, 2);
});

// ── 오탐 방어 ───────────────────────────────────────────────

test("생년월일이 말이 되지 않으면 넘긴다", () => {
  // 13월, 32일은 없다. 임의의 13자리 숫자가 대부분 여기서 걸러진다.
  assert.equal(findResidentNumbers("901301-1234567").length, 0, "13월");
  assert.equal(findResidentNumbers("900132-1234567").length, 0, "32일");
  assert.equal(findResidentNumbers("900001-1234567").length, 0, "0월");
  assert.equal(findResidentNumbers("900100-1234567").length, 0, "0일");
});

test("성별 자리가 범위를 벗어나면 넘긴다", () => {
  assert.equal(findResidentNumbers("900101-9234567").length, 0, "9는 쓰이지 않는다");
  assert.equal(findResidentNumbers("900101-0234567").length, 0, "0은 쓰이지 않는다");
});

test("더 긴 숫자열 안에서는 잡지 않는다", () => {
  // 주문번호, 타임스탬프, 해시 앞부분이 우연히 형태를 만족할 수 있다.
  assert.equal(findResidentNumbers("1900101123456789").length, 0);
  assert.equal(findResidentNumbers("9001011234567890").length, 0);
});

test("식별자 안의 숫자는 잡지 않는다", () => {
  // \b 는 밑줄을 단어 문자로 보므로 이 사례가 통과해 버린다. 숫자 경계를 직접 본다.
  assert.equal(findResidentNumbers("const order_9001011234567 = 1;").length, 0);
  assert.equal(findResidentNumbers("ORDER9001011234567").length, 0);
});

test("자리수가 다르면 잡지 않는다", () => {
  assert.equal(findResidentNumbers("900101-123456").length, 0);
  assert.equal(findResidentNumbers("90101-1234567").length, 0);
  assert.equal(findResidentNumbers("전화 010-1234-5678").length, 0);
  assert.equal(findResidentNumbers("사업자 123-45-67891").length, 0);
});

test("허용 표시가 있는 줄은 넘긴다", () => {
  const text = 'const fake = "900101-1234567"; // kimchi-allow-rrn 형식만 맞는 가짜 값';
  assert.equal(findResidentNumbers(text).length, 0);
  // 표시가 없는 다른 줄은 그대로 잡는다.
  assert.equal(findResidentNumbers(`${text}\nconst real = "850315-2345678";`).length, 1);
});

test("잘못된 입력에 안전하다", () => {
  assert.deepEqual(findResidentNumbers(""), []);
  assert.deepEqual(findResidentNumbers(null), []);
  assert.deepEqual(findResidentNumbers(42), []);
});

// ── 보여 주기 ───────────────────────────────────────────────

test("경고에 번호를 그대로 싣지 않는다", () => {
  // 훅이 유출 경로가 되면 안 된다.
  const message = formatLeak(findResidentNumbers("900101-1234567"), "src/seed.ts");
  assert.ok(!message.includes("1234567"), "뒷자리가 그대로 남았다");
  assert.ok(message.includes("900101-*******"));
  assert.equal(redact("900101-1234567"), "900101-*******");
});

test("경고가 무엇을 해야 하는지 말한다", () => {
  const message = formatLeak(findResidentNumbers("900101-1234567"), "src/seed.ts");
  assert.match(message, /kimchi-allow-rrn/, "가짜 값을 쓸 길을 알려 준다");
  assert.match(message, /CI/, "대안을 알려 준다");
  assert.match(message, /커밋을 지워도 사라지지 않습니다/, "왜 막는지 밝힌다");
});

test("위반이 없으면 빈 메시지를 돌려준다", () => {
  assert.equal(formatLeak([]), "");
});

// ── 검사 대상 ───────────────────────────────────────────────

test("말투 린터와 달리 확장자를 가리지 않는다", () => {
  // 유출은 코드와 시험 자료에서 난다. 한국어 문서만 보면 놓친다.
  const content = "900101-1234567";
  for (const path of ["src/seed.ts", "test/fixture.json", "db/init.sql", "notes.md", "a.py"]) {
    assert.equal(extractTargets("Write", { file_path: path, content }).length, 1, path);
  }
});

test("사람이 쓴 것이 아닌 파일은 건너뛴다", () => {
  const content = "900101-1234567";
  for (const path of ["logo.png", "font.woff2", "package-lock.json", "bundle.wasm"]) {
    assert.equal(extractTargets("Write", { file_path: path, content }).length, 0, path);
  }
});

test("Bash 명령 전체를 본다", () => {
  // 커밋 메시지뿐 아니라 heredoc 으로 파일을 만드는 경우도 걸려야 한다.
  const targets = extractTargets("Bash", { command: "echo 900101-1234567 > seed.txt" });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].label, "명령");
});

test("MultiEdit 의 편집마다 검사한다", () => {
  const targets = extractTargets("MultiEdit", {
    file_path: "a.ts",
    edits: [{ new_string: "하나" }, { new_string: "둘" }, { old_string: "셋" }],
  });
  assert.equal(targets.length, 2);
});

// ── 훅 동작 ─────────────────────────────────────────────────

test("기본값은 차단이다", () => {
  // 말투 린터와 정반대다. 밀어 버린 번호는 되돌릴 수 없다.
  const output = runHook(write('const seed = "900101-1234567";'));
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /주민등록번호로 보이는 값/);
});

test("깨끗한 파일은 통과시킨다", () => {
  assert.equal(runHook(write("const total = 1234567;")), null);
  assert.equal(runHook(write("전화번호는 010-1234-5678 입니다.")), null);
});

test("KIMCHI_PII=warn 은 막지 않고 알려만 준다", () => {
  const output = runHook(write('const seed = "900101-1234567";'), { KIMCHI_PII: "warn" });
  assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
  assert.match(output.systemMessage, /주민등록번호로 보이는 값/);
});

test("KIMCHI_PII=off 와 KIMCHI_DISABLE=1 은 아무것도 하지 않는다", () => {
  const payload = write('const seed = "900101-1234567";');
  assert.equal(runHook(payload, { KIMCHI_PII: "off" }), null);
  assert.equal(runHook(payload, { KIMCHI_DISABLE: "1" }), null);
});

test("커밋 명령에서도 막는다", () => {
  const output = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: 'git commit -m "사용자 900101-1234567 자료 추가"' },
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("망가진 입력에도 종료 코드 0으로 조용히 끝난다", () => {
  for (const input of ["", "not json", "{}", "null", '{"tool_name":"Write"}']) {
    const stdout = execFileSync("node", [HOOK], { input, encoding: "utf8" });
    assert.equal(stdout.trim(), "", `입력 "${input}" 에서 출력이 나왔다`);
  }
});

// ── 두 구현의 일치 ──────────────────────────────────────────

test("스킬 예시와 런타임 탐지기가 같은 판정을 내린다", () => {
  // 스킬 예시는 사용자가 자기 프로젝트로 복사해 갈 교재라 자기완결이어야 한다.
  // 그래서 두 벌로 두되, 판정이 갈리지 않도록 여기서 묶는다.
  const cases = [
    "900101-1234567",
    "9001011234567",
    "850315-2345678",
    "901301-1234567",
    "900101-9234567",
    "900101-123456",
    "전화 010-1234-5678",
    "사업자 123-45-67891",
    "아무 글도 없음",
    FULLWIDTH_SAMPLE,
    "９００１０１-1234567", // kimchi-allow-rrn 형식만 맞는 가짜 번호
  ];
  for (const text of cases) {
    const runtime = findResidentNumbers(text).length > 0;
    const skill = skillFind(text).length > 0;
    assert.equal(runtime, skill, `"${text}" 에서 판정이 갈린다`);
  }
});
