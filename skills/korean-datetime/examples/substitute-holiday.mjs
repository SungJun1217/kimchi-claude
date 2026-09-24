// 대체공휴일 계산.
//
// **음력 공휴일을 직접 계산하려 들지 말 것.** 설, 추석, 부처님오신날은 음력이고
// 음력 변환은 천문 계산이다. 직접 구현하면 반드시 틀린다. 공공데이터포털의
// "특일 정보" API 나 관공서 공휴일 규정 고시를 받아 쓴다.
//
// 이 파일이 하는 일은 그다음이다. 공휴일 날짜를 받아 대체공휴일을 계산한다.
// 이 규칙은 결정론적이라 코드로 둘 수 있다.
//
// 대체공휴일이 붙는 공휴일. 아래 표는 **2026-04-30 대통령령 제36290호 시행 이후** 기준이다
// (관공서의 공휴일에 관한 규정 제3조).
//   설·추석 연휴        일요일이나 다른 공휴일과 겹치면 대체. **토요일은 대체하지 않는다**
//   그 밖의 대상 공휴일  토요일·일요일이나 다른 공휴일과 겹치면 대체
//   신정, 현충일,        대체공휴일 없음. 제3조에 아예 없는 공휴일이다.
//   임시공휴일, 선거일
//
// 대체 대상 목록은 법이 바뀔 때마다 바뀌어 왔다. 2021년 확대로 국경일·한글날이,
// 2023년 개정으로 부처님오신날·기독탄신일이, 2026년 대통령령 제36290호(2026-04-30
// 개정)로 제헌절과 노동절(옛 근로자의 날)이 대체 대상에 들어갔다. 그래서 이 표를 과거
// 연도에 그대로 적용하면 틀린다 — 옛날 공휴일 목록은 이 함수로 다시 계산하지 말고
// 공공데이터포털 API가 이미 계산해 준 대체공휴일 행을 그대로 쓴다. 법이 또 바뀌면
// law.go.kr "관공서의 공휴일에 관한 규정" 을 다시 확인해야 한다.
//
// 겹침은 날짜 단위로 하나만 만든다. 같은 날 공휴일이 두 개면 대체공휴일도 하나다
// (제3조는 "겹치는 날"에 대체를 붙이지, 겹친 공휴일 개수만큼 붙이지 않는다). 같은
// 공휴일을 가리키는 다른 이름(설/설날, 3·1절/삼일절, 노동절/근로자의 날 등)이나 중복
// 입력행은 겹침으로 세지 않는다 — canonicalize() 로 정규화한 이름 기준으로 센다.
//
// 대체일은 연휴 다음의 가장 이른 비공휴일 평일이다.

/** 일요일에만 대체가 붙는 공휴일 (토요일은 대체하지 않는다). canonicalize() 이후의 정규 이름만 담는다. */
const SUNDAY_ONLY = new Set(["설", "추석"]);

/** 토요일·일요일·겹침에 대체가 붙는 공휴일. canonicalize() 이후의 정규 이름만 담는다. */
const WEEKEND_OR_OVERLAP = new Set([
  "삼일절",
  "어린이날",
  "광복절",
  "개천절",
  "한글날",
  "부처님오신날",
  "기독탄신일",
  "제헌절",
  "노동절",
]);

/** 같은 공휴일을 가리키는 다른 표기를 하나로 접는다. canonicalize() 가 이 표를 쓴다. */
const NAME_ALIASES = {
  설날: "설",
  "추석 연휴": "추석",
  "3·1절": "삼일절",
  "3.1절": "삼일절",
  성탄절: "기독탄신일",
  크리스마스: "기독탄신일",
};

/**
 * 공휴일 이름을 정규 이름으로 접는다. 겹침을 셀 때와 대체 대상인지 볼 때 이 이름을 쓴다.
 *
 * 근로자의 날은 특별하다. 2026년 대통령령 제36290호로 이름이 노동절로 바뀌며 대체
 * 대상이 됐다 — 그 이전 연도의 근로자의 날은 대체 대상이 아니었으므로 접지 않는다.
 *
 * @param {string} name
 * @param {number} year
 * @returns {string}
 */
function canonicalize(name, year) {
  if (name === "근로자의 날") return year >= 2026 ? "노동절" : name;
  return NAME_ALIASES[name] ?? name;
}

function isCovered(name) {
  return SUNDAY_ONLY.has(name) || WEEKEND_OR_OVERLAP.has(name);
}

