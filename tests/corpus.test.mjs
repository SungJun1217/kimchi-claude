// 규칙표 자체를 검사한다.
//
// 이 시험이 잡으려는 실패는 이렇다. 어떤 규칙이 "X를 쓰지 말고 리팩토링을 쓰라"고 하는데
// 다른 규칙이 "리팩토링을 쓰지 말고 리팩터링을 쓰라"고 하는 경우다.
// 규칙이 수백 개로 자라면 사람 눈으로는 못 잡는다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRules,
  CHECKS,
  PRIORITIES,
  CHECK_SUBSTITUTE,
  RULE_KIND_TAG_NAMES,
  BRACKET_PREFIX_PATTERN,
} from "../hooks/lib/rules.mjs";
import {
  lint,
  toPattern,
  applyFixes,
  autoFixReplacement,
  alternativesOf,
  primaryGood,
} from "../hooks/lib/lint.mjs";
import { fixParticles } from "../hooks/lib/particle.mjs";

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

test("치환 규칙의 자동 교정 결과가 그 규칙 자신의 쓸 것과 같다", () => {
  // 표층 복사 → 깊은 복사처럼, 한 규칙 안의 매치가 다른 대안의 쓸 것을 꽂는 사고가
  // 실제로 있었다. 규칙 하나만 떼어 시험하면 못 잡는다 — 전체 규칙표를 상대로 돌려서,
  // 적용된 교정이 정말 그 규칙 자신의 autoFixReplacement 값과 같은지 봐야 한다.
  const mismatched = [];
  for (const rule of rules) {
    if (rule.check !== CHECK_SUBSTITUTE) continue;
    if (toPattern(rule.bad) === null) continue;
    const expected = autoFixReplacement(rule);
    if (expected === null) continue; // 다른 시험(치환 규칙은 그대로 꽂을 수 있는...)이 잡는다

    const sample = `앞말 ${rule.bad} 뒷말`;
    const { applied } = applyFixes(sample, rules);
    const hit = applied.find((a) => a.bad === rule.bad);
    if (!hit) {
      mismatched.push(`"${rule.bad}" 전체 규칙표에서는 자동 교정이 적용되지 않는다`);
    } else if (hit.replacement !== expected) {
      mismatched.push(`"${rule.bad}" → "${hit.replacement}" (기대: "${expected}")`);
    }
  }
  assert.deepEqual(mismatched, [], `\n${mismatched.join("\n")}`);
});

test("치환 규칙의 쓰지 말 것에는 / 로 가른 대안이 없다", () => {
  // " / "가 있는 셀은 한 대안만 매치돼도 다른 대안의 쓸 것을 꽂을 위험이 있다
  // (autoFixReplacement가 이런 규칙을 스스로 막지만, 애초에 자료에 남기지 않는다).
  // 대안이 필요하면 행을 나눠 대안마다 정확한 쓸 것을 짝짓는다.
  const withSlash = rules
    .filter((rule) => rule.check === CHECK_SUBSTITUTE && rule.bad.includes(" / "))
    .map((rule) => rule.bad);
  assert.deepEqual(withSlash, []);
});

test("치환 규칙은 자기 자신을 다시 잡지 않는다", () => {
  // 고친 결과가 같은 규칙에 또 걸리면 무한히 지적하게 된다.
  const looping = [];
  for (const rule of rules) {
    if (rule.check !== CHECK_SUBSTITUTE) continue;
    // 규칙 하나만 담은 배열이다 — latin-hada까지 섞이면 이 규칙과 무관한 매치로 오판할 수 있다.
    if (lint(rule.good, [rule], {}, { latinHada: false }).length > 0) {
      looping.push(`"${rule.bad}" → "${rule.good}"`);
    }
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
    // 규칙 하나만 담은 배열이다 — latin-hada가 섞이면 이 규칙이 진짜로 잡히는지와
    // 무관하게 길이가 0보다 커져 "잘 잡힌다"는 오판이 나올 수 있다.
    if (lint(`앞말 ${rule.bad} 뒷말`, [rule], {}, { latinHada: false }).length === 0) {
      silent.push(rule.bad);
    }
  }
  assert.deepEqual(silent, []);
});

// 아래 시험이 실제로 배포됐던 결함을 막는다.
// "커플링을 낮췄습니다" → "결합도, 느슨한 결합을 낮췄습니다" 가 실제로 나왔다.
//
// 판정은 생산 코드와 같은 함수(autoFixReplacement)로 한다. 예전에는 이 시험이 금칙 신호
// 목록을 손으로 베껴 써서 생산 코드보다 느슨했다.

