// 산출물에 섞인 주민등록번호를 찾는다.
//
// 말투 린터와 목적이 다르다. 말투는 고치면 되지만 주민등록번호는 한 번 푸시되면
// 커밋을 지워도 사라지지 않는다. 그래서 대상이 넓고(모든 파일) 기본 동작이 차단이다.
//
// 오탐을 줄이는 것이 이 파일의 절반이다. 13자리 숫자는 주문번호일 수도 있다.
// 패턴만으로 막으면 정상 작업을 방해하고, 그러면 사람들이 훅을 끈다.

// 눈에 안 보이는 서식 문자. ZWSP·ZWNJ·ZWJ·단어 결합자·소프트 하이픈·BOM 이 숫자
// 사이에 끼어도 번호가 끊긴 것으로 보면 안 된다 — 붙여넣기·복사 과정에서 흔히 섞인다.
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0x00ad, 0xfeff]);

// 대시류 문자를 전부 하나의 표시로 접는다. en-dash·em-dash·figure dash·마이너스
// 기호·전각 하이픈까지 실제로 붙여넣기에서 나온다.
const DASH_LIKE = new Set([0x002d, 0xff0d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2212, 0xfe63]);

// 탭·NBSP·표의문자 공백처럼 시각적으로 빈칸인 문자를 보통 공백 하나로 접는다.
// 탭은 ASCII 지만 SEP 이 아는 공백이 아니라서 여기서 접어 줘야 구분자로 인식된다.
// \s 가 받던 공백은 모두 받는다. 처음에 탭·NBSP·U+3000 만 넣었다가 엔 스페이스(U+2002),
// 가는 공백(U+2009), 좁은 NBSP(U+202F), 세로 탭, 폼 피드를 쓴 번호를 놓쳤다.
const SPACE_LIKE = new Set([
  0x09, 0x0b, 0x0c, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

// 아라비아 숫자(٠-٩, U+0660~0669)는 NFKC 로 안 접힌다 — 별도 문자 계열이라 호환
// 분해 매핑이 없다. 전각 숫자와 수학 굵은 숫자(𝟎-𝟗 등)는 NFKC 가 접어 준다.
function foldDigit(codePoint, char) {
  if (codePoint >= 0x0660 && codePoint <= 0x0669) return String(codePoint - 0x0660);
  const folded = char.normalize("NFKC");
  return /^[0-9]$/.test(folded) ? folded : null;
}

// 이 문자들이 하나도 없으면 원문을 그대로 훑어도 결과가 같다 — 코드 포인트 배열을
// 만들 필요가 없다. 한글 문서, 코드, 로그, CSV 는 거의 다 여기 걸린다(아스키뿐이든
// 한글이 섞여 있든, BMP 안이면 코드 포인트 색인과 UTF-16 색인이 같다). 서로게이트
// 쌍(이모지, 수학 굵은 숫자 등 U+10000 이상)이 하나라도 있으면 그 뒤로 두 색인이
// 어긋나므로 — 접을 필요가 없는 이모지라도 — 무조건 느린 경로로 보낸다.
const NEEDS_FOLD = new RegExp(
  "[\\t\\v\\f\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\u200B\\u200C\\u200D\\u2060\\u00AD\\uFEFF" +
    "\\uFF0D\\u2010\\u2011\\u2012\\u2013\\u2014\\u2212\\uFE63" +
    "\\uFF10-\\uFF19\\u0660-\\u0669\\uD800-\\uDBFF]"
);

/**
 * 줄 하나를 검사용으로 다듬는다. 보이지 않는 서식 문자를 지우고, 대시류를 '-' 로,
 * 공백류를 ' ' 로, 숫자류를 ASCII 숫자로 접는다. 반환하는 map[i] 는 clean[i] 에
 * 대응하는 원문의 코드 포인트 색인이다 — 이모지 같은 서로게이트 쌍 앞에서도 열
 * 번호가 코드 포인트 기준으로 맞도록 원문을 코드 포인트 단위로 훑는다.
 *
 * @param {string} line
 * @returns {{chars: string[]|null, clean: string, map: number[]|null}}
 */
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
    if (DASH_LIKE.has(cp)) {
      rep = "-";
    } else if (SPACE_LIKE.has(cp)) {
      rep = " ";
    } else {
      const digit = foldDigit(cp, ch);
      if (digit !== null) rep = digit;
    }
    // rep 를 코드 포인트가 아니라 UTF-16 단위로 훑는다. 정규식 .exec() 의 index 는
    // UTF-16 단위 오프셋이라, clean 과 map 의 길이가 그 단위로 맞아야 한다 — 그래야
    // 이모지처럼 원문에 그대로 남는 서로게이트 쌍 앞에서 열 번호가 밀리지 않는다.
    for (let u = 0; u < rep.length; u += 1) {
      clean += rep[u];
      map.push(i);
    }
  }
  return { chars, clean, map };
}

