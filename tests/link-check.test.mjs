import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  trimUrl,
  extractUrlsFromLine,
  isExcludedUrl,
  collectFiles,
  extractLinks,
} from "../scripts/extract-links.mjs";
import {
  MARKER,
  classify,
  looksLikeSoftDeadTitle,
  looksLikeUnverifiedTitle,
  looksLikeRunnerOutage,
  splitLinks,
  buildReport,
  buildSummary,
} from "../scripts/link-report.mjs";

// ---- extract-links.mjs ----

test("trimUrl: 여는 괄호와 짝이 맞물릴 때만 닫는 괄호를 벗겨낸다", () => {
  assert.equal(trimUrl("https://a.b/c)"), "https://a.b/c");
  assert.equal(trimUrl("https://a.b/(c)"), "https://a.b/(c)"); // 짝이 맞으면 안 벗겨낸다
});

test("extractUrlsFromLine: 마크다운 링크 괄호 안 URL만 뽑는다", () => {
  assert.deepEqual(extractUrlsFromLine("자세히는 [문서](https://a.b/c)를 보세요."), ["https://a.b/c"]);
});

test("extractUrlsFromLine: 꺾쇠로 감싼 URL", () => {
  assert.deepEqual(extractUrlsFromLine("<https://a.b/c>"), ["https://a.b/c"]);
});

test("extractUrlsFromLine: 전각 마침표로 끝나는 문장", () => {
  assert.deepEqual(extractUrlsFromLine("참고: https://a.b/c。"), ["https://a.b/c"]);
});

test("extractUrlsFromLine: 닫는 괄호 뒤 마침표", () => {
  assert.deepEqual(extractUrlsFromLine("이 문서(https://a.b/c)."), ["https://a.b/c"]);
});

test("extractUrlsFromLine: 닫는 괄호 바로 뒤에 조사가 공백 없이 붙는다", () => {
  assert.deepEqual(extractUrlsFromLine("[Pages](https://sungjun1217.github.io/kimchi-claude/)와 위키로"), [
    "https://sungjun1217.github.io/kimchi-claude/",
  ]);
});

test("extractUrlsFromLine: 쿼리 문자열과 프래그먼트를 그대로 남긴다", () => {
  assert.deepEqual(extractUrlsFromLine("https://a.b/c?x=1&y=2#frag 를 보세요"), ["https://a.b/c?x=1&y=2#frag"]);
});

test("extractUrlsFromLine: 한 줄에 여러 URL", () => {
  assert.deepEqual(extractUrlsFromLine("(https://a.b/1) 그리고 <https://a.b/2>"), [
    "https://a.b/1",
    "https://a.b/2",
  ]);
});

// 리뷰에서 지적된 실측 사고 사례: 뒤에 붙는 마크다운 기호·문장부호가 URL 문자로 그대로
// 받아들여져 유효한 링크를 깨뜨렸다(백틱 하나가 진짜 data.go.kr 링크를 404로 만들었다).
test("extractUrlsFromLine: 백틱으로 감싼 URL 뒤에 조사가 바로 붙는다", () => {
  assert.deepEqual(extractUrlsFromLine("`https://a.go.kr/x`를 확인한다"), ["https://a.go.kr/x"]);
});

test("extractUrlsFromLine: 굵게(별표 두 개)로 감싼 URL", () => {
  assert.deepEqual(extractUrlsFromLine("**https://a.go.kr/x**"), ["https://a.go.kr/x"]);
});

test("extractUrlsFromLine: 가운뎃점으로 붙은 두 URL은 따로 뽑힌다", () => {
  assert.deepEqual(extractUrlsFromLine("https://a.go.kr/x·https://b.go.kr/y"), [
    "https://a.go.kr/x",
    "https://b.go.kr/y",
  ]);
});

test("extractUrlsFromLine: 엠대시 뒤에 이어지는 말", () => {
  assert.deepEqual(extractUrlsFromLine("https://a.go.kr/x—다음 문장"), ["https://a.go.kr/x"]);
});

test("extractUrlsFromLine: 말줄임표로 끝나는 문장", () => {
  assert.deepEqual(extractUrlsFromLine("문서·https://b.go.kr/y…"), ["https://b.go.kr/y"]);
});

test("extractUrlsFromLine: 규칙표 셀 안에서 파이프 앞에서 멈춘다", () => {
  assert.deepEqual(extractUrlsFromLine("자료: https://a.go.kr/x?a=1&b=2| 치환 |"), [
    "https://a.go.kr/x?a=1&b=2",
  ]);
});

