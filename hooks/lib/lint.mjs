// 규칙표를 정규식 검사로 바꿔 문장에 적용한다.
//
// 검사 대상은 maskProtected가 덮은 문자열이다. 제외 구간이 센티넬로 바뀌어 있으므로
// 코드나 경로 안에서는 애초에 매치가 일어나지 않는다. 위치 비교를 따로 할 필요가 없다.

import { maskProtected, isIgnoredFile } from "./segment.mjs";
import { particleHeads, RIEUL, OTHER_FINAL, NO_FINAL } from "./particle.mjs";
import { CHECK_SUBSTITUTE, SCANNABLE_CHECKS } from "./rules.mjs";
import { findLatinVerbHada } from "./latin-hada.mjs";

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
//
// 낱말 경계에 걸려 버려지는 매치는 이 수에 넣지 않는다. "디커플링 커패시터."를 50번
// 반복한 문서에서 진짜 "커플링이 높습니다."가 뒤에 와도, 경계에 막힌 50번이 이 상한을
// 먼저 채워 버리면 진짜 지적을 하나도 못 잡는다. 대신 정규식이 도는 횟수 자체는
// MAX_PATTERN_ITERATIONS 로 따로 막는다.
//
// 이 상한은 **보고**(lint()의 기본값) 전용이다. 자동 교정(applyFixes)은 문서에 실제로
// 있는 만큼 다 고쳐야 한다 — 이 상한을 그대로 쓰면 "2838건을 2835건만 고치고 고쳤다고
// 말하는" 불일치가 생긴다(실측, 0.14.13). applyFixes는 MAX_AUTOFIX_HITS_PER_RULE을
// 대신 쓴다.
const MAX_RAW_HITS_PER_RULE = 50;

// 경계에 막혀 버려지는 매치까지 포함한, 정규식이 한 규칙당 돌 수 있는 총 횟수의 상한.
// MAX_RAW_HITS_PER_RULE 보다 넉넉해야 "경계에 막힌 매치가 많은 문서"에서도 진짜 매치를
// 찾을 때까지 계속 돈다.
const MAX_PATTERN_ITERATIONS = 1000;

// 자동 교정 전용 상한. artifact.mjs의 MAX_AUTOFIX_CHARS(2,000,000자)가 이미 문서 크기를
// 막아 두므로, 그 문서 안에서 규칙 하나(최소 매치 길이 MIN_LITERAL_LENGTH=2)가 이론상
// 가질 수 있는 매치 수의 상한(100만)을 그대로 쓴다 — 실측한 실제 문서(2838건)보다
// 훨씬 여유 있게 잡아, 문서 크기 제한 안에서는 "일부만 고치고 다 고쳤다고 말하는" 일이
// 없다. 그래도 무한은 아니어야 병적인 입력에서 정규식이 무한히 돌지 않는다.
const MAX_AUTOFIX_HITS_PER_RULE = 1_000_000;
const MAX_AUTOFIX_PATTERN_ITERATIONS = 2_000_000;

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;
const JAMO_COUNT = 28;

// 완성형 음절과 낱자(자모) 모두 "한글이 이어진다"로 본다. 완성형만 보면 "ㄱ"으로 시작하는
// 드문 표기를 경계로 오판한다.
const HANGUL_CHAR = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;

function isHangulChar(ch) {
  return typeof ch === "string" && ch.length > 0 && HANGUL_CHAR.test(ch);
}

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

// "쓰지 말 것" 칸의 " / "는 사람에게는 "이 중 아무거나"로 읽히지만, 그동안은 한 칸을
// 통째로 리터럴로 컴파일해 "A / B"라는 문자열 그대로만 찾았다 — 즉 절대 매치되지 않았다.
// 대안마다 따로 정규식을 만들어 교대(|)로 묶어야 실제로 A도, B도 잡는다.
const ALTERNATIVE_SEPARATOR = " / ";

// bad 문자열 하나를 대안 목록으로 쪼갠다. 대안이 하나뿐이면 그 하나만 담은 배열이다.
// compilePattern(매치용)과 boundaryRequirement(경계 판정용)·autoFixReplacement(자동
// 교정 금지 판정용)가 모두 같은 쪼갬을 써야 한다. 따로 쪼개면 셋이 어긋난다.
const alternativeCache = new Map();
export function alternativesOf(bad) {
  if (typeof bad !== "string") return [];
  if (alternativeCache.has(bad)) return alternativeCache.get(bad);
  const core = stripWildcardEdges(bad);
  const alts = core.length === 0 ? [] : core.split(ALTERNATIVE_SEPARATOR).map((alt) => alt.trim()).filter(Boolean);
  const result = alts.length > 0 ? alts : core.length > 0 ? [core] : [];
  alternativeCache.set(bad, result);
  return result;
}

function compilePattern(bad) {
  const alternatives = alternativesOf(bad);
  if (alternatives.length === 0) return null;

  const sources = [];
  for (const alt of alternatives) {
    const parts = alt.split(WILDCARD);
    const literalLength = parts.join("").replace(/\s+/g, "").length;
    if (literalLength < MIN_LITERAL_LENGTH) continue;
    sources.push(parts.map(escapeRegExp).join(WILDCARD_PATTERN));
  }
  if (sources.length === 0) return null;

  const source = sources.length === 1 ? sources[0] : `(?:${sources.join("|")})`;
  try {
    return new RegExp(source, "g");
  } catch {
    return null;
  }
}

