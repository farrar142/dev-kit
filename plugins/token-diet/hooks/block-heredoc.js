// PreToolUse(Bash): 큰 heredoc 이 든 명령을 스크립트 파일로 옮겨 `source <file>` 로 바꿔 실행한다.
// 한 사용자의 트랜스크립트 분석에서 heredoc 1,224건 중 파싱이 깨진 12건은 전부 7,600자 이상이었고,
// 6,000자 이하는 깨진 적이 없다. 짧은 heredoc(커밋 메시지·짧은 스크립트)은 그대로 둔다.
// source 로 같은 셸에서 실행하므로 cd·변수·heredoc 확장 등 의미는 원래 명령과 같다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_CHARS = 6000;
const DIR = path.join(os.tmpdir(), 'claude-heredoc');

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
  const toolInput = input.tool_input || {};
  const cmd = toolInput.command || '';

  // bash heredoc: <<EOF, <<'EOF', <<-"EOF" (<<< here-string, 1<<3 산술은 제외)
  const heredoc = /(^|[^<])<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(cmd);
  if (!heredoc || cmd.length <= MAX_CHARS) process.exit(0);

  try {
    fs.mkdirSync(DIR, { recursive: true });
    // 하루 지난 스크립트는 정리
    const dayAgo = Date.now() - 86400000;
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      if (fs.statSync(p).mtimeMs < dayAgo) fs.rmSync(p, { force: true });
    }
    const file = path.join(DIR, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.sh`);
    fs.writeFileSync(file, cmd.replace(/\r\n/g, '\n') + '\n', 'utf8');
    const posix = file.replace(/\\/g, '/');
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: `큰 heredoc(${cmd.length}자)을 ${posix} 로 옮겨 실행`,
          updatedInput: { ...toolInput, command: `source '${posix}'` },
        },
      })
    );
  } catch {
    // 변환에 실패하면 원래 명령을 그대로 실행시킨다
  }
  process.exit(0);
});
