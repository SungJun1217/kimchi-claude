#!/usr/bin/env node
// README·설계 문서·기여 안내·보안 정책을 GitHub Pages 와 위키로 퍼블리시할 때
// 상대 링크를 대상별로 고쳐 쓴다.
//
// 위키는 저장소 파일을 못 보므로(별도 저장소, `<repo>.wiki.git`) 이미지는 raw URL로,
// 스테이징하지 않는 문서(AGENTS.md 등)는 blob URL로 바꿔야 한다. Pages 도 스테이징
// 디렉터리에 없는 문서를 링크할 때는 같은 문제가 생긴다 — 두 대상 모두 손대지 않으면
// 퍼블리시된 페이지에 죽은 링크가 남는다. 코드 스팬·펜스 안의 문자열은 예시이지
// 실제 링크가 아니므로 건드리지 않는다(불변식 4 — 코드는 검사·재작성 대상이 아니다).
//
// 사용법:
//   node scripts/publish-docs.mjs --mode pages --repo owner/name --ref v0.17.0 --out <디렉터리>
//   node scripts/publish-docs.mjs --mode wiki  --repo owner/name --ref v0.17.0 --out <디렉터리>

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "../hooks/lib/entrypoint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const MODE_PAGES = "pages";
export const MODE_WIKI = "wiki";

// 스테이징 디렉터리에 실제로 올라가는 문서. 이 목록에 없는 상대 경로는 두 대상
// 모두에서 저장소 원본으로 되돌아가는 절대 URL로 바뀐다.
const STAGED_DOCS = {
  "README.md": { pagesPath: "index.md", wikiPage: "Home" },
  "docs/design.md": { pagesPath: "docs/design.md", wikiPage: "설계-문서" },
  "CONTRIBUTING.md": { pagesPath: "CONTRIBUTING.md", wikiPage: "기여-안내" },
  "SECURITY.md": { pagesPath: "SECURITY.md", wikiPage: "보안" },
};

const HEADER_SOURCE = {
  Home: "README.md",
  "설계-문서": "docs/design.md",
  "기여-안내": "CONTRIBUTING.md",
  보안: "SECURITY.md",
};

const WIKI_HEADER = (path) =>
  `이 페이지는 저장소의 ${path}에서 자동으로 만듭니다. 고치려면 저장소에 PR을 보내 주세요.\n\n`;

/** 상대 경로를 "경로"와 "#앵커"로 나눈다. 앵커만 있으면 경로는 빈 문자열이다. */
function splitAnchor(target) {
  const hash = target.indexOf("#");
  if (hash === -1) return { path: target, anchor: "" };
  return { path: target.slice(0, hash), anchor: target.slice(hash) };
}

function isAbsolute(target) {
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target) || target.startsWith("#");
}

