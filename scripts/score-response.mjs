#!/usr/bin/env node
// 한국어 글을 규칙표로 채점한다.
//
// 훅 밖에서 쓰는 도구다. 평가 결과를 손으로 확인할 때, 그리고 자격 증명이 없어
// claude plugin eval 을 돌릴 수 없는 환경에서 말투를 재 볼 때 쓴다.
//
// 사용법:
//   node scripts/score-response.mjs <파일>
//   cat 답변.md | node scripts/score-response.mjs
//   node scripts/score-response.mjs --fix <파일>   치환 규칙을 적용한 결과를 내보낸다
//   node scripts/score-response.mjs --json <파일>

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules } from "../hooks/lib/rules.mjs";
import { lint, applyFixes, formatFindings } from "../hooks/lib/lint.mjs";
import { looksKorean, countHangul } from "../hooks/lib/detect.mjs";
import { findParticleErrors, fixParticles, formatParticleErrors } from "../hooks/lib/particle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readInput(path) {
  try {
    return readFileSync(path ?? 0, "utf8");
  } catch (error) {
    console.error(`읽을 수 없습니다: ${path ?? "표준 입력"} (${error.code || error.message})`);
    process.exit(2);
  }
}

// 1000자당 위반 건수. 글 길이가 다른 답변을 견주기 위한 값이다.
function densityPer1000(findings, text) {
  const hangul = countHangul(text) || 1;
  return Math.round((findings.length / hangul) * 1000 * 10) / 10;
}

function main() {
  const args = process.argv.slice(2);
  const fix = args.includes("--fix");
  const json = args.includes("--json");
  const path = args.find((arg) => !arg.startsWith("--"));

  const text = readInput(path);
  const { rules } = loadRules(join(ROOT, "rules"));

  if (rules.length === 0) {
    console.error("규칙을 찾지 못했습니다. rules/ 를 확인하십시오.");
    process.exit(2);
  }

  if (fix) {
    // 조사를 먼저 고친다. 용어를 바꾸면 조사가 다시 틀어질 수 있어 순서가 중요하다.
    const result = applyFixes(fixParticles(text).text, rules);
    process.stdout.write(fixParticles(result.text).text);
    if (result.skipped.length > 0) {
      console.error(`\n손대지 않은 것 ${result.skipped.length}건:`);
      for (const item of result.skipped) {
        console.error(`  "${item.matched}" — ${item.reason}`);
      }
    }
    return;
  }

  const findings = lint(text, rules);
  const particles = findParticleErrors(text);

  if (json) {
    console.log(
      JSON.stringify(
        {
          korean: looksKorean(text),
          hangul: countHangul(text),
          rules: rules.length,
          violations: findings.length + particles.length,
          particleErrors: particles.length,
          per1000: densityPer1000([...findings, ...particles], text),
          findings: findings.map(({ matched, good, why, index, priority, source }) => ({
            matched, good, why, index, priority, source,
          })),
        },
        null,
        2
      )
    );
    process.exit(findings.length + particles.length === 0 ? 0 : 1);
  }

  if (!looksKorean(text)) {
    console.log("한국어 글로 보이지 않아 검사하지 않았습니다.");
    return;
  }

  if (findings.length === 0 && particles.length === 0) {
    console.log(`걸리는 표현이 없습니다. (한글 ${countHangul(text)}자, 규칙 ${rules.length}개)`);
    return;
  }

  if (findings.length > 0) console.log(formatFindings(findings));
  if (particles.length > 0) {
    if (findings.length > 0) console.log("");
    console.log(formatParticleErrors(particles));
  }
  console.log(`\n한글 1000자당 ${densityPer1000([...findings, ...particles], text)}건.`);
  process.exit(1);
}

main();
