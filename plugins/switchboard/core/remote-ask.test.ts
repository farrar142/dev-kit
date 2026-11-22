// 원격 질문 — 묻는 쪽(#111): 가짜 switchboard 서버(#106 댓글 「remote questions API」)로 코어를 돌린다.
import { expect, test } from 'claude-code/testing'

import type { QuestionPanelQuestion } from '../types'
import type { HttpInit } from './host'
import { EMPTY_GAP_MS } from './mailbox'
import { answerMailId, createQuestionsApi, isRemoteId, questionMailId, remoteAnswerText } from './remote-questions'
import type { RemoteAnswer, RemoteQuestion } from './remote-questions'
import { askRefusedText, localFallbackLine, normalizeRelayTo, remoteAskText, withdrawText } from './remote-ask'
import { createSwitchboard } from './switchboard'
import { fakeClock, fakeHost, flush } from './testing'
import type { FakeClock, FakeHost } from './testing'

const EP = 'http://mail.test'
const TOKEN = 'tok-SECRET-q'
const PROFILE = '/home/u/.config/switchboard/p.json'
// 서버 시스템 보낸이: 새 이름(#144). 옛 이름도 알아본다.
const SYSTEM = 'switchboard/system'
const OLD_SYSTEM = 'agent-mail/system'
const ME = 'team/worker-1'

type Mail = { id: number; to: string; sender: string; subject: string; body: string; priority: string; task_id?: string; status: 'pending' | 'read' }

const QS: QuestionPanelQuestion[] = [
  {
    question: '어느 DB를 쓸까요?',
    header: 'DB',
    multiSelect: false,
    options: [
      { label: 'Postgres', description: '관계형' },
      { label: 'SQLite', description: '파일형', preview: 'file.db' },
    ],
    picked: ['SQLite'],
    other: '쓰다 만 글',
  },
  {
    question: '넣을 기능은?',
    header: '',
    multiSelect: true,
    options: [
      { label: '검색', description: '' },
      { label: '알림', description: '' },
    ],
    picked: [],
    other: '',
  },
]

