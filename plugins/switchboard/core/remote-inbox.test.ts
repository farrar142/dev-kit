// 원격 질문 — 대장 쪽(#112): 가짜 switchboard 서버(#106 댓글 「remote questions API」)와 진짜 질문 패널 코어(메모리 저장소)로
// 교환대를 돌린다. 서버 질문이 패널에 오르고, 패널 답이 서버로 가며, 대장 세션 자신에게는 턴으로 들어가지 않는다.
import { expect, test } from 'claude-code/testing'

import type { QuestionPanelBatch } from '../types'
import type { HttpInit } from './host'
import { EMPTY_GAP_MS } from './mailbox'
import { createQuestionPanel } from './questions'
import type { LedgerLink, LedgerRecord, Store, SyncArgs } from './questions'
import { isBossRole } from './remote-inbox'
import type { RemoteSink } from './remote-inbox'
import type { RemoteAnswer, RemoteItem, RemoteQuestion } from './remote-questions'
import { createSwitchboard } from './switchboard'
import type { Switchboard } from './switchboard'
import { fakeClock, fakeHost, flush } from './testing'
import type { FakeClock, FakeHost } from './testing'

const EP = 'http://mail.test'
const TOKEN = 'tok-SECRET-b'
const PROFILE = '/home/u/.config/switchboard/b.json'
const BOSS = 'team/lead'
const ASKER = 'team/worker-2'

const ITEMS: RemoteItem[] = [
  {
    header: 'DB',
    question: '어느 DB를 쓸까요?',
    options: [
      { label: 'Postgres', description: '관계형' },
      { label: 'SQLite', description: '파일형' },
    ],
    multiSelect: false,
  },
  { header: '기능', question: '넣을 기능은?', options: [{ label: '검색', description: '' }, { label: '알림', description: '' }], multiSelect: true },
]

type Mail = { id: number; to: string; sender: string; subject: string; body: string; task_id: string; status: 'pending' | 'read' }

/**
 * 가짜 서버: 메일 긴 대기(답 메일)와 질문 API(올리기·목록·poll·보기·답·거두기). down 이면 질문 API 가 연결 실패.
 * ownerOnly 면 묻는 쪽과 같은 base 의 답은 403(대표만 답하는 대장 자기 질문, #138).
 */
