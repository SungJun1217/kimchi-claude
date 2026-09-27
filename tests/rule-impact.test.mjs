// scripts/rule-impact.mjs 시험. 순수 함수는 합성 규칙으로 직접 부르고, 실제 base→head
// 시나리오(행 추가·제거·칸 변경이 스타일 본문에 미치는 영향)는 저장소를 임시 디렉터리에
// 복사해 스크립트를 실제로 돌려 확인한다 — buildBody의 예산 재배치는 lane 사이 상호작용이
// 있어(build-style.mjs 주석 참고) 합성 규칙만으로는 "본문이 가득 찼을 때 실제로 밀려나는지"
// 를 못 미덥게 확인한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withTempDir, ROOT, rule } from "./helpers.mjs";
import { mdCode } from "../scripts/lib/markdown.mjs";
import {
  MARKER,
  ruleKey,
  diffRules,
  styleContainsRule,
  bodyTransitions,
  countLintHits,
  collectAnswerTexts,
  buildMarkdown,
} from "../scripts/rule-impact.mjs";

const RULE_IMPACT = join(ROOT, "scripts", "rule-impact.mjs");

// ---- 순수 함수 단위 시험 ----

test("ruleKey는 파일 + 쓰지 말 것으로 규칙을 식별한다", () => {
  const a = rule({ source: "a.md", bad: "x", good: "하나" });
  const b = rule({ source: "a.md", bad: "x", good: "다름" });
  assert.equal(ruleKey(a), ruleKey(b));
});

test("diffRules: 추가 · 제거 · 칸 변경을 가른다", () => {
  const base = [
    rule({ source: "a.md", bad: "얇은 계약", good: "낮은 결합도" }),
    rule({ source: "b.md", bad: "여파", good: "영향 범위" }),
  ];
  const head = [
    rule({ source: "a.md", bad: "얇은 계약", good: "결합도 낮추기" }), // good 칸만 바뀜
    rule({ source: "b.md", bad: "새 표현", good: "쓸 것" }), // 새로 추가
  ];
  const { added, removed, changed } = diffRules(base, head);
  assert.equal(added.length, 1);
  assert.equal(added[0].bad, "새 표현");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].bad, "여파");
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].columns, ["good"]);
});

test("styleContainsRule: 본문에 실제 행이 있을 때만 참이다", () => {
  const r = rule({ en: "thin contract", bad: "얇은 계약", good: "낮은 결합도" });
  const body = "| thin contract | 얇은 계약 | 낮은 결합도 | 이유 |\n";
  assert.ok(styleContainsRule(body, r));
  assert.ok(!styleContainsRule("이 규칙과 무관한 본문", r));
});

test("bodyTransitions: 같은 규칙이 본문에서 빠지거나 새로 들어간 것만 잡는다", () => {
  const shared = rule({ en: "x", bad: "가", good: "나" });
  const baseMap = new Map([[ruleKey(shared), shared]]);
  const headMap = new Map([[ruleKey(shared), shared]]);

  const entered = bodyTransitions(baseMap, headMap, new Set(), new Set([ruleKey(shared)]));
  assert.equal(entered.entered.length, 1);
  assert.equal(entered.left.length, 0);

  const left = bodyTransitions(baseMap, headMap, new Set([ruleKey(shared)]), new Set());
  assert.equal(left.entered.length, 0);
  assert.equal(left.left.length, 1);

  // base에만 있는 규칙(제거된 행)은 여기 섞이면 안 된다 — 제거는 diffRules의 몫이다.
  const removedOnly = rule({ source: "z.md", bad: "지운다", good: "대체" });
  const baseMap2 = new Map([[ruleKey(shared), shared], [ruleKey(removedOnly), removedOnly]]);
  const headMap2 = new Map([[ruleKey(shared), shared]]);
  const result = bodyTransitions(baseMap2, headMap2, new Set([ruleKey(removedOnly)]), new Set());
  assert.equal(result.left.length, 0);
});