/** 가짜 서버: 메일(긴 대기·읽기)과 질문 API. mode 로 POST /api/questions 의 실패를 고른다. */
const fakeServer = () => {
  const mails: Mail[] = []
  const questions: (RemoteQuestion & { asker: string })[] = []
  const posted: { role: string; body: unknown }[] = []
  const calls: string[] = []
  let mode: 'ok' | 403 | 409 | 400 | 500 | 'down' = 'ok'
  let getDown = false
  let nextMail = 1
  let seq = 0
  let waiters: (() => void)[] = []
  const box = (role: string) => role.replace(/-1$/, '')
  const base = (role: string) => role.replace(/-\d+$/, '')
  const put = (m: Omit<Mail, 'id' | 'status'>) => {
    const mail: Mail = { id: nextMail++, status: 'pending', ...m, to: box(m.to) }
    mails.push(mail)
    const w = waiters
    waiters = []
    for (const done of w) done()

    return mail
  }
  const hex = (n: number) => n.toString(16).padStart(32, '0')

  const attach = (host: FakeHost, role: string) => {
    const authed = (init: HttpInit) => init.headers?.Authorization === `Bearer ${TOKEN}` && init.headers['X-Switchboard-Role'] === role
    host.http.route(`${EP}/api/messages/`, ({ url, init }: { url: string; init: HttpInit }) => {
      if (!authed(init)) return { status: 401 }
      const m = /\/api\/messages\/(\d+)(\/read)?$/.exec(url)
      const mail = m === null ? undefined : mails.find(x => x.id === Number(m[1]))
      if (mail === undefined) return { status: 404 }
      mail.status = 'read'

      return { text: JSON.stringify({ id: mail.id, body: mail.body, status: 'read' }) }
    })
    host.http.route(`${EP}/api/events/poll`, async ({ url, init }: { url: string; init: HttpInit }) => {
      if (!authed(init)) return { status: 401 }
      const q = new URL(url).searchParams
      const after = q.has('after') ? Number(q.get('after')) : -1
      const timeout = Number(q.get('timeout') ?? '25')
      const list = () => mails.filter(m => m.to === box(role) && m.status === 'pending' && m.id > after)
      if (list().length === 0 && timeout > 0) {
        await new Promise<void>(done => {
          waiters.push(done)
          host.clock.after(timeout * 1000, done)
        })
      }
      const events = list().map(m => ({ id: m.id, sender: m.sender, subject: m.subject, priority: m.priority, ...(m.task_id === undefined ? {} : { task_id: m.task_id }) }))

      return { text: JSON.stringify({ events, cursor: events.length > 0 ? events[events.length - 1]!.id : Math.max(after, 0) }) }
    })
    host.http.route(`${EP}/api/questions`, ({ url, init }: { url: string; init: HttpInit }) => {
      if (!authed(init)) return { status: 401 }
      calls.push(`${init.method ?? 'GET'} ${url.slice(EP.length)}`)
      if (url === `${EP}/api/questions` && init.method === 'POST') {
        if (mode === 'down') throw new Error('connect ECONNREFUSED')
        if (mode === 403) return { status: 403, text: JSON.stringify({ error: 'can_ask is off' }) }
        if (mode === 400) return { status: 400, text: JSON.stringify({ error: 'header too long' }) }
        if (mode === 409) return { status: 409, text: JSON.stringify({ error: 'nobody can answer' }) }
        if (mode === 500) return { status: 500, text: JSON.stringify({ error: 'boom' }) }
        const body = JSON.parse(init.body ?? '{}') as { questions: RemoteQuestion['questions'] }
        posted.push({ role, body })
        const q = {
          id: `q_${hex(questions.length + 1)}`,
          asker: role,
          created_at: '2026-11-17T00:00:00Z',
          status: 'pending' as const,
          questions: body.questions,
          answers: null,
          answered_by: '',
          answered_at: null,
          withdrawn_at: null,
          seq: ++seq,
          can_answer: false,
        }
        questions.push(q)

        return { status: 201, text: JSON.stringify(q) }
      }
      const m = /\/api\/questions\/(q_[0-9a-f]+)(\/withdraw)?$/.exec(url)
      const q = m === null ? undefined : questions.find(x => x.id === m[1])
      if (q === undefined || m === null) return { status: 404, text: JSON.stringify({ error: 'not found' }) }
      if (base(q.asker) !== base(role)) return { status: 403, text: JSON.stringify({ error: 'forbidden' }) }
      if (m[2] === '/withdraw') {
        if (q.status !== 'pending') return { status: 409, text: JSON.stringify({ error: 'not pending' }) }
        q.status = 'withdrawn'
        q.seq = ++seq

        return { text: JSON.stringify(q) }
      }
      if (getDown) throw new Error('connection reset')

      return { text: JSON.stringify(q) }
    })
  }

  return {
    attach,
    mails,
    questions,
    posted,
    calls,
    put,
    setMode: (m: typeof mode) => void (mode = m),
    setGetDown: (v: boolean) => void (getDown = v),
    /** 대장·대시보드가 답한다: 서버처럼 묻는 역할 앞으로 답 메일을 보낸다. */
    answer: (id: string, answers: RemoteAnswer[], by = 'dashboard', sender = SYSTEM) => {
      const q = questions.find(x => x.id === id)!
      q.status = 'answered'
      q.answers = answers
      q.answered_by = by
      q.answered_at = '2026-11-17T00:01:00Z'
      q.seq = ++seq
      const lines = q.questions.map((item, i) => `${item.header}: ${item.question} = ${answers[i]!.selected.join(', ')}${answers[i]!.other === undefined ? '' : ` / 기타: ${answers[i]!.other}`}`)
      put({ to: q.asker, sender, subject: `[질문 답] ${id} ${q.questions[0]!.header}`, body: [...lines, `답한 쪽: ${by}`].join('\n'), priority: 'normal', task_id: id })
    },
  }
}

/** 패널 쪽 흉내(대장 세션용): 올리고 닫은 것만 센다. */
const fakeSink = () => {
  const offered: string[] = []

  return {
    offered,
    sink: {
      offer: async (q: RemoteQuestion) => void offered.push(q.id),
      close: async () => {},
      prune: async () => {},
    },
  }
}

