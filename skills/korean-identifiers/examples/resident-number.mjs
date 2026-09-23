// 주민등록번호.
//
// **이 파일에 검증 함수가 없는 것이 요점이다.**
//
// 2020년 10월부터 주민등록번호 뒷자리 중 지역 표시와 검증 번호가 없어지고 임의 번호로
// 발급된다. 그래서 오래 알려진 체크섬 알고리즘은 그 이후 발급된 번호에 통하지 않는다.
// 체크섬으로 검증하는 코드는 **정상 번호를 거부한다.** 한국 코드베이스에 아직 많이 남아
// 있는 버그이고, 새로 짤 때 가장 하기 쉬운 실수다.
//
// 그리고 애초에 저장하지 않는 것이 맞다. 개인정보 보호법은 법령에 근거가 있는 경우로
// 주민등록번호 처리를 제한한다. 근거 없이 수집하면 위법이다.
//
// 대신 이렇게 한다.
//   본인 확인이 필요하면      본인인증 기관의 CI/DI 를 받아 쓴다. 번호 자체를 보관하지 않는다
//   중복 가입을 막으려면      CI(연계정보)로 판단한다
//   나이 확인이 필요하면      생년월일이나 성인 여부만 받는다
//   실명 확인이 필요하면      본인인증 결과만 보관한다
//
// 정말로 법령 근거가 있어 보관해야 하면 암호화가 의무이고, 화면·로그·오류 보고에는
// 마스킹한 값만 나가야 한다. masking.mjs 를 참고할 것.

/**
 * 주민등록번호 형태를 띈 문자열을 찾는 패턴. 검증이 아니라 탐지용이다.
 *
 * \b 를 쓰지 않는다. 밑줄을 단어 문자로 보기 때문에 `order_9001011234567` 같은 식별자
 * 안에서 매치가 일어난다. 앞뒤 경계를 직접 본다.
 *
 * 전각 숫자와 전각 하이픈도 받는다. 한글 문서에서 복사한 번호가 그렇게 온다.
 * `\d` 는 ASCII 숫자만 받아서 전각이 한 글자만 섞여도 탐지를 빠져나간다.
 */
export const RESIDENT_NUMBER_PATTERN =
  /(?<![0-9０-９A-Za-z_])[0-9０-９]{6}[-－\s]?[1-8１-８][0-9０-９]{6}(?![0-9０-９A-Za-z_])/g;

// 전각 숫자를 반각으로 되돌리고 숫자만 남긴다.
const digitsOf = (value) => String(value ?? "").normalize("NFKC").replace(/\D/g, "");

/**
 * 형식만 확인한다. 유효한 번호인지는 알 수 없다.
 *
 * 쓸 자리는 하나다. 사용자가 입력란을 잘못 채웠을 때 즉시 알려 주는 것.
 * 이 함수가 true 를 준다고 실제로 존재하는 번호는 아니다.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeResidentNumber(value) {
  const digits = digitsOf(value);
  if (digits.length !== 13) return false;

  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  const genderDigit = Number(digits[6]);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  // 1~4 는 내국인, 5~8 은 외국인. 9·0 은 1900년 이전 출생으로 현재는 사실상 없다.
  return genderDigit >= 1 && genderDigit <= 8;
}

/**
 * 성별과 출생 연도를 뽑는다. 나이 확인에만 쓰고 번호는 버린다.
 *
 * @param {string} value
 * @returns {{birthYear: number, century: number}|null}
 */
export function birthYearOf(value) {
  const digits = digitsOf(value);
  if (!looksLikeResidentNumber(digits)) return null;

  const genderDigit = Number(digits[6]);
  // 1·2·5·6 → 1900년대, 3·4·7·8 → 2000년대
  const century = genderDigit === 1 || genderDigit === 2 || genderDigit === 5 || genderDigit === 6 ? 1900 : 2000;
  return { birthYear: century + Number(digits.slice(0, 2)), century };
}

/**
 * 글에 주민등록번호로 보이는 것이 섞여 있는지 찾는다.
 *
 * 로그, 오류 보고, 커밋 메시지, 시험 자료에 실수로 들어가는 것을 막는 데 쓴다.
 * 시험 자료에 실제 번호를 쓰지 말 것. 형식만 맞는 가짜 번호를 쓴다.
 *
 * @param {string} text
 * @returns {string[]} 찾은 문자열들
 */
export function findResidentNumbers(text) {
  if (typeof text !== "string") return [];
  // 형태만 맞는 것을 모두 보고하면 주문번호와 타임스탬프가 섞인다.
  // 앞 6자리가 말이 되는 생년월일인지까지 보면 오탐이 크게 줄어든다.
  return [...text.matchAll(RESIDENT_NUMBER_PATTERN)]
    .map((match) => match[0])
    .filter((value) => looksLikeResidentNumber(value));
}