test("extractUrlsFromLine: 위키백과류 URL은 괄호를 그대로 품는다", () => {
  assert.deepEqual(extractUrlsFromLine("https://en.wikipedia.org/wiki/Foo_(bar) 참고"), [
    "https://en.wikipedia.org/wiki/Foo_(bar)",
  ]);
});

// URL_RE가 "(" 를 URL 문자로 받게 되면서 새로 생긴 사고 — URL 바로 뒤 공백 없이 한글
// 부연 설명이 여는 괄호로 시작하면("...(이중 피동") 그 "(" 까지 매치에 딸려 온다.
// 짝이 되는 ")"는 한글 다음이라 이미 매치 밖이라 무조건 벗겨내야 한다(실측 —
// docs/design.md 자기 서술에서 드러났다).
test("extractUrlsFromLine: URL 뒤에 공백 없이 오는 한글 괄호 설명의 여는 괄호를 벗겨낸다", () => {
  assert.deepEqual(
    extractUrlsFromLine("https://korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=216&qna_seq=310695(이중 피동 질의응답), 그다음"),
    ["https://korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=216&qna_seq=310695"]
  );
});

test("extractUrlsFromLine: 취소선(물결 두 개)으로 감싼 URL은 끝에서만 벗겨낸다", () => {
  assert.deepEqual(extractUrlsFromLine("~~https://a.b/x~~ 그다음"), ["https://a.b/x"]);
  // 물결은 URL 중간(홈 디렉터리 경로)에서는 그대로 남아야 한다.
  assert.deepEqual(extractUrlsFromLine("https://a.b/~user/profile 확인"), ["https://a.b/~user/profile"]);
});

test("isExcludedUrl: 자리표시자 호스트를 뺀다", () => {
  assert.equal(isExcludedUrl("https://example.com/foo"), true);
  assert.equal(isExcludedUrl("https://localhost:3000/"), true);
  assert.equal(isExcludedUrl("https://127.0.0.1/"), true);
  assert.equal(isExcludedUrl("https://law.go.kr/foo"), false);
});

test("isExcludedUrl: 이 저장소 자기 github.com 링크를 뺀다(대소문자 무관)", () => {
  assert.equal(isExcludedUrl("https://github.com/SungJun1217/kimchi-claude/wiki"), true);
  assert.equal(isExcludedUrl("https://GITHUB.COM/sungjun1217/KIMCHI-CLAUDE.git"), true);
  assert.equal(isExcludedUrl("https://github.com/other/repo"), false);
});

test("isExcludedUrl: 형식이 깨진 URL은 안전하게 포함한다", () => {
  assert.equal(isExcludedUrl("https://"), false);
});

