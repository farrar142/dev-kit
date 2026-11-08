// 워커 시험: 훅으로 받은 질문이 저장되고, 답이 그 터미널에 한 줄로 들어간다.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { InboxFile, WorkerIo } from './io.ts'
import { createWorker, deactivate, FOCUS_WAIT_MS } from './main.ts'
import { windowsCmdLine } from './node-io.ts'

/** 폴더·CLI 를 흉내 내는 가짜 io. runs 에 CLI 호출이 쌓인다. */
const fakeIo = (
  files: InboxFile[] = [],
  answer: (args: string[]) => { code: number | null; stdout: string; stderr: string; error?: string } = () => ({
    code: 0,
    stdout: '',
    stderr: '',
  }),
) => {
  const runs: { program: string; args: string[]; env: Record<string, string> }[] = []
  const removed: string[] = []
  const io: WorkerIo = {
    inboxDir: '/home/me/.question-panel/orca-inbox',
    listInbox: async () => files.filter(f => !removed.includes(f.name)),
    removeInbox: async name => {
      removed.push(name)
    },
    runCli: async (program, args, env) => {
      runs.push({ program, args, env })

      return answer(args)
    },
    pollMs: null,
  }

  return { io, runs, removed }
}

const worker = { default: createWorker(fakeIo().io), deactivate, FOCUS_WAIT_MS }

const ASK = {
  agent: 'claude',
  workspaceId: 'ws_1',
  terminalId: 'term_1',
  tool: 'mcp__plugin_question-panel_qp__ask',
  input: {
    questions: [
      { question: '어느 DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
    ],
  },
  output: '질문 묶음 q2을 패널에 올렸다.',
}

test('질문 도구 호출을 저장하고, 답을 그 터미널에 q-ID가 든 한 줄로 넣는다', async () => {
  const host = mockHost({ results: { 'terminal.sendText': { accepted: true } } })
  const w = await mountWorker(worker, { host })
  const d = await w.hooks.fire('agent.tool.after', ASK)
  assert.equal(d.kind, 'continue')
  const saved = (await w.request('qp.answer', { id: 'q2', terminalId: 'term_1', picks: [[1]] })) as {
    ok: boolean
  }
  assert.equal(saved.ok, true)
  assert.deepEqual(host.callsOf('terminal.sendText'), [
    { terminalId: 'term_1', text: '[질문 패널 답 q2] 1) 어느 DB? = SQLite [2]', enter: true },
  ])
  const again = (await w.request('qp.answer', { id: 'q2', terminalId: 'term_1', picks: [[1]] })) as { ok: boolean }
  assert.equal(again.ok, false, '보낸 묶음에 또 보내지 않는다')
})

test('다른 도구와 터미널 없는 호출은 저장하지 않고, 덜 고른 답은 보내지 않는다', async () => {
  const host = mockHost({ results: { 'terminal.sendText': { accepted: true } } })
  const w = await mountWorker(worker, { host })
  await w.hooks.fire('agent.tool.after', { ...ASK, tool: 'Bash' })
  await w.hooks.fire('agent.tool.after', { ...ASK, terminalId: undefined })
  const none = (await w.request('qp.answer', { id: 'q2', terminalId: 'term_1', picks: [[0]] })) as { ok: boolean }
  assert.equal(none.ok, false)
  await w.hooks.fire('agent.tool.after', ASK)
  const partial = (await w.request('qp.answer', { id: 'q2', terminalId: 'term_1', picks: [[]] })) as {
    ok: boolean
  }
  assert.equal(partial.ok, false)
  assert.deepEqual(host.callsOf('terminal.sendText'), [])
})

test('터미널이 답을 받지 않으면 묶음을 대기로 남긴다', async () => {
  const host = mockHost({ results: { 'terminal.sendText': { accepted: false } } })
  const w = await mountWorker(worker, { host })
  await w.hooks.fire('agent.tool.after', ASK)
  const r = (await w.request('qp.answer', { id: 'q2', terminalId: 'term_1', picks: [[0]] })) as { ok: boolean }
  assert.equal(r.ok, false)
  const stored = JSON.stringify(w.host.data().storage.batches)
  assert.match(stored, /"status":"pending"/)
})

// Orca 1.4.253: workspace.open 은 곧바로 돌아오고, 활성 worktree는 조금 뒤에 바뀐다.
// 여기서는 open 뒤 readContext 를 세 번 읽어야 포커스가 바뀐 것으로 흉내 낸다.
const focusHost = (switchAfterReads: number) => {
  let opened = false
  let reads = 0
  const focused = () => opened && reads >= switchAfterReads

  return mockHost({
    results: {
      'workspace.readContext': () => {
        if (opened) reads += 1

        return { branch: 'b', displayName: focused() ? '대상' : 'main', terminals: focused() ? [{ id: 'term_1' }] : [] }
      },
      'workspace.open': () => {
        opened = true

        return { opened: true }
      },
      'terminal.sendText': () => {
        if (!focused()) throw hostError('action_failed', 'terminal is outside the active worktree')

        return { accepted: true }
      },
    },
  })
}

test('포커스 밖 터미널이면 그 workspace를 열고 포커스가 바뀔 때까지 기다린 뒤 다시 보낸다', async () => {
  const host = focusHost(3)
  const w = await mountWorker(worker, { host })
  await w.hooks.fire('agent.tool.after', ASK)
  const r = (await w.request('qp.answer', { id: 'q2', terminalId: 'term_1', picks: [[0]] })) as { ok: boolean }
  assert.equal(r.ok, true)
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'ws_1' }])
  assert.equal(host.callsOf('terminal.sendText').length, 2)
  assert.ok(w.logs.some(l => l.includes('sendText 실패: action_failed: terminal is outside the active worktree')))
  assert.ok(w.logs.some(l => /포커스 바뀜\(\d+ms\), 다시 보냄/.test(l)))
  assert.ok(w.logs.some(l => l.includes('묶음 q2 보냄')))
})

