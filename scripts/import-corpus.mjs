#!/usr/bin/env node
// 조사로 모은 규칙 묶음(JSON)을 rules/*.md 로 옮긴다.
//
// 개발용 도구다. 플러그인이 돌 때는 쓰이지 않는다.
//
// 기대하는 JSON 모양:
//   { "rules": [ { "category", "en", "bad", "good", "why"|"reason", "lintable", "priority" }, ... ] }
//
// 검사 칸은 손으로 정하지 않고 계산한다. applyFixes 로 실제 치환을 해 보고
// 성공하는 것만 `치환`으로 표시한다. 조사가 깨지거나 대체 표현이 드롭인이 아니면 `정규식`으로 내린다.
// 규칙 하나하나를 사람이 판정하면 536개에서 반드시 틀린다.
//
// 사용법:
//   node scripts/import-corpus.mjs corpus.json
//   node scripts/import-corpus.mjs corpus.json --dry-run

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFixes, toPattern, lint } from "../hooks/lib/lint.mjs";
import { PRIORITIES } from "../hooks/lib/rules.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES_DIR = join(ROOT, "rules");

// 분류 이름 → 파일 이름과 머리글
const CATEGORY_FILES = {
  hanja: {
    file: "hanja.md",
    heading: "# 용어 — 한국어 기술용어가 있는 경우",
    intro: [
      "영어 개념에 대응하는 한국어 기술용어가 이미 있는 경우다. 대개 한자어이고, 풀어쓴 서술문보다",
      "짧고 정확하며 이미 통용된다.",
      "",
      "`쓰지 말 것` 칸에는 클로드가 낼 법한 어색한 대안을 넣는다. 대개 풀어쓴 서술문이다.",
    ],
  },
  metaphor: {
    file: "metaphors.md",
    heading: "# 은유",
    intro: [
      "영어 기술 글쓰기에는 물리적·공간적 은유가 많다. 그것을 단어째로 옮기면 단어는 다 한국어인데",
      "비유가 영어라서 뜻이 통하지 않는다. 단어 검사와 문법 검사를 모두 통과하기 때문에 가장 잡기 어렵다.",
      "",
      "핵심은 **은유마다 정착 여부가 다르다**는 점이다. 원칙으로 유도할 수 없으므로 사례를 판정해 둔다.",
      "정착한 은유는 그대로 쓴다. 무거운 작업, 가벼운 라이브러리, 코드 냄새, 일급 함수.",
    ],
  },
  literal: {
    file: "terms.md",
    heading: "# 직역과 음차",
    intro: [
      "영어 용어를 억지로 직역하거나 음차해서 만든, 한국어로 통하지 않는 표기를 모은다.",
      "",
      "두 방향의 실패가 함께 들어 있다.",
      "",
      "- **과잉 번역** — 정착한 외래어를 억지로 우리말로 바꾸는 것. \"캐시\"를 \"임시 저장소\"로.",
      "- **불필요한 음차** — 우리말 용어가 있는데 소리만 옮기는 것. \"블라스트 레디우스\".",
    ],
  },
  syntax: {
    file: "patterns.md",
    heading: "# 문장 구조",
    intro: [
      "단어가 아니라 문장 구조에서 나오는 번역 냄새다. 용어표로는 잡히지 않는 층이다.",
      "",
      "`검사`가 `프롬프트`인 규칙은 문자열로 잡을 수 없어 출력 스타일만이 막을 수 있다.",
    ],
  },
  pangyo: {
    file: "pangyo.md",
    heading: "# 판교어와 한영 혼용",
    intro: [
      "한국 개발 현장의 영어 음차 남용과 한영 혼용을 모은다.",
      "",
      "판단 기준은 하나다. 한국 개발자가 공식 기술 문서나 팀 위키에 쓸 표현인가.",
      "구어로만 쓰는 말이면 글에서는 뺀다.",
      "",
      "반대로 이미 표준으로 굳은 외래어는 절대 바꾸지 않는다. 커밋, 머지, 브랜치, 배포, 캐시,",
      "버퍼, 큐, 스택, 스레드, 토큰, 세션, 리팩터링, 테스트, 빌드, 로그, 인터페이스, 모듈.",
    ],
  },
  register: {
    file: "register.md",
    heading: "# 어투와 표기",
    intro: [
      "실무 동료체를 유지하는 층이다. 경어체 일관성, 군더더기 제거, 표기법.",
      "",
      "한 답변 안에서 `~합니다`와 `~해요`와 `~한다`를 섞지 않는다. 기본은 `~습니다`로 한다.",
      "",
      "영어 단어 뒤 조사는 **발음**으로 받침을 판단한다. 철자가 아니다.",
      "`commit을`, `JSON을`, `SQL을` / `cache를`, `API를`, `UUID를`.",
    ],
  },
};

const TABLE_HEADER = ["| 원어 | 쓰지 말 것 | 쓸 것 | 이유 | 검사 | 순위 |", "|---|---|---|---|---|---|"];

// 대체 표현이 드롭인이 아니라는 신호들. 이런 값은 자동 치환 대상에서 뺀다.
const NOT_DROP_IN = /[\/|]|생략|또는|참조|문맥|\.{3}|…/;