const session = async (
  server: ReturnType<typeof fakeServer>,
  clock: FakeClock,
  o: { role?: string; profile?: boolean; bosses?: string[]; panel?: boolean; isBoss?: boolean } = {},
) => {
  const role = o.role ?? ME
  const host = fakeHost({ clock, identity: { machine: 'box-w', cwd: '/work/repo', sessionId: 'sess-w' } })
  if (o.profile !== false) host.fs.files.set(PROFILE, JSON.stringify({ endpoint: EP, role, token: TOKEN }))
  server.attach(host, role)
  // 새 서버(#130): whoami. 없으면 라우트가 없어 404(옛 서버, 전역 목록 판정).
  const isBoss = o.isBoss
  if (isBoss !== undefined) host.http.route(`${EP}/api/whoami`, () => ({ text: JSON.stringify({ role, base: role, group: 'g', global_boss: false, boss_of: [], is_boss: isBoss }) }))
  const logs: string[] = []
  const board = createSwitchboard(host, {
    log: t => void logs.push(t),
    mail: { profilePath: o.profile === false ? null : PROFILE, log: t => void logs.push(t) },
    ...(o.bosses === undefined ? {} : { permissions: { bosses: o.bosses } }),
    // 대장 쪽 inbox(패널). 가짜 서버는 목록·poll 을 404 로 돌려 inbox 는 물러나 다시 해 보기만 한다.
    ...(o.panel === true ? { remoteQuestions: { sink: fakeSink().sink, retry: { firstMs: 60_000, maxMs: 60_000 } } } : {}),
  })
  await board.start()
  await clock.advance(EMPTY_GAP_MS)

  return { host, board, logs }
}

/** 메일이 와서 세션에 들어가기까지(긴 대기가 깨고, GET 보기를 읽고, 유휴 때 넣는다). */
const settle = async (clock: FakeClock) => {
  for (let i = 0; i < 5; i++) {
    await flush()
    await clock.advance(EMPTY_GAP_MS)
  }
}

test('원격 질문: 프로필이 있으면 서버 질문으로 올린다(패널 상태는 빼고, 빈 header 는 채운다)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  const r = await w.board.askRemote(QS)
  expect(r.kind).toBe('remote')
  if (r.kind !== 'remote') return
  expect(isRemoteId(r.id)).toBe(true)
  expect(r.asker).toBe(ME)
  expect(server.posted.length).toBe(1)
  expect(server.posted[0]!.body).toEqual({
    questions: [
      {
        header: 'DB',
        question: '어느 DB를 쓸까요?',
        options: [
          { label: 'Postgres', description: '관계형' },
          { label: 'SQLite', description: '파일형', preview: 'file.db' },
        ],
        multiSelect: false,
      },
      { header: '질문', question: '넣을 기능은?', options: [{ label: '검색', description: '' }, { label: '알림', description: '' }], multiSelect: true },
    ],
  })
  // 결과 글: 어느 쪽인지, 손잡이(서버 id), 거두는 길. Orca 카드로 옮겨지지 않게 「질문 묶음 qN」은 쓰지 않는다.
  const text = remoteAskText(r.id, r.asker, 'resolve')
  expect(text).toContain(`원격 질문 ${r.id} 로 올렸다`)
  expect(text).toContain(`[질문 패널 답 ${r.id}]`)
  expect(text).not.toMatch(/질문 묶음 q\d/)
  await w.board.stop()
})

test('원격 질문: 400·5xx·연결 실패면 로컬 패널로(까닭을 남긴다)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  const cases: [400 | 500 | 'down', RegExp][] = [
    [400, /400: header too long/],
    [500, /서버 오류\(HTTP 500/],
    ['down', /서버에 닿지 않음/],
  ]
  for (const [mode, why] of cases) {
    server.setMode(mode)
    const r = await w.board.askRemote(QS)
    expect(r.kind).toBe('local')
    if (r.kind === 'local') {
      expect(r.reason ?? '').toMatch(why)
      expect(localFallbackLine(r.reason ?? '')).toContain('로컬 패널에 올렸다')
    }
  }
  expect(server.questions.length).toBe(0)
  await w.board.stop()
})

test('원격 질문: relay_to 를 주면 요청 본문에 실리고, 안 주거나 비면 칸이 없다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  await w.board.askRemote(QS, undefined, ['team/coordinator', 'team/reviewer'])
  await w.board.askRemote([{ ...QS[0]!, question: '다른 질문 A?' }])
  await w.board.askRemote([{ ...QS[0]!, question: '다른 질문 B?' }], undefined, [])
  expect((server.posted[0]!.body as Record<string, unknown>).relay_to).toEqual(['team/coordinator', 'team/reviewer'])
  expect('relay_to' in (server.posted[1]!.body as object)).toBe(false)
  expect('relay_to' in (server.posted[2]!.body as object)).toBe(false)
  expect(normalizeRelayTo([' team/a ', '', 'team/a', 3, ...Array.from({ length: 10 }, (_, i) => `r/${i}`)])).toHaveLength(8)
  expect(normalizeRelayTo(undefined)).toEqual([])
  await w.board.stop()
})

