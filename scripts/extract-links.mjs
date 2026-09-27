#!/usr/bin/env node
// skills/·rules/·docs/·README.md·CONTRIBUTING.md·SECURITY.md 에 적힌 http(s) 링크를
// 모은다(불변식 7 — 값이 바뀌는 자료는 하드코딩하지 않고 출처를 가리키므로, 그 출처
// 링크가 죽으면 스킬이 조용히 잘못된 안내를 한다). scripts/link-report.mjs 가 이 목록을
// 실제로 두드려 본 결과와 합쳐 이슈 본문을 만든다 — 이 스크립트 자신은 네트워크를 열지
// 않는다(불변식 10). 스킬 예시 코드(skills/*/examples/*.mjs)의 주석에 적힌 링크도 빼지
// 않는다 — 코드 주석이라도 여기서는 근거 출처이지 훅이 손대지 말아야 할 "코드"(불변식
// 4)가 아니다.
//
// 사용법: node extract-links.mjs [--root <저장소 루트>] [--out <결과 JSON 경로>]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, writeJson, runMain } from "./lib/cli.mjs";
import { isEntrypoint } from "../hooks/lib/entrypoint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// git ls-files 에 넘기는 경로 한정자. 디렉터리는 그 아래를 통째로, 파일은 그 이름만.
const SCAN_PATHS = ["skills", "rules", "docs", "README.md", "CONTRIBUTING.md", "SECURITY.md"];

// 예시·자리표시자 호스트는 실제로 살아 있는지 볼 대상이 아니다.
const EXCLUDED_HOSTS = new Set(["example.com", "www.example.com", "localhost", "127.0.0.1"]);

// 이 저장소 자기 자신을 가리키는 github.com 링크는 뺀다 — 죽었는지는 이 저장소가
// 존재하는지와 같은 질문이라(파일이 지워지면 다른 방식으로 이미 드러난다) 별도로 두드려
// 볼 이유가 없다. 소문자로 비교한다(GitHub 호스트·소유자명은 대소문자를 가리지 않는다).
const SELF_REPO_PREFIX = "github.com/sungjun1217/kimchi-claude";

