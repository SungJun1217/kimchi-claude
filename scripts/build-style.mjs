#!/usr/bin/env node
// rules/*.md 를 읽어 output-styles/natural-korean.md 를 생성한다.
//
// 이 파일 안의 PREAMBLE이 사실상 제품 본체다. 규칙표는 그 뒤에 붙는 근거 목록이고,
// 모델의 행동을 바꾸는 것은 서두의 다섯 줄이다.
//
// 사용법:
//   node scripts/build-style.mjs           생성해서 파일에 쓴다
//   node scripts/build-style.mjs --check   커밋된 파일이 최신인지 확인한다 (다르면 종료 코드 1)

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRules,
  byPriority,
  PRIORITIES,
  CHECK_PROMPT,
  CHECK_REGEX,
  CHECK_SUBSTITUTE,
} from "../hooks/lib/rules.mjs";
import { isEntrypoint } from "../hooks/lib/entrypoint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RULES_DIR = join(ROOT, "rules");
const OUT_PATH = join(ROOT, "output-styles", "natural-korean.md");
const README_PATH = join(ROOT, "README.md");

// README 안에서 숫자를 갈아 끼울 구간. 산문에 숫자를 손으로 적으면 조용히 낡는다.
const COUNTS_OPEN = "<!-- kimchi:counts -->";
const COUNTS_CLOSE = "<!-- /kimchi:counts -->";

// 스타일 본문 전체 길이 상한. 시스템 프롬프트는 프롬프트 캐시에 올라가므로 비용 부담은
// 낮지만 모델의 주의 예산은 유한하다. 자료가 300개로 자라도 본문은 여기까지만 담는다.
export const MAX_CHARS = 6000;

// 행 예산 가운데 프롬프트 규칙에 배정하는 비율. 나머지는 치환·정규식 규칙이 쓴다.
// 프롬프트 규칙은 예시 문장이라 한 줄이 길고, 용어 규칙은 짧아 같은 예산으로 여러 개가 들어간다.
export const PROMPT_SHARE = 0.5;

// 규칙 파일별 소제목. 없는 파일은 파일명을 그대로 쓴다.
const SECTION_TITLES = {
  "observed.md": "실제로 자주 나오는 실패",
  "hanja.md": "용어: 한국어 기술용어가 있는 경우",
  "metaphors.md": "은유: 벗기고 개념의 이름을 쓸 것",
  "terms.md": "직역과 음차",
  "patterns.md": "문장 구조",
  "pangyo.md": "판교어와 한영 혼용",
  "register.md": "어투와 표기",
};

