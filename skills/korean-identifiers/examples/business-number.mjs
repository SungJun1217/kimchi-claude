// 사업자등록번호와 법인등록번호.
//
// 사업자등록번호는 검증할 수 있다. 체크섬이 살아 있다.
// 주민등록번호는 **검증할 수 없다.** 2020년 10월부터 뒷자리가 임의로 발급되어
// 기존 체크섬이 통하지 않는다. resident-number.mjs 를 참고할 것.

const BUSINESS_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5];

/**
 * 사업자등록번호를 검증한다. 10자리.
 *
 * 체크섬 규칙: 앞 9자리에 가중치 [1,3,7,1,3,7,1,3,5] 를 곱해 더하고,
 * 9번째 자리 × 5 의 십의 자리를 더한 뒤, (10 - 합 % 10) % 10 이 마지막 자리와 같아야 한다.
 *
 * @param {string} value 하이픈이 있어도 된다
 * @returns {boolean}
 */
export function isValidBusinessNumber(value) {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length !== 10) return false;

  const numbers = [...digits].map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += numbers[i] * BUSINESS_WEIGHTS[i];
  sum += Math.floor((numbers[8] * 5) / 10);

  return (10 - (sum % 10)) % 10 === numbers[9];
}

/**
 * 사업자등록번호를 표기 형식으로 바꾼다. `000-00-00000`
 * @param {string} value
 * @returns {string} 10자리가 아니면 입력을 그대로 돌려준다
 */
export function formatBusinessNumber(value) {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length !== 10) return String(value);
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/**
 * 법인등록번호를 검증한다. 13자리.
 *
 * 가중치가 1과 2를 번갈아 쓰고, 각 자리의 곱을 그대로 더한다.
 * 사업자등록번호와 규칙이 다르므로 같은 함수로 처리하지 말 것.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidCorporateNumber(value) {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length !== 13) return false;

  const numbers = [...digits].map(Number);
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += numbers[i] * (i % 2 === 0 ? 1 : 2);

  return (10 - (sum % 10)) % 10 === numbers[12];
}