test('포커스가 끝내 안 바뀌면 기다린 뒤 한 번 더 보내고, 실패 이유를 돌려준다', async () => {
  const host = focusHost(Number.POSITIVE_INFINITY)
  const w = await mountWorker(worker, { host })
  await w.hooks.fire('agent.tool.after', ASK)
  const r = (await w.request('qp.answer', { id: 'q2', terminalId: 'term_1', picks: [[0]] })) as {
    ok: boolean
    reason: string
  }
  assert.equal(r.ok, false)
  assert.match(r.reason, /workspace 밖입니다/)
  assert.equal(host.callsOf('terminal.sendText').length, 2)
  assert.ok(w.logs.some(l => l.includes(`${worker.FOCUS_WAIT_MS}ms 안에 포커스가 대상 터미널로 안 바뀜`)))
})

test('보내기 실패는 던지지 않고 이유를 돌려주며 로그에 남긴다', async () => {
  const host = mockHost({
    results: {
      'terminal.sendText': () => {
        throw hostError('action_failed', 'pty gone')
      },
    },
  })
  const w = await mountWorker(worker, { host })
  await w.hooks.fire('agent.tool.after', ASK)
  const r = (await w.request('qp.answer', { id: 'q2', terminalId: 'term_1', picks: [[0]] })) as {
    ok: boolean
    reason: string
  }
  assert.equal(r.ok, false)
  assert.match(r.reason, /pty gone/)
  assert.ok(w.logs.some(l => l.includes('hook mcp__plugin_question-panel_qp__ask terminalId=term_1')))
  assert.ok(w.logs.some(l => l.includes('qp.answer 받음 id=q2')))
})

