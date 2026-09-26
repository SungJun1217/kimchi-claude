import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  globToRegExp,
  matchesAnyPattern,
  findingsForTarget,
  findingsForText,
  safeDisplayPath,
  DEFAULT_PATTERNS,
} from "../scripts/action-lint.mjs";
import {
  commentableLines,
  mdCode,
  fingerprint,
  extractFingerprints,
  buildLineSuggestion,
  buildComments,
  finalizeComment,
  planReviewActions,
  reviewsToMinimize,
  buildReviewBody,
  buildStickyBody,
  isKimchiBot,
  BOT_LOGIN,
  REVIEW_MARKER,
} from "../scripts/build-review.mjs";

// GraphQL이 실제로 돌려주는 봇 계정 모양. REST(login: "github-actions[bot]")와 다르다.
const GRAPHQL_BOT_AUTHOR = { login: "github-actions", __typename: "Bot" };
import { loadToneRules } from "../hooks/lib/artifact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACTION_LINT = join(ROOT, "scripts", "action-lint.mjs");
const RULES = loadToneRules();

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-action-lint-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runActionLint(args, extraEnv = {}) {
  const stdout = execFileSync("node", [ACTION_LINT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return stdout.trim() === "" ? null : JSON.parse(stdout);
}

function initGitRepo(dir) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "kimchi",
    GIT_AUTHOR_EMAIL: "kimchi@example.com",
    GIT_COMMITTER_NAME: "kimchi",
    GIT_COMMITTER_EMAIL: "kimchi@example.com",
  };
  execFileSync("git", ["init", "-q"], { cwd: dir, env });
  return env;
}

function commitAll(dir, env, message) {
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, env });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env }).toString().trim();
}

// --- globToRegExp / matchesAnyPattern -------------------------------------

test("**/*.md 는 저장소 루트 파일에도 걸린다", () => {
  assert.equal(globToRegExp("**/*.md").test("a.md"), true);
  assert.equal(globToRegExp("**/*.md").test("docs/a.md"), true);
  assert.equal(globToRegExp("**/*.md").test("docs/nested/a.md"), true);
  assert.equal(globToRegExp("**/*.md").test("a.mdx"), false);
});

test("기본 패턴이 문서 확장자 다섯 가지를 모두 받는다", () => {
  const patterns = DEFAULT_PATTERNS.split(",");
  for (const file of ["README.md", "guide.mdx", "notes.txt", "spec.rst", "manual.adoc"]) {
    assert.equal(matchesAnyPattern(file, patterns), true, file);
  }
  assert.equal(matchesAnyPattern("index.js", patterns), false);
});

// --- safeDisplayPath --------------------------------------------------------

test("경로에 섞인 주민등록번호를 가린다(대시 구분)", () => {
  const safe = safeDisplayPath("docs/900101-1234567.md");
  assert.match(safe, /900101-\*+/);
  assert.equal(/1234567/.test(safe), false);
});

// [보안 회귀] 요구사항 3: 감지와 가리기가 같은 규칙을 써야 한다. 훅의 pii.mjs는 경로에
// pathOnly(대시만 인정)를 쓰지만, 이 함수는 표시용이라 감지에 걸리는 모든 형태(붙여
// 쓴 형태·공백 구분)를 똑같이 가려야 한다 — 감지는 되는데 가리기만 놓치면 "PII를
// 찾았다고 알리면서 동시에 원문을 그대로 보여주는" 최악의 조합이 된다.
test("경로에 섞인 주민등록번호를 가린다(구분자 없이 붙은 형태)", () => {
  const safe = safeDisplayPath("docs/9001011234568.md");
  assert.equal(/1234568/.test(safe), false, "붙여 쓴 형태도 가려야 한다");
  assert.match(safe, /900101-\*+/);
});

test("경로에 섞인 주민등록번호를 가린다(공백 구분)", () => {
  const safe = safeDisplayPath("docs/900101 1234568.md");
  assert.equal(/1234568/.test(safe), false, "공백으로 구분한 형태도 가려야 한다");
  assert.match(safe, /900101-\*+/);
});

test("평범한 경로는 그대로 둔다", () => {
  assert.equal(safeDisplayPath("docs/design.md"), "docs/design.md");
});

// --- findingsForTarget -----------------------------------------------------

