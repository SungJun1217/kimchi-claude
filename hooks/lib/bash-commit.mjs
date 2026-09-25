// git commit 명령에서 커밋 메시지로 쓰이는 부분만 정확한 글자 범위로 뽑아낸다.
//
// 예전에는 명령 전체를 정규식 두어 개로 훑었다. 그러면 다른 명령이 만든 heredoc이나
// 파일에 적는 문자열까지 "커밋 메시지"로 오해하고, 치환도 명령 전체에서
// `split(target).join(fixed)`로 전역으로 일어나 겹치는 문자열까지 함께 바뀌었다.
//
// 이 파일은 대신 셸 문법을 최소한으로 해석한다. `&&`, `||`, `;`, `|`, 줄바꿈으로
// 단순 명령을 나누고, 그 중 `git ... commit` 형태만 대상으로 `-m`/`--message`/`-F` 값과
// 그 값이 딸린 heredoc을 원본 문자열 안의 정확한 시작/끝 위치로 찾는다.
// 자동 교정은 이 위치만 갈아 끼운다. 그 밖의 자리는 절대 건드리지 않는다.
//
// 셸 문법 전체를 구현하지는 않는다. sudo/env/time/command/nohup, VAR=대입, `(`/`{` 묶음,
// `then`/`do`/`else` 뒤, 기본 이름이 git인 경로(/usr/bin/git), `$(...)` 안의 명령,
// `sh`/`bash`/`zsh`/`dash -c` 의 작은따옴표·이중따옴표 스크립트(결합 옵션 `-lc`, `-ec` 등
// 포함)는 다루지만, 파이프로 다른 명령에 넘어간 뒤 다시 git으로 들어오는 흐름 같은 것은
// 다루지 않는다 — 그런 경우는 그냥 지나친다(불변식 5).

const SHORT_OPTS = "acCeFinoqsSuvtm"; // git commit(1) 짧은 옵션 가운데 결합형에 나타날 수 있는 것들
const SHORT_M_ALONE = new RegExp(`^-[${SHORT_OPTS}]*m$`);
const SHORT_M_INLINE = new RegExp(`^-[${SHORT_OPTS}]*m([\\s\\S]+)$`);
const SHORT_F_ALONE = new RegExp(`^-[${SHORT_OPTS}]*F$`);
const SHORT_F_INLINE = new RegExp(`^-[${SHORT_OPTS}]*F([\\s\\S]+)$`);

// -m "$(cat <<'EOF' ... EOF)" 형태. 따옴표로 감싼 값 전체가 이 패턴이면 실제로 지적할
// 대상은 heredoc 본문뿐이다. $(...) 자체는 명령이지 한국어 문장이 아니다.
// 종료 표시 앞에 탭이 올 수 있다 — <<-'EOF' 처럼 탭을 지우는 형태를 쓸 때 흔하다.
const CAT_HEREDOC_VALUE = /^\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1\r?\n([\s\S]*?)\r?\n\t*\2\s*\)$/d;

// git commit 앞에 흔히 붙는 것들. 뒤에 진짜 git이 있는지는 findGitCommitCommand 가 본다.
const PREFIX_SKIP_WORDS = new Set(["sudo", "time", "command", "nohup", "env", "then", "do", "else", "!"]);
const SHELL_C_NAMES = new Set(["bash", "sh", "zsh", "dash"]);
const MAX_RECURSION_DEPTH = 3;

