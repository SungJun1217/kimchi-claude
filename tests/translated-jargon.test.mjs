// 실제 사용자 저장소(README.ko.md)에서 관찰한 직역 한자어 신조어를 잡는지 검사한다.
//
// 적격(eligible)·인출률(pull rate)·붕괴시키다(collapse a block)·축자 인용(verbatim)·
// 계상되다(counted)·열화 보고(degradation report)는 개별 글자만 보면 멀쩡한 한자어라
// 기존 규칙표를 통과했다(rules/hanja.md, 2026-09-26 추가). 각 낱말이 다른 정당한 뜻과
// 겹쳐 정규식(경고만, 자동 교정 없음)으로 두었다.
//
// 처음 후보에 있던 원장(ledger)과 게이팅(gating)은 검토 리뷰에서 뺐다 — 분산 원장
// 기술(DLT)·원장 테이블, 게이팅 네트워크(MoE)·피처 게이팅처럼 그 자체가 정착한 용어라
// 제외 이유를 rules/hanja.md 본문에 적었다(불변식 9). 이 시험은 그 제외가 유지되는지
// 부정 사례로 확인한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lint, applyFixes } from "../hooks/lib/lint.mjs";
import { loadRules, CHECK_REGEX } from "../hooks/lib/rules.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { rules } = loadRules(join(ROOT, "rules"));

const REAL_SENTENCES = [
  ["적격 여부는 받는 세션이 시작할 때 판정하므로", "적격 여부 / 적격 대상"],
  ["아카이브 지연과 인출률 포함", "인출률"],
  ["인출률이 끝없이 낮아 보입니다", "인출률"],
  ["낡은 구간을 그 자리에서 붕괴시킵니다.", "붕괴시키 / 붕괴시킵니다 / 붕괴시킨 / 붕괴시켜 / 붕괴시켰"],
  ["축자 인용만. 재작성하지 않음", "축자 인용"],
  ["모르는 레코드 종류는 여전히 unparsed로 계상됩니다.", "계상"],
  ["status의 열화 보고로 완화하지만", "열화 보고"],
];

for (const [sentence, bad] of REAL_SENTENCES) {
  test(`실제 문장을 잡는다: ${sentence}`, () => {
    const findings = lint(sentence, rules);
    assert.ok(
      findings.some((f) => f.bad === bad),
      `"${sentence}" 에서 "${bad}" 규칙이 안 잡혔다 (잡힌 것: ${findings.map((f) => f.bad).join(", ")})`
    );
    const fixed = applyFixes(sentence, rules);
    assert.deepEqual(fixed.applied, [], `정규식 규칙인데 자동 교정이 일어났다: ${sentence}`);
  });
}

// "붕괴시키" 계열은 -ㅂ니다/-ㄴ/-어/-었 활용이 시키다 어간의 마지막 음절(키)을 통째로
// 삼켜 문자열로는 안 남는다("시키"+"ㅂ니다"="시킵니다"). 활용형마다 대안을 따로 적었다.
const COLLAPSE_INFLECTIONS = [
  "지난주에 오래된 인덱스를 붕괴시켰습니다.",
  "이 절차가 낡은 구간을 붕괴시킨 다음",
  "그 자리에서 즉시 붕괴시켜 버립니다",
];
for (const sentence of COLLAPSE_INFLECTIONS) {
  test(`붕괴시키다 활용형도 잡는다: ${sentence}`, () => {
    const findings = lint(sentence, rules);
    assert.ok(findings.some((f) => f.bad.startsWith("붕괴시키")), sentence);
  });
}

const GOOD_SENTENCES = [
  "대상(eligible) 여부는 받는 세션이 시작할 때 판정하므로",
  "아카이브 지연과 pull rate(조회 비율) 포함",
  "낡은 구간을 그 자리에서 접습니다.",
  "그대로 인용만. 재작성하지 않음",
  "모르는 레코드 종류는 여전히 unparsed로 집계됩니다.",
  "status의 degraded 상태 보고로 완화하지만",
];

for (const sentence of GOOD_SENTENCES) {
  test(`쓸 것 표현은 깨끗하다: ${sentence}`, () => {
    assert.deepEqual(lint(sentence, rules), []);
  });
}

// 구조적으로 가려낼 수 있는 부정 사례.
const NEGATIVE_SENTENCES = [
  // 왼쪽 경계(부적격).
  "부적격 판정을 받았다.",
  // 자동사 붕괴(사동 -시키다가 아니다).
  "건물이 붕괴했다.",
  // 정확한 어구(열화 보고가 아니라 열화 단독).
  "품질 열화가 심하다.",
  // 적격 여부/적격 대상으로 좁혀 적격성·적격 투자자·적격하다는 건드리지 않는다.
  "적격성 심사를 통과했다.",
  "적격 투자자만 참여할 수 있다.",
  "그 후보가 적격하다고 판단했다.",
  // 원장·게이팅은 검토에서 규칙을 뺐다 — 그 자체가 정착한 용어라 문자열로 가를 수 없다.
  "분산 원장 기술(DLT)을 공부했다.",
  "원장 테이블에 거래를 기록한다.",
  "원장님께 여쭈었다.",
  "게이팅 네트워크(MoE)를 구현했다.",
  "피처 게이팅을 적용했다.",
];

for (const sentence of NEGATIVE_SENTENCES) {
  test(`정당한 문맥은 잡지 않는다: ${sentence}`, () => {
    assert.deepEqual(lint(sentence, rules), []);
  });
}

// "건물을 붕괴시키는 지진"처럼 실제 물리적 붕괴를 사동형으로 쓴 문장은 세션/블록을
// 접는다는 뜻의 오용과 문자열로 구분할 수 없어 여전히 경고가 뜬다(알려진 한계, 자동
// 교정은 하지 않는다). cache/임시 저장소, buffer/완충 장치와 같은 종류의 트레이드오프다.
test("실제 붕괴를 사동으로 쓴 문장도 구분하지 못해 경고가 뜬다(알려진 한계)", () => {
  const findings = lint("건물을 붕괴시키는 지진이 났다.", rules);
  assert.ok(findings.some((f) => f.bad.startsWith("붕괴시키")));
});

test("적격·인출률·붕괴시키·축자 인용·계상·열화 보고 규칙은 정규식이라 경고만 한다", () => {
  const bads = [
    "적격 여부 / 적격 대상",
    "인출률",
    "붕괴시키 / 붕괴시킵니다 / 붕괴시킨 / 붕괴시켜 / 붕괴시켰",
    "축자 인용",
    "계상",
    "열화 보고",
  ];
  for (const bad of bads) {
    const rule = rules.find((r) => r.bad === bad && r.source === "hanja.md");
    assert.ok(rule, `"${bad}" 규칙을 rules/hanja.md 에서 못 찾았다`);
    assert.equal(rule.check, CHECK_REGEX, `"${bad}" 는 정규식이어야 한다`);
  }
});

test("원장·게이팅 규칙은 검토에서 빠졌다", () => {
  assert.equal(rules.find((r) => r.bad === "원장" && r.source === "hanja.md"), undefined);
  assert.equal(rules.find((r) => r.bad === "게이팅" && r.source === "hanja.md"), undefined);
});
