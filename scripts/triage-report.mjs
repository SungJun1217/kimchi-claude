#!/usr/bin/env node
// 오탐/놓친 표현 이슈(.github/ISSUE_TEMPLATE/false-positive.yml, missed-expression.yml)를
// 현재 규칙(main, 즉 최신 릴리스 기준 — 워크플로가 기본 브랜치를 체크아웃한다)으로
// 재현해 보고, 결과 JSON과 이슈 코멘트 마크다운을 만든다.
//
// action-lint.mjs와 같은 원칙이다 — 네트워크를 열지 않는다(불변식 10). 이슈 본문은
// 워크플로가 GITHUB_EVENT_PATH에서 미리 파일로 읽어 둔 것을 넘겨받고, 결과를 코멘트로
// 올리거나 라벨을 바꾸는 것은 이 스크립트의 일이 아니다 — .github/workflows/triage.yml의
// gh 셸 단계가 한다.
//
// 판정 로직은 새로 만들지 않는다. scripts/action-lint.mjs의 findingsForTarget/
// findingsForText를 그대로 불러 커밋 메시지·문서 파일과 같은 경로로 재현한다(문서
// 대상 하나를 검사하는 것이 이 스크립트가 하는 일의 전부다). 대화 답변(스타일)은 애초에
// 린트 대상이 아니므로(hooks/lib/lint.mjs가 보는 것은 커밋 메시지와 문서 파일뿐이다)
// 린트 결과를 절대 주장하지 않고, 규칙표에 짝이 되는 프롬프트 규칙이 있는지만 본다.
//
// 사용법:
//   node triage-report.mjs --body <이슈 본문 텍스트 파일> --template false-positive|missed-expression
//     [--repo <owner/name>] [--ref <태그, 기본 v<version>>] [--version <x.y.z>]
//     [--out <결과 JSON 경로>] [--comment-out <코멘트 마크다운 경로>]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findingsForTarget, findingsForText } from "./action-lint.mjs";
import { mdCode } from "./build-review.mjs";
import { loadToneRules } from "../hooks/lib/artifact.mjs";
import { CHECK_PROMPT } from "../hooks/lib/rules.mjs";
import { toPattern } from "../hooks/lib/lint.mjs";
import { looksKorean } from "../hooks/lib/detect.mjs";
import { findResidentNumbers, redactText } from "../hooks/lib/pii.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const MARKER = "<!-- kimchi-claude-triage -->";

const WHERE_STYLE = "대화 답변(스타일)";
const WHERE_COMMIT = "커밋 메시지";

// 이슈 본문은 사람이 웹 폼으로 채우지만 API로 임의 길이 텍스트를 보낼 수도 있다.
// 한도 없이 다 읽으면 아래 분해·정규식 단계가 그 길이에 비례해 오래 걸린다 — 재현에
// 필요한 것은 각 필드의 짧은 문장 하나뿐이라 잘라내도 잃는 것이 없다.
const MAX_BODY_CHARS = 65_536;

/**
 * GitHub 이슈 폼 본문("### 라벨\n\n값", render: text 항목은 ```text 펜스로 감싸 온다)을
 * 라벨 → 값 맵으로 바꾼다. 펜스가 있든 없든, 항목이 아예 빠졌든 다 견딘다. 본문이
 * MAX_BODY_CHARS를 넘으면 앞부분만 본다(신뢰할 수 없는 입력의 크기를 제한한다).
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function parseIssueForm(body) {
  const form = {};
  if (typeof body !== "string") return form;
  const capped = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
  // "### 라벨" 줄을 가른다. 예전 형태(/^### (.+?)\s*$/m)는 지연(lazy) ".+?" 뒤에
  // "\s*$"가 붙어, 제목 줄에 공백이 아주 길게 이어지면(수만 자) 그 경계를 찾느라
  // 되짚기(backtracking)가 늘어 이차 시간이 든다(실측 — 신뢰할 수 없는 이슈 본문이
  // 이 모양을 그대로 만들 수 있다). "[^\n]*\S" + "[ \t]*$"는 같은 결과(앞뒤 공백을
  // 뗀 라벨)를 선형 시간에 낸다 — 탐욕적 문자 클래스는 마지막이 공백이 아닌 지점까지만
  // 한 번에 물러난다.
  const parts = capped.split(/^### ([^\n]*\S)[ \t]*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const label = parts[i].trim();
    let value = (parts[i + 1] || "").trim();
    // render: text 항목은 GitHub이 제출 시 ```<lang>\n...\n``` 로 감싼다. 펜스 길이가
    // 항상 3이라는 보장은 없다고 보고(사용자가 옮겨 붙인 텍스트에 백틱이 섞였을 수
    // 있다) 3개 이상을 넓게 받는다.
    const fenced = value.match(/^(`{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/);
    if (fenced) value = fenced[2].trim();
    if (value === "_No response_") value = "";
    form[label] = value;
  }
  return form;
}

/** 이슈 폼에서 재현에 필요한 필드만 뽑는다. 템플릿마다 라벨이 다르다. */
export function extractFields(form, template) {
  if (template === "missed-expression") {
    return {
      sentence: form["어색한 문장"] || "",
      where: form["어디서"] || "",
      fix: form["고친다면"] || "",
      basis: form["근거"] || "",
    };
  }
  return {
    sentence: form["걸린 문장"] || "",
    where: form["어디서"] || "",
    message: form["경고·교정 메시지"] || "",
    reason: form["왜 틀렸다고 보나"] || "",
  };
}

