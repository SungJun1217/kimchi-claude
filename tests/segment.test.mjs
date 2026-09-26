import { test } from "node:test";
import assert from "node:assert/strict";
import { maskProtected, isIgnoredFile, collectReferenceDefLabels, MASK } from "../hooks/lib/segment.mjs";
import { fastestMs } from "./helpers.mjs";

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
  // 병렬로 도는 다른 시험 때문에 한 번 잰 값이 튈 수 있다. 최솟값이 실제 비용에
  // 가깝고, 이차 비용 회귀는 최솟값에도 그대로 남는다(helpers.mjs 의 fastestMs 참고).
  const ms = fastestMs(() => maskProtected(doc));
  console.log(`    1MB 문서 마스킹: ${ms}ms (길이 ${doc.length})`);
  // 부하 없이 도는 로컬에서는 수십 ms 안에 끝난다. 이 상한의 여유는 공유 CI
  // 러너의 부하를 견디기 위한 것이고, 이차 비용 회귀(수 초대로 튀는 것)는 여전히 잡는다.
  assert.ok(ms < 3000, `1MB 문서 마스킹이 ${ms}ms 걸렸다`);
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
  const ms = fastestMs(() => maskProtected(doc, "rst"));
  console.log(`    rST ${doc.length}자 마스킹: ${ms}ms`);
  assert.ok(ms < 1000, `rST 문서 마스킹이 ${ms}ms 걸렸다`);
});

// ── 불변식 4: 비산문 구간(링크 대상·식별자·프롬프트·로그·프런트매터) ─────────

test("마크다운 링크 대상은 덮지만 링크 텍스트는 계속 검사한다", () => {
  const masked = maskProtected("[타겟 안내](#a) 문서입니다.");
  assert.ok(!masked.includes("#a"));
  assert.ok(masked.includes("타겟 안내"), "링크 텍스트까지 덮였다");
});

test("이미지 대상은 덮지만 대체 텍스트는 계속 검사한다", () => {
  const masked = maskProtected("![타겟 그림](img/a.png) 설명입니다.");
  assert.ok(!masked.includes("img/a.png"));
  assert.ok(masked.includes("타겟 그림"), "대체 텍스트까지 덮였다");
  assert.ok(masked.includes("설명입니다."));
});

test("참조 정의 줄 전체를 덮는다", () => {
  const masked = maskProtected('[ref]: https://example.com "타겟 제목"\n본문입니다.');
  assert.ok(!masked.includes("타겟 제목"));
  assert.ok(masked.includes("본문입니다."));
});

// 라운드2 항목5: 닫는 괄호가 없는 "](" 반복 입력에서 이차 비용이 났다(실측 5.7초).
test("항목5: 닫는 괄호 없는 ]( 반복 입력도 선형 시간 근처에서 끝난다", () => {
  const doc = "](".repeat(40000);
  const ms = fastestMs(() => maskProtected(doc));
  console.log(`    ]( 반복 ${doc.length}자 마스킹: ${ms}ms`);
  assert.ok(ms < 500, `]( 반복 마스킹이 ${ms}ms 걸렸다`);
});

// 라운드2 항목3: 참조식 링크의 라벨(정의와 글자로 맞아야 하는 식별자)이 자동 교정으로
// 바뀌면 정의 줄과 어긋나 죽은 링크가 된다. 라벨만 가리고 링크 텍스트는 계속 검사한다.
test("항목3: [글 내용][라벨] 형태에서 라벨만 가리고 글 내용은 계속 검사한다", () => {
  const text = "[설정 안내][타겟]\n\n[타겟]: ./setup.md";
  const masked = maskProtected(text, "md");
  assert.ok(masked.includes("설정 안내"), "링크 텍스트까지 가려졌다");
  assert.ok(!masked.includes("][타겟]"), "라벨이 가려지지 않았다");
});

test("항목3: [라벨][] 축약형은 통째로 가린다", () => {
  const text = "[타겟][]\n\n[타겟]: ./setup.md";
  const masked = maskProtected(text, "md");
  assert.ok(!masked.includes("[타겟][]"));
});

test("항목3: 정의가 있는 [라벨] 단축형 참조도 가린다", () => {
  const text = "자세한 것은 [타겟]을 본다.\n\n[타겟]: ./setup.md";
  const masked = maskProtected(text, "md");
  assert.ok(!masked.includes("[타겟]을"));
  assert.ok(masked.includes("자세한 것은"));
});

test("항목3: 정의가 없는 대괄호는 참조 라벨로 보지 않는다", () => {
  const text = "이 값은 [예시] 안에 있습니다.";
  assert.equal(maskProtected(text, "md"), text);
});

