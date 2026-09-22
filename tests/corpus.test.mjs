// 규칙표 자체를 검사한다.
//
// 이 시험이 잡으려는 실패는 이렇다. 어떤 규칙이 "X를 쓰지 말고 리팩토링을 쓰라"고 하는데
// 다른 규칙이 "리팩토링을 쓰지 말고 리팩터링을 쓰라"고 하는 경우다.
// 규칙이 수백 개로 자라면 사람 눈으로는 못 잡는다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules, CHECKS, PRIORITIES, CHECK_SUBSTITUTE } from "../hooks/lib/rules.mjs";
import { lint, toPattern, applyFixes } from "../hooks/lib/lint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { rules, skipped, files } = loadRules(join(ROOT, "rules"));

test("규칙 파일을 읽었고 형식이 깨진 행이 없다", () => {
  assert.ok(files.length > 0, "rules/ 에 마크다운 파일이 없다");
  assert.ok(rules.length > 0, "규칙을 하나도 읽지 못했다");
  assert.equal(skipped, 0, `형식이 깨진 행이 ${skipped}개 있다`);
});

test("검사와 순위 칸의 값이 모두 유효하다", () => {
  for (const rule of rules) {
    assert.ok(CHECKS.includes(rule.check), `"${rule.bad}" 의 검사 값이 잘못됐다: ${rule.check}`);
    assert.ok(PRIORITIES.includes(rule.priority), `"${rule.bad}" 의 순위 값이 잘못됐다`);
  }
});

test("쓸 것이 다른 규칙에 걸리지 않는다", () => {
  // 규칙이 권하는 표현이 다른 규칙의 금칙어면 순환이 생긴다.
  const problems = [];
  for (const rule of rules) {
    const others = rules.filter((other) => other !== rule);
    for (const finding of lint(rule.good, others)) {
      problems.push(`"${rule.bad}" → "${rule.good}" 가 "${finding.bad}" 규칙에 걸린다`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
});

test("쓰지 말 것이 중복되지 않는다", () => {
  const seen = new Map();
  const duplicates = [];
  for (const rule of rules) {
    const previous = seen.get(rule.bad);
    if (previous && previous.good !== rule.good) {
      duplicates.push(`"${rule.bad}" 가 "${previous.good}" 과 "${rule.good}" 두 곳에서 갈린다`);
    }
    seen.set(rule.bad, rule);
  }
  assert.deepEqual(duplicates, [], `\n${duplicates.join("\n")}`);
});

test("쓰지 말 것과 쓸 것이 같은 규칙이 없다", () => {
  const useless = rules
    .filter((rule) => rule.bad.trim() === rule.good.trim())
    .map((rule) => rule.bad);
  assert.deepEqual(useless, []);
});

test("치환 규칙은 실제로 치환할 수 있다", () => {
  const broken = [];
  for (const rule of rules) {
    if (rule.check !== CHECK_SUBSTITUTE) continue;
    if (toPattern(rule.bad) === null) {
      broken.push(`"${rule.bad}" 는 문자열 검사가 안 되는데 치환으로 표시됐다`);
      continue;
    }
    const sample = `앞말 ${rule.bad} 뒷말`;
    const { text, applied, skipped: notApplied } = applyFixes(sample, [rule]);
    if (applied.length === 0) {
      const reason = notApplied[0]?.reason || "이유 불명";
      broken.push(`"${rule.bad}" 치환이 적용되지 않는다: ${reason}`);
    } else if (text === sample) {
      broken.push(`"${rule.bad}" 치환이 문장을 바꾸지 않았다`);
    }
  }
  assert.deepEqual(broken, [], `\n${broken.join("\n")}`);
});

test("치환 규칙은 자기 자신을 다시 잡지 않는다", () => {
  // 고친 결과가 같은 규칙에 또 걸리면 무한히 지적하게 된다.
  const looping = [];
  for (const rule of rules) {
    if (rule.check !== CHECK_SUBSTITUTE) continue;
    if (lint(rule.good, [rule]).length > 0) looping.push(`"${rule.bad}" → "${rule.good}"`);
  }
  assert.deepEqual(looping, []);
});

test("한 글자 금칙어에는 문자열 검사를 걸지 않는다", () => {
  // 한 글자 규칙은 오탐이 너무 많다. 스타일 본문으로만 가르쳐야 한다.
  const risky = rules
    .filter((rule) => rule.check === CHECK_SUBSTITUTE && rule.bad.replace(/[~\s]/g, "").length < 2)
    .map((rule) => rule.bad);
  assert.deepEqual(risky, []);
});

test("이유 칸이 비어 있지 않다", () => {
  const missing = rules.filter((rule) => rule.why.trim().length === 0).map((rule) => rule.bad);
  assert.deepEqual(missing, [], "이유가 없으면 목록 밖으로 일반화되지 않는다");
});

test("깨끗한 한국어 문장에는 아무 규칙도 걸리지 않는다", () => {
  // 오탐 감시용이다. 규칙을 더할 때 이 문장들이 걸리기 시작하면 그 규칙이 너무 공격적이다.
  const clean = [
    "이 함수가 호출될 때마다 캐시를 새로 만들고 있어서 느렸습니다.",
    "결과를 한 번만 계산하고 재사용하도록 고쳤고, 테스트는 전부 통과합니다.",
    "모듈 사이의 결합도를 낮추면 변경 범위가 줄어듭니다.",
    "동시에 여러 요청이 들어오면 경쟁 조건이 생길 수 있습니다.",
    "이 수정의 영향 범위가 넓어서 결제 모듈에만 먼저 적용했습니다.",
    "리팩터링은 다음 스프린트로 넘기고, 지금은 지연 시간부터 잡겠습니다.",
    "커밋을 머지하기 전에 스레드 관련 테스트를 한 번 더 돌려 주세요.",
    "이 값이 늘 0으로 보이는 이유는 비동기 호출을 기다리지 않기 때문입니다.",
  ];
  const problems = [];
  for (const sentence of clean) {
    for (const finding of lint(sentence, rules)) {
      problems.push(`"${sentence}" 가 "${finding.bad}" 규칙에 걸린다`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
});

test("규칙이 겨냥한 나쁜 문장은 실제로 걸린다", () => {
  // 문자열 검사로 표시된 규칙은 자기 금칙어를 스스로 잡아야 한다.
  const silent = [];
  for (const rule of rules) {
    if (rule.check === "프롬프트") continue;
    if (toPattern(rule.bad) === null) continue;
    if (lint(`앞말 ${rule.bad} 뒷말`, [rule]).length === 0) silent.push(rule.bad);
  }
  assert.deepEqual(silent, []);
});
