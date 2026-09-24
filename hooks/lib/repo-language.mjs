// 이 저장소가 산출물을 어느 언어로 쓰는지 추론한다.
//
// 설정 파일을 만들라고 하지 않는다. 아무도 만들지 않을 것이고, 저장소가 이미 답을
// 갖고 있다. 커밋 이력과 문서를 보면 이 팀이 영어로 쓰는지 한국어로 쓰는지 알 수 있다.
//
// 쓸 자리는 하나다. 오픈소스에 기여하는 한국 개발자가 대화는 한국어로 하면서 커밋 메시지는
// 영어로 써야 하는 경우. 지금은 플러그인이 그걸 모르고 한국어 커밋을 권한다.

import { execFileSync } from "node:child_process";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { countHangul } from "./detect.mjs";

// 표본을 이 개수만큼 본다. 더 보면 오래된 관행까지 섞인다.
const COMMIT_SAMPLE = 40;

// 판정 문턱. 양쪽을 다 보수적으로 잡는다.
//
// 오류의 값이 비대칭이다. "아무 말도 하지 않는" 실수는 값이 싸지만, "영어로 쓰라고 잘못
// 지시하는" 실수는 팀 관행을 거스르게 만든다. 그래서 강한 증거가 있을 때만 단정한다.
const KOREAN_RATIO = 0.6;
const ENGLISH_RATIO = 0.1;

// 이보다 적은 표본으로는 판정하지 않는다. 커밋 두 개로 저장소 관행을 단정할 수 없다.
// 언어 신호가 없는 표본(이모지, 버전, 봇 커밋)을 뺀 뒤의 개수에 적용한다.
const MIN_SAMPLES = 3;

// 문서는 표본이 하나(파일 하나)라 개수로 셀 수 없다. 대신 분량을 본다.
// 한글·로마자 글자 수가 이보다 적으면 근거가 못 된다.
//
// 한국어는 글자당 정보량이 많아 같은 내용이 영어보다 짧다. 문턱을 높게 잡으면
// 한국어 문서만 판정에서 빠지므로 낮게 둔다.
const MIN_DOC_CHARS = 120;

// README 읽기 상한. FIFO 나 소켓처럼 끝나지 않는 스트림을 만나면 크기를 몰라도
// 여기서 멈춘다. 실제 README 는 이보다 훨씬 작다.
const MAX_README_BYTES = 256 * 1024;

// 언어 판정에 실제로 쓰는 분량 상한. 읽기 상한(256KB)과 별개다 — 정규식으로 마크업을
// 지우는 비용은 입력 길이에 좌우되므로, 판정에는 앞부분 32KB만 쓴다. README 서두에
// 언어가 이미 드러나므로 뒷부분을 안 봐도 판정이 달라지지 않는다.
const MAX_ANALYSIS_CHARS = 32 * 1024;

/**
 * 명령을 돌리고 실패하면 null 을 준다.
 *
 * 훅에서 부르므로 어떤 이유로든 멈춰서는 안 된다. git 이 없거나 저장소가 아니거나
 * 커밋이 하나도 없는 경우가 모두 정상이다.
 *
 * i18n.logOutputEncoding 을 강제로 UTF-8 로 고정한다. 저장소나 전역 설정이 이 값을
 * cp949 같은 것으로 바꿔 두면 git 이 커밋 메시지를 그 인코딩으로 다시 써서 내보내고,
 * 우리는 그것을 utf8 로 읽어 한글이 깨진 것처럼 보인다 — 실제로는 영어가 아니라
 * 인코딩이 어긋난 것인데 영어로 오판하게 된다.
 */
