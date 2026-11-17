// 질문 패널 코어 시험: 가짜 어댑터와 메모리 저장소로 돈다. 닫힘 장부(Orca 연동)는 선택 어댑터다.
import { expect, test } from 'claude-code/testing'

import type { QuestionPanelBatch } from '../types'
import { createQuestionPanel, normalize } from './questions'
import type { LedgerLink, LedgerRecord, Store, SyncArgs } from './questions'
import { fakeHost, flush } from './testing'

const memory = <T,>(v: T): Store<T> & { value: () => T } => {
  let cur = v

  return {
    read: async () => cur,
    update: async fn => void (cur = fn(cur)),
    value: () => cur,
  }
}

const QUESTIONS = normalize([
  { question: '어느 DB?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
])

const setup = (ledger?: LedgerLink) => {
  const host = fakeHost()
  const queue = memory<QuestionPanelBatch[]>([])
  const draft = memory('')
  const notes: string[] = []
  const panel = createQuestionPanel({ queue, draft, host, ...(ledger === undefined ? {} : { ledger }), notify: t => notes.push(t) })
  if (typeof QUESTIONS === 'string') throw new Error(QUESTIONS)

  return { host, queue, draft, notes, panel, questions: QUESTIONS }
}

/** 메모리 장부: 배타 생성처럼 먼저 쓴 쪽만 이긴다. */
const memoryLedger = () => {
  const records = new Map<string, LedgerRecord>()
  const calls: SyncArgs[] = []
  const link: LedgerLink = {
    sync: async args => {
      calls.push(args)
      const out: { claimed?: boolean; holder?: LedgerRecord | null; closed: Record<string, LedgerRecord> } = { closed: {} }
      if (args.close !== undefined) {
        const c = args.close
        const had = records.get(c.key)
        out.claimed = had === undefined
        if (had === undefined) records.set(c.key, { key: c.key, id: '', state: c.state, by: c.by, at: 0 })
        else out.holder = had
      }
      for (const k of args.keys ?? []) {
        const r = records.get(k)
        if (r !== undefined) out.closed[k] = r
      }

      return out
    },
  }

  return { link, records, calls }
}

test('질문 패널 코어: 장부(Orca)가 없어도 쌓고 고르고 완료하면 세션에 답이 간다', async () => {
  const { host, queue, panel, questions } = setup()
  const { batch } = await panel.add({ questions, sessionId: 'sess-A', now: 1_000 })
  expect(batch).toMatchObject({ id: 'q1', status: 'pending', key: 'sess-A~q1~1000' })

  await panel.finish('q1')
  expect(host.turns).toEqual([])
  await panel.pick('q1', 0, 'SQLite')
  await panel.finish('q1')
  await flush()
  expect(host.turns).toEqual(['[질문 패널 답] 어느 DB? = SQLite'])
  expect(queue.value()[0]?.status).toBe('sent')

  await panel.poll()
  expect(host.turns).toHaveLength(1)
})

test('질문 패널 코어: 세션에 못 보내면 대기로 되돌리고 알린다', async () => {
  const { host, queue, notes, panel, questions } = setup()
  await panel.add({ questions, sessionId: 's', now: 1 })
  await panel.pick('q1', 0, 'Postgres')
  host.failNextSubmit()
  await panel.finish('q1')
  await flush()
  expect(queue.value()[0]?.status).toBe('pending')
  expect(notes).toEqual(['답을 보내지 못했습니다. 다시 완료를 눌러 주세요.'])
})

test('질문 패널 코어: 장부에 Orca 가 먼저 답했으면 완료는 보내지 않고 「Orca에서 답함」으로 둔다', async () => {
  const ledger = memoryLedger()
  const { host, queue, notes, panel, questions } = setup(ledger.link)
  const { batch } = await panel.add({ questions, sessionId: 's', now: 1 })
  ledger.records.set(batch.key ?? '', { key: batch.key ?? '', id: 'q1', state: 'answered', by: 'orca', at: 2 })

  await panel.pick('q1', 0, 'Postgres')
  await panel.finish('q1')
  await flush()
  expect(host.turns).toEqual([])
  expect(queue.value()[0]).toMatchObject({ status: 'sent', via: 'orca' })
  expect(notes[0]).toContain('Orca에서 답함')
})

test('질문 패널 코어: 장부를 읽어 Orca 에서 답 없이 닫은 묶음을 닫고 세션에 한 줄 알린다', async () => {
  const ledger = memoryLedger()
  const { host, queue, panel, questions } = setup(ledger.link)
  const { batch } = await panel.add({ questions, sessionId: 's', now: 1 })
  ledger.records.set(batch.key ?? '', { key: batch.key ?? '', id: 'q1', state: 'dismissed', by: 'orca', at: 2 })

  await panel.poll()
  await flush()
  expect(queue.value()[0]).toMatchObject({ status: 'sent', via: 'orca-dismissed' })
  expect(host.turns).toEqual(['[질문 패널 답] q1 답 없이 닫음(Orca)'])
})

test('질문 패널 코어: 대화창 글의 묶음 ID 로 닫으면 장부에 「대화창에서 답함」을 남긴다', async () => {
  const ledger = memoryLedger()
  const { queue, panel, questions } = setup(ledger.link)
  const { batch } = await panel.add({ questions, sessionId: 's', now: 1 })

  await panel.say('q1 2번')
  await flush()
  expect(queue.value()[0]).toMatchObject({ status: 'sent', via: 'chat' })
  expect(ledger.records.get(batch.key ?? '')).toMatchObject({ state: 'answered', by: 'chat' })
})