test('원격 질문: relay_to 가 있고 서버가 400 이면 그 본문이 까닭에 남는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  server.setMode(400)
  const r = await w.board.askRemote(QS, undefined, ['team/nobody'])
  expect(r.kind === 'local' ? r.reason : '').toMatch(/400: header too long/)
  await w.board.stop()
})

test('원격 질문: 403(질문 권한 없음)은 로컬로 돌리지 않고 거절을 돌려준다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  server.setMode(403)
  expect(await w.board.askRemote(QS)).toEqual({ kind: 'refused', askVia: null, settingsTarget: null, code: null })
  expect(askRefusedText(null)).toContain('질문을 올릴 곳이 없다')
  expect(askRefusedText('x/y')).toContain('x/y 에 질문이 전달됐다')
  await w.board.stop()
})

test('원격 질문: 같은 문항은 같은 Idempotency-Key, 다른 문항은 다른 키로 올린다(#176)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  const keys: (string | undefined)[] = []
  const inner = w.host.http
  const spy = { fetch: (url: string, init: HttpInit) => (url.endsWith('/api/questions') && init.method === 'POST' ? (keys.push(init.headers?.['Idempotency-Key']), inner.fetch(url, init)) : inner.fetch(url, init)) }
  await w.board.askRemote(QS, { http: spy })
  await w.board.askRemote(QS, { http: spy })
  await w.board.askRemote([{ ...QS[0]!, question: '다른 질문?' }], { http: spy })
  expect(keys[0]).toMatch(/^switchboard-ask-[0-9a-f]{8}$/)
  expect(keys[1]).toBe(keys[0])
  expect(keys[2]).not.toBe(keys[0])
  await w.board.stop()
})

test('원격 질문: 프로필이 없으면 서버에 묻지 않고 로컬(까닭 없음)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock, { profile: false })
  expect(await w.board.askRemote(QS)).toEqual({ kind: 'local', reason: null })
  expect(server.calls).toEqual([])
})

test('원격 질문: 답 메일은 로컬 답과 같은 꼴(「[질문 패널 답 <id>] 질문 = 고른 것」)로 세션에 넣고 read 로 표시한다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  const r = await w.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  server.answer(r.id, [{ selected: ['Postgres'] }, { selected: ['검색', '알림'], other: '로그' }], 'team/boss-1')
  await settle(clock)
  expect(w.host.turns).toEqual([
    [
      `[질문 패널 답 ${r.id}] 어느 DB를 쓸까요? = Postgres`,
      `[질문 패널 답 ${r.id}] 넣을 기능은? = 검색, 알림, 기타: 로그`,
      `(원격 질문 ${r.id}의 답 · 답한 쪽: team/boss-1)`,
    ].join('\n'),
  ])
  expect(server.mails[0]!.status).toBe('read')
  await w.board.stop()
})

test('원격 질문: 세션이 다시 떠 올린 기록이 없어도 서버 보기의 asker base 로 내 질문 답을 알아본다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const first = await session(server, clock)
  const r = await first.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  await first.board.stop()
  // 다시 뜬 세션(같은 역할 주소): 이 세션은 r.id 를 올린 적이 없다.
  const again = await session(server, clock)
  server.answer(r.id, [{ selected: ['SQLite'] }, { selected: [], other: '없음' }])
  await settle(clock)
  expect(again.host.turns).toEqual([
    [`[질문 패널 답 ${r.id}] 어느 DB를 쓸까요? = SQLite`, `[질문 패널 답 ${r.id}] 넣을 기능은? = 기타: 없음`, `(원격 질문 ${r.id}의 답 · 답한 쪽: dashboard)`].join('\n'),
  ])
  await again.board.stop()
})

