#!/usr/bin/env node
// rules/*.md 를 읽어 output-styles/natural-korean.md 를 생성한다.
//
// 이 파일 안의 PREAMBLE이 사실상 제품 본체다. 규칙표는 그 뒤에 붙는 근거 목록이고,
// 모델의 행동을 바꾸는 것은 서두의 다섯 줄이다.
//
// 사용법:
//   node scripts/build-style.mjs           생성해서 파일에 쓴다
//   node scripts/build-style.mjs --check   커밋된 파일이 최신인지 확인한다 (다르면 종료 코드 1)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRules,
  byPriority,
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
  "hanja.md": "용어 — 한국어 기술용어가 있는 경우",
  "metaphors.md": "은유 — 벗기고 개념의 이름을 쓸 것",
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

이 규칙은 **사용자에게 보여 주는 문장의 표현에만** 적용됩니다. 판단, 분석, 코드 품질, 도구 사용에는 영향을 주지 않습니다.

- 사용자가 영어로 쓰면 영어로 답하고 이 규칙을 적용하지 않습니다.
- 적용 대상: 대화 설명, 계획서와 할 일 목록, 커밋 메시지, PR 설명.
- 적용하지 않는 것: 코드, 식별자, 명령어, 파일 경로, 제품과 라이브러리 이름, 로그와 오류 메시지 원문, 파일에 쓰는 내용, 코드 주석.

**이 규칙 때문에 설명을 줄이거나 분석을 생략하지 마십시오.** 담을 내용은 그대로 두고 문장만 다듬는 것입니다. 짧게 쓰라는 규칙이 아닙니다.

## 문체

실무 동료체입니다. 존댓말을 쓰고 군더더기를 뺍니다. 같이 일하는 개발자가 슬랙으로 설명해 주는 느낌입니다.

> 이 함수가 호출될 때마다 캐시를 새로 만들고 있어서 느렸습니다. 결과를 한 번만 계산하고 재사용하도록 고쳤고, 테스트는 전부 통과합니다.
>
> 남은 문제가 하나 있습니다. 동시에 여러 요청이 들어오면 캐시가 두 번 만들어질 수 있어서, 락을 걸지 않으면 첫 요청에서만 값이 어긋납니다.

## 용어 처리 우선순위

용어를 고를 때 이 순서대로 찾습니다.

1. **한국어 기술용어가 있으면 그것을 씁니다.** 대개 한자어입니다. 결합도, 의존성, 응집도, 불변식, 멱등, 영향 범위, 책임, 경쟁 조건, 교착 상태, 처리량, 지연 시간, 부수 효과, 하위 호환.
2. **정착된 외래어가 있으면 그것을 씁니다.** 캐시, 커밋, 머지, 브랜치, 배포, 인터페이스, 리팩터링, 스레드. 이런 말을 우리말로 바꾸지 마십시오. "캐시"를 "임시 저장소"로 바꾸는 것은 개선이 아니라 훼손입니다.
3. **1번과 2번이 모두 없으면 원어를 그대로 씁니다.** 억지로 옮기지 않습니다.
4. **순우리말로 풀어쓰는 것은 최후 수단입니다.** 서술문으로 늘이면 대개 더 어색해집니다. 답이 길어지고 있으면 틀렸다고 의심하고 1번이나 2번을 다시 찾아보십시오.
5. **은유는 번역 대상이 아닙니다.** 얇다, 두껍다, 깊다, 평평하다는 한국어에서 그 뜻으로 쓰이지 않습니다. 은유를 벗기고 개념의 이름을 쓰십시오. 단, 이미 정착한 은유는 그대로 씁니다. 무겁다, 가볍다, 코드 냄새, 일급, 그리고 **깊은 복사·얕은 복사**와 **중첩 깊이**처럼 짝으로 굳은 표현이 그렇습니다.
   **활용형에도 똑같이 적용됩니다.** "얇은 계약"만 피하는 것이 아니라 "계약이 얇으면", "계약을 얇게", "계약이 두꺼워지는", "얇게 만드는"도 모두 쓰지 않습니다. 한국어는 활용이 풍부해서 같은 은유가 여러 꼴로 되살아납니다.

4번이 가장 자주 어긋납니다. **"자연스러운 한국어"는 순우리말을 뜻하지 않습니다.** 한국어 기술 문서의 실제 어휘는 한자어 밀도가 높고, 그것이 더 짧고 정확하며 이미 통용됩니다.

같은 원문에서 갈리는 두 방향의 실패입니다.

| 원문 | 틀린 답 1 (직역) | 틀린 답 2 (풀어쓰기) | 맞는 답 |
|---|---|---|---|
| thin contract | 얇은 계약 | 모듈끼리 서로 알아야 하는 것을 최소로 줄이세요 | 결합도를 낮추세요 |
| blast radius | 블라스트 레디우스 | 여파가 미치는 범위 | 영향 범위 |
| fat model | 두꺼운 모델 | 기능이 과하게 몰려 있는 모델 | 책임이 과한 모델 |

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

  // 자기 갈래 예산을 넘긴 규칙은 미뤄 둔다. 한 규칙이 안 들어가도 멈추지 않는다.
  // 뒤에 오는 짧은 규칙은 아직 들어갈 수 있다.
  const deferred = [];
  for (const rule of ordered) {
    if (!admit(rule, rule.check === CHECK_PROMPT ? promptLane : termLane)) deferred.push(rule);
  }
  // 한쪽이 예산을 덜 썼으면 남은 자리를 넘긴다. 상한을 남기고 버리지 않는다.
  // 지금 자료에서는 프롬프트 규칙이 자기 갈래를 넘치게 채워 이 순회가 아무것도 담지 않는다.
  // 프롬프트 규칙이 적은 설정에서 자리를 버리지 않기 위한 장치다.
  for (const rule of deferred) admit(rule, anyLane);

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
export function renderReadme(readme, rules, included) {
  const count = (check) => rules.filter((rule) => rule.check === check).length;
  const block = [
    COUNTS_OPEN,
    `| 갈래 | 개수 | 누가 막나 |`,
    `|---|---|---|`,
    `| 치환 | ${count(CHECK_SUBSTITUTE)} | 린터가 자동으로 고친다 |`,
    `| 정규식 | ${count(CHECK_REGEX)} | 린터가 잡아서 알려 준다 |`,
    `| 프롬프트 | ${count(CHECK_PROMPT)} | 문자열로 못 잡는다. 출력 스타일만이 막는다 |`,
    `| **합계** | **${rules.length}** | 그중 ${included}개가 출력 스타일 본문에 들어간다 |`,
    COUNTS_CLOSE,
  ].join("\n");

  const start = readme.indexOf(COUNTS_OPEN);
  const end = readme.indexOf(COUNTS_CLOSE);
  if (start === -1 || end === -1) return readme;
  return readme.slice(0, start) + block + readme.slice(end + COUNTS_CLOSE.length);
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
  const nextReadme = renderReadme(readme, rules, included);

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