test("치환 규칙의 위반에 줄·칸·replacement를 붙인다", () => {
  const findings = findingsForTarget({ text: "이 컨텐츠를 확인합니다.", ext: "md" }, RULES);
  const hit = findings.find((f) => f.bad === "컨텐츠");
  assert.ok(hit, "컨텐츠 위반을 찾아야 한다");
  assert.equal(hit.line, 1);
  assert.equal(hit.column, 3);
  assert.equal(hit.check, "치환");
  assert.equal(hit.fixable, true);
  assert.equal(hit.replacement, "콘텐츠");
  assert.equal(hit.lineText, "이 컨텐츠를 확인합니다.");
  assert.equal(hit.lineHasPii, false);
  assert.ok(hit.ruleKey, "원본 규칙 패턴(ruleKey)이 있어야 지문을 만들 수 있다");
});

test("둘째 줄의 위반은 줄 번호가 2다", () => {
  const findings = findingsForTarget({ text: "첫 줄입니다.\n이 컨텐츠를 확인합니다.", ext: "md" }, RULES);
  const hit = findings.find((f) => f.bad === "컨텐츠");
  assert.equal(hit.line, 2);
});

test("정규식(문맥 필요) 규칙은 fixable이 false이고 replacement가 없다", () => {
  const findings = findingsForTarget({ text: "얇은 계약을 유지해야 합니다.", ext: "md" }, RULES);
  const hit = findings.find((f) => f.bad === "얇은 계약");
  assert.ok(hit);
  assert.equal(hit.fixable, false);
  assert.equal(hit.replacement, undefined);
});

test("코드 울타리 안의 컨텐츠는 잡지 않는다", () => {
  const text = ["설명입니다.", "```", "컨텐츠", "```"].join("\n");
  const findings = findingsForTarget({ text, ext: "md" }, RULES);
  assert.equal(findings.length, 0);
});

// [보안 회귀] 요구사항 1: 주민등록번호가 있는 줄은 lineText에 원문 숫자가 남지 않는다
test("주민등록번호가 섞인 줄은 lineText를 가리고 lineHasPii를 켠다", () => {
  const findings = findingsForTarget(
    { text: "이 컨텐츠에는 900101-1234567 이 적혀 있습니다.", ext: "md" },
    RULES
  );
  const hit = findings.find((f) => f.bad === "컨텐츠");
  assert.ok(hit);
  assert.equal(hit.lineHasPii, true);
  assert.equal(/1234567/.test(hit.lineText), false, "가려진 lineText에 원문 숫자가 남으면 안 된다");
  assert.match(hit.lineText, /900101-\*+/);
});

// --- findingsForText (커밋 메시지·PR 텍스트) --------------------------------

test("영어 문장에는 개입하지 않는다", () => {
  assert.deepEqual(findingsForText("Fix the cache bug", RULES), []);
});

test("한국어 문장의 위반을 찾는다", () => {
  const findings = findingsForText("컨텐츠를 정리했습니다", RULES);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].bad, "컨텐츠");
  assert.equal(findings[0].fixable, true);
});

// --- action-lint.mjs CLI 전체 -----------------------------------------------

test("파일·커밋·PR 텍스트·주민등록번호를 한 번에 검사한다", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.md"), "이 컨텐츠는 리팩토링이 필요합니다. 얇은 계약을 유지해야 합니다.\n");
    writeFileSync(join(dir, "b.js"), "// 컨텐츠\n"); // 소스 파일은 검사하지 않는다
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "a.md\nb.js\n");
    const commitsJson = join(dir, "commits.json");
    writeFileSync(commitsJson, JSON.stringify(["컨텐츠를 정리했습니다", "900101-1234567 테스트"]));
    const prTextJson = join(dir, "pr-text.json");
    writeFileSync(prTextJson, JSON.stringify({ title: "컨텐츠 수정", body: "정상 본문입니다" }));

    const output = runActionLint([
      "--files", filesList,
      "--repo-root", dir,
      "--commits", commitsJson,
      "--pr-text", prTextJson,
    ]);

    assert.equal(output.files.filter((f) => f.file === "a.md").length > 0, true);
    assert.equal(output.files.some((f) => f.file === "b.js"), false);
    assert.equal(output.commits.length, 1);
    assert.equal(output.commits[0].bad, "컨텐츠");
    assert.equal(output.prText.title.length, 1);
    assert.equal(output.prText.body.length, 0);
    assert.equal(output.pii.length, 1);
    assert.equal(output.pii[0].masked, "900101-*******");
    assert.equal(/1234567/.test(JSON.stringify(output)), false, "원문 주민등록번호가 그대로 새면 안 된다");
  });
});

