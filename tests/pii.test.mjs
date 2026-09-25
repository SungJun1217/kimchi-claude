// 주민등록번호 유출 검사.
//
// 이 시험의 절반은 오탐을 막는 것이다. 13자리 숫자를 무조건 막으면 정상 작업이 방해받고,
// 그러면 사람들이 훅을 끈다. 훅이 꺼지면 검사도 사라진다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findResidentNumbers, redact, redactText, formatLeak } from "../hooks/lib/pii.mjs";
import { extractPiiTargets as extractTargets } from "../hooks/lib/pii.mjs";
import { findResidentNumbers as skillFind } from "../skills/korean-identifiers/examples/resident-number.mjs";
import { fastestMs } from "./helpers.mjs";

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
    // 경로 자체도 대상이라(2번 항목) content 대상과 합쳐 2건이다.
    assert.equal(extractTargets("Write", { file_path: path, content }).length, 2, path);
  }
});

test("파일 경로 자체도 검사 대상이다", () => {
  const targets = extractTargets("Write", { file_path: "/tmp/users/900101-1234567.txt", content: "no rrn here" });
  assert.equal(targets.length, 2);
  assert.ok(targets.some((t) => t.kind === "path" && t.text === "/tmp/users/900101-1234567.txt"));
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
  // 편집 2건 + 경로 자체 1건.
  assert.equal(targets.length, 3);
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
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined, "경고는 권한 프롬프트를 건너뛰면 안 된다");
  assert.match(output.systemMessage, /주민등록번호로 보이는 값/);
  assert.match(output.hookSpecificOutput.additionalContext, /주민등록번호로 보이는 값/, "모델에게도 경고가 닿아야 한다");
});

