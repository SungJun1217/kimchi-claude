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

test("쓰지 말 것 칸의 / 로 가른 대안을 각각 잡는다", () => {
  const findings = lint("난간을 잡고 계단을 올랐습니다.", [rule({ bad: "난간 / 차선 방호벽", good: "안전장치" })]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].matched, "난간");

  const findings2 = lint("차선 방호벽이 설치됐습니다.", [rule({ bad: "난간 / 차선 방호벽", good: "안전장치" })]);
  assert.equal(findings2.length, 1);
  assert.equal(findings2[0].matched, "차선 방호벽");
});

test("NFD(자모 분해형) 한글도 NFC와 같은 개수만큼 잡는다", () => {
  const nfc = "컨텐츠 메세지를 리팩토링했습니다.";
  const nfd = nfc.normalize("NFD");
  const rules = [
    rule({ bad: "컨텐츠", good: "콘텐츠" }),
    rule({ bad: "메세지", good: "메시지" }),
    rule({ bad: "리팩토링", good: "리팩터링" }),
  ];
  assert.equal(lint(nfd, rules).length, lint(nfc, rules).length);
  assert.equal(lint(nfd, rules).length, 3);
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
  // 앞 구간의 끝(index+length)이 뒤 구간의 시작과 같으면 겹친 게 아니다. 한글로 하면
  // 새로 생긴 낱말 경계 검사에 걸리므로(다른 낱말 속인지 판정), 경계와 무관한 로마자로 시험한다.
  const first = rule({ bad: "ab", good: "다름1" });
  const second = rule({ bad: "cd", good: "다름2" });
  const findings = lint("abcd", [first, second]);
  assert.deepEqual(findings.map((f) => f.bad), ["ab", "cd"]);
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

// ── 낱말 경계 ─────────────────────────────────────────────
//
// 규칙이 다른 낱말 속에 우연히 들어 있으면 잡으면 안 된다. "디커플링"의 "커플링",
// "뒷문장"의 "뒷문"이 실제로 배포됐던 오탐이다.

test("다른 낱말 속에 갇힌 금칙어는 잡지 않는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);

  // 왼쪽 경계: "디커플링" 안의 "커플링".
  assert.deepEqual(
    lint("디커플링 커패시터를 추가했습니다.", rules).filter((f) => f.bad === "커플링"),
    []
  );
  // 오른쪽 경계: "뒷문장" 안의 "뒷문".
  assert.deepEqual(
    lint("뒷문장을 다시 썼습니다.", rules).filter((f) => f.bad === "뒷문"),
    []
  );
  // 오른쪽 경계: "일정대로" 안의 "맡은 일".
  assert.deepEqual(
    lint("제가 맡은 일정대로 진행하겠습니다.", rules).filter((f) => f.bad === "맡은 일"),
    []
  );
  // 왼쪽 경계: "결론짓기" 안의 "짓기".
  assert.deepEqual(
    lint("아직 결론짓기 어렵습니다.", rules).filter((f) => f.bad === "짓기"),
    []
  );
});

test("낱말 경계 안에서는 여전히 잡는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);

  assert.ok(lint("커플링이 높습니다.", rules).some((f) => f.bad === "커플링"));
  assert.ok(lint("커플링 문제입니다.", rules).some((f) => f.bad === "커플링"));
  assert.ok(lint("뒷문을 열어 두었습니다.", rules).some((f) => f.bad === "뒷문"));
  assert.ok(lint("제가 맡은 일을 끝냈습니다.", rules).some((f) => f.bad === "맡은 일"));
});

test("낱말 여러 개로 된 규칙은 활용형이 붙어도 여전히 잡는다", () => {
  // "계약이 얇"·"싱크를 맞"처럼 목적어·주어 뒤에 어간만 남긴 규칙은 활용형이 무한히
  // 이어질 수 있어 오른쪽 경계를 문자열로 셀 수 없다 — 검사를 하지 않는다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);

  assert.ok(lint("계약이 얇습니다.", rules).some((f) => f.bad === "계약이 얇"));
  assert.ok(lint("팀과 싱크를 맞춘 뒤 진행하겠습니다.", rules).some((f) => f.bad === "싱크를 맞"));
});

