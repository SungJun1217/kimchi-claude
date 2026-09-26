import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseIssueForm,
  extractFields,
  reproduce,
  promptRuleMatches,
  ruleLocation,
  blobUrl,
  attachRuleLocations,
  buildComment,
  decideLabels,
  MARKER,
} from "../scripts/triage-report.mjs";
import { loadToneRules } from "../hooks/lib/artifact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "triage-report.mjs");
const RULES = loadToneRules();
const REPO = "SungJun1217/kimchi-claude";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-triage-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runTriage(args) {
  const stdout = execFileSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  return stdout;
}

// --- parseIssueForm ----------------------------------------------------

test("render: text 펜스가 있는 항목의 값을 뽑는다", () => {
  const body = ["### 걸린 문장", "", "```text", "이 컨텐츠를 확인합니다.", "```"].join("\n");
  const form = parseIssueForm(body);
  assert.equal(form["걸린 문장"], "이 컨텐츠를 확인합니다.");
});

test("펜스 없는 일반 항목(input·textarea)의 값도 뽑는다", () => {
  const body = ["### 고친다면", "", "영향력 있게", "", "### 근거", "", "실무 관행입니다."].join("\n");
  const form = parseIssueForm(body);
  assert.equal(form["고친다면"], "영향력 있게");
  assert.equal(form["근거"], "실무 관행입니다.");
});

test("false-positive 양식 전체를 파싱한다", () => {
  const body = [
    "### 걸린 문장",
    "",
    "```text",
    "이 컨텐츠를 확인합니다.",
    "```",
    "",
    "### 경고·교정 메시지",
    "",
    "```text",
    '"컨텐츠" → "콘텐츠"',
    "```",
    "",
    "### 어디서",
    "",
    "문서 파일",
    "",
    "### 왜 틀렸다고 보나",
    "",
    "우리 팀 용례입니다.",
    "",
    "### 버전",
    "",
    "0.18.0",
    "",
    "### KIMCHI_AUTOFIX 사용 여부",
    "",
    "사용하지 않음",
  ].join("\n");
  const fields = extractFields(parseIssueForm(body), "false-positive");
  assert.equal(fields.sentence, "이 컨텐츠를 확인합니다.");
  assert.equal(fields.where, "문서 파일");
  assert.equal(fields.reason, "우리 팀 용례입니다.");
});

test("missed-expression 양식 전체를 파싱한다", () => {
  const body = [
    "### 어색한 문장",
    "",
    "```text",
    "임팩트 있게 만들었습니다.",
    "```",
    "",
    "### 고친다면",
    "",
    "영향력 있게",
    "",
    "### 근거",
    "",
    "국립국어원 순화어입니다.",
    "",
    "### 어디서",
    "",
    "커밋 메시지",
  ].join("\n");
  const fields = extractFields(parseIssueForm(body), "missed-expression");
  assert.equal(fields.sentence, "임팩트 있게 만들었습니다.");
  assert.equal(fields.fix, "영향력 있게");
  assert.equal(fields.where, "커밋 메시지");
});

test("항목이 아예 빠져도 죽지 않고 빈 문자열로 채운다", () => {
  const fields = extractFields(parseIssueForm("### 어디서\n\n기타"), "false-positive");
  assert.equal(fields.sentence, "");
  assert.equal(fields.where, "기타");
});

test("_No response_ 는 빈 문자열로 본다", () => {
  const form = parseIssueForm("### 근거\n\n_No response_");
  assert.equal(form["근거"], "");
});

test("빈 문자열·비문자열 본문에도 안전하다", () => {
  assert.deepEqual(parseIssueForm(""), {});
  assert.deepEqual(parseIssueForm(undefined), {});
});

// [보안 회귀] 예전 정규식(/^### (.+?)\s*$/m)은 지연 ".+?" 뒤에 "\s*$"가 붙어, 제목
// 줄에 공백이 아주 길게 이어지면 되짚기(backtracking)가 늘어 이차 시간이 들었다 —
// 신뢰할 수 없는 이슈 본문이 이 모양을 그대로 만들 수 있어 그 자체로 서비스거부 경로였다.
test("타이밍: 제목 줄에 공백이 아주 길게 이어져도 선형 시간에 끝난다", () => {
  // MAX_BODY_CHARS(65,536자) 안에 담아야 한다 — 그 한도를 넘는 뒤쪽은 애초에 안 보므로,
  // 한도보다 큰 입력을 주면 이 시험이 재현하려는 것(공백 자체의 되짚기 비용)과 무관하게
  // "본문이 잘려서 내용을 못 찾았다"는 이유로 실패한다(별도로 아래에서 그 한도 자체를 시험한다).
  const pathological = `### 걸린 문장${" ".repeat(60_000)}\n\n내용`;
  const start = Date.now();
  const form = parseIssueForm(pathological);
  const elapsed = Date.now() - start;
  assert.equal(form["걸린 문장"], "내용");
  assert.ok(elapsed < 1000, `공백이 긴 제목 줄 파싱이 ${elapsed}ms 걸렸다 — 이차 시간으로 되돌아갔을 수 있다`);
});