test("KIMCHI_PII=warn 과 KIMCHI_AUTOFIX=1 이 겹치면 결정 없이 두 메시지가 모두 additionalContext 에 실린다", () => {
  const output = runHook(write("주민번호 900101-1234567, 리팩토링 후 컨텐츠 정리", "notes.md"), {
    KIMCHI_PII: "warn",
    KIMCHI_AUTOFIX: "1",
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined, "경고+교정이 겹쳐도 결정을 실으면 안 된다");
  assert.match(output.systemMessage, /주민등록번호로 보이는 값/);
  assert.match(output.hookSpecificOutput.additionalContext, /주민등록번호로 보이는 값/);
  assert.match(output.hookSpecificOutput.additionalContext, /입력을 고쳤습니다/);
});

test("KIMCHI_PII=warn 과 KIMCHI_BLOCK=1 이 겹치면 차단은 그대로고, 개인정보 경고도 additionalContext 에 실린다", () => {
  // 말투 쪽이 deny 를 낼 때는 원래 additionalContext 가 없다 — 개인정보 경고를 "이미 있으면
  // 덧붙인다"로만 처리하면 이 조합에서 모델에게 경고가 전달되지 않는 회귀가 난다.
  const output = runHook(write("주민번호 900101-1234567, 리팩토링 후 컨텐츠 정리", "notes.md"), {
    KIMCHI_PII: "warn",
    KIMCHI_BLOCK: "1",
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny", "말투 차단은 개인정보 경고와 무관하게 그대로다");
  assert.match(output.systemMessage, /주민등록번호로 보이는 값/);
  assert.match(output.hookSpecificOutput.additionalContext, /주민등록번호로 보이는 값/, "차단 응답에도 모델용 경고가 있어야 한다");
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
    "900101–1234567", // en-dash
    "900101 - 1234567",
    "900101\t1234567", // tab
    "900101.1234567", // 점은 부동소수점과 겹쳐 실측 후 뺐다 — 이제 둘 다 clean
    "900101_1234567", // 밑줄은 ORD_/IMG_ 식별자와 겹쳐 실측 후 뺐다 — 이제 둘 다 clean
    "900101/1234567", // 슬래시는 날짜/번호 나열과 겹쳐 실측 후 뺐다 — 이제 둘 다 clean
    "x900101-1234567",
    "order_9001011234567",
    "1.900101.1234567",
    "ts=1607011234567",
    "127.1201151234567",
  ];
  for (const text of cases) {
    const runtime = findResidentNumbers(text).length > 0;
    const skill = skillFind(text).length > 0;
    assert.equal(runtime, skill, `"${text}" 에서 판정이 갈린다`);
  }
});

// ── 구분자·보이지 않는 문자 회피(결함 1) ─────────────────────

test("대시류 변종과 보이지 않는 서식 문자를 끼워도 잡는다", () => {
  const dashes = ["–", "—", "−", "‐", "‑", "﹣"];
  for (const dash of dashes) {
    const text = `900101${dash}1234567`;
    assert.equal(findResidentNumbers(text).length, 1, `대시 ${dash.codePointAt(0).toString(16)} 를 놓쳤다`);
  }

  assert.equal(findResidentNumbers("900101 - 1234567").length, 1, "공백-대시-공백");
  assert.equal(findResidentNumbers("900101  1234567").length, 1, "공백 두 칸");

  const invisibles = ["​", "‌", "‍", "⁠", "­", "﻿"];
  for (const zw of invisibles) {
    const found = findResidentNumbers(`900101${zw}-1234567`);
    assert.equal(found.length, 1, `보이지 않는 문자 ${zw.codePointAt(0).toString(16)} 가 번호를 끊었다`);
    assert.equal(found[0].matched, "900101-1234567");
  }
});

test("아라비아 숫자와 수학 굵은 숫자도 NFKC 로 접어 찾는다", () => {
  // 아라비아 숫자(٠-٩)는 NFKC 가 안 접어 준다 — 직접 접어야 한다.
  assert.equal(findResidentNumbers("٩٠٠١٠١-1234567").length, 1, "아라비아 숫자");
  // 수학 굵은 숫자는 NFKC 가 접어 준다.
  assert.equal(
    findResidentNumbers("\u{1D7DF}\u{1D7D8}\u{1D7D8}\u{1D7D9}\u{1D7D8}\u{1D7D9}-1234567").length,
    1,
    "수학 굵은 숫자"
  );
});

test("실제 자료에서는 깨끗하다 — 날짜·버전·IP·전화·사업자번호", () => {
  const clean = [
    "2024/01/01",
    "2024-09-24",
    "1.2.3",
    "v10.20.30",
    "192.168.1.1",
    "10.0.0.1",
    "전화 010-1234-5678",
    "사업자 123-45-67891",
    "1.900101.1234567", // 버전 문자열 속 숫자
  ];
  for (const text of clean) {
    assert.equal(findResidentNumbers(text).length, 0, `"${text}" 에서 오탐이 났다`);
  }
});

// ── 탭·NBSP·표의문자 공백도 구분자로 본다(결함 2, 2차 검토) ──

test("탭·NBSP·표의문자 공백으로 나눠도 잡는다", () => {
  assert.equal(findResidentNumbers("900101\t1234567").length, 1, "탭");
  assert.equal(findResidentNumbers("이름\t900101\t1234567").length, 1, "글 속 탭");
  assert.equal(findResidentNumbers("900101 1234567").length, 1, "NBSP");
  assert.equal(findResidentNumbers("900101　1234567").length, 1, "표의문자 공백");
  assert.equal(
    findResidentNumbers("９００１０１　１２３４５６７")
      .length,
    1,
    "전각 숫자 + 표의문자 공백"
  );
});

// ── 점·밑줄·슬래시는 일반 텍스트에서 뺐다(결함 4, 2차 검토) ──

test("점·밑줄·슬래시 구분자는 이제 일반 텍스트에서 잡지 않는다", () => {
  // 실측: 점은 6.7 자리 부동소수점(좌표·정밀 금액)과, 밑줄은 ORD_/IMG_ 류 식별자와,
  // 슬래시는 날짜/번호 나열과 겹친다. 대시·공백류만 남긴다.
  assert.equal(findResidentNumbers("amount 900101.1234567").length, 0);
  assert.equal(findResidentNumbers("ORD_900101_1234567").length, 0);
  assert.equal(findResidentNumbers("240101/1234567").length, 0);
});

// ── 글자 뒤에 와도 구분자가 있으면 잡는다(결함 2) ────────────

test("구분자가 있으면 앞에 글자가 있어도 잡는다", () => {
  assert.equal(findResidentNumbers("x900101-1234567").length, 1);
  assert.equal(findResidentNumbers("주민번호:900101-1234567").length, 1);
});

test("구분자가 없으면 글자 뒤 식별자는 여전히 제외한다", () => {
  assert.equal(findResidentNumbers("x9001011234567").length, 0);
  assert.equal(findResidentNumbers("const order_9001011234567 = 1;").length, 0);
});

// ── 타임스탬프·부동소수점 오탐(결함 3) ────────────────────────

test("유닉스 밀리초 타임스탬프는 JSON 값·대입문 문맥에서 잡지 않는다", () => {
  assert.equal(findResidentNumbers('{"createdAt": 1710151234567}').length, 0);
  assert.equal(findResidentNumbers("ts=1607011234567").length, 0);
  assert.equal(findResidentNumbers('{"updatedAt": 1601011234567}').length, 0);
  assert.equal(findResidentNumbers("created_at=1607011234567").length, 0);
});

test("소수점 뒤에 붙은 13자리는 잡지 않는다", () => {
  assert.equal(findResidentNumbers("127.1201151234567").length, 0);
  assert.equal(findResidentNumbers("0.9001011234567").length, 0);
});

test("구분자가 있는 형태는 문맥과 무관하게 여전히 의심한다", () => {
  // 과제 명세: 대시가 있으면 항상 의심한다. 타임스탬프 문맥 예외(콜론/대입 + 시간을
  // 가리키는 열쇠말)는 붙지 않은 형태에만 적용되고, 시간과 무관한 열쇠말(rrn)에는
  // 적용되지 않는다.
  assert.equal(findResidentNumbers("ts: 9001011234567").length, 0, "붙은 형태 + 콜론 + 시간 열쇠말은 예외");
  assert.equal(findResidentNumbers("rrn: 9001011234567").length, 1, "시간 열쇠말이 아니면 그대로 잡는다");
  assert.equal(findResidentNumbers('rrn: "900101-1234567"').length, 1, "구분자가 있으면 그대로 잡는다");
});

// ── 예외는 줄 전체가 아니라 콜론/대입 바로 앞 키로만 판단한다(결함 1, 2차 검토) ──

test("같은 줄에 시간 낱말이 있어도 그 필드의 키가 시간이 아니면 잡는다", () => {
  // 1차 구현은 "줄에 시간 낱말이 있으면" 식으로 판단해서, 같은 줄의 다른 필드
  // (created_at, date, time 등) 때문에 rrn 자신이 빠져나가는 회귀가 있었다.
  const mustBlock = [
    '{"id":1,"rrn":"9001011234567","created_at":"2024-01-01"}',
    '{"name":"홍길동","rrn":"9001011234567","createdAt":"..."}',
    "rrn=9001011234567 date=2024-01-01",
    "// see seed.ts  const RRN = 9001011234567;",
    "rrn: 9001011234567  # 10 ms",
    "주민번호=9001011234567 (update date)",
    "user.rrn = 9001011234567 // TODO: time",
  ];
  for (const text of mustBlock) {
    assert.ok(findResidentNumbers(text).length > 0, `"${text}" 를 놓쳤다`);
  }
});

test("ms 와 맨 ts 는 열쇠말에서 뺐다 — 너무 흔한 substring 이다", () => {
  assert.equal(findResidentNumbers("results=9001011234567").length, 1, "results 는 ts 를 부분 문자열로 담을 뿐이다");
  assert.equal(findResidentNumbers("items=9001011234567").length, 1, "items 도 마찬가지다");
});

// ── NotebookEdit 도 지킨다(결함 4) ────────────────────────────

test("NotebookEdit 의 new_source 도 검사 대상이다", () => {
  const targets = extractTargets("NotebookEdit", {
    notebook_path: "nb.ipynb",
    new_source: 'x = "900101-1234567"',
  });
  assert.ok(targets.some((t) => t.kind === "edit" && t.text.includes("900101-1234567")));
});

test("훅이 NotebookEdit 을 실제로 막는다", () => {
  const output = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "NotebookEdit",
    tool_input: { notebook_path: "nb.ipynb", new_source: 'x = "900101-1234567"' },
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /주민등록번호로 보이는 값/);
});

// ── file_path 자체도 검사하고, 메시지에서는 가린다(결함 5) ────

test("file_path 에 주민등록번호가 있으면 막고, 메시지에서 가린다", () => {
  const output = runHook(
    write("전혀 문제 없는 내용", "/tmp/users/900101-1234567.txt")
  );
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  const reason = output.hookSpecificOutput.permissionDecisionReason;
  assert.ok(!reason.includes("900101-1234567"), "경로에 실린 번호가 그대로 새어 나왔다");
  assert.match(reason, /900101-\*{7}/);
});

test("redactText 는 문자열 속 번호만 가리고 나머지는 그대로 둔다", () => {
  assert.equal(redactText("/tmp/users/900101-1234567.txt"), "/tmp/users/900101-*******.txt");
  assert.equal(redactText("src/seed.ts"), "src/seed.ts", "번호가 없으면 그대로다");
  assert.equal(redactText(""), "");
});

test("redactText 는 보이지 않는 문자가 껴 있어도 뒷자리까지 완전히 가린다", () => {
  // matched(clean 문자열에서 뽑음)의 길이만으로 자르면, 사이에 끼어 있던 ZWSP 만큼
  // 원문 구간이 더 길어서 뒷자리 숫자가 한 글자 남는다(회귀).
  const leaky = "/tmp/900101​-1234567.txt";
  const redacted = redactText(leaky, { pathOnly: true });
  assert.equal(redacted, "/tmp/900101-*******.txt");
  for (const digit of "1234567") {
    assert.ok(!redacted.includes(`-${digit}`) && !redacted.slice(11).match(/\d/), `뒷자리 숫자가 새어 나왔다: ${redacted}`);
  }
});

// ── 경로 전용 규칙(결함 3, 2차 검토) ───────────────────────────

test("파일 이름 관례에서 나는 오탐은 경로 전용 규칙으로 거른다", () => {
  const pathClean = [
    "backup_250101_1234567.sql",
    "/sdcard/DCIM/IMG_900101_1234567.jpg.txt",
    "Screenshot_240101_1234567.txt",
    "logs/240101/1234567.log",
    "build/250101.1234567/x.js",
    "cache/ab/250101/1234567/data.json",
    "reports/2501011234567.csv",
  ];
  for (const p of pathClean) {
    assert.equal(findResidentNumbers(p, { pathOnly: true }).length, 0, `"${p}" 에서 오탐이 났다`);
  }
});

test("경로에서도 순수 대시 형태(앞에 글자 없이)는 여전히 의심한다 — 받아들인 트레이드오프", () => {
  // `/tmp/run-250102-1034567/` 처럼 대시로만 이은 6자리-7자리는 주민등록번호와 모양이
  // 똑같아 구분할 수 없다. kimchi-allow-rrn 대신 이름을 바꾸라고 안내한다(메시지 확인은 아래).
  assert.equal(findResidentNumbers("/tmp/run-250102-1034567/out.txt", { pathOnly: true }).length, 1);
});

test("훅이 경로 오탐 목록을 막지 않는다", () => {
  for (const path of [
    "backup_250101_1234567.sql",
    "logs/240101/1234567.log",
    "reports/2501011234567.csv",
  ]) {
    assert.equal(runHook(write("깨끗한 내용", path)), null, `"${path}" 를 막았다`);
  }
});

test("경로에서 찾았으면 kimchi-allow-rrn 대신 이름을 바꾸라고 안내한다", () => {
  const output = runHook(write("깨끗한 내용", "/tmp/run-250102-1034567/out.txt"));
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  const reason = output.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /이름을 바꾸십시오/);
  assert.ok(!reason.includes("주석을 붙이십시오"), "경로에 붙일 수 없는 주석을 시켰다");
});

