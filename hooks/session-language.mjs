#!/usr/bin/env node
// 세션 시작에 이 저장소의 산출물 언어를 알려 준다.
//
// 출력 스타일로는 할 수 없다. 스타일은 정적 파일이라 저장소별 사실을 모른다.
// 세션마다 한 번, 저장소마다 다른 사실이므로 SessionStart 가 맞는 자리다.
//
// 한국어로 쓰는 저장소에는 아무것도 말하지 않는다. 출력 스타일이 이미 그렇게 시킨다.
// 영어로 쓰는 저장소일 때만 알려 준다. 그것이 새로운 사실이다.
//
// 설정:
//   KIMCHI_REPO_LANG=off  이 훅을 끈다
//   KIMCHI_DISABLE=1      플러그인 훅 전체를 끈다

import { readFileSync } from "node:fs";
import { isEntrypoint } from "./lib/entrypoint.mjs";
import { detectRepoLanguage, describeRepoLanguage } from "./lib/repo-language.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  if (process.env.KIMCHI_DISABLE === "1") return;
  if (process.env.KIMCHI_REPO_LANG === "off") return;

  // 훅 입력에 작업 디렉터리가 들어온다. 없으면 프로세스의 것을 쓴다.
  let cwd = process.cwd();
  const raw = readStdin();
  if (raw.trim()) {
    try {
      cwd = JSON.parse(raw).cwd || cwd;
    } catch {
      // 입력이 망가졌으면 프로세스의 작업 디렉터리를 쓴다.
    }
  }

  const context = describeRepoLanguage(detectRepoLanguage(cwd));
  if (context === "") return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    })
  );
}

// 직접 실행될 때만 돈다.
if (isEntrypoint(import.meta.url)) {
  try {
    main();
  } catch {
    // 조용히 넘어간다. 말투를 돕는 부가 기능이 세션 시작을 막아서는 안 된다.
  }
  process.exit(0);
}
