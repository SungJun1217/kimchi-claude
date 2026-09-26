// 저장소에 남는 산출물의 한국어를 검사한다. 커밋 메시지와 한국어 문서 파일이 대상이다.
//
// 진입점은 hooks/guard.mjs 다. 이 파일은 판정만 하고 훅 입출력은 다루지 않는다.
//
// 이 훅은 말투를 다듬는 부가 기능이고 작업에 필요한 부품이 아니다.
// 그래서 어떤 오류가 나도 조용히 아무 일도 하지 않고 종료 코드 0으로 끝낸다.
// 훅이 깨져서 작업이 막히면 그것이 더 큰 실패다.
//
import { readFileSync, statSync } from "node:fs";
import { dirname, join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules } from "./rules.mjs";
import { lint, applyFixes, formatFindings } from "./lint.mjs";
import { findParticleErrors, fixParticles, formatParticleErrors } from "./particle.mjs";
import { looksKorean } from "./detect.mjs";
import { isIgnoredFile, maskProtected, collectReferenceDefLabels, MASK } from "./segment.mjs";
import { extractCommitTargets, escapeDoubleQuoted } from "./bash-commit.mjs";
import { groupCounted, formatGroupedList, MAX_LISTED } from "./format.mjs";

const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 문서 파일만 본다. 소스 파일을 검사하면 코드 주석까지 건드리게 되고, 그것은 적용 범위 밖이다.
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"]);

// .txt 확장자 자체는 남겨 둔다. 일반 텍스트로 적은 설계 메모·안내문에도 검사해야 할 산문이 있다.
// 하지만 아래 이름들은 이름 자체가 이미 정해진 빌드 도구용 형식이지 산문이 아니다.
// 말투 검사(이 파일)만 뺀다 — 개인정보 검사는 pii.mjs가 파일 종류와 무관하게 모든
// 파일에 그대로 돈다(불변식 2).
const TONE_EXEMPT_BASENAMES = [
  /^CMakeLists\.txt$/,
  /^requirements.*\.txt$/,
  /.*-requirements\.txt$/,
  /^constraints.*\.txt$/,
  /^robots\.txt$/,
];

function isToneExemptBasename(filePath) {
  const base = basename(filePath || "");
  return TONE_EXEMPT_BASENAMES.some((pattern) => pattern.test(base));
}

/**
 * 파일이 스스로를 검사 예외로 선언했는지 디스크에서 확인한다.
 * 읽을 수 없으면(새 파일 등) 선언이 없는 것으로 본다.
 */