// 일반 텍스트(파일 내용·편집 조각·커밋 메시지)에서 구분자가 있는 형태. 대시(위에서
// 이미 '-' 로 접힘) 앞뒤로 공백 0~1개, 또는 공백만 1~2개. 앞은 letter 를 막지 않는다
// — `x900101-1234567` 처럼 글자 뒤에 와도 구분자가 있으면 숫자만으로 된 식별자와
// 헷갈릴 일이 없다.
//
// 점·밑줄·슬래시는 실측 후 뺐다. 점은 6자리.7자리로 맞춰진 부동소수점(좌표, 정밀
// 금액)과 겹치고, 슬래시는 `240101/1234567` 같은 날짜/번호 나열과, 밑줄은
// `ORD_900101_1234567`·`IMG_900101_1234567` 같은 흔한 식별자와 겹친다. 앞에 글자가
// 없는 경우(예: 파일 맨 앞 슬래시 구분)까지 걸러내려면 검사가 더 복잡해지는데,
// 그 복잡도를 감수할 만큼 이 세 구분자가 실제 유출 경로로 관찰되지 않았다. 대시와
// 공백만 남긴다.
const SEP = "(?: ?- ?| {1,2})";
// 숫자 뒤의 '.' 만 소수점으로 보고 거른다("1.900101-1234567"). 글자 뒤의 '.' 는
// 문장부호일 뿐이라("주민번호 No.900101-1234567", "…번호.900101-1234567") 앞자리
// 숫자를 막지 않는다 — 실측된 오탐 경로(숫자.숫자)만 막고 실측된 미탐(글자.숫자)은 살린다.
const CANDIDATE_SEPARATED = new RegExp(
  `(?<![0-9])(?<![0-9]\\.)([0-9]{6})${SEP}([1-8][0-9]{6})(?![0-9A-Za-z_])`,
  "g"
);

// 구분자 없이 붙은 13자리. 식별자 속(`order_9001011234567`)이나 소수점 뒤
// (`0.9001011234567`)에서는 잡지 않는다 — 둘 다 실측된 오탐 경로다.
const CANDIDATE_GLUED = /(?<![0-9A-Za-z_.])([0-9]{6})([1-8][0-9]{6})(?![0-9A-Za-z_])/g;

// 파일 경로 전용. 대시 구분자만 인정하고(밑줄·슬래시·붙은 형태는 아예 안 본다 —
// 파일 이름·디렉터리 관례가 그 구분자를 흔히 쓴다), 앞에 글자·숫자·밑줄·점이 있으면
// 식별자의 일부로 보고 제외한다. `backup_250101_1234567.sql`, `IMG_900101_1234567.jpg`,
// `logs/240101/1234567.log`, `reports/2501011234567.csv` 는 모두 여기 안 걸린다.
// `/tmp/run-250102-1034567/` 처럼 정말 대시로만 이어진 6자리-7자리는 여전히 걸린다
// — 그 모양 자체가 주민등록번호와 구별이 안 되기 때문에 받아들인다. 걸리면
// kimchi-allow-rrn 대신 파일·폴더 이름을 바꾸는 수밖에 없다(메시지에서 안내한다).
const PATH_CANDIDATE = /(?<![0-9A-Za-z_.])([0-9]{6}) ?- ?([1-8][0-9]{6})(?![0-9A-Za-z_])/g;