function weekdayTriggers(name, weekday) {
  if (SUNDAY_ONLY.has(name)) return weekday === 0;
  return weekday === 0 || weekday === 6;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `YYYY-MM-DD` 를 UTC 자정 Date 로 엄격하게 파싱한다.
 *
 * 형식이 다르거나(`2026-3-5`) 존재하지 않는 날짜(`2025-02-30`)면 던진다.
 * `new Date()` 는 이런 입력을 조용히 다른 날짜로 밀어버린다.
 *
 * @param {string} dateStr
 * @param {string} label 에러 메시지에 쓸 이름
 * @returns {Date}
 */
function parseDateStrict(dateStr, label = "date") {
  if (typeof dateStr !== "string" || !DATE_RE.test(dateStr)) {
    throw new TypeError(`${label} 은 YYYY-MM-DD 형식이어야 한다: ${dateStr}`);
  }
  const date = new Date(`${dateStr}T00:00:00Z`);
  const [year, month, day] = dateStr.split("-").map(Number);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new TypeError(`${label} 이 존재하지 않는 날짜다: ${dateStr}`);
  }
  return date;
}

/** Set 이나 배열을 받아 조회용 Set 으로 통일한다. */
function toKeySet(holidayKeys) {
  if (holidayKeys instanceof Set) return holidayKeys;
  if (Array.isArray(holidayKeys)) return new Set(holidayKeys);
  throw new TypeError("holidayKeys 는 Set 이거나 배열이어야 한다");
}

