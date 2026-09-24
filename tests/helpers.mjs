// 시험용 규칙 객체를 만든다.
//
// 규칙 객체의 모양은 parseTable, lint, byPriority, toRow 사이의 약속이다. 그 모양을
// 시험 파일마다 따로 적어 두면 필드가 하나 늘 때 한 곳을 빠뜨리게 되고, 그 시험은
// 생산 코드가 만들지 않는 모양을 검사하게 된다.

const DEFAULTS = {
  en: "",
  bad: "얇은 계약",
  good: "낮은 결합도",
  why: "은유 직역",
  check: "치환",
  priority: "핵심",
  source: "metaphors.md",
};

/**
 * 규칙 객체 하나를 만든다. 넘긴 값만 기본값을 덮는다.
 * @param {object} [overrides]
 * @returns {object}
 */
export function rule(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

/**
 * 규칙을 여러 개 만든다. 분량 상한을 시험할 때 쓴다.
 *
 * 색인을 세 자리로 채우는 이유는 행 길이를 맞추기 위해서다. 길이가 다르면 짧은 행이
 * 남은 자리에 끼어들어 순위나 예산을 재는 시험이 흐려진다.
 *
 * @param {number} count
 * @param {(index: number, tag: string) => object} build
 * @returns {object[]}
 */
export function manyRules(count, build) {
  return Array.from({ length: count }, (_, index) => {
    const tag = String(index).padStart(3, "0");
    return rule(build(index, tag));
  });
}

/**
 * fn() 을 여러 번 재서 가장 빠른 값을 돌려준다.
 *
 * CI/개발 머신에서 여러 시험이 동시에 도는 동안은 한 번 잰 시간이 다른 프로세스의
 * 스케줄링에 그대로 흔들린다. 최솟값은 "이 코드가 실제로 걸리는 시간"에 훨씬
 * 가깝고, 이차 비용 회귀(알고리즘이 O(n²)로 퇴화하는 것)는 최솟값에도 그대로 남는다
 * — 재는 목적은 그 회귀를 잡는 것이지 절대 시간을 재는 것이 아니다.
 *
 * @param {() => void} fn
 * @param {number} [runs]
 * @returns {number} 밀리초
 */
export function fastestMs(fn, runs = 3) {
  let best = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const start = Date.now();
    fn();
    const ms = Date.now() - start;
    if (ms < best) best = ms;
  }
  return best;
}
