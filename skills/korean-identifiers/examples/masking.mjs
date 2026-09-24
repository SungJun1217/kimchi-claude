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
 * NFD(자모 분리)로 들어오면 글자 수를 세는 자리부터 틀린다. NFC로 모으고 시작한다.
 * 문자열이 아니면(null, undefined, 숫자 등) 마스킹할 이름이 아니므로 빈 문자열을 돌려준다.
 *
 * @param {string} name
 * @returns {string}
 */
export function maskName(name) {
  if (typeof name !== "string") return "";
  const chars = [...name.normalize("NFC")];
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

// 도로명주소: "…로 123", "…로123길 45", "…길 45-6", "…로 지하 12" 형태.
// "종로1가"·"을지로2가"처럼 숫자 뒤에 "가"가 붙는 법정동 이름은 지번이므로 도로명으로
// 보지 않는다(뒤에 "가"가 오면 매치하지 않는다). 숫자 바로 뒤에 호·동·층이 붙으면 그
// 숫자는 건물번호가 아니라 상세주소의 단위(호수·동수·층수)다 — "1203호"를 건물번호로
// 착각해 남기면 안 된다.
// 마지막 제외 목록에 "길"도 넣는다. "논현로12길"처럼 "로\d+길" 전체가 맞았다가 뒤에서
// 실패하면, 정규식 엔진이 "로"만 딴 뒤("[로길]" 대안) "12"를 건물번호로 오인해 되돌아간다.
const ROAD_DETAIL = /^(.*?[가-힣]+(?:로\d+길|[로길])\s*(?:지하\s*)?\d+(?:-\d+)?)(?![\d-가호동층길])/;

// 지번주소: "…동 123-4", "…리 5", "…동2가 12-3", "산 101" 임야 지번. 도로명과 같은
// 이유로 숫자 바로 뒤의 호·동·층은 지번이 아니라 상세주소다.
const LOT_DETAIL = /^(.*?[가-힣]+(?:\d+가|[동리가])\s*(?:산\s*)?\d+(?:-\d+)?)(?![\d-호동층])/;

// 한국의 시/도 이름. 이 안에 없으면 아무것도 믿을 수 없다 — "은마아파트12동345호"처럼
// 시/도조차 없는 입력에서 tokens[0]을 그대로 돌려주면 상세주소가 그대로 새어 나간다.
const PROVINCE_NAMES = [
  "서울특별시", "서울시", "서울",
  "부산광역시", "부산시", "부산",
  "대구광역시", "대구시", "대구",
  "인천광역시", "인천시", "인천",
  "광주광역시", "광주",
  "대전광역시", "대전시", "대전",
  "울산광역시", "울산시", "울산",
  "세종특별자치시", "세종시", "세종",
  "경기도", "경기",
  "강원특별자치도", "강원도", "강원",
  "충청북도", "충북",
  "충청남도", "충남",
  "전북특별자치도", "전라북도", "전북",
  "전라남도", "전남",
  "경상북도", "경북",
  "경상남도", "경남",
  "제주특별자치도", "제주도", "제주",
].sort((a, b) => b.length - a.length);

// 도로명도 지번도 못 알아본 경우다. 시/도(+시/군/구)까지만 안전하게 남기고 그 뒤는
// 모두 가린다. 실패를 열어 두면(원본이나 첫 낱말을 그대로 돌려주면) 동·호수가 새어 나간다.
//
// 시/도 이름조차 찾지 못하면 아무것도 남기지 않는다 — "1203호"·"101-1203"처럼 주소
// 형태가 아예 아닌 입력에서 첫 토큰을 그대로 돌려주는 게 옛 결함이었다.
function safePrefix(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";

  // 공백 없이 붙어 오는 입력도 있다("서울시강남구역삼동…"). 첫 토큰의 접두사로 찾는다.
  const province = PROVINCE_NAMES.find((name) => tokens[0].startsWith(name));
  if (province === undefined) return "";
  if (tokens[0] !== province) return province; // 시/도 뒤가 붙어 있으면 구까지는 못 믿는다

  let lastAdminIndex = 0;
  for (let i = 1; i < tokens.length; i += 1) {
    if (/\d/.test(tokens[i])) break; // 숫자가 나오면 그 뒤는 상세주소일 위험이 있다
    if (!/[시군구]$/.test(tokens[i])) break; // 시/군/구가 아닌 낱말이 끼면 그 뒤는 못 믿는다
    lastAdminIndex = i;
  }
  return tokens.slice(0, lastAdminIndex + 1).join(" ");
}

function withMaskedRemainder(prefix, text) {
  const remainder = text.slice(prefix.length).trim();
  return remainder.length === 0 ? prefix : `${prefix} ****`;
}

/**
 * 주소를 마스킹한다. 상세주소를 지운다.
 *
 * 도로명과 건물 번호까지는 남기고 동·호수를 가린다. 동·호수가 남으면 특정된다.
 *
 * **실패를 닫는 쪽으로 둔다.** 도로명도 지번도 알아볼 수 없으면 원본을 그대로 돌려주지
 * 않는다. 시/도(+시/군/구)까지만 남기고 나머지는 가린다. 그것조차 없으면 통째로 가린다
 * — 알아보지 못했다고 원본이나 첫 낱말을 그대로 흘려보내면 마스킹이 없느니만 못하다.
 *
 * @param {string} value
 * @returns {string}
 */
export function maskAddress(value) {
  const text = String(value).trim();

  const road = ROAD_DETAIL.exec(text);
  if (road !== null) return withMaskedRemainder(road[1], text);

  const lot = LOT_DETAIL.exec(text);
  if (lot !== null) return withMaskedRemainder(lot[1], text);

  const prefix = safePrefix(text);
  if (prefix.length === 0) return "****";
  return prefix.length === text.length ? prefix : `${prefix} ****`;
}