const PREAMBLE = `---
name: 자연스러운 한국어
description: 한국어로 물으면 한국 개발자가 실제로 쓰는 말투로 답합니다
keep-coding-instructions: true
force-for-plugin: true
---
<!-- kimchi-ignore-file 이 문서는 금칙 표현을 대조 예시로 싣는다. 린터가 자기 본문을 지적하면 안 된다 -->

사용자가 한국어로 쓰면, 한국 개발자가 실제로 쓰는 말로 답합니다.

## 적용 범위

이 규칙은 **사용자에게 보이는 문장 표현에만** 적용됩니다. 판단·분석·코드 품질·도구 사용에는 영향이 없습니다.

- 사용자가 영어로 쓰면 영어로 답하고 이 규칙을 적용하지 않습니다.
- 적용 대상: 대화, 계획서, 커밋 메시지, PR 설명.
- 적용하지 않는 것: 코드, 식별자, 명령어, 파일 경로, 제품·라이브러리 이름, 로그·오류 메시지 원문, 파일 내용, 주석.

**이 규칙 때문에 설명을 줄이거나 분석을 생략하지 마십시오.** 문장만 다듬는 것이지, 짧게 쓰라는 규칙이 아닙니다.

한글 인코딩·엑셀 CSV, 개인정보 마스킹, 공휴일·음력, 주소·전화번호를 다루는 코드를 쓸 때는 먼저 해당 korean-* 스킬을 엽니다.

## 문체

실무 동료체입니다. 존댓말을 쓰고 군더더기를 뺍니다.

> 캐시를 매번 새로 만들어서 느렸습니다. 한 번만 계산하도록 고쳤고, 테스트는 통과합니다.
>
> 동시 요청이 오면 캐시가 두 번 만들어질 수 있어, 락이 없으면 첫 요청만 값이 어긋납니다.

문장은 서술어로 끝맺습니다. 명사로 끊지 않습니다(제목과 짧은 목록 항목은 예외). "~할지 여부", "~하는 것을 권장합니다" 같은 공문서체도 쓰지 않습니다. 문장 가운데를 쌍점이나 엠대시로 잇지 말고, 접속사를 쓰거나 두 문장으로 나눕니다.

## 용어 처리 우선순위

용어를 고를 때 이 순서대로 찾습니다.

1. **한국 개발자가 실제로 타이핑하는 대로 씁니다.** 확신이 없으면 원어를 그대로 씁니다.
2. **한국어로 정착한 말은 한국어로 씁니다.** 배포, 커밋, 캐시 등입니다.
3. **개발자가 로마자로 쓰는 말은 로마자로 씁니다.** state, props, payload, target, directory, endpoint 같은 명사입니다. 명사 자리에만 쓰고, 컨펌·어사인 같은 사내 은어는 한국어로 씁니다. 여러 낱말로 된 용어는 통째로 씁니다("build target directory"). target·directory는 로마자로 쓰고, 한글로 적어야 하면 타깃·디렉터리로 씁니다(질문 표기를 따르지 않습니다). 릴리즈는 릴리스로 씁니다.
4. **순우리말로 풀어쓰는 것은 최후 수단입니다.** 늘이면 대개 더 어색해집니다. 길어지면 틀렸다고 의심하고 1~3번을 다시 찾으십시오.
5. **은유는 번역 대상이 아닙니다.** 얇다, 두껍다, 깊다, 평평하다는 한국어에서 그 뜻으로 쓰이지 않습니다. 은유를 벗기고 개념의 이름을 쓰십시오. 단, 이미 정착한 은유는 그대로 씁니다. 무겁다, 가볍다, 코드 냄새, 일급, 그리고 **깊은 복사·얕은 복사**와 **중첩 깊이**처럼 짝으로 굳은 표현이 그렇습니다.
   **활용형에도 적용됩니다.** "얇은 계약"뿐 아니라 "계약이 얇으면", "계약을 얇게"도 쓰지 않습니다. 활용이 풍부해 같은 은유가 여러 꼴로 되살아납니다.

로마자 동사에 하다를 붙이지 않습니다("push합니다"는 틀립니다). 정착한 음차 동사는 한글로 씁니다(푸시·머지·업데이트합니다). 한 답변 안에서는 같은 말을 한 가지 표기로만 씁니다.

4번이 가장 자주 어긋납니다. **"자연스러운 한국어"는 순우리말을 뜻하지 않습니다.** 정착어·원어가 더 짧고 정확하며 통용됩니다.

같은 원문이 두 방향으로 갈립니다. thin contract는 "얇은 계약"도 "모듈끼리 서로 알아야 하는 것을 최소로 줄이세요"도 아니라 "결합도를 낮추세요"이고, blast radius는 "블라스트 레디우스"도 "여파가 미치는 범위"도 아니라 "영향 범위"입니다.

## 쓰지 말 것과 쓸 것

아래는 자주 어긋나는 사례입니다. 목록에 없는 표현도 위의 다섯 순위로 판단하십시오.
`;

// 이유 칸이 길어지면 표가 읽기 어려워진다. 스타일 본문에서는 첫 문장만 남긴다.
const MAX_WHY_CHARS = 60;

function shortenWhy(why) {
  if (!why) return "";
  if (why.length <= MAX_WHY_CHARS) return why;
  const cut = why.slice(0, MAX_WHY_CHARS);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("다 "));
  return (lastStop > 20 ? cut.slice(0, lastStop + 1) : cut).trim();
}

/**
 * 규칙 한 줄을 표 행으로 만든다.
 *
 * 이유 칸을 모든 규칙에 붙인다. 목록에 없는 표현까지 판단하게 만드는 것이 목적이므로,
 * 치환 쌍만 나열하는 것보다 이유를 읽히는 편이 낫다.
 */