test("bodyTransitions: 칸 자체가 바뀐 규칙은 changedEntered/changedLeft로 따로 담긴다", () => {
  const changedRule = rule({ en: "y", bad: "다", good: "라" });
  const baseMap = new Map([[ruleKey(changedRule), changedRule]]);
  const headMap = new Map([[ruleKey(changedRule), changedRule]]);
  const changedKeys = new Set([ruleKey(changedRule)]);

  const result = bodyTransitions(baseMap, headMap, new Set(), new Set([ruleKey(changedRule)]), changedKeys);
  assert.equal(result.entered.length, 0, "칸이 바뀐 규칙은 순수 entered에 섞이면 안 된다");
  assert.equal(result.changedEntered.length, 1);

  const result2 = bodyTransitions(baseMap, headMap, new Set([ruleKey(changedRule)]), new Set(), changedKeys);
  assert.equal(result2.left.length, 0, "칸이 바뀐 규칙은 순수 left에 섞이면 안 된다");
  assert.equal(result2.changedLeft.length, 1);
});

test("countLintHits: 규칙별 적발 건수와 총건수를 센다", () => {
  const r = rule({ source: "a.md", bad: "가", good: "나" });
  const fakeLint = (text, rules) => (text.includes("가") ? [{ source: rules[0].source, bad: rules[0].bad }] : []);
  const texts = [
    { ext: "md", content: "가나다" },
    { ext: "md", content: "다라마" },
  ];
  const { counts, total } = countLintHits(texts, [r], fakeLint);
  assert.equal(total, 1);
  assert.equal(counts.get(`${r.source}\u0000${r.bad}`), 1);
});

const EMPTY_TREE = { rules: [], body: "", included: 0, maxChars: 6000 };
const EMPTY_DIFF = { added: [], removed: [], changed: [] };
const EMPTY_TRANSITIONS = { entered: [], left: [], changedEntered: [], changedLeft: [] };
const EMPTY_LINT_SET = { fileCount: 0, baseTotal: 0, headTotal: 0, deltaTotal: 0, topChanged: [] };
const EMPTY_LINT_DIFF = { catchSet: EMPTY_LINT_SET, falsePositiveSet: EMPTY_LINT_SET };

test("buildMarkdown: 변화가 없으면 짧게 영향 없음이라고 말한다", () => {
  const md = buildMarkdown({
    base: EMPTY_TREE,
    head: EMPTY_TREE,
    diff: EMPTY_DIFF,
    transitions: EMPTY_TRANSITIONS,
    lintDiff: EMPTY_LINT_DIFF,
  });
  assert.ok(md.startsWith(MARKER));
  assert.ok(md.includes("영향이 없습니다"));
});

test("buildMarkdown: 규칙은 그대로인데 본문 길이·상한만 달라져도 영향 없음이 아니다", () => {
  // scripts/build-style.mjs 자체가 바뀐 PR(예: PREAMBLE이 길어짐)은 규칙 diff가 비어
  // 있어도 본문 길이나 MAX_CHARS가 달라질 수 있다 — 그 경우에도 요약 줄은 찍혀야 한다.
  const md = buildMarkdown({
    base: EMPTY_TREE,
    head: { ...EMPTY_TREE, body: "x".repeat(10), maxChars: 6100 },
    diff: EMPTY_DIFF,
    transitions: EMPTY_TRANSITIONS,
    lintDiff: EMPTY_LINT_DIFF,
  });
  assert.ok(!md.includes("영향이 없습니다"));
  assert.ok(md.includes("규칙 변경 영향"));
  assert.ok(md.includes("6000자 → 6100자"));
});

