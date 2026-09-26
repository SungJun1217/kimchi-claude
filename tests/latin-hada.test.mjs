// "push합니다"처럼 로마자 동사에 하다를 붙인 표현을 찾는지 검사한다.
//
// rules/*.md 표로 표현할 수 없는 패턴이라 latin-hada.mjs 를 따로 두었다 — 이 파일
// 상단의 설명을 보라. lint()에 얹었으므로 여기서는 lint() 를 통해 검사한다(실제로
// guard.mjs 가 부르는 경로와 같다).

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lint, applyFixes } from "../hooks/lib/lint.mjs";
import { findLatinVerbHada, LATIN_HADA_RULE } from "../hooks/lib/latin-hada.mjs";
import { loadRules, CHECK_REGEX } from "../hooks/lib/rules.mjs";
import { fastestMs } from "./helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { rules: tableRules } = loadRules(join(ROOT, "rules"));
// lint()는 더 이상 이 검사를 하드코딩하지 않는다 — rules 배열에 이 규칙 객체가 실려
// 있어야 검사된다(rules.mjs의 loadRules()가 훅에는 builtins로 얹어 준다). 이 시험은
// lint() 자체를 부르므로 직접 포함한다.
const BUILTIN_RULES = [LATIN_HADA_RULE];
// 규칙표와 함께 겹침을 시험할 때는 훅이 실제로 보는 전체 집합과 같은 모양으로 맞춘다.
const rules = [...tableRules, LATIN_HADA_RULE];

test("push합니다를 찾아 푸시합니다를 제안한다", () => {
  const findings = lint("이제 push합니다.", BUILTIN_RULES);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].matched, "push합니다");
  assert.equal(findings[0].good, "푸시합니다");
  assert.equal(findings[0].check, CHECK_REGEX);
});

test("deploy한을 찾아 배포한을 제안한다", () => {
  const findings = lint("어제 deploy한 버전입니다.", BUILTIN_RULES);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].matched, "deploy한");
  assert.equal(findings[0].good, "배포한");
});

test("언어 키워드·전역 API 이름과 헷갈리는 동사는 목록에서 뺐다", () => {
  // "한 모듈이 상대에게서 import하는 심볼 수" — 실제 관찰된 문장이지만 import는
  // import 구문 자체를 가리키는 말이지 표기 위반이 아니다(불변식 5). return·delete는
  // 예약어, fetch·load·render는 그 자체로 흔히 참조되는 전역 API·생명주기 메서드 이름이라
  // 같은 이유로 뺐다. latin-hada.mjs 의 VERBS 주석을 보라.
  const sentences = [
    "한 모듈이 상대에게서 import하는 심볼 수를 봅니다.",
    "정적 export하면 됩니다.",
    "이 함수가 undefined를 return하면 실패입니다.",
    "이 값을 delete하면 사라집니다.",
    "state를 fetch하면 됩니다.",
    "이미지를 load하면 됩니다.",
    "컴포넌트를 render하면 됩니다.",
  ];
  for (const text of sentences) assert.equal(lint(text, BUILTIN_RULES).length, 0, text);
});

test("체크박스와 헷갈리는 check, 정착 음차가 없는 pull도 목록에서 뺐다", () => {
  // check: "체크된 항목"의 체크는 표시라는 뜻이라 확인으로 바꾸면 뜻이 달라진다.
  // pull: "풀하다"라는 정착 음차 자체가 없다 — 개발자는 "pull 받아서"라고 쓴다.
  assert.equal(lint("체크된 항목만 배포합니다.", BUILTIN_RULES).length, 0);
  assert.equal(lint("이슈를 close하려고 check했습니다.", BUILTIN_RULES).length, 0);
  assert.equal(lint("최신 브랜치를 pull한 뒤 시작합니다.", BUILTIN_RULES).length, 0);
});

test("trigger는 트리거로, reset은 리셋으로 제안한다 (실행/초기화가 아니다)", () => {
  const trigger = lint("이벤트가 trigger되면 실행됩니다.", BUILTIN_RULES);
  assert.equal(trigger.length, 1);
  assert.equal(trigger[0].good, "트리거되면");

  const reset = lint("상태를 reset한 뒤 다시 시작합니다.", BUILTIN_RULES);
  assert.equal(reset.length, 1);
  assert.equal(reset[0].good, "리셋한");
});

test("대문자로 시작해도 잡는다", () => {
  const findings = lint("PR을 Call하고 기다립니다.", BUILTIN_RULES);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].matched, "Call하고");
  assert.equal(findings[0].good, "호출하고");
});