function makeScanRepo() {
  const dir = mkdtempSync(join(tmpdir(), "kimchi-links-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });

  mkdirSync(join(dir, "skills", "korean-datetime", "examples"), { recursive: true });
  mkdirSync(join(dir, "rules"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });

  writeFileSync(
    join(dir, "skills", "korean-datetime", "examples", "holiday.mjs"),
    "// 출처: https://www.law.go.kr/법령/공휴일\nexport const x = 1;\n"
  );
  writeFileSync(join(dir, "rules", "terms.md"), "근거: https://korean.go.kr/foo\n");
  writeFileSync(join(dir, "docs", "design.md"), "같은 링크 재사용: https://korean.go.kr/foo (다른 줄)\n");
  writeFileSync(join(dir, "README.md"), "무시할 링크: https://example.com/x\n");
  writeFileSync(join(dir, "CONTRIBUTING.md"), "스캔 대상 아닌 파일: not-a-link\n");
  writeFileSync(join(dir, "unrelated.md"), "스캔 밖: https://should-not-appear.example.org/\n");

  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

test("extractLinks: 대상 디렉터리만 훑고, 같은 URL은 위치를 모아 하나로 합친다", () => {
  const dir = makeScanRepo();
  try {
    const links = extractLinks(dir);
    const byUrl = Object.fromEntries(links.map((l) => [l.url, l]));

    // URL 경로에 한글이 그대로(퍼센트 인코딩 없이) 섞여 있으면 한글 시작 지점에서 잘린다
    // (URL_RE가 한글 음절을 URL 문자로 안 받는다) — law.go.kr 조문 링크처럼 실제로 나올
    // 수 있는 모양이라 트리밍 결과가 안정적인지 여기서 확인한다.
    assert.ok("https://www.law.go.kr/" in byUrl);
    assert.ok("https://korean.go.kr/foo" in byUrl);
    assert.equal(byUrl["https://korean.go.kr/foo"].locations.length, 2);
    assert.deepEqual(
      byUrl["https://korean.go.kr/foo"].locations.map((l) => l.file).sort(),
      ["docs/design.md", "rules/terms.md"]
    );

    assert.ok(!("https://example.com/x" in byUrl)); // 제외 호스트
    assert.ok(!links.some((l) => l.locations.some((loc) => loc.file === "unrelated.md"))); // 스캔 대상 밖
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectFiles: git 이 추적하지 않는 파일은 안 낸다", () => {
  const dir = makeScanRepo();
  try {
    writeFileSync(join(dir, "rules", "untracked.md"), "https://untracked.example.org/\n");
    const files = collectFiles(dir);
    assert.ok(!files.includes("rules/untracked.md"));
    assert.ok(files.includes("rules/terms.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- link-report.mjs ----

test("classify: 404/410은 죽음, 6/7은 DNS·연결 실패로 죽음", () => {
  assert.equal(classify({ httpCode: 404, curlExit: 0 }).status, "dead");
  assert.equal(classify({ httpCode: 410, curlExit: 0 }).status, "dead");
  assert.equal(classify({ httpCode: null, curlExit: 6 }).status, "dead");
  assert.equal(classify({ httpCode: null, curlExit: 7 }).status, "dead");
});

test("classify: 403/429/5xx/타임아웃/응답 없음은 확인 못 함이지 죽음이 아니다", () => {
  assert.equal(classify({ httpCode: 403, curlExit: 0 }).status, "unverified");
  assert.equal(classify({ httpCode: 429, curlExit: 0 }).status, "unverified");
  assert.equal(classify({ httpCode: 503, curlExit: 0 }).status, "unverified");
  assert.equal(classify({ httpCode: null, curlExit: 28 }).status, "unverified");
  assert.equal(classify(undefined).status, "unverified");
});

test("classify: 2xx/3xx는 정상", () => {
  assert.equal(classify({ httpCode: 200, curlExit: 0 }).status, "ok");
  assert.equal(classify({ httpCode: 301, curlExit: 0 }).status, "ok");
});

test("classify: 404/410이 아닌 다른 4xx(400/401/451)도 확인 못 함이지 정상이 아니다", () => {
  assert.equal(classify({ httpCode: 400, curlExit: 0 }).status, "unverified");
  assert.equal(classify({ httpCode: 401, curlExit: 0 }).status, "unverified");
  assert.equal(classify({ httpCode: 451, curlExit: 0 }).status, "unverified");
});

test("classify: 6/7/28이 아닌 다른 curl 종료 코드(예: 47 리다이렉트 반복)도 확인 못 함이다", () => {
  const result = classify({ httpCode: null, curlExit: 47 });
  assert.equal(result.status, "unverified");
  assert.match(result.reason, /47/);
});

test("classify: HTTP 200이어도 title이 강한 연성 404 고정 문구면 softDead다(죽음과 같은 무게)", () => {
  const lawGoKr = classify({ httpCode: 200, curlExit: 0, title: "국가법령정보센터 | 오류페이지" });
  assert.equal(lawGoKr.status, "softDead");
  assert.match(lawGoKr.reason, /오류 페이지/);

  const notFoundPage = classify({ httpCode: 200, curlExit: 0, title: "페이지를 찾을 수 없습니다" });
  assert.equal(notFoundPage.status, "softDead");

  const koreanGoKr = classify({ httpCode: 200, curlExit: 0, title: "존재하지 않는 페이지입니다" });
  assert.equal(koreanGoKr.status, "softDead");

  const noSuchLaw = classify({ httpCode: 200, curlExit: 0, title: "존재하지 않는 법령입니다" });
  assert.equal(noSuchLaw.status, "softDead");
});

// 넓은(오탐 여지가 있는) 오류 낱말은 반대로 실제 문서 제목과 흔히 겹친다 — 죽음과 같은
// 무게로 다루면 안 되고, "확인 못 함"에만 머물러야 한다.
test("classify: 넓은 오류 낱말(에러·not found)은 확인 못 함일 뿐 softDead가 아니다", () => {
  const notFound = classify({ httpCode: 200, curlExit: 0, title: "404 Not Found" });
  assert.equal(notFound.status, "unverified");

  const errorGuide = classify({ httpCode: 200, curlExit: 0, title: "Error Handling 가이드" });
  assert.equal(errorGuide.status, "unverified");
});

test("classify: title이 평범하면 200은 그대로 정상이다", () => {
  const result = classify({ httpCode: 200, curlExit: 0, title: "관공서의공휴일에관한규정" });
  assert.equal(result.status, "ok");
});

test("looksLikeSoftDeadTitle: 빈 제목·평범한 제목·넓은 오류 낱말은 강한 연성 404가 아니다", () => {
  assert.equal(looksLikeSoftDeadTitle(""), false);
  assert.equal(looksLikeSoftDeadTitle(undefined), false);
  assert.equal(looksLikeSoftDeadTitle("한눈에 알아보는 공공언어 바로 쓰기(개정판)"), false);
  assert.equal(looksLikeSoftDeadTitle("Error Handling 가이드"), false);
  assert.equal(looksLikeSoftDeadTitle("404 Not Found"), false);
});

test("looksLikeUnverifiedTitle: 넓은 오류 낱말만 본다", () => {
  assert.equal(looksLikeUnverifiedTitle("Error Handling 가이드"), true);
  assert.equal(looksLikeUnverifiedTitle("404 Not Found"), true);
  assert.equal(looksLikeUnverifiedTitle("한눈에 알아보는 공공언어 바로 쓰기(개정판)"), false);
});

const LINKS = [
  { url: "https://dead.example.org/a", locations: [{ file: "rules/terms.md", line: 3 }] },
  { url: "https://slow.example.org/b", locations: [{ file: "docs/design.md", line: 5 }] },
  { url: "https://ok.example.org/c", locations: [{ file: "README.md", line: 1 }] },
];
const RESULTS = {
  "https://dead.example.org/a": { httpCode: 404, curlExit: 0 },
  "https://slow.example.org/b": { httpCode: 403, curlExit: 0 },
  "https://ok.example.org/c": { httpCode: 200, curlExit: 0 },
};

test("splitLinks: dead/unverified 로 가른다", () => {
  const { dead, unverified } = splitLinks(LINKS, RESULTS);
  assert.deepEqual(dead.map((l) => l.url), ["https://dead.example.org/a"]);
  assert.deepEqual(unverified.map((l) => l.url), ["https://slow.example.org/b"]);
});

test("buildSummary: 건수와 러너 장애 여부를 낸다", () => {
  assert.deepEqual(buildSummary(LINKS, RESULTS), { dead: 1, suspect: 0, unverified: 1, runnerOutage: false });
});

// 리뷰 지적: 연성 404만 있고(dead=0) 진짜 죽은 링크가 없어도, 워크플로는 이슈를 닫으면
// 안 된다 — suspect가 dead와 같은 무게로 "이슈를 열고/유지할지"를 정한다(dead + suspect
// > 0). 넓은 오류 낱말(unverified)만 있는 경우와 달리, 이 요약 값이 그 구분을 지킨다.
test("buildSummary: 연성 404만 있어도(dead=0) suspect로 잡혀 이슈를 열고/유지할 근거가 된다", () => {
  const links = [{ url: "https://law.go.kr/x", locations: [{ file: "skills/korean-datetime/SKILL.md", line: 1 }] }];
  const results = { "https://law.go.kr/x": { httpCode: 200, curlExit: 0, title: "국가법령정보센터 | 오류페이지" } };
  const summary = buildSummary(links, results);
  assert.equal(summary.dead, 0);
  assert.equal(summary.suspect, 1);
  assert.ok(summary.dead + summary.suspect > 0); // 워크플로가 이 조건으로 열지/닫을지를 가른다
});

test("buildSummary: 넓은 오류 낱말(unverified)만 있으면 dead+suspect가 0이라 이슈를 닫을 근거가 된다", () => {
  const links = [{ url: "https://a.example.org/guide", locations: [{ file: "docs/design.md", line: 1 }] }];
  const results = { "https://a.example.org/guide": { httpCode: 200, curlExit: 0, title: "Error Handling 가이드" } };
  const summary = buildSummary(links, results);
  assert.equal(summary.dead, 0);
  assert.equal(summary.suspect, 0);
  assert.equal(summary.unverified, 1);
  assert.equal(summary.dead + summary.suspect, 0);
});

test("looksLikeRunnerOutage: 링크가 하나라도 있는데 전부 DNS·연결 실패면 러너 장애로 본다", () => {
  const links = [{ url: "https://a.go.kr/" }, { url: "https://b.go.kr/" }];
  const allDown = {
    "https://a.go.kr/": { httpCode: null, curlExit: 6 },
    "https://b.go.kr/": { httpCode: null, curlExit: 7 },
  };
  assert.equal(looksLikeRunnerOutage(links, allDown), true);
});

test("looksLikeRunnerOutage: 하나라도 살아 있으면 러너 장애가 아니다", () => {
  const links = [{ url: "https://a.go.kr/" }, { url: "https://b.go.kr/" }];
  const oneUp = {
    "https://a.go.kr/": { httpCode: null, curlExit: 6 },
    "https://b.go.kr/": { httpCode: 200, curlExit: 0 },
  };
  assert.equal(looksLikeRunnerOutage(links, oneUp), false);
});

test("looksLikeRunnerOutage: 링크가 없으면 러너 장애로 보지 않는다", () => {
  assert.equal(looksLikeRunnerOutage([], {}), false);
});

test("buildReport: 마커와 두 구역을 담고, 확인 못 함은 더 약하게 말한다", () => {
  const body = buildReport(LINKS, RESULTS);
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /끊긴 링크 1건/);
  assert.match(body, /확인 못 한 링크 1건/);
  assert.match(body, /끊긴 것으로 보지 않습니다/);
  assert.ok(!body.includes("ok.example.org")); // 정상 링크는 아예 안 나온다
});

test("buildReport: 죽은 링크가 없으면 그 사실만 짧게 말하고 확인 못 함 구역이 없으면 안 낸다", () => {
  const okResults = { "https://ok.example.org/c": { httpCode: 200, curlExit: 0 } };
  const body = buildReport([LINKS[2]], okResults);
  assert.match(body, /끊긴 링크를 찾지 못했습니다/);
  assert.ok(!body.includes("확인 못"));
});

test("buildReport: 연성 404는 죽은 링크와 별도 구역에, 더 부드러운 말로 나온다", () => {
  const links = [{ url: "https://law.go.kr/x", locations: [{ file: "skills/korean-datetime/SKILL.md", line: 1 }] }];
  const results = { "https://law.go.kr/x": { httpCode: 200, curlExit: 0, title: "국가법령정보센터 | 오류페이지" } };
  const body = buildReport(links, results);
  assert.match(body, /오류 페이지가 나오는 링크 1건/);
  assert.match(body, /문서 이름이 바뀌었을 수 있습니다/);
  assert.match(body, /오류 페이지가 나옵니다/); // 개별 항목의 사유
  assert.ok(!body.includes("끊긴 링크를 찾지 못했습니다")); // dead=0이어도 "못 찾았다"고 말하면 안 된다
});

test("buildReport: URL을 인라인 코드로 이스케이프한다(백틱이 섞여도 안전)", () => {
  const links = [{ url: "https://a.b/`x`", locations: [{ file: "rules/terms.md", line: 1 }] }];
  const results = { "https://a.b/`x`": { httpCode: 404, curlExit: 0 } };
  const body = buildReport(links, results);
  assert.match(body, /`` https:\/\/a\.b\/`x` ``/);
});

test("buildReport: 목록이 상한을 넘으면 나머지를 건수로만 말한다", () => {
  const links = Array.from({ length: 40 }, (_, i) => ({
    url: `https://dead${i}.example.org/`,
    locations: [{ file: "rules/terms.md", line: i + 1 }],
  }));
  const results = Object.fromEntries(links.map((l) => [l.url, { httpCode: 404, curlExit: 0 }]));
  const body = buildReport(links, results);
  assert.match(body, /외 10건 더/);
});

test("buildReport: 위치가 상한을 넘으면 나머지를 곳 수로만 말한다", () => {
  const locations = Array.from({ length: 8 }, (_, i) => ({ file: `rules/f${i}.md`, line: 1 }));
  const links = [{ url: "https://dead.example.org/", locations }];
  const results = { "https://dead.example.org/": { httpCode: 404, curlExit: 0 } };
  const body = buildReport(links, results);
  assert.match(body, /외 3곳/);
});
