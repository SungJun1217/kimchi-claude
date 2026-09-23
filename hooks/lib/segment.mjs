// 검사에서 제외할 구간을 가려낸다.
//
// 이 플러그인의 가장 큰 위험은 `contract`라는 변수명을 "계약"으로 고치라고 하는 오탐이다.
// 그래서 제외 규칙을 단독 부품으로 떼어 따로 테스트한다.
//
// 가려낸 구간을 잘라내지 않고 같은 길이의 센티넬로 덮는 이유는 위치를 보존하기 위해서다.
// 길이가 유지되면 검사에서 찾은 위치가 원문 위치와 그대로 맞는다.

export const MASK = "\u0000";

// 순서가 중요하다. 울타리 코드 블록을 먼저 덮어야 그 안의 백틱이 인라인 코드로 잘못 잡히지 않는다.
//
// 자바스크립트 정규식의 \w와 \b는 ASCII만 단어 문자로 보고 한글은 비단어 문자다.
// 덕분에 아래 패턴들이 한글 본문을 건드리지 않는다.
const PROTECTED_PATTERNS = [
  /```[\s\S]*?```/g, // 울타리 코드 블록
  /~~~[\s\S]*?~~~/g,
  /`[^`\n]*`/g, // 인라인 코드
  /<[^>\n]{1,200}>/g, // HTML 태그, <https://...>
  /\bhttps?:\/\/\S+/g, // URL
  /\bwww\.[^\s)]+/g,
  /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*/g, // 파일 경로
  /\b[A-Za-z0-9_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|py|go|rs|java|kt|rb|sh|bash|zsh|yml|yaml|toml|lock|txt|csv|css|scss|html|sql|env|ini|conf)\b/g,
  /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, // 환경변수
  /(?:^|\s)--?[A-Za-z][A-Za-z0-9-]*/g, // 명령행 옵션

  // 사람이 지정한 예외 구간.
  // 문체 가이드나 규칙 문서는 나쁜 예를 일부러 인용한다. 그것까지 지적하면 쓸 수 없다.
  /<!--\s*kimchi-ignore-start\b[\s\S]*?-->[\s\S]*?<!--\s*kimchi-ignore-end\b[\s\S]*?-->/g,
  /^.*<!--\s*kimchi-ignore\b[^>]*-->.*$/gm, // 표시가 붙은 한 줄
];

// 문서 전체를 검사에서 빼는 표시.
// 표시 뒤에 이유를 덧붙일 수 있게 둔다. 왜 빼는지 적어 두는 것이 자연스러운 쓰임이다.
const IGNORE_FILE = /<!--\s*kimchi-ignore-file\b[\s\S]*?-->/;

/**
 * 문서 전체가 검사 예외로 표시되었는지 알려준다.
 * @param {string} text
 * @returns {boolean}
 */
export function isIgnoredFile(text) {
  return typeof text === "string" && IGNORE_FILE.test(text);
}

/**
 * 제외 구간을 센티넬로 덮은 문자열을 돌려준다. 길이는 원문과 같다.
 * @param {string} text
 * @returns {string}
 */
export function maskProtected(text) {
  if (typeof text !== "string" || text.length === 0) return "";

  const ranges = [];
  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  // 가릴 구간이 없으면 원문을 그대로 돌려준다. 아무것도 할당하지 않는다.
  if (ranges.length === 0) return text;

  ranges.sort((a, b) => a[0] - b[0]);

  // 겹치거나 품은 구간은 커서로 정리한다. 센티넬을 구간 길이만큼 채워 위치를 보존한다.
  let out = "";
  let cursor = 0;
  for (const [from, to] of ranges) {
    if (to <= cursor) continue;
    const start = Math.max(from, cursor);
    out += text.slice(cursor, start);
    out += MASK.repeat(to - start);
    cursor = to;
  }
  return out + text.slice(cursor);
}