// 유닉스 밀리초 타임스탬프는 13자리이고, 앞 6자리가 우연히 월·일 범위에 들어가는
// 경우가 있다(2020~2021년대가 특히 그렇다). 예외로 치려면 콜론/대입 바로 앞의
// **키 이름 자체**가 시간을 가리켜야 한다 — 줄 전체에 시간 낱말이 있다는 것만으로는
// 부족하다. 안 그러면 `{"rrn": "...", "created_at": "..."}` 처럼 같은 줄에 있는
// 다른 필드의 낱말 때문에 rrn 자신이 빠져나간다(실측된 회귀). ms 와 맨 ts 는 너무
// 흔한 substring 이라 뺐다 — ts 는 키 전체가 정확히 "ts" 일 때만 인정한다.
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

// 이 표시가 있는 줄은 넘어간다. 형식만 맞는 가짜 번호를 자료로 써야 할 때가 있다.
const ALLOW_LINE = /kimchi-allow-rrn/;

// 통째로 생성되는 파일. 확장자가 .json 이라 확장자 목록으로는 걸러지지 않는다.
export const GENERATED_FILES = /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|go\.sum)$/;

// 뒷자리 맨 앞 숫자(성별·세기 표시)가 가리키는 출생 세기. 1/2 는 1900년대 내국인,
// 3/4 는 2000년대 내국인, 5/6 은 1900년대 외국인, 7/8 은 2000년대 외국인,
// 9/0 은 1800년대다(9/0 은 CANDIDATE_* 정규식이 [1-8]만 받으므로 현재 입력에는
// 나오지 않지만, 함수 자체는 실제 부여 규칙을 그대로 옮겨 둔다).
const CENTURY_BASE = { 1: 1900, 2: 1900, 3: 2000, 4: 2000, 5: 1900, 6: 1900, 7: 2000, 8: 2000, 9: 1800, 0: 1800 };

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return DAYS_IN_MONTH[month - 1];
}

/**
 * 뒷자리가 임의 발급이라 검증은 못 한다. 앞자리의 생년월일이 실제로 있는 날짜인지만 본다.
 *
 * 이 검사로 오탐이 크게 줄어든다. 임의의 13자리 숫자가 앞 6자리에서 실재하는
 * 연월일을 동시에 만족할 확률은 낮다. 2월 29일은 윤년에만 인정한다 — 세기는
 * 뒷자리 첫 숫자(성별 표시)로 정해진다.
 *
 * @param {string} front 앞 6자리(clean 문자열에서 뽑혀 이미 ASCII 숫자다)
 * @param {string} genderDigit 뒷자리 맨 앞 숫자
 * @returns {boolean}
 */
function plausibleBirthDate(front, genderDigit) {
  const month = Number(front.slice(2, 4));
  const day = Number(front.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const base = CENTURY_BASE[genderDigit];
  if (base === undefined) return false;
  const year = base + Number(front.slice(0, 2));

  return day <= daysInMonth(year, month);
}

/**
 * 매치 바로 앞(공백·따옴표는 건너뛴다)이 `:` 나 `=` 이고, 그 콜론/대입 앞의 키
 * 이름 자체가 시간을 가리키는지 본다. clean 문자열 안에서만 본다 — 키 이름은
 * 글자라 접기 대상이 아니므로 원문과 위치가 같다.
 *
 * @param {string} clean
 * @param {number} matchIndex clean 안에서 매치가 시작하는 자리
 * @returns {boolean}
 */
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

/**
 * 한 줄에서 후보를 찾는다.
 *
 * @param {string} rawLine
 * @param {boolean} pathOnly 파일 경로 전용 규칙(대시만, 붙은 형태는 안 봄)을 쓸지
 * @returns {{matched: string, codePointIndex: number, length: number}[]}
 */
function scanLine(rawLine, pathOnly) {
  const { chars, clean, map } = buildClean(rawLine);
  const results = [];

  function push(match) {
    const startClean = match.index;
    const endClean = match.index + match[0].length - 1;
    const codePointIndex = map ? map[startClean] : startClean;
    const endCodePoint = (map ? map[endClean] : endClean) + 1;
    results.push({ matched: match[0], codePointIndex, length: endCodePoint - codePointIndex });
  }

  const sepRegex = pathOnly ? PATH_CANDIDATE : CANDIDATE_SEPARATED;
  sepRegex.lastIndex = 0;
  let match;
  while ((match = sepRegex.exec(clean)) !== null) {
    if (!plausibleBirthDate(match[1], match[2][0])) continue;
    push(match);
  }

  if (!pathOnly) {
    CANDIDATE_GLUED.lastIndex = 0;
    while ((match = CANDIDATE_GLUED.exec(clean)) !== null) {
      if (!plausibleBirthDate(match[1], match[2][0])) continue;
      if (keyBeforeIsTimeLike(clean, match.index)) continue;
      push(match);
    }
  }

  return results;
}

/**
 * 글에서 주민등록번호로 보이는 것을 찾는다.
 *
 * @param {string} text
 * @param {{pathOnly?: boolean}} [options] pathOnly 면 파일 경로 전용 규칙을 쓴다
 *   (대시로 이은 형태만, 앞에 글자·숫자·밑줄·점이 없을 때만 — 파일 이름 관례에서
 *   나는 오탐을 줄인다).
 * @returns {{matched: string, line: number, column: number, length: number}[]}
 */
export function findResidentNumbers(text, options = {}) {
  if (typeof text !== "string" || text.length === 0) return [];
  const pathOnly = Boolean(options.pathOnly);

  const found = [];
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (ALLOW_LINE.test(line)) continue;

    for (const hit of scanLine(line, pathOnly)) {
      found.push({ matched: hit.matched, line: index + 1, column: hit.codePointIndex + 1, length: hit.length });
    }
  }

  return found;
}

