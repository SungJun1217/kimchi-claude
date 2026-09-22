import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFixes, hasFinalConsonant, isParticleSafe } from "../hooks/lib/lint.mjs";

const rule = (overrides = {}) => ({
  en: "",
  bad: "리팩토링",
  good: "리팩터링",
  why: "외래어 표기법",
  check: "치환",
  priority: "보통",
  source: "register.md",
  ...overrides,
});

test("받침 유무를 판정한다", () => {
  assert.equal(hasFinalConsonant("계약"), true);
  assert.equal(hasFinalConsonant("결합도"), false);
  assert.equal(hasFinalConsonant("커밋"), true);
  assert.equal(hasFinalConsonant("머지"), false);
  // 끝이 한글이 아니면 판정할 수 없다
  assert.equal(hasFinalConsonant("deep module"), null);
  assert.equal(hasFinalConsonant(""), null);
  assert.equal(hasFinalConsonant(null), null);
  // 끝의 공백은 건너뛴다
  assert.equal(hasFinalConsonant("계약  "), true);
});

test("뒤에 조사가 없으면 언제나 안전하다", () => {
  assert.ok(isParticleSafe("얇은 계약", "낮은 결합도", " "));
  assert.ok(isParticleSafe("얇은 계약", "낮은 결합도", ""));
  assert.ok(isParticleSafe("얇은 계약", "낮은 결합도", "."));
});

test("받침이 달라지면 조사 앞에서 막는다", () => {
  // 계약(받침 있음) → 결합도(받침 없음). "결합도을"이 되면 안 된다.
  assert.ok(!isParticleSafe("얇은 계약", "낮은 결합도", "을"));
  assert.ok(!isParticleSafe("얇은 계약", "낮은 결합도", "이"));
});

test("받침이 같으면 조사 앞에서도 통과한다", () => {
  assert.ok(isParticleSafe("제출", "커밋", "을"));
  assert.ok(isParticleSafe("합치기", "머지", "를"));
});

test("한글로 끝나지 않으면 조사 앞에서 막는다", () => {
  assert.ok(!isParticleSafe("깊은 모듈", "deep module", "을"));
});

test("단순 치환을 적용한다", () => {
  const { text, applied } = applyFixes("리팩토링이 필요합니다.", [rule()]);
  assert.equal(text, "리팩터링이 필요합니다.");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].replacement, "리팩터링");
});

test("조사가 깨질 치환은 건너뛰고 이유를 남긴다", () => {
  const thin = rule({ bad: "얇은 계약", good: "낮은 결합도", check: "치환" });
  const { text, applied, skipped } = applyFixes("얇은 계약을 유지하세요.", [thin]);
  assert.equal(text, "얇은 계약을 유지하세요.", "조사가 깨지는데도 바꿨다");
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /조사/);
});

test("같은 규칙이라도 조사가 없는 자리는 바꾼다", () => {
  const thin = rule({ bad: "얇은 계약", good: "낮은 결합도" });
  const { text } = applyFixes("얇은 계약 이야기입니다.", [thin]);
  assert.equal(text, "낮은 결합도 이야기입니다.");
});

test("물결표 규칙의 핵심만 바꾼다", () => {
  const passive = rule({ bad: "~되어질", good: "~될" });
  const { text } = applyFixes("곧 수정되어질 예정입니다.", [passive]);
  assert.equal(text, "곧 수정될 예정입니다.");
});

test("가운데 물결표가 있는 규칙은 바꾸지 않는다", () => {
  const ambiguous = rule({ bad: "~에 대한 ~를 진행", good: "~를 처리" });
  const input = "파일에 대한 검사를 진행했습니다.";
  const { text, applied } = applyFixes(input, [ambiguous]);
  assert.equal(text, input);
  assert.equal(applied.length, 0);
});

test("정규식 규칙은 바꾸지 않는다", () => {
  const warnOnly = rule({ bad: "당신의", good: "이 / 생략", check: "정규식" });
  const input = "당신의 코드입니다.";
  assert.equal(applyFixes(input, [warnOnly]).text, input);
});

test("프롬프트 규칙은 바꾸지 않는다", () => {
  const promptOnly = rule({ check: "프롬프트" });
  const input = "리팩토링이 필요합니다.";
  assert.equal(applyFixes(input, [promptOnly]).text, input);
});

test("여러 곳을 뒤에서부터 고쳐 위치가 어긋나지 않는다", () => {
  const { text, applied } = applyFixes("컨텐츠와 메세지를 고쳤습니다. 컨텐츠 하나 더.", [
    rule({ bad: "컨텐츠", good: "콘텐츠" }),
    rule({ bad: "메세지", good: "메시지" }),
  ]);
  assert.equal(text, "콘텐츠와 메시지를 고쳤습니다. 콘텐츠 하나 더.");
  assert.equal(applied.length, 3);
});

test("적용 목록을 위치 순으로 돌려준다", () => {
  const { applied } = applyFixes("메세지 뒤에 컨텐츠", [
    rule({ bad: "컨텐츠", good: "콘텐츠" }),
    rule({ bad: "메세지", good: "메시지" }),
  ]);
  assert.deepEqual(
    applied.map((item) => item.matched),
    ["메세지", "컨텐츠"]
  );
});

test("코드 블록 안은 고치지 않는다", () => {
  const input = ["```", "const 리팩토링 = 1;", "```", "리팩토링이 필요합니다."].join("\n");
  const { text, applied } = applyFixes(input, [rule()]);
  assert.ok(text.includes("const 리팩토링 = 1;"), "코드 안을 건드렸다");
  assert.ok(text.includes("리팩터링이 필요합니다."));
  assert.equal(applied.length, 1);
});

test("바꿀 표현이 비어 있으면 건너뛴다", () => {
  const empty = rule({ good: "~" });
  const input = "리팩토링이 필요합니다.";
  const { text, skipped } = applyFixes(input, [empty]);
  assert.equal(text, input);
  assert.equal(skipped.length, 1);
});

test("잘못된 입력에 안전하다", () => {
  assert.deepEqual(applyFixes("", [rule()]), { text: "", applied: [], skipped: [] });
  assert.deepEqual(applyFixes(null, [rule()]), { text: "", applied: [], skipped: [] });
  assert.equal(applyFixes("리팩토링", null).text, "리팩토링");
});
