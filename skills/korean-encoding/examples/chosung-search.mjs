// 초성 검색.
//
// "김치" 를 "ㄱㅊ" 로 찾는 기능이다. 한국 서비스의 검색창에서는 사실상 필수인데,
// 직접 짜면 자모 분리 산술을 틀리기 쉽다.
//
// 한글 음절은 (초성 × 21 × 28) + (중성 × 28) + 종성 + 0xAC00 으로 만들어진다.
// 따라서 초성 색인은 (코드 - 0xAC00) / 588 이다. 588 = 21 × 28.

const SYLLABLE_BASE = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const MEDIAL_COUNT = 21;
const FINAL_COUNT = 28;

// 초성 19개. 순서가 유니코드 배열 순서와 같아야 한다.
const INITIALS = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ",
  "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];

/**
 * 음절 하나의 초성을 돌려준다. 한글 음절이 아니면 그 글자를 그대로 돌려준다.
 *
 * 한글이 아닌 글자를 그대로 통과시켜야 "iOS앱" 을 "iOSㅇ" 로 찾을 수 있다.
 *
 * @param {string} char
 * @returns {string}
 */
export function initialOf(char) {
  const code = char.codePointAt(0);
  if (code < SYLLABLE_BASE || code > SYLLABLE_LAST) return char;
  return INITIALS[Math.floor((code - SYLLABLE_BASE) / (MEDIAL_COUNT * FINAL_COUNT))];
}

/**
 * 문자열을 초성 문자열로 바꾼다.
 * @param {string} text
 * @returns {string}
 */
export function toChosung(text) {
  return [...text].map(initialOf).join("");
}

/**
 * 질의가 초성만으로 이루어졌는지 본다.
 *
 * 이 판정이 필요한 이유가 있다. 사용자가 "김" 을 입력했을 때 초성 검색으로 처리하면
 * "ㄱ" 으로 시작하는 모든 것이 걸려 오히려 방해가 된다. 초성 질의일 때만 초성으로 찾는다.
 *
 * @param {string} query
 * @returns {boolean}
 */
export function isChosungQuery(query) {
  const trimmed = query.replace(/\s+/g, "");
  return trimmed.length > 0 && [...trimmed].every((char) => INITIALS.includes(char));
}

/**
 * 초성 검색과 보통 검색을 함께 처리한다.
 *
 * 질의가 초성만이면 초성으로 찾고, 아니면 부분 문자열로 찾는다.
 *
 * @param {string} haystack 찾을 대상
 * @param {string} query 사용자가 입력한 질의
 * @returns {boolean}
 */
export function matches(haystack, query) {
  const needle = query.replace(/\s+/g, "");
  if (needle.length === 0) return true;
  if (isChosungQuery(needle)) return toChosung(haystack).includes(needle);
  return haystack.replace(/\s+/g, "").includes(needle);
}
