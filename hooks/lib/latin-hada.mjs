// 로마자 영어 동사에 한국어 "하다/되다" 어미를 그대로 붙인 표현을 찾는다.
//
// "push합니다", "deploy한"처럼 로마자는 명사 자리에만 쓴다는 0.15.0 표기 원칙(정착한
// 음차 동사는 한글로 쓴다, output-styles/natural-korean.md PREAMBLE)을 rules/*.md 표로는
// 표현할 수 없다 — toPattern(lint.mjs)이 지원하는 건 리터럴과 ~ 물결 와일드카드뿐이라
// "임의의 로마자 동사 + 하다 활용형"이라는 패턴 자체를 규칙 표 한 줄로 적을 수 없다.
// 그래서 이 작은 데이터 표를 엔진이 직접 읽는다.
//
// rules/ 디렉터리에 두지 않는 이유는 parseTable이 6칸 표(| 원어 | 쓰지 말 것 | 쓸 것 |
// 이유 | 검사 | 순위 |)만 규칙으로 읽고, 그 형식에 안 맞는 줄은 "형식이 깨진 행"으로
// 세기 때문이다 — corpus.test.mjs가 loadRules(rules/)의 skipped === 0을 강제하므로,
// 다른 형식의 표를 rules/ 에 섞으면 그 시험이 깨진다. rules/ 밖의 이 파일이 덜 침습적이다.
//
// 문맥마다 자연스러운 한글 활용형이 다를 수 있어(불변식 5, "확신이 없으면 판단하지
// 않는다") 자동 교정은 하지 않는다 — CHECK_REGEX로만 분류해 applyFixes가 절대 이
// 발견을 집어 고치지 않게 한다(applyFixes는 CHECK_SUBSTITUTE만 거른다).
//
// lint()에는 이 파일 끝의 LATIN_HADA_RULE 하나로 얹힌다 — bad/good이 규칙표처럼 고정된
// 문자열이 아니라 매치마다(동사마다) 달라지므로, toPattern(lint.mjs)이 쓰는 정적 정규식
// 대신 find(masked, normalized) 매처를 규칙 객체에 얹는 일반 기제를 쓴다. rules.mjs의
// loadRules()가 이 규칙을 builtins로 내보내고, 실제 검사에 쓰는 소비자(artifact.loadToneRules
// 등)만 rules에 이어 붙인다 — 규칙표만 보는 소비자(build-style.mjs, corpus.test.mjs 등)는
// 그대로 rules만 쓰므로 이 규칙이 섞여 들어오지 않는다.

import { CHECK_REGEX } from "./checks.mjs";
import { MASK } from "./segment.mjs";

// 동사만 담는다(명사 자리에서 쓰는 state·props·target 같은 낱말은 뺀다 — 0.15.0 표기
// 원칙 3번이 이미 로마자로 남겨 두라고 정한 자리다). 자주 관찰된 사고(push합니다,
// deploy한)에서 시작해 흔한 개발 동사로 넓힌 목록이다.
//
// 일부러 뺀 동사(불변식 5 — 확신이 없으면 판단하지 않는다):
//
//   import, export — 언어 키워드 자체다("import { x } from …", Next.js output: 'export').
//     "한 모듈이 상대에게서 import하는 심볼 수"(실제 관찰된 문장)는 표기 위반이 아니라
//     import라는 구문 자체를 가리키는 말이다. 검사할 수 없으니 빼는 것이 아니라, 빼는
//     쪽이 맞아서 뺐다 — 진짜 "가져오다/내보내다"라는 뜻으로 로마자를 쓴 사례를 이 낱말
//     하나로는 구별할 수 없다.
//   return, delete — 대부분의 언어에서 예약어다(return문, delete 연산자). 같은 이유로 뺀다.
//   fetch, load, render — 특정 언어 키워드는 아니지만 그 자체가 흔히 참조되는 전역
//     API·생명주기 메서드 이름이다(fetch(), window.onload, React의 render()). "state를
//     render하면"이 실제 render() 호출을 가리키는지 "그리다"라는 뜻인지 낱말만으로는
//     가를 수 없다.
//
// 반대로 남긴 것들도 같은 잣대로 다시 봤다. call(Function.prototype.call)·apply
// (Function.prototype.apply)·reset(git reset, form.reset())도 API 이름으로 쓰이지만,
// 실제 개발 대화에서는 "API를 call하면"·"패치를 apply하면"·"상태를 reset하면"처럼
// 압도적으로 일반 동사로 더 많이 쓰인다 — 위 여섯과 달리 언어 구문 자체를 가리키는
// 용법이 지배적이지 않다고 판단해 남겼다.
//
// 이유가 다른 두 낱말도 뺐다(둘 다 "쓸 것" 칸을 하나로 정할 수 없다는 게 공통점이다):
//
//   check — "체크된 항목"·"checked checkbox"처럼 체크박스·마킹을 뜻하는 자리가 흔하고,
//     이때 "확인"으로 바꾸면 뜻이 달라진다(확인은 검증, 체크는 표시). 낱말만으로는
//     어느 뜻인지 가를 수 없다.
//   pull — "풀해서"는 실제로 쓰이지 않는다. 개발자는 "pull 받아서"처럼 pull을 로마자
//     명사로 남기고 조사·동사를 따로 붙인다("PR 자리에만 로마자를 쓴다"는 0.15.0
//     원칙 3번과 같은 결의 예외다). "풀하다"라는 정착 음차 자체가 없다.
const VERBS = {
  push: "푸시", merge: "머지", rebase: "리베이스", deploy: "배포",
  call: "호출", update: "업데이트", fix: "수정", commit: "커밋",
  build: "빌드", run: "실행", test: "테스트", review: "리뷰", refactor: "리팩터링",
  handle: "처리", install: "설치", reset: "리셋", apply: "적용", release: "릴리스",
  trigger: "트리거", iterate: "순회", parse: "파싱",
  validate: "검증", sync: "동기화", save: "저장",
  create: "생성", send: "전송",
};

