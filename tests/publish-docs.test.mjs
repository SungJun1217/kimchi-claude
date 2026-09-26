// scripts/publish-docs.mjs 의 링크 재작성을 검사한다.
//
// Pages와 위키는 대상이 저장소 파일을 보는 방식이 다르다 — 위키는 별도 저장소라
// 상대 경로가 아예 통하지 않는다. 여기서는 각 대상이 실제로 올바른 URL을
// 내놓는지, 그리고 코드 스팬·펜스 안의 예시 문자열은 손대지 않는지를 본다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteLinks } from "../scripts/publish-docs.mjs";

const OPTS = { repo: "SungJun1217/kimchi-claude", ref: "v0.17.0" };

test("pages: 스테이징한 문서로 가는 상대 md 링크는 html로 바뀐다", () => {
  const out = rewriteLinks("[설계](docs/design.md)", { mode: "pages", ...OPTS });
  assert.equal(out, "[설계](docs/design.html)");
});

test("pages: README는 index로, 앵커는 그대로 붙는다", () => {
  const out = rewriteLinks("[근거](docs/design.md#어떤-절)", { mode: "pages", ...OPTS });
  assert.equal(out, "[근거](docs/design.html#어떤-절)");
});

test("pages: 같은 문서 안 앵커만 있는 링크는 손대지 않는다", () => {
  const out = rewriteLinks("[고치는 것](#고치는-것)", { mode: "pages", ...OPTS });
  assert.equal(out, "[고치는 것](#고치는-것)");
});

test("pages: assets 경로는 상대 그대로 둔다(스테이징 디렉터리에 함께 복사한다)", () => {
  const out = rewriteLinks('<img src="assets/logo-light.svg">', { mode: "pages", ...OPTS });
  assert.equal(out, '<img src="assets/logo-light.svg">');
});

test("pages: 스테이징하지 않는 문서는 저장소 blob 절대 URL로 바뀐다", () => {
  const out = rewriteLinks("[안내](AGENTS.md)", { mode: "pages", ...OPTS });
  assert.equal(out, "[안내](https://github.com/SungJun1217/kimchi-claude/blob/v0.17.0/AGENTS.md)");
});

test("wiki: 스테이징한 문서로 가는 링크는 위키 페이지 이름이 된다", () => {
  const out = rewriteLinks("[설계 문서](docs/design.md)", { mode: "wiki", ...OPTS });
  assert.equal(out, "[설계 문서](설계-문서)");
});

test("wiki: assets 경로는 raw.githubusercontent 절대 URL이 된다", () => {
  const out = rewriteLinks('<source srcset="assets/hero-dark.svg">', { mode: "wiki", ...OPTS });
  assert.equal(
    out,
    '<source srcset="https://raw.githubusercontent.com/SungJun1217/kimchi-claude/v0.17.0/assets/hero-dark.svg">'
  );
});

test("wiki: 스테이징하지 않는 문서는 blob 절대 URL이 된다", () => {
  const out = rewriteLinks("[제보](.github/ISSUE_TEMPLATE/false-positive.yml)", { mode: "wiki", ...OPTS });
  assert.equal(
    out,
    "[제보](https://github.com/SungJun1217/kimchi-claude/blob/v0.17.0/.github/ISSUE_TEMPLATE/false-positive.yml)"
  );
});

test("인라인 코드 스팬 안의 예시 링크는 두 대상 모두 손대지 않는다", () => {
  const text = "마크다운 링크 문법 `[안내](url)` 를 설명한다.";
  assert.equal(rewriteLinks(text, { mode: "pages", ...OPTS }), text);
  assert.equal(rewriteLinks(text, { mode: "wiki", ...OPTS }), text);
});

test("펜스 코드 블록 안의 예시 표는 손대지 않는다", () => {
  const text = "```markdown\n| 원어 | [예시](docs/design.md) |\n```";
  assert.equal(rewriteLinks(text, { mode: "wiki", ...OPTS }), text);
});

test("물결 펜스(~~~) 코드 블록 안의 예시 링크도 손대지 않는다", () => {
  const text = "~~~markdown\n[예시](docs/design.md)\n~~~";
  assert.equal(rewriteLinks(text, { mode: "pages", ...OPTS }), text);
  assert.equal(rewriteLinks(text, { mode: "wiki", ...OPTS }), text);
});

test("절대 URL과 뱃지 링크는 두 대상 모두 그대로 둔다", () => {
  const text = "[test](https://img.shields.io/badge/test-D9532B)";
  assert.equal(rewriteLinks(text, { mode: "pages", ...OPTS }), text);
  assert.equal(rewriteLinks(text, { mode: "wiki", ...OPTS }), text);
});
