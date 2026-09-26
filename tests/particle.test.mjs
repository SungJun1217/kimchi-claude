// 영어 낱말 뒤 조사 판정.
//
// 이 시험의 핵심은 "모르면 판정하지 않는다"를 지키는 것이다. 틀린 자동 교정은
// 없는 것보다 나쁘다. 목록에 없는 낱말에 대해 추측하기 시작하면 이 기능은 해가 된다.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasFinalSound,
  finalSoundOf,
  correctParticle,
  findParticleErrors,
  fixParticles,
  formatParticleErrors,
} from "../hooks/lib/particle.mjs";

test("목록에 있는 낱말의 끝소리를 판정한다", () => {
  assert.equal(hasFinalSound("commit"), true, "커밋 — ㅅ");
  assert.equal(hasFinalSound("cache"), false, "캐시");
  assert.equal(hasFinalSound("hook"), true, "훅 — ㄱ");
  assert.equal(hasFinalSound("module"), true, "모듈 — ㄹ");
  assert.equal(hasFinalSound("merge"), false, "머지");
});

test("대소문자를 가리지 않는다", () => {
  assert.equal(hasFinalSound("COMMIT"), true);
  assert.equal(hasFinalSound("Commit"), true);
});

test("낱말로 읽는 두음자어를 글자로 읽지 않는다", () => {
  // JSON 을 글자로 읽으면 엔(ㄴ)이라 우연히 맞지만, REST 는 티(받침 없음)가 아니라
  // 레스트(받침 없음)로 읽어야 맞고, YAML 은 엘(ㄹ)과 야믈(ㄹ)이 같다.
  assert.equal(hasFinalSound("JSON"), true, "제이슨 — ㄴ");
  assert.equal(hasFinalSound("REST"), false, "레스트");
  assert.equal(hasFinalSound("CRUD"), false, "크러드");
  assert.equal(hasFinalSound("YAML"), true, "야믈 — ㄹ");
});

test("목록에 없는 짧은 두음자어는 글자로 읽는다", () => {
  assert.equal(hasFinalSound("SQL"), true, "에스큐엘 — ㄹ");
  assert.equal(hasFinalSound("API"), false, "에이피아이");
  assert.equal(hasFinalSound("CPU"), false, "씨피유");
  assert.equal(hasFinalSound("DOM"), true, "디오엠 — ㅁ");
});

test("순수 숫자는 한국어 수사로 읽는다", () => {
  assert.equal(hasFinalSound("3"), true, "삼 — ㅁ");
  assert.equal(hasFinalSound("2"), false, "이");
  assert.equal(hasFinalSound("7"), true, "칠 — ㄹ");
  assert.equal(hasFinalSound("100"), true, "백 — ㄱ. 끝자리 0 은 영 — ㅇ");
  assert.equal(hasFinalSound("42"), false, "사십이");
});

test("글자가 붙은 숫자는 영어로 읽는다", () => {
  // 같은 3 이 문맥에 따라 삼(받침 있음)과 쓰리(받침 없음)로 갈린다.
  assert.equal(hasFinalSound("3"), true, "삼");
  assert.equal(hasFinalSound("S3"), false, "에스쓰리");
  assert.equal(hasFinalSound("v3"), false, "브이쓰리");
  assert.equal(hasFinalSound("EC2"), false, "이씨투");
  assert.equal(hasFinalSound("v1"), true, "브이원 — ㄴ");
});

test("모르는 낱말은 판정하지 않는다", () => {
  // 철자로 끝소리를 유도할 수 없다. hook 은 훅(ㄱ)인데 cache 는 캐시(받침 없음)다.
  // 규칙처럼 보이지만 갈린다. 추측하면 안 된다.
  assert.equal(hasFinalSound("foo"), null);
  assert.equal(hasFinalSound("mycompanyservice"), null);
  assert.equal(hasFinalSound("FRAMEWORK"), null, "네 글자를 넘는 대문자는 낱말로 읽힐 수 있다");
});

test("글자 뒤 여러 자리 숫자는 판정하지 않는다", () => {
  // S3 는 에스쓰리로 읽지만 p99 는 "피 나인티나인" 이 아니라 "피 구십구" 로 읽는다.
  // 어느 쪽인지 갈리는 자리라 손대지 않는다. p99를 을 p99을 로 고치려 했던 오탐이다.
  assert.equal(hasFinalSound("S3"), false, "한 자리는 영어로 읽는다");
  assert.equal(hasFinalSound("p99"), null);
  assert.equal(hasFinalSound("v10"), null);
  assert.equal(hasFinalSound("99"), false, "순수 숫자는 한국어 수사다. 구십구 — 끝 음절 구는 받침이 없다");
  assert.equal(hasFinalSound("91"), true, "구십일 — ㄹ");
});

