// 영어 낱말과 숫자 뒤의 조사를 발음으로 판정한다.
//
// 한국어 조사는 앞말의 **발음**이 결정한다. 철자가 아니다. 그래서 `commit을` 은 맞고
// `commit를` 은 틀리다. 커밋의 끝소리에 ㅅ 받침이 있기 때문이다.
//
// 규칙표에 낱말마다 한 줄씩 넣는 방식으로는 덮을 수 없다. 영어 낱말은 무한하다.
// 그래서 읽는 법을 아는 것만 판정하고 **모르면 판정하지 않는다.**
// 틀린 자동 교정은 없는 것보다 나쁘다.

import { maskProtected, isIgnoredFile } from "./segment.mjs";

// 받침을 세 가지로 나눈다. 있고 없음만으로는 모자라다.
//
// `으로/로` 는 예외가 있다. **ㄹ 받침 뒤에는 로를 쓴다.** 서울로, 제주로, 1로(일), URL로(유알엘).
// 다른 조사는 받침 유무만 보므로 ㄹ 을 따로 알아야 하는 것은 이 짝뿐이다.
export const NO_FINAL = "";
export const RIEUL = "ㄹ";
export const OTHER_FINAL = "other";

/**
 * 받침에 따라 갈리는 조사 짝. 받침 있을 때 쓰는 것을 먼저 적는다.
 *
 * 계사(이다)의 활용형도 여기 속한다 — "디펜던시였습니다"(받침 없음이라 였이 맞다)처럼
 * 겉보기엔 조사가 아니지만 앞말 받침이 형태를 가른다는 점은 같다. 순서는 긴 것을
 * 먼저 적는다: "이어야"/"이어서"를 "이어" 뒤에 두면 "이어"가 먼저 매치해 "야"/"서"가
 * 덜렁 남는다.
 *
 * 뺀 것도 있다. "다/이다"는 계사가 아니라 거의 모든 동사·형용사 종결형에도 쓰여
 * (간다, 좋다) 이 표만 보고서는 앞말이 명사인지조차 알 수 없다 — 조사 목록에 넣으면
 * 관계없는 문장 끝마다 걸린다. "야/이야"도 마찬가지로 호격 조사 "아/야"(철수야)와
 * 형태가 겹쳐 계사인지 호격인지 이 표만으로는 가릴 수 없다. "여/이어"도 뺐다 —
 * "10여 개"·"100여 건"의 "여"(남짓)는 계사가 아니라 숫자 뒤에 붙는 한자 접미사라
 * 형태가 겹친다. "여야"·"여서"처럼 뒤에 어미가 더 붙는 긴 형태는 접미사 "여"와
 * 겹치지 않아 남겨 두되, correctParticle 이 순수 숫자 앞에서는 그마저도 판정하지
 * 않는다(아래 참고). 셋 다 판정하지 않는다 — 불변식 5.
 */
const PAIRS = [
  ["으로서", "로서"],
  ["으로써", "로써"],
  ["으로", "로"],
  ["이나", "나"],
  ["이란", "란"],
  ["이라", "라"],
  ["이며", "며"],
  ["이든", "든"],
  ["이어야", "여야"],
  ["이어서", "여서"],
  ["이었", "였"],
  ["이에요", "예요"],
  ["이랑", "랑"],
  ["을", "를"],
  ["이", "가"],
  ["은", "는"],
  ["과", "와"],
];

// "여야"/"여서"의 "여"도 "10여 개"의 "여"(남짓)와 자리가 겹칠 수 있다 — "10여야"처럼
// 실제로 쓰이지는 않지만, 숫자 뒤에서는 아예 이 계사 활용형을 판정하지 않는다.
const DIGIT_TOKEN = /^\d+$/;
const NUMERAL_SUFFIX_COLLISION = new Set(["이어야", "여야", "이어서", "여서"]);

/**
 * 조사들의 첫 글자 집합. 짝 표에서 유도한다.
 *
 * lint.mjs 가 "이 글자가 조사일 수 있는가"를 판정할 때 쓴다. 짝 표가 원본이므로
 * 조사를 하나 더하면 두 곳이 함께 늘어난다.
 *
 * @returns {Set<string>}
 */
export function particleHeads() {
  return new Set(PAIRS.flat().map((particle) => particle[0]));
}

// 순수 숫자는 한국어 수사로 읽는다. 3 → 삼(ㅁ).
const DIGIT_KOREAN = [
  OTHER_FINAL, // 0 영·공 — ㅇ
  RIEUL, // 1 일
  NO_FINAL, // 2 이
  OTHER_FINAL, // 3 삼 — ㅁ
  NO_FINAL, // 4 사
  NO_FINAL, // 5 오
  OTHER_FINAL, // 6 육 — ㄱ
  RIEUL, // 7 칠
  RIEUL, // 8 팔
  NO_FINAL, // 9 구
];

