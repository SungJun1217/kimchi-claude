#!/usr/bin/env node
// README 그림을 만든다. assets/*.svg 를 라이트·다크 두 벌씩 쓴다.
//
// 그림 속 문구를 손으로 적지 않는다. 훅 메시지는 훅이 쓰는 함수로, 린터 점수는
// 린터로 그 자리에서 만든다. 손으로 적은 그림은 메시지가 바뀌어도 아무도 모른 채 낡는다.
// 답변 발췌만은 손으로 줄을 나눴고, 발췌가 원문에 있는지는 시험이 확인한다.
//
// 사용법:
//   node scripts/build-readme-art.mjs           assets/ 를 다시 쓴다
//   node scripts/build-readme-art.mjs --check   다시 만든 결과가 디스크와 다르면 실패한다

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules } from "../hooks/lib/rules.mjs";
import { lint } from "../hooks/lib/lint.mjs";
import { findParticleErrors } from "../hooks/lib/particle.mjs";
import { countHangul } from "../hooks/lib/detect.mjs";
import { findResidentNumbers, formatLeak } from "../hooks/lib/pii.mjs";
import { warnAboutTone } from "../hooks/lib/artifact.mjs";
import { describeRepoLanguage } from "../hooks/lib/repo-language.mjs";
import { isEntrypoint } from "../hooks/lib/entrypoint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets");

const THEMES = {
  light: {
    bg: "#FFFBF5", chrome: "#F6ECE1", border: "#EAD8C6", card: "#FFFFFF", cardBorder: "#EFE2D4",
    text: "#2B2320", muted: "#9A8A7E", red: "#C8372D", redBg: "#FCE4DF", green: "#2F8A45",
    greenBg: "#DFF2E3", amber: "#B8660F", amberBg: "#FCEBD5", blue: "#2F6DB5", blueBg: "#E0ECF9",
    accent: "#D9532B", glow: "#F4B39C",
    logoJar: "#9A5B3A", logoJarDark: "#7A4329", logoJarLight: "#B97550", logoRim: "#6E3B23", logoShadow: "#2B232022",
    logoFace: "#2B2320", logoBlush: "#F08A7E", logoTag: "#FFFBF5", logoTagText: "#2B2320", logoLeaf: "#F4EEC9",
    logoLeafEdge: "#DCCF94", logoGreen: "#6FAE45", logoGreenDark: "#4E8A2E", logoRed: "#D9532B", logoRedDeep: "#B8391C",
  },
  dark: {
    bg: "#1A1513", chrome: "#241D1A", border: "#3A2F2A", card: "#211B18", cardBorder: "#3A2F2A",
    text: "#EFE5DC", muted: "#9C8B7F", red: "#FF7B6B", redBg: "#4A231F", green: "#7FD18F",
    greenBg: "#1D3A25", amber: "#F2B05E", amberBg: "#45300F", blue: "#8DB8F0", blueBg: "#1B2C45",
    accent: "#FF8A5B", glow: "#7A3322",
    logoJar: "#B06A45", logoJarDark: "#8A4E31", logoJarLight: "#CC8760", logoRim: "#7E4529", logoShadow: "#00000055",
    logoFace: "#1A1513", logoBlush: "#FF9A8C", logoTag: "#241D1A", logoTagText: "#EFE5DC", logoLeaf: "#F1E9C0",
    logoLeafEdge: "#CFC088", logoGreen: "#7FC455", logoGreenDark: "#5A9C38", logoRed: "#E8663D", logoRedDeep: "#C4492A",
  },
};

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
const SANS = "'Pretendard','Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',system-ui,sans-serif";

/** 글자 폭 추정. 한글은 거의 정사각형, ASCII 는 그 절반 남짓이다. */
function width(str, size, mono = false) {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= 0x1100 && (code <= 0x11ff || (code >= 0x2e80 && code <= 0xd7af) || code >= 0xff00)) w += size * 0.94;
    else if (ch === " ") w += size * (mono ? 0.6 : 0.28);
    else w += size * (mono ? 0.6 : 0.56);
  }
  return w;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 등장 시각(초)마다 fade 키프레임을 만든다. 모두 한 주기 안에서 사라졌다가 다시 뜬다. */
