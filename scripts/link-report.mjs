#!/usr/bin/env node
// scripts/extract-links.mjs 가 뽑은 링크 목록과, .github/workflows/link-check.yml 의 셸
// 단계가 curl 로 두드려 만든 결과 JSON을 합쳐 이슈 본문을 만든다. 이 스크립트 자신은
// curl 을 부르지 않는다 — 네트워크는 워크플로의 셸 단계만 연다(불변식 10, action-lint.mjs·
// triage-report.mjs와 같은 원칙).
//
// 죽었다고 단정하는 것은 404/410(응답은 왔지만 "없다"고 말한 것), 재시도까지 다 실패한
// DNS·연결 오류, 그리고 "응답은 200인데 본문은 정부·기관 오류 페이지 고정 문구"(연성
// 404, soft 404 — law.go.kr 실측)뿐이다. 이 셋은 이슈를 열고/유지하는 판단에서 같은
// 무게다. 그 밖의 4xx·5xx·타임아웃·기타 curl 오류·더 넓은(오탐 여지가 있는) 오류
// 낱말은 모두 "확인 못 함"으로 따로, 더 약하게 말한다 — 국내 공공기관 사이트가 봇을
// 자주 막는다는 사실을 반영한 것으로, 불변식 6(불확실하면 판단하지 않는다)과 같은
// 정신이다.
//
// 사용법: node link-report.mjs --links <extract-links.mjs 결과 JSON>
//   --results <{url: {httpCode, curlExit, effectiveUrl, title}} JSON> [--out <이슈 본문 md>]
//   [--summary-out <{dead, suspect, unverified, runnerOutage} JSON>]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, writeJson, writeText, runMain } from "./lib/cli.mjs";
import { mdCode } from "./lib/markdown.mjs";
import { isEntrypoint } from "../hooks/lib/entrypoint.mjs";

export const MARKER = "<!-- kimchi-claude-link-check -->";

// 공개 이슈 본문이 링크 건수에 비례해 무한정 커지지 않게 한다(triage-report.mjs의
// MAX_LISTED_FINDINGS와 같은 원칙).
const MAX_LISTED = 30;
const MAX_LOCATIONS_PER_LINK = 5;

const DEAD_HTTP_CODES = new Set([404, 410]);
// curl 종료 코드: 6 = Couldn't resolve host, 7 = Failed to connect — --retry(-connrefused)
// 까지 다 실패했다는 뜻이라 응답 자체가 없었던 경우다. 28(시간 초과)이나 그 밖의 코드
// (예: 47 너무 많은 리다이렉트)는 응답이 늦었거나 curl 쪽 사정일 뿐일 수 있어 죽었다고
// 보지 않는다 — "확인 못 함"으로만 말한다.
const DEAD_CURL_EXITS = new Set([6, 7]);
const TIMEOUT_CURL_EXIT = 28;

// 연성 404(soft 404): 서버가 HTTP 200을 그대로 주면서 본문만 "이 문서는 없다"고 말하는
// 경우다. law.go.kr(국가법령정보센터, "오류페이지")가 실측으로 이렇게 동작한다 — 상태
// 코드만 보면 "정상"으로 잘못 판정한다.
//
// 이 낱말들은 "확인 못 함"이 아니라 "죽음"과 똑같이 이슈를 열고/유지하는 강한 신호로
// 쓴다("softDead") — 그래서 오탐 여지가 없는, 정부·기관 오류 페이지에서만 실제로 쓰는
// 고정 문구로 좁힌다("존재하지 않는" 뒤에 "페이지"·"법령"이 오는 경우로 한정한 것도 같은
// 이유다 — "존재하지 않는 키를 참조합니다" 같은 일반 문서 제목과 안 겹치게 한다).
const SOFT_DEAD_TITLE_PATTERNS = [/오류\s*페이지/, /페이지를\s*찾을\s*수\s*없습니다/, /존재하지\s*않는\s*(페이지|법령)/];

