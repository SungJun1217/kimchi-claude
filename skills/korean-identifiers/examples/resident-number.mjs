// 주민등록번호.
//
// **이 파일에 검증 함수가 없는 것이 요점이다.**
//
// 2020년 10월부터 주민등록번호 뒷자리 중 지역 표시와 검증 번호가 없어지고 임의 번호로
// 발급된다. 그래서 오래 알려진 체크섬 알고리즘은 그 이후 발급된 번호에 통하지 않는다.
// 체크섬으로 검증하는 코드는 **정상 번호를 거부한다.** 한국 코드베이스에 아직 많이 남아
// 있는 버그이고, 새로 짤 때 가장 하기 쉬운 실수다.
//
// 그리고 애초에 저장하지 않는 것이 맞다. 개인정보 보호법은 법령에 근거가 있는 경우로
// 주민등록번호 처리를 제한한다. 근거 없이 수집하면 위법이다.
//
// 대신 이렇게 한다.
//   본인 확인이 필요하면      본인인증 기관의 CI/DI 를 받아 쓴다. 번호 자체를 보관하지 않는다
//   중복 가입을 막으려면      CI(연계정보)로 판단한다
//   나이 확인이 필요하면      생년월일이나 성인 여부만 받는다
//   실명 확인이 필요하면      본인인증 결과만 보관한다
//
// 정말로 법령 근거가 있어 보관해야 하면 암호화가 의무이고, 화면·로그·오류 보고에는
// 마스킹한 값만 나가야 한다. masking.mjs 를 참고할 것.

/**
 * 주민등록번호 형태를 띈 문자열을 찾는 기본 패턴. 검증이 아니라 탐지용이고, 하이픈이나
 * 공백 정도의 흔한 표기만 받는다.
 *
 * \b 를 쓰지 않는다. 밑줄을 단어 문자로 보기 때문에 `order_9001011234567` 같은 식별자
 * 안에서 매치가 일어난다. 앞뒤 경계를 직접 본다.
 *
 * 전각 숫자와 전각 하이픈도 받는다. 한글 문서에서 복사한 번호가 그렇게 온다.
 * `\d` 는 ASCII 숫자만 받아서 전각이 한 글자만 섞여도 탐지를 빠져나간다.
 *
 * 실전 탐지(붙여넣기에 섞이는 보이지 않는 서식 문자, en-dash 같은 대시 변종, 타임스탬프
 * 오탐 방지)는 이 패턴 하나로는 부족해서 findResidentNumbers() 가 따로 처리한다.
 *
 * 구분자는 findResidentNumbers() 의 SEP 와 같은 규칙이다 — 대시(전각 포함) 앞뒤로
 * 공백 0~1개, 또는 공백만 1~2개. 둘이 다르면 이 패턴만 보고 따라 짠 코드가 실제
 * 탐지와 다르게 동작한다.
 */
export const RESIDENT_NUMBER_PATTERN =
  /(?<![0-9０-９A-Za-z_])[0-9０-９]{6}(?: ?[-－] ?| {1,2})[1-8１-８][0-9０-９]{6}(?![0-9０-９A-Za-z_])/g;

// 전각 숫자를 반각으로 되돌리고 숫자만 남긴다.
const digitsOf = (value) => String(value ?? "").normalize("NFKC").replace(/\D/g, "");

// 눈에 안 보이는 서식 문자. 붙여넣기 과정에서 숫자 사이에 흔히 섞인다.
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0x00ad, 0xfeff]);

// 대시류 문자를 전부 '-' 로 접는다. en-dash·em-dash·전각 하이픈까지 실제로 온다.
const DASH_LIKE = new Set([0x002d, 0xff0d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212, 0xfe63]);

