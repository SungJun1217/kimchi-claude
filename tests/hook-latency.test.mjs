// scripts/hook-latency.mjs 시험. 순수 통계 함수(median/percentile/isRegression)와
// 마크다운 조립은 합성 값으로 직접 부른다. 실제 스폰 경로는 --runs 1로 아주 작게만
// 돌려 "구조가 맞는지"만 본다 — 타이밍 자체는 시험 환경(다른 시험과 동시에 도는
// CI 러너)에서 흔들리므로 여기서 회귀 여부를 단정하지 않는다(과제 지시대로).
// --confirm-runs 1 --confirm-warmup 0도 함께 준다 — 단일 표본(--runs 1)은 노이즈만
// 으로도 문턱을 자주 넘어 재확인이 걸리는데, 기본 CONFIRM_RUNS(20) 그대로면 트립할
// 때마다 스폰이 수십 번씩 늘어 이 시험이 오래 걸린다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir, ROOT } from "./helpers.mjs";
import {
  MARKER,
  REGRESSION_RATIO,
  REGRESSION_FLOOR_MS,
  CONFIRM_RUNS,
  CONFIRM_WARMUP,
  TIMEOUT_CONFIRM_RETRIES,
  TIMEOUT_CONFIRM_MIN_HITS,
  SCRIPT_DEADLINE_MS,
  median,
  percentile,
  isRegression,
  toResult,
  confirmIfRegression,
  confirmTimeoutIfNeeded,
  measurePayload,
  buildMarkdown,
  buildSummary,
} from "../scripts/hook-latency.mjs";

const HOOK_LATENCY = join(ROOT, "scripts", "hook-latency.mjs");

// 통합 시험이 매번 hooks/ 트리를 복사하는 준비 과정을 공유한다.
function prepareHooksCopy(dir, { headOverride } = {}) {
  const baseDir = join(dir, "base");
  const headDir = join(dir, "head");
  execFileSync("mkdir", ["-p", baseDir, headDir]);
  execFileSync("cp", ["-R", join(ROOT, "hooks"), baseDir]);
  execFileSync("cp", ["-R", join(ROOT, "hooks"), headDir]);
  if (headOverride) {
    for (const [relPath, content] of Object.entries(headOverride)) {
      writeFileSync(join(headDir, relPath), content);
    }
  }
  return { baseDir, headDir };
}

// ---- 순수 함수 단위 시험 ----