// [보안 회귀] 요구사항 2: 파일 경로 자체에 주민등록번호가 있어도 출력 전체에 원문이 없다
test("파일 경로에 든 주민등록번호는 출력 어디에도 원문으로 남지 않는다", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "900101-1234567.md"), "캐시를 한 번만 계산하도록 고쳤습니다.\n");
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "900101-1234567.md\n");
    const output = runActionLint(["--files", filesList, "--repo-root", dir]);
    const json = JSON.stringify(output);
    assert.equal(/1234567/.test(json), false);
    assert.equal(output.pii.some((hit) => hit.kind === "path"), true);
    for (const hit of output.pii) assert.match(hit.file, /\*{7}/);
  });
});

// [보안 회귀] 요구사항 3: 구분자가 없거나 공백으로 구분된 파일명도 원문이 새지 않는다
test("붙여 쓰거나 공백으로 구분한 파일명의 주민등록번호도 출력에 원문으로 남지 않는다", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "9001011234568.md"), "캐시를 한 번만 계산하도록 고쳤습니다.\n");
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "9001011234568.md\n");
    const output = runActionLint(["--files", filesList, "--repo-root", dir]);
    const json = JSON.stringify(output);
    assert.equal(/1234568/.test(json), false);
    assert.equal(output.pii.some((hit) => hit.kind === "path"), true);
  });
});

// [보안 회귀] 요구사항 4 대비: pathHasPii 가 있어야 build-review.mjs 가 인라인 코멘트를
// 걸러낼 수 있다 — 여기서는 그 표시 자체가 파일 찾기(tone finding)에도 실리는지만 본다.
test("경로에 주민등록번호가 있으면 그 파일의 tone 위반에도 pathHasPii가 켜진다", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "900101-1234567.md"), "이 컨텐츠를 확인합니다.\n");
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "900101-1234567.md\n");
    const output = runActionLint(["--files", filesList, "--repo-root", dir]);
    assert.ok(output.files.length > 0);
    for (const finding of output.files) assert.equal(finding.pathHasPii, true);
    assert.equal(/1234567/.test(JSON.stringify(output)), false);
  });
});

test("경로가 평범하면 pathHasPii가 꺼져 있다", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.md"), "이 컨텐츠를 확인합니다.\n");
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "a.md\n");
    const output = runActionLint(["--files", filesList, "--repo-root", dir]);
    assert.ok(output.files.length > 0);
    for (const finding of output.files) assert.equal(finding.pathHasPii, false);
  });
});

// [보안 회귀] 커밋 메시지·PR 제목·본문은 fork PR 기여자가 통제하는 자유 텍스트다.
// kimchi-allow-rrn은 저장소 관리자가 자기 문서에 남기는 opt-out이지, 신뢰할 수 없는
// 기여자가 실제 번호를 검사망 밖으로 빼돌리는 수단이 되면 안 된다 — 이 세 대상은
// ignoreAllowLine: true로 검사해야 한다.
test("커밋 메시지에 kimchi-allow-rrn을 붙여도 검사를 피하지 못한다", () => {
  withTempDir((dir) => {
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "");
    const commitsJson = join(dir, "commits.json");
    writeFileSync(commitsJson, JSON.stringify(["880505-2345678 // kimchi-allow-rrn"]));
    const output = runActionLint(["--files", filesList, "--repo-root", dir, "--commits", commitsJson]);
    assert.equal(output.pii.length, 1, "kimchi-allow-rrn 표시로 커밋 메시지의 번호를 놓치면 안 된다");
    assert.equal(/2345678/.test(JSON.stringify(output)), false);
  });
});

test("PR 제목·본문에 kimchi-allow-rrn을 붙여도 검사를 피하지 못한다", () => {
  withTempDir((dir) => {
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "");
    const prTextJson = join(dir, "pr-text.json");
    writeFileSync(
      prTextJson,
      JSON.stringify({ title: "880505-2345678 // kimchi-allow-rrn", body: "770606-1234567 // kimchi-allow-rrn" })
    );
    const output = runActionLint(["--files", filesList, "--repo-root", dir, "--pr-text", prTextJson]);
    assert.equal(output.pii.length, 2, "kimchi-allow-rrn 표시로 PR 제목·본문의 번호를 놓치면 안 된다");
    assert.equal(/2345678|1234567/.test(JSON.stringify(output)), false);
  });
});

