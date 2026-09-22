import { test } from "node:test";
import assert from "node:assert/strict";
import { maskProtected, isMasked, isIgnoredFile, MASK } from "../hooks/lib/segment.mjs";

// 이 파일의 시험은 이 플러그인의 가장 큰 위험을 막는다.
// contract 라는 변수명을 "계약"으로 고치라고 하는 오탐이다.

test("길이를 보존한다", () => {
  const text = "이 함수는 `contract` 를 검사합니다.";
  assert.equal(maskProtected(text).length, text.length);
});

test("인라인 코드를 덮는다", () => {
  const text = "이 값은 `contract` 입니다.";
  const masked = maskProtected(text);
  assert.ok(!masked.includes("contract"), "인라인 코드 안의 식별자가 남아 있다");
  assert.ok(masked.includes("이 값은"), "한글 본문이 덮였다");
});

test("울타리 코드 블록을 덮는다", () => {
  const text = ["설명입니다.", "```js", "const contract = 1;", "```", "끝입니다."].join("\n");
  const masked = maskProtected(text);
  assert.ok(!masked.includes("const contract"));
  assert.ok(masked.includes("설명입니다."));
  assert.ok(masked.includes("끝입니다."));
});

test("울타리 안의 백틱에 속지 않는다", () => {
  const text = ["```", "`a` 그리고 `b`", "```", "본문 `c` 입니다."].join("\n");
  const masked = maskProtected(text);
  assert.ok(!masked.includes("`a`"));
  assert.ok(!masked.includes("c"), "울타리 밖 인라인 코드도 덮여야 한다");
  assert.ok(masked.includes("본문"));
});

test("URL을 덮는다", () => {
  const text = "문서는 https://example.com/contract 에 있습니다.";
  const masked = maskProtected(text);
  assert.ok(!masked.includes("example.com"));
  assert.ok(masked.includes("문서는"));
});

test("파일 경로를 덮는다", () => {
  const text = "hooks/lib/contract.mjs 를 고쳤습니다.";
  const masked = maskProtected(text);
  assert.ok(!masked.includes("contract"));
  assert.ok(masked.includes("고쳤습니다"));
});

test("확장자가 붙은 파일명을 덮는다", () => {
  const text = "contract.json 파일입니다.";
  const masked = maskProtected(text);
  assert.ok(!masked.includes("contract"));
  assert.ok(masked.includes("파일입니다"));
});

test("환경변수와 명령행 옵션을 덮는다", () => {
  const masked = maskProtected("${KIMCHI_DISABLE} 와 --dry-run 을 씁니다.");
  assert.ok(!masked.includes("KIMCHI_DISABLE"));
  assert.ok(!masked.includes("dry-run"));
  assert.ok(masked.includes("씁니다"));
});

test("한글만 있는 문장은 그대로 둔다", () => {
  const text = "결합도를 낮추면 변경 범위가 줄어듭니다.";
  assert.equal(maskProtected(text), text);
});

test("빈 문자열과 잘못된 입력에 안전하다", () => {
  assert.equal(maskProtected(""), "");
  assert.equal(maskProtected(null), "");
  assert.equal(maskProtected(undefined), "");
  assert.equal(maskProtected(42), "");
});

test("isMasked가 덮인 구간을 알려준다", () => {
  const text = "앞 `x` 뒤";
  const masked = maskProtected(text);
  const backtick = text.indexOf("`");
  assert.ok(isMasked(masked, backtick, 3));
  assert.ok(!isMasked(masked, 0, 1));
});

test("센티넬이 원문에 이미 있어도 깨지지 않는다", () => {
  const text = `앞${MASK}뒤 \`x\``;
  const masked = maskProtected(text);
  assert.equal(masked.length, text.length);
});

test("문서 전체 예외 표시를 알아본다", () => {
  assert.ok(isIgnoredFile("앞말\n<!-- kimchi-ignore-file -->\n뒷말"));
  assert.ok(isIgnoredFile("<!--kimchi-ignore-file-->"));
  assert.ok(!isIgnoredFile("보통 문서입니다."));
  assert.ok(!isIgnoredFile(null));
});

test("구간 예외 표시 안쪽을 덮는다", () => {
  const text = [
    "여기는 검사합니다.",
    "<!-- kimchi-ignore-start -->",
    "얇은 계약을 인용합니다.",
    "<!-- kimchi-ignore-end -->",
    "여기도 검사합니다.",
  ].join("\n");
  const masked = maskProtected(text);
  assert.ok(!masked.includes("얇은 계약"), "예외 구간이 덮이지 않았다");
  assert.ok(masked.includes("여기는 검사합니다."));
  assert.ok(masked.includes("여기도 검사합니다."));
});

test("한 줄 예외 표시는 그 줄만 덮는다", () => {
  const text = ["얇은 계약 하나", "얇은 계약 둘 <!-- kimchi-ignore -->", "얇은 계약 셋"].join("\n");
  const masked = maskProtected(text);
  assert.equal(masked.split("\n")[0], "얇은 계약 하나");
  assert.ok(!masked.split("\n")[1].includes("얇은 계약"));
  assert.equal(masked.split("\n")[2], "얇은 계약 셋");
});