test("buildMarkdown: 규칙 문구의 백틱을 안전하게 감싼다", () => {
  const r = rule({ source: "a.md", bad: "`push`합니다", good: "푸시합니다" });
  const md = buildMarkdown({
    base: EMPTY_TREE,
    head: { ...EMPTY_TREE, rules: [r] },
    diff: { ...EMPTY_DIFF, added: [r] },
    transitions: EMPTY_TRANSITIONS,
    lintDiff: EMPTY_LINT_DIFF,
  });
  assert.ok(md.includes(mdCode(r.bad)), "백틱이 든 문구는 mdCode로 감싼 형태로만 나와야 한다");
  // 코드 스팬이 깨지지 않았다면 원문 백틱이 스팬 밖으로 그대로 노출되지 않는다.
  assert.ok(!md.includes("`push`합니다 →"));
});

test("buildMarkdown: 분량 상한(60KB)을 넘으면 잘라내고 마커는 남긴다", () => {
  const huge = rule({ source: "a.md", bad: "가", good: "나".repeat(80_000) });
  const md = buildMarkdown({
    base: EMPTY_TREE,
    head: { ...EMPTY_TREE, rules: [huge] },
    diff: { ...EMPTY_DIFF, added: [huge] },
    transitions: EMPTY_TRANSITIONS,
    lintDiff: EMPTY_LINT_DIFF,
  });
  assert.ok(Buffer.byteLength(md, "utf8") <= 60 * 1024);
  assert.ok(md.startsWith(MARKER));
  assert.ok(md.includes("잘랐습니다"));
});

test("buildMarkdown: 칸이 바뀌어 빠진 행은 '분량 상한 때문' 목록과 분리해 보여준다", () => {
  const r = rule({ source: "a.md", bad: "바뀐 행", good: "새 대체" });
  const md = buildMarkdown({
    base: EMPTY_TREE,
    head: EMPTY_TREE,
    diff: EMPTY_DIFF,
    transitions: { entered: [], left: [], changedEntered: [], changedLeft: [r] },
    lintDiff: EMPTY_LINT_DIFF,
  });
  assert.ok(md.includes("행 자체가 바뀌어 본문에서 빠진 행"));
  assert.ok(!md.includes("본문에서 빠진 행 — 분량 상한 때문입니다"));
});

// ---- 실제 시나리오: 저장소를 복사해 스크립트를 그대로 돌린다 ----

function copyTree(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of ["hooks", "scripts", "rules", "tests", "evals"]) {
    cpSync(join(ROOT, name), join(dir, name), { recursive: true });
  }
  cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
}

function runImpact(baseDir, headDir) {
  const out = join(headDir, "impact.md");
  execFileSync("node", [join(headDir, "scripts", "rule-impact.mjs"), "--base", baseDir, "--head", headDir, "--out", out], {
    encoding: "utf8",
  });
  return readFileSync(out, "utf8");
}

test("변화가 없는 base/head는 영향 없음을 낸다", () => {
  withTempDir((tmp) => {
    const baseDir = join(tmp, "base");
    const headDir = join(tmp, "head");
    copyTree(baseDir);
    copyTree(headDir);

    const md = runImpact(baseDir, headDir);
    assert.ok(md.startsWith(MARKER));
    assert.ok(md.includes("영향이 없습니다"));
  });
});

