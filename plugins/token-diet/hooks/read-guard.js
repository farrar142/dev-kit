// PreToolUse(Read): 큰 텍스트 파일을 limit 없이 통째로 읽으려 하면 막는다.
// 전체가 정말 필요하면 limit 을 명시하면 통과한다(의도적인 전체 읽기).
// 한도는 환경변수 READ_GUARD_MAX_LINES·READ_GUARD_MAX_BYTES 로 바꾼다.
const fs = require('fs');
const path = require('path');

const MAX_LINES = Number(process.env.READ_GUARD_MAX_LINES) || 1000;
const MAX_BYTES = Number(process.env.READ_GUARD_MAX_BYTES) || 80000;
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.pdf', '.ipynb']);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const inp = input.tool_input || {};
  const file = inp.file_path || '';
  if (inp.limit || inp.pages) process.exit(0);
  if (SKIP_EXT.has(path.extname(file).toLowerCase())) process.exit(0);

  let size, lines;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) process.exit(0);
    size = st.size;
    const buf = fs.readFileSync(file);
    lines = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
  } catch {
    process.exit(0);
  }
  const offset = inp.offset || 0;
  const remaining = Math.max(lines - Math.max(offset - 1, 0), 0);
  if (remaining <= MAX_LINES && size <= MAX_BYTES) process.exit(0);

  const reason =
    `read-guard: ${file} 는 ${lines}줄 / ${size.toLocaleString('en-US')}바이트입니다. 통째로 읽지 말고 ` +
    'Grep으로 필요한 위치를 먼저 찾은 뒤 offset/limit으로 그 부분만 읽으세요. ' +
    '정말 전체가 필요하면 limit을 명시해 다시 호출하면 통과합니다.';
  // JSON.stringify 는 비 ASCII 를 그대로 둔다. Windows 콘솔 인코딩에서 깨지지 않게 \u 이스케이프로 바꾼다.
  const out = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }).replace(/[\u0080-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  process.stdout.write(out);
  process.exit(0);
});