// "하다"/"되다" 활용형의 시작 조각. 여기 나열한 순서는 상관없다 — 아래 SUFFIX_PATTERN이
// 길이 내림차순으로 다시 정렬한다("하다"가 "하"보다 먼저 와야 정규식 교대(|)가 "하다"까지
// 통째로 잡는다. 정렬 없이 "하"가 먼저 오면 "다"를 뒤에 남긴다).
const SUFFIXES = [
  "합니다", "하세요", "됩니다", "하도록", "하려면",
  "하다", "하는", "하고", "하면", "해서", "하기", "하여", "되는", "되면", "되고", "되어",
  "하지", "하게", "되지",
  "한", "할", "해", "했", "된", "돼", "됐", "됨", "함",
];

const VERB_PATTERN = Object.keys(VERBS)
  .sort((a, b) => b.length - a.length)
  .join("|");
const SUFFIX_PATTERN = [...SUFFIXES].sort((a, b) => b.length - a.length).join("|");

// 왼쪽 경계. 두 갈래를 막는다.
//
// 1. 로마자·숫자·밑줄·마침표·하이픈·콜론·슬래시·골뱅이·달러 기호 바로 뒤 — 다른 낱말
//    속(rebuild합니다의 build)이나 코드 조각(fn.call하면, npm:build할, obj.save할)의
//    일부를 잘못 자르지 않는다. 이 문자들은 식별자·경로·네임스페이스 구분자로만 쓰이므로
//    폭넓게 넣어도 손해가 적다.
// 2. 로마자·숫자 낱말 + 공백 바로 뒤(가변 길이 lookbehind, V8이 지원한다) — "git push하면",
//    "npm test하면", "cargo build하면", "npm run build한"처럼 명령 이름이 앞에 붙거나
//    "unit test하는", "smoke test한"처럼 영어 합성어의 일부일 때는 실제로 관찰된 문장이라도
//    빼야 한다(불변식 5). "이제 push합니다"처럼 앞이 한글이면 이 갈래는 아예 안 걸린다
//    ([A-Za-z0-9]+가 한글 앞에서 시작할 수 없다).
//
// 한글이 로마자 동사 바로 앞에 붙는 경우(예: "재commit해야")는 이 함수 자체의 두 갈래
// 어디에도 안 걸리지만, 실제로는 findLatinVerbHada가 항상 masked 문자열(maskProtected가
// 이미 가린 것)에서 도는 덕에 더 앞단에서 걸러진다 — segment.mjs가 "한글 음절 + 로마자
// 소문자(또는 대문자+소문자)"를 "타겟Id"류 혼합 식별자로 보고 통째로 가린다("재commit"도
// 그 모양에 맞는다). 그래서 이 경계는 여기서 따로 만들지 않는다 — 이미 있는 보호를
// 또 만들면 두 곳이 어긋날 뿐이다. 오른쪽은 SUFFIX_PATTERN 자체가 경계다 — "pushed"처럼
// 뒤에 "하다"/"되다" 계열이 오지 않으면 애초에 매치하지 않는다.
// 가린 자리(MASK, "\u0000")도 로마자 낱말처럼 본다. "`git` push하면"은 백틱이 가려진 뒤
// 명령 이름 자리가 MASK로 남는다. 역슬래시는 Windows 경로("C:\\build한")라서 뺀다. 앞 낱말과의
// 사이는 줄바꿈이 아닌 공백만 본다. 줄 첫머리의 동사를 윗줄 끝 영어 낱말이 가리면 안 된다.
const LEFT_BOUNDARY = String.raw`(?<![A-Za-z0-9_.:/@$\\${MASK}-]|[A-Za-z0-9${MASK}]+[ \t])`;
const LATIN_VERB_HADA_PATTERN = new RegExp(
  `${LEFT_BOUNDARY}(${VERB_PATTERN})(${SUFFIX_PATTERN})`,
  "gi"
);

