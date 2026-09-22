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

const HEADER_FIRST_CELL = "원어";
const CELL_COUNT = 6;
const PIPE_PLACEHOLDER = "\u0001";
const EMPTY_MARKS = new Set(["—", "-", "–", ""]);

function splitCells(line) {
  const escaped = line.replace(/\\\|/g, PIPE_PLACEHOLDER);
  const trimmed = escaped.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed
    .split("|")
    .map((cell) => cell.replace(new RegExp(PIPE_PLACEHOLDER, "g"), "|").trim());
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

    const [en, bad, good, why, check, priority] = cells;

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

    rules.push({
      en: normalizeOptional(en),
      bad,
      good,
      why: normalizeOptional(why),
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

/**
 * 순위 순으로 정렬한다. 같은 순위 안에서는 원래 순서를 지킨다.
 * @param {object[]} rules
 * @returns {object[]}
 */
export function byPriority(rules) {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const diff =
        PRIORITIES.indexOf(a.rule.priority) - PRIORITIES.indexOf(b.rule.priority);
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map(({ rule }) => rule);
}
