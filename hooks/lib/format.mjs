// 같은 지적·교정이 문서에 수천 번 반복될 수 있다(1.24M자 문서에서 실측: 3.6MB짜리 훅
// JSON). 종류별로 묶어 세지 않으면 systemMessage/additionalContext 가 건수에 비례해
// 커진다 — artifact.mjs의 자동 교정 목록, particle.mjs의 조사 오류 목록이 똑같이 겪던
// 문제라 여기 하나로 모았다.

// 목록에서 줄로 보여 줄 종류의 상한. 이 숫자를 넘으면 나머지는 "외 N가지 더"로만 말한다.
export const MAX_LISTED = 20;

/**
 * items를 keyFn이 돌려주는 열쇠로 묶어 각 묶음의 첫 항목과 건수를 담은 배열을 돌려준다.
 * 순서는 처음 나온 순서(등장 순)를 유지한다 — Map이 삽입 순서를 지키는 성질을 그대로 쓴다.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} keyFn
 * @returns {{item: T, count: number}[]}
 */
export function groupCounted(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const entry = groups.get(key);
    if (entry) entry.count += 1;
    else groups.set(key, { item, count: 1 });
  }
  return [...groups.values()];
}

/**
 * 묶음 목록을 최대 max개까지 줄로 나열하고, 남은 것은 "외 N가지 더"로 요약한다.
 *
 * @param {{item: object, count: number}[]} groups
 * @param {(entry: {item: object, count: number}) => string} lineFn
 * @param {number} [max]
 * @returns {string[]}
 */
export function formatGroupedList(groups, lineFn, max = MAX_LISTED) {
  const listed = groups.slice(0, max);
  const rest = groups.length - listed.length;
  const lines = listed.map(lineFn);
  if (rest > 0) lines.push(`- 외 ${rest}가지 더`);
  return lines;
}