test("median: 홀수/짝수 개수를 모두 가운데 값으로 잡는다", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test("percentile: 표본이 적어도(8개 안팎) p90을 안정적으로 낸다", () => {
  const xs = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  assert.equal(percentile(xs, 90), 18, "최근접 순위 방식: ceil(0.9*10)=9번째(1부터 셈) 값");
  // percentile은 최근접 순위 방식이라, 표본이 짝수 개일 때 median(가운데 두 값의 평균)과
  // 한 자리 어긋날 수 있다(50번째 백분위 = ceil(0.5*10)=5번째 값인 14, median은 14.5) —
  // 이 어긋남 자체가 두 함수가 다른 방식이라는 뜻이라 여기서는 상식적인 범위인지만 본다.
  assert.ok(percentile(xs, 50) >= 13 && percentile(xs, 50) <= 15);
  assert.ok(Number.isNaN(percentile([], 90)));
});

test("isRegression: 비율과 절대값 문턱을 모두 넘어야 회귀다", () => {
  // 비율은 넘지만(30%) 절대값이 문턱(10ms) 밑이면 잡음으로 본다.
  assert.equal(isRegression(20, 26), false, "6ms 차이는 절대값 문턱 밑이다");
  // 절대값은 넘지만(15ms) 비율(3%)이 낮으면 회귀가 아니다.
  assert.equal(isRegression(500, 515), false, "3% 증가는 비율 문턱 밑이다");
  // 둘 다 넘으면 회귀다.
  assert.equal(isRegression(50, 65), true, "50 → 65는 30%이자 15ms다");
  // head가 더 빨라지면 회귀가 아니다.
  assert.equal(isRegression(100, 80), false);
  assert.equal(REGRESSION_RATIO, 0.2);
  assert.equal(REGRESSION_FLOOR_MS, 10);
});

test("isRegression: NaN이 섞이면 판정하지 않는다", () => {
  assert.equal(isRegression(NaN, 100), false);
  assert.equal(isRegression(100, NaN), false);
});

test("재확인 상수가 기본값 그대로다(문서·워크플로가 이 값을 인용한다)", () => {
  assert.equal(CONFIRM_RUNS, 20);
  assert.equal(CONFIRM_WARMUP, 2);
  assert.equal(TIMEOUT_CONFIRM_RETRIES, 3);
  assert.equal(TIMEOUT_CONFIRM_MIN_HITS, 2);
  assert.equal(SCRIPT_DEADLINE_MS, 8 * 60 * 1000);
});

// ---- toResult / buildMarkdown / buildSummary ----

const PAYLOAD = { name: "시험 페이로드", script: "hooks/guard.mjs" };

test("toResult: base·head 모두 있으면 중앙값·p90·차이를 계산한다", () => {
  const measured = {
    baseMissing: false,
    headMissing: false,
    baseSamples: [100, 102, 104],
    headSamples: [130, 132, 134],
    baseTimeouts: 0,
    headTimeouts: 0,
    attempts: 3,
  };
  const result = toResult(PAYLOAD, measured);
  assert.equal(result.base.medianMs, 102);
  assert.equal(result.head.medianMs, 132);
  assert.equal(result.deltaMs, 30);
  assert.ok(result.deltaPct > 29 && result.deltaPct < 30);
  assert.equal(result.regression, true);
  assert.equal(result.headTimeouts, 0);
  assert.equal(result.timeoutNote, null);
});

test("toResult: base에 스크립트가 없으면(새 훅) base를 null로, 비교 불가로 남긴다", () => {
  const measured = {
    baseMissing: true,
    headMissing: false,
    baseSamples: [],
    headSamples: [100, 101, 102],
    baseTimeouts: 0,
    headTimeouts: 0,
    attempts: 3,
  };
  const result = toResult(PAYLOAD, measured);
  assert.equal(result.base, null);
  assert.equal(result.baseMissing, true);
  assert.equal(result.deltaMs, null);
  assert.equal(result.regression, false);
});

test("toResult: head가 타임아웃되면 통계와 무관하게 회귀로, 눈에 띄는 문구를 남긴다", () => {
  const measured = {
    baseMissing: false,
    headMissing: false,
    baseSamples: [50, 51, 52],
    headSamples: [51, 52], // 나머지 회차는 타임아웃
    baseTimeouts: 0,
    headTimeouts: 1,
    attempts: 3,
  };
  const result = toResult(PAYLOAD, measured);
  assert.equal(result.regression, true, "타임아웃은 통계 문턱과 무관하게 회귀다");
  assert.match(result.timeoutNote, /훅 제한 시간/);
  assert.match(result.timeoutNote, /1\/3회/);
});

test("toResult: base만 타임아웃되면 회귀로 강제하지 않되 문구는 남긴다", () => {
  const measured = {
    baseMissing: false,
    headMissing: false,
    baseSamples: [50],
    headSamples: [50, 51, 52],
    baseTimeouts: 2,
    headTimeouts: 0,
    attempts: 3,
  };
  const result = toResult(PAYLOAD, measured);
  assert.equal(result.regression, false);
  assert.match(result.timeoutNote, /base가/);
});

test("buildMarkdown: 마커로 시작하고 회귀 페이로드 수를 말한다", () => {
  const results = [
    toResult(PAYLOAD, {
      baseMissing: false,
      headMissing: false,
      baseSamples: [50, 51],
      headSamples: [80, 81],
      baseTimeouts: 0,
      headTimeouts: 0,
      attempts: 2,
    }),
    toResult(
      { ...PAYLOAD, name: "정상 페이로드" },
      {
        baseMissing: false,
        headMissing: false,
        baseSamples: [50, 51],
        headSamples: [51, 52],
        baseTimeouts: 0,
        headTimeouts: 0,
        attempts: 2,
      }
    ),
  ];
  const md = buildMarkdown(results, { runs: 8, warmup: 2 });
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /회귀로 보이는 페이로드가 1개 있습니다/);
  assert.ok(md.includes("시험 페이로드"));
  assert.ok(md.includes("정상 페이로드"));
});