test('질문을 저장할 때 터미널 제목과 workspace 이름도 적는다', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': { branch: 'b', displayName: 'data', terminals: [{ id: 'term_1', title: 'claude 질문' }] },
      'workspace.list': {
        workspaces: [{ id: 'ws_1', kind: 'worktree', name: 'Data', path: '/d', branch: 'main', hostId: null }],
        truncated: false,
      },
      'terminal.read': { lines: ['❯'], truncated: false },
    },
  })
  const w = await mountWorker(worker, { host })
  await w.hooks.fire('agent.tool.after', ASK)
  const [b] = (w.host.data().storage.batches ?? []) as { terminalTitle?: string; workspaceName?: string }[]
  assert.equal(b.terminalTitle, 'claude 질문')
  assert.equal(b.workspaceName, 'Data')
})

test('닫힌 터미널(terminal_handle_stale)의 묶음은 보내지 않고 닫힘으로 표시하며, 지울 수 있다', async () => {
  const host = mockHost({
    results: {
      'terminal.read': () => {
        throw hostError('action_failed', 'terminal_handle_stale')
      },
      'terminal.sendText': { accepted: true },
    },
  })
  const w = await mountWorker(worker, { host })
  await w.hooks.fire('agent.tool.after', ASK)
  const stored = () => (w.host.data().storage.batches ?? []) as { id: string; closed?: boolean }[]
  // 새 질문이 오면 다시 확인하므로 저장 직후 이미 닫힘이다.
  assert.equal(stored()[0].closed, true)
  const r = (await w.request('qp.answer', { id: 'q2', terminalId: 'term_1', picks: [[0]] })) as {
    ok: boolean
    reason: string
  }
  assert.equal(r.ok, false)
  assert.match(r.reason, /터미널이 닫혔습니다/)
  assert.equal(host.callsOf('terminal.sendText').length, 0)
  await w.request('qp.clearClosed', {})
  assert.equal(stored().length, 0)
})

test('refresh는 살아 있는 터미널을 닫힘으로 보지 않고, 권한 오류도 닫힘으로 보지 않는다', async () => {
  let alive = true
  const host = mockHost({
    results: {
      'terminal.read': () => {
        if (alive) throw hostError('permission_denied', 'no terminal:read')
        throw hostError('action_failed', 'terminal_handle_stale')
      },
    },
  })
  const w = await mountWorker(worker, { host })
  await w.hooks.fire('agent.tool.after', ASK)
  const stored = () => (w.host.data().storage.batches ?? []) as { id: string; closed?: boolean }[]
  assert.equal(stored()[0].closed, undefined)
  alive = false
  await w.request('qp.refresh', {})
  assert.equal(stored()[0].closed, true)
  await w.request('qp.remove', { id: 'q2', terminalId: 'term_1' })
  assert.equal(stored().length, 0)
})

test('terminal.read 가 거부 없이 빈 출력(exited)을 돌려줘도 닫힘으로 보고, 판정을 로그에 남긴다', async () => {
  let lines: string[] = ['❯ 질문']
  const host = mockHost({ results: { 'terminal.read': () => ({ lines, truncated: false }) } })
  const w = await mountWorker(worker, { host })
  await w.hooks.fire('agent.tool.after', ASK)
  const stored = () => (w.host.data().storage.batches ?? []) as { closed?: boolean }[]
  await w.request('qp.refresh', {})
  assert.equal(stored()[0].closed, undefined)
  lines = []
  await w.request('qp.refresh', {})
  assert.equal(stored()[0].closed, true)
  const r = (await w.request('qp.answer', { id: 'q2', terminalId: 'term_1', picks: [[0]] })) as { ok: boolean }
  assert.equal(r.ok, false)
  assert.equal(host.callsOf('terminal.sendText').length, 0)
})

// ── 채팅 세션(메일함 경로, 0.4.0) ─────────────────────────────────────────────

const INBOX = {
  name: 'q4-sess_1.json',
  text: JSON.stringify({
    v: 1,
    id: 'q4',
    createdAt: 5,
    questions: [
      { question: '어느 DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] },
      { question: '켤 기능', header: '', multiSelect: true, options: [{ label: '캐시', description: '' }, { label: '로그', description: '' }] },
    ],
    session: { id: 'sess_1', runId: 'run_xxxx' },
    orcaCli: '/opt/orca/bin/orca',
    userData: '/home/me/.config/orca',
    cwd: '/home/me/work/app',
  }),
}

const json = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: '' })

