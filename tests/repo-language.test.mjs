// 저장소의 산출물 언어 추론.
//
// 설정 파일을 요구하지 않고 커밋 이력에서 추론한다. 그래서 오판이 곧 잘못된 지시가 된다.
// 이 시험의 핵심은 **섞여 있으면 개입하지 않는다**를 지키는 것이다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
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
  // 로마자에 2.5분의 1 가중치를 걸므로(기술 용어가 섞인 한국어 문서를 영어로 오판하지
  // 않으려는 것) 글자 수가 똑같은 영어·한국어 문서를 이으면 더는 정확히 반반이 아니다.
  // 가중치를 반영해 영어 쪽 분량을 그만큼 늘려야 실제로 중간 지대에 놓인다.
  const mixed = `${ENGLISH_DOC}\n${ENGLISH_DOC}\n${KOREAN_DOC}`;
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

test("배지·로고·백틱 코드가 섞여도 한국어 README 를 영어로 보지 않는다", () => {
  // hangulCharShare 가 백틱 코드만 빼던 시절에는 배지·이미지·링크 주소의 로마자가
  // 그대로 세어져, 프로즈는 한국어인데 전체 판정이 영어로 뒤집혔다.
  const withBadges = [
    '<p align="center"><img src="https://example.com/logo.png" width="120"></p>',
    "",
    "![Build](https://img.shields.io/badge/build-passing-green)",
    "![Version](https://img.shields.io/badge/version-1.0.0-blue)",
    "![License](https://img.shields.io/badge/license-MIT-blue)",
    "![Downloads](https://img.shields.io/badge/downloads-1000-blue)",
    "",
    KOREAN_DOC,
    "",
    "`inline code`",
    "",
    "[문서 보기](https://example.com/docs)",
    "",
  ].join("\n");
  withRepo(["캐시를 더했습니다", "버그를 고쳤습니다", "의존성을 올렸습니다"], withBadges, (dir) => {
    assert.notEqual(docLanguage(dir), "영어");
  });
});

test("긴 코드 울타리와 닫히지 않은 울타리도 판정에서 뺀다", () => {
  const longCode = Array.from({ length: 20 }, (_, i) => `const identifierNumber${i} = doSomethingWithArguments(i);`).join(
    "\n"
  );
  const withFences = [
    KOREAN_DOC,
    "~~~js",
    longCode,
    "~~~",
    "",
    "    indented code line one",
    "    indented code line two",
    "",
    "```",
    "unterminated fence content that never closes and runs to the end of the file",
  ].join("\n");
  withRepo(["init"], withFences, (dir) => assert.notEqual(docLanguage(dir), "영어"));
});

test("UTF-16LE 로 쓴 README 는 알 수 없음이다", () => {
  withRepo(["init"], undefined, (dir) => {
    writeFileSync(join(dir, "README.md"), Buffer.from(KOREAN_DOC, "utf16le"));
    assert.equal(docLanguage(dir), "알 수 없음");
  });
});

test("임의 바이너리 README 는 알 수 없음이다", () => {
  withRepo(["init"], undefined, (dir) => {
    const junk = Buffer.alloc(4096);
    for (let i = 0; i < junk.length; i += 1) junk[i] = (i * 37 + 11) % 256;
    writeFileSync(join(dir, "README.md"), junk);
    assert.equal(docLanguage(dir), "알 수 없음");
  });
});

test("README 자리에 FIFO 가 있어도 곧바로 끝난다", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-fifo-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync("mkfifo", [join(dir, "README.md")]);
    const start = Date.now();
    assert.equal(docLanguage(dir), "알 수 없음");
    assert.ok(Date.now() - start < 1000, "FIFO 를 읽으려다 멈추면 안 된다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("README 는 저장소 최상위에서 찾는다", () => {
  withRepo(["캐시를 더했습니다", "버그를 고쳤습니다", "의존성을 올렸습니다"], KOREAN_DOC, (dir) => {
    const sub = join(dir, "packages", "x");
    mkdirSync(sub, { recursive: true });
    // 벤더 받은 하위 패키지의 영어 문서. 저장소 전체를 이걸로 오판하면 안 된다.
    writeFileSync(join(sub, "README.md"), ENGLISH_DOC, "utf8");
    assert.equal(docLanguage(sub), "한국어");
  });
});

test("표본에 언어 신호가 없으면 분모에서도 뺀다", () => {
  // 이모지·버전 번호·봇 커밋은 어느 쪽 증거도 아니다. 분모에 남으면 영어 쪽으로 잘못 쏠린다.
  const subjects = [
    "캐시를 정리했습니다",
    "🎉",
    "✨ 3",
    "0.1.3",
    "Bump lodash from 1.2.3 to 1.2.4",
    "Merge pull request #12 from a/b",
    "Merge branch 'develop' into feature/x",
  ];
  assert.equal(koreanShare(subjects), 1, "언어 신호가 있는 표본은 '캐시를 정리했습니다' 하나뿐이다");
});

