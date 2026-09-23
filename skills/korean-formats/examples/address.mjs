// 한국 주소.
//
// 법정 주소는 도로명주소다. 지번주소는 병행 표기로 남아 있고, 옛 자료에는 지번만 있다.
// 우편번호는 2015년 8월에 6자리에서 **5자리**로 바뀌었다. 6자리로 검증하는 코드는 틀린다.
//
// 주소를 한 칸에 담지 말 것. 세 칸으로 나눈다.
//   우편번호     5자리
//   기본주소     검색 결과를 그대로 받는다. 사용자가 고치게 하지 않는다
//   상세주소     동·호수. 사용자가 직접 입력한다
//
// 기본주소를 사용자가 고칠 수 있게 두면 배송이 실패한다. 주소 검색 API(도로명주소
// 안내시스템, 카카오·다음 우편번호 서비스)의 결과를 읽기 전용으로 저장한다.

/** 우편번호는 5자리다. 2015년 8월 이전은 6자리였다. */
export const POSTAL_CODE_PATTERN = /^\d{5}$/;

/**
 * 우편번호를 검증한다.
 * @param {string} value
 * @returns {boolean}
 */
export function isValidPostalCode(value) {
  return POSTAL_CODE_PATTERN.test(String(value).trim());
}

/**
 * 도로명주소인지 지번주소인지 가른다.
 *
 * 도로명주소는 "…로 123" 이나 "…길 45-6" 형태로 끝난다.
 * 지번주소는 "…동 123-4" 형태다.
 *
 * @param {string} address
 * @returns {"도로명"|"지번"|"알 수 없음"}
 */
export function addressKind(address) {
  const text = String(address).trim();
  if (/[로길]\s*\d+(-\d+)?(\s|$)/.test(text)) return "도로명";
  if (/[동리]\s*\d+(-\d+)?(\s|$)/.test(text)) return "지번";
  return "알 수 없음";
}

/**
 * 기본주소에서 참고항목을 떼어 낸다.
 *
 * 주소 검색 결과에는 괄호로 법정동과 건물명이 붙는다.
 * 예: "서울 강남구 테헤란로 123 (역삼동, 아무빌딩)"
 *
 * 괄호 안은 **주소의 일부가 아니다.** 배송이나 주소 비교에 쓰면 안 된다.
 * 화면에 보여 줄 때만 쓴다.
 *
 * @param {string} address
 * @returns {{base: string, reference: string}}
 */
export function splitReference(address) {
  const text = String(address).trim();
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(text);
  if (match === null) return { base: text, reference: "" };
  return { base: match[1].trim(), reference: match[2].trim() };
}

/**
 * 두 주소가 같은 곳인지 견준다.
 *
 * 공백과 참고항목을 무시하고, 한글 정규화를 맞춘다.
 * macOS 에서 입력한 주소와 서버에 저장된 주소가 자모 분리 때문에 다를 수 있다.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameAddress(a, b) {
  const normalize = (value) =>
    splitReference(value).base.normalize("NFC").replace(/\s+/g, "");
  return normalize(a) === normalize(b);
}
