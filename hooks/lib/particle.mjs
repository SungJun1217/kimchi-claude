// 영어 낱말과 숫자 뒤의 조사를 발음으로 판정한다.
//
// 한국어 조사는 앞말의 **발음**이 결정한다. 철자가 아니다. 그래서 `commit을` 은 맞고
// `commit를` 은 틀리다. 커밋의 끝소리에 ㅅ 받침이 있기 때문이다.
//
// 규칙표에 낱말마다 한 줄씩 넣는 방식으로는 덮을 수 없다. 영어 낱말은 무한하다.
// 그래서 읽는 법을 아는 것만 판정하고 **모르면 판정하지 않는다.**
// 틀린 자동 교정은 없는 것보다 나쁘다.

import { maskProtected } from "./segment.mjs";

/** 받침에 따라 갈리는 조사 짝. 받침 있을 때 쓰는 것을 먼저 적는다. */
const PAIRS = [
  ["으로서", "로서"],
  ["으로써", "로써"],
  ["으로", "로"],
  ["이나", "나"],
  ["이란", "란"],
  ["이라", "라"],
  ["이며", "며"],
  ["이든", "든"],
  ["을", "를"],
  ["이", "가"],
  ["은", "는"],
  ["과", "와"],
];

// 순수 숫자는 한국어 수사로 읽는다. 3 → 삼(ㅁ).
const DIGIT_KOREAN = [
  true, // 0 영·공 — ㅇ
  true, // 1 일 — ㄹ
  false, // 2 이
  true, // 3 삼 — ㅁ
  false, // 4 사
  false, // 5 오
  true, // 6 육 — ㄱ
  true, // 7 칠 — ㄹ
  true, // 8 팔 — ㄹ
  false, // 9 구
];

// 글자가 앞에 붙은 숫자는 영어로 읽는다. S3 → 에스쓰리, v1 → 브이원.
// 같은 3 이 문맥에 따라 삼(받침 있음)과 쓰리(받침 없음)로 갈린다.
const DIGIT_ENGLISH = [
  false, // 0 제로
  true, // 1 원 — ㄴ
  false, // 2 투
  false, // 3 쓰리
  false, // 4 포
  false, // 5 파이브
  false, // 6 식스
  true, // 7 세븐 — ㄴ
  false, // 8 에이트
  true, // 9 나인 — ㄴ
];

// 낱자를 읽는 법. 두음자어를 글자로 읽을 때 마지막 글자만 보면 된다.
// 받침이 있는 것만 적는다. L 엘, M 엠, N 엔, R 알.
const LETTERS_WITH_FINAL = new Set(["l", "m", "n", "r"]);
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