test("치환 규칙은 그대로 꽂을 수 있는 대체 표현을 갖는다", () => {
  const unusable = rules
    .filter((rule) => rule.check === CHECK_SUBSTITUTE && autoFixReplacement(rule) === null)
    .map((rule) => `"${rule.bad}" → "${rule.good}"`);
  assert.deepEqual(unusable, [], "치환으로 표시됐는데 꽂을 표현을 뽑을 수 없다");
});

test("자동 교정은 검사 칸을 믿지 않고 스스로 막는다", () => {
  // rules/*.md 는 손으로 고치는 파일이다. 칸에 치환이라고 적혀 있어도 꽂을 수 없는 값이면
  // 문장이 망가지므로, applyFixes 가 자체 판정으로 막아야 한다.
  const handEdited = {
    bad: "커플링", good: "결합도, 느슨한 결합", why: "손으로 잘못 적은 규칙",
    check: CHECK_SUBSTITUTE, priority: "핵심", source: "hand.md",
  };
  const { text, applied } = applyFixes("커플링 문제입니다.", [handEdited]);
  assert.equal(applied[0]?.replacement, "결합도", "대안 나열을 그대로 꽂았다");
  assert.equal(text, "결합도 문제입니다.");
});

test("이유 칸 맨 앞의 대괄호 표지는 [표기]나 [외래어] 뿐이다", () => {
  // parseTable 은 이유 칸의 낱말이 아니라 이 표지만으로 orthography/loanword 를 가른다
  // (hooks/lib/lint.mjs 의 isOrthographyRule 참고). 정의되지 않은 대괄호가 파일에 남으면
  // 표지를 붙였다고 착각하고도 조용히 무시되는 규칙이 생긴다 — 자료를 손으로 고치다
  // 생기는 오타이므로 여기서 잡는다.
  const RULES_DIR = join(ROOT, "rules");
  const bad = [];
  for (const name of readdirSync(RULES_DIR).filter((n) => n.endsWith(".md"))) {
    const text = readFileSync(join(RULES_DIR, name), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trimStart().startsWith("|")) continue;
      const cells = line.split("|");
      const why = cells[4]?.trim() ?? "";
      const match = why.match(BRACKET_PREFIX_PATTERN);
      if (!match) continue;
      const known = RULE_KIND_TAG_NAMES.some((tag) => why.startsWith(tag));
      if (!known) bad.push(`${name}: "${why}"`);
    }
  }
  assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
});

// 참고: 치환 규칙 가운데 상당수는 앞뒤 받침이 다르다. 그 규칙들은 뒤에 조사가 없을 때만
// 교정되도록 실행 시점 안전장치에 의존하는 정상 규칙이므로, 받침 일치를 자료 불변식으로
// 단정하면 안 된다. applyFixes 가 실제로 조사를 지키는지는 tests/fixes.test.mjs 가 본다.

// ── 0.14.5 회귀 시험 ──────────────────────────────────────────

test("타겟팅은 타깃팅이 아니라 타기팅으로 고쳐진다 (겹침 해소)", () => {
  // target(타겟→타깃) 규칙이 타겟팅 안의 타겟까지 잡아 타깃팅으로 잘못 고치던 문제.
  // 더 긴 타겟팅 규칙이 겹침 해소에서 이겨야 한다.
  const cases = [
    ["타겟팅 광고를 껐습니다.", "타기팅 광고를 껐습니다."],
    ["타겟팅을 다시 설정합니다.", "타기팅을 다시 설정합니다."],
    ["마이크로타겟팅 전략입니다.", "마이크로타기팅 전략입니다."],
  ];
  for (const [input, expected] of cases) {
    const { text } = applyFixes(input, rules);
    assert.equal(text, expected, input);
    assert.ok(!text.includes("타깃팅"), `${input} 이 타깃팅으로 잘못 고쳐졌다`);
  }
});

test("타겟만 있으면 그대로 타깃으로 고쳐진다", () => {
  const { text } = applyFixes("타겟을 지정합니다.", rules);
  assert.equal(text, "타깃을 지정합니다.");
});

test("이미 틀린 타깃팅도 타기팅으로 고쳐진다", () => {
  const { text } = applyFixes("타깃팅 광고입니다.", rules);
  assert.equal(text, "타기팅 광고입니다.");
});