// ── 위치를 더 정확히 말한다(결함 6) ───────────────────────────

test("MultiEdit 은 몇 번째 편집인지 메시지에 밝힌다", () => {
  const output = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "MultiEdit",
    tool_input: {
      file_path: "a.ts",
      edits: [{ new_string: "깨끗한 텍스트" }, { new_string: 'const seed = "900101-1234567";' }],
    },
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /2번째 편집/);
});

test("Edit 은 새 텍스트 기준임을 밝힌다", () => {
  const output = runHook({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "a.ts", old_string: "x", new_string: 'const seed = "900101-1234567";' },
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /새 텍스트 기준/);
});

test("이모지 앞의 열 번호는 코드 포인트 기준이다", () => {
  const found = findResidentNumbers("\u{1F600}900101-1234567");
  assert.equal(found.length, 1);
  assert.equal(found[0].column, 2, "이모지 하나 + 1 이어야 한다(UTF-16 서로게이트 두 단위가 아니라)");
});

// ── 타이밍 ──────────────────────────────────────────────────

test("타이밍: 1MB 짜리 한 줄에서도 오늘의 자릿수 안에서 끝난다", () => {
  const line = "a1b23c4567 ".repeat(100000);
  // 병렬로 도는 다른 시험 때문에 한 번 잰 값이 튈 수 있다. 최솟값이 실제 비용에
  // 가깝고, 이차 비용 회귀는 최솟값에도 그대로 남는다(helpers.mjs 의 fastestMs 참고).
  const ms = fastestMs(() => findResidentNumbers(line));
  console.log(`    1MB 한 줄: ${ms}ms (길이 ${line.length})`);
  assert.ok(ms < 500, `1MB 한 줄 검사가 ${ms}ms 걸렸다`);
});

