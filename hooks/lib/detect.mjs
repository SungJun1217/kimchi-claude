// 한국어 문서인지 판정한다.
//
// 린터가 영어 문서에 한국어 문체 규칙을 들이대는 것을 막는 용도다.
// 출력 스타일 쪽에는 쓰이지 않는다. 거기서는 모델이 사용자의 말을 보고 직접 판단한다.

// 한글 음절, 한글 자모, 호환 자모
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/g;

function isHangul(code) {
  return (
    (code >= 0xac00 && code <= 0xd7a3) || // 음절
    (code >= 0x1100 && code <= 0x11ff) || // 자모
    (code >= 0x3130 && code <= 0x318f) // 호환 자모
  );
}

function isWhitespace(code, char) {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  return code > 127 && /\s/.test(char);
}

/**
 * 한글 문자 수를 센다.
 * @param {string} text
 * @returns {number}
 */
export function countHangul(text) {
  if (typeof text !== "string") return 0;
  const matches = text.match(HANGUL);
  return matches ? matches.length : 0;
}

/**
 * 한국어 문서로 볼지 판정한다.
 *
 * 한글이 하나라도 있으면 켜는 방식은 한국어 파일명 하나 때문에 오작동한다.
 * 그래서 절대 개수와 비율을 함께 본다.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksKorean(text) {
  if (typeof text !== "string" || text.length === 0) return false;

  // 한 번만 훑으면서 한글 수와 공백을 뺀 길이를 함께 센다.
  // 예전에는 match() 로 배열을, replace() 로 문자열 사본을 각각 만들었다.
  let hangul = 0;
  let dense = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isWhitespace(code, text[i])) continue;
    dense += 1;
    if (isHangul(code)) hangul += 1;
  }

  if (hangul < 3) return false;
  return hangul / (dense || 1) >= 0.1;
}
