// 저장소의 산출물 언어 추론.
//
// 설정 파일을 요구하지 않고 커밋 이력에서 추론한다. 그래서 오판이 곧 잘못된 지시가 된다.
// 이 시험의 핵심은 **섞여 있으면 개입하지 않는다**를 지키는 것이다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  koreanShare,
  classify,
  commitLanguage,
  docLanguage,
  hangulCharShare,
  detectRepoLanguage,
  describeRepoLanguage,
} from "../hooks/lib/repo-language.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "hooks", "session-language.mjs");

/** 커밋 제목 목록으로 임시 저장소를 만든다. */
function makeRepo(subjects, readme) {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-repo-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });

  for (const subject of subjects) {
    appendFileSync(join(dir, "f.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", subject], { cwd: dir });
  }
  if (readme !== undefined) writeFileSync(join(dir, "README.md"), readme, "utf8");
  return dir;
}

function withRepo(subjects, readme, body) {
  const dir = makeRepo(subjects, readme);
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 비율과 판정 ─────────────────────────────────────────────

test("표본 개수 비율로 센다", () => {
  // 글자 수가 아니라 표본 개수다. 커밋 하나가 유난히 길어도 판정이 흔들리지 않아야 한다.
  assert.equal(koreanShare(["캐시 추가", "add cache"]), 0.5);
  assert.equal(koreanShare(["add cache", "fix bug"]), 0);
  assert.equal(koreanShare([]), null);
  assert.equal(koreanShare(["", "  "]), null);
});

test("한글 한 글자만으로는 한국어로 보지 않는다", () => {
  // 영어 커밋에 한글 파일명이 섞이는 경우가 있다.
  assert.equal(koreanShare(["Rename 한.txt"]), 0);
  assert.equal(koreanShare(["한글 파일명 정리"]), 1);
});

test("가운데 구간은 혼용으로 둔다", () => {
  // 양쪽 문턱을 보수적으로 잡는다. 잘못 단정하는 실수가 침묵하는 실수보다 비싸다.
  assert.equal(classify(1), "한국어");
  assert.equal(classify(0.6), "한국어");
  assert.equal(classify(0), "영어");
  assert.equal(classify(0.1), "영어");
  assert.equal(classify(0.33), "혼용", "문단 셋 중 하나는 섞인 것이다");
  assert.equal(classify(0.5), "혼용");
  assert.equal(classify(null), "알 수 없음");
});

test("표본이 적으면 판정하지 않는다", () => {
  // 커밋 두 개로 저장소 관행을 단정할 수 없다.
  assert.equal(classify(1, 2), "알 수 없음");
  assert.equal(classify(0, 1), "알 수 없음");
  assert.equal(classify(1, 3), "한국어");
});

// ── 저장소에서 읽기 ─────────────────────────────────────────

test("영어로 커밋하는 저장소를 알아본다", () => {
  withRepo(["Add cache layer", "Fix race condition", "Bump deps"], undefined, (dir) => {
    assert.equal(commitLanguage(dir), "영어");
  });
});

test("한국어로 커밋하는 저장소를 알아본다", () => {
  withRepo(["캐시 계층을 더했습니다", "경쟁 조건을 고쳤습니다", "의존성을 올렸습니다"], undefined, (dir) => {
    assert.equal(commitLanguage(dir), "한국어");
  });
});

test("섞여 있으면 혼용으로 둔다", () => {
  const subjects = ["Add cache", "Fix bug", "Bump deps", "캐시 정리", "버그 수정"];
  withRepo(subjects, undefined, (dir) => {
    assert.equal(commitLanguage(dir), "혼용", "5개 중 2개면 40퍼센트");
  });
});

test("git 저장소가 아니면 알 수 없음이다", () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-plain-"));
  try {
    assert.equal(commitLanguage(dir), "알 수 없음");
    assert.equal(detectRepoLanguage(dir).commit, "알 수 없음");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("커밋이 없는 저장소도 안전하다", () => {
  withRepo([], undefined, (dir) => {
    assert.equal(commitLanguage(dir), "알 수 없음");
  });
});

const ENGLISH_DOC = [
  "# Project",
  "",
  "This project does a thing. The documentation is written in English for contributors",
  "who may not read Korean. Everything here follows that convention consistently.",
  "",
  "Another paragraph explains how to build and test the project on a local machine",
  "without any additional setup beyond a recent version of the runtime.",
  "",
].join("\n");

// 시험 자료는 실제 README 만큼의 분량이어야 한다. 100자짜리 문서로는 판정하지 않는 것이
// 맞고, 문턱을 자료에 맞춰 낮추면 실제 오판이 늘어난다.
const KOREAN_DOC = [
  "# 프로젝트",
  "",
  "이 프로젝트는 무언가를 합니다. 문서는 한국어로 썼고, 팀원 모두가 한국어를 읽습니다.",
  "설치와 실행 방법을 아래에 적어 두었습니다. 준비물은 최신 런타임 하나뿐입니다.",
  "",
  "두 번째 문단에서는 빌드와 시험을 어떻게 돌리는지 설명합니다. 별도 준비물은 없습니다.",
  "시험은 의존성 없이 돌아가고, 생성물이 최신인지도 함께 확인합니다.",
  "",
  "기여하실 때는 시험을 먼저 돌려 주십시오. 실패하는 시험이 있으면 원인을 적어 알려 주십시오.",
  "",
].join("\n");

test("문서의 언어를 글자 비율로 본다", () => {
  withRepo(["init"], ENGLISH_DOC, (dir) => assert.equal(docLanguage(dir), "영어"));
  withRepo(["init"], KOREAN_DOC, (dir) => assert.equal(docLanguage(dir), "한국어"));
});

test("긴 영어 문서에 한국어 한 줄이 섞이면 영어로 둔다", () => {
  // 글자 비율로 세므로 분량이 반영된다. 긴 영어 문서에 한 줄이 섞인 것은 영어 문서다.
  // 문단 개수로 세면 셋 중 하나가 33퍼센트가 되어 혼용으로 오판했다.
  const mostlyEnglish = `${ENGLISH_DOC}\n이 줄만 한국어입니다.\n`;
  withRepo(["init"], mostlyEnglish, (dir) => assert.equal(docLanguage(dir), "영어"));
});

test("절반씩 섞인 문서에는 개입하지 않는다", () => {
  const mixed = `${ENGLISH_DOC}\n${KOREAN_DOC}`;
  withRepo(["init"], mixed, (dir) => assert.equal(docLanguage(dir), "혼용"));
});

test("코드 블록은 언어 판정에서 뺀다", () => {
  // 한국어 문서에 영어 코드 예시가 길게 들어가도 한국어로 남아야 한다.
  const withCode = `${KOREAN_DOC}\n\`\`\`js\nconst veryLongEnglishIdentifier = buildSomethingUseful(withArguments);\n\`\`\`\n`;
  withRepo(["init"], withCode, (dir) => assert.equal(docLanguage(dir), "한국어"));
});

test("분량이 적은 문서로는 판정하지 않는다", () => {
  withRepo(["init"], "# P\n\nA thing.\n", (dir) => assert.equal(docLanguage(dir), "알 수 없음"));
});

test("README 가 없으면 알 수 없음이다", () => {
  withRepo(["init"], undefined, (dir) => assert.equal(docLanguage(dir), "알 수 없음"));
});

// ── 알려 줄 문장 ────────────────────────────────────────────

test("영어로 쓰는 저장소일 때만 알려 준다", () => {
  assert.match(describeRepoLanguage({ commit: "영어", doc: "영어" }), /커밋 메시지와 PR 설명은/);
  assert.match(describeRepoLanguage({ commit: "영어", doc: "한국어" }), /커밋 메시지와 PR 설명은/);
  assert.ok(!describeRepoLanguage({ commit: "영어", doc: "한국어" }).includes("README"));
});

test("한국어로 쓰는 저장소에는 아무것도 말하지 않는다", () => {
  // 출력 스타일이 이미 그렇게 시킨다. 같은 말을 두 번 하면 분량만 먹는다.
  assert.equal(describeRepoLanguage({ commit: "한국어", doc: "한국어" }), "");
});

test("혼용이나 알 수 없음에는 개입하지 않는다", () => {
  assert.equal(describeRepoLanguage({ commit: "혼용", doc: "혼용" }), "");
  assert.equal(describeRepoLanguage({ commit: "알 수 없음", doc: "알 수 없음" }), "");
});

test("사용자의 지시가 추론보다 앞선다고 밝힌다", () => {
  const text = describeRepoLanguage({ commit: "영어", doc: "영어" });
  assert.match(text, /사용자가 한국어로 쓰라고 하면 그 말을 따릅니다/);
});

// ── 훅 ─────────────────────────────────────────────────────

function runHook(cwd, env = {}) {
  const stdout = execFileSync("node", [HOOK], {
    input: JSON.stringify({ cwd }),
    encoding: "utf8",
    env: { ...process.env, KIMCHI_DISABLE: "", KIMCHI_REPO_LANG: "", ...env },
  });
  return stdout.trim() === "" ? null : JSON.parse(stdout);
}

test("영어 저장소에서 컨텍스트를 내보낸다", () => {
  withRepo(["Add cache", "Fix bug", "Bump deps"], ENGLISH_DOC, (dir) => {
    const output = runHook(dir);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(output.hookSpecificOutput.additionalContext, /영어로/);
  });
});

test("한국어 저장소에서는 침묵한다", () => {
  withRepo(["캐시를 더했습니다", "버그를 고쳤습니다", "의존성을 올렸습니다"], undefined, (dir) => {
    assert.equal(runHook(dir), null);
  });
});

test("끄는 길이 있다", () => {
  withRepo(["Add cache", "Fix bug", "Bump deps"], undefined, (dir) => {
    assert.equal(runHook(dir, { KIMCHI_REPO_LANG: "off" }), null);
    assert.equal(runHook(dir, { KIMCHI_DISABLE: "1" }), null);
  });
});

test("망가진 입력에도 조용히 끝난다", () => {
  for (const input of ["", "not json", "{}", "null"]) {
    const stdout = execFileSync("node", [HOOK], { input, encoding: "utf8" });
    // 이 저장소는 한국어라 빈 출력이 맞다. 중요한 것은 멈추지 않는 것이다.
    assert.equal(stdout.trim(), "", `입력 "${input}"`);
  }
});
