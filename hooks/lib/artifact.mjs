// 저장소에 남는 산출물의 한국어를 검사한다. 커밋 메시지와 한국어 문서 파일이 대상이다.
//
// 진입점은 hooks/guard.mjs 다. 이 파일은 판정만 하고 훅 입출력은 다루지 않는다.
//
// 이 훅은 말투를 다듬는 부가 기능이고 작업에 필요한 부품이 아니다.
// 그래서 어떤 오류가 나도 조용히 아무 일도 하지 않고 종료 코드 0으로 끝낸다.
// 훅이 깨져서 작업이 막히면 그것이 더 큰 실패다.
//
import { readFileSync, statSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules } from "./rules.mjs";
import { lint, applyFixes, formatFindings } from "./lint.mjs";
import { findParticleErrors, fixParticles, formatParticleErrors } from "./particle.mjs";
import { looksKorean } from "./detect.mjs";
import { isIgnoredFile, maskProtected, MASK } from "./segment.mjs";
import { extractCommitTargets, escapeDoubleQuoted } from "./bash-commit.mjs";

const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 문서 파일만 본다. 소스 파일을 검사하면 코드 주석까지 건드리게 되고, 그것은 적용 범위 밖이다.
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"]);

/**
 * 파일이 스스로를 검사 예외로 선언했는지 디스크에서 확인한다.
 * 읽을 수 없으면(새 파일 등) 선언이 없는 것으로 본다.
 */
function declaresIgnore(filePath) {
  try {
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
    if (statSync(filePath).size > MAX_CONTEXT_FILE_BYTES) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
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

  const masked = maskProtected(fileText, ext);
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
 * @returns {"exempt"|"unknown"|"ok"}
 */
function classifyEditContext(filePath, oldString, newString, replaceAll) {
  if (!filePath) return "unknown";
  const fileText = readDocForContext(filePath);
  if (fileText === null) return "unknown";
  const ext = docExt(filePath);

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
  const ext = docExt(filePath);
  // 파일이 스스로를 예외로 선언했으면 조각만 넘어와도 존중한다.
  //
  // lint() 는 넘겨받은 글에서 표시를 찾으므로, Edit 처럼 조각만 오면 파일 수준 선언이
  // 보이지 않는다. 그래서 여기서 파일을 읽어 확인한다. 이 덕분에 사용자가 자기 문서에
  // 표시를 붙여 Edit 로 고칠 때도 동작한다.
  if (filePath && declaresIgnore(filePath)) return [];

  if (toolName === "Write" && typeof toolInput.content === "string") {
    return [{ label: filePath || "문서", text: toolInput.content, field: "content", ext }];
  }

  if (toolName === "Edit" && typeof toolInput.new_string === "string") {
    const ctx = classifyEditContext(filePath, toolInput.old_string, toolInput.new_string, toolInput.replace_all);
    if (ctx === "exempt") return [];
    return [
      {
        label: filePath || "문서",
        text: toolInput.new_string,
        field: "new_string",
        ext,
        autofixSafe: ctx !== "unknown",
      },
    ];
  }

  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map((edit, editIndex) => {
        if (typeof edit?.new_string !== "string") return null;
        const ctx = classifyEditContext(filePath, edit.old_string, edit.new_string, edit.replace_all);
        if (ctx === "exempt") return null;
        return {
          label: filePath || "문서",
          text: edit.new_string,
          field: "new_string",
          ext,
          editIndex,
          autofixSafe: ctx !== "unknown",
        };
      })
      .filter(Boolean);
  }

  return [];
}

function describeFixes(applied) {
  const lines = applied.map((item) => `- "${item.matched}" → "${item.replacement}"`);
  return [`한국어 표현 ${applied.length}건을 고쳤습니다.`, ...lines].join("\n");
}

export function autofixOrBlock(toolName, toolInput, targets, rules) {
  if (blockEnabled()) {
    // F8: 막을 때만 전체 위반 목록이 필요하다. 자동 교정 경로에서는 applyFixes 가
    // 안에서 다시 검사하므로 미리 훑으면 같은 일을 두 번 한다.
    const allFindings = targets.flatMap((target) => lint(target.text, rules, target.ext));
    if (allFindings.length === 0) return null;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: formatFindings(allFindings, targets[0]?.label || ""),
      },
    };
  }

  // 자동 교정. 원본을 그대로 유지한 채 필드별로 바꿔 넣는다.
  const updatedInput = { ...toolInput };
  const applied = [];
  let changed = false;

  /** 조사를 먼저 고치고, 그다음 용어를 고친다. 용어를 바꾸면 조사가 다시 틀어질 수 있어 한 번 더 돈다. */
  function fixOne(text, ext) {
    const withParticles = fixParticles(text);
    const result = applyFixes(withParticles.text, rules, ext);
    const fixedText = fixParticles(result.text).text;
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
      const fixed = fixOne(target.text, target.ext);
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
      for (const edit of edits) applied.push(...edit.applied);
    }
  } else {
    for (const target of targets) {
      if (target.autofixSafe === false) continue;
      const fixed = fixOne(target.text, target.ext);
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
      applied.push(...fixed.applied);
    }
  }

  if (!changed || applied.length === 0) return null;

  return {
    systemMessage: describeFixes(applied),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };
}

export function warnAboutTone(targets, rules) {
  const findings = targets.flatMap((target) =>
    lint(target.text, rules, target.ext).map((finding) => ({ ...finding, label: target.label }))
  );
  const particles = targets.flatMap((target) => findParticleErrors(target.text));
  if (findings.length === 0 && particles.length === 0) return null;

  const label = targets[0]?.label || "";
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: [
        findings.length > 0 ? formatFindings(findings, label) : "",
        particles.length > 0 ? formatParticleErrors(particles) : "",
        "",
        "저장소에 남는 글이므로 위 표현을 고쳐 주십시오. 코드와 식별자는 그대로 두십시오.",
      ].join("\n"),
    },
  };
}

export const autofixEnabled = () => process.env.KIMCHI_AUTOFIX === "1";
export const blockEnabled = () => process.env.KIMCHI_BLOCK === "1";

/** 규칙을 읽는다. 값싼 걸러내기를 통과한 뒤에만 부른다. */
export function loadToneRules() {
  return loadRules(join(PLUGIN_ROOT, "rules")).rules;
}

export { extractCommitMessages, extractTargets };
