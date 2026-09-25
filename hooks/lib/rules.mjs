// rules/*.md 의 마크다운 표를 규칙 객체로 파싱한다.
//
// 자료 원본을 마크다운 표로 두는 이유는 사람이 읽는 문서와 기계가 읽는 규칙을 한 파일로
// 묶기 위해서다. 두 벌로 나누면 반드시 어긋난다.
//
// 기대하는 표 형식:
//   | 원어 | 쓰지 말 것 | 쓸 것 | 이유 | 검사 | 순위 |

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// 검사 칸의 세 값은 세 가지 실제 능력에 대응한다.
//   치환   — 정규식으로 잡히고, 쓸 것으로 그대로 바꿔도 뜻이 상하지 않는다. 자동 교정 대상
//   정규식 — 잡을 수는 있지만 문맥을 봐야 고칠 수 있다. 경고만 한다
//   프롬프트 — 문자열로 잡을 수 없다. 출력 스타일만이 막을 수 있다
export const CHECK_SUBSTITUTE = "치환";
export const CHECK_REGEX = "정규식";
export const CHECK_PROMPT = "프롬프트";
export const CHECKS = [CHECK_SUBSTITUTE, CHECK_REGEX, CHECK_PROMPT];

// 치환과 정규식은 둘 다 린터가 문자열로 찾는다.
export const SCANNABLE_CHECKS = [CHECK_SUBSTITUTE, CHECK_REGEX];

export const PRIORITIES = ["핵심", "보통", "참고"];

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
 * @param {string} rulesDir
 * @returns {{rules: object[], skipped: number, files: string[]}}
 */
export function loadRules(rulesDir) {
  if (!existsSync(rulesDir)) return { rules: [], skipped: 0, files: [] };

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

  return { rules, skipped, files };
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
