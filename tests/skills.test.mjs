// 스킬 파일의 구조를 검사한다.
//
// 출력 스타일과 같은 종류의 실패를 막는다. 프런트매터가 깨지면 클로드 코드가 스킬을
// 조용히 건너뛴다. 그러면 스킬은 저장소에 있는데 아무 일도 하지 않고 아무도 알아채지 못한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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

for (const name of skillNames) {
  test(`${name}: 프런트매터가 온전하다`, () => {
    const { front } = readSkill(name);
    assert.equal(front.name, name, "name 이 디렉터리 이름과 같아야 한다");
    assert.ok(front.description?.length > 40, "description 이 너무 짧다");
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

  test(`${name}: 참조하는 예시 파일이 실제로 있다`, () => {
    const { body } = readSkill(name);
    const referenced = [...body.matchAll(/examples\/([\w-]+\.mjs)/g)].map((match) => match[1]);
    assert.ok(referenced.length > 0, "동작하는 코드를 참조해야 한다. 산문만으로는 다시 틀린다");

    for (const file of new Set(referenced)) {
      assert.ok(
        existsSync(join(SKILLS_DIR, name, "examples", file)),
        `${file} 를 참조하는데 파일이 없다`
      );
    }
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
