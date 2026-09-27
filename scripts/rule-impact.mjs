#!/usr/bin/env node
// PR이 바꾼 규칙(rules/*.md)이 출력 스타일 본문과 실제 린트 결과에 어떤 영향을 주는지
// 계산한다. build-style.mjs의 buildBody(rules, maxChars)는 본문 상한(MAX_CHARS)에 맞춰
// 낮은 순위 행부터 자른다 — 행을 하나 추가하면 다른 행이 조용히 밀려날 수 있는데, 지금은
// 사람이 diff를 직접 읽고 알아채야 한다. 이 스크립트가 그 변화를 눈에 보이게 만든다.
//
// base/head 디렉터리는 각각 완전한 저장소 체크아웃이다. 규칙 파싱기(hooks/lib/rules.mjs)와
// 스타일 생성기(scripts/build-style.mjs), 린트 엔진(hooks/lib/lint.mjs)을 그 트리 자신의
// 파일에서 동적으로 불러온다 — 한쪽만 파서를 바꾼 PR이면 그 변경까지 그대로 반영해야
// 비교가 맞다. 표 자체만 보는 소비자와 같은 원칙으로 rules 필드만 쓰고 builtins
// (latin-hada.mjs 등, bad가 매치마다 달라 표 한 줄로 못 세는 규칙)는 diff에 넣지 않는다
// (rules.mjs 문서 참고) — 코드 자체의 변경은 이 스크립트의 대상이 아니다.
//
// 오프라인이다(불변식 10). 네트워크를 열지 않는다.
//
// 사용법:
//   node scripts/rule-impact.mjs --base <디렉터리> --head <디렉터리> [--out <파일>]

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { mdCode } from "./lib/markdown.mjs";
import { formatGroupedList } from "../hooks/lib/format.mjs";
import { isEntrypoint } from "../hooks/lib/entrypoint.mjs";
import { parseArgs, writeText, runMain } from "./lib/cli.mjs";

export const MARKER = "<!-- kimchi-claude-rule-impact -->";

// 목록을 사람이 읽을 만큼만 보여 준다(공개 PR 코멘트다 — hooks/lib/format.mjs와 같은 원칙).
const MAX_LISTED = 20;
const MAX_TOP_LINT_RULES = 10;
// 코멘트 전체 크기 상한. sticky 코멘트가 규칙 수에 비례해 무한정 커지면 안 된다.
const MAX_BYTES = 60 * 1024;

const SKIP_DIRS = new Set(["node_modules", ".git", ".remember", "results"]);
const COMPARE_FIELDS = ["en", "good", "why", "check", "priority"];

/** 규칙 하나를 표 파일 + `쓰지 말 것`으로 식별한다. 두 값이 같으면 같은 행으로 본다. */
export function ruleKey(rule) {
  return `${rule.source}\u0000${rule.bad}`;
}

/**
 * 디렉터리 아래 모든 파일 경로를 모은다(선택적으로 확장자로 좁힌다).
 * @param {string} dir
 * @param {string} [ext] 예: ".md"
 * @returns {string[]}
 */
function walk(dir, ext) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) found.push(...walk(full, ext));
    else if (!ext || name.endsWith(ext)) found.push(full);
  }
  return found;
}

// 자료 파일(tests/fixtures/*.md, evals/experiments/**/answers/*.md)은 dogfood 시험에서
// 빠지려고 `<!-- kimchi-ignore-file ... -->` 로 시작한다(tests/dogfood.test.mjs). 그런데
// 이 표시는 lint()의 isIgnoredFile()도 그대로 걸러 버려서, 벗기지 않고 그대로 돌리면
// 나쁜 표현이 그대로 있는 자료도 항상 0건으로 나온다 — 실측: 벗기기 전에는 두 집합
// 모두 0건이었다. tests/improvement.test.mjs의 readAnswer와 같은 규칙(맨 앞 주석 한
// 덩어리만 벗긴다)으로 벗겨야 자료 본문이 실제로 검사된다.
function stripLeadingIgnoreComment(text) {
  return text.replace(/^<!--[\s\S]*?-->\n/, "");
}

