// rules/*.md 의 마크다운 표를 규칙 객체로 파싱한다.
//
// 자료 원본을 마크다운 표로 두는 이유는 사람이 읽는 문서와 기계가 읽는 규칙을 한 파일로
// 묶기 위해서다. 두 벌로 나누면 반드시 어긋난다.
//
// 기대하는 표 형식:
//   | 원어 | 쓰지 말 것 | 쓸 것 | 이유 | 검사 | 순위 |

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CHECKS } from "./checks.mjs";
import { LATIN_HADA_RULE } from "./latin-hada.mjs";

// 검사 칸 상수는 checks.mjs 가 원본이다 — latin-hada.mjs 도 이 값을 쓰는데, 여기서
// 정의하면 latin-hada.mjs 를 불러오는 위 import 와 순환 참조가 된다(checks.mjs
// 상단 설명 참고). 이 파일을 불러 쓰던 곳은 그대로 rules.mjs 에서 이름을 가져오면
// 되도록 다시 내보낸다.
export { CHECK_SUBSTITUTE, CHECK_REGEX, CHECK_PROMPT, CHECKS, SCANNABLE_CHECKS } from "./checks.mjs";

export const PRIORITIES = ["핵심", "보통", "참고"];

// rules/*.md 표로 옮길 수 없는 검사(latin-hada.mjs 상단 설명 참고)를 loadRules() 가
// 함께 내보낸다. 규칙표 파싱과 분리해 둔 것은, 스타일 본문(build-style.mjs)·README
// 규칙 수·코퍼스 표 시험(corpus.test.mjs)처럼 "표에 적힌 규칙만" 봐야 하는 소비자가
// rules 필드만 그대로 쓰면 되고, 훅처럼 "실제로 검사하는 전체 규칙"이 필요한 쪽만
// builtins 를 더해 쓰면 되게 하려는 것이다.
const BUILTIN_RULES = [LATIN_HADA_RULE];

// 이유 칸 맨 앞에 적는 명시 표지. lint.mjs 가 이유의 낱말(예: "표기")을 문자열로 매칭해
// 경계 검사를 켜고 끄던 것을 대신한다 — 이유를 다듬어 적다 보면 매칭 낱말이 우연히
// 빠지거나 들어가 판정이 조용히 바뀌었다. 0.13.19에서 실제로 그랬다(레지스터리는 "외래어"
// 낱말이 빠져 분류를 잃었고, "50 %"는 새 이유에 "띄어"가 우연히 들어가 분류를 얻었다).
// 판정에 쓰는 값과 사람이 읽는 설명을 분리해 이유 문장을 자유롭게 고쳐도 판정이 흔들리지
// 않게 한다.
//   [표기]   — 표기·맞춤법·띄어쓰기 규칙. 왼쪽 경계 검사를 건너뛴다(kind: "orthography")
//   [외래어] — 외래어 표기 규칙. 왼쪽·오른쪽 경계 둘 다 건너뛴다(kind: "loanword", 표기를 포함한다)
const RULE_KIND_TAGS = { "[표기] ": "orthography", "[외래어] ": "loanword" };
// 코퍼스 검사(tests/corpus.test.mjs)가 "이유 칸 맨 앞의 대괄호는 늘 이 둘 중 하나"를 확인할 때 쓴다.
export const RULE_KIND_TAG_NAMES = Object.keys(RULE_KIND_TAGS);
// 대괄호로 시작하는지만 느슨하게 본다. 뒤에 오는 공백까지 요구하면 "[외래어]외래어 표기법"처럼
// 공백을 빠뜨린 오타가 대괄호 자체를 못 찾아 코퍼스 검사를 통과해 버린다 — 그 오타를 잡는 일이
// 정확히 이 검사의 목적이므로, 여기서는 대괄호만 보고 "알려진 표지와 정확히 같은가"는
// RULE_KIND_TAG_NAMES 로 따로 비교한다.
export const BRACKET_PREFIX_PATTERN = /^\[[^\]]*\]/;

/**
 * rule.kind 를 이유 칸 맨 앞 표지 문자열로 되돌린다. kind 가 없으면 빈 문자열.
 * import-corpus.mjs 의 --recheck 가 이유 칸을 다시 쓸 때 표지를 잃지 않게 하는 데 쓴다 —
 * parseTable 이 이미 떼어낸 rule.why 에는 표지가 남아 있지 않다.
 * @param {string} [kind]
 * @returns {string}
 */
export function kindTag(kind) {
  const entry = Object.entries(RULE_KIND_TAGS).find(([, k]) => k === kind);
  return entry ? entry[0] : "";
}

const HEADER_FIRST_CELL = "원어";
const CELL_COUNT = 6;
const PIPE_PLACEHOLDER = "\u0001";
const PIPE_PLACEHOLDER_PATTERN = new RegExp(PIPE_PLACEHOLDER, "g");
const EMPTY_MARKS = new Set(["—", "-", "–", ""]);

