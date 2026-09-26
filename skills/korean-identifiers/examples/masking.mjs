import {
  RESIDENT_NUMBER_SEPARATED_PATTERN,
  RESIDENT_NUMBER_GLUED_PATTERN,
  looksLikeResidentNumber,
  foldForScan,
} from "./resident-number.mjs";

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

// 키 이름을 정규화한다. resident_number·residentNumber·RESIDENT-NUMBER·RRN 이 전부 같은
// 필드를 가리키는데, 관리자 화면마다 DB 컬럼명 관행(snake_case, camelCase, 대문자 약어)이
// 다르다. 원래 키 그대로 찾으면 셋 중 하나만 맞고 나머지 둘은 마스킹 없이 새 나간다.
function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[_\-\s]/g, "");
}

// 필드 이름으로 마스커를 고른다. 관리자 화면은 대개 데이터베이스 행을 그대로 내보낸다.
// 정규화된(normalizeKey) 이름으로 찾으므로 표기 관행이 달라도 같은 필드로 잡힌다.
const MASKERS_BY_KEY = {
  name: maskName,
  username: maskName,
  membername: maskName,
  fullname: maskName,
  이름: maskName,
  성명: maskName,
  residentnumber: maskResidentNumber,
  residentregistrationnumber: maskResidentNumber,
  rrn: maskResidentNumber,
  jumin: maskResidentNumber,
  juminnumber: maskResidentNumber,
  juminregistrationnumber: maskResidentNumber,
  주민등록번호: maskResidentNumber,
  주민번호: maskResidentNumber,
  phone: maskPhone,
  phones: maskPhone, // 배열 필드는 복수형("phones": [...])으로 흔히 온다
  phonenumber: maskPhone,
  mobile: maskPhone,
  mobilenumber: maskPhone,
  tel: maskPhone,
  telephone: maskPhone,
  cellphone: maskPhone,
  휴대폰: maskPhone,
  휴대폰번호: maskPhone,
  휴대전화: maskPhone,
  전화: maskPhone,
  전화번호: maskPhone,
  email: maskEmail,
  emails: maskEmail,
  mail: maskEmail,
  이메일: maskEmail,
  전자우편: maskEmail,
  account: maskAccount,
  accounts: maskAccount,
  accountnumber: maskAccount,
  cardnumber: maskAccount,
  card: maskAccount,
  cards: maskAccount,
  계좌: maskAccount,
  계좌번호: maskAccount,
  카드번호: maskAccount,
  address: maskAddress,
  주소: maskAddress,
};

// 혼자서는 안전해 보이지만 모이면 특정되는 필드들. 정규화된 이름으로 비교한다.
//
// name·userName·memberName·address 는 여기서 뺐다 — MASKERS_BY_KEY 에 이미 있어서
// 항상 마스킹되고, 아래 shown 목록(마스킹하지 않은 필드만 담는다)에는 절대 들어오지
// 않는 죽은 항목이었다. 마스커가 없는 필드만 남긴다 — "따로는 안전해 보이지만 모이면
// 특정된다"는 경고가 실제로 마스킹하지 않고 남긴 필드를 가리키게 하려는 것이다.
const IDENTIFYING_TOGETHER = new Set(["birthDate", "birthday", "zipCode"].map(normalizeKey));

// 자유 텍스트(메모, 비고 등)에 섞여 들어오는 전화번호. 하이픈·마침표·공백 어느 것으로
// 구분해도(또는 구분자 없이) 잡되, 앞뒤가 숫자로 이어지면 더 긴 번호(주문번호,
// 카드번호)의 일부일 수 있으므로 경계를 둔다.
// AREA_CODES(02, 0[3-6]1~4) 와 휴대전화 접두사(01[016789])만 인정한다 — 060·070·080·15xx
// 같은 특수번호까지 넓히면 오탐이 늘어나는데, 메모에 그런 번호가 섞일 일은 드물다.
// foldForScan() 이 돌려준 clean 문자열에만 쓴다 — 대시류(en-dash 포함)·공백류가 이미
// '-'·' ' 로 접혀 있으므로 마침표만 따로 받으면 된다.
const PHONE_IN_TEXT =
  /(?<![0-9])(?:01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}|0(?:2|[3-6][1-4])[-.\s]?\d{3,4}[-.\s]?\d{4})(?![0-9])/g;

