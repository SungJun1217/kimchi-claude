// 한글 자모 분리와 정규화.
//
// macOS 는 파일 이름을 NFD(자모 분리)로 저장하고 리눅스·윈도는 NFC(음절 결합)로 저장한다.
// 그래서 macOS 에서 만든 "한글.txt" 를 리눅스 서버에 올리면 이름이 같은데도 다른 문자열이 된다.
// 눈으로는 구별할 수 없어서 원인을 찾는 데 시간이 오래 걸리는 종류의 버그다.
//
// 규칙은 하나다. **경계를 넘는 모든 문자열은 NFC 로 정규화한다.**
// 업로드 받을 때, 데이터베이스에 넣을 때, 비교할 때.

const SYLLABLE_BASE = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const MEDIAL_COUNT = 21;
const FINAL_COUNT = 28;

const INITIALS = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ",
  "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];
const MEDIALS = [
  "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ", "ㅙ",
  "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ",
];
// 첫 칸은 종성이 없는 경우다.
const FINALS = [
  "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ",
  "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];

/**
 * 경계를 넘는 문자열을 NFC 로 정규화한다.
 *
 * 파일 업로드, 데이터베이스 저장, 문자열 비교 앞에서 반드시 거쳐야 한다.
 * 자바스크립트 String.normalize 가 표준으로 들어 있으니 직접 구현하지 말 것.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeForStorage(text) {
  return text.normalize("NFC");
}

/**
 * 눈으로 같아 보이는 두 문자열이 정규화 형태만 다른지 알려준다.
 *
 * 버그를 진단할 때 쓴다. true 면 NFC 정규화가 빠진 자리를 찾아야 한다.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function differsOnlyByNormalization(a, b) {
  return a !== b && a.normalize("NFC") === b.normalize("NFC");
}

/**
 * 음절을 초성·중성·종성으로 나눈다. 종성이 없으면 빈 문자열이다.
 *
 * 받침 유무를 알아야 조사(을/를, 이/가)를 고를 수 있다.
 *
 * @param {string} char
 * @returns {{initial: string, medial: string, final: string}|null}
 */
export function decompose(char) {
  const code = char.codePointAt(0);
  if (code < SYLLABLE_BASE || code > SYLLABLE_LAST) return null;

  const offset = code - SYLLABLE_BASE;
  return {
    initial: INITIALS[Math.floor(offset / (MEDIAL_COUNT * FINAL_COUNT))],
    medial: MEDIALS[Math.floor(offset / FINAL_COUNT) % MEDIAL_COUNT],
    final: FINALS[offset % FINAL_COUNT],
  };
}

/**
 * 앞말의 받침에 맞는 조사를 고른다.
 *
 * 한국어 서비스의 안내 문구를 코드로 만들 때 반드시 필요하다.
 * "{name}을 삭제했습니다" 를 문자열 이어붙이기로 만들면 이름에 따라 틀린다.
 *
 * 영어나 숫자로 끝나면 발음으로 판단해야 하는데 자동으로는 알 수 없다.
 * 그런 경우에는 조사를 쓰지 않는 문장으로 바꾸는 편이 안전하다.
 *
 * @param {string} word
 * @param {"을/를"|"이/가"|"은/는"|"과/와"|"으로/로"} pair
 * @returns {string|null} 판정할 수 없으면 null
 */
export function particleFor(word, pair) {
  const PAIRS = {
    "을/를": ["을", "를"],
    "이/가": ["이", "가"],
    "은/는": ["은", "는"],
    "과/와": ["과", "와"],
    "으로/로": ["으로", "로"],
  };
  const chosen = PAIRS[pair];
  if (!chosen) return null;

  const last = [...word].at(-1);
  const parts = last === undefined ? null : decompose(last);
  if (parts === null) return null; // 한글이 아니면 발음을 알 수 없다

  // 으로/로 만 예외다. ㄹ 받침 뒤에는 "로" 를 쓴다. "서울로", "제주로".
  if (pair === "으로/로" && parts.final === "ㄹ") return "로";
  return parts.final === "" ? chosen[1] : chosen[0];
}
