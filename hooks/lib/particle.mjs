// 영어 낱말과 숫자 뒤의 조사를 발음으로 판정한다.
//
// 한국어 조사는 앞말의 **발음**이 결정한다. 철자가 아니다. 그래서 `commit을` 은 맞고
// `commit를` 은 틀리다. 커밋의 끝소리에 ㅅ 받침이 있기 때문이다.
//
// 규칙표에 낱말마다 한 줄씩 넣는 방식으로는 덮을 수 없다. 영어 낱말은 무한하다.
// 그래서 읽는 법을 아는 것만 판정하고 **모르면 판정하지 않는다.**
// 틀린 자동 교정은 없는 것보다 나쁘다.

import { maskProtected, isIgnoredFile } from "./segment.mjs";
import { groupCounted, formatGroupedList, MAX_LISTED } from "./format.mjs";

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

  // 라틴 문자 그대로 쓰기로 한 개발 명사(0.15.0 이후 문체가 유지하라고 하는 낱말들).
  // 여러 낱말로 된 용어(race condition, sanity check 등)도 조사는 마지막 낱말에만
  // 붙으므로 그 낱말만 올린다 — TOKEN_WITH_PARTICLE 이 한 낱말만 잡기 때문이다.
  state: NO_FINAL, // 스테이트
  props: NO_FINAL, // 프롭스
  target: OTHER_FINAL, // 타깃/타겟 — 둘 다 ㅅ
  directory: NO_FINAL, // 디렉터리
  query: NO_FINAL, // 쿼리
  handler: NO_FINAL, // 핸들러
  middleware: NO_FINAL, // 미들웨어
  reducer: NO_FINAL, // 리듀서
  condition: OTHER_FINAL, // (race) 컨디션 — ㄴ
  deadlock: OTHER_FINAL, // 데드락 — ㄱ
  latency: NO_FINAL, // 레이턴시
  throughput: OTHER_FINAL, // 스루풋 — ㅅ
  effect: NO_FINAL, // (side) 이펙트
  regression: OTHER_FINAL, // 리그레션 — ㄴ
  truth: NO_FINAL, // (source of) 트루스
  check: NO_FINAL, // (sanity) 체크
  limit: OTHER_FINAL, // (rate) 리밋 — ㅅ
  hatch: NO_FINAL, // (escape) 해치
  return: OTHER_FINAL, // (early) 리턴 — ㄴ
  change: NO_FINAL, // (breaking) 체인지
  degradation: OTHER_FINAL, // (graceful) 디그레데이션 — ㄴ
  sanitization: OTHER_FINAL, // 새니타이제이션 — ㄴ
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

/**
 * 받침 종류를 이미 알고 있을 때 조사가 맞는지 본다. correctParticle과 괄호 뒤 조사
 * 판정(findParenParticleErrors)이 함께 쓴다 — 받침을 얻는 방법만 다르다(영어는 발음
 * 사전, 괄호 앞 한글은 종성 코드).
 *
 * @param {""|"ㄹ"|"other"} final
 * @param {string} particle
 * @returns {string|null}
 */
function correctForFinal(final, particle) {
  const pair = PAIRS.find(([withFinal, without]) => particle === withFinal || particle === without);
  if (pair === undefined) return null;
  const usesShortForm = final === NO_FINAL || (final === RIEUL && pair[1].endsWith("로"));
  const correct = usesShortForm ? pair[1] : pair[0];
  return correct === particle ? null : correct;
}

// 한글 음절 코드에서 종성(받침) 색인. lint.mjs의 finalConsonantClass와 같은 상수다 —
// lint.mjs가 이미 particle.mjs를 임포트하므로(particleHeads 등) 거꾸로 임포트하면
// 순환 참조가 생긴다. 상수 네 개뿐이라 각자 갖는 편이 회로를 끊는 것보다 싸다.
const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;
const JAMO_COUNT = 28;
const RIEUL_FINAL_INDEX = 8;

/**
 * 괄호 앞 한글 낱말의 끝 음절 받침을 판정한다. 한글이 아니면 null.
 *
 * @param {string} ch 한 글자
 * @returns {""|"ㄹ"|"other"|null}
 */
function hangulFinalOf(ch) {
  if (typeof ch !== "string" || ch.length === 0) return null;
  const code = ch.charCodeAt(0);
  if (code < HANGUL_START || code > HANGUL_END) return null;
  const finalIndex = (code - HANGUL_START) % JAMO_COUNT;
  if (finalIndex === 0) return NO_FINAL;
  if (finalIndex === RIEUL_FINAL_INDEX) return RIEUL;
  return OTHER_FINAL;
}

const HANGUL_SYLLABLE = /[가-힣]/;
const ALNUM = /[A-Za-z0-9]/;

