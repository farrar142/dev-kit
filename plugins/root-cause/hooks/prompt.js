// UserPromptSubmit: 사용자 입력에 문제 신호(오류·장애·실패·4xx/5xx·Traceback …)가 있으면
// 「고치거나 넘기기 전에 근본 원인부터」 문맥을 넣는다. 막지는 않는다.
'use strict';
const { signalHits, disabled, readStdin } = require('./signals');

const CONTEXT = [
  'root-cause: 문제 신고다. 고치거나 넘기기 전에 증상 → 직접 원인 → 근본 원인(왜 처음 일어났나, 무엇이 바뀌었나)을 증거로 확인하라.',
  '증거는 시각 상관(언제부터·무엇과 같이), 변경 이력(배포·커밋·이미지·설정·의존성), 로그다. 경고로 낮추기·걸러내기·재시도는 원인을 찾은 뒤의 일이다.',
  '답에 `근본 원인:` 줄을 쓴다. 모르면 `근본 원인: 미확인 — <다음 확인할 것>`.',
  '`diagnosing-bugs` 스킬이 있으면 그것을 쓴다.',
].join('\n');

function contextFor(prompt) {
  if (disabled()) return null;
  const hits = signalHits(prompt || '');
  if (!hits.length) return null;
  return `${CONTEXT}\n(신호: ${hits.slice(0, 4).join(', ')})`;
}

module.exports = { contextFor, CONTEXT };

if (require.main === module) {
  readStdin((input) => {
    const ctx = contextFor(input.prompt);
    if (ctx) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }),
      );
    }
    process.exit(0);
  });
}