// 탭·NBSP·표의문자 공백을 보통 공백 하나로 접는다. 탭은 ASCII 지만 구분자로 안
// 쳐 주면 놓치므로 여기서 접어야 한다.
// \s 가 받던 공백은 모두 받는다. 처음에 탭·NBSP·U+3000 만 넣었다가 엔 스페이스(U+2002),
// 가는 공백(U+2009), 좁은 NBSP(U+202F), 세로 탭, 폼 피드를 쓴 번호를 놓쳤다.
const SPACE_LIKE = new Set([
  0x09, 0x0b, 0x0c, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

// 아라비아 숫자(٠-٩)는 NFKC 로 안 접힌다. 전각·수학 굵은 숫자는 NFKC 가 접어 준다.
function foldDigit(codePoint, char) {
  if (codePoint >= 0x0660 && codePoint <= 0x0669) return String(codePoint - 0x0660);
  const folded = char.normalize("NFKC");
  return /^[0-9]$/.test(folded) ? folded : null;
}

// 이 문자들이 없으면 원문을 그대로 써도 결과가 같다 — 한글 문서든 순수 아스키든
// 코드 포인트 배열을 새로 만들 필요가 없다. 서로게이트 쌍(이모지 등)이 하나라도
// 있으면 그 뒤로 코드 포인트 색인과 UTF-16 색인이 어긋나므로 느린 경로로 보낸다.
const NEEDS_FOLD = new RegExp(
  "[\\t\\v\\f\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\u200B\\u200C\\u200D\\u2060\\u00AD\\uFEFF" +
    "\\uFF0D\\u2010\\u2011\\u2012\\u2013\\u2014\\u2212\\uFE63" +
    "\\uFF10-\\uFF19\\u0660-\\u0669\\uD800-\\uDBFF]"
);

function buildClean(line) {
  if (!NEEDS_FOLD.test(line)) return { chars: null, clean: line, map: null };
  const chars = Array.from(line);
  let clean = "";
  const map = [];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const cp = ch.codePointAt(0);
    if (ZERO_WIDTH.has(cp)) continue;
    let rep = ch;
    if (DASH_LIKE.has(cp)) rep = "-";
    else if (SPACE_LIKE.has(cp)) rep = " ";
    else {
      const digit = foldDigit(cp, ch);
      if (digit !== null) rep = digit;
    }
    // UTF-16 단위로 훑는다. 정규식 index 가 그 단위라 clean/map 길이가 맞아야 한다.
    for (let u = 0; u < rep.length; u += 1) {
      clean += rep[u];
      map.push(i);
    }
  }
  return { chars, clean, map };
}

/**
 * 원문을 탐지용으로 접되(보이지 않는 문자 제거, 대시류·공백류·숫자류 정규화),
 * 접은 문자열(clean) 안의 위치를 원문의 실제 위치로 되짚을 수 있게 해 준다.
 *
 * 주민등록번호 말고 다른 패턴(전화번호 등)도 같은 접기 규칙으로 찾고, 찾은 자리를
 * **원문 그대로**에서 가려야 할 때 쓴다 — clean 문자열을 그대로 돌려주면 원문에만
 * 있던 표기(리가처, 로마 숫자, 단위 기호 등)가 관계없는 자리까지 바뀌어 나간다.
 *
 * @param {string} text
 * @returns {{clean: string, spanToOriginal(cleanStart: number, cleanEnd: number): {start: number, end: number}}}
 */
export function foldForScan(text) {
  const { chars, clean, map } = buildClean(text);

  function spanToOriginal(cleanStart, cleanEnd) {
    // 접을 게 없었으면(chars === null) clean 이 원문 그대로라 위치도 그대로 맞는다.
    if (chars === null) return { start: cleanStart, end: cleanEnd };
    const startCodePoint = map[cleanStart];
    const endCodePoint = map[cleanEnd - 1] + 1;
    const start = chars.slice(0, startCodePoint).join("").length;
    const end = start + chars.slice(startCodePoint, endCodePoint).join("").length;
    return { start, end };
  }

  return { clean, spanToOriginal };
}

// 점·밑줄·슬래시는 실측 후 뺐다 — 부동소수점, 날짜/번호 나열, `ORD_`·`IMG_` 류
// 식별자와 겹친다. hooks/lib/pii.mjs 의 SEP 설명을 참고할 것.
const SEP = "(?: ?- ?| {1,2})";
// 숫자 뒤의 '.' 만 소수점으로 보고 거른다. 글자 뒤의 '.' 는 문장부호일 뿐이라
// ("No.900101-1234567") 앞자리 숫자를 막지 않는다. hooks/lib/pii.mjs 와 같다.
const CANDIDATE_SEPARATED = new RegExp(`(?<![0-9])(?<![0-9]\\.)([0-9]{6})${SEP}([1-8][0-9]{6})(?![0-9A-Za-z_])`, "g");
const CANDIDATE_GLUED = /(?<![0-9A-Za-z_.])([0-9]{6})([1-8][0-9]{6})(?![0-9A-Za-z_])/g;

// 구분자 없이 붙은 13자리("9001011234567", "주민번호9001011234567"). RESIDENT_NUMBER_PATTERN
// 은 구분자가 있는 형태만 잡는다 — 자유 텍스트에서는 구분자 없이 그대로 붙여 넣는
// 경우도 흔해서 따로 둔다. foldForScan() 이 돌려준 clean 문자열에만 쓴다(원문에
// 전각 숫자가 섞이면 이 패턴의 [0-9] 로는 못 잡는다). 식별자 속(`order_9001011234567`)
// 이나 소수점 뒤(`0.9001011234567`)에서는 잡지 않는다 — CANDIDATE_GLUED 와 같은 이유다.
// CANDIDATE_GLUED 의 캡처 그룹을 그대로 물려받지만(.source), 매치 결과에는 영향이 없다.
export const RESIDENT_NUMBER_GLUED_PATTERN = new RegExp(CANDIDATE_GLUED.source, "g");

// 구분자가 있는 형태를 탐지기(findResidentNumbers)와 똑같은 경계로 잡는다. 가리는 쪽이
// 따로 패턴을 두면 "ID900101-1234567"처럼 탐지기는 잡는데 마스킹은 놓치는 틈이 생긴다.
// foldForScan() 이 돌려준 clean 문자열에만 쓴다. lastIndex 를 탐지기와 나눠 쓰지 않도록
// 따로 만든다.
export const RESIDENT_NUMBER_SEPARATED_PATTERN = new RegExp(CANDIDATE_SEPARATED.source, "g");

// 콜론/대입 바로 앞의 키 이름 자체가 시간을 가리킬 때만 타임스탬프로 보고 넘어간다.
// 줄 전체에 시간 낱말이 있다는 것만으로는 부족하다 — 그러면 같은 줄의 다른 필드
// 때문에 rrn 자신이 빠져나간다. ms 와 맨 ts 는 너무 흔해서 뺐다(ts 는 키 전체가
// 정확히 "ts" 일 때만 인정).
// 키 이름 끝만 본다. 낱말 뒤 꼬리는 시간 필드에서 실제로 쓰는 것만 받는다.
// 꼬리를 아무 글자나 받자 dateOfBirth·date_of_birth 가 시간 키로 빠져나갔고,
// 대소문자를 무시하자 lat·format 처럼 at 으로 끝나는 키가 모두 빠져나갔다.
// 생년월일 필드는 주민등록번호가 붙여 넣어지는 바로 그 자리라 birth 가 든 키는 예외가 아니다.
const TIME_KEY_WORD = /^(?:time|date|timestamp|stamp|epoch|created|updated|expires|modified|issued|deleted)(?:_?(?:at|on|ms|time|stamp|utc))?$/i;
const TIME_KEY_CAMEL_AT = /^[a-z][A-Za-z0-9]*At$/;
const TIME_KEY_SNAKE_AT = /^[a-z0-9_]+_at$/i;

function isTimeLikeKey(before) {
  const key = before.match(/[A-Za-z0-9_]+$/)?.[0];
  if (!key || /birth/i.test(key)) return false;
  return TIME_KEY_WORD.test(key) || TIME_KEY_CAMEL_AT.test(key) || TIME_KEY_SNAKE_AT.test(key) || /^ts$/i.test(key);
}

function keyBeforeIsTimeLike(clean, matchIndex) {
  let i = matchIndex - 1;
  while (i >= 0 && clean[i] === " ") i -= 1;
  if (i >= 0 && (clean[i] === '"' || clean[i] === "'")) i -= 1;
  if (i < 0 || (clean[i] !== ":" && clean[i] !== "=")) return false;
  i -= 1;
  while (i >= 0 && clean[i] === " ") i -= 1;
  if (i >= 0 && (clean[i] === '"' || clean[i] === "'")) i -= 1;
  return isTimeLikeKey(clean.slice(0, i + 1));
}

function scanLine(rawLine) {
  const { clean } = buildClean(rawLine);
  const results = [];

  CANDIDATE_SEPARATED.lastIndex = 0;
  let match;
  while ((match = CANDIDATE_SEPARATED.exec(clean)) !== null) {
    if (!looksLikeResidentNumber(match[0])) continue;
    results.push(match[0]);
  }

  CANDIDATE_GLUED.lastIndex = 0;
  while ((match = CANDIDATE_GLUED.exec(clean)) !== null) {
    if (!looksLikeResidentNumber(match[0])) continue;
    if (keyBeforeIsTimeLike(clean, match.index)) continue;
    results.push(match[0]);
  }

  return results;
}

// 뒷자리 맨 앞 숫자(성별·세기 표시)가 가리키는 출생 세기. 1/2 는 1900년대,
// 3/4 는 2000년대(내국인). 5/6·7/8 은 외국인 표시로 같은 세기를 가리킨다.
const CENTURY_BASE = { 1: 1900, 2: 1900, 3: 2000, 4: 2000, 5: 1900, 6: 1900, 7: 2000, 8: 2000 };

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return DAYS_IN_MONTH[month - 1];
}