/**
 * 닫는 괄호 바로 앞, 여는 괄호 바로 앞의 낱말이 받침을 판정할 수 있는지 본다.
 * 판정할 수 없으면(빈 낱말, 여는 괄호가 줄 맨 앞, 코드로 가려진 자리, 순수 숫자) null —
 * NIKL 온라인가나다는 괄호 뒤 조사가 괄호 안이 아니라 괄호 앞말을 따른다고 답한다
 * (327689, 296978, 302384, 316103). 개발 문서에서 영어 원어를 괄호로 병기하는 자리에
 * 흔히 나온다: "암호 기법(secret key cryptography)이".
 *
 * @param {string} masked maskProtected를 거친 글 — 코드/링크는 이미 센티넬로 덮여 있다.
 * @param {number} openIdx 여는 괄호 "(" 의 위치
 * @returns {{start: number, final: ""|"ㄹ"|"other"}|null}
 */
function wordBeforeParen(masked, openIdx) {
  if (openIdx <= 0) return null;
  const prev = masked[openIdx - 1];

  if (HANGUL_SYLLABLE.test(prev)) {
    let start = openIdx - 1;
    while (start > 0 && HANGUL_SYLLABLE.test(masked[start - 1])) start -= 1;
    return { start, final: hangulFinalOf(prev) };
  }

  if (ALNUM.test(prev)) {
    let start = openIdx - 1;
    while (start > 0 && ALNUM.test(masked[start - 1])) start -= 1;
    const run = masked.slice(start, openIdx);
    // 순수 숫자는 괄호 앞에서는 판정하지 않는다 — "3(three)" 처럼 숫자와 영어 원어가
    // 함께 괄호로 병기되는 자리는 근거로 삼은 조사(온라인가나다 항목들)가 다루지 않아
    // 모호하다고 본다. 낱말 하나가 여러 글자로 된 경우(S3, v1)는 그대로 finalSoundOf에
    // 맡긴다 — 이미 아는 자리다.
    if (DIGIT_TOKEN.test(run)) return null;
    const final = finalSoundOf(run);
    return final === null ? null : { start, final };
  }

  return null;
}

/**
 * 닫는 괄호 바로 앞에서 여는 괄호를 찾는다. 중첩되었거나(괄호 안에 괄호가 또 있음)
 * 안 닫혔으면 null — 중첩은 "괄호 앞말"이 어느 괄호의 앞말인지 모호해 판정하지 않는다
 * (불변식 5).
 *
 * @param {string} masked
 * @param {number} closeIdx 닫는 괄호 ")" 의 위치
 * @returns {number|null}
 */
