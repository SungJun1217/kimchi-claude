// 스킬에 담은 예시 코드를 검증한다.
//
// 이 시험이 없으면 스킬은 그냥 주장이다. 클로드가 그 코드를 그대로 가져다 쓰는데
// 동작하지 않으면 산문으로 설명하는 것보다 나쁘다.

import { test } from "node:test";
import assert from "node:assert/strict";

import { toChosung, initialOf, isChosungQuery, matches } from "../skills/korean-encoding/examples/chosung-search.mjs";
import {
  decompose,
  particleFor,
  normalizeForStorage,
  differsOnlyByNormalization,
} from "../skills/korean-encoding/examples/hangul-jamo.mjs";
import {
  normalizeWidth,
  cleanField,
  checkDigitCount,
  escapeForSpreadsheet,
  toExcelCsv,
} from "../skills/korean-encoding/examples/tabular.mjs";
import { withSubstitutes, addBusinessDays } from "../skills/korean-datetime/examples/substitute-holiday.mjs";
import {
  isValidBusinessNumber,
  formatBusinessNumber,
  isValidCorporateNumber,
} from "../skills/korean-identifiers/examples/business-number.mjs";
import * as residentNumber from "../skills/korean-identifiers/examples/resident-number.mjs";
import {
  maskName,
  maskResidentNumber,
  maskPhone,
  maskEmail,
  maskAccount,
  maskAddress,
} from "../skills/korean-identifiers/examples/masking.mjs";
import {
  parsePhone,
  formatPhone,
  toInternational,
  isSafeNumber,
} from "../skills/korean-formats/examples/phone.mjs";
import {
  isValidPostalCode,
  addressKind,
  splitReference,
  sameAddress,
} from "../skills/korean-formats/examples/address.mjs";

// ── 초성 검색 ────────────────────────────────────────────────

test("초성을 뽑는다", () => {
  assert.equal(toChosung("김치"), "ㄱㅊ");
  assert.equal(toChosung("찌개"), "ㅉㄱ");
  assert.equal(initialOf("빵"), "ㅃ");
  assert.equal(initialOf("값"), "ㄱ");
});

test("한글이 아닌 글자는 그대로 둔다", () => {
  // "iOS앱" 을 "iOSㅇ" 로 찾을 수 있어야 한다.
  assert.equal(toChosung("iOS앱"), "iOSㅇ");
  assert.equal(toChosung("v2 배포"), "v2 ㅂㅍ");
});

test("초성 질의인지 가른다", () => {
  assert.ok(isChosungQuery("ㄱㅊ"));
  assert.ok(isChosungQuery("ㄱ ㅊ"));
  assert.ok(!isChosungQuery("김"), "음절은 초성 질의가 아니다");
  assert.ok(!isChosungQuery("ㄱ치"));
  assert.ok(!isChosungQuery(""));
});

test("초성 질의와 보통 질의를 함께 처리한다", () => {
  assert.ok(matches("김치찌개", "ㄱㅊ"));
  assert.ok(matches("김치찌개", "김치"));
  assert.ok(!matches("된장찌개", "ㄱㅊ"));
  // 음절 질의를 초성으로 처리하면 "ㄱ" 으로 시작하는 모든 것이 걸려 방해가 된다.
  assert.ok(!matches("고추장", "김"));
  assert.ok(matches("아무것", ""), "빈 질의는 모두 통과");
});

// ── 자모와 조사 ──────────────────────────────────────────────

test("음절을 초성·중성·종성으로 나눈다", () => {
  // 겹받침은 유니코드에서 한 글자다. ㅂ + ㅅ 이 아니라 ㅄ 이다.
  assert.deepEqual(decompose("값"), { initial: "ㄱ", medial: "ㅏ", final: "ㅄ" });
  assert.deepEqual(decompose("가"), { initial: "ㄱ", medial: "ㅏ", final: "" });
  assert.equal(decompose("A"), null);
});

test("받침에 맞는 조사를 고른다", () => {
  assert.equal(particleFor("파일", "을/를"), "을");
  assert.equal(particleFor("캐시", "을/를"), "를");
  assert.equal(particleFor("계약", "이/가"), "이");
  assert.equal(particleFor("결합도", "이/가"), "가");
  assert.equal(particleFor("커밋", "은/는"), "은");
  assert.equal(particleFor("머지", "은/는"), "는");
});

test("으로/로 는 ㄹ 받침에서 예외다", () => {
  assert.equal(particleFor("서울", "으로/로"), "로", "ㄹ 받침 뒤에는 로");
  assert.equal(particleFor("제주", "으로/로"), "로");
  assert.equal(particleFor("집", "으로/로"), "으로");
});