const fakeServer = () => {
  const questions: RemoteQuestion[] = []
  const answered: { id: string; role: string; body: unknown }[] = []
  const calls: string[] = []
  const mails: Mail[] = []
  let seq = 0
  let down = false
  let ownerOnly = false
  let waiters: (() => void)[] = []
  let mailWaiters: (() => void)[] = []
  /** 서버처럼 묻는 역할 앞으로 답 메일을 보낸다. */
  const mailAnswer = (q: RemoteQuestion) => {
    const lines = q.questions.map((item, i) => `${item.header}: ${item.question} = ${q.answers?.[i]?.selected.join(', ') ?? ''}`)
    mails.push({
      id: mails.length + 1,
      to: q.asker,
      sender: 'switchboard/system',
      subject: `[질문 답] ${q.id} ${q.questions[0]!.header}`,
      body: [...lines, `답한 쪽: ${q.answered_by}`].join('\n'),
      task_id: q.id,
      status: 'pending',
    })
    const w = mailWaiters
    mailWaiters = []
    for (const done of w) done()
  }
  const base = (role: string) => role.replace(/-\d+$/, '')
  const hex = (n: number) => n.toString(16).padStart(32, '0')
  const bump = (q: RemoteQuestion) => {
    q.seq = ++seq
    const w = waiters
    waiters = []
    for (const done of w) done()
  }
  const view = (q: RemoteQuestion, role: string) => ({ ...q, can_answer: q.status === 'pending' && base(q.asker) !== base(role) })

  const attach = (host: FakeHost, role: string) => {
    const authed = (init: HttpInit) => init.headers?.Authorization === `Bearer ${TOKEN}` && init.headers['X-Switchboard-Role'] === role
    host.http.route(`${EP}/api/messages/`, ({ url }: { url: string; init: HttpInit }) => {
      const m = /\/api\/messages\/(\d+)(\/read)?$/.exec(url)
      const mail = m === null ? undefined : mails.find(x => x.id === Number(m[1]))
      if (mail === undefined) return { status: 404 }
      mail.status = 'read'

      return { text: JSON.stringify({ id: mail.id, body: mail.body, status: 'read' }) }
    })
    host.http.route(`${EP}/api/events/poll`, async ({ url }: { url: string; init: HttpInit }) => {
      const q = new URL(url).searchParams
      const after = q.has('after') ? Number(q.get('after')) : -1
      const timeout = Number(q.get('timeout') ?? '25')
      const list = () => mails.filter(m => m.to === role && m.status === 'pending' && m.id > after)
      if (list().length === 0 && timeout > 0) {
        await new Promise<void>(done => {
          mailWaiters.push(done)
          host.clock.after(timeout * 1000, done)
        })
      }
      const events = list().map(m => ({ id: m.id, sender: m.sender, subject: m.subject, priority: 'normal', task_id: m.task_id }))

      return { text: JSON.stringify({ events, cursor: events.length > 0 ? events[events.length - 1]!.id : Math.max(after, 0) }) }
    })
    host.http.route(`${EP}/api/questions`, async ({ url, init }: { url: string; init: HttpInit }) => {
      if (!authed(init)) return { status: 401 }
      const path = url.slice(EP.length)
      calls.push(`${init.method ?? 'GET'} ${path.replace(/\?.*$/, '')}`)
      if (down) throw new Error('connect ECONNREFUSED')
      const u = new URL(url)
      if (u.pathname === '/api/questions/poll') {
        const after = Number(u.searchParams.get('after'))
        const timeout = Number(u.searchParams.get('timeout'))
        const list = () => questions.filter(q => q.seq > after).sort((a, b) => a.seq - b.seq)
        if (list().length === 0 && timeout > 0) {
          await new Promise<void>(done => {
            waiters.push(done)
            host.clock.after(timeout * 1000, done)
          })
        }
        if (down) throw new Error('connect ECONNREFUSED')
        const got = list()

        return { text: JSON.stringify({ questions: got.map(q => view(q, role)), cursor: got.length > 0 ? got[got.length - 1]!.seq : after }) }
      }
      if (u.pathname === '/api/questions' && init.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}') as { questions: RemoteItem[] }
        const q = ask(role, body.questions)

        return { status: 201, text: JSON.stringify(view(q, role)) }
      }
      const one = /^\/api\/questions\/(q_[0-9a-f]+)(\/withdraw)?$/.exec(u.pathname)
      if (one !== null) {
        const q = questions.find(x => x.id === one[1])
        if (q === undefined) return { status: 404, text: JSON.stringify({ error: 'not found' }) }
        if (one[2] === undefined) return { text: JSON.stringify(view(q, role)) }
        if (base(q.asker) !== base(role)) return { status: 403, text: JSON.stringify({ error: 'forbidden' }) }
        if (q.status !== 'pending') return { status: 409, text: JSON.stringify({ error: 'not pending' }) }
        q.status = 'withdrawn'
        bump(q)

        return { text: JSON.stringify(view(q, role)) }
      }
      if (u.pathname === '/api/questions' && (init.method ?? 'GET') === 'GET') {
        const status = u.searchParams.get('status')
        const limit = Number(u.searchParams.get('limit') ?? '100')
        const list = [...questions]
          .reverse()
          .filter(q => status === null || q.status === status)
          .slice(0, limit)

        return { text: JSON.stringify({ questions: list.map(q => view(q, role)) }) }
      }
      const m = /^\/api\/questions\/(q_[0-9a-f]+)\/answer$/.exec(u.pathname)
      const q = m === null ? undefined : questions.find(x => x.id === m[1])
      if (q === undefined) return { status: 404, text: JSON.stringify({ error: 'not found' }) }
      if (ownerOnly && base(q.asker) === base(role)) return { status: 403, text: JSON.stringify({ error: 'owner answers' }) }
      if (q.status !== 'pending') return { status: 409, text: JSON.stringify({ error: 'not pending' }) }
      const body = JSON.parse(init.body ?? '{}') as { answers: RemoteAnswer[] }
      answered.push({ id: q.id, role, body })
      q.status = 'answered'
      q.answers = body.answers
      q.answered_by = role
      bump(q)
      mailAnswer(q)

      return { text: JSON.stringify(view(q, role)) }
    })
  }

  /** 묻는 역할이 질문을 올린다. */
  const ask = (asker = ASKER, items = ITEMS) => {
    const q: RemoteQuestion = {
      id: `q_${hex(questions.length + 1)}`,
      asker,
      created_at: '2026-11-17T00:00:00Z',
      status: 'pending',
      questions: items,
      answers: null,
      answered_by: '',
      answered_at: null,
      withdrawn_at: null,
      seq: 0,
      can_answer: false,
    }
    questions.push(q)
    bump(q)

    return q
  }

  return {
    attach,
    questions,
    answered,
    calls,
    ask,
    mails,
    setDown: (v: boolean) => void (down = v),
    setOwnerOnly: (v: boolean) => void (ownerOnly = v),
    /** 대시보드가 먼저 답한다. */
    dashboard: (id: string) => {
      const q = questions.find(x => x.id === id)!
      q.status = 'answered'
      q.answers = q.questions.map(i => ({ selected: [i.options[0]!.label] }))
      q.answered_by = 'dashboard'
      bump(q)
      mailAnswer(q)
    },
    withdraw: (id: string) => {
      const q = questions.find(x => x.id === id)!
      q.status = 'withdrawn'
      bump(q)
    },
  }
}