// 이보다 넓은 낱말("에러", "찾을 수 없음")은 반대로 실제 문서 제목과도 흔히 겹친다
// (예: "Error Handling 가이드", "404와 Not Found의 차이") — 그래서 이 층은 "확인 못
// 함"에만 쓰고, 이슈를 열거나 유지하는 판단에는 관여하지 않는다(불변식 6).
const UNVERIFIED_TITLE_PATTERNS = [/not\s*found/i, /\berror\b/i];

function titleMatches(title, patterns) {
  if (typeof title !== "string" || title.trim() === "") return false;
  return patterns.some((re) => re.test(title));
}

/** title이 (오탐 여지가 낮은) 정부·기관 오류 페이지 고정 문구처럼 보이는지만 본다. */
export function looksLikeSoftDeadTitle(title) {
  return titleMatches(title, SOFT_DEAD_TITLE_PATTERNS);
}

/** title이 "에러"·"찾을 수 없음"류의 더 넓은(오탐 여지가 있는) 낱말을 담고 있는지만 본다. */
export function looksLikeUnverifiedTitle(title) {
  return titleMatches(title, UNVERIFIED_TITLE_PATTERNS);
}

/**
 * curl 결과 하나를 판정한다. httpCode/curlExit 가 없거나 이상해도(워크플로 셸이 값을
 * 못 채웠거나 이 링크를 아예 두드리지 못했으면) "확인 못 함"으로 본다 — 판정 실패를
 * 죽음으로 단정하지 않는다. 404·410과 DNS·연결 실패는 "죽었다"고 단정하고, 강한 연성
 * 404 문구(SOFT_DEAD_TITLE_PATTERNS)는 "softDead"로 같이 취급한다(이슈를 열고/유지하는
 * 판단에서는 죽음과 같은 무게다). 그 밖의 모든 4xx·5xx·curl 오류·넓은 오류 낱말은
 * "확인 못 함"이다.
 * @param {{httpCode?: number|null, curlExit?: number, title?: string}} [result]
 * @returns {{status: "dead"|"softDead"|"unverified"|"ok", reason: string}}
 */
export function classify(result) {
  const httpCode = typeof result?.httpCode === "number" ? result.httpCode : null;
  const curlExit = Number.isInteger(result?.curlExit) ? result.curlExit : 0;
  const title = result?.title;

  if (DEAD_CURL_EXITS.has(curlExit)) return { status: "dead", reason: "DNS·연결 실패" };
  if (httpCode !== null && DEAD_HTTP_CODES.has(httpCode)) return { status: "dead", reason: `HTTP ${httpCode}` };

  if (curlExit === TIMEOUT_CURL_EXIT) return { status: "unverified", reason: "시간 초과" };
  if (curlExit !== 0) return { status: "unverified", reason: `curl 오류(종료 코드 ${curlExit})` };

  if (httpCode === null) return { status: "unverified", reason: "확인 못 함" };
  if (httpCode >= 400) return { status: "unverified", reason: `HTTP ${httpCode}` };
  if (looksLikeSoftDeadTitle(title)) return { status: "softDead", reason: "오류 페이지가 나옵니다" };
  if (looksLikeUnverifiedTitle(title)) return { status: "unverified", reason: "오류 페이지로 보입니다" };

  return { status: "ok", reason: `HTTP ${httpCode}` };
}