function animation(times, cycle) {
  let css = "";
  times.forEach((t, i) => {
    const p = (x) => ((x / cycle) * 100).toFixed(2);
    css +=
      `@keyframes f${i}{0%{opacity:0;transform:translateY(4px)}${p(t)}%{opacity:0;transform:translateY(4px)}` +
      `${p(t + 0.45)}%{opacity:1;transform:none}${p(cycle - 1.4)}%{opacity:1;transform:none}` +
      `${p(cycle - 0.6)}%{opacity:0}100%{opacity:0}}` +
      `.f${i}{opacity:0;animation:f${i} ${cycle}s ease-out infinite}`;
  });
  return css;
}

const REDUCED = "@media (prefers-reduced-motion:reduce){[class^=f],[class*=' f']{animation:none!important;opacity:1!important;transform:none!important}.cursor,.pulse{animation:none!important}}";

function chrome(c, w, h, title) {
  return (
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="16" fill="${c.bg}" stroke="${c.border}"/>` +
    `<path d="M0.5 16.5 a16 16 0 0 1 16 -16 h${w - 33} a16 16 0 0 1 16 16 v25 h-${w - 1} z" fill="${c.chrome}" stroke="${c.border}"/>` +
    `<line x1="0" y1="42" x2="${w}" y2="42" stroke="${c.border}"/>` +
    `<circle cx="24" cy="21" r="6" fill="#FF5F57"/><circle cx="44" cy="21" r="6" fill="#FEBC2E"/><circle cx="64" cy="21" r="6" fill="#28C840"/>` +
    `<text x="${w / 2}" y="26" text-anchor="middle" class="mono" font-size="12.5" fill="${c.muted}">${esc(title)}</text>`
  );
}

/**
 * [대괄호] 로 감싼 구간을 강조 tspan 으로 바꾼다.
 */
function rich(line, cls) {
  return line
    .split(/(\[[^\]]+\])/)
    .map((part) =>
      part.startsWith("[") ? `<tspan class="${cls}">${esc(part.slice(1, -1))}</tspan>` : esc(part)
    )
    .join("");
}

// ─── 그림에 들어가는 자료 ─────────────────────────────────────────────────────

// 같은 질문에 플러그인을 끄고 켠 상태로 받은 실제 답변(tests/fixtures/)에서 발췌한다.
// [대괄호] 는 강조할 구간이다. 줄 끝의 … 와 줄 앞의 • 는 발췌 표시라 원문에 없다.
export const EXCERPTS = {
  without: {
    fixture: "thin-contract-without-plugin.md",
    lines: [
      "두 모듈이 서로 주고받는 인터페이스(공개 API)",
      "면적을 최소로 유지하라는 뜻입니다. …",
      "[계약이 얇으면] 한 모듈을 고칠 때 다른 모듈을",
      "함께 수정할 일이 거의 없어져서, 각자",
      "독립적으로 바꾸고 테스트할 수 있습니다.",
      "",
      "• [계약이 두꺼워지는] 전형적 신호: 공개 함수가",
      "   계속 늘어난다 …",
      "• 답이 한두 곳이면 [계약이 얇은] 것입니다.",
    ],
  },
  with: {
    fixture: "thin-contract-with-plugin.md",
    lines: [
      "두 모듈이 서로 알아야 하는 규약, 즉",
      "[공개 인터페이스]를 최소로 줄이라는 뜻입니다.",
      "지금은 한쪽이 상대의 내부 구조나 자료 형식까지",
      "알고 있어서 [결합도]가 높다고 본 것으로 보입니다.",
      "공개하는 함수와 타입을 줄이고 내부 구현을 감추면,",
      "한쪽을 고칠 때 [영향 범위]가 상대 모듈까지",
      "번지지 않습니다.",
      "",
      "• contract는 여기서 법적 계약이 아니라",
      "   규약·인터페이스를 가리킵니다.",
    ],
  },
};

/** 자료 파일을 예외 표시를 떼고 읽는다. */
export function readFixture(name) {
  return readFileSync(join(ROOT, "tests/fixtures", name), "utf8").replace(/^<!--[\s\S]*?-->\n/, "");
}

/** npm run score 와 같은 셈이다. 규칙 위반과 조사 오류를 더하고 한글 1000자당 건수를 낸다. */
function score(text, rules) {
  const count = lint(text, rules).length + findParticleErrors(text).length;
  const per1000 = Math.round((count / (countHangul(text) || 1)) * 1000 * 10) / 10;
  return { count, per1000 };
}

// 훅 그림의 입력. 주민등록번호는 소스에 통째로 적지 않는다. 형식이 맞는 값이 소스에 있으면
// 이 파일을 고치려는 사람이 자기 훅에 막힌다.
const PII_FILE = "docs/users.md";
const PII_TEXT = ["홍길동", ["900101", "1234567"].join("-")].join(" ");
const COMMIT_MESSAGE = "리팩토링 후 디플로이 이슈를 핸들링했습니다";

/** 뽑기가 어긋나면 크게 실패한다. 조용히 빈칸을 그리면 틀린 그림이 시험까지 통과한다. */
function expect(condition, what) {
  if (!condition) {
    throw new Error(`훅 문구의 형식이 바뀌어 그림 자료를 뽑지 못했습니다: ${what}. build-readme-art.mjs 의 hookMessages() 를 고치십시오.`);
  }
}

/** 훅이 실제로 내놓는 문구를 훅이 쓰는 함수로 만든다. */
function hookMessages(rules) {
  const leak = formatLeak(findResidentNumbers(PII_TEXT), PII_FILE).split("\n");
  const tone = warnAboutTone([{ label: "커밋 메시지", text: COMMIT_MESSAGE }], rules)
    ?.hookSpecificOutput?.additionalContext?.split("\n");
  expect(tone, "말투 경고가 나오지 않는다");
  const notice = describeRepoLanguage({ commit: "영어", doc: "알 수 없음" })
    .split("\n")
    .find((line) => line.startsWith("If the user is writing in Korean"));
  expect(notice, "저장소 언어 안내 문장을 찾지 못했다");
  // 그림 칸이 좁아 문장 전체는 못 싣는다. 핵심 대상만 뽑는다.
  const noticeTarget = notice.match(/but write (.+?) in English/);
  expect(noticeTarget, "저장소 언어 안내에서 대상을 뽑지 못했다");

  const sentences = leak[0].split(". ");
  expect(sentences.length === 2, "주민등록번호 안내 첫 줄이 두 문장이 아니다");
  const [leakHead, leakTail] = sentences;
  const position = leak.find((line) => line.startsWith("- 1번째"));
  expect(position, "주민등록번호 안내에 위치 줄이 없다");

  // 경고의 항목 줄은 모두 "- " 로 시작한다. 뽑은 수가 그와 다르면 형식이 바뀐 것이다.
  const items = tone.filter((line) => line.startsWith("- "));
  const fixes = items
    .map((line) => line.match(/^- "(.+?)" → "(.+?)" \((.+)\)$/))
    .filter(Boolean)
    // 이유는 첫 구절만 싣는다. 그림 폭이 모자라다.
    .map(([, bad, good, why]) => [bad, good, why.split(",")[0].replace(/이다$/, "")]);
  expect(fixes.length > 0 && fixes.length === items.length, `말투 경고 항목 ${items.length}줄 중 ${fixes.length}줄만 읽었다`);
  expect(/^\S.*\d+가지/.test(tone[0]), "말투 경고 첫 줄에 건수가 없다");

  return {
    notice: `Write ${noticeTarget[1]} in English`,
    leakHead: `${leakHead}.`,
    leakDetail: `${position.slice(2)}  —  ${leakTail.replace(/니다\.$/, "니다")}`,
    toneHead: tone[0],
    fixes,
  };
}

// ─── 1. 히어로: 같은 질문, 플러그인 없이 / 있을 때 ───────────────────────────
function hero(c, data) {
  const W = 1040, H = 500;
  const left = EXCERPTS.without.lines;
  const right = EXCERPTS.with.lines;

  const times = [0.4, 1.4]; // 질문, 왼쪽 카드
  left.forEach((_, i) => times.push(1.8 + i * 0.28));
  const rightCard = times.length;
  times.push(4.6);
  right.forEach((_, i) => times.push(5.0 + i * 0.28));
  const scoreL = times.length;
  times.push(8.2);
  const scoreR = times.length;
  times.push(8.7);
  const CYCLE = 16;

  const cardY = 112, cardH = 318, colW = 476;
  const card = (x, idx, badge, badgeFill, badgeBg, sub) =>
    `<g class="f${idx}"><rect x="${x}" y="${cardY}" width="${colW}" height="${cardH}" rx="12" fill="${c.card}" stroke="${c.cardBorder}"/>` +
    `<rect x="${x + 20}" y="${cardY + 18}" width="${width(badge, 13, !/[가-힣]/.test(badge)) + 26}" height="26" rx="13" fill="${badgeBg}"/>` +
    `<text x="${x + 33}" y="${cardY + 36}" class="mono" font-size="13" font-weight="700" fill="${badgeFill}">${esc(badge)}</text>` +
    `<text x="${x + colW - 20}" y="${cardY + 36}" text-anchor="end" class="sans" font-size="12.5" fill="${c.muted}">${esc(sub)}</text></g>`;

  const lines = (x, arr, start, cls) =>
    arr
      .map((l, i) =>
        l ? `<text x="${x + 22}" y="${cardY + 78 + i * 23}" class="sans f${start + i}" font-size="15" fill="${c.text}">${rich(l, cls)}</text>` : ""
      )
      .join("");

  const lx = 32, rx = W - 32 - colW;
  return svg(W, H, "같은 리뷰 질문에 플러그인을 끄고 켜서 받은 실제 답변입니다. 끈 쪽은 계약이 얇다는 직역을 쓰고, 켠 쪽은 결합도와 영향 범위라는 표준 용어를 씁니다", c,
    `.bad{fill:${c.red};font-weight:700;text-decoration:line-through;text-decoration-thickness:2px}` +
    `.good{fill:${c.green};font-weight:700}` +
    animation(times, CYCLE),
    chrome(c, W, H, "~/shop-api — claude") +
    `<text x="32" y="80" class="sans f0" font-size="16" fill="${c.text}"><tspan class="mono" fill="${c.accent}" font-weight="700">❯ </tspan>리뷰에 <tspan class="mono" fill="${c.blue}">“keep the contract between these two modules thin”</tspan>이라고 달렸어. 무슨 뜻이야?</text>` +
    card(lx, 1, "플러그인 없이", c.red, c.redBg, "직역한 은유가 그대로") +
    lines(lx, left, 2, "bad") +
    card(rx, rightCard, "kimchi-claude", c.green, c.greenBg, "정착된 기술 용어로") +
    lines(rx, right, rightCard + 1, "good") +
    // 가운데 화살표
    `<g class="f${rightCard}"><circle cx="${W / 2}" cy="${cardY + cardH / 2}" r="17" fill="${c.accent}"/>` +
    `<path d="M${W / 2 - 6} ${cardY + cardH / 2} h11 m-5 -5 l5 5 l-5 5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>` +
    `<g class="f${scoreL}"><rect x="${lx}" y="${cardY + cardH + 14}" width="${colW}" height="34" rx="10" fill="${c.redBg}"/>` +
    `<text x="${lx + colW / 2}" y="${cardY + cardH + 36}" text-anchor="middle" class="mono" font-size="13.5" font-weight="700" fill="${c.red}">린터 ${data.without.count}건 · 한글 1000자당 ${data.without.per1000}건</text></g>` +
    `<g class="f${scoreR}"><rect x="${rx}" y="${cardY + cardH + 14}" width="${colW}" height="34" rx="10" fill="${c.greenBg}"/>` +
    `<text x="${rx + colW / 2}" y="${cardY + cardH + 36}" text-anchor="middle" class="mono" font-size="13.5" font-weight="700" fill="${c.green}">린터 ${data.with.count}건 · 분석 깊이는 그대로</text></g>`
  );
}