test('채팅 세션 질문 파일을 묶음으로 옮기고 파일을 지우며, 답은 그 세션 신원으로 Run 메일함에 보낸다', async () => {
  const f = fakeIo([INBOX, { name: 'bad.json', text: '{"v":1}' }], args =>
    args[1] === 'run-current'
      ? json({ ok: true, result: { run: { id: 'run_yyyy' } } })
      : json({ ok: true, result: { message: { id: 'msg_1' } } }),
  )
  const host = mockHost({})
  const w = await mountWorker({ default: createWorker(f.io), deactivate }, { host })
  await w.request('qp.refresh', {})
  assert.deepEqual(f.removed.sort(), ['bad.json', 'q4-sess_1.json'])
  const [b] = (w.host.data().storage.batches ?? []) as { id: string; terminalId: string; route: { kind: string } }[]
  assert.equal(b.id, 'q4')
  assert.equal(b.terminalId, 'orca_session_id:sess_1')
  assert.equal(b.route.kind, 'mailbox')
  assert.ok(w.logs.some(l => /bad\.json: 모양이 틀려 버림/.test(l)))
  assert.equal(host.callsOf('notifications.show').length, 1)

  const r = (await w.request('qp.answer', { id: 'q4', terminalId: 'orca_session_id:sess_1', picks: [[1], [0, 1]] })) as {
    ok: boolean
    via?: string
  }
  assert.equal(r.ok, true)
  // 질문 뒤 Run 이 바뀌었으면(run-current) 지금 Run 으로 보낸다.
  assert.equal(r.via, '메일함 run:run_yyyy')
  assert.equal(host.callsOf('terminal.sendText').length, 0)
  // refresh 의 run-current(세션이 살아 있나), 보내기 직전 run-current, send.
  assert.equal(f.runs.length, 3)
  for (const run of f.runs) {
    assert.equal(run.program, '/opt/orca/bin/orca')
    assert.deepEqual(run.env, {
      ORCA_AGENT_SESSION_ID: 'sess_1',
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_USER_DATA_PATH: '/home/me/.config/orca',
    })
  }
  assert.deepEqual(f.runs[2].args, [
    'orchestration',
    'send',
    '--to',
    'run:run_yyyy',
    '--subject',
    '[질문 패널 답] q4',
    '--body',
    'q4 1-2, 2-1, 2-2 / [질문 패널 답] 어느 DB? = SQLite / [질문 패널 답] 켤 기능 = 캐시, 로그',
    '--json',
  ])
  const [sent] = (w.host.data().storage.batches ?? []) as { status: string; via?: string }[]
  assert.equal(sent.status, 'sent')
  assert.equal(sent.via, '메일함 run:run_yyyy')
  await w.deactivate()
})

test('Run 에 묶이지 않은 채팅 세션은 세션 주소(orca_session_id:)로 보내고, run-current 를 못 읽으면 질문 때 Run 을 쓴다', async () => {
  const noRun = fakeIo([INBOX], args =>
    args[1] === 'run-current' ? json({ ok: true, result: { run: null } }) : json({ ok: true, result: { message: { id: 'msg_2' } } }),
  )
  const w1 = await mountWorker({ default: createWorker(noRun.io), deactivate }, { host: mockHost({}) })
  await w1.request('qp.refresh', {})
  const r1 = (await w1.request('qp.answer', { id: 'q4', terminalId: 'orca_session_id:sess_1', picks: [[0], [0]] })) as {
    via?: string
  }
  assert.equal(r1.via, '메일함 orca_session_id:sess_1')
  await w1.deactivate()

  const broken = fakeIo([INBOX], args =>
    args[1] === 'run-current' ? { code: 1, stdout: '', stderr: 'boom' } : json({ ok: true, result: { message: { id: 'msg_3' } } }),
  )
  const w2 = await mountWorker({ default: createWorker(broken.io), deactivate }, { host: mockHost({}) })
  await w2.request('qp.refresh', {})
  const r2 = (await w2.request('qp.answer', { id: 'q4', terminalId: 'orca_session_id:sess_1', picks: [[0], [0]] })) as {
    via?: string
  }
  assert.equal(r2.via, '메일함 run:run_xxxx')
  assert.ok(w2.logs.some(l => /run-current\(세션 sess_1\) 읽지 못함, 질문 때 값\(run_xxxx\)/.test(l)))
  await w2.deactivate()
})

