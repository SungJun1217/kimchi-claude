#!/usr/bin/env node
// GitHub Action(action.yml)의 오프라인 계산 부분이다. 변경된 문서 파일, 커밋 메시지,
// PR 제목·본문을 로컬 파일에서 읽어 훅과 같은 규칙으로 검사하고 JSON 결과만 낸다.
//
// 네트워크를 절대 열지 않는다(불변식 10). PR 파일 목록을 모으고, 결과를 리뷰나 코멘트로
// 올리는 것은 이 스크립트의 일이 아니다 — action.yml 의 셸 단계가 `gh` CLI 로 한다.
// 이 파일은 로컬 파일만 읽고 표준 출력(또는 --out 파일)에 JSON 만 쓴다.
//
// 판정 로직은 새로 만들지 않는다. hooks/lib/artifact.mjs 의 extractTargets 를 Write
// 도구 호출인 것처럼 그대로 불러 쓴다 — 문서 확장자 제한, 검사 예외 파일 이름, 파일
// 자신의 kimchi-ignore-file 선언, 참조식 링크 라벨 수집까지 훅과 완전히 같은 판정을
// 거치게 하려는 것이다. 두 번째 구현을 두면 반드시 어긋난다.
//
// 사용법:
//   node action-lint.mjs --files <변경 파일 목록.txt> [--patterns "**/*.md,**/*.txt"]
//     [--commits <커밋 메시지 JSON 배열>] [--pr-text <{title,body} JSON>]
//     [--repo-root <디렉터리>] [--head-sha <커밋>] [--mode annotations|comment]
//     [--out <결과 JSON 경로>]
//
// --files 에 적는 파일은 한 줄에 하나씩, 저장소 루트 기준 상대 경로다. --head-sha 를
// 주면 그 커밋의 스냅숏을(`git show <sha>:<path>`) 읽는다 — PR 이벤트의 기본 체크아웃은
// merge 커밋이라, 작업 트리를 그냥 읽으면 base 브랜치가 그새 바뀐 줄이 섞여 들어와
// 실제 PR 헤드와 다른 줄 번호를 보고할 수 있다(실측 버그). --head-sha 없이는 작업
// 트리를 그대로 읽는다(로컬 시험용).
//
// PR diff 자체(어느 줄이 추가/삭제됐는지)는 여기서 다루지 않는다 — 리뷰 코멘트를
// diff 위치에 올릴 수 있는지는 scripts/build-review.mjs 가 patch hunk 로 따로 가른다.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractTargets, loadToneRules } from "../hooks/lib/artifact.mjs";
import { lint, applyFixes } from "../hooks/lib/lint.mjs";
import { CHECK_SUBSTITUTE } from "../hooks/lib/rules.mjs";
import { looksKorean } from "../hooks/lib/detect.mjs";
import { findResidentNumbers, redact, redactText } from "../hooks/lib/pii.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 액션 입력의 기본값과 그대로 맞춘다(action.yml 의 paths 입력).
export const DEFAULT_PATTERNS = "**/*.md,**/*.mdx,**/*.txt,**/*.rst,**/*.adoc";

/**
 * 아주 단순한 glob → 정규식 변환이다. `**`(경로 구분자까지 아무거나)와 `*`(구분자 제외
 * 아무거나)만 지원한다 — 실제 문서 확장자를 어떤 언어의 glob 엔진 없이 골라내는 데는
 * 이 정도로 충분하고, 의존성을 늘리지 않는다(불변식 10). `paths` 입력이 더 정교한 규칙을
 * 요구하면 이 함수를 넓히기보다 실제 glob 라이브러리를 들이는 편이 맞다.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegExp(pattern) {
  const escapeLiteral = (ch) => ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    // "**/" 는 "디렉터리 몇 겹이든(0겹 포함)"이다. 0겹을 허용해야 "**/*.md" 가 저장소
    // 루트 바로 아래 "a.md" 에도 걸린다 — 뒤에 남는 "/" 를 문자 그대로 요구하면 안 된다.
    if (pattern.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (pattern.startsWith("**", i)) {
      source += ".*";
      i += 2;
      continue;
    }
    if (pattern[i] === "*") {
      source += "[^/]*";
      i += 1;
      continue;
    }
    source += escapeLiteral(pattern[i]);
    i += 1;
  }
  return new RegExp(`^${source}$`);
}

/** @param {string} filePath @param {string[]} patterns */
export function matchesAnyPattern(filePath, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(filePath));
}