function run(args, cwd) {
  try {
    return execFileSync(
      "git",
      ["-c", "i18n.logOutputEncoding=UTF-8", "-c", "core.quotepath=false", ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  } catch {
    return null;
  }
}

/** 저장소 최상위 디렉터리. README 는 cwd 가 아니라 여기서 찾는다 — 벤더 받은 하위
 * 디렉터리(예: packages/x)의 영어 README 때문에 전체 저장소를 영어로 오판하지 않도록. */
function repoTopLevel(cwd) {
  const out = run(["rev-parse", "--show-toplevel"], cwd);
  if (out === null) return cwd;
  const top = out.trim();
  return top || cwd;
}

// 봇·머지 커밋 제목. 팀의 언어 관행과 무관하게 도구나 웹 UI 가 기계적으로 만든 글이다.
//
// "merge" 로 시작하는 제목은 폭넓게 잡는다 — pull request, branch, remote-tracking
// branch, tag, commit, 그리고 이 저장소 자신이 쓰는 git-flow 식 "merge: feature/x" 까지
// 전부 병합 도구가 자동으로 붙인 글이지 팀이 고른 말투가 아니다.
const BOT_SUBJECT_PATTERNS = [
  /^merge\b/i,
  /^revert\b/i,
  /^initial commit$/i,
  // GitHub 웹 편집기가 커밋할 때 붙이는 기본 메시지: "Update README.md" 같은 것.
  /^(update|create|delete)\s+\S+\.\w+$/i,
  // dependabot/renovate. conventional commit 접두어(chore(deps): 등)가 붙기도 한다.
  /^(?:\w+(?:\([^)]*\))?!?:\s*)?bump\s+\S.*\s+from\s+\S.*\s+to\s+\S/i,
  /^(?:\w+(?:\([^)]*\))?!?:\s*)?update dependency\s/i,
  /^(?:\w+(?:\([^)]*\))?!?:\s*)?update module\s/i,
];

function isBotOrMergeSubject(text) {
  return BOT_SUBJECT_PATTERNS.some((pattern) => pattern.test(text));
}

/** 인코딩이 깨진 표본. U+FFFD(치환 문자)나 NUL 이 보이면 디코딩이 실패한 것이다. */
function isUndecodable(text) {
  return /[�\u0000]/.test(text);
}

/**
 * 표본에 언어를 판정할 만한 내용이 있는지 본다.
 *
 * 이모지 하나(🎉), 버전 번호(0.1.3)처럼 한글도 로마자도 없는 표본은 어느 쪽 증거도
 * 아니다. 그런데 지금까지는 "한국어가 아니다"로 세어져 영어 쪽 증거로 잘못 쌓였다.
 */
function hasLanguageContent(text) {
  const hangul = countHangul(text);
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return hangul > 0 || latin >= 3;
}

/**
 * 표본 하나를 한국어로 볼지 정한다.
 *
 * 한글이 두 자 이상이면 한국어로 본다. 한 자뿐일 때는 로마자가 거의 없을 때만
 * 한국어로 본다 — "Rename 한.txt"처럼 영어 커밋에 한글 파일명 하나가 섞인 경우와,
 * "값 3"처럼 표본 전체가 짧은 한국어 단어인 경우를 로마자 유무로 가른다. 앞의 예는
 * 로마자가 많아 한국어로 보지 않고, 뒤의 예는 로마자가 없어 한국어로 본다.
 */
function isKoreanSubject(text) {
  const hangul = countHangul(text);
  if (hangul >= 2) return true;
  if (hangul === 0) return false;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return latin < 3;
}

/** 판정에 쓸 표본만 남긴다. 언어 신호가 없거나 인코딩이 깨졌거나 봇이 쓴 것은 뺀다. */
function filterMeaningfulSubjects(samples) {
  return samples
    .filter((sample) => sample.trim().length > 0)
    .filter((sample) => !isUndecodable(sample))
    .filter((sample) => !isBotOrMergeSubject(sample))
    .filter((sample) => hasLanguageContent(sample));
}

/**
 * 표본 가운데 한글이 든 것의 비율을 센다.
 *
 * 글자 수 비율이 아니라 **표본 개수** 비율을 쓴다. 커밋 하나가 유난히 길어도
 * 판정이 흔들리지 않아야 한다.
 *
 * @param {string[]} samples
 * @returns {number|null} 판정에 쓸 표본이 없으면 null
 */
export function koreanShare(samples) {
  const meaningful = filterMeaningfulSubjects(samples);
  if (meaningful.length === 0) return null;
  return meaningful.filter(isKoreanSubject).length / meaningful.length;
}

