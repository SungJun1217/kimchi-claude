import { test } from "node:test";
import assert from "node:assert/strict";
import { looksKorean, countHangul } from "../hooks/lib/detect.mjs";

test("한글 문자를 센다", () => {
  assert.equal(countHangul("결합도"), 3);
  assert.equal(countHangul("cache를"), 1);
  assert.equal(countHangul("hello"), 0);
  assert.equal(countHangul(null), 0);
});

test("한국어 문장을 한국어로 본다", () => {
  assert.ok(looksKorean("이 함수는 캐시를 새로 만듭니다."));
});

test("영어 문장을 한국어로 보지 않는다", () => {
  assert.ok(!looksKorean("This function rebuilds the cache on every call."));
});

test("한국어 파일명 하나로는 켜지지 않는다", () => {
  // 영어 커밋 메시지에 한글 파일명이 섞인 경우다. 이걸 한국어 문서로 보면 오작동한다.
  const text = "Rename 한글.txt to hangul.txt and update all of the import paths accordingly";
  assert.ok(!looksKorean(text));
});

test("한글이 두 자 이하면 켜지지 않는다", () => {
  assert.ok(!looksKorean("ok 네"));
});

test("들여쓰기가 많아도 비율이 눌리지 않는다", () => {
  const text = "\n\n        결합도를 낮추면 변경 범위가 줄어듭니다.\n\n";
  assert.ok(looksKorean(text));
});

test("빈 문자열과 잘못된 입력에 안전하다", () => {
  assert.ok(!looksKorean(""));
  assert.ok(!looksKorean(null));
  assert.ok(!looksKorean(undefined));
  assert.ok(!looksKorean(42));
});
