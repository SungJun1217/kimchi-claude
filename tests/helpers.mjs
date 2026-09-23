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