test("-게로 끝나는 부사형 규칙도 활용형이 붙어도 잡는다", () => {
  // "얇게 만들"(observed.md)의 마지막 낱말 "만들"은 어/고/기 따위가 무한히 붙는 서술어다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.ok(lint("얇게 만들어 두었습니다.", rules).some((f) => f.bad === "얇게 만들"));
  assert.ok(lint("얇게 만들고 있습니다.", rules).some((f) => f.bad === "얇게 만들"));
});

// ── "로"/"으로" 오른쪽 경계 ───────────────────────────────
//
// "로"는 조사이기도 하지만 "로그"·"로직"의 시작이기도 하다. "판박이 코드"(→"보일러플레이트")
// 규칙이 "판박이 코드로그를"까지 잡아 "보일러플레이트로그를"로 깨졌던 것이 실제 사례다.

test("판박이 코드 뒤에 로그/로직/으로그가 이어지면 다른 낱말 속이라 잡지 않는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const boilerplate = (text) => lint(text, rules).filter((f) => f.bad === "판박이 코드");

  assert.deepEqual(boilerplate("판박이 코드로그를 확인합니다."), []);
  assert.deepEqual(boilerplate("판박이 코드로직을 확인합니다."), []);
  assert.deepEqual(boilerplate("판박이 코드로더를 확인합니다."), []);
  assert.deepEqual(boilerplate("판박이 코드로컬을 확인합니다."), []);
  assert.deepEqual(boilerplate("판박이 코드로드를 확인합니다."), []);
  assert.deepEqual(boilerplate("판박이 코드으로그를 확인합니다."), []);
});

test("판박이 코드 뒤에 진짜 로/으로 조사·연속 조사가 오면 여전히 잡는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const boilerplate = (text) => lint(text, rules).filter((f) => f.bad === "판박이 코드");

  assert.ok(boilerplate("판박이 코드로 확인합니다.").length > 0);
  assert.ok(boilerplate("판박이 코드는 확인합니다.").length > 0);
  assert.ok(boilerplate("판박이 코드로서 확인합니다.").length > 0);
  assert.ok(boilerplate("판박이 코드로써 확인합니다.").length > 0);
  assert.ok(boilerplate("판박이 코드로부터 확인합니다.").length > 0);
  assert.ok(boilerplate("판박이 코드으로는 확인합니다.").length > 0);
});

test("판박이 코드 뒤에 로인해/로다가가 이어져도 여전히 잡는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const boilerplate = (text) => lint(text, rules).filter((f) => f.bad === "판박이 코드");

  assert.ok(boilerplate("판박이 코드로인해 문제가 생겼습니다.").length > 0);
  assert.ok(boilerplate("판박이 코드로다가 확인합니다.").length > 0);
});

// ── 표기·띄어쓰기 규칙은 경계를 보지 않는다 ──────────────────
//
// "수정해야합니다"의 "해야합니다", "메타데이타를"의 "데이타"처럼 앞뒤에 무엇이 오든
// 표기·띄어쓰기 자체가 틀렸다. 낱말 경계 검사가 이런 규칙까지 막으면 안 된다.

test("표기·띄어쓰기 규칙은 다른 낱말에 붙어 있어도 잡는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const cases = [
    ["수정해야합니다.", "해야합니다"],
    ["처리하는것이 늦었습니다.", "하는것"],
    ["사용함으로서 문제를 해결했습니다.", "함으로서"],
    ["변경됬습니다.", "됬습니다"],
    ["메타데이타를 읽습니다.", "데이타"],
    ["서버랜더링을 켰습니다.", "랜더링"],
    ["궁굼한데 여쭤봐도 될까요?", "궁굼한"],
    ["메세지큐에 넣었습니다.", "메세지"],
    ["쓰레드풀을 늘렸습니다.", "쓰레드"],
    ["엑세스토큰을 발급했습니다.", "엑세스"],
    ["컨텐츠팀에서 정리했습니다.", "컨텐츠"],
  ];
  for (const [text, bad] of cases) {
    assert.ok(lint(text, rules).some((f) => f.bad === bad), `${text} 에서 "${bad}" 를 놓쳤다`);
  }
});

