#!/usr/bin/env node
// 훅 지연 시간을 base(develop 등 비교 대상)와 head(이번 PR) 트리에서 재서 회귀를
// 눈에 보이게 만든다(불변식 10 — 훅은 도구 호출마다 돌고, 예산은 호출당 ~100ms,
// 그중 ~80ms는 Node 시작 시간이라고 명시돼 있다). 지금까지는 tests/*.test.mjs의
// 느슨한 타임아웃만이 이 예산을 지켰는데, 타임아웃은 몇 배씩 벌어져야 겨우 잡히므로
// 서서히 느려지는 회귀는 통과해 버린다. 이 스크립트는 base→head 상대 비교로
// 그 사각지대를 메운다.
//
// 정해진 합성 페이로드 집합(hooks/lib에 실제로 있는 갈래 — 빠른 경로 PII만 검사,
// git commit 차단 모드, 자동 교정 모드의 작은/큰 문서, PostToolUse 기본 경고 경로,
// SessionStart)에 대해 `node <dir>/hooks/guard.mjs`·`session-language.mjs`를 실제로
// 스폰해 벽시계 시간을 잰다. base/head를 ABBA 순서로 번갈아 실행해 러너 자체의
// 드리프트(스로틀링, 캐시 상태 변화, 먼저 도는 쪽이 유리해지는 위치 효과)를 양쪽에
// 고르게 나눠 싣는다. 앞쪽 몇 회는 웜업으로 버린다(첫 스폰은 파일시스템 캐시가 덜
// 데워져 있다). 스폰 하나가 훅 제한 시간(5초)을 한참 넘겨도 안 끝나면(무한 루프,
// 병리적 정규식 백트래킹처럼 이 봇이 잡아야 할 바로 그 회귀) 죽이고 그 자체를
// 회귀로 보고한다 — execFileSync가 영원히 막혀 job이 끝나지 않으면 안 된다. 1차
// 측정에서 회귀로 보인 페이로드만 더 많은 반복으로 재확인한 뒤에만 최종 회귀로
// 남긴다(부하가 심한 러너에서는 표본이 적으면 잡음도 문턱을 넘을 수 있다).
//
// 오프라인이다(불변식 10). 네트워크를 열지 않는다.
//
// 사용법:
//   node scripts/hook-latency.mjs --base <디렉터리> --head <디렉터리>
//     [--runs N] [--warmup N] [--spawn-timeout-ms N] [--out 파일] [--json 파일]

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, writeJson, writeText, runMain } from "./lib/cli.mjs";

export const MARKER = "<!-- kimchi-claude-hook-latency -->";

// 회귀로 보려면 두 조건을 모두 만족해야 한다. 비율만 보면 원래 값이 몇 ms인 빠른
// 경로(예: PII만 보는 PreToolUse Bash)에서 1ms → 1.3ms 같은 잡음도 "30% 증가"로
// 잡힌다. 절대값만 보면 이미 느린 경로(대용량 문서 자동 교정)에서 10% 늘어난 실제
// 회귀를 놓친다. 두 문턱을 and로 묶어야 잡음과 실제 회귀가 갈린다.
export const REGRESSION_RATIO = 0.2;
export const REGRESSION_FLOOR_MS = 10;

// 웜업으로 버리는 앞쪽 반복 수. 첫 스폰 몇 번은 파일시스템 캐시가 덜 데워져 있어
// 이후 반복보다 눈에 띄게 느리다(실측: 첫 스폰이 이후 중앙값보다 수십 ms 더 걸림).
export const DEFAULT_WARMUP = 2;
// 페이로드당 기록하는 반복 수. 부하가 심한 러너에서는 이 정도 표본으로도 개별 회차
// 편차가 ±30%까지 벌어질 수 있었다(재확인 절차 — CONFIRM_RUNS 참고 — 가 그 잡음을
// 거른다). 러너 예산(2분) 안에서 회귀로 보이는 페이로드만 추가 비용을 문다.
export const DEFAULT_RUNS = 8;

// 스폰 하나의 상한. 이보다 오래 걸리면 execFileSync가 죽이고 timedOut:true로
// 돌아온다 — 던지지 않는다. 이 상한이 없으면 무한 루프나 병리적 정규식
// 백트래킹처럼 이 봇이 정확히 잡아야 할 회귀 앞에서 이 execFileSync 호출 자체가
// 영원히 막혀(GitHub Actions job 기본 상한 6시간까지) job이 끝나지 않고 코멘트도
// 못 남긴다. 훅 제한 시간(hooks.json의 timeout: 5초)의 3배로 잡아 정상적인 느린
// 실행(대용량 문서, 부하가 심한 러너)까지 오탐으로 죽이지 않으면서도 진짜 멈춘
// 프로세스는 확실히 잡는다.
export const SPAWN_TIMEOUT_MS = 15_000;

// 1차 측정에서 회귀로 보인 페이로드만 다시 재는 반복 수. 표본을 늘리면 개별 회차
// 편차가 중앙값에 미치는 영향이 줄어든다.
export const CONFIRM_RUNS = 20;
export const CONFIRM_WARMUP = 2;

