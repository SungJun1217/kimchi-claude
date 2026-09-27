// 마크다운 인라인 코드·펜스 블록을 안전하게 만드는 공통 도구. build-review.mjs와
// triage-report.mjs가 같은 백틱-이스케이프 규칙(커먼마크: 감싸는 백틱은 내용 안 최장
// 백틱 연속보다 하나 더 길어야 한다)을 각자 구현해 갖고 있던 것을 하나로 모았다.

function longestBacktickRun(text) {
  const runs = String(text).match(/`+/g) || [];
  return runs.reduce((max, run) => Math.max(max, run.length), 0);
}

/**
 * 마크다운 인라인 코드로 안전하게 감싼다. 텍스트 안에 백틱이 있어도 깨지지 않도록
 * 감싸는 백틱 개수를 텍스트 안 최장 백틱 연속보다 하나 더 길게 잡는다(커먼마크 규칙).
 * 코드 스팬 안에서는 `@멘션`도 알림으로 파싱되지 않는다 — 파일 이름·지적 문구에 우연히
 * `@`가 들어 있어도 이 함수로 감싸면 별도 이스케이프 없이 안전하다.
 * @param {string} text
 * @returns {string}
 */
export function mdCode(text) {
  const s = String(text);
  const fence = "`".repeat(longestBacktickRun(s) + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

/**
 * 여러 줄 텍스트를 펜스 코드 블록으로 안전하게 감싼다(백틱 개수 규칙은 mdCode와 같다).
 * 펜스는 반드시 그 줄의 첫 글자여야 한다(커먼마크 규칙) — 호출부는 이 반환값을 항상
 * 별도 줄(앞에 레이블을 붙이려면 별개의 줄로)에 놓아야 한다. 같은 줄에
 * `레이블: ${mdBlock(text)}` 처럼 이어 붙이면 펜스가 줄 중간에서 시작해 마크다운
 * 펜스로 인식되지 않고, 사용자가 넣은 여러 줄 텍스트가 코드 블록 밖에서 그대로
 * 렌더링된다(@멘션·이미지·헤딩이 실제로 해석되는 보안 결함이었다 — 실측).
 *
 * 길이 상한이나 트리밍은 이 함수의 일이 아니다 — 호출부가 필요하면 미리 잘라서 넘긴다.
 * @param {string} text
 * @returns {string}
 */
export function mdBlock(text) {
  const s = String(text);
  const fence = "`".repeat(Math.max(longestBacktickRun(s) + 1, 3));
  return `${fence}\n${s}\n${fence}`;
}