test("한글 한 글자뿐이라도 로마자가 거의 없으면 한국어로 본다", () => {
  // "값 3"은 표본 전체가 짧은 한국어 단어다. "Rename 한.txt"처럼 로마자가 많은
  // 표본과 달리, 이 표본에는 그 한 글자 말고 다른 언어 증거가 없다.
  assert.equal(koreanShare(["값 3"]), 1);
  assert.equal(koreanShare(["Rename 한.txt"]), 0, "로마자가 많으면 여전히 한국어로 보지 않는다");
});

test("커밋 인코딩 설정이 cp949 여도 한국어 커밋을 알아본다", () => {
  withRepo(["캐시 계층을 더했습니다", "경쟁 조건을 고쳤습니다", "의존성을 올렸습니다"], undefined, (dir) => {
    execFileSync("git", ["config", "i18n.logOutputEncoding", "cp949"], { cwd: dir });
    assert.equal(commitLanguage(dir), "한국어");
  });
});

test("dependabot·renovate·머지·되돌리기·초기 커밋·깃허브 웹 편집 커밋을 모두 봇으로 뺀다", () => {
  const subjects = [
    "캐시를 정리했습니다",
    "버그를 고쳤습니다",
    "의존성을 올렸습니다",
    "값을 검증했습니다",
    "chore(deps): bump lodash from 4.17.20 to 4.17.21",
    "chore(deps): update dependency eslint to v9",
    "fix(deps): update module github.com/foo/bar to v1.2.3",
    "Merge pull request #42 from foo/feature-x",
    "Merge branch 'develop' into feature/y",
    "Merge remote-tracking branch 'origin/main'",
    "Merge tag 'v1.2.3' into release",
    "Merge commit 'abcdef' into main",
    "merge: feature/pii-detection",
    'Revert "캐시 계층을 더했습니다"',
    "Initial commit",
    "Update README.md",
    "Create CONTRIBUTING.md",
    "Delete old-notes.txt",
  ];
  // 언어 신호가 있는 표본은 한국어 넷뿐이다. 봇·머지·초기·깃허브 웹 편집 커밋 14개는
  // 팀의 말투와 무관한 기계적인 글이므로 분모에서 빠져야 한다.
  assert.equal(koreanShare(subjects), 1, "봇·머지 커밋을 빼면 남는 것은 전부 한국어다");
});

test("이 저장소 자신의 커밋 이력은 한국어로 판정된다", () => {
  // 이 저장소는 git-flow 식 "merge: feature/x" 병합 커밋을 자주 쓴다. 그런 병합
  // 제목이 언어 신호 없는 표본으로 잘못 세어지면 실제 관행(한국어)이 흐려진다.
  assert.equal(commitLanguage(ROOT), "한국어");
});

test("들여쓴 한국어 중첩 목록은 코드로 보지 않는다", () => {
  // 영어 소제목 아래 한국어로 된 4칸 들여쓰기 하위 목록이 있는 README. 들여쓴 줄이라고
  // 무조건 코드로 지우면, 실제 코드가 거의 없는데도 프로즈가 통째로 사라져 영어로 뒤집힌다.
  const withKoreanNestedList = [
    "## Features",
    "",
    "- **Authentication**",
    "    - 이메일과 비밀번호로 로그인할 수 있습니다.",
    "    - 소셜 로그인은 구글과 카카오를 지원합니다.",
    "- **Billing**",
    "    - 구독은 월 단위로 청구됩니다.",
    "    - 환불 정책은 이용 약관에 적어 두었습니다.",
    "- **Notifications**",
    "    - 이메일과 푸시 알림을 함께 보냅니다.",
    "    - 알림 주기는 설정 화면에서 바꿀 수 있습니다.",
    "",
  ].join("\n");
  withRepo(["init"], withKoreanNestedList, (dir) => assert.notEqual(docLanguage(dir), "영어"));
});

test("기술 용어가 잔뜩 섞인 한국어 문서를 영어로 보지 않는다", () => {
  // 로마자 낱말(AWS, API, CI/CD 등)이 많이 섞인 한국어 산문. 로마자를 한글과
  // 1대1로 세면 이런 문서가 영어 쪽으로 밀린다.
  const techHeavyKorean = [
    "# 인프라",
    "",
    "이 프로젝트는 AWS Lambda 와 API Gateway, DynamoDB, S3, CloudFront, IAM, VPC, CloudWatch 를 씁니다.",
    "배포는 GitHub Actions CI/CD 파이프라인으로 자동화했고, Docker 이미지를 ECR 에 올린 뒤 ECS Fargate 로 실행합니다.",
    "",
    "설정은 Terraform 으로 관리하고, 환경 변수는 SSM Parameter Store 와 Secrets Manager 에 둡니다.",
    "로그는 CloudWatch Logs 로 모으고, 알림은 SNS 와 Slack Webhook 으로 보냅니다.",
    "",
    "테스트는 Jest 와 Playwright 로 돌리고, 커버리지는 Codecov 로 확인합니다. 빌드는 esbuild 로 합니다.",
    "",
  ].join("\n");
  withRepo(["init"], techHeavyKorean, (dir) => assert.notEqual(docLanguage(dir), "영어"));
});

