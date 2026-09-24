// 스킬 파일의 구조를 검사한다.
//
// 출력 스타일과 같은 종류의 실패를 막는다. 프런트매터가 깨지면 클로드 코드가 스킬을
// 조용히 건너뛴다. 그러면 스킬은 저장소에 있는데 아무 일도 하지 않고 아무도 알아채지 못한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(ROOT, "skills");

const skillNames = existsSync(SKILLS_DIR)
  ? readdirSync(SKILLS_DIR).filter((name) => statSync(join(SKILLS_DIR, name)).isDirectory())
  : [];

function readSkill(name) {
  const path = join(SKILLS_DIR, name, "SKILL.md");
  const text = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, `${name}: 프런트매터가 첫 줄부터 시작해야 한다`);

  const front = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) front[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { front, body: text.slice(match[0].length), path };
}

test("스킬을 찾았다", () => {
  assert.ok(skillNames.length > 0, "skills/ 에 스킬이 없다");
});

// YAML 은 따옴표 없는 스칼라 값에 ": " 나 " #" 가 있으면 다음 키나 주석으로 잘못 끊는다.
// 우리 파서(readSkill)는 첫 콜론만 보고 값을 통째로 가져오니 이 결함을 못 잡는다 — 실제
// YAML 파서(PyYAML/js-yaml)는 거부하고, 클로드 코드는 그 스킬을 조용히 건너뛴다.
// 의존성을 늘리지 않고 같은 결함을 잡도록 같은 검사만 그대로 한다.
function assertSafeYamlScalar(name, key, rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"') || value.startsWith("'")) return; // 따옴표로 감쌌으면 안전하다
  assert.ok(!value.includes(": "), `${name}: ${key} 값에 ": " 가 있으면 YAML 이 다음 키로 잘못 끊는다 — "${value}"`);
  assert.ok(!value.includes(" #"), `${name}: ${key} 값에 " #" 가 있으면 YAML 이 주석으로 자른다 — "${value}"`);
  assert.ok(
    !/^[[{&*!|>'"%@`]/.test(value),
    `${name}: ${key} 값이 YAML 특수 문자로 시작한다 — "${value}"`,
  );
}

for (const name of skillNames) {
  test(`${name}: 프런트매터가 온전하다`, () => {
    const { front } = readSkill(name);
    assert.equal(front.name, name, "name 이 디렉터리 이름과 같아야 한다");
    assert.ok(front.description?.length > 40, "description 이 너무 짧다");
  });

  test(`${name}: 프런트매터 값이 YAML 로 파싱된다`, () => {
    const { front } = readSkill(name);
    assert.ok(front.name, "name 키가 있어야 한다");
    assert.ok(front.description, "description 키가 있어야 한다");
    for (const [key, value] of Object.entries(front)) assertSafeYamlScalar(name, key, value);
  });

  test(`${name}: 설명이 언제 열어야 하는지 말한다`, () => {
    // 클로드가 이 설명만 보고 열지 말지 정한다. 무엇을 다루는지가 아니라
    // 언제 필요한지가 적혀 있어야 한다.
    const { front } = readSkill(name);
    assert.match(front.description, /Use when/i, "Use when 으로 시작해 상황을 밝혀야 한다");
  });

  test(`${name}: 한국어와 영어 열쇠말을 함께 담는다`, () => {
    // 사용자는 "인코딩 문제" 라고도 쓰고 "encoding issue" 라고도 쓴다.
    const { front } = readSkill(name);
    assert.match(front.description, /[가-힣]/, "한국어 열쇠말이 없다");
    assert.match(front.description, /[A-Za-z]{4,}/, "영어 열쇠말이 없다");
  });

  test(`${name}: 가리키는 파일이 실제로 있다`, () => {
    // 산문만 있는 스킬은 값어치가 적다. 동작하는 코드나 자료표를 가리켜야 한다.
    // 가리키는 방식은 스킬마다 다르다. 구현 예시를 담는 스킬은 examples/ 를 가리키고,
    // 참고용 스킬은 rules/ 나 scripts/ 를 가리킨다. 중요한 것은 그 파일이 있는 것이다.
    const { body } = readSkill(name);
    // **경로는 스킬 파일 기준이어야 한다.** 사용자 세션에서는 작업 디렉터리가 사용자의
    // 프로젝트이고 플러그인은 다른 곳에 있다. 저장소 뿌리 기준으로 적으면 가리키는 곳이
    // 없는데, 개발 환경에서는 우연히 맞아 시험이 통과한다.
    const referenced = [
      ...body.matchAll(/`((?:\.\.\/)*(?:examples|rules|scripts|hooks)\/[\w./-]+)`/g),
    ].map((match) => match[1]);
    assert.ok(referenced.length > 0, "동작하는 코드나 자료표를 가리켜야 한다");

    const missing = [...new Set(referenced)]
      .filter((relative) => !relative.includes("*"))
      .filter((relative) => !existsSync(resolve(SKILLS_DIR, name, relative)));
    assert.deepEqual(missing, [], "스킬 파일 기준으로 풀었을 때 없는 경로가 있다");
  });

  test(`${name}: 하지 말라고 말리는 절이 있다`, () => {
    // 지식 층의 절반은 직접 구현하지 말라고 말리는 일이다.
    // "이렇게 하라" 만 있으면 클로드가 틀린 방향으로 부지런해진다.
    const { body } = readSkill(name);
    assert.match(body, /자주 틀리는 것/, "자주 틀리는 것 절이 없다");
  });
}

test("모든 예시 파일이 스킬 문서에서 참조된다", () => {
  const orphans = [];
  for (const name of skillNames) {
    const examplesDir = join(SKILLS_DIR, name, "examples");
    if (!existsSync(examplesDir)) continue;

    const { body } = readSkill(name);
    for (const file of readdirSync(examplesDir).filter((entry) => entry.endsWith(".mjs"))) {
      if (!body.includes(file)) orphans.push(`${name}/examples/${file}`);
    }
  }
  assert.deepEqual(orphans, [], "문서에서 가리키지 않는 예시 파일은 아무도 찾지 못한다");
});

// 사용자 세션에서 Read 권한이 막히면 클로드는 SKILL.md에 박아 넣은 코드로 되돌아간다.
// 그 코드가 example 원본과 어긋나면(드리프트) 잘못된 구현을 그대로 쓰게 된다.
// 블록을 여는 줄에 `// inline:<파일명>` 표시를 두고, 나머지 줄은 전부 그 파일의 어느
// 줄과 (다듬어서) 똑같아야 한다 — 순서나 사이 간격은 상관없다.
test("SKILL.md에 박아 넣은 코드가 example 원본과 어긋나지 않는다", () => {
  for (const name of skillNames) {
    const { body } = readSkill(name);
    const blocks = [...body.matchAll(/```js\n\/\/ inline:(\S+)\n([\s\S]*?)```/g)];
    // 줄 끝 주석은 무시한다. 박아 넣은 코드는 원본의 설명 주석까지 그대로 옮길 필요가 없다.
    const stripTrailingComment = (line) => line.replace(/\s*\/\/.*$/, "").trim();

    for (const [, sourceFile, blockBody] of blocks) {
      const sourcePath = join(SKILLS_DIR, name, "examples", sourceFile);
      assert.ok(existsSync(sourcePath), `${name}: inline 대상 ${sourceFile} 이 없다`);
      const sourceLines = new Set(
        readFileSync(sourcePath, "utf8")
          .split("\n")
          .map(stripTrailingComment)
          .filter(Boolean),
      );
      for (const line of blockBody.split("\n").map(stripTrailingComment).filter(Boolean)) {
        assert.ok(sourceLines.has(line), `${name}/examples/${sourceFile}: 박아 넣은 줄이 원본에 없다 — "${line}"`);
      }
    }
  }
});

test("스킬 어디에도 보이지 않는 BOM 문자를 직접 쓰지 않는다", () => {
  // 도구 호출 인자는 JSON 이라 "﻿" 이스케이프가 파싱 단계에서 진짜 BOM 문자로 풀린다.
  // 그 문자가 문서에 그대로 박히면 복사해 쓰는 사람의 소스에도 보이지 않게 옮겨붙는다.
  const offenders = [];
  for (const name of skillNames) {
    const path = join(SKILLS_DIR, name, "SKILL.md");
    if (readFileSync(path, "utf8").includes("﻿")) offenders.push(`${name}/SKILL.md`);

    const examplesDir = join(SKILLS_DIR, name, "examples");
    if (!existsSync(examplesDir)) continue;
    for (const file of readdirSync(examplesDir).filter((entry) => entry.endsWith(".mjs"))) {
      const filePath = join(examplesDir, file);
      if (readFileSync(filePath, "utf8").includes("﻿")) offenders.push(`${name}/examples/${file}`);
    }
  }
  assert.deepEqual(offenders, [], "보이지 않는 BOM 문자가 그대로 박혀 있다");
});
