// 저장소의 한국어 문서가 자기 린터를 통과하는지 검사한다.
//
// 한국어 말투를 고쳐 주는 플러그인이 자기 문서에서 어색한 표현을 쓰면 설득력이 없다.
// 이 시험이 그것을 막는다. 문서에 나쁜 예를 인용해야 하면 kimchi-ignore 표시를 쓴다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules } from "../hooks/lib/rules.mjs";
import { lint } from "../hooks/lib/lint.mjs";
import { findParticleErrors } from "../hooks/lib/particle.mjs";
import { looksKorean } from "../hooks/lib/detect.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// output-styles 를 빼지 않는다. 생성된 스타일 본문이 스스로 붙인 예외 표시로
// 걸러지는지 여기서 함께 확인된다.
const SKIP_DIRS = new Set(["node_modules", ".git", ".remember", "results"]);

/** 디렉터리 아래 모든 파일을 모은다. */
function collectFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...collectFiles(full));
    else found.push(full);
  }
  return found;
}

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

test("저장소의 한국어 문서에 조사 오류가 없다", () => {
  // 손으로 훑어서 찾은 것은 시험으로 옮긴다. 이 시험이 없어서 "1으로" 를 손으로 찾았다.
  const problems = [];
  for (const path of documents) {
    const text = readFileSync(path, "utf8");
    if (!looksKorean(text)) continue;
    for (const hit of findParticleErrors(text)) {
      problems.push(`${relative(ROOT, path)}: "${hit.matched}" → "${hit.word}${hit.correct}"`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
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

// README 의 규칙 수는 build-style.mjs 가 써 넣고 --check 가 검증한다.
// 산문을 정규식으로 긁는 시험은 표현을 고칠 때마다 깨지고, 다음 사람은 시험 대신
// 문장을 고칠 유인을 갖는다.

test("설계 문서의 파일 목록이 실물과 맞는다", () => {
  // 문서가 틀리면 읽는 사람을 속인다. README 의 숫자는 --check 가 검증하는데
  // 설계 문서의 파일 목록은 아무도 보지 않아 네 기능이 지나가도록 낡아 있었다.
  const spec = readFileSync(join(ROOT, "docs/superpowers/specs/2026-09-22-natural-korean-plugin-design.md"), "utf8");
  const structure = spec.slice(spec.indexOf("## 구조"), spec.indexOf("### 왜 출력 스타일인가"));

  // 런타임 코드는 모두 적혀 있어야 한다.
  const runtime = ["hooks", "scripts"].flatMap((dir) =>
    collectFiles(join(ROOT, dir)).filter((path) => path.endsWith(".mjs"))
  );
  const missing = runtime
    .map((path) => basename(path))
    .filter((name) => !structure.includes(name));
  assert.deepEqual(missing, [], "구조 절에 빠진 파일이 있다");

  // 없어진 파일이 아직 적혀 있는 경우도 잡는다. 구조 절은 시험 파일도 가리키므로
  // 저장소 전체의 .mjs 를 안다고 본다.
  // 점을 포함한 온전한 파일명을 잡는다. [\w-]+ 만 쓰면 examples.test.mjs 에서
  // test.mjs 만 잘려 나와 없는 파일로 보인다.
  const declared = [...structure.matchAll(/(?<![\w.-])([\w.-]+\.mjs)/g)].map((hit) => hit[1]);
  const known = new Set(
    collectFiles(ROOT)
      .filter((path) => path.endsWith(".mjs"))
      .map((path) => basename(path))
  );
  const stale = [...new Set(declared)].filter((name) => !known.has(name) && !name.startsWith("*"));
  assert.deepEqual(stale, [], "구조 절에 없어진 파일이 적혀 있다");
});