test("한글로 끝나지 않으면 판정하지 않는다", () => {
  // 발음을 알 수 없다. 조사를 쓰지 않는 문장으로 바꾸는 편이 안전하다.
  assert.equal(particleFor("commit", "을/를"), null);
  assert.equal(particleFor("API", "이/가"), null);
  assert.equal(particleFor("", "을/를"), null);
});

test("정규화 형태만 다른 문자열을 알아낸다", () => {
  const nfc = "한글".normalize("NFC");
  const nfd = "한글".normalize("NFD");
  assert.notEqual(nfc, nfd, "두 형태가 실제로 다르다");
  assert.ok(differsOnlyByNormalization(nfc, nfd));
  assert.equal(normalizeForStorage(nfd), nfc);
  assert.ok(!differsOnlyByNormalization("한글", "한글"));
  assert.ok(!differsOnlyByNormalization("한글", "영문"));
});

// ── 대체공휴일 ──────────────────────────────────────────────

test("일요일과 겹친 공휴일은 다음 평일로 대체된다", () => {
  // 2026-03-01 은 일요일이다.
  const result = withSubstitutes([{ date: "2026-03-01", name: "삼일절" }]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[1], { date: "2026-03-02", name: "대체공휴일", substituteFor: "삼일절" });
});

test("토요일과 겹친 공휴일도 대체된다", () => {
  // 2026-08-15 는 토요일이다.
  const result = withSubstitutes([{ date: "2026-08-15", name: "광복절" }]);
  assert.equal(result.length, 2);
  assert.equal(result[1].date, "2026-08-17", "토·일을 건너뛴 월요일");
});

test("설과 추석은 토요일에 대체되지 않는다", () => {
  // 관공서의 공휴일에 관한 규정이 설·추석 연휴만 달리 다룬다.
  const saturday = withSubstitutes([{ date: "2026-08-15", name: "추석" }]);
  assert.equal(saturday.length, 1, "토요일이면 대체가 붙지 않는다");

  const sunday = withSubstitutes([{ date: "2026-03-01", name: "설날" }]);
  assert.equal(sunday.length, 2, "일요일이면 대체가 붙는다");
});

test("신정과 현충일에는 대체공휴일이 없다", () => {
  assert.equal(withSubstitutes([{ date: "2026-03-01", name: "신정" }]).length, 1);
  assert.equal(withSubstitutes([{ date: "2026-08-15", name: "현충일" }]).length, 1);
});

test("두 공휴일이 같은 날이면 대체가 붙는다", () => {
  // 2026-05-05 는 화요일이다. 겹침만으로 대체가 생긴다.
  const result = withSubstitutes([
    { date: "2026-05-05", name: "어린이날" },
    { date: "2026-05-05", name: "부처님오신날" },
  ]);
  assert.equal(result.filter((day) => day.name === "대체공휴일").length, 2);
});

test("대체일은 이미 공휴일인 날을 건너뛴다", () => {
  // 2026-03-01 일요일 + 다음 날도 공휴일이면 그다음 평일로 간다.
  const result = withSubstitutes([
    { date: "2026-03-01", name: "삼일절" },
    { date: "2026-03-02", name: "임시공휴일" },
  ]);
  const substitute = result.find((day) => day.name === "대체공휴일");
  assert.equal(substitute.date, "2026-03-03");
});

test("영업일을 더할 때 주말과 공휴일을 건너뛴다", () => {
  // 2026-03-05 는 목요일이다. 하나 더하면 금요일.
  assert.equal(addBusinessDays("2026-03-05", 1, new Set()), "2026-03-06");
  // 둘 더하면 주말을 건너뛴 월요일.
  assert.equal(addBusinessDays("2026-03-05", 2, new Set()), "2026-03-09");
  // 월요일이 공휴일이면 화요일.
  assert.equal(addBusinessDays("2026-03-05", 2, new Set(["2026-03-09"])), "2026-03-10");
});

// ── 사업자등록번호 ──────────────────────────────────────────

test("사업자등록번호 체크섬을 검증한다", () => {
  // 1234567891 의 검증 번호를 손으로 계산했다.
  // 가중치 [1,3,7,1,3,7,1,3,5] → 합 165, 9번째 자리 보정 +4 → 169, (10-9)%10 = 1
  assert.ok(isValidBusinessNumber("1234567891"));
  assert.ok(isValidBusinessNumber("123-45-67891"), "하이픈이 있어도 된다");
  assert.ok(!isValidBusinessNumber("1234567890"));
  assert.ok(!isValidBusinessNumber("123456789"), "9자리는 형식이 아니다");
  assert.ok(!isValidBusinessNumber(""));
});

