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

/**
 * 정규식들을 text에 돌려 겹치지 않는 매치 구간을 모은다. 빈 문자열 매치는 무한 루프를
 * 막으려고 한 글자 건너뛴다(패턴 자체가 빈 매치를 낼 수 있는 경우 대비 — 현재 패턴들은
 * 실제로 빈 매치를 내지 않지만 다음에 추가되는 패턴이 안전하게 이 함수를 쓰게 해 둔다).
 * accept(match)를 주면 매치 안쪽 조건(로그·프롬프트 줄의 콜론 뒤 내용 등)을 본 것만 담는다.
 */
function collectRanges(text, patterns, accept) {
  const ranges = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      if (!accept || accept(match)) ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

// 참조 정의 줄 `[label]: url "title"` 전체. 라벨을 캡처해 둬서 findReferenceLabelRanges가
// 정의된 라벨 집합을 모을 때도 이 정규식을 그대로 쓴다 — ALWAYS_PATTERNS 쪽은 라벨이
// 필요 없어 캡처만 뺀 버전을 이 소스에서 파생시킨다(아래).
const REF_DEF_LINE = /^ {0,3}\[([^\]\n]+)\]:[ \t]+\S[^\n]*$/gm;

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
  new RegExp(LEAD + String.raw`[\p{L}\p{N}_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|py|go|rs|java|kt|rb|sh|bash|zsh|yml|yaml|toml|lock|txt|csv|css|scss|html|sql|env|ini|conf|png|jpe?g|gif|svg|webp|ico|pdf)` + TAIL, "gu"),
  // 밑줄로 잇는 혼합 식별자(예: content_컨텐츠, 타겟_id). 밑줄과 한글이 어딘가 함께 있어야만
  // 덮는다(앞선 방향제한 없는 lookahead) — 밑줄 없는 보통 한글 낱말까지 덮으면 지나치다.
  new RegExp(
    LEAD +
      String.raw`(?=[A-Za-z0-9_\p{Script=Hangul}]*\p{Script=Hangul})[A-Za-z0-9_\p{Script=Hangul}]*_[A-Za-z0-9_\p{Script=Hangul}]*` +
      TAIL,
    "gu"
  ),

  // 마크다운 링크·이미지 대상 `](...)`. 대괄호 안(링크 텍스트·대체 텍스트)은 산문이라
  // 계속 검사해야 하지만, 괄호 안의 대상 경로는 코드다. 문자 집합에서 `(`·`]`도 뺀다 —
  // `)`만 빼면 "](".repeat(40000)처럼 닫는 괄호가 없는 입력에서 각 "](" 마다 문자열
  // 끝까지 밀었다 되돌리는 이차 비용이 났다(실측 5.7초). 괄호·대괄호가 나오면 그 자리에서
  // 바로 실패하므로 더 되돌릴 게 없다. 길이도 2000자로 한 번 더 막는다.
  /\]\([^()\]\n]{0,2000}\)/g,
  // 참조 정의 줄 `[label]: url "title"` 전체. REF_DEF_LINE에서 캡처 그룹만 뺀 버전 — 소스가
  // 둘이면 한쪽만 고치고 잊는 사고가 난다.
  new RegExp(REF_DEF_LINE.source.replace("(", "(?:"), "gm"),
  // 한 줄짜리 `$(...)` 명령 치환. 중첩 괄호는 다루지 않는다 — 그런 경우까지 정확히 가르려면
  // bash-commit.mjs 수준의 셸 파서가 필요하다.
  /\$\([^()\n]*\)/g,

  // 사람이 지정한 예외 구간.
  // 문체 가이드나 규칙 문서는 나쁜 예를 일부러 인용한다. 그것까지 지적하면 쓸 수 없다.
  /<!--\s*kimchi-ignore-start\b[\s\S]*?-->[\s\S]*?<!--\s*kimchi-ignore-end\b[\s\S]*?-->/g,
  /^.*<!--\s*kimchi-ignore\b[^>]*-->.*$/gm, // 표시가 붙은 한 줄
];