test("항목3: 인라인 링크 [글 내용](url)의 글 내용은 라벨 취급하지 않는다", () => {
  const text = "[타겟](./a.md) 안내입니다.\n\n[타겟]: ./setup.md";
  const masked = maskProtected(text, "md");
  // 인라인 링크의 대괄호는 단축형 참조가 아니다 — 뒤에 "(" 가 바로 오면 제외한다.
  assert.ok(masked.includes("타겟"), "인라인 링크의 글 내용까지 가려졌다");
  assert.ok(masked.includes("안내입니다."));
});

// 라운드3 항목1: Edit 조각(new_string)만으로는 파일 다른 곳의 정의 줄이 안 보인다.
// 외부에서 모은 라벨(extraDefs)을 얹어야 그 정의와 맞는 라벨도 가릴 수 있다.
test("항목1: 조각 밖에서 모은 라벨(extraDefs)로도 ][라벨]을 가린다", () => {
  const fragment = "[설정 안내][타겟]을 보세요.";
  assert.equal(maskProtected(fragment, "md"), fragment); // 조각 안에 정의가 없으면 그대로
  const masked = maskProtected(fragment, "md", new Set(["타겟"]));
  assert.ok(!masked.includes("][타겟]"));
});

test("항목1: extraDefs가 null(파일을 못 읽음)이면 보수적으로 ][라벨] 형태를 전부 가린다", () => {
  const masked = maskProtected("[설정 안내][아무 라벨]을 보세요.", "md", null);
  assert.ok(!masked.includes("][아무 라벨]"), "정의를 모르는데도 가리지 않았다");
  assert.ok(masked.includes("설정 안내"), "링크 텍스트까지 가려졌다");
});

test("항목1: extraDefs가 null이어도 단축형 [라벨]은 넓히지 않는다", () => {
  // 두 괄호짜리 형태만 보수적으로 가린다 — 홑 대괄호는 혼자서도 흔한 표기라 여기서까지
  // 넓히면 오탐이 너무 커진다.
  const text = "이 값은 [예시] 안에 있습니다.";
  assert.equal(maskProtected(text, "md", null), text);
});

// 라운드3 항목2: 정의가 하나라도 있으면 두 정규식이 문서 전체에서 돈다 — 닫히지 않은
// "["가 잔뜩 있으면 이차 비용이 났다(실측 36초).
test("항목2: 닫히지 않은 [ 가 잔뜩 있어도 정의가 있으면 선형 시간 근처에서 끝난다", () => {
  const doc = "[".repeat(100000) + "\n[a]: b";
  const ms = fastestMs(() => maskProtected(doc, "md"));
  console.log(`    닫히지 않은 [ 반복 ${doc.length}자 마스킹: ${ms}ms`);
  assert.ok(ms < 1000, `닫히지 않은 [ 반복 마스킹이 ${ms}ms 걸렸다`);
});

// 라운드3 항목3: 정의는 울타리·인라인 코드를 가린 뒤에 찾아야 한다. 코드로 인용한
// 가짜 정의를 진짜로 세면 그 라벨을 쓰는 산문까지 부당하게 빠진다.
test("항목3: 울타리 안의 가짜 정의 줄은 세지 않는다", () => {
  const text = ["`[타겟]` 과 [타겟]", "", "```", "[타겟]: x", "```"].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(masked.includes("[타겟]"), "울타리 밖 [타겟]까지 가려졌다");
});

test("항목3: 인라인 코드 안의 가짜 정의도 세지 않는다 (collectReferenceDefLabels)", () => {
  const text = "`[타겟]: 진짜 정의처럼 보이는 코드 예시` 그리고 [타겟] 본문.";
  const defs = collectReferenceDefLabels(text, "md");
  assert.ok(!defs.has("타겟"));
});

test("항목3: 진짜 정의 줄은 여전히 모은다 (collectReferenceDefLabels)", () => {
  const defs = collectReferenceDefLabels("[타겟]: ./setup.md\n본문", "md");
  assert.ok(defs.has("타겟"));
});

test("확장자 목록에 이미지·문서 형식을 추가로 덮는다", () => {
  const masked = maskProtected("그림.png 파일을 첨부합니다.");
  assert.ok(!masked.includes("그림.png"));
  assert.ok(masked.includes("첨부합니다."));
});

test("타겟Id처럼 한글 뒤에 로마자가 바로 붙은 혼합 식별자를 덮는다", () => {
  const masked = maskProtected("타겟Id 값을 확인합니다.");
  assert.ok(!masked.includes("타겟Id"));
  assert.ok(masked.includes("확인합니다."));
});