test("buildMarkdown: base에 없는 훅은 'base에 없음'으로 표시한다", () => {
  const results = [
    toResult(PAYLOAD, {
      baseMissing: true,
      headMissing: false,
      baseSamples: [],
      headSamples: [50, 51],
      baseTimeouts: 0,
      headTimeouts: 0,
      attempts: 2,
    }),
  ];
  const md = buildMarkdown(results, { runs: 8, warmup: 2 });
  assert.ok(md.includes("base에 없음"));
});

test("buildMarkdown: 회귀가 없으면 그렇게 말한다", () => {
  const results = [
    toResult(PAYLOAD, {
      baseMissing: false,
      headMissing: false,
      baseSamples: [50, 51],
      headSamples: [51, 52],
      baseTimeouts: 0,
      headTimeouts: 0,
      attempts: 2,
    }),
  ];
  const md = buildMarkdown(results, { runs: 8, warmup: 2 });
  assert.match(md, /회귀로 보이는 페이로드가 없습니다/);
});

test("buildMarkdown: 타임아웃·오류 행은 표뿐 아니라 별도 절에도 눈에 띄게 남는다", () => {
  const timeoutResult = toResult(PAYLOAD, {
    baseMissing: false,
    headMissing: false,
    baseSamples: [50],
    headSamples: [],
    baseTimeouts: 0,
    headTimeouts: 3,
    attempts: 3,
  });
  const errorResult = { name: "오류 페이로드", script: "hooks/session-language.mjs", error: "node가 1로 종료했습니다" };
  const md = buildMarkdown([timeoutResult, errorResult], { runs: 8, warmup: 2 });
  assert.ok(md.includes("시간 제한을 넘은 페이로드"));
  assert.ok(md.includes("측정하지 못한 페이로드"));
  assert.ok(md.includes("오류 페이로드"));
  assert.match(md, /회귀로 보이는 페이로드가 1개 있습니다/, "타임아웃은 회귀 개수에 포함된다");
});

test("buildMarkdown: 재확인에서 사라진 타임아웃은 '정상'으로 표시되고 눈에 띄는 절에서 빠진다", () => {
  const first = toResult(PAYLOAD, {
    baseMissing: false,
    headMissing: false,
    baseSamples: [50, 51],
    headSamples: [],
    baseTimeouts: 0,
    headTimeouts: 3,
    attempts: 3,
  });
  const deconfirmed = confirmTimeoutIfNeeded(PAYLOAD, first, () => ({
    baseMissing: false,
    headMissing: false,
    baseSamples: [],
    headSamples: [60, 61, 62],
    baseTimeouts: 0,
    headTimeouts: 0,
    attempts: 3,
  }));
  const md = buildMarkdown([deconfirmed], { runs: 8, warmup: 2 });
  assert.match(md, /회귀로 보이는 페이로드가 없습니다/);
  assert.ok(!md.includes("시간 제한을 넘은 페이로드"), "재확인에서 사라졌으면 눈에 띄는 절에 남으면 안 된다");
  assert.ok(md.includes("정상(시간 초과가 재확인에서 사라짐)"));
});

test("buildSummary: 회귀 개수와 문턱을 함께 낸다", () => {
  const results = [
    toResult(PAYLOAD, {
      baseMissing: false,
      headMissing: false,
      baseSamples: [50, 51],
      headSamples: [80, 81],
      baseTimeouts: 0,
      headTimeouts: 0,
      attempts: 2,
    }),
  ];
  const summary = buildSummary(results, { runs: 8, warmup: 2 });
  assert.equal(summary.regressions, 1);
  assert.equal(summary.thresholds.ratio, REGRESSION_RATIO);
  assert.equal(summary.thresholds.floorMs, REGRESSION_FLOOR_MS);
  assert.equal(summary.payloads.length, 1);
});

// ---- confirmIfRegression: 주입한 측정 함수로 재확인 로직만 순수하게 시험한다 ----