// [보안 회귀] 이슈 본문은 API로 임의 길이를 보낼 수 있다. 한도 없이 다 읽으면 크기에
// 비례해 파싱이 오래 걸린다 — MAX_BODY_CHARS(65,536자)를 넘는 부분은 아예 보지 않는다.
test("본문이 너무 길면 한도를 넘는 부분은 파싱하지 않는다", () => {
  const padding = "x".repeat(70_000);
  const body = `### 걸린 문장\n\n${padding}\n\n### 어디서 뒤에 숨은 라벨\n\n이 값은 안 보여야 한다`;
  const form = parseIssueForm(body);
  assert.equal(form["어디서 뒤에 숨은 라벨"], undefined, "한도를 넘긴 자리의 항목은 파싱되면 안 된다");
});

// --- reproduce (커밋 메시지 / 문서 파일 / 스타일) ------------------------

test("커밋 메시지 경로는 재현되면(findings 있음) reproduced=true 라벨을 단다(false-positive)", () => {
  const result = reproduce("컨텐츠를 정리했습니다", "커밋 메시지", RULES);
  assert.equal(result.mode, "lint");
  assert.ok(result.findings.some((f) => f.bad === "컨텐츠"));
  const labels = decideLabels("false-positive", result, false);
  assert.deepEqual(labels, { add: ["reproduced"], remove: ["not-reproduced", "needs-info"] });
});

test("문서 파일 경로에서 안 걸리면 false-positive는 not-reproduced", () => {
  const result = reproduce("캐시를 한 번만 계산하도록 고쳤습니다.", "문서 파일", RULES);
  assert.equal(result.mode, "lint");
  assert.deepEqual(result.findings, []);
  const labels = decideLabels("false-positive", result, false);
  assert.deepEqual(labels, { add: ["not-reproduced"], remove: ["reproduced", "needs-info"] });
});

test("missed-expression은 이미 잡히면(findings 있음) not-reproduced(더는 놓치지 않음)다", () => {
  const result = reproduce("임팩트 있게 만들었습니다.", "문서 파일", RULES);
  assert.ok(result.findings.length > 0, "observed.md 의 임팩트 규칙에 걸려야 한다");
  const labels = decideLabels("missed-expression", result, false);
  assert.deepEqual(labels, { add: ["not-reproduced"], remove: ["reproduced", "needs-info"] });
});

test("missed-expression은 아직 안 잡히면 reproduced(여전히 놓침)다", () => {
  const result = reproduce("아무 규칙에도 안 걸리는 평범한 문장입니다.", "문서 파일", RULES);
  assert.deepEqual(result.findings, []);
  const labels = decideLabels("missed-expression", result, false);
  assert.deepEqual(labels, { add: ["reproduced"], remove: ["not-reproduced", "needs-info"] });
});

test('"기타"는 문서 기준으로 재현하고 그 사실을 notes에 남긴다', () => {
  const result = reproduce("컨텐츠를 정리했습니다", "기타", RULES);
  assert.equal(result.mode, "lint");
  assert.ok(result.notes.some((n) => n.includes("기타")));
});

// --- 대화 답변(스타일) ----------------------------------------------------

test("스타일 대상은 린트하지 않고(findings 없음) 프롬프트 규칙만 본다", () => {
  const result = reproduce("당신의 코드를 검토했습니다.", "대화 답변(스타일)", RULES);
  assert.equal(result.mode, "style");
  assert.deepEqual(result.findings, []);
});

test("프롬프트 규칙에 걸리는 스타일 문장은 promptHits에 담긴다", () => {
  const result = reproduce("우리는 캐시를 재생성합니다.", "대화 답변(스타일)", RULES);
  assert.equal(result.mode, "style");
  assert.ok(result.promptHits.length > 0, "we(우리는 ~합니다) 프롬프트 규칙이 걸려야 한다");
});

test("스타일 모드는 reproduced/not-reproduced를 둘 다 떼고 확정하지 않는다", () => {
  const result = reproduce("당신의 코드를 검토했습니다.", "대화 답변(스타일)", RULES);
  assert.deepEqual(decideLabels("false-positive", result, false), {
    add: [],
    remove: ["reproduced", "not-reproduced", "needs-info"],
  });
});