/** repoRoot 아래 SCAN_PATHS 에 걸리는, git 이 추적하는 파일 경로(저장소 루트 기준 상대 경로)를 낸다. */
export function collectFiles(repoRoot) {
  const out = execFileSync("git", ["ls-files", "--", ...SCAN_PATHS], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

// 여는 괄호에 짝이 맞물릴 때만 닫는 괄호를 벗겨낸다(마크다운 링크 `(url)` 이 흔한
// 모양이다). `(`·`)` 는 URL_RE 가 걸러내지 않는다 — 위키백과류 URL(`Foo_(bar)`)이 실제로
// 괄호를 포함하기 때문이다(실측). 다른 괄호·꺾쇠는 URL_RE 가 애초에 못 들어오게 막아서
// 여기 도달할 일이 없지만, 나중에 그쪽도 허용하게 되면 바로 쓸 수 있도록 남겨 둔다.
// 벗겨낸 뒤에도 문장부호가 남아 있을 수 있어 반복한다.
const CLOSERS = { ")": "(", "]": "[", "}": "{", ">": "<" };
// 문장 끝에 붙는 구두점은 URL의 일부일 리가 없다고 보고 무조건 벗겨낸다(전각 마침표·
// 가운뎃점 포함 — 국립국어원·law.go.kr 같은 한국어 문서에 섞여 나온다). `~`는 URL_RE가
// 걸러내지 않는다(`~user` 홈 디렉터리 경로처럼 URL 중간에 정당하게 나온다) — 그래서
// 마크다운 텍스트의 취소선(`~~text~~`)처럼 끝에 몰려 있을 때만 여기서 벗겨낸다.
const TRAILING_PUNCT = /[.,;:!?~、。”’"'》〉」』]+$/;

/** URL 매치 뒤에 함께 잡힌 문장부호·괄호를 벗겨낸다. 테스트 케이스는 tests/link-check.test.mjs 참고. */
export function trimUrl(raw) {
  let url = raw;
  let changed = true;
  while (changed) {
    changed = false;
    const punct = url.match(TRAILING_PUNCT);
    if (punct) {
      url = url.slice(0, -punct[0].length);
      changed = true;
      continue;
    }
    const last = url.at(-1);
    // 맨 끝이 여는 괄호 "("면 그 자체로 늘 짝이 없다 — URL_RE가 "(" 를 URL 문자로
    // 받으므로("Foo_(bar)" 보존을 위해서다), "…qna_seq=310695(이중 피동"처럼 URL 바로
    // 뒤에 공백 없이 여는 괄호로 시작하는 한글 부연 설명이 오면 그 "("까지 매치에
    // 딸려 온다(실측 — docs/design.md). 짝이 되는 ")"는 애초에 한글 다음이라 매치 밖에
    // 있으므로 무조건 벗겨낸다.
    if (last === "(") {
      url = url.slice(0, -1);
      changed = true;
      continue;
    }
    const opener = CLOSERS[last];
    if (!opener) continue;
    const opens = (url.match(new RegExp(`\\${opener}`, "g")) || []).length;
    const closes = (url.match(new RegExp(`\\${last}`, "g")) || []).length;
    if (closes > opens) {
      url = url.slice(0, -1);
      changed = true;
    }
  }
  return url;
}

// 꺾쇠·따옴표·백틱·별표·파이프와 한글 음절/자모, 그리고 CJK 문장부호 블록(U+3000-U+303F,
// 。·「」 포함) · 일반 문장부호 블록(U+2000-U+206F, 엠대시·말줄임표·가운뎃점·굽은 따옴표
// 포함)은 URL 문자로 아예 안 받는다. 한국어 문서에서는 `[말](https://a.b/c)와`처럼 닫는
// 괄호 바로 뒤에 공백 없이 조사가 붙는 일이 흔해서(실측 — README.md) 한글 음절은 여기서
// 걸러야 문장부호 뒤 트리밍만으로는 늦고, ``https://a.b/x`를``·`**https://a.b/x**`처럼
// 마크다운 강조로 감싼 URL도 백틱·별표가 뒤에 바로 붙어(실측 — 규칙표 인용에 끼워 넣다가
// 드러났다) 같은 이유로 걸러야 한다. 괄호(`(`·`)`)는 반대로 URL 문자로 받는다 —
// 위키백과류 URL(`.../wiki/Foo_(bar)`)이 실제로 괄호를 포함해서, 못 들어오게 막으면
// 그 URL 자체가 잘린다. 대신 trimUrl의 괄호 짝 맞추기(CLOSERS)가 마크다운 링크의 짝
// 없는 닫는 괄호만 따로 벗겨낸다. URL이 실제로 제외 문자를 담는 일은 인코딩된
// 형태(%XX)로만 있으므로 잃는 것이 없다.
const URL_RE = /https?:\/\/[^\s"'<>[\]{}`*|· -⁯ᄀ-ᇿ㄰-㆏가-힣　-〿]+/g;

/** 한 줄에서 URL을 뽑아 다듬는다(트리밍 후 빈 문자열이 되면 뺀다 — 순수 문장부호 나열이었다는 뜻이다). */
export function extractUrlsFromLine(line) {
  const found = line.match(URL_RE) || [];
  return found.map(trimUrl).filter((url) => url.length > 0);
}

/** 자리표시자 호스트·이 저장소 자기 링크를 뺀다. url 파싱에 실패하면(형식이 깨졌으면) 안전하게 포함한다. */
export function isExcludedUrl(url) {
  const lower = url.toLowerCase();
  if (lower.includes(SELF_REPO_PREFIX)) return true;
  try {
    const { hostname } = new URL(url);
    return EXCLUDED_HOSTS.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * repoRoot 아래 대상 파일을 모두 훑어 URL → 등장 위치 목록을 낸다.
 * @param {string} repoRoot
 * @returns {{url: string, locations: {file: string, line: number}[]}[]}
 */
export function extractLinks(repoRoot) {
  const files = collectFiles(repoRoot);
  const byUrl = new Map();
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(repoRoot, file), "utf8");
    } catch {
      continue; // git ls-files 이후 파일이 지워졌을 수 있다(작업 트리와 색인이 어긋난 경우) — 건너뛴다.
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      for (const url of extractUrlsFromLine(lines[i])) {
        if (isExcludedUrl(url)) continue;
        const entry = byUrl.get(url) || { url, locations: [] };
        entry.locations.push({ file, line: i + 1 });
        byUrl.set(url, entry);
      }
    }
  }
  return [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.root ? String(args.root) : ROOT;
  writeJson(extractLinks(repoRoot), args.out);
}

if (isEntrypoint(import.meta.url)) runMain(main);