test("한국어 단어 몇 개가 섞여도 영어 문서는 여전히 영어로 본다", () => {
  // 가중치를 걸어도 영어 문서에 짧은 한국어 문장 하나가 섞인 정도로는 판정이 뒤집히면 안 된다.
  const mostlyEnglish = `${ENGLISH_DOC}\n이 줄만 한국어입니다.\n`;
  withRepo(["init"], mostlyEnglish, (dir) => assert.equal(docLanguage(dir), "영어"));
});

test("읽기 상한에서 한글 글자 중간이 잘려도 알 수 없음으로 오판하지 않는다", () => {
  // MAX_README_BYTES 로 자를 때 하필 한글 한 글자의 바이트 사이에서 잘리면, 그
  // 조각은 홀로 유효한 UTF-8 이 아니어서 U+FFFD 로 디코딩된다 — 멀쩡한 문서인데
  // 잘리는 위치에 따라 알 수 없음이 되어서는 안 된다.
  const filler = `${KOREAN_DOC}\n`.repeat(2000); // 256KB 상한을 넉넉히 넘는 분량
  withRepo(["init"], filler, (dir) => {
    assert.equal(docLanguage(dir), "한국어");
  });
});

test("병적인 입력에도 문서 판정이 빠르게 끝난다", () => {
  // 닫는 꺾쇠·대괄호가 전혀 없는 256KB 입력. 태그·이미지·링크 정규식의 폭을 제한하지
  // 않으면 위치마다 문서 끝까지 훑는 이차 시간이 걸린다.
  const pathological = "a<".repeat(128 * 1024) + "\n" + KOREAN_DOC;
  withRepo(["init"], pathological, (dir) => {
    const start = Date.now();
    docLanguage(dir);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `너무 오래 걸렸다: ${elapsed}ms`);
  });
});

// ── 알려 줄 문장 ────────────────────────────────────────────

test("영어로 쓰는 저장소일 때만 알려 준다", () => {
  assert.match(describeRepoLanguage({ commit: "영어", doc: "영어" }), /commit messages and PR descriptions/);
  assert.match(describeRepoLanguage({ commit: "영어", doc: "한국어" }), /commit messages and PR descriptions/);
  assert.ok(!describeRepoLanguage({ commit: "영어", doc: "한국어" }).includes("README"));
});

test("근거를 사실별로 따로 댄다 — 커밋 이력과 문서 이유를 뒤섞지 않는다", () => {
  const commitOnly = describeRepoLanguage({ commit: "영어", doc: "한국어" });
  assert.match(commitOnly, /because this repository's commit history is in English/);
  assert.ok(!commitOnly.includes("documentation"));

  const docOnly = describeRepoLanguage({ commit: "한국어", doc: "영어" });
  assert.match(docOnly, /because this repository's documentation is in English/);
  assert.ok(!docOnly.includes("commit history"));

  const both = describeRepoLanguage({ commit: "영어", doc: "영어" });
  assert.match(both, /commit history is in English/);
  assert.match(both, /documentation is in English/);
  assert.ok(!both.includes(" and README"), "이중 and 로 이어붙이지 않는다");
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
  assert.match(text, /user's explicit instruction always overrides this note/);
});

test("대화 언어를 무조건 지시하지 않는다 — 조건문으로만 건다", () => {
  // SessionStart 시점에는 사용자가 이번 세션에서 무슨 언어로 말할지 아직 모른다.
  // 영어로 쓰는 사용자에게까지 "한국어로 대화하라"고 무조건 지시하면 안 된다.
  const text = describeRepoLanguage({ commit: "영어", doc: "영어" });
  assert.match(text, /^If the user is writing in Korean/m, "조건문으로 시작해야 한다");
  assert.ok(
    !/^(대화는|Converse|Talk to the user)/m.test(text),
    "무조건적인 대화 언어 지시가 있으면 안 된다"
  );
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
    assert.match(output.hookSpecificOutput.additionalContext, /in English/);
    assert.match(output.hookSpecificOutput.additionalContext, /^If the user is writing in Korean/m);
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

test("끄는 값은 대소문자와 표기를 가리지 않는다", () => {
  withRepo(["Add cache", "Fix bug", "Bump deps"], undefined, (dir) => {
    for (const off of ["off", "OFF", "0", "false", "FALSE"]) {
      assert.equal(runHook(dir, { KIMCHI_REPO_LANG: off }), null, `KIMCHI_REPO_LANG=${off}`);
    }
  });
});

test("망가진 입력에도 조용히 끝난다", () => {
  for (const input of ["", "not json", "{}", "null"]) {
    const stdout = execFileSync("node", [HOOK], { input, encoding: "utf8" });
    // 이 저장소는 한국어라 빈 출력이 맞다. 중요한 것은 멈추지 않는 것이다.
    assert.equal(stdout.trim(), "", `입력 "${input}"`);
  }
});
