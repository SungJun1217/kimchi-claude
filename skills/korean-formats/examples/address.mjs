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

// 실제 배정된 우편번호는 앞 두 자리가 01~63 이다(우정사업본부 우편번호 체계 기준,
// 서울 01xxx ~ 제주 63xxx). "00000"처럼 다섯 자리이기만 한 값을 형식 검사로 걸러낸다.
/** 우편번호는 5자리다. 2015년 8월 이전은 6자리였다. */
export const POSTAL_CODE_PATTERN = /^(?:0[1-9]|[1-5]\d|6[0-3])\d{3}$/;

/**
 * 우편번호를 검증한다. 형식과 앞 두 자리의 배정 범위(01~63)만 본다.
 *
 * 실제로 쓰이는 번호인지는 확인하지 않는다. 우정사업본부가 우편번호를 새로 배정하거나
 * 회수하면 이 범위 안에서도 없는 번호가 생긴다. 배송 전 검증은 주소 검색 API 결과를
 * 그대로 신뢰하는 편이 안전하다.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidPostalCode(value) {
  // 관공서 자료에는 전각 숫자(０６２３４)가 섞여 온다. NFKC 가 반각으로 되돌린다.
  return POSTAL_CODE_PATTERN.test(String(value).normalize("NFKC").trim());
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
  // 번호 뒤에는 공백, 끝, 쉼표가 온다. 공식 표기는 "테헤란로 123, 101동 1203호" 처럼
  // 쉼표 뒤에 상세주소를 붙인다. 공백만 받으면 공식 표기를 판정하지 못한다.
  //
  // 지하 건물은 "을지로 지하 12", 임야 지번은 "봉천동 산 101" 처럼 번호 앞에 한 낱말이 끼어든다.
  //
  // "을지로2가"·"종로1가" 처럼 숫자 뒤에 "가"가 바로 붙으면 도로명이 아니라 법정동
  // 이름이다(지번주소). 숫자 뒤에 "가"가 오면 도로명으로 보지 않는다.
  if (/[로길]\s*(지하\s*)?\d+(-\d+)?(?![\d-가])/.test(text)) return "도로명";
  if (/[동리가]\s*(산\s*)?\d+(-\d+)?(?![\d-])/.test(text)) return "지번";
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
  if (!text.endsWith(")")) return { base: text, reference: "" };

  // 괄호 안에 괄호가 또 올 수 있다("역삼동, 아무(가)빌딩"). 정규식 하나로는 중첩을
  // 다루지 못하므로 끝에서부터 괄호 깊이를 세어 바깥쪽 여는 괄호를 찾는다.
  let depth = 0;
  let start = -1;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === ")") depth += 1;
    else if (text[i] === "(") {
      depth -= 1;
      if (depth === 0) {
        start = i;
        break;
      }
    }
  }
  if (start === -1) return { base: text, reference: "" };
  return { base: text.slice(0, start).trim(), reference: text.slice(start + 1, -1).trim() };
}

/**
 * 두 주소가 같은 곳인지 견준다.
 *
 * 공백과 참고항목을 무시하고, 한글 정규화와 시도 이름을 맞춘다. 숫자와 숫자 사이의
 * 공백만은 남긴다 — 지우면 "테헤란로 1 23"과 "테헤란로 12 3"이 같은 주소가 되어 버린다.
 * macOS 에서 입력한 주소와 서버에 저장된 주소가 자모 분리 때문에 다를 수 있다.
 *
 * **문자열 비교는 차선이다.** 시군구와 도로명도 바뀐다(인천 남구 → 미추홀구, 군위군의
 * 대구 편입, 도로명 변경). 주소 검색 API 가 돌려주는 건물관리번호를 함께 저장하고,
 * 같은 곳인지는 그 번호로 가리는 것이 맞다. 이 함수는 번호가 없는 옛 자료용이다.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameAddress(a, b) {
  const normalize = (value) => {
    const tokens = splitReference(value).base.normalize("NFC").trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return "";
    const [first, ...rest] = tokens;

    // 시도 이름이 다음 낱말과 붙어 올 때가 있다("서울강남구"). 아는 시도 이름이 앞에
    // 있으면 떼어 낸다.
    const known = [...REGION_CANONICAL.keys()]
      .sort((x, y) => y.length - x.length)
      .find((name) => first.startsWith(name));
    const joined =
      known && known.length < first.length
        ? [canonicalRegion(known), first.slice(known.length), ...rest].join(" ")
        : [canonicalRegion(first), ...rest].join(" ");

    // 공백 자체는 무시한다("강남구테헤란로"와 "강남구 테헤란로"는 같은 곳이다) —
    // 다만 숫자와 숫자 사이의 공백만은 남긴다. 거기를 지우면 "테헤란로 1 23"과
    // "테헤란로 12 3"이 이어붙어 같은 문자열이 되어 버린다.
    return joined.replace(/(?<!\d)\s+|\s+(?!\d)/g, "");
  };
  return normalize(a) === normalize(b);
}

// 시도 이름은 출처마다 다르게 온다. 도로명주소 안내시스템은 "서울특별시", 카카오는 "서울".
// 그리고 이름이 바뀌었다. 옛 자료에는 옛 이름이 그대로 남아 있다.
//   2023-06-11  강원도   → 강원특별자치도
//   2024-01-18  전라북도 → 전북특별자치도
const REGION_ALIASES = {
  서울: ["서울특별시", "서울시"],
  부산: ["부산광역시", "부산시"],
  대구: ["대구광역시", "대구시"],
  인천: ["인천광역시", "인천시"],
  광주: ["광주광역시"],
  대전: ["대전광역시", "대전시"],
  울산: ["울산광역시", "울산시"],
  세종: ["세종특별자치시", "세종시"],
  경기: ["경기도"],
  강원: ["강원특별자치도", "강원도"],
  충북: ["충청북도"],
  충남: ["충청남도"],
  전북: ["전북특별자치도", "전라북도"],
  전남: ["전라남도"],
  경북: ["경상북도"],
  경남: ["경상남도"],
  제주: ["제주특별자치도", "제주도"],
};
const REGION_CANONICAL = new Map(
  Object.entries(REGION_ALIASES).flatMap(([short, names]) => [[short, short], ...names.map((name) => [name, short])])
);

/**
 * 시도 이름을 짧은 이름 하나로 모은다. 시도가 아니면 그대로 돌려준다.
 *
 * "광주" 는 광주광역시다. 경기도 광주시는 "경기 광주시" 로 시도가 앞에 온다.
 *
 * @param {string} name
 * @returns {string}
 */
export function canonicalRegion(name) {
  return REGION_CANONICAL.get(name) ?? name;
}