function toRow(rule) {
  const en = rule.en || "—";
  return `| ${en} | ${rule.bad} | ${rule.good} | ${shortenWhy(rule.why)} |`;
}

function sectionHeading(title) {
  return `\n### ${title}\n\n| 원어 | 쓰지 말 것 | 쓸 것 | 이유 |\n|---|---|---|---|\n`;
}

/**
 * 규칙 목록으로 본문을 만든다. 상한을 넘으면 낮은 순위부터 잘라낸다.
 *
 * @param {object[]} rules
 * @param {number} maxChars
 * @returns {{body: string, included: number, dropped: number}}
 */
export function buildBody(rules, maxChars = MAX_CHARS) {
  const ordered = byPriority(rules);

  // 예산을 두 갈래로 나눈다.
  //
  // 프롬프트 규칙은 문자열로 잡을 수 없어 예방밖에 방법이 없다. 그렇다고 치환·정규식 규칙을
  // 뒤로 미루면 안 된다. 린터는 커밋 메시지와 문서 파일만 보고 **대화는 못 본다.**
  // 대화가 이 플러그인의 주 무대이므로 용어 규칙도 스타일에 있어야 한다.
  //
  // 소제목 비용은 어느 갈래에도 물리지 않고 전체 상한에서만 뺀다. 한 소제목 아래에
  // 두 갈래가 섞여 들어오기 때문이다.
  const rowBudget = Math.max(0, maxChars - PREAMBLE.length);
  const promptBudget = Math.floor(rowBudget * PROMPT_SHARE);
  const promptLane = { budget: promptBudget, spent: 0 };
  const termLane = { budget: rowBudget - promptBudget, spent: 0 };
  const anyLane = { budget: Infinity, spent: 0 };

  const sections = new Map();
  let length = PREAMBLE.length;
  let included = 0;

  const admit = (rule, lane) => {
    const title = SECTION_TITLES[rule.source] || rule.source;
    const rowCost = `${toRow(rule)}
`.length;
    const headingCost = sections.has(title) ? 0 : sectionHeading(title).length;

    if (length + rowCost + headingCost > maxChars) return false;
    if (lane.spent + rowCost > lane.budget) return false;

    if (!sections.has(title)) sections.set(title, []);
    sections.get(title).push(rule);
    length += rowCost + headingCost;
    lane.spent += rowCost;
    included += 1;
    return true;
  };

  // 자기 갈래 예산을 넘긴 규칙은 같은 순위 안에서 곧바로 남는 자리(anyLane)에 다시 시도한다.
  // 순위 tier가 끝날 때까지 미루면 안 된다 — 미루는 동안 낮은 순위 규칙이 (제 갈래 예산이
  // 아직 안 찼다는 이유로) 첫 시도에서 바로 들어가 length를 먼저 써버리면, 높은 순위인데
  // 제 갈래만 못 들어간 규칙이 나중에 anyLane을 시도할 때는 정작 남는 자리가 없다. 실측:
  // rules/hanja.md의 핵심 순위 행 몇 개가 길어져 치환 갈래(termLane) 예산을 넘기자, 같은
  // 핵심 순위인 metaphors.md의 lazy evaluation(치환)이 밀려났는데, 그보다 뒤에 오는 보통
  // 순위 profiling(hanja.md, 프롬프트)은 프롬프트 갈래(promptLane) 예산이 아직 남아 있어
  // 첫 시도에서 바로 들어갔다 — 낮은 순위가 자기 갈래에 자리가 있다는 이유만으로 높은
  // 순위의 재시도보다 먼저 length를 차지한 것이다. tier별로 즉시 재시도해야 이 역전이 안 생긴다.
  for (const priority of PRIORITIES) {
    const tier = ordered.filter((rule) => rule.priority === priority);
    const deferred = [];
    for (const rule of tier) {
      if (!admit(rule, rule.check === CHECK_PROMPT ? promptLane : termLane)) deferred.push(rule);
    }
    // 한쪽 갈래가 이 순위에서 예산을 덜 썼으면 남은 자리를 같은 순위 안에서 넘긴다.
    for (const rule of deferred) admit(rule, anyLane);
  }

  let body = PREAMBLE;
  for (const [title, rows] of sections) {
    body += sectionHeading(title);
    for (const rule of rows) body += `${toRow(rule)}
`;
  }

  return { body, included, dropped: ordered.length - included };
}