// ── 짧은 낱말로 끝나는 규칙만 오른쪽 경계를 본다 ──────────────
//
// 실제 오탐(뒷문+장, 맡은 일+정)은 마지막 낱말이 짧았다. "커플링"·"핸들링"처럼 세 음절
// 이상으로 끝나는 규칙까지 검사하면 흔한 활용·파생이 대량으로 걸러졌다.

test("긴 낱말로 끝나는 규칙은 활용·파생이 붙어도 잡는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const cases = [
    ["컨펌받았습니다.", "컨펌"],
    ["디플로이됩니다.", "디플로이"],
    ["커플링시켜 문제가 생겼습니다.", "커플링"],
    ["핸들링마다 다릅니다.", "핸들링"],
    ["니즈대로 진행합니다.", "니즈"],
    ["커플링일 때 문제가 생깁니다.", "커플링"],
  ];
  for (const [text, bad] of cases) {
    assert.ok(lint(text, rules).some((f) => f.bad === bad), `${text} 에서 "${bad}" 를 놓쳤다`);
  }
});

test("한 글자 접미사 제거는 실제 합성어 오탐도 여전히 막는다", () => {
  // "제출"+"자"(제출자를), "제출"+"서"(제출서류), "제출"+"용"(제출용), "니즈"+"니"(니즈니)
  // 처럼 짧은 규칙 뒤에 다른 낱말이 붙어 오탐을 낸 사례다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.deepEqual(
    lint("제출자를 확인해 주세요.", rules).filter((f) => f.bad === "제출"),
    []
  );
  assert.deepEqual(
    lint("니즈니 노브고로드에 갔습니다.", rules).filter((f) => f.bad === "니즈"),
    []
  );
});

test("경계에 막혀 버려지는 매치는 규칙별 보고 상한에 넣지 않는다", () => {
  // "디커플링 커패시터."를 50번 반복해도 뒤에 나오는 진짜 "커플링이 높습니다."는 잡아야 한다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const text = "디커플링 커패시터. ".repeat(50) + "커플링이 높습니다.";
  assert.ok(lint(text, rules).some((f) => f.bad === "커플링"));
});

// ── 길이로 오른쪽 검사를 통째로 빼지 않는다 ──────────────────
//
// 긴 낱말로 끝나는 규칙을 통째로 안 본 적이 있다. 그러면 "이 기록부터"의 "기록부",
// "쿠버네티스 디플로이먼트"의 "디플로이"처럼 우연히 다른 낱말 속에 낀 매치까지 다시
// 새어 나갔다. 길이와 무관하게 FOLLOWER_TOKENS 로만 판정한다.

test("긴 낱말로 끝나는 규칙도 다른 낱말 속에 갇히면 잡지 않는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const cases = [
    ["이 기록부터 봅시다.", "기록부"],
    ["쿠버네티스 디플로이먼트를 늘렸습니다.", "디플로이"],
    ["디펜던시즈를 정리했습니다.", "디펜던시"],
    ["통나무집을 지었습니다.", "통나무"],
  ];
  for (const [text, bad] of cases) {
    assert.deepEqual(
      lint(text, rules).filter((f) => f.bad === bad),
      [],
      `${text} 에서 "${bad}" 가 다른 낱말 속에서 잘못 잡혔다`
    );
  }
});

test("일시처럼 시로 시작하되 시키지 않는 낱말은 시키/시켜류로 보지 않는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.deepEqual(
    lint("맡은 일시 중단했습니다.", rules).filter((f) => f.bad === "맡은 일"),
    []
  );
});

// ── 표기 규칙은 왼쪽만 뺀다 ───────────────────────────────────
//
// 양쪽을 다 빼면 "어떻게 할 지"가 "지침"·"지원" 속까지 파고든다. 오른쪽 검사는 켜 두되,
// 외래어 명사를 그대로 이어 붙이는 표기 규칙(메세지·데이타 등)만 예외로 오른쪽도 뺀다.

test("띄어쓰기 규칙은 오른쪽 경계를 그대로 지킨다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.deepEqual(
    lint("어떻게 할 지침이 필요합니다.", rules).filter((f) => f.bad === "어떻게 할 지"),
    []
  );
  assert.deepEqual(
    lint("어떻게 할 지원이 필요합니다.", rules).filter((f) => f.bad === "어떻게 할 지"),
    []
  );
  // 정당한 쓰임은 여전히 잡는다.
  assert.ok(lint("어떻게 할 지 모르겠습니다.", rules).some((f) => f.bad === "어떻게 할 지"));
});