test("에 있어서는 문자열로 잡지 않는다 (있다의 활용과 구분할 수 없다)", () => {
  // 0.14.3에서 정규식으로 추가했으나, 존재를 뜻하는 있다 활용형과 문자열이 같아
  // "서버에 있어서는 안 됩니다", "있어서 다행입니다" 같은 정당한 문장까지 잡았다.
  // 문맥 판단이 필요해 프롬프트로 내렸다.
  const literal = [
    "이 키는 운영 서버에 있어서는 안 됩니다.",
    "이 서버에 있어서 다행입니다.",
  ];
  for (const sentence of literal) {
    const findings = lint(sentence, rules).filter((f) => f.matched === "에 있어서");
    assert.deepEqual(findings, [], sentence);
  }
});

test("지금새로는 금새로 잘못 잡지 않는다 (왼쪽 경계)", () => {
  // 금새→금세 규칙에 [표기] 표지가 있어 왼쪽 경계를 건너뛰던 탓에 지금+새로 속의
  // 금새까지 잡았다. 표지를 떼어 왼쪽 경계를 다시 켰다.
  const findings = lint("지금새로 만든 브랜치입니다.", rules);
  assert.deepEqual(findings.filter((f) => f.bad === "금새"), []);
});

test("금새는 여전히 잡는다", () => {
  // 정규식(경고)이라 자동 교정은 하지 않는다. 문맥에 따라 명사 금새(값)일 수 있어서다.
  const findings = lint("금새 끝났습니다.", rules);
  assert.ok(findings.some((f) => f.bad === "금새"), "금새 끝났습니다가 잡히지 않는다");
});

test("ㄹ 받침 어간의 -ㄹ께요 도 게로 고쳐진다", () => {
  const cases = [
    ["제가 드릴께요.", "제가 드릴게요."],
    ["알려드릴께요.", "알려드릴게요."],
    ["줄께요.", "줄게요."],
    ["만들께요.", "만들게요."],
  ];
  for (const [input, expected] of cases) {
    const { text } = applyFixes(input, rules);
    assert.equal(text, expected, input);
  }
});

test("볼께·줄께처럼 께 하나만 남긴 행은 두지 않는다 (조사 께와 구분할 수 없다)", () => {
  // 볼께가 빨개졌습니다: 볼(명사)+께가(조사). 볼께 행이 있으면 볼게가로 잘못 고쳐진다.
  // 셋째 줄께 앉으세요: 줄(명사)+께(조사). 줄께 행이 있으면 줄게로 잘못 고쳐진다.
  assert.deepEqual(lint("볼께가 빨개졌습니다.", rules), []);
  assert.deepEqual(lint("셋째 줄께 앉으세요.", rules), []);
});

test("매니져와 메니져는 모두 매니저로 고쳐진다", () => {
  assert.equal(applyFixes("매니져와 이야기했습니다.", rules).text, "매니저와 이야기했습니다.");
  assert.equal(applyFixes("메니져를 불렀습니다.", rules).text, "매니저를 불렀습니다.");
});

test("몇일째와 몇일간도 며칠로 고쳐진다", () => {
  assert.equal(applyFixes("몇일째 야근입니다.", rules).text, "며칠째 야근입니다.");
  assert.equal(applyFixes("몇일간 쉬었습니다.", rules).text, "며칠간 쉬었습니다.");
});

// ── 0.14.10 회귀 시험 ─────────────────────────────────────────
// 안전하지 않은 치환(활용형에 따라 문장이 깨지거나, 일상어와 겹치거나, 왼쪽 경계를 보지
// 않는 숫자 규칙이 다른 숫자 속을 잘못 잡는 경우)을 정규식(경고만)으로 내린 작업이다.

test("쓰지 말 것은 alternativesOf 로 나눈 뒤에도 규칙 사이에서 겹치지 않는다", () => {
  // " / "로 여러 대안을 적은 행이 있어도, 대안 하나하나가 다른 행의 금칙어와 같으면 안 된다.
  // 같으면 두 행 중 어느 쪽을 적용해야 할지 알 수 없다.
  //
  // 행(rule 객체) 자체를 열쇠로 겹침을 판정한다. bad 문자열로 판정하면 "같은 bad, 같은
  // good"인 진짜 중복 행(예전에 hanja.md/metaphors.md에 있던 행복한 길·변덕스러운 테스트·
  // 여파가 미치는 범위)까지 "bad가 같으니 같은 규칙"이라며 봐줘 버려서 이 시험이 못 잡는다.
  const seen = new Map();
  const duplicates = [];
  for (const rule of rules) {
    for (const alt of alternativesOf(rule.bad)) {
      const owner = seen.get(alt);
      if (owner && owner !== rule) {
        duplicates.push(
          `"${alt}" 가 "${owner.source}:${owner.bad}" 와 "${rule.source}:${rule.bad}" 두 행에 걸쳐 나온다`
        );
      }
      seen.set(alt, rule);
    }
  }
  assert.deepEqual(duplicates, [], `\n${duplicates.join("\n")}`);
});

