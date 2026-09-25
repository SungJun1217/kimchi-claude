// scripts/import-corpus.mjs 의 --recheck 가 이유 칸의 [표기]/[외래어] 표지를
// 잃지 않는지, 그리고 강등(치환 → 정규식)만 하고 승격은 하지 않는지 본다.
// parseTable 은 표지를 rule.kind 로 떼어 가므로, 검사 칸만 다시 써서 행을 재조립할
// 때 표지를 rule.kind 에서 되살리지 않으면 조용히 사라진다.
//
// decideCheck 는 "기계적 치환이 되는가"만 본다. 문맥이 겹쳐 사람이 손으로 정규식으로
// 내려 둔 규칙(예: "핸들링" → "처리")도 그 기준으로는 치환처럼 보이므로, recheck 가
// 그대로 승격시키면 손으로 내린 판단이 조용히 되돌아간다 — 강등만 허용해야 한다.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { recheckLine } from "../scripts/import-corpus.mjs";
import { parseTable } from "../hooks/lib/rules.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES_DIR = join(ROOT, "rules");

test("recheck 로 강등될 때(치환 → 정규식) [표기] 표지는 살아남는다", () => {
  const bad = "가".repeat(30); // SUBSTITUTE_MAX(24)를 넘겨 강제로 정규식으로 내려가게 한다
  const line = `| — | ${bad} | 나 | [표기] 아무 이유 | 치환 | 보통 |`;
  const changes = [];
  const after = recheckLine(line, "test.md", changes);

  assert.notEqual(after, line, "검사 칸이 바뀌지 않았다 — 시험 전제가 깨졌다");
  assert.match(after, /\[표기\]/, "표지가 사라졌다");

  const { rules } = parseTable(after, "test.md");
  assert.equal(rules[0].kind, "orthography");
  assert.equal(rules[0].check, "정규식");
});

test("recheck 로 강등될 때(치환 → 정규식) [외래어] 표지는 살아남는다", () => {
  const bad = "가".repeat(30);
  const line = `| — | ${bad} | 나 | [외래어] 아무 이유 | 치환 | 보통 |`;
  const changes = [];
  const after = recheckLine(line, "test.md", changes);

  assert.match(after, /\[외래어\]/, "표지가 사라졌다");
  const { rules } = parseTable(after, "test.md");
  assert.equal(rules[0].kind, "loanword");
  assert.equal(rules[0].check, "정규식");
});

test("검사 칸이 그대로면 줄 자체를 바꾸지 않는다", () => {
  const line = "| — | 테스트경계말 | 고침말 | [표기] 아무 이유 | 치환 | 보통 |";
  const changes = [];
  const after = recheckLine(line, "test.md", changes);
  assert.equal(after, line);
  assert.deepEqual(changes, []);
});

test("정규식으로 손으로 내려 둔 행은 decideCheck 가 치환을 가리켜도 승격하지 않는다", () => {
  // decideCheck("핸들링" → "처리") 는 규칙만 보면 치환으로 판정하지만, rules/pangyo.md
  // 에는 사람이 정규식으로 내려 두었다. recheck 는 이 판단을 뒤집으면 안 된다.
  const line = "| handling | 핸들링 | 처리 | 예외 처리·오류 처리가 표준이다 | 정규식 | 참고 |";
  const changes = [];
  const after = recheckLine(line, "test.md", changes);
  assert.equal(after, line);
  assert.deepEqual(changes, []);
});

test("recheckLine 을 rules/*.md 전체에 돌려도 승격(정규식 → 치환)은 없다", () => {
  const promotions = [];
  for (const name of readdirSync(RULES_DIR).filter((file) => file.endsWith(".md"))) {
    const text = readFileSync(join(RULES_DIR, name), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trimStart().startsWith("|")) continue;
      const { rules } = parseTable(line, name);
      if (rules.length !== 1) continue;
      const before = rules[0].check;
      const changes = [];
      const after = recheckLine(line, name, changes);
      if (after === line) continue;
      const { rules: afterRules } = parseTable(after, name);
      const nextCheck = afterRules[0]?.check;
      if (before === "정규식" && nextCheck === "치환") {
        promotions.push(`${name}: "${rules[0].bad}"`);
      }
    }
  }
  assert.deepEqual(promotions, []);
});