// 구분자 없이 숫자만 있는 전화번호. 앞자리 0 이 없는 형태도 받는다 — 전화번호를 문자열이
// 아니라 숫자(JS number)로 저장하면 앞자리 0 이 파싱 단계에서 이미 사라진다("010..." →
// 10...). 그 손실은 여기서 되돌릴 수 없지만, 0 이 없어도 접두사 모양은 알아볼 수 있다.
const PHONE_DIGITS_ONLY = /^(?:0?1[016789]\d{7,8}|0?2\d{7,8}|0?[3-6][1-4]\d{6,7})$/;

// 정규식 하나로 찾은 구간들을 합친다. 뒤에서부터 원문을 잘라 끼워야 앞쪽 자리가
// 밀리지 않는데, 그러려면 구간끼리 겹치지 않아야 한다 — RRN 매치와 전화번호 매치가
// 겹칠 일은 실제로는 거의 없지만, 겹쳤을 때 조용히 깨지는 것보다 합쳐 두는 편이 싸다.
function collectSpans(clean, pattern, spanToOriginal, spans, isValid) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(clean)) !== null) {
    if (isValid !== undefined && !isValid(match[0])) continue;
    spans.push(spanToOriginal(match.index, match.index + match[0].length));
  }
}

function mergeSpans(spans) {
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * 자유 텍스트에서 주민등록번호·전화번호로 보이는 조각을 찾아 가린다.
 *
 * 필드 이름으로는 마스커를 고를 수 없는 memo·note 같은 값에 쓴다. 아무것도 찾지
 * 못하면 null 을 돌려준다 — 호출하는 쪽에서 경고를 붙일지 판단하는 신호로 쓴다.
 *
 * **찾은 구간만 가리고 나머지는 원문 그대로 둔다.** foldForScan() 이 만든 clean
 * 문자열(전각 숫자·대시류·공백류를 접은 사본)에서 패턴을 찾되, 실제로 가릴 때는
 * spanToOriginal() 로 원문의 자리를 되짚어 그 구간만 자리표시자로 바꾼다. 예전에는
 * 정규화한 문자열 전체를 돌려줘서 "①"→"1", "㎏"→"kg" 처럼 민감정보가 아닌 표기까지
 * 바뀌어 나갔다.
 *
 * @param {string} text
 * @returns {string|null}
 */
function maskFreeText(text) {
  const { clean, spanToOriginal } = foldForScan(text);
  const spans = [];

  collectSpans(clean, RESIDENT_NUMBER_SEPARATED_PATTERN, spanToOriginal, spans, looksLikeResidentNumber);
  collectSpans(clean, RESIDENT_NUMBER_GLUED_PATTERN, spanToOriginal, spans, looksLikeResidentNumber);
  collectSpans(clean, PHONE_IN_TEXT, spanToOriginal, spans);

  if (spans.length === 0) return null;

  let result = text;
  for (const span of mergeSpans(spans).reverse()) {
    result = result.slice(0, span.start) + "*".repeat(span.end - span.start) + result.slice(span.end);
  }
  return result;
}

/**
 * 자유 텍스트 스캔의 숫자 버전. memo 필드가 문자열이 아니라 숫자·bigint 로 올 때 쓴다.
 *
 * 하이픈 같은 구분자가 원래 없으므로 PHONE_IN_TEXT 를 그대로 쓸 수 없다. 자릿수와
 * 접두사만 본다.
 *
 * @param {number|bigint} value
 * @returns {string|null}
 */
function maskFreeNumber(value) {
  const digits = String(value);
  if (digits.length === 13 && looksLikeResidentNumber(digits)) return "*".repeat(digits.length);
  if (PHONE_DIGITS_ONLY.test(digits)) return "*".repeat(digits.length);
  return null;
}

// 정상적으로 마스킹된 값에는 원문 조각(생년월일, 뒤 네 자리, 도메인 등)이 남는다.
// 값 전체가 '*' 뿐이면 형식을 못 알아봐서 마스커가 통째로 가린 것이다 — maskAddress 가
// 못 알아본 주소를 "****" 로 통째로 가리는 것과 같은 실패 방향이다. 이때는 무엇을
// 저장했는지 알 수 없으므로 사람이 직접 확인하라고 경고한다.
function isFullyMasked(value) {
  return typeof value === "string" && value.length > 0 && /^\*+$/.test(value);
}

// Object.create(null) 로 만든 사전과 보통의 { } 객체만 "레코드"로 본다. Date·Map·Set·
// Buffer·직접 만든 클래스 인스턴스는 필드가 아니라 값 하나다 — 그 안을 필드처럼
// 순회하면 Date 가 { } 로, Buffer 가 숫자 배열로 뭉개진다.
function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const MAX_DEPTH = 6;

// 이미 마스킹한(혹은 마스킹 중인) 객체·배열을 다시 마주쳤을 때 쓴다.
//   cache      원본 참조 → (그 자리의 마스커 → 마스킹 완료된 사본). 같은 객체가 두
//              필드에서 공유되면(const c = {...}; {a: c, b: c}) 두 번 계산하지 않고
//              같은 사본을 돌려준다 — 원본을 그대로 돌려주면 b 자리로 가려지지 않은
//              값이 새어 나간다. 마스커까지 키에 넣는 이유는, 같은 배열이 한쪽은
//              이름 필드("name": arr)로, 다른 쪽은 태그 필드("tags": arr)로 쓰일 때
//              적용해야 할 정책이 서로 다르기 때문이다 — 값만으로 캐싱하면 먼저 계산된
//              쪽의 결과(마스킹됐거나 안 됐거나)를 정책이 다른 자리에 그대로 돌려주게 된다.
//   inProgress 지금 이 호출 스택에서 마스킹하는 중인 원본. 순환 참조(record.self = record)
//              를 만나면 여기 걸린다 — 원본을 그대로 돌려주면 util.inspect·구조적 복제·
//              로거가 원본까지 따라가 민감정보를 그대로 보여준다. 순환은 마스커와 무관하게
//              같은 원본을 다시 만난 것 자체가 문제이므로 값만으로 판단한다.
function maskContainer(key, value, masker, ctx, depth, isArrayLike) {
  if (ctx.inProgress.has(value)) {
    ctx.warnings.push(`${key} 값에 순환 참조가 있어 가렸다`);
    return "[순환참조]";
  }
  const cachedByMasker = ctx.cache.get(value);
  if (cachedByMasker !== undefined && cachedByMasker.has(masker)) return cachedByMasker.get(masker);
  if (depth > MAX_DEPTH) {
    ctx.warnings.push(`${key} 값이 너무 깊게 중첩되어 있어 통째로 가렸다`);
    return "****";
  }

  if (masker !== undefined) {
    // 알려진 필드인데 값이 문자열이 아니라 객체/배열이다. name.first 처럼 하위 필드가
    // 무엇을 뜻하는지 이 함수는 알 길이 없다 — 잘못 짐작해서 반쪽만 가리느니
    // 통째로 가린다. 배열이면 원소가 전부 문자열/숫자(그 필드의 마스커가 그대로
    // 통하는 값)일 때만 예외로 각 원소에 마스커를 적용한다("phones": [...] 같은 경우).
    const allLeaves = isArrayLike && value.every((item) => item === null || item === undefined || typeof item !== "object");
    if (!allLeaves) {
      ctx.warnings.push(`${key} 값이 문자열이 아니라 ${isArrayLike ? "배열이라" : "객체라"} 통째로 가렸다`);
      return "****";
    }
  }

  ctx.inProgress.add(value);
  const result = isArrayLike
    ? value.flatMap((item) => {
        if (typeof item === "function") {
          ctx.warnings.push(`${key} 값의 배열 안에 함수가 있어 결과에서 뺐다`);
          return [];
        }
        return [maskField(key, item, masker, ctx, depth + 1)];
      })
    : maskEntries(Object.entries(value), ctx, depth + 1);
  ctx.inProgress.delete(value);
  const variants = cachedByMasker ?? new Map();
  variants.set(masker, result);
  ctx.cache.set(value, variants);
  return result;
}

// 함수 값(특히 toJSON)을 걸러내고 나머지를 마스킹한다.
//
// JSON.stringify 는 값에 toJSON 메서드가 있으면 그 함수를 호출해서 결과를 대신 넣는다.
// 원본 함수를 마스킹된 사본에 그대로 옮기면, 다른 필드는 다 가려졌어도
// JSON.stringify(masked) 한 번에 그 클로저가 쥐고 있던 원본 민감정보가 그대로
// 나온다. util.inspect 도 함수 자체(클로저 포함)를 그대로 보여줄 수 있다 —
// 함수는 통째로 뺀다. maskRecord 도 최상위 필드에 이 함수를 그대로 쓴다 — 중첩된
// 객체와 최상위 레코드가 같은 판단을 따로 두 번 짤 이유가 없다.
//
// onEntry 는 maskRecord 가 필드별 마스커 유무와 마스킹 전후 값을 한 번에 넘겨받으려는
// 훅이다 — 마스커를 여기서 한 번만 계산하고, 호출하는 쪽이 normalizeKey 를 다시 돌려
// 같은 값을 두 번 구하지 않게 한다.
function maskEntries(entries, ctx, depth, onEntry) {
  const result = {};
  for (const [k, v] of entries) {
    if (typeof v === "function") {
      ctx.warnings.push(`${k} 값이 함수라 마스킹된 결과에서 뺐다`);
      continue;
    }
    const masker = MASKERS_BY_KEY[normalizeKey(k)];
    const maskedValue = maskField(k, v, masker, ctx, depth);
    result[k] = maskedValue;
    onEntry?.(k, v, masker, maskedValue);
  }
  return result;
}

function maskField(key, value, masker, ctx, depth) {
  if (value === null || value === undefined) return value;

  if (value instanceof Date) {
    if (masker === undefined) return value; // 필드 이름을 모르면 원자 값으로 보고 손대지 않는다.
    // 알려진 필드인데 문자열도 숫자도 아니다. rrn: new Date(...) 처럼 잘못 채워진
    // 값이다 — 마스커에 그대로 넘기면 String(Date)("Thu Jan 01 1970…")를 흘려보낼
    // 수 있으니 통째로 가린다.
    ctx.warnings.push(`${key} 값이 문자열이나 숫자가 아니라 통째로 가렸다`);
    return "****";
  }

  if (Array.isArray(value)) return maskContainer(key, value, masker, ctx, depth, true);

  if (typeof value === "object") {
    if (!isPlainObject(value)) {
      // Map·Set·Buffer·클래스 인스턴스. 필드처럼 순회하면 형태가 뭉개지고, 그렇다고
      // 원본을 그대로 돌려주면 그 안의 민감정보가 새어 나갈 수 있다 — 통째로 가린다.
      ctx.warnings.push(`${key} 값이 마스킹할 수 없는 객체 형식이라 통째로 가렸다`);
      return "****";
    }
    return maskContainer(key, value, masker, ctx, depth, false);
  }

  if (masker !== undefined) {
    const result = masker(value);
    // 이름은 한 글자여도 "*" 하나로 온전히 가리는 게 정상 동작이다(maskName 참고) —
    // 전부 '*' 라고 형식 실패로 보면 안 된다. 나머지 마스커는 전부 '*' 면 형식을
    // 못 알아봐서 통째로 가린 것이다.
    if (masker !== maskName && isFullyMasked(result) && String(value).trim().length > 0) {
      ctx.warnings.push(`${key} 값이 예상한 형식이 아니어서 전체를 가렸다`);
    }
    return result;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    // resident-number.mjs 의 findResidentNumbers() 는 키 이름 끝이 시간을 가리키면
    // (created_at 등) 오탐 방지로 건너뛰지만, 여기서는 그 판단을 일부러 들여오지 않는다.
    // 관리자 화면에서 값을 보여 주는 쪽은 실수로 섞여 들어간 값을 놓치는 게 더 큰
    // 사고다 — created_at 에 주민등록번호가 잘못 들어갔어도 그대로 가려야 한다.
    const scanned = typeof value === "string" ? maskFreeText(value) : maskFreeNumber(value);
    if (scanned !== null) {
      ctx.warnings.push(`${key} 값에서 민감정보로 보이는 값을 찾아 가렸다`);
      return scanned;
    }
    return value;
  }

  return value; // boolean, symbol 등은 개인정보를 담지 않는다고 보고 손대지 않는다.
}

/**
 * 행 하나를 통째로 마스킹한다.
 *
 * 필드마다 다른 마스커를 써야 하는데, 관리자 화면에서 손으로 고르면 하나를 빠뜨린다.
 * 이름을 알면 마스커도 정해진다. 알려진 필드가 아니어도 값 자체에 주민등록번호나
 * 전화번호가 섞여 있으면(memo, note 등의 자유 텍스트나 숫자 필드) 찾아서 가린다.
 * 중첩된 객체와 배열도 재귀적으로 마스킹하고, 같은 객체를 여러 필드가 공유하거나
 * 순환 참조가 있어도 원본을 그대로 돌려주지 않는다.
 *
 * **한계.** 전화번호나 주민등록번호를 문자열이 아니라 숫자로 저장하면 맨 앞 0 이
 * 이미 파싱 단계에서 사라져 있다. 전화번호는 접두사 모양으로 짐작할 수 있지만,
 * 주민등록번호는 자릿수가 12개로 줄어 다른 12자리 숫자와 구별할 수 없어 놓친다.
 * 애초에 문자열로 저장해야 한다.
 *
 * @param {object} record
 * @returns {{masked: object, warnings: string[]}}
 */
export function maskRecord(record) {
  const isObject = record !== null && typeof record === "object";
  const ctx = { warnings: [], cache: new WeakMap(), inProgress: new WeakSet() };
  const shown = [];

  // 레코드 자신을 먼저 진행 중으로 등록해 둔다. 그래야 record.self = record 처럼
  // 자기 자신을 가리키는 필드를 만났을 때 순환 참조로 바로 걸린다.
  if (isObject) ctx.inProgress.add(record);

  // 최상위 필드도 중첩된 객체와 똑같이 maskEntries 를 거친다 — 함수 값을 거르는 판단을
  // 여기서 따로 다시 짜지 않는다. onEntry 로 마스커 유무와 마스킹 전후 값만 받아 조합
  // 위험(shown) 목록을 만든다.
  const masked = maskEntries(Object.entries(record ?? {}), ctx, 1, (key, value, masker, maskedValue) => {
    if (masker === undefined && IDENTIFYING_TOGETHER.has(normalizeKey(key)) && maskedValue === value) {
      shown.push(key);
    }
  });

  if (isObject) {
    ctx.inProgress.delete(record);
    ctx.cache.set(record, new Map([[undefined, masked]]));
  }

  // 조합 위험을 알려 준다. 필드마다 따로 보면 안전해 보인다.
  if (shown.length >= 2) {
    ctx.warnings.push(`마스킹하지 않은 식별 가능 필드가 ${shown.length}개다: ${shown.join(", ")}. 모이면 특정된다`);
  }

  return { masked, warnings: ctx.warnings };
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