// ─── 2. 훅: 차단 · 경고 · 안내 ───────────────────────────────────────────────
function guard(c, data) {
  const m = data.hook;
  const W = 1040, H = 440;
  const rows = [
    ["mono", c.muted, "● ", c.text, "SessionStart", "  ·  영어 이력 저장소에서 새 세션"],
    ["pill", c.blue, c.blueBg, "안내", m.notice],
    ["gap"],
    ["mono", c.muted, "● ", c.text, `Write(${PII_FILE})`, "  ·  주민등록번호가 든 회원 명단"],
    ["pill", c.red, c.redBg, "차단", m.leakHead],
    ["sub", m.leakDetail],
    ["gap"],
    ["mono", c.muted, "● ", c.text, `Bash(git commit -m "${COMMIT_MESSAGE}")`, ""],
    ["pill", c.amber, c.amberBg, "경고", m.toneHead],
    ...m.fixes.map((fix) => ["fix", ...fix]),
  ];
  const times = [];
  let y = 82, t = 0.5, body = "";
  rows.forEach((r, i) => {
    if (r[0] === "gap") { y += 14; t += 0.6; return; }
    const k = times.length;
    times.push(t);
    t += r[0] === "pill" ? 0.9 : 0.45;
    if (r[0] === "mono") {
      body += `<text x="32" y="${y}" class="mono f${k}" font-size="14.5"><tspan fill="${c.accent}">${r[2]}</tspan><tspan fill="${r[3]}" font-weight="700">${esc(r[4])}</tspan><tspan fill="${c.muted}">${esc(r[5])}</tspan></text>`;
      y += 30;
    } else if (r[0] === "pill") {
      body +=
        `<g class="f${k}"><text x="40" y="${y}" class="mono" font-size="14.5" fill="${c.muted}">⎿</text>` +
        `<rect x="64" y="${y - 17}" width="54" height="24" rx="12" fill="${r[2]}"/>` +
        `<text x="91" y="${y}" text-anchor="middle" class="sans" font-size="13" font-weight="800" fill="${r[1]}">${r[3]}</text>` +
        `<text x="132" y="${y}" class="sans" font-size="15" fill="${c.text}">${esc(r[4])}</text></g>`;
      y += 28;
    } else if (r[0] === "sub") {
      body += `<text x="132" y="${y}" class="mono f${k}" font-size="13" fill="${c.muted}">${esc(r[1])}</text>`;
      y += 24;
    } else if (r[0] === "fix") {
      body +=
        `<text x="132" y="${y}" class="sans f${k}" font-size="14.5"><tspan fill="${c.red}" text-decoration="line-through">${esc(r[1])}</tspan>` +
        `<tspan fill="${c.muted}">  →  </tspan><tspan fill="${c.green}" font-weight="700">${esc(r[2])}</tspan>` +
        `<tspan fill="${c.muted}" font-size="13">    ${esc(r[3])}</tspan></text>`;
      y += 24;
    }
  });
  // 오른쪽 범례
  const lg = times.length;
  times.push(t + 0.3);
  const legend =
    `<g class="f${lg}"><rect x="760" y="300" width="248" height="112" rx="12" fill="${c.card}" stroke="${c.cardBorder}"/>` +
    `<text x="780" y="328" class="sans" font-size="13" fill="${c.muted}">기본값</text>` +
    `<circle cx="786" cy="350" r="5" fill="${c.red}"/><text x="800" y="355" class="sans" font-size="13.5" fill="${c.text}">개인정보 → 차단</text>` +
    `<circle cx="786" cy="374" r="5" fill="${c.amber}"/><text x="800" y="379" class="sans" font-size="13.5" fill="${c.text}">말투 → 경고만</text>` +
    `<circle cx="786" cy="398" r="5" fill="${c.blue}"/><text x="800" y="403" class="sans" font-size="13.5" fill="${c.text}">저장소 언어 → 한 번 안내</text></g>`;
  return svg(W, H, "훅이 개입하는 세 장면입니다. 영어 저장소에서는 커밋을 영어로 쓰라고 안내하고, 주민등록번호가 든 파일 쓰기는 막고, 어색한 커밋 메시지에는 고칠 표현을 알려 줍니다", c,
    animation(times, Math.ceil(t + 4)),
    chrome(c, W, H, "~/shop-api — claude  ·  kimchi-claude hooks") + body + legend);
}