// 파일 내용은 여전히 kimchi-allow-rrn을 존중한다 — 이 저장소 자신의 문서·규칙표가
// 형식만 맞는 예시에 그 표시를 정당하게 쓰는 관례라(dogfooding), 여기까지 끄면
// 저장소 스스로의 PR에서 오탐이 늘어난다.
test("파일 내용의 kimchi-allow-rrn은 여전히 존중한다(관리자 문서의 정당한 예시)", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.md"), "880505-2345678 // kimchi-allow-rrn\n");
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "a.md\n");
    const output = runActionLint(["--files", filesList, "--repo-root", dir]);
    assert.equal(output.pii.length, 0, "파일 내용은 여전히 kimchi-allow-rrn 표시를 존중해야 한다");
  });
});

test("걸리는 것이 없으면 빈 결과를 낸다", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.md"), "캐시를 한 번만 계산하도록 고쳤습니다.\n");
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "a.md\n");
    const output = runActionLint(["--files", filesList, "--repo-root", dir]);
    assert.deepEqual(output.files, []);
    assert.deepEqual(output.pii, []);
  });
});

test("patterns 로 검사 대상을 좁힌다", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.md"), "컨텐츠\n");
    writeFileSync(join(dir, "b.txt"), "컨텐츠\n");
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "a.md\nb.txt\n");
    const output = runActionLint(["--files", filesList, "--repo-root", dir, "--patterns", "**/*.md"]);
    const files = new Set(output.files.map((f) => f.file));
    assert.equal(files.has("a.md"), true);
    assert.equal(files.has("b.txt"), false);
  });
});

test("--mode annotations 는 ::warning 줄을 stdout에 낸다(파일에는 JSON만)", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.md"), "이 컨텐츠를 확인합니다.\n");
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "a.md\n");
    const outPath = join(dir, "out.json");
    const stdout = execFileSync(
      "node",
      [ACTION_LINT, "--files", filesList, "--repo-root", dir, "--mode", "annotations", "--out", outPath],
      { encoding: "utf8" }
    );
    assert.match(stdout, /^::warning file=a\.md,line=1,col=\d+::/m);
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(written.files.length, 1);
  });
});

test("--fail-on-findings 는 위반이 있으면 종료 코드를 1로 만든다", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.md"), "컨텐츠\n");
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "a.md\n");
    assert.throws(() => {
      execFileSync("node", [ACTION_LINT, "--files", filesList, "--repo-root", dir, "--fail-on-findings", "true"], {
        encoding: "utf8",
      });
    });
    // fail-on-findings 없이는 위반이 있어도 종료 코드 0이다
    const stdout = execFileSync("node", [ACTION_LINT, "--files", filesList, "--repo-root", dir], { encoding: "utf8" });
    assert.ok(JSON.parse(stdout).files.length > 0);
  });
});

// 요구사항 7 회귀: PR 제목/본문에서만 위반이 나도 실패로 잡는다
test("--fail-on-findings 는 PR 제목·본문의 위반도 센다", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.md"), "캐시를 한 번만 계산하도록 고쳤습니다.\n");
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "a.md\n");
    const prTextJson = join(dir, "pr-text.json");
    writeFileSync(prTextJson, JSON.stringify({ title: "컨텐츠 수정", body: "" }));
    assert.throws(() => {
      execFileSync(
        "node",
        [ACTION_LINT, "--files", filesList, "--repo-root", dir, "--pr-text", prTextJson, "--fail-on-findings", "true"],
        { encoding: "utf8" }
      );
    });
  });
});

test("깨진 --files 경로에도 죽지 않는다", () => {
  const output = runActionLint(["--files", "/no/such/file.txt"]);
  assert.deepEqual(output, { files: [], commits: [], prText: { title: [], body: [] }, pii: [] });
});