function regressionResult() {
  return toResult(PAYLOAD, {
    baseMissing: false,
    headMissing: false,
    baseSamples: [50, 51],
    headSamples: [80, 81],
    baseTimeouts: 0,
    headTimeouts: 0,
    attempts: 2,
  });
}

test("confirmIfRegression: 회귀가 아니면 손대지 않는다", () => {
  const normal = toResult(PAYLOAD, {
    baseMissing: false,
    headMissing: false,
    baseSamples: [50, 51],
    headSamples: [51, 52],
    baseTimeouts: 0,
    headTimeouts: 0,
    attempts: 2,
  });
  let called = false;
  const measure = () => {
    called = true;
    return {};
  };
  const result = confirmIfRegression(PAYLOAD, normal, measure);
  assert.equal(result, normal);
  assert.equal(called, false, "회귀가 아니면 다시 재지 않는다");
});

test("confirmIfRegression: 재확인에서도 트립하면 회귀로 남긴다", () => {
  const first = regressionResult();
  let capturedOpts = null;
  const measure = (payload, opts) => {
    capturedOpts = opts;
    // 재확인에서도 같은 정도로 벌어진 표본을 준다 — 재현된 것으로 본다.
    return {
      baseMissing: false,
      headMissing: false,
      baseSamples: Array(10).fill(50),
      headSamples: Array(10).fill(80),
      baseTimeouts: 0,
      headTimeouts: 0,
      attempts: 10,
    };
  };
  const result = confirmIfRegression(PAYLOAD, first, measure, { confirmRuns: 10, confirmWarmup: 1 });
  assert.equal(result.regression, true);
  assert.equal(result.confirmed, true);
  assert.deepEqual(
    capturedOpts,
    { runs: 10, warmup: 1, stopAfterFirstHeadTimeout: true },
    "confirmRuns/confirmWarmup을 그대로 넘기고, stopAfterFirstHeadTimeout도 방어적으로 켜야 한다"
  );
});

test("confirmIfRegression: 재확인에서 사라지면(잡음) 정상으로 되돌린다", () => {
  const first = regressionResult();
  const measure = () => ({
    // 재확인에서는 base/head가 사실상 같다 — 1차 측정의 문턱 초과가 잡음이었다는 뜻이다.
    baseMissing: false,
    headMissing: false,
    baseSamples: Array(10).fill(50),
    headSamples: Array(10).fill(51),
    baseTimeouts: 0,
    headTimeouts: 0,
    attempts: 10,
  });
  const result = confirmIfRegression(PAYLOAD, first, measure, { confirmRuns: 10, confirmWarmup: 1 });
  assert.equal(result.regression, false, "재확인에서 트립하지 않으면 정상으로 되돌아가야 한다");
  assert.equal(result.confirmed, false);
});

test("confirmIfRegression: 타임아웃으로 확정된 결과는 다시 재지 않는다", () => {
  const timeoutResult = toResult(PAYLOAD, {
    baseMissing: false,
    headMissing: false,
    baseSamples: [50],
    headSamples: [],
    baseTimeouts: 0,
    headTimeouts: 2,
    attempts: 2,
  });
  let called = false;
  const measure = () => {
    called = true;
    return {};
  };
  const result = confirmIfRegression(PAYLOAD, timeoutResult, measure);
  assert.equal(result, timeoutResult);
  assert.equal(called, false, "타임아웃은 통계가 아니라 이미 확정된 사실이다");
});

// ---- confirmTimeoutIfNeeded: 주입한 측정 함수로 타임아웃 재확인만 순수하게 시험한다 ----

function timeoutResult({ headTimeouts = 2 } = {}) {
  return toResult(PAYLOAD, {
    baseMissing: false,
    headMissing: false,
    baseSamples: [50, 51],
    headSamples: [],
    baseTimeouts: 0,
    headTimeouts,
    attempts: 2,
  });
}

test("confirmTimeoutIfNeeded: 타임아웃이 없으면 손대지 않는다", () => {
  const normal = toResult(PAYLOAD, {
    baseMissing: false,
    headMissing: false,
    baseSamples: [50, 51],
    headSamples: [51, 52],
    baseTimeouts: 0,
    headTimeouts: 0,
    attempts: 2,
  });
  let called = false;
  const measure = () => {
    called = true;
    return {};
  };
  const result = confirmTimeoutIfNeeded(PAYLOAD, normal, measure);
  assert.equal(result, normal);
  assert.equal(called, false);
});