function unescapeDoubleQuoted(text) {
  return text.replace(/\\([$`"\\\n])/g, "$1");
}

/**
 * unescapeDoubleQuoted 와 같은 규칙으로 풀되, 풀린 각 글자가 원문의 어느 자리에서
 * 왔는지도 같이 돌려준다. `bash -c "..."` 처럼 이중 따옴표 스크립트 안에서 찾은
 * 위치를 바깥 명령 문자열의 실제 글자 위치로 되짚어 갈 때 쓴다.
 *
 * @param {string} raw
 * @returns {{text: string, mapToOuter: number[]}} mapToOuter[k] 는 풀린 글자 k 번째가
 *   시작하는 raw 안의 위치. mapToOuter[text.length] 는 raw.length(끝 경계).
 */
function unescapeDoubleQuotedWithMap(raw) {
  let text = "";
  const mapToOuter = [0];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    if (raw[i] === "\\" && /[$`"\\\n]/.test(raw[i + 1] ?? "")) {
      text += raw[i + 1];
      i += 2;
    } else {
      text += raw[i];
      i += 1;
    }
    mapToOuter.push(i);
  }
  return { text, mapToOuter };
}

function escapeDoubleQuoted(text) {
  return text.replace(/[$`"\\]/g, "\\$&");
}

/** 이중 따옴표 내용을 훑는다. i는 여는 따옴표 다음 위치. 닫는 따옴표의 인덱스를 돌려준다(없으면 길이). */
function skipDoubleQuoted(command, i) {
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === '"') return i;
    if (ch === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      i = skipSubshell(command, i + 2) + 1;
      continue;
    }
    i += 1;
  }
  return n;
}

/**
 * $( ... ) 안을 훑는다. i는 여는 괄호 다음 위치. 닫는 괄호의 인덱스를 돌려준다(없으면 길이).
 *
 * 명령 문맥이므로 안에서도 heredoc이 다시 의미를 갖는다. 여기서 만난 heredoc은 소유자(slot)
 * 없이 버린다 — 서브셸 안의 heredoc을 바깥 명령에 엮을 이유가 없다.
 */
function skipSubshell(command, i) {
  const n = command.length;
  let pendingHeredocs = [];
  while (i < n) {
    const ch = command[i];
    if (ch === ")") return i;
    if (ch === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(command, i + 1) + 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      i = skipSubshell(command, i + 2) + 1;
      continue;
    }
    const hd = matchHeredocOperator(command, i);
    if (hd) {
      pendingHeredocs.push(hd.heredoc); // slot 없음 — consumeHeredocBodies 가 그냥 지나간다
      i = hd.next;
      continue;
    }
    if (ch === "\n" && pendingHeredocs.length > 0) {
      i = consumeHeredocBodies(command, i + 1, pendingHeredocs);
      pendingHeredocs = [];
      continue;
    }
    i += 1;
  }
  return n;
}

function matchHeredocOperator(command, i) {
  if (command[i] !== "<" || command[i + 1] !== "<") return null;
  let j = i + 2;
  let dashStrip = false;
  if (command[j] === "-") {
    dashStrip = true;
    j += 1;
  }
  while (command[j] === " " || command[j] === "\t") j += 1;
  let marker = "";
  let quoted = false; // 종료 표시를 따옴표로 감쌌는지 — 감쌌으면 본문 안의 $(…)·${…}·백틱이 셸에서 확장되지 않는다
  if (command[j] === "'" || command[j] === '"') {
    quoted = true;
    const q = command[j];
    const close = command.indexOf(q, j + 1);
    if (close === -1) return null;
    marker = command.slice(j + 1, close);
    j = close + 1;
  } else {
    const start = j;
    while (j < command.length && /[A-Za-z0-9_]/.test(command[j])) j += 1;
    if (j === start) return null;
    marker = command.slice(start, j);
  }
  return { heredoc: { marker, dashStrip, quoted }, next: j };
}

/**
 * heredoc 본문들을 순서대로 소비한다. 각 heredoc이 `slot`(그것을 요청한 단순 명령의
 * 자리)을 들고 있으면 그 slot.heredocs 에 결과를 담는다 — `;`/`&&`로 나뉜 여러 명령이
 * 같은 줄에서 heredoc을 하나씩 요청해도(`cat <<A; git commit -F - <<B`) 각자 제 몫만 받는다.
 */
function consumeHeredocBodies(command, pos, heredocs) {
  const n = command.length;
  for (const hd of heredocs) {
    const bodyStart = pos;
    let searchFrom = pos;
    let bodyEnd = n;
    let resumeAt = n;
    while (true) {
      const lineEnd = command.indexOf("\n", searchFrom);
      const lineTextEnd = lineEnd === -1 ? n : lineEnd;
      const line = command.slice(searchFrom, lineTextEnd);
      const testLine = hd.dashStrip ? line.replace(/^\t+/, "") : line;
      if (testLine === hd.marker) {
        bodyEnd = searchFrom > bodyStart && command[searchFrom - 1] === "\n" ? searchFrom - 1 : searchFrom;
        resumeAt = lineEnd === -1 ? n : lineEnd + 1;
        break;
      }
      if (lineEnd === -1) {
        bodyEnd = n;
        resumeAt = n;
        break;
      }
      searchFrom = lineEnd + 1;
    }
    if (hd.slot) {
      hd.slot.heredocs.push({ marker: hd.marker, dashStrip: hd.dashStrip, quoted: hd.quoted, bodyStart, bodyEnd });
    }
    pos = resumeAt;
  }
  return pos;
}

/**
 * 명령을 `&&`, `||`, `;`, `|`, 줄바꿈 기준으로 단순 명령들로 나눈다. 따옴표와 `$(...)` 안은
 * 건드리지 않는다. 각 단순 명령에 딸린 heredoc의 본문 위치도 함께 기억한다.
 *
 * 바깥에 그대로 드러난(따옴표 밖) `$(...)` 도 만나는 대로 subshells 에 담는다 —
 * `out=$(git commit -m "...")` 처럼 대입문 안에 커밋이 숨어 있는 경우를 잡기 위해서다.
 *
 * @param {string} command
 * @param {{start: number, end: number}[]} [subshells] 채워 넣을 배열(부작용)
 * @returns {{start: number, end: number, heredocs: object[]}[]}
 */
export function parseSimpleCommands(command, subshells) {
  const n = command.length;
  const commands = [];
  let i = 0;
  let curStart = 0;
  let curSlot = { heredocs: [] };
  let pendingHeredocs = [];

  const finalize = (end) => {
    if (end > curStart) commands.push({ start: curStart, end, heredocs: curSlot.heredocs });
    curSlot = { heredocs: [] };
  };

  while (i < n) {
    const ch = command[i];
    if (ch === "\\" && i + 1 < n) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(command, i + 1) + 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      const innerStart = i + 2;
      const innerEnd = skipSubshell(command, innerStart);
      if (subshells) subshells.push({ start: innerStart, end: innerEnd });
      i = innerEnd + 1;
      continue;
    }

    const hd = matchHeredocOperator(command, i);
    if (hd) {
      pendingHeredocs.push({ ...hd.heredoc, slot: curSlot });
      i = hd.next;
      continue;
    }

    if (ch === "\n") {
      if (pendingHeredocs.length > 0) {
        i = consumeHeredocBodies(command, i + 1, pendingHeredocs);
        pendingHeredocs = [];
        finalize(i);
        curStart = i;
        continue;
      }
      finalize(i);
      curStart = i + 1;
      i += 1;
      continue;
    }

    if (ch === "&" && command[i + 1] === "&") {
      finalize(i);
      i += 2;
      curStart = i;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      finalize(i);
      i += 2;
      curStart = i;
      continue;
    }
    if (ch === "|") {
      finalize(i);
      i += 1;
      curStart = i;
      continue;
    }
    if (ch === ";") {
      finalize(i);
      i += 1;
      curStart = i;
      continue;
    }

    i += 1;
  }
  finalize(n);
  return commands;
}

/**
 * 공백으로 낱말을 나눈다. 따옴표와 `$(...)` 안의 공백은 낱말을 가르지 않는다.
 * 줄 끝의 `\`(다음 줄로 이어짐)도 공백처럼 취급한다 — 안 그러면 `git add . && \`
 * 다음 줄의 `git commit` 이 백슬래시·줄바꿈과 한 낱말로 붙어 "git"과 정확히 같지 않게 된다.
 */
function tokenizeWords(command, start, end) {
  const tokens = [];
  let i = start;
  let tokenStart = -1;
  while (i < end) {
    const ch = command[i];
    const isLineContinuation = ch === "\\" && command[i + 1] === "\n";
    if (ch === " " || ch === "\t" || isLineContinuation) {
      if (tokenStart !== -1) {
        tokens.push({ start: tokenStart, end: i });
        tokenStart = -1;
      }
      i += isLineContinuation ? 2 : 1;
      continue;
    }
    if (tokenStart === -1) tokenStart = i;
    if (ch === "\\" && i + 1 < end) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const e = command.indexOf("'", i + 1);
      i = e === -1 || e >= end ? end : e + 1;
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(command, i + 1) + 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      i = skipSubshell(command, i + 2) + 1;
      continue;
    }
    i += 1;
  }
  if (tokenStart !== -1) tokens.push({ start: tokenStart, end });
  return tokens;
}

/** 여는 괄호/중괄호가 낱말 앞에 붙어 있으면(`(git`, `{git`) 뗀다. */
function stripLeadingGroup(word) {
  return word.replace(/^[({]+/, "");
}

/**
 * git 앞에 흔히 붙는 것들을 건너뛴다: VAR=대입, sudo/time/command/nohup/env(와 그 플래그),
 * then/do/else/!, 여는 괄호·중괄호.
 * @returns {number} git이어야 할 토큰의 인덱스
 */
function skipCommandPrefix(tokens, command) {
  let idx = 0;
  let skippedKeyword = false;
  while (idx < tokens.length) {
    const raw = command.slice(tokens[idx].start, tokens[idx].end);
    const word = stripLeadingGroup(raw);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      idx += 1;
      continue;
    }
    if (PREFIX_SKIP_WORDS.has(word)) {
      idx += 1;
      skippedKeyword = true;
      continue;
    }
    if (/^[({]+$/.test(raw)) {
      // 괄호/중괄호만 있고 뒤에 낱말이 안 붙어 있었다("(" 단독 토큰) — 그냥 지나간다
      idx += 1;
      continue;
    }
    // sudo/env/time 뒤에 딸린 그것들 자신의 플래그(-n, -i 등)
    if (skippedKeyword && /^-/.test(word)) {
      idx += 1;
      continue;
    }
    break;
  }
  return idx;
}

/** 낱말들이 `git [전역 옵션...] commit` 형태인지 보고, commit 토큰의 인덱스를 돌려준다. */
function findGitCommitCommand(tokens, command) {
  if (tokens.length === 0) return null;
  const start = skipCommandPrefix(tokens, command);
  if (start >= tokens.length) return null;
  const first = stripLeadingGroup(command.slice(tokens[start].start, tokens[start].end));
  if (first !== "git" && !/(?:^|\/)git$/.test(first)) return null;

  let idx = start + 1;
  while (idx < tokens.length) {
    const word = command.slice(tokens[idx].start, tokens[idx].end);
    if (word === "commit") return idx;
    if (/^-[Cc]$/.test(word)) {
      idx += 2;
      continue;
    }
    if (/^--?[A-Za-z][\w-]*=/.test(word) || /^--?[A-Za-z][\w-]*$/.test(word)) {
      idx += 1;
      continue;
    }
    return null; // 다른 하위 명령(log, status, add 등)이면 커밋 메시지를 찾지 않는다
  }
  return null;
}

function matchMessageFlag(word) {
  if (word === "--message") return { type: "message", form: "alone" };
  let m = /^--message=([\s\S]*)$/.exec(word);
  if (m) return { type: "message", form: "inline", valueOffset: word.indexOf("=") + 1 };
  if (word === "--file") return { type: "file", form: "alone" };
  m = /^--file=([\s\S]*)$/.exec(word);
  if (m) return { type: "file", form: "inline", valueOffset: word.indexOf("=") + 1 };

  if (SHORT_M_ALONE.test(word)) return { type: "m", form: "alone" };
  m = SHORT_M_INLINE.exec(word);
  if (m) return { type: "m", form: "inline", valueOffset: word.length - m[1].length };

  if (SHORT_F_ALONE.test(word)) return { type: "file", form: "alone" };
  m = SHORT_F_INLINE.exec(word);
  if (m) return { type: "file", form: "inline", valueOffset: word.length - m[1].length };

  return null;
}

function readValue(command, absPos, tokenEnd) {
  const ch = command[absPos];
  if (ch === '"') {
    const closeIdx = skipDoubleQuoted(command, absPos + 1);
    return { quote: '"', innerStart: absPos + 1, innerEnd: closeIdx };
  }
  if (ch === "'") {
    const closeIdx = command.indexOf("'", absPos + 1);
    const end = closeIdx === -1 || closeIdx > tokenEnd ? tokenEnd : closeIdx;
    return { quote: "'", innerStart: absPos + 1, innerEnd: end };
  }
  return { quote: null, innerStart: absPos, innerEnd: tokenEnd };
}

/**
 * 옵션 토큰들을 훑어 `-c`(또는 `-lc`, `-ec`, `-xec` 처럼 c를 포함한 결합형)를 찾고,
 * 그 다음 토큰(스크립트 문자열)의 인덱스를 돌려준다. `--` 를 만나거나 옵션처럼 안
 * 생긴 낱말이 먼저 나오면 `-c` 호출이 아니다.
 * @returns {number|null}
 */
function findDashCScriptIndex(tokens, command) {
  let idx = 1;
  while (idx < tokens.length) {
    const word = command.slice(tokens[idx].start, tokens[idx].end);
    if (word === "--" || !/^-[A-Za-z]+$/.test(word)) return null;
    idx += 1;
    if (word.includes("c")) return idx;
  }
  return null;
}

/** git ... commit 이 아닌, `sh`/`bash`/`zsh`/`dash -c "..."` 안에 숨은 커밋도 살핀다. */
function extractShellDashCTargets(command, sc, depth) {
  if (depth >= MAX_RECURSION_DEPTH) return [];
  const tokens = tokenizeWords(command, sc.start, sc.end);
  if (tokens.length < 2) return [];
  const first = stripLeadingGroup(command.slice(tokens[0].start, tokens[0].end));
  if (!SHELL_C_NAMES.has(first) && !/\/(?:bash|sh|zsh|dash)$/.test(first)) return [];

  const scriptIdx = findDashCScriptIndex(tokens, command);
  if (scriptIdx === null || scriptIdx >= tokens.length) return [];
  const scriptTok = tokens[scriptIdx];
  const quote = command[scriptTok.start];

  if (quote === "'") {
    // 작은따옴표 안은 이스케이프가 없는 그대로의 문자다 — 안쪽 위치에 시작 위치만 더하면 된다.
    const innerStart = scriptTok.start + 1;
    const innerEnd = command.indexOf("'", innerStart);
    if (innerEnd === -1) return [];
    const inner = command.slice(innerStart, innerEnd);
    return extractCommitTargets(inner, depth + 1).map((t) => ({
      ...t,
      start: t.start + innerStart,
      end: t.end + innerStart,
    }));
  }

  if (quote === '"') {
    // 이중 따옴표 스크립트는 바깥 셸이 한 번 풀어서 bash -c 에 넘긴다. 안쪽 문자열을 풀어
    // 다시 추출한 뒤, 찾아낸 자리를 바깥 글자 위치로 되짚는다.
    const outerInnerStart = scriptTok.start + 1;
    const outerInnerEnd = skipDoubleQuoted(command, outerInnerStart);
    const outerRaw = command.slice(outerInnerStart, outerInnerEnd);
    const { text: inner, mapToOuter } = unescapeDoubleQuotedWithMap(outerRaw);
    const innerTargets = extractCommitTargets(inner, depth + 1);
    return innerTargets.map((t) => {
      const outerStart = outerInnerStart + mapToOuter[t.start];
      const outerEnd = outerInnerStart + mapToOuter[t.end];
      const outerSlice = command.slice(outerStart, outerEnd);
      // outerSlice가 안쪽 글과 글자 그대로 같다는 것은 이 구간에 이스케이프가 하나도
      // 없었다는 뜻이다(이스케이프가 있었다면 바깥 구간이 더 길다). 그런데도 $나 백틱이
      // 그 구간에 남아 있다면 bash -c를 부르는 바깥 셸이 그것을 먼저 확장해 버린다 —
      // 그 경우는 손대지 않고 알리기만 한다.
      const safe =
        t.replaceable && outerSlice === t.text && !outerSlice.includes("$") && !outerSlice.includes("`");
      return { ...t, start: outerStart, end: outerEnd, replaceable: safe, escapeOnWrite: false };
    });
  }

  return [];
}

/**
 * git commit 명령에서 메시지로 쓰이는 구간을 정확한 글자 범위로 뽑는다.
 *
 * @param {string} command
 * @param {number} [depth] `$(...)`/`bash -c`로 파고드는 재귀 깊이. 바깥에서는 넘기지 않는다.
 * @returns {{start: number, end: number, text: string, quote: string|null, replaceable: boolean, escapeOnWrite: boolean}[]}
 */
export function extractCommitTargets(command, depth = 0) {
  if (typeof command !== "string") return [];
  if (!/\bgit\b/.test(command) || !/\bcommit\b/.test(command)) return [];
  if (depth >= MAX_RECURSION_DEPTH) return [];

  const targets = [];
  const subshells = [];
  const simpleCommands = parseSimpleCommands(command, subshells);

  for (const sc of simpleCommands) {
    const tokens = tokenizeWords(command, sc.start, sc.end);
    const commitIdx = findGitCommitCommand(tokens, command);

    if (commitIdx !== null) {
      let ti = commitIdx + 1;
      while (ti < tokens.length) {
        const tok = tokens[ti];
        const word = command.slice(tok.start, tok.end);
        if (word === "--") break; // 이 뒤는 경로 스펙이다. -m 처럼 보여도 더는 플래그가 아니다

        const flag = matchMessageFlag(word);
        if (!flag) {
          ti += 1;
          continue;
        }

        let valueStart;
        let valueEnd;
        if (flag.form === "inline") {
          valueStart = tok.start + flag.valueOffset;
          valueEnd = tok.end;
          ti += 1;
        } else {
          const next = tokens[ti + 1];
          if (!next) {
            ti += 1;
            continue;
          }
          valueStart = next.start;
          valueEnd = next.end;
          ti += 2;
        }

        if (flag.type === "file") {
          const raw = command.slice(valueStart, valueEnd).replace(/^['"]|['"]$/g, "");
          if (raw !== "-" && raw !== "/dev/stdin") continue;
          // 한 명령에 heredoc이 여럿이면(드물지만) 실제로 표준입력에 연결되는 건 마지막 것이다.
          const hd = sc.heredocs[sc.heredocs.length - 1];
          if (!hd || hd.bodyEnd <= hd.bodyStart) continue;
          const hdBody = command.slice(hd.bodyStart, hd.bodyEnd);
          targets.push({
            start: hd.bodyStart,
            end: hd.bodyEnd,
            text: hdBody,
            quote: null,
            // 종료 표시가 따옴표로 감싸여 있으면(quoted) 본문의 $(…)·${…}·백틱은 셸이
            // 확장하지 않는 글자 그대로다 — 자동 교정이 그 글자를 고쳐도 실행에 영향이
            // 없다. 감싸지 않았다면(unquoted) -m 경로(아래)와 같은 정책으로, 그런 문자가
            // 없을 때만 안전하다.
            replaceable: hd.quoted || !/\$\(|\$\{|`/.test(hdBody),
            escapeOnWrite: false,
          });
          continue;
        }

        const value = readValue(command, valueStart, valueEnd);
        const raw = command.slice(value.innerStart, value.innerEnd);
        if (raw.trim().length === 0) continue;

        if (value.quote === '"') {
          const catMatch = CAT_HEREDOC_VALUE.exec(raw);
          if (catMatch) {
            const [bStart, bEnd] = catMatch.indices[3];
            const catBody = catMatch[3];
            // catMatch[1]은 종료 표시를 감싼 따옴표 글자('든 "든) 자체는 안 본다 — 감쌌는지
            // 여부만 중요하다. 감쌌으면(quoted) -F - 경로와 같은 정책을 그대로 적용한다.
            const catQuoted = catMatch[1] !== "";
            targets.push({
              start: value.innerStart + bStart,
              end: value.innerStart + bEnd,
              text: catBody,
              quote: null,
              replaceable: catQuoted || !/\$\(|\$\{|`/.test(catBody),
              escapeOnWrite: false,
            });
            continue;
          }
          // 백슬래시가 하나도 없으면 이스케이프를 걱정할 게 없다 — 원문 그대로 잘라 붙인다.
          // $BRANCH나 `date` 처럼 이스케이프 없이 쓴 특수 문자를 건드리지 않는 길이 이 길뿐이다.
          // 다만 $(…)와 ${…} 안은 명령과 매개변수 확장이라 글이 아니다. 가림 처리가 그 안을
          // 덮지 못하므로 고치지 않고 알리기만 한다. "$(grep 리팩토링 a.txt)"의 검색어가 바뀌었다.
          if (!raw.includes("\\")) {
            targets.push({
              start: value.innerStart,
              end: value.innerEnd,
              text: raw,
              quote: '"',
              replaceable: !raw.includes("$(") && !raw.includes("${"),
              escapeOnWrite: false,
            });
            continue;
          }
          // 백슬래시가 하나라도 있으면(예: \" 로 이스케이프한 따옴표) 되돌릴 때도 다시
          // 이스케이프를 입혀야 한다. escapeDoubleQuoted 는 $/백틱/따옴표/백슬래시를
          // 전부 이스케이프하므로, 원문에 이스케이프된 \"나 \\ 와 이스케이프되지 않은
          // $VAR나 백틱이 함께 있으면(예: `"\"컨텐츠\" $BRANCH"`) 되짚었을 때 원문과
          // 달라진다 — $BRANCH 까지 `\$BRANCH` 로 다시 이스케이프되어 버리기 때문이다.
          // 이런 뒤섞인 경우는 일부러 경고만 하고 자동 교정하지 않는다. 절반만 맞는
          // 이스케이프를 밀어 넣는 것보다는 사람이 보고 고치는 편이 안전하다.
          const text = unescapeDoubleQuoted(raw);
          const roundtrip = escapeDoubleQuoted(text) === raw;
          targets.push({
            start: value.innerStart,
            end: value.innerEnd,
            text,
            quote: '"',
            replaceable: roundtrip,
            escapeOnWrite: true,
          });
          continue;
        }

        targets.push({
          start: value.innerStart,
          end: value.innerEnd,
          text: raw,
          quote: value.quote,
          replaceable: true,
          escapeOnWrite: false,
        });
      }
    }

    targets.push(...extractShellDashCTargets(command, sc, depth));
  }

  for (const sub of subshells) {
    const inner = command.slice(sub.start, sub.end);
    for (const t of extractCommitTargets(inner, depth + 1)) {
      targets.push({ ...t, start: t.start + sub.start, end: t.end + sub.start });
    }
  }

  return targets;
}

export { escapeDoubleQuoted, unescapeDoubleQuoted };