// 파일 이름으로 두 집합을 가른다. 저장소 문서 전체(트리가 추적하는 임의의 .md)를 훑지
// 않는다 — 그 문서들은 이미 dogfood 시험을 통과한 깨끗한 글이라(불변식 8) 규칙을
// 지우거나 넓혀도 대개 0건에서 0건으로 아무것도 안 움직인다. 나쁜 표현이 실제로 들어
// 있는 자료(플러그인 없이 받은 답변, 초안)와 플러그인을 켠 상태로 받은 실제 답변만
// 대상으로 삼는다.
//   - "잡아야 할 표현" — 플러그인이 없거나(다른 스타일 포함) 아직 안 고친 상태로 받은
//     실제 답변이다. 규칙을 지우면 여기서 적발 건수가 떨어져야 한다.
//   - "오탐 신호" — 플러그인을 켠 상태로 받은 실제 답변이다. 여기서 적발이 늘면 새
//     규칙이 지나치게 넓어 정상적인 문장까지 잡았다는 뜻이다.
function classifyAnswer(name) {
  if (/^(none|fluent)-/.test(name)) return "catch";
  if (/^(kimchi|merged)-/.test(name)) return "falsePositive";
  if (name.endsWith("-without-plugin.md") || name === "draft-before.md") return "catch";
  if (name.endsWith("-with-plugin.md") || name.endsWith("-forced.md") || name === "draft-after.md") return "falsePositive";
  return null;
}

/**
 * 린트 결과 비교에 쓸 텍스트 두 집합("잡아야 할 표현"/"오탐 신호")을 head 트리에서 모은다.
 * 실제로 값이 비교되는 것은 텍스트가 아니라 규칙 집합이므로(같은 텍스트에 base 규칙과
 * head 규칙을 각각 돌린다), 텍스트는 head 트리 한 벌만 모은다.
 * @param {string} headDir
 * @returns {{catchSet: object[], falsePositiveSet: object[]}}
 */
export function collectAnswerTexts(headDir) {
  const catchSet = [];
  const falsePositiveSet = [];

  const candidates = [
    ...walk(join(headDir, "tests/fixtures"), ".md"),
    ...walk(join(headDir, "evals/experiments"), ".md").filter((path) =>
      relative(headDir, path).split(sep).includes("answers")
    ),
  ];

  for (const path of candidates) {
    const kind = classifyAnswer(basename(path));
    if (!kind) continue;
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const entry = { path: relative(headDir, path), ext: "md", content: stripLeadingIgnoreComment(content) };
    if (kind === "catch") catchSet.push(entry);
    else falsePositiveSet.push(entry);
  }

  return { catchSet, falsePositiveSet };
}

/**
 * loadTree가 만든 트리 하나의 모양을 확인한다. 동적 import는 export가 바뀌어도(이름이
 * 바뀌거나 반환 모양이 바뀌어도) 그 자체로는 던지지 않는다 — `lintMod.lint`가
 * `undefined`인 채로 그대로 넘어가면 한참 뒤(countLintHits 안에서 lint(...)를 호출할
 * 때)에야 TypeError로 터진다. 실패 지점을 여기로 당겨서 어느 트리·어느 파일이
 * 문제인지 바로 알 수 있는 메시지를 던진다 — main()의 넓은 try/catch(이 함수보다
 * 아래에서 diff·lint 계산까지 전부 감싼다)가 최종 방어선이고, 이건 그 방어선이
 * 실제로 필요해지기 전에 더 나은 진단을 남기는 앞단이다.
 * @param {{lint: unknown, rules: unknown, body: unknown, included: unknown, maxChars: unknown}} tree
 * @param {string} abs
 */
function assertTreeShape(tree, abs) {
  if (typeof tree.lint !== "function") {
    throw new Error(`${abs}: hooks/lib/lint.mjs가 lint 함수를 내보내지 않습니다.`);
  }
  if (!Array.isArray(tree.rules)) {
    throw new Error(`${abs}: hooks/lib/rules.mjs의 loadRules()가 rules 배열을 돌려주지 않습니다.`);
  }
  if (typeof tree.body !== "string") {
    throw new Error(`${abs}: scripts/build-style.mjs의 buildBody()가 문자열 body를 돌려주지 않습니다.`);
  }
  if (!Number.isInteger(tree.included)) {
    throw new Error(`${abs}: scripts/build-style.mjs의 buildBody()가 정수 included를 돌려주지 않습니다.`);
  }
  if (!Number.isInteger(tree.maxChars)) {
    throw new Error(`${abs}: scripts/build-style.mjs의 MAX_CHARS가 정수가 아닙니다.`);
  }
}

/**
 * 트리 하나(base 또는 head)의 규칙·본문·린트 엔진을 그 트리 자신의 파일에서 읽는다.
 * 트리가 이 스크립트가 기대하는 모양과 다르면(모듈이 옮겨졌거나, export 이름이
 * 바뀌었거나, 반환 모양이 바뀐 PR) 그대로 던진다 — 호출부(main)가 잡아서 안전하게
 * 끝낸다.
 * @param {string} dir
 */
