// 시험용 규칙 객체를 만든다.
//
// 규칙 객체의 모양은 parseTable, lint, byPriority, toRow 사이의 약속이다. 그 모양을
// 시험 파일마다 따로 적어 두면 필드가 하나 늘 때 한 곳을 빠뜨리게 되고, 그 시험은
// 생산 코드가 만들지 않는 모양을 검사하게 된다.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 이 파일(helpers.mjs)의 위치를 기준으로 저장소 루트를 잡는다. 시험 파일마다
// 따로 계산하면 ".." 개수를 하나 틀렸을 때 그 파일만 조용히 엉뚱한 경로를 본다.
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  en: "",
  bad: "얇은 계약",
  good: "낮은 결합도",
  why: "은유 직역",
  check: "치환",
  priority: "핵심",
  source: "metaphors.md",
};

/**
 * 규칙 객체 하나를 만든다. 넘긴 값만 기본값을 덮는다.
 * @param {object} [overrides]
 * @returns {object}
 */
export function rule(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

/**
 * 규칙을 여러 개 만든다. 분량 상한을 시험할 때 쓴다.
 *
 * 색인을 세 자리로 채우는 이유는 행 길이를 맞추기 위해서다. 길이가 다르면 짧은 행이
 * 남은 자리에 끼어들어 순위나 예산을 재는 시험이 흐려진다.
 *
 * @param {number} count
 * @param {(index: number, tag: string) => object} build
 * @returns {object[]}
 */
export function manyRules(count, build) {
  return Array.from({ length: count }, (_, index) => {
    const tag = String(index).padStart(3, "0");
    return rule(build(index, tag));
  });
}

/**
 * fn() 을 여러 번 재서 가장 빠른 값을 돌려준다.
 *
 * CI/개발 머신에서 여러 시험이 동시에 도는 동안은 한 번 잰 시간이 다른 프로세스의
 * 스케줄링에 그대로 흔들린다. 최솟값은 "이 코드가 실제로 걸리는 시간"에 훨씬
 * 가깝고, 이차 비용 회귀(알고리즘이 O(n²)로 퇴화하는 것)는 최솟값에도 그대로 남는다
 * — 재는 목적은 그 회귀를 잡는 것이지 절대 시간을 재는 것이 아니다.
 *
 * @param {() => void} fn
 * @param {number} [runs]
 * @returns {number} 밀리초
 */
export function fastestMs(fn, runs = 3) {
  let best = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const start = Date.now();
    fn();
    const ms = Date.now() - start;
    if (ms < best) best = ms;
  }
  return best;
}

/**
 * 훅에 넣을 tool-call 페이로드 하나를 만든다.
 *
 * hook_event_name/tool_name/tool_input 세 필드는 훅이 실제로 받는 모양 그대로다.
 * 시험마다 이 리터럴을 손으로 적으면 필드 이름 오타 하나가 조용히 통과한다(훅이
 * 모르는 이벤트로 보고 아무 것도 안 하기 때문이다).
 * @param {string} event "PreToolUse" | "PostToolUse"
 * @param {string} tool
 * @param {object} input tool_input
 * @returns {object}
 */
export function toolCall(event, tool, input) {
  return { hook_event_name: event, tool_name: tool, tool_input: input };
}

/**
 * 훅 스크립트 하나를 실제 프로세스로 돌리고 stdout 을 JSON 으로 돌려준다.
 *
 * clear 로 넘긴 KIMCHI_* 변수는 빈 문자열로 지운 뒤 env 를 덮어쓴다 — 실행 중인
 * 셸/CI 환경에 그 변수가 이미 켜져 있어도 시험이 그 값을 물려받지 않게 하기 위해서다.
 * @param {string} scriptPath
 * @param {object} payload
 * @param {{env?: object, clear?: string[], maxBuffer?: number}} [options]
 * @returns {object | null}
 */
export function runNodeJson(scriptPath, payload, { env = {}, clear = [], maxBuffer } = {}) {
  const cleared = Object.fromEntries(clear.map((key) => [key, ""]));
  const stdout = execFileSync("node", [scriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    ...(maxBuffer ? { maxBuffer } : {}),
    env: { ...process.env, ...cleared, ...env },
  });
  return stdout.trim() === "" ? null : JSON.parse(stdout);
}

/**
 * 임시 디렉터리를 만들어 fn 에 넘기고, 끝나면(예외가 나도) 지운다.
 * @param {(dir: string) => any} fn
 * @param {string} [prefix]
 * @returns {any}
 */
export function withTempDir(fn, prefix = "kimchi-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 커밋 제목 목록(과 선택적 README)으로 임시 git 저장소를 만든다. */
export function makeRepo(subjects, readme) {
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

/** makeRepo 로 저장소를 만들어 body 에 넘기고, 끝나면 지운다. */
export function withRepo(subjects, readme, body) {
  const dir = makeRepo(subjects, readme);
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 실제 README 만큼의 분량이어야 판정 문턱을 실물에 맞게 시험한다 — 100자짜리
// 문서로는 애초에 판정하지 않는 것이 맞고, 문턱을 자료에 맞춰 낮추면 실제
// 오판이 늘어난다.
export const ENGLISH_DOC = [
  "# Project",
  "",
  "This project does a thing. The documentation is written in English for contributors",
  "who may not read Korean. Everything here follows that convention consistently.",
  "",
  "Another paragraph explains how to build and test the project on a local machine",
  "without any additional setup beyond a recent version of the runtime.",
  "",
].join("\n");

/**
 * hooks/ 와 rules/ 를 이상한 이름의 디렉터리로 복사한다. 실제 저장소 경로에서
 * 심볼릭 링크·공백·한글이 섞여도 훅이 여전히 도는지를 시험할 때 쓴다. base(복사본이
 * 들어앉은 임시 디렉터리 자체)를 지우는 것은 부른 쪽 몫이다.
 * @param {string} [name] 그 아래 만들 디렉터리 이름(공백/한글 등 이상한 이름을 시험할 때 씀)
 * @returns {string} <base>/<name> 경로
 */
export function copyPlugin(name = "plugin") {
  const base = mkdtempSync(join(tmpdir(), "kimchi-plugin-"));
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, "hooks"), join(dir, "hooks"), { recursive: true });
  cpSync(join(ROOT, "rules"), join(dir, "rules"), { recursive: true });
  return dir;
}

export const PII_PAYLOAD = toolCall("PreToolUse", "Write", {
  file_path: "a.txt",
  content: "주민번호 900101-1234568",
});
