import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTable, byPriority, CHECK_REGEX, CHECK_PROMPT } from "../hooks/lib/rules.mjs";

const TABLE = [
  "| 원어 | 쓰지 말 것 | 쓸 것 | 이유 | 검사 | 순위 |",
  "|---|---|---|---|---|---|",
  "| thin contract | 얇은 계약 | 결합도를 낮추다 | 은유 직역 | 정규식 | 핵심 |",
  "| — | 우리는 캐시를 재생성한다 | 캐시가 매번 새로 만들어집니다 | 인칭 주어 직역 | 프롬프트 | 보통 |",
].join("\n");

test("정상 표를 파싱한다", () => {
  const { rules, skipped } = parseTable(TABLE, "terms.md");
  assert.equal(skipped, 0);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0], {
    en: "thin contract",
    bad: "얇은 계약",
    good: "결합도를 낮추다",
    why: "은유 직역",
    check: CHECK_REGEX,
    priority: "핵심",
    source: "terms.md",
  });
});

test("원어의 — 를 빈 문자열로 바꾼다", () => {
  const { rules } = parseTable(TABLE);
  assert.equal(rules[1].en, "");
  assert.equal(rules[1].check, CHECK_PROMPT);
});

test("표가 아닌 줄은 무시한다", () => {
  const md = ["# 제목", "본문입니다.", TABLE, "", "맺음말."].join("\n");
  const { rules, skipped } = parseTable(md);
  assert.equal(rules.length, 2);
  assert.equal(skipped, 0);
});

test("칸이 부족한 행을 버리고 센다", () => {
  const md = [TABLE, "| a | b | c |"].join("\n");
  const { rules, skipped } = parseTable(md);
  assert.equal(rules.length, 2);
  assert.equal(skipped, 1);
});

test("검사 칸 값이 잘못된 행을 버린다", () => {
  const md = [TABLE, "| x | 나쁨 | 좋음 | 이유 | 어쩌구 | 핵심 |"].join("\n");
  const { rules, skipped } = parseTable(md);
  assert.equal(rules.length, 2);
  assert.equal(skipped, 1);
});

test("순위 칸 값이 잘못된 행을 버린다", () => {
  const md = [TABLE, "| x | 나쁨 | 좋음 | 이유 | 정규식 | 아주중요 |"].join("\n");
  const { rules, skipped } = parseTable(md);
  assert.equal(rules.length, 2);
  assert.equal(skipped, 1);
});

test("쓰지 말 것이나 쓸 것이 비어 있으면 버린다", () => {
  const md = [TABLE, "| x | — | 좋음 | 이유 | 정규식 | 핵심 |", "| x | 나쁨 | — | 이유 | 정규식 | 핵심 |"].join("\n");
  const { rules, skipped } = parseTable(md);
  assert.equal(rules.length, 2);
  assert.equal(skipped, 2);
});

test("이스케이프한 파이프를 살린다", () => {
  const md = [
    "| 원어 | 쓰지 말 것 | 쓸 것 | 이유 | 검사 | 순위 |",
    "|---|---|---|---|---|---|",
    "| — | a\\|b | c\\|d | 이유 | 정규식 | 핵심 |",
  ].join("\n");
  const { rules } = parseTable(md);
  assert.equal(rules[0].bad, "a|b");
  assert.equal(rules[0].good, "c|d");
});

test("여러 표가 있어도 모두 읽는다", () => {
  const { rules } = parseTable([TABLE, "", TABLE].join("\n"));
  assert.equal(rules.length, 4);
});

test("잘못된 입력에 안전하다", () => {
  assert.deepEqual(parseTable(null), { rules: [], skipped: 0 });
  assert.deepEqual(parseTable(""), { rules: [], skipped: 0 });
});

test("byPriority가 순위대로 정렬하고 같은 순위의 순서를 지킨다", () => {
  const rules = [
    { bad: "a", priority: "참고" },
    { bad: "b", priority: "핵심" },
    { bad: "c", priority: "보통" },
    { bad: "d", priority: "핵심" },
  ];
  assert.deepEqual(
    byPriority(rules).map((rule) => rule.bad),
    ["b", "d", "c", "a"]
  );
});