// 금칙어 길이로 세 구간을 가른다.
//
// 종결어미로 끝나는지는 기준이 못 된다. 한국어에서는 구절 단위 패턴도 자연스럽게
// 종결어미로 끝난다. "픽스했습니다"는 예시 문장이 아니라 쓸 만한 패턴이다.
const SUBSTITUTE_MAX = 24; // 이 길이까지는 자동 교정을 검토한다
const PATTERN_MAX = 40; // 이 길이를 넘으면 그 문장 하나에서만 걸리므로 린터에 쓸모가 없다

function patternCore(bad) {
  return bad.replace(/^~+|~+$/g, "").trim();
}

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

/**
 * 검사 칸의 값을 계산한다. 사람의 판단 대신 실제 동작으로 정한다.
 */
function decideCheck(rule) {
  if (!rule.lintable) return "프롬프트";
  if (toPattern(rule.bad) === null) return "프롬프트";

  const length = patternCore(rule.bad).length;
  // 너무 긴 금칙어는 그 문장 하나에서만 걸린다. 스타일 본문의 대조 예시로만 쓴다.
  if (length > PATTERN_MAX) return "프롬프트";
  // 문장 하나를 통째로 갈아 끼우는 것은 위험하다. 잡기만 하고 고치지는 않는다.
  if (length > SUBSTITUTE_MAX) return "정규식";

  const candidate = { ...rule, check: "치환" };

  // 대체 표현이 드롭인으로 보이지 않으면 경고만 한다.
  if (NOT_DROP_IN.test(rule.good)) return "정규식";
  // 고친 결과가 같은 규칙에 또 걸리면 순환한다.
  if (lint(rule.good, [candidate]).length > 0) return "정규식";

  // 실제로 치환해 본다. 조사가 없는 자리에서도 적용되지 않으면 치환 규칙이 아니다.
  // 조사 앞에서 막히는 경우는 applyFixes 의 안전장치가 실행 시점에 알아서 건너뛴다.
  const plain = applyFixes(`앞말 ${rule.bad} 뒷말`, [candidate]);
  if (plain.applied.length === 0) return "정규식";

  return "치환";
}

function normalizePriority(value) {
  return PRIORITIES.includes(value) ? value : "보통";
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const path = args.find((arg) => !arg.startsWith("--"));

  if (!path) {
    console.error("사용법: node scripts/import-corpus.mjs <corpus.json> [--dry-run]");
    process.exit(2);
  }

  const payload = JSON.parse(readFileSync(path, "utf8"));
  const incoming = payload.rules || payload;
  if (!Array.isArray(incoming)) {
    console.error("JSON 에 rules 배열이 없습니다.");
    process.exit(2);
  }

  const grouped = new Map();
  const unknownCategories = new Set();
  const seen = new Set();
  let duplicates = 0;

  for (const raw of incoming) {
    const category = raw.category;
    if (!CATEGORY_FILES[category]) {
      unknownCategories.add(category);
      continue;
    }
    const bad = escapeCell(raw.bad);
    const good = escapeCell(raw.good);
    if (!bad || !good || bad === good) continue;
    if (seen.has(bad)) {
      duplicates += 1;
      continue;
    }
    seen.add(bad);

    const rule = {
      en: escapeCell(raw.en) || "—",
      bad,
      good,
      why: escapeCell(raw.why || raw.reason) || "—",
      lintable: raw.lintable !== false,
      priority: normalizePriority(raw.priority),
    };
    rule.check = decideCheck(rule);

    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(rule);
  }

  const summary = [];
  for (const [category, rules] of grouped) {
    const meta = CATEGORY_FILES[category];
    const ordered = [...rules].sort(
      (a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)
    );
    const lines = [
      // 이 파일은 나쁜 예를 일부러 인용한다. 린터가 자기 자료를 지적하면 쓸 수 없다.
      "<!-- kimchi-ignore-file -->",
      meta.heading,
      "",
      ...meta.intro,
      "",
      ...TABLE_HEADER,
      ...ordered.map(
        (rule) =>
          `| ${rule.en} | ${rule.bad} | ${rule.good} | ${rule.why} | ${rule.check} | ${rule.priority} |`
      ),
      "",
    ];
    const target = join(RULES_DIR, meta.file);
    if (!dryRun) writeFileSync(target, lines.join("\n"), "utf8");

    const counts = ordered.reduce((acc, rule) => {
      acc[rule.check] = (acc[rule.check] || 0) + 1;
      return acc;
    }, {});
    summary.push(
      `${meta.file.padEnd(14)} ${String(ordered.length).padStart(4)}개  ` +
        `치환 ${counts["치환"] || 0}, 정규식 ${counts["정규식"] || 0}, 프롬프트 ${counts["프롬프트"] || 0}`
    );
  }

  console.log(dryRun ? "시험 실행입니다. 파일을 쓰지 않았습니다.\n" : "규칙 파일을 다시 썼습니다.\n");
  console.log(summary.sort().join("\n"));
  console.log(`\n총 ${seen.size}개.`);
  if (duplicates > 0) console.log(`쓰지 말 것이 겹쳐 버린 항목 ${duplicates}개.`);
  if (unknownCategories.size > 0) {
    console.log(`모르는 분류 ${[...unknownCategories].join(", ")} 는 건너뛰었습니다.`);
  }
  console.log("\n다음: node scripts/build-style.mjs && npm test");
}

main();