test("타이밍: 5만 행 CSV 에서도 오늘의 자릿수 안에서 끝난다", () => {
  const rows = Array.from({ length: 50000 }, (_, i) => `row${i},value,2024-01-0${(i % 9) + 1}`).join("\n");
  const ms = fastestMs(() => findResidentNumbers(rows));
  console.log(`    5만 행 CSV: ${ms}ms`);
  assert.ok(ms < 500, `5만 행 CSV 검사가 ${ms}ms 걸렸다`);
});

test("타이밍: 1MB 짜리 한글 문서도 아스키만큼 빠르다", () => {
  // 접을 문자가 없는 한글 텍스트는 빠른 경로를 타야 한다. 예전 구현은 "아스키뿐인가"로만
  // 빠른 경로를 갈랐는데, 그러면 한글이 섞인 순간 코드 포인트 배열을 매번 새로 만들어
  // 30배 가까이 느려졌다(1MB 한 줄 기준 5ms → 180ms, 실측 회귀).
  //
  // 절대 시간은 부하가 큰 환경(병렬로 도는 다른 시험)에서 흔들린다. 그래서 같은 줄
  // 앞에 탭 하나만 붙여 느린 경로(코드 포인트 배열 생성)를 강제로 태운 값과 비교한다
  // — 빠른 경로가 그 느린 경로보다 확연히 빨라야 한다는 조건은 부하와 무관하게 유효하다.
  const line = "결합도를 낮추면 변경 범위가 줄어듭니다. ".repeat(30000);
  const fastMs = fastestMs(() => findResidentNumbers(line));
  const slowMs = fastestMs(() => findResidentNumbers(`\t${line}`));
  console.log(`    1MB 한글 줄: 빠른 경로 ${fastMs}ms, 느린 경로(강제) ${slowMs}ms`);
  assert.ok(fastMs < 300, `1MB 한글 줄 검사가 ${fastMs}ms 걸렸다 — 빠른 경로를 안 탔다`);
  assert.ok(
    fastMs * 5 < slowMs,
    `빠른 경로(${fastMs}ms)가 느린 경로(${slowMs}ms)에 견줘 충분히 빠르지 않다 — 빠른 경로를 안 탄 것 같다`
  );
});