async function loadTree(dir) {
  const abs = resolve(dir);
  const rulesMod = await import(pathToFileURL(join(abs, "hooks/lib/rules.mjs")).href);
  const buildStyleMod = await import(pathToFileURL(join(abs, "scripts/build-style.mjs")).href);
  const lintMod = await import(pathToFileURL(join(abs, "hooks/lib/lint.mjs")).href);

  const { rules } = rulesMod.loadRules(join(abs, "rules"));
  const { body, included } = buildStyleMod.buildBody(rules);

  const tree = {
    dir: abs,
    rules,
    body,
    included,
    maxChars: buildStyleMod.MAX_CHARS,
    lint: lintMod.lint,
  };
  assertTreeShape(tree, abs);
  return tree;
}

/**
 * base/head 규칙 집합을 비교한다. 추가/제거/변경(칸 단위)으로 가른다.
 * @param {object[]} baseRules
 * @param {object[]} headRules
 */
export function diffRules(baseRules, headRules) {
  const baseMap = new Map(baseRules.map((r) => [ruleKey(r), r]));
  const headMap = new Map(headRules.map((r) => [ruleKey(r), r]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, rule] of headMap) if (!baseMap.has(key)) added.push(rule);
  for (const [key, rule] of baseMap) if (!headMap.has(key)) removed.push(rule);
  for (const [key, headRule] of headMap) {
    const baseRule = baseMap.get(key);
    if (!baseRule) continue;
    const columns = COMPARE_FIELDS.filter((field) => (baseRule[field] || "") !== (headRule[field] || ""));
    if (columns.length > 0) changed.push({ base: baseRule, head: headRule, columns });
  }

  return { added, removed, changed, baseMap, headMap };
}

/**
 * 규칙 하나가 스타일 본문에 실제로 담겼는지 본다. build-style.mjs의 toRow가 내는
 * `| 원어 | 쓰지 말 것 | 쓸 것 | 이유 | ` 가운데 이유 칸만 줄여 적으므로(shortenWhy),
 * 그 앞부분만 그대로 되풀이해 부분 문자열로 찾는다 — 이유 칸의 축약 규칙까지 복제할
 * 필요가 없다.
 * @param {string} body
 * @param {object} rule
 * @returns {boolean}
 */
export function styleContainsRule(body, rule) {
  return body.includes(`| ${rule.en || "—"} | ${rule.bad} | ${rule.good} | `);
}

function inStyleKeys(rules, body) {
  const keys = new Set();
  for (const rule of rules) if (styleContainsRule(body, rule)) keys.add(ruleKey(rule));
  return keys;
}

/**
 * 두 트리에 모두 있는(추가·제거가 아닌) 규칙 가운데 본문 소속이 바뀐 것을 가른다.
 *
 * `changedKeys`(diff.changed에 든 규칙)는 따로 뗀다 — 그 규칙은 칸 자체가 바뀌어 행
 * 텍스트(원어·쓸 것)가 달라졌으니, 본문에서 빠지거나 들어간 것이 분량 상한 때문인지
 * 행 텍스트가 달라졌기 때문인지 구분이 안 된다. 순수하게 분량 상한만으로 밀린 것은
 * entered/left에, 칸이 바뀌면서 소속도 바뀐 것은 changedEntered/changedLeft에 담는다.
 * @param {Map<string, object>} baseMap
 * @param {Map<string, object>} headMap
 * @param {Set<string>} baseInStyle
 * @param {Set<string>} headInStyle
 * @param {Set<string>} [changedKeys]
 */
export function bodyTransitions(baseMap, headMap, baseInStyle, headInStyle, changedKeys = new Set()) {
  const entered = [];
  const left = [];
  const changedEntered = [];
  const changedLeft = [];
  for (const [key, headRule] of headMap) {
    if (!baseMap.has(key)) continue;
    const wasIn = baseInStyle.has(key);
    const isIn = headInStyle.has(key);
    if (wasIn === isIn) continue;
    const enteredNow = !wasIn && isIn;
    if (changedKeys.has(key)) (enteredNow ? changedEntered : changedLeft).push(headRule);
    else (enteredNow ? entered : left).push(headRule);
  }
  return { entered, left, changedEntered, changedLeft };
}