// 글자가 앞에 붙은 숫자는 영어로 읽는다. S3 → 에스쓰리, v1 → 브이원.
// 같은 3 이 문맥에 따라 삼(받침 있음)과 쓰리(받침 없음)로 갈린다.
const DIGIT_ENGLISH = [
  NO_FINAL, // 0 제로
  OTHER_FINAL, // 1 원 — ㄴ
  NO_FINAL, // 2 투
  NO_FINAL, // 3 쓰리
  NO_FINAL, // 4 포
  NO_FINAL, // 5 파이브
  NO_FINAL, // 6 식스
  OTHER_FINAL, // 7 세븐 — ㄴ
  NO_FINAL, // 8 에이트
  OTHER_FINAL, // 9 나인 — ㄴ
];

// 낱자를 읽는 법. 두음자어를 글자로 읽을 때 마지막 글자만 보면 된다.
// 받침이 있는 것만 적는다. L 엘(ㄹ), R 알(ㄹ), M 엠(ㅁ), N 엔(ㄴ).
const LETTER_FINAL = { l: RIEUL, r: RIEUL, m: OTHER_FINAL, n: OTHER_FINAL };
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

// 두음자어를 "글자로 읽는다"고 판단해도 되는 경우만 가린다.
//
// 모음이 없으면(HTTP, SQL, TCP) 낱말로 읽을 방법이 없어 무조건 글자로 읽는다.
// 모음이 있으면 낱말처럼 읽힐 수도 있다 — GET·PUT·DROP·LOCK·STOP·MAP은 명령어라
// 낱말로 읽고(GET을, DROP을), API·URL·SQL은 자리에 모음이 있어도 관용적으로 글자로
// 읽는다(API를, 에이피아이). 철자만으로는 못 가르므로, 모음이 있는 두음자어는 실제로
// 글자로 읽는다고 알려진 것만 이 목록에 올린다. 없는 것은 판정하지 않는다 — 불변식 5.
const SPELLED_ACRONYMS = new Set([
  "API", "URL", "SQL", "CPU", "GPU", "UI", "UX", "ID", "OS", "DB", "PR", "CI", "CD", "QA",
  "AWS", "GCP", "SDK", "CLI", "IDE", "JWT", "XML", "HTML", "CSS", "DNS", "TCP", "UDP", "IP",
  "SSH", "SSL", "TLS", "HTTP", "HTTPS", "RAM", "SSD", "USB", "PDF", "CSV", "UUID", "ORM",
  "MVC", "DOM", "NPM", "VM",
]);
const VOWEL_LETTERS = new Set(["A", "E", "I", "O", "U"]);

