// 규칙표를 정규식 검사로 바꿔 문장에 적용한다.
//
// 검사 대상은 maskProtected가 덮은 문자열이다. 제외 구간이 센티넬로 바뀌어 있으므로
// 코드나 경로 안에서는 애초에 매치가 일어나지 않는다. 위치 비교를 따로 할 필요가 없다.

import { maskProtected, isIgnoredFile } from "./segment.mjs";
import { particleHeads } from "./particle.mjs";
import { CHECK_SUBSTITUTE, SCANNABLE_CHECKS } from "./rules.mjs";

// 규칙의 "쓰지 말 것" 칸에서 ~ 는 "앞뒤에 무엇이 붙든"을 뜻한다.
const WILDCARD = "~";
const WILDCARD_PATTERN = "[^\\n]{0,20}";

// 한 글자 규칙은 오탐이 너무 많아 아예 쓰지 않는다.
const MIN_LITERAL_LENGTH = 2;

// 한 규칙이 같은 문서에서 몇 번까지 보고할지. 같은 지적을 수십 번 쏟아내면 읽지 않는다.
// 겹침을 해소한 **뒤**에 적용한다. 해소하기 전에 적용하면 "루즈 커플링" 안에 갇힌 "커플링"
// 매치가 짧은 규칙의 몫을 다 써버려서, 뒤에 진짜로 따로 나온 "커플링"은 못 잡는다.
const MAX_HITS_PER_RULE = 3;

// 정규식 실행 자체가 오래 걸리는 것을 막는 안전 상한. 겹침 해소 전 원본 매치에 적용하므로
// 최종 보고 개수(MAX_HITS_PER_RULE)보다 넉넉해야 겹쳐서 버려질 매치도 해소 단계까지 살아남는다.
const MAX_RAW_HITS_PER_RULE = 50;

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;
const JAMO_COUNT = 28;

// 조사 지식은 particle.mjs 의 짝 표가 원본이다. 여기서는 첫 글자만 유도해 쓴다.
// 두 곳에 적으면 한쪽만 고치게 된다.
const PARTICLE_HEADS = particleHeads();

/** 앞말의 받침에 따라 목적격 조사를 고른다. */
function objectParticle(word) {
  return hasFinalConsonant(word) ? "을" : "를";
}

