---
name: korean-encoding
description: Use when handling Korean text encoding or search — CP949 EUC-KR legacy files, Excel CSV BOM mojibake (한글 깨짐), NFC/NFD Unicode normalization for filenames uploaded from macOS, 초성 검색 initial-consonant search, 한글 정렬 Korean collation, 자모 decomposition, choosing 을/를 이/가 particles in generated messages.
---
<!-- kimchi-ignore-file 나쁜 예를 그대로 인용한다 -->

# 한글 인코딩과 문자 처리

## 인코딩이 깨지는 세 자리

**엑셀에서 CSV 가 깨진다.** 엑셀은 UTF-8 파일에 BOM 이 없으면 시스템 기본 인코딩으로
읽습니다. 한국어 윈도에서는 CP949 라서 한글이 전부 깨집니다. 해결은 BOM(`﻿`)을 앞에
붙이는 것입니다. 파일 내용을 CP949 로 바꾸지 마십시오 — 엑셀은 열리지만 다른 도구가 깨집니다.

```js
const csv = "﻿" + rows.map((row) => row.join(",")).join("\r\n");
```

줄바꿈도 `\r\n` 이어야 엑셀이 제대로 나눕니다.

**옛 파일이 CP949 다.** 관공서 자료, 은행 거래 내역, 레거시 시스템 내보내기가 아직
CP949/EUC-KR 입니다. Node 는 CP949 를 기본으로 지원하지 않아 `iconv-lite` 같은 것이 필요합니다.
바이트를 UTF-8 로 가정해 읽으면 조용히 깨진 문자열이 됩니다.

**macOS 에서 올린 파일 이름이 다르다.** 이게 가장 찾기 어렵습니다. macOS 는 파일 이름을
NFD(자모 분리)로 저장하고 리눅스·윈도는 NFC(음절 결합)로 저장합니다. 눈으로는 똑같은
`한글.txt` 인데 문자열이 달라서 조회가 실패합니다.

규칙은 하나입니다. **경계를 넘는 모든 문자열은 NFC 로 정규화합니다.** 업로드를 받을 때,
데이터베이스에 넣을 때, 비교할 때.

```js
import { normalizeForStorage, differsOnlyByNormalization } from "./examples/hangul-jamo.mjs";

normalizeForStorage(uploadedName); // 저장 전에 반드시
differsOnlyByNormalization(a, b); // 버그를 진단할 때
```

## 초성 검색

한국 서비스의 검색창에서는 사실상 필수입니다. "김치"를 "ㄱㅊ"로 찾는 기능입니다.

한글 음절은 `(초성 × 21 × 28) + (중성 × 28) + 종성 + 0xAC00` 으로 만들어지므로 초성 색인은
`(코드 - 0xAC00) / 588` 입니다. 직접 짜면 이 산술을 틀리기 쉽습니다.

동작하는 구현: `examples/chosung-search.mjs`

**놓치기 쉬운 것**: 질의가 초성만일 때에만 초성으로 찾아야 합니다. 사용자가 "김"을
입력했는데 초성으로 처리하면 "ㄱ"으로 시작하는 모든 것이 걸려 오히려 방해가 됩니다.
그리고 한글이 아닌 글자는 그대로 통과시켜야 "iOS앱"을 "iOSㅇ"로 찾을 수 있습니다.

## 한글 정렬

코드포인트 순서는 사전순과 다릅니다. 겹받침과 옛한글이 섞이면 어긋납니다.
`localeCompare("ko")` 나 데이터베이스의 한국어 콜레이션을 쓰십시오.

```js
names.sort((a, b) => a.localeCompare(b, "ko"));
```

직접 자모를 분해해 비교하지 마십시오. 표준 콜레이션이 이미 옳게 합니다.

## 생성 문구의 조사

`"${name}을 삭제했습니다"` 처럼 문자열을 이어붙이면 이름에 따라 틀립니다.
"파일을"은 맞고 "캐시을"은 틀립니다. 받침으로 골라야 합니다.

```js
import { particleFor } from "./examples/hangul-jamo.mjs";

`${name}${particleFor(name, "을/를")} 삭제했습니다`;
```

`으로/로` 는 예외가 있습니다. ㄹ 받침 뒤에는 "로"를 씁니다. "서울로", "제주로".

**영어나 숫자로 끝나면 자동으로 알 수 없습니다.** 발음으로 판단해야 하는데 철자로는
알 수 없습니다. `particleFor` 가 `null` 을 돌려주면 조사를 쓰지 않는 문장으로 바꾸십시오.
"commit을 확인하세요" 대신 "다음 커밋을 확인하세요".

## 자주 틀리는 것

- CSV 에 BOM 없이 UTF-8 로 쓰기 — 엑셀에서 깨집니다
- 업로드 파일 이름을 정규화하지 않기 — macOS 에서 올린 것이 조회되지 않습니다
- 음절 질의를 초성 검색으로 처리하기 — 결과가 쏟아집니다
- 코드포인트로 한글 정렬하기 — 사전순이 아닙니다
- 문자열 이어붙이기로 조사 만들기 — 절반은 틀립니다
- `slice` 로 한글 자르기 — 자모 분리된 문자열에서는 글자가 깨집니다. `[...text]` 를 쓰십시오