test("confirmTimeoutIfNeeded: 재확인 3회 중 2회 이상 다시 타임아웃되면 회귀로 확정한다", () => {
  const first = timeoutResult();
  let capturedOpts = null;
  const measure = (payload, opts) => {
    capturedOpts = opts;
    return { baseMissing: false, headMissing: false, baseSamples: [], headSamples: [], baseTimeouts: 0, headTimeouts: 2, attempts: 3 };
  };
  const result = confirmTimeoutIfNeeded(PAYLOAD, first, measure);
  assert.equal(result.regression, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.timeoutConfirmed, true);
  assert.match(result.timeoutNote, /재확인 3회 중 2회/);
  assert.deepEqual(capturedOpts, { runs: TIMEOUT_CONFIRM_RETRIES, warmup: 0, sides: ["head"] }, "head만, 웜업 없이 재야 한다");
});

test("confirmTimeoutIfNeeded: 재확인에서 1회 이하만 다시 타임아웃되면(일시적 부하) 정상으로 되돌린다", () => {
  const first = timeoutResult();
  const measure = () => ({
    baseMissing: false,
    headMissing: false,
    baseSamples: [],
    headSamples: [60, 61],
    baseTimeouts: 0,
    headTimeouts: 1, // 3회 중 1회만 — TIMEOUT_CONFIRM_MIN_HITS(2) 미만
    attempts: 3,
  });
  const result = confirmTimeoutIfNeeded(PAYLOAD, first, measure);
  assert.equal(result.regression, false, "재현되지 않은 타임아웃은 회귀가 아니다");
  assert.equal(result.confirmed, false);
  assert.equal(result.timeoutConfirmed, false);
  assert.match(result.timeoutNote, /일시적 부하/);
  // headTimeouts는 1차 측정 기록을 그대로 남긴다 — markFor가 timeoutConfirmed를
  // 먼저 보고 "정상"으로 표시하지만, 애초에 몇 번 걸렸었는지는 지우지 않는다.
  assert.equal(result.headTimeouts, 2);
});

test("confirmTimeoutIfNeeded: 재확인에서 아예 안 걸리면(0/3) 정상으로 되돌린다", () => {
  const first = timeoutResult();
  const measure = () => ({
    baseMissing: false,
    headMissing: false,
    baseSamples: [],
    headSamples: [60, 61, 62],
    baseTimeouts: 0,
    headTimeouts: 0,
    attempts: 3,
  });
  const result = confirmTimeoutIfNeeded(PAYLOAD, first, measure);
  assert.equal(result.regression, false);
  assert.equal(result.timeoutConfirmed, false);
});

// ---- measurePayload/spawnOnce: 실제 타임아웃 경로 ----