/** 저장소 상대 경로 하나를 mode 에 맞는 링크 대상으로 바꾼다. */
function resolvePath(target, { mode, repo, ref }) {
  if (target === "" || isAbsolute(target)) return target;

  const { path, anchor } = splitAnchor(target);
  if (path === "") return target; // 같은 문서 안 앵커

  const normalized = path.replace(/^\.\//, "");

  if (normalized.startsWith("assets/")) {
    if (mode === MODE_WIKI) {
      return `https://raw.githubusercontent.com/${repo}/${ref}/${normalized}${anchor}`;
    }
    return target; // pages 는 assets/ 를 그대로 스테이징하므로 상대 경로가 유효하다
  }

  const staged = STAGED_DOCS[normalized];
  if (staged) {
    if (mode === MODE_WIKI) return `${staged.wikiPage}${anchor}`;
    return `${staged.pagesPath.replace(/\.md$/, ".html")}${anchor}`;
  }

  // 스테이징하지 않는 저장소 파일(AGENTS.md, .github/ISSUE_TEMPLATE/*, evals/README.md 등).
  return `https://github.com/${repo}/blob/${ref}/${normalized}${anchor}`;
}

// 마크다운 링크 `[글](대상)` 과 이미지/소스 태그의 `src="…"`, `srcset="…"` 를 잡는다.
// 셋 다 "괄호나 따옴표 안의 경로"라는 같은 모양이라 링크 대상만 골라 바꿔치기한다.
const LINK_PATTERN = /(\[[^\]]*\]\()([^)\s]+)(\))/g;
const ATTR_PATTERN = /((?:src|srcset)=")([^"]+)(")/g;

function rewritePlain(text, opts) {
  return text
    .replace(LINK_PATTERN, (all, open, target, close) => `${open}${resolvePath(target, opts)}${close}`)
    .replace(ATTR_PATTERN, (all, open, target, close) => `${open}${resolvePath(target, opts)}${close}`);
}

// 펜스(```)와 인라인 코드 스팬(`…`) 은 예시 문자열이지 실제 링크가 아니므로 그대로 둔다.
// 예: docs/design.md 의 "`[안내](url)`" 는 마크다운 링크 문법을 설명하는 예시일 뿐이다.
const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]+`)/;

/**
 * 마크다운 문서의 상대 링크를 mode 에 맞춰 고쳐 쓴다. 코드 펜스·인라인 코드는 손대지 않는다.
 * @param {string} markdown
 * @param {{ mode: "pages"|"wiki", repo: string, ref: string }} opts
 */
export function rewriteLinks(markdown, opts) {
  return markdown
    .split(CODE_SEGMENT)
    .map((segment, i) => (i % 2 === 1 ? segment : rewritePlain(segment, opts)))
    .join("");
}

function stageAssets(outDir) {
  const assetsOut = join(outDir, "assets");
  mkdirSync(assetsOut, { recursive: true });
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const names = [...new Set([...readme.matchAll(/assets\/([\w.-]+)/g)].map((hit) => hit[1]))];
  for (const name of names) {
    copyFileSync(join(ROOT, "assets", name), join(assetsOut, name));
  }
}

const CONFIG_YML = `title: kimchi-claude
description: 한국어로 물으면 한국 개발자가 실제로 쓰는 말투로 답하는 클로드 코드 플러그인
lang: ko
theme: minima
`;

// jekyll-optional-front-matter 는 파일이 마크다운 제목으로 시작할 때만 front matter
// 없이도 처리해 준다 — README.md 는 첫 줄이 `<div align="center">` 라 이 휴리스틱을
// 못 만족할 수 있다. 플러그인 동작에 기대지 않고 앞머리를 직접 붙여 항상 .html로 빌드되게 한다.
const PAGE_TITLE = {
  "README.md": "kimchi-claude",
  "docs/design.md": "설계 문서",
  "CONTRIBUTING.md": "기여하기",
  "SECURITY.md": "보안 정책",
};

function buildPages({ repo, ref, out }) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "_config.yml"), CONFIG_YML);
  for (const [source, staged] of Object.entries(STAGED_DOCS)) {
    const text = readFileSync(join(ROOT, source), "utf8");
    const rewritten = rewriteLinks(text, { mode: MODE_PAGES, repo, ref });
    const frontMatter = `---\ntitle: "${PAGE_TITLE[source]}"\n---\n\n`;
    const destPath = join(out, staged.pagesPath);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, frontMatter + rewritten);
  }
  stageAssets(out);
}

function buildWiki({ repo, ref, out }) {
  mkdirSync(out, { recursive: true });
  const pages = [];
  for (const [source, staged] of Object.entries(STAGED_DOCS)) {
    const text = readFileSync(join(ROOT, source), "utf8");
    const rewritten = rewriteLinks(text, { mode: MODE_WIKI, repo, ref });
    const withHeader = WIKI_HEADER(HEADER_SOURCE[staged.wikiPage]) + rewritten;
    writeFileSync(join(out, `${staged.wikiPage}.md`), withHeader);
    pages.push(staged.wikiPage);
  }
  const sidebar = pages.map((name) => `- [[${name}]]`).join("\n") + "\n";
  writeFileSync(join(out, "_Sidebar.md"), sidebar);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function main() {
  const { mode, repo, ref, out } = parseArgs(process.argv.slice(2));
  if (!mode || !repo || !ref || !out) {
    console.error("사용법: node scripts/publish-docs.mjs --mode pages|wiki --repo owner/name --ref v0.0.0 --out <디렉터리>");
    process.exit(2);
  }
  if (mode === MODE_PAGES) buildPages({ repo, ref, out });
  else if (mode === MODE_WIKI) buildWiki({ repo, ref, out });
  else {
    console.error(`알 수 없는 mode: ${mode}`);
    process.exit(2);
  }
  console.log(`${mode} 문서를 ${out} 에 썼습니다.`);
}

if (isEntrypoint(import.meta.url)) main();