test("타겟_id 처럼 한글이 앞에 오는 밑줄 식별자도 덮는다", () => {
  const masked = maskProtected("타겟_id 값을 확인합니다.");
  assert.ok(!masked.includes("타겟_id"));
});

test("user_디렉토리 처럼 한글이 뒤에 오는 밑줄 식별자는 계속 덮는다", () => {
  const masked = maskProtected("user_디렉토리 값을 확인합니다.");
  assert.ok(!masked.includes("디렉토리"));
});

test("API가 처럼 로마자 뒤에 한글이 오는 보통 문장은 덮지 않는다", () => {
  const text = "API가 디렉토리를 만듭니다.";
  assert.equal(maskProtected(text), text);
});

test("타겟Name 처럼 한글 뒤에 대문자로 시작하는 캐멀케이스도 덮는다", () => {
  const masked = maskProtected("타겟Name 값을 확인합니다.");
  assert.ok(!masked.includes("타겟Name"));
});

// 라운드2 항목1: 한글 뒤에 대문자만 이어지는 두문자어(API·UI·PR)는 식별자가 아니라
// 보통 산문에 섞인 영문 약어다 — 캐멀케이스만 식별자로 본다.
test("항목1: 한글 뒤에 대문자 두문자어만 오면 식별자로 보지 않고 그대로 검사한다", () => {
  for (const text of ["컨텐츠UI를 정리합니다.", "타겟API 호출을 확인합니다.", "리팩토링PR을 올렸습니다."]) {
    assert.equal(maskProtected(text), text, text);
  }
});

test("항목1: 100KB 반복 입력도 선형 시간 근처에서 끝난다 (한글+로마자 붙임)", () => {
  const doc = "가a".repeat(50000); // 100,000자
  const ms = fastestMs(() => maskProtected(doc));
  console.log(`    "가a" 반복 ${doc.length}자 마스킹: ${ms}ms`);
  assert.ok(ms < 500, `"가a" 반복 마스킹이 ${ms}ms 걸렸다`);
});

test("항목1: 한글·로마자·두문자어가 섞인 반복 입력도 선형 시간 근처에서 끝난다", () => {
  const doc = "이번에타겟Id를추가했고API를호출해서값을받습니다".repeat(700);
  const ms = fastestMs(() => maskProtected(doc));
  console.log(`    섞인 반복 ${doc.length}자 마스킹: ${ms}ms`);
  assert.ok(ms < 1000, `섞인 반복 마스킹이 ${ms}ms 걸렸다`);
});

test("울타리 없는 셸 프롬프트 줄을 덮되 이어지는 산문은 검사한다", () => {
  const masked = maskProtected("$ npm test\n타겟 실패를 확인해 주십시오.");
  assert.ok(!masked.includes("npm test"));
  assert.ok(masked.includes("타겟 실패를 확인해 주십시오."));
});

test("줄 앞 로그 레벨로 시작하는 줄을 덮되 이어지는 산문은 검사한다", () => {
  const masked = maskProtected("FATAL: connection refused\n타겟 문제를 다시 보십시오.");
  assert.ok(!masked.includes("connection refused"));
  assert.ok(masked.includes("타겟 문제를 다시 보십시오."));
});

// 라운드2 항목4: "Error:"·"Warning:"·"$ "가 로그·프롬프트가 아니라 한국어 문장의 첫 낱말일
// 수 있다. 콜론/공백 뒤가 한글 위주면(또는 숫자로 시작하면) 산문으로 보고 덮지 않는다.
test("항목4: 콜론 뒤가 한글 위주인 Error 줄은 로그로 보지 않고 그대로 검사한다", () => {
  const text = "Error: 컨텐츠를 불러오지 못하면 다시 시도하세요";
  assert.equal(maskProtected(text), text);
});

test("항목4: 목록 표시가 붙은 Warning 줄도 한글 위주면 그대로 검사한다", () => {
  const text = "- Warning: 이 설정을 바꾸면 컨텐츠가 사라집니다";
  assert.equal(maskProtected(text), text);
});

test("항목4: $ 뒤가 숫자면 프롬프트가 아니라 그대로 검사한다", () => {
  const text = "$ 5를 내면 컨텐츠를 받습니다";
  assert.equal(maskProtected(text), text);
});

test("항목4: 콜론 뒤가 영문 위주인 로그 줄은 여전히 덮는다", () => {
  const masked = maskProtected("Error: 타겟 not found");
  assert.ok(!masked.includes("타겟 not found"));
});

test("한 줄짜리 $(...) 명령 치환을 덮는다", () => {
  const masked = maskProtected("$(echo 타겟) 확인해 주십시오.");
  assert.ok(!masked.includes("echo 타겟"));
  assert.ok(masked.includes("확인해 주십시오."));
});

