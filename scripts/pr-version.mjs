#!/usr/bin/env node
// .github/workflows/pr-version.yml 이 부르는 오프라인 계산이다(불변식 10 — 네트워크도,
// npm 의존성도 없다). AGENTS.md의 규칙("모든 단위 커밋은 package.json 과
// .claude-plugin/plugin.json 버전을 함께 올리고, 제목은 `0.x.y — <합니다체 한 문장>`
// 형식이다")을 사람이 손으로 확인하던 것을 대신한다.
//
// 네 가지 일을 한다.
//   check      — 버전·형식이 규칙에 맞는지 보고 문제만 늘어놓는다(고치지 않는다).
//   bump       — Dependabot PR처럼 버전이 아직 안 올라간 곳에서 다음 버전을 계산해 두
//                파일에 쓰고, 제목 문장까지 만들어 낸다.
//   needs-bump — bump가 다시 할 일이 있는지만 본다(워크플로가 셸에서 변수만으로
//                판정하려다 신뢰할 수 없는 값을 `node -e` 소스에 그대로 붙여 넣는 사고를
//                막는다 — 이 서브커맨드가 그 배관을 대신한다).
//   is-stale   — develop이 앞서가서 열려 있는 Dependabot PR이 뒤처졌는지만 본다
//                (nudge-stale-dependabot-prs job이 쓴다).
//
// 판정 로직은 새로 만들지 않는다. 조사(을/를, 으로/로) 판정은 hooks/lib/particle.mjs의
// finalSoundOf·correctForFinal 하나만 쓴다 — 두 번째 발음 사전을 두면 반드시 어긋난다.
//
// 커밋 제목처럼 신뢰할 수 없는 값(PR 헤드가 자유롭게 정하는 것)은 --commit-subject로
// 셸 문자열을 직접 받지 않는다 — --base-sha/--head-sha를 주면 이 스크립트가 execFileSync로
// (셸을 거치지 않고 배열 인자로) 직접 git log를 불러 범위 안의 마지막 단위 커밋 제목을
// 스스로 읽는다. 호출부(워크플로)는 그 값을 절대 셸 문자열로 조립할 필요가 없다.
//
// 사용법:
//   node pr-version.mjs check --head-pkg-version <v> --head-plugin-version <v>
//     [--base-pkg-version <v>] [--base-ref <브랜치 이름>]
//     [--base-sha <sha> --head-sha <sha> --repo-root <디렉터리>]
//     [--commit-subject <직접 지정, 시험용>] [--title <PR 제목>] [--out <경로>]
//   node pr-version.mjs bump --level patch|minor
//     [--base-version <v>]
//     (--subject-from-dependabot "<Dependabot PR 제목>" | --subject "<직접 지정할 문장>")
//     [--pkg <package.json 경로>] [--plugin <plugin.json 경로>] [--out <경로>]
//   node pr-version.mjs needs-bump --base-pkg-version <v> --head-pkg-version <v>
//     --head-plugin-version <v>
//   node pr-version.mjs is-stale --develop-version <v> --head-version <v>

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { finalSoundOf, correctForFinal, NO_FINAL } from "../hooks/lib/particle.mjs";
import { parseArgs, writeJson, runMain } from "./lib/cli.mjs";
import { isEntrypoint } from "../hooks/lib/entrypoint.mjs";

const DEFAULT_PKG_PATH = "package.json";
const DEFAULT_PLUGIN_PATH = ".claude-plugin/plugin.json";

// 릴리스 PR(develop → main)의 base 브랜치 이름이다. 이 흐름은 여러 단위 커밋(과 그
// 병합 커밋들)을 그대로 실어 main으로 보내는 것이라 "제목 하나"가 없다 — 버전만 맞으면
// 충분하다(docs/design.md 참고).
const RELEASE_BASE_REF = "main";