/**
 * 비율을 언어 판정으로 바꾼다.
 *
 * 가운데 구간은 `혼용` 이다. 섞여 있으면 개입하지 않는다. 잘못 밀어붙이면
 * 팀 관행을 거스르게 된다.
 *
 * @param {number|null} share
 * @param {number} [count] 표본 개수. 적으면 판정하지 않는다
 * @returns {"한국어"|"영어"|"혼용"|"알 수 없음"}
 */
export function classify(share, count = Infinity) {
  if (share === null) return "알 수 없음";
  if (count < MIN_SAMPLES) return "알 수 없음";
  if (share >= KOREAN_RATIO) return "한국어";
  if (share <= ENGLISH_RATIO) return "영어";
  return "혼용";
}

/**
 * 커밋 메시지 제목의 언어를 판정한다.
 * @param {string} cwd
 * @returns {"한국어"|"영어"|"혼용"|"알 수 없음"}
 */
export function commitLanguage(cwd) {
  const log = run(["log", `-${COMMIT_SAMPLE}`, "--format=%s"], cwd);
  if (log === null) return "알 수 없음";
  const subjects = log.split("\n").filter((line) => line.trim().length > 0);
  const meaningful = filterMeaningfulSubjects(subjects);
  return classify(koreanShare(subjects), meaningful.length);
}

// 저장소의 얼굴이 되는 문서들. 있는 것만 본다.
const DOC_CANDIDATES = ["README.md", "README.rst", "CONTRIBUTING.md", "docs/README.md"];

/**
 * 잘린 지점이 다중 바이트 UTF-8 시퀀스 한가운데면 그 시퀀스 전체를 잘라 낸다.
 *
 * 읽기 상한에 걸려 파일 중간에서 잘랐을 때, 하필 한글 한 글자의 바이트 사이에서
 * 잘리면 그 바이트는 단독으로 유효한 UTF-8 이 아니라 디코딩 시 U+FFFD 가 된다.
 * 그러면 "인코딩을 신뢰할 수 없다"는 신호와 구별이 안 돼 멀쩡한 긴 한국어 README 가
 * 잘리는 위치에 따라 알 수 없음으로 오판된다.
 */
function trimIncompleteUtf8(buf) {
  const n = buf.length;
  if (n === 0) return buf;

  let i = n - 1;
  let back = 0;
  // 이어짐 바이트(10xxxxxx)를 거슬러 올라간다. 시퀀스는 최대 4바이트다.
  while (i >= 0 && back < 3 && (buf[i] & 0xc0) === 0x80) {
    i -= 1;
    back += 1;
  }
  if (i < 0) return buf; // 전부 이어짐 바이트뿐이면 판단할 리딩 바이트가 없다 — 그대로 둔다

  const lead = buf[i];
  let seqLen = 1;
  if ((lead & 0xe0) === 0xc0) seqLen = 2;
  else if ((lead & 0xf0) === 0xe0) seqLen = 3;
  else if ((lead & 0xf8) === 0xf0) seqLen = 4;
  else if (lead >= 0x80) return buf; // 이어짐 바이트가 리딩 바이트 자리에 있으면 이미 깨진 것 — 그대로 둔다

  const have = n - i;
  return have < seqLen ? buf.subarray(0, i) : buf;
}

/**
 * 일반 파일만, 크기를 제한해서 읽는다.
 *
 * FIFO 나 소켓처럼 stat 이 끝나도 읽기가 끝나지 않는 대상이 있다. isFile() 로 그런
 * 것들을 미리 거르고, 정상 파일도 앞부분만 읽어 크기와 무관하게 시간을 예측 가능하게 한다.
 *
 * @returns {Buffer|null}
 */
function readRegularFileBounded(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size === 0) return Buffer.alloc(0);

  let fd;
  try {
    fd = openSync(path, "r");
    const len = Math.min(stat.size, MAX_README_BYTES);
    const buf = Buffer.alloc(len);
    const bytesRead = readSync(fd, buf, 0, len, 0);
    const slice = buf.subarray(0, bytesRead);
    // 실제로 잘라 읽었을 때만 경계를 다듬는다. 파일을 통째로 읽었으면 자를 자리가 없다.
    return bytesRead < stat.size ? trimIncompleteUtf8(slice) : slice;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 무시. 이미 읽을 것은 읽었다.
      }
    }
  }
}