const memory = <T,>(v: T): Store<T> & { value: () => T } => {
  let cur = v

  return { read: async () => cur, update: async fn => void (cur = fn(cur)), value: () => cur }
}

/** 메모리 장부(Orca 질문 패널이 쓰는 기록을 흉내 낸다). */
const memoryLedger = () => {
  const records = new Map<string, LedgerRecord>()
  const offers: NonNullable<SyncArgs['offer']>[] = []
  const link: LedgerLink = {
    sync: async args => {
      if (args.offer !== undefined) offers.push(args.offer)
      let claimed: boolean | undefined
      let holder: LedgerRecord | null | undefined
      if (args.close !== undefined) {
        const c = args.close
        const had = records.get(c.key)
        claimed = had === undefined
        if (had === undefined) records.set(c.key, { key: c.key, id: c.key.split('~')[1] ?? '', state: c.state, by: c.by, at: 1 })
        else holder = had
      }
      const closed: Record<string, LedgerRecord> = {}
      for (const k of args.keys ?? []) {
        const r = records.get(k)
        if (r !== undefined) closed[k] = r
      }

      return { ...(claimed === undefined ? {} : { claimed }), ...(holder === undefined ? {} : { holder }), closed }
    },
  }

  return { link, records, offers }
}

/** 대장(또는 아닌) 세션 하나: 교환대 + 진짜 질문 패널 코어. sink 는 register.tsx 의 remoteSink 와 같은 일을 한다. */
const session = async (server: ReturnType<typeof fakeServer>, clock: FakeClock, o: { role?: string; bosses?: string[]; isBoss?: boolean } = {}) => {
  const role = o.role ?? BOSS
  const host = fakeHost({ clock, identity: { machine: 'box-b', cwd: '/work/repo', sessionId: 'sess-b' } })
  host.fs.files.set(PROFILE, JSON.stringify({ endpoint: EP, role, token: TOKEN }))
  server.attach(host, role)
  // 새 서버(#130): whoami 가 is_boss 를 답한다. 없으면 라우트가 없어 404(옛 서버).
  const isBoss = o.isBoss
  if (isBoss !== undefined) {
    host.http.route(`${EP}/api/whoami`, () => ({
      text: JSON.stringify({ role, base: role.replace(/-\d+$/, ''), group: '', global_boss: isBoss, boss_of: [], is_boss: isBoss }),
    }))
  }
  const queue = memory<QuestionPanelBatch[]>([])
  const draft = memory('')
  const ledger = memoryLedger()
  const notes: string[] = []
  let board: Switchboard | undefined
  const panel = createQuestionPanel({
    queue,
    draft,
    host,
    ledger: ledger.link,
    notify: t => void notes.push(t),
    remote: { answer: async (id, answers) => (board === undefined ? { kind: 'failed', reason: 'off' } : board.answerRemote(id, answers)) },
  })
  const sink: RemoteSink = {
    offer: async q => {
      const b = await panel.addRemote({ q, sessionId: 'sess-b', now: await clock.now() })
      if (b !== null && b.key !== undefined && b.remote !== undefined) await ledger.link.sync({ offer: { id: b.id, key: b.key, questions: q.questions, remote: b.remote } })
    },
    close: async q => void (await panel.closeRemote(q.id, q.status === 'withdrawn' ? 'remote-withdrawn' : 'remote-answered')),
    prune: async open => void (await panel.pruneRemote(open)),
  }
  const logs: string[] = []
  board = createSwitchboard(host, {
    log: t => void logs.push(t),
    mail: { profilePath: PROFILE, log: t => void logs.push(t) },
    permissions: { waitMs: 0, bosses: o.bosses ?? [BOSS] },
    remoteQuestions: { sink, timeoutS: 25, retry: { firstMs: 1000, maxMs: 4000 }, idleMs: 30_000 },
  })
  await board.start()
  await settle(clock)

  return { host, board, panel, queue, ledger, notes, logs }
}