/**
 * "x.y.z" 를 파싱한다. 형식이 아니면 null — 잘못된 입력에 숫자를 억지로 만들어내지 않는다.
 * @param {unknown} value
 * @returns {{major: number, minor: number, patch: number}|null}
 */
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * 두 semver 문자열을 비교한다. 어느 한쪽이라도 형식이 아니면 null — "모르면 판정하지
 * 않는다"는 이 저장소의 원칙(불변식 5)을 버전 비교에도 그대로 쓴다.
 * @param {string} a
 * @param {string} b
 * @returns {number|null} 음수/0/양수, 또는 비교 불가면 null
 */
export function compareSemver(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  return va.patch - vb.patch;
}

/**
 * 다음 버전을 계산한다. minor는 patch를 0으로 되돌린다(semver 관례).
 * @param {string} version
 * @param {"patch"|"minor"} level
 * @returns {string}
 */
export function nextVersion(version, level) {
  const v = parseVersion(version);
  if (!v) throw new Error(`버전 형식이 아닙니다: ${version}`);
  if (level === "minor") return `${v.major}.${v.minor + 1}.0`;
  if (level === "patch") return `${v.major}.${v.minor}.${v.patch + 1}`;
  throw new Error(`level 은 patch 또는 minor 여야 합니다: ${level}`);
}

// AGENTS.md가 정한 커밋 제목 형식이다. 첫 줄만 본다 — 본문(여러 줄)이 이어 붙어도
// 형식 판정은 제목 한 줄로 충분하고, 여러 줄 전체를 정규식에 맡기면 본문 내용에 따라
// 뜻밖에 매치가 갈릴 수 있다.
const SUBJECT_RE = /^(\d+\.\d+\.\d+) — (.+)$/;

/**
 * 커밋 제목(또는 PR 제목) 한 줄이 "그 버전"으로 쓴 형식인지 본다.
 * @param {string} subject
 * @param {string} version
 * @returns {boolean}
 */
export function subjectMatchesVersion(subject, version) {
  const firstLine = String(subject || "").split("\n")[0].trim();
  const m = SUBJECT_RE.exec(firstLine);
  return m !== null && m[1] === version;
}

/**
 * base..head 범위에서 병합 커밋을 뺀 가장 최근 커밋 제목을 읽는다. `git log`는 최신
 * 커밋을 먼저 내므로 첫 줄이 곧 "마지막 단위 커밋"이다.
 *
 * execFileSync에 인자를 배열로 넘긴다 — 셸을 거치지 않으므로 sha나 경로에 무엇이
 * 들었든(신뢰할 수 없는 PR 헤드가 만든 값이라도) 명령 주입이 성립하지 않는다.
 *
 * "범위 안에 확인할 커밋이 없다"(병합 전용 PR 등, `subject: null, error: null`)와
 * "범위 자체를 못 읽었다"(sha가 없거나 얕은 클론이라 못 찾음, `subject: null, error:
 * <메시지>`)를 구분해서 돌려준다 — 앞은 "버전만 보면 충분하다"는 정당한 판정이지만,
 * 뒤는 확인 자체가 실패한 것이라 조용히 넘어가면 안 된다(reviewer 지적 — 설정이
 * 깨졌는데 검사가 조용히 통과하면 그게 더 나쁘다). 호출부(runCheck)가 error가 있으면
 * ::warning::을 내고 검사 전체를 실패시킨다.
 *
 * @param {string} repoRoot
 * @param {string} baseSha
 * @param {string} headSha
 * @returns {{subject: string|null, error: string|null}}
 */