/**
 * 바이트를 UTF-8 로 읽는다.
 *
 * Node 는 깨진 바이트를 조용히 U+FFFD 로 바꿔치기한다. CP949 나 UTF-16 로 저장된
 * 문서, 임의 바이너리가 모두 이렇게 걸린다 — 그런 문서로는 언어를 판정할 수 없다.
 *
 * @returns {string|null} 디코딩을 신뢰할 수 없으면 null
 */
function decodeUtf8OrNull(buf) {
  if (buf.length === 0) return "";
  const text = buf.toString("utf8");
  return isUndecodable(text) ? null : text;
}

/**
 * 프로즈가 아닌 부분을 지운다. HTML 태그, 이미지·배지, 링크 주소, 맨 URL, 코드
 * 울타리(닫히지 않은 것 포함), 들여쓴 코드 블록, HTML 주석.
 *
 * 배지투성이 한국어 README 를 예로 들면: `![shield](url)` 같은 배지 문구는 거의
 * 로마자라서 지우지 않으면 한국어 문서가 영어로 오판된다.
 */
function stripMarkdownNoise(text) {
  let t = text.replace(/\r\n/g, "\n");

  // HTML 주석은 어느 언어로 썼든 프로즈가 아니다.
  t = t.replace(/<!--[\s\S]*?-->/g, " ");

  // 닫히지 않은 울타리는 그 뒤 전부를 코드로 본다. 닫힌 울타리를 지우기 전에
  // 먼저 봐야 짝이 안 맞는 것을 짝이 맞는 것처럼 착각하지 않는다.
  const fenceMarks = [...t.matchAll(/^(```|~~~)/gm)];
  if (fenceMarks.length % 2 === 1) {
    t = t.slice(0, fenceMarks[fenceMarks.length - 1].index);
  }

  // 닫힌 코드 울타리와 인라인 코드.
  t = t.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
  t = t.replace(/`[^`\n]*`/g, " ");

  // 4칸 이상 들여쓴 줄 가운데 한글이 없는 줄만 들여쓰기 코드로 본다. 한글이 있으면
  // 중첩 목록이나 이어지는 설명일 가능성이 높다 — 실제 코드는 거의 항상 울타리
  // 안에 있으므로, 들여쓰기만으로 코드라고 단정하면 한국어 중첩 목록을 지워 버린다.
  t = t
    .split("\n")
    .map((line) => (/^(?: {4,}|\t)/.test(line) && countHangul(line) === 0 ? "" : line))
    .join("\n");

  // HTML 태그. 태그 하나의 길이를 제한해 "a<a<a<..." 같은 병적인 입력에서 닫는
  // 꺾쇠를 찾다가 매 위치마다 문서 끝까지 훑는 이차 시간을 막는다.
  t = t.replace(/<[^>\n]{0,300}>/g, " ");

  // 이미지·배지: 대체 텍스트도 프로즈가 아니다. 링크 주소는 버리고 글자만 남긴다.
  // 대괄호·괄호 안 길이를 제한하는 이유는 태그와 같다.
  t = t.replace(/!\[[^\]\n]{0,300}\]\([^)\n]{0,500}\)/g, " ");
  t = t.replace(/\[([^\]\n]{0,300})\]\([^)\n]{0,500}\)/g, "$1");
  t = t.replace(/https?:\/\/\S+/g, " ");

  return t;
}

/**
 * 글에서 한글이 차지하는 비율을 센다. 공백·코드·마크업은 뺀다.
 *
 * 커밋과 달리 문서는 표본이 하나다. 그래서 개수 비율 대신 글자 비율을 쓴다.
 * 짧은 한국어 한 줄이 긴 영어 문서에 섞여도 비율은 크게 움직이지 않는다 — 분량이
 * 반영되는 것이 맞다. 문단 개수로 셌다면 그 한 줄만으로도 혼용이 되었을 것이다.
 *
 * 비율은 전체 글자 수가 아니라 **한글·로마자 글자 수**를 분모로 쓴다. 기호나
 * 숫자, 표 문법(`|`) 같은 것은 어느 언어인지와 무관하다.
 *
 * @param {string} text
 * @returns {{share: number, dense: number, letters: number}}
 */
