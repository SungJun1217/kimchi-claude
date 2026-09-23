// 관공서·은행 자료를 읽고 엑셀로 내보낼 때 필요한 정제.
//
// 이 파일이 다루는 결함은 모두 **예외를 던지지 않는다.** 조용히 잘못된 값을 만들어
// 끝까지 흘러간다. 그래서 입력 경계에서 정제하고, 어긋나면 멈추는 쪽이 낫다.

// 전각 영숫자와 기호는 U+FF01~U+FF5E 이고 반각과 0xFEE0 만큼 떨어져 있다.
const FULLWIDTH_START = 0xff01;
const FULLWIDTH_END = 0xff5e;
const FULLWIDTH_OFFSET = 0xfee0;

// 공백으로 보이지만 공백이 아닌 글자들. 관공서 자료와 웹에서 복사한 값에 섞인다.
const INVISIBLE_SPACES = /[   -   　]/g;
// 폭이 없어 눈에 보이지 않는 글자. 붙여넣기로 들어오고 비교를 깨뜨린다.
const ZERO_WIDTH = /[​-‍﻿⁠]/g;

/**
 * 전각 영숫자·기호를 반각으로 바꾸고, 보이지 않는 글자를 정리한다.
 *
 * 관공서 자료에 `１２３-４５-６７８９１` 처럼 전각 숫자가 섞여 온다. 눈으로는 구별하기
 * 어렵고 정규식 `\d` 에도 걸리지 않아서 검증이 조용히 실패한다.
 *
 * 한글과 한자는 건드리지 않는다. 전각이 정상인 글자다.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeWidth(text) {
  if (typeof text !== "string") return "";

  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    out +=
      code >= FULLWIDTH_START && code <= FULLWIDTH_END
        ? String.fromCodePoint(code - FULLWIDTH_OFFSET)
        : char;
  }
  return out.replace(INVISIBLE_SPACES, " ").replace(ZERO_WIDTH, "");
}

/**
 * 자료로 받은 값을 비교·저장할 수 있는 형태로 정제한다.
 *
 * 순서가 중요하다. 폭을 맞추고, 보이지 않는 글자를 지우고, 한글을 NFC 로 모으고,
 * 그다음에 공백을 다듬는다. 순서를 바꾸면 남는 것이 생긴다.
 *
 * @param {string} value
 * @returns {string}
 */
export function cleanField(value) {
  return normalizeWidth(String(value ?? ""))
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 앞자리 0 이 살아 있는지 확인한다.
 *
 * 한국 자료의 식별자는 대개 0 으로 시작한다. 사업자번호, 우편번호, 전화번호, 계좌번호.
 * 숫자로 읽으면 앞자리 0 이 날아가고, **받은 파일이 이미 엑셀을 거쳤으면 원본이 이미
 * 망가져 있다.** 지수 표기(`1.23457E+09`)로 바뀐 것도 있다.
 *
 * 0 을 채워 복구하려 들지 말 것. 잘못 채우면 다른 사업자의 번호가 된다.
 * 이상 자료로 표시해 담당자에게 되돌리는 것이 유일한 해결이다.
 *
 * @param {string} value 원본 문자열
 * @param {number} expectedDigits 있어야 하는 자리 수
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkDigitCount(value, expectedDigits) {
  const raw = String(value ?? "");
  if (/[eE]\+?\d/.test(raw)) {
    return { ok: false, reason: "지수 표기다. 엑셀을 거치며 원본이 훼손됐다" };
  }

  const digits = normalizeWidth(raw).replace(/\D/g, "");
  if (digits.length === expectedDigits) return { ok: true };
  if (digits.length < expectedDigits) {
    return {
      ok: false,
      reason: `${digits.length}자리다. 앞자리 0 이 날아간 것으로 보인다. 채워 넣지 말고 되돌릴 것`,
    };
  }
  return { ok: false, reason: `${digits.length}자리다. 자리 수가 많다` };
}

// 엑셀과 구글 스프레드시트가 수식으로 실행하는 첫 글자들.
const FORMULA_STARTERS = /^[=+\-@\t\r]/;

/**
 * 스프레드시트에 내보낼 값에서 수식 주입을 막는다.
 *
 * `=` `+` `-` `@` 로 시작하는 값을 엑셀이 수식으로 실행한다. 상호나 비고란에 실제로
 * 들어오고, 받는 사람의 기기에서 실행되므로 보안 문제다.
 *
 * 앞에 홑따옴표를 붙이면 엑셀이 문자열로 다룬다. 값 자체는 보이는 대로 남는다.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeForSpreadsheet(value) {
  const text = String(value ?? "");
  return FORMULA_STARTERS.test(text) ? `'${text}` : text;
}

/**
 * 엑셀에서 열리는 CSV 를 만든다.
 *
 * BOM 이 없으면 한국어 윈도의 엑셀이 CP949 로 읽어 한글이 깨진다. 파일 내용을 CP949 로
 * 바꾸는 방식은 쓰지 말 것 — 엑셀만 열리고 다른 도구가 깨진다.
 *
 * 줄바꿈은 CRLF 여야 엑셀이 제대로 나눈다.
 *
 * @param {string[][]} rows
 * @returns {string}
 */
export function toExcelCsv(rows) {
  const BOM = "﻿";
  const body = rows
    .map((row) =>
      row
        .map((cell) => {
          const safe = escapeForSpreadsheet(cell);
          // 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싸고 따옴표는 두 번 쓴다.
          return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        })
        .join(",")
    )
    .join("\r\n");

  return BOM + body;
}
