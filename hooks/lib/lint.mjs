// 규칙표를 정규식 검사로 바꿔 문장에 적용한다.
//
// 검사 대상은 maskProtected가 덮은 문자열이다. 제외 구간이 센티넬로 바뀌어 있으므로
// 코드나 경로 안에서는 애초에 매치가 일어나지 않는다. 위치 비교를 따로 할 필요가 없다.

import { maskProtected, isIgnoredFile } from "./segment.mjs";
import { CHECK_SUBSTITUTE, SCANNABLE_CHECKS } from "./rules.mjs";

// 규칙의 "쓰지 말 것" 칸에서 ~ 는 "앞뒤에 무엇이 붙든"을 뜻한다.
const WILDCARD = "~";
const WILDCARD_PATTERN = "[^\\n]{0,20}";

// 한 글자 규칙은 오탐이 너무 많아 아예 쓰지 않는다.
const MIN_LITERAL_LENGTH = 2;

// 한 규칙이 같은 문서에서 몇 번까지 보고할지. 같은 지적을 수십 번 쏟아내면 읽지 않는다.
const MAX_HITS_PER_RULE = 3;

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;
const JAMO_COUNT = 28;

// 앞말의 받침에 따라 형태가 갈리는 조사들의 첫 글자.
// 넉넉하게 담는다. 잘못 포함해도 교정을 건너뛸 뿐이라 안전한 방향이다.
const PARTICLE_HEADS = new Set([
  "을", "를", "이", "가", "은", "는", "과", "와", "으", "로", "나", "라", "며", "야", "아",
]);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripWildcardEdges(text) {
  return text.trim().replace(/^~+/, "").replace(/~+$/, "");
}

/**
 * 규칙의 "쓰지 말 것" 문자열을 정규식으로 바꾼다.
 * 너무 짧아 위험한 규칙은 null을 돌려준다.
 *
 * @param {string} bad
 * @returns {RegExp|null}
 */
export function toPattern(bad) {
  if (typeof bad !== "string") return null;

  const core = stripWildcardEdges(bad);
  if (core.length === 0) return null;

  const parts = core.split(WILDCARD);
  const literalLength = parts.join("").replace(/\s+/g, "").length;
  if (literalLength < MIN_LITERAL_LENGTH) return null;

  const source = parts.map(escapeRegExp).join(WILDCARD_PATTERN);
  try {
    return new RegExp(source, "g");
  } catch {
    return null;
  }
}

/**
 * 마지막 한글 음절에 받침이 있는지 알려준다. 판정할 수 없으면 null.
 *
 * 한글 음절은 (코드 - 0xAC00) % 28 이 0이면 받침이 없다.
 *
 * @param {string} text
 * @returns {boolean|null}
 */
export function hasFinalConsonant(text) {
  if (typeof text !== "string") return null;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const code = text.charCodeAt(i);
    if (code >= HANGUL_START && code <= HANGUL_END) {
      return (code - HANGUL_START) % JAMO_COUNT !== 0;
    }
    // 끝에 한글이 아닌 글자가 있으면 받침을 판정할 수 없다.
    if (!/\s/.test(text[i])) return null;
  }
  return null;
}

/**
 * 치환해도 뒤따르는 조사가 깨지지 않는지 확인한다.
 *
 * "얇은 계약을"의 "얇은 계약"을 "낮은 결합도"로 바꾸면 "낮은 결합도을"이 된다.
 * 받침이 사라졌기 때문이다. 이런 경우에는 교정하지 않는다.
 *
 * @param {string} bad
 * @param {string} good
 * @param {string} nextChar 매치 바로 뒤 글자
 * @returns {boolean}
 */
export function isParticleSafe(bad, good, nextChar) {
  if (!nextChar || !PARTICLE_HEADS.has(nextChar)) return true;
  const before = hasFinalConsonant(bad);
  const after = hasFinalConsonant(good);
  if (before === null || after === null) return false;
  return before === after;
}