test("사업자등록번호를 표기 형식으로 바꾼다", () => {
  assert.equal(formatBusinessNumber("1234567891"), "123-45-67891");
  assert.equal(formatBusinessNumber("123-45-67891"), "123-45-67891");
  assert.equal(formatBusinessNumber("짧다"), "짧다");
});

test("법인등록번호는 규칙이 달라 따로 검증한다", () => {
  // 1234567890120 의 검증 번호를 손으로 계산했다. 가중치 1·2 번갈이 → 합 70, (10-0)%10 = 0
  assert.ok(isValidCorporateNumber("1234567890120"));
  assert.ok(!isValidCorporateNumber("1234567890121"));
  assert.ok(!isValidCorporateNumber("1234567891"), "사업자번호를 넣으면 거부한다");
});

// ── 주민등록번호 ────────────────────────────────────────────

test("주민등록번호 검증 함수를 제공하지 않는다", () => {
  // 2020년 10월부터 뒷자리가 임의 발급이라 체크섬 검증이 통하지 않는다.
  // 검증 함수를 두면 정상 번호를 거부하는 코드가 퍼진다.
  const exported = Object.keys(residentNumber);
  const validators = exported.filter((name) => /^(isValid|validate|verify|checksum)/i.test(name));
  assert.deepEqual(validators, [], `검증으로 읽힐 이름이 있다: ${validators}`);
  assert.ok(exported.includes("looksLikeResidentNumber"), "형식 확인만 제공한다");
});

test("주민등록번호 형식만 확인한다", () => {
  assert.ok(residentNumber.looksLikeResidentNumber("900101-1234567"));
  assert.ok(residentNumber.looksLikeResidentNumber("9001011234567"));
  assert.ok(!residentNumber.looksLikeResidentNumber("901301-1234567"), "13월은 없다");
  assert.ok(!residentNumber.looksLikeResidentNumber("900132-1234567"), "32일은 없다");
  assert.ok(!residentNumber.looksLikeResidentNumber("900101-9234567"), "9는 현재 쓰이지 않는다");
  assert.ok(!residentNumber.looksLikeResidentNumber("900101-123456"));
});

test("성별 자리로 출생 연도를 판단한다", () => {
  assert.equal(residentNumber.birthYearOf("900101-1234567").birthYear, 1990);
  assert.equal(residentNumber.birthYearOf("050101-3234567").birthYear, 2005);
  assert.equal(residentNumber.birthYearOf("900101-5234567").birthYear, 1990, "외국인 1900년대");
  assert.equal(residentNumber.birthYearOf("050101-7234567").birthYear, 2005, "외국인 2000년대");
  assert.equal(residentNumber.birthYearOf("아무말"), null);
});

test("글에 섞인 주민등록번호를 찾아낸다", () => {
  const text = "사용자 900101-1234567 로 조회했습니다.";
  assert.deepEqual(residentNumber.findResidentNumbers(text), ["900101-1234567"]);
  assert.deepEqual(residentNumber.findResidentNumbers("주문 번호 12345678"), []);
  assert.deepEqual(residentNumber.findResidentNumbers(null), []);
});

// ── 마스킹 ──────────────────────────────────────────────────

test("이름을 마스킹한다", () => {
  assert.equal(maskName("홍길동"), "홍*동");
  assert.equal(maskName("김철수현"), "김**현");
  assert.equal(maskName("이도"), "이*", "두 글자는 뒤를 가린다");
  assert.equal(maskName("김"), "*");
  assert.equal(maskName(""), "");
});

test("주민등록번호는 뒷자리를 통째로 가린다", () => {
  // 성별 자리도 가린다. 생년월일과 성별이 함께 남으면 식별될 수 있다.
  assert.equal(maskResidentNumber("900101-1234567"), "900101-*******");
  assert.ok(!maskResidentNumber("900101-1234567").includes("1234567"));
});

test("전화번호와 전자우편을 마스킹한다", () => {
  assert.equal(maskPhone("010-1234-5678"), "010-****-5678");
  assert.equal(maskPhone("02-123-4567"), "02-****-4567");
  assert.equal(maskEmail("hong@example.com"), "ho**@example.com");
  assert.equal(maskEmail("ab@example.com"), "**@example.com");
  assert.equal(maskEmail("망가진주소"), "*****");
});

test("계좌와 카드는 뒤 네 자리만 남긴다", () => {
  assert.equal(maskAccount("1234-5678-9012-3456"), "************3456");
  assert.equal(maskAccount("123"), "***");
});