function declaresIgnore(filePath) {
  try {
    // 일반 파일만 읽는다. FIFO 나 소켓은 stat 은 끝나도 읽기가 끝나지 않을 수 있다.
    if (!statSync(filePath).isFile()) return false;
    return isIgnoredFile(readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
}

/**
 * git commit 명령에서 메시지로 보이는 부분을 뽑는다. (하위 호환용 — 문자열만 필요한 호출부를 위한 얇은 래퍼)
 *
 * 실제 위치 정보가 필요한 자동 교정은 extractCommitTargets 를 직접 쓴다.
 */
function extractCommitMessages(command) {
  return extractCommitTargets(command).map((t) => t.text);
}

// Edit/MultiEdit 문맥 확인에 읽을 파일의 크기 상한. 이보다 크면 비용을 걸지 않고 조각만 본다.
const MAX_CONTEXT_FILE_BYTES = 1_000_000;

function readDocForContext(filePath) {
  try {
    // 일반 파일만, 크기 상한 안에서만 읽는다. FIFO 같은 대상은 isFile() 이 걸러 준다.
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_CONTEXT_FILE_BYTES) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * dst에 src 원소를 하나씩 민다. spread(...src)는 함수 호출 인자 개수 상한(수만 건)에
 * 걸려 대량 반복 문서에서 "Maximum call stack size exceeded"로 죽는다(실측).
 */
function pushAll(dst, src) {
  for (const item of src) dst.push(item);
}

/** 파일 확장자를 점 없이 소문자로. maskProtected/lint 의 블록형 가리개 범위를 정하는 데 쓴다. */
function docExt(filePath) {
  const ext = extname(filePath || "").toLowerCase();
  return ext ? ext.slice(1) : undefined;
}

/**
 * 문자열 하나가 파일 안에서 검사 예외(코드 울타리, kimchi-ignore 구간 등) 안에 있는지 본다.
 * 위치를 하나로 정할 수 없으면(없거나, replace_all 없이 여러 번 나오면) 보류.
 * 등장한 자리 일부만 예외 구간이면("일부만"도 판단을 보류한다 — 불변식 5) 보류로 본다.
 *
 * @returns {"exempt"|"unknown"|"ok"}
 */
function locateAndClassify(fileText, ext, needle, replaceAll) {
  if (typeof needle !== "string" || needle.length === 0) return "unknown";
  const first = fileText.indexOf(needle);
  if (first === -1) return "unknown";
  const second = fileText.indexOf(needle, first + 1);
  if (second !== -1 && !replaceAll) return "unknown";

  const occurrences = [];
  let idx = first;
  while (idx !== -1) {
    occurrences.push(idx);
    if (!replaceAll) break;
    idx = fileText.indexOf(needle, idx + needle.length);
  }

  const masked = maskProtected(fileText, { ext });
  const flags = occurrences.map((at) => masked.slice(at, at + needle.length) === MASK.repeat(needle.length));
  if (flags.every(Boolean)) return "exempt";
  if (flags.some(Boolean)) return "unknown"; // 일부만 예외 구간 — 하나로 못 정한 것과 같다
  return "ok";
}

/**
 * Edit/MultiEdit 조각이 파일의 어느 위치에 들어가는지 찾아, 그 자리가 코드 울타리나
 * kimchi-ignore 구간처럼 검사 예외인지 본다.
 *
 * PreToolUse 시점에는 파일에 아직 old_string이 남아 있고, PostToolUse 시점에는 이미
 * new_string으로 바뀌어 있다. 이 함수는 둘 중 무엇이 호출됐는지 모르므로 old_string을
 * 먼저 찾아보고, 못 찾으면 new_string으로 다시 찾는다 — 그래야 PostToolUse 에서도
 * 울타리 안 편집을 예외로 알아본다.
 *
 * 위치를 하나로 정할 수 없으면(파일을 못 읽거나, 둘 다 없거나, replace_all 없이
 * 여러 번 나오면) 판단을 보류한다 — 불변식 5. 이때 자동 교정은 그 대상을 건너뛰고,
 * 경고는 조각만으로 계속한다.
 *
 * @param {string|null} fileText 미리 읽어 둔 파일 전체 글. null이면 못 읽은 것이다.
 * @returns {"exempt"|"unknown"|"ok"}
 */
function classifyEditContext(fileText, ext, oldString, newString, replaceAll) {
  if (fileText === null) return "unknown";
  const viaOld = locateAndClassify(fileText, ext, oldString, replaceAll);
  if (viaOld !== "unknown") return viaOld;
  return locateAndClassify(fileText, ext, newString, replaceAll);
}

/**
 * 검사 대상 문자열들을 뽑는다. 대상이 아니면 빈 배열.
 * @returns {{label: string, text: string, field: string, editIndex?: number, span?: object, quote?: string|null, replaceable?: boolean, autofixSafe?: boolean}[]}
 */
function extractTargets(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];

  if (toolName === "Bash") {
    return extractCommitTargets(toolInput.command).map((t) => ({
      label: "커밋 메시지",
      text: t.text,
      field: "command",
      span: { start: t.start, end: t.end },
      quote: t.quote,
      replaceable: t.replaceable,
      escapeOnWrite: t.escapeOnWrite,
      // ext 없음: 커밋 메시지에는 들여쓰기 코드·rST·AsciiDoc 같은 문서 전용 가리개를
      // 적용하지 않는다. "    컨텐츠 정리"처럼 앞에 공백이 붙었다고 코드로 볼 이유가 없다.
    }));
  }

  const filePath = toolInput.file_path || "";
  if (filePath && !DOC_EXTENSIONS.has(extname(filePath).toLowerCase())) return [];
  if (filePath && isToneExemptBasename(filePath)) return [];
  const ext = docExt(filePath);

  if (toolName === "Edit" && typeof toolInput.new_string === "string") {
    // 파일은 한 번만 읽는다 — 예외 선언 확인(isIgnoredFile), 울타리 판정
    // (classifyEditContext), 참조식 링크 정의 수집(refDefs)이 같은 사본을 함께 쓴다.
    const fileText = filePath ? readDocForContext(filePath) : null;
    if (declaresIgnoreFrom(filePath, fileText)) return [];
    const ctx = classifyEditContext(fileText, ext, toolInput.old_string, toolInput.new_string, toolInput.replace_all);
    if (ctx === "exempt") return [];
    return [
      {
        label: filePath || "문서",
        text: toolInput.new_string,
        field: "new_string",
        ext,
        autofixSafe: ctx !== "unknown",
        // 조각(new_string)만으로는 파일 다른 곳의 참조식 링크 정의(`[라벨]: url`)가 안 보인다.
        // fileText가 null(못 읽음)이면 null을 그대로 넘겨 findReferenceLabelRanges가
        // 보수적으로 두 괄호짜리 참조를 전부 가리게 한다 — 죽은 링크보다 지적을 놓치는
        // 쪽이 낫다.
        refDefs: fileText === null ? null : collectReferenceDefLabels(fileText, ext),
      },
    ];
  }

  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    const fileText = filePath ? readDocForContext(filePath) : null;
    if (declaresIgnoreFrom(filePath, fileText)) return [];
    const refDefs = fileText === null ? null : collectReferenceDefLabels(fileText, ext);
    return toolInput.edits
      .map((edit, editIndex) => {
        if (typeof edit?.new_string !== "string") return null;
        const ctx = classifyEditContext(fileText, ext, edit.old_string, edit.new_string, edit.replace_all);
        if (ctx === "exempt") return null;
        return {
          label: filePath || "문서",
          text: edit.new_string,
          field: "new_string",
          ext,
          editIndex,
          autofixSafe: ctx !== "unknown",
          refDefs,
        };
      })
      .filter(Boolean);
  }

  // 파일이 스스로를 예외로 선언했으면 조각만 넘어와도 존중한다.
  //
  // lint() 는 넘겨받은 글에서 표시를 찾으므로, Edit/MultiEdit 처럼 조각만 오면 파일
  // 수준 선언이 보이지 않는다 — 위 두 분기는 이미 읽어 둔 fileText로 확인을 마쳤다.
  // Write는 새 내용을 파일 전체로 받으므로 여기서 디스크의 기존 내용을 따로 읽어 본다.
  if (filePath && declaresIgnore(filePath)) return [];

  if (toolName === "Write" && typeof toolInput.content === "string") {
    return [{ label: filePath || "문서", text: toolInput.content, field: "content", ext }];
  }

  return [];
}

/**
 * 이미 읽어 둔 fileText로 예외 선언을 확인한다. 크기 상한(readDocForContext)에 걸려
 * fileText가 null이면 declaresIgnore로 한 번 더 읽어 큰 파일에서도 선언을 놓치지 않는다
 * — 그 경우에만 두 번 읽고, 보통 크기 파일은 이 함수 덕분에 한 번만 읽는다.
 */
function declaresIgnoreFrom(filePath, fileText) {
  if (fileText !== null) return isIgnoredFile(fileText);
  return filePath ? declaresIgnore(filePath) : false;
}

// 같은 교정이 문서에 수천 번 반복될 수 있다(1.24M자 문서에서 실측: 3.6MB짜리 훅 JSON).
// 종류별로 묶어 세지 않으면 systemMessage/additionalContext 가 건수에 비례해 커진다 —
// particle.mjs의 formatParticleErrors, lint.mjs의 formatFindings와 같은 문제, 같은 해법이다.
// 묶고 나열하는 부분은 format.mjs 하나로 모았다.
const MAX_LISTED_FIXES = MAX_LISTED;

function groupApplied(applied) {
  return groupCounted(applied, (item) => `${item.matched}\u0000${item.replacement}`);
}

function formatFixList(applied) {
  const entries = groupApplied(applied);
  const lines = formatGroupedList(
    entries,
    ({ item, count }) => `- "${item.matched}" → "${item.replacement}"${count > 1 ? ` (총 ${count}곳)` : ""}`,
    MAX_LISTED_FIXES
  );
  return lines.join("\n");
}

function describeFixes(applied) {
  const distinct = groupApplied(applied).length;
  const header =
    distinct === applied.length
      ? `한국어 표현 ${applied.length}건을 고쳤습니다.`
      : `한국어 표현 ${distinct}가지(총 ${applied.length}건)를 고쳤습니다.`;
  return [header, formatFixList(applied)].join("\n");
}

// 자동 교정은 updatedInput 필드에 고친 문서 전체를 그대로 되실어 보낸다. 문서가 크면
// 훅 JSON 자체가 그만큼 커진다(실측: 2.48MB 문서 → 출력 JSON 2.6MB). fixParticles/
// applyFixes 를 선형으로 고쳐도(0.14.13) 계산·직렬화·쓰기가 모두 안전 타이머(guard.mjs,
// 4초) 안에 끝난다는 보장은 문서 크기가 무한이면 성립하지 않는다. 이 상한을 넘는
// 대상은 자동 교정을 건너뛰고 원본 그대로 둔다 — PostToolUse 의 warnAboutTone 이
// 이어받아 경고만 한다.
const MAX_AUTOFIX_CHARS = 2_000_000;

export function autofixOrBlock(toolName, toolInput, targets, rules) {
  if (blockEnabled()) {
    // F8: 막을 때만 전체 위반 목록이 필요하다. 자동 교정 경로에서는 applyFixes 가
    // 안에서 다시 검사하므로 미리 훑으면 같은 일을 두 번 한다.
    const allFindings = targets.flatMap((target) => lint(target.text, rules, target));
    if (allFindings.length === 0) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: formatFindings(allFindings, targets[0]?.label || ""),
      },
    };
  }

  // 자동 교정은 updatedInput에 고친 문서 전체를 되실어 보낸다. MultiEdit처럼 대상이
  // 여럿이면 편집 하나하나는 상한 밑이어도 다 더하면 넘을 수 있다 — 훅 JSON 크기를
  // 결정하는 것은 호출 전체이지 대상 하나가 아니다. 합쳐서 넘으면 이 호출 전체에서
  // 자동 교정을 건너뛴다(PostToolUse의 warnAboutTone이 이어받는다).
  const totalChars = targets.reduce((sum, target) => sum + (typeof target.text === "string" ? target.text.length : 0), 0);
  if (totalChars > MAX_AUTOFIX_CHARS) return null;

  // 자동 교정. 원본을 그대로 유지한 채 필드별로 바꿔 넣는다.
  const updatedInput = { ...toolInput };
  const applied = [];
  let changed = false;

  /** 조사를 먼저 고치고, 그다음 용어를 고친다. 용어를 바꾸면 조사가 다시 틀어질 수 있어 한 번 더 돈다. */
  function fixOne(text, mask) {
    const withParticles = fixParticles(text, mask);
    const result = applyFixes(withParticles.text, rules, mask);
    // 용어를 하나도 안 고쳤으면 조사도 다시 틀어질 일이 없다 — 마지막 fixParticles를
    // 건너뛴다(같은 글을 또 가리는 비용도 함께 던다, maskProtected 캐시가 있어도 호출은 던다).
    const fixedText = result.applied.length === 0 ? result.text : fixParticles(result.text, mask).text;
    return {
      text: fixedText,
      applied: [
        ...withParticles.applied.map((hit) => ({ matched: hit.matched, replacement: `${hit.word}${hit.correct}` })),
        ...result.applied,
      ],
    };
  }

  if (toolName === "Bash") {
    // 위치가 확실한 대상만 고친다. 나머지(예: 이스케이프를 되돌릴 수 없는 문자열)는 그대로 둔다.
    const edits = [];
    for (const target of targets) {
      if (target.replaceable === false || !target.span) continue;
      const fixed = fixOne(target.text, target);
      if (fixed.text === target.text) continue;
      // escapeOnWrite: 원문에 실제 이스케이프(\", \\ 등)가 있던 값만 다시 이스케이프한다.
      // 이스케이프가 없던 값(예: $BRANCH, `date` 를 그대로 쓴 메시지)은 손대지 않아야
      // $/백틱이 뜻하지 않게 이스케이프되어 셸 동작이 바뀌지 않는다.
      const writeText = target.quote === '"' && target.escapeOnWrite ? escapeDoubleQuoted(fixed.text) : fixed.text;
      edits.push({ start: target.span.start, end: target.span.end, writeText, applied: fixed.applied });
    }
    if (edits.length > 0) {
      edits.sort((a, b) => b.start - a.start); // 뒤에서부터 갈아 끼워야 앞선 자리의 위치가 안 어긋난다
      let command = String(updatedInput.command);
      for (const edit of edits) command = command.slice(0, edit.start) + edit.writeText + command.slice(edit.end);
      updatedInput.command = command;
      changed = true;
      for (const edit of edits) pushAll(applied, edit.applied);
    }
  } else {
    for (const target of targets) {
      if (target.autofixSafe === false) continue;
      const fixed = fixOne(target.text, target);
      if (fixed.text === target.text) continue;

      if (target.editIndex !== undefined) {
        updatedInput.edits = (updatedInput.edits || []).map((edit, index) =>
          index === target.editIndex ? { ...edit, new_string: fixed.text } : edit
        );
        changed = true;
      } else {
        updatedInput[target.field] = fixed.text;
        changed = true;
      }
      pushAll(applied, fixed.applied);
    }
  }

  if (!changed || applied.length === 0) return null;

  // permissionDecision 에 "allow" 를 실으면 Claude Code 가 사용자의 권한 프롬프트를
  // 건너뛴다("Hook approved tool use ... bypassing permission prompt", 2.1.282 실측). 여기서
  // 결정할 일은 자동 교정뿐이지 실행 승인이 아니므로 결정 없이 updatedInput 만 돌려주고,
  // 뒤이어 정상 권한 파이프라인이 이 rewritten input 을 보고 사용자에게 물어보게 둔다.
  //
  // systemMessage 는 사용자에게만 보이고 모델에게는 전달되지 않는다. 모델이 무엇이 바뀌었는지
  // 모르면 나중에 커밋/저장된 내용을 잘못 보고하거나 되돌려 버릴 수 있어, 모델에게 닿는
  // hookSpecificOutput.additionalContext 에도 같은 내용을 싣는다.
  return {
    systemMessage: describeFixes(applied),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput,
      additionalContext: [
        "kimchi-claude 가 KIMCHI_AUTOFIX 설정에 따라 이 도구를 실행하기 전에 입력을 고쳤습니다.",
        "실제로 실행되거나 저장되는 내용은 아래처럼 바뀐 것입니다. 이 교정을 되돌리지 말고, 사용자에게도 이렇게 바뀌었다고 알려 주십시오.",
        formatFixList(applied),
      ].join("\n"),
    },
  };
}