function findSimpleOpenParen(masked, closeIdx) {
  let i = closeIdx - 1;
  while (i >= 0 && masked[i] !== "(" && masked[i] !== ")") i -= 1;
  return i >= 0 && masked[i] === "(" ? i : null;
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

// 닫는 괄호 바로 뒤에 조사가 오는 자리. TOKEN_WITH_PARTICLE과 같은 조사 목록을 쓰되
// 앞말이 영어 낱말/숫자가 아니라 괄호라는 점만 다르다.
const PAREN_PARTICLE = new RegExp(`\\)(${PARTICLE_ALTERNATION})(?![가-힣])`, "g");

/**
 * 글에서 "낱말(원어)조사" 형태의 틀린 자리를 찾는다. findParticleErrors가 합쳐서 쓴다.
 *
 * @param {string} masked maskProtected를 거친 글
 * @param {string} original 위치가 같은 원문 — 메시지·교정에 실제 글자를 보여주려고 쓴다.
 * @returns {{matched: string, word: string, particle: string, correct: string, index: number}[]}
 */
function findParenParticleErrors(masked, original) {
  const found = [];
  PAREN_PARTICLE.lastIndex = 0;
  let match;
  while ((match = PAREN_PARTICLE.exec(masked)) !== null) {
    const closeIdx = match.index; // match[0]이 ")"로 시작하므로 match.index가 그 위치다.
    const particle = match[1];

    const openIdx = findSimpleOpenParen(masked, closeIdx);
    if (openIdx === null) continue; // 중첩되었거나 안 닫힌 괄호
    if (openIdx + 1 === closeIdx) continue; // 빈 괄호

    const info = wordBeforeParen(masked, openIdx);
    if (info === null) continue;

    const correct = correctForFinal(info.final, particle);
    if (correct === null) continue;

    const word = original.slice(info.start, closeIdx + 1); // "낱말(원어)" 그대로
    found.push({ matched: word + particle, word, particle, correct, index: info.start });
  }
  return found;
}

/**
 * 글에서 조사가 틀린 자리를 찾는다.
 *
 * 코드 블록, 인라인 코드, 경로는 제외한다. `commit를` 이 코드 예시 안에 있으면
 * 그대로 두어야 한다. 문서가 스스로를 예외로 선언했으면 아무것도 보고하지 않는다.
 *
 * @param {string} text
 * @param {{ext?: string, refDefs?: Set<string>|null}} [mask] maskProtected에 그대로 전달한다.
 *   ext: 문서 확장자(점 없이, 소문자). 들여쓰기 코드·<pre>/<code>·rST·AsciiDoc 같은 문서 전용
 *   가리개도 적용받는다. 생략하면(예: 커밋 메시지) 일반 가리개만 적용된다.
 * @returns {{matched: string, word: string, particle: string, correct: string, index: number}[]}
 */
export function findParticleErrors(text, mask = {}) {
  if (typeof text !== "string" || text.length === 0) return [];
  // lint() 와 같은 기제를 쓴다. 한쪽만 표시를 존중하면 문체 가이드 문서에서 갈린다.
  if (isIgnoredFile(text)) return [];

  // 위치를 보존하며 제외 구간을 덮는다. 찾은 자리가 원문 위치와 그대로 맞는다.
  const masked = maskProtected(text, mask);

  const found = [];
  TOKEN_WITH_PARTICLE.lastIndex = 0;
  let match;

  while ((match = TOKEN_WITH_PARTICLE.exec(masked)) !== null) {
    const [matched, word, particle] = match;
    const correct = correctParticle(word, particle);
    if (correct === null) continue;
    found.push({ matched, word, particle, correct, index: match.index });
  }

  // "낱말(원어)조사"는 앞말 자리가 다르지만 겹치지 않는다 — TOKEN_WITH_PARTICLE은 영어
  // 낱말 뒤에 조사가 곧장 붙는 자리만 잡고, 괄호가 끼어 있으면 애초에 매치하지 않는다.
  // fixParticles가 뒤에서부터 안전하게 이어 붙이려면 index 오름차순이어야 해 합친 뒤 정렬한다.
  found.push(...findParenParticleErrors(masked, text));
  found.sort((a, b) => a.index - b.index);

  return found;
}

/**
 * 틀린 조사를 고친다. 뒤에서부터 바꿔 위치가 어긋나지 않게 한다.
 *
 * @param {string} text
 * @param {{ext?: string, refDefs?: Set<string>|null}} [mask] findParticleErrors 에 그대로 전달한다.
 * @returns {{text: string, applied: object[]}}
 */
export function fixParticles(text, mask = {}) {
  const found = findParticleErrors(text, mask);
  if (found.length === 0) return { text: typeof text === "string" ? text : "", applied: [] };

  // found는 TOKEN_WITH_PARTICLE이 왼쪽에서 오른쪽으로 훑어 찾은 순서라 index 오름차순이고
  // 서로 겹치지 않는다. 교정마다 전체 문자열을 slice + concat 하면 교정 건수 × 문서
  // 길이에 비례해 느려진다 — 실측: 1.2MB 문서, 교정 수만 건에서 10초 넘게 걸렸다(이차
  // 비용). 조각을 모아 한 번만 이어 붙인다.
  const pieces = [];
  let cursor = 0;
  for (const hit of found) {
    pieces.push(text.slice(cursor, hit.index), hit.word, hit.correct);
    cursor = hit.index + hit.matched.length;
  }
  pieces.push(text.slice(cursor));

  return { text: pieces.join(""), applied: found };
}

// 같은 오류가 문서에 수천 번 반복될 수 있다("commit를" × 1000). 종류별로 묶어 세지
// 않으면 같은 줄이 그만큼 나열되어 메시지가 건수에 비례해 커진다(lint.mjs의
// formatFindings와 같은 문제, 같은 해법). 목록은 종류 몇 가지만 보여 주고 나머지는
// 개수로만 말한다 — pii.mjs의 MAX_LISTED와 같은 관례다. 묶고 나열하는 부분은
// format.mjs 하나로 모았다.
const MAX_LISTED_PARTICLES = MAX_LISTED;

/**
 * 사람이 읽을 메시지로 만든다. 같은 교정(같은 낱말 → 같은 고침)은 한 줄로 묶고 건수를
 * 덧붙인다.
 *
 * @param {object[]} found
 * @returns {string}
 */
export function formatParticleErrors(found) {
  if (found.length === 0) return "";

  const entries = groupCounted(found, (hit) => `${hit.word}${hit.particle}\u0000${hit.correct}`);

  const header =
    entries.length === found.length
      ? `영어 낱말 뒤 조사가 발음과 맞지 않는 곳 ${found.length}건입니다.`
      : `영어 낱말 뒤 조사가 발음과 맞지 않는 곳 ${entries.length}가지(총 ${found.length}건)입니다.`;

  const lines = formatGroupedList(
    entries,
    ({ item: hit, count }) =>
      `- "${hit.matched}" → "${hit.word}${hit.correct}"${count > 1 ? ` (총 ${count}곳)` : ""}`,
    MAX_LISTED_PARTICLES
  );

  return [header, "", ...lines].join("\n");
}