test("울타리 닫힘(```) 바로 뒤의 들여쓰기는 목록 연속이 아니라 코드다 (.md)", () => {
  const text = ["설명입니다.", "", "```", "코드", "```", "", "    타겟 코드입니다.", "", "끝."].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(!masked.includes("타겟 코드입니다."));
  assert.ok(masked.includes("설명입니다."));
  assert.ok(masked.includes("끝."));
});

test("ATX 제목(##) 바로 뒤의 들여쓰기도 코드다 (.md)", () => {
  const text = ["## 제목", "", "    타겟 코드입니다.", "", "끝."].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(!masked.includes("타겟 코드입니다."));
});

test("목록 항목 뒤의 들여쓰기는 울타리·제목 예외와 무관하게 여전히 목록 연속이다 (.md)", () => {
  const text = ["- 첫 항목입니다.", "", "    타겟 이어지는 내용입니다.", "", "끝."].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(masked.includes("타겟 이어지는 내용입니다."));
});

test("YAML 프런트매터: 산문 키(title/description)의 값은 계속 검사한다 (.md)", () => {
  const text = ["---", "title: 타겟 제목", "description: |", "  타겟 설명", "환경: prod", "---", "본문 타겟."].join(
    "\n"
  );
  const masked = maskProtected(text, "md");
  assert.ok(masked.includes("타겟 제목"), "title 값이 덮였다");
  assert.ok(masked.includes("타겟 설명"), "description 값이 덮였다");
  assert.ok(!masked.includes("환경: prod"), "산문 키가 아닌 줄이 덮이지 않았다");
  assert.ok(masked.includes("본문 타겟."), "프런트매터 밖 본문이 덮였다");
});

test("--- 로 시작하지만 안쪽이 YAML처럼 안 생기면 프런트매터로 보지 않는다 (.md)", () => {
  const text = ["---", "타겟 그냥 문단입니다.", "", "---", ""].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(masked.includes("타겟 그냥 문단입니다."));
});

test("프런트매터는 확장자가 없으면(커밋 메시지) 적용되지 않는다", () => {
  const text = ["---", "title: 타겟", "---", "본문"].join("\n");
  assert.equal(maskProtected(text), text);
});

// 라운드2 항목2: 여는 --- 바로 다음 줄이 key: 줄이 아니면(빈 줄, 제목, 굵게 등) 프런트매터가
// 아니라 ---로 감싼 산문이다. 잘못 프런트매터로 인정하면 그 안의 진짜 위반까지 삼킨다.
test("항목2: 여는 --- 다음이 제목·목록이면 프런트매터로 보지 않고 안쪽도 검사한다", () => {
  const text = ["---", "", "## 변경 사항", "", "- 컨텐츠를 정리했습니다", "- 타겟을 바꿨습니다", "", "---", "", "다음 절"].join(
    "\n"
  );
  const masked = maskProtected(text, "md");
  assert.ok(masked.includes("컨텐츠를 정리했습니다"));
  assert.ok(masked.includes("타겟을 바꿨습니다"));
});

test("항목2: 여는 --- 다음이 **굵게**: 형태면 YAML 키로 보지 않는다", () => {
  const text = ["---", "", "**참고**: 컨텐츠를 옮겼습니다.", "", "---", "", "본문"].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(masked.includes("컨텐츠를 옮겼습니다"));
});

// 라운드3 항목5: 키가 온통 한글이면(영문 키가 하나도 없으면) YAML이 아니라 "키처럼
// 보이는 한국어 문장"일 수 있다.
test("항목5: 영문 키가 하나도 없으면 프런트매터로 보지 않는다", () => {
  const text = ["---", "참고: 컨텐츠 문서를 옮겼습니다", "---", "본문"].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(masked.includes("컨텐츠 문서를 옮겼습니다"));
});

test("항목5: 영문 키가 하나라도 있으면 그대로 프런트매터로 인정한다", () => {
  const text = ["---", "id: 123", "참고: 컨텐츠 문서를 옮겼습니다", "---", "본문"].join("\n");
  const masked = maskProtected(text, "md");
  assert.ok(!masked.includes("컨텐츠 문서를 옮겼습니다"));
});

test("한 줄 예외 표시는 그 줄만 덮는다", () => {
  const text = ["얇은 계약 하나", "얇은 계약 둘 <!-- kimchi-ignore -->", "얇은 계약 셋"].join("\n");
  const masked = maskProtected(text);
  assert.equal(masked.split("\n")[0], "얇은 계약 하나");
  assert.ok(!masked.split("\n")[1].includes("얇은 계약"));
  assert.equal(masked.split("\n")[2], "얇은 계약 셋");
});
