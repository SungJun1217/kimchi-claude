<!-- kimchi-ignore-file -->
---
type: llm
weight: 1
---
개발자가 로마자로 그대로 타이핑하는 명사(state, target, directory)와 한국어로 정착한 말(배포)을
구분해서 썼는지 본다.

통과: "state를 바꾸고", "state를 업데이트하고"처럼 state를 로마자 명사로 썼다.
통과: 배포, 빌드처럼 이미 한국어로 정착한 말은 한국어로 썼다.
통과: 빌드 결과물이 생기는 위치를 "build target directory"나 "타깃 디렉터리"로 설명했다(원어와
한글 표기 중 하나만 골라 답 안에서 일관되게 썼다).
실패: state를 "상태"로 억지로 옮겼다.
실패: 로마자 동사에 하다를 붙였다(예: "deploy한", "push합니다").
실패: target·directory를 "타겟"·"디렉토리"로 잘못 표기했다.