test("외래어 표기 규칙은 다른 외래어에 그대로 붙어 있어도 잡는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const cases = [
    ["메세지큐에 넣었습니다.", "메세지"],
    ["쓰레드풀을 늘렸습니다.", "쓰레드"],
    ["데이타베이스를 손봤습니다.", "데이타"],
    ["엑세스토큰을 발급했습니다.", "엑세스"],
    ["컨텐츠팀에서 정리했습니다.", "컨텐츠"],
    ["스케쥴러를 손봤습니다.", "스케쥴러"],
    // 레지스터리는 0.13.19에서 이유 문장이 바뀌며 [외래어] 분류를 잃었다가 이번 단위에서
    // 되돌렸다 — 메세지처럼 다른 외래어에 붙어 있어도 잡아야 정상이다.
    ["윈도우레지스터리를 봅니다.", "레지스터리"],
  ];
  for (const [text, bad] of cases) {
    assert.ok(lint(text, rules).some((f) => f.bad === bad), `${text} 에서 "${bad}" 를 놓쳤다`);
  }
});

test("50 % 는 더 이상 [표기] 로 분류되지 않는다", () => {
  // 0.13.19에서 이유 문장에 "띄어도"가 우연히 들어가 [표기] 분류를 얻었다 — 실제 매치에는
  // 영향이 없었다("50 %"의 첫 글자가 숫자라 왼쪽 경계 검사 자체가 애초에 걸리지 않는다)
  // 지만, 자료로서는 잘못된 분류였으므로 이번 단위에서 표지를 뗐다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  const rule = rules.find((r) => r.bad === "50 %");
  assert.equal(rule.kind, undefined);
  assert.ok(lint("할인율은 50 % 입니다.", rules).some((f) => f.bad === "50 %"));
});

// ── 표기·외래어 분류는 이유 낱말이 아니라 kind 표지만 본다 ─────
//
// 예전에는 이유 칸에 "표기" 같은 낱말이 있으면 왼쪽 경계를 뺐다. 이유 문장을 다듬다
// 낱말이 우연히 빠지거나 들어가면 판정이 조용히 바뀌었다 — 0.13.19에서 레지스터리는
// "외래어"가 빠져 분류를 잃었고, "50 %"는 새 이유의 "띄어도"에 걸려 분류를 얻었다.
// rules.mjs 가 이유 칸 맨 앞 [표기]/[외래어] 표지를 읽어 kind 로 넘기고, lint.mjs 는 그
// 필드만 본다 — 이유 문장의 낱말과는 이제 무관하다는 것을 아래에서 확인한다.

test("이유에 표기 낱말이 있어도 kind 표지가 없으면 경계를 그대로 지킨다", () => {
  const synthetic = rule({
    bad: "가짜규칙",
    good: "고친말",
    why: "표기 맞춤법과 관련 있어 보이는 설명이지만 표지가 없다",
    check: "치환",
  });
  // 왼쪽에 한글이 바로 붙어 있으면(경계 없음) 표기 규칙이 아닌 한 잡지 않는다.
  assert.deepEqual(lint("앞말가짜규칙 뒷말", [synthetic]), []);
});

test("이유에 표기 낱말이 없어도 kind: orthography 표지가 있으면 왼쪽 경계를 뺀다", () => {
  const synthetic = rule({
    bad: "가짜규칙",
    good: "고친말",
    why: "아무 상관 없는 설명",
    kind: "orthography",
    check: "치환",
  });
  assert.ok(lint("앞말가짜규칙 뒷말", [synthetic]).some((f) => f.bad === "가짜규칙"));
});

test("kind: loanword 표지가 있으면 왼쪽·오른쪽 경계를 모두 뺀다", () => {
  const synthetic = rule({
    bad: "가짜규칙",
    good: "고친말",
    why: "아무 상관 없는 설명",
    kind: "loanword",
    check: "치환",
  });
  assert.ok(lint("앞말가짜규칙뒷말", [synthetic]).some((f) => f.bad === "가짜규칙"));
});

