// node --test plugins/context-cap/tests
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'context-cap.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'context-cap-test-'));
let seq = 0;

const assistant = (tokens, extra = {}) => ({
  type: 'assistant',
  isSidechain: false,
  message: {
    model: 'm',
    usage: { input_tokens: 2, cache_read_input_tokens: tokens - 1002, cache_creation_input_tokens: 1000, output_tokens: 50 },
  },
  ...extra,
});
const user = { type: 'user', isSidechain: false, message: { role: 'user', content: 'x' } };

function transcript(lines, { padBytes = 0 } = {}) {
  const f = path.join(tmp, `t${++seq}.jsonl`);
  const pad = padBytes ? [{ type: 'user', isSidechain: false, message: { content: 'p'.repeat(padBytes) } }] : [];
  fs.writeFileSync(f, [...pad, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

function run(event, file, { env = {}, prompt, tool, input, session } = {}) {
  const payload = {
    hook_event_name: event,
    session_id: session || `s${++seq}`,
    transcript_path: file,
    prompt,
    tool_name: tool,
    tool_input: input,
  };
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { PATH: process.env.PATH, CONTEXT_CAP_STATE_DIR: path.join(tmp, 'state'), ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const CAPS = { CONTEXT_CAP_SOFT: '20000', CONTEXT_CAP_HARD: '30000' };

test('환경변수가 없으면 아무것도 하지 않는다', () => {
  const f = transcript([user, assistant(500000)]);
  assert.strictEqual(run('UserPromptSubmit', f, { prompt: '다음 티켓' }), null);
  assert.strictEqual(run('PreToolUse', f, { tool: 'Read', input: { file_path: '/x' } }), null);
  assert.strictEqual(run('PostToolUse', f, { tool: 'Read' }), null);
});

test('SOFT 아래면 통과', () => {
  const f = transcript([user, assistant(19000)]);
  assert.strictEqual(run('UserPromptSubmit', f, { env: CAPS, prompt: '다음 티켓' }), null);
  assert.strictEqual(run('PostToolUse', f, { env: CAPS, tool: 'Bash' }), null);
});

test('SOFT 위면 새 지시를 거절하고 토큰 수를 말한다', () => {
  const f = transcript([user, assistant(25000)]);
  const out = run('UserPromptSubmit', f, { env: CAPS, prompt: '다음 티켓 #12 해라' });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /25k/);
  assert.match(out.reason, /새 세션/);
});

test('SOFT 위라도 넘김 지시는 통과', () => {
  const f = transcript([user, assistant(25000)]);
  assert.strictEqual(run('UserPromptSubmit', f, { env: CAPS, prompt: '넘김 문서 써라' }), null);
  assert.strictEqual(run('UserPromptSubmit', f, { env: CAPS, prompt: 'write a HANDOFF doc' }), null);
});

test('SOFT 위면 PostToolUse 에서 한 번만 알린다', () => {
  const f = transcript([user, assistant(25000)]);
  const session = 'once';
  const first = run('PostToolUse', f, { env: CAPS, tool: 'Bash', session });
  assert.match(first.hookSpecificOutput.additionalContext, /새 세션 필요\(컨텍스트 25k\)/);
  assert.strictEqual(run('PostToolUse', f, { env: CAPS, tool: 'Bash', session }), null);
});

test('SOFT 위라도 HARD 아래면 PreToolUse 는 막지 않는다', () => {
  const f = transcript([user, assistant(25000)]);
  assert.strictEqual(run('PreToolUse', f, { env: CAPS, tool: 'Read', input: { file_path: '/x' } }), null);
});

test('HARD 위면 일반 도구는 막고 넘김·보고는 남긴다', () => {
  const f = transcript([user, assistant(31000)]);
  const deny = (tool, input) => run('PreToolUse', f, { env: CAPS, tool, input });
  const d = deny('Read', { file_path: '/x' });
  assert.strictEqual(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /넘김 문서를 쓰고 보고한 뒤 멈춰라/);
  assert.ok(deny('Edit', { file_path: '/repo/src/app.ts' }));
  assert.ok(deny('Bash', { command: 'npm test' }));
  assert.ok(deny('Bash', { command: 'git status && npm test' }));
  assert.ok(deny('Bash', { command: 'echo $(python3 x.py)' }));
  assert.ok(deny('Agent', { prompt: 'x' }));

  assert.strictEqual(deny('Write', { file_path: '/repo/docs/handoff-12.md' }), null);
  assert.strictEqual(deny('Edit', { file_path: '/repo/넘김.md' }), null);
  assert.strictEqual(deny('SendMessage', { to: 'main' }), null);
  assert.strictEqual(
    deny('Bash', { command: "cd /repo && git add -A && git commit -m \"$(cat <<'EOF'\n넘김; npm test\nEOF\n)\" && git push" }),
    null
  );
  assert.strictEqual(deny('Bash', { command: 'orca orchestration send --to run:x "새 세션 필요; 넘김"' }), null);
  assert.strictEqual(deny('Bash', { command: 'gh issue comment 3 --body-file /tmp/handoff.md' }), null);
});

test('CONTEXT_CAP_ALLOW_BASH 로 허용 조각을 더한다', () => {
  const f = transcript([user, assistant(31000)]);
  const env = { ...CAPS, CONTEXT_CAP_ALLOW_BASH: '^docker compose -p \\S+ down' };
  assert.strictEqual(run('PreToolUse', f, { env, tool: 'Bash', input: { command: 'docker compose -p w1 down' } }), null);
});

test('사이드체인 메시지는 세지 않는다', () => {
  const f = transcript([user, assistant(10000), assistant(90000, { isSidechain: true })]);
  assert.strictEqual(run('UserPromptSubmit', f, { env: CAPS, prompt: '다음' }), null);
  assert.strictEqual(run('PreToolUse', f, { env: CAPS, tool: 'Read', input: {} }), null);
});

test('compact 경계 뒤 아직 응답이 없으면 0으로 본다', () => {
  const f = transcript([user, assistant(90000), { type: 'system', subtype: 'compact_boundary', isSidechain: false }, user]);
  assert.strictEqual(run('UserPromptSubmit', f, { env: CAPS, prompt: '다음' }), null);
});

test('큰 transcript 도 끝에서부터 읽어 블록 경계를 넘는 줄을 맞게 잰다', () => {
  // 1MB 블록보다 긴 마지막 줄 + 앞에 큰 패딩
  const big = assistant(25000, { pad: 'z'.repeat(1.5 * 1024 * 1024) });
  const f = transcript([user, assistant(5000), user, big], { padBytes: 3 * 1024 * 1024 });
  const t0 = Date.now();
  const out = run('UserPromptSubmit', f, { env: CAPS, prompt: '다음' });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /25k/);
  assert.ok(Date.now() - t0 < 2000);
});

test('SOFT 를 처음 넘을 때 알림 명령을 한 번 돌린다', async () => {
  const f = transcript([user, assistant(25000)]);
  const mark = path.join(tmp, 'notified.txt');
  const env = { ...CAPS, CONTEXT_CAP_NOTIFY_CMD: `echo "$CONTEXT_CAP_TOKENS" >> ${mark}` };
  run('UserPromptSubmit', f, { env, prompt: '다음', session: 'notify' });
  run('PostToolUse', f, { env, tool: 'Bash', session: 'notify' });
  for (let i = 0; i < 50 && !fs.existsSync(mark); i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(fs.readFileSync(mark, 'utf8').trim(), '25000');
});

test('알림 명령이 실패해도 훅은 성공으로 끝난다', () => {
  const f = transcript([user, assistant(25000)]);
  const env = { ...CAPS, CONTEXT_CAP_NOTIFY_CMD: 'exit 7' };
  assert.strictEqual(run('UserPromptSubmit', f, { env, prompt: '다음' }).decision, 'block');
});

test('transcript 가 없거나 깨졌으면 통과', () => {
  assert.strictEqual(run('UserPromptSubmit', path.join(tmp, 'nope.jsonl'), { env: CAPS, prompt: '다음' }), null);
  const f = path.join(tmp, 'broken.jsonl');
  fs.writeFileSync(f, '{"type":"assistant", broken\n');
  assert.strictEqual(run('UserPromptSubmit', f, { env: CAPS, prompt: '다음' }), null);
});