/**
 * 가릴 수 있는 형태로 바꿔 보여 준다.
 *
 * 경고 메시지에 번호를 그대로 실으면 훅이 유출 경로가 된다.
 *
 * @param {string} value
 * @returns {string}
 */
export function redact(value) {
  const digits = String(value).normalize("NFKC").replace(/\D/g, "");
  if (digits.length !== 13) return "*".repeat(String(value).length);
  return `${digits.slice(0, 6)}-*******`;
}

/**
 * 경고 메시지 자체(파일 경로 같은 대상 이름)에 주민등록번호로 보이는 값이 섞여 있으면
 * 가린다. 훅이 대상 이름을 그대로 되읊으면서 유출 경로가 되는 것을 막는다.
 *
 * hit.length(원문 코드 포인트 길이)로 잘라낸다 — 매치 안에 보이지 않는 서식 문자가
 * 있었으면 clean 문자열에서 뽑은 matched 보다 원문 구간이 더 길어서, matched 길이만
 * 지우면 뒷부분 숫자가 그대로 남는다.
 *
 * @param {string} text
 * @param {{pathOnly?: boolean}} [options]
 * @returns {string}
 */
export function redactText(text, options = {}) {
  if (typeof text !== "string" || text.length === 0) return text;
  const found = findResidentNumbers(text, options);
  if (found.length === 0) return text;

  const chars = Array.from(text);
  // 뒤에서부터 갈아 끼워야 앞쪽 자리(코드 포인트 색인)가 밀리지 않는다.
  for (const hit of [...found].sort((a, b) => b.column - a.column)) {
    const start = hit.column - 1;
    chars.splice(start, hit.length, redact(hit.matched));
  }
  return chars.join("");
}

// 한 건에 줄 40바이트 안팎이다. 한도 없이 다 나열하면 메시지가 유출 건수에 비례해
// 커진다 — 2000건짜리 CSV 하나로 훅 출력이 수십 KB 가 된다. 목록은 앞쪽 몇 건만
// 보여 주고 나머지는 건수로만 말한다. 첫 문장의 전체 건수는 그대로 정확하다.
const MAX_LISTED = 20;

/** 몇 번째 편집의 몇 번째 줄 몇 칸인지 말해 준다. Edit/MultiEdit 은 파일 전체가 아니라
 * 넘어온 조각(new_string) 안에서만 줄·칸을 셀 수 있어 "새 텍스트 기준"임을 밝힌다. */
function locationOf(hit) {
  if (hit.kind === "path") return `경로 ${hit.column}칸`;
  const editPart = Number.isInteger(hit.editIndex) ? `${hit.editIndex + 1}번째 편집 ` : "";
  const relative = hit.kind === "edit" ? "새 텍스트 기준 " : "";
  return `${editPart}${relative}${hit.line}번째 줄 ${hit.column}칸`;
}