// 읽는 법을 아는 낱말. **여기가 유일한 원본이다.** 값은 끝소리에 받침이 있는지다.
//
// 목록에 없는 낱말은 판정하지 않는다. 철자로 끝소리를 유도할 수 없기 때문이다.
// `cache` 는 캐시(받침 없음)인데 `attach` 는 어태치(받침 없음), `match` 는 매치.
// 반면 `hook` 은 훅(ㄱ), `stack` 은 스택(ㄱ). 철자 규칙으로는 갈릴 수 없다.
const LEXICON = {
  // 글자로 읽으면 틀리는 두음자어
  json: OTHER_FINAL, // 제이슨 — ㄴ
  yaml: RIEUL, // 야믈 — ㄹ
  toml: RIEUL, // 토믈 — ㄹ
  ssl: RIEUL, // 에스에스엘 — ㄹ
  url: RIEUL, // 유알엘 — ㄹ
  npm: OTHER_FINAL, // 엔피엠 — ㅁ
  rest: NO_FINAL, // 레스트
  crud: NO_FINAL, // 크러드
  ajax: NO_FINAL, // 에이잭스
  cors: NO_FINAL, // 코스
  jwt: NO_FINAL, // 제이더블유티
  saas: NO_FINAL, // 사스
  tls: NO_FINAL, // 티엘에스
  ssh: NO_FINAL, // 에스에스에이치
  uri: NO_FINAL, // 유알아이

  // 형상 관리와 도구
  git: OTHER_FINAL, // 깃 — ㅅ
  commit: OTHER_FINAL, // 커밋 — ㅅ
  webpack: OTHER_FINAL, // 웹팩 — ㄱ
  pull: RIEUL, // 풀 — ㄹ
  merge: NO_FINAL, // 머지
  rebase: NO_FINAL, // 리베이스
  branch: NO_FINAL, // 브랜치
  tag: NO_FINAL, // 태그
  push: NO_FINAL, // 푸시
  fork: NO_FINAL, // 포크
  docker: NO_FINAL, // 도커
  node: NO_FINAL, // 노드
  vite: NO_FINAL, // 비트

  // 자료와 저장소
  stack: OTHER_FINAL, // 스택 — ㄱ
  heap: OTHER_FINAL, // 힙 — ㅂ
  table: RIEUL, // 테이블 — ㄹ
  column: OTHER_FINAL, // 칼럼 — ㅁ
  mysql: RIEUL, // 마이에스큐엘 — ㄹ
  cache: NO_FINAL, // 캐시
  buffer: NO_FINAL, // 버퍼
  queue: NO_FINAL, // 큐
  index: NO_FINAL, // 인덱스
  schema: NO_FINAL, // 스키마
  redis: NO_FINAL, // 레디스
  postgres: NO_FINAL, // 포스트그레스
  mongodb: NO_FINAL, // 몽고디비

  // 코드 개념
  module: RIEUL, // 모듈 — ㄹ
  function: OTHER_FINAL, // 펑션 — ㄴ
  token: OTHER_FINAL, // 토큰 — ㄴ
  session: OTHER_FINAL, // 세션 — ㄴ
  stream: OTHER_FINAL, // 스트림 — ㅁ
  hook: OTHER_FINAL, // 훅 — ㄱ
  timeout: OTHER_FINAL, // 타임아웃 — ㅅ
  callback: OTHER_FINAL, // 콜백 — ㄱ
  method: NO_FINAL, // 메서드
  class: NO_FINAL, // 클래스
  package: NO_FINAL, // 패키지
  import: NO_FINAL, // 임포트
  export: NO_FINAL, // 익스포트
  build: NO_FINAL, // 빌드
  test: NO_FINAL, // 테스트
  lint: NO_FINAL, // 린트
  thread: NO_FINAL, // 스레드
  cookie: NO_FINAL, // 쿠키
  request: NO_FINAL, // 리퀘스트
  response: NO_FINAL, // 리스폰스
  endpoint: NO_FINAL, // 엔드포인트
  payload: NO_FINAL, // 페이로드
  promise: NO_FINAL, // 프로미스
  log: NO_FINAL, // 로그
  server: NO_FINAL, // 서버
  client: NO_FINAL, // 클라이언트
  browser: NO_FINAL, // 브라우저
  proxy: NO_FINAL, // 프록시
  port: NO_FINAL, // 포트
  host: NO_FINAL, // 호스트

  // 언어와 런타임
  python: OTHER_FINAL, // 파이썬 — ㄴ
  kotlin: OTHER_FINAL, // 코틀린 — ㄴ
  bun: OTHER_FINAL, // 번 — ㄴ
  java: NO_FINAL, // 자바
  rust: NO_FINAL, // 러스트
  go: NO_FINAL, // 고
  swift: NO_FINAL, // 스위프트
  ruby: NO_FINAL, // 루비
  deno: NO_FINAL, // 디노
  typescript: NO_FINAL, // 타입스크립트
  javascript: NO_FINAL, // 자바스크립트

  // 프레임워크와 도구
  graphql: RIEUL, // 그래프큐엘
  ansible: RIEUL, // 앤서블
  gradle: RIEUL, // 그레이들
  babel: RIEUL, // 바벨
  vercel: RIEUL, // 버셀
  laravel: RIEUL, // 라라벨
  terraform: OTHER_FINAL, // 테라폼 — ㅁ
  spring: OTHER_FINAL, // 스프링 — ㅇ
  tomcat: OTHER_FINAL, // 톰캣 — ㅅ
  maven: OTHER_FINAL, // 메이븐 — ㄴ
  storybook: OTHER_FINAL, // 스토리북 — ㄱ
  yarn: OTHER_FINAL, // 얀 — ㄴ
  pnpm: OTHER_FINAL, // 피엔피엠 — ㅁ
  react: NO_FINAL, // 리액트
  vue: NO_FINAL, // 뷰
  angular: NO_FINAL, // 앵귤러
  svelte: NO_FINAL, // 스벨트
  nuxt: NO_FINAL, // 넉스트
  django: NO_FINAL, // 장고
  flask: NO_FINAL, // 플라스크
  rails: NO_FINAL, // 레일즈
  eslint: NO_FINAL, // 이에스린트
  prettier: NO_FINAL, // 프리티어
  jest: NO_FINAL, // 제스트
  cypress: NO_FINAL, // 사이프러스
  playwright: NO_FINAL, // 플레이라이트
  jenkins: NO_FINAL, // 젠킨스
  kubernetes: NO_FINAL, // 쿠버네티스
  nginx: NO_FINAL, // 엔진엑스
  apache: NO_FINAL, // 아파치
  kafka: NO_FINAL, // 카프카
  grafana: NO_FINAL, // 그라파나
  prometheus: NO_FINAL, // 프로메테우스
  kibana: NO_FINAL, // 키바나
  elasticsearch: NO_FINAL, // 엘라스틱서치

  // 규약과 클라우드
  iam: OTHER_FINAL, // 아이엠 — ㅁ
  cdn: OTHER_FINAL, // 씨디엔 — ㄴ
  saml: RIEUL, // 사믈
  xml: RIEUL, // 엑스엠엘
  html: RIEUL, // 에이치티엠엘
  https: NO_FINAL, // 에이치티티피에스
  grpc: NO_FINAL, // 지알피씨
  oauth: NO_FINAL, // 오어스
  dns: NO_FINAL, // 디엔에스
  tcp: NO_FINAL, // 티씨피
  lambda: NO_FINAL, // 람다
  athena: NO_FINAL, // 아테나
  dynamodb: NO_FINAL, // 다이나모디비
  rds: NO_FINAL, // 알디에스
  sqs: NO_FINAL, // 에스큐에스
  vpc: NO_FINAL, // 브이피씨
};