test("한글로 끝나면 이 함수가 다루지 않는다", () => {
  assert.equal(hasFinalSound("커밋"), null);
  assert.equal(hasFinalSound("캐시"), null);
});

test("잘못된 입력에 안전하다", () => {
  assert.equal(hasFinalSound(""), null);
  assert.equal(hasFinalSound(null), null);
  assert.equal(hasFinalSound(42), null);
});

test("틀린 조사를 바로잡는다", () => {
  assert.equal(correctParticle("commit", "를"), "을");
  assert.equal(correctParticle("cache", "을"), "를");
  assert.equal(correctParticle("module", "가"), "이");
  assert.equal(correctParticle("SQL", "는"), "은");
});

test("맞는 조사는 그대로 둔다", () => {
  assert.equal(correctParticle("commit", "을"), null);
  assert.equal(correctParticle("cache", "를"), null);
  assert.equal(correctParticle("API", "를"), null);
});

test("판정할 수 없으면 손대지 않는다", () => {
  assert.equal(correctParticle("kubernetes", "를"), null);
  assert.equal(correctParticle("commit", "에서"), null, "받침과 무관한 조사");
});

test("으로/로 도 다룬다", () => {
  assert.equal(correctParticle("JSON", "로"), "으로", "제이슨 — ㄴ");
  assert.equal(correctParticle("cache", "으로"), "로");
  assert.equal(correctParticle("commit", "로서"), "으로서");
});

test("글에서 틀린 자리를 찾는다", () => {
  const found = findParticleErrors("commit를 확인하고 cache을 비웠습니다.");
  assert.equal(found.length, 2);
  assert.deepEqual(
    found.map((hit) => `${hit.word}${hit.particle}→${hit.word}${hit.correct}`),
    ["commit를→commit을", "cache을→cache를"]
  );
});

test("코드와 경로 안은 건드리지 않는다", () => {
  assert.equal(findParticleErrors("`commit를` 이라고 쓴 예시").length, 0);
  assert.equal(findParticleErrors(["```", "commit를", "```"].join("\n")).length, 0);
  assert.equal(findParticleErrors("https://example.com/commit를").length, 0);
});

test("ext를 넘기면 문서 전용 가리개(들여쓰기 코드·<pre>/<code>)도 건드리지 않는다", () => {
  // maskProtected(text) 를 ext 없이 부르면 이 블록형 가리개가 하나도 안 걸린다 —
  // ext 를 그대로 전달해야 lint() 와 같은 범위로 코드를 가려낸다.
  const indented = "빈 줄 뒤:\n\n    git commit를 실행한다\n\n그 뒤 문장입니다.";
  assert.equal(findParticleErrors(indented, "md").length, 0);
  assert.equal(findParticleErrors(indented).length, 1, "ext 없이는 여전히 잡아야(하위 호환)");

  const pre = "<pre>json를 출력</pre>";
  assert.equal(findParticleErrors(pre, "md").length, 0);

  const { text, applied } = fixParticles(indented, "md");
  assert.equal(text, indented);
  assert.equal(applied.length, 0);
});

test("뒤에 한글이 이어지면 조사로 보지 않는다", () => {
  // "commit은행" 같은 자리에서 은을 조사로 잘라내면 안 된다.
  assert.equal(findParticleErrors("commit은행 이야기").length, 0);
});

test("긴 조사를 먼저 자른다", () => {
  // 으로서 를 으로 로 자르면 남은 서 때문에 어긋난다.
  const found = findParticleErrors("cache으로서 씁니다");
  assert.equal(found.length, 1);
  assert.equal(found[0].particle, "으로서");
  assert.equal(found[0].correct, "로서");
});

test("고친 결과가 올바르다", () => {
  const { text, applied } = fixParticles("commit를 확인하고 cache을 비웠습니다.");
  assert.equal(text, "commit을 확인하고 cache를 비웠습니다.");
  assert.equal(applied.length, 2);
});

test("여러 곳을 뒤에서부터 고쳐 위치가 어긋나지 않는다", () => {
  const { text } = fixParticles("S3을 보고 v1를 올리고 JSON로 바꿨습니다.");
  assert.equal(text, "S3를 보고 v1을 올리고 JSON으로 바꿨습니다.");
});