test("주소는 상세주소를 지운다", () => {
  assert.equal(maskAddress("서울 강남구 테헤란로 123 101동 202호"), "서울 강남구 테헤란로 123 ****");
  assert.equal(maskAddress("서울 강남구 테헤란로 123"), "서울 강남구 테헤란로 123");
});

// ── 전화번호 ────────────────────────────────────────────────

test("휴대전화를 알아본다", () => {
  assert.deepEqual(parsePhone("01012345678"), { kind: "휴대전화", parts: ["010", "1234", "5678"] });
  assert.equal(formatPhone("01012345678"), "010-1234-5678");
  // 2G 종료로 신규 발급은 없지만 아직 쓰는 번호가 있다.
  assert.equal(parsePhone("0111234567").kind, "휴대전화");
});

test("서울 지역번호는 두 자리다", () => {
  assert.deepEqual(parsePhone("0212345678"), { kind: "유선전화", parts: ["02", "1234", "5678"] });
  assert.deepEqual(parsePhone("021234567"), { kind: "유선전화", parts: ["02", "123", "4567"] });
  assert.equal(formatPhone("0212345678"), "02-1234-5678");
});

test("그 밖의 지역번호는 세 자리다", () => {
  assert.equal(formatPhone("03112345678"), "031-1234-5678");
  assert.equal(formatPhone("0641234567"), "064-123-4567");
});

test("대표번호는 지역번호가 없다", () => {
  assert.deepEqual(parsePhone("15771234"), { kind: "대표번호", parts: ["1577", "1234"] });
  assert.equal(formatPhone("1588-1234"), "1588-1234");
});

test("인터넷전화와 평생번호를 알아본다", () => {
  assert.equal(parsePhone("07012345678").kind, "특수번호");
  assert.deepEqual(parsePhone("050512345678"), { kind: "특수번호", parts: ["0505", "1234", "5678"] });
});

test("050 대역 전체를 받는다", () => {
  // 0505 만 받으면 오픈마켓 주문의 안심번호가 검증에서 떨어져 배송 알림이 못 나간다.
  for (const prefix of ["0502", "0503", "0504", "0505", "0506", "0507"]) {
    assert.ok(parsePhone(`${prefix}12345678`) !== null, prefix);
  }
});

test("안심번호를 따로 가른다", () => {
  // 유효 기간이 있어 회원 정보에 영구 보관하면 안 된다. 주문 단위로만 쓴다.
  assert.equal(parsePhone("050412345678").kind, "안심번호");
  assert.ok(isSafeNumber("0504-1234-5678"));
  assert.ok(!isSafeNumber("0505-1234-5678"), "0505 는 평생번호다");
  assert.ok(!isSafeNumber("010-1234-5678"));
  assert.equal(formatPhone("050412345678"), "0504-1234-5678");
});

test("알 수 없는 번호는 null 을 돌려준다", () => {
  assert.equal(parsePhone("1234"), null);
  assert.equal(parsePhone("09912345678"), null, "없는 접두사");
  assert.equal(parsePhone("아무말"), null);
});

test("고정 자리수로 검증하면 틀린다", () => {
  // 세 자리 지역번호와 두 자리 지역번호가 섞여 있어 하나의 패턴으로 검증할 수 없다.
  const fixed = /^\d{3}-\d{4}-\d{4}$/;
  assert.ok(!fixed.test("02-1234-5678"), "서울 번호를 거부한다");
  assert.ok(parsePhone("0212345678") !== null, "우리 파서는 받는다");
});

test("국제 형식으로 바꾼다", () => {
  assert.equal(toInternational("010-1234-5678"), "+821012345678");
  assert.equal(toInternational("02-1234-5678"), "+82212345678");
  // 국제 형식으로 들어온 것도 다시 처리할 수 있다.
  assert.equal(toInternational("+82-10-1234-5678"), "+821012345678");
  assert.equal(toInternational("아무말"), null);
});

// ── 주소 ────────────────────────────────────────────────────

test("우편번호는 다섯 자리다", () => {
  // 2015년 8월에 여섯 자리에서 다섯 자리로 바뀌었다.
  assert.ok(isValidPostalCode("06236"));
  assert.ok(!isValidPostalCode("135-080"), "옛 여섯 자리 형식");
  assert.ok(!isValidPostalCode("1234"));
});

test("도로명주소와 지번주소를 가른다", () => {
  assert.equal(addressKind("서울 강남구 테헤란로 123"), "도로명");
  assert.equal(addressKind("서울 강남구 역삼동 123-4"), "지번");
  assert.equal(addressKind("어딘가"), "알 수 없음");
});