export function subjectFromRange(repoRoot, baseSha, headSha) {
  if (!baseSha || !headSha) {
    return { subject: null, error: "base sha 또는 head sha가 없습니다" };
  }
  try {
    const out = execFileSync("git", ["log", "--no-merges", "--format=%s", `${baseSha}..${headSha}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const lines = out.split("\n").filter((line) => line.trim().length > 0);
    return { subject: lines.length > 0 ? lines[0] : null, error: null };
  } catch (err) {
    // sha를 못 찾거나(얕은 클론) repoRoot가 저장소가 아니다 — "범위가 비었다"와는
    // 다르다. 메시지 앞부분만 담는다(git 에러 출력은 절대 경로 등 잡음이 길다).
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { subject: null, error: `git log이 실패했습니다(${baseSha}..${headSha}): ${detail}` };
  }
}

/**
 * PR의 버전·제목이 AGENTS.md 규칙에 맞는지 본다. 문제만 모아 돌려주고 아무것도 고치지
 * 않는다 — 실제 교정은 bump()의 몫이다.
 *
 * subjects는 형식을 확인할 후보 문장들이다(예: 마지막 단위 커밋 제목). 이 저장소는
 * `--no-ff` 병합만 쓰고 스쿼시하지 않으므로, 실제 이력에 남는 것은 커밋 제목이지 PR
 * 제목이 아니다(docs/design.md 참고 — PR 제목은 자유 텍스트라 신뢰하지 않는다).
 *
 * 두 경우는 제목 형식 자체를 보지 않고 버전만 본다(둘 다 "형식에 맞는 단위 커밋 제목이
 * 없다"는 같은 사정이다) — ①`baseRef`가 릴리스 브랜치(main)다. ②확인할 후보가 하나도
 * 없다(범위 안에 병합이 아닌 커밋이 없다). 후보가 있는데 전부 형식에 안 맞을 때만
 * 문제로 낸다.
 *
 * @param {{
 *   headPkgVersion: string, headPluginVersion: string, basePkgVersion?: string,
 *   baseRef?: string, subjects?: {label: string, text: string}[]
 * }} input
 * @returns {{ok: boolean, problems: {code: string, message: string}[]}}
 */
export function checkPrVersion({ headPkgVersion, headPluginVersion, basePkgVersion, baseRef, subjects = [] }) {
  const problems = [];

  const headPkg = parseVersion(headPkgVersion);
  const headPlugin = parseVersion(headPluginVersion);
  if (!headPkg || !headPlugin) {
    problems.push({
      code: "invalid-version",
      message: `버전 형식이 아닙니다: package.json=${headPkgVersion}, plugin.json=${headPluginVersion}`,
    });
    return { ok: false, problems };
  }

  if (headPkgVersion !== headPluginVersion) {
    problems.push({
      code: "version-mismatch",
      message: `package.json(${headPkgVersion})과 .claude-plugin/plugin.json(${headPluginVersion})의 버전이 다릅니다`,
    });
  }

  if (basePkgVersion !== undefined && parseVersion(basePkgVersion)) {
    const cmp = compareSemver(headPkgVersion, basePkgVersion);
    if (cmp !== null && cmp <= 0) {
      problems.push({
        code: "version-not-bumped",
        message: `head 버전(${headPkgVersion})이 base 버전(${basePkgVersion})보다 크지 않습니다`,
      });
    }
  }

  const candidates = subjects.filter((s) => s && typeof s.text === "string" && s.text.trim().length > 0);
  const skipSubjectCheck = baseRef === RELEASE_BASE_REF || candidates.length === 0;
  if (!skipSubjectCheck) {
    const matched = candidates.some((s) => subjectMatchesVersion(s.text, headPkgVersion));
    if (!matched) {
      const where = candidates.map((s) => s.label).join(", ");
      problems.push({
        code: "subject-format",
        message: `"${headPkgVersion} — <합니다체 한 문장>" 형식과 맞는 제목이 없습니다 (${where})`,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 영어 이름(액션 이름 등) 뒤에 붙일 을/를을 발음으로 고른다. `으로`류 예외(ㄹ 받침)는
 * 이 조사 짝에는 없다 — 받침 유무만 본다.
 *
 * 이름에 "/"가 있으면(owner/repo 형태) 마지막 조각만 발음을 안다 — "actions/checkout"의
 * 조사는 "checkout"의 끝소리를 따른다.
 *
 * @param {string} name
 * @returns {"을"|"를"|null} 읽는 법을 모르면 null(불변식 5 — 판정하지 않는다)
 */
export function eulReulFor(name) {
  const lastSegment = String(name || "").split("/").pop();
  const final = finalSoundOf(lastSegment);
  if (final === null) return null;
  return final === NO_FINAL ? "를" : "을";
}

// Dependabot이 실제로 내는 제목 모양이다(github/dependabot-core). 이 저장소의
// dependabot.yml은 groups로 actions 전부를 한데 묶으므로 "group" 모양이 가장 흔하고
// (실제 이력 — `git log --author=dependabot`: "ci: bump the actions group with 2
// updates"), 단일 업데이트나(그룹에 하나만 걸리면 Dependabot이 묶지 않는다) 다른
// 저장소를 참고할 독자를 위해 나머지 모양도 다룬다.
//
// 접두사도 받아들인다. dependabot.yml의 `commit-message.prefix: "ci"`가 실제로
// "ci: bump the actions group with 3 updates"처럼(Bump가 아니라 소문자 bump다) 통짜
// 커밋 제목에 conventional-commits 스타일 접두사를 붙인다 — 실제 이력에 있는 모양이다.
// scope(`ci(actions):`)나 breaking 표시(`!:`)가 붙어도 그대로 받는다.
const PREFIX_SRC = "(?:[\\w-]+(?:\\([^)]*\\))?!?:\\s*)?";
const SINGLE_BUMP_RE = new RegExp(`^${PREFIX_SRC}[Bb]ump (\\S+) from (\\S+) to (\\S+)(?: in (\\S+))?$`);
const GROUP_ACROSS_RE = new RegExp(
  `^${PREFIX_SRC}[Bb]ump the (.+?) group across (\\d+) director(?:y|ies) with (\\d+) updates?$`
);
const GROUP_RE = new RegExp(`^${PREFIX_SRC}[Bb]ump the (.+?) group with (\\d+) updates?$`);

/**
 * Dependabot PR 제목을 구조화한다. 세 모양(단일 업데이트, 그룹, 여러 디렉터리 그룹)만
 * 알고 나머지는 "unknown"으로 돌린다 — 문장을 억지로 만들지 않는다.
 * @param {string} title
 * @returns {object}
 */
export function parseDependabotTitle(title) {
  const t = String(title || "").trim();

  let m = SINGLE_BUMP_RE.exec(t);
  if (m) return { kind: "single", name: m[1], from: m[2], to: m[3], directory: m[4] || null };

  m = GROUP_ACROSS_RE.exec(t);
  if (m) return { kind: "group", name: m[1], directories: Number(m[2]), count: Number(m[3]) };

  m = GROUP_RE.exec(t);
  if (m) return { kind: "group", name: m[1], directories: null, count: Number(m[2]) };

  return { kind: "unknown", raw: t };
}

/**
 * 버전 토큰을 사람이 읽는 모양으로 다듬는다. 숫자만이면(액션 태그 관례) v를 붙인다.
 * 이미 v로 시작하거나 커밋 해시처럼 숫자가 아니면 그대로 둔다.
 * @param {string} value
 * @returns {string}
 */
function versionToken(value) {
  if (/^v/i.test(value)) return value;
  if (/^\d[\d.]*$/.test(value)) return `v${value}`;
  return value;
}

/**
 * "…로 올렸습니다"의 조사를 버전 토큰의 실제 마지막 숫자로 고른다. "8"은 팔(ㄹ 받침 —
 * 짧은 "로"), "0"은 영/공(ㅇ 받침 — 긴 "으로")이다. 버전 문자열 전체(예: "v3.27.0")를
 * finalSoundOf에 그대로 넘기면 안 된다 — 그 함수는 글자 뒤에 붙은 숫자를 영어로 읽는
 * 낱말(S3, v1)로 보는 규칙이 있어, "v3.27.0"처럼 점이 여럿인 버전 문자열에서는 엉뚱한
 * 자리(맨 끝 숫자가 아니라 그 앞)를 최우선으로 보게 설계되지 않았다. 실제로 소리 내
 * 읽을 때 조사가 따르는 자리는 항상 맨 끝 숫자 한 글자이므로, 그 글자만 뽑아
 * finalSoundOf에 순수 숫자로 넘긴다 — 그러면 글자 접두사 판정이 아예 끼어들지 않는다.
 * 끝에 숫자가 아예 없으면(태그가 숫자가 아닌 경우 등) 판정하지 않는다(불변식 5) —
 * 그때는 짧은 "로"로 물러난다. 짧은 형은 받침 없음/ㄹ 받침 두 경우에 다 맞아 가장
 * 흔한 경우이고, 나머지(그 외 받침)만 이 함수가 "으로"로 바로잡는다.
 * @param {string} versionValue Dependabot 제목의 원래 버전 문자열(예: "8", "3.27.0")
 * @returns {"로"|"으로"}
 */
export function roParticleForVersion(versionValue) {
  const lastDigit = /(\d)(?!.*\d)/.exec(String(versionValue));
  if (!lastDigit) return "로";
  const final = finalSoundOf(lastDigit[1]);
  if (final === null) return "로";
  return correctForFinal(final, "로") ?? "로";
}

/**
 * Dependabot PR 제목에서 합니다체 한 문장을 만든다. 조사를 모르면(불변식 5) 이름에
 * 조사를 바로 붙이지 않고 "버전을"처럼 받침이 고정된 한국어 낱말 뒤로 옮겨 피해 간다.
 * @param {string} title
 * @returns {string}
 */
export function sentenceFromDependabotTitle(title) {
  const parsed = parseDependabotTitle(title);

  if (parsed.kind === "single") {
    const fromTok = versionToken(parsed.from);
    const toTok = versionToken(parsed.to);
    // 디렉터리가 저장소 루트("/")면 굳이 적지 않는다 — 이 저장소를 포함해 대부분의
    // 워크플로가 루트에 있어 "(/)"는 정보가 아니라 잡음이다. 실제로 하위 디렉터리일
    // 때만("in packages/api" 등) 덧붙인다.
    const dirNote = parsed.directory && parsed.directory !== "/" ? ` (${parsed.directory})` : "";
    const roParticle = roParticleForVersion(parsed.to);
    const particle = eulReulFor(parsed.name);
    return particle
      ? `GitHub Actions의 ${parsed.name}${particle} ${fromTok}에서 ${toTok}${roParticle} 올렸습니다${dirNote}`
      : `GitHub Actions의 ${parsed.name} 버전을 ${fromTok}에서 ${toTok}${roParticle} 올렸습니다${dirNote}`;
  }

  if (parsed.kind === "group") {
    const dirNote = parsed.directories ? ` (디렉터리 ${parsed.directories}곳)` : "";
    // "GitHub Actions의 {name} 그룹의 ..."는 관형격(의)이 두 번 겹친다("GitHub
    // Actions의"와 "{name} 그룹의") — 겹친 관형격은 부자연스럽다고 지적받아 앞의
    // "GitHub Actions의"를 뺐다. "GitHub Actions"는 뒤로 옮겨 무엇을 올렸는지(그
    // 그룹 안의 액션들)를 밝히는 말로 쓴다.
    return `${parsed.name} 그룹의 GitHub Actions ${parsed.count}개 버전을 올렸습니다${dirNote}`;
  }

  // 못 알아본 제목(Dependabot이 모양을 바꾸는 등) — 이름을 억지로 문장에 끼워 넣지
  // 않는다. 판정할 수 없으면 안전하고 일반적인 문장으로 물러난다(불변식 5).
  return "GitHub Actions 버전을 최신으로 올렸습니다";
}

/**
 * 다음 버전의 커밋 제목 전체("0.x.y — …")를 만든다.
 * @param {string} nextVer
 * @param {string} title
 * @returns {string}
 */
export function buildDependabotSubject(nextVer, title) {
  return `${nextVer} — ${sentenceFromDependabotTitle(title)}`;
}

/**
 * JSON 파일 텍스트에서 "version" 필드 값만 바꾼다. JSON.parse→stringify를 쓰지 않는다 —
 * 그러면 들여쓰기·줄바꿈·키 순서가 파일마다 조금씩 다른 원래 모양을 잃는다(요구사항:
 * 포맷은 그대로, 버전 문자열만 바뀐다). 정확히 한 번만 나오는 것을 전제한다 — 두 번
 * 이상 나오면(있을 수 없는 모양) 첫 번째만 바꾸는 대신 알아챌 수 있게 에러를 던진다.
 * @param {string} text
 * @param {string} expectedOld 현재 버전(파일 내용과 다르면 에러 — 다른 커밋이 먼저 손댔을 신호)
 * @param {string} newVersion
 * @returns {string}
 */
export function bumpVersionInText(text, expectedOld, newVersion) {
  const re = /("version"\s*:\s*")([^"]*)(")/g;
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) throw new Error('"version" 필드를 찾지 못했습니다');
  if (matches.length > 1) throw new Error('"version" 필드가 두 번 이상 나옵니다 — 어느 것을 바꿀지 모릅니다');

  const [match] = matches;
  if (match[2] !== expectedOld) {
    throw new Error(`현재 버전이 예상과 다릅니다: 파일=${match[2]}, 예상=${expectedOld}`);
  }

  const start = match.index;
  const end = start + match[0].length;
  return text.slice(0, start) + match[1] + newVersion + match[3] + text.slice(end);
}

/**
 * package.json/plugin.json 텍스트에서 현재 버전만 읽는다(JSON.parse로 충분 — 쓰기와
 * 달리 읽기는 포맷을 보존할 필요가 없다).
 * @param {string} text
 * @returns {string}
 */
function readVersionFromText(text) {
  return JSON.parse(text).version;
}

/**
 * head 브랜치가 이미 base보다 앞서 있어(누가 먼저 올렸거나, 우리가 이미 push한 커밋을
 * Dependabot의 rebase가 그대로 들고 있어) 다시 bump할 필요가 없는지 본다. 순수 함수라
 * git 호출 없이 시험할 수 있다.
 * @param {string} basePkgVersion
 * @param {string} headPkgVersion
 * @param {string} headPluginVersion
 * @returns {boolean}
 */
export function needsBump(basePkgVersion, headPkgVersion, headPluginVersion) {
  if (headPkgVersion !== headPluginVersion) return true; // 어긋나 있으면 손볼 것이 있다
  const cmp = compareSemver(headPkgVersion, basePkgVersion);
  if (cmp === null) return true; // 형식이 이상하면 일단 손보게 한다 — 조용히 넘기지 않는다
  return cmp <= 0;
}

/**
 * PR 헤드의 package.json 버전이 develop의 새 버전을 못 따라가는지 본다(develop에
 * push될 때마다 열려 있는 Dependabot PR을 훑는 nudge-stale-dependabot-prs job이 쓴다).
 * `needsBump`와 판정 자체는 같은 모양이지만(head <= base면 뒤처졌다) 쓰는 자리가
 * 다르다 — 이건 재생성(recreate)을 요청할지 정하는 것이고, `needsBump`는 이 저장소가
 * 직접 bump할지 정하는 것이다. 이름이 겹치는 개념이라도 호출부의 의도가 다르면 같은
 * 이름 아래 두지 않는다.
 *
 * 형식이 이상해 비교할 수 없으면(cmp === null) 뒤처졌다고 본다 — "재생성 요청을
 * 놓친다"보다 "쓸데없이 한 번 더 요청한다"가 안전하다(불변식 5의 반대 방향과 같은
 * 이유 — 판정 실패를 "문제없음"으로 두지 않는다).
 *
 * @param {string} developVersion
 * @param {string} headVersion
 * @returns {boolean}
 */
export function isStaleAgainstDevelop(developVersion, headVersion) {
  const cmp = compareSemver(headVersion, developVersion);
  return cmp === null ? true : cmp <= 0;
}

/**
 * package.json과 plugin.json의 버전을 다음 버전으로 올려 그 자리에 쓴다. 포맷은
 * 그대로(bumpVersionInText), 버전 문자열만 바뀐다.
 *
 * `baseVersion`을 주면(워크플로가 항상 준다) head가 아니라 **base에서** 다음 버전을
 * 계산한다 — head 쪽 파일은 신뢰하지 않는다. 두 파일이 이미 어긋나 있거나(누가 하나만
 * 손댔다) head가 base를 앞서지 못했으면 base + 1을 정답으로 놓고 그 위에 덮어쓴다.
 * head가 이미 base보다 앞서 있고 두 파일이 같으면(Dependabot의 rebase가 우리 bump
 * 커밋을 그대로 들고 있는 등) 다시 할 일이 없다 — `skipped: true`로 돌아가고 아무
 * 파일도 건드리지 않는다(멱등성).
 *
 * `baseVersion`을 생략하면(워크플로 밖에서 손으로 부르는 경우) 예전처럼 head 쪽
 * 두 파일이 같다고 엄격히 요구한다 — 다르면 추측하지 않고 에러를 던진다.
 *
 * @param {{pkgPath: string, pluginPath: string, level: "patch"|"minor", baseVersion?: string}} input
 * @returns {{oldVersion: string, newVersion: string, skipped: boolean}}
 */
export function bumpVersionFiles({ pkgPath, pluginPath, level, baseVersion }) {
  const pkgText = readFileSync(pkgPath, "utf8");
  const pluginText = readFileSync(pluginPath, "utf8");
  const pkgVersion = readVersionFromText(pkgText);
  const pluginVersion = readVersionFromText(pluginText);

  if (baseVersion === undefined) {
    if (pkgVersion !== pluginVersion) {
      throw new Error(
        `bump 전에 두 파일의 버전이 이미 다릅니다: package.json=${pkgVersion}, plugin.json=${pluginVersion}`
      );
    }
    const newVersion = nextVersion(pkgVersion, level);
    writeFileSync(pkgPath, bumpVersionInText(pkgText, pkgVersion, newVersion));
    writeFileSync(pluginPath, bumpVersionInText(pluginText, pluginVersion, newVersion));
    return { oldVersion: pkgVersion, newVersion, skipped: false };
  }

  if (!needsBump(baseVersion, pkgVersion, pluginVersion)) {
    return { oldVersion: pkgVersion, newVersion: pkgVersion, skipped: true };
  }

  const newVersion = nextVersion(baseVersion, level);
  writeFileSync(pkgPath, bumpVersionInText(pkgText, pkgVersion, newVersion));
  writeFileSync(pluginPath, bumpVersionInText(pluginText, pluginVersion, newVersion));
  return { oldVersion: pkgVersion, newVersion, skipped: false };
}

async function runCheck(args) {
  const baseRef = typeof args["base-ref"] === "string" ? args["base-ref"] : undefined;

  // --commit-subject는 시험·손 호출용 지름길이다. 워크플로는 이걸 쓰지 않는다 — 대신
  // --base-sha/--head-sha를 줘서 이 스크립트가 직접(셸을 거치지 않고) git log로 읽게
  // 한다. 둘 다 있으면 명시적으로 준 --commit-subject를 우선한다.
  let subjectText;
  let subjectLookupError;
  if (typeof args["commit-subject"] === "string") {
    subjectText = args["commit-subject"];
  } else if (args["base-sha"] && args["head-sha"]) {
    const repoRoot = args["repo-root"] ? resolve(String(args["repo-root"])) : process.cwd();
    const range = subjectFromRange(repoRoot, String(args["base-sha"]), String(args["head-sha"]));
    subjectText = range.subject ?? undefined;
    subjectLookupError = range.error ?? undefined;
  }

  const subjects = [];
  if (subjectText) subjects.push({ label: "마지막 단위 커밋 제목", text: subjectText });
  if (typeof args.title === "string") subjects.push({ label: "PR 제목", text: args.title });

  const result = checkPrVersion({
    headPkgVersion: String(args["head-pkg-version"] || ""),
    headPluginVersion: String(args["head-plugin-version"] || ""),
    basePkgVersion: args["base-pkg-version"] !== undefined ? String(args["base-pkg-version"]) : undefined,
    baseRef,
    subjects,
  });

  // git log 자체가 실패한 것("범위를 못 읽었다")은 "범위가 비어 있다"(정당한 스킵)와
  // 다르다 — 얕은 클론이나 잘못된 sha처럼 확인 인프라 자체가 고장 난 신호라 조용히
  // 통과시키면 안 된다. checkPrVersion의 정상 판정 위에 이 문제를 덧붙이고 실패로
  // 뒤집는다.
  if (subjectLookupError) {
    console.log(`::warning::${subjectLookupError}`);
    result.problems.push({ code: "subject-lookup-failed", message: subjectLookupError });
    result.ok = false;
  }

  for (const problem of result.problems) {
    // subject-lookup-failed는 위에서 이미 ::warning::으로 냈다 — 같은 문제를
    // ::error::로 다시 반복하지 않는다.
    if (problem.code === "subject-lookup-failed") continue;
    console.log(`::error::${problem.message}`);
  }

  writeJson(result, args.out);
  if (!result.ok) process.exitCode = 1;
}

async function runBump(args) {
  const level = String(args.level || "");
  if (level !== "patch" && level !== "minor") {
    throw new Error(`--level 은 patch 또는 minor 여야 합니다: ${level}`);
  }

  const pkgPath = resolve(String(args.pkg || DEFAULT_PKG_PATH));
  const pluginPath = resolve(String(args.plugin || DEFAULT_PLUGIN_PATH));
  const baseVersion = typeof args["base-version"] === "string" ? args["base-version"] : undefined;

  const result = bumpVersionFiles({ pkgPath, pluginPath, level, baseVersion });

  let subject = null;
  if (!result.skipped) {
    if (typeof args.subject === "string") {
      subject = args.subject;
    } else {
      const title = typeof args["subject-from-dependabot"] === "string" ? args["subject-from-dependabot"] : "";
      subject = buildDependabotSubject(result.newVersion, title);
    }
  }

  writeJson({ ...result, subject }, args.out);
}

async function runNeedsBump(args) {
  const result = needsBump(
    String(args["base-pkg-version"] || ""),
    String(args["head-pkg-version"] || ""),
    String(args["head-plugin-version"] || "")
  );
  console.log(result ? "true" : "false");
}

async function runIsStale(args) {
  const result = isStaleAgainstDevelop(String(args["develop-version"] || ""), String(args["head-version"] || ""));
  console.log(result ? "true" : "false");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "check") return runCheck(args);
  if (command === "bump") return runBump(args);
  if (command === "needs-bump") return runNeedsBump(args);
  if (command === "is-stale") return runIsStale(args);
  throw new Error(`알 수 없는 명령입니다: ${command || "(없음)"} (check, bump, needs-bump, is-stale 중 하나)`);
}

if (isEntrypoint(import.meta.url)) runMain(main);