test("고칠 것이 없으면 원문을 그대로 돌려준다", () => {
  const input = "commit을 확인하고 cache를 비웠습니다.";
  const { text, applied } = fixParticles(input);
  assert.equal(text, input);
  assert.equal(applied.length, 0);
});

test("잘못된 입력에 안전하다", () => {
  assert.deepEqual(fixParticles(""), { text: "", applied: [] });
  assert.deepEqual(fixParticles(null), { text: "", applied: [] });
  assert.deepEqual(findParticleErrors(null), []);
});

test("메시지에 고칠 형태를 보여 준다", () => {
  const message = formatParticleErrors(findParticleErrors("commit를 확인"));
  assert.match(message, /"commit를" → "commit을"/);
  assert.equal(formatParticleErrors([]), "");
});

test("정상 한국어 문서에서 오탐이 없다", () => {
  const clean = [
    "commit을 머지하기 전에 test를 돌려 주세요.",
    "cache를 비우고 Redis를 다시 띄웠습니다.",
    "S3를 쓰고 EC2를 늘렸습니다.",
    "SQL을 고치고 API를 호출합니다.",
    "JSON으로 바꿔 stream을 흘려보냅니다.",
    "module을 쪼개고 hook을 붙였습니다.",
    "kubernetes를 쓰는지 terraform을 쓰는지 모르겠습니다.",
    "state를 바꾸고 props를 내려받아 target을 갱신합니다.",
    "race condition을 피하려고 deadlock을 검사합니다.",
    "latency를 줄이고 throughput을 늘렸습니다.",
  ];
  for (const sentence of clean) {
    assert.deepEqual(findParticleErrors(sentence), [], sentence);
  }
});

test("라틴 문자로 쓰기로 한 개발 명사 뒤 조사도 판정한다", () => {
  // 0.15.0 이후 문체가 상태/타깃 같은 개발 명사를 라틴 문자로 남기라고 하면서
  // 이 낱말들 뒤 조사가 판정 불가로 남았다 — 그 구멍을 메운다.
  assert.equal(correctParticle("state", "을"), "를", "스테이트");
  assert.equal(correctParticle("target", "를"), "을", "타깃/타겟 — ㅅ");
  assert.equal(correctParticle("deadlock", "를"), "을", "데드락 — ㄱ");
  assert.equal(correctParticle("directory", "을"), "를", "디렉터리");
  assert.equal(correctParticle("condition", "를"), "을", "(race) 컨디션 — ㄴ");
  assert.equal(correctParticle("latency", "을"), "를", "레이턴시");
  assert.equal(correctParticle("throughput", "를"), "을", "스루풋 — ㅅ");

  assert.equal(correctParticle("state", "를"), null, "이미 맞다");
  assert.equal(correctParticle("target", "을"), null, "이미 맞다");
  assert.equal(correctParticle("directory", "를"), null, "이미 맞다");
  assert.equal(correctParticle("condition", "을"), null, "이미 맞다");

  // 나머지 항목도 한 줄씩 고정한다. 받침 분류를 잘못 바꾸면 조사를 틀리게 고친다.
  const withFinal = ["regression", "limit", "return", "degradation", "sanitization"];
  const noFinal = ["props", "query", "handler", "middleware", "reducer", "effect", "truth", "check", "hatch", "change"];
  for (const word of withFinal) assert.equal(correctParticle(word, "를"), "을", word);
  for (const word of noFinal) assert.equal(correctParticle(word, "을"), "를", word);

  const found = findParticleErrors(
    "state을 바꿀 때 race condition를 조심하고 deadlock를 피해야 latency을 낮춘다."
  );
  assert.deepEqual(
    found.map((hit) => `${hit.word}${hit.particle}→${hit.word}${hit.correct}`),
    ["state을→state를", "condition를→condition을", "deadlock를→deadlock을", "latency을→latency를"]
  );

  assert.equal(findParticleErrors("`state을 이렇게 쓴 예시`").length, 0, "코드 안은 건드리지 않는다");
  assert.equal(
    findParticleErrors(["```", "target를", "```"].join("\n")).length,
    0,
    "코드 블록 안은 건드리지 않는다"
  );
});

test("ㄹ 받침 뒤에는 으로 대신 로를 쓴다", () => {
  // 서울로, 제주로. 다른 조사는 받침 유무만 보지만 으로/로 만 예외다.
  // 이 예외를 빼먹어 "1로" 를 "1으로" 로, "URL로" 를 "URL으로" 로 고치려 했다.
  assert.equal(correctParticle("1", "로"), null, "일 — ㄹ 받침");
  assert.equal(correctParticle("URL", "로"), null, "유알엘 — ㄹ");
  assert.equal(correctParticle("SQL", "로"), null, "에스큐엘 — ㄹ");
  assert.equal(correctParticle("module", "로"), null, "모듈 — ㄹ");
  assert.equal(correctParticle("7", "로"), null, "칠 — ㄹ");
});

