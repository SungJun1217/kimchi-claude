import { test } from "node:test";
import assert from "node:assert/strict";
import { rule as base } from "./helpers.mjs";
import { lint, toPattern, formatFindings } from "../hooks/lib/lint.mjs";
import { loadRules } from "../hooks/lib/rules.mjs";

// 이 시험 묶음의 기본값만 여기서 정하고, 규칙 객체 모양은 helpers 가 갖는다.
const rule = (overrides = {}) => base({ check: "정규식", good: "결합도", source: "test.md", ...overrides });

test("정규식 규칙이 위반을 찾는다", () => {
  const findings = lint("여기서 얇은 계약을 유지하세요.", [rule()]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].matched, "얇은 계약");
  assert.equal(findings[0].good, "결합도");
});

test("위치가 원문 기준으로 정확하다", () => {
  const text = "앞말 얇은 계약 뒷말";
  const findings = lint(text, [rule()]);
  assert.equal(findings[0].index, text.indexOf("얇은 계약"));
});

test("프롬프트 규칙은 검사하지 않는다", () => {
  const findings = lint("얇은 계약입니다.", [rule({ check: "프롬프트" })]);
  assert.equal(findings.length, 0);
});

test("인라인 코드 안의 같은 문자열은 잡지 않는다", () => {
  const findings = lint("`얇은 계약` 이라는 용어", [rule()]);
  assert.equal(findings.length, 0, "제외 구간에서 매치가 일어났다");
});

test("코드 블록 안의 같은 문자열은 잡지 않는다", () => {
  const text = ["```", "// 얇은 계약", "```"].join("\n");
  assert.equal(lint(text, [rule()]).length, 0);
});

test("식별자 오탐을 막는다", () => {
  // contract 를 계약으로 고치라는 규칙이 변수명에 걸리면 안 된다.
  const contractRule = rule({ bad: "계약", good: "인터페이스" });
  const findings = lint("`contract` 를 `Contract` 로 바꿨습니다.", [contractRule]);
  assert.equal(findings.length, 0);
});

test("한 글자 규칙은 위험해서 쓰지 않는다", () => {
  assert.equal(toPattern("들"), null);
  assert.equal(lint("파일들을 읽습니다.", [rule({ bad: "들" })]).length, 0);
});

test("물결표는 앞뒤 무엇이든을 뜻한다", () => {
  const pattern = toPattern("~되어질");
  assert.ok(pattern.test("수정되어질 것입니다"));
  const findings = lint("수정되어질 예정입니다.", [rule({ bad: "~되어질", good: "~될" })]);
  assert.equal(findings.length, 1);
});

test("가운데 물결표가 사이를 건너뛴다", () => {
  const findings = lint("파일에 대한 검사를 진행했습니다.", [
    rule({ bad: "~에 대한 ~를 진행", good: "~를 검사" }),
  ]);
  assert.equal(findings.length, 1);
});

test("정규식 특수문자를 문자 그대로 다룬다", () => {
  const findings = lint("점(.)과 별표(*)입니다.", [rule({ bad: "(.)과 별표(*)", good: "기호" })]);
  assert.equal(findings.length, 1);
});

test("한 규칙의 보고 수를 제한한다", () => {
  const text = "얇은 계약 얇은 계약 얇은 계약 얇은 계약 얇은 계약";
  assert.equal(lint(text, [rule()]).length, 3);
});

test("여러 규칙의 결과를 위치 순으로 돌려준다", () => {
  const text = "뒤에 얇은 계약, 앞에 두꺼운 모델";
  const findings = lint(text, [rule(), rule({ bad: "두꺼운 모델", good: "책임이 과한 모델" })]);
  assert.equal(findings.length, 2);
  assert.ok(findings[0].index < findings[1].index);
});

test("잘못된 입력에 안전하다", () => {
  assert.deepEqual(lint("", [rule()]), []);
  assert.deepEqual(lint(null, [rule()]), []);
  assert.deepEqual(lint("얇은 계약", null), []);
  assert.deepEqual(lint("얇은 계약", []), []);
});

test("메시지에 대체 표현과 이유가 들어간다", () => {
  const message = formatFindings(lint("얇은 계약입니다.", [rule()]), "커밋 메시지");
  assert.match(message, /커밋 메시지/);
  assert.match(message, /결합도/);
  assert.match(message, /은유 직역/);
});

test("같은 지적을 반복해 싣지 않는다", () => {
  const message = formatFindings(lint("얇은 계약 얇은 계약", [rule()]));
  assert.equal(message.split("\n").filter((line) => line.startsWith("- ")).length, 1);
});

test("위반이 없으면 빈 메시지를 돌려준다", () => {
  assert.equal(formatFindings([]), "");
});

test("문서 전체 예외 표시가 있으면 검사하지 않는다", () => {
  const text = "<!-- kimchi-ignore-file -->\n얇은 계약을 인용합니다.";
  assert.deepEqual(lint(text, [rule()]), []);
});

