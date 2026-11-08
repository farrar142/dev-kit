// 패널 시험: 저장된 묶음을 카드로 그리고, 다 고르면 「답 보내기」가 워커에 고른 번호를 보낸다.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel.tsx'

const BATCH = {
  id: 'q2',
  terminalId: 'term_1',
  workspaceId: 'ws_1',
  createdAt: 1,
  status: 'pending',
  questions: [
    {
      question: '어느 DB?',
      header: 'DB',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: '' },
        { label: 'SQLite', description: '파일 하나' },
      ],
    },
    {
      question: '켤 기능',
      header: '',
      multiSelect: true,
      options: [
        { label: '캐시', description: '' },
        { label: '로그', description: '' },
      ],
    },
  ],
}

test('대기 묶음이 없으면 빈 안내를 그린다', async () => {
  const p = await mount(panel, { host: mockHost({ storage: { batches: [] } }) })
  assert.match(p.summary().join('\n'), /대기 중인 질문이 없습니다/)
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.warnings, [])
  await p.unmount()
})

test('다 고르기 전에는 보내기가 꺼져 있고, 고르면 번호를 워커에 보낸다', async () => {
  const got: unknown[] = []
  const host = mockHost({
    storage: { batches: [BATCH] },
    requests: {
      'qp.answer': input => {
        got.push(input)

        return { ok: true, reason: '' }
      },
    },
  })
  const p = await mount(panel, { host })
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.warnings, [])
  const button = { type: 'Button', text: '답 보내기' }
  assert.equal(p.find(button)?.props.disabled, true)
  await p.select({ type: 'RadioGroup', label: '어느 DB?' }, '1')
  await p.toggle({ type: 'Checkbox', label: '로그' })
  assert.equal(p.find(button)?.props.disabled, false)
  await p.press(button)
  assert.deepEqual(got, [{ id: 'q2', terminalId: 'term_1', picks: [[1], [1]] }])
  await p.unmount()
})

test('워커가 실패 이유를 돌려주면 패널 위쪽과 카드에 보인다', async () => {
  const host = mockHost({
    storage: { batches: [BATCH] },
    requests: { 'qp.answer': { ok: false, reason: '터미널에 넣지 못했습니다 — x' } },
  })
  const p = await mount(panel, { host })
  await p.select({ type: 'RadioGroup', label: '어느 DB?' }, '0')
  await p.toggle({ type: 'Checkbox', label: '캐시' })
  await p.press({ type: 'Button', text: '답 보내기' })
  assert.equal(p.findAll({ type: 'Callout', text: /터미널에 넣지 못했습니다 — x/ }).length, 2)
  await p.unmount()
})

test('워커 요청이 거부돼도(예: unavailable) 이유가 보인다', async () => {
  const host = mockHost({
    storage: { batches: [BATCH] },
    requests: {
      'qp.answer': () => {
        throw hostError('unavailable', 'no worker')
      },
    },
  })
  const p = await mount(panel, { host })
  await p.select({ type: 'RadioGroup', label: '어느 DB?' }, '0')
  await p.toggle({ type: 'Checkbox', label: '캐시' })
  await p.press({ type: 'Button', text: '답 보내기' })
  assert.ok(p.find({ type: 'Callout', text: /워커에 닿지 못했습니다 \(unavailable\)/ }))
  await p.unmount()
})

test('카드에 workspace 이름·터미널 제목을 보이고, 닫힌 터미널 카드는 보내기를 막고 지우기를 준다', async () => {
  const removed: unknown[] = []
  let cleared = 0
  const host = mockHost({
    storage: {
      batches: [
        { ...BATCH, workspaceName: 'Data', terminalTitle: 'claude 질문' },
        { ...BATCH, terminalId: 'term_old', closed: true },
      ],
    },
    requests: {
      'qp.remove': input => {
        removed.push(input)

        return { ok: true, reason: '' }
      },
      'qp.clearClosed': () => {
        cleared += 1

        return { ok: true, reason: '' }
      },
    },
  })
  const p = await mount(panel, { host })
  assert.ok(p.find({ type: 'Text', text: /Data · claude 질문/ }))
  // 제목을 모르면 workspace id의 마지막 이름과 터미널 id로.
  assert.ok(p.find({ type: 'Text', text: /ws_1 · term_old/ }))
  assert.equal(p.findAll({ type: 'Badge', text: '터미널이 닫힘' }).length, 1)
  const sends = p.findAll({ type: 'Button', text: '답 보내기' })
  assert.equal(sends.length, 2)
  assert.equal(sends[1].props.disabled, true)
  await p.press({ type: 'Button', text: '지우기' })
  assert.deepEqual(removed, [{ id: 'q2', terminalId: 'term_old' }])
  await p.press({ type: 'Button', text: '닫힌 세션 질문 지우기 (1)' })
  assert.equal(cleared, 1)
  await p.unmount()
})