// 읽는 법을 아는 낱말. **여기가 유일한 원본이다.** 값은 끝소리에 받침이 있는지다.
//
// 목록에 없는 낱말은 판정하지 않는다. 철자로 끝소리를 유도할 수 없기 때문이다.
// `cache` 는 캐시(받침 없음)인데 `attach` 는 어태치(받침 없음), `match` 는 매치.
// 반면 `hook` 은 훅(ㄱ), `stack` 은 스택(ㄱ). 철자 규칙으로는 갈릴 수 없다.
const LEXICON = {
  // 글자로 읽으면 틀리는 두음자어
  json: true, // 제이슨 — ㄴ
  yaml: true, // 야믈 — ㄹ
  toml: true, // 토믈 — ㄹ
  ssl: true, // 에스에스엘 — ㄹ
  url: true, // 유알엘 — ㄹ
  npm: true, // 엔피엠 — ㅁ
  rest: false, // 레스트
  crud: false, // 크러드
  ajax: false, // 에이잭스
  cors: false, // 코스
  jwt: false, // 제이더블유티
  saas: false, // 사스
  tls: false, // 티엘에스
  ssh: false, // 에스에스에이치
  uri: false, // 유알아이

  // 형상 관리와 도구
  git: true, // 깃 — ㅅ
  commit: true, // 커밋 — ㅅ
  webpack: true, // 웹팩 — ㄱ
  pull: true, // 풀 — ㄹ
  merge: false, // 머지
  rebase: false, // 리베이스
  branch: false, // 브랜치
  tag: false, // 태그
  push: false, // 푸시
  fork: false, // 포크
  docker: false, // 도커
  node: false, // 노드
  vite: false, // 비트

  // 자료와 저장소
  stack: true, // 스택 — ㄱ
  heap: true, // 힙 — ㅂ
  table: true, // 테이블 — ㄹ
  column: true, // 칼럼 — ㅁ
  mysql: true, // 마이에스큐엘 — ㄹ
  cache: false, // 캐시
  buffer: false, // 버퍼
  queue: false, // 큐
  index: false, // 인덱스
  schema: false, // 스키마
  redis: false, // 레디스
  postgres: false, // 포스트그레스
  mongodb: false, // 몽고디비

  // 코드 개념
  module: true, // 모듈 — ㄹ
  function: true, // 펑션 — ㄴ
  token: true, // 토큰 — ㄴ
  session: true, // 세션 — ㄴ
  stream: true, // 스트림 — ㅁ
  hook: true, // 훅 — ㄱ
  timeout: true, // 타임아웃 — ㅅ
  callback: true, // 콜백 — ㄱ
  method: false, // 메서드
  class: false, // 클래스
  package: false, // 패키지
  import: false, // 임포트
  export: false, // 익스포트
  build: false, // 빌드
  test: false, // 테스트
  lint: false, // 린트
  thread: false, // 스레드
  cookie: false, // 쿠키
  request: false, // 리퀘스트
  response: false, // 리스폰스
  endpoint: false, // 엔드포인트
  payload: false, // 페이로드
  promise: false, // 프로미스
  log: false, // 로그
  server: false, // 서버
  client: false, // 클라이언트
  browser: false, // 브라우저
  proxy: false, // 프록시
  port: false, // 포트
  host: false, // 호스트
};

/**
 * 영어 낱말이나 숫자의 한국어 끝소리에 받침이 있는지 판정한다.
 *
 * @param {string} word
 * @returns {boolean|null} 읽는 법을 모르면 null
 */
export function hasFinalSound(word) {
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
    const lastDigit = Number(digitMatch[2].at(-1));
    const readInEnglish = /[A-Za-z]/.test(digitMatch[1]);
    return readInEnglish ? DIGIT_ENGLISH[lastDigit] : DIGIT_KOREAN[lastDigit];
  }

  // 대문자만으로 된 짧은 두음자어는 글자로 읽는다.
  // 목록에 없는 긴 것은 낱말로 읽힐 수 있어 판정하지 않는다.
  if (/^[A-Z]{2,4}$/.test(token)) {
    const last = token.at(-1).toLowerCase();
    if (!LETTERS.includes(last)) return null;
    return LETTERS_WITH_FINAL.has(last);
  }

  return null;
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

  const final = hasFinalSound(word);
  if (final === null) return null;

  const correct = final ? pair[0] : pair[1];
  return correct === particle ? null : correct;
}

// 긴 조사를 먼저 시도해야 한다. `으로서` 를 `으로` 로 자르면 남은 `서` 때문에 어긋난다.
// PAIRS 가 이미 긴 것부터 적혀 있으므로 그 순서를 그대로 쓴다.
const PARTICLE_ALTERNATION = [...new Set(PAIRS.flat())].join("|");
const TOKEN_WITH_PARTICLE = new RegExp(
  `([A-Za-z][A-Za-z0-9]*|\\d+)(${PARTICLE_ALTERNATION})(?![가-힣])`,
  "g"
);

/**
 * 글에서 조사가 틀린 자리를 찾는다.
 *
 * 코드 블록, 인라인 코드, 경로는 제외한다. `commit를` 이 코드 예시 안에 있으면
 * 그대로 두어야 한다.
 *
 * @param {string} text
 * @returns {{matched: string, word: string, particle: string, correct: string, index: number}[]}
 */
export function findParticleErrors(text) {
  if (typeof text !== "string" || text.length === 0) return [];

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