/**
 * 문장에 규칙을 적용해 위반 목록을 돌려준다.
 *
 * @param {string} text
 * @param {object[]} rules
 * @returns {object[]}
 */
export function lint(text, rules) {
  if (typeof text !== "string" || text.length === 0) return [];
  if (!Array.isArray(rules)) return [];
  if (isIgnoredFile(text)) return [];

  const masked = maskProtected(text);
  const findings = [];

  for (const rule of rules) {
    if (!SCANNABLE_CHECKS.includes(rule.check)) continue;

    const pattern = toPattern(rule.bad);
    if (pattern === null) continue;

    pattern.lastIndex = 0;
    let hits = 0;
    let match;
    while ((match = pattern.exec(masked)) !== null && hits < MAX_HITS_PER_RULE) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      findings.push({
        bad: rule.bad,
        good: rule.good,
        why: rule.why,
        check: rule.check,
        index: match.index,
        length: match[0].length,
        matched: text.slice(match.index, match.index + match[0].length),
        priority: rule.priority,
        source: rule.source,
      });
      hits += 1;
    }
  }

  return findings.sort((a, b) => a.index - b.index);
}

/**
 * 치환 규칙만 실제로 고쳐 쓴다. 자동 교정은 기본으로 꺼져 있고 호출하는 쪽이 켠다.
 *
 * @param {string} text
 * @param {object[]} rules
 * @returns {{text: string, applied: object[], skipped: object[]}}
 */
export function applyFixes(text, rules) {
  const applied = [];
  const skipped = [];

  if (typeof text !== "string" || text.length === 0) {
    return { text: typeof text === "string" ? text : "", applied, skipped };
  }

  const candidates = lint(text, rules).filter((finding) => {
    if (finding.check !== CHECK_SUBSTITUTE) return false;
    // 가운데 물결표가 있는 규칙은 무엇으로 바꿀지 정할 수 없다.
    return !stripWildcardEdges(finding.bad).includes(WILDCARD);
  });

  // 뒤에서부터 고친다. 앞쪽을 먼저 고치면 뒤쪽 위치가 어긋난다.
  const ordered = [...candidates].sort((a, b) => b.index - a.index);

  let result = text;
  let lastStart = result.length;

  for (const finding of ordered) {
    const end = finding.index + finding.length;
    if (end > lastStart) {
      skipped.push({ ...finding, reason: "앞선 교정과 겹칩니다" });
      continue;
    }

    const replacement = stripWildcardEdges(finding.good);
    if (replacement.length === 0) {
      skipped.push({ ...finding, reason: "바꿀 표현이 비어 있습니다" });
      continue;
    }

    const nextChar = result[end] ?? "";
    if (!isParticleSafe(finding.matched, replacement, nextChar)) {
      skipped.push({ ...finding, reason: `뒤따르는 조사 "${nextChar}"가 깨집니다` });
      continue;
    }

    result = result.slice(0, finding.index) + replacement + result.slice(end);
    applied.push({ ...finding, replacement });
    lastStart = finding.index;
  }

  return { text: result, applied: applied.reverse(), skipped };
}

/**
 * 위반 목록을 사람이 읽을 메시지로 만든다.
 *
 * @param {object[]} findings
 * @param {string} label 검사 대상 이름
 * @returns {string}
 */
export function formatFindings(findings, label = "") {
  if (findings.length === 0) return "";

  const lines = [
    label
      ? `${label}에서 어색한 한국어 표현 ${findings.length}건을 찾았습니다.`
      : `어색한 한국어 표현 ${findings.length}건을 찾았습니다.`,
    "",
  ];

  const seen = new Set();
  for (const finding of findings) {
    const key = `${finding.bad}\u0000${finding.good}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = finding.why ? ` (${finding.why})` : "";
    // 물결표는 규칙 표기용 기호이므로 사람에게 보여 줄 때는 뺀다.
    lines.push(`- "${finding.matched}" → "${stripWildcardEdges(finding.good)}"${reason}`);
  }

  return lines.join("\n");
}