export function warnAboutTone(targets, rules) {
  const findings = targets.flatMap((target) =>
    lint(target.text, rules, target).map((finding) => ({ ...finding, label: target.label }))
  );
  const particles = targets.flatMap((target) => findParticleErrors(target.text, target));
  if (findings.length === 0 && particles.length === 0) return null;

  const label = targets[0]?.label || "";
  // command 필드는 Bash 의 커밋 메시지다. 커밋 메시지에는 kimchi-ignore 표시를 붙일
  // 수단이 없으므로(파일이 아니다) 이 안내는 문서 대상일 때만 낸다.
  const isDocTarget = targets.some((target) => target.field !== "command");
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: [
        findings.length > 0 ? formatFindings(findings, label) : "",
        particles.length > 0 ? formatParticleErrors(particles) : "",
        "",
        "저장소에 남는 글이므로 위 표현을 고쳐 주십시오. 코드와 식별자는 그대로 두십시오.",
        isDocTarget
          ? "사용자가 일부러 쓴 표현을 인용해야 한다면 그 줄에 `<!-- kimchi-ignore -->`를, 여러 줄이면 " +
            "`<!-- kimchi-ignore-start -->`…`<!-- kimchi-ignore-end -->`로 감싸 두십시오(파일 전체를 빼는 표시는 쓰지 마십시오)."
          : "",
      ].join("\n"),
    },
  };
}

export const autofixEnabled = () => process.env.KIMCHI_AUTOFIX === "1";
export const blockEnabled = () => process.env.KIMCHI_BLOCK === "1";

/**
 * 규칙을 읽는다. 값싼 걸러내기를 통과한 뒤에만 부른다.
 *
 * rules/*.md 표(rules)에 builtins(latin-hada.mjs의 LATIN_HADA_RULE처럼 표로 옮길 수
 * 없는 검사, rules.mjs의 loadRules() 참고)를 이어 붙여 돌려준다 — 훅은 "실제로 검사하는
 * 전체 규칙"이 필요하다. 스타일 본문·README 규칙 수·코퍼스 표 시험은 이 함수를 쓰지
 * 않고 loadRules().rules만 직접 쓴다.
 */
export function loadToneRules() {
  const { rules, builtins } = loadRules(join(PLUGIN_ROOT, "rules"));
  return [...rules, ...builtins];
}

export { extractCommitMessages, extractTargets };
