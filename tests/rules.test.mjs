import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTable,
  byPriority,
  CHECK_REGEX,
  CHECK_PROMPT,
  RULE_KIND_TAG_NAMES,
  BRACKET_PREFIX_PATTERN,
} from "../hooks/lib/rules.mjs";

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

test("이유 칸 맨 앞의 [표기] 표지를 떼어 kind 로 넘긴다", () => {
  const md = [
    "| 원어 | 쓰지 말 것 | 쓸 것 | 이유 | 검사 | 순위 |",
    "|---|---|---|---|---|---|",
    "| — | 나쁨 | 좋음 | [표기] 아무 이유 | 치환 | 보통 |",
  ].join("\n");
  const { rules } = parseTable(md);
  assert.equal(rules[0].kind, "orthography");
  assert.equal(rules[0].why, "아무 이유");
});

test("이유 칸 맨 앞의 [외래어] 표지를 떼어 kind 로 넘긴다", () => {
  const md = [
    "| 원어 | 쓰지 말 것 | 쓸 것 | 이유 | 검사 | 순위 |",
    "|---|---|---|---|---|---|",
    "| — | 나쁨 | 좋음 | [외래어] 아무 이유 | 치환 | 보통 |",
  ].join("\n");
  const { rules } = parseTable(md);
  assert.equal(rules[0].kind, "loanword");
  assert.equal(rules[0].why, "아무 이유");
});

test("표지가 없으면 kind 가 없다", () => {
  const { rules } = parseTable(TABLE);
  assert.equal(rules[0].kind, undefined);
});

test("정의되지 않은 표지는 표지로 인정하지 않고 글자 그대로 남긴다", () => {
  // 오타(예: [표기재]나 [foo])를 조용히 표지로 삼으면 안 된다 — 대괄호가 그대로
  // 이유 문장에 남아야 검토자 눈에 띈다.
  const md = [
    "| 원어 | 쓰지 말 것 | 쓸 것 | 이유 | 검사 | 순위 |",
    "|---|---|---|---|---|---|",
    "| — | 나쁨 | 좋음 | [foo] 아무 이유 | 치환 | 보통 |",
  ].join("\n");
  const { rules } = parseTable(md);
  assert.equal(rules[0].kind, undefined);
  assert.equal(rules[0].why, "[foo] 아무 이유");
});

test("공백을 빠뜨린 표지 오타도 대괄호로 잡힌다", () => {
  // BRACKET_PREFIX_PATTERN이 뒤 공백까지 요구하면 "[외래어]외래어 표기법"처럼 공백을
  // 빠뜨린 오타가 대괄호 자체를 못 찾아 코퍼스 검사(tests/corpus.test.mjs)를 그냥
  // 통과해 버린다. 대괄호만 보고, "알려진 표지와 정확히 같은가"는 따로 판정해야 한다.
  const why = "[외래어]외래어 표기법";
  assert.ok(BRACKET_PREFIX_PATTERN.test(why), "공백 없는 대괄호를 못 찾았다");
  assert.equal(
    RULE_KIND_TAG_NAMES.some((tag) => why.startsWith(tag)),
    false,
    "공백이 없는데도 알려진 표지로 인정했다"
  );
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


test("검사 값은 순서에 영향을 주지 않는다", () => {
  // `검사`는 "어떻게 강제하는가"이고 "얼마나 중요한가"가 아니다. 후자는 `순위` 칸의 일이다.
  const input = [
    { bad: "먼저", priority: "보통", check: "정규식" },
    { bad: "나중", priority: "보통", check: "치환" },
  ];
  assert.deepEqual(byPriority(input).map((rule) => rule.bad), ["먼저", "나중"]);
  assert.deepEqual(byPriority([...input].reverse()).map((rule) => rule.bad), ["나중", "먼저"]);
});