// ─── 0. 로고: 배추김치 모자를 쓴 김치 항아리 ──────────────────────────────────
// 이 플러그인만의 캐릭터다. Claude 로고는 Anthropic 상표라 고쳐 쓰지 않는다.
function logo(c) {
  // 고춧가루 점. 자리는 고정해서 생성 결과가 늘 같다.
  const flakes = [[66,70],[70,82],[84,52],[88,76],[90,40],[110,44],[114,68],[118,82],[132,62],[136,76],[140,56],[80,62]]
    .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 3 === 0 ? 2.2 : 1.6}" fill="${c.logoRedDeep}" opacity=".75"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -10 200 210" width="160" height="160" role="img" aria-label="배추김치 모자를 쓴 김치 항아리 캐릭터입니다">
<defs>
  <radialGradient id="jarShade" cx="38%" cy="35%" r="75%">
    <stop offset="0" stop-color="${c.logoJarLight}"/><stop offset=".55" stop-color="${c.logoJar}"/><stop offset="1" stop-color="${c.logoJarDark}"/>
  </radialGradient>
  <linearGradient id="kimchi" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${c.logoRed}"/><stop offset="1" stop-color="${c.logoRedDeep}"/>
  </linearGradient>
</defs>
<ellipse cx="100" cy="186" rx="52" ry="7" fill="${c.logoShadow}"/>
<!-- 항아리 몸통 -->
<path d="M68 92 C40 104 34 150 58 172 C72 184 128 184 142 172 C166 150 160 104 132 92 Z" fill="url(#jarShade)"/>
<!-- 항아리 입 -->
<rect x="64" y="84" width="72" height="14" rx="7" fill="${c.logoRim}"/>
<rect x="68" y="86" width="64" height="5" rx="2.5" fill="${c.logoJarLight}" opacity=".45"/>
<!-- 얼굴 -->
<ellipse cx="84" cy="124" rx="5.2" ry="6.4" fill="${c.logoFace}"/><circle cx="85.8" cy="121.6" r="1.8" fill="#fff"/>
<ellipse cx="116" cy="124" rx="5.2" ry="6.4" fill="${c.logoFace}"/><circle cx="117.8" cy="121.6" r="1.8" fill="#fff"/>
<ellipse cx="74" cy="138" rx="7" ry="4" fill="${c.logoBlush}" opacity=".7"/>
<ellipse cx="126" cy="138" rx="7" ry="4" fill="${c.logoBlush}" opacity=".7"/>
<path d="M93 136 Q100 143 107 136" stroke="${c.logoFace}" stroke-width="3" fill="none" stroke-linecap="round"/>
<!-- 이름표 -->
<rect x="82" y="152" width="36" height="17" rx="5" fill="${c.logoTag}" opacity=".95"/>
<text x="100" y="165" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="12" font-weight="700" fill="${c.logoTagText}">&gt;_</text>
<!-- 배추김치 모자: 잎 세 장이 베레모처럼 오른쪽으로 기운다. 흰 줄기 위에 양념, 끝은 초록 -->
<g transform="rotate(-8 100 90)">
  <!-- 왼쪽 잎 -->
  <path d="M60 92 C50 74 52 52 66 40 C74 52 80 72 82 92 Z" fill="${c.logoLeaf}" stroke="${c.logoLeafEdge}" stroke-width="1.2"/>
  <path d="M61 90 C54 76 55 60 64 50 C70 60 74 76 76 90 Z" fill="url(#kimchi)" opacity=".92"/>
  <path d="M66 40 C60 34 58 26 62 20 C64 26 68 24 70 30 C73 26 76 30 74 36 C72 40 70 42 66 40 Z" fill="${c.logoGreen}"/>
  <!-- 오른쪽 잎 -->
  <path d="M140 92 C150 74 150 50 134 36 C126 50 120 72 118 92 Z" fill="${c.logoLeaf}" stroke="${c.logoLeafEdge}" stroke-width="1.2"/>
  <path d="M139 90 C146 76 146 58 136 46 C130 58 126 76 124 90 Z" fill="url(#kimchi)" opacity=".92"/>
  <path d="M134 36 C140 30 144 22 140 14 C137 20 133 18 131 24 C128 20 124 25 126 31 C128 36 130 38 134 36 Z" fill="${c.logoGreen}"/>
  <!-- 가운데 잎: 가장 크고 앞에 온다 -->
  <path d="M74 94 C66 66 76 32 100 18 C124 32 134 66 126 94 Z" fill="${c.logoLeaf}" stroke="${c.logoLeafEdge}" stroke-width="1.4"/>
  <path d="M77 92 C72 70 78 44 96 30 C88 50 88 74 94 92 Z M106 92 C112 74 112 50 104 30 C122 44 128 70 123 92 Z" fill="url(#kimchi)" opacity=".95"/>
  <path d="M100 22 C96 44 96 70 100 94" stroke="${c.logoLeaf}" stroke-width="6" fill="none" stroke-linecap="round"/>
  <path d="M100 22 C96 44 96 70 100 94" stroke="${c.logoLeafEdge}" stroke-width="1" fill="none" opacity=".8"/>
  <path d="M100 18 C92 12 90 2 96 -4 C98 2 102 0 103 6 C106 0 112 2 110 10 C114 8 118 14 112 20 C108 24 104 22 100 18 Z" fill="${c.logoGreen}"/>
  <path d="M100 16 C101 10 103 6 105 2" stroke="${c.logoGreenDark}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
