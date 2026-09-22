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
import { loadRules, byPriority } from "../hooks/lib/rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RULES_DIR = join(ROOT, "rules");
const OUT_PATH = join(ROOT, "output-styles", "natural-korean.md");

// 스타일 본문 전체 길이 상한. 시스템 프롬프트는 프롬프트 캐시에 올라가므로 비용 부담은
// 낮지만 모델의 주의 예산은 유한하다. 자료가 300개로 자라도 본문은 여기까지만 담는다.
export const MAX_CHARS = 6000;

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
5. **은유는 번역 대상이 아닙니다.** 얇다, 두껍다, 깊다, 평평하다는 한국어에서 그 뜻으로 쓰이지 않습니다. 은유를 벗기고 개념의 이름을 쓰십시오. 단, 이미 정착한 은유(무겁다, 가볍다, 코드 냄새, 일급)는 그대로 씁니다.
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

  // 두 단계로 나눈다. 먼저 순위 순서로 무엇을 담을지 고르고, 그다음 분류별로 묶어 출력한다.
  // 한 번에 하면 분류가 교차해 같은 소제목이 여러 번 나온다.
  const sections = new Map();
  let length = PREAMBLE.length;
  let included = 0;

  for (const rule of ordered) {
    const title = SECTION_TITLES[rule.source] || rule.source;
    const rowCost = `${toRow(rule)}\n`.length;
    const headingCost = sections.has(title) ? 0 : sectionHeading(title).length;

    if (length + rowCost + headingCost > maxChars) break;

    if (!sections.has(title)) sections.set(title, []);
    sections.get(title).push(rule);
    length += rowCost + headingCost;
    included += 1;
  }

  let body = PREAMBLE;
  for (const [title, picked] of sections) {
    body += sectionHeading(title);
    for (const rule of picked) body += `${toRow(rule)}\n`;
  }

  return { body, included, dropped: ordered.length - included };
}

function main() {
  const check = process.argv.includes("--check");
  const { rules, skipped, files } = loadRules(RULES_DIR);

  if (rules.length === 0) {
    console.error(`규칙을 찾지 못했습니다. ${RULES_DIR} 를 확인하십시오.`);
    process.exit(1);
  }

  const { body, included, dropped } = buildBody(rules);

  if (check) {
    if (!existsSync(OUT_PATH)) {
      console.error(`${OUT_PATH} 가 없습니다. node scripts/build-style.mjs 를 실행하십시오.`);
      process.exit(1);
    }
    const current = readFileSync(OUT_PATH, "utf8");
    if (current !== body) {
      console.error("커밋된 출력 스타일이 rules/ 와 어긋납니다. node scripts/build-style.mjs 를 실행하십시오.");
      process.exit(1);
    }
    console.log(`최신입니다. 규칙 ${rules.length}개, 본문 ${body.length}자.`);
    return;
  }

  writeFileSync(OUT_PATH, body, "utf8");
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

if (import.meta.url === `file://${process.argv[1]}`) main();
