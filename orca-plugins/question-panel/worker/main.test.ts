// 워커 시험: 훅으로 받은 질문이 저장되고, 답이 그 터미널에 한 줄로 들어간다.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import * as worker from './main.ts'

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