function readLines(path) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readJson(path, fallback) {
  if (!path) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * 커밋 스냅숏에서 파일 내용을 읽는다. `headSha`가 있으면 작업 트리가 아니라
 * `git show <sha>:<path>`로 그 커밋 시점의 내용을 읽는다 — PR 이벤트의 기본 체크아웃은
 * base 를 끌어와 만든 merge 커밋이라, 작업 트리를 그냥 읽으면 실제 PR 헤드에는 없는
 * base 쪽 변경이 섞여 줄 번호가 어긋날 수 있다. 커밋을 못 찾으면(얕은 클론에 없음 등)
 * null 을 돌려준다 — action.yml 이 미리 `git fetch`로 확보해 둬야 한다.
 *
 * @param {string} repoRoot
 * @param {string} relPath
 * @param {string|undefined} headSha
 * @returns {string|null}
 */
function readFileAt(repoRoot, relPath, headSha) {
  if (!headSha) {
    try {
      return readFileSync(join(repoRoot, relPath), "utf8");
    } catch {
      return null;
    }
  }
  try {
    return execFileSync("git", ["show", `${headSha}:${relPath}`], { cwd: repoRoot, encoding: "utf8" });
  } catch {
    return null; // 삭제된 파일, 혹은 그 커밋을 로컬에 못 찾은 경우
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/** index 이하인 가장 마지막 줄 시작 위치를 찾는다(이분 탐색). lineStarts 는 오름차순이다. */
function lineIndexOf(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 문서 대상 하나(Write 도구 호출로 흉내 낸 파일 전체)의 위반을 줄·칸 위치가 붙은
 * 결과로 바꾼다.
 *
 * `bad`는 실제로 걸린 텍스트(matched), `ruleKey`는 규칙표의 원본 `쓰지 말 것` 패턴이다
 * — 같은 문구를 여러 규칙이 서로 다른 이유로 잡을 수 있어, 지문(fingerprint)에는 어느
 * 쪽이 잡았는지까지 실어야 재실행마다 같은 지적을 같은 것으로 알아본다.
 * `lineText`는 그 줄의 원문 그대로다(고치기 전) — build-review.mjs 가 여러 지적을 한
 * 줄에 함께 적용한 제안을 만들 때와, 지문을 계산할 때 쓴다. `replacement`는 치환
 * 규칙이 실제로 안전하게 만들어낸 대체 문자열만이다(줄 전체가 아니다) — 한 줄에 고칠
 * 곳이 여럿이면 build-review.mjs 가 뒤에서부터 순서대로 꽂아 합친다.
 *
 * @param {{text: string, ext?: string, refDefs?: Set<string>|null}} target
 * @param {object[]} rules
 * @returns {object[]}
 */
export function findingsForTarget(target, rules) {
  // lint()/applyFixes() 는 NFC 로 정규화한 사본에서 위치를 센다(lint.mjs 참고).
  // 원문이 NFC 가 아니면(드묾 — 대개 macOS 로 만든 파일) 줄·칸이 조금 어긋날 수 있다.
  // applyFixes 자신도 같은 이유로 NFD 입력에는 자동 교정을 걸지 않는다.
  const normalized = target.text.normalize("NFC");
  const findings = lint(normalized, rules, target.ext, target.refDefs ?? null);
  const { applied } = applyFixes(normalized, rules, target.ext, target.refDefs ?? null);
  const appliedByIndex = new Map(applied.map((hit) => [hit.index, hit]));

  const lines = normalized.split("\n");
  const lineStarts = [0];
  for (const line of lines) lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1);

  return findings.map((finding) => {
    const lineIndex = lineIndexOf(lineStarts, finding.index);
    const line = lineIndex + 1;
    const column = finding.index - lineStarts[lineIndex] + 1;
    const appliedHit = finding.check === CHECK_SUBSTITUTE ? appliedByIndex.get(finding.index) : undefined;
    const fixable = Boolean(appliedHit);
    // 줄 원문에 주민등록번호로 보이는 값이 있으면 그 값을 지운 사본만 내보낸다 — 이
    // JSON 은 디스크에 남고 나중에 리뷰 코멘트로도 옮겨질 수 있어, 훅의 pii.mjs 와
    // 같은 원칙(원문을 절대 그대로 되읊지 않는다)을 여기서도 지켜야 한다. 원문과
    // 다르면(가려졌으면) lineHasPii 를 켜서, build-review.mjs 가 이 줄에는 제안
    // 코멘트(suggestion)를 아예 만들지 않게 한다 — 가려진 뒤 문자열로 다시 검사하면
    // 이미 안전해 보여 이 표시가 무의미해지므로, 가리기 전/후를 직접 비교해서 정한다.
    const rawLine = lines[lineIndex];
    const safeLine = redactText(rawLine);
    const result = {
      line,
      column,
      bad: finding.matched,
      good: finding.good,
      reason: finding.why || "",
      check: finding.check,
      ruleKey: finding.bad,
      lineText: safeLine,
      lineHasPii: safeLine !== rawLine,
      fixable,
    };
    if (fixable) result.replacement = appliedHit.replacement;
    return result;
  });
}

/**
 * 파일도 줄도 없는 대상(커밋 메시지, PR 제목·본문)의 위반을 뽑는다. 저장소 diff 위치가
 * 없으므로 줄 코멘트를 달 수 없다 — 리뷰 본문에 문자열로만 적는다(action.yml 쪽 책임).
 * @param {string} text
 * @param {object[]} rules
 * @returns {object[]}
 */
export function findingsForText(text, rules) {
  if (!looksKorean(text)) return [];
  const normalized = text.normalize("NFC");
  const findings = lint(normalized, rules, undefined, null);
  const { applied } = applyFixes(normalized, rules, undefined, null);
  const appliedByIndex = new Map(applied.map((hit) => [hit.index, hit]));
  return findings.map((finding) => ({
    bad: finding.matched,
    good: finding.good,
    reason: finding.why || "",
    check: finding.check,
    ruleKey: finding.bad,
    fixable: finding.check === CHECK_SUBSTITUTE && appliedByIndex.has(finding.index),
  }));
}

function piiHits(text, label, extra = {}, options = {}) {
  return findResidentNumbers(text, options).map((hit) => ({
    ...extra,
    line: hit.line,
    column: hit.column,
    masked: redact(hit.matched),
    label,
  }));
}

/**
 * 경로 문자열에 주민등록번호로 보이는 값이 섞여 있으면 가린 사본을 돌려준다. 파일
 * 이름 자체가 유출 경로가 될 수 있어(예: `900101-1234567.md`), JSON·주석·리뷰 어디에
 * 실을 "file" 값은 이 함수를 반드시 거친다 — 실제 디스크 읽기·git show 에는 원래
 * 경로를 그대로 쓴다(가린 값으로는 파일을 찾을 수 없다).
 *
 * 훅의 pii.mjs 는 경로를 검사할 때 일부러 좁은 규칙(`pathOnly`, 대시 구분자만)만
 * 쓴다 — 파일명 관례(날짜+일련번호를 붙여 쓴 리포트 파일 등)에서 나는 오탐을 줄이기
 * 위해서다. 여기서는 그 좁은 규칙을 쓰지 않는다 — 이 값은 표시(annotations·sticky
 * 코멘트·JSON)로 나가는 문구라서, "걸렸는데 안 가려짐"이 "안 걸림"보다 훨씬 나쁘다.
 * 그래서 감지(findResidentNumbers, 아래 main())와 가리기를 똑같이 기본 규칙(대시·공백·
 * 구분자 없는 형태까지)으로 맞춘다 — 둘이 다른 규칙을 쓰면 감지는 했는데 가리지는
 * 못하는 이 함수 자체의 목적이 깨진다. 그 대가로 몇몇 파일명 관례(예:
 * `reports/2501011234567.csv`)가 지나치게 가려질 수 있지만, 표시용 값 하나가 과하게
 * 가려지는 것이 주민등록번호를 그대로 보여주는 것보다 훨씬 싸다.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function safeDisplayPath(filePath) {
  return redactText(filePath);
}

// GitHub 워크플로 명령(`::warning file=...`)의 속성 값은 이 다섯 문자를 퍼센트 인코딩
// 해야 한다(GitHub 문서). 인코딩하지 않으면 파일 이름에 든 콤마·콜론이 다음 속성과
// 경계를 깨거나, 줄바꿈이 명령 자체를 두 줄로 쪼갠다.
function escapeWorkflowProperty(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

function escapeWorkflowMessage(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args["repo-root"] ? resolve(String(args["repo-root"])) : process.cwd();
  const headSha = typeof args["head-sha"] === "string" ? args["head-sha"] : undefined;
  const patterns = String(args.patterns || DEFAULT_PATTERNS)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const rules = loadToneRules();

  const changedFiles = args.files ? readLines(resolve(String(args.files))) : [];
  const targetFiles = changedFiles.filter((f) => matchesAnyPattern(f, patterns));

  const files = [];
  const pii = [];

  for (const relPath of targetFiles) {
    const content = readFileAt(repoRoot, relPath, headSha);
    if (content === null) continue; // 삭제된 파일, 혹은 그 커밋을 로컬에서 못 찾음

    const safePath = safeDisplayPath(relPath);
    // 경로 자체에 주민등록번호로 보이는 값이 있었는지. build-review.mjs 가 이 표시를
    // 보고 그런 파일은 인라인 코멘트를 아예 만들지 않는다(요구사항 4) — 리뷰 코멘트의
    // path 값은 PR의 실제 파일 경로와 정확히 같아야 하고(다르면 GitHub API가 리뷰
    // 전체를 422로 거부한다), 그렇다고 가려지지 않은 실제 경로를 그 자리에 쓰면 이
    // 함수가 막으려던 유출이 리뷰 코멘트를 통해 그대로 일어난다. 그런 파일의 지적은
    // sticky 요약 코멘트에 가려진 이름으로만 올라간다.
    const pathHasPii = safePath !== relPath;

    // 주민등록번호 검사는 hooks/lib/pii.mjs 와 같은 규칙으로, 문서 확장자와 무관하게
    // 모든 대상에 돈다(불변식 2) — 경로 자체와 내용을 둘 다 본다. "file" 값은 항상
    // safePath(가려진 경로)를 쓴다 — 경로 자체에 번호가 있으면 그 경로를 여는 순간
    // 원문이 그대로 새 나간다.
    pii.push(...piiHits(relPath, safePath, { file: safePath, kind: "path" }));
    pii.push(...piiHits(content, safePath, { file: safePath, kind: "content" }));

    // extractTargets 를 Write 호출인 것처럼 그대로 불러, 훅과 같은 판정(문서 확장자,
    // 예외 파일 이름, kimchi-ignore-file, 참조식 링크 라벨)을 거친다. file_path 는
    // 실제 파일 시스템 경로가 아니어도 되는 자리(확장자 판정·라벨용)라 원래 경로를 준다.
    const targets = extractTargets("Write", { file_path: join(repoRoot, relPath), content }).filter((t) =>
      looksKorean(t.text)
    );
    for (const target of targets) {
      for (const finding of findingsForTarget(target, rules)) {
        // pathHasPii 가 거짓이면 safePath === relPath 라서 file 값 자체가 이미 실제
        // 경로다 — build-review.mjs 는 그 경우에만 file 을 그대로 PR files API·diff
        // patch 조회에 쓴다. 참(가려짐)이면 실제 경로를 어디에도 담지 않는다 — 이
        // JSON 자체가 디스크에 남고 나중에 로그로도 보일 수 있어서, "가려야 할 값을
        // 되살릴 수 있는 필드"를 아예 만들지 않는 것이 가장 안전하다.
        files.push({ file: safePath, pathHasPii, ...finding });
      }
    }
  }

  // 커밋 메시지·PR 제목·본문은 fork PR 기여자가 그대로 쓰는 자유 텍스트다 —
  // kimchi-allow-rrn 표시로 검사를 피해 실제 번호를 흘려보내는 수단으로 못 쓰게
  // ignoreAllowLine을 켠다(triage-report.mjs와 같은 이유, hooks/lib/pii.mjs 참고).
  // 파일 경로·내용(위 328~329행)은 그대로 둔다 — 이 저장소 자신의 문서·규칙표가
  // 형식만 맞는 예시에 그 표시를 정당하게 쓰는 관례라, 여기까지 끄면 저장소 스스로의
  // PR에서 오탐이 늘어난다.
  const untrustedTextPii = { ignoreAllowLine: true };

  const commits = readJson(args.commits ? resolve(String(args.commits)) : null, []);
  const commitFindings = (Array.isArray(commits) ? commits : []).flatMap((message, index) => {
    if (typeof message !== "string") return [];
    pii.push(...piiHits(message, `커밋 ${index + 1}`, { commitIndex: index }, untrustedTextPii));
    return findingsForText(message, rules).map((finding) => ({ commitIndex: index, ...finding }));
  });

  const prText = readJson(args["pr-text"] ? resolve(String(args["pr-text"])) : null, null);
  const prTextFindings = { title: [], body: [] };
  if (prText && typeof prText === "object") {
    if (typeof prText.title === "string") {
      pii.push(...piiHits(prText.title, "PR 제목", { field: "title" }, untrustedTextPii));
      prTextFindings.title = findingsForText(prText.title, rules);
    }
    if (typeof prText.body === "string") {
      pii.push(...piiHits(prText.body, "PR 본문", { field: "body" }, untrustedTextPii));
      prTextFindings.body = findingsForText(prText.body, rules);
    }
  }

  const output = { files, commits: commitFindings, prText: prTextFindings, pii };

  if (args.mode === "annotations") {
    for (const finding of files) {
      const message = `"${finding.bad}" → "${finding.good}"${finding.reason ? ` (${finding.reason})` : ""}`;
      const file = escapeWorkflowProperty(finding.file);
      const line = escapeWorkflowProperty(finding.line);
      const col = escapeWorkflowProperty(finding.column);
      console.log(`::warning file=${file},line=${line},col=${col}::${escapeWorkflowMessage(message)}`);
    }
    for (const hit of pii) {
      const loc = hit.file ? `file=${escapeWorkflowProperty(hit.file)}${hit.line ? `,line=${escapeWorkflowProperty(hit.line)},col=${escapeWorkflowProperty(hit.column)}` : ""}` : "";
      const message = `주민등록번호로 보이는 값이 있습니다(${hit.label}): ${hit.masked}`;
      console.log(`::error ${loc}::${escapeWorkflowMessage(message)}`);
    }
  }

  const json = JSON.stringify(output, null, 2);
  if (args.out) writeFileSync(resolve(String(args.out)), `${json}\n`);
  else console.log(json);

  const failOnFindings = args["fail-on-findings"] === "true" || args["fail-on-findings"] === "1";
  const totalFindings =
    files.length + commitFindings.length + prTextFindings.title.length + prTextFindings.body.length + pii.length;
  if (failOnFindings && totalFindings > 0) {
    process.exitCode = 1;
  }
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
    // 이 스크립트는 사람이 읽는 CI 로그를 향한 것이라, 훅과 달리 실패를 숨기지 않는다 —
    // 여기서 조용히 넘어가면 액션이 "검사를 안 했는데 통과했다"는 잘못된 신호를 준다.
    console.error(err);
    process.exitCode = 1;
  });
}

export { ROOT };
