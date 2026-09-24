// 검사에서 제외할 구간을 가려낸다.
//
// 이 플러그인의 가장 큰 위험은 `contract`라는 변수명을 "계약"으로 고치라고 하는 오탐이다.
// 그래서 제외 규칙을 단독 부품으로 떼어 따로 테스트한다.
//
// 가려낸 구간을 잘라내지 않고 같은 길이의 센티넬로 덮는 이유는 위치를 보존하기 위해서다.
// 길이가 유지되면 검사에서 찾은 위치가 원문 위치와 그대로 맞는다.

export const MASK = "\u0000";

// 경로·확장자·혼합 식별자 앞뒤 경계.
//
// \b는 한글 앞에서 경계로 서지 않는다(한글이 \w가 아니므로 공백↔한글 사이에 전환이 없다).
// 그래서 공백 대신 "여는 괄호/따옴표 뒤" 를 시작 경계로, "닫는 괄호·구두점이나 조사가 붙어도
// 좋다"를 끝 경계로 직접 쓴다. 조사가 안 오면 뒤에는 그냥 공백이나 문장 끝이 와야 한다.
const OPEN_QUOTES = `(["'「【（`; // ( " ' 「 【 （
const LEAD = String.raw`(?<![^\s${OPEN_QUOTES.replace(/[\]\\^-]/g, "\\$&")}])`;
const CLOSERS = `)\\]"'」】）,.:;!?`; // ) ] " ' 」 】 ） , . : ; ! ?
// 뒤에 흔히 붙는 조사 몇 가지. 모든 조사를 다루지는 않는다 — 놓치면 경계 판정이 실패해서
// 그 자리를 덮지 못할 뿐이고(불변식 5), 잘못 덮는 쪽보다는 안전하다.
const PARTICLES = "을|를|이|가|은|는|과|와|도|의|에서|에게|으로|로서|로써|로|까지|부터|이나|나|이란|란";
const TAIL = String.raw`(?:[${CLOSERS}]*(?:${PARTICLES})?)(?=\s|$)`;