/**
 * 형식만 확인한다. 유효한 번호인지는 알 수 없다.
 *
 * 쓸 자리는 하나다. 사용자가 입력란을 잘못 채웠을 때 즉시 알려 주는 것.
 * 이 함수가 true 를 준다고 실제로 존재하는 번호는 아니다.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeResidentNumber(value) {
  const digits = digitsOf(value);
  if (digits.length !== 13) return false;

  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  const genderDigit = Number(digits[6]);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  // 1~4 는 내국인, 5~8 은 외국인. 9·0 은 1900년 이전 출생으로 현재는 사실상 없다.
  if (genderDigit < 1 || genderDigit > 8) return false;

  // 2월 30일처럼 형식은 맞아도 실재하지 않는 날짜는 거른다. 2월 29일은 세기 자리로
  // 정해지는 실제 연도가 윤년일 때만 인정한다.
  const year = CENTURY_BASE[genderDigit] + Number(digits.slice(0, 2));
  return day <= daysInMonth(year, month);
}

/**
 * 성별과 출생 연도를 뽑는다. 나이 확인에만 쓰고 번호는 버린다.
 *
 * @param {string} value
 * @returns {{birthYear: number, century: number}|null}
 */
export function birthYearOf(value) {
  const digits = digitsOf(value);
  if (!looksLikeResidentNumber(digits)) return null;

  const genderDigit = Number(digits[6]);
  const century = CENTURY_BASE[genderDigit];
  return { birthYear: century + Number(digits.slice(0, 2)), century };
}

/**
 * 글에 주민등록번호로 보이는 것이 섞여 있는지 찾는다.
 *
 * 로그, 오류 보고, 커밋 메시지, 시험 자료에 실수로 들어가는 것을 막는 데 쓴다.
 * 시험 자료에 실제 번호를 쓰지 말 것. 형식만 맞는 가짜 번호를 쓴다.
 *
 * @param {string} text
 * @returns {string[]} 찾은 문자열들
 */
export function findResidentNumbers(text) {
  if (typeof text !== "string") return [];
  // 형태만 맞는 것을 모두 보고하면 주문번호와 타임스탬프가 섞인다.
  // 앞 6자리가 말이 되는 생년월일인지까지 보면 오탐이 크게 줄어든다.
  return text.split("\n").flatMap((line) => scanLine(line));
}
