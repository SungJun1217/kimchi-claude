#!/usr/bin/env node
// action-lint.mjs 가 낸 JSON 결과를 GitHub PR 리뷰 페이로드로 바꾼다. 재실행할 때마다
// 리뷰를 새로 쌓지 않도록, 이미 올라간 지적과 이번에 찾은 지적을 지문(fingerprint)으로
// 비교해 "새로 올릴 것"과 "더는 없어져서 스레드를 접어도 되는 것"을 가른다.
//
// 이 스크립트도 네트워크를 열지 않는다(불변식 10) — 로컬 JSON 파일만 읽고 로컬 JSON
// 파일만 쓴다. 실제로 `gh api`(REST·GraphQL)를 불러 리뷰를 올리고 스레드를 접는 것은
// action.yml 의 셸 단계다.
//
// 인라인 코멘트는 PR diff 에 실제로 보이는 줄에만 달 수 있다(GitHub 리뷰 API 제약).
// `gh api repos/{repo}/pulls/{number}/files`가 주는 patch(unified diff hunk)에서
// 오른쪽(새 파일) 줄 번호 집합을 뽑아, 그 집합에 없는 자리의 지적은 코멘트 대신
// sticky 요약 코멘트 쪽 "diff 밖" 목록으로 접는다 — 못 단 지적을 조용히 버리지 않는다.
//
// 재실행 설계(소유자 승인):
//   - 인라인 코멘트마다 지문 마커(`<!-- kimchi-claude-lint:v1 fp=<sha1> -->`)를 심는다.
//     같은 지문이 이미 달려 있으면 다시 올리지 않는다(planReviewActions).
//   - 지문이 사라진(그 자리가 고쳐진) 기존 kimchi 스레드는 GraphQL
//     `resolveReviewThread`로 접는다 — 지우지 않아 이력이 남는다.
//   - 새 리뷰를 올릴 때 이전 kimchi 리뷰는 GraphQL `minimizeComment`로 접는다
//     (PullRequestReview 는 Minimizable 이다). 리뷰 본문은 짧게, 자세한 목록은
//     한 개짜리 sticky 이슈 코멘트에 둔다.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { findResidentNumbers } from "../hooks/lib/pii.mjs";

// 지문 마커는 인라인 코멘트마다(지적 하나당 하나) 붙는다 — "이 지적이 이미 올라가
// 있는가"를 판정하는 열쇠다. 리뷰 마커·sticky 마커는 지문이 없다 — "이 리뷰/코멘트가
// kimchi 것인가"만 구분하면 된다.
const FP_MARKER_RE = /<!-- kimchi-claude-lint:v1 fp=([0-9a-f]{40}) -->/g;
export const REVIEW_MARKER = "<!-- kimchi-claude-lint:review -->";
export const STICKY_MARKER = "<!-- kimchi-claude-lint:summary -->";
// REST API 는 봇 계정 로그인을 "github-actions[bot]"으로 준다. GraphQL 은 같은 계정을
// login: "github-actions", __typename: "Bot" 로 다르게 준다(대괄호가 없다) — 실측.
// 이 저장소가 REST(리뷰 코멘트 목록)와 GraphQL(스레드·리뷰)을 함께 쓰므로, 둘 중
// 하나만 보고 판정하면 절반의 경로에서 봇 코멘트를 놓친다.
export const BOT_LOGIN = "github-actions[bot]";
const BOT_LOGIN_GRAPHQL = "github-actions";

/**
 * REST·GraphQL 어느 쪽에서 왔든 author 가 이 액션이 쓰는 봇 계정인지 판정한다.
 * @param {{login?: string, __typename?: string}|null|undefined} author
 * @returns {boolean}
 */
