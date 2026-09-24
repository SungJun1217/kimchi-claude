import { test } from "node:test";
import assert from "node:assert/strict";
import { maskProtected, isIgnoredFile, MASK } from "../hooks/lib/segment.mjs";

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

test("F7: 마크다운 들여쓰기 코드 블록을 덮는다 (.md)", () => {
  const text = ["설명입니다.", "", "    const 메세지 = \"컨텐츠\";", "", "끝입니다."].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(!masked.includes("컨텐츠"));
  assert.ok(masked.includes("설명입니다."));
  assert.ok(masked.includes("끝입니다."));
});

test("F7: 탭으로 들여쓴 코드 블록도 덮는다 (.md)", () => {
  const text = ["설명입니다.", "", "\tconst 메세지 = \"컨텐츠\";", "", "끝입니다."].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(!masked.includes("컨텐츠"));
});

test("F7: rST code-block 지시자 뒤의 들여쓰기 블록을 덮는다 (.rst)", () => {
  const text = [".. code-block:: python", "", "    print(\"컨텐츠\")", "", "본문입니다."].join("\n");
  const masked = maskProtected(text, "rst");
  assert.ok(!masked.includes("컨텐츠"));
  assert.ok(masked.includes("본문입니다."));
});

test("F7: ::로 끝나는 rST 문단 뒤의 들여쓰기 블록을 덮는다 (.rst)", () => {
  const text = ["예시입니다::", "", "    컨텐츠 처리", "", "본문입니다."].join("\n");
  const masked = maskProtected(text, "rst");
  assert.ok(!masked.includes("컨텐츠"));
});

test("F7: AsciiDoc ---- 리스팅 블록을 덮는다 (.adoc)", () => {
  const text = ["----", "컨텐츠 처리", "----", "본문입니다."].join("\n");
  const masked = maskProtected(text, "adoc");
  assert.ok(!masked.includes("컨텐츠"));
  assert.ok(masked.includes("본문입니다."));
});

test("F7: <pre>와 <code> 블록을 덮는다 (.md)", () => {
  const text = "설명 <pre>컨텐츠 메세지</pre> 그리고 <code>컨텐츠</code> 끝.";
  const masked = maskProtected(text, "md");
  assert.ok(!masked.includes("컨텐츠"));
  assert.ok(masked.includes("설명"));
  assert.ok(masked.includes("끝."));
});

test("A: 들여쓰기·rST·AsciiDoc·pre/code 가리개는 커밋 메시지(ext 없음)에는 적용되지 않는다", () => {
  const indented = ["설명입니다.", "", "    컨텐츠 정리", "", "끝입니다."].join("\n");
  assert.ok(maskProtected(indented).includes("컨텐츠"));

  const asciidoc = ["----", "컨텐츠 처리", "----"].join("\n");
  assert.ok(maskProtected(asciidoc).includes("컨텐츠"));

  const preTag = "설명 <pre>컨텐츠</pre> 끝.";
  // <pre> 자체는 일반 HTML 태그 가리개(ALWAYS_PATTERNS)에 걸려 내용까지 함께 지워지지 않는다 —
  // 태그만 개별로 덮이므로 안의 "컨텐츠"는 그대로 남는다.
  assert.ok(maskProtected(preTag).includes("컨텐츠"));
});

test("F8: 한글이 섞인 경로를 덮는다", () => {
  const masked = maskProtected("docs/컨텐츠.md 파일을 고쳤습니다.");
  assert.ok(!masked.includes("컨텐츠"));
  assert.ok(masked.includes("고쳤습니다"));
});

test("F8: 밑줄로 잇는 혼합 식별자를 덮는다", () => {
  const masked = maskProtected("content_컨텐츠 변수를 고쳤습니다.");
  assert.ok(!masked.includes("컨텐츠"));
  assert.ok(masked.includes("고쳤습니다"));
});

test("F8: 슬래시로 대안을 가르는 보통 문장은 덮지 않는다", () => {
  const text = "이거 / 저거 가운데 하나를 고르세요.";
  assert.equal(maskProtected(text), text);
});

test("타이밍: 1MB 문서도 오늘의 자릿수 안에서 끝난다", () => {
  const doc = "결합도를 낮추면 변경 범위가 줄어듭니다. ".repeat(30000);
  const start = Date.now();
  maskProtected(doc);
  const ms = Date.now() - start;
  console.log(`    1MB 문서 마스킹: ${ms}ms (길이 ${doc.length})`);
  assert.ok(ms < 2000, `1MB 문서 마스킹이 ${ms}ms 걸렸다`);
});

// 라운드1 항목1: 새로 추가한 가리개가 보통 한글 글을 지우면 안 된다.
test("항목1a: 양쪽이 모두 한글뿐인 슬래시는 경로로 보지 않는다", () => {
  for (const text of ["컨텐츠/메세지를 정리합니다.", "읽기/쓰기 방향을 고릅니다.", "불변/가변이 다릅니다."]) {
    const masked = maskProtected(text, "md");
    assert.ok(masked.includes("컨텐츠") || masked.includes("메세지") || masked.includes("읽기") || masked.includes("쓰기") || masked.includes("불변") || masked.includes("가변"), text);
  }
});

test("항목1b: 목록 항목 뒤에 이어지는 4칸 들여쓰기는 코드로 보지 않는다", () => {
  const text = ["- 첫 항목입니다.", "", "    컨텐츠 이어지는 내용입니다.", "", "끝입니다."].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(masked.includes("컨텐츠"));
});

test("항목1c: 마크다운 문서의 -------- 가로줄/셋텍스트 밑줄은 AsciiDoc 블록으로 보지 않는다", () => {
  const text = ["제목입니다", "----", "", "컨텐츠 문단입니다.", "", "----", "", "끝입니다."].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(masked.includes("컨텐츠"));
});

test("항목1d: ::로 끝나는 줄이 있어도 마크다운(.md)에서는 뒤 문단을 덮지 않는다", () => {
  const text = ["예시입니다::", "", "컨텐츠 문단입니다."].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(masked.includes("컨텐츠"));
});

test("타이밍: rST 지시자가 많은 560KB 문서도 이차 비용 없이 끝난다 (F8)", () => {
  const block = [".. code-block:: python", "", "    print(1)", "", "본문 문단입니다.", ""].join("\n");
  const doc = block.repeat(4000);
  const start = Date.now();
  maskProtected(doc, "rst");
  const ms = Date.now() - start;
  console.log(`    rST ${doc.length}자 마스킹: ${ms}ms`);
  assert.ok(ms < 1000, `rST 문서 마스킹이 ${ms}ms 걸렸다`);
});

test("한 줄 예외 표시는 그 줄만 덮는다", () => {
  const text = ["얇은 계약 하나", "얇은 계약 둘 <!-- kimchi-ignore -->", "얇은 계약 셋"].join("\n");
  const masked = maskProtected(text);
  assert.equal(masked.split("\n")[0], "얇은 계약 하나");
  assert.ok(!masked.split("\n")[1].includes("얇은 계약"));
  assert.equal(masked.split("\n")[2], "얇은 계약 셋");
});