// 한글 음절 바로 뒤에 로마자가 붙은 캐멀케이스 혼합 식별자(예: 타겟Id, 타겟Name). \p{L}*로
// 양쪽을 넓게 무는 정규식은 137KB 문서에서 0.27ms 대 13.5ms로 50배 느려진다(실측) — 대신
// 한글→로마자 경계만 스캔으로 찾고 [\p{L}\p{N}_] 문자 집합으로 좌우를 선형으로 넓힌다.
//
// 시드는 한글 뒤에 소문자, 또는 대문자+소문자(캐멀케이스 시작)가 와야만 잡는다 — "컨텐츠UI를"·
// "타겟API 호출"·"리팩토링PR을"처럼 한글 뒤에 대문자만 이어지는 두문자어는 식별자가 아니라
// 보통 산문에 섞인 영문 약어라 계속 검사해야 한다. 반대 방향(API가 처럼 로마자 뒤에 한글이
// 오는 경우)도 다루지 않는다 — 그쪽은 보통 산문이다.
const HANGUL_ASCII_SEED = /[가-힣](?:[a-z]|[A-Z][a-z])/g;
const JOIN_TOKEN_CHAR = /[\p{L}\p{N}_]/u;

function findHangulAsciiJoinRanges(text) {
  const ranges = [];
  HANGUL_ASCII_SEED.lastIndex = 0;
  let m;
  while ((m = HANGUL_ASCII_SEED.exec(text)) !== null) {
    let start = m.index;
    let end = m.index + m[0].length;
    while (start > 0 && JOIN_TOKEN_CHAR.test(text[start - 1])) start -= 1;
    while (end < text.length && JOIN_TOKEN_CHAR.test(text[end])) end += 1;
    ranges.push([start, end]);
    // 한 붙임 구간은 한 번만 넓힌다. lastIndex를 넓힌 끝으로 밀지 않으면 "가a"를
    // 수천 번 이어 붙인 입력에서 시드가 겹치는 위치마다 매번 좌우로 문자열 전체를
    // 다시 훑어 이차 비용이 난다(실측: 5000회 반복에서 0.5초 → 8.8초).
    if (end > HANGUL_ASCII_SEED.lastIndex) HANGUL_ASCII_SEED.lastIndex = end;
  }
  return ranges;
}

// 문서 확장자별로만 적용하는 블록형 가리개. 커밋 메시지(ext 없음)에는 무엇도 걸리지 않는다 —
// 커밋 메시지에 "    컨텐츠 정리"처럼 앞에 공백 몇 칸이 붙었다고 코드로 볼 이유가 없다.
// 들여쓰기 코드·pre/code 태그·참조식 링크·프런트매터는 전부 "마크다운이다"라는 같은 판단을
// 쓴다 — 따로 둔 두 집합이 갈라질 일이 없어 하나로 합친다.
const MARKDOWN_EXTS = new Set(["md", "mdx", "markdown"]);
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

/**
 * 글자(\p{L}) 가운데 한글 비율이 낮은지(대략 30% 미만) 본다. 로그·프롬프트 줄 판정에 쓴다.
 * 숫자·기호뿐이면(글자가 하나도 없으면) 막을 이유가 없다고 보고 그대로 코드로 취급한다.
 */
function isMostlyNonHangul(text) {
  let letters = 0;
  let hangul = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters += 1;
    if (ch >= "가" && ch <= "힣") hangul += 1;
  }
  if (letters === 0) return true;
  return hangul / letters < 0.3;
}

// 줄 앞의 로그 레벨·예외 이름으로 시작하는 한 줄. 인용부호(`> `)나 목록 표시가 붙어도 된다.
// "Error: 컨텐츠를 불러오지 못하면 다시 시도하세요"처럼 "Error:"가 안내문의 첫 낱말일 뿐인
// 온전한 한국어 문장까지 통째로 덮으면 그 문장은 다시는 검사되지 않는다 — 콜론 뒤가 한글
// 위주면(실측 기준 30% 이상) 로그가 아니라 산문으로 보고 덮지 않는다.
const LOG_LINE = /^[ \t]*(?:>[ \t]*)?(?:[-*+][ \t]+)?(?:[A-Z][A-Za-z]*(?:Error|Exception)|Error|ERROR|FATAL|Fatal|fatal|WARN|WARNING|Warning|warning|error|panic|Traceback)(?:\[[^\]\n]*\])?:[ \t]([^\n]*)/gm;

