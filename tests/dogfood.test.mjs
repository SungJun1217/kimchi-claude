// 저장소의 한국어 문서가 자기 린터를 통과하는지 검사한다.
//
// 한국어 말투를 고쳐 주는 플러그인이 자기 문서에서 어색한 표현을 쓰면 설득력이 없다.
// 이 시험이 그것을 막는다. 문서에 나쁜 예를 인용해야 하면 kimchi-ignore 표시를 쓴다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules } from "../hooks/lib/rules.mjs";
import { lint } from "../hooks/lib/lint.mjs";
import { looksKorean } from "../hooks/lib/detect.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".remember", "results", "output-styles"]);

function collectMarkdown(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...collectMarkdown(full));
    else if (name.endsWith(".md")) found.push(full);
  }
  return found;
}

const { rules } = loadRules(join(ROOT, "rules"));
const documents = collectMarkdown(ROOT);

test("한국어 마크다운 문서를 찾았다", () => {
  const korean = documents.filter((path) => looksKorean(readFileSync(path, "utf8")));
  assert.ok(korean.length >= 5, `한국어 문서를 ${korean.length}개만 찾았다`);
});

test("저장소의 한국어 문서가 규칙을 어기지 않는다", () => {
  const problems = [];
  for (const path of documents) {
    const text = readFileSync(path, "utf8");
    if (!looksKorean(text)) continue;
    for (const finding of lint(text, rules)) {
      problems.push(`${relative(ROOT, path)}: "${finding.matched}" → "${finding.good}"`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `\n${problems.join("\n")}\n\n나쁜 예를 일부러 인용한 자리라면 kimchi-ignore 표시를 쓰십시오.`
  );
});

test("README가 말하는 규칙 수가 실제와 맞는다", () => {
  // 문서의 숫자는 조용히 낡는다. 낡으면 읽는 사람을 속인다.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const stated = readme.match(/규칙 (\d+)개/g)?.map((hit) => Number(hit.match(/\d+/)[0])) ?? [];
  assert.ok(stated.length > 0, "README에 규칙 수가 적혀 있지 않다");
  for (const count of stated) {
    assert.equal(count, rules.length, `README는 ${count}개라고 적었는데 실제는 ${rules.length}개다`);
  }
});