test(
  "head 훅이 멈추면(무한 루프) 타임아웃으로 잡아 회귀로 표시한다",
  { timeout: 20_000 },
  () => {
    withTempDir((dir) => {
      const { baseDir, headDir } = prepareHooksCopy(dir, {
        headOverride: { "hooks/guard.mjs": "for (;;) {}\n" },
      });
      const payload = {
        name: "무한 루프 시험",
        script: "hooks/guard.mjs",
        env: {},
        input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" } },
      };
      // timeoutMs를 짧게 줘서(300ms) 시험이 SPAWN_TIMEOUT_MS(15초) 기본값을 기다리지
      // 않게 한다 — 이 옵션 자체가 실사용과 다른 값이라는 뜻이 아니라, 시험은 "타임아웃
      // 경로가 작동하는지"만 보면 된다.
      const timeoutMs = 300;
      const measure = (p, opts) => measurePayload(baseDir, headDir, p, { timeoutMs, ...opts });
      // runs:5, warmup:2(총 7회 반복)로 줘서, stopAfterFirstHeadTimeout이 없으면
      // 7번 다 head가 걸려 7 * 300ms가 들 상황을 만든다. attempts === 1이면 첫
      // 타임아웃에서 실제로 멈췄다는 뜻이다.
      const measured = measure(payload, { runs: 5, warmup: 2, stopAfterFirstHeadTimeout: true });
      assert.equal(measured.headTimeouts, 1, "head 스폰이 첫 시도에서 타임아웃으로 잡혀야 한다");
      assert.equal(measured.baseTimeouts, 0, "base(정상 guard.mjs)는 타임아웃되면 안 된다");
      assert.equal(measured.attempts, 1, "stopAfterFirstHeadTimeout이 나머지 6회를 건너뛰어야 한다");

      let result = toResult(payload, measured);
      assert.equal(result.regression, true, "1차 측정에서는 잠정적으로 회귀다");

      // 무한 루프는 진짜로 멈춰 있으므로 재확인(head만 3회 재시도)에서도 매번 다시
      // 타임아웃돼야 한다 — confirmTimeoutIfNeeded까지 거쳐도 최종적으로 회귀로
      // 남아야, 이 통합 시험이 실제 타임아웃 경로 전체(1차 측정 → 재확인)를 검증한다.
      result = confirmTimeoutIfNeeded(payload, result, measure);
      assert.equal(result.regression, true, "무한 루프는 재확인에서도 다시 걸려야 한다");
      assert.equal(result.timeoutConfirmed, true);
      assert.match(result.timeoutNote, /훅 제한 시간/);
      assert.match(result.timeoutNote, /재확인/);
    }, "kimchi-hook-latency-test-");
  }
);

test("무한 루프여도 head 스폰은 페이로드당 최대 1(초기)+3(재확인)회로 제한된다(주입한 spawn으로 센다)", () => {
  withTempDir((dir) => {
    const baseDir = join(dir, "base");
    const headDir = join(dir, "head");
    execFileSync("mkdir", ["-p", join(baseDir, "hooks"), join(headDir, "hooks")]);
    // 내용은 절대 실행되지 않는다 — spawn을 통째로 주입해 대체했으므로 existsSync가
    // 볼 파일이 있기만 하면 된다.
    writeFileSync(join(baseDir, "hooks", "guard.mjs"), "");
    writeFileSync(join(headDir, "hooks", "guard.mjs"), "");

    const payload = {
      name: "무한 루프(주입)",
      script: "hooks/guard.mjs",
      env: {},
      input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" } },
    };
    const headScript = join(headDir, "hooks", "guard.mjs");
    let headCalls = 0;
    let baseCalls = 0;
    const spawn = (scriptPath) => {
      if (scriptPath === headScript) {
        headCalls += 1;
        return { ms: null, timedOut: true }; // 실제로 자지 않는다 — 항상 즉시 "타임아웃됐다"고만 답한다.
      }
      baseCalls += 1;
      return { ms: 50, timedOut: false };
    };
    const measure = (p, opts) => measurePayload(baseDir, headDir, p, { ...opts, spawn });

    // 1차 측정: runs+warmup을 크게 줘도(기본값 그대로, 10회) stopAfterFirstHeadTimeout이
    // head 스폰을 1번에서 끊어야 한다.
    let result = toResult(payload, measure(payload, { stopAfterFirstHeadTimeout: true }));
    assert.equal(headCalls, 1, "1차 측정에서 head는 최대 1번만 불려야 한다(무한 루프라도)");

    result = confirmTimeoutIfNeeded(payload, result, measure);
    assert.equal(result.regression, true);
    assert.equal(headCalls, 1 + TIMEOUT_CONFIRM_RETRIES, "재확인은 head를 정확히 TIMEOUT_CONFIRM_RETRIES회 더 불러야 한다");
    // base는 확인 단계에서 한 번도 안 불린다(sides: ["head"]) — 왕복 비용을 더하지 않는다는 설계다.
    assert.ok(baseCalls <= 1, "base는 1차 측정 1회뿐, 재확인에서는 안 불려야 한다");
  }, "kimchi-hook-latency-test-");
});

// ---- 통합 시험: 실제로 스크립트를 돌린다(구조만 확인, 타이밍은 확인하지 않는다) ----

