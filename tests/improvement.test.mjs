// 플러그인이 말투를 실제로 개선하는지 확인한다.
//
// 이 저장소에서 가장 약한 자리였다. "개선한다"고 주장하면서 손으로 두 번 비교한 것이
// 증거의 전부였다. claude plugin eval 은 자식 프로세스가 자격 증명을 받지 못해 돌지 않는다.
//
// 그래서 실제로 받은 답변을 자료로 보존하고, 린터로 채점해 차이를 시험으로 굳혔다.
// 손으로 한 비교는 다시 하지 않아도 된다.
//
// 자료는 tests/fixtures/ 에 있다. 같은 질문에 플러그인을 켜고 끈 상태로 받은 실제 답변이다.
//   질문: "keep the contract between these two modules thin" 이라는 리뷰를 받았는데 무슨 뜻인가

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules } from "../hooks/lib/rules.mjs";
import { lint } from "../hooks/lib/lint.mjs";
import { findParticleErrors } from "../hooks/lib/particle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { rules } = loadRules(join(ROOT, "rules"));

/** 예외 표시를 떼고 읽는다. 자료 파일이라 dogfood 시험에서 빠지도록 표시를 달아 두었다. */
function readAnswer(name) {
  const text = readFileSync(join(ROOT, "tests/fixtures", name), "utf8");
  return text.replace(/^<!--[\s\S]*?-->\n/, "");
}

function score(text) {
  return lint(text, rules).length + findParticleErrors(text).length;
}

const WITHOUT = readAnswer("thin-contract-without-plugin.md");
const WITH = readAnswer("thin-contract-with-plugin.md");
const FORCED = readAnswer("thin-contract-forced.md");

test("자료가 실제 답변이다", () => {
  // 짧은 예시가 아니라 받은 답변 전체여야 한다. 잘라 내면 비교가 흐려진다.
  assert.ok(WITHOUT.length > 500, `끈 상태 답변이 ${WITHOUT.length}자로 너무 짧다`);
  assert.ok(WITH.length > 300, `켠 상태 답변이 ${WITH.length}자로 너무 짧다`);
});

test("플러그인을 끈 답변에는 은유 직역이 들어 있다", () => {
  // 처음에 제보받은 바로 그 증상이다. 이 단정이 깨지면 자료가 바뀐 것이다.
  assert.match(WITHOUT, /계약이 얇/);
  assert.match(WITHOUT, /계약이 두꺼|계약을 두껍게/);
  assert.ok(score(WITHOUT) >= 3, `끈 상태에서 ${score(WITHOUT)}건만 걸렸다`);
});

test("플러그인을 켠 답변에는 걸리는 표현이 없다", () => {
  assert.equal(score(WITH), 0, "켠 상태에서도 걸리는 표현이 있다");
  assert.equal(score(FORCED), 0);
});

test("켠 답변이 통용되는 용어를 쓴다", () => {
  // 은유를 벗기고 개념의 이름을 쓰는 것이 이 플러그인의 핵심 규칙이다.
  assert.match(WITH, /결합도/);
  assert.match(WITH, /영향 범위|공개|노출/);
  assert.ok(!/얇/.test(WITH), "켠 답변에 얇다가 남아 있다");
});

test("유도 질문에도 얇다가 나오지 않는다", () => {
  // 질문에 thin 을 직접 넣어 가장 강하게 유도한 경우다.
  assert.ok(!/얇/.test(FORCED), "유도 질문에 얇다로 답했다");
  assert.match(FORCED, /결합도/);
});

test("개선폭을 수치로 남긴다", () => {
  const before = score(WITHOUT);
  const after = score(WITH);
  assert.ok(after < before, `개선이 없다: 끈 상태 ${before}건, 켠 상태 ${after}건`);
});