test('원격 질문: 참조(watcher) 사본 — 다른 역할이 물은 질문의 답 메일은 평소 시스템 통지로 둔다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  // 다른 base 의 역할이 올린 질문(서버에만 있다).
  const other = await session(server, clock, { role: 'team/other-1' })
  const r = await other.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  await other.board.stop()
  const w = await session(server, clock)
  server.put({ to: ME, sender: SYSTEM, subject: `[질문 답] ${r.id} team/other-1 DB`, body: 'DB: 어느 DB를 쓸까요? = Postgres\n답한 쪽: dashboard', priority: 'normal', task_id: r.id })
  await settle(clock)
  expect(w.host.turns.length).toBe(1)
  expect(w.host.turns[0]).toContain('시스템 통지]')
  expect(w.host.turns[0]).not.toContain('[질문 패널 답 ')
  await w.board.stop()
})

const BOSS = 'team/boss-1'
const qMail = (id: string, to: string) => ({ to, sender: SYSTEM, subject: `[질문] ${id} team/other-1 DB`, body: 'DB: 어느 DB를 쓸까요?', priority: 'normal', task_id: id })
const aMail = (id: string, to: string) => ({
  to,
  sender: SYSTEM,
  subject: `[질문 답] ${id} team/other-1 DB`,
  body: 'DB: 어느 DB를 쓸까요? = Postgres\n답한 쪽: dashboard',
  priority: 'normal',
  task_id: id,
})

test('대장 세션(#120): 참조 메일 [질문]·[질문 답] 은 세션에 넣지 않고 read 로만 표시한다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const other = await session(server, clock, { role: 'team/other-1' })
  const r = await other.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  await other.board.stop()
  const b = await session(server, clock, { role: BOSS, bosses: ['team/boss'], panel: true })
  server.put(qMail(r.id, BOSS))
  server.put(aMail(r.id, BOSS))
  await settle(clock)
  expect(b.host.turns).toEqual([])
  expect(server.mails.map(m => m.status)).toEqual(['read', 'read'])
  await b.board.stop()
})

test('대장 세션(#120): 참조 메일은 거르고 다른 시스템 통지는 그대로 넣는다(한 묶음에 섞여도)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const b = await session(server, clock, { role: BOSS, bosses: ['team/boss'], panel: true })
  const id = `q_${'b'.repeat(32)}`
  server.put(qMail(id, BOSS))
  server.put({ to: BOSS, sender: SYSTEM, subject: '[시스템] 다른 통지', body: '본문', priority: 'normal' })
  await settle(clock)
  expect(b.host.turns.length).toBe(1)
  expect(b.host.turns[0]).toContain('다른 통지')
  expect(b.host.turns[0]).not.toContain(id)
  expect(server.mails.map(m => m.status)).toEqual(['read', 'read'])
  await b.board.stop()
})

test('대장 세션(#120·#138): 대장이 스스로 물은 질문의 답은 여전히 「[질문 패널 답 …]」으로 한 번 넣는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const b = await session(server, clock, { role: BOSS, bosses: ['team/boss'], panel: true })
  const r = await b.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  server.answer(r.id, [{ selected: ['Postgres'] }, { selected: ['검색'] }])
  await settle(clock)
  expect(b.host.turns.length).toBe(1)
  expect(b.host.turns[0]).toContain(`[질문 패널 답 ${r.id}] 어느 DB를 쓸까요? = Postgres`)
  await b.board.stop()
})

test('대장 아닌 세션(#120): 참조 [질문] 메일은 평소 시스템 통지로 넣는다(대장 목록에 없거나 패널이 없는 대장)', async () => {
  for (const o of [{ role: ME, bosses: ['team/boss'], panel: true }, { role: BOSS, bosses: ['team/boss'], panel: false }]) {
    const clock = fakeClock()
    const server = fakeServer()
    const w = await session(server, clock, o)
    const id = `q_${'c'.repeat(32)}`
    server.put(qMail(id, o.role))
    server.put(aMail(id, o.role))
    await settle(clock)
    expect(w.host.turns.length).toBe(1)
    expect(w.host.turns[0]).toContain(`[질문] ${id}`)
    expect(w.host.turns[0]).toContain(`[질문 답] ${id}`)
    expect(w.host.turns[0]).not.toContain('[질문 패널 답 ')
    await w.board.stop()
  }
})

