// 워커 시험: 훅으로 받은 질문이 저장되고, 답이 그 터미널에 한 줄로 들어간다.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as worker from './main.ts'

const ASK = {
  agent: 'claude',
  workspaceId: 'ws_1',
  terminalId: 'term_1',
  tool: 'mcp__question-panel__ask',
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
