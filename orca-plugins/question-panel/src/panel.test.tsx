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
