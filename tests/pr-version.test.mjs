import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTempDir, ROOT } from "./helpers.mjs";
import {
  parseVersion,
  compareSemver,
  nextVersion,
  subjectMatchesVersion,
  subjectFromRange,
  checkPrVersion,
  eulReulFor,
  parseDependabotTitle,
  sentenceFromDependabotTitle,
  buildDependabotSubject,
  bumpVersionInText,
  bumpVersionFiles,
  needsBump,
  isStaleAgainstDevelop,
  roParticleForVersion,
} from "../scripts/pr-version.mjs";

test("parseVersion 은 x.y.z 형식만 받아들인다", () => {
  assert.deepEqual(parseVersion("0.21.4"), { major: 0, minor: 21, patch: 4 });
  assert.equal(parseVersion("0.21"), null);
  assert.equal(parseVersion("v0.21.4"), null);
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion(undefined), null);
});

test("compareSemver 는 자릿수마다 비교하고, 형식이 아니면 null", () => {
  assert.ok(compareSemver("0.21.5", "0.21.4") > 0);
  assert.ok(compareSemver("0.21.4", "0.21.5") < 0);
  assert.equal(compareSemver("0.21.4", "0.21.4"), 0);
  assert.ok(compareSemver("0.22.0", "0.21.9") > 0);
  assert.ok(compareSemver("1.0.0", "0.99.99") > 0);
  assert.equal(compareSemver("x", "0.21.4"), null);
});

test("nextVersion 은 patch/minor 를 올바르게 올린다", () => {
  assert.equal(nextVersion("0.21.4", "patch"), "0.21.5");
  assert.equal(nextVersion("0.21.4", "minor"), "0.22.0");
  assert.throws(() => nextVersion("0.21.4", "major"));
  assert.throws(() => nextVersion("bad", "patch"));
});

test("subjectMatchesVersion 은 형식과 버전이 둘 다 맞을 때만 참", () => {
  assert.equal(subjectMatchesVersion("0.21.5 — 무언가를 했습니다", "0.21.5"), true);
  assert.equal(subjectMatchesVersion("0.21.4 — 무언가를 했습니다", "0.21.5"), false);
  assert.equal(subjectMatchesVersion("0.21.5 무언가를 했습니다", "0.21.5"), false); // 대시 없음
  assert.equal(subjectMatchesVersion("merge: feature/x", "0.21.5"), false);
  // 여러 줄이 와도 첫 줄만 본다(커밋 본문이 이어 붙은 경우).
  assert.equal(subjectMatchesVersion("0.21.5 — 무언가를 했습니다\n\n본문 설명", "0.21.5"), true);
});

// ── subjectFromRange: 실제 git 저장소로 병합 커밋을 걸러내는지 본다 ──────────

/** 임시 git 저장소를 만들어 fn에 넘기고, 끝나면 지운다. execFileSync만 쓴다(셸 없음). */
function withGitRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-pr-version-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  return fn(dir, git);
}