test("ㄹ 이 아닌 받침에는 으로를 쓴다", () => {
  assert.equal(correctParticle("JSON", "로"), "으로", "제이슨 — ㄴ");
  assert.equal(correctParticle("commit", "로"), "으로", "커밋 — ㅅ");
  assert.equal(correctParticle("3", "로"), "으로", "삼 — ㅁ");
});

test("받침이 없으면 로를 쓴다", () => {
  assert.equal(correctParticle("cache", "으로"), "로");
  assert.equal(correctParticle("API", "으로"), "로");
  assert.equal(correctParticle("2", "으로"), "로", "이");
});

test("ㄹ 받침도 다른 조사에서는 받침으로 다룬다", () => {
  // 로 만 예외다. 을/를, 이/가 는 ㄹ 도 받침으로 본다.
  assert.equal(correctParticle("URL", "를"), "을");
  assert.equal(correctParticle("module", "가"), "이");
  assert.equal(correctParticle("1", "를"), "을", "일");
});

test("받침의 종류를 알려준다", () => {
  assert.equal(finalSoundOf("URL"), "ㄹ");
  assert.equal(finalSoundOf("commit"), "other");
  assert.equal(finalSoundOf("cache"), "");
  assert.equal(finalSoundOf("mycompanyservice"), null);
});

test("흔한 기술 낱말을 판정한다", () => {
  // 목록이 작으면 기능이 없는 것과 같다. 실제로 쓰는 낱말이 들어 있어야 한다.
  const cases = [
    ["Python", "other"], ["Kotlin", "other"], ["Terraform", "other"], ["Spring", "other"],
    ["GraphQL", "ㄹ"], ["Ansible", "ㄹ"], ["Gradle", "ㄹ"], ["XML", "ㄹ"], ["HTML", "ㄹ"],
    ["Kafka", ""], ["Kubernetes", ""], ["React", ""], ["Vue", ""], ["Java", ""],
    ["HTTPS", ""], ["gRPC", ""], ["Lambda", ""], ["DynamoDB", ""],
  ];
  for (const [word, expected] of cases) {
    assert.equal(finalSoundOf(word), expected, word);
  }
});

test("문서가 스스로를 예외로 선언하면 아무것도 보고하지 않는다", () => {
  // lint() 와 같은 기제를 쓴다. 한쪽만 표시를 존중하면 문체 가이드 문서에서 갈린다.
  const guide = "<!-- kimchi-ignore-file 나쁜 예를 인용한다 -->\ncommit를 라고 쓰면 틀립니다.";
  assert.deepEqual(findParticleErrors(guide), []);
  assert.equal(fixParticles(guide).text, guide);
});

// ── 계사·조사의 축약형 ────────────────────────────────────
//
// 였/이었, 예요/이에요, 여/이어, 랑/이랑도 앞말 받침이 형태를 가른다. 이 짝이 짝 표에
// 없어서 자동 교정이 "디펜던시였습니다" 같은 깨진 문장을 만들었다.

test("계사의 활용형도 받침에 맞춰 바로잡는다", () => {
  assert.equal(correctParticle("commit", "였"), "이었", "커밋 — ㅅ");
  assert.equal(correctParticle("cache", "이었"), "였", "캐시");
  assert.equal(correctParticle("commit", "예요"), "이에요");
  assert.equal(correctParticle("cache", "이에요"), "예요");
  assert.equal(correctParticle("commit", "이랑"), null, "받침 있음 — 이랑이 맞다");
  assert.equal(correctParticle("cache", "이랑"), "랑");
  assert.equal(correctParticle("commit", "여야"), "이어야");
  assert.equal(correctParticle("cache", "이어야"), "여야");
});

test("모르는 낱말 뒤 계사 활용형은 손대지 않는다", () => {
  assert.deepEqual(findParticleErrors("디펜던시였습니다."), []);
  assert.deepEqual(findParticleErrors("아이덤포턴트여야 합니다."), []);
  assert.deepEqual(findParticleErrors("컨커런시예요."), []);
  assert.deepEqual(findParticleErrors("디펜던시랑 얽혀 있습니다."), []);
});

// ── 대문자 두음자어: 글자로 읽는 것과 낱말로 읽는 것 ────────
//
// GET·PUT·DROP처럼 명령어로 읽는 두음자어를 API·SQL과 똑같이 "글자로 읽는다"고
// 판정해 "GET을"을 "GET를"로 잘못 고쳤다.