const settle = async (clock: FakeClock) => {
  for (let i = 0; i < 5; i++) {
    await flush()
    await clock.advance(EMPTY_GAP_MS)
  }
}

const pending = (q: QuestionPanelBatch[]) => q.filter(b => b.status === 'pending')

test('원격 질문 대장: 대장 판정은 번호 역할의 바탕으로 한다', () => {
  expect(isBossRole('team/lead-3', ['team/lead'])).toBe(true)
  expect(isBossRole('team/lead', ['team/lead-1'])).toBe(true)
  expect(isBossRole('team/worker', ['team/lead'])).toBe(false)
  expect(isBossRole(null, ['team/lead'])).toBe(false)
  expect(isBossRole('team/lead', [])).toBe(false)
})

test('원격 질문 대장: 시작할 때 대기 목록으로 채우고, 뒤에 온 질문은 poll 로 패널에 올린다(묻는 역할 표시·Orca 폴더에도)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const first = server.ask()
  // 대장 자신의 base 가 물은 것(can_answer false)도 자기 질문이라 올린다(#138).
  const own = server.ask('team/lead-2')
  const s = await session(server, clock)
  expect(s.queue.value().map(b => b.remote?.id)).toEqual([first.id, own.id])
  const b = s.queue.value()[0]!
  expect(b.remote).toEqual({ id: first.id, asker: ASKER })
  expect(b.questions.map(q => q.question)).toEqual(['어느 DB를 쓸까요?', '넣을 기능은?'])
  expect(b.questions[0]!.picked).toEqual([])
  expect(server.calls.some(c => c === 'GET /api/questions/poll')).toBe(true)

  const second = server.ask('other/dev')
  await settle(clock)
  expect(s.queue.value().map(b => b.remote?.id)).toEqual([first.id, own.id, second.id])
  expect(s.queue.value()[2]!.remote?.asker).toBe('other/dev')
  // 패널에 올린 묶음은 장부 도구로 Orca 질문 패널 폴더에도 남긴다.
  expect(s.ledger.offers.map(o => o.remote.id)).toEqual([first.id, own.id, second.id])
  expect(s.ledger.offers[0]!.key).toBe(b.key!)
  expect(s.host.turns).toEqual([])
  await s.board.stop()
})