test("겹치는 발견은 더 긴 쪽만 남긴다", () => {
  // "루즈 커플링" 안에 "커플링"이 포함된다. 둘 다 잡히면 짧은 쪽은 버린다.
  const outer = rule({ bad: "루즈 커플링", good: "느슨한 결합" });
  const inner = rule({ bad: "커플링", good: "결합도" });
  const findings = lint("루즈 커플링 구조로 바꿨습니다.", [outer, inner]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].bad, "루즈 커플링");
});

test("겹치지 않으면 둘 다 남는다", () => {
  const outer = rule({ bad: "루즈 커플링", good: "느슨한 결합" });
  const inner = rule({ bad: "커플링", good: "결합도" });
  const findings = lint("커플링 문제입니다.", [outer, inner]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].bad, "커플링");
});

test("따로 떨어진 매치는 둘 다 남는다", () => {
  const outer = rule({ bad: "루즈 커플링", good: "느슨한 결합" });
  const inner = rule({ bad: "커플링", good: "결합도" });
  const findings = lint("루즈 커플링 구조입니다. 나중에 커플링 문제가 또 생겼습니다.", [outer, inner]);
  assert.deepEqual(findings.map((f) => f.bad), ["루즈 커플링", "커플링"]);
});

test("맞닿기만 하고 겹치지 않는 두 구간은 둘 다 남는다", () => {
  // 앞 구간의 끝(index+length)이 뒤 구간의 시작과 같으면 겹친 게 아니다.
  const first = rule({ bad: "가나", good: "다름1" });
  const second = rule({ bad: "다라", good: "다름2" });
  const findings = lint("가나다라", [first, second]);
  assert.deepEqual(findings.map((f) => f.bad), ["가나", "다라"]);
});

test("'~지 여부'는 동사 어미 뒤만 잡고 '지'로 끝나는 명사는 두고 본다", () => {
  // 한 줄짜리 '~지 여부' 규칙이 유지·금지·방지 여부까지 잡고 틀린 교정을 권했다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const hits = (text) => lint(text, rules).filter((finding) => finding.bad.endsWith("여부"));
  assert.equal(hits("캐시가 필요한지 여부를 확인했습니다.").length, 1);
  assert.equal(hits("쿠폰을 먼저 적용할지 여부는 정해야 합니다.").length, 1);
  for (const clean of ["세션 유지 여부를 설정합니다.", "캐시 삭제 금지 여부", "중복 방지 여부를 옵션으로 둡니다.", "배포 중지 여부", "사용자 인지 여부", "성공 여부를 기록합니다."]) {
    assert.deepEqual(hits(clean), [], clean);
  }
});

test("실제 규칙표에서도 '루즈 커플링'은 '커플링'에 겹쳐 잡히지 않는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const findings = lint("루즈 커플링 구조로 바꿨습니다.", rules);
  const hits = findings.filter((f) => f.bad === "커플링" || f.bad === "루즈 커플링");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].bad, "루즈 커플링");
});

test("문장 패턴 규칙은 폭 안에 겹친 낱말 규칙을 삼키지 않는다", () => {
  // "만약 ~라면, 그러면"의 물결표는 앞뒤 20자까지 아무 내용이나 문다. 그 폭 안에
  // 우연히 "임시 저장소"가 있어도 둘은 서로 다른 지적이다. 길이만 보고 겹침을
  // 해소하면 항상 더 긴 문장 패턴이 이겨서 낱말 지적을 지워 버린다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);

  const s1 = lint("만약 임시 저장소라면, 그러면 다시 채웁니다.", rules);
  assert.ok(s1.some((f) => f.bad === "만약 ~라면, 그러면"), "문장 패턴이 사라졌다");
  assert.ok(s1.some((f) => f.bad === "임시 저장소"), "낱말 지적이 삼켜졌다");

  const s2 = lint("그것은 루즈 커플링 구조를 택하기 때문입니다.", rules);
  assert.ok(s2.some((f) => f.bad === "그것은 ~하기 때문입니다"), "문장 패턴이 사라졌다");
  assert.ok(s2.some((f) => f.bad === "루즈 커플링"), "낱말 지적이 삼켜졌다");
});

test("규칙별 상한은 겹침 해소 뒤에 적용된다", () => {
  // "루즈 커플링"이 "커플링"의 상한(3)을 겹침 해소 전에 다 써버리면, 뒤에 따로 나오는
  // 진짜 "커플링"은 보고되지 않는다.
  const outer = rule({ bad: "루즈 커플링", good: "느슨한 결합" });
  const inner = rule({ bad: "커플링", good: "결합도" });
  const text = "루즈 커플링 구조입니다. ".repeat(3) + "커플링 문제입니다. ".repeat(2);
  const findings = lint(text, [outer, inner]);
  assert.deepEqual(
    findings.map((f) => f.bad),
    ["루즈 커플링", "루즈 커플링", "루즈 커플링", "커플링", "커플링"]
  );
});