/**
 * texts에 rules를 lint로 돌려, 규칙별 적발 건수와 총건수를 센다.
 * @param {{ext: string, content: string}[]} texts
 * @param {object[]} rules
 * @param {(text: string, rules: object[], mask: object) => object[]} lint
 */
export function countLintHits(texts, rules, lint) {
  const counts = new Map();
  let total = 0;
  for (const { ext, content } of texts) {
    for (const finding of lint(content, rules, { ext })) {
      const key = `${finding.source}\u0000${finding.bad}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      total += 1;
    }
  }
  return { counts, total };
}

function topChangedLintRules(baseCounts, headCounts, baseMap, headMap, max) {
  const keys = new Set([...baseCounts.keys(), ...headCounts.keys()]);
  const rows = [];
  for (const key of keys) {
    const base = baseCounts.get(key) || 0;
    const head = headCounts.get(key) || 0;
    if (base === head) continue;
    const rule = headMap.get(key) || baseMap.get(key);
    if (!rule) continue;
    rows.push({ rule, base, head });
  }
  rows.sort((a, b) => Math.abs(b.head - b.base) - Math.abs(a.head - a.base));
  return rows.slice(0, max);
}

function ruleLine(rule) {
  return `- ${mdCode(rule.source)}: ${mdCode(rule.bad)} → ${mdCode(rule.good)}`;
}

function changedLine({ base, head, columns }) {
  const cols = columns.map((field) => `${field} ${mdCode(base[field] || "—")} → ${mdCode(head[field] || "—")}`).join(", ");
  return `- ${mdCode(head.source)}: ${mdCode(head.bad)} — ${cols}`;
}

/** 목록 하나를 소제목 + 상한 걸린 줄로 바꾼다. 비어 있으면 아무것도 내지 않는다. */
function section(title, items, lineFn) {
  if (items.length === 0) return [];
  const groups = items.map((item) => ({ item, count: 1 }));
  const lines = formatGroupedList(groups, ({ item }) => lineFn(item), MAX_LISTED, (rest) => `- 외 ${rest}개 더`);
  return [`### ${title} (${items.length}개)`, "", ...lines, ""];
}

/** 전체 마크다운이 상한을 넘으면 뒷부분을 잘라낸다. 마커는 항상 맨 앞이라 잘려도 남는다. */
function finalize(text) {
  if (Buffer.byteLength(text, "utf8") <= MAX_BYTES) return text;
  let truncated = text;
  while (Buffer.byteLength(truncated, "utf8") > MAX_BYTES - 200 && truncated.length > 0) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
  }
  return `${truncated}\n\n(분량 상한을 넘어 뒷부분을 잘랐습니다.)`;
}

/** 텍스트 집합 하나(잡아야 할 표현/오탐 신호)의 base→head 린트 비교를 계산한다. */
function compareLintOnSet(texts, base, head, diffMaps) {
  const { counts: baseCounts, total: baseTotal } = countLintHits(texts, base.rules, base.lint);
  const { counts: headCounts, total: headTotal } = countLintHits(texts, head.rules, head.lint);
  return {
    fileCount: texts.length,
    baseTotal,
    headTotal,
    deltaTotal: headTotal - baseTotal,
    topChanged: topChangedLintRules(baseCounts, headCounts, diffMaps.baseMap, diffMaps.headMap, MAX_TOP_LINT_RULES),
  };
}

function lintSetSection(title, note, setDiff) {
  const lines = [
    `### ${title}`,
    "",
    `${note}(검사 대상 ${setDiff.fileCount}개 파일): 적발 ${setDiff.baseTotal}건 → ${setDiff.headTotal}건입니다.`,
    "",
  ];
  if (setDiff.topChanged.length > 0) {
    lines.push(
      ...setDiff.topChanged.map(
        ({ rule, base: b, head: h }) => `- ${mdCode(rule.source)}: ${mdCode(rule.bad)} 적발 ${b}건 → ${h}건`
      ),
      ""
    );
  }
  return lines;
}

/**
 * 계산 결과(diffRules + bodyTransitions + 린트 건수 비교)를 사람이 읽는 합니다체
 * 마크다운으로 만든다.
 */
export function buildMarkdown(report) {
  const { base, head, diff, transitions, lintDiff } = report;
  const noChange =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    transitions.entered.length === 0 &&
    transitions.left.length === 0 &&
    transitions.changedEntered.length === 0 &&
    transitions.changedLeft.length === 0 &&
    lintDiff.catchSet.deltaTotal === 0 &&
    lintDiff.falsePositiveSet.deltaTotal === 0 &&
    base.body.length === head.body.length &&
    base.maxChars === head.maxChars &&
    base.included === head.included;

  if (noChange) {
    return finalize(`${MARKER}\n\n규칙 변경이 출력 스타일 본문과 린트 결과에 주는 영향이 없습니다.`);
  }

  const lines = [
    MARKER,
    "",
    "## 규칙 변경 영향",
    "",
    `규칙 ${base.rules.length}개 → ${head.rules.length}개, 본문 ${base.body.length}자 → ${head.body.length}자` +
      `(상한 ${base.maxChars}자 → ${head.maxChars}자), 본문에 담긴 규칙 ${base.included}개 → ${head.included}개입니다.`,
    "",
  ];

  lines.push(
    ...section("추가된 행", diff.added, (r) => `${ruleLine(r)}${styleContainsRule(head.body, r) ? " (본문 포함)" : ""}`)
  );
  lines.push(
    ...section("제거된 행", diff.removed, (r) => `${ruleLine(r)}${styleContainsRule(base.body, r) ? " (본문에서도 빠짐)" : ""}`)
  );
  lines.push(...section("바뀐 행", diff.changed, changedLine));
  lines.push(...section("본문에서 빠진 행 — 분량 상한 때문입니다", transitions.left, ruleLine));
  lines.push(...section("본문에 새로 들어간 행", transitions.entered, ruleLine));
  lines.push(...section("행 자체가 바뀌어 본문에서 빠진 행", transitions.changedLeft, ruleLine));
  lines.push(...section("행 자체가 바뀌어 본문에 들어간 행", transitions.changedEntered, ruleLine));

  lines.push("## 린트 결과 변화", "");
  lines.push(
    ...lintSetSection(
      "잡아야 할 표현 자료",
      "플러그인 없이(또는 다른 스타일로) 받은 실제 답변입니다. 규칙을 지우면 여기서 적발이 줄어야 합니다",
      lintDiff.catchSet
    )
  );
  lines.push(
    ...lintSetSection(
      "오탐 신호 자료",
      "플러그인을 켠 상태로 받은 실제 답변입니다. 여기서 적발이 늘면 새 규칙이 지나치게 넓다는 뜻입니다",
      lintDiff.falsePositiveSet
    )
  );

  return finalize(lines.join("\n").trimEnd());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base || !args.head) {
    throw new Error("--base와 --head 디렉터리를 모두 지정해야 합니다.");
  }

  // loadTree부터 buildMarkdown까지 통째로 감싼다 — assertTreeShape가 흔한 모양 오류
  // (export 이름이 바뀌거나 반환 모양이 바뀐 PR)를 loadTree 안에서 먼저 잡아 더 나은
  // 진단을 남기지만, 그걸로 다 잡힌다는 보장은 없다(예: rules 배열 안의 규칙 객체
  // 자체가 이상한 모양이면 diffRules나 countLintHits 안에서 나중에 터질 수 있다).
  // 이 스크립트가 어디서 실패하든 결과는 같아야 한다 — 낡은 sticky 코멘트를 그대로
  // 두는 대신, 실패했다는 사실 자체를 마커가 든 짧은 본문으로 남기고 exit 0으로
  // 끝난다(이 함수는 job을 실패시키지 않는다).
  try {
    const base = await loadTree(String(args.base));
    const head = await loadTree(String(args.head));

    const diff = diffRules(base.rules, head.rules);
    const baseInStyle = inStyleKeys(base.rules, base.body);
    const headInStyle = inStyleKeys(head.rules, head.body);
    const changedKeys = new Set(diff.changed.map(({ head: headRule }) => ruleKey(headRule)));
    const transitions = bodyTransitions(diff.baseMap, diff.headMap, baseInStyle, headInStyle, changedKeys);

    const { catchSet, falsePositiveSet } = collectAnswerTexts(head.dir);
    const lintDiff = {
      catchSet: compareLintOnSet(catchSet, base, head, diff),
      falsePositiveSet: compareLintOnSet(falsePositiveSet, base, head, diff),
    };

    const markdown = buildMarkdown({ base, head, diff, transitions, lintDiff });
    writeText(markdown, args.out);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    writeText(
      finalize(
        `${MARKER}\n\n트리를 불러오지 못했습니다(${mdCode(message)}). base 또는 head의 규칙 파싱기·스타일 생성기·린트 엔진이 이 스크립트가 기대하는 모양과 다릅니다.`
      ),
      args.out
    );
  }
}

if (isEntrypoint(import.meta.url)) runMain(main);