test('원격 질문 대장: 같은 서버 id 는 두 번 올리지 않는다(poll 에 다시 와도, 다시 시작해도)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const q = server.ask()
  const s = await session(server, clock)
  // 같은 질문이 poll 에 다시 실려 온다(seq 가 올랐다).
  server.questions[0]!.seq = 0
  const again = server.questions[0]!
  again.seq = 99
  server.ask() // 깨운다
  await settle(clock)
  expect(s.queue.value().filter(b => b.remote?.id === q.id).length).toBe(1)
  // 교환대를 다시 띄워도(같은 패널 큐) 다시 올리지 않는다.
  await s.board.stop()
  await s.board.start()
  await settle(clock)
  expect(s.queue.value().filter(b => b.remote?.id === q.id).length).toBe(1)
  await s.board.stop()
})

test('원격 질문 대장: 패널에서 답하면 서버에 POST answer({selected, other}) 하고 닫는다 — 세션 턴으로는 넣지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const q = server.ask()
  const s = await session(server, clock)
  const id = s.queue.value()[0]!.id
  await s.panel.pick(id, 0, 'SQLite')
  await s.panel.pick(id, 1, '알림')
  await s.panel.typeOther(id, 1, '  둘 다 나중에  ')
  await s.panel.finish(id)
  await flush()
  expect(server.answered).toEqual([
    { id: q.id, role: BOSS, body: { answers: [{ selected: ['SQLite'] }, { selected: ['알림'], other: '둘 다 나중에' }] } },
  ])
  const b = s.queue.value()[0]!
  expect(b.status).toBe('sent')
  expect(b.via).toBeUndefined()
  // 장부에 닫힘을 남겨 Orca 카드도 닫힌다.
  expect(s.ledger.records.get(b.key!)?.by).toBe('claude')
  expect(s.host.turns).toEqual([])
  expect(s.notes.join('\n')).toContain('서버에 보냈습니다')
  // poll 로 돌아온 answered 는 이미 닫힌 묶음을 건드리지 않는다.
  await settle(clock)
  expect(s.queue.value()[0]!.via).toBeUndefined()
  await s.board.stop()
})

test('원격 질문 대장: 패널 답이 409(먼저 답함·거둠)면 「이미 답함·거둠」으로 닫는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const q = server.ask()
  const s = await session(server, clock)
  const id = s.queue.value()[0]!.id
  // 대시보드가 먼저 답했지만 poll 이 아직 알려 주기 전에 패널에서 누른다.
  server.questions[0]!.status = 'answered'
  await s.panel.pick(id, 0, 'Postgres')
  await s.panel.pick(id, 1, '검색')
  await s.panel.finish(id)
  await flush()
  expect(server.answered).toEqual([])
  expect(s.queue.value()[0]!.status).toBe('sent')
  expect(s.queue.value()[0]!.via).toBe('remote-taken')
  expect(s.notes.join('\n')).toContain('이미 답이 났거나 거둔')
  expect(s.host.turns).toEqual([])
  expect(q.answered_by).toBe('')
  await s.board.stop()
})

test('원격 질문 대장: 서버에 닿지 않으면 묶음을 대기로 되돌리고 알린다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  server.ask()
  const s = await session(server, clock)
  const id = s.queue.value()[0]!.id
  server.setDown(true)
  await s.panel.pick(id, 0, 'Postgres')
  await s.panel.pick(id, 1, '검색')
  await s.panel.finish(id)
  await flush()
  expect(s.queue.value()[0]!.status).toBe('pending')
  expect(s.notes.join('\n')).toContain('보내지 못했습니다')
  expect(s.host.turns).toEqual([])
  server.setDown(false)
  await s.board.stop()
})

