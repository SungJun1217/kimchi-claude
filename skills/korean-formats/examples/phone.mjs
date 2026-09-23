// 한국 전화번호.
//
// 자리수가 고정이라고 가정하면 틀린다. 지역번호가 2자리(서울)와 3자리(그 밖)로 갈리고,
// 대표번호는 지역번호가 없으며, 휴대전화도 010 이전 번호가 남아 있다.
//
// 그래서 `\d{3}-\d{4}-\d{4}` 같은 정규식으로 검증하면 정상 번호를 거부한다.

// 지역번호. 서울만 2자리다.
const AREA_CODES = [
  "02", // 서울
  "031", "032", "033", // 경기, 인천, 강원
  "041", "042", "043", "044", // 충남, 대전, 충북, 세종
  "051", "052", "053", "054", "055", // 부산, 울산, 대구, 경북, 경남
  "061", "062", "063", "064", // 전남, 광주, 전북, 제주
];

// 휴대전화. 011·016·017·018·019 는 2G 종료로 신규 발급이 없지만 아직 쓰는 번호가 있다.
const MOBILE_PREFIXES = ["010", "011", "016", "017", "018", "019"];

// 지역번호 없이 쓰는 번호들.
//
// 050 대역은 평생번호와 안심번호로 나뉜다. 0502~0507 이 모두 쓰이므로 0505 만 받으면
// 오픈마켓 주문의 안심번호(0504 등)가 검증에서 떨어진다. 배송 알림이 못 나간다.
const SPECIAL_PREFIXES = [
  "070", // 인터넷전화
  "080", // 수신자부담
  "0502", "0503", "0504", "0505", "0506", "0507", // 평생번호·안심번호
];

/** 050 대역 가운데 안심번호로 쓰이는 접두사. 유효 기간이 있어 영구 보관하면 안 된다. */
const SAFE_NUMBER_PREFIXES = new Set(["0504", "0503", "0506", "0507"]);

/**
 * 안심번호인지 알려준다.
 *
 * 오픈마켓 주문에는 구매자의 실제 번호 대신 안심번호가 들어온다. **유효 기간이 있다.**
 * 영구 보관하면 나중에 연락이 닿지 않고, 다른 사람에게 재배정될 수도 있다.
 * 주문 단위로만 쓰고 회원 정보에 저장하지 말 것.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isSafeNumber(value) {
  const digits = String(value).normalize("NFKC").replace(/\D/g, "");
  return [...SAFE_NUMBER_PREFIXES].some((prefix) => digits.startsWith(prefix));
}

/**
 * 전화번호를 뜯어본다.
 *
 * @param {string} value
 * @returns {{kind: string, parts: string[]}|null} 알 수 없으면 null
 */
export function parsePhone(value) {
  let digits = String(value).normalize("NFKC").replace(/\D/g, "");

  // 국제 형식을 국내 형식으로 되돌린다. +82-10-1234-5678 → 01012345678
  if (digits.startsWith("82")) digits = `0${digits.slice(2)}`;

  const mobile = MOBILE_PREFIXES.find((prefix) => digits.startsWith(prefix));
  if (mobile) {
    const rest = digits.slice(3);
    // 010 은 8자리, 그 밖의 구 번호는 7자리도 있다.
    if (rest.length !== 7 && rest.length !== 8) return null;
    return { kind: "휴대전화", parts: [mobile, rest.slice(0, rest.length - 4), rest.slice(-4)] };
  }

  // 대표번호. 15XX·16XX·18XX 로 시작하고 8자리다. 지역번호가 없다.
  if (/^1[568]\d{2}\d{4}$/.test(digits)) {
    return { kind: "대표번호", parts: [digits.slice(0, 4), digits.slice(4)] };
  }

  const special = SPECIAL_PREFIXES.find((prefix) => digits.startsWith(prefix));
  if (special) {
    const rest = digits.slice(special.length);
    if (rest.length < 7 || rest.length > 8) return null;
    const kind = isSafeNumber(digits) ? "안심번호" : "특수번호";
    return { kind, parts: [special, rest.slice(0, rest.length - 4), rest.slice(-4)] };
  }

  // 지역번호는 긴 것부터 맞춰야 한다. "02" 가 "021" 을 먹어 버리면 안 된다.
  const area = [...AREA_CODES].sort((a, b) => b.length - a.length).find((code) => digits.startsWith(code));
  if (area) {
    const rest = digits.slice(area.length);
    // 국번은 3자리나 4자리다.
    if (rest.length !== 7 && rest.length !== 8) return null;
    return { kind: "유선전화", parts: [area, rest.slice(0, rest.length - 4), rest.slice(-4)] };
  }

  return null;
}

/**
 * 표기 형식으로 바꾼다. 하이픈을 넣는다.
 * @param {string} value
 * @returns {string} 알 수 없으면 입력을 그대로 돌려준다
 */
export function formatPhone(value) {
  const parsed = parsePhone(value);
  return parsed === null ? String(value) : parsed.parts.join("-");
}

/**
 * 국제 형식으로 바꾼다. 앞의 0 을 떼고 +82 를 붙인다.
 *
 * 문자 발송이나 해외 결제에서 필요하다.
 *
 * @param {string} value
 * @returns {string|null}
 */
export function toInternational(value) {
  const parsed = parsePhone(value);
  if (parsed === null) return null;
  const digits = parsed.parts.join("");
  return `+82${digits.replace(/^0/, "")}`;
}