test('메일 보내기가 실패하면 이유를 돌려주고 카드에 남기며 로그를 쓴다', async () => {
  const f = fakeIo([INBOX], args =>
    args[1] === 'run-current'
      ? json({ ok: true, result: { run: { id: 'run_xxxx' } } })
      : { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'no_active_sender_terminal', message: 'who?' } }), stderr: '' },
  )
  const w = await mountWorker({ default: createWorker(f.io), deactivate }, { host: mockHost({}) })
  await w.request('qp.refresh', {})
  const r = (await w.request('qp.answer', { id: 'q4', terminalId: 'orca_session_id:sess_1', picks: [[0], [0]] })) as {
    ok: boolean
    reason: string
  }
  assert.equal(r.ok, false)
  assert.match(r.reason, /메일함\(run:run_xxxx\)으로 보내지 못했습니다 — no_active_sender_terminal: who\?/)
  const [b] = (w.host.data().storage.batches ?? []) as { status: string; error?: string }[]
  assert.equal(b.status, 'pending')
  assert.equal(b.error, r.reason)
  assert.ok(w.logs.some(l => /메일 보내기 실패 → run:run_xxxx/.test(l)))
  await w.deactivate()
})

test('채팅 묶음은 터미널 닫힘을 보지 않는다', async () => {
  const f = fakeIo([INBOX])
  const host = mockHost({})
  const w = await mountWorker({ default: createWorker(f.io), deactivate }, { host })
  await w.request('qp.refresh', {})
  await w.request('qp.refresh', {})
  assert.equal(host.callsOf('terminal.read').length, 0)
  await w.deactivate()
})

test('Windows 의 .cmd 런처용 cmd.exe 한 줄: 인자를 따옴표로 감싸고 " % 줄바꿈을 바꾼다', () => {
  assert.equal(
    windowsCmdLine('C:\\Orca\\bin\\orca.cmd', ['send', '--body', 'a "b" 50% & c\nd', 'x\\']),
    '""C:\\Orca\\bin\\orca.cmd" "send" "--body" "a \'b\' 50％ & c d" "x\\\\""',
  )
})

// ── 0.4.1: 실제 출력 모양, 중복 방지, 정리 ────────────────────────────────────

const CHAT = 'orca_session_id:sess_1'
const line = (s: string) => ({ code: 0, stdout: `${s}\n`, stderr: '' })
type Stored = { id: string; status: string; error?: string; maybeSent?: boolean; closed?: boolean; route?: { runId: string | null } }

test('Windows 1.4.253 의 짧은 결과({ok,result:{messageId}}, {runId})를 성공·Run 으로 읽는다', async () => {
  const f = fakeIo([INBOX], args =>
    args[1] === 'run-current'
      ? line('{"ok":true,"result":{"runId":"run_xxxx","objective":"o"}}')
      : line('{"ok":true,"result":{"messageId":"msg_6e38a5a1a9b0"}}'),
  )
  const w = await mountWorker({ default: createWorker(f.io), deactivate }, { host: mockHost({}) })
  await w.request('qp.refresh', {})
  const r = (await w.request('qp.answer', { id: 'q4', terminalId: CHAT, picks: [[0], [0]] })) as { ok: boolean; via?: string }
  assert.equal(r.ok, true)
  assert.equal(r.via, '메일함 run:run_xxxx')
  assert.ok(w.logs.some(l => /메일 보냄 msg_6e38a5a1a9b0 → run:run_xxxx/.test(l)))
  const [b] = (w.host.data().storage.batches ?? []) as Stored[]
  assert.equal(b.status, 'sent')
  const again = (await w.request('qp.answer', { id: 'q4', terminalId: CHAT, picks: [[0], [0]] })) as { ok: boolean }
  assert.equal(again.ok, false, '보낸 묶음은 다시 보내지 않는다')
  assert.equal(f.runs.filter(x => x.args[1] === 'send').length, 1)
  await w.deactivate()
})