export function isKimchiBot(author) {
  if (!author) return false;
  if (author.login === BOT_LOGIN) return true; // REST
  if (author.__typename === "Bot" && author.login === BOT_LOGIN_GRAPHQL) return true; // GraphQL
  return false;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    args[token.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * 파일 하나의 지적(같은 file·rule·bad·줄 원문)을 재실행에도 같은 것으로 알아보는
 * 지문이다. sha1은 충돌 걱정 없이 짧게 요약하는 용도일 뿐 보안 해시가 아니다.
 * @param {{file: string, ruleKey?: string, bad: string, lineText?: string}} finding
 * @returns {string} 40자 16진수
 */
export function fingerprint(finding) {
  const key = [finding.file, finding.ruleKey ?? finding.good ?? "", finding.bad, (finding.lineText ?? "").trim()].join(
    "|"
  );
  return createHash("sha1").update(key).digest("hex");
}

function markerFor(fp) {
  return `<!-- kimchi-claude-lint:v1 fp=${fp} -->`;
}

/** 코멘트 본문에서 지문 마커를 전부 뽑는다(한 코멘트가 여러 지적을 묶을 수 있어 여럿일 수 있다). */
export function extractFingerprints(body) {
  if (typeof body !== "string") return [];
  return [...body.matchAll(FP_MARKER_RE)].map((m) => m[1]);
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
  const runs = s.match(/`+/g) || [];
  const maxRun = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const fence = "`".repeat(maxRun + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

/**
 * unified diff hunk(`patch`)에서 코멘트를 달 수 있는 오른쪽(새 파일) 줄 번호를 모은다.
 * 추가된 줄과 문맥(변경 없는) 줄은 diff 에 보이므로 달 수 있고, 삭제된 줄(옛 파일에만
 * 있음)은 달 수 없다.
 *
 * @param {string|undefined} patch
 * @returns {Set<number>}
 */
export function commentableLines(patch) {
  const lines = new Set();
  if (typeof patch !== "string") return lines;

  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("-")) continue; // 옛 파일에만 있는 줄. 새 줄 번호를 소비하지 않는다
    if (raw.startsWith("+")) {
      lines.add(newLine);
      newLine += 1;
      continue;
    }
    // 문맥 줄(접두사 없음). diff 에 보이므로 코멘트를 달 수 있다.
    lines.add(newLine);
    newLine += 1;
  }
  return lines;
}

function formatFindingLine(finding) {
  const reason = finding.reason ? ` (${finding.reason})` : "";
  return `- ${mdCode(finding.bad)} → ${mdCode(finding.good)}${reason}`;
}

function formatPiiLine(hit, where) {
  return `- ${mdCode(where)}: 주민등록번호로 보이는 값 ${mdCode(hit.masked)}`;
}

/**
 * 한 줄에 걸린 지적을 전부 반영한 제안 줄을 만든다. 고칠 곳이 여럿이면 뒤(오른쪽
 * 칸)부터 적용해야 앞선 자리의 칸이 밀리지 않는다.
 *
 * 이 줄 원문에 주민등록번호로 보이는 값이 있었으면(action-lint.mjs 가 이미
 * `lineHasPii`로 표시해 뒀다) 제안을 아예 만들지 않는다 — 원문 줄 전체를 그대로
 * 되읊는 `suggestion` 블록에 개인정보가 실리는 것을 막는 마지막 방어선이다. 이미
 * 가려진 lineText 를 다시 findResidentNumbers 로 검사해도 소용없다(가린 값은 더 이상
 * 13자리로 안 보인다) — 그래서 가리기 전/후를 비교해 둔 표시를 그대로 믿는다.
 *
 * @param {object[]} group 같은 (file, line)의 지적들
 * @returns {string|null}
 */
export function buildLineSuggestion(group) {
  if (group.length === 0) return null;
  if (group.some((f) => f.lineHasPii)) return null;
  const lineText = group[0].lineText;
  if (typeof lineText !== "string") return null;
  // 방어적으로 한 번 더 본다 — lineHasPii 표시가 없는 경로(옛 데이터·다른 생성기)로
  // 들어와도 원문에 번호가 있으면 제안을 만들지 않는다.
  if (findResidentNumbers(lineText).length > 0) return null;

  const fixable = group.filter((f) => f.fixable && typeof f.replacement === "string");
  if (fixable.length === 0) return null;

  const sorted = [...fixable].sort((a, b) => b.column - a.column);
  let text = lineText;
  for (const f of sorted) {
    const start = f.column - 1;
    const end = start + f.bad.length;
    text = text.slice(0, start) + f.replacement + text.slice(end);
  }
  return text;
}

/**
 * findings.files 를 (file, line) 별로 묶어 인라인 코멘트 후보를 만든다. diff 에 없는
 * 줄은 코멘트를 달 수 없어 outOfDiff 로 뺀다.
 *
 * 본문(body)은 여기서 확정하지 않는다 — 그룹 중 일부가 이미 다른 실행에서 올라가
 * 있을 수 있고, 그 경우 새로 올리는 코멘트에는 **새 지적만** 실어야 한다(중복 방지,
 * `finalizeComment` 참고). 대신 그룹 전체(`group`)와 그 지문(`fingerprints`)만 담아
 * 후보로 돌려준다.
 *
 * @param {object[]} fileFindings
 * @param {Map<string, string|undefined>} patchByFile
 * @returns {{comments: object[], outOfDiff: object[]}}
 */
export function buildComments(fileFindings, patchByFile) {
  const byLocation = new Map();
  const outOfDiff = [];

  for (const finding of fileFindings) {
    // 경로 자체에 주민등록번호로 보이는 값이 있던 파일은 인라인 코멘트를 절대 달지
    // 않는다(요구사항 4). 리뷰 코멘트의 path 는 PR의 실제 파일 경로와 글자 그대로
    // 같아야 하는데, finding.file 은 이미 가려진 표시용 값이라 그 값을 실제 경로로
    // 쓰면 GitHub API가 찾지 못해 리뷰 전체가 422로 거부된다. 그렇다고 실제 경로를
    // 되살려 쓰면 safeDisplayPath 가 막으려던 유출이 코멘트를 통해 그대로 일어난다.
    // 이런 지적은 무조건 sticky 요약(가려진 이름으로)으로 보낸다.
    if (finding.pathHasPii) {
      outOfDiff.push(finding);
      continue;
    }
    // pathHasPii 가 거짓이면 action-lint.mjs 가 file 에 실제 경로를 그대로 남겨 뒀다
    // (가릴 것이 없었으므로) — PR files API 응답의 filename 과 그대로 맞는다.
    const commentable = commentableLines(patchByFile.get(finding.file));
    if (!commentable.has(finding.line)) {
      outOfDiff.push(finding);
      continue;
    }
    const key = `${finding.file}\u0000${finding.line}`;
    if (!byLocation.has(key)) byLocation.set(key, []);
    byLocation.get(key).push(finding);
  }

  const comments = [];
  for (const [key, group] of byLocation) {
    const [file, lineText] = key.split("\u0000");
    comments.push({ path: file, line: Number(lineText), side: "RIGHT", group, fingerprints: group.map(fingerprint) });
  }

  return { comments, outOfDiff };
}

/**
 * 코멘트 후보 하나를 실제로 올릴 본문으로 확정한다. 그룹 중 지문이 이미 올라가 있는
 * (existingFps에 있는) 지적은 마커·목록에서 뺀다 — 같은 줄에 지적이 여럿이고 그중
 * 일부만 새로 생겼을 때, 이미 활성 스레드가 있는 지적까지 다시 올리면 같은 지적이
 * 두 스레드에 중복으로 남는다.
 *
 * 다만 `suggestion` 블록은 **그룹 전체**(새 지적 + 이미 올라간 지적)로 계산한다 —
 * 그 줄에 실제로 적용 가능한 최종 모습은 그 줄에 걸린 모든 치환을 반영해야 나온다.
 * 새 지적만 고치면 같은 줄에 남아 있는 다른(이미 지적됐지만 아직 안 고쳐진) 문제를
 * suggestion이 놓치게 된다.
 *
 * 그룹 전체가 이미 올라가 있으면(새 지적이 하나도 없으면) null을 돌려준다 — 이
 * 코멘트는 올릴 것이 없다.
 *
 * @param {{path: string, line: number, side: string, group: object[], fingerprints: string[]}} candidate
 * @param {Set<string>} existingFps
 * @returns {{path: string, line: number, side: string, body: string}|null}
 */
export function finalizeComment(candidate, existingFps) {
  const pairs = candidate.group.map((finding, i) => ({ finding, fp: candidate.fingerprints[i] }));
  const newPairs = pairs.filter((p) => !existingFps.has(p.fp));
  if (newPairs.length === 0) return null;

  const markers = newPairs.map((p) => markerFor(p.fp)).join("\n");
  const bodyLines = newPairs.map((p) => formatFindingLine(p.finding));
  const suggestionLine = buildLineSuggestion(candidate.group); // 그룹 전체로 계산한다(위 설명 참고)
  const suggestion = suggestionLine ? [`\n\`\`\`suggestion`, suggestionLine, "```"].join("\n") : "";

  return {
    path: candidate.path,
    line: candidate.line,
    side: candidate.side,
    body: [markers, bodyLines.join("\n"), suggestion].filter(Boolean).join("\n"),
  };
}

/**
 * 스레드의 "첫 코멘트"가 kimchi 봇이 지문 마커를 달아 연 것인지 본다. 사람이 나중에
 * 우연히 마커와 같은 글자를 남긴 코멘트(가짜 마커)는 스레드를 열지 않았으므로 대상이
 * 아니다 — 반드시 첫 코멘트(스레드를 연 코멘트)의 작성자·내용만 본다.
 * @param {{comments: {body: string, author?: object}[]}} thread
 * @returns {boolean}
 */
function isKimchiThread(thread) {
  const first = thread.comments?.[0];
  return Boolean(first) && isKimchiBot(first.author) && extractFingerprints(first.body).length > 0;
}

/**
 * 스레드에 봇이 아닌 사람이 답을 남겼는지 본다. 사람이 논의 중인 스레드는 지문이
 * 사라졌다고 자동으로 접으면 안 된다 — 진행 중인 대화를 뭉갤 수 있다.
 * @param {{comments: {author?: object}[]}} thread
 * @returns {boolean}
 */
function hasNonBotReply(thread) {
  return (thread.comments || []).slice(1).some((c) => !isKimchiBot(c.author));
}

/**
 * 이번 실행에서 나온 코멘트 후보와, PR에 이미 달린 kimchi 스레드를 비교해 "새로 올릴
 * 것"과 "더는 안 걸려서 접어도 되는 스레드"를 가른다. 순수 함수라 gh 호출 없이
 * 시험할 수 있다.
 *
 * "이미 올라간 지문"은 **아직 열려 있고(해결·낡음 표시가 없는) 봇이 연** 스레드에서만
 * 모은다(요구사항 5) — 이미 해결되어 화면에서 접힌 스레드의 지문까지 세면, 그 지적이
 * 다시 나타나도(예: 되돌리기 커밋) 다시 올리지 않는 버그가 된다. "해결됐다"는 "그
 * 자리는 지금 깨끗하다"는 뜻이지 "다시는 지적하지 않는다"는 뜻이 아니다.
 *
 * `toPost`의 각 코멘트는 `finalizeComment`를 거쳐 **이미 올라간 지적을 뺀 나머지만**
 * 담는다 — 한 줄에 지적이 여럿이고 그중 일부만 새로 생겼으면, 이미 활성 스레드가
 * 있는 지적까지 다시 올려 중복 스레드를 만들지 않는다. suggestion은 그래도 그
 * 줄에 걸린 지적 전체로 계산한다(finalizeComment 참고).
 *
 * @param {{reviewThreads: {id: string, isResolved?: boolean, isOutdated?: boolean,
 *   comments: {body: string, author?: object}[]}[],
 *   comments: {group: object[], fingerprints: string[]}[]}} args
 * @returns {{toPost: object[], toResolveThreadIds: string[]}}
 */
export function planReviewActions({ reviewThreads, comments }) {
  const threads = reviewThreads || [];

  const existingFps = new Set(
    threads
      .filter((t) => isKimchiThread(t) && !t.isResolved && !t.isOutdated)
      .flatMap((t) => t.comments.flatMap((c) => extractFingerprints(c.body)))
  );
  const toPost = comments.map((c) => finalizeComment(c, existingFps)).filter((c) => c !== null);

  const currentFps = new Set(comments.flatMap((c) => c.fingerprints));
  const toResolveThreadIds = threads
    .filter((t) => isKimchiThread(t) && !t.isResolved)
    .filter((t) => !hasNonBotReply(t)) // 사람이 답한 진행 중인 논의는 자동으로 접지 않는다
    .filter((t) => !t.comments.some((c) => extractFingerprints(c.body).some((fp) => currentFps.has(fp))))
    .map((t) => t.id);

  return { toPost, toResolveThreadIds };
}

/**
 * 새 리뷰를 올릴 때 함께 접어야 할 이전 kimchi 리뷰의 노드 id 목록.
 * @param {{id: string, author?: object, body: string}[]} existingReviews
 * @returns {string[]}
 */
export function reviewsToMinimize(existingReviews) {
  return (existingReviews || [])
    .filter((r) => isKimchiBot(r.author) && typeof r.body === "string" && r.body.includes(REVIEW_MARKER))
    .map((r) => r.id);
}

function countFindings(findings) {
  const prText = findings.prText || { title: [], body: [] };
  return {
    files: (findings.files || []).length,
    commits: (findings.commits || []).length,
    title: (prText.title || []).length,
    body: (prText.body || []).length,
    pii: (findings.pii || []).length,
  };
}

/**
 * 짧은 리뷰 본문. 자세한 목록은 sticky 코멘트에 있다(요구사항: 리뷰 본문은 건수 +
 * sticky 코멘트로의 안내만).
 * @param {object} findings
 * @param {string} stickyCommentUrl sticky 코멘트 링크(있으면)
 */
export function buildReviewBody(findings, stickyCommentUrl) {
  const c = countFindings(findings);
  const total = c.files + c.commits + c.title + c.body;
  const pointer = stickyCommentUrl ? `자세한 목록은 ${stickyCommentUrl} 코멘트를 보십시오.` : "자세한 목록은 아래 sticky 코멘트를 보십시오.";
  return [REVIEW_MARKER, `kimchi-claude 가 어색한 표현 ${total}건, 주민등록번호로 보이는 값 ${c.pii}건을 찾았습니다.`, pointer].join(
    "\n"
  );
}

/**
 * sticky 이슈 코멘트 본문. diff 밖 지적, 커밋, PR 텍스트, 주민등록번호 목록을 담는다.
 * 걸리는 것이 하나도 없어도(재실행으로 전부 고쳐졌을 때도) 항상 이 자리에 현재 상태를
 * 그대로 반영한다 — "없어짐"도 상태다.
 * @param {object} findings
 * @param {object[]} outOfDiff
 */
export function buildStickyBody(findings, outOfDiff) {
  const bodyParts = [];
  if (outOfDiff.length > 0) {
    bodyParts.push(
      "**diff 밖에서 찾은 표현** (파일에는 있지만 이번 PR 이 바꾼 줄이 아니라 인라인 코멘트를 달 수 없습니다)",
      ...outOfDiff.map((f) => `- ${mdCode(`${f.file}:${f.line}`)} ${formatFindingLine(f).slice(2)}`)
    );
  }
  if ((findings.commits || []).length > 0) {
    bodyParts.push(
      "**커밋 메시지**",
      ...findings.commits.map((f) => `- (커밋 ${f.commitIndex + 1}) ${formatFindingLine(f).slice(2)}`)
    );
  }
  const prTextTitle = findings.prText?.title || [];
  const prTextBody = findings.prText?.body || [];
  if (prTextTitle.length > 0) bodyParts.push("**PR 제목**", ...prTextTitle.map(formatFindingLine));
  if (prTextBody.length > 0) bodyParts.push("**PR 본문**", ...prTextBody.map(formatFindingLine));

  const pii = findings.pii || [];
  if (pii.length > 0) {
    bodyParts.push(
      "**주민등록번호로 보이는 값** (저장소에 남으면 커밋을 지워도 사라지지 않습니다)",
      ...pii.map((hit) => formatPiiLine(hit, hit.file ? `${hit.file}:${hit.line ?? "?"}` : hit.label))
    );
  }

  const c = countFindings(findings);
  const total = c.files + c.commits + c.title + c.body;
  const summary = total > 0 || pii.length > 0 ? `현재 남은 지적 ${total}건, 주민등록번호로 보이는 값 ${pii.length}건입니다.` : "걸리는 표현이 없습니다.";

  return [STICKY_MARKER, summary, ...(bodyParts.length > 0 ? ["", ...bodyParts] : [])].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const findings = readJson(args.findings, { files: [], commits: [], prText: {}, pii: [] });
  const prFiles = readJson(args["pr-files"], []);
  const reviewThreads = readJson(args["review-threads"], []);
  const existingReviews = readJson(args["existing-reviews"], []);

  const patchByFile = new Map((Array.isArray(prFiles) ? prFiles : []).map((f) => [f.filename, f.patch]));
  const { comments, outOfDiff } = buildComments(findings.files || [], patchByFile);
  const { toPost, toResolveThreadIds } = planReviewActions({
    reviewThreads: Array.isArray(reviewThreads) ? reviewThreads : [],
    comments,
  });
  const toMinimize = reviewsToMinimize(Array.isArray(existingReviews) ? existingReviews : []);

  const stickyBody = buildStickyBody(findings, outOfDiff);
  const hasNewComments = toPost.length > 0;
  const commitId = typeof args["commit-id"] === "string" ? args["commit-id"] : undefined;

  const review =
    hasNewComments
      ? {
          event: "COMMENT",
          body: buildReviewBody(findings),
          comments: toPost, // finalizeComment 가 이미 {path, line, side, body} 모양으로 확정해 뒀다
          ...(commitId ? { commit_id: commitId } : {}),
        }
      : null;

  const output = {
    review,
    toResolveThreadIds,
    toMinimizeReviewIds: toMinimize,
    stickyBody,
  };

  const json = JSON.stringify(output, null, 2);
  if (args.out) writeFileSync(resolve(args.out), `${json}\n`);
  else console.log(json);
}

function isEntrypoint() {
  return process.argv[1] && process.argv[1].endsWith("build-review.mjs");
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
