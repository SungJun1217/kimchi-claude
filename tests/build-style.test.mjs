import { test } from "node:test";
import assert from "node:assert/strict";
import { rule as base, manyRules } from "./helpers.mjs";
import { buildBody, MAX_CHARS } from "../scripts/build-style.mjs";
import { loadRules } from "../hooks/lib/rules.mjs";

// 이 시험 묶음의 기본값만 여기서 정하고, 규칙 객체 모양은 helpers 가 갖는다.
const rule = (overrides = {}) => base({ en: "thin contract", good: "결합도", source: "metaphors.md", ...overrides });

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
  assert.match(body, /### 은유: 벗기고 개념의 이름을 쓸 것/);
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
  const many = manyRules(2000, (i, tag) => ({ en: `term-${tag}`, bad: `나쁜표현${tag}`, good: `좋은표현${tag}` }));
  const { body, dropped } = buildBody(many);
  assert.ok(body.length <= MAX_CHARS, `본문이 ${body.length}자로 상한을 넘었다`);
  assert.ok(dropped > 0, "상한을 넘겼는데도 제외된 규칙이 없다");
});

test("낮은 순위를 먼저 잘라낸다", () => {
  const make = (prefix, priority) =>
    manyRules(300, (i, tag) => ({ en: `${prefix}-${tag}`, bad: `${prefix}표현${tag}`, good: `대체${tag}`, priority }));
  const { body } = buildBody([...make("참고", "참고"), ...make("핵심", "핵심")]);
  assert.ok(body.includes("핵심표현"), "핵심 규칙이 하나도 안 들어갔다");
  assert.ok(!body.includes("참고표현"), "참고 순위가 핵심보다 먼저 들어갔다");
});

test("들어가지 못한 규칙이 있어도 선택을 멈추지 않는다", () => {
  // 긴 규칙이 확실히 거절되도록 상한을 서두 + 짧은 행 하나에 맞춘다.
  // 예전 시험은 상한이 넉넉해 거절이 일어나지 않아, break 로 되돌려도 통과했다.
  const short = rule({ en: "short", bad: "짧은표현", good: "대체", priority: "핵심" });
  const shortRowCost = buildBody([short]).body.length - buildBody([]).body.length;
  const cap = buildBody([]).body.length + shortRowCost;

  const long = rule({ bad: "가".repeat(600), good: "나".repeat(600), priority: "핵심" });
  const { body, included } = buildBody([long, short], cap);

  assert.equal(included, 1, "긴 규칙이 거절된 뒤 짧은 규칙까지 버렸다");
  assert.ok(body.includes("짧은표현"));
  assert.ok(!body.includes("가".repeat(600)));
});

test("프롬프트 규칙이 용어 규칙을 밀어내지 않는다", () => {
  // 린터는 커밋과 문서만 본다. 대화를 위해 용어 규칙도 본문에 있어야 한다.
  const prompts = manyRules(200, (i, tag) => ({
    en: `p-${tag}`, bad: `예시 문장 ${tag} 입니다`, good: `고친 문장 ${tag} 입니다`, check: "프롬프트",
  }));
  const terms = manyRules(200, (i, tag) => ({ en: `t-${tag}`, bad: `나쁜용어${tag}`, good: `좋은용어${tag}`, check: "치환" }));
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

// 다른 규칙의 이유·쓸 것 칸 글자 수가 늘면(용어 자료를 고치는 흔한 작업), 같은 순위인데
// 알파벳 순서가 뒤인 파일(patterns.md, metaphors.md 등)의 핵심 규칙이 예산에서 밀려날 수
// 있다. 실제로 rules/hanja.md 몇 행을 고치면서 patterns.md 문장 구조 핵심 규칙 두 개가
// 이렇게 조용히 빠졌었다. 본문에 꼭 있어야 하는 핵심 규칙을 여기 못박아, 다음에 같은 일이
// 생기면 npm test가 잡는다.
test("실제 규칙표: 핵심 순위 문장 구조·은유 규칙이 본문 예산에서 밀려나지 않는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const { body } = buildBody(rules);
  const mustInclude = [
    "우리는 ~합니다", // patterns.md: 인칭 주어 직역
    "이 변경은 성능 향상을 가져옵니다.", // patterns.md: This change brings...
    "한 문장에 절을 셋 이상 이어 붙이기", // patterns.md: 절 3개 이상
    "수정 완료. 확인 필요.", // patterns.md: 전보체
    "얇은 계약", // metaphors.md: thin contract
    "두꺼운 모델", // metaphors.md: fat model
    "신선하지 않은 데이터", // metaphors.md: stale data
    "김빠진 캐시", // metaphors.md: stale cache
  ];
  for (const bad of mustInclude) {
    assert.ok(body.includes(bad), `핵심 규칙이 본문 예산에서 빠졌다: ${bad}`);
  }
});

// tier별로 즉시 anyLane을 재시도하는 게 실제로 필요한지 못박는다. 예전 코드(전체를 한
// 순회로 훑고 나서야 한 번에 anyLane을 재시도)로 되돌리면 이 시험이 실패해야 한다 —
// 실제로 되돌려서 확인했다: 옛 코드는 핵심 14개 중 8개, 보통 40개 중 7개가 들어갔지만
// (보통 규칙이 아직 자리가 있는 핵심 규칙보다 먼저 들어갔다), 지금 코드는 보통을 하나도
// 들이지 않고 핵심 14개를 채운다.
test("갈래 예산을 넘긴 핵심 규칙이 자리가 있는데도 보통 규칙에 밀리지 않는다", () => {
  const core = manyRules(40, (i, tag) => ({
    en: `core-${tag}`,
    bad: `핵심표현${tag}`,
    good: `대체표현${tag}`,
    why: "핵심 이유 문장입니다 핵심 이유 문장입니다",
    check: "치환",
    priority: "핵심",
    source: "metaphors.md",
  }));
  const normal = manyRules(40, (i, tag) => ({
    en: `normal-${tag}`,
    bad: `보통표현${tag}`,
    good: `대체표현${tag}`,
    why: "보통 이유 문장",
    check: "프롬프트",
    priority: "보통",
    source: "patterns.md",
  }));

  const { body } = buildBody([...core, ...normal], 3000);
  const normalIncluded = normal.filter((r) => body.includes(r.bad)).length;
  const coreIncluded = core.filter((r) => body.includes(r.bad)).length;

  assert.equal(normalIncluded, 0, "핵심 규칙이 더 들어갈 수 있는데 보통 규칙이 먼저 들어갔다");
  assert.ok(coreIncluded >= 10, `핵심 규칙이 ${coreIncluded}개만 들어갔다`);
});