test('보내는 중에 또 누르면 두 번째는 보내지 않는다', async () => {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  const f = fakeIo([INBOX], args =>
    args[1] === 'run-current' ? line('{"ok":true,"result":{"runId":null}}') : line('{"ok":true,"result":{"messageId":"msg_1"}}'),
  )
  const slow: WorkerIo = {
    ...f.io,
    runCli: async (program, args, env) => {
      if (args[1] === 'send') await gate
      return f.io.runCli(program, args, env)
    },
  }
  const w = await mountWorker({ default: createWorker(slow), deactivate }, { host: mockHost({}) })
  await w.request('qp.refresh', {})
  const first = w.request('qp.answer', { id: 'q4', terminalId: CHAT, picks: [[0], [0]] }) as Promise<{ ok: boolean }>
  await new Promise(resolve => setTimeout(resolve, 20))
  const second = (await w.request('qp.answer', { id: 'q4', terminalId: CHAT, picks: [[0], [0]] })) as { ok: boolean; reason: string }
  assert.equal(second.ok, false)
  assert.match(second.reason, /이미 보내는 중/)
  open()
  assert.equal((await first).ok, true)
  assert.equal(f.runs.filter(x => x.args[1] === 'send').length, 1)
  await w.deactivate()
})

test('CLI가 돌았는데 결과를 모르면 「이미 보냈을 수 있음」을 남기고, 다시 보내면 지운다', async () => {
  let fail = true
  const f = fakeIo([INBOX], args =>
    args[1] === 'run-current'
      ? line('{"ok":true,"result":{"runId":"run_xxxx"}}')
      : fail
        ? { code: 1, stdout: '', stderr: 'socket hang up' }
        : line('{"ok":true,"result":{"messageId":"msg_2"}}'),
  )
  const w = await mountWorker({ default: createWorker(f.io), deactivate }, { host: mockHost({}) })
  await w.request('qp.refresh', {})
  const r = (await w.request('qp.answer', { id: 'q4', terminalId: CHAT, picks: [[0], [0]] })) as { ok: boolean; maybeSent?: boolean }
  assert.equal(r.ok, false)
  assert.equal(r.maybeSent, true)
  let [b] = (w.host.data().storage.batches ?? []) as Stored[]
  assert.equal(b.maybeSent, true)
  assert.match(b.error ?? '', /socket hang up/)
  fail = false
  const ok = (await w.request('qp.answer', { id: 'q4', terminalId: CHAT, picks: [[0], [0]] })) as { ok: boolean }
  assert.equal(ok.ok, true)
  ;[b] = (w.host.data().storage.batches ?? []) as Stored[]
  assert.equal(b.status, 'sent')
  assert.equal(b.maybeSent, undefined)
  assert.equal(b.error, undefined)
  await w.deactivate()
})