/**
 * 매치된 문자열이 대안 중 어느 것인지 찾는다. 경계 판정(boundaryRequirement)이
 * 대안마다 달라야 하기 때문이다 — "물결 효과"(명사)와 "파문이 퍼집니다"(절)가 한
 * 규칙 안에 있으면 오른쪽 경계 요구가 서로 다르다.
 *
 * @param {string} bad
 * @param {string} matchedText
 * @returns {string} 못 찾으면 첫 대안(호출부의 안전한 기본값)
 */
function matchedAlternative(bad, matchedText) {
  const alts = alternativesOf(bad);
  if (alts.length <= 1) return alts[0] ?? "";
  for (const alt of alts) {
    const parts = alt.split(WILDCARD);
    const source = `^(?:${parts.map(escapeRegExp).join(WILDCARD_PATTERN)})$`;
    try {
      if (new RegExp(source).test(matchedText)) return alt;
    } catch {
      continue;
    }
  }
  return alts[0];
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

// 한글 음절 코드에서 종성(받침) 색인. 8이 ㄹ이다 — (코드 - 0xAC00) % 28 의 나머지가
// 그대로 국립국어원 종성 순서(ㄱㄲㄳㄴㄵㄶㄷㄹ…)의 색인이다.
const RIEUL_FINAL_INDEX = 8;

/**
 * 마지막 한글 음절의 받침을 받침 없음/ㄹ/그 밖 셋으로 가른다. 판정할 수 없으면 null.
 *
 * 으로/로 조사만 받침 유무 두 가지로 못 가른다 — ㄹ 받침 뒤에도 "로"를 쓴다(일로,
 * 책임으로가 아니라 "책임으로"는 ㅁ받침이라 "으로"가 맞고, "일로"는 ㄹ받침이라 "로"가
 * 맞다). particle.mjs 의 RIEUL/OTHER_FINAL/NO_FINAL 과 값을 맞춰, 영어 낱말(particle.mjs)과
 * 한글 낱말(여기) 두 판정기가 같은 세 값을 쓰게 한다.
 *
 * @param {string} text
 * @returns {""|"ㄹ"|"other"|null}
 */
export function finalConsonantClass(text) {
  if (typeof text !== "string") return null;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const code = text.charCodeAt(i);
    if (code >= HANGUL_START && code <= HANGUL_END) {
      const finalIndex = (code - HANGUL_START) % JAMO_COUNT;
      if (finalIndex === 0) return NO_FINAL;
      if (finalIndex === RIEUL_FINAL_INDEX) return RIEUL;
      return OTHER_FINAL;
    }
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
  // 대안이 둘 이상이면 매치된 대안에 따라 꽂을 말도 달라져야 하는데, 치환 하나로는
  // 그 대응을 표현할 수 없다("표층 복사"에 "깊은 복사"를 꽂는 식의 오배정이 실제로
  // 있었다). 자료가 대안마다 행을 나누지 않는 한 자동 교정은 하지 않는다.
  if (alternativesOf(rule.bad).length > 1) return null;

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

  // 으로/로는 받침 유무만으로 못 가른다 — ㄹ받침은 받침 없음과 같은 무리로 "로"를 쓴다
  // ("일로", "나무로"는 되지만 "책임으로"는 다른 받침이라 "으로"다). bad와 good을 서로
  // 비교하지 않는다 — bad(원문의 낱말)와 실제로 문장에 쓰인 조사가 이미 어긋나 있을 수
  // 있어서다("코드 포함률으로"는 원문부터 틀렸다. 포함률은 ㄹ받침이라 "포함률로"가 맞다).
  // bad 기준으로 "같은 무리인가"만 보면 이런 원문 오류가 그대로 good에 옮겨 붙는다
  // ("커버리지으로"). 대신 실제로 뒤에 온 조사(nextChar)가 요구하는 받침과 good이
  // 맞는지 직접 본다 — "으"가 왔으면 good은 ㄹ이 아닌 받침이 있어야 하고, "로"만
  // 왔으면(으 없이) good은 받침이 없거나 ㄹ받침이어야 한다.
  if (nextChar === "로" || nextChar === "으") {
    const after = finalConsonantClass(good);
    if (after === null) {
      return `받침을 판정할 수 없어 뒤따르는 로/으로 조사를 지킬 수 없습니다`;
    }
    const requiresOtherFinal = nextChar === "으";
    if (requiresOtherFinal !== (after === OTHER_FINAL)) {
      return `뒤따르는 로/으로 조사가 깨집니다`;
    }
    return null;
  }

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
 * 낱말 경계 판정.
 *
 * "쓰지 말 것"이 다른 낱말 속에 우연히 들어 있으면 안 된다. "디커플링"의 "커플링",
 * "뒷문장"의 "뒷문"이 그런 오탐이다. 판정은 두 방향이다.
 *
 * - 왼쪽: 금칙어가 한글 음절로 시작하면, 매치 바로 앞이 한글이면 다른 낱말 속이다.
 *   앞에 물결표를 선언한 규칙("~에 대한 ~를 진행")은 애초에 앞을 아무거나 물겠다고
 *   선언한 것이므로 이 검사에서 뺀다. 표기·띄어쓰기 규칙(isOrthographyRule)도 뺀다 —
 *   "수정해야합니다"의 "해야합니다"처럼 앞말이 무엇이든 띄어쓰기·맞춤법 자체가 틀렸다.
 * - 오른쪽: 금칙어가 한글 음절로 끝나면, 뒤에 한글이 이어질 때 그것이 이 낱말에 자연스럽게
 *   붙는 조사·계사·어미·접미사(FOLLOWER_TOKENS)인지 본다. 아니면 "뒷문"+"장"처럼 다른
 *   낱말 속이다. 길이로 검사 여부를 가르지 않는다 — "커플링"(3음절)처럼 긴 낱말로 끝나는
 *   규칙만 통째로 빼면 "기록부"+"터"("이 기록부터 봅시다")처럼 진짜 오탐도 함께 빠진다.
 *   대신 FOLLOWER_TOKENS 를 넉넉히 채워 "커플링시켜"·"디펜던시가" 같은 실제 활용·파생은
 *   목록으로 받는다. 표기 규칙도 오른쪽 검사에서 빼지 않는다 — "어떻게 할 지"가 "지침"
 *   속까지 파고들면 안 된다(불변식 4). "궁굼한데"처럼 정당한 활용은 FOLLOWER_TOKENS 의
 *   "데"가 받는다. 예외는 외래어 표기 규칙(isLoanwordSpellingRule)뿐이다 —
 *   "메세지"+"큐"처럼 뒤에 오는 것이 조사가 아니라 또 다른 외래어라 목록으로 셀 수 없다.
 *
 *   단, "계약이 얇"(→"결합도가 낮")처럼 목적어·주어 뒤에 용언 어간만 남긴 규칙은 뒤에
 *   습니다·다·아서 같은 활용형이 무한히 올 수 있어 이 목록으로 다 덮을 수 없다.
 *   "하/되/시키"로 끝나는 규칙(픽스하다 류)과 절 조각(endsInsideClauseFragment)이 그
 *   경우이고, 오른쪽 검사를 하지 않는다 — 규칙을 쓴 사람이 이미 어간만 남겨 활용을
 *   받아들이겠다고 표시한 것으로 본다.
 */

// 명사 뒤에 자연스럽게 붙는 조사·계사·어미·접미사. 긴 것이 짧은 것의 접두라도 순서는
// 상관없다 — 어느 하나라도 시작에 걸리면 통과다(대체가 아니라 존재 확인).
//
// 자/서/용/다/지/니 같은 한 글자는 일부러 뺐다. "제출자를"(자)·"제출서류"(서)·
// "제출용"(용)·"통나무다리"(다)·"칸막이벽지"(지)·"니즈니"(니)처럼 실제로 다른 낱말의
// 시작과 겹쳐 오탐을 냈다. 그 대가로 놓치는 활용형(예: "짓다")은 endsWithVerbStem·
// endsInsideClauseFragment 가 이미 검사 자체를 꺼서 따로 받는다. "적"은 통째로 빼지
// 않고 allowJeok 로 따로 다룬다(아래 JEOK_ALLOWED_MIN_SYLLABLES 참고) — 한자어 3음절
// 이상 뒤의 "-적"(효과적, 기술적)은 흔한 파생이라 무작정 빼면 손해가 더 크다.
const FOLLOWER_TOKENS = [
  // 조사
  "이에요", "예요", "입니다", "입니까", "이나마", "이었", "이랑", "까지", "부터", "처럼",
  "이나", "이며", "이라", "이면", "이", "가", "을", "를", "은", "는", "의", "에서", "에게",
  "께", "에", "으로", "로", "와", "과", "랑", "도", "만", "보다", "나", "요", "였", "여",
  "며", "라", "란", "냐", "인", "면", "들", "뿐", "마다", "밖에", "조차", "마저", "쯤",
  "대로", "끼리", "씩", "엔", "치고", "고", "야", "므로", "거나", "일", "임", "없이", "님",
  "데",
  // 명사에 붙는 접미사·파생. "됩"은 됩니다를 한 글자로 묶는다. "시키/시켜/시켰/시킨/시킬"은
  // 통째로 적는다 — 한 글자 "시"만 받으면 "일시"("맡은 일시 중단")까지 걸린다.
  "하", "해", "했", "한", "할", "함", "합",
  "되", "된", "될", "됨", "돼", "됐", "됩",
  "시키", "시켜", "시켰", "시킨", "시킬", "받", "상", "화", "형", "별", "중", "성", "감",
  "력", "률", "율",
  // 용언 활용형의 흔한 시작 — "계약이 얇"처럼 어간만 남긴 규칙이 습니다/았다 따위로
  // 이어질 때를 받아 준다. 어간 자체가 뒤에 뭐가 오는지 목록으로 다 셀 수 없으니
  // 여기서는 "다른 낱말 속이 아니다"만 넉넉하게 인정한다.
  "습", "았", "었", "겠", "으", "게", "죠", "네", "든", "려",
];
const FOLLOWER_PATTERN = new RegExp(
  `^(?:${[...FOLLOWER_TOKENS].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`
);
const JEOK_PATTERN = /^적/;

// 마지막 낱말이 한자어·외래어 명사로 세 음절 이상일 때만 "-적"을 받는다. "효과적"·
// "기술적"류의 흔한 파생은 살리되, "접속면적"·"연결면적"처럼 "면적"이 우연히 뒤에
// 붙어 다른 낱말(넓이)이 되는 자리는 명시적으로 막는다 — 세 음절 조건만으로는
// 이 둘을 가를 수 없어서다.
const JEOK_ALLOWED_MIN_SYLLABLES = 3;
const JEOK_DENYLIST = new Set(["접속면", "연결면"]);

// "로"·"으로"는 FOLLOWER_TOKENS에도 있지만(진짜 조사), 뒤에 바로 다른 음절이 이어지면
// "로그"·"로직"·"로더"·"로컬"·"로드"처럼 다른 낱말의 시작일 수 있다 — "판박이 코드로그를"이
// 실제로 "판박이 코드"+"로그를"로 오판됐다. FOLLOWER_PATTERN은 접두만 보므로 이 둘을
// 못 가른다. "로"/"으로" 뒤가 한글이 아니거나(문장 끝) 흔히 그 뒤에 오는 조사
// 연속(는/도/만/서/써/부터/…)일 때만 진짜 조사로 인정한다. 일반화한 연쇄 판정은 하지
// 않는다 — "하"+"니다"처럼 다른 어간·어미 조합까지 건드리면 손해가 더 크다.
const RO_TOKEN = /^(?:으로|로)/;
const RO_CONTINUATION_TOKENS = [
  "는", "도", "만", "서", "써", "부터", "의", "까지", "라도", "라면", "나", "요", "선", "은",
  "야", "밖에", "조차", "마저", "든", "인", "다가",
];
const RO_CONTINUATION_PATTERN = new RegExp(
  `^(?:${[...RO_CONTINUATION_TOKENS].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`
);

function isAllowedFollower(rest, allowJeok) {
  if (rest.length === 0) return true;
  if (!isHangulChar(rest[0])) return true;

  const ro = RO_TOKEN.exec(rest);
  if (ro) {
    const after = rest.slice(ro[0].length);
    if (after.length === 0 || !isHangulChar(after[0]) || RO_CONTINUATION_PATTERN.test(after)) return true;
    // "로"/"으로"는 여기서 조사로 인정할 수 없다. FOLLOWER_TOKENS 안에 "로"로 시작하는
    // 다른 토큰은 없으므로(적 판정 제외) 일반 검사로 넘겨도 결과는 같다 — 명시적으로 끊는다.
    return allowJeok && JEOK_PATTERN.test(rest);
  }

  if (FOLLOWER_PATTERN.test(rest)) return true;
  return allowJeok && JEOK_PATTERN.test(rest);
}

// 어간으로 끝나는 규칙("픽스하", "계약이 얇"처럼 다다르지 못한 서술어)은 활용형이 무한해
// 오른쪽 경계를 문자열로 셀 수 없다. 동사·형용사·"하다" 파생을 만드는 흔한 어미 앞
// 음절만 신호로 삼는다 — 정밀한 품사 판정이 아니라, 오른쪽 경계 검사를 하지 않아도
// 안전하다는 표시다.
const VERB_STEM_SUFFIXES = ["시키", "하", "되"];
function endsWithVerbStem(core) {
  return VERB_STEM_SUFFIXES.some((stem) => core.endsWith(stem));
}

// "계약이 얇", "싱크를 맞"처럼 여러 낱말로 된 규칙은 끝 낱말 하나만으로 어간인지 알 수
// 없다. 대신 그 앞 낱말이 이/가/을/를로 끝나는지, 마지막 낱말이 -게로 끝나는 부사형인지
// 본다("얇게 만들"의 "만들"도 뒤에 어/고/기 따위가 무한히 붙는다) — 그러면 마지막 낱말은
// 서술어이고, 서술어는 어미가 무한히 붙을 수 있어 문자열로는 오른쪽 경계를 셀 수 없다.
// 은/는은 빼 둔다 — "맡은"처럼 관형형 어미 "-은"과 글자가 같아 주제 조사인지 구별할 수
// 없다(불변식 5).
const CLAUSE_PREDICATE_MARKER = /[을를이가게]$/;

// CLAUSE_PREDICATE_MARKER는 글자만 보므로 "허가"(허락하다)·"판박이"·"욕심쟁이"·"눈송이"·
// "알갱이"처럼 낱말 전체가 우연히 이/가로 끝나는 명사를 "낱말+조사"로 오판한다 —
// "허가 내주기"가 "허가 내주기표를"까지 삼킨 것이 실제 사례다(0.14.11). 형태소
// 분석 없이는 일반화할 수 없으니, 실제로 오탐이 확인된 낱말만 JEOK_DENYLIST와 같은
// 방식으로 막는다.
const CLAUSE_MARKER_DENYLIST = new Set(["허가", "판박이", "욕심쟁이", "눈송이", "알갱이"]);
function endsInsideClauseFragment(core) {
  const words = core.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  const marker = words[words.length - 2];
  if (CLAUSE_MARKER_DENYLIST.has(marker)) return false;
  return CLAUSE_PREDICATE_MARKER.test(marker);
}

// 규칙의 마지막 낱말과 그 한글 음절 수. allowJeok 판정에 쓴다.
function finalWord(core) {
  const words = core.split(/\s+/).filter(Boolean);
  return words[words.length - 1] ?? "";
}
function hangulSyllableCount(word) {
  return [...word].filter((ch) => ch >= "가" && ch <= "힣").length;
}

// 표기·띄어쓰기·맞춤법 규칙은 왼쪽 경계를 보지 않는다. "해야합니다"(→"해야 합니다")는
// 앞에 어떤 동사가 오든 붙여 쓴 것 자체가 틀렸고, "데이타"(→"데이터")는 "메타데이타"처럼
// 다른 낱말에 붙어 있어도 표기가 틀린 건 마찬가지다 — 오탐의 성격이 다른 규칙과 다르다.
//
// rules.mjs 의 parseTable 이 이유 칸 맨 앞 [표기]/[외래어] 표지를 읽어 rule.kind 로 넘겨준다.
// 예전에는 이유 문장 낱말(표기·맞춤법·띄어 …)을 정규식으로 매칭했는데, 이유를 다듬어
// 적다 보니 매칭 낱말이 우연히 빠지거나 들어가 판정이 조용히 바뀌었다. 0.13.19에서 실제로
// 그랬다 — 레지스터리는 이유에서 "외래어"라는 말이 빠져 왼쪽·오른쪽 경계 판정을 둘 다
// 잃었고, "50 %"는 반대로 새 이유에 "붙여도 띄어도 된다"는 "띄어"가 우연히 들어가 없던
// 왼쪽 경계 예외를 얻었다(첫 글자가 숫자라 동작은 그대로였다). 판정은 표지 하나로만 하고, 이유 문장은 사람이 읽기 좋게
// 자유로 고친다. 파일 위치(source)는 더 안 본다 — 표지 자체가 이미 명시적이라 register.md
// 로 한정할 이유가 없고, 한정하면 다른 규칙 파일에 표지를 적어도 조용히 무시되는 두 번째
// 함정이 생긴다.
function isOrthographyRule(rule) {
  return rule?.kind === "orthography" || rule?.kind === "loanword";
}

// 오른쪽 경계는 원칙대로 본다 — "어떻게 할 지"(띄어쓰기 규칙)를 오른쪽까지 빼면
// "어떻게 할 지침이"의 "지침"까지 "할지침이"로 잘못 고친다. 표기가 틀렸다는 사실이 뒤에
// 다른 낱말이 와도 된다는 뜻은 아니다.
//
// 예외는 [외래어] 표지가 붙은 규칙뿐이다. "메세지"+"큐", "데이타"+"베이스", "쓰레드"+"풀"
// 처럼 한국어 개발 현장은 외래어 명사 둘을 조사 없이 그대로 붙여 쓴다 — 뒤에 오는 것도
// 한글 조사가 아니라 또 다른 외래어라서 FOLLOWER_TOKENS 로는 절대 다 셀 수 없다. 이
// 부류만 오른쪽도 뺀다. "어떻게 할 지"·"하는것"·"궁굼한" 같은 [표기] 규칙은
// 뒤에 오는 것이 보통 조사·어미라 FOLLOWER_TOKENS 로 이미 받는다 — 그쪽은 오른쪽
// 검사를 켜 둬도 손해가 없다.
function isLoanwordSpellingRule(rule) {
  return rule?.kind === "loanword";
}

// 숫자로 시작하는 규칙의 왼쪽 경계 판정에 쓴다. 선행 숫자만 뽑는다.
function leadingDigits(text) {
  const match = /^[0-9]+/.exec(typeof text === "string" ? text.trim() : "");
  return match ? match[0] : null;
}

// bad 문자열이 아니라 규칙 객체를 열쇠로 쓴다. why·source 도 판정에 들어가기 때문이다.
// 규칙 배열은 loadRules 가 한 번 읽어 재사용하므로, 같은 규칙 객체는 호출마다 같다.
//
// 대안(" / ")마다 요구가 다를 수 있어 rule 하나에 대안별 결과를 담은 Map을 매단다.
// "물결 효과 / 파문이 퍼집니다"처럼 명사와 절이 한 규칙에 섞이면, 절 쪽은 어미가 무한히
// 붙어 오른쪽 경계를 셀 수 없지만 명사 쪽은 셀 수 있다 — 규칙 전체가 아니라 실제로
// 매치된 대안 기준으로 판정해야 한다.
const boundaryCache = new WeakMap();

function boundaryRequirement(rule, alt) {
  let perRule = boundaryCache.get(rule);
  if (perRule === undefined) {
    perRule = new Map();
    boundaryCache.set(rule, perRule);
  }
  if (perRule.has(alt)) return perRule.get(alt);

  const bad = rule.bad;
  const alts = alternativesOf(bad);
  const isFirstAlt = alts[0] === alt;
  const isLastAlt = alts[alts.length - 1] === alt;
  const leadsWithWildcard = typeof bad === "string" && bad.trim().startsWith(WILDCARD) && isFirstAlt;
  const trailsWithWildcard = typeof bad === "string" && bad.trim().endsWith(WILDCARD) && isLastAlt;
  const orthography = isOrthographyRule(rule);
  const last = finalWord(alt);
  // 숫자로 시작하는 규칙("3개의 파일")은 한글 왼쪽 경계가 없어 위 left가 항상 꺼진다.
  // 그대로 두면 "13개의 파일"의 "3개의 파일"처럼 더 긴 숫자 속에서도 매치한다 — 이건 막아야
  // 한다. 하지만 "50 %"→"50%", "30퍼센트"→"30%"처럼 쓸 것도 같은 자리 숫자로 시작하는
  // 규칙은 반대다: "150 %"의 "50 %"를 그대로 잡아 "150%"를 만드는 것이 의도한 동작이다
  // (앞자리 숫자 "1"은 그대로 남고 뒷부분만 바뀐다). 두 경우를 가르는 신호는 쓸 것이 같은
  // 숫자로 시작하는지다 — 치환 규칙은 이미 corpus.test.mjs 골든 시험이 "숫자로 시작하면
  // 쓸 것도 같은 숫자로 시작한다"를 강제하므로, 그 규칙들은 이 조건에서 항상 leftDigit이
  // 꺼진다. 숫자 자체가 바뀌거나 사라지는 규칙("3개의 파일"→"파일 3개")만 leftDigit을 켠다.
  const badDigits = leadingDigits(alt);
  const goodDigits = leadingDigits(primaryGood(rule.good));
  const requirement = {
    left: !orthography && !leadsWithWildcard && isHangulChar(alt[0]),
    leftDigit: !leadsWithWildcard && badDigits !== null && badDigits !== goodDigits,
    right:
      !isLoanwordSpellingRule(rule) &&
      !trailsWithWildcard &&
      !endsWithVerbStem(alt) &&
      !endsInsideClauseFragment(alt) &&
      isHangulChar(alt[alt.length - 1]),
    allowJeok: hangulSyllableCount(last) >= JEOK_ALLOWED_MIN_SYLLABLES && !JEOK_DENYLIST.has(last),
  };
  perRule.set(alt, requirement);
  return requirement;
}

/**
 * 매치가 낱말 경계에서 일어났는지 본다. masked 는 lint() 가 이미 만든 문자열이라
 * 그대로 받는다 — 다시 만들면 그만큼 비용이다.
 *
 * @param {object} rule
 * @param {string} masked
 * @param {number} index
 * @param {number} length
 * @returns {boolean}
 */
function isWordBoundaryMatch(rule, masked, index, length) {
  const matchedText = masked.slice(index, index + length);
  const alt = matchedAlternative(rule.bad, matchedText);
  const { left, leftDigit, right, allowJeok } = boundaryRequirement(rule, alt);
  if (left && isHangulChar(masked[index - 1] ?? "")) return false;
  if (leftDigit && /[0-9.]/.test(masked[index - 1] ?? "")) return false;
  if (right && !isAllowedFollower(masked.slice(index + length), allowJeok)) return false;
  return true;
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

  // 흔한 경우(실제로 겹치는 발견이 하나도 없음)는 훑기 한 번으로 끝낸다. 아래의
  // 길이 내림차순 삽입은 규칙마다 서로 다른 길이가 뒤섞여 끼어드는 자리가 흩어지면
  // splice 가 매번 배열 중간을 옮겨 이차 비용이 된다(실측: 서로 다른 두 규칙이
  // 30만 건 뒤섞인 문서에서 3.5초). 대부분의 문서는 애초에 겹치는 발견이 없으므로
  // — "루즈 커플링"처럼 한 규칙이 다른 규칙 안에 포함되는 경우만 예외다 — index
  // 오름차순으로 정렬한 뒤 인접한 것끼리만 겹치는지 한 번 보고, 안 겹치면 그대로 돌려준다.
  const byIndex = [...plain].sort((a, b) => a.index - b.index);
  let hasOverlap = false;
  for (let i = 1; i < byIndex.length; i += 1) {
    if (byIndex[i - 1].index + byIndex[i - 1].length > byIndex[i].index) {
      hasOverlap = true;
      break;
    }
  }
  if (!hasOverlap) {
    return [...byIndex, ...wildcard].sort((a, b) => a.index - b.index);
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
 * @param {string} [ext] 문서 확장자(점 없이, 소문자). 블록형 가리개(들여쓰기 코드, rST, AsciiDoc)의
 *   범위를 정한다. 커밋 메시지처럼 확장자가 없는 대상은 일반 가리개만 적용된다.
 * @param {Set<string>|null} [extraDefs] maskProtected에 그대로 전달한다. Edit/MultiEdit
 *   조각 밖의 참조식 링크 정의 라벨.
 * @param {{capReporting?: boolean, maxHitsPerRule?: number, maxIterations?: number, latinHada?: boolean}} [options]
 *   capReporting을 false로 주면 규칙당 보고 상한(MAX_HITS_PER_RULE)을 적용하지 않는다.
 *   applyFixes가 문서에 실제로 있는 매치를 전부 고쳐야 할 때 쓴다 — 원시 매치·반복 상한도
 *   함께 넉넉히 올려야 그만큼 찾힌다(maxHitsPerRule/maxIterations). latinHada를 false로
 *   주면 findLatinVerbHada를 건너뛴다 — import-corpus.mjs·corpus.test.mjs처럼 규칙
 *   하나만 담은 임시 배열로 "규칙 자신을 다시 잡는지"만 볼 때, latin-hada가 그 결과에
 *   섞여 들어오면 안 되기 때문이다(전체 규칙 집합을 검사하는 게 아니다).
 * @returns {object[]}
 */
export function lint(text, rules, ext, extraDefs, options = {}) {
  const {
    capReporting = true,
    maxHitsPerRule = MAX_RAW_HITS_PER_RULE,
    maxIterations = MAX_PATTERN_ITERATIONS,
    latinHada = true,
  } = options;

  if (typeof text !== "string" || text.length === 0) return [];
  if (!Array.isArray(rules)) return [];
  if (isIgnoredFile(text)) return [];

  // 한글은 NFC(완성형)와 NFD(자모 분해형) 두 가지로 인코딩될 수 있다. macOS 파일시스템이
  // 만든 텍스트는 NFD로 온다. 규칙표의 리터럴은 전부 NFC로 적혀 있어서, NFD 그대로
  // 매치하면 하나도 안 잡힌다. 정규화한 사본으로 찾아야 두 형태 모두에서 같은 결과가
  // 나온다. text가 이미 NFC면 normalized === text라 아래 로직에 변화가 없다.
  const normalized = text.normalize("NFC");
  const masked = maskProtected(normalized, ext, extraDefs);
  const findings = [];

  for (const rule of rules) {
    if (!SCANNABLE_CHECKS.includes(rule.check)) continue;

    const pattern = toPattern(rule.bad);
    if (pattern === null) continue;

    pattern.lastIndex = 0;
    let hits = 0;
    let iterations = 0;
    let match;
    while (
      hits < maxHitsPerRule &&
      iterations < maxIterations &&
      (match = pattern.exec(masked)) !== null
    ) {
      iterations += 1;
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      if (!isWordBoundaryMatch(rule, masked, match.index, match[0].length)) continue;
      hits += 1;
      findings.push({
        bad: rule.bad,
        good: rule.good,
        why: rule.why,
        check: rule.check,
        index: match.index,
        length: match[0].length,
        matched: normalized.slice(match.index, match.index + match[0].length),
        priority: rule.priority,
        source: rule.source,
      });
    }
  }

  // resolveOverlaps는 규칙끼리만 겹침을 다툰다. latin-hada는 규칙표로 표현할 수 없는
  // 별개의 검사라(latin-hada.mjs 상단 설명 참고) 규칙과 span이 겹쳐도 어느 한쪽이 다른
  // 쪽을 밀어내면 안 된다 — "build할때"에서 latin-hada가 "build할"을 잡았다고 "할때"→
  // "할 때" 치환 규칙까지 지워지면, 그 규칙이 원래 했던 자동 교정(applyFixes는 lint()의
  // findings를 그대로 후보로 쓴다)까지 함께 사라진다(실측, 0.16.0). latin-hada는 절대
  // 자동 교정하지 않으므로(check가 늘 정규식이다) 겹침은 표시상의 문제일 뿐이고, 둘 다
  // 보여 줘도 읽는 사람이 헷갈리지 않는다 — 그래서 규칙 겹침을 먼저 해소한 뒤에 latin-hada
  // 발견을 그대로 이어 붙인다.
  const resolved = resolveOverlaps(findings);
  const combined = latinHada
    ? [...resolved, ...findLatinVerbHada(masked, normalized)].sort((a, b) => a.index - b.index)
    : resolved;
  return capReporting ? capPerRule(combined) : combined;
}

/**
 * 치환 규칙만 실제로 고쳐 쓴다. 자동 교정은 기본으로 꺼져 있고 호출하는 쪽이 켠다.
 *
 * @param {string} text
 * @param {object[]} rules
 * @param {string} [ext] lint() 에 그대로 전달한다.
 * @param {Set<string>|null} [extraDefs] lint() 에 그대로 전달한다.
 * @returns {{text: string, applied: object[], skipped: object[]}}
 */
export function applyFixes(text, rules, ext, extraDefs) {
  const applied = [];
  const skipped = [];

  if (typeof text !== "string" || text.length === 0) {
    return { text: typeof text === "string" ? text : "", applied, skipped };
  }

  // `검사` 칸이 치환인 것은 규칙을 쓴 사람의 의사 표시이고, 실제로 꽂을 수 있는지는
  // autoFixReplacement 가 따로 판정한다. 둘을 모두 만족해야 고친다.
  //
  // lint()의 기본 상한(규칙당 3건 보고)을 그대로 쓰지 않는다 — 자동 교정은 문서에 실제로
  // 있는 만큼 다 고쳐야 한다. 그대로 쓰면 "2838건을 2835건만 고치고 고쳤다고 말하는"
  // 불일치가 생긴다(실측, 0.14.13). capReporting: false로 규칙당 보고 상한을 끄고,
  // 원시 매치·반복 상한도 자동 교정 전용 값으로 넉넉히 올린다.
  const candidates = lint(text, rules, ext, extraDefs, {
    capReporting: false,
    maxHitsPerRule: MAX_AUTOFIX_HITS_PER_RULE,
    maxIterations: MAX_AUTOFIX_PATTERN_ITERATIONS,
  }).filter((finding) => finding.check === CHECK_SUBSTITUTE);

  // lint() 는 매치를 NFC로 정규화한 사본에서 찾으므로, 찾은 index는 그 사본 기준이다.
  // text가 이미 NFC면 사본과 원본이 같아 인덱스가 그대로 맞는다. NFD로 들어온 텍스트를
  // 그 인덱스로 그대로 잘라 쓰면 엉뚱한 자리를 자르거나, 고치지 않은 나머지 글자까지
  // 통째로 NFC로 재정규화되어 버린다 — 사용자가 바꾸지 않은 글자까지 조용히 바뀐다.
  // 그래서 NFD 입력은 경고만 하고 고치지 않는다.
  if (text.normalize("NFC") !== text) {
    return {
      text,
      applied,
      skipped: candidates.map((finding) => ({
        ...finding,
        reason: "NFC로 정규화되지 않은 입력이라 자동 교정하지 않습니다",
      })),
    };
  }

  // 겹침은 이미 lint() 안의 resolveOverlaps 가 해소했다 — 물결표가 있는 문장 패턴
  // 규칙만 그 해소에서 빠지는데, 그 규칙들은 bad 안에 물결표가 있어 autoFixReplacement 가
  // 항상 null 을 돌려주므로 애초에 갈아 끼우지 않는다. 그래서 candidates 끼리 겹칠 일이
  // 없고, index 오름차순으로 이미 정렬되어 있다(lint()의 resolveOverlaps가 그렇게 돌려준다).
  //
  // 조사 위험 판정(particleRisk)은 뒤(오른쪽)부터 해야 한다. 두 매치가 맞닿아 있으면
  // ("계약이 얇 계약이 얇다"처럼) 왼쪽 매치의 nextChar가 오른쪽 매치를 실제로 고칠지
  // 여부에 달려 있는데, 그 답은 오른쪽부터 판정해야 먼저 나온다. 다만 예전처럼 판정마다
  // 전체 문자열을 자르고 이으면 매치 수 × 문서 길이에 비례해 느려진다(실측: fixParticles의
  // 같은 문제로 1.2MB 문서에서 10초 넘게 걸렸다, 0.14.13). 그래서 판정은 오른쪽부터 하되
  // 결과만 기록하고, 문자열 조립은 왼쪽에서 오른쪽으로 한 번만 훑는다.
  const outcomes = new Array(candidates.length);

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const finding = candidates[i];
    const end = finding.index + finding.length;
    const replacement = autoFixReplacement(finding);
    if (replacement === null) {
      skipped.push({ ...finding, reason: "그대로 꽂을 수 있는 대체 표현이 아닙니다" });
      continue;
    }

    // 바로 다음 매치가 이 매치에 맞닿아 있으면(둘 사이에 원문이 없으면) 그 매치가 실제로
    // 적용됐는지에 따라 nextChar가 달라진다. 적용됐으면 그 교정 결과의 첫 글자, 건너뛰었거나
    // 안 맞닿았으면 원문 그대로다 — 어느 쪽이든 이 자리는 다른 매치가 손대지 않았으므로
    // 원문에서 그대로 읽어도 안전하다.
    const next = candidates[i + 1];
    const nextOutcome = i + 1 < outcomes.length ? outcomes[i + 1] : undefined;
    const nextChar = next && next.index === end && nextOutcome ? nextOutcome.replacement[0] ?? "" : text[end] ?? "";
    // prevChar는 항상 아직 판정하지 않은 왼쪽 매치 앞이라 원문 그대로다(오른쪽부터
    // 판정하므로 왼쪽은 아직 안 바뀐 것으로 본다 — 예전 구현도 같은 순서였다).
    const prevChar = text[finding.index - 1] ?? "";
    const risk = particleRisk(finding.matched, replacement, nextChar, prevChar);
    if (risk !== null) {
      skipped.push({ ...finding, reason: risk });
      continue;
    }

    outcomes[i] = { replacement };
  }

  const pieces = [];
  let cursor = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const outcome = outcomes[i];
    if (!outcome) continue;
    const finding = candidates[i];
    pieces.push(text.slice(cursor, finding.index), outcome.replacement);
    cursor = finding.index + finding.length;
    applied.push({ ...finding, replacement: outcome.replacement });
  }
  pieces.push(text.slice(cursor));

  return { text: pieces.join(""), applied, skipped };
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

  const seen = new Set();
  const rows = [];
  for (const finding of findings) {
    const key = `${finding.bad}\u0000${finding.good}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(finding);
  }

  // 아래에 나열하는 줄 수(rows.length, 중복 제거)와 첫 문장의 건수가 같은 값이어야
  // "3건을 찾았습니다" 인데 줄이 2개인 것처럼 세는 것과 보여 주는 것이 어긋나지 않는다.
  // 실제 등장 횟수(findings.length)가 더 많으면 괄호로 총 등장 횟수를 덧붙인다.
  const header =
    rows.length === findings.length
      ? `어색한 표현 ${rows.length}가지를 찾았습니다.`
      : `어색한 표현 ${rows.length}가지(총 ${findings.length}곳)를 찾았습니다.`;

  const lines = [label ? `${label}에서 ${header}` : header, ""];

  for (const finding of rows) {
    const reason = finding.why ? ` (${finding.why})` : "";
    // 쓸 것을 적힌 그대로 보여 준다. "~될", "~습니다"처럼 어미를 적는 물결표는
    // 한국어에서 자연스러운 표기이므로 지우면 오히려 읽기 어려워진다.
    lines.push(`- "${finding.matched}" → "${finding.good}"${reason}`);
  }

  return lines.join("\n");
}
