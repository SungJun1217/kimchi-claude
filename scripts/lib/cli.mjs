// action-lint.mjs와 triage-report.mjs가 각자 거의 같은 모양으로 갖고 있던 CLI 배관을
// 하나로 모았다. build-review.mjs·publish-docs.mjs는 옮기지 않는다 — 이 둘의 인자
// 문법은 bare `--flag`가 true가 되지 않고 항상 다음 토큰을 값으로 삼는다(용도가 달라
// `--out`처럼 값이 항상 있는 인자만 받는다). 같은 이름(parseArgs)이라도 의미가 다르면
// 억지로 하나로 합치지 않는다.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `--key value` 와 bare `--flag`(다음 토큰이 없거나 다음 토큰도 `--`로 시작하면 true)를
 * 함께 지원하는 최소한의 인자 파서다. `--`로 시작하지 않는 토큰은 무시한다.
 * @param {string[]} argv
 * @returns {Record<string, string|true>}
 */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * 결과 텍스트를 `outPath`가 있으면 파일로, 없으면 표준 출력으로 낸다. 두 스크립트 모두
 * "사람이 봐도 되고 워크플로가 파일로 받아도 되는" 결과를 이 모양으로 낸다.
 * @param {string} text
 * @param {string|true|undefined} outPath
 */
export function writeText(text, outPath) {
  if (outPath) writeFileSync(resolve(String(outPath)), `${text}\n`);
  else console.log(text);
}

/**
 * 값을 JSON으로 직렬화해 writeText로 낸다.
 * @param {unknown} value
 * @param {string|true|undefined} outPath
 */
export function writeJson(value, outPath) {
  writeText(JSON.stringify(value, null, 2), outPath);
}

/**
 * `main()`을 실행하고 실패를 exitCode 1로 옮긴다. 훅(hooks/*.mjs)과 달리 이 스크립트들은
 * 사람이 읽는 CI 로그를 향한 것이라 실패를 조용히 삼키지 않는다 — 여기서 그냥 넘어가면
 * 액션이 "검사를 안 했는데 통과했다"는 잘못된 신호를 준다.
 * @param {() => Promise<void>} main
 * @returns {Promise<void>}
 */
export function runMain(main) {
  return main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