// ── -적 은 세 음절 이상 뒤에서만, 알려진 충돌은 막는다 ─────────

test("세 음절 이상 뒤의 -적은 흔한 파생이라 잡는다", () => {
  // 접속면·연결면 같은 충돌 사례가 없는, 세 음절 한자어 뒤의 흔한 "-적" 파생이다.
  const threeSyllable = rule({ bad: "가용성", good: "가용도" });
  assert.ok(lint("가용성적인 측면에서 낫습니다.", [threeSyllable]).some((f) => f.bad === "가용성"));
});

test("접속면적·연결면적처럼 -적이 다른 낱말을 만드는 자리는 막는다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.deepEqual(
    lint("접속면적이 넓습니다.", rules).filter((f) => f.bad === "접속면"),
    []
  );
  assert.deepEqual(
    lint("연결면적이 넓습니다.", rules).filter((f) => f.bad === "연결면"),
    []
  );
});

// ── 숫자로 시작하는 규칙은 더 긴 숫자 속에서 잡지 않는다 ─────────

test("숫자로 시작하는 규칙은 더 긴 숫자 속에서는 잡지 않는다", () => {
  const digitLed = rule({ bad: "3개의 파일", good: "세 개의 파일" });
  assert.deepEqual(lint("13개의 파일을 수정했습니다.", [digitLed]), []);
});

test("숫자로 시작하는 규칙은 숫자가 그 앞에서 끝나면 그대로 잡는다", () => {
  const digitLed = rule({ bad: "3개의 파일", good: "세 개의 파일" });
  assert.ok(lint("총 3개의 파일을 수정했습니다.", [digitLed]).some((f) => f.bad === "3개의 파일"));
});

test("실제 규칙표: 숫자로 시작하는 기존 규칙은 여전히 잡힌다", () => {
  // 50 %, 30퍼센트, 10 밀리세컨드 같은 숫자 선행 규칙이 이 변경으로 죽지 않았는지 본다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.ok(lint("응답이 50 % 느려졌습니다.", rules).some((f) => f.bad === "50 %"));
  assert.ok(lint("지연이 30퍼센트 줄었습니다.", rules).some((f) => f.bad === "30퍼센트"));
  assert.ok(lint("지연이 10 밀리세컨드 늘었습니다.", rules).some((f) => f.bad === "10 밀리세컨드"));
});

test("숫자로 시작하는 규칙도 쓸 것이 같은 앞자리 숫자로 시작하면 더 긴 숫자 속에서도 잡는다", () => {
  // "50 %"→"50%"는 앞자리 숫자 "50"이 good에도 그대로 남는다 — "150 %"의 "50 %"를
  // 잡아 "150%"를 만드는 것이 의도한 동작이다("3개의 파일"→"파일 3개"처럼 숫자 자체가
  // 사라지거나 자리를 옮기는 규칙과는 다르다). leftDigit을 무조건 켜면 이 자동 교정이
  // 통째로 죽는다.
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  assert.ok(lint("성능이 150 % 늘었습니다.", rules).some((f) => f.bad === "50 %"));
  assert.ok(lint("비율이 130퍼센트입니다.", rules).some((f) => f.bad === "30퍼센트"));
  assert.ok(lint("시간은 3.10 밀리세컨드입니다.", rules).some((f) => f.bad === "10 밀리세컨드"));
});

// ── "허가"처럼 우연히 이/가로 끝나는 낱말은 절 조각으로 보지 않는다 ─────────

test("허가처럼 낱말 전체가 이/가로 끝나면 오른쪽 경계를 그대로 지킨다", () => {
  const { rules } = loadRules(new URL("../rules", import.meta.url).pathname);
  // "허가 내주기표를"의 "표"는 FOLLOWER_TOKENS에 없으니 오른쪽 경계가 살아 있어야 잡히지 않는다.
  assert.deepEqual(
    lint("그는 허가 내주기표를 만들었다.", rules).filter((f) => f.bad === "허가 내주기"),
    []
  );
  // 정상적인 자리에서는 여전히 잡는다.
  assert.ok(lint("허가 내주기 절차를 손봤습니다.", rules).some((f) => f.bad === "허가 내주기"));
});
