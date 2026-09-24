// 실험 채점기. out/*.md 를 읽어 조건별 지표를 낸다.
// 사용법: node metrics.mjs answers
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const KIMCHI = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const { loadRules } = await import(`${KIMCHI}/hooks/lib/rules.mjs`);
const { lint } = await import(`${KIMCHI}/hooks/lib/lint.mjs`);
const { findParticleErrors } = await import(`${KIMCHI}/hooks/lib/particle.mjs`);
const { countHangul } = await import(`${KIMCHI}/hooks/lib/detect.mjs`);
const { rules } = loadRules(join(KIMCHI, "rules"));

const ENDINGS = new Set(["다", "요", "죠", "까", "네"]);
const NOUNISH = /(함|됨|음|임|필요|완료|예정|가능|불가|없음|있음|확인|통과|수정|추가|제거|변경|적용|누락)$/;

function prose(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "X");
}

function analyze(text) {
  const clean = prose(text);
  const hangul = countHangul(clean) || 1;
  const rows = { prose: { n: 0, bad: 0, noun: 0 }, list: { n: 0, bad: 0, noun: 0 } };
  const lengths = [];
  for (const raw of clean.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("|") || /^[-*_]{3,}$/.test(line)) continue;
    const isList = /^([-*•]|\d+[.)])\s/.test(line);
    const body = line.replace(/^([-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, "");
    for (const sentence of body.split(/(?<=[.!?])\s+/)) {
      const s = sentence.replace(/[.!?:)\]"'”’\s]+$/, "");
      if (countHangul(s) < 4) continue;
      const last = [...s].reverse().find((ch) => /[가-힣]/.test(ch));
      if (!last) continue;
      const row = rows[isList ? "list" : "prose"];
      row.n++;
      if (!ENDINGS.has(last)) row.bad++;
      if (NOUNISH.test(s)) row.noun++;
      lengths.push(countHangul(s));
    }
  }
  const ui = (clean.match(/[가-힣]의(?=\s)/g) || []).length;
  return {
    hangul,
    lint: lint(clean, rules).length + findParticleErrors(clean).length,
    proseSentences: rows.prose.n,
    proseNoEnding: rows.prose.bad,
    listItems: rows.list.n,
    listNoEnding: rows.list.bad,
    nounEndings: rows.prose.noun + rows.list.noun,
    uiPer1000: +((ui / hangul) * 1000).toFixed(1),
    emDash: (clean.match(/—/g) || []).length,
    avgSentence: lengths.length ? +(lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(1) : 0,
  };
}

const dir = process.argv[2];
const results = {};
for (const name of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
  results[name.replace(/\.md$/, "")] = analyze(readFileSync(join(dir, name), "utf8"));
}
console.log(JSON.stringify(results, null, 1));