test("자동 교정 대상이 아니다 (정규식 검사만, 치환 금지)", () => {
  // applyFixes는 check === 치환인 발견만 거른다. CHECK_REGEX면 후보에도 못 들어가
  // 절대 자동으로 고쳐지지 않는다(불변식 5 — 어떤 하다 활용형이 자연스러운지는 문맥에 달렸다).
  const { text, applied } = applyFixes("이제 push합니다.", BUILTIN_RULES);
  assert.equal(text, "이제 push합니다.");
  assert.equal(applied.length, 0);
});

test("인라인 코드 안의 push합니다는 잡지 않는다", () => {
  assert.equal(lint("`push합니다`", BUILTIN_RULES).length, 0);
});

test("코드 블록 안의 deploy한은 잡지 않는다", () => {
  const text = ["```", "// deploy한 버전을 기록한다", "```"].join("\n");
  assert.equal(lint(text, BUILTIN_RULES).length, 0);
});

test("명사 자리에 조사가 붙은 경우는 잡지 않는다 (push를 실행합니다)", () => {
  assert.equal(lint("git push를 실행합니다.", BUILTIN_RULES).length, 0);
});

test("이미 정착한 음차 동사(머지합니다)는 잡지 않는다", () => {
  assert.equal(lint("PR을 머지합니다.", BUILTIN_RULES).length, 0);
});

test("영어 과거형(pushed)은 하다 활용형이 아니므로 잡지 않는다", () => {
  assert.equal(lint("이미 pushed 상태입니다.", BUILTIN_RULES).length, 0);
});

test("영어만 있는 문장은 잡지 않는다", () => {
  assert.equal(lint("We should push the fix and deploy it.", BUILTIN_RULES).length, 0);
});

test("URL 안의 동사는 잡지 않는다", () => {
  assert.equal(lint("https://example.com/api/push하면-이상함 을 참고하십시오.", BUILTIN_RULES).length, 0);
});

test("다른 낱말 속을 잘못 잘라내지 않는다 (rebuild합니다)", () => {
  // build는 목록에 있지만 rebuild합니다에서 왼쪽 경계(ASCII 문자 뒤)에 걸려 잡히지 않는다.
  assert.equal(lint("전체를 rebuild합니다.", BUILTIN_RULES).length, 0);
});

test("명령 이름·식별자·경로 구분자 뒤는 잡지 않는다", () => {
  // 왼쪽 경계 2단계: ①문자 바로 뒤(마침표·하이픈·콜론·슬래시 등) ②로마자 낱말 + 공백 뒤.
  const sentences = [
    "pre-commit하면 실행됩니다.",
    "re-run하면 됩니다.",
    "dry-run한 결과입니다.",
    "force-push하면 위험합니다.",
    "auto-merge된 PR입니다.",
    "fn.call하면 됩니다.",
    "obj.save할 때 주의하세요.",
    "npm:build할 수 있습니다.",
    "ci:test하면 됩니다.",
    "git push하면 됩니다.",
    "git pull해서 받았습니다.",
    "npm test하면 됩니다.",
    "cargo build하면 됩니다.",
    "Docker build하면 됩니다.",
    "npm run build한 결과입니다.",
    "unit test하는 코드입니다.",
    "smoke test한 결과입니다.",
    "load test하는 중입니다.",
    "@types/node install한 뒤에 씁니다.",
    // 백틱이나 경로가 가려진 자리(MASK) 뒤, Windows 경로의 역슬래시 뒤
    "`git` push하면 됩니다.",
    "src/app.ts build하면 됩니다.",
    "A/B test할 때 봅니다.",
    "C:\\build한 파일입니다.",
  ];
  for (const text of sentences) assert.equal(lint(text, BUILTIN_RULES, { ext: "md" }).length, 0, text);
});

test("윗줄 끝의 영어 낱말이 줄 첫머리 동사를 가리지 않는다", () => {
  const findings = lint("Run the build\npush하면 됩니다.", BUILTIN_RULES, { ext: "md" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].matched, "push하면");
});

test("한글이 로마자 동사에 곧바로 붙으면 잡지 않는다 (재commit해야)", () => {
  // latin-hada 자신의 왼쪽 경계에는 안 걸리지만(한글은 그 두 갈래 어디에도 없다),
  // segment.mjs가 "한글 + 로마자 소문자" 모양을 타겟Id류 혼합 식별자로 보고 통째로
  // 가린다("재commit"도 그 모양이다) — 그 앞단 보호 덕에 여기서도 안 잡힌다.
  assert.equal(lint("재commit해야 합니다.", BUILTIN_RULES).length, 0);
});

test("findLatinVerbHada는 masked 문자열 기준으로 위치를 돌려준다", () => {
  const masked = "이제 push합니다.";
  const findings = findLatinVerbHada(masked, masked);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].index, masked.indexOf("push합니다"));
  assert.equal(findings[0].length, "push합니다".length);
});

