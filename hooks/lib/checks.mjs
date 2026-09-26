// rules.mjs 와 latin-hada.mjs 가 함께 참조하는 `검사` 값 상수만 모은 파일이다.
//
// latin-hada.mjs 가 규칙 하나(LATIN_HADA_RULE)를 만들려면 CHECK_REGEX 가 필요하고,
// rules.mjs 는 loadRules() 가 그 규칙을 builtins 로 내보내려면 latin-hada.mjs 를
// 불러야 한다 — 두 파일이 CHECK_REGEX 를 두고 서로 불러오면 순환 참조가 된다(ESM 은
// 순환 임포트 자체는 허용하지만, 상수가 초기화되기 전에 값을 읽으면
// "Cannot access before initialization" 로 죽는다). 값을 이 잎사귀 모듈로 옮기면
// 두 파일 다 여기만 내려다보고, 서로는 보지 않는다.

// 검사 칸의 세 값은 세 가지 실제 능력에 대응한다.
//   치환   — 정규식으로 잡히고, 쓸 것으로 그대로 바꿔도 뜻이 상하지 않는다. 자동 교정 대상
//   정규식 — 잡을 수는 있지만 문맥을 봐야 고칠 수 있다. 경고만 한다
//   프롬프트 — 문자열로 잡을 수 없다. 출력 스타일만이 막을 수 있다
export const CHECK_SUBSTITUTE = "치환";
export const CHECK_REGEX = "정규식";
export const CHECK_PROMPT = "프롬프트";
export const CHECKS = [CHECK_SUBSTITUTE, CHECK_REGEX, CHECK_PROMPT];

// 치환과 정규식은 둘 다 린터가 문자열로 찾는다.
export const SCANNABLE_CHECKS = [CHECK_SUBSTITUTE, CHECK_REGEX];