// 요구사항 8 회귀: --head-sha 를 주면 작업 트리가 아니라 그 커밋 시점 내용을 읽는다
test("--head-sha 를 주면 그 커밋 시점 내용을 읽는다(작업 트리가 달라도)", () => {
  withTempDir((dir) => {
    const env = initGitRepo(dir);
    writeFileSync(join(dir, "a.md"), "이 컨텐츠를 확인합니다.\n");
    const headSha = commitAll(dir, env, "head");
    // 커밋 뒤에 작업 트리를 다르게 바꿔 둔다 — 훅이 이걸 보면 안 된다(merge 커밋
    // 시나리오를 흉내낸다).
    writeFileSync(join(dir, "a.md"), "캐시를 한 번만 계산하도록 고쳤습니다.\n");

    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "a.md\n");
    const output = runActionLint(["--files", filesList, "--repo-root", dir, "--head-sha", headSha]);
    assert.equal(output.files.some((f) => f.bad === "컨텐츠"), true, "작업 트리가 아니라 head 커밋을 읽어야 한다");
  });
});

test("--head-sha 를 안 주면 작업 트리를 읽는다(기존 동작)", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "a.md"), "이 컨텐츠를 확인합니다.\n");
    const filesList = join(dir, "files.txt");
    writeFileSync(filesList, "a.md\n");
    const output = runActionLint(["--files", filesList, "--repo-root", dir]);
    assert.equal(output.files.some((f) => f.bad === "컨텐츠"), true);
  });
});

// --- build-review.mjs: mdCode / fingerprint --------------------------------

test("mdCode가 백틱이 섞인 텍스트도 안전하게 감싼다", () => {
  assert.equal(mdCode("컨텐츠"), "`컨텐츠`");
  const withBacktick = mdCode("a`b");
  assert.ok(withBacktick.startsWith("``"));
  assert.ok(withBacktick.endsWith("``"));
  assert.ok(withBacktick.includes("a`b"));
});

test("지문은 file·rule·bad·줄 원문이 같으면 같고, 하나라도 다르면 다르다", () => {
  const base = { file: "a.md", ruleKey: "컨텐츠", bad: "컨텐츠", lineText: "이 컨텐츠를 확인합니다." };
  assert.equal(fingerprint(base), fingerprint({ ...base }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, file: "b.md" }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, bad: "리팩토링" }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, lineText: "다른 줄입니다" }));
  assert.match(fingerprint(base), /^[0-9a-f]{40}$/);
});

test("extractFingerprints가 한 코멘트에 실린 마커 여러 개를 모두 뽑는다", () => {
  const body = "<!-- kimchi-claude-lint:v1 fp=" + "a".repeat(40) + " -->\n<!-- kimchi-claude-lint:v1 fp=" + "b".repeat(40) + " -->\n내용";
  assert.deepEqual(extractFingerprints(body), ["a".repeat(40), "b".repeat(40)]);
  assert.deepEqual(extractFingerprints("마커 없음"), []);
});

// --- buildLineSuggestion ----------------------------------------------------

// 요구사항 11 회귀: 한 줄에 고칠 곳이 둘이면 둘 다(오른쪽부터) 반영한다
test("한 줄에 컨텐츠가 두 번 있으면 둘 다 고친 제안을 만든다", () => {
  const lineText = "이 컨텐츠와 저 컨텐츠를 정리합니다.";
  const first = lineText.indexOf("컨텐츠") + 1;
  const second = lineText.indexOf("컨텐츠", first) + 1;
  const group = [
    { bad: "컨텐츠", good: "콘텐츠", column: first, lineText, fixable: true, replacement: "콘텐츠", lineHasPii: false },
    { bad: "컨텐츠", good: "콘텐츠", column: second, lineText, fixable: true, replacement: "콘텐츠", lineHasPii: false },
  ];
  assert.equal(buildLineSuggestion(group), "이 콘텐츠와 저 콘텐츠를 정리합니다.");
});

// 요구사항 1 회귀: 줄에 주민등록번호가 있었으면 제안 자체를 만들지 않는다
test("주민등록번호가 있던 줄에는 suggestion을 절대 만들지 않는다", () => {
  const group = [
    {
      bad: "컨텐츠",
      good: "콘텐츠",
      column: 3,
      lineText: "이 컨텐츠에는 900101-*******가 있습니다.",
      fixable: true,
      replacement: "콘텐츠",
      lineHasPii: true,
    },
  ];
  assert.equal(buildLineSuggestion(group), null);
});

test("정규식 규칙만 있으면(고칠 것이 없으면) suggestion이 없다", () => {
  const group = [{ bad: "얇은 계약", good: "낮은 결합도", column: 1, lineText: "얇은 계약", fixable: false, lineHasPii: false }];
  assert.equal(buildLineSuggestion(group), null);
});

// --- isKimchiBot -------------------------------------------------------