function locationsText(locations) {
  const shown = locations.slice(0, MAX_LOCATIONS_PER_LINK).map((loc) => mdCode(`${loc.file}:${loc.line}`));
  const rest = locations.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} 외 ${rest}곳` : shown.join(", ");
}

function linkLine(entry) {
  return `- ${mdCode(entry.url)} — ${entry.reason} — ${locationsText(entry.locations)}`;
}

function cappedSection(entries) {
  const listed = entries.slice(0, MAX_LISTED);
  const rest = entries.length - listed.length;
  const lines = listed.map(linkLine);
  if (rest > 0) lines.push(`- 외 ${rest}건 더`);
  return lines;
}

/**
 * 링크 목록과 결과를 죽음/연성 죽음(softDead)/확인 못 함으로 가른다.
 * @param {{url: string, locations: {file: string, line: number}[]}[]} links
 * @param {Record<string, object>} results
 * @returns {{dead: object[], softDead: object[], unverified: object[]}}
 */
export function splitLinks(links, results) {
  const dead = [];
  const softDead = [];
  const unverified = [];
  for (const link of links) {
    const { status, reason } = classify(results[link.url]);
    if (status === "dead") dead.push({ ...link, reason });
    else if (status === "softDead") softDead.push({ ...link, reason });
    else if (status === "unverified") unverified.push({ ...link, reason });
  }
  return { dead, softDead, unverified };
}

/**
 * 이슈 본문 마크다운을 만든다. 죽은 링크도 연성 죽음도 없으면 그 사실만 짧게 말한다
 * (닫을지 말지는 이 함수가 정하지 않는다 — 워크플로가 buildSummary 로 판단한다).
 * @param {{url: string, locations: object[]}[]} links
 * @param {Record<string, object>} results
 * @returns {string}
 */
export function buildReport(links, results) {
  const { dead, softDead, unverified } = splitLinks(links, results);
  const lines = [MARKER];

  if (dead.length === 0 && softDead.length === 0) {
    lines.push("이번 점검에서 끊긴 링크를 찾지 못했습니다.");
  } else {
    if (dead.length > 0) {
      lines.push(
        `**끊긴 링크 ${dead.length}건**을 찾았습니다. 문서가 옮겨졌거나 지워졌을 수 있으니 확인해 주십시오.`,
        ...cappedSection(dead)
      );
    }
    if (softDead.length > 0) {
      lines.push(
        "",
        `**오류 페이지가 나오는 링크 ${softDead.length}건**도 있습니다. 문서 이름이 바뀌었을 수 있습니다.`,
        ...cappedSection(softDead)
      );
    }
  }

  if (unverified.length > 0) {
    lines.push(
      "",
      `확인 못 한 링크 ${unverified.length}건도 있습니다(차단·속도 제한·일시 장애일 수 있어 끊긴 것으로 보지 않습니다).`,
      ...cappedSection(unverified)
    );
  }

  return lines.join("\n\n");
}

/**
 * 링크가 하나라도 있는데 전부 DNS·연결 실패(6/7)면 출처가 실제로 죽은 게 아니라 러너
 * 자체가 이번 실행에서 바깥 네트워크에 못 나갔을 가능성이 높다 — 이럴 때 이슈를
 * 열거나 갱신하면 "전부 끊겼다"는 잘못된 신호를 남긴다.
 * @param {{url: string}[]} links
 * @param {Record<string, object>} results
 * @returns {boolean}
 */
export function looksLikeRunnerOutage(links, results) {
  if (links.length === 0) return false;
  return links.every((link) => DEAD_CURL_EXITS.has(Number(results[link.url]?.curlExit)));
}

/**
 * 워크플로가 이슈를 열지/닫을지 정하는 데 쓰는 요약. `suspect`(softDead)는 이슈를
 * 열고/유지하는 판단에서 `dead`와 같은 무게로 쓴다 — 워크플로는 `dead + suspect`가
 * 0보다 크면 열고/갱신하고, 0이면 닫는다.
 * @param {{url: string, locations: object[]}[]} links
 * @param {Record<string, object>} results
 * @returns {{dead: number, suspect: number, unverified: number, runnerOutage: boolean}}
 */
export function buildSummary(links, results) {
  const { dead, softDead, unverified } = splitLinks(links, results);
  return {
    dead: dead.length,
    suspect: softDead.length,
    unverified: unverified.length,
    runnerOutage: looksLikeRunnerOutage(links, results),
  };
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(resolve(String(path)), "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.links) throw new Error("--links 가 필요합니다");
  if (!args.results) throw new Error("--results 가 필요합니다");

  const links = readJsonFile(args.links);
  const results = readJsonFile(args.results);

  writeText(buildReport(links, results), args.out);
  if (args["summary-out"]) writeJson(buildSummary(links, results), args["summary-out"]);
}

if (isEntrypoint(import.meta.url)) runMain(main);