function toKey(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * 공휴일 목록을 받아 대체공휴일을 더한 목록을 돌려준다.
 *
 * 입력은 공공데이터포털 등 권위 있는 출처에서 받은 그 해 공휴일이어야 한다.
 * 음력 날짜를 이 함수가 계산하지는 않는다.
 *
 * 입력에 이미 "대체공휴일" 행이 있으면(API가 이미 계산해 준 경우) 그 행을 그대로 두고
 * 같은 자리에 대체를 또 만들지 않는다. API 목록을 중복 없이 그대로 통과시키기 위해서다.
 *
 * @param {{date: string, name: string}[]} holidays `YYYY-MM-DD` 형식
 * @returns {{date: string, name: string, substituteFor?: string}[]} 날짜 순
 */
export function withSubstitutes(holidays) {
  for (const holiday of holidays) parseDateStrict(holiday.date, "holiday.date");

  const byDate = new Map();
  for (const holiday of holidays) {
    if (!byDate.has(holiday.date)) byDate.set(holiday.date, []);
    byDate.get(holiday.date).push(holiday.name);
  }

  // API 가 이미 계산해 둔 대체공휴일 날짜. 겹침 하나를 처리할 때마다 하나씩 소진한다 —
  // 겹침이 여러 개인데 API 행이 하나뿐이면 나머지 겹침엔 그래도 새로 만들어야 한다.
  const substituteDates = new Set(holidays.filter((h) => h.name === "대체공휴일").map((h) => h.date));
  const occupied = new Set(holidays.map((h) => h.date));
  const added = [];

  const dates = [...byDate.keys()].sort((a, b) => a.localeCompare(b));
  for (const date of dates) {
    const year = Number(date.slice(0, 4));
    const names = byDate.get(date);
    const canonicalNames = [...new Set(names.map((name) => canonicalize(name, year)))];
    const coveredNames = canonicalNames.filter(isCovered);
    if (coveredNames.length === 0) continue;

    const weekday = parseDateStrict(date).getUTCDay(); // 0 일요일, 6 토요일
    // 겹침은 정규화한 이름이 서로 다를 때만이다. 같은 공휴일의 중복 입력이나 다른 표기는
    // 겹침이 아니다.
    const overlap = canonicalNames.length > 1;
    if (!overlap && !coveredNames.some((name) => weekdayTriggers(name, weekday))) continue;

    let candidate = addDays(new Date(`${date}T00:00:00Z`), 1);
    for (let guard = 0; guard < 30; guard += 1) {
      const key = toKey(candidate);
      if (substituteDates.has(key)) {
        substituteDates.delete(key); // 이 겹침 몫으로 소진했다. 다른 겹침엔 또 필요할 수 있다.
        break;
      }
      const candidateWeekday = candidate.getUTCDay();
      if (candidateWeekday !== 0 && candidateWeekday !== 6 && !occupied.has(key)) {
        occupied.add(key);
        added.push({ date: key, name: "대체공휴일", substituteFor: coveredNames.join(", ") });
        break;
      }
      candidate = addDays(candidate, 1);
    }
  }

  return [...holidays, ...added].sort((a, b) => a.date.localeCompare(b.date));
}

// 공휴일은 아니지만 은행이 쉬는 날.
//
// **2025년까지는 근로자의 날(5월 1일)이 그랬다.** 관공서의 공휴일에 관한 규정에 없어서
// 공공데이터포털 공휴일 목록에도 나오지 않았다. 관공서는 정상 근무하고 은행만 휴무였다.
//
// 2026년 대통령령 제36290호(2026-04-30 개정)로 이름이 노동절로 바뀌며 관공서 공휴일이
// 됐다. 그 해부터는 withSubstitutes() 에 넘기는 공휴일 목록(API) 에 이미 들어 있으므로
// 여기서 또 더하지 않는다 — 더하면 이미 공휴일인 날을 "은행만 쉬는 날"로 착각하게 된다.
const BANK_ONLY_HOLIDAYS = [{ month: 5, day: 1, name: "근로자의 날" }];
const BANK_ONLY_LAST_YEAR = 2025;

/**
 * 은행 영업일 판정에 쓸 휴무일 집합을 만든다.
 *
 * 공휴일 집합과 다르다. 돈이 움직이는 날짜(정산 이체, 환불, 출금)는 이 집합으로 잡는다.
 * 증권시장 휴장일은 또 다르므로 필요하면 따로 더해야 한다.
 *
 * @param {Iterable<string>} holidayKeys 대체공휴일을 포함한 공휴일 `YYYY-MM-DD`
 * @param {number[]} years 대상 연도
 * @returns {Set<string>}
 */
export function bankClosedDays(holidayKeys, years) {
  const closed = new Set(holidayKeys);
  for (const year of years) {
    if (year > BANK_ONLY_LAST_YEAR) continue; // 이 해부터는 공휴일 목록에 이미 들어 있다
    for (const { month, day } of BANK_ONLY_HOLIDAYS) {
      closed.add(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
  }
  return closed;
}

/**
 * 한국 시간 기준 날짜 구간을 반쯤 열린 형태로 만든다.
 *
 * `BETWEEN ... 23:59:59` 로 자르면 마지막 1초를 흘린다. 밀리초를 쓰면 더 크게 흘린다.
 * 시작 이상, 끝 미만으로 잡아야 구멍이 없다.
 *
 * 그리고 경계를 UTC 로 잡으면 안 된다. 한국 시간 0시는 UTC 전날 15시다.
 * 여기서 돌려주는 값은 실제 UTC 순간이므로 `...Z` 로 저장된 값과 그대로 비교할 수 있다.
 *
 * @param {string} fromDate 포함하는 첫날 `YYYY-MM-DD` (KST)
 * @param {string} toDate 포함하지 않는 끝날 `YYYY-MM-DD` (KST)
 * @returns {{startUtc: string, endUtc: string}} 저장된 UTC 값과 비교할 경계 (ISO, `Z`)
 */
export function kstRange(fromDate, toDate) {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const from = parseDateStrict(fromDate, "fromDate");
  const to = parseDateStrict(toDate, "toDate");
  return {
    startUtc: new Date(from.getTime() - KST_OFFSET_MS).toISOString(),
    endUtc: new Date(to.getTime() - KST_OFFSET_MS).toISOString(),
  };
}

/**
 * 영업일을 더한다. 주말과 공휴일을 건너뛴다.
 *
 * 돈이 움직이는 날짜라면 holidayKeys 에 bankClosedDays() 의 결과를 넣어야 한다.
 * 공휴일 집합만 쓰면 은행만 쉬는 날에 이체를 잡는다.
 *
 * @param {string} from `YYYY-MM-DD`
 * @param {number} businessDays
 * @param {Set<string>|string[]} holidayKeys 대체공휴일을 포함한 공휴일 날짜
 * @returns {string} `YYYY-MM-DD`
 */
export function addBusinessDays(from, businessDays, holidayKeys) {
  let date = parseDateStrict(from, "from");
  const keys = toKeySet(holidayKeys);
  let remaining = businessDays;

  while (remaining > 0) {
    date = addDays(date, 1);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (keys.has(toKey(date))) continue;
    remaining -= 1;
  }

  return toKey(date);
}