test('원격 질문: 보기를 못 읽으면(끊김) 이 세션이 올린 질문은 메일 본문으로 같은 머리를 달아 넣는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  const r = await w.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  server.setGetDown(true)
  server.answer(r.id, [{ selected: ['Postgres'] }, { selected: ['검색'] }])
  await settle(clock)
  expect(w.host.turns).toEqual([
    [`[질문 패널 답 ${r.id}] DB: 어느 DB를 쓸까요? = Postgres`, `[질문 패널 답 ${r.id}] 질문: 넣을 기능은? = 검색`, `(원격 질문 ${r.id}의 답한 쪽: dashboard)`].join('\n'),
  ])
  await w.board.stop()
})

test('원격 질문: resolve 는 거두기(withdraw)로, 이미 답·거둔 질문은 409 로 안내한다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  const r = await w.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  const ok = await w.board.withdrawRemote(r.id)
  expect(ok).toEqual({ ok: true })
  expect(server.questions[0]!.status).toBe('withdrawn')
  expect(server.calls).toContain(`POST /api/questions/${r.id}/withdraw`)
  expect(withdrawText(r.id, ok)).toContain('거뒀다')
  const again = await w.board.withdrawRemote(r.id)
  expect(again).toMatchObject({ ok: false, status: 409 })
  expect(withdrawText(r.id, again)).toContain('이미 답이 났거나 거둔 질문')
  const missing = await w.board.withdrawRemote(`q_${'f'.repeat(32)}`)
  expect(missing).toMatchObject({ ok: false, status: 404 })
  await w.board.stop()
})

test('원격 질문: 답 메일 판정·답 글 도우미', () => {
  const id = `q_${'a'.repeat(32)}`
  expect(answerMailId({ sender: SYSTEM, subject: `[질문 답] ${id} DB`, task_id: id })).toBe(id)
  expect(answerMailId({ sender: 'agent-mail/system-2', subject: `[질문 답] ${id} DB` })).toBe(id)
  expect(answerMailId({ sender: 'switchboard/system-3', subject: `[질문 답] ${id} DB` })).toBe(id)
  expect(answerMailId({ sender: OLD_SYSTEM, subject: `[질문 답] ${id} DB`, task_id: id })).toBe(id)
  expect(answerMailId({ sender: 'switchboard/systems', subject: `[질문 답] ${id} DB` })).toBeNull()
  // 시스템이 아닌 보낸이, task_id 가 다름, 로컬 묶음 id 는 아니다.
  expect(answerMailId({ sender: 'team/lead', subject: `[질문 답] ${id} DB`, task_id: id })).toBeNull()
  expect(answerMailId({ sender: SYSTEM, subject: `[질문 답] ${id} DB`, task_id: 'q_other' })).toBeNull()
  expect(answerMailId({ sender: SYSTEM, subject: '[질문 답] q3 DB' })).toBeNull()
  // 새 질문 참조 메일(#120): 답 메일과 서로 겹치지 않는다.
  expect(questionMailId({ sender: SYSTEM, subject: `[질문] ${id} team/other-1 DB`, task_id: id })).toBe(id)
  expect(questionMailId({ sender: SYSTEM, subject: `[질문 답] ${id} DB`, task_id: id })).toBeNull()
  expect(answerMailId({ sender: SYSTEM, subject: `[질문] ${id} DB`, task_id: id })).toBeNull()
  expect(questionMailId({ sender: 'team/lead', subject: `[질문] ${id} DB` })).toBeNull()
  const view: RemoteQuestion = {
    id,
    asker: ME,
    created_at: '',
    status: 'answered',
    questions: [{ header: 'DB', question: 'Q?', options: [], multiSelect: false }],
    answers: [{ selected: ['A'] }],
    answered_by: 'dashboard',
    answered_at: '',
    withdrawn_at: null,
    seq: 1,
    can_answer: false,
  }
  expect(remoteAnswerText(view)).toBe(`[질문 패널 답 ${id}] Q? = A\n(원격 질문 ${id}의 답 · 답한 쪽: dashboard)`)
})