test("핵심 행 추가 · 기존 행 제거 · 칸 변경을 한 PR에서 함께 잡는다", () => {
  withTempDir((tmp) => {
    const baseDir = join(tmp, "base");
    const headDir = join(tmp, "head");
    copyTree(baseDir);
    copyTree(headDir);

    const metaphorsPath = join(headDir, "rules", "metaphors.md");
    let text = readFileSync(metaphorsPath, "utf8");

    // 1) 새 핵심 치환 행을 추가한다 — 본문이 이미 상한(6000자)까지 차 있어(build-style.mjs
    //    주석 참고), 이 한 줄이 다른 낮은 순위 행을 밀어낼 수 있다.
    const addLine = "| load-bearing | 하중을 지탱하는 | 없으면 안 되는 | 물리적 하중 은유를 그대로 옮겨 뜻이 안 통한다 | 치환 | 핵심 |";
    assert.ok(text.includes("keep it thin"), "고정 fixture 가정이 깨졌다");
    text = text.replace(
      /\| keep it thin \|.*\|\n/,
      (matched) => `${matched}${addLine}\n`
    );

    // 2) 기존 행 하나를 완전히 지운다.
    assert.ok(text.includes("thin interface"));
    const removedLineMatch = text.match(/\| thin interface \|.*\|\n/);
    text = text.replace(/\| thin interface \|.*\|\n/, "");

    // 3) 남아 있는 행 하나의 이유 칸을 바꾼다(칸 단위 변경).
    text = text.replace(
      "| thin contract | 얇은 계약 | 낮은 결합도 | thin과 contract를 둘 다 직역해 뜻이 사라졌다 | 치환 | 핵심 |",
      "| thin contract | 얇은 계약 | 낮은 결합도 | 새로 다듬은 이유 | 치환 | 핵심 |"
    );

    writeFileSync(metaphorsPath, text, "utf8");

    const md = runImpact(baseDir, headDir);

    assert.ok(md.includes("추가된 행"));
    assert.ok(md.includes(mdCode("하중을 지탱하는")));

    assert.ok(md.includes("제거된 행"));
    assert.ok(md.includes(mdCode(removedLineMatch[0].split(" | ")[1])));

    assert.ok(md.includes("바뀐 행"));
    assert.ok(md.includes("why"));

    // 본문 상한(6000자)에 이미 가득 차 있었으므로, 새 행 하나가 최소 하나는 밀어냈거나
    // 새로 들어간 행이 있어야 한다(build-style.mjs 예산 재배치 — bodyTransitions 참고).
    assert.ok(md.includes("본문에서 빠진 행") || md.includes("본문에 새로 들어간 행"));
  });
});

test("규칙을 지우면 그 규칙의 린트 적발이 실제 자료에서 줄어든다(잡아야 할 표현 자료)", () => {
  withTempDir((tmp) => {
    const baseDir = join(tmp, "base");
    const headDir = join(tmp, "head");
    copyTree(baseDir);
    copyTree(headDir);

    // "계약이 얇"은 tests/fixtures/thin-contract-without-plugin.md 등 실제 답변에 그대로
    // 들어 있는 관찰 사례다(rules/observed.md). 이 행을 지우면 "잡아야 할 표현" 자료에서
    // 이 규칙의 적발이 반드시 줄어야 한다 — 규칙표의 bad 문자열을 그대로 재사용해 만든
    // 인위적 텍스트가 아니라 실제 답변으로 확인한다.
    const observedPath = join(headDir, "rules", "observed.md");
    const before = readFileSync(observedPath, "utf8");
    assert.ok(before.includes("계약이 얇"), "고정 fixture 가정이 깨졌다");
    const after = before
      .split("\n")
      .filter((line) => !line.includes("계약이 얇"))
      .join("\n");
    writeFileSync(observedPath, after, "utf8");

    const md = runImpact(baseDir, headDir);

    assert.ok(md.includes("제거된 행"));
    assert.ok(md.includes(mdCode("계약이 얇")));
    assert.ok(md.includes("잡아야 할 표현 자료"));
    // "적발 X건 → Y건" 줄에서 X > Y — 그 규칙 자체의 적발 건수가 줄었다.
    const perRuleLine = md.split("\n").find((line) => line.includes(mdCode("계약이 얇")) && line.includes("적발"));
    assert.ok(perRuleLine, "규칙별 적발 변화 줄을 찾지 못했다");
    const [, before2, after2] = perRuleLine.match(/적발 (\d+)건 → (\d+)건/);
    assert.ok(Number(before2) > Number(after2), `적발 건수가 줄지 않았다: ${perRuleLine}`);
    assert.equal(Number(after2), 0, "규칙을 지웠으니 head 적발은 0건이어야 한다");
  });
});