test("낱말로 읽히는 두음자어는 판정하지 않는다", () => {
  for (const word of ["GET", "PUT", "DROP", "LOCK", "STOP", "MAP", "JAR"]) {
    assert.equal(finalSoundOf(word), null, `${word} 는 낱말로 읽힐 수도 있어 판정할 수 없다`);
  }
});

test("모음이 없는 두음자어는 글자로 읽을 수밖에 없다", () => {
  assert.equal(hasFinalSound("HTTP"), false, "에이치티티피");
});

test("알려진 두음자어는 모음이 있어도 글자로 읽는다", () => {
  assert.equal(hasFinalSound("API"), false, "에이피아이");
  assert.equal(hasFinalSound("SQL"), true, "에스큐엘 — ㄹ");
});

test("실제 문장에서 GET/PUT/DROP 뒤 조사를 건드리지 않는다", () => {
  for (const sentence of ["GET을 호출합니다.", "PUT을 호출합니다.", "DROP을 실행합니다.", "MAP을 씁니다."]) {
    assert.deepEqual(findParticleErrors(sentence), [], sentence);
  }
});

// ── 숫자 뒤의 "여"(남짓)는 계사가 아니다 ──────────────────────
//
// "10여 개"의 "여"를 계사 짝으로 보고 "10이어 개"로 고친 적이 있다. 숫자 뒤에 붙는
// 한자 접미사(南짓)와 계사 활용형이 형태로 겹친다.

test("숫자 뒤의 여(남짓)는 계사로 판정하지 않는다", () => {
  for (const sentence of ["테스트 10여 개를 정리했습니다.", "100여 건을 처리했습니다."]) {
    assert.deepEqual(findParticleErrors(sentence), [], sentence);
    assert.equal(fixParticles(sentence).text, sentence, sentence);
  }
});

test("여야/여서도 숫자 뒤에서는 판정하지 않는다", () => {
  assert.equal(correctParticle("10", "여야"), null);
  assert.equal(correctParticle("10", "여서"), null);
  // 숫자가 아닌 낱말 뒤에서는 그대로 판정한다.
  assert.equal(correctParticle("commit", "여야"), "이어야");
});

// ── 같은 오류가 대량 반복될 때(결함 4) ────────────────────────

test("같은 조사 오류가 수천 번 반복돼도 메시지는 한 줄로 묶고 건수를 센다", () => {
  const text = "commit를 올렸습니다.\n".repeat(1000);
  const found = findParticleErrors(text);
  assert.equal(found.length, 1000, "탐지 자체는 전부 세야 한다");

  const message = formatParticleErrors(found);
  const bullets = message.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(bullets.length, 1, "종류가 하나면 줄도 하나여야 한다");
  assert.match(bullets[0], /"commit를" → "commit을".*총 1000곳/);
  assert.match(message, /1가지\(총 1000건\)/);
});

test("교정 종류가 많으면 목록에 상한을 두고 나머지는 개수로만 말한다", () => {
  // 받침 있는 낱말(을/를이 틀리는 자리)만 골라야 낱말마다 실제로 서로 다른 교정이
  // 하나씩 나온다 — LEXICON에서 받침 있는 낱말 25개를 모았다.
  const words = [
    "git", "commit", "webpack", "stack", "heap", "column", "function", "token",
    "session", "stream", "hook", "timeout", "callback", "python", "kotlin", "bun",
    "terraform", "spring", "tomcat", "maven", "storybook", "yarn", "pnpm", "iam", "cdn",
  ];
  const sentences = words.map((w) => `${w}를 확인`).join(" ");
  const found = findParticleErrors(sentences);
  assert.equal(found.length, words.length, "낱말마다 하나씩 잡혀야 시험 전제가 맞다");

  const message = formatParticleErrors(found);
  const bullets = message.split("\n").filter((line) => line.startsWith("- "));
  assert.ok(bullets.length < found.length, "상한 없이 종류마다 다 나열하면 안 된다");
  assert.match(message, /외 \d+가지 더/);
});

test("fixParticles 는 대량 반복 문서에서도 값이 맞다", () => {
  const text = "commit를 올렸습니다.\n".repeat(500);
  const fixed = fixParticles(text);
  assert.equal(fixed.applied.length, 500);
  assert.ok(!fixed.text.includes("commit를"), "고치지 않은 자리가 남았다");
  assert.equal((fixed.text.match(/commit을/g) || []).length, 500);
});