</g>
${flakes}
</svg>
`;
}

// ─── 3. 구조: 항상 켜진 층과 필요할 때 여는 층 ────────────────────────────────
function layers(c) {
  const W = 1040, H = 420;
  const box = (x, y, w, h, fill, stroke) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}"/>`;
  const node = (x, y, w, title, sub, tone) =>
    box(x, y, w, 58, c.card, tone) +
    `<text x="${x + 16}" y="${y + 25}" class="mono" font-size="13.5" font-weight="700" fill="${c.text}">${esc(title)}</text>` +
    `<text x="${x + 16}" y="${y + 45}" class="sans" font-size="12.5" fill="${c.muted}">${esc(sub)}</text>`;
  const arrow = (x1, y1, x2, y2, tone) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${tone}" stroke-width="2" stroke-dasharray="6 5" class="flow"/>` +
    `<path d="M${x2 - 7} ${y2 - 5} L${x2} ${y2} L${x2 - 7} ${y2 + 5}" stroke="${tone}" stroke-width="2" fill="none"/>`;

  const skills = ["korean-encoding", "korean-datetime", "korean-identifiers", "korean-formats", "natural-korean-writing"];
  const skillSub = ["CP949 · BOM · NFC/NFD · 초성", "공휴일 · 음력 · KST · 만 나이", "주민번호 · 사업자번호 · 마스킹", "주소 · 전화번호 · 이름", "규칙표 전체 · 글 검토"];

  let s = "";
  // 왼쪽 층
  s += box(24, 24, 640, 372, c.redBg, c.red);
  s += `<text x="46" y="58" class="sans" font-size="17" font-weight="800" fill="${c.red}">항상 켜짐 — 말투</text>`;
  s += `<text x="46" y="80" class="sans" font-size="13" fill="${c.text}">매 문장에 적용돼야 해서 모델 판단에 맡기지 않습니다</text>`;
  s += node(46, 104, 180, "rules/*.md", "사람이 읽는 규칙표", c.cardBorder);
  s += arrow(226, 133, 256, 133, c.red);
  s += node(258, 104, 170, "build-style.mjs", "순위대로 상한까지", c.cardBorder);
  s += arrow(428, 133, 458, 133, c.red);
  s += node(460, 104, 186, "natural-korean.md", "생성된 출력 스타일", c.red);
  s += arrow(553, 162, 553, 196, c.red);
  s += box(400, 198, 246, 64, c.card, c.red) +
    `<text x="523" y="225" text-anchor="middle" class="sans" font-size="14.5" font-weight="800" fill="${c.red}">시스템 프롬프트</text>` +
    `<text x="523" y="246" text-anchor="middle" class="mono" font-size="12" fill="${c.muted}">force-for-plugin · 압축돼도 남는다</text>`;
  s += node(46, 198, 330, "hooks/guard.mjs", "모든 Bash·Write·Edit 호출 · 약 80ms", c.cardBorder);
  const pills = [["주민등록번호 → 차단", c.red, c.card], ["말투 → 경고", c.amber, c.card], ["코드 · 식별자 → 손대지 않음", c.muted, c.card]];
  let px = 46;
  pills.forEach(([label, tone]) => {
    const w = width(label, 13) + 28;
    s += `<rect x="${px}" y="284" width="${w}" height="28" rx="14" fill="${c.card}" stroke="${tone}"/>` +
      `<text x="${px + w / 2}" y="303" text-anchor="middle" class="sans" font-size="13" font-weight="700" fill="${tone}">${esc(label)}</text>`;
    px += w + 10;
  });
  s += node(46, 326, 330, "hooks/session-language.mjs", "이력이 분명히 영어일 때만 한 번 안내", c.cardBorder);
  s += `<text x="400" y="352" class="sans" font-size="12.5" fill="${c.muted}">의존성 0 · LLM 호출 0</text>`;
  s += `<text x="400" y="372" class="sans" font-size="12.5" fill="${c.muted}">실패하면 조용히 비켜납니다</text>`;

  // 오른쪽 층
  s += box(684, 24, 332, 372, c.greenBg, c.green);
  s += `<text x="706" y="58" class="sans" font-size="17" font-weight="800" fill="${c.green}">필요할 때 — 지식</text>`;
  s += `<text x="706" y="80" class="sans" font-size="13" fill="${c.text}">그 일을 할 때만 열립니다 · 동작하는 코드 포함</text>`;
  skills.forEach((name, i) => {
    const y = 100 + i * 57;
    s += box(706, y, 288, 48, c.card, c.cardBorder) +
      `<circle cx="724" cy="${y + 24}" r="5" fill="${c.green}" class="pulse" style="animation-delay:${i * 0.4}s"/>` +
      `<text x="738" y="${y + 21}" class="mono" font-size="13" font-weight="700" fill="${c.text}">${name}</text>` +
      `<text x="738" y="${y + 39}" class="sans" font-size="12" fill="${c.muted}">${esc(skillSub[i])}</text>`;
  });
  return svg(W, H, "플러그인의 두 층입니다. 왼쪽 말투 층은 규칙표로 출력 스타일을 만들어 시스템 프롬프트에 넣고, 훅이 산출물을 검사합니다. 오른쪽은 필요할 때만 여는 한국 개발 지식 스킬 다섯 개입니다", c,
    `@keyframes dash{to{stroke-dashoffset:-22}}.flow{animation:dash 1.1s linear infinite}` +
    `@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}.pulse{animation:pulse 2s ease-in-out infinite}`,
    s);
}