test('채팅 묶음 카드는 전달 경로(메일함)와 저장된 실패 이유를 보이고, 보내면 보낸 곳을 알린다', async () => {
  const chat = {
    ...BATCH,
    id: 'q5',
    terminalId: 'orca_session_id:sess_1',
    workspaceId: null,
    route: { kind: 'mailbox', sessionId: 'sess_1', runId: 'run_xxxx', cli: null, userData: null },
    cwd: '/home/me/app',
    error: '메일함(run:run_xxxx)으로 보내지 못했습니다 — boom',
  }
  const host = mockHost({
    storage: { batches: [chat] },
    requests: { 'qp.answer': { ok: true, reason: '', via: '메일함 run:run_xxxx' } },
  })
  const p = await mount(panel, { host })
  assert.ok(p.find({ type: 'Badge', text: '메일함 run:run_xxxx' }))
  assert.ok(p.find({ type: 'Text', text: /채팅 · app · 세션 sess_1/ }))
  assert.ok(p.find({ type: 'Callout', text: /boom/ }))
  assert.equal(p.findAll({ type: 'Badge', text: '터미널이 닫힘' }).length, 0)
  await p.select({ type: 'RadioGroup', label: '어느 DB?' }, '0')
  await p.toggle({ type: 'Checkbox', label: '캐시' })
  // 실패한 적이 있는 카드는 「다시 보내기」.
  await p.press({ type: 'Button', text: '다시 보내기' })
  assert.ok(p.find({ type: 'Callout', text: /q5 답을 보냈습니다 — 메일함 run:run_xxxx/ }))
  await p.unmount()
})

test('정리: 카드마다 ×로 바로 지우고 되돌리기를 띄우며, 위쪽 정리 버튼은 보낸 것·닫힌 세션을 지운다', async () => {
  const calls: [string, unknown][] = []
  const rec = (name: string) => (input: unknown) => {
    calls.push([name, input])

    return { ok: true, reason: '' }
  }
  const chatGone = {
    ...BATCH,
    id: 'q6',
    terminalId: 'orca_session_id:sess_2',
    workspaceId: null,
    closed: true,
    route: { kind: 'mailbox', sessionId: 'sess_2', runId: null, cli: null, userData: null },
  }
  const sent = { ...BATCH, id: 'q1', status: 'sent', sent: '[질문 패널 답 q1] …', via: '터미널' }
  const host = mockHost({
    storage: { batches: [BATCH, chatGone, sent] },
    requests: {
      'qp.remove': rec('remove'),
      'qp.undoRemove': rec('undo'),
      'qp.clearSent': rec('clearSent'),
      'qp.clearClosed': rec('clearClosed'),
    },
  })
  const p = await mount(panel, { host })
  assert.deepEqual(p.errors, [])
  assert.ok(p.find({ type: 'Badge', text: '채팅 세션이 없음' }))
  assert.ok(p.find({ type: 'Toolbar', label: '정리' }))
  await p.press({ type: 'IconButton', label: 'q2 카드 지우기' })
  assert.deepEqual(calls.at(-1), ['remove', { id: 'q2', terminalId: 'term_1' }])
  assert.ok(p.find({ type: 'Callout', text: /q2 카드를 지웠습니다/ }))
  await p.press({ type: 'Button', text: '되돌리기' })
  assert.deepEqual(calls.at(-1), ['undo', { id: 'q2', terminalId: 'term_1' }])
  assert.equal(p.findAll({ type: 'Callout', text: /q2 카드를 지웠습니다/ }).length, 0)
  await p.press({ type: 'Button', text: '답한 것·보낸 것 모두 지우기 (1)' })
  assert.deepEqual(calls.at(-1), ['clearSent', {}])
  await p.press({ type: 'Button', text: '닫힌 세션 질문 지우기 (1)' })
  assert.deepEqual(calls.at(-1), ['clearClosed', {}])
  await p.unmount()
})

test('앞선 보내기가 실제로는 갔을 수 있으면 경고하고 「다시 보내기」로 바꾼다', async () => {
  const chat = {
    ...BATCH,
    id: 'q7',
    terminalId: 'orca_session_id:sess_1',
    workspaceId: null,
    route: { kind: 'mailbox', sessionId: 'sess_1', runId: 'run_xxxx', cli: null, userData: null },
    error: '메일함(run:run_xxxx)으로 보내지 못했습니다 — orca 종료 코드 1',
    maybeSent: true,
  }
  const host = mockHost({
    storage: { batches: [chat] },
    requests: { 'qp.answer': { ok: false, reason: '메일함으로 보내지 못했습니다 — x', maybeSent: true } },
  })
  const p = await mount(panel, { host })
  assert.ok(p.find({ type: 'Callout', text: /이미 보냈을 수 있음|\[질문 패널 답\] q7/ }))
  await p.select({ type: 'RadioGroup', label: '어느 DB?' }, '0')
  await p.toggle({ type: 'Checkbox', label: '캐시' })
  await p.press({ type: 'Button', text: '다시 보내기' })
  assert.ok(p.find({ type: 'Callout', text: /실제로는 갔을 수 있습니다/ }))
  await p.unmount()
})
