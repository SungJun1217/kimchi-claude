<!-- kimchi-ignore-file 평가자가 감점한 나쁜 표현을 그대로 인용한다 -->
# 출력 스타일 비교 실험 (2026-09-24)

fluent-korean(국어국문학 전공자가 쓴 출력 스타일)을 들여오면 답이 더 자연스러워지는지 재 본 기록이다.
결과는 0.13.0의 문장 규칙으로 반영했다.

## 조건

같은 질문을 네 조건에서 받았다.

| 조건 | 내용 |
|---|---|
| `none` | 출력 스타일 없음 |
| `kimchi` | kimchi-claude 0.12.6 (강제 적용) |
| `fluent` | fluent-korean 1.0.0의 `fluent-korean` 판 (`--settings`로 골랐다. 강제 적용이 아니다) |
| `merged` | kimchi 0.12.6 본문에 fluent-korean의 문법 규칙을 옮긴 절([`merged-section.md`](merged-section.md))을 더한 시험판. 본문이 6352자라 실제 상한 6000자를 넘는다 |

질문은 [`prompts.tsv`](prompts.tsv)에 있다.

| 질문 | 겨냥한 것 |
|---|---|
| P1 | 쿠폰 테스트가 깨진 원인을 찾아 고치고 "짧게 보고". 전보체가 가장 나오기 쉬운 자리다. 고친 뒤 테스트가 통과하는지로 작업 품질도 본다 |
| P2 | 영어 리뷰 코멘트("this couples the cache layer too tightly…")의 뜻. 직역 은유 |
| P3 | Redis와 프로세스 안 LRU 캐시 비교. 긴 설명문 |
| P4 | 회원 등급 할인 작업 계획. 목록형 문서 |

P1·P2·P4는 [`template/`](template/)의 작은 저장소에서 물었다. 캐시 키에 쿠폰이 빠진 버그가 있어 테스트 하나가 깨진다.

## 환경

- Claude Code 2.1.281, `--model opus --effort medium`, 조건마다 한 번씩 16회
- `--setting-sources project,local`로 사용자 설정을 떼어 냈다. 방법은 [`../../README.md`](../../README.md)에 적었다
- 스타일이 실제로 적용됐는지는 디버그 로그로 확인했다. `kimchi`와 `merged`는 `Using forced plugin output style` 줄이 있고, `none`은 스타일을 하나도 읽지 않았다. `fluent`는 선택한 스타일이 로그에 남지 않아 stream-json `init`의 `output_style`이 `fluent-korean:fluent-korean`인 것으로 확인했다
- 16회 모두 성공했고 P1은 네 조건 모두 테스트를 통과시켰다. 비용은 모두 $2.34

## 결과 1: 지표

[`metrics.mjs`](metrics.mjs)로 셌다. 기록한 값은 [`metrics.json`](metrics.json)이다.

| 조건 | 종결어미 없이 끝난 문장 | 명사형 종결 | '의' 밀도(1000자당) | 린터 위반 |
|---|---|---|---|---|
| none | 26/98 (27%) | 1 | 3.1 | 1 |
| kimchi | 22/109 (20%) | 6 | 4.1 | 0 |
| fluent | 13/87 (15%) | 1 | 2.4 | 1 |
| merged | 10/120 (8%) | 3 | 1.6 | 0 |

걸린 줄의 상당수는 "**3단계: 구현**" 같은 굵은 단계 제목과 짧은 목록 항목이라 잡음이 섞였다.
지금 규칙표로 다시 세면 fluent-P4의 린터 위반이 0에서 1로 는다. 0.13.0에서 넣은 "~지 여부" 규칙이 잡는다.

## 결과 2: 눈가림 비교

조건을 가린 채 질문마다 A~D로 섞어 두 평가자에게 매기게 했다. 섞은 표는 [`blind-key.json`](blind-key.json)이다.
평가자는 둘 다 Claude(Opus)이고, 하나는 영어로, 하나는 한국어로 지시했다.

| 평가자 | P1 | P2 | P3 | P4 |
|---|---|---|---|---|
| 1 | kimchi > none > fluent > merged | kimchi > merged > fluent > none | kimchi > merged > none > fluent | kimchi > merged > none > fluent |
| 2 | merged > kimchi > none > fluent | merged > kimchi > fluent > none | merged > kimchi > fluent > none | merged > kimchi > none > fluent |

1등 4점부터 4등 1점으로 더하면 kimchi 28, merged 26, none 14, fluent 12다.

두 평가자가 감점한 표현은 대부분 fluent 답에서 나왔다. "~할지 여부", "시작하는 것을 권장합니다", "감안해야 합니다", "판단합니다", "여쭙고 싶습니다". 평가자는 이를 공문서체라고 불렀다.
merged 답의 "한 가지 알려드립니다: …"처럼 문장 가운데를 쌍점으로 이은 것도 둘 다 감점했다. 엠대시 대신 쌍점을 쓰라는 fluent-korean의 권고를 그대로 옮긴 결과다.
전보체(조사 생략, 명사형 종결)는 두 평가자 모두 표와 목록 칸 말고는 드물다고 했다.

## 해석

- kimchi는 스타일 없음보다 확실히 낫다. 판정 여덟 번 모두에서 kimchi가 none보다 위였다.
- fluent-korean만 쓰면 스타일 없음보다도 낮았다. 성분을 다 채우라는 지시가 공문서체로 흘렀다.
- merged와 kimchi는 비겼다. 평가자 1은 네 번 모두 kimchi를, 평가자 2는 네 번 모두 merged를 1등으로 골랐다. 지표로는 merged가 가장 좋았다.
- 그래서 fluent-korean을 통째로 들이지 않고, 명사형 종결 금지와 공문서체 피하기만 넣고 쌍점 권고는 뒤집었다(0.13.0).

## 한계

- 조건마다 한 번씩 돌렸다. 같은 조건을 다시 돌리면 순위가 바뀔 수 있다.
- 평가자가 답을 쓴 모델과 같은 계열이다. 취향이 겹칠 수 있고, 사람 평가자는 없었다.
- 새 세션이라 컨텍스트 압박이 없었다. fluent-korean README도 그런 조건에서는 원래 답의 품질이 더 좋게 나온다고 적어 두었다.

## 다시 하기

```bash
node metrics.mjs answers     # 이 디렉터리에서. 지금 규칙표로 지표를 다시 센다
```

세션을 다시 띄우려면 `template/`을 조건마다 새로 복사해 그 안에서 위 환경의 플래그로 `claude -p`를 돌린다.
fluent-korean은 https://github.com/snflkd/fluent-korean (MIT)에서 받는다.
