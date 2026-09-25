import { test } from "node:test";
import assert from "node:assert/strict";
import { rule as base } from "./helpers.mjs";
import {
  applyFixes,
  hasFinalConsonant,
  isParticleSafe,
  primaryGood,
  autoFixReplacement,
  lint,
} from "../hooks/lib/lint.mjs";
import { particleHeads } from "../hooks/lib/particle.mjs";
import { loadRules } from "../hooks/lib/rules.mjs";

// 이 시험 묶음의 기본값만 여기서 정하고, 규칙 객체 모양은 helpers 가 갖는다.
const rule = (overrides = {}) => base({ bad: "리팩토링", good: "리팩터링", why: "외래어 표기법", priority: "보통", source: "register.md", ...overrides });

test("받침 유무를 판정한다", () => {
  assert.equal(hasFinalConsonant("계약"), true);
  assert.equal(hasFinalConsonant("결합도"), false);
  assert.equal(hasFinalConsonant("커밋"), true);
  assert.equal(hasFinalConsonant("머지"), false);
  // 끝이 한글이 아니면 판정할 수 없다
  assert.equal(hasFinalConsonant("deep module"), null);
  assert.equal(hasFinalConsonant(""), null);
  assert.equal(hasFinalConsonant(null), null);
  // 끝의 공백은 건너뛴다
  assert.equal(hasFinalConsonant("계약  "), true);
});

test("뒤에 조사가 없으면 언제나 안전하다", () => {
  assert.ok(isParticleSafe("얇은 계약", "낮은 결합도", " "));
  assert.ok(isParticleSafe("얇은 계약", "낮은 결합도", ""));
  assert.ok(isParticleSafe("얇은 계약", "낮은 결합도", "."));
});

test("받침이 달라지면 조사 앞에서 막는다", () => {
  // 계약(받침 있음) → 결합도(받침 없음). "결합도을"이 되면 안 된다.
  assert.ok(!isParticleSafe("얇은 계약", "낮은 결합도", "을"));
  assert.ok(!isParticleSafe("얇은 계약", "낮은 결합도", "이"));
});

test("받침이 같으면 조사 앞에서도 통과한다", () => {
  assert.ok(isParticleSafe("제출", "커밋", "을"));
  assert.ok(isParticleSafe("합치기", "머지", "를"));
});

test("한글로 끝나지 않으면 조사 앞에서 막는다", () => {
  assert.ok(!isParticleSafe("깊은 모듈", "deep module", "을"));
});

test("단순 치환을 적용한다", () => {
  const { text, applied } = applyFixes("리팩토링이 필요합니다.", [rule()]);
  assert.equal(text, "리팩터링이 필요합니다.");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].replacement, "리팩터링");
});

test("조사가 깨질 치환은 건너뛰고 이유를 남긴다", () => {
  const thin = rule({ bad: "얇은 계약", good: "낮은 결합도", check: "치환" });
  const { text, applied, skipped } = applyFixes("얇은 계약을 유지하세요.", [thin]);
  assert.equal(text, "얇은 계약을 유지하세요.", "조사가 깨지는데도 바꿨다");
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /조사/);
});

test("같은 규칙이라도 조사가 없는 자리는 바꾼다", () => {
  const thin = rule({ bad: "얇은 계약", good: "낮은 결합도" });
  const { text } = applyFixes("얇은 계약 이야기입니다.", [thin]);
  assert.equal(text, "낮은 결합도 이야기입니다.");
});

test("물결표 규칙의 핵심만 바꾼다", () => {
  const passive = rule({ bad: "~되어질", good: "~될" });
  const { text } = applyFixes("곧 수정되어질 예정입니다.", [passive]);
  assert.equal(text, "곧 수정될 예정입니다.");
});

test("가운데 물결표가 있는 규칙은 바꾸지 않는다", () => {
  const ambiguous = rule({ bad: "~에 대한 ~를 진행", good: "~를 처리" });
  const input = "파일에 대한 검사를 진행했습니다.";
  const { text, applied } = applyFixes(input, [ambiguous]);
  assert.equal(text, input);
  assert.equal(applied.length, 0);
});

test("정규식 규칙은 바꾸지 않는다", () => {
  const warnOnly = rule({ bad: "당신의", good: "이 / 생략", check: "정규식" });
  const input = "당신의 코드입니다.";
  assert.equal(applyFixes(input, [warnOnly]).text, input);
});

test("프롬프트 규칙은 바꾸지 않는다", () => {
  const promptOnly = rule({ check: "프롬프트" });
  const input = "리팩토링이 필요합니다.";
  assert.equal(applyFixes(input, [promptOnly]).text, input);
});