// [보안 회귀] 요구사항 1: REST 와 GraphQL 이 같은 봇 계정을 다르게 표기한다
test("isKimchiBot이 REST·GraphQL 두 표기를 모두 인식한다", () => {
  assert.equal(isKimchiBot({ login: BOT_LOGIN }), true, "REST 표기");
  assert.equal(isKimchiBot(GRAPHQL_BOT_AUTHOR), true, "GraphQL 표기");
  assert.equal(isKimchiBot({ login: "github-actions" }), false, "__typename 없이는 봇으로 안 본다");
  assert.equal(isKimchiBot({ login: "human" }), false);
  assert.equal(isKimchiBot(null), false);
  assert.equal(isKimchiBot(undefined), false);
});

// --- buildComments / finalizeComment ------------------------------------

function pseudoFinding(overrides = {}) {
  return {
    file: "a.md",
    ruleKey: "컨텐츠",
    bad: "컨텐츠",
    good: "콘텐츠",
    reason: "외래어 표기법",
    check: "치환",
    lineText: "이 컨텐츠 확인",
    lineHasPii: false,
    pathHasPii: false,
    fixable: true,
    replacement: "콘텐츠",
    column: 3,
    ...overrides,
  };
}

test("diff 안의 줄은 인라인 코멘트로, 밖의 줄은 outOfDiff로 접는다", () => {
  const findings = [
    pseudoFinding({ line: 2 }),
    pseudoFinding({
      line: 99,
      bad: "리팩토링",
      good: "리팩터링",
      ruleKey: "리팩토링",
      lineText: "리팩토링",
      replacement: "리팩터링",
      column: 1,
    }),
  ];
  const patchByFile = new Map([["a.md", "@@ -1,1 +1,3 @@\n+첫 줄\n+이 컨텐츠 확인\n+마지막 줄"]]);
  const { comments, outOfDiff } = buildComments(findings, patchByFile);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].line, 2);
  assert.equal(comments[0].group.length, 1);
  assert.equal(comments[0].fingerprints.length, 1);
  assert.equal(outOfDiff.length, 1);
  assert.equal(outOfDiff[0].line, 99);

  // finalizeComment 로 실제 올릴 본문을 확정해야 suggestion·markers가 나온다
  const finalized = finalizeComment(comments[0], new Set());
  assert.match(finalized.body, /```suggestion\n이 콘텐츠 확인\n```/);
});

// [보안 회귀] 요구사항 4: 경로 자체에 PII가 있으면 diff 안에 있어도 인라인 코멘트를 달지 않는다
test("pathHasPii가 켜진 지적은 diff 안에 있어도 인라인 코멘트를 달지 않는다", () => {
  const findings = [pseudoFinding({ file: "900101-*******.md", line: 1, pathHasPii: true })];
  // patchByFile 에 이 표시용 경로로 걸어 둬도(=혹시 우연히 실제 경로와 같더라도)
  // pathHasPii 가 우선한다 — 애초에 patchByFile 조회 자체를 하지 않는다.
  const patchByFile = new Map([["900101-*******.md", "@@ -1,1 +1,1 @@\n+이 컨텐츠를 확인합니다."]]);
  const { comments, outOfDiff } = buildComments(findings, patchByFile);
  assert.deepEqual(comments, []);
  assert.equal(outOfDiff.length, 1);
});

// [회귀] 코멘트 그룹 중 일부만 새로 생겼으면, 새 지적만 마커·목록에 싣되 suggestion은
// 그 줄 전체(이미 올라간 것 포함)로 계산해야 실제로 적용 가능한 줄이 나온다.
test("finalizeComment는 이미 올라간 지적을 빼고 새 지적만 담는다(suggestion은 전체로)", () => {
  const existing = pseudoFinding({ bad: "컨텐츠", good: "콘텐츠", replacement: "콘텐츠", column: 3, lineText: "이 컨텐츠와 저 리팩토링" });
  const fresh = pseudoFinding({
    bad: "리팩토링",
    good: "리팩터링",
    ruleKey: "리팩토링",
    replacement: "리팩터링",
    column: 10,
    lineText: "이 컨텐츠와 저 리팩토링",
  });
  const group = [existing, fresh];
  const candidate = { path: "a.md", line: 1, side: "RIGHT", group, fingerprints: group.map(fingerprint) };

  const existingFps = new Set([fingerprint(existing)]);
  const finalized = finalizeComment(candidate, existingFps);

  assert.ok(finalized, "새 지적(리팩토링)이 있으니 코멘트를 올려야 한다");
  // 이미 올라간 "컨텐츠" 지적의 마커·목록 줄은 없어야 한다(중복 방지)
  assert.equal(finalized.body.includes(fingerprint(existing)), false);
  assert.equal(/컨텐츠.*→.*콘텐츠/.test(finalized.body), false, "이미 올라간 지적은 목록에 다시 싣지 않는다");
  assert.match(finalized.body, /리팩토링.*→.*리팩터링/);
  assert.equal(finalized.body.includes(fingerprint(fresh)), true);
  // suggestion은 그룹 전체(컨텐츠+리팩토링)를 반영한 최종 줄이어야 한다
  assert.match(finalized.body, /```suggestion\n이 콘텐츠와 저 리팩터링\n```/);
});

