<!-- kimchi-ignore-file -->
# 평가 세트

두 가지를 함께 잰다.

- **말투** — 어색한 표현이 사라졌는가 (`tone-*`)
- **품질과 비개입** — 작업 실력이 떨어지지 않았는가, 영어 세션을 건드리지 않는가
  (`quality-preserved`, `english-passthrough`)

두 번째가 첫 번째만큼 중요하다. 말투가 좋아지고 실력이 떨어지면 실패다.

## 돌리는 법

```bash
claude plugin eval . --runs 2 -j 4
```

`--ablation`은 기본이 `with-without`이다. 플러그인을 켠 팔과 끈 팔을 모두 돌려 점수 차이를
보고한다. 우리가 보고 싶은 것이 정확히 그 차이다.

기대하는 결과:

| 사례 | 플러그인 켬 | 기준선 | 해석 |
|---|---|---|---|
| `tone-*` | 높음 | 낮음 | 말투 규칙이 실제로 듣는다 |
| `quality-preserved` | 높음 | 높음 | 차이가 없어야 한다. 떨어지면 회귀다 |
| `english-passthrough` | 높음 | 높음 | 영어 세션에 개입하지 않는다 |

`quality-preserved`의 점수가 기준선보다 낮으면 출력 스타일이 작업을 방해하고 있다는 뜻이다.
그 경우 `scripts/build-style.mjs`의 `MAX_CHARS`를 줄이거나 `순위`를 다시 매겨 본문을 줄여야 한다.

## 채점기 종류

`regex` 채점기는 무료이고 결정론적이다. 금칙 표현을 직접 겨냥할 때 쓴다.
`llm` 채점기는 목록으로 잡을 수 없는 것을 본다. 문장 구조, 기술적 정확성.

가능하면 `regex`를 먼저 쓴다. 판정이 흔들리지 않고 비용이 들지 않는다.

## 호스트 설정과 섞이지 않게 하기

`claude -p --plugin-dir` 로 띄운 세션에는 이 플러그인만 올라오지 않는다. 사용자 설정의
`enabledPlugins`, 사용자 훅, `~/.claude/skills` 의 스킬, 사용자 MCP 서버가 함께 올라온다.
실측해 보니 섞여 드는 주범은 플러그인보다 사용자 훅이었다. 모든 이벤트에서 돈다.

손으로 말투를 잴 때는 사용자 설정을 뺀다.

```bash
claude -p "<질문>" --plugin-dir "<플러그인 절대 경로>" --setting-sources project,local \
  --output-format stream-json --verbose --include-hook-events --no-session-persistence \
  --debug-file run.debug.log < /dev/null
```

- 인증(OAuth)과 모델은 그대로 남는다. 사용자 설정의 추론 수준(`effortLevel`)은 빠지므로
  대화형 환경과 견주려면 `--effort` 를 직접 준다.
- 빈 임시 저장소에서 띄운다. 현재 디렉터리의 `.claude/` 설정은 여전히 읽힌다.
- `--bare` 는 OAuth 를 읽지 않아 인증이 막히고, `--safe-mode` 는 `--plugin-dir` 로 넣은
  플러그인까지 끈다. 둘 다 쓰지 않는다.
- 격리됐는지는 디버그 로그로 확인한다. `Registered 3 hooks from 3 plugins` 와
  `Using forced plugin output style: kimchi-claude:자연스러운 한국어` 가 있어야 한다.
  stream-json 의 `init` 은 증거가 아니다. 출력 스타일이 강제로 적용돼도 `output_style` 에는
  설정값인 `"default"` 가 찍힌다.

`claude plugin eval` 이 사용자 설정을 떼어 내는지는 아직 확인하지 않았다. 도움말에 그런
옵션이 없다. 다음에 돌릴 때 자식 세션에 올라온 훅 수부터 확인한다.

## 알려진 제약

평가는 자식 `claude` 프로세스를 띄운다. 그 프로세스가 자격 증명을 물려받지 못하는 환경에서는
모든 사례가 인증 오류로 실패한다. AWS Bedrock 경유 세션 안에서 돌릴 때 특히 그렇다.
그런 경우에는 사람이 직접 셸에서 돌려야 한다.

자격 증명이 필요 없는 검증은 `npm test`에 들어 있다. 규칙표 자체의 정합성을 보는 시험이다.