test('원격 질문 대장: poll 에 answered(대시보드)·withdrawn(묻는 쪽)이 오면 패널에서 닫는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const a = server.ask()
  const w = server.ask('other/dev')
  const s = await session(server, clock)
  expect(pending(s.queue.value()).length).toBe(2)
  server.dashboard(a.id)
  await settle(clock)
  server.withdraw(w.id)
  await settle(clock)
  const byRemote = (rid: string) => s.queue.value().find(b => b.remote?.id === rid)!
  expect(byRemote(a.id).status).toBe('sent')
  expect(byRemote(a.id).via).toBe('remote-answered')
  expect(byRemote(w.id).via).toBe('remote-withdrawn')
  expect(s.ledger.records.get(byRemote(w.id).key!)?.state).toBe('dismissed')
  expect(s.host.turns).toEqual([])
  await s.board.stop()
})

test('원격 질문 대장: 다시 시작할 때 서버에서 대기가 아니게 된 묶음은 닫는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const a = server.ask()
  const s = await session(server, clock)
  await s.board.stop()
  // 꺼진 사이 대시보드가 답했다.
  server.dashboard(a.id)
  await s.board.start()
  await settle(clock)
  expect(s.queue.value()[0]!.via).toBe('remote-taken')
  await s.board.stop()
})

test('원격 질문 대장: 대장 역할이 아니면 질문 API 를 부르지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  server.ask()
  const worker = await session(server, clock, { role: 'team/worker' })
  await clock.advance(120_000)
  await settle(clock)
  expect(server.calls).toEqual([])
  expect(worker.queue.value()).toEqual([])
  await worker.board.stop()
  // 대장 목록이 비어도 끈다.
  const none = await session(server, clock, { bosses: [] })
  await clock.advance(120_000)
  expect(server.calls).toEqual([])
  await none.board.stop()
})

test('원격 질문 대장: 연결 실패는 간격을 늘려 다시 해 보고, 끄면 루프와 타이머를 정리한다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  server.setDown(true)
  const s = await session(server, clock)
  const tries = () => server.calls.filter(c => c === 'GET /api/questions').length
  expect(tries()).toBeGreaterThan(0)
  // 간격이 상한(4초)까지 늘었다: 40초 동안 다시 해 보는 것은 열 번 안팎(1초 간격이었다면 40번).
  const at0 = tries()
  await clock.advance(40_000)
  await flush()
  expect(tries() - at0).toBeGreaterThanOrEqual(9)
  expect(tries() - at0).toBeLessThanOrEqual(11)
  expect(s.logs.some(l => l.includes('원격 질문을 못 읽음'))).toBe(true)
  // 다시 닿으면 채운다.
  server.setDown(false)
  const q = server.ask()
  await clock.advance(4000)
  await settle(clock)
  expect(s.queue.value().map(b => b.remote?.id)).toEqual([q.id])
  await s.board.stop()
  const before = server.calls.length
  await clock.advance(600_000)
  await flush()
  // 끈 뒤에는 (걸려 있던 긴 대기 하나가 끝난 것 말고) 새 요청이 없다.
  expect(server.calls.length - before).toBeLessThanOrEqual(0)
})

test('원격 질문 대장: Orca 사이드바에서 답하면(장부 기록에 실린 답) 서버로 보내고 세션에는 넣지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const q = server.ask()
  const s = await session(server, clock)
  const b = s.queue.value()[0]!
  // Orca 질문 패널 0.7.0 이 원격 카드 답을 장부에 남긴다.
  s.ledger.records.set(b.key!, {
    key: b.key!,
    id: b.id,
    state: 'answered',
    by: 'orca',
    at: 2,
    answers: [{ selected: ['Postgres'] }, { selected: [], other: '나중에' }],
  })
  await s.panel.poll()
  await flush()
  expect(server.answered).toEqual([{ id: q.id, role: BOSS, body: { answers: [{ selected: ['Postgres'] }, { selected: [], other: '나중에' }] } }])
  expect(s.queue.value()[0]!.via).toBe('orca')
  expect(s.host.turns).toEqual([])
  await s.board.stop()
})