function svg(w, h, label, c, css, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
<style>.mono{font-family:${MONO}}.sans{font-family:${SANS}}text{white-space:pre}${css}${REDUCED}</style>
${body}
</svg>
`;
}

/** 그릴 파일 이름 → 내용. */
export function renderAll() {
  const { rules } = loadRules(join(ROOT, "rules"));
  const data = {
    without: score(readFixture(EXCERPTS.without.fixture), rules),
    with: score(readFixture(EXCERPTS.with.fixture), rules),
    hook: hookMessages(rules),
  };
  const files = {};
  for (const [name, draw] of Object.entries({ logo, hero, guard, layers })) {
    for (const [theme, colors] of Object.entries(THEMES)) {
      files[`${name}-${theme}.svg`] = draw(colors, data);
    }
  }
  return files;
}

function main() {
  const check = process.argv.includes("--check");
  const files = renderAll();
  const stale = Object.keys(files).filter((name) => {
    const path = join(OUT, name);
    return !existsSync(path) || readFileSync(path, "utf8") !== files[name];
  });

  if (check) {
    if (stale.length > 0) {
      console.error(`README 그림이 낡았습니다: ${stale.join(", ")}\nnpm run art 로 다시 만드십시오.`);
      process.exit(1);
    }
    return;
  }
  mkdirSync(OUT, { recursive: true });
  for (const name of stale) writeFileSync(join(OUT, name), files[name], "utf8");
  console.log(stale.length > 0 ? `다시 쓴 그림: ${stale.join(", ")}` : "그림이 이미 최신입니다.");
}

if (isEntrypoint(import.meta.url)) main();