test("여러 곳을 뒤에서부터 고쳐 위치가 어긋나지 않는다", () => {
  const { text, applied } = applyFixes("컨텐츠와 메세지를 고쳤습니다. 컨텐츠 하나 더.", [
    rule({ bad: "컨텐츠", good: "콘텐츠" }),
    rule({ bad: "메세지", good: "메시지" }),
  ]);
  assert.equal(text, "콘텐츠와 메시지를 고쳤습니다. 콘텐츠 하나 더.");
  assert.equal(applied.length, 3);
});

test("적용 목록을 위치 순으로 돌려준다", () => {
  const { applied } = applyFixes("메세지 뒤에 컨텐츠", [
    rule({ bad: "컨텐츠", good: "콘텐츠" }),
    rule({ bad: "메세지", good: "메시지" }),
  ]);
  assert.deepEqual(
    applied.map((item) => item.matched),
    ["메세지", "컨텐츠"]
  );
});

test("코드 블록 안은 고치지 않는다", () => {
  const input = ["```", "const 리팩토링 = 1;", "```", "리팩토링이 필요합니다."].join("\n");
  const { text, applied } = applyFixes(input, [rule()]);
  assert.ok(text.includes("const 리팩토링 = 1;"), "코드 안을 건드렸다");
  assert.ok(text.includes("리팩터링이 필요합니다."));
  assert.equal(applied.length, 1);
});

test("바꿀 표현이 비어 있으면 건너뛴다", () => {
  const empty = rule({ good: "~" });
  const input = "리팩토링이 필요합니다.";
  const { text, skipped } = applyFixes(input, [empty]);
  assert.equal(text, input);
  assert.equal(skipped.length, 1);
});

test("잘못된 입력에 안전하다", () => {
  assert.deepEqual(applyFixes("", [rule()]), { text: "", applied: [], skipped: [] });
  assert.deepEqual(applyFixes(null, [rule()]), { text: "", applied: [], skipped: [] });
  assert.equal(applyFixes("리팩토링", null).text, "리팩토링");
});

test("건너뛴 이유의 조사도 받침에 맞춘다", () => {
  // 조사를 지켜 주는 코드가 자기 메시지의 조사를 틀리면 우습다.
  const thin = rule({ bad: "얇은 계약", good: "낮은 결합도" });
  const withEul = applyFixes("얇은 계약을 유지하세요.", [thin]);
  assert.match(withEul.skipped[0].reason, /"을"이 깨집니다/);

  const dep = rule({ bad: "디펜던시", good: "의존성" });
  const withGa = applyFixes("디펜던시가 꼬였습니다.", [dep]);
  assert.match(withGa.skipped[0].reason, /"가"가 깨집니다/);
});

test("괄호 안의 쉼표에서 잘리지 않는다", () => {
  // 쉼표로 먼저 자르고 괄호를 벗기면 "백분위 (p95, p99)" 가 "백분위 (p95" 가 된다.
  // 괄호가 반토막 난 채로 본문에 꽂힌다. 괄호를 먼저 벗겨야 한다.
  assert.equal(primaryGood("백분위 (p95, p99)"), "백분위");
  assert.equal(primaryGood("지연 시간 (p50, p95, p99 기준)"), "지연 시간");
  assert.equal(primaryGood("인가 / 권한 확인"), "인가");
  assert.equal(primaryGood("결합도, 느슨한 결합"), "결합도");
});

test("구두점이 남은 대체 표현은 쓰지 않는다", () => {
  // 마지막 방어선이다. 주 표현을 뽑은 뒤에도 괄호나 쉼표가 남아 있으면 꽂을 수 없다.
  const broken = rule({ bad: "나쁜 표현", good: "반쪽 (괄호" });
  assert.equal(autoFixReplacement(broken), null);
  assert.equal(applyFixes("나쁜 표현 입니다.", [broken]).applied.length, 0);
});

test("겹치는 치환은 더 긴 쪽을 적용한다", () => {
  const outer = rule({ bad: "루즈 커플링", good: "느슨한 결합" });
  const inner = rule({ bad: "커플링", good: "결합도" });
  const { text, applied } = applyFixes("루즈 커플링 구조로 바꿨습니다.", [outer, inner]);
  assert.equal(text, "느슨한 결합 구조로 바꿨습니다.");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].bad, "루즈 커플링");
});

test("긴 쪽이 조사 때문에 위험하면 짧은 쪽으로 물러나지 않는다", () => {
  // "얇은 계약"(받침 있음) 을 "낮은 결합도"(받침 없음) 으로 바꾸면 뒤따르는 "을" 이 깨진다.
  // 안쪽에 겹치는 "계약" 규칙이 있어도 대신 적용해서는 안 된다 — 아예 손대지 않는 것이 옳다.
  const outer = rule({ bad: "얇은 계약", good: "낮은 결합도" });
  const inner = rule({ bad: "계약", good: "합의" });
  const { text, applied, skipped } = applyFixes("얇은 계약을 유지하세요.", [outer, inner]);
  assert.equal(text, "얇은 계약을 유지하세요.");
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].bad, "얇은 계약");
});