/**
 * 영어 낱말이나 숫자의 한국어 끝소리 받침을 판정한다.
 *
 * @param {string} word
 * @returns {""|"ㄹ"|"other"|null} 읽는 법을 모르면 null
 */
export function finalSoundOf(word) {
  if (typeof word !== "string") return null;
  const token = word.trim();
  if (token.length === 0) return null;

  // 한글로 끝나면 이 함수가 다룰 일이 아니다. lint.mjs 의 hasFinalConsonant 가 본다.
  if (/[가-힣]$/.test(token)) return null;

  const lower = token.toLowerCase();
  if (Object.hasOwn(LEXICON, lower)) return LEXICON[lower];

  // 숫자로 끝나는 경우. 앞에 글자가 붙었는지로 읽는 법이 갈린다.
  const digitMatch = /^(.*?)(\d+)$/.exec(token);
  if (digitMatch !== null) {
    const digits = digitMatch[2];
    const lastDigit = Number(digits.at(-1));
    if (!/[A-Za-z]/.test(digitMatch[1])) return DIGIT_KOREAN[lastDigit];

    // 글자 뒤 숫자는 영어로 읽는다. S3 에스쓰리, v1 브이원, EC2 이씨투.
    // 다만 한 자리일 때만 그렇다. p99 는 "피 나인티나인" 이 아니라 "피 구십구" 로 읽고,
    // 어느 쪽인지 갈리는 자리다. 갈리면 판정하지 않는다.
    return digits.length === 1 ? DIGIT_ENGLISH[lastDigit] : null;
  }

  // 대문자만으로 된 짧은 두음자어는 흔히 글자로 읽지만, GET·PUT·DROP처럼 낱말로 읽는
  // 것도 있다. 모음이 없으면 낱말로 읽을 방법이 없으니 글자로 읽고, 모음이 있으면
  // 글자로 읽는다고 확인된 것(SPELLED_ACRONYMS)만 판정한다. 나머지는 판정하지 않는다.
  if (/^[A-Z]{2,4}$/.test(token)) {
    const hasVowel = [...token].some((ch) => VOWEL_LETTERS.has(ch));
    if (hasVowel && !SPELLED_ACRONYMS.has(token)) return null;
    const last = token.at(-1).toLowerCase();
    if (!LETTERS.includes(last)) return null;
    return LETTER_FINAL[last] ?? NO_FINAL;
  }

  return null;
}

/**
 * 받침이 있는지만 본다. 받침의 종류가 필요한 자리에서는 finalSoundOf 를 쓴다.
 *
 * @param {string} word
 * @returns {boolean|null}
 */
export function hasFinalSound(word) {
  const final = finalSoundOf(word);
  return final === null ? null : final !== NO_FINAL;
}

/**
 * 조사가 앞말에 맞는지 보고, 틀렸으면 올바른 형태를 돌려준다.
 *
 * @param {string} word 앞말
 * @param {string} particle 뒤에 붙은 조사
 * @returns {string|null} 고칠 필요가 없거나 판정할 수 없으면 null
 */
