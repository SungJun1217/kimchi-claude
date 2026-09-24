// README 그림이 실물과 맞는지 확인한다.
//
// 그림은 첫 화면에서 이 플러그인이 무엇을 바꾸는지 보여 주는 증거다. 증거가 지어낸 것이거나
// 낡았으면 읽는 사람을 속인다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAll, EXCERPTS, readFixture } from "../scripts/build-readme-art.mjs";
import { findResidentNumbers } from "../hooks/lib/pii.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets");
const files = renderAll();

test("README 그림이 최신이다", () => {
  const stale = Object.keys(files).filter(
    (name) => readFileSync(join(ASSETS, name), "utf8") !== files[name]
  );
  assert.deepEqual(stale, [], "npm run art 로 다시 만드십시오");
});

test("assets 에 생성기가 만들지 않은 그림이 없다", () => {
  // 손으로 넣은 그림은 --check 가 보지 못해 조용히 낡는다.
  // .DS_Store 같은 운영체제 파일은 git 에 들어가지 않으니 보지 않는다.
  const extra = readdirSync(ASSETS).filter((name) => !name.startsWith(".") && !(name in files));
  assert.deepEqual(extra, []);
});

test("답변 발췌가 원문에 그대로 있다", () => {
  // 발췌는 손으로 줄을 나눴다. 한 글자라도 바꾸면 실제 답변이 아니게 된다.
  // 줄마다 따로 찾으면 순서를 바꾸거나 다른 자리의 문장을 이어 붙여도 통과한다.
  // 그래서 … 과 • 로 끊기지 않은 줄들을 이어 붙인 덩어리째 찾는다.
  const flatten = (text) => text.replaceAll("**", "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  for (const { fixture, lines } of Object.values(EXCERPTS)) {
    const original = flatten(readFixture(fixture));
    const runs = [[]];
    for (const line of lines) {
      if (!line || /^\s*•/.test(line)) runs.push([]);
      if (line) runs.at(-1).push(line.replace(/^\s*•\s*/, "").replace(/\s*…$/, ""));
      if (/…$/.test(line)) runs.push([]);
    }
    for (const run of runs.filter((r) => r.length > 0)) {
      const quoted = flatten(run.join(" "));
      assert.ok(original.includes(quoted), `${fixture} 에 없는 발췌: "${quoted}"`);
    }
  }
});

test("그림에 형식이 맞는 주민등록번호가 없다", () => {
  // 차단 장면을 그리지만 번호는 가린 채로만 나와야 한다.
  for (const [name, content] of Object.entries(files)) {
    assert.deepEqual(findResidentNumbers(content), [], name);
  }
});

test("README 가 모든 그림을 라이트·다크 짝으로 가리킨다", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const bases = new Set(Object.keys(files).map((name) => name.replace(/-(light|dark)\.svg$/, "")));
  for (const base of bases) {
    assert.ok(readme.includes(`assets/${base}-light.svg`), `${base}-light.svg`);
    assert.ok(readme.includes(`assets/${base}-dark.svg`), `${base}-dark.svg`);
  }
});