/**
 * 이유 칸 맨 앞의 표지를 떼어 kind 로 돌려준다. 표지가 없으면 kind 는 undefined.
 * 정의되지 않은 표지(예: "[foo] ")는 표지로 인정하지 않고 이유 글자 그대로 둔다 —
 * 오타를 조용히 무시하는 대신 이유 문장 첫머리에 대괄호가 그대로 남아 눈에 띈다.
 * @param {string} why
 * @returns {{why: string, kind?: string}}
 */
function stripKindTag(why) {
  for (const [tag, kind] of Object.entries(RULE_KIND_TAGS)) {
    if (why.startsWith(tag)) return { why: why.slice(tag.length), kind };
  }
  return { why };
}

function splitCells(line) {
  const escaped = line.replace(/\\\|/g, PIPE_PLACEHOLDER);
  const trimmed = escaped.trim().replace(/^\|/, "").replace(/\|$/, "");
  // 이스케이프한 파이프는 드물다. 있는 칸만 되돌린다.
  return trimmed
    .split("|")
    .map((cell) =>
      cell.includes(PIPE_PLACEHOLDER) ? cell.replace(PIPE_PLACEHOLDER_PATTERN, "|").trim() : cell.trim()
    );
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function normalizeOptional(cell) {
  return EMPTY_MARKS.has(cell) ? "" : cell;
}

/**
 * 마크다운 문서 하나에서 규칙을 뽑는다.
 *
 * 형식이 깨진 행은 조용히 버리고 개수만 센다. 자료 파일 하나가 망가져도
 * 플러그인 전체가 멈추면 안 되기 때문이다.
 *
 * @param {string} markdown
 * @param {string} source 파일 이름. 오류 추적용
 * @returns {{rules: object[], skipped: number}}
 */
export function parseTable(markdown, source = "") {
  const rules = [];
  let skipped = 0;

  if (typeof markdown !== "string") return { rules, skipped };

  for (const line of markdown.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;

    const cells = splitCells(line);
    if (isSeparatorRow(cells)) continue;
    if (cells[0] === HEADER_FIRST_CELL) continue;

    if (cells.length < CELL_COUNT) {
      skipped += 1;
      continue;
    }

    const [en, bad, good, whyRaw, check, priority] = cells;

    if (!CHECKS.includes(check)) {
      skipped += 1;
      continue;
    }
    if (!PRIORITIES.includes(priority)) {
      skipped += 1;
      continue;
    }
    if (EMPTY_MARKS.has(bad) || EMPTY_MARKS.has(good)) {
      skipped += 1;
      continue;
    }

    const { why, kind } = stripKindTag(normalizeOptional(whyRaw));

    rules.push({
      en: normalizeOptional(en),
      bad,
      good,
      why,
      ...(kind ? { kind } : {}),
      check,
      priority,
      source,
    });
  }

  return { rules, skipped };
}

/**
 * rules 디렉터리의 모든 마크다운을 읽어 규칙을 모은다.
 *
 * builtins 는 rulesDir 과 무관하게 늘 같다(rules/*.md 표로 표현할 수 없는 검사라 파일이
 * 아니라 코드로 있다) — build-style.mjs·corpus.test.mjs·import-corpus.mjs 처럼 표
 * 자체만 다루는 소비자는 rules 만 쓰고 builtins 는 무시하면 되고, artifact.loadToneRules()
 * 처럼 실제 검사에 쓰는 전체 집합이 필요한 소비자만 [...rules, ...builtins] 로 합친다.
 *
 * @param {string} rulesDir
 * @returns {{rules: object[], builtins: object[], skipped: number, files: string[]}}
 */
export function loadRules(rulesDir) {
  if (!existsSync(rulesDir)) return { rules: [], builtins: BUILTIN_RULES, skipped: 0, files: [] };

  const files = readdirSync(rulesDir)
    .filter((name) => name.endsWith(".md"))
    .sort();

  const rules = [];
  let skipped = 0;

  for (const name of files) {
    let markdown;
    try {
      markdown = readFileSync(join(rulesDir, name), "utf8");
    } catch {
      continue;
    }
    const parsed = parseTable(markdown, name);
    rules.push(...parsed.rules);
    skipped += parsed.skipped;
  }

  return { rules, builtins: BUILTIN_RULES, skipped, files };
}

// 린터의 적용 범위: 커밋 메시지와 문서 파일. **대화는 보지 못한다.**
// 그래서 `검사` 값은 "어떻게 강제하는가"이고 "얼마나 중요한가"가 아니다. 후자는 `순위` 칸의 일이다.
// 스타일 본문에 무엇을 담을지는 build-style.mjs 가 갈래별 예산으로 정한다.

/**
 * 순위 순으로 정렬한다. 같은 순위 안에서는 규칙 파일에 적은 순서를 지킨다.
 * @param {object[]} rules
 * @returns {object[]}
 */
export function byPriority(rules) {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const byRank =
        PRIORITIES.indexOf(a.rule.priority) - PRIORITIES.indexOf(b.rule.priority);
      return byRank !== 0 ? byRank : a.index - b.index;
    })
    .map(({ rule }) => rule);
}