test("finalizeComment는 그룹 전체가 이미 올라가 있으면 null을 돌려준다(중복 게시 방지)", () => {
  const only = pseudoFinding();
  const candidate = { path: "a.md", line: 1, side: "RIGHT", group: [only], fingerprints: [fingerprint(only)] };
  assert.equal(finalizeComment(candidate, new Set([fingerprint(only)])), null);
});

// --- planReviewActions ---------------------------------------------------

function thread(id, comments, overrides = {}) {
  return { id, comments, isResolved: false, isOutdated: false, ...overrides };
}

/** planReviewActions 시험용 코멘트 후보 하나. group·fingerprints를 같이 만들어 둔다. */
function candidateFor(findings) {
  return { path: "a.md", line: 1, side: "RIGHT", group: findings, fingerprints: findings.map(fingerprint) };
}

test("이미 열려 있는 kimchi 스레드의 지문은 다시 올리지 않는다", () => {
  const finding = pseudoFinding();
  const fp1 = fingerprint(finding);
  const reviewThreads = [thread("t1", [{ author: GRAPHQL_BOT_AUTHOR, body: `<!-- kimchi-claude-lint:v1 fp=${fp1} -->\n지적` }])];
  const comments = [candidateFor([finding])];
  const { toPost } = planReviewActions({ reviewThreads, comments });
  assert.deepEqual(toPost, []);
});

test("새로 생긴 지적은 올린다", () => {
  const comments = [candidateFor([pseudoFinding()])];
  const { toPost } = planReviewActions({ reviewThreads: [], comments });
  assert.equal(toPost.length, 1);
});

test("사람이 연 스레드는 마커와 같은 글자가 있어도 기존 지문 집합에 넣지 않는다", () => {
  const finding = pseudoFinding();
  const fp1 = fingerprint(finding);
  const reviewThreads = [thread("t1", [{ author: { login: "human" }, body: `<!-- kimchi-claude-lint:v1 fp=${fp1} --> (사람이 인용함)` }])];
  const comments = [candidateFor([finding])];
  const { toPost } = planReviewActions({ reviewThreads, comments });
  assert.equal(toPost.length, 1, "사람이 연 스레드는 kimchi 스레드가 아니다");
});

// [보안 회귀] 요구사항 5: 이미 해결·낡은 스레드의 지문은 "이미 올라감"으로 세면 안 된다
test("해결되었거나 낡은 스레드의 지문은 dedup에 쓰지 않는다(되돌리기로 다시 나타나면 재게시)", () => {
  const finding = pseudoFinding();
  const fp1 = fingerprint(finding);
  const body = `<!-- kimchi-claude-lint:v1 fp=${fp1} -->`;
  const resolved = thread("t1", [{ author: GRAPHQL_BOT_AUTHOR, body }], { isResolved: true });
  const outdated = thread("t2", [{ author: GRAPHQL_BOT_AUTHOR, body }], { isOutdated: true });
  const comments = [candidateFor([finding])];
  assert.equal(planReviewActions({ reviewThreads: [resolved], comments }).toPost.length, 1);
  assert.equal(planReviewActions({ reviewThreads: [outdated], comments }).toPost.length, 1);
});