/** 앞말의 받침에 따라 주격 조사를 고른다. */
function subjectParticle(word) {
  return hasFinalConsonant(word) ? "이" : "가";
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripWildcardEdges(text) {
  return text.trim().replace(/^~+/, "").replace(/~+$/, "");
}

/**
 * 규칙의 "쓰지 말 것" 문자열을 정규식으로 바꾼다.
 * 너무 짧아 위험한 규칙은 null을 돌려준다.
 *
 * @param {string} bad
 * @returns {RegExp|null}
 */
// 금칙어별 정규식을 기억한다. lint() 는 규칙 575개를 매번 훑으므로 기억하지 않으면
// 호출마다 정규식 575개를 새로 컴파일한다. 그것이 lint() 시간의 70퍼센트였다.
// 열쇠는 규칙 객체가 아니라 금칙어 문자열이다. 객체는 loadRules 마다 새로 만들어진다.
const patternCache = new Map();

export function toPattern(bad) {
  if (typeof bad !== "string") return null;
  if (patternCache.has(bad)) return patternCache.get(bad);
  const pattern = compilePattern(bad);
  patternCache.set(bad, pattern);
  return pattern;
}

function compilePattern(bad) {
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
 * 대체 표현이 조사로 시작하는지 본다.
 *
 * "~에 대한 처리를 진행" → "~를 처리" 같은 규칙이 그렇다. 이때는 매치 뒤가 아니라
 * 매치 **앞** 단어의 받침이 조사를 결정한다. "파일에 대한 처리를 진행"을 그대로 바꾸면
 * "파일를 처리"가 된다.
 *
 * @param {string} replacement
 * @returns {boolean}
 */
export function startsWithParticle(replacement) {
  return typeof replacement === "string" && PARTICLE_HEADS.has(replacement[0]);
}

/**
 * 쓸 것 칸이 앞말이 붙는다고 선언했는지 본다. 선두 물결표가 그 선언이다.
 *
 * 이 선언이 있을 때만 첫 글자를 조사로 본다. 없으면 "가변", "라이브락", "이벤트"처럼
 * 조사와 같은 음절로 시작하는 보통 낱말이다. 조사 여부는 글자가 아니라 위치의 성질이다.
 */
function declaresLeadingContext(good) {
  return typeof good === "string" && good.trimStart().startsWith(WILDCARD);
}

// 자동 교정에 쓸 수 없다는 신호. 파싱할 수 없는 메타 주석들이다.
const NOT_A_REPLACEMENT = /생략|또는|참조|문맥|\.{3}|…/;

// 주 표현을 뽑은 뒤에도 남아 있으면 안 되는 구두점.
const LEFTOVER_PUNCTUATION = /[(),/|]/;

/**
 * 쓸 것 칸에서 실제로 문장에 꽂을 표현 하나를 뽑는다.
 *
 * 칸의 문법은 `주 표현 [ (보충) ] [ / 대안 ] [ , 대안 ]` 이다. 사람에게는 칸 전체를
 * 보여 주는 편이 낫지만, 치환에는 표현 하나만 필요하다.
 *
 * @param {string} good
 * @returns {string}
 */
export function primaryGood(good) {
  if (typeof good !== "string") return "";

  // 괄호를 먼저 벗기고 나서 대안을 자른다. 순서를 뒤집으면 괄호 안의 쉼표에서 잘려
  // "백분위 (p95, p99)" 가 "백분위 (p95" 가 된다. 괄호가 반토막 난 채로 본문에 꽂힌다.
  const withoutNotes = stripWildcardEdges(good).replace(/\s*\([^)]*\)\s*/g, " ");
  return withoutNotes
    .split(/\s*[\/|,]\s*/)[0]
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 규칙을 자동 교정에 쓸 수 있으면 꽂을 표현을, 쓸 수 없으면 null 을 돌려준다.
 *
 * **이 판정을 applyFixes 안에서 강제한다. 규칙 표의 `검사` 칸을 믿지 않는다.**
 * rules/*.md 는 손으로 고치는 파일이라, 칸에 `치환`이라고 적혀 있어도 꽂을 수 없는
 * 값이면 문장이 망가진다. 안전 속성이 자료의 정확성에 실려 있으면 안 된다.
 *
 * @param {{bad?: string, good?: string}} rule
 * @returns {string|null}
 */
export function autoFixReplacement(rule) {
  const good = rule?.good;
  if (typeof good !== "string") return null;
  if (NOT_A_REPLACEMENT.test(good)) return null;
  // 금칙어 가운데에 물결표가 있으면 무엇을 남기고 무엇을 바꿀지 정할 수 없다.
  if (stripWildcardEdges(rule.bad ?? "").includes(WILDCARD)) return null;

  const replacement = primaryGood(good);
  if (replacement.length === 0) return null;
  if (replacement.includes(WILDCARD)) return null;
  // 뽑아낸 뒤에도 구두점이 남아 있으면 본문에 그대로 꽂을 수 없다. 마지막 방어선이다.
  if (LEFTOVER_PUNCTUATION.test(replacement)) return null;
  // 앞말이 붙는다고 선언했는데 조사로 시작하면 앞말의 받침을 알아야 한다. 규칙 표에는 없다.
  if (declaresLeadingContext(good) && startsWithParticle(replacement)) return null;
  return replacement;
}

/**
 * 치환해도 앞뒤 조사가 깨지지 않는지 확인한다.
 *
 * 조사는 양쪽에서 온다. 뒤에 붙는 경우와 대체 표현이 조사로 시작하는 경우를 모두 막아야 한다.
 *
 * - 뒤: "얇은 계약을"의 "얇은 계약"을 "낮은 결합도"로 바꾸면 "낮은 결합도을"이 된다.
 * - 앞: "파일에 대한 처리를 진행"을 "를 처리"로 바꾸면 "파일를 처리"가 된다.
 *
 * **판정과 설명을 한 함수에서 한다.** 따로 두면 두 곳이 어긋나고, 실제로 어긋났다.
 * 원인을 틀리게 알려 주면 고치는 사람이 엉뚱한 곳을 뒤진다.
 *
 * @param {string} bad
 * @param {string} good
 * @param {string} nextChar 매치 바로 뒤 글자
 * @param {string} [prevChar] 매치 바로 앞 글자
 * @returns {string|null} 위험하면 이유, 안전하면 null
 */
export function particleRisk(bad, good, nextChar, prevChar = "") {
  // 대체 표현이 조사로 시작하면 앞말의 받침에 맞아야 한다. 규칙 표에는 그 정보가 없으므로
  // 자동 교정을 포기한다. 앞이 한글이 아니면 조사가 걸릴 일이 없어 그대로 둔다.
  if (startsWithParticle(good) && hasFinalConsonant(prevChar) !== null) {
    return `바꿀 표현이 조사 "${good[0]}"로 시작해 앞말의 받침을 봐야 합니다`;
  }

  if (!nextChar || !PARTICLE_HEADS.has(nextChar)) return null;

  const before = hasFinalConsonant(bad);
  const after = hasFinalConsonant(good);
  if (before === null || after === null) {
    return `받침을 판정할 수 없어 뒤따르는 조사 "${nextChar}"${objectParticle(nextChar)} 지킬 수 없습니다`;
  }
  if (before !== after) {
    return `뒤따르는 조사 "${nextChar}"${subjectParticle(nextChar)} 깨집니다`;
  }
  return null;
}

/**
 * particleRisk 의 참/거짓 판.
 * @returns {boolean}
 */
export function isParticleSafe(bad, good, nextChar, prevChar = "") {
  return particleRisk(bad, good, nextChar, prevChar) === null;
}

/**
 * 규칙의 금칙어 안쪽에 물결표가 있는지 본다.
 *
 * "만약 ~라면, 그러면" 같은 문장 패턴 규칙은 앞뒤로 최대 20자까지 아무 내용이나 물고
 * 매치한다. 그 폭 안에 우연히 다른 규칙(예: "임시 저장소")이 들어 있어도 두 규칙은
 * 서로 다른 것을 지적하는 것이지 한쪽이 다른 쪽을 가리키는 게 아니다. 길이만 보고
 * 겹침을 해소하면 패턴 규칙이 항상 이겨서 그 안의 진짜 지적을 삼켜 버린다.
 *
 * @param {string} bad
 * @returns {boolean}
 */
function hasInteriorWildcard(bad) {
  return typeof bad === "string" && stripWildcardEdges(bad).includes(WILDCARD);
}

/**
 * 정렬된 배열에서 index가 target 이상인 첫 자리를 찾는다.
 * @param {object[]} sorted index 오름차순, 서로 겹치지 않음
 * @param {number} target
 * @returns {number}
 */
function lowerBound(sorted, target) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].index < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 겹치는 발견을 정리한다. 같은 구간을 두 규칙이 잡으면 더 긴 쪽만 남긴다.
 *
 * "루즈 커플링"과 "커플링"이 같은 문장에서 함께 잡히면, 짧은 "커플링"만 지적해서는
 * 독자가 "루즈"는 왜 안 걸리는지 헷갈린다. 긴 쪽이 뜻을 더 구체적으로 담고 있으므로
 * 긴 쪽을 남기고 그 구간에 포함된 짧은 것은 버린다.
 *
 * 물결표가 있는 문장 패턴 규칙은 이 해소에서 아예 빠진다. 항상 남고, 다른 발견을
 * 밀어내지도 않는다 — hasInteriorWildcard 의 설명을 보라.
 *
 * 길이 내림차순으로 훑으며 이미 받아들인 구간과 겹치면 버리는 탐욕법을 쓴다. 길이가 같으면
 * 앞쪽(index 오름차순)을 먼저 받아들인다. accepted를 index 오름차순으로 유지하면, 이미
 * 받아들인 구간끼리는 서로 겹치지 않으므로 새 후보가 겹칠 수 있는 상대는 삽입 지점의
 * 양옆 둘뿐이다 — 매번 accepted 전체를 훑지 않고 이진 탐색으로 그 둘만 본다.
 *
 * @param {object[]} findings index 순으로 정렬되어 있지 않아도 된다
 * @returns {object[]} index 오름차순
 */
function resolveOverlaps(findings) {
  const wildcard = [];
  const plain = [];
  for (const finding of findings) {
    (hasInteriorWildcard(finding.bad) ? wildcard : plain).push(finding);
  }

  const ordered = plain.sort((a, b) => b.length - a.length || a.index - b.index);
  const accepted = [];

  for (const finding of ordered) {
    const end = finding.index + finding.length;
    const pos = lowerBound(accepted, finding.index);
    const before = accepted[pos - 1];
    const after = accepted[pos];
    const overlapsBefore = before !== undefined && before.index + before.length > finding.index;
    const overlapsAfter = after !== undefined && after.index < end;
    if (!overlapsBefore && !overlapsAfter) accepted.splice(pos, 0, finding);
  }

  return [...accepted, ...wildcard].sort((a, b) => a.index - b.index);
}

/**
 * 규칙별 보고 개수 상한을 적용한다. 겹침을 해소한 **뒤**에 불러야 한다.
 * @param {object[]} findings index 오름차순
 * @returns {object[]}
 */
function capPerRule(findings) {
  const counts = new Map();
  const capped = [];
  for (const finding of findings) {
    const count = counts.get(finding.bad) ?? 0;
    if (count >= MAX_HITS_PER_RULE) continue;
    counts.set(finding.bad, count + 1);
    capped.push(finding);
  }
  return capped;
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
    while ((match = pattern.exec(masked)) !== null && hits < MAX_RAW_HITS_PER_RULE) {
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

  return capPerRule(resolveOverlaps(findings));
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

  // `검사` 칸이 치환인 것은 규칙을 쓴 사람의 의사 표시이고, 실제로 꽂을 수 있는지는
  // autoFixReplacement 가 따로 판정한다. 둘을 모두 만족해야 고친다.
  const candidates = lint(text, rules).filter((finding) => finding.check === CHECK_SUBSTITUTE);

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

    const replacement = autoFixReplacement(finding);
    if (replacement === null) {
      skipped.push({ ...finding, reason: "그대로 꽂을 수 있는 대체 표현이 아닙니다" });
      continue;
    }

    const nextChar = result[end] ?? "";
    const prevChar = result[finding.index - 1] ?? "";
    const risk = particleRisk(finding.matched, replacement, nextChar, prevChar);
    if (risk !== null) {
      skipped.push({ ...finding, reason: risk });
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
    // 쓸 것을 적힌 그대로 보여 준다. "~될", "~습니다"처럼 어미를 적는 물결표는
    // 한국어에서 자연스러운 표기이므로 지우면 오히려 읽기 어려워진다.
    lines.push(`- "${finding.matched}" → "${finding.good}"${reason}`);
  }

  return lines.join("\n");
}
