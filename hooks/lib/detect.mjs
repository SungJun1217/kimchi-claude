// 한국어 문서인지 판정한다.
//
// 린터가 영어 문서에 한국어 문체 규칙을 들이대는 것을 막는 용도다.
// 출력 스타일 쪽에는 쓰이지 않는다. 거기서는 모델이 사용자의 말을 보고 직접 판단한다.

// 한글 음절, 한글 자모, 호환 자모
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/g;

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
  const hangul = countHangul(text);
  if (hangul < 3) return false;
  // 공백을 뺀 길이로 비율을 잰다. 들여쓰기가 많은 문서에서 비율이 눌리는 것을 막는다.
  const dense = text.replace(/\s+/g, "").length || 1;
  return hangul / dense >= 0.1;
}