// 순서가 중요하다. 울타리 코드 블록을 먼저 덮어야 그 안의 백틱이 인라인 코드로 잘못 잡히지 않는다.
//
// 여기 있는 패턴은 대상 종류를 가리지 않고 항상 적용한다 — 커밋 메시지에도, 어떤 문서
// 확장자에도. 들여쓰기 코드·rST·AsciiDoc·HTML 리터럴 블록처럼 "이 파일 형식에서만
// 코드로 읽힌다"는 판단이 필요한 것들은 DOC_ONLY_PATTERNS 와 아래 함수들에 따로 둔다.
const ALWAYS_PATTERNS = [
  /```[\s\S]*?```/g, // 울타리 코드 블록
  /~~~[\s\S]*?~~~/g,
  /`[^`\n]*`/g, // 인라인 코드
  /<[^>\n]{1,200}>/g, // HTML 태그, <https://...>
  /\bhttps?:\/\/\S+/g, // URL
  /\bwww\.[^\s)]+/g,
  /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, // 환경변수
  /(?:^|\s)--?[A-Za-z][A-Za-z0-9-]*/g, // 명령행 옵션
  new RegExp(LEAD + String.raw`[\p{L}\p{N}_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|py|go|rs|java|kt|rb|sh|bash|zsh|yml|yaml|toml|lock|txt|csv|css|scss|html|sql|env|ini|conf)` + TAIL, "gu"),
  // 밑줄로 잇는 혼합 식별자(예: content_컨텐츠). 밑줄과 한글이 함께 있어야만 덮는다 —
  // 밑줄 없는 보통 한글 낱말까지 덮으면 지나치다.
  new RegExp(LEAD + String.raw`[A-Za-z0-9_\p{Script=Hangul}]*_[A-Za-z0-9_\p{Script=Hangul}]*\p{Script=Hangul}[A-Za-z0-9_\p{Script=Hangul}]*` + TAIL, "gu"),

  // 사람이 지정한 예외 구간.
  // 문체 가이드나 규칙 문서는 나쁜 예를 일부러 인용한다. 그것까지 지적하면 쓸 수 없다.
  /<!--\s*kimchi-ignore-start\b[\s\S]*?-->[\s\S]*?<!--\s*kimchi-ignore-end\b[\s\S]*?-->/g,
  /^.*<!--\s*kimchi-ignore\b[^>]*-->.*$/gm, // 표시가 붙은 한 줄
];

// 문서 확장자별로만 적용하는 블록형 가리개. 커밋 메시지(ext 없음)에는 무엇도 걸리지 않는다 —
// 커밋 메시지에 "    컨텐츠 정리"처럼 앞에 공백 몇 칸이 붙었다고 코드로 볼 이유가 없다.
const INDENTED_CODE_EXTS = new Set(["md", "mdx", "markdown"]);
const PRE_CODE_EXTS = new Set(["md", "mdx", "markdown"]);
const RST_EXTS = new Set(["rst"]);
const ASCIIDOC_EXTS = new Set(["adoc"]);

const PRE_CODE_PATTERNS = [
  /<pre[^>]*>[\s\S]*?<\/pre>/gi,
  /<code[^>]*>[\s\S]*?<\/code>/gi,
];

/**
 * 경로/슬래시 토큰. 앞뒤로 한글이 섞일 수 있지만(docs/컨텐츠.md), 슬래시 양쪽이 모두
 * 한글뿐이면(읽기/쓰기) 경로가 아니라 대안을 가르는 보통 글이다 — ASCII 글자나 마침표가
 * 하나도 없으면 경로로 보지 않는다.
 */
function findPathRanges(text) {
  const re = new RegExp(
    LEAD +
      String.raw`(?:[\p{L}\p{N}_.-]+[/\\][\p{L}\p{N}_./\\-]*|[\p{L}\p{N}_.-]*[/\\][\p{L}\p{N}_./\\-]+)` +
      TAIL,
    "gu"
  );
  const ranges = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (/[A-Za-z0-9]/.test(m[0])) ranges.push([m.index, m.index + m[0].length]);
    else if (m[0].length === 0) re.lastIndex += 1;
  }
  return ranges;
}

// 빈 줄 뒤에 4칸 들여쓰기나 탭으로 시작하는 줄이 이어지면 마크다운의 들여쓰기 코드 블록 —
// 단, 바로 앞의 안 비어 있는 줄이 목록 항목(- , * , 1. 등)이면 그 들여쓰기는 코드가 아니라
// 목록의 연속 내용이다(CommonMark). 목록 연속까지 코드로 덮으면 평범한 글이 사라진다.
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

function findIndentedBlockRanges(text) {
  const ranges = [];
  const n = text.length;
  let i = 0;
  let prevBlank = true;
  let lastNonBlankLine = "";
  while (i < n) {
    const lineEnd = text.indexOf("\n", i);
    const end = lineEnd === -1 ? n : lineEnd;
    const line = text.slice(i, end);
    const trimmed = line.trim();
    const indented = trimmed.length > 0 && /^(?: {4,}|\t)/.test(line);

    if (indented && prevBlank && !LIST_ITEM.test(lastNonBlankLine)) {
      let blockEnd = end;
      let cursor = end + 1;
      while (cursor <= n) {
        const nextEnd = text.indexOf("\n", cursor);
        const nEnd = nextEnd === -1 ? n : nextEnd;
        const nextLine = text.slice(cursor, nEnd);
        const nextTrimmed = nextLine.trim();
        const nextIndented = nextTrimmed.length > 0 && /^(?: {4,}|\t)/.test(nextLine);
        if (nextIndented) {
          blockEnd = nEnd;
          cursor = nEnd + 1;
          continue;
        }
        if (nextTrimmed.length === 0) {
          cursor = nEnd + 1;
          continue;
        }
        break;
      }
      ranges.push([i, blockEnd]);
      i = blockEnd + 1;
      prevBlank = false;
      lastNonBlankLine = "";
      continue;
    }

    if (trimmed.length > 0) lastNonBlankLine = line;
    prevBlank = trimmed.length === 0;
    i = end + 1;
  }
  return ranges;
}

// reStructuredText 지시자(code-block/code/sourcecode)나 `::`로 끝나는 문단 바로 뒤에
// (빈 줄만 사이에 두고) 이어지는 들여쓰기 블록만 덮는다. 사이에 다른 문단이 있으면
// 그 지시자에 딸린 블록이 아니다 — 400자를 그냥 무는 식으로는 중간 산문까지 같이 덮인다.
function findRstLiteralRanges(text, blocks) {
  const starts = [];
  const directiveRe = /^[ \t]*\.\.[ \t]+(?:code-block|code|sourcecode)::[^\n]*$/gm;
  const doubleColonRe = /^[ \t]*\S[^\n]*::[ \t]*$/gm;
  let m;
  while ((m = directiveRe.exec(text)) !== null) starts.push(m.index);
  while ((m = doubleColonRe.exec(text)) !== null) starts.push(m.index);
  if (starts.length === 0) return [];
  starts.sort((a, b) => a - b);

  const n = text.length;
  const ranges = [];
  let bi = 0; // blocks 는 시작 위치 오름차순 — 포인터를 앞으로만 옮긴다 (F8: 이차 비용 방지)
  for (const start of starts) {
    const lineEnd = text.indexOf("\n", start);
    let pos = lineEnd === -1 ? n : lineEnd + 1;
    while (pos < n) {
      const nEnd = text.indexOf("\n", pos);
      const lineTextEnd = nEnd === -1 ? n : nEnd;
      if (text.slice(pos, lineTextEnd).trim().length === 0) {
        pos = lineTextEnd + 1;
        continue;
      }
      break;
    }
    while (bi < blocks.length && blocks[bi][0] < pos) bi += 1;
    if (bi < blocks.length && blocks[bi][0] === pos) ranges.push([start, blocks[bi][1]]);
  }
  return ranges;
}

// AsciiDoc 구분선(----, ...., ++++)으로 감싼 리스팅 블록.
function findAsciidocRanges(text) {
  const ranges = [];
  for (const delim of ["----", "....", "++++"]) {
    const re = new RegExp(`^${delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "gm");
    const starts = [];
    let m;
    while ((m = re.exec(text)) !== null) starts.push(m.index);
    for (let k = 0; k + 1 < starts.length; k += 2) {
      const closeLineEnd = text.indexOf("\n", starts[k + 1]);
      ranges.push([starts[k], closeLineEnd === -1 ? text.length : closeLineEnd]);
    }
  }
  return ranges;
}

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
 *
 * @param {string} text
 * @param {string} [ext] 문서 확장자(점 없이, 소문자로). 들여쓰기 코드·rST·AsciiDoc·HTML
 *   리터럴 블록처럼 "이 파일 형식이라야 코드로 읽힌다"는 가리개의 범위를 정한다.
 *   생략하면(예: 커밋 메시지) 이 블록형 가리개는 하나도 적용되지 않는다.
 * @returns {string}
 */
export function maskProtected(text, ext) {
  if (typeof text !== "string" || text.length === 0) return "";

  const ranges = [];
  for (const pattern of ALWAYS_PATTERNS) {
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
  ranges.push(...findPathRanges(text));

  if (PRE_CODE_EXTS.has(ext)) {
    for (const pattern of PRE_CODE_PATTERNS) {
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
  }

  const indentedBlocks = INDENTED_CODE_EXTS.has(ext) ? findIndentedBlockRanges(text) : [];
  ranges.push(...indentedBlocks);
  if (RST_EXTS.has(ext)) ranges.push(...findRstLiteralRanges(text, findIndentedBlockRanges(text)));
  if (ASCIIDOC_EXTS.has(ext)) ranges.push(...findAsciidocRanges(text));

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