// 정규식이 병적인 입력에서 무한히 돌지 않도록 하는 안전 상한. 실제 문서에서 같은 동사가
// 이만큼 반복되는 일은 없다 — lint.mjs의 다른 상한들과 같은 목적이다.
const MAX_HITS = 1000;

const LATIN_HADA_SOURCE = "latin-hada";
const LATIN_HADA_WHY = "로마자 동사에 하다를 붙이지 않는다. 정착한 음차 동사는 한글로 쓴다.";

/**
 * masked 문자열(maskProtected가 이미 코드·경로·URL을 가린 것)에서 "로마자 동사+하다"
 * 표현을 찾는다. lint()의 규칙 기반 발견과 같은 모양의 객체를 돌려준다.
 *
 * @param {string} masked 검사 대상. 코드·경로 등은 이미 센티넬로 덮여 있다고 가정한다.
 * @param {string} normalized masked와 길이가 같은 원문(정규화된). 실제로 보여 줄 원문을 여기서 뽑는다.
 * @returns {object[]}
 */
export function findLatinVerbHada(masked, normalized) {
  if (typeof masked !== "string" || masked.length === 0) return [];

  const findings = [];
  LATIN_VERB_HADA_PATTERN.lastIndex = 0;
  let match;
  let hits = 0;
  while (hits < MAX_HITS && (match = LATIN_VERB_HADA_PATTERN.exec(masked)) !== null) {
    hits += 1;
    const verb = match[1].toLowerCase();
    const hangul = VERBS[verb]; // VERB_PATTERN이 VERBS의 키로만 만들어지므로 항상 찾는다.
    const suffix = match[2];
    const good = `${hangul}${suffix}`;
    const matched = normalized.slice(match.index, match.index + match[0].length);

    findings.push({
      bad: `${LATIN_HADA_SOURCE}:${verb}`,
      good,
      why: LATIN_HADA_WHY,
      check: CHECK_REGEX,
      index: match.index,
      length: match[0].length,
      matched,
      priority: "핵심",
      source: LATIN_HADA_SOURCE,
    });
  }
  return findings;
}

/**
 * lint()가 규칙표의 다른 규칙과 똑같이 다루는 규칙 객체 하나로 이 검사를 감싼다.
 *
 * bad/good이 매치마다 달라(동사별로 뜻이 다르다) 정적인 rule.bad 하나로 표현할 수
 * 없으므로, find가 masked/normalized를 받아 findLatinVerbHada의 결과(이미 bad·good·why
 * 까지 채운 발견 목록)를 그대로 돌려준다. overlapFree: true는 이 발견이 규칙끼리 겹침을
 * 다투는 resolveOverlaps(lint.mjs)에 끼지 않는다는 뜻이다 — "build할때"에서 이 규칙이
 * 잡은 "build할"이 치환 규칙 "할때"→"할 때"보다 길다는 이유로 그 규칙을 밀어내면, 절대
 * 자동 교정하지 않는(check가 늘 정규식) 이 규칙이 실제로 되던 자동 교정까지 함께
 * 지워버린다(실측, 0.16.0).
 */
export const LATIN_HADA_RULE = {
  check: CHECK_REGEX,
  priority: "핵심",
  source: LATIN_HADA_SOURCE,
  overlapFree: true,
  find: findLatinVerbHada,
};