test('원격 질문 대장: 원격 묶음을 답 없이 닫거나 대화창 글로 언급해도 세션·서버에 보내지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  server.ask()
  const s = await session(server, clock)
  const id = s.queue.value()[0]!.id
  await s.panel.closeByChat(new Set([id]))
  expect(s.queue.value()[0]!.status).toBe('pending')
  await s.panel.askDelete(id, true)
  await s.panel.dismiss(id)
  await flush()
  expect(s.queue.value()[0]!.via).toBe('dismissed')
  expect(s.host.turns).toEqual([])
  expect(server.answered).toEqual([])
  await s.board.stop()
})

test('원격 질문 대장(#130): whoami 가 is_boss true 면 전역 목록에 없는 역할도 서버 질문을 끌어온다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const q = server.ask()
  const s = await session(server, clock, { role: 'g/lead', bosses: [], isBoss: true })
  expect(s.queue.value().map(b => b.remote?.id)).toEqual([q.id])
  expect(s.logs.some(l => l.includes('g/lead 는 대장(whoami'))).toBe(true)
  await s.board.stop()
})

test('원격 질문 대장(#130): whoami 가 is_boss false 면 전역 목록에 있어도 질문 API 를 부르지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  server.ask()
  const s = await session(server, clock, { isBoss: false })
  await clock.advance(120_000)
  await settle(clock)
  expect(server.calls).toEqual([])
  expect(s.queue.value()).toEqual([])
  await s.board.stop()
})

const QS = ITEMS.map(i => ({ ...i, options: [...i.options], picked: [] as string[], other: '' }))

/** 대장 세션이 스스로 질문을 올린다: 서버 질문 하나, 패널(대장 끌어오기)에 한 번. */
const bossAsks = async (server: ReturnType<typeof fakeServer>, clock: FakeClock) => {
  const s = await session(server, clock)
  const r = await s.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  await settle(clock)
  const mine = s.queue.value().filter(b => b.remote?.id === r.id)
  expect(mine.length).toBe(1)
  expect(s.queue.value().length).toBe(1)

  return { s, id: r.id, batch: mine[0]!.id }
}

test('대장 자기 질문(#138): 서버에 올린 질문은 같은 세션 패널에 한 번만 뜬다(poll 이 다시 실어 와도)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const { s, id } = await bossAsks(server, clock)
  expect(server.questions.map(q => q.id)).toEqual([id])
  // 같은 질문이 poll 에 다시 실려 온다.
  server.questions[0]!.seq = 50
  server.ask('other/dev')
  await settle(clock)
  expect(s.queue.value().filter(b => b.remote?.id === id).length).toBe(1)
  expect(s.host.turns).toEqual([])
  await s.board.stop()
})

test('대장 자기 질문(#138): 서버가 패널 답을 받으면(200) 답 메일로 세션에 한 번만 들어간다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const { s, id, batch } = await bossAsks(server, clock)
  await s.panel.pick(batch, 0, 'SQLite')
  await s.panel.pick(batch, 1, '검색')
  await s.panel.finish(batch)
  await settle(clock)
  expect(server.answered.map(a => a.id)).toEqual([id])
  expect(s.host.turns.length).toBe(1)
  expect(s.host.turns[0]).toContain(`[질문 패널 답 ${id}] 어느 DB를 쓸까요? = SQLite`)
  await settle(clock)
  expect(s.host.turns.length).toBe(1)
  await s.board.stop()
})

test('대장 자기 질문(#138): 서버가 패널 답을 받지 않으면(403) 거두고 답을 세션에 한 번 넣는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  server.setOwnerOnly(true)
  const { s, id, batch } = await bossAsks(server, clock)
  await s.panel.pick(batch, 0, 'Postgres')
  await s.panel.pick(batch, 1, '알림')
  await s.panel.finish(batch)
  await settle(clock)
  expect(server.answered).toEqual([])
  expect(server.questions[0]!.status).toBe('withdrawn')
  expect(s.host.turns.length).toBe(1)
  expect(s.host.turns[0]).toContain(`[질문 패널 답 ${id}] 어느 DB를 쓸까요? = Postgres`)
  expect(s.host.turns[0]).toContain(`[질문 패널 답 ${id}] 넣을 기능은? = 알림`)
  expect(s.queue.value()[0]!.status).toBe('sent')
  await s.board.stop()
})