test("실제로 돌리면 base=head 복사본에서도 결과 구조가 맞다", { timeout: 60_000 }, () => {
  withTempDir((dir) => {
    const { baseDir, headDir } = prepareHooksCopy(dir);

    const outMd = join(dir, "out.md");
    const outJson = join(dir, "out.json");
    execFileSync("node", [
      HOOK_LATENCY,
      "--base",
      baseDir,
      "--head",
      headDir,
      "--runs",
      "1",
      "--warmup",
      "0",
      "--confirm-runs",
      "1",
      "--confirm-warmup",
      "0",
      "--out",
      outMd,
      "--json",
      outJson,
    ]);

    const md = execFileSync("cat", [outMd], { encoding: "utf8" });
    assert.ok(md.startsWith(MARKER));
    assert.ok(md.includes("| 페이로드 |"));

    const summary = JSON.parse(execFileSync("cat", [outJson], { encoding: "utf8" }));
    assert.equal(typeof summary.regressions, "number");
    assert.ok(Array.isArray(summary.payloads));
    assert.ok(summary.payloads.length >= 7, "대표 페이로드가 전부 있어야 한다");
    for (const payload of summary.payloads) {
      assert.equal(payload.error, null, "base=head 복사본에서 오류가 나면 안 된다");
      assert.equal(payload.baseMissing, false, "base=head 복사본이라 둘 다 있어야 한다");
      assert.equal(payload.headMissing, false);
      assert.equal(typeof payload.base.medianMs, "number");
      assert.equal(typeof payload.head.medianMs, "number");
    }
  }, "kimchi-hook-latency-test-");
});

test("base 트리에 훅이 없으면(새 훅) 크래시 없이 base에 없음으로 보고한다", { timeout: 60_000 }, () => {
  withTempDir((dir) => {
    const baseDir = join(dir, "base");
    const headDir = join(dir, "head");
    execFileSync("mkdir", ["-p", join(baseDir, "hooks", "lib")]);
    execFileSync("cp", ["-R", join(ROOT, "hooks"), headDir]);

    const outJson = join(dir, "out.json");
    execFileSync("node", [
      HOOK_LATENCY,
      "--base",
      baseDir,
      "--head",
      headDir,
      "--runs",
      "1",
      "--warmup",
      "0",
      "--confirm-runs",
      "1",
      "--confirm-warmup",
      "0",
      "--json",
      outJson,
    ]);

    const summary = JSON.parse(execFileSync("cat", [outJson], { encoding: "utf8" }));
    assert.ok(summary.payloads.every((p) => p.baseMissing === true));
    assert.equal(summary.regressions, 0, "비교 불가는 회귀로 세지 않는다");
  }, "kimchi-hook-latency-test-");
});

test(
  "한 페이로드가 실패해도(head의 session-language.mjs가 깨짐) 나머지 행은 그대로 보고된다",
  { timeout: 60_000 },
  () => {
    withTempDir((dir) => {
      const { baseDir, headDir } = prepareHooksCopy(dir, {
        headOverride: { "hooks/session-language.mjs": "process.exit(1);\n" },
      });

      const outJson = join(dir, "out.json");
      execFileSync("node", [
        HOOK_LATENCY,
        "--base",
        baseDir,
        "--head",
        headDir,
        "--runs",
        "1",
        "--warmup",
        "0",
        "--confirm-runs",
        "1",
        "--confirm-warmup",
        "0",
        "--json",
        outJson,
      ]);

      const summary = JSON.parse(execFileSync("cat", [outJson], { encoding: "utf8" }));
      const broken = summary.payloads.find((p) => p.script === "hooks/session-language.mjs");
      assert.ok(broken.error, "깨진 페이로드는 error 필드를 달아야 한다");

      const others = summary.payloads.filter((p) => p.script === "hooks/guard.mjs");
      assert.ok(others.length >= 6, "guard.mjs 페이로드가 모두 그대로 있어야 한다");
      for (const p of others) assert.equal(p.error, null, "다른 페이로드는 실패로 물들면 안 된다");
    }, "kimchi-hook-latency-test-");
  }
);

