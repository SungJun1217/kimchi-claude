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

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

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
