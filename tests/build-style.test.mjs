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
  // 행 길이를 맞춘다. 길이가 다르면 짧은 행이 남은 자리에 끼어들어 순위를 재는 시험이 흐려진다.
  const make = (prefix, priority) =>
    Array.from({ length: 300 }, (_, i) => {
      const tag = String(i).padStart(3, "0");
      return rule({ en: `${prefix}-${tag}`, bad: `${prefix}표현${tag}`, good: `대체${tag}`, priority });
    });
  const { body } = buildBody([...make("참고", "참고"), ...make("핵심", "핵심")]);
  assert.ok(body.includes("핵심표현"), "핵심 규칙이 하나도 안 들어갔다");
  assert.ok(!body.includes("참고표현"), "참고 순위가 핵심보다 먼저 들어갔다");
});

test("남은 자리를 버리지 않는다", () => {
  // 한 규칙이 안 들어가도 멈추지 않는다. 뒤에 오는 짧은 규칙은 아직 들어갈 수 있다.
  const long = rule({ bad: "가".repeat(400), good: "나".repeat(400), priority: "핵심" });
  const short = rule({ en: "short", bad: "짧은표현", good: "대체", priority: "핵심" });
  const { body, included } = buildBody([long, short], 5200);
  assert.ok(included >= 1, "긴 규칙 하나 때문에 선택이 끝났다");
  assert.ok(body.includes("짧은표현"));
});

test("프롬프트 규칙이 용어 규칙을 밀어내지 않는다", () => {
  // 린터는 커밋과 문서만 본다. 대화를 위해 용어 규칙도 본문에 있어야 한다.
  const prompts = Array.from({ length: 200 }, (_, i) =>
    rule({ en: `p-${i}`, bad: `예시 문장 ${i} 입니다`, good: `고친 문장 ${i} 입니다`, check: "프롬프트" })
  );
  const terms = Array.from({ length: 200 }, (_, i) =>
    rule({ en: `t-${i}`, bad: `나쁜용어${i}`, good: `좋은용어${i}`, check: "치환" })
  );
  const { body } = buildBody([...prompts, ...terms]);
  assert.ok(body.includes("나쁜용어"), "용어 규칙이 전부 밀려났다");
  assert.ok(body.includes("예시 문장"), "프롬프트 규칙이 전부 밀려났다");
});

test("여러 분류가 섞여도 소제목이 한 번만 나온다", () => {
  const { body } = buildBody([
    rule({ source: "hanja.md", bad: "나쁜하나", good: "좋은하나", priority: "핵심" }),
    rule({ source: "terms.md", bad: "나쁜둘", good: "좋은둘", priority: "핵심" }),
    rule({ source: "hanja.md", bad: "나쁜셋", good: "좋은셋", priority: "참고" }),
  ]);
  const headings = body.match(/^### .*$/gm) || [];
  assert.equal(headings.length, new Set(headings).size, `소제목이 중복됐다: ${headings}`);
  assert.equal(headings.length, 2);
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