/**
 * 프롬프트 전용 규칙(치환·정규식으로 못 잡는 규칙) 중 이 문장에 걸리는 것을 찾는다.
 * lint()는 이런 규칙을 애초에 검사하지 않으므로(SCANNABLE_CHECKS 밖) 여기서 직접
 * toPattern으로 시험한다 — "규칙표에 짝이 있는가"를 보는 것이지 린트 결과가 아니다.
 * @param {string} text
 * @param {object[]} rules
 * @returns {object[]}
 */
export function promptRuleMatches(text, rules) {
  if (typeof text !== "string" || text.length === 0) return [];
  return rules.filter((rule) => {
    if (rule.check !== CHECK_PROMPT) return false;
    const pattern = toPattern(rule.bad);
    if (!pattern) return false;
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/**
 * 신고된 문장을 "어디서"에 맞는 경로로 재현한다.
 *
 * - 커밋 메시지 → findingsForText(줄·칸이 없다).
 * - 문서 파일 / 기타 → findingsForTarget(문서로 본다. "기타"도 대개 산문이라 문서
 *   기준이 가장 가깝다 — notes에 그 사실을 남긴다).
 * - 대화 답변(스타일) → 린트 대상이 아니다. 프롬프트 규칙 매치만 본다.
 *
 * @param {string} text
 * @param {string} where
 * @param {object[]} rules
 * @returns {{mode: "lint"|"style"|"none", findings: object[], promptHits: object[], notes: string[]}}
 */
export function reproduce(text, where, rules) {
  const notes = [];
  if (!text) return { mode: "none", findings: [], promptHits: [], notes };

  if (where === WHERE_STYLE) {
    return { mode: "style", findings: [], promptHits: promptRuleMatches(text, rules), notes };
  }

  if (where === WHERE_COMMIT) {
    return { mode: "lint", findings: findingsForText(text, rules), promptHits: [], notes };
  }

  if (where !== "문서 파일") {
    notes.push('어디서가 "기타"라 문서 파일 기준으로 재현했습니다.');
  }
  if (!looksKorean(text)) return { mode: "lint", findings: [], promptHits: [], notes };
  return { mode: "lint", findings: findingsForTarget({ text, ext: "md" }, rules), promptHits: [], notes };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 규칙표 원본 파일에서 이 규칙이 적힌 줄 번호를 찾는다. import-corpus.mjs 이후로 규칙
 * 객체 자체는 줄 번호를 안 들고 있어서(rules.mjs 참고), 링크가 필요할 때만 여기서
 * 다시 찾는다. 못 찾으면(표 형식이 달라졌거나 파일이 없으면) null — 링크 없이 파일
 * 이름만 보여준다.
 * @param {{bad: string, source?: string}} rule
 * @param {string} rulesDir
 * @returns {{file: string, line: number}|null}
 */
export function ruleLocation(rule, rulesDir) {
  if (!rule.source) return null;
  try {
    const text = readFileSync(join(rulesDir, rule.source), "utf8");
    const needle = new RegExp(`\\|\\s*${escapeRegExp(rule.bad)}\\s*\\|`);
    const lines = text.split("\n");
    const index = lines.findIndex((line) => line.trimStart().startsWith("|") && needle.test(line));
    if (index === -1) return null;
    return { file: `rules/${rule.source}`, line: index + 1 };
  } catch {
    return null;
  }
}

/** @param {string} repo owner/name @param {string} ref 태그 @param {{file:string,line:number}} loc */
export function blobUrl(repo, ref, loc) {
  return `https://github.com/${repo}/blob/${ref}/${loc.file}#L${loc.line}`;
}

/**
 * findingsForTarget/findingsForText는 원본 규칙(rules.mjs가 파싱한 것) 자체가 아니라
 * 위반 하나하나(ruleKey·bad·good·check)만 낸다 — source(어느 rules/*.md 파일인지)가
 * 없다. 같은 (ruleKey, good, check) 조합으로 원본 규칙표에서 다시 찾는다 — 두 벌을
 * 따로 유지하지 않기 위해서다.
 * @param {{ruleKey: string, good: string, check: string}} finding
 * @param {object[]} rules
 * @returns {object|undefined}
 */
function ownerRuleOf(finding, rules) {
  return rules.find((r) => r.bad === finding.ruleKey && r.good === finding.good && r.check === finding.check);
}

/**
 * findingsForTarget/findingsForText가 낸 위반에 규칙 출처 링크를 붙인다.
 * @param {object[]} findings
 * @param {object[]} rules
 * @param {string} repo
 * @param {string} ref
 * @returns {object[]}
 */
export function attachRuleLocations(findings, rules, repo, ref) {
  const rulesDir = join(ROOT, "rules");
  return findings.map((finding) => {
    const owner = ownerRuleOf(finding, rules);
    const loc = owner ? ruleLocation(owner, rulesDir) : null;
    return {
      bad: finding.bad,
      good: finding.good,
      reason: finding.reason || finding.why || "",
      check: finding.check,
      source: owner?.source,
      line: loc?.line,
      url: loc && repo ? blobUrl(repo, ref, loc) : undefined,
    };
  });
}

// 코멘트가 유출 건수·인용 길이에 비례해 무한정 커지는 것을 막는다(공개 이슈 코멘트다 —
// build-review.mjs의 MAX_LISTED_FIXES·pii.mjs의 MAX_LISTED와 같은 원칙).
const MAX_QUOTE_CHARS = 2000;
const MAX_LISTED_FINDINGS = 20;

/** 인용문이 너무 길면 잘라내고 표시한다. */
function truncateForDisplay(text) {
  const s = String(text ?? "");
  return s.length > MAX_QUOTE_CHARS ? `${s.slice(0, MAX_QUOTE_CHARS)}…(생략)` : s;
}

/**
 * <input> 타입 폼 필드(예: "고친다면")는 웹 UI에서 한 줄만 받지만, API로는 방어적으로
 * 줄바꿈이 섞여 들어올 수 있다. mdCode(인라인 코드 스팬)에 줄바꿈이 있으면 스팬이
 * 그 자리에서 끊겨 뒤 텍스트가 코드 밖으로 흘러나온다 — 스팬에 넣기 전에 한 줄로 접고,
 * 길이도 잘라낸다.
 */
function inlineCode(text) {
  return mdCode(truncateForDisplay(String(text ?? "").replace(/\r\n|\r|\n/g, " ")));
}

function findingLine(finding) {
  const location = finding.url
    ? `[${finding.source}:${finding.line}](${finding.url})`
    : finding.source
      ? mdCode(finding.source)
      : "";
  const reason = finding.reason ? ` (${finding.reason})` : "";
  return `- ${inlineCode(finding.bad)} → ${mdCode(finding.good)}${reason} — ${location}`;
}

function ruleRefLine(rule, repo, ref) {
  const loc = ruleLocation(rule, join(ROOT, "rules"));
  const location = loc && repo ? `[${loc.file}:${loc.line}](${blobUrl(repo, ref, loc)})` : rule.source ? mdCode(rule.source) : "";
  return `- ${mdCode(rule.bad)} → ${mdCode(rule.good)}${rule.why ? ` (${rule.why})` : ""} — ${location}`;
}

/** items를 formatter로 줄마다 바꾸되, MAX_LISTED_FINDINGS를 넘으면 나머지는 건수로만 말한다. */
function cappedLines(items, formatter) {
  const listed = items.slice(0, MAX_LISTED_FINDINGS);
  const rest = items.length - listed.length;
  const out = listed.map(formatter);
  if (rest > 0) out.push(`- 외 ${rest}건 더`);
  return out;
}

/**
 * 여러 줄 사용자 텍스트를 안전하게 인용한다(백틱 개수를 내용보다 하나 더 길게 잡는다).
 * 펜스는 반드시 그 줄의 첫 글자여야 한다(커먼마크 규칙) — 호출부는 이 반환값을
 * 항상 별도 줄(앞에 레이블을 붙이려면 별개의 lines 항목으로)에 놓아야 한다. 같은 줄에
 * `레이블: ${mdBlock(text)}` 처럼 이어 붙이면 펜스가 줄 중간에서 시작해 마크다운
 * 펜스로 인식되지 않고, 사용자가 넣은 여러 줄 텍스트가 코드 블록 밖에서 그대로
 * 렌더링된다(@멘션·이미지·헤딩이 실제로 해석되는 보안 결함이었다 — 실측).
 */
function mdBlock(text) {
  const s = truncateForDisplay(text);
  const runs = s.match(/`+/g) || [];
  const maxRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(maxRun + 1, 3));
  return `${fence}\n${s}\n${fence}`;
}

/**
 * 결과 하나(reproduce 반환값 + 컨텍스트)를 사람이 읽는 합니다체 코멘트로 만든다.
 * @param {{template: string, version: string, sentence: string, quoted: string,
 *   piiRedacted: boolean, result: object, extra: object}} args
 * @returns {string}
 */
export function buildComment(args) {
  const { template, version, quoted, piiRedacted, result, repo, ref, rules } = args;
  const lines = [MARKER];

  if (piiRedacted) {
    lines.push(
      "**주민등록번호로 보이는 값을 가렸습니다.** 실제 값 대신 형식만 맞는 가상의 값(예: 900101-1234567)으로 " +
        "다시 적어 주시면 재현에 도움이 됩니다."
    );
  }

  // 레이블과 펜스 블록을 반드시 별개의 항목으로 push한다 — 펜스는 줄 맨 앞에서
  // 시작해야 코드 블록으로 인식된다(mdBlock 문서 참고).
  lines.push("인용한 문장:", mdBlock(quoted));

  if (result.mode === "none") {
    lines.push("문장이 비어 있어 재현하지 못했습니다. 이슈를 편집해 문장을 채워 주십시오.");
  } else if (result.mode === "style") {
    lines.push(
      "대화 답변(스타일)은 린트 대상이 아니라 `output-styles/natural-korean.md`(rules/*.md에서 생성됩니다)가 " +
        "다루는 영역입니다. 린트 결과로 재현 여부를 확정할 수 없습니다."
    );
    if (result.promptHits.length > 0) {
      lines.push(
        "규칙표에 짝이 되는 프롬프트 규칙이 있습니다.",
        ...cappedLines(result.promptHits, (r) => ruleRefLine(r, repo, ref))
      );
    } else {
      lines.push("규칙표에 짝이 되는 프롬프트 규칙을 찾지 못했습니다.");
    }
  } else if (template === "missed-expression") {
    const caught = attachRuleLocations(result.findings, rules, repo, ref);
    if (caught.length > 0) {
      lines.push(`**이미 잡습니다.** 현재 규칙(${version})에 다음 규칙이 있습니다.`, ...cappedLines(caught, findingLine));
    } else {
      lines.push(`**현재 규칙으로는 잡히지 않습니다.** 버전 ${version} 기준입니다.`);
      if (args.fix) {
        const fixResult = reproduce(args.fix, args.where, rules);
        const fixFindings = attachRuleLocations(fixResult.findings, rules, repo, ref);
        if (fixFindings.length === 0) {
          lines.push(`제안하신 표현 ${inlineCode(args.fix)}은(는) 현재 규칙을 그대로 통과합니다.`);
        } else {
          lines.push(
            `제안하신 표현 ${inlineCode(args.fix)}도 다음 규칙에 걸립니다.`,
            ...cappedLines(fixFindings, findingLine)
          );
        }
      }
    }
  } else {
    const found = attachRuleLocations(result.findings, rules, repo, ref);
    if (found.length > 0) {
      lines.push(`**재현됨**: 현재 규칙(${version})에서 이 문장에 다음 경고가 뜹니다.`, ...cappedLines(found, findingLine));
      lines.push("오탐이 맞다면 위 규칙 파일의 이유 칸을 검토해 PR로 조정해 주시면 반영이 빠릅니다.");
    } else {
      lines.push(`**재현 안 됨**: 버전 ${version}에서는 이 문장이 걸리지 않습니다(이미 고쳐졌을 수 있습니다).`);
    }
  }

  if (result.notes.length > 0) lines.push("", ...result.notes);

  return lines.join("\n\n");
}

/**
 * 라벨 add/remove를 정한다. style/none 모드는 린트로 재현 여부를 확정하지 못하므로
 * reproduced/not-reproduced 둘 다 뗀다 — 이전 편집에서 lint 모드로 붙은 라벨이 이번
 * 편집(예: "어디서"를 대화 답변(스타일)로 바꿈)에서도 그대로 남아 확정된 것처럼
 * 보이면 안 된다. needs-info도 이번 판정에 PII가 없으면 뗀다 — 신고자가 이슈를
 * 편집해 실제 번호를 지웠는데 라벨만 남아 있으면 안 된다.
 * @returns {{add: string[], remove: string[]}}
 */
export function decideLabels(template, result, piiRedacted) {
  const add = [];
  const remove = [];
  if (result.mode === "lint") {
    // false-positive: 아직도 걸리면(재현되면) 문제가 남아 있다.
    // missed-expression: 아직도 안 잡히면(못 찾으면) 여전히 놓치고 있다 → 재현.
    const reproduced = template === "missed-expression" ? result.findings.length === 0 : result.findings.length > 0;
    add.push(reproduced ? "reproduced" : "not-reproduced");
    remove.push(reproduced ? "not-reproduced" : "reproduced");
  } else {
    remove.push("reproduced", "not-reproduced");
  }
  if (piiRedacted) add.push("needs-info");
  else remove.push("needs-info");
  return { add, remove };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[token.slice(2)] = true;
    else {
      args[token.slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const template = String(args.template || "");
  if (template !== "false-positive" && template !== "missed-expression") {
    throw new Error(`--template은 false-positive 또는 missed-expression이어야 합니다: ${template}`);
  }

  const version = String(args.version || JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
  const ref = String(args.ref || `v${version}`);
  const repo = args.repo ? String(args.repo) : "";

  const body = args.body ? readFileSync(resolve(String(args.body)), "utf8") : "";
  const form = parseIssueForm(body);
  const fields = extractFields(form, template);
  const rules = loadToneRules();

  // 주민등록번호로 보이는 값은 재현에 쓰기 전에 가린다 — 훅이 어떤 문서에도 원문을
  // 다시 새어 나가게 하지 않는 것과 같은 원칙이다(pii.mjs). 가린 텍스트로는 어차피
  // 13자리가 안 남아 재현 결과가 달라지지 않는다(형식만 맞는 값이라 규칙표 매치와
  // 무관하다).
  //
  // ignoreAllowLine: true를 반드시 켠다. kimchi-allow-rrn 표시는 저장소 관리자가 자기
  // 문서에 형식만 맞는 예시를 남길 때 쓰라고 둔 opt-out이다 — 신뢰할 수 없는 이슈
  // 제출자가 신고 문장에 그 표시를 붙여 실제 번호를 검사망 밖으로 빼돌리고, 그 값이
  // 공개 봇 코멘트에 그대로 실리게 만드는 수단으로 쓰이면 안 된다(pii.mjs 참고).
  const piiOptions = { ignoreAllowLine: true };
  const piiHit =
    findResidentNumbers(fields.sentence, piiOptions).length > 0 ||
    (fields.fix && findResidentNumbers(fields.fix, piiOptions).length > 0);
  const safeSentence = redactText(fields.sentence, piiOptions);
  const safeFix = fields.fix ? redactText(fields.fix, piiOptions) : "";

  const result = reproduce(safeSentence, fields.where, rules);
  const comment = buildComment({
    template,
    version,
    quoted: safeSentence,
    piiRedacted: piiHit,
    result,
    repo,
    ref,
    fix: safeFix,
    where: fields.where,
    rules,
  });
  const labels = decideLabels(template, result, piiHit);

  const output = {
    reproduced:
      result.mode === "lint"
        ? template === "missed-expression"
          ? result.findings.length === 0
          : result.findings.length > 0
        : null,
    mode: result.mode,
    findings: attachRuleLocations(result.findings, rules, repo, ref),
    version,
    notes: result.notes,
    labels,
  };

  const json = JSON.stringify(output, null, 2);
  if (args.out) writeFileSync(resolve(String(args.out)), `${json}\n`);
  else console.log(json);

  if (args["comment-out"]) writeFileSync(resolve(String(args["comment-out"])), `${comment}\n`);
  else if (!args.out) console.log(comment);
}

function isEntrypoint() {
  try {
    return resolve(process.argv[1] || "") === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export { ROOT };