// --- promptRuleMatches ---------------------------------------------------

test("promptRuleMatches는 치환·정규식 규칙은 무시하고 프롬프트 규칙만 본다", () => {
  const hits = promptRuleMatches("우리는 이 기능을 사용합니다.", RULES);
  assert.ok(hits.every((r) => r.check === "프롬프트"));
  assert.ok(hits.length > 0);
});

test("빈 문자열에는 아무것도 걸리지 않는다", () => {
  assert.deepEqual(promptRuleMatches("", RULES), []);
});

// --- ruleLocation / blobUrl / attachRuleLocations ------------------------

test("ruleLocation이 규칙표에서 실제 줄 번호를 찾는다", () => {
  const rule = RULES.find((r) => r.bad === "컨텐츠");
  assert.ok(rule, "컨텐츠 규칙이 있어야 한다");
  const loc = ruleLocation(rule, join(ROOT, "rules"));
  assert.ok(loc);
  assert.equal(loc.file, `rules/${rule.source}`);
  assert.ok(loc.line > 0);
});

test("source가 없으면 null을 돌려준다", () => {
  assert.equal(ruleLocation({ bad: "아무거나" }, join(ROOT, "rules")), null);
});

test("blobUrl이 저장소·태그·파일·줄로 링크를 만든다", () => {
  assert.equal(
    blobUrl(REPO, "v0.18.0", { file: "rules/register.md", line: 42 }),
    `https://github.com/${REPO}/blob/v0.18.0/rules/register.md#L42`
  );
});

