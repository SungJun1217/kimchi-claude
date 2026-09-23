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
  assert.equal(hasFinalSound("MIDDLEWARE"), null, "네 글자를 넘는 대문자는 낱말로 읽힐 수 있다");
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
  ];
  for (const sentence of clean) {
    assert.deepEqual(findParticleErrors(sentence), [], sentence);
  }
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