/**
 * README 의 표시 구간에 규칙 수를 써 넣은 문서를 돌려준다.
 */
export function renderReadme(readme, rules, included, skillDescriptions = []) {
  const count = (check) => rules.filter((rule) => rule.check === check).length;
  const block = [
    COUNTS_OPEN,
    `| 갈래 | 개수 | 누가 막나 |`,
    `|---|---|---|`,
    `| 치환 | ${count(CHECK_SUBSTITUTE)} | 린터가 잡고, \`KIMCHI_AUTOFIX=1\`이면 바로 고칩니다 |`,
    `| 정규식 | ${count(CHECK_REGEX)} | 린터가 잡아서 알려 줍니다 |`,
    `| 프롬프트 | ${count(CHECK_PROMPT)} | 문자열로는 못 잡아서 출력 스타일로만 막습니다 |`,
    `| **합계** | **${rules.length}** | 그중 ${included}개가 출력 스타일 본문에 들어갑니다 |`,
    "",
    `스킬은 설명 ${skillDescriptions.length}개, 모두 ${skillDescriptions.reduce((sum, text) => sum + text.length, 0)}자만 늘 컨텍스트에 있습니다. 본문은 그 일을 할 때만 열립니다.`,
    COUNTS_CLOSE,
  ].join("\n");

  const start = readme.indexOf(COUNTS_OPEN);
  const end = readme.indexOf(COUNTS_CLOSE);
  if (start === -1 || end === -1) return readme;
  return readme.slice(0, start) + block + readme.slice(end + COUNTS_CLOSE.length);
}

/**
 * 스킬마다 frontmatter 의 description 을 읽는다. 늘 컨텍스트에 있는 것은 이 설명뿐이다.
 * 손으로 적은 토큰 수는 스킬이 늘면서 조용히 낡았다. 그래서 글자 수를 세어 써 넣는다.
 */
function readSkillDescriptions() {
  const dir = join(ROOT, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name, "SKILL.md"))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf8").match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function main() {
  const check = process.argv.includes("--check");
  const { rules, skipped, files } = loadRules(RULES_DIR);

  if (rules.length === 0) {
    console.error(`규칙을 찾지 못했습니다. ${RULES_DIR} 를 확인하십시오.`);
    process.exit(1);
  }

  const { body, included, dropped } = buildBody(rules);

  const readme = existsSync(README_PATH) ? readFileSync(README_PATH, "utf8") : "";
  const nextReadme = renderReadme(readme, rules, included, readSkillDescriptions());

  if (check) {
    if (!existsSync(OUT_PATH)) {
      console.error(`${OUT_PATH} 가 없습니다. node scripts/build-style.mjs 를 실행하십시오.`);
      process.exit(1);
    }
    const stale = [];
    if (readFileSync(OUT_PATH, "utf8") !== body) stale.push("출력 스타일");
    if (readme !== nextReadme) stale.push("README 의 규칙 수");
    if (stale.length > 0) {
      console.error(`${stale.join("과 ")}가 rules/ 와 어긋납니다. node scripts/build-style.mjs 를 실행하십시오.`);
      process.exit(1);
    }
    console.log(`최신입니다. 규칙 ${rules.length}개, 본문 ${body.length}자.`);
    return;
  }

  writeFileSync(OUT_PATH, body, "utf8");
  if (readme !== nextReadme) writeFileSync(README_PATH, nextReadme, "utf8");
  console.log(
    [
      `파일 ${files.length}개에서 규칙 ${rules.length}개를 읽었습니다.`,
      skipped > 0 ? `형식이 깨진 행 ${skipped}개는 건너뛰었습니다.` : null,
      `본문에 ${included}개를 담았습니다. ${dropped > 0 ? `${dropped}개는 분량 상한으로 제외했습니다.` : ""}`,
      `본문 길이 ${body.length}자 (상한 ${MAX_CHARS}자).`,
    ]
      .filter(Boolean)
      .join("\n")
  );
}

if (isEntrypoint(import.meta.url)) main();
