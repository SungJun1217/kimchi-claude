import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody, MAX_CHARS } from "../scripts/build-style.mjs";

const rule = (overrides = {}) => ({
  en: "thin contract",
  bad: "얇은 계약",
  good: "결합도",
  why: "은유 직역",
  check: "정규식",
  priority: "핵심",
  source: "metaphors.md",
  ...overrides,
});

test("프런트매터에 강제 적용과 코딩 지침 유지가 들어간다", () => {
  const { body } = buildBody([rule()]);
  assert.match(body, /^---\n/);
  assert.match(body, /force-for-plugin: true/);
  assert.match(body, /keep-coding-instructions: true/);
});

test("품질을 지키는 문장이 빠지지 않는다", () => {
  const { body } = buildBody([rule()]);
  assert.match(body, /설명을 줄이거나 분석을 생략하지 마십시오/);
  assert.match(body, /코드, 식별자, 명령어/);
  assert.match(body, /영어로 쓰면 영어로 답하고/);
});

test("용어 처리 다섯 순위가 모두 들어간다", () => {
  const { body } = buildBody([rule()]);
  for (const marker of ["1. ", "2. ", "3. ", "4. ", "5. "]) {
    assert.ok(body.includes(marker), `${marker} 항목이 없다`);
  }
  assert.match(body, /순우리말로 풀어쓰는 것은 최후 수단/);
  assert.match(body, /은유는 번역 대상이 아닙니다/);
});

test("규칙이 표 행으로 들어간다", () => {
  const { body, included } = buildBody([rule()]);
  assert.equal(included, 1);
  assert.match(body, /\| thin contract \| 얇은 계약 \| 결합도 \|/);
});

test("소제목을 파일 이름으로 붙인다", () => {
  const { body } = buildBody([rule()]);
  assert.match(body, /### 은유 — 벗기고 개념의 이름을 쓸 것/);
});

test("이유를 모든 규칙에 붙인다", () => {
  assert.match(buildBody([rule({ why: "은유 직역" })]).body, /\| 은유 직역 \|/);
  assert.match(
    buildBody([rule({ check: "프롬프트", why: "인칭 주어 직역" })]).body,
    /\| 인칭 주어 직역 \|/
  );
});

test("긴 이유를 잘라 표를 지킨다", () => {
  const long = "가".repeat(200);
  const { body } = buildBody([rule({ why: long })]);
  const row = body.split("\n").find((line) => line.includes("얇은 계약"));
  assert.ok(row.length < 160, `표 행이 ${row.length}자로 너무 길다`);
  assert.ok(!body.includes(long));
});

test("원어가 없으면 — 를 넣는다", () => {
  const { body } = buildBody([rule({ en: "" })]);
  assert.match(body, /\| — \| 얇은 계약 \|/);
});

test("상한을 넘지 않는다", () => {
  const many = Array.from({ length: 2000 }, (_, i) =>
    rule({ en: `term-${i}`, bad: `나쁜표현${i}`, good: `좋은표현${i}` })
  );
  const { body, dropped } = buildBody(many);
  assert.ok(body.length <= MAX_CHARS, `본문이 ${body.length}자로 상한을 넘었다`);
  assert.ok(dropped > 0, "상한을 넘겼는데도 제외된 규칙이 없다");
});

test("낮은 순위를 먼저 잘라낸다", () => {
  const filler = Array.from({ length: 2000 }, (_, i) =>
    rule({ en: `core-${i}`, bad: `핵심표현${i}`, good: `대체${i}`, priority: "핵심" })
  );
  const note = rule({ en: "note-only", bad: "참고표현", good: "대체", priority: "참고" });
  const { body } = buildBody([note, ...filler]);
  assert.ok(!body.includes("참고표현"), "참고 순위가 핵심보다 먼저 들어갔다");
});

test("작은 상한에서도 서두는 지킨다", () => {
  const { body, included } = buildBody([rule()], 100);
  assert.equal(included, 0);
  assert.match(body, /force-for-plugin: true/);
});

test("규칙이 없어도 서두만으로 동작한다", () => {
  const { body, included, dropped } = buildBody([]);
  assert.equal(included, 0);
  assert.equal(dropped, 0);
  assert.match(body, /용어 처리 우선순위/);
});