test("attachRuleLocations가 finding에 source·line·url을 붙인다", () => {
  const result = reproduce("이 컨텐츠를 확인합니다.", "문서 파일", RULES);
  const attached = attachRuleLocations(result.findings, RULES, REPO, "v0.18.0");
  const hit = attached.find((f) => f.bad === "컨텐츠");
  assert.ok(hit);
  assert.ok(hit.source);
  assert.ok(hit.line > 0);
  assert.match(hit.url, /^https:\/\/github\.com\/.*#L\d+$/);
});

// --- PII: 훅과 같은 원칙으로 원문을 절대 되읊지 않는다 ---------------------

test("주민등록번호가 섞인 문장을 가려서 재현한다(원문 숫자가 findings·코멘트 어디에도 없다)", () => {
  withTempDir((dir) => {
    const bodyPath = join(dir, "body.txt");
    writeFileSync(
      bodyPath,
      [
        "### 걸린 문장",
        "",
        "```text",
        "주민등록번호 880505-2345678 을 검증해야 합니다.",
        "```",
        "",
        "### 경고·교정 메시지",
        "",
        "```text",
        "주민등록번호로 보이는 값을 찾았습니다.",
        "```",
        "",
        "### 어디서",
        "",
        "문서 파일",
        "",
        "### 왜 틀렸다고 보나",
        "",
        "실제로 검증 가능한 값입니다.",
        "",
        "### 버전",
        "",
        "0.18.0",
        "",
        "### KIMCHI_AUTOFIX 사용 여부",
        "",
        "사용하지 않음",
      ].join("\n")
    );
    const outPath = join(dir, "out.json");
    const commentPath = join(dir, "comment.md");
    runTriage([
      "--body", bodyPath,
      "--template", "false-positive",
      "--repo", REPO,
      "--out", outPath,
      "--comment-out", commentPath,
    ]);
    const json = readFileSync(outPath, "utf8");
    const comment = readFileSync(commentPath, "utf8");
    assert.equal(/2345678/.test(json), false, "원문 주민등록번호가 JSON에 남으면 안 된다");
    assert.equal(/2345678/.test(comment), false, "원문 주민등록번호가 코멘트에 남으면 안 된다");
    assert.match(comment, /880505-\*+/);
    assert.equal(JSON.parse(json).labels.add.includes("needs-info"), true);
  });
});

// [보안 회귀] kimchi-allow-rrn은 저장소 관리자가 자기 문서에 남기는 표시다. 신뢰할 수
// 없는 이슈 제출자가 신고 문장에 그 표시를 붙여 검사를 피하고, 실제 번호가 공개
// 코멘트에 그대로 실리게 하면 안 된다 — CLI(main)는 ignoreAllowLine: true로 호출해야 한다.
test("이슈 본문에 kimchi-allow-rrn을 붙여도 검사를 피하지 못하고 여전히 가려진다", () => {
  withTempDir((dir) => {
    const bodyPath = join(dir, "body.txt");
    writeFileSync(
      bodyPath,
      [
        "### 걸린 문장",
        "",
        "```text",
        "880505-2345678 // kimchi-allow-rrn",
        "```",
        "",
        "### 어디서",
        "",
        "문서 파일",
      ].join("\n")
    );
    const outPath = join(dir, "out.json");
    const commentPath = join(dir, "comment.md");
    runTriage([
      "--body", bodyPath,
      "--template", "false-positive",
      "--repo", REPO,
      "--out", outPath,
      "--comment-out", commentPath,
    ]);
    const json = readFileSync(outPath, "utf8");
    const comment = readFileSync(commentPath, "utf8");
    assert.equal(/2345678/.test(json), false, "kimchi-allow-rrn 표시로 원문 번호가 새어 나오면 안 된다");
    assert.equal(/2345678/.test(comment), false, "kimchi-allow-rrn 표시로 원문 번호가 새어 나오면 안 된다");
    assert.match(comment, /880505-\*+/, "표시가 있어도 가려야 한다");
    assert.equal(JSON.parse(json).labels.add.includes("needs-info"), true, "표시가 있어도 PII로 판정해야 한다");
  });
});

// --- buildComment: 마크다운 이스케이프 --------------------------------

test("코멘트에 마커가 있고, 인용문이 임의 길이 백틱 펜스에도 깨지지 않는다", () => {
  const result = { mode: "none", findings: [], promptHits: [], notes: [] };
  const comment = buildComment({
    template: "false-positive",
    version: "0.18.0",
    quoted: "백틱 ```` 넷짜리가 섞인 문장",
    piiRedacted: false,
    result,
    repo: REPO,
    ref: "v0.18.0",
    rules: RULES,
  });
  assert.ok(comment.startsWith(MARKER));
  assert.match(comment, /`{5,}\n백틱 ```` 넷짜리가 섞인 문장\n`{5,}/);
});

test("@멘션이 섞인 인용문이 코드 블록 밖에서 알림으로 파싱되지 않도록 감싼다", () => {
  const result = { mode: "none", findings: [], promptHits: [], notes: [] };
  const comment = buildComment({
    template: "false-positive",
    version: "0.18.0",
    quoted: "@octocat 님이 이렇게 썼습니다",
    piiRedacted: false,
    result,
    repo: REPO,
    ref: "v0.18.0",
    rules: RULES,
  });
  // 펜스 블록 안에 있어야 한다 — 펜스 밖에 맨 @멘션이 그대로 남으면 안 된다.
  const fenceMatch = comment.match(/`{3,}\n([\s\S]*?)\n`{3,}/);
  assert.ok(fenceMatch);
  assert.match(fenceMatch[1], /@octocat/);
});

// [보안 회귀] 예전에는 "인용한 문장: ```" 처럼 레이블과 여는 펜스가 한 줄에 있었다 —
// 펜스는 줄 맨 앞에서 시작해야 코드 블록으로 인식되므로(커먼마크), 그러면 사용자가
// 넣은 여러 줄 텍스트가 실제로는 코드 블록이 아니라 살아 있는 마크다운으로 렌더링되어
// @멘션·이미지·헤딩이 그대로 해석됐다.
test("여러 줄 인용문의 펜스가 항상 줄 맨 앞에서 시작한다(레이블과 같은 줄에 붙이면 깨진다)", () => {
  const result = { mode: "none", findings: [], promptHits: [], notes: [] };
  const quoted = "첫 줄\n\n@octocat 님 보세요\n![경고](https://evil.example/x.png)";
  const comment = buildComment({
    template: "false-positive",
    version: "0.18.0",
    quoted,
    piiRedacted: false,
    result,
    repo: REPO,
    ref: "v0.18.0",
    rules: RULES,
  });
  const lines = comment.split("\n");
  const fenceLineIndexes = lines.reduce((acc, l, i) => (/^`{3,}$/.test(l.trim()) ? [...acc, i] : acc), []);
  assert.ok(fenceLineIndexes.length >= 2, "펜스 여는 줄과 닫는 줄이 있어야 한다");
  for (const i of fenceLineIndexes) {
    assert.equal(lines[i].trim(), lines[i], `펜스 줄에 다른 텍스트가 함께 있으면 안 된다: ${JSON.stringify(lines[i])}`);
  }
  const [startIdx, endIdx] = fenceLineIndexes;
  const inside = lines.slice(startIdx + 1, endIdx).join("\n");
  assert.match(inside, /@octocat/, "@멘션이 코드 블록 안에 있어야 한다");
  assert.match(inside, /!\[경고\]\(https:\/\/evil\.example\/x\.png\)/, "이미지 구문이 코드 블록 안에 있어야 한다");
});

// [보안 회귀] "고친다면"(input 필드)은 웹 UI에서 한 줄이지만, 방어적으로 줄바꿈이
// 섞여 들어와도 mdCode(인라인 코드 스팬)가 그 자리에서 끊겨 뒤 텍스트가 스팬 밖으로
// 흘러나오면 안 된다.
test("제안 표현(고친다면)에 줄바꿈이 섞여도 인라인 코드 스팬이 끊기지 않는다", () => {
  const result = { mode: "lint", findings: [], promptHits: [], notes: [] };
  const comment = buildComment({
    template: "missed-expression",
    version: "0.18.0",
    quoted: "짧은 문장",
    piiRedacted: false,
    result,
    repo: REPO,
    ref: "v0.18.0",
    rules: RULES,
    fix: "첫 줄\n@octocat 두번째 줄",
    where: "문서 파일",
  });
  // 원본 줄바꿈이 그대로 남아 스팬이 끊기면 안 된다 — 한 줄로 접혀 인라인 스팬 안에
  // 전부 들어가 있어야 한다.
  assert.equal(comment.includes("첫 줄\n@octocat"), false, "원본 줄바꿈이 그대로 남아 있으면 안 된다");
  assert.match(comment, /`첫 줄 @octocat 두번째 줄`/, "한 줄로 접힌 채 인라인 코드 스팬 안에 있어야 한다");
});

// --- buildComment: 길이 상한 ------------------------------------------------

function fakeFinding(i) {
  return { bad: `나쁜말${i}`, good: `좋은말${i}`, reason: "시험용", check: "치환", ruleKey: `나쁜말${i}` };
}

test("인용문이 너무 길면 잘라내고 생략 표시를 남긴다", () => {
  const result = { mode: "none", findings: [], promptHits: [], notes: [] };
  const longQuote = "가".repeat(3000);
  const comment = buildComment({
    template: "false-positive",
    version: "0.18.0",
    quoted: longQuote,
    piiRedacted: false,
    result,
    repo: REPO,
    ref: "v0.18.0",
    rules: RULES,
  });
  assert.match(comment, /…\(생략\)/);
  assert.equal(comment.includes("가".repeat(3000)), false, "잘리지 않은 원문 전체가 남아 있으면 안 된다");
});

test("findings가 많아도 목록은 상한까지만 나열하고 나머지는 건수로만 말한다", () => {
  const result = { mode: "lint", findings: Array.from({ length: 30 }, (_, i) => fakeFinding(i)), promptHits: [], notes: [] };
  const comment = buildComment({
    template: "false-positive",
    version: "0.18.0",
    quoted: "짧은 문장",
    piiRedacted: false,
    result,
    repo: REPO,
    ref: "v0.18.0",
    rules: RULES,
  });
  const listedLines = comment.split("\n").filter((l) => l.startsWith("- `나쁜말"));
  assert.equal(listedLines.length, 20);
  assert.match(comment, /외 10건 더/);
});

test("인용문·findings가 모두 최악의 경우여도 코멘트 전체 길이가 64KB를 넘지 않는다", () => {
  const result = { mode: "lint", findings: Array.from({ length: 500 }, (_, i) => fakeFinding(i)), promptHits: [], notes: [] };
  const comment = buildComment({
    template: "false-positive",
    version: "0.18.0",
    quoted: "가".repeat(10_000),
    piiRedacted: true,
    result,
    repo: REPO,
    ref: "v0.18.0",
    rules: RULES,
  });
  assert.ok(comment.length < 65_536, `코멘트가 ${comment.length}자 — 상한을 넘었다`);
});

// --- CLI 전체 -------------------------------------------------------------

test("CLI가 false-positive 재현 결과와 라벨을 JSON으로 낸다", () => {
  withTempDir((dir) => {
    const bodyPath = join(dir, "body.txt");
    writeFileSync(
      bodyPath,
      ["### 걸린 문장", "", "```text", "이 컨텐츠를 확인합니다.", "```", "", "### 어디서", "", "문서 파일"].join("\n")
    );
    const stdout = runTriage(["--body", bodyPath, "--template", "false-positive", "--repo", REPO]);
    const [jsonPart] = stdout.split(MARKER);
    const output = JSON.parse(jsonPart);
    assert.equal(output.reproduced, true);
    assert.deepEqual(output.labels, { add: ["reproduced"], remove: ["not-reproduced", "needs-info"] });
    assert.ok(stdout.includes(MARKER));
  });
});

test("잘못된 --template은 실패한다", () => {
  assert.throws(() => runTriage(["--template", "nonsense"]));
});