test("실제 규칙표: '루즈 커플링'은 고쳐지고, 짧은 '디펜던시'도 따로 옳게 고쳐진다", () => {
  // "커플링"은 일상어(TV·전기 커플링)로도 쓰여 0.14.10에서 정규식(경고만)으로 내렸다.
  // 겹침 해소 자체는 여전히 살아 있는지 확인하려면 자동 교정이 남아 있는 다른 짧은 규칙이 필요하다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.equal(applyFixes("루즈 커플링 구조로 바꿨습니다.", rules).text, "느슨한 결합 구조로 바꿨습니다.");
  assert.equal(applyFixes("디펜던시 문제입니다.", rules).text, "의존성 문제입니다.");
});

test("실제 규칙표: '타이트 커플링'도 '커플링'에 먼저 삼켜지지 않고 옳게 고쳐진다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.equal(applyFixes("타이트 커플링을 풀었습니다.", rules).text, "강한 결합을 풀었습니다.");
});

test("실제 규칙표: '데드락'은 지적만 하고 고치지 않는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.equal(lint("데드락 발생", rules).some((f) => f.bad === "데드락"), true);
  assert.equal(applyFixes("데드락 발생", rules).text, "데드락 발생");
});

test("실제 규칙표: '레더 로직입니다'는 손대지 않고 지적하지도 않는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.deepEqual(lint("레더 로직입니다.", rules), []);
  assert.equal(applyFixes("레더 로직입니다.", rules).text, "레더 로직입니다.");
});

test("실제 규칙표: 문장 패턴 폭 안의 낱말 규칙도 따로 고쳐진다", () => {
  // "만약 ~라면, 그러면"은 정규식(경고만)이라 그대로 남고, 그 폭 안의 "쓰레드"는
  // 치환이라 "스레드"로 바뀐다. 두 규칙은 서로 다른 구간을 가리키는 게 아니라 겹쳐 있을
  // 뿐이므로 긴 쪽이 짧은 쪽의 교정을 막아서는 안 된다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const s1 = applyFixes("만약 쓰레드라면, 그러면 다시 만듭니다.", rules);
  assert.equal(s1.text, "만약 스레드라면, 그러면 다시 만듭니다.");

  const s2 = applyFixes("그것은 루즈 커플링 구조를 택하기 때문입니다.", rules);
  assert.equal(s2.text, "그것은 느슨한 결합 구조를 택하기 때문입니다.");
});

test("실제 규칙표: 앞자리 숫자가 같은 숫자 선행 규칙은 더 긴 숫자 속에서도 자동 교정된다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.equal(applyFixes("성능이 150 % 늘었습니다.", rules).text, "성능이 150% 늘었습니다.");
  assert.equal(applyFixes("비율이 130퍼센트입니다.", rules).text, "비율이 130%입니다.");
  assert.equal(applyFixes("시간은 3.10 밀리세컨드입니다.", rules).text, "시간은 3.10ms입니다.");
  // 숫자 자체가 사라지거나 자리를 옮기는 규칙("3개의 파일"→"파일 3개", 정규식)은
  // 여전히 더 긴 숫자 속에서는 손대지 않는다.
  assert.equal(applyFixes("13개의 파일을 수정했습니다.", rules).text, "13개의 파일을 수정했습니다.");
});

test("실제 규칙표: 낱말 전체가 이/가로 끝나 절 조각 오탐 목록에 오른 낱말도 자동 교정은 그대로 된다", () => {
  // endsInsideClauseFragment 의 CLAUSE_MARKER_DENYLIST는 오른쪽 경계 판정에만 쓴다.
  // "판박이 코드"·"눈송이 서버"는 규칙의 마지막 낱말이 아니라 그 앞 낱말("판박이",
  // "눈송이")이 우연히 이/가로 끝나 오탐 목록에 오른 것뿐이고, 규칙 자체의 매치·치환은
  // 이 목록과 무관하게 그대로 동작해야 한다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.equal(
    applyFixes("판박이 코드를 줄였습니다.", rules).text,
    "보일러플레이트를 줄였습니다.",
    "판박이 코드 치환이 깨졌다"
  );
  // 뒤에 다른 낱말이 더 붙어도(코드베이스) 오른쪽 경계가 살아 있어 그 낱말까지 삼키지
  // 않는다. CLAUSE_MARKER_DENYLIST 가 없던 때는 "판박이 코드베이스를"이 "보일러플레이트베이스를"로
  // 잘못 바뀌었다.
  assert.equal(
    applyFixes("판박이 코드베이스를 정리했습니다.", rules).text,
    "판박이 코드베이스를 정리했습니다.",
    "판박이 코드베이스까지 삼켰다"
  );
  assert.equal(
    applyFixes("눈송이 서버리스 함수를 늘렸습니다.", rules).text,
    "눈송이 서버리스 함수를 늘렸습니다.",
    "눈송이 서버리스까지 삼켰다"
  );
});

