// scripts/import-corpus.mjs 의 --recheck 가 이유 칸의 [표기]/[외래어] 표지를
// 잃지 않는지 본다. parseTable 은 표지를 rule.kind 로 떼어 가므로, 검사 칸만 다시
// 써서 행을 재조립할 때 표지를 rule.kind 에서 되살리지 않으면 조용히 사라진다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { recheckLine } from "../scripts/import-corpus.mjs";
import { parseTable } from "../hooks/lib/rules.mjs";

test("recheck 로 검사 칸이 바뀌어도 [표기] 표지는 살아남는다", () => {
  const line = "| — | 테스트경계말 | 고침말 | [표기] 아무 이유 | 정규식 | 보통 |";
  const changes = [];
  const after = recheckLine(line, "test.md", changes);

  assert.notEqual(after, line, "검사 칸이 바뀌지 않았다 — 시험 전제가 깨졌다");
  assert.match(after, /\[표기\]/, "표지가 사라졌다");

  const { rules } = parseTable(after, "test.md");
  assert.equal(rules[0].kind, "orthography");
  assert.equal(rules[0].check, "치환");
});

test("recheck 로 검사 칸이 바뀌어도 [외래어] 표지는 살아남는다", () => {
  const line = "| — | 테스트경계말 | 고침말 | [외래어] 아무 이유 | 정규식 | 보통 |";
  const changes = [];
  const after = recheckLine(line, "test.md", changes);

  assert.match(after, /\[외래어\]/, "표지가 사라졌다");
  const { rules } = parseTable(after, "test.md");
  assert.equal(rules[0].kind, "loanword");
});

test("검사 칸이 그대로면 줄 자체를 바꾸지 않는다", () => {
  const line = "| — | 테스트경계말 | 고침말 | [표기] 아무 이유 | 치환 | 보통 |";
  const changes = [];
  const after = recheckLine(line, "test.md", changes);
  assert.equal(after, line);
  assert.deepEqual(changes, []);
});
