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

// 프로세스가 시작된 시점. 안전 타이머(아래 writeAndExit)를 여기서부터 재서, 도구
// 로딩에 시간이 걸려도 전체 실행이 훅 제한 시간(5초) 안에 들도록 한다.
const PROCESS_START = Date.now();

// lib/ 안의 파일은 정적 import 를 쓰지 않는다. guard.mjs 와 같은 이유다 — 설치가 깨져
// 그중 하나라도 없거나 문법 오류가 있으면 정적 import 는 아래 try/catch 를 거치지 못하고
// 스택 트레이스와 함께 종료 코드 1로 끝난다(불변식 1 위반).

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * @returns {string|undefined} 내보낼 JSON 문자열. 낼 것이 없으면 undefined.
 */
async function main() {
  if (process.env.KIMCHI_DISABLE === "1") return undefined;
  // off/0/false 를 대소문자 가리지 않고 받는다. 소문자 "off"만 받으면 KIMCHI_REPO_LANG=OFF
  // 처럼 흔히 쓰는 표기가 안 먹혀서 끄려던 사용자가 계속 안내를 받는다.
  const repoLangEnv = String(process.env.KIMCHI_REPO_LANG ?? "").toLowerCase();
  if (["off", "0", "false"].includes(repoLangEnv)) return undefined;

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

  const { detectRepoLanguage, describeRepoLanguage } = await import("./lib/repo-language.mjs");
  const context = describeRepoLanguage(detectRepoLanguage(cwd));
  if (context === "") return undefined;

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  });
}

/**
 * stdout 이 파이프일 때 macOS/Linux 는 쓰기가 비동기다. guard.mjs 의 writeAndExit 와
 * 같은 이유로 콜백을 받은 뒤에만 종료한다. 안전 타이머는 PROCESS_START 부터 재서
 * 훅 제한 시간(5초) 안에 들게 하고, 리더가 멈춰 타이머가 먼저 울리면 그때까지 파이프에
 * 들어간 만큼만 나간다 — Claude Code 쪽이 멈춰야만 일어나는 일이라 받아들인다.
 */
function writeAndExit(json) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    process.exit(0);
  };

  const remaining = Math.max(0, 4000 - (Date.now() - PROCESS_START));
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

async function run() {
  // 직접 실행될 때만 돈다. entrypoint.mjs 도 동적으로 불러온다 — 설치가 깨져
  // 이 파일조차 없으면 아무 일도 하지 않고 조용히 끝나야 한다.
  try {
    const { isEntrypoint } = await import("./lib/entrypoint.mjs");
    if (!isEntrypoint(import.meta.url)) return;
  } catch {
    return;
  }

  let output;
  try {
    output = await main();
  } catch {
    // 조용히 넘어간다. 말투를 돕는 부가 기능이 세션 시작을 막아서는 안 된다.
    output = undefined;
  }

  if (!output) {
    process.exit(0);
    return;
  }
  writeAndExit(output);
}

run();