test("추가한 하다/되다 활용형도 잡는다 (trigger되면, commit됐습니다)", () => {
  const trigger = lint("이벤트가 trigger되면 실행됩니다.", BUILTIN_RULES);
  assert.equal(trigger.length, 1);
  assert.equal(trigger[0].matched, "trigger되면");

  const commit = lint("이미 commit됐습니다.", BUILTIN_RULES);
  assert.equal(commit.length, 1);
  assert.equal(commit[0].matched, "commit됐");
  assert.equal(commit[0].good, "커밋됐");
});

test("규칙별 보고 상한을 그대로 따른다 (같은 동사 3건까지만 보고)", () => {
  const text = Array(5).fill("push합니다.").join(" ");
  const findings = lint(text, BUILTIN_RULES);
  assert.equal(findings.length, 3);
});

test("지연 시간: 긴 문서에서도 빠르다", () => {
  // fastestMs: 다른 시험과 동시에 도는 동안은 한 번 잰 시간이 스케줄링에 흔들린다(실측).
  const text = "이 문장은 평범한 한국어 문장입니다. ".repeat(2000);
  const ms = fastestMs(() => lint(text, BUILTIN_RULES));
  // 공유 CI 러너는 로컬보다 느릴 수 있다. 72KB 입력에서 이차 비용으로 퇴화하면
  // 그래도 이 상한을 넘는다.
  assert.ok(ms < 1000, `긴 문서에서 지나치게 오래 걸렸다 (${ms}ms)`);
});

// 아래 네 문장은 실제로 배포됐던 결함을 막는다(0.16.0 리뷰 1차).
//
// latin-hada가 규칙과 같은 findings 배열 안에서 겹침을 다투면, "build할때"에서
// latin-hada가 잡은 "build할"(6자)이 치환 규칙 "할때"→"할 때"(2자)보다 길다는 이유로
// resolveOverlaps가 그 규칙을 밀어냈다 — 지적만 사라지는 게 아니라 applyFixes가
// lint()의 결과를 그대로 후보로 쓰므로 원래 되던 자동 교정까지 함께 사라졌다.
// latin-hada는 절대 자동 교정하지 않으므로(check가 늘 정규식이다) 규칙과 겹쳐도
// 서로 밀어낼 이유가 없다 — 규칙 쪽 치환은 그대로 적용되고, latin-hada 경고도 함께 보인다.
test("latin-hada와 겹쳐도 기존 치환 규칙이 계속 적용된다 (할때→할 때)", () => {
  const findings = lint("build할때 확인합니다.", rules);
  assert.ok(findings.some((f) => f.matched === "build할"), "latin-hada 발견이 사라졌다");
  assert.ok(findings.some((f) => f.matched === "할때"), "치환 규칙 발견이 사라졌다");

  const { text, applied } = applyFixes("build할때 확인합니다.", rules);
  assert.equal(text, "build할 때 확인합니다.");
  assert.ok(applied.some((a) => a.matched === "할때"), "할때→할 때 자동 교정이 사라졌다");
});

test("latin-hada와 겹쳐도 기존 치환 규칙이 계속 적용된다 (해야합니다→해야 합니다)", () => {
  const { text, applied } = applyFixes("test해야합니다.", rules);
  assert.equal(text, "test해야 합니다.");
  assert.ok(applied.some((a) => a.matched === "해야합니다"));
});

test("latin-hada와 겹쳐도 기존 치환 규칙이 계속 적용된다 (하는것→하는 것)", () => {
  const { text, applied } = applyFixes("commit하는것이 좋습니다.", rules);
  assert.equal(text, "commit하는 것이 좋습니다.");
  assert.ok(applied.some((a) => a.matched === "하는것"));
});

test("latin-hada와 겹쳐도 기존 치환 규칙이 계속 적용된다 (할께요→할게요)", () => {
  const { text, applied } = applyFixes("fix할께요.", rules);
  assert.equal(text, "fix할게요.");
  assert.ok(applied.some((a) => a.matched === "할께요"));
});

test("겹침을 규칙과 나눠도 rebuild/retest/recommit/hotfix 같은 진짜 다른 낱말은 여전히 고쳐진다", () => {
  // 왼쪽 경계에 걸려 latin-hada 자체는 안 잡히지만(rebuild는 다른 낱말), 겹쳐 있던
  // 치환 규칙은 그대로 살아 있어야 한다 — latin-hada를 뒤에 이어 붙이는 변경이
  // 이 경로에 영향을 주면 안 된다.
  assert.equal(applyFixes("rebuild할때 확인합니다.", rules).text, "rebuild할 때 확인합니다.");
  assert.equal(applyFixes("retest해야합니다.", rules).text, "retest해야 합니다.");
  assert.equal(applyFixes("recommit하는것이 좋습니다.", rules).text, "recommit하는 것이 좋습니다.");
  assert.equal(applyFixes("hotfix할께요.", rules).text, "hotfix할게요.");
});
