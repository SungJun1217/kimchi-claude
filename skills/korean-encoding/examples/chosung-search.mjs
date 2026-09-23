// 초성 검색.
//
// "김치" 를 "ㄱㅊ" 로 찾는 기능이다. 한국 서비스의 검색창에서는 사실상 필수인데,
// 직접 짜면 자모 분리 산술을 틀리기 쉽다.
//
// 한글 음절은 (초성 × 21 × 28) + (중성 × 28) + 종성 + 0xAC00 으로 만들어진다.
// 따라서 초성 색인은 (코드 - 0xAC00) / 588 이다. 588 = 21 × 28.
//
// **입력하는 도중의 질의도 받아야 한다.** 한글 입력기는 "김치" 를 치는 동안
// "기" → "김" → "김ㅊ" → "김치" 를 차례로 보낸다. 글자를 칠 때마다 결과를 보여 주는
// 검색창에서 완성된 질의만 받으면, 결과가 사라졌다가 마지막 글자에서 다시 나타난다.

import { decompose } from "./hangul-jamo.mjs";

const SYLLABLE_BASE = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const MEDIAL_COUNT = 21;
const FINAL_COUNT = 28;

// 초성 19개. 순서가 유니코드 배열 순서와 같아야 한다.
const INITIALS = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ",
  "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];

// 겹받침의 첫 자음. "달" 까지 친 사람은 "닭" 을 찾고 있을 수 있다.
const COMPOUND_FINAL_HEAD = {
  "ㄳ": "ㄱ", "ㄵ": "ㄴ", "ㄶ": "ㄴ", "ㄺ": "ㄹ", "ㄻ": "ㄹ", "ㄼ": "ㄹ",
  "ㄽ": "ㄹ", "ㄾ": "ㄹ", "ㄿ": "ㄹ", "ㅀ": "ㄹ", "ㅄ": "ㅂ",
};

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
  return [...text.normalize("NFC")].map(initialOf).join("");
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
 * 입력 도중인 마지막 음절이 대상 글자와 맞는지 본다.
 *
 * "기" 는 "김" 의 앞부분이다(받침을 아직 안 쳤다). "김" 은 "기미" 의 앞부분일 수도 있다
 * (다음 모음을 치면 받침이 다음 음절의 초성으로 넘어간다). "달" 은 "닭" 의 앞부분이다.
 *
 * @param {string} typed 질의의 마지막 음절
 * @param {string} char 대상의 같은 자리 글자
 * @param {string|undefined} next 대상의 다음 글자
 * @returns {boolean}
 */
function composingMatches(typed, char, next) {
  if (typed === char) return true;
  const q = decompose(typed);
  const h = decompose(char);
  if (q === null || h === null) return false;
  if (q.initial !== h.initial || q.medial !== h.medial) return false;

  if (q.final === "") return true;
  if (COMPOUND_FINAL_HEAD[h.final] === q.final) return true;
  return h.final === "" && next !== undefined && initialOf(next) === q.final;
}

/**
 * 질의 글자 하나가 대상 글자 하나와 맞는지 본다.
 *
 * 질의에서 초성만 있는 자리는 초성으로 비교하고, 음절은 그대로 비교한다.
 * "김ㅊ" 은 첫 자리를 음절로, 둘째 자리를 초성으로 비교한다.
 */
function charMatches(typed, char, next, isLast) {
  if (INITIALS.includes(typed)) return initialOf(char) === typed;
  if (isLast) return composingMatches(typed, char, next);
  return typed === char;
}

function prepare(text) {
  // 맥에서 올린 이름은 NFD 로 온다. 정규화하지 않으면 한 글자도 맞지 않는다.
  return [...text.normalize("NFC").replace(/\s+/g, "").toLowerCase()];
}

/**
 * 초성 검색과 보통 검색을 함께 처리한다.
 *
 * 질의가 초성만이면 초성으로 찾고, 음절과 초성이 섞였으면 자리마다 맞춰 보고,
 * 마지막 음절은 입력 도중일 수 있으므로 앞부분만 맞아도 통과시킨다.
 *
 * @param {string} haystack 찾을 대상
 * @param {string} query 사용자가 입력한 질의
 * @returns {boolean}
 */
export function matches(haystack, query) {
  const needle = prepare(query);
  if (needle.length === 0) return true;
  const chars = prepare(haystack);

  for (let start = 0; start + needle.length <= chars.length; start += 1) {
    const hit = needle.every((typed, offset) =>
      charMatches(typed, chars[start + offset], chars[start + offset + 1], offset === needle.length - 1)
    );
    if (hit) return true;
  }
  return false;
}