// head 타임아웃 전용 재확인. 통계 문턱이 아니라 "다시 걸리는가"로만 판단하므로
// CONFIRM_RUNS보다 훨씬 적게, 그리고 head만 재도 된다(measurePayload의 sides 참고).
export const TIMEOUT_CONFIRM_RETRIES = 3;
export const TIMEOUT_CONFIRM_MIN_HITS = 2;

// 스크립트 전체에 쓸 수 있는 시간 상한. head가 정말로 멈춰 있으면(모든 페이로드가
// guard.mjs를 부른다) 페이로드마다 최악의 경우 SPAWN_TIMEOUT_MS(15초, 초기 감지 —
// stopAfterFirstHeadTimeout 덕에 딱 1번만) + TIMEOUT_CONFIRM_RETRIES * SPAWN_TIMEOUT_MS
// (45초, 재확인)로 ~60초가 든다. 페이로드가 늘어날수록(지금 7개) 이 비용이
// 선형으로 쌓여(7 * 60초 ≈ 7분) job의 timeout-minutes보다 오래 걸릴 수 있다 — 이
// 상한을 넘기면 남은 페이로드는 스폰하지 않고 "시간이 모자라 측정하지 못했습니다"로
// 건너뛴다. job의 timeout-minutes(15분)보다 여유 있게 짧게 잡아, 이 상한이 잘라낸
// 뒤에도 결과 파일을 쓸 시간이 남게 한다.
export const SCRIPT_DEADLINE_MS = 8 * 60 * 1000;

/** 훅에 넣을 tool-call 페이로드 하나를 만든다. tests/helpers.mjs의 toolCall과 같은 모양이다. */
function toolCall(event, tool, input) {
  return { hook_event_name: event, tool_name: tool, tool_input: input };
}

// 말투 규칙에 실제로 걸리는 짧은 문장을 반복해 목표 바이트 수를 채운다. 규칙표에
// 있는 실제 항목(rules/terms.md의 blast radius/loose coupling)을 써서, 자동 교정
// 체인(rules → lint → particle → segment)이 실제로 무언가를 찾아 처리하게 만든다 —
// 아무것도 안 걸리는 텍스트로는 체인의 일부만 재고 전체 비용을 재지 못한다.
const TONE_HIT_SENTENCE =
  "이 모듈은 블라스트 레디우스가 넓고 루즈 커플링 문제가 있어서, 당신의 코드에서 " +
  "우리는 이 문제를 반드시 먼저 손봐야 합니다. ";

function koreanDoc(targetBytes) {
  let text = "";
  while (Buffer.byteLength(text, "utf8") < targetBytes) text += TONE_HIT_SENTENCE;
  return text;
}

/**
 * SessionStart 페이로드용 임시 저장소. 영어 커밋 이력만 있으면 되므로 base/head
 * 양쪽이 공유해도 무방하다(session-language.mjs는 저장소 자체가 아니라 그 안의
 * 훅 스크립트만 트리마다 다르게 부른다). commit.gpgsign과 core.hooksPath를
 * 명시적으로 끈다 — 이 스크립트를 돌리는 머신의 전역 git 설정(서명 요구, 로컬
 * pre-commit 훅)에 이 임시 저장소의 커밋이 엮이면 이유를 알기 힘든 실패나 정지로
 * 이어진다.
 * @returns {string} 저장소 경로
 */