test("조사 첫 글자 집합이 짝 표에서 유도된다", () => {
  // 조사 지식을 두 곳에 적으면 한쪽만 고치게 된다.
  const heads = particleHeads();
  for (const particle of ["을", "를", "이", "가", "은", "는", "과", "와", "으", "로"]) {
    assert.ok(heads.has(particle[0]), `${particle} 의 첫 글자가 빠졌다`);
  }
});

test("으로/로 조사는 bad가 아니라 실제로 뒤에 온 조사와 good을 직접 맞춰 본다", () => {
  // bad(원문 낱말)와 good을 서로 비교하지 않는다 — 원문 자체가 이미 조사를 틀렸을 수
  // 있어서다("포함률으로"는 포함률이 ㄹ받침이라 원래 "포함률로"가 맞다). bad 기준으로
  // "같은 무리인가"만 보면 그 원문 오류가 good에 그대로 옮겨 붙는다("커버리지으로").
  // "으"가 왔으면 good은 ㄹ이 아닌 받침이 있어야 하고, "로"만 왔으면 good은 받침이
  // 없거나 ㄹ받침이어야 한다 — 이 판정에 bad의 받침은 들어가지 않는다.
  assert.ok(isParticleSafe("일", "책임", "으"), "책임은 으로 앞에 실제로 안전한데 위험하다고 봤다");
  assert.ok(isParticleSafe("책임", "일", "로"), "일은 로 앞에 실제로 안전한데 위험하다고 봤다");
  assert.ok(!isParticleSafe("포함률", "커버리지", "으"), "커버리지는 으로 앞에 위험한데 안전하다고 봤다");
  // ㄹ받침과 받침 없음은 둘 다 "로"를 쓰므로 서로 바뀌어도 안전하다.
  assert.ok(isParticleSafe("일", "나무", "로"));
  assert.ok(isParticleSafe("나무", "일", "로"));
  // 다른 받침끼리는 으로 앞에서 안전하다.
  assert.ok(isParticleSafe("책임", "권한", "으"));
});

test("실제 규칙표: 문지기 구문으로 → 가드 절으로처럼 ㄹ받침이 깨지는 치환은 건너뛴다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const s1 = applyFixes("문지기 구문으로 처리합니다.", rules);
  assert.equal(s1.text, "문지기 구문으로 처리합니다.", "가드 절으로 로 깨졌다");
  assert.equal(s1.applied.length, 0);

  const s2 = applyFixes("여러 모습 성질로 구현했습니다.", rules);
  assert.equal(s2.text, "여러 모습 성질로 구현했습니다.", "다형성로 로 깨졌다");

  const s3 = applyFixes("이뮤터블로 만들었습니다.", rules);
  assert.equal(s3.text, "이뮤터블로 만들었습니다.", "불변로 로 깨졌다");

  // 원문이 이미 조사를 틀린 경우("포함률으로"는 포함률이 ㄹ받침이라 "포함률로"가 맞다).
  // bad·good을 서로 비교하면 "둘 다 '으로 쪽' 받침이 아니다"로 오판해 그대로 옮겨
  // "커버리지으로"를 만든다. 실제 조사(으)와 good(커버리지, 받침 없음)을 직접 맞춰야
  // "으"가 받침 있는 다른 낱말에만 온다는 걸 보고 건너뛴다.
  const s4 = applyFixes("코드 포함률으로 본다.", rules);
  assert.equal(s4.text, "코드 포함률으로 본다.", "커버리지으로 로 깨졌다");
  assert.equal(s4.applied.length, 0);
});

test("실제 규칙표: 계사·랑의 축약형이 깨지면 자동 교정을 건너뛴다", () => {
  // "디펜던시였습니다" → "의존성였습니다"처럼, 짝 표에 없던 계사 활용형이 자동 교정을
  // 지나쳐서 깨진 문장을 냈다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const cases = [
    "원인은 디펜던시였습니다.",
    "아이덤포턴트여야 합니다.",
    "컨커런시예요.",
    "디펜던시랑 얽혀 있습니다.",
  ];
  for (const sentence of cases) {
    assert.equal(applyFixes(sentence, rules).text, sentence, sentence);
  }
});