test('서버 클라이언트: list·poll·answer 는 계약의 경로로 부르고 응답을 읽는다(#112가 쓴다)', async () => {
  const seen: { path: string; method: string; body?: string; timeoutMs?: number }[] = []
  const id = `q_${'b'.repeat(32)}`
  const view = { id, asker: 'x/y-1', created_at: '', status: 'pending', questions: [], answers: null, answered_by: '', answered_at: null, withdrawn_at: null, seq: 7, can_answer: true }
  const api = createQuestionsApi(async (path, init = {}, io = {}) => {
    seen.push({ path, method: init.method ?? 'GET', ...(init.body === undefined ? {} : { body: init.body }), ...(io.timeoutMs === undefined ? {} : { timeoutMs: io.timeoutMs }) })
    if (path.startsWith('/api/questions/poll')) return { status: 200, ok: true, text: JSON.stringify({ questions: [view], cursor: 7 }) }
    if (path.endsWith('/answer')) return { status: 409, ok: false, text: JSON.stringify({ error: 'not pending' }) }

    return { status: 200, ok: true, text: JSON.stringify({ questions: [view] }) }
  })
  const listed = await api.list({ status: 'pending', limit: 5 })
  expect(listed.ok && listed.value.map(q => q.id)).toEqual([id])
  const polled = await api.poll(3, 25)
  expect(polled.ok && polled.value.cursor).toBe(7)
  const answered = await api.answer(id, [{ selected: ['A'] }])
  expect(answered).toEqual({ ok: false, status: 409, error: 'not pending' })
  expect(seen).toEqual([
    { path: '/api/questions?status=pending&limit=5', method: 'GET' },
    { path: '/api/questions/poll?after=3&timeout=25', method: 'GET', timeoutMs: 40_000 },
    { path: `/api/questions/${id}/answer`, method: 'POST', body: JSON.stringify({ answers: [{ selected: ['A'] }] }) },
  ])
})

test('대장 판정(#130): whoami 가 is_boss false 면 전역 목록의 대장이어도 참조 메일을 거르지 않고, true 면 목록 밖이어도 거른다', async () => {
  for (const o of [
    { role: BOSS, bosses: ['team/boss'], panel: true, isBoss: false, dropped: false },
    { role: ME, bosses: [], panel: true, isBoss: true, dropped: true },
  ]) {
    const clock = fakeClock()
    const server = fakeServer()
    const w = await session(server, clock, o)
    const id = `q_${'d'.repeat(32)}`
    server.put(qMail(id, o.role))
    await settle(clock)
    expect(w.host.turns.length).toBe(o.dropped ? 0 : 1)
    await w.board.stop()
  }
})

test('대장 세션(#138): ask 도 서버에 먼저 올린다(201 이면 서버 질문, 결과 글은 이 세션 패널에 뜬다고 적는다)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  // whoami 판정(is_boss=true)과 옛 서버의 전역 목록 판정 둘 다.
  for (const o of [{ isBoss: true }, { bosses: ['team/boss'] }]) {
    const before = server.posted.length
    const b = await session(server, clock, { role: BOSS, panel: true, ...o })
    const r = await b.board.askRemote(QS)
    if (r.kind !== 'remote') throw new Error('remote 가 아님')
    expect(r.here).toBe(true)
    expect(server.posted.length).toBe(before + 1)
    const text = remoteAskText(r.id, r.asker, 'resolve', r.here)
    expect(text).toContain('이 세션의 질문 패널과 관리 대시보드에 뜬다')
    expect(text).not.toContain('띄우지 않는다')
    await b.board.stop()
  }
})

test('대장 아닌 세션(#138): 서버 질문 결과 글은 이 세션 패널에 띄우지 않는다고 적는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  const r = await w.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  expect(r.here).toBe(false)
  expect(remoteAskText(r.id, r.asker, 'resolve', r.here)).toContain('이 세션의 질문 패널에는 띄우지 않는다')
  await w.board.stop()
})

test('409(#138, 옛 서버): 대장이든 아니든 로컬로, 결과에 까닭을 붙이지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  for (const o of [{ isBoss: true, panel: true }, { isBoss: false }]) {
    const b = await session(server, clock, { role: BOSS, ...o })
    server.setMode(409)
    const before = server.calls.filter(c => c.startsWith('POST /api/questions')).length
    expect(await b.board.askRemote(QS)).toEqual({ kind: 'local', reason: null })
    expect(server.calls.filter(c => c.startsWith('POST /api/questions')).length).toBe(before + 1)
    await b.board.stop()
  }
})

