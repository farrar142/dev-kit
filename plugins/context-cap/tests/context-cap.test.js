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

function run(event, file, { env = {}, prompt, tool, input, session, agent } = {}) {
  const payload = {
    hook_event_name: event,
    session_id: session || `s${++seq}`,
    transcript_path: file,
    prompt,
    tool_name: tool,
    tool_input: input,
    ...agent,
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

test('환경변수도 에이전트도 없으면 아무것도 하지 않는다', () => {
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

test('SOFT 위라도 하네스가 넣는 배경 작업 알림(<task-notification>)은 통과', () => {
  const f = transcript([user, assistant(31000)]);
  // claude 2.1.318 에서 확인한 꼴: 배경 Bash 완료, Monitor 이벤트 모두 <task-notification> 으로 시작한다.
  const bash = '<task-notification>\n<task-id>b0hibq38k</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/x/tasks/b0hibq38k.output</output-file>\n<status>completed</status>\n<summary>Background command "CI 기다리기" completed (exit code 0)</summary>\n</task-notification>';
  const monitor = '<task-notification>\n<task-id>bhpz115bl</task-id>\n<summary>Monitor event: "ticks"</summary>\n<event>tick1</event>\n</task-notification>';
  assert.strictEqual(run('UserPromptSubmit', f, { env: CAPS, prompt: bash }), null);
  assert.strictEqual(run('UserPromptSubmit', f, { env: CAPS, prompt: monitor }), null);
  // 사람 지시에 태그가 끼어 있거나 중간에 있으면 그대로 막는다.
  const human = run('UserPromptSubmit', f, { env: CAPS, prompt: '다음 티켓 해라 <task-notification>' });
  assert.strictEqual(human.decision, 'block');
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

test('HARD 위라도 배경 대기 결과 읽기와 병합·배포 확인은 남긴다', () => {
  const f = transcript([user, assistant(31000)]);
  const call = (tool, input) => run('PreToolUse', f, { env: CAPS, tool, input });
  const ok = (tool, input) => assert.strictEqual(call(tool, input), null, `${tool} ${JSON.stringify(input)}`);
  ok('TaskOutput', { task_id: 'b0hibq38k' });
  ok('Read', { file_path: '/tmp/claude-1000/-proj/1234/tasks/b0hibq38k.output' });
  ok('Read', { file_path: 'C:\\Users\\u\\AppData\\Local\\Temp\\claude\\p\\s\\tasks\\a1.output' });
  ok('Read', { file_path: '/repo/docs/handoff-12.md' });
  ok('Bash', { command: 'python3 /home/u/.claude/plugins/x/scripts/wait-ci.py 31' });
  ok('Bash', { command: 'python3 scripts/wait-deploy.py --job app-deploy --pr 31 --repo o/r' });
  ok('Bash', { command: 'gh pr checks 31' });
  ok('Bash', { command: 'gh pr merge 31 --squash --delete-branch' });
  ok('Bash', { command: 'gh pr view 31 --json state,mergeCommit -q .mergeCommit.oid' });
  ok('Bash', { command: 'gh issue close 30 --comment "병합됨"' });
  ok('Bash', { command: 'gh run view 99 --log-failed > /tmp/x/ci.log 2>&1; echo exit=$?; tail -n 40 /tmp/x/ci.log' });
  ok('Bash', { command: 'git fetch -q origin && git rebase origin/main && git push --force-with-lease' });
  ok('Bash', { command: 'git pull --ff-only && git show --stat HEAD' });
  ok('Bash', { command: 'git -C /repo worktree remove --force /repo-wt && git branch -D fix-1 && git push origin --delete fix-1' });
  ok('Bash', { command: 'head -n 20 /tmp/x/tasks/a.output' });

  assert.ok(call('Read', { file_path: '/repo/src/app.ts' }));
  assert.ok(call('Read', { file_path: '/repo/tasks/notes.md' }));
  assert.ok(call('Bash', { command: 'gh api -X DELETE repos/o/r' }));
  assert.ok(call('Bash', { command: 'python3 scripts/build.py' }));
  assert.ok(call('Bash', { command: 'git reset --hard origin/main' }));
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

// --agent 본 세션: agent_type 만. 서브에이전트 안 도구 호출: agent_type + agent_id (claude 2.1.318 에서 확인).
const MAIN_WORKER = { agent_type: 'issue-worker' };

test('--agent issue-worker 본 세션은 환경변수 없이 기본값(250k/300k)으로 켜진다', () => {
  const below = transcript([user, assistant(240000)]);
  assert.strictEqual(run('UserPromptSubmit', below, { agent: MAIN_WORKER, prompt: '다음 티켓' }), null);
  const soft = transcript([user, assistant(260000)]);
  const out = run('UserPromptSubmit', soft, { agent: MAIN_WORKER, prompt: '다음 티켓' });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /260k/);
  assert.match(out.reason, /250k/);
  assert.strictEqual(run('PreToolUse', soft, { agent: MAIN_WORKER, tool: 'Read', input: { file_path: '/x' } }), null);
  const hard = transcript([user, assistant(310000)]);
  const deny = run('PreToolUse', hard, { agent: MAIN_WORKER, tool: 'Read', input: { file_path: '/x' } });
  assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /300k/);
});

test('플러그인 이름이 붙은 에이전트 이름도 끝 이름으로 맞춘다', () => {
  const f = transcript([user, assistant(260000)]);
  const out = run('UserPromptSubmit', f, { agent: { agent_type: 'issue-track:issue-worker' }, prompt: 'x' });
  assert.strictEqual(out.decision, 'block');
});

test('서브에이전트(agent_id 있음)와 다른 에이전트 본 세션은 기본값을 쓰지 않는다', () => {
  const f = transcript([user, assistant(500000)]);
  const sub = { agent_type: 'issue-worker', agent_id: 'a9015cd7bf2371b55' };
  assert.strictEqual(run('PreToolUse', f, { agent: sub, tool: 'Read', input: { file_path: '/x' } }), null);
  assert.strictEqual(run('PostToolUse', f, { agent: sub, tool: 'Read' }), null);
  assert.strictEqual(run('UserPromptSubmit', f, { agent: { agent_type: 'errand' }, prompt: 'x' }), null);
});

test('환경변수가 있으면 기본값보다 우선한다', () => {
  const f = transcript([user, assistant(25000)]);
  const out = run('UserPromptSubmit', f, { agent: MAIN_WORKER, env: CAPS, prompt: 'x' });
  assert.match(out.reason, /20k/);
  const big = transcript([user, assistant(260000)]);
  const onlyHard = run('UserPromptSubmit', big, { agent: MAIN_WORKER, env: { CONTEXT_CAP_HARD: '400000' }, prompt: 'x' });
  assert.strictEqual(onlyHard, null);
});

test('CONTEXT_CAP_SOFT=0 이면 issue-worker 본 세션도 끈다', () => {
  const f = transcript([user, assistant(500000)]);
  const off = { CONTEXT_CAP_SOFT: '0' };
  assert.strictEqual(run('UserPromptSubmit', f, { agent: MAIN_WORKER, env: off, prompt: 'x' }), null);
  assert.strictEqual(run('PreToolUse', f, { agent: MAIN_WORKER, env: off, tool: 'Read', input: { file_path: '/x' } }), null);
});

test('CONTEXT_CAP_AGENTS 로 기본 대상 목록을 바꾼다', () => {
  const f = transcript([user, assistant(260000)]);
  const env = { CONTEXT_CAP_AGENTS: 'tickworld-worker, other' };
  assert.strictEqual(run('UserPromptSubmit', f, { agent: MAIN_WORKER, env, prompt: 'x' }), null);
  const out = run('UserPromptSubmit', f, { agent: { agent_type: 'tickworld-worker' }, env, prompt: 'x' });
  assert.strictEqual(out.decision, 'block');
  assert.strictEqual(run('UserPromptSubmit', f, { agent: MAIN_WORKER, env: { CONTEXT_CAP_AGENTS: '' }, prompt: 'x' }), null);
});
