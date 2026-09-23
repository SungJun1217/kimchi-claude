// 산출물에 섞인 주민등록번호를 찾는다.
//
// 말투 린터와 목적이 다르다. 말투는 고치면 되지만 주민등록번호는 한 번 푸시되면
// 커밋을 지워도 사라지지 않는다. 그래서 대상이 넓고(모든 파일) 기본 동작이 차단이다.
//
// 오탐을 줄이는 것이 이 파일의 절반이다. 13자리 숫자는 주문번호일 수도 있다.
// 패턴만으로 막으면 정상 작업을 방해하고, 그러면 사람들이 훅을 끈다.

// 주민등록번호 형태. 하이픈이나 공백이 있어도 잡는다.
//
// 경계를 직접 본다. \b 는 밑줄을 단어 문자로 보므로 `order_9001011234567` 같은 식별자 안에서
// 매치가 일어난다. 반대로 숫자만 배제하면 밑줄과 글자가 통과한다. 둘 다 막아야 한다.
const CANDIDATE = /(?<![0-9A-Za-z_])(\d{6})[-\s]?([1-8]\d{6})(?![0-9A-Za-z_])/g;

// 이 표시가 있는 줄은 넘어간다. 형식만 맞는 가짜 번호를 자료로 써야 할 때가 있다.
const ALLOW_LINE = /kimchi-allow-rrn/;

// 통째로 생성되는 파일. 확장자가 .json 이라 확장자 목록으로는 걸러지지 않는다.
export const GENERATED_FILES = /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|go\.sum)$/;

/**
 * 뒷자리가 임의 발급이라 검증은 못 한다. 앞자리의 생년월일이 말이 되는지만 본다.
 *
 * 이 검사로 오탐이 크게 줄어든다. 임의의 13자리 숫자가 앞 6자리에서 월 01~12 와
 * 일 01~31 을 동시에 만족할 확률은 낮다.
 *
 * @param {string} front 앞 6자리
 * @returns {boolean}
 */
function plausibleBirthDate(front) {
  const month = Number(front.slice(2, 4));
  const day = Number(front.slice(4, 6));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * 글에서 주민등록번호로 보이는 것을 찾는다.
 *
 * @param {string} text
 * @returns {{matched: string, line: number, column: number}[]}
 */
export function findResidentNumbers(text) {
  if (typeof text !== "string" || text.length === 0) return [];

  const found = [];
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (ALLOW_LINE.test(line)) continue;

    CANDIDATE.lastIndex = 0;
    let match;
    while ((match = CANDIDATE.exec(line)) !== null) {
      if (!plausibleBirthDate(match[1])) continue;
      found.push({ matched: match[0], line: index + 1, column: match.index + 1 });
    }
  }

  return found;
}

/**
 * 가릴 수 있는 형태로 바꿔 보여 준다.
 *
 * 경고 메시지에 번호를 그대로 실으면 훅이 유출 경로가 된다.
 *
 * @param {string} value
 * @returns {string}
 */
export function redact(value) {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length !== 13) return "*".repeat(String(value).length);
  return `${digits.slice(0, 6)}-*******`;
}

/**
 * 사람이 읽을 경고를 만든다.
 *
 * @param {{matched: string, line: number, column: number}[]} found
 * @param {string} label 검사 대상 이름
 * @returns {string}
 */
export function formatLeak(found, label = "") {
  if (found.length === 0) return "";

  const where = label ? `${label}에서 ` : "";
  const lines = [
    `${where}주민등록번호로 보이는 값 ${found.length}건을 찾았습니다. 저장소에 남으면 커밋을 지워도 사라지지 않습니다.`,
    "",
    ...found.map((hit) => `- ${hit.line}번째 줄 ${hit.column}칸: ${redact(hit.matched)}`),
    "",
    "할 일:",
    "- 시험 자료라면 형식만 맞는 가짜 번호를 쓰고, 그 줄에 kimchi-allow-rrn 주석을 붙이십시오.",
    "- 실제 값이라면 지우십시오. 주민등록번호는 법령에 근거가 없으면 수집·보관할 수 없습니다.",
    "- 본인 확인이 목적이라면 본인인증 기관의 CI 를 쓰십시오. korean-identifiers 스킬을 참고하십시오.",
  ];

  return lines.join("\n");
}