export function correctParticle(word, particle) {
  const pair = PAIRS.find(([withFinal, without]) => particle === withFinal || particle === without);
  if (pair === undefined) return null;
  // "10여 개"의 "여"는 계사가 아니라 숫자 접미사(남짓)다. 순수 숫자 뒤에서는 겹치는
  // 계사 활용형을 판정하지 않는다.
  if (DIGIT_TOKEN.test(word) && NUMERAL_SUFFIX_COLLISION.has(particle)) return null;

  const final = finalSoundOf(word);
  if (final === null) return null;

  // 으로/로 만 예외다. ㄹ 받침 뒤에는 로를 쓴다. 서울로, 1로(일), URL로(유알엘).
  const usesShortForm = final === NO_FINAL || (final === RIEUL && pair[1].endsWith("로"));
  const correct = usesShortForm ? pair[1] : pair[0];
  return correct === particle ? null : correct;
}

// 긴 조사를 먼저 시도해야 한다. `으로서` 를 `으로` 로 자르면 남은 `서` 때문에 어긋난다.
// PAIRS 가 이미 긴 것부터 적혀 있으므로 그 순서를 그대로 쓴다.
//
// (?![가-힣]) 는 "commit은행"의 "은"을 조사로 잘라내지 않으려는 방어다. 그 대가로
// "이었"·"이에요"·"이랑"처럼 여러 음절인 계사 활용형은 뒤에 어미가 이어지는 실제 문장
// (예: "commit이었습니다"의 "이었" 뒤에 "습")에서 이 함수로는 거의 못 잡는다 — 항상
// 한글이 이어지기 때문이다. 일부러 손대지 않는다: 이 짝들의 진짜 쓸모는 lint.mjs의
// particleRisk 가 규칙 치환 뒤에 오는 이 조사들을 보고 자동 교정을 건너뛰는 것이고,
// 그건 첫 글자만 필요해 이 문제와 무관하다. 조사를 더 너그럽게 자르면 "state가"처럼
// 무관한 한글이 뒤에 오는 자리에서 오탐이 날 위험이 있다 — 불변식 5.
const PARTICLE_ALTERNATION = [...new Set(PAIRS.flat())].join("|");
const TOKEN_WITH_PARTICLE = new RegExp(
  `([A-Za-z][A-Za-z0-9]*|\\d+)(${PARTICLE_ALTERNATION})(?![가-힣])`,
  "g"
);

/**
 * 글에서 조사가 틀린 자리를 찾는다.
 *
 * 코드 블록, 인라인 코드, 경로는 제외한다. `commit를` 이 코드 예시 안에 있으면
 * 그대로 두어야 한다. 문서가 스스로를 예외로 선언했으면 아무것도 보고하지 않는다.
 *
 * @param {string} text
 * @returns {{matched: string, word: string, particle: string, correct: string, index: number}[]}
 */
export function findParticleErrors(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  // lint() 와 같은 기제를 쓴다. 한쪽만 표시를 존중하면 문체 가이드 문서에서 갈린다.
  if (isIgnoredFile(text)) return [];

  // 위치를 보존하며 제외 구간을 덮는다. 찾은 자리가 원문 위치와 그대로 맞는다.
  const masked = maskProtected(text);

  const found = [];
  TOKEN_WITH_PARTICLE.lastIndex = 0;
  let match;

  while ((match = TOKEN_WITH_PARTICLE.exec(masked)) !== null) {
    const [matched, word, particle] = match;
    const correct = correctParticle(word, particle);
    if (correct === null) continue;
    found.push({ matched, word, particle, correct, index: match.index });
  }

  return found;
}

/**
 * 틀린 조사를 고친다. 뒤에서부터 바꿔 위치가 어긋나지 않게 한다.
 *
 * @param {string} text
 * @returns {{text: string, applied: object[]}}
 */
export function fixParticles(text) {
  const found = findParticleErrors(text);
  if (found.length === 0) return { text: typeof text === "string" ? text : "", applied: [] };

  let result = text;
  for (const hit of [...found].reverse()) {
    const end = hit.index + hit.matched.length;
    result = `${result.slice(0, hit.index)}${hit.word}${hit.correct}${result.slice(end)}`;
  }

  return { text: result, applied: found };
}

/**
 * 사람이 읽을 메시지로 만든다.
 *
 * @param {object[]} found
 * @returns {string}
 */
export function formatParticleErrors(found) {
  if (found.length === 0) return "";
  const lines = found.map((hit) => `- "${hit.matched}" → "${hit.word}${hit.correct}"`);
  return [`영어 낱말 뒤 조사가 발음과 맞지 않는 곳 ${found.length}건입니다.`, "", ...lines].join("\n");
}