function findLogLineRanges(text) {
  return collectRanges(text, [LOG_LINE], (m) => isMostlyNonHangul(m[1]));
}

// 울타리 없는 셸 프롬프트 한 줄(`$ npm test`). "$ 5를 내면 컨텐츠를 받습니다"처럼 공백
// 바로 뒤가 숫자면 값을 나타내는 보통 문장이지 명령 프롬프트가 아니다.
const PROMPT_LINE = /^[ \t]*\$ ([^\n]*)/gm;

function findPromptLineRanges(text) {
  return collectRanges(text, [PROMPT_LINE], (m) => !/^[0-9]/.test(m[1]));
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

    // 울타리 닫힘이나 ATX 제목 바로 뒤에 오는 들여쓰기 줄은 목록 연속이 아니라 새
    // 코드 블록이다 — lastNonBlankLine을 비워 두어야 뒤이은 들여쓰기가 LIST_ITEM 검사에
    // 걸려 코드 취급을 놓치지 않는다.
    const fenceOrHeading = /^ {0,3}(?:```|~~~|#{1,6}(?:\s|$))/.test(line);
    if (trimmed.length > 0) lastNonBlankLine = fenceOrHeading ? "" : line;
    prevBlank = trimmed.length === 0 || fenceOrHeading;
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

// 문서 맨 앞(인덱스 0)의 YAML 프런트매터. 마크다운 계열(md/mdx/markdown)에만 적용한다 —
// 커밋 메시지(ext 없음)에는 애초에 "맨 앞 ---"이라는 개념이 없다.
//
// title/description/summary/excerpt/subtitle 값은 사람이 읽는 산문이라 계속 검사한다.
// 나머지 키·값(빌드 도구가 읽는 설정)은 코드로 보고 덮는다. `---`로 시작하지만 안쪽 줄이
// YAML처럼 안 생겼으면(보통 문단이면) 프런트매터가 아니라 가로줄이다 — 덮지 않는다.
const PROSE_KEYS = /^(?:title|description|summary|excerpt|subtitle)[ \t]*:/;
const FRONTMATTER_FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/;
// 키 이름은 \w로 제한하지 않는다 — "환경: prod"처럼 한글 키도 실제로 쓰인다. `*`(굵게)나
// `#`(마크다운 제목)으로 시작하는 줄은 키로 보지 않는다 — "**참고**: 컨텐츠를 옮겼습니다."는
// 콜론이 있어도 YAML 키가 아니라 강조한 산문이다.
const KEY_LINE = /^[^\s:*#-][^\n:]*:(?=[ \t]|$)/;
// 빌드 도구가 읽는 프런트매터 키는 실무에서 거의 항상 영문/숫자다. "참고: 컨텐츠 문서를
// 옮겼습니다"처럼 키 자리가 한글뿐이면 YAML이 아니라 "키처럼 보이는 한국어 문장"일 수
// 있다 — 블록 안에 영문 키가 하나도 없으면 프런트매터로 보지 않는다.
const ASCII_KEY_LINE = /^[A-Za-z0-9_-]+[ \t]*:(?=[ \t]|$)/;

/**
 * 프런트매터 안쪽 줄들이 실제로 YAML처럼 생겼는지 본다.
 *
 * 여는 --- 바로 다음 줄이 빈 줄이거나 키 줄이 아니면 프런트매터가 아니라 "---로 감싼
 * 산문"이다("---\n\n## 변경 사항\n\n- 컨텐츠…" 처럼 제목 뒤에 목록으로 적은 변경 이력이
 * 이 모양으로 자동 교정을 빠져나간 적이 있다). 목록(`- `)·주석(`#`) 줄은 앞서 키 줄이 한
 * 번이라도 나온 뒤에만 YAML의 값으로 인정한다 — 키 없이 곧장 나오면 그냥 마크다운 목록·제목이다.
 */
function looksLikeFrontmatter(lines) {
  if (lines.length === 0 || !KEY_LINE.test(lines[0])) return false;
  let sawKey = true;
  let sawAsciiKey = ASCII_KEY_LINE.test(lines[0]);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue;
    if (KEY_LINE.test(line)) {
      sawKey = true;
      if (ASCII_KEY_LINE.test(line)) sawAsciiKey = true;
      continue;
    }
    if (/^\s+\S/.test(line)) continue; // 들여쓴 계속 줄(값)
    if (sawKey && /^-[ \t]/.test(line)) continue; // 키 뒤에 오는 목록 값
    if (sawKey && /^#/.test(line)) continue; // 키 뒤에 오는 주석
    return false;
  }
  return sawAsciiKey;
}

function findFrontmatterRanges(text) {
  const m = FRONTMATTER_FENCE.exec(text);
  if (!m) return [];
  const lines = m[1].split("\n");
  if (!looksLikeFrontmatter(lines)) return [];

  const ranges = [];
  let pos = text.indexOf("\n") + 1;
  ranges.push([0, pos]); // 여는 --- 줄
  let inProseValue = false;
  for (const line of lines) {
    const key = PROSE_KEYS.exec(line);
    if (key) {
      ranges.push([pos, pos + key[0].length]); // "title:" 만 덮고 값은 산문으로 남긴다
      inProseValue = true;
    } else if (inProseValue && /^\s+\S/.test(line)) {
      // 산문 키의 들여쓴 계속 줄 — 통째로 산문이라 덮지 않는다.
    } else {
      inProseValue = false;
      ranges.push([pos, pos + line.length]);
    }
    pos += line.length + 1;
  }
  ranges.push([pos, m.index + m[0].length]); // 닫는 --- 또는 ... 줄
  return ranges;
}

// 참조식 링크의 라벨. `[글 내용][라벨]`·`[라벨][]`(축약형)·`[라벨]`(단축형)의 라벨은
// 문서 어딘가의 정의 줄(`[라벨]: url`)과 글자 그대로 맞아야 링크가 산다. 라벨이 규칙에
// 걸려 자동 교정되면(예: 타겟→타깃) 정의 줄은 안 바뀐 채 라벨만 바뀌어 링크가 끊긴다 —
// 실제로 `[설정 안내][타겟]` 이 `[설정 안내][타깃]`으로 바뀌고 `[타겟]:` 정의는 그대로
// 남아 죽은 링크가 됐다. 정의가 있는 라벨만 가려 그 부분만 검사에서 뺀다. 링크 텍스트
// (`[글 내용]`)는 라벨이 아니므로 계속 검사한다. 마크다운 계열(md/mdx/markdown)에서만
// 본다 — 참조식 링크 자체가 마크다운 전용 문법이다. REF_DEF_LINE은 파일 위쪽에서 정의한다
// (ALWAYS_PATTERNS의 캡처 없는 버전이 그 소스를 그대로 빌려 쓴다).
// 대괄호 안 문자 집합에서 "["·"]" 둘 다 빼고 길이도 999자로 막는다. "["를 수만 개 이어
// 붙인 입력에서 시작마다 문자열 끝까지 밀었다 되돌리는 이차 비용이 났다(실측 36초) —
// 정의가 하나라도 있으면 이 패턴들이 전체 글에서 돈다.
const FULL_OR_COLLAPSED_REF = /\[([^[\]\n]{0,999})\]\[([^[\]\n]{0,999})\]/g;
// 앞이 "]"가 아니고(두 괄호짜리 형태의 둘째 라벨이 아니고) 뒤가 "("나 "["가 아닌(인라인
// 링크·두 괄호짜리 형태의 첫 괄호가 아닌) 홑 대괄호만 단축형 참조로 본다.
const SHORTCUT_REF = /(?<!\])\[([^[\]\n]{0,999})\](?![(\[])/g;

function normalizeRefLabel(label) {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** ranges로 표시한 자리를 센티넬로 덮는다. maskProtected와 정의 전용 스캔이 함께 쓴다. */
function maskRanges(text, ranges) {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [from, to] of sorted) {
    if (to <= cursor) continue;
    const start = Math.max(from, cursor);
    out += text.slice(cursor, start);
    out += MASK.repeat(to - start);
    cursor = to;
  }
  return out + text.slice(cursor);
}

// scripts/publish-docs.mjs 도 링크 재작성에서 이 패턴을 그대로 가져다 쓴다 — 펜스·인라인
// 코드가 "검사에서 뺄 자리"라는 정의는 검사기든 퍼블리시 스크립트든 하나여야 한다.
export const CODE_ONLY_PATTERNS = [/```[\s\S]*?```/g, /~~~[\s\S]*?~~~/g, /`[^`\n]*`/g];

/**
 * 코드로 보고 가릴 구간만 모은다. 정의 줄 스캔(maskCodeForDefScan)과 maskProtected가
 * 둘 다 필요로 하는 부분 집합이라 여기 하나로 둔다 — maskProtected는 이미 알고 있는
 * 결과를 넘겨받아 다시 계산하지 않는다.
 */
function codeRanges(text, ext) {
  const ranges = collectRanges(text, CODE_ONLY_PATTERNS);
  if (MARKDOWN_EXTS.has(ext)) {
    ranges.push(...collectRanges(text, PRE_CODE_PATTERNS));
    ranges.push(...findIndentedBlockRanges(text));
  }
  return ranges;
}

/**
 * 정의 줄을 찾기 전에 코드만 가려 둔 사본을 만든다. 울타리·인라인 코드 안의
 * `` `[타겟]` `` 나 펜스 안 ` ```\n[타겟]: x\n``` `는 진짜 정의가 아니다 — 코드 예시로
 * 인용했을 뿐인데 실제 정의로 세면 그 라벨을 쓰는 모든 자리가 부당하게 검사에서 빠진다.
 *
 * @param {(number[])[]} [precomputed] maskProtected가 이미 구한 codeRanges 결과. 없으면
 *   새로 구한다(collectReferenceDefLabels처럼 codeRanges를 따로 안 가진 호출자용).
 */
function maskCodeForDefScan(text, ext, precomputed) {
  return maskRanges(text, precomputed || codeRanges(text, ext));
}

function scanDefLabels(maskedText, into) {
  REF_DEF_LINE.lastIndex = 0;
  let dm;
  while ((dm = REF_DEF_LINE.exec(maskedText)) !== null) into.add(normalizeRefLabel(dm[1]));
}

/**
 * 문서 안의 참조식 링크 정의 라벨을 모은다. Edit/MultiEdit처럼 조각만 보이는 호출에서,
 * 실제 정의 줄은 조각 밖 파일 어딘가에 있을 수 있다 — 그 정의를 maskProtected의 extraDefs
 * 로 얹어 주는 통로다. 코드 울타리·인라인 코드 안의 가짜 정의는 세지 않는다.
 *
 * @param {string} text 파일 전체 글
 * @param {string} [ext]
 * @returns {Set<string>}
 */
export function collectReferenceDefLabels(text, ext) {
  if (typeof text !== "string" || text.length === 0) return new Set();
  const defs = new Set();
  scanDefLabels(maskCodeForDefScan(text, ext), defs);
  return defs;
}

/**
 * @param {string} text
 * @param {string} [ext]
 * @param {Set<string>|null} [extraDefs] Edit/MultiEdit처럼 조각 밖의 정의를 알아야 할 때
 *   미리 모은 라벨 집합. `null`이면 "파일을 못 읽어 알 수 없음"이라는 뜻으로, 보수적으로
 *   두 괄호짜리 참조(`][라벨]`·`[라벨][]`)를 정의 확인 없이 전부 가린다 — 단축형(`[라벨]`)은
 *   혼자서도 흔한 대괄호 표기라 여기서까지 넓히지 않는다. 자동 교정이 죽은 링크를 만드는
 *   쪽이 지적 하나를 놓치는 쪽보다 나쁘다.
 * @param {(number[])[]} [precomputedCodeRanges] maskProtected가 이미 구한 codeRanges 결과.
 */
function findReferenceLabelRanges(text, ext, extraDefs, precomputedCodeRanges) {
  const conservative = extraDefs === null;
  // extraDefs가 비어 있고(파일 밖 정의도 없고) 글 안에도 정의 줄이 있을 수 없으면
  // (`]:`가 아예 없으면) defs는 항상 빈 채로 끝나 아래 두 루프 모두 아무것도 못 찾는다 —
  // 결과가 같으니 정규식을 돌릴 필요가 없다. 보수적인 null은 정의와 무관하게 항상 가리므로
  // 이 지름길에서 뺀다.
  if (!conservative && (!extraDefs || extraDefs.size === 0) && !text.includes("]:")) return [];
  const defs = new Set(conservative ? [] : extraDefs || []);
  scanDefLabels(maskCodeForDefScan(text, ext, precomputedCodeRanges), defs);

  const ranges = [];

  FULL_OR_COLLAPSED_REF.lastIndex = 0;
  let m;
  while ((m = FULL_OR_COLLAPSED_REF.exec(text)) !== null) {
    const [full, linkText, label] = m;
    if (label.length > 0) {
      if (conservative || defs.has(normalizeRefLabel(label))) {
        const secondBracketStart = m.index + 1 + linkText.length + 1; // "[" + 글 내용 + "]" 다음
        ranges.push([secondBracketStart, m.index + full.length]);
      }
    } else if (conservative || defs.has(normalizeRefLabel(linkText))) {
      // 축약형 [라벨][] — 글 내용 자체가 라벨을 겸한다. 통째로 뺀다.
      ranges.push([m.index, m.index + full.length]);
    }
  }

  if (!conservative) {
    SHORTCUT_REF.lastIndex = 0;
    while ((m = SHORTCUT_REF.exec(text)) !== null) {
      if (defs.has(normalizeRefLabel(m[1]))) ranges.push([m.index, m.index + m[0].length]);
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
 * @param {Set<string>|null} [extraDefs] 참조식 링크 라벨 판정에 쓸, 이 글 밖에서 모은 정의
 *   라벨. collectReferenceDefLabels 참고.
 * @returns {string}
 */
// 한 훅 호출 안에서 같은 글을 여러 번 가린다 — locateAndClassify가 old_string/new_string
// 둘 다 찾아보고(artifact.mjs), fixOne이 조사 교정 전후로 다시 가리고, warnAboutTone이
// lint와 findParticleErrors에 각각 넘긴다. 매번 text·ext가 똑같은 값(대개 같은 문자열
// 인스턴스)이라 마지막 한 번만 기억해 두면 대부분 그대로 맞는다 — 단칸 캐시로 충분하다.
let lastMaskKey = null;
let lastMaskResult = null;

export function maskProtected(text, ext, extraDefs) {
  if (typeof text !== "string" || text.length === 0) return "";

  if (lastMaskKey && lastMaskKey.text === text && lastMaskKey.ext === ext && lastMaskKey.extraDefs === extraDefs) {
    return lastMaskResult;
  }

  const result = maskProtectedUncached(text, ext, extraDefs);
  lastMaskKey = { text, ext, extraDefs };
  lastMaskResult = result;
  return result;
}

function maskProtectedUncached(text, ext, extraDefs) {
  const ranges = collectRanges(text, ALWAYS_PATTERNS);
  ranges.push(...findPathRanges(text));
  ranges.push(...findHangulAsciiJoinRanges(text));
  ranges.push(...findLogLineRanges(text));
  ranges.push(...findPromptLineRanges(text));

  if (MARKDOWN_EXTS.has(ext)) {
    // codeRanges는 pre/code 태그와 들여쓰기 블록까지 한 번에 구한다 — findReferenceLabelRanges
    // 안에서 다시 구하지 않도록 그대로 넘긴다(원래 여기서도, 정의 스캔에서도 두 번씩 돌던 계산).
    const code = codeRanges(text, ext);
    ranges.push(...code);
    ranges.push(...findFrontmatterRanges(text));
    ranges.push(...findReferenceLabelRanges(text, ext, extraDefs, code));
  }
  if (RST_EXTS.has(ext)) ranges.push(...findRstLiteralRanges(text, findIndentedBlockRanges(text)));
  if (ASCIIDOC_EXTS.has(ext)) ranges.push(...findAsciidocRanges(text));

  return maskRanges(text, ranges);
}