test('대장 자기 질문(#138): 서버에 닿지 않아 패널 답을 넣었으면 뒤에 대시보드 답 메일이 와도 다시 넣지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const { s, id, batch } = await bossAsks(server, clock)
  server.setDown(true)
  await s.panel.pick(batch, 0, 'SQLite')
  await s.panel.pick(batch, 1, '검색')
  await s.panel.finish(batch)
  await flush()
  expect(s.host.turns.length).toBe(1)
  server.setDown(false)
  server.dashboard(id)
  await settle(clock)
  expect(server.mails.length).toBe(1)
  expect(server.mails[0]!.status).toBe('read')
  expect(s.host.turns.length).toBe(1)
  await s.board.stop()
})

/** Orca 질문 패널(0.7.0+)이 원격 카드 답을 장부 기록에 남긴 것을 흉내 낸다. */
const orcaAnswers = (s: Awaited<ReturnType<typeof session>>, batch: string) => {
  const b = s.queue.value().find(x => x.id === batch)!
  s.ledger.records.set(b.key!, { key: b.key!, id: b.id, state: 'answered', by: 'orca', at: 2, answers: [{ selected: ['SQLite'] }, { selected: ['검색'] }] })
}

test('대장 자기 질문(#142): Orca 사이드바 답은 서버가 받으면(200) 답 메일로 세션에 한 번만 들어간다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const { s, id, batch } = await bossAsks(server, clock)
  orcaAnswers(s, batch)
  await s.panel.poll()
  await settle(clock)
  await s.panel.poll()
  await settle(clock)
  expect(server.answered.map(a => a.id)).toEqual([id])
  expect(s.host.turns.length).toBe(1)
  expect(s.host.turns[0]).toContain(`[질문 패널 답 ${id}] 어느 DB를 쓸까요? = SQLite`)
  await s.board.stop()
})

test('대장 자기 질문(#142): Orca 사이드바 답을 서버가 받지 않으면(403) 세션에 한 번 넣고, 뒤에 오는 장부 보기·답 메일로 다시 넣지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  server.setOwnerOnly(true)
  const { s, id, batch } = await bossAsks(server, clock)
  orcaAnswers(s, batch)
  await s.panel.poll()
  await settle(clock)
  await s.panel.poll()
  await settle(clock)
  expect(server.answered).toEqual([])
  expect(server.questions[0]!.status).toBe('withdrawn')
  expect(s.host.turns.length).toBe(1)
  expect(s.host.turns[0]).toContain(`[질문 패널 답 ${id}] 어느 DB를 쓸까요? = SQLite`)
  expect(s.queue.value().filter(b => b.status === 'pending')).toEqual([])
  await s.board.stop()
})

test('원격 질문 대장(#142): 남의 질문을 Orca 사이드바로 답하면 서버로 한 번 가고 대장 세션에는 아무것도 넣지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const q = server.ask()
  const s = await session(server, clock)
  orcaAnswers(s, s.queue.value()[0]!.id)
  await s.panel.poll()
  await settle(clock)
  await s.panel.poll()
  await settle(clock)
  expect(server.answered.map(a => a.id)).toEqual([q.id])
  expect(s.host.turns).toEqual([])
  await s.board.stop()
})

test('대장 자기 질문(#138): 대시보드가 먼저 답하면 패널 묶음은 닫히고 답 메일만 한 번 들어간다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const { s, id } = await bossAsks(server, clock)
  server.dashboard(id)
  await settle(clock)
  expect(pending(s.queue.value())).toEqual([])
  expect(s.host.turns.length).toBe(1)
  expect(s.host.turns[0]).toContain(`[질문 패널 답 ${id}] 어느 DB를 쓸까요? = Postgres`)
  await s.board.stop()
})
