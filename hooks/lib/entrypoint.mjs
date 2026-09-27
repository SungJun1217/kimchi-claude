// 훅 진입점이 공유하는 배관이다: 직접 실행됐는지 판정하고(isEntrypoint), stdin을
// 읽고(readStdin), 결과를 안전하게 쓰고 종료한다(runHook). guard.mjs와
// session-language.mjs 둘 다 이 셋을 글자 그대로 복제해 갖고 있던 것을 여기로 모았다.
//
// 이 파일 자체는 어떤 예외도 던지지 않는다 — 훅의 안전한 종료 경로(불변식 1)에 이
// 파일이 들어가기 때문이다. 호출하는 쪽(각 훅의 run())이 그래도 한 번 더 try/catch로
// 감싸는 것은, 이 파일 자체가 없거나 깨졌을 때(설치 손상)를 위해서다 — 동적 import가
// 실패하면 이 파일 안의 방어는 애초에 작동할 기회가 없다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * stdin을 통째로 읽는다. 훅 입력은 JSON 한 덩어리로 온다. 읽기 자체가 실패하면
 * (파이프가 없는 등) 빈 문자열로 본다 — main()이 그 경우를 "낼 것이 없다"로 처리한다.
 * @returns {string}
 */
export function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * stdout이 파이프일 때 macOS/Linux는 쓰기가 비동기다. write()를 fire-and-forget으로
 * 부르고 바로 exit(0)하면 OS 파이프 버퍼(64KiB)를 넘는 출력이 잘린다. 콜백을 받아
 * 실제로 다 나간 뒤에만 종료한다.
 *
 * 느린 리더나 막힌 파이프에서 무한히 기다리지 않도록 안전 타이머로 상한을 둔다.
 * processStart(각 훅이 자기 프로세스가 시작된 시점을 기록해 넘긴 값)부터 재서, 그 앞의
 * 동적 import나 검사에 걸린 시간까지 합쳐 훅 제한 시간(5초)보다 한참 짧게 끝나도록 한다.
 * 타이머가 먼저 울리면 그때까지 파이프에 실제로 들어간 만큼만 나가고 나머지는 버려진다
 * — 이미 쓴 바이트는 물릴 수 없으니 받아들인다. Claude Code 쪽이 멈춰야만 일어나는
 * 일이고, 그때는 훅이 뭘 하든 5초 뒤 강제 종료된다.
 *
 * @param {string} json
 * @param {number} processStart
 */
function writeAndExit(json, processStart) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    process.exit(0);
  };

  const remaining = Math.max(0, 4000 - (Date.now() - processStart));
  const timer = setTimeout(finish, remaining);
  timer.unref?.();

  try {
    process.stdout.write(json, () => {
      clearTimeout(timer);
      finish();
    });
  } catch {
    clearTimeout(timer);
    finish();
  }
}

/**
 * 훅 진입점의 공통 뼈대다. 직접 실행됐을 때만(isEntrypoint) main을 돌리고, 낼 것이
 * 없으면(undefined/빈 문자열) 곧바로, 있으면 writeAndExit로 안전하게 종료한다.
 *
 * main 자체가 던지는 예외는 여기서 삼킨다 — 말투를 돕는 부가 기능 하나가 던진
 * 예외 때문에 사용자의 작업(도구 호출, 세션 시작)이 막히면 안 된다(불변식 1).
 *
 * @param {string} importMetaUrl 호출한 훅의 import.meta.url
 * @param {() => Promise<string|undefined>} main
 * @param {number} processStart 호출한 훅이 자기 프로세스 시작 시점을 기록한 값
 */
export async function runHook(importMetaUrl, main, processStart) {
  if (!isEntrypoint(importMetaUrl)) return;

  let output;
  try {
    output = await main();
  } catch {
    output = undefined;
  }

  if (!output) {
    process.exit(0);
    return;
  }
  writeAndExit(output, processStart);
}

// 모듈이 커맨드라인에서 직접 실행됐는지 본다.
//
// 흔한 관용구 `import.meta.url === \`file://${process.argv[1]}\`` 는 두 값의 형태가
// 다르면 늘 어긋난다. import.meta.url 은 퍼센트 인코딩되고 심볼릭 링크가 풀린 절대
// 경로인 반면 argv[1] 은 사용자가 입력한 그대로다. 경로에 공백이나 한글이 섞이거나,
// 훅이 심볼릭 링크를 통해 실행되면(플러그인 설치가 흔히 이렇다) 비교가 실패해서
// main() 이 아예 돌지 않는다. 훅은 조용히 끝나야 하므로 이 실패는 티가 나지 않고,
// 그 결과 주민등록번호 차단(불변식 2)이 조용히 꺼져 버렸다.
//
// realpath 로 심볼릭 링크를 풀어 비교하고, 경로가 없거나 읽을 수 없어 realpath 가
// 실패하면 resolve() 만으로 비교해 최소한의 정확도를 지킨다. 어떤 경우에도
// 예외를 던지지 않는다 — 훅의 안전한 종료 경로에 이 함수가 들어가기 때문이다.

/**
 * @param {string} importMetaUrl 호출한 모듈의 import.meta.url
 * @returns {boolean} 그 모듈이 이 프로세스의 진입점이면 true
 */
export function isEntrypoint(importMetaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;

  let modulePath;
  try {
    modulePath = fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }

  try {
    return realpathSync(modulePath) === realpathSync(argv1);
  } catch {
    // 경로가 없거나 읽을 수 없어 realpath 가 실패하면 정규화한 경로로만 비교한다.
    return resolve(modulePath) === resolve(argv1);
  }
}