test("생년월일 키와 at 으로 끝나는 보통 키는 시간 키로 보지 않는다", () => {
  // 시간 키 꼬리를 아무 글자나 받자 dateOfBirth 가, 대소문자를 무시하자 lat 이 빠져나갔다.
  for (const text of [
    '{"dateOfBirth":"9001011234567"}',
    "date_of_birth=9001011234567",
    "lat: 9001011234567",
    "format=9001011234567",
    "birthdate: 9001011234567",
  ]) {
    assert.equal(findResidentNumbers(text).length, 1, text);
  }
  for (const text of ['{"createdAt":9001011234567}', "issued_at: 9001011234567", '"ts" : 9001011234567', "DATE=9001011234567", "updated_at=9001011234567"]) {
    assert.equal(findResidentNumbers(text).length, 0, text);
  }
});

test("\\s 가 받던 공백 구분자는 모두 잡는다", () => {
  // 탭·NBSP·U+3000 만 접자 엔 스페이스·가는 공백·좁은 NBSP·세로 탭·폼 피드를 놓쳤다.
  for (const space of [" ", " ", " ", "\u000B", "\u000C", " ", " "]) {
    const text = `번호 900101${space}1234567`;
    assert.equal(findResidentNumbers(text).length, 1, JSON.stringify(space));
    assert.equal(skillFind(text).length, 1, JSON.stringify(space));
  }
});