function makeEnglishRepo() {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-hook-latency-repo-"));
  const gitConfigArgs = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
  execFileSync("git", [...gitConfigArgs, "init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  for (const subject of ["Add cache layer", "Fix race condition", "Bump dependency versions"]) {
    appendFileSync(join(dir, "f.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", [...gitConfigArgs, "commit", "-q", "-m", subject], { cwd: dir });
  }
  return dir;
}

/**
 * 대표 페이로드 목록을 만든다. ctx.englishRepoDir처럼 한 번만 만들면 되는 자원은
 * main()이 미리 준비해 넘긴다.
 * @param {{englishRepoDir: string}} ctx
 */
export function buildPayloads(ctx) {
  const smallDoc = koreanDoc(5 * 1024);
  const largeDoc = koreanDoc(200 * 1024);
  return [
    {
      name: "PreToolUse Bash 일반 명령 (빠른 경로)",
      script: "hooks/guard.mjs",
      env: {},
      input: toolCall("PreToolUse", "Bash", { command: "ls -la" }),
    },
    {
      name: "PreToolUse Bash git commit (한국어 메시지, 차단 모드)",
      script: "hooks/guard.mjs",
      env: { KIMCHI_BLOCK: "1" },
      input: toolCall("PreToolUse", "Bash", {
        command: 'git commit -m "블라스트 레디우스를 영향 범위로 고쳤습니다"',
      }),
    },
    {
      name: "PreToolUse Write 5KB 한국어 문서 (자동 교정 모드)",
      script: "hooks/guard.mjs",
      env: { KIMCHI_AUTOFIX: "1" },
      input: toolCall("PreToolUse", "Write", { file_path: "notes.md", content: smallDoc }),
    },
    {
      name: "PostToolUse Edit 작은 new_string (경고 경로)",
      script: "hooks/guard.mjs",
      env: {},
      input: toolCall("PostToolUse", "Edit", {
        file_path: "notes.md",
        old_string: "가",
        new_string: "블라스트 레디우스",
      }),
    },
    {
      name: "PreToolUse Write 200KB 대용량 문서 (자동 교정 모드)",
      script: "hooks/guard.mjs",
      env: { KIMCHI_AUTOFIX: "1" },
      input: toolCall("PreToolUse", "Write", { file_path: "big.md", content: largeDoc }),
    },
    {
      // 기본 설정(KIMCHI_AUTOFIX·KIMCHI_BLOCK 둘 다 꺼짐)의 PostToolUse는 그래도
      // checkTone을 태운다(guard.mjs의 checkTone은 event !== "PreToolUse"면 항상
      // 돈다) — 이것이 아무 설정도 켜지 않은 기본 사용자가 대용량 문서를 쓸 때마다
      // 실제로 내는 비용이다. 위 200KB 페이로드는 자동 교정 모드만 재므로 이
      // 페이로드가 없으면 "기본값 그대로 쓰는 사용자"의 경로는 5KB짜리로만 잡힌다.
      name: "PostToolUse Write 200KB 대용량 문서 (기본 모드)",
      script: "hooks/guard.mjs",
      env: {},
      input: toolCall("PostToolUse", "Write", { file_path: "big.md", content: largeDoc }),
    },
    {
      name: "SessionStart 영어 저장소 이력",
      script: "hooks/session-language.mjs",
      env: {},
      input: { cwd: ctx.englishRepoDir },
    },
  ];
}

/** 오름차순 정렬 사본을 만든다. */
function sorted(values) {
  return [...values].sort((a, b) => a - b);
}

/** @param {number[]} values @returns {number} */
export function median(values) {
  if (values.length === 0) return NaN;
  const xs = sorted(values);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** 최근접 순위(nearest-rank) 방식의 백분위수. 표본이 적어도(8개 안팎) 안정적이다. */
export function percentile(values, p) {
  if (values.length === 0) return NaN;
  const xs = sorted(values);
  const rank = Math.ceil((p / 100) * xs.length);
  const idx = Math.min(xs.length - 1, Math.max(0, rank - 1));
  return xs[idx];
}

/**
 * base→head 중앙값이 두 문턱을 모두 넘을 때만 회귀로 본다.
 * @param {number} baseMedian
 * @param {number} headMedian
 */
export function isRegression(baseMedian, headMedian) {
  if (!Number.isFinite(baseMedian) || !Number.isFinite(headMedian)) return false;
  const deltaMs = headMedian - baseMedian;
  if (deltaMs < REGRESSION_FLOOR_MS) return false;
  if (baseMedian <= 0) return true;
  return deltaMs / baseMedian >= REGRESSION_RATIO;
}

/** KIMCHI_* 를 지운 환경에 overrides를 얹는다. 훅이 실행 중인 셸의 설정을 물려받지 않게 한다. */
function cleanEnv(overrides) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KIMCHI_")));
  return { ...base, ...overrides };
}

/**
 * 스크립트 하나를 실제로 스폰해 벽시계 시간(ms)을 잰다. 출력은 버린다 — 잴 것은
 * 실행 시간이지 산출물 내용이 아니고, 대용량 문서 페이로드에서 stdout을 그대로
 * 받으면 버퍼링 자체가 시간에 섞여 들어간다.
 *
 * `timeoutMs`가 지나도 안 끝나면 execFileSync가 killSignal(기본 SIGTERM)로 죽이고
 * 던진다 — 그 실패(`err.signal`이 채워져 있다)는 예외로 전파하지 않고
 * `timedOut: true`로 알린다. 이 함수를 부르는 쪽이 무한 루프·병리적 정규식
 * 백트래킹 같은 회귀를 만나면, 그 사실 자체가 잴 결과이지 스크립트를 죽여야 할
 * 오류가 아니다.
 * @param {string} scriptPath
 * @param {object} payload
 * @param {number} [timeoutMs]
 * @returns {{ms: number|null, timedOut: boolean}}
 */
export function spawnOnce(scriptPath, payload, timeoutMs = SPAWN_TIMEOUT_MS) {
  const start = process.hrtime.bigint();
  try {
    execFileSync("node", [scriptPath], {
      input: JSON.stringify(payload.input),
      env: cleanEnv(payload.env),
      stdio: ["pipe", "ignore", "ignore"],
      timeout: timeoutMs,
    });
  } catch (err) {
    if (err && (err.signal || err.killed)) {
      return { ms: null, timedOut: true };
    }
    throw err;
  }
  const end = process.hrtime.bigint();
  return { ms: Number(end - start) / 1e6, timedOut: false };
}

/**
 * 4회를 한 묶음으로 base/head 중 누가 먼저 스폰되는지를 뒤집는다(A,B,B,A) — 고전
 * ABBA 균형화다. 항상 같은 순서(ABAB)로만 재면 "먼저 도는 쪽이 파일시스템 캐시를
 * 데워 둔다" 같은 위치 효과가 있을 때 그 효과를 한쪽에만 고정해서 싣는다. ABBA는
 * 그 위치도 절반씩 나눠 겪게 해, 선형 드리프트뿐 아니라 위치 효과까지 상쇄한다.
 * @param {number} i
 * @returns {["base","head"]|["head","base"]}
 */
function orderForIteration(i) {
  const pos = i % 4;
  return pos === 0 || pos === 3 ? ["base", "head"] : ["head", "base"];
}

/**
 * 페이로드 하나를 base/head에서 ABBA 순서로 재고, 각 스폰의 타임아웃 여부를 센다.
 * 한쪽 트리에 스크립트 자체가 없으면(새 훅) 그 트리는 건너뛰고 missing으로
 * 표시한다. `sides`로 한쪽만 재게 할 수 있다 — head 타임아웃을 head만 다시 재
 * 확인할 때(`confirmTimeoutIfNeeded`) base 왕복까지 더할 이유가 없다.
 *
 * `stopAfterFirstHeadTimeout`이 켜져 있으면 head가 한 번이라도 타임아웃되는 순간
 * 나머지 반복을 그만둔다 — head가 정말로 멈춰 있으면(모든 스폰이 타임아웃) 이
 * 옵션 없이는 `runs+warmup`회(기본 10회) 내내 매번 `SPAWN_TIMEOUT_MS`(15초)를
 * 기다리게 되고, 그 비용이 페이로드마다 쌓여(지금 7개) job의 timeout-minutes를
 * 넘길 수 있다. 최초 감지는 "멈췄는지 아닌지"만 알면 되므로 1번으로 충분하고,
 * "몇 번 멈췄는지"의 확인은 `confirmTimeoutIfNeeded`가 head만 따로, 정해진
 * 횟수만큼 재는 것으로 넘긴다(그 호출에는 이 옵션을 켜지 않는다 — 3회를 다
 * 채워야 재현 여부를 셀 수 있다).
 * @param {string} baseDir
 * @param {string} headDir
 * @param {object} payload
 * @param {{runs?: number, warmup?: number, timeoutMs?: number, sides?: ("base"|"head")[], stopAfterFirstHeadTimeout?: boolean, spawn?: (scriptPath: string) => {ms: number|null, timedOut: boolean}}} [options]
 */
export function measurePayload(baseDir, headDir, payload, options = {}) {
  const {
    runs = DEFAULT_RUNS,
    warmup = DEFAULT_WARMUP,
    timeoutMs = SPAWN_TIMEOUT_MS,
    sides = ["base", "head"],
    stopAfterFirstHeadTimeout = false,
    spawn = (scriptPath) => spawnOnce(scriptPath, payload, timeoutMs),
  } = options;

  const baseScript = join(baseDir, payload.script);
  const headScript = join(headDir, payload.script);
  const baseMissing = !existsSync(baseScript);
  const headMissing = !existsSync(headScript);

  const baseSamples = [];
  const headSamples = [];
  let baseTimeouts = 0;
  let headTimeouts = 0;
  const total = runs + warmup;
  let attemptsCompleted = 0;

  for (let i = 0; i < total; i += 1) {
    attemptsCompleted = i + 1;
    let headTimedOutThisIteration = false;
    for (const side of orderForIteration(i)) {
      if (!sides.includes(side)) continue;
      if (side === "base" && !baseMissing) {
        const { ms, timedOut } = spawn(baseScript);
        if (timedOut) baseTimeouts += 1;
        else if (i >= warmup) baseSamples.push(ms);
      } else if (side === "head" && !headMissing) {
        const { ms, timedOut } = spawn(headScript);
        if (timedOut) {
          headTimeouts += 1;
          headTimedOutThisIteration = true;
        } else if (i >= warmup) headSamples.push(ms);
      }
    }
    if (stopAfterFirstHeadTimeout && headTimedOutThisIteration) break;
  }

  return { baseMissing, headMissing, baseSamples, headSamples, baseTimeouts, headTimeouts, attempts: attemptsCompleted };
}

function summarize(samples) {
  if (samples.length === 0) return null;
  return { medianMs: median(samples), p90Ms: percentile(samples, 90) };
}

/**
 * measurePayload 결과 하나를 base/head 요약 + 회귀 판정으로 바꾼다. 타임아웃이
 * 하나라도 있으면(특히 head) 잠정적으로 회귀로 본다 — 최종 판정은
 * `confirmTimeoutIfNeeded`가 head만 다시 재서 확정한다(1차 측정 한 번의 타임아웃은
 * 부하가 심한 러너에서 우연히도 일어날 수 있다).
 * @param {object} payload
 * @param {ReturnType<typeof measurePayload>} measured
 */
export function toResult(payload, measured) {
  const base = measured.baseMissing ? null : summarize(measured.baseSamples);
  const head = measured.headMissing ? null : summarize(measured.headSamples);
  const deltaMs = base && head ? head.medianMs - base.medianMs : null;
  const deltaPct = base && head && base.medianMs > 0 ? (deltaMs / base.medianMs) * 100 : null;
  const headTimeouts = measured.headTimeouts || 0;
  const baseTimeouts = measured.baseTimeouts || 0;

  let regression = base && head ? isRegression(base.medianMs, head.medianMs) : false;
  let timeoutNote = null;
  if (headTimeouts > 0) {
    timeoutNote =
      `head가 훅 제한 시간(5초)을 훌쩍 넘겨 ${SPAWN_TIMEOUT_MS / 1000}초 안에도 끝나지 않았습니다` +
      `(${headTimeouts}/${measured.attempts}회). 무한 루프나 병리적 정규식 백트래킹처럼 훅 자체를 멈추는 회귀일 수 있습니다(재확인 중).`;
    regression = true;
  } else if (baseTimeouts > 0) {
    timeoutNote =
      `base가 ${SPAWN_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다(${baseTimeouts}/${measured.attempts}회). ` +
      `비교 기준 자체가 미덥지 않으니 이 행의 delta는 참고만 하십시오.`;
  }

  return {
    name: payload.name,
    script: payload.script,
    baseMissing: measured.baseMissing,
    headMissing: measured.headMissing,
    base,
    head,
    deltaMs,
    deltaPct,
    regression,
    confirmed: null,
    headTimeouts,
    baseTimeouts,
    timeoutConfirmed: null,
    timeoutNote,
    error: null,
  };
}

/**
 * 1차 측정에서 회귀로 보인 페이로드만 CONFIRM_RUNS회로 다시 재서 확인한다. 부하가
 * 심한 러너에서는 DEFAULT_RUNS(8) 남짓한 표본으로도 개별 회차 편차가 ±30%까지
 * 벌어질 수 있다(공유 인프라의 이웃 부하) — 딱 한 번 문턱을 넘었다고 바로
 * 경고하면 그 잡음까지 회귀로 보고한다. 재확인에서도 넘으면(재현) 회귀로 남기고,
 * 아니면(잡음) 정상으로 되돌린다. 타임아웃으로 이미 확정된 결과는 다시 재지
 * 않는다 — 통계로 판단할 문제가 아니다.
 *
 * `measure`는 (payload, {runs, warmup}) => measurePayload(...) 모양의 함수다.
 * base/head 디렉터리를 이 함수의 인자로 받지 않고 호출부가 클로저로 미리
 * 묶어 넘기게 한 것은, 시험이 실제 스폰 없이 순수 함수만으로 이 재확인 로직을
 * 검증할 수 있게 하기 위해서다. confirmRuns/confirmWarmup을 옵션으로 받는 것도
 * 같은 이유다 — tests/hook-latency.test.mjs의 구조 확인용 통합 시험은 --runs 1
 * 로 재기 때문에(단일 표본이라 노이즈만으로도 자주 트립한다) 기본 CONFIRM_RUNS(20)
 * 그대로면 트립할 때마다 스폰이 수십 번씩 추가로 늘어 시험이 오래 걸린다.
 * @param {object} payload
 * @param {ReturnType<typeof toResult>} result
 * @param {(payload: object, opts: {runs: number, warmup: number}) => ReturnType<typeof measurePayload>} measure
 * @param {{confirmRuns?: number, confirmWarmup?: number}} [options]
 */
export function confirmIfRegression(payload, result, measure, options = {}) {
  const { confirmRuns = CONFIRM_RUNS, confirmWarmup = CONFIRM_WARMUP } = options;
  if (!result.regression || result.headTimeouts > 0 || result.baseTimeouts > 0) return result;
  // stopAfterFirstHeadTimeout을 여기서도 켠다 — 통계 회귀로 보였던 페이로드가
  // 재확인 도중(20회) 갑자기 멈추기 시작해도 이 호출 하나가 20 * 15초까지
  // 늘어지지 않게 하는 방어선이다. 이 경로로 들어왔다는 것은 1차 측정에서는
  // 타임아웃이 없었다는 뜻이라 흔한 경우는 아니지만, 비용이 없는 방어다.
  const confirmMeasured = measure(payload, { runs: confirmRuns, warmup: confirmWarmup, stopAfterFirstHeadTimeout: true });
  const confirmResult = toResult(payload, confirmMeasured);
  return {
    ...result,
    confirmed: confirmResult.regression,
    regression: confirmResult.regression,
    confirmBase: confirmResult.base,
    confirmHead: confirmResult.head,
  };
}

/**
 * head 쪽에 타임아웃이 하나라도 있으면 그 자체를 최종 회귀로 확정하기 전에 head만
 * `TIMEOUT_CONFIRM_RETRIES`(3)회 다시 재본다. 부하가 심한 러너에서는 15초짜리
 * `SPAWN_TIMEOUT_MS`도 우연히 한 번은 넘길 수 있다(실측: A/A 재현 중 10회 중 2회가
 * 거짓 타임아웃이었다) — 그런데 그 우연이 "훅 제한 시간을 넘긴 회귀"라는, 신뢰를
 * 가장 크게 깎는 거짓 경보로 이어지면 안 된다. 진짜 무한 루프나 병리적 정규식
 * 백트래킹은 재시도마다 다시 걸리지만, 일시적 부하는 3번 연속(또는 3번 중 2번)
 * 재현되기 어렵다 — 그래서 `TIMEOUT_CONFIRM_MIN_HITS`(2)회 이상 다시 타임아웃돼야만
 * 최종적으로 회귀로 확정한다. base는 다시 재지 않는다(`measurePayload`의
 * `sides: ["head"]`) — head만 문제 삼는 판정에 base 왕복 비용을 더할 이유가 없다.
 * 최악의 경우 추가 비용은 `TIMEOUT_CONFIRM_RETRIES * SPAWN_TIMEOUT_MS` ≈ 45초로,
 * 페이로드 하나에만 국한된다.
 *
 * `measure`는 confirmIfRegression과 같은 (payload, opts) => measurePayload(...) 모양의
 * 함수다 — 시험이 실제 스폰 없이 순수 함수만으로 이 로직을 검증할 수 있게 한다.
 * @param {object} payload
 * @param {ReturnType<typeof toResult>} result
 * @param {(payload: object, opts: object) => ReturnType<typeof measurePayload>} measure
 */
export function confirmTimeoutIfNeeded(payload, result, measure) {
  if (result.headTimeouts === 0) return result;
  const confirmMeasured = measure(payload, { runs: TIMEOUT_CONFIRM_RETRIES, warmup: 0, sides: ["head"] });
  const timeouts = confirmMeasured.headTimeouts || 0;
  const attempts = confirmMeasured.attempts || TIMEOUT_CONFIRM_RETRIES;

  if (timeouts >= TIMEOUT_CONFIRM_MIN_HITS) {
    return {
      ...result,
      confirmed: true,
      timeoutConfirmed: true,
      regression: true,
      timeoutNote:
        `head가 훅 제한 시간(5초)을 훌쩍 넘겨 ${SPAWN_TIMEOUT_MS / 1000}초 안에도 끝나지 않았고, ` +
        `재확인 ${attempts}회 중 ${timeouts}회에서도 다시 타임아웃됐습니다. 무한 루프나 병리적 정규식 ` +
        `백트래킹처럼 훅 자체를 멈추는 회귀로 보입니다.`,
    };
  }
  return {
    ...result,
    confirmed: false,
    timeoutConfirmed: false,
    regression: false,
    timeoutNote:
      `head가 1차 측정에서 훅 제한 시간을 넘긴 적이 있지만, 재확인 ${attempts}회 중 ${timeouts}회만 다시` +
      ` 넘겨 일시적 부하로 보고 회귀로 세지 않았습니다.`,
  };
}

function fmtMs(n) {
  return Number.isFinite(n) ? `${n.toFixed(1)}ms` : "—";
}

function fmtPct(n) {
  return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(1)}%` : "—";
}

function markFor(result) {
  if (result.skipped) return "⏳ 시간 부족";
  if (result.error) return "❗ 오류";
  // timeoutConfirmed === false: 1차 측정에서 head가 타임아웃됐지만 재확인에서
  // 재현되지 않았다 — headTimeouts는 여전히 >0(1차 기록을 남겨 둔다)이므로 아래
  // "⏱️ head 타임아웃" 분기보다 반드시 먼저 봐야 한다.
  if (result.timeoutConfirmed === false) return "정상(시간 초과가 재확인에서 사라짐)";
  if (result.headTimeouts > 0) return "⏱️ head 타임아웃(회귀)";
  if (result.baseTimeouts > 0) return "⏱️ base 타임아웃";
  if (result.regression) return result.confirmed !== null ? "⚠️ 회귀(재확인됨)" : "⚠️ 회귀";
  if (result.confirmed === false) return "정상(재확인에서 사라짐)";
  if (result.baseMissing || result.headMissing) return "비교 불가";
  return "정상";
}

/** 결과 하나를 표 한 줄로 만든다. */
function resultRow(result) {
  if (result.error || result.skipped) return `| ${result.name} | — | — | — | ${markFor(result)} |`;
  const baseCell = result.baseMissing
    ? "base에 없음"
    : result.base
      ? `${fmtMs(result.base.medianMs)} (p90 ${fmtMs(result.base.p90Ms)})`
      : "표본 없음";
  const headCell = result.headMissing
    ? "head에 없음"
    : result.head
      ? `${fmtMs(result.head.medianMs)} (p90 ${fmtMs(result.head.p90Ms)})`
      : "표본 없음";
  const deltaCell = result.deltaMs === null || result.deltaMs === undefined ? "—" : `${fmtMs(result.deltaMs)} (${fmtPct(result.deltaPct)})`;
  return `| ${result.name} | ${baseCell} | ${headCell} | ${deltaCell} | ${markFor(result)} |`;
}

/**
 * 결과 목록을 사람이 읽는 합니다체 마크다운으로 만든다.
 * @param {ReturnType<typeof toResult>[]} results
 * @param {{runs: number, warmup: number}} options
 */
export function buildMarkdown(results, { runs, warmup }) {
  const regressions = results.filter((r) => r.regression);
  // 재확인에서 사라진 타임아웃(timeoutConfirmed === false)은 더 이상 회귀가 아니므로
  // 눈에 띄는 절에서 뺀다 — 표의 "정상(시간 초과가 재확인에서 사라짐)" 표시로 충분하다.
  const timeouts = results.filter(
    (r) => ((r.headTimeouts || 0) > 0 && r.timeoutConfirmed !== false) || (r.baseTimeouts || 0) > 0
  );
  const skipped = results.filter((r) => r.skipped);
  const errored = results.filter((r) => r.error && !r.skipped);

  const lines = [
    MARKER,
    "",
    "## 훅 지연 시간 비교",
    "",
    `합성 페이로드 ${results.length}개를 base/head에서 ABBA 순서로 번갈아(웜업 ${warmup}회 제외, 기록 ${runs}회) 실제로` +
      ` 스폰해 벽시계 시간을 쟀습니다. 회귀는 head 중앙값이 base 중앙값보다 ${(REGRESSION_RATIO * 100).toFixed(
        0
      )}% 이상, 그리고 ${REGRESSION_FLOOR_MS}ms 이상 늘어났을 때만 표시합니다(둘 다 만족해야 합니다 — 노이즈 문턱입니다).` +
      ` 문턱을 넘은 페이로드만 ${CONFIRM_RUNS}회로 다시 재확인해, 그때도 넘을 때만 최종 회귀로 남겼습니다.` +
      ` 스폰 하나가 ${SPAWN_TIMEOUT_MS / 1000}초 안에도 끝나지 않으면(훅 제한 시간 5초를 이미 넘긴 것입니다)` +
      ` head만 ${TIMEOUT_CONFIRM_RETRIES}회 다시 재보고, 그 중 ${TIMEOUT_CONFIRM_MIN_HITS}회 이상 다시` +
      ` 넘겨야 회귀로 확정합니다(한 번의 타임아웃은 일시적 부하일 수 있습니다).`,
    "",
  ];

  if (timeouts.length > 0) {
    lines.push("### 시간 제한을 넘은 페이로드 — 훅이 멈췄을 수 있습니다", "");
    for (const r of timeouts) lines.push(`- **${r.name}**: ${r.timeoutNote}`);
    lines.push("");
  }

  if (errored.length > 0) {
    lines.push("### 측정하지 못한 페이로드", "");
    for (const r of errored) lines.push(`- **${r.name}**: ${r.error}`);
    lines.push("");
  }

  if (skipped.length > 0) {
    lines.push("### 시간이 모자라 건너뛴 페이로드", "");
    lines.push(
      `아래 ${skipped.length}개는 스크립트 전체 시간 상한(${
        SCRIPT_DEADLINE_MS / 1000
      }초)을 넘겨 스폰하지 않고 건너뛰었습니다 — 앞선 페이로드에서 head가 멈춰(타임아웃) 시간을 많이 썼을 수 있습니다.`,
      ""
    );
    for (const r of skipped) lines.push(`- **${r.name}**`);
    lines.push("");
  }

  lines.push(
    regressions.length > 0
      ? `회귀로 보이는 페이로드가 ${regressions.length}개 있습니다.`
      : "회귀로 보이는 페이로드가 없습니다.",
    "",
    "| 페이로드 | base | head | 차이 | 판정 |",
    "|---|---|---|---|---|",
    ...results.map(resultRow)
  );
  return lines.join("\n");
}

/** 실패했을 때 남기는 마커 본문. rule-impact.mjs와 같은 원칙 — 실패 자체를 결과로 보고한다. */
function failureMarkdown(message) {
  return `${MARKER}\n\n훅 지연 시간을 측정하지 못했습니다(${message}).`;
}

// SCRIPT_DEADLINE_MS를 넘겨 건너뛴 페이로드에 붙이는 문구. error 필드에 그대로
// 실어 기존 "측정하지 못한 페이로드" 배관(마크다운 절, JSON 표시)을 그대로 쓴다 —
// 다만 markFor/resultRow는 result.skipped로 이 경우만 다른 표시(⏳)를 붙인다.
const SKIPPED_MESSAGE = "시간이 모자라 측정하지 못했습니다.";

export function buildSummary(results, { runs, warmup }) {
  return {
    regressions: results.filter((r) => r.regression).length,
    runs,
    warmup,
    thresholds: { ratio: REGRESSION_RATIO, floorMs: REGRESSION_FLOOR_MS, spawnTimeoutMs: SPAWN_TIMEOUT_MS },
    payloads: results,
  };
}

/**
 * 이 스크립트가 직접 실행됐는지 본다. hooks/lib/entrypoint.mjs의 isEntrypoint를
 * 일부러 쓰지 않는다 — 이 스크립트는 정확히 hooks/를 건드리는 PR의 지연 시간을
 * 재려고 만들었는데, 그 훅 라이브러리 자신의 export가 바뀌거나 깨지는 PR이면
 * 이 파일 맨 위의 정적 import가 아래 main()의 try보다 먼저 로딩 자체를 실패시켜
 * 코멘트조차 못 남긴다(재는 대상이 재는 도구 자신을 깨뜨리는 순환 취약점). 심볼릭
 * 링크 해석 같은 정교함은 여기서 필요 없다 — 이 스크립트는 항상
 * `node scripts/hook-latency.mjs`로 직접 실행되므로, argv[1]과 이 파일의 실제
 * 경로를 그대로 비교하는 것으로 충분하다.
 * @param {string} importMetaUrl
 * @returns {boolean}
 */
function isEntrypoint(importMetaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fileURLToPath(importMetaUrl) === resolve(argv1);
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base || !args.head) {
    throw new Error("--base와 --head 디렉터리를 모두 지정해야 합니다.");
  }
  const runs = args.runs ? Number(args.runs) : DEFAULT_RUNS;
  // --warmup·--spawn-timeout-ms·--confirm-runs·--confirm-warmup·--deadline-ms는 시험
  // (tests/hook-latency.test.mjs)이 구조만 확인하는 통합 시험이나 타임아웃·시간 상한
  // 경로를 빠르게 재현하려고 줄여 부르는 용도다. 실사용(워크플로)에서는 기본값을 그대로 쓴다.
  const warmup = args.warmup !== undefined ? Number(args.warmup) : DEFAULT_WARMUP;
  const timeoutMs = args["spawn-timeout-ms"] !== undefined ? Number(args["spawn-timeout-ms"]) : SPAWN_TIMEOUT_MS;
  const confirmRuns = args["confirm-runs"] !== undefined ? Number(args["confirm-runs"]) : CONFIRM_RUNS;
  const confirmWarmup = args["confirm-warmup"] !== undefined ? Number(args["confirm-warmup"]) : CONFIRM_WARMUP;
  const deadlineMs = args["deadline-ms"] !== undefined ? Number(args["deadline-ms"]) : SCRIPT_DEADLINE_MS;
  const baseDir = resolve(String(args.base));
  const headDir = resolve(String(args.head));

  // englishRepoDir 준비와 결과 파일 쓰기까지를 통째로 감싼다 — 이 스크립트가 CI에서
  // 어디서 실패하든(임시 저장소를 못 만들거나, writeText/writeJson 자체가 던지거나)
  // 낡은 sticky 코멘트를 그대로 두는 대신 실패했다는 사실 자체를 마커가 든 짧은
  // 본문으로 남기고 정상 종료한다. 페이로드 하나의 측정 실패는 이 바깥 try가 아니라
  // 아래 for 루프 안의 개별 try가 잡는다 — 한 페이로드가 예상 밖으로 던져도 나머지
  // 페이로드의 행은 그대로 보고돼야 한다.
  let englishRepoDir;
  try {
    englishRepoDir = makeEnglishRepo();
    const payloads = buildPayloads({ englishRepoDir });
    const measure = (payload, opts) => measurePayload(baseDir, headDir, payload, { timeoutMs, ...opts });

    // payloads.map이 아니라 명시적 for 루프를 쓴다 — 페이로드마다 시작 전에 전체
    // 경과 시간을 확인해, 상한(deadlineMs)을 넘겼으면 그 뒤로는 스폰 자체를 하지
    // 않고 건너뛴다. head가 정말로 멈춰 있으면(모든 페이로드가 guard.mjs를
    // 부른다) stopAfterFirstHeadTimeout으로 페이로드당 비용을 ~60초로 줄여도,
    // 페이로드 수가 늘어나면(지금 7개) 그 비용이 선형으로 쌓여 job의
    // timeout-minutes를 넘길 수 있다 — 이 상한이 마지막 방어선이다.
    const scriptStart = Date.now();
    const results = [];
    for (const payload of payloads) {
      if (Date.now() - scriptStart > deadlineMs) {
        results.push({ name: payload.name, script: payload.script, error: SKIPPED_MESSAGE, skipped: true });
        continue;
      }
      try {
        let result = toResult(payload, measure(payload, { runs, warmup, stopAfterFirstHeadTimeout: true }));
        try {
          if (result.headTimeouts > 0) {
            // head 타임아웃은 통계 문턱과 다른 방식으로 확인한다 — head만 적게
            // 재본다(TIMEOUT_CONFIRM_RETRIES). confirmIfRegression은 여기서 부르지
            // 않는다 — 통계 재확인은 애초에 타임아웃 결과를 손대지 않는다.
            result = confirmTimeoutIfNeeded(payload, result, measure);
          } else if (result.regression) {
            result = confirmIfRegression(payload, result, measure, { confirmRuns, confirmWarmup });
          }
        } catch (err) {
          result.confirmError = err && err.message ? err.message : String(err);
        }
        results.push(result);
      } catch (err) {
        results.push({
          name: payload.name,
          script: payload.script,
          error: err && err.message ? err.message : String(err),
        });
      }
    }

    writeText(buildMarkdown(results, { runs, warmup }), args.out);
    writeJson(buildSummary(results, { runs, warmup }), args.json);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    writeText(failureMarkdown(message), args.out);
    writeJson({ regressions: 0, error: message }, args.json);
  } finally {
    if (englishRepoDir) rmSync(englishRepoDir, { recursive: true, force: true });
  }
}

if (isEntrypoint(import.meta.url)) runMain(main);