test('대장 세션(#138): 서버 불통·5xx 면 로컬로 까닭을 붙인다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const b = await session(server, clock, { role: BOSS, panel: true, isBoss: true })
  server.setMode('down')
  expect(await b.board.askRemote(QS)).toEqual({ kind: 'local', reason: '서버에 닿지 않음' })
  server.setMode(500)
  const r = await b.board.askRemote(QS)
  expect(r.kind === 'local' ? r.reason : '').toMatch(/HTTP 500/)
  await b.board.stop()
})

const MIN = 60_000
const answerLines = (id: string) =>
  [`[질문 패널 답 ${id}] 어느 DB를 쓸까요? = Postgres`, `[질문 패널 답 ${id}] 넣을 기능은? = 검색`, `(원격 질문 ${id}의 답 · 답한 쪽: dashboard)`].join('\n')

test('질문 답 메일(#144): 사람 답 뒤 보류 시간 안에 와도 바로 넣는다(새 보낸이 switchboard/system)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  const r = await w.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  w.host.emit({ type: 'input.submit', text: '이거 해 줘', origin: 'user' })
  w.host.emit({ type: 'turn.start' })
  w.host.emit({ type: 'turn.complete' })
  await flush()
  server.answer(r.id, [{ selected: ['Postgres'] }, { selected: ['검색'] }])
  await settle(clock)
  expect(w.host.turns).toEqual([answerLines(r.id)])
  expect(server.mails[0]!.status).toBe('read')
  expect(w.logs.join('\n')).not.toContain('미룸')
  // 보류가 풀린 뒤에도 다시 들어가지 않는다(답 한 번).
  await clock.advance(4 * MIN)
  await settle(clock)
  expect(w.host.turns.length).toBe(1)
  await w.board.stop()
})

test('질문 답 메일(#144): 입력창에 글이 있어도 바로 넣는다, 일반 메일은 미룬다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  const r = await w.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  w.host.emit({ type: 'input.change', text: '쓰는 중' })
  server.put({ to: ME, sender: 'team/lead', subject: '일반', body: '본문', priority: 'normal' })
  server.answer(r.id, [{ selected: ['Postgres'] }, { selected: ['검색'] }])
  await settle(clock)
  expect(w.host.turns).toEqual([answerLines(r.id)])
  await w.board.stop()
})

test('질문 답 메일(#144): 바쁜 턴에는 다음 도구 호출 결과 뒤에 끼워 넣는다(긴급과 같은 길)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  const r = await w.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  w.host.emit({ type: 'turn.start' })
  server.answer(r.id, [{ selected: ['Postgres'] }, { selected: ['검색'] }])
  await settle(clock)
  w.host.toolCall()
  await settle(clock)
  expect(w.host.injected).toEqual([answerLines(r.id)])
  w.host.emit({ type: 'turn.complete' })
  await settle(clock)
  expect(w.host.turns).toEqual([])
  await w.board.stop()
})

test('질문 답 메일(#144): 옛 보낸이 agent-mail/system 도 그대로 바로 넣는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  const r = await w.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  w.host.emit({ type: 'input.submit', text: '이거', origin: 'user' })
  w.host.emit({ type: 'turn.start' })
  w.host.emit({ type: 'turn.complete' })
  await flush()
  server.answer(r.id, [{ selected: ['Postgres'] }, { selected: ['검색'] }], 'dashboard', OLD_SYSTEM)
  await settle(clock)
  expect(w.host.turns).toEqual([answerLines(r.id)])
  await w.board.stop()
})

test('질문 답 메일(#144): 다른 역할 질문의 참조 사본은 바로 길을 타지 않고 입력 중 보류를 따른다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const other = await session(server, clock, { role: 'team/other-1' })
  const r = await other.board.askRemote(QS)
  if (r.kind !== 'remote') throw new Error('remote 가 아님')
  await other.board.stop()
  const w = await session(server, clock)
  w.host.emit({ type: 'input.change', text: '쓰는 중' })
  await flush()
  server.put({ to: ME, sender: SYSTEM, subject: `[질문 답] ${r.id} team/other-1 DB`, body: 'DB: 어느 DB를 쓸까요? = Postgres\n답한 쪽: dashboard', priority: 'normal', task_id: r.id })
  await settle(clock)
  expect(w.host.turns).toEqual([])
  w.host.emit({ type: 'input.change', text: '' })
  await settle(clock)
  expect(w.host.turns.length).toBe(1)
  expect(w.host.turns[0]).toContain('시스템 통지]')
  await w.board.stop()
})
