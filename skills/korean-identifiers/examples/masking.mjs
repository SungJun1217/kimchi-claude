// 개인정보 마스킹.
//
// **서버에서 마스킹한다.** 원본을 내려보내고 화면에서 가리면 개발자 도구와 네트워크 기록,
// 브라우저 캐시에 원본이 그대로 남는다. 마스킹은 응답을 만드는 자리에서 해야 한다.
//
// **판단 단위는 필드가 아니라 조합이다.** 각각은 안전해 보여도 한 줄에 모이면 특정된다.
// 이름 첫 글자 + 생년월일 + 지역이면 사실상 한 사람이다.
//
// 화면, 로그, 오류 보고, 통계에 나가는 값은 마스킹한다. 개인정보 보호법과 그 시행령이
// 안전성 확보 조치를 요구하고, 실무에서는 아래 정도가 관행이다.
//
// 마스킹은 **되돌릴 수 없어야** 한다. 앞뒤를 조금씩 남기면 다른 정보와 합쳐 복원된다.
// 특히 생년월일과 이름을 함께 남기면 사실상 식별된다.

/**
 * 이름을 마스킹한다. 가운데를 가린다.
 *
 * 두 글자 이름은 가운데가 없으므로 마지막 글자를 가린다.
 * 성이 두 글자인 경우(남궁, 황보)를 자동으로 알 수는 없다. 그래서 성을 분리하려 하지 않는다.
 *
 * @param {string} name
 * @returns {string}
 */
export function maskName(name) {
  const chars = [...String(name)];
  if (chars.length === 0) return "";
  if (chars.length === 1) return "*";
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars.at(-1)}`;
}

/**
 * 주민등록번호를 마스킹한다. 뒷자리를 통째로 가린다.
 *
 * 생년월일만 남긴다. 성별 표시 한 자리도 가린다. 성별과 생년월일이 함께 남으면
 * 다른 정보와 합쳐 식별될 수 있다.
 *
 * @param {string} value
 * @returns {string}
 */
export function maskResidentNumber(value) {
  const digits = String(value).normalize("NFKC").replace(/\D/g, "");
  if (digits.length !== 13) return "*".repeat(String(value).length);
  return `${digits.slice(0, 6)}-*******`;
}

/**
 * 전화번호를 마스킹한다. 가운데 자리를 가린다.
 *
 * @param {string} value
 * @returns {string}
 */
export function maskPhone(value) {
  const digits = String(value).normalize("NFKC").replace(/\D/g, "");
  if (digits.length < 9) return "*".repeat(String(value).length);
  // 서울만 지역번호가 두 자리다. 나머지 지역번호와 휴대전화 앞자리는 세 자리다.
  // 자리수를 전체 길이에서 빼서 구하면 9자리 번호에서 머리가 한 자리로 줄어든다.
  const headLength = digits.startsWith("02") ? 2 : 3;
  return `${digits.slice(0, headLength)}-****-${digits.slice(-4)}`;
}

/**
 * 전자우편 주소를 마스킹한다. 계정 이름의 앞 두 글자만 남긴다.
 *
 * 도메인은 남긴다. 회사 도메인은 개인 식별 정보가 아니고, 남겨 두면 문제를 진단할 수 있다.
 *
 * @param {string} value
 * @returns {string}
 */
export function maskEmail(value) {
  const text = String(value);
  const at = text.lastIndexOf("@");
  if (at <= 0) return "*".repeat(text.length);

  const local = text.slice(0, at);
  const domain = text.slice(at);
  if (local.length <= 2) return `${"*".repeat(local.length)}${domain}`;
  return `${local.slice(0, 2)}${"*".repeat(local.length - 2)}${domain}`;
}

/**
 * 계좌번호와 카드번호를 마스킹한다. 뒤 네 자리만 남긴다.
 *
 * 카드번호는 앞 여섯 자리(BIN)도 남기지 않는다. 카드사와 상품이 드러난다.
 *
 * @param {string} value
 * @returns {string}
 */
export function maskAccount(value) {
  const digits = String(value).normalize("NFKC").replace(/\D/g, "");
  if (digits.length <= 4) return "*".repeat(digits.length);
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

// 필드 이름으로 마스커를 고른다. 관리자 화면은 대개 데이터베이스 행을 그대로 내보낸다.
const MASKERS = {
  name: maskName,
  userName: maskName,
  memberName: maskName,
  residentNumber: maskResidentNumber,
  rrn: maskResidentNumber,
  phone: maskPhone,
  phoneNumber: maskPhone,
  mobile: maskPhone,
  email: maskEmail,
  account: maskAccount,
  accountNumber: maskAccount,
  cardNumber: maskAccount,
  address: maskAddress,
};

// 혼자서는 안전해 보이지만 모이면 특정되는 필드들.
const IDENTIFYING_TOGETHER = ["name", "userName", "memberName", "birthDate", "birthday", "address", "zipCode"];

/**
 * 행 하나를 통째로 마스킹한다.
 *
 * 필드마다 다른 마스커를 써야 하는데, 관리자 화면에서 손으로 고르면 하나를 빠뜨린다.
 * 이름을 알면 마스커도 정해진다.
 *
 * @param {object} record
 * @returns {{masked: object, warnings: string[]}}
 */
export function maskRecord(record) {
  const masked = {};
  const shown = [];

  for (const [key, value] of Object.entries(record ?? {})) {
    const masker = MASKERS[key];
    if (masker === undefined) {
      masked[key] = value;
      if (IDENTIFYING_TOGETHER.includes(key)) shown.push(key);
      continue;
    }
    masked[key] = value === null || value === undefined ? value : masker(value);
  }

  // 조합 위험을 알려 준다. 필드마다 따로 보면 안전해 보인다.
  const warnings =
    shown.length >= 2
      ? [`마스킹하지 않은 식별 가능 필드가 ${shown.length}개다: ${shown.join(", ")}. 모이면 특정된다`]
      : [];

  return { masked, warnings };
}

/**
 * 주소를 마스킹한다. 상세주소를 지운다.
 *
 * 도로명과 건물 번호까지는 남기고 동·호수를 가린다. 동·호수가 남으면 특정된다.
 *
 * @param {string} value
 * @returns {string}
 */
export function maskAddress(value) {
  // 도로명 + 건물번호까지 남긴다. 그 뒤는 상세주소로 본다.
  const match = /^(.*?[로길]\s*\d+(?:-\d+)?)\s*(.*)$/.exec(String(value).trim());
  if (match === null) return String(value);
  return match[2].length === 0 ? match[1] : `${match[1]} ****`;
}
