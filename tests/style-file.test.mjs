// 생성된 출력 스타일 파일이 클로드 코드가 읽을 수 있는 형태인지 검사한다.
//
// 이 시험이 막으려는 실패가 가장 나쁜 종류다. 프런트매터에 모르는 키가 있으면
// 클로드 코드가 "Skipping plugin output-style" 하고 조용히 건너뛴다.
// 그러면 플러그인은 설치돼 있는데 아무 일도 하지 않고, 아무도 알아채지 못한다.
//
// 허용되는 키는 클로드 코드 2.1.278 바이너리에서 확인한 네 개뿐이다.
//   name / description / keep-coding-instructions / force-for-plugin

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STYLE_PATH = join(ROOT, "output-styles", "natural-korean.md");

const ALLOWED_KEYS = new Set([
  "name",
  "description",
  "keep-coding-instructions",
  "force-for-plugin",
]);

const style = readFileSync(STYLE_PATH, "utf8");

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, "프런트매터를 찾지 못했다");
  const entries = {};
  for (const line of match[1].split("\n")) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    assert.ok(colon > 0, `프런트매터 줄이 key: value 형태가 아니다: ${line}`);
    entries[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { entries, body: text.slice(match[0].length) };
}

const { entries, body } = parseFrontmatter(style);

test("프런트매터에 허용되지 않은 키가 없다", () => {
  const unknown = Object.keys(entries).filter((key) => !ALLOWED_KEYS.has(key));
  assert.deepEqual(unknown, [], "모르는 키가 있으면 스타일이 조용히 무시된다");
});

test("이름과 설명이 있다", () => {
  assert.ok(entries.name?.length > 0);
  assert.ok(entries.description?.length > 0);
});

test("코딩 지침을 남기도록 켜져 있다", () => {
  // 기본값이 false다. false면 클로드 코드의 기본 엔지니어링 지침이 시스템 프롬프트에서 빠진다.
  assert.equal(entries["keep-coding-instructions"], "true");
});

test("강제 적용이 켜져 있다", () => {
  // 이게 꺼지면 사용자가 /output-style 에서 직접 골라야 한다. 요구사항 위반이다.
  assert.equal(entries["force-for-plugin"], "true");
});

test("본문이 비어 있지 않고 표가 들어 있다", () => {
  assert.ok(body.trim().length > 500, `본문이 ${body.trim().length}자로 너무 짧다`);
  assert.match(body, /\| 원어 \| 쓰지 말 것 \| 쓸 것 \| 이유 \|/);
});

test("품질을 지키는 문장이 본문에 남아 있다", () => {
  assert.match(body, /설명을 줄이거나 분석을 생략하지 마십시오/);
  assert.match(body, /영어로 쓰면 영어로 답하고/);
  assert.match(body, /코드, 식별자, 명령어/);
});

test("모델의 편향을 거스르는 지시가 본문에 남아 있다", () => {
  assert.match(body, /순우리말로 풀어쓰는 것은 최후 수단/);
  assert.match(body, /은유는 번역 대상이 아닙니다/);
  assert.match(body, /"자연스러운 한국어"는 순우리말을 뜻하지 않습니다/);
});

test("파일 크기가 로더 한도 안에 있다", () => {
  // 클로드 코드는 스타일 파일당 1MB까지 읽는다. 넉넉하지만 상한이 있다는 사실을 박아 둔다.
  assert.ok(Buffer.byteLength(style) < 1024 * 1024);
});