test("참고항목을 떼어 낸다", () => {
  const { base, reference } = splitReference("서울 강남구 테헤란로 123 (역삼동, 아무빌딩)");
  assert.equal(base, "서울 강남구 테헤란로 123");
  assert.equal(reference, "역삼동, 아무빌딩");
  assert.deepEqual(splitReference("서울 강남구 테헤란로 123"), {
    base: "서울 강남구 테헤란로 123",
    reference: "",
  });
});

test("같은 주소를 정규화 형태와 무관하게 견준다", () => {
  const nfd = "서울 강남구 테헤란로 123".normalize("NFD");
  assert.ok(sameAddress("서울 강남구 테헤란로 123", nfd), "자모 분리 때문에 다르게 보인다");
  assert.ok(sameAddress("서울 강남구 테헤란로 123 (역삼동)", "서울강남구 테헤란로 123"));
  assert.ok(!sameAddress("테헤란로 123", "테헤란로 124"));
});

// ── 표 형식 자료 정제 ───────────────────────────────────────
//
// 이 절이 다루는 결함은 모두 예외를 던지지 않는다. 조용히 잘못된 값을 만들어 흘러간다.

test("전각 영숫자를 반각으로 바꾼다", () => {
  // 관공서 자료에 전각 숫자가 섞여 온다. \d 에 걸리지 않아 검증이 조용히 실패한다.
  assert.equal(normalizeWidth("１２３-４５-６７８９１"), "123-45-67891");
  assert.equal(normalizeWidth("ＡＢＣ"), "ABC");
  assert.equal(normalizeWidth("（주）"), "(주)", "한글은 건드리지 않는다");
  assert.equal(normalizeWidth(null), "");
});

test("보이지 않는 글자를 정리한다", () => {
  assert.equal(normalizeWidth("가 나"), "가 나", "줄바꿈 없는 공백");
  assert.equal(normalizeWidth("가　나"), "가 나", "전각 공백");
  assert.equal(normalizeWidth("가​나"), "가나", "폭 없는 공백");
  assert.equal(normalizeWidth("가﻿나"), "가나", "BOM");
});

test("자료 값을 비교할 수 있는 형태로 정제한다", () => {
  assert.equal(cleanField("  １２３  -​４５  "), "123 -45");
  assert.equal(cleanField("한글".normalize("NFD")), "한글", "NFC 로 모은다");
  assert.equal(cleanField(undefined), "");
});

test("앞자리 0 이 날아간 것을 알아낸다", () => {
  assert.deepEqual(checkDigitCount("0123456789", 10), { ok: true });
  const short = checkDigitCount("123456789", 10);
  assert.equal(short.ok, false);
  assert.match(short.reason, /채워 넣지 말고/, "복구하지 말라고 말해야 한다");
});

test("엑셀을 거쳐 훼손된 값을 알아낸다", () => {
  const broken = checkDigitCount("1.23457E+09", 10);
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /지수 표기/);
});

test("전각 숫자로 와도 자리 수를 센다", () => {
  assert.deepEqual(checkDigitCount("０１２３４５６７８９", 10), { ok: true });
});

test("스프레드시트 수식 주입을 막는다", () => {
  // 받는 사람의 기기에서 실행되므로 보안 문제다.
  for (const payload of ["=SUM(A1)", "+1+1", "-1+1", "@SUM(A1)"]) {
    assert.equal(escapeForSpreadsheet(payload), `'${payload}`, payload);
  }
  assert.equal(escapeForSpreadsheet("아무개상사"), "아무개상사", "보통 값은 건드리지 않는다");
  assert.equal(escapeForSpreadsheet(null), "");
});

test("엑셀에서 열리는 CSV 를 만든다", () => {
  const csv = toExcelCsv([["상호", "번호"], ["=cmd|calc", "0123456789"]]);
  assert.ok(csv.startsWith("﻿"), "BOM 이 없으면 엑셀이 CP949 로 읽는다");
  assert.ok(csv.includes("\r\n"), "줄바꿈이 CRLF 여야 한다");
  assert.ok(csv.includes("'=cmd|calc"), "수식 주입을 막아야 한다");
  assert.ok(csv.includes("0123456789"), "앞자리 0 이 살아 있어야 한다");
});

test("쉼표와 따옴표가 든 값을 감싼다", () => {
  const csv = toExcelCsv([['아무개, 상사', '따옴표 "있음"']]);
  assert.ok(csv.includes('"아무개, 상사"'));
  assert.ok(csv.includes('"따옴표 ""있음"""'));
});