// "늘어놓기"·"올리기"처럼 동사를 명사형으로 적은 금칙어는 뒤에 "위해"·"쉽게"가 붙는
// 활용 문맥에서 그대로 꽂으면 문장이 깨진다(정규식으로 내려 자동 교정은 하지 않는다).
// 남은 두 행은 "기"로 끝나지만 그 자체로 굳은 명사(락 단위를 재는 크기, dirty read의
// 읽기)라 이 시험의 대상이 아니다 — 접미사로 느슨하게 걸면 앞으로 들어올 진짜 위반까지
// 조용히 가릴 수 있어, 금칙어 전체 문자열로만 정확히 예외를 둔다.
const GI_ALLOWED_BAD = ["자물쇠 알갱이 크기", "더러운 읽기"];

test("치환 규칙의 금칙어가 '기'로 끝나면 쓸 것도 '기'로 끝난다 (예외는 명시한다)", () => {
  const mismatched = [];
  for (const rule of rules) {
    if (rule.check !== CHECK_SUBSTITUTE) continue;
    const alts = alternativesOf(rule.bad);
    const last = alts[alts.length - 1] ?? "";
    if (!last.endsWith("기")) continue;
    if (GI_ALLOWED_BAD.includes(last)) continue;
    const good = primaryGood(rule.good);
    if (!good.endsWith("기")) {
      mismatched.push(`"${last}" → "${good}"`);
    }
  }
  assert.deepEqual(mismatched, [], `\n${mismatched.join("\n")}`);
});

test("치환 규칙의 금칙어가 숫자로 시작하면 쓸 것도 같은 숫자로 시작한다", () => {
  // 숫자로 시작하는 금칙어는 왼쪽 경계 검사를 하지 않는다(compilePattern이 한글만 본다).
  // "13개의 파일"의 "3개의"까지 잡으면 안 되므로, 애초에 앞자리 숫자가 같은 자료만 남긴다.
  const mismatched = [];
  for (const rule of rules) {
    if (rule.check !== CHECK_SUBSTITUTE) continue;
    const alts = alternativesOf(rule.bad);
    const last = alts[alts.length - 1] ?? "";
    const digits = last.match(/^[0-9]+/)?.[0];
    if (!digits) continue;
    const good = primaryGood(rule.good);
    if (!good.startsWith(digits)) {
      mismatched.push(`"${last}" → "${good}"`);
    }
  }
  assert.deepEqual(mismatched, [], `\n${mismatched.join("\n")}`);
});

test("골든 문장: 자동 교정 파이프라인을 그대로 통과한다", () => {
  // fixParticles → applyFixes → fixParticles 는 hooks/lib/artifact.mjs 의 실제 순서다.
  const pipeline = (text) => fixParticles(applyFixes(fixParticles(text).text, rules).text).text;

  const unchanged = [
    "계약이 두꺼워서 바꾸기 어렵습니다.",
    "데이터를 차례로 늘어놓기 위해",
    "제가 맡은 일은 끝났습니다.",
    "선물 포장지를 샀다",
    "세입자 퇴거 일정",
    "심장 박동 수를 측정",
    "AC 커플링 커패시터",
    "건물 뒷문 열쇠",
    "원하시면 환불해 드릴 수 있습니다.",
    "13개의 파일을 수정했습니다.",
    "설치 후 설정 파일을 확인하십시오.",
    "회원 등급 올리기",
    "이 작업은 더 쪼갤 수 없음.",
    "캐시가 살아 있는 시간을 줄였다.",
    "서버가 잘 안 죽는 구성으로 바꿨다.",
    "새 API가 예전 것과도 맞는 구조입니다.",
    "락을 해제하는 것은 중요합니다.",
    "마이그레이션을 실행하는 것을 잊지 마세요.",
    "이것은 가장 흔한 실수들 중의 하나입니다.",
    "저는 이 부분이 원인이라고 생각합니다.",
  ];
  for (const sentence of unchanged) {
    assert.equal(pipeline(sentence), sentence, sentence);
  }

  assert.equal(pipeline("제가 확인해 본 결과를 공유합니다."), "확인해 본 결과를 공유합니다.");
  assert.equal(pipeline("패러렐리즘을 높였다"), "병렬성을 높였다");
});
