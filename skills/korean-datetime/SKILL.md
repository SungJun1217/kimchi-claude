---
name: korean-datetime
description: Use when handling Korean dates, holidays or business days — 공휴일 holiday calendar, 대체공휴일 substitute holidays, 음력 lunar dates for 설날 추석 부처님오신날, KST timezone vs UTC storage, 영업일 business day calculation, 주말 포함 여부. Explains why lunar holidays must come from 공공데이터포털 rather than being computed.
---
<!-- kimchi-ignore-file 법령 용어와 나쁜 예를 그대로 인용한다 -->

# 한국의 날짜와 시간

## 음력 공휴일은 계산하지 마십시오

설날, 추석, 부처님오신날은 음력입니다. 음력 변환은 천문 계산이고 직접 구현하면 반드시
틀립니다. 윤달 처리와 절기 기준이 해마다 다릅니다.

받아 쓰십시오.

- **공공데이터포털 특일 정보 API** — 한국천문연구원이 제공합니다. 권위 있는 출처입니다
- 관공서의 공휴일에 관한 규정 고시 — 임시공휴일은 여기서만 알 수 있습니다

그리고 **임시공휴일은 예측할 수 없습니다.** 정부가 그때그때 지정합니다. 공휴일 목록을
코드에 하드코딩하면 임시공휴일이 생길 때마다 배포해야 합니다. 자료로 두고 갱신하십시오.

## 대체공휴일 규칙은 결정론적입니다

공휴일 날짜를 받아 오면 대체공휴일은 규칙으로 계산할 수 있습니다.

| 공휴일 | 대체 조건 |
|---|---|
| 신정, 현충일 | 대체공휴일 없음 |
| 설·추석 연휴 | **일요일**이나 다른 공휴일과 겹칠 때만. 토요일은 대체하지 않습니다 |
| 그 밖의 공휴일 | 토요일·일요일이나 다른 공휴일과 겹칠 때 |

설·추석만 토요일을 빼는 것이 함정입니다. 다른 공휴일과 같은 규칙으로 처리하면 하루를
더 쉬는 달력이 나옵니다.

대체일은 연휴 다음의 가장 이른 비공휴일 평일입니다. 이미 공휴일인 날은 건너뜁니다.

동작하는 구현: `examples/substitute-holiday.mjs`

```js
import { withSubstitutes, addBusinessDays } from "./examples/substitute-holiday.mjs";

// 권위 있는 출처에서 받은 공휴일을 넣는다
const calendar = withSubstitutes(holidaysFromApi);
addBusinessDays("2026-03-05", 3, new Set(calendar.map((day) => day.date)));
```

## 시간대

**한국 표준시는 UTC+9 고정입니다.** 서머타임이 없습니다. 이것이 오히려 함정을 만듭니다 —
오프셋이 고정이라 `new Date()` 에 9시간을 더하는 코드가 잘 도는 것처럼 보이고, 그 코드가
서머타임이 있는 지역으로 확장될 때 터집니다.

원칙은 다른 나라와 같습니다.

- 저장은 UTC 로, 표시할 때 `Asia/Seoul` 로 변환합니다
- 오프셋을 직접 더하지 말고 시간대 이름을 쓰십시오
- 서버 시간대에 의존하지 마십시오. 컨테이너는 대개 UTC 입니다

```js
new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "long" }).format(date);
```

**날짜 경계가 바뀝니다.** UTC 로 저장한 값을 날짜별로 집계하면 한국 기준 하루가 UTC 기준
이틀에 걸칩니다. "오늘 주문"을 UTC 날짜로 묶으면 오전 9시 이전 주문이 어제로 들어갑니다.
집계 기준 시간대를 명시하십시오.

## 만 나이

2023년 6월부터 법령상 나이는 만 나이입니다. 그전에는 세는 나이와 연 나이가 섞여 있었습니다.

- 만 나이 계산에는 생일이 지났는지가 들어갑니다. 연도 차이만 쓰면 틀립니다
- 나이 제한(청소년 보호, 성인 인증)은 만 나이 기준입니다
- 생년월일을 받지 않고 나이를 받으면 해가 바뀔 때 틀어집니다. 생년월일을 저장하십시오

## 자주 틀리는 것

- 음력 공휴일을 직접 계산하기
- 공휴일을 코드에 하드코딩하기 — 임시공휴일이 생기면 배포해야 합니다
- 설·추석을 다른 공휴일과 같은 대체 규칙으로 처리하기
- `new Date()` 에 9시간을 더해 한국 시간을 만들기
- UTC 날짜로 한국 기준 일별 집계를 하기
- 나이를 저장하기 — 생년월일을 저장해야 합니다
- 연도 차이로 만 나이를 계산하기 — 생일 경과를 봐야 합니다