test("현재 findings에 없는 지문의 kimchi 스레드는 접는다", () => {
  const staleFp = "b".repeat(40);
  const currentFinding = pseudoFinding();
  const currentFp = fingerprint(currentFinding);
  const reviewThreads = [
    thread("thread-1", [{ author: GRAPHQL_BOT_AUTHOR, body: `<!-- kimchi-claude-lint:v1 fp=${staleFp} -->` }]),
    thread("thread-2", [{ author: GRAPHQL_BOT_AUTHOR, body: `<!-- kimchi-claude-lint:v1 fp=${currentFp} -->` }]),
    thread("thread-3", [{ author: { login: "human" }, body: "사람이 단 코멘트, 마커 없음" }]),
  ];
  const comments = [candidateFor([currentFinding])];
  const { toResolveThreadIds } = planReviewActions({ reviewThreads, comments });
  assert.deepEqual(toResolveThreadIds, ["thread-1"]);
});

// [보안 회귀] 요구사항 2: 사람이 답한 스레드는 지문이 사라져도 자동으로 접지 않는다
test("사람이 답을 남긴 스레드는 지문이 사라져도 접지 않는다(진행 중인 논의)", () => {
  const staleFp = "b".repeat(40);
  const reviewThreads = [
    thread("thread-discuss", [
      { author: GRAPHQL_BOT_AUTHOR, body: `<!-- kimchi-claude-lint:v1 fp=${staleFp} -->` },
      { author: { login: "reviewer" }, body: "이 부분은 일부러 이렇게 썼습니다 — 논의 중" },
    ]),
  ];
  const { toResolveThreadIds } = planReviewActions({ reviewThreads, comments: [] });
  assert.deepEqual(toResolveThreadIds, []);
});

test("가짜 마커를 포함한 사람의 코멘트가 첫 코멘트인 스레드는 접지 않는다", () => {
  const fakeFp = "d".repeat(40);
  const reviewThreads = [
    thread("thread-fake", [{ author: { login: "human" }, body: `<!-- kimchi-claude-lint:v1 fp=${fakeFp} --> (인용)` }]),
  ];
  const { toResolveThreadIds } = planReviewActions({ reviewThreads, comments: [] });
  assert.deepEqual(toResolveThreadIds, [], "첫 코멘트가 사람이면 kimchi 스레드가 아니다");
});

test("reviewsToMinimize는 kimchi 리뷰만, 사람 리뷰는 건드리지 않는다(REST·GraphQL 표기 모두)", () => {
  const reviews = [
    { id: "r1", author: { login: BOT_LOGIN }, body: `${REVIEW_MARKER}\n찾은 것 있음` },
    { id: "r2", author: GRAPHQL_BOT_AUTHOR, body: `${REVIEW_MARKER}\n찾은 것 있음(GraphQL 표기)` },
    { id: "r3", author: { login: "human" }, body: `${REVIEW_MARKER}\n가짜` },
    { id: "r4", author: { login: BOT_LOGIN }, body: "마커 없는 다른 리뷰" },
  ];
  assert.deepEqual(reviewsToMinimize(reviews), ["r1", "r2"]);
});

// --- buildReviewBody / buildStickyBody -------------------------------------

test("리뷰 본문은 짧고 sticky를 가리킨다", () => {
  const findings = { files: [{ bad: "컨텐츠" }], commits: [], prText: { title: [], body: [] }, pii: [] };
  const body = buildReviewBody(findings);
  assert.match(body, /sticky/);
  assert.ok(body.length < 300);
  assert.ok(body.startsWith(REVIEW_MARKER));
});

test("걸리는 것이 없으면 sticky 본문이 그렇게 말한다", () => {
  const findings = { files: [], commits: [], prText: { title: [], body: [] }, pii: [] };
  assert.match(buildStickyBody(findings, []), /걸리는 표현이 없습니다/);
});

// 요구사항 2 회귀: sticky 본문의 PII 목록도 가려진 값만 싣는다
test("sticky 본문의 주민등록번호 목록은 가려진 값만 싣는다", () => {
  const findings = {
    files: [],
    commits: [],
    prText: { title: [], body: [] },
    pii: [{ file: "a.md", line: 1, column: 1, masked: "900101-*******", label: "a.md" }],
  };
  const body = buildStickyBody(findings, []);
  assert.match(body, /900101-\*{7}/);
  assert.equal(/1234567/.test(body), false);
});

test("diff 밖 지적도 sticky 본문에 파일 경로와 함께 나온다", () => {
  const findings = { files: [], commits: [], prText: { title: [], body: [] }, pii: [] };
  const outOfDiff = [{ file: "a.md", line: 99, bad: "리팩토링", good: "리팩터링", reason: "" }];
  const body = buildStickyBody(findings, outOfDiff);
  assert.match(body, /a\.md:99/);
});