/**
 * 상황에 맞는 할 일을 고른다. 경로에서 찾았으면 kimchi-allow-rrn 안내가 쓸모없다
 * — 파일 경로에는 주석을 못 붙인다. 대신 이름을 바꾸라고 말한다.
 */
function adviceLines(found) {
  const hasPathHit = found.some((hit) => hit.kind === "path");
  const hasTextHit = found.some((hit) => hit.kind !== "path");
  const lines = [];
  if (hasTextHit) {
    lines.push("- 시험 자료라면 형식만 맞는 가짜 번호를 쓰고, 그 줄에 kimchi-allow-rrn 주석을 붙이십시오.");
  }
  if (hasPathHit) {
    lines.push("- 파일·폴더 이름에서 났습니다. 경로에는 kimchi-allow-rrn 표시를 붙일 수 없으니 이름을 바꾸십시오.");
  }
  lines.push("- 실제 값이라면 지우십시오. 주민등록번호는 법령에 근거가 없으면 수집·보관할 수 없습니다.");
  lines.push("- 본인 확인이 목적이라면 본인인증 기관의 CI 를 쓰십시오. korean-identifiers 스킬을 참고하십시오.");
  return lines;
}

/**
 * 사람이 읽을 경고를 만든다.
 *
 * @param {{matched: string, line: number, column: number, kind?: string, editIndex?: number}[]} found
 * @param {string} label 검사 대상 이름
 * @returns {string}
 */
export function formatLeak(found, label = "") {
  if (found.length === 0) return "";

  const where = label ? `${label}에서 ` : "";
  const listed = found.slice(0, MAX_LISTED);
  const rest = found.length - listed.length;
  const lines = [
    `${where}주민등록번호로 보이는 값 ${found.length}건을 찾았습니다. 저장소에 남으면 커밋을 지워도 사라지지 않습니다.`,
    "",
    ...listed.map((hit) => `- ${locationOf(hit)}: ${redact(hit.matched)}`),
    ...(rest > 0 ? [`- 외 ${rest}건`] : []),
    "",
    "할 일:",
    ...adviceLines(found),
  ];

  return lines.join("\n");
}

// 이 확장자는 검사하지 않는다. 사람이 쓴 것이 아니거나 통째로 생성된 것들이다.
const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|woff2?|ttf|eot|mp[34]|mov|wasm|lock)$/i;

/**
 * 검사할 글을 뽑는다. 말투 린터와 달리 확장자를 가리지 않는다.
 *
 * file_path/notebook_path 자체도 검사 대상이다 — `/tmp/900101-1234567.txt` 처럼
 * 경로에 번호가 실려 오는 경우가 있다.
 *
 * @returns {{label: string, text: string, kind?: string, editIndex?: number}[]}
 */
export function extractPiiTargets(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];

  if (toolName === "Bash") {
    // 명령 전체를 본다. 커밋 메시지뿐 아니라 heredoc 으로 파일을 만드는 경우도 걸린다.
    const command = toolInput.command;
    return typeof command === "string" ? [{ label: "명령", text: command }] : [];
  }

  const filePath = toolInput.file_path || toolInput.notebook_path || "";
  if (SKIP_EXTENSIONS.test(filePath) || GENERATED_FILES.test(filePath)) return [];
  const label = filePath || "파일";

  const targets = [];
  if (filePath) targets.push({ label, text: filePath, kind: "path" });

  if (toolName === "Write" && typeof toolInput.content === "string") {
    targets.push({ label, text: toolInput.content, kind: "content" });
  }
  if (toolName === "Edit" && typeof toolInput.new_string === "string") {
    targets.push({ label, text: toolInput.new_string, kind: "edit" });
  }
  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    toolInput.edits.forEach((edit, editIndex) => {
      if (typeof edit?.new_string === "string") {
        targets.push({ label, text: edit.new_string, kind: "edit", editIndex });
      }
    });
  }
  if (toolName === "NotebookEdit" && typeof toolInput.new_source === "string") {
    targets.push({ label, text: toolInput.new_source, kind: "edit" });
  }

  return targets;
}