// 로마자 하나가 담는 정보량은 한글 음절 하나보다 훨씬 적다(한글은 자모 2~3개가
// 한 음절에 압축된 것이다). 기술 문서는 AWS, API, Docker 같은 로마자 낱말이 잔뜩
// 섞여도 산문 자체는 한국어인데, 로마자를 한글과 1대1로 세면 그런 문서가 영어
// 쪽으로 밀린다. 로마자를 2.5로 나눠 가중치를 낮춘다.
const LATIN_WEIGHT = 1 / 2.5;

export function hangulCharShare(text) {
  const prose = stripMarkdownNoise(text.slice(0, MAX_ANALYSIS_CHARS));
  const dense = prose.replace(/\s+/g, "").length;
  const hangul = countHangul(prose);
  const latin = (prose.match(/[A-Za-z]/g) || []).length;
  const rawLetters = hangul + latin; // 바이너리 판별에는 가중치를 걸지 않은 값을 쓴다
  const weighted = hangul + latin * LATIN_WEIGHT;
  return { share: weighted === 0 ? 0 : hangul / weighted, dense, letters: rawLetters };
}

/**
 * 문서의 언어를 판정한다.
 *
 * @param {string} cwd
 * @returns {"한국어"|"영어"|"혼용"|"알 수 없음"}
 */
export function docLanguage(cwd) {
  const root = repoTopLevel(cwd);
  for (const candidate of DOC_CANDIDATES) {
    const path = join(root, candidate);
    const buf = readRegularFileBounded(path);
    if (buf === null || buf.length === 0) continue;

    const text = decodeUtf8OrNull(buf);
    if (text === null) return "알 수 없음"; // 인코딩을 신뢰할 수 없으면 이 문서로 판정하지 않는다

    const { share, dense, letters } = hangulCharShare(text);
    if (dense < MIN_DOC_CHARS) continue;
    if (letters / dense < 0.2) return "알 수 없음"; // 대부분이 글자가 아니면 바이너리로 본다
    return classify(share, MIN_SAMPLES);
  }
  return "알 수 없음";
}

/**
 * 저장소의 산출물 언어를 정리해 돌려준다.
 *
 * @param {string} cwd
 * @returns {{commit: string, doc: string}}
 */
export function detectRepoLanguage(cwd) {
  return { commit: commitLanguage(cwd), doc: docLanguage(cwd) };
}

/**
 * 모델에게 알려 줄 문장을 만든다. 알려 줄 것이 없으면 빈 문자열.
 *
 * SessionStart 시점에는 사용자가 이번 세션에서 어느 언어로 말할지 알 수 없다.
 * 그래서 이 문장은 **조건문**으로 쓴다 — "사용자가 한국어로 쓰면" 이라고 전제를 걸고,
 * 그 안에서만 저장소 산출물의 언어를 알려 준다. 영어로 대화하는 세션에는 전제가
 * 성립하지 않으니 아무 지시도 아니다. (예전 버전은 "대화는 한국어로 하되"로 시작해서,
 * 영어로 쓰는 사용자에게도 무조건 한국어로 대화하라고 지시하는 것처럼 읽혔다.)
 *
 * @param {{commit: string, doc: string}} detected
 * @returns {string}
 */
export function describeRepoLanguage(detected) {
  const clauses = [];
  if (detected.commit === "영어") {
    clauses.push("write commit messages and PR descriptions in English, because this repository's commit history is in English");
  }
  if (detected.doc === "영어") {
    clauses.push("write README and other docs in English, because this repository's documentation is in English");
  }
  if (clauses.length === 0) return "";

  return [
    "## Repository output language",
    "",
    `If the user is writing in Korean: keep conversing in Korean, but ${clauses.join("; and ")}.`,
    "",
    "The user's explicit instruction always overrides this note.",
  ].join("\n");
}