test("collectAnswerTexts: 이그노어 표시를 벗기고 잡아야 할 표현/오탐 신호 자료를 가른다", () => {
  const { catchSet, falsePositiveSet } = collectAnswerTexts(ROOT);
  assert.ok(catchSet.length > 0, "잡아야 할 표현 자료를 못 찾았다");
  assert.ok(falsePositiveSet.some((t) => t.path.endsWith("thin-contract-with-plugin.md")));
  for (const { content } of [...catchSet, ...falsePositiveSet]) {
    assert.ok(!content.startsWith("<!--"), "이그노어 표시가 안 벗겨졌다");
  }
});

test("트리를 못 불러오면(모듈 반환 모양이 바뀜) 실패로 끝나지 않고 마커가 든 짧은 본문을 낸다", () => {
  withTempDir((tmp) => {
    const baseDir = join(tmp, "base");
    const headDir = join(tmp, "head");
    copyTree(baseDir);
    copyTree(headDir);

    // build-style.mjs가 buildBody를 더는 내보내지 않는 것처럼 흉내 낸다(리네임·시그니처
    // 변경 PR). loadTree가 그대로 던지고, main()이 잡아 exit 0으로 끝나야 한다.
    const buildStylePath = join(headDir, "scripts", "build-style.mjs");
    writeFileSync(
      buildStylePath,
      readFileSync(buildStylePath, "utf8").replace("export function buildBody(", "function renamedBuildBody("),
      "utf8"
    );

    const out = join(headDir, "impact.md");
    execFileSync(
      "node",
      [join(headDir, "scripts", "rule-impact.mjs"), "--base", baseDir, "--head", headDir, "--out", out],
      { encoding: "utf8" }
    ); // execFileSync 자체가 0이 아닌 종료 코드에 예외를 던진다 — 여기서 안 던지면 exit 0이다.

    const md = readFileSync(out, "utf8");
    assert.ok(md.startsWith(MARKER));
    assert.ok(md.includes("트리를 불러오지 못했습니다"));
  });
});

test("lint export 이름이 바뀌어도(loadTree는 통과, 나중에야 터지는 모양) 실패로 끝나지 않는다", () => {
  withTempDir((tmp) => {
    const baseDir = join(tmp, "base");
    const headDir = join(tmp, "head");
    copyTree(baseDir);
    copyTree(headDir);

    // hooks/lib/lint.mjs가 `lint`를 `lintText`로 이름만 바꿔 내보내는 것처럼 흉내 낸다 —
    // 동적 import 자체는 성공하고(lintMod.lint는 undefined일 뿐 예외가 안 난다),
    // assertTreeShape가 loadTree 단계에서 이를 잡아 던져야 한다. 이 검사가 없으면
    // 한참 뒤 countLintHits 안에서 lint(...)를 호출할 때에야 TypeError로 터졌다
    // (리뷰에서 지적된 시나리오 — 그때는 main()의 try가 loadTree만 감싸고 있어
    // exit 1로 끝나고 impact.md도 안 남았다).
    const lintPath = join(headDir, "hooks", "lib", "lint.mjs");
    writeFileSync(
      lintPath,
      readFileSync(lintPath, "utf8").replace("export function lint(", "export function lintText("),
      "utf8"
    );

    const out = join(headDir, "impact.md");
    execFileSync(
      "node",
      [join(headDir, "scripts", "rule-impact.mjs"), "--base", baseDir, "--head", headDir, "--out", out],
      { encoding: "utf8" }
    ); // execFileSync 자체가 0이 아닌 종료 코드에 예외를 던진다 — 여기서 안 던지면 exit 0이다.

    const md = readFileSync(out, "utf8");
    assert.ok(md.startsWith(MARKER));
    assert.ok(md.includes("트리를 불러오지 못했습니다"));
    assert.ok(md.includes("lint"));
  });
});