test('카드 지우기는 지운 기록에 남아 되돌릴 수 있고, 질문 폴더에 같은 파일이 남아 있어도 다시 뜨지 않는다', async () => {
  const f = fakeIo([INBOX], args => (args[1] === 'run-current' ? line('{"ok":true,"result":{"runId":"run_xxxx"}}') : line('{}')))
  // 파일 지우기가 안 되는 폴더(권한 등): 늘 같은 파일이 보인다.
  const sticky: WorkerIo = { ...f.io, listInbox: async () => [INBOX] }
  const w = await mountWorker({ default: createWorker(sticky), deactivate }, { host: mockHost({}) })
  await w.request('qp.refresh', {})
  assert.equal(((w.host.data().storage.batches ?? []) as Stored[]).length, 1)
  const r = (await w.request('qp.remove', { id: 'q4', terminalId: CHAT })) as { ok: boolean }
  assert.equal(r.ok, true)
  assert.equal(((w.host.data().storage.batches ?? []) as Stored[]).length, 0)
  assert.equal(((w.host.data().storage.dismissed ?? []) as unknown[]).length, 1)
  await w.request('qp.refresh', {})
  assert.equal(((w.host.data().storage.batches ?? []) as Stored[]).length, 0, '지운 묶음은 다시 뜨지 않는다')
  assert.ok(w.logs.some(l => /지운 묶음 q4이라 다시 띄우지 않고 버림/.test(l)))
  const u = (await w.request('qp.undoRemove', { id: 'q4', terminalId: CHAT })) as { ok: boolean }
  assert.equal(u.ok, true)
  const back = (w.host.data().storage.batches ?? []) as Stored[]
  assert.deepEqual(back.map(b => b.id), ['q4'])
  assert.equal(((w.host.data().storage.dismissed ?? []) as unknown[]).length, 0)
  const none = (await w.request('qp.undoRemove', { id: 'q4', terminalId: CHAT })) as { ok: boolean }
  assert.equal(none.ok, false)
  await w.deactivate()
})

test('채팅 세션이 Orca에 없으면(session_caller_unknown) 닫힘이고, 「닫힌 세션 질문 지우기」·「보낸 것 지우기」는 그것만 지운다', async () => {
  const gone = fakeIo([INBOX], args =>
    args[1] === 'run-current'
      ? { code: 1, stdout: '{"ok":false,"error":{"code":"session_caller_unknown","message":"No Orca agent session"}}', stderr: '' }
      : line('{}'),
  )
  const host = mockHost({
    results: { 'terminal.read': { lines: ['$'], truncated: false }, 'terminal.sendText': { accepted: true } },
  })
  const w = await mountWorker({ default: createWorker(gone.io), deactivate }, { host })
  await w.hooks.fire('agent.tool.after', ASK)
  await w.request('qp.refresh', {})
  const byId = () => Object.fromEntries(((w.host.data().storage.batches ?? []) as Stored[]).map(b => [b.id, b]))
  assert.equal(byId().q4.closed, true)
  assert.equal(byId().q2.closed, undefined)
  assert.ok(w.logs.some(l => /닫힘 판정 채팅 세션 sess_1: 닫힘\(session_caller_unknown\)/.test(l)))
  const no = (await w.request('qp.answer', { id: 'q4', terminalId: CHAT, picks: [[0], [0]] })) as { ok: boolean }
  assert.equal(no.ok, false)
  await w.request('qp.clearClosed', {})
  assert.deepEqual(Object.keys(byId()), ['q2'])
  await w.request('qp.answer', { id: 'q2', terminalId: 'term_1', picks: [[0]] })
  assert.equal(byId().q2.status, 'sent')
  await w.request('qp.clearSent', {})
  assert.deepEqual(Object.keys(byId()), [])
  assert.equal(((w.host.data().storage.dismissed ?? []) as unknown[]).length, 2)
  await w.deactivate()
})

test('쉬는 채팅 세션(session_caller_not_live)은 닫힘으로 보지 않는다', async () => {
  const f = fakeIo([INBOX], () => ({
    code: 1,
    stdout: '{"ok":false,"error":{"code":"session_caller_not_live","message":"x"}}',
    stderr: '',
  }))
  const w = await mountWorker({ default: createWorker(f.io), deactivate }, { host: mockHost({}) })
  await w.request('qp.refresh', {})
  const [b] = (w.host.data().storage.batches ?? []) as Stored[]
  assert.equal(b.closed, undefined)
  await w.deactivate()
})