test("subjectFromRange 는 병합 커밋을 건너뛰고 그 앞의 단위 커밋 제목을 낸다", () => {
  withGitRepo((dir, git) => {
    writeFileSync(join(dir, "f.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base commit");
    const baseSha = git("rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "f.txt"), "b\n");
    git("add", "-A");
    git("commit", "-q", "-m", "0.21.5 — 단위 커밋입니다");
    const unitSha = git("rev-parse", "HEAD").trim();
    const treeSha = git("rev-parse", "HEAD^{tree}").trim();

    // HEAD가 병합 커밋인 채로 확인이 도는 실제 모양(reviewer 지적 1) — develop을
    // feature로 병합해 들여오면 마지막 커밋이 "merge: ..."가 된다. 이 병합이 실제로는
    // 새로 들여오는 것이 없어도(둘째 부모가 이미 base의 조상이라 range에 안 잡혀도)
    // 그 앞의 단위 커밋(unitSha) 제목을 찾아내야 한다. commit-tree로 부모 둘 다
    // 직접 지정해 브랜치를 나누지 않고도 이 모양을 그대로 만든다.
    const mergeSha = execFileSync(
      "git",
      ["commit-tree", treeSha, "-p", unitSha, "-p", baseSha, "-m", "merge: develop into feature/x"],
      { cwd: dir, encoding: "utf8" }
    ).trim();

    assert.deepEqual(subjectFromRange(dir, baseSha, unitSha), { subject: "0.21.5 — 단위 커밋입니다", error: null });
    assert.deepEqual(subjectFromRange(dir, baseSha, mergeSha), { subject: "0.21.5 — 단위 커밋입니다", error: null });
  });
});

test("subjectFromRange 는 범위 안에 단위 커밋이 없으면(병합만 있으면) null", () => {
  withGitRepo((dir, git) => {
    writeFileSync(join(dir, "f.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "root commit");
    const rootSha = git("rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "f.txt"), "b\n");
    git("add", "-A");
    git("commit", "-q", "-m", "0.21.4 — 기준 커밋입니다");
    const baseSha = git("rev-parse", "HEAD").trim();
    const treeSha = git("rev-parse", "HEAD^{tree}").trim();

    // 둘째 부모(rootSha)가 이미 baseSha의 조상이라 아무것도 새로 안 들여오는 병합을
    // 만든다 — 이미 병합된 브랜치를 실수로 다시 병합하는 등 실제로 일어날 수 있는
    // 모양이다. 부모가 둘(unitSha 없이 rootSha·baseSha)인 진짜 병합 커밋이라
    // --no-merges가 이 커밋 자체를 거르고, base..merge 범위에는 이 병합 말고 아무것도
    // 없으니(rootSha는 base의 조상이라 범위 밖) 남는 제목이 없다.
    const mergeSha = execFileSync(
      "git",
      ["commit-tree", treeSha, "-p", baseSha, "-p", rootSha, "-m", "merge: redundant merge"],
      { cwd: dir, encoding: "utf8" }
    ).trim();

    // 범위가 진짜로 비어 있다 — git이 실패한 게 아니라 확인한 결과 아무것도 없다는
    // 뜻이라 error는 null이어야 한다(reviewer 지적 2 — 이 둘을 구분한다).
    assert.deepEqual(subjectFromRange(dir, baseSha, mergeSha), { subject: null, error: null });
  });
});

test("subjectFromRange 는 sha를 못 찾으면(얕은 클론·잘못된 sha) error를 낸다 — null로 조용히 넘어가지 않는다", () => {
  withGitRepo((dir, git) => {
    writeFileSync(join(dir, "f.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base commit");
    const baseSha = git("rev-parse", "HEAD").trim();

    // 저장소는 있지만 head sha가 존재하지 않는다 — "범위가 비었다"가 아니라 "범위
    // 자체를 못 읽었다"다. 조용히 null만 돌려주면 확인 인프라가 고장 난 채로 검사가
    // 통과해 버린다.
    const result = subjectFromRange(dir, baseSha, "f".repeat(40));
    assert.equal(result.subject, null);
    assert.match(result.error, /git log이 실패했습니다/);
  });
});

test("subjectFromRange 는 저장소 자체가 없어도 error를 낸다", () => {
  withTempDir((dir) => {
    const result = subjectFromRange(dir, "0".repeat(40), "1".repeat(40));
    assert.equal(result.subject, null);
    assert.match(result.error, /git log이 실패했습니다/);
  });
});

test("checkPrVersion 은 정상 상태를 통과시킨다", () => {
  const result = checkPrVersion({
    headPkgVersion: "0.21.5",
    headPluginVersion: "0.21.5",
    basePkgVersion: "0.21.4",
    subjects: [{ label: "마지막 단위 커밋 제목", text: "0.21.5 — 무언가를 했습니다" }],
  });
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("checkPrVersion 은 두 파일 버전이 다르면 잡는다", () => {
  const result = checkPrVersion({
    headPkgVersion: "0.21.5",
    headPluginVersion: "0.21.4",
    subjects: [{ label: "c", text: "0.21.5 — 문장" }],
  });
  assert.ok(result.problems.some((p) => p.code === "version-mismatch"));
  assert.equal(result.ok, false);
});

test("checkPrVersion 은 head가 base보다 크지 않으면 잡는다", () => {
  const same = checkPrVersion({
    headPkgVersion: "0.21.4",
    headPluginVersion: "0.21.4",
    basePkgVersion: "0.21.4",
    subjects: [{ label: "c", text: "0.21.4 — 문장" }],
  });
  assert.ok(same.problems.some((p) => p.code === "version-not-bumped"));

  const behind = checkPrVersion({
    headPkgVersion: "0.21.3",
    headPluginVersion: "0.21.3",
    basePkgVersion: "0.21.4",
    subjects: [{ label: "c", text: "0.21.3 — 문장" }],
  });
  assert.ok(behind.problems.some((p) => p.code === "version-not-bumped"));
});

test("checkPrVersion 은 base가 없으면 크기 비교를 건너뛴다", () => {
  const result = checkPrVersion({
    headPkgVersion: "0.21.4",
    headPluginVersion: "0.21.4",
    subjects: [{ label: "c", text: "0.21.4 — 문장" }],
  });
  assert.equal(result.problems.some((p) => p.code === "version-not-bumped"), false);
});

test("checkPrVersion 은 형식에 맞는 제목이 없으면 잡는다", () => {
  const result = checkPrVersion({
    headPkgVersion: "0.21.5",
    headPluginVersion: "0.21.5",
    subjects: [{ label: "마지막 단위 커밋 제목", text: "ci: bump actions/checkout" }],
  });
  assert.ok(result.problems.some((p) => p.code === "subject-format"));
});

test("checkPrVersion 은 제목 후보 여러 개 중 하나만 맞아도 통과한다", () => {
  const result = checkPrVersion({
    headPkgVersion: "0.21.5",
    headPluginVersion: "0.21.5",
    subjects: [
      { label: "PR 제목", text: "임의의 PR 제목" },
      { label: "마지막 단위 커밋 제목", text: "0.21.5 — 무언가를 했습니다" },
    ],
  });
  assert.equal(result.ok, true);
});

test("checkPrVersion 은 버전 형식 자체가 틀리면 다른 검사를 건너뛰고 바로 문제로 낸다", () => {
  const result = checkPrVersion({ headPkgVersion: "bad", headPluginVersion: "bad", subjects: [] });
  assert.deepEqual(
    result.problems.map((p) => p.code),
    ["invalid-version"]
  );
});

test("checkPrVersion 은 확인할 제목 후보가 하나도 없으면(병합 커밋만 있으면) 제목은 안 보고 버전만 본다", () => {
  const result = checkPrVersion({
    headPkgVersion: "0.21.5",
    headPluginVersion: "0.21.5",
    basePkgVersion: "0.21.4",
    subjects: [],
  });
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("checkPrVersion 은 base가 main이면(릴리스 PR) 제목 형식을 안 보고 버전만 본다", () => {
  const okWithBadSubject = checkPrVersion({
    headPkgVersion: "0.22.0",
    headPluginVersion: "0.22.0",
    basePkgVersion: "0.21.9",
    baseRef: "main",
    subjects: [{ label: "마지막 단위 커밋 제목", text: "merge: feature/x" }],
  });
  assert.deepEqual(okWithBadSubject, { ok: true, problems: [] });

  // main으로 가도 버전 자체는 여전히 본다.
  const stillChecksVersion = checkPrVersion({
    headPkgVersion: "0.21.9",
    headPluginVersion: "0.21.9",
    basePkgVersion: "0.21.9",
    baseRef: "main",
    subjects: [],
  });
  assert.ok(stillChecksVersion.problems.some((p) => p.code === "version-not-bumped"));
});

test("eulReulFor 는 발음 사전에 있는 낱말만 판정한다", () => {
  assert.equal(eulReulFor("actions/checkout"), "을"); // 체크아웃 — ㅅ 받침
  assert.equal(eulReulFor("checkout"), "을");
  assert.equal(eulReulFor("cache"), "를"); // 캐시 — 받침 없음
  assert.equal(eulReulFor("actions/setup-node"), null); // 모르는 낱말 — 판정하지 않는다
});

test("roParticleForVersion 은 버전 문자열의 마지막 숫자로 로/으로를 고른다", () => {
  assert.equal(roParticleForVersion("8"), "로"); // 팔 — ㄹ 받침(짧은 형)
  assert.equal(roParticleForVersion("7"), "로"); // 칠 — ㄹ 받침
  assert.equal(roParticleForVersion("5"), "로"); // 오 — 받침 없음
  assert.equal(roParticleForVersion("0"), "으로"); // 영/공 — ㅇ 받침(긴 형)
  assert.equal(roParticleForVersion("3.27.0"), "으로"); // 마지막 숫자만 본다 — 영
  assert.equal(roParticleForVersion("3.27.5"), "로"); // 마지막 숫자만 본다 — 오
  assert.equal(roParticleForVersion("main"), "로"); // 숫자가 없으면 판정하지 않고 짧은 형으로 물러난다
});

test("sentenceFromDependabotTitle 은 도착 버전의 받침에 맞춰 로/으로를 가른다", () => {
  assert.match(sentenceFromDependabotTitle("Bump x/y from 1 to 8"), /v8로 올렸습니다/);
  assert.match(sentenceFromDependabotTitle("Bump x/y from 1 to 10"), /v10으로 올렸습니다/); // 십 — ㅂ 받침
});

test("parseDependabotTitle 은 세 가지 실제 모양을 가른다", () => {
  assert.deepEqual(parseDependabotTitle("Bump actions/checkout from 7 to 8"), {
    kind: "single",
    name: "actions/checkout",
    from: "7",
    to: "8",
    directory: null,
  });
  assert.deepEqual(parseDependabotTitle("Bump the actions group with 3 updates"), {
    kind: "group",
    name: "actions",
    directories: null,
    count: 3,
  });
  assert.deepEqual(parseDependabotTitle("Bump actions/setup-node from 4.0.0 to 5.0.0 in /sub"), {
    kind: "single",
    name: "actions/setup-node",
    from: "4.0.0",
    to: "5.0.0",
    directory: "/sub",
  });
  assert.equal(parseDependabotTitle("전혀 다른 제목").kind, "unknown");
});

// 이 저장소의 실제 이력에 있는 제목 그대로다(`git log --author=dependabot --oneline`:
// 569b6b6, ea3df98). dependabot.yml의 `commit-message.prefix: "ci"`가 conventional-commits
// 접두사를 붙이고, Bump도 소문자로 내려간다 — "Bump"만 받으면 이 실제 모양을 놓친다.
test("parseDependabotTitle 은 실제 이력의 conventional-commits 접두사가 붙은 제목도 가른다", () => {
  assert.deepEqual(parseDependabotTitle("ci: bump the actions group with 3 updates"), {
    kind: "group",
    name: "actions",
    directories: null,
    count: 3,
  });
  assert.deepEqual(parseDependabotTitle("ci: bump the actions group with 2 updates"), {
    kind: "group",
    name: "actions",
    directories: null,
    count: 2,
  });
  assert.deepEqual(parseDependabotTitle("ci: bump actions/checkout from 5 to 7"), {
    kind: "single",
    name: "actions/checkout",
    from: "5",
    to: "7",
    directory: null,
  });
  // scope나 breaking 표시가 붙어도 받는다.
  assert.equal(parseDependabotTitle("ci(actions)!: bump actions/checkout from 5 to 7").kind, "single");
});

test("sentenceFromDependabotTitle 은 읽는 법을 아는 이름에는 조사를 바로 붙인다", () => {
  assert.equal(
    sentenceFromDependabotTitle("Bump actions/checkout from 7 to 8"),
    "GitHub Actions의 actions/checkout을 v7에서 v8로 올렸습니다"
  );
});

test("sentenceFromDependabotTitle 은 실제 이력의 제목으로도 자연스러운 문장을 낸다", () => {
  assert.equal(
    sentenceFromDependabotTitle("ci: bump the actions group with 3 updates"),
    "actions 그룹의 GitHub Actions 3개 버전을 올렸습니다"
  );
});

test("sentenceFromDependabotTitle 은 디렉터리가 저장소 루트(/)면 덧붙이지 않는다", () => {
  assert.equal(
    sentenceFromDependabotTitle("Bump actions/checkout from 7 to 8 in /"),
    "GitHub Actions의 actions/checkout을 v7에서 v8로 올렸습니다"
  );
  assert.match(
    sentenceFromDependabotTitle("Bump actions/checkout from 7 to 8 in /packages/api"),
    /\(\/packages\/api\)$/
  );
});

test("sentenceFromDependabotTitle 은 모르는 이름 뒤에는 조사를 피해 간다", () => {
  const sentence = sentenceFromDependabotTitle("Bump actions/setup-node from 4 to 5");
  assert.match(sentence, /actions\/setup-node 버전을/);
  assert.doesNotMatch(sentence, /actions\/setup-node(을|를)/);
});

test("sentenceFromDependabotTitle 은 못 알아본 제목에서 안전한 문장으로 물러난다", () => {
  assert.equal(sentenceFromDependabotTitle("이상한 제목"), "GitHub Actions 버전을 최신으로 올렸습니다");
});

test("buildDependabotSubject 는 버전과 문장을 합친다", () => {
  assert.equal(
    buildDependabotSubject("0.21.5", "Bump actions/checkout from 7 to 8"),
    "0.21.5 — GitHub Actions의 actions/checkout을 v7에서 v8로 올렸습니다"
  );
});

test("bumpVersionInText 는 버전 문자열만 바꾸고 나머지는 그대로 둔다", () => {
  const original = '{\n  "name": "x",\n  "version": "0.21.4",\n  "private": true\n}\n';
  const updated = bumpVersionInText(original, "0.21.4", "0.21.5");
  assert.equal(updated, '{\n  "name": "x",\n  "version": "0.21.5",\n  "private": true\n}\n');
  // 버전 값 말고는 바이트 단위로 같아야 한다.
  assert.equal(updated.replace("0.21.5", "0.21.4"), original);
});

test("bumpVersionInText 는 현재 버전이 예상과 다르면 조용히 넘어가지 않는다", () => {
  const original = '{"version": "0.21.3"}';
  assert.throws(() => bumpVersionInText(original, "0.21.4", "0.21.5"), /예상과 다릅니다/);
});

test("bumpVersionInText 는 version 필드가 없거나 여럿이면 던진다", () => {
  assert.throws(() => bumpVersionInText("{}", "0.21.4", "0.21.5"), /찾지 못했습니다/);
  assert.throws(
    () => bumpVersionInText('{"version":"0.21.4","nested":{"version":"0.21.4"}}', "0.21.4", "0.21.5"),
    /두 번 이상/
  );
});

test("bumpVersionFiles(baseVersion 없이) 는 두 파일을 같은 다음 버전으로 바꾸고 포맷을 보존한다", () => {
  withTempDir((dir) => {
    const pkgPath = join(dir, "package.json");
    const pluginPath = join(dir, "plugin.json");
    const pkgText = '{\n  "name": "kimchi-claude",\n  "version": "0.21.4"\n}\n';
    const pluginText = '{\n  "name": "kimchi-claude",\n  "version": "0.21.4",\n  "author": {}\n}\n';
    writeFileSync(pkgPath, pkgText);
    writeFileSync(pluginPath, pluginText);

    const result = bumpVersionFiles({ pkgPath, pluginPath, level: "patch" });

    assert.equal(result.oldVersion, "0.21.4");
    assert.equal(result.newVersion, "0.21.5");
    assert.equal(result.skipped, false);

    const newPkgText = readFileSync(pkgPath, "utf8");
    const newPluginText = readFileSync(pluginPath, "utf8");
    assert.equal(newPkgText, pkgText.replace("0.21.4", "0.21.5"));
    assert.equal(newPluginText, pluginText.replace("0.21.4", "0.21.5"));
  });
});

test("bumpVersionFiles(baseVersion 없이) 는 두 파일의 현재 버전이 이미 다르면 아무것도 쓰지 않는다", () => {
  withTempDir((dir) => {
    const pkgPath = join(dir, "package.json");
    const pluginPath = join(dir, "plugin.json");
    writeFileSync(pkgPath, '{"version": "0.21.5"}');
    writeFileSync(pluginPath, '{"version": "0.21.4"}');

    assert.throws(() => bumpVersionFiles({ pkgPath, pluginPath, level: "patch" }), /이미 다릅니다/);
    assert.equal(readFileSync(pkgPath, "utf8"), '{"version": "0.21.5"}');
    assert.equal(readFileSync(pluginPath, "utf8"), '{"version": "0.21.4"}');
  });
});

// ── bumpVersionFiles(baseVersion 지정) — max(base, head)에서 올린다 ──────────

test("bumpVersionFiles 는 baseVersion을 주면 head가 아니라 base에서 다음 버전을 계산한다", () => {
  withTempDir((dir) => {
    const pkgPath = join(dir, "package.json");
    const pluginPath = join(dir, "plugin.json");
    // head 쪽 파일은 아직 base와 같다(Dependabot이 손대지 않은 최초 상태).
    writeFileSync(pkgPath, '{"version": "0.21.4"}');
    writeFileSync(pluginPath, '{"version": "0.21.4"}');

    const result = bumpVersionFiles({ pkgPath, pluginPath, level: "patch", baseVersion: "0.21.4" });
    assert.equal(result.skipped, false);
    assert.equal(result.newVersion, "0.21.5");
    assert.equal(JSON.parse(readFileSync(pkgPath, "utf8")).version, "0.21.5");
  });
});

test("bumpVersionFiles 는 head가 이미 base를 앞서 있고 두 파일이 같으면 아무것도 안 하고 skipped를 낸다", () => {
  withTempDir((dir) => {
    const pkgPath = join(dir, "package.json");
    const pluginPath = join(dir, "plugin.json");
    writeFileSync(pkgPath, '{"version": "0.21.5"}');
    writeFileSync(pluginPath, '{"version": "0.21.5"}');

    const result = bumpVersionFiles({ pkgPath, pluginPath, level: "patch", baseVersion: "0.21.4" });
    assert.equal(result.skipped, true);
    assert.equal(result.newVersion, "0.21.5"); // 바뀌지 않았다
    // 파일에 손대지 않았다(바이트 그대로).
    assert.equal(readFileSync(pkgPath, "utf8"), '{"version": "0.21.5"}');
    assert.equal(readFileSync(pluginPath, "utf8"), '{"version": "0.21.5"}');
  });
});

test("bumpVersionFiles 는 두 파일이 어긋나 있으면(누가 하나만 손댔으면) head를 믿지 않고 base에서 다시 올린다", () => {
  withTempDir((dir) => {
    const pkgPath = join(dir, "package.json");
    const pluginPath = join(dir, "plugin.json");
    // package.json만 실수로 올라가 있고 plugin.json은 그대로인 상태.
    writeFileSync(pkgPath, '{"version": "0.21.5"}');
    writeFileSync(pluginPath, '{"version": "0.21.4"}');

    const result = bumpVersionFiles({ pkgPath, pluginPath, level: "patch", baseVersion: "0.21.4" });
    assert.equal(result.skipped, false);
    assert.equal(result.newVersion, "0.21.5"); // base(0.21.4) + 1, head(0.21.5)를 그대로 믿지 않는다
    assert.equal(JSON.parse(readFileSync(pkgPath, "utf8")).version, "0.21.5");
    assert.equal(JSON.parse(readFileSync(pluginPath, "utf8")).version, "0.21.5");
  });
});

test("bumpVersionFiles 는 head가 base보다 뒤처져 있으면(리베이스로 되돌아간 경우) base에서 다시 올린다", () => {
  withTempDir((dir) => {
    const pkgPath = join(dir, "package.json");
    const pluginPath = join(dir, "plugin.json");
    writeFileSync(pkgPath, '{"version": "0.21.3"}');
    writeFileSync(pluginPath, '{"version": "0.21.3"}');

    const result = bumpVersionFiles({ pkgPath, pluginPath, level: "patch", baseVersion: "0.21.4" });
    assert.equal(result.skipped, false);
    assert.equal(result.newVersion, "0.21.5");
  });
});

const PR_VERSION = join(ROOT, "scripts", "pr-version.mjs");

test("CLI check 는 문제가 없으면 exitCode 0, JSON을 낸다", () => {
  const stdout = execFileSync("node", [
    PR_VERSION,
    "check",
    "--head-pkg-version",
    "0.21.5",
    "--head-plugin-version",
    "0.21.5",
    "--base-pkg-version",
    "0.21.4",
    "--commit-subject",
    "0.21.5 — 테스트용 문장입니다",
  ]).toString();
  assert.deepEqual(JSON.parse(stdout), { ok: true, problems: [] });
});

test("CLI check 는 문제가 있으면 exitCode 1로 실패하고 ::error:: 를 낸다", () => {
  assert.throws(
    () => {
      execFileSync("node", [
        PR_VERSION,
        "check",
        "--head-pkg-version",
        "0.21.5",
        "--head-plugin-version",
        "0.21.4",
        "--commit-subject",
        "형식이 아닌 제목",
      ]);
    },
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stdout.toString(), /::error::/);
      return true;
    }
  );
});

test("CLI check 는 --base-ref main 이면 형식이 아닌 제목이어도 통과한다(릴리스 PR)", () => {
  const stdout = execFileSync("node", [
    PR_VERSION,
    "check",
    "--head-pkg-version",
    "0.22.0",
    "--head-plugin-version",
    "0.22.0",
    "--base-pkg-version",
    "0.21.9",
    "--base-ref",
    "main",
    "--commit-subject",
    "merge: feature/x",
  ]).toString();
  assert.deepEqual(JSON.parse(stdout), { ok: true, problems: [] });
});

test("CLI check 는 --base-sha/--head-sha로 실제 저장소에서 제목을 직접 읽는다(셸에 값을 붙여넣지 않는다)", () => {
  withGitRepo((dir, git) => {
    writeFileSync(join(dir, "f.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base commit");
    const baseSha = git("rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "f.txt"), "b\n");
    git("add", "-A");
    git("commit", "-q", "-m", "0.21.5 — 테스트용 문장입니다");
    const headSha = git("rev-parse", "HEAD").trim();

    const stdout = execFileSync("node", [
      PR_VERSION,
      "check",
      "--head-pkg-version",
      "0.21.5",
      "--head-plugin-version",
      "0.21.5",
      "--base-pkg-version",
      "0.21.4",
      "--base-sha",
      baseSha,
      "--head-sha",
      headSha,
      "--repo-root",
      dir,
    ]).toString();
    assert.deepEqual(JSON.parse(stdout), { ok: true, problems: [] });
  });
});

test("CLI check 는 head-sha를 못 찾으면(범위를 못 읽으면) ::warning::을 내고 실패한다(빈 범위와 다르다)", () => {
  withGitRepo((dir, git) => {
    writeFileSync(join(dir, "f.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base commit");
    const baseSha = git("rev-parse", "HEAD").trim();

    assert.throws(
      () => {
        execFileSync("node", [
          PR_VERSION,
          "check",
          "--head-pkg-version",
          "0.21.5",
          "--head-plugin-version",
          "0.21.5",
          "--base-pkg-version",
          "0.21.4",
          "--base-sha",
          baseSha,
          "--head-sha",
          "f".repeat(40),
          "--repo-root",
          dir,
        ]);
      },
      (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stdout.toString(), /::warning::git log이 실패했습니다/);
        assert.equal(JSON.parse(err.stdout.toString().split("\n").slice(1).join("\n")).ok, false);
        return true;
      }
    );
  });
});

test("CLI bump 는 두 파일을 실제로 고치고 subject를 낸다", () => {
  withTempDir((dir) => {
    const pkgPath = join(dir, "package.json");
    const pluginPath = join(dir, "plugin.json");
    writeFileSync(pkgPath, '{\n  "version": "0.21.4"\n}\n');
    writeFileSync(pluginPath, '{\n  "version": "0.21.4"\n}\n');

    const stdout = execFileSync("node", [
      PR_VERSION,
      "bump",
      "--level",
      "patch",
      "--pkg",
      pkgPath,
      "--plugin",
      pluginPath,
      "--subject-from-dependabot",
      "Bump actions/checkout from 7 to 8",
    ]).toString();

    const result = JSON.parse(stdout);
    assert.equal(result.newVersion, "0.21.5");
    assert.equal(result.subject, "0.21.5 — GitHub Actions의 actions/checkout을 v7에서 v8로 올렸습니다");
    assert.equal(readFileSync(pkgPath, "utf8"), '{\n  "version": "0.21.5"\n}\n');
  });
});

test("CLI bump 는 --base-version을 주면 이미 앞서 있을 때 아무것도 안 하고 subject를 null로 낸다", () => {
  withTempDir((dir) => {
    const pkgPath = join(dir, "package.json");
    const pluginPath = join(dir, "plugin.json");
    writeFileSync(pkgPath, '{"version": "0.21.5"}');
    writeFileSync(pluginPath, '{"version": "0.21.5"}');

    const stdout = execFileSync("node", [
      PR_VERSION,
      "bump",
      "--level",
      "patch",
      "--pkg",
      pkgPath,
      "--plugin",
      pluginPath,
      "--base-version",
      "0.21.4",
      "--subject-from-dependabot",
      "Bump actions/checkout from 7 to 8",
    ]).toString();

    const result = JSON.parse(stdout);
    assert.equal(result.skipped, true);
    assert.equal(result.subject, null);
    assert.equal(readFileSync(pkgPath, "utf8"), '{"version": "0.21.5"}'); // 안 건드렸다
  });
});

test("CLI needs-bump 는 true/false 텍스트만 한 줄 낸다", () => {
  const yes = execFileSync("node", [
    PR_VERSION,
    "needs-bump",
    "--base-pkg-version",
    "0.21.4",
    "--head-pkg-version",
    "0.21.4",
    "--head-plugin-version",
    "0.21.4",
  ])
    .toString()
    .trim();
  assert.equal(yes, "true");

  const no = execFileSync("node", [
    PR_VERSION,
    "needs-bump",
    "--base-pkg-version",
    "0.21.4",
    "--head-pkg-version",
    "0.21.5",
    "--head-plugin-version",
    "0.21.5",
  ])
    .toString()
    .trim();
  assert.equal(no, "false");
});

test("needsBump 는 head가 base를 앞서면 더 손볼 것이 없다고 본다(멱등성)", () => {
  assert.equal(needsBump("0.21.4", "0.21.5", "0.21.5"), false);
  assert.equal(needsBump("0.21.4", "0.21.4", "0.21.4"), true); // 아직 안 올림
  assert.equal(needsBump("0.21.4", "0.21.5", "0.21.4"), true); // 두 파일이 어긋남 — 손볼 것이 있다
  assert.equal(needsBump("0.21.4", "bad", "bad"), true); // 형식이 이상하면 조용히 넘기지 않는다
});

test("isStaleAgainstDevelop 은 head가 develop을 못 앞서면 뒤처졌다고 본다", () => {
  assert.equal(isStaleAgainstDevelop("0.22.0", "0.21.5"), true); // develop이 이미 더 앞섰다
  assert.equal(isStaleAgainstDevelop("0.22.0", "0.22.0"), true); // 같으면 아직 안 올린 것과 같다
  assert.equal(isStaleAgainstDevelop("0.22.0", "0.23.0"), false); // Dependabot PR이 이미 앞섰다
  assert.equal(isStaleAgainstDevelop("0.22.0", "bad"), true); // 형식이 이상하면 안전하게 뒤처졌다고 본다
});

test("CLI is-stale 는 true/false 텍스트만 한 줄 낸다", () => {
  const stale = execFileSync("node", [
    PR_VERSION,
    "is-stale",
    "--develop-version",
    "0.22.0",
    "--head-version",
    "0.21.5",
  ])
    .toString()
    .trim();
  assert.equal(stale, "true");

  const fresh = execFileSync("node", [
    PR_VERSION,
    "is-stale",
    "--develop-version",
    "0.22.0",
    "--head-version",
    "0.23.0",
  ])
    .toString()
    .trim();
  assert.equal(fresh, "false");
});
