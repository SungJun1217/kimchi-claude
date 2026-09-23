import { test } from "node:test";
import assert from "node:assert/strict";
import { rule as base } from "./helpers.mjs";
import { lint, toPattern, formatFindings } from "../hooks/lib/lint.mjs";

// 이 시험 묶음의 기본값만 여기서 정하고, 규칙 객체 모양은 helpers 가 갖는다.
const rule = (overrides = {}) => base({ check: "정규식", good: "결합도", source: "test.md", ...overrides });

test("정규식 규칙이 위반을 찾는다", () => {
  const findings = lint("여기서 얇은 계약을 유지하세요.", [rule()]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].matched, "얇은 계약");
  assert.equal(findings[0].good, "결합도");
});

test("위치가 원문 기준으로 정확하다", () => {
  const text = "앞말 얇은 계약 뒷말";
  const findings = lint(text, [rule()]);
  assert.equal(findings[0].index, text.indexOf("얇은 계약"));
});

test("프롬프트 규칙은 검사하지 않는다", () => {
  const findings = lint("얇은 계약입니다.", [rule({ check: "프롬프트" })]);
  assert.equal(findings.length, 0);
});

test("인라인 코드 안의 같은 문자열은 잡지 않는다", () => {
  const findings = lint("`얇은 계약` 이라는 용어", [rule()]);
  assert.equal(findings.length, 0, "제외 구간에서 매치가 일어났다");
});

test("코드 블록 안의 같은 문자열은 잡지 않는다", () => {
  const text = ["```", "// 얇은 계약", "```"].join("\n");
  assert.equal(lint(text, [rule()]).length, 0);
});

test("식별자 오탐을 막는다", () => {
  // contract 를 계약으로 고치라는 규칙이 변수명에 걸리면 안 된다.
  const contractRule = rule({ bad: "계약", good: "인터페이스" });
  const findings = lint("`contract` 를 `Contract` 로 바꿨습니다.", [contractRule]);
  assert.equal(findings.length, 0);
});

test("한 글자 규칙은 위험해서 쓰지 않는다", () => {
  assert.equal(toPattern("들"), null);
  assert.equal(lint("파일들을 읽습니다.", [rule({ bad: "들" })]).length, 0);
});

test("물결표는 앞뒤 무엇이든을 뜻한다", () => {
  const pattern = toPattern("~되어질");
  assert.ok(pattern.test("수정되어질 것입니다"));
  const findings = lint("수정되어질 예정입니다.", [rule({ bad: "~되어질", good: "~될" })]);
  assert.equal(findings.length, 1);
});

test("가운데 물결표가 사이를 건너뛴다", () => {
  const findings = lint("파일에 대한 검사를 진행했습니다.", [
    rule({ bad: "~에 대한 ~를 진행", good: "~를 검사" }),
  ]);
  assert.equal(findings.length, 1);
});

test("정규식 특수문자를 문자 그대로 다룬다", () => {
  const findings = lint("점(.)과 별표(*)입니다.", [rule({ bad: "(.)과 별표(*)", good: "기호" })]);
  assert.equal(findings.length, 1);
});

test("한 규칙의 보고 수를 제한한다", () => {
  const text = "얇은 계약 얇은 계약 얇은 계약 얇은 계약 얇은 계약";
  assert.equal(lint(text, [rule()]).length, 3);
});

test("여러 규칙의 결과를 위치 순으로 돌려준다", () => {
  const text = "뒤에 얇은 계약, 앞에 두꺼운 모델";
  const findings = lint(text, [rule(), rule({ bad: "두꺼운 모델", good: "책임이 과한 모델" })]);
  assert.equal(findings.length, 2);
  assert.ok(findings[0].index < findings[1].index);
});

test("잘못된 입력에 안전하다", () => {
  assert.deepEqual(lint("", [rule()]), []);
  assert.deepEqual(lint(null, [rule()]), []);
  assert.deepEqual(lint("얇은 계약", null), []);
  assert.deepEqual(lint("얇은 계약", []), []);
});

test("메시지에 대체 표현과 이유가 들어간다", () => {
  const message = formatFindings(lint("얇은 계약입니다.", [rule()]), "커밋 메시지");
  assert.match(message, /커밋 메시지/);
  assert.match(message, /결합도/);
  assert.match(message, /은유 직역/);
});

test("같은 지적을 반복해 싣지 않는다", () => {
  const message = formatFindings(lint("얇은 계약 얇은 계약", [rule()]));
  assert.equal(message.split("\n").filter((line) => line.startsWith("- ")).length, 1);
});

test("위반이 없으면 빈 메시지를 돌려준다", () => {
  assert.equal(formatFindings([]), "");
});

test("문서 전체 예외 표시가 있으면 검사하지 않는다", () => {
  const text = "<!-- kimchi-ignore-file -->\n얇은 계약을 인용합니다.";
  assert.deepEqual(lint(text, [rule()]), []);
});
