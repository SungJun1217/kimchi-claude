// 이 저장소가 산출물을 어느 언어로 쓰는지 추론한다.
//
// 설정 파일을 만들라고 하지 않는다. 아무도 만들지 않을 것이고, 저장소가 이미 답을
// 갖고 있다. 커밋 이력과 문서를 보면 이 팀이 영어로 쓰는지 한국어로 쓰는지 알 수 있다.
//
// 쓸 자리는 하나다. 오픈소스에 기여하는 한국 개발자가 대화는 한국어로 하면서 커밋 메시지는
// 영어로 써야 하는 경우. 지금은 플러그인이 그걸 모르고 한국어 커밋을 권한다.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
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
const MIN_SAMPLES = 3;

// 문서는 표본이 하나(파일 하나)라 개수로 셀 수 없다. 대신 분량을 본다.
// 공백을 뺀 글자가 이보다 적으면 근거가 못 된다.
//
// 한국어는 글자당 정보량이 많아 같은 내용이 영어보다 짧다. 문턱을 높게 잡으면
// 한국어 문서만 판정에서 빠지므로 낮게 둔다.
const MIN_DOC_CHARS = 120;

/**
 * 명령을 돌리고 실패하면 null 을 준다.
 *
 * 훅에서 부르므로 어떤 이유로든 멈춰서는 안 된다. git 이 없거나 저장소가 아니거나
 * 커밋이 하나도 없는 경우가 모두 정상이다.
 */
function run(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * 표본 가운데 한글이 든 것의 비율을 센다.
 *
 * 글자 수 비율이 아니라 **표본 개수** 비율을 쓴다. 커밋 하나가 유난히 길어도
 * 판정이 흔들리지 않아야 한다.
 *
 * @param {string[]} samples
 * @returns {number|null} 표본이 없으면 null
 */
export function koreanShare(samples) {
  const meaningful = samples.filter((sample) => sample.trim().length > 0);
  if (meaningful.length === 0) return null;
  return meaningful.filter((sample) => countHangul(sample) >= 2).length / meaningful.length;
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
  return classify(koreanShare(subjects), subjects.length);
}

// 저장소의 얼굴이 되는 문서들. 있는 것만 본다.
const DOC_CANDIDATES = ["README.md", "README.rst", "CONTRIBUTING.md", "docs/README.md"];

/**
 * 글에서 한글이 차지하는 비율을 센다. 공백과 코드 블록은 뺀다.
 *
 * 커밋과 달리 문서는 표본이 하나다. 그래서 개수 비율 대신 글자 비율을 쓴다.
 * 영어 문서에 한국어 문단이 하나 섞이면 비율이 가운데로 떨어져 혼용이 된다.
 *
 * @param {string} text
 * @returns {{share: number, dense: number}}
 */
export function hangulCharShare(text) {
  // 코드 블록은 어느 언어로 썼는지와 무관하다.
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const dense = prose.replace(/\s+/g, "").length;
  return { share: dense === 0 ? 0 : countHangul(prose) / dense, dense };
}

/**
 * 문서의 언어를 판정한다.
 *
 * @param {string} cwd
 * @returns {"한국어"|"영어"|"혼용"|"알 수 없음"}
 */
export function docLanguage(cwd) {
  for (const candidate of DOC_CANDIDATES) {
    const path = join(cwd, candidate);
    if (!existsSync(path)) continue;
    try {
      const { share, dense } = hangulCharShare(readFileSync(path, "utf8"));
      if (dense < MIN_DOC_CHARS) continue;
      return classify(share, MIN_SAMPLES);
    } catch {
      continue;
    }
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
 * 한국어로 쓰는 저장소에는 아무것도 말하지 않는다. 출력 스타일이 이미 그렇게 시킨다.
 * 영어로 쓰는 저장소일 때만 알려 준다. 그것이 새로운 사실이다.
 *
 * @param {{commit: string, doc: string}} detected
 * @returns {string}
 */
export function describeRepoLanguage(detected) {
  const lines = [];

  if (detected.commit === "영어") {
    lines.push("- 커밋 메시지와 PR 설명은 **영어로** 씁니다. 이 저장소의 이력이 영어입니다.");
  }
  if (detected.doc === "영어") {
    lines.push("- README 와 문서는 **영어로** 씁니다. 이 저장소의 문서가 영어입니다.");
  }
  if (lines.length === 0) return "";

  return [
    "## 이 저장소의 산출물 언어",
    "",
    "대화는 한국어로 하되, 저장소에 남는 글은 이 저장소의 관행을 따릅니다.",
    ...lines,
    "",
    "팀 관행을 거스르지 않는 것이 말투보다 앞섭니다. 사용자가 한국어로 쓰라고 하면 그 말을 따릅니다.",
  ].join("\n");
}
