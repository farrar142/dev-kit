// 「근본 원인 줄」 정의 — gate.js(PreToolUse)·stop.js(Stop)가 함께 쓴다. 정의를 여기 한 곳에만 둔다.
//   - hasRootCause: 빈 값이 아닌 `근본 원인:`/`Root cause:` 줄 또는 `## 근본 원인` 절이 있는가
//   - assertedRootCauses: 단정한 `근본 원인:` 줄들(`해당 없음 — …`·`미확인 — …`은 단정이 아니다), 코드 펜스·인용 안은 뺀다
//   - hasEvidenceLine: 모양을 갖춘 `증거:` 줄이 있는가
'use strict';

const ROOT_LINE = /^[ \t>*_-]*(?:\*\*|__)?(?:근본\s?원인|root[ -]?cause)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*\S.{1,}/im;
const ROOT_HEAD = /^#{1,6}\s*(?:근본\s?원인|root[ -]?cause)[^\n]*\n+\s*\S/im;
const hasRootCause = (text) => ROOT_LINE.test(text) || ROOT_HEAD.test(text);

// 줄 앞 장식(들여쓰기·목록 표시·굵게)을 떼고 `<이름>: <값>` 을 읽는다. 인용(`>`)은 호출부에서 먼저 거른다.
const LEAD = String.raw`^[ \t]*(?:[*-][ \t]+)?(?:\*\*|__)?`;
const ROOT_VALUE = new RegExp(String.raw`${LEAD}(?:근본\s?원인|root[ -]?cause)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(\S.*)$`, 'i');
const EVIDENCE_VALUE = new RegExp(String.raw`${LEAD}(?:증거|evidence)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(\S.*)$`, 'i');
// 단정이 아닌 값: `해당 없음 — …`, `미확인 — …`
const NOT_ASSERTION = /^(?:해당\s?없음|미확인|n\/a|not applicable|unconfirmed|unknown)(?![0-9A-Za-z가-힣])/i;

// 코드 펜스(``` 또는 ~~~) 안과 인용(`>`) 줄을 뺀 줄들
function proseLines(text) {
  const out = [];
  let fence = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^[ \t]*>/.test(line)) continue;
    out.push(line);
  }
  return out;
}

function stripValue(v) {
  return v.replace(/(?:\*\*|__)\s*$/, '').trim();
}

// 단정한 `근본 원인:` 줄의 값들
function assertedRootCauses(text) {
  const out = [];
  for (const line of proseLines(text)) {
    const m = ROOT_VALUE.exec(line);
    if (!m) continue;
    const v = stripValue(m[1]);
    if (v.length < 2 || NOT_ASSERTION.test(v)) continue;
    out.push(v);
  }
  return out;
}

// 증거 값의 모양: 백틱 명령, 경로(/ \), #번호, 커밋 sha(16진 7자 이상), 시각 HH:MM, 파일:줄
const EVIDENCE_SHAPES = [
  /`[^`\n]+`/,
  /[/\\]/,
  /(?:^|[^\w&])#\d+\b/,
  /\b(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/i,
  /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/,
  /[\w.-]+\.\w+:\d+/,
];
const evidenceShaped = (v) => EVIDENCE_SHAPES.some((re) => re.test(v));

function hasEvidenceLine(text) {
  for (const line of proseLines(text)) {
    const m = EVIDENCE_VALUE.exec(line);
    if (m && evidenceShaped(stripValue(m[1]))) return true;
  }
  return false;
}

module.exports = { ROOT_LINE, ROOT_HEAD, hasRootCause, assertedRootCauses, hasEvidenceLine, evidenceShaped, proseLines };