test(
  "head 훅이 guard.mjs·session-language.mjs 모두에서 멈춰도(무한 루프) 전체 실행이 시간 안에 끝난다",
  { timeout: 30_000 },
  () => {
    withTempDir((dir) => {
      // 대표 페이로드 7개 전부(guard.mjs 6개 + session-language.mjs 1개)가 head에서
      // 멈추는 최악의 경우를 재현한다 — 정확히 코디네이터가 지적한 시나리오다.
      const { baseDir, headDir } = prepareHooksCopy(dir, {
        headOverride: {
          "hooks/guard.mjs": "for (;;) {}\n",
          "hooks/session-language.mjs": "for (;;) {}\n",
        },
      });

      const outJson = join(dir, "out.json");
      const start = Date.now();
      execFileSync("node", [
        HOOK_LATENCY,
        "--base",
        baseDir,
        "--head",
        headDir,
        "--spawn-timeout-ms",
        "200",
        "--json",
        outJson,
      ]);
      const elapsedMs = Date.now() - start;

      // stopAfterFirstHeadTimeout이 없다면(고치기 전) 7개 페이로드 * (기본 runs+warmup=10)회
      // * 200ms ≈ 14초가 1차 측정에만 들고, 재확인(최대 3회 * 200ms)까지 더하면 이 시험
      // 자체가 아래 상한을 넘겨 실패했을 것이다 — 고친 뒤에는 페이로드당 최대
      // 1(초기)+TIMEOUT_CONFIRM_RETRIES(재확인)회뿐이라 훨씬 짧게 끝나야 한다.
      assert.ok(elapsedMs < 15_000, `전체 실행이 ${elapsedMs}ms 걸렸다 — stopAfterFirstHeadTimeout이 작동하지 않는 것으로 보인다`);

      const summary = JSON.parse(execFileSync("cat", [outJson], { encoding: "utf8" }));
      assert.ok(summary.payloads.length >= 7);
      for (const p of summary.payloads) {
        assert.equal(p.regression, true, `${p.name}는 head가 멈췄으니 회귀로 확정돼야 한다`);
        assert.equal(p.timeoutConfirmed, true, `${p.name}는 재확인(3회)에서도 다시 멈췄어야 한다`);
      }
    }, "kimchi-hook-latency-test-");
  }
);

test(
  "시간 상한(--deadline-ms)을 넘기면 남은 페이로드를 건너뛰고도 보고서를 낸다",
  { timeout: 30_000 },
  () => {
    withTempDir((dir) => {
      const { baseDir, headDir } = prepareHooksCopy(dir);
      const outMd = join(dir, "out.md");
      const outJson = join(dir, "out.json");
      execFileSync("node", [
        HOOK_LATENCY,
        "--base",
        baseDir,
        "--head",
        headDir,
        "--runs",
        "1",
        "--warmup",
        "0",
        "--deadline-ms",
        "1",
        "--out",
        outMd,
        "--json",
        outJson,
      ]);

      const summary = JSON.parse(execFileSync("cat", [outJson], { encoding: "utf8" }));
      assert.ok(summary.payloads.length >= 7);
      // 상한 확인은 페이로드마다 시작 전에 하므로, 1ms처럼 극단적으로 짧아도 첫
      // 페이로드는 (기준 시각을 잡자마자 곧바로 도는) 실제로 잴 수 있다 — 그 뒤로
      // 경과 시간이 상한을 넘어야 나머지가 건너뛰어진다. "일부라도 건너뛴다"만 본다.
      const skipped = summary.payloads.filter((p) => p.skipped === true);
      assert.ok(skipped.length >= 1, "상한이 1ms면 적어도 뒤쪽 페이로드는 건너뛰어야 한다");
      for (const p of skipped) {
        assert.equal(p.error, "시간이 모자라 측정하지 못했습니다.");
        assert.equal(p.regression, undefined, "건너뛴 페이로드는 회귀로 세면 안 된다");
      }
      assert.equal(summary.regressions, 0, "정상 트리끼리 비교이므로 회귀가 없어야 한다");

      const md = execFileSync("cat", [outMd], { encoding: "utf8" });
      assert.ok(md.includes("시간이 모자라 건너뛴 페이로드"));
    }, "kimchi-hook-latency-test-");
  }
);
