// 대체공휴일 계산.
//
// **음력 공휴일을 직접 계산하려 들지 말 것.** 설, 추석, 부처님오신날은 음력이고
// 음력 변환은 천문 계산이다. 직접 구현하면 반드시 틀린다. 공공데이터포털의
// "특일 정보" API 나 관공서 공휴일 규정 고시를 받아 쓴다.
//
// 이 파일이 하는 일은 그다음이다. 공휴일 날짜를 받아 대체공휴일을 계산한다.
// 이 규칙은 결정론적이라 코드로 둘 수 있다.
//
// 규칙 (관공서의 공휴일에 관한 규정)
//   신정, 현충일        대체공휴일 없음
//   설·추석 연휴        일요일이나 다른 공휴일과 겹치면 대체. **토요일은 대체하지 않는다**
//   그 밖의 공휴일      토요일·일요일이나 다른 공휴일과 겹치면 대체
//
// 대체일은 연휴 다음의 가장 이른 비공휴일 평일이다.

/** 대체공휴일이 붙지 않는 공휴일 */
const NO_SUBSTITUTE = new Set(["신정", "현충일"]);

/** 토요일에는 대체가 붙지 않는 공휴일 */
const SUNDAY_ONLY = new Set(["설", "설날", "추석"]);

const DAY_MS = 24 * 60 * 60 * 1000;

function toKey(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * 이 공휴일에 대체공휴일이 붙어야 하는지 본다.
 *
 * @param {{date: string, name: string}} holiday
 * @param {Set<string>} holidayKeys 그 해 모든 공휴일 날짜
 * @returns {boolean}
 */
function needsSubstitute(holiday, holidayKeys) {
  if (NO_SUBSTITUTE.has(holiday.name)) return false;

  // UTC 로 다룬다. KST 오프셋을 섞으면 하루가 밀린다.
  const date = new Date(`${holiday.date}T00:00:00Z`);
  const weekday = date.getUTCDay(); // 0 일요일, 6 토요일

  if (SUNDAY_ONLY.has(holiday.name)) {
    if (weekday === 0) return true;
  } else if (weekday === 0 || weekday === 6) {
    return true;
  }

  // 다른 공휴일과 겹치는 경우. 같은 날에 두 공휴일 이름이 있으면 하나는 밀린다.
  return countAt(holidayKeys, holiday.date) > 1;
}

function countAt(holidayKeys, key) {
  // holidayKeys 는 날짜별 개수를 담은 Map 이거나 Set 이다.
  if (holidayKeys instanceof Map) return holidayKeys.get(key) ?? 0;
  return holidayKeys.has(key) ? 1 : 0;
}

/**
 * 공휴일 목록을 받아 대체공휴일을 더한 목록을 돌려준다.
 *
 * 입력은 공공데이터포털 등 권위 있는 출처에서 받은 그 해 공휴일이어야 한다.
 * 음력 날짜를 이 함수가 계산하지는 않는다.
 *
 * @param {{date: string, name: string}[]} holidays `YYYY-MM-DD` 형식
 * @returns {{date: string, name: string, substituteFor?: string}[]} 날짜 순
 */
export function withSubstitutes(holidays) {
  const counts = new Map();
  for (const holiday of holidays) {
    counts.set(holiday.date, (counts.get(holiday.date) ?? 0) + 1);
  }

  const occupied = new Set(holidays.map((holiday) => holiday.date));
  const added = [];

  for (const holiday of holidays) {
    if (!needsSubstitute(holiday, counts)) continue;

    // 연휴 다음의 가장 이른 평일이면서 공휴일이 아닌 날을 찾는다.
    let candidate = addDays(new Date(`${holiday.date}T00:00:00Z`), 1);
    for (let guard = 0; guard < 30; guard += 1) {
      const key = toKey(candidate);
      const weekday = candidate.getUTCDay();
      if (weekday !== 0 && weekday !== 6 && !occupied.has(key)) {
        occupied.add(key);
        added.push({ date: key, name: "대체공휴일", substituteFor: holiday.name });
        break;
      }
      candidate = addDays(candidate, 1);
    }
  }

  return [...holidays, ...added].sort((a, b) => a.date.localeCompare(b.date));
}

// 공휴일은 아니지만 은행이 쉬는 날.
//
// **근로자의 날(5월 1일)이 그렇다.** 관공서의 공휴일에 관한 규정에 없어서 공공데이터포털
// 공휴일 목록에도 나오지 않는다. 관공서는 정상 근무하고 은행은 휴무다.
// 공휴일 목록만 써서 이체 날짜를 잡으면 정산이 실패한다.
const BANK_ONLY_HOLIDAYS = [{ month: 5, day: 1, name: "근로자의 날" }];

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
 * UTC 날짜로 묶으면 오전 9시 이전 자료가 전날로 들어간다.
 *
 * @param {string} fromDate 포함하는 첫날 `YYYY-MM-DD` (KST)
 * @param {string} toDate 포함하지 않는 끝날 `YYYY-MM-DD` (KST)
 * @returns {{startUtc: string, endUtc: string}} 저장된 UTC 값과 비교할 경계
 */
export function kstRange(fromDate, toDate) {
  // KST 는 UTC+9 고정이다. 서머타임이 없어 오프셋을 그대로 뺀다.
  return {
    startUtc: `${fromDate}T00:00:00+09:00`,
    endUtc: `${toDate}T00:00:00+09:00`,
  };
}

/**
 * 영업일을 더한다. 주말과 공휴일을 건너뛴다.
 *
 * 돈이 움직이는 날짜라면 holidayKeys 에 bankClosedDays() 의 결과를 넣어야 한다.
 * 공휴일 집합만 쓰면 근로자의 날에 이체를 잡는다.
 *
 * @param {string} from `YYYY-MM-DD`
 * @param {number} businessDays
 * @param {Set<string>} holidayKeys 대체공휴일을 포함한 공휴일 날짜
 * @returns {string} `YYYY-MM-DD`
 */
export function addBusinessDays(from, businessDays, holidayKeys) {
  let date = new Date(`${from}T00:00:00Z`);
  let remaining = businessDays;

  while (remaining > 0) {
    date = addDays(date, 1);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (holidayKeys.has(toKey(date))) continue;
    remaining -= 1;
  }

  return toKey(date);
}
