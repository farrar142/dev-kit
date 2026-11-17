// 메일함 시험 도우미: 가짜 Agent Mail 서버(긴 대기, #73 댓글 계약)와 메일함을 켠 코어 준비. 시험에서만 쓴다.
import { flush } from './testing'
import type { CompactBehavior, FakeHost } from './testing'
import { fakeHost } from './testing'
import type { HttpInit, Usage } from './host'
import { EMPTY_GAP_MS } from './mailbox'
import { createSwitchboard } from './switchboard'
import type { SwitchboardOptions } from './switchboard'

export const EP = 'http://mail.test'
export const ROLE = 'team/worker'
export const TOKEN = 'tok-SECRET-123'
export const PROFILE = '/home/u/.config/agent-mail/worker.json'

/** 가짜 Agent Mail: 계약(#73 댓글)의 긴 대기를 흉내 낸다. pending 만, id 오름차순, after 보다 큰 것만. */
export const fakeMail = (host: FakeHost) => {
  const mails: { id: number; status: 'pending' | 'read'; priority: string; body: string }[] = []
  /** 서버에 들어온 읽음 처리(POST …/read, GET 메일 하나). */
  const reads: number[] = []
  /** true 면 긴급 이벤트에 본문을 싣지 않는다(본문을 따로 받아 오는 길 시험). */
  let omitBody = false
  let waiters: (() => void)[] = []
  let down = false
  let nextId = 1
  const polls: { after: number | null; timeout: number }[] = []
  const pending = (after: number | null) =>
    mails
      .filter(m => m.status === 'pending' && (after === null || m.id > after))
      .map(m => ({
        id: m.id,
        sender: 'team/lead',
        subject: `s${m.id}`,
        priority: m.priority,
        // 계약: body 는 urgent 일 때만.
        ...(m.priority === 'urgent' && !omitBody ? { body: m.body } : {}),
      }))

  host.http.route(`${EP}/api/messages/`, ({ url, init }: { url: string; init: HttpInit }) => {
    if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return { status: 401, text: 'unauthorized' }
    const m = /\/api\/messages\/(\d+)(\/read)?$/.exec(url)
    const mail = m === null ? undefined : mails.find(x => x.id === Number(m[1]))
    if (mail === undefined || m === null) return { status: 404, text: 'not found' }
    if ((init.method ?? 'GET') === 'GET' && m[2] === undefined) {
      reads.push(mail.id)
      mail.status = 'read'

      return { text: JSON.stringify({ id: mail.id, body: mail.body, priority: mail.priority, status: 'read' }) }
    }
    if (init.method === 'POST' && m[2] === '/read') {
      reads.push(mail.id)
      mail.status = 'read'

      return { text: JSON.stringify({ id: mail.id, status: 'read' }) }
    }

    return { status: 405, text: 'method' }
  })

  host.http.route(`${EP}/api/events/poll`, async ({ url, init }: { url: string; init: HttpInit }) => {
    if (down) throw new Error(`connect ECONNREFUSED (headers ${JSON.stringify(init.headers)})`)
    if (init.headers?.Authorization !== `Bearer ${TOKEN}` || init.headers['X-Agent-Mail-Role'] !== ROLE) {
      return { status: 401, text: 'unauthorized' }
    }
    const q = new URL(url).searchParams
    const after = q.has('after') ? Number(q.get('after')) : null
    const timeout = Number(q.get('timeout') ?? '25')
    polls.push({ after, timeout })
    let events = pending(after)
    if (events.length === 0 && timeout > 0) {
      // 새 메일이나 시간 초과까지 기다린다.
      await new Promise<void>(done => {
        waiters.push(done)
        host.clock.after(timeout * 1000, done)
      })
      if (down) throw new Error('connection reset')
      events = pending(after)
    }
    const cursor = events.length > 0 ? events[events.length - 1]!.id : (after ?? 0)

    return { text: JSON.stringify({ events, cursor }) }
  })

  return {
    polls,
    reads,
    status: (id: number) => mails.find(x => x.id === id)?.status,
    setOmitBody: (v: boolean) => void (omitBody = v),
    send: (priority = 'normal', body = '') => {
      const id = nextId++
      mails.push({ id, status: 'pending', priority, body })
      const w = waiters
      waiters = []
      for (const done of w) done()

      return id
    },
    read: (id: number) => {
      const m = mails.find(x => x.id === id)
      if (m) m.status = 'read'
    },
    setDown: (v: boolean) => {
      down = v
      if (v) {
        const w = waiters
        waiters = []
        for (const done of w) done()
      }
    },
  }
}

export const setup = async (
  opts: { profile?: string | null; isMain?: boolean; preload?: number; features?: { midTurnInject?: boolean; compact?: boolean }; board?: Omit<SwitchboardOptions, 'mail'>
    /** 연결 전부터의 컨텍스트(resume 으로 이어 띄운 세션). */
    usage?: Usage
    compact?: CompactBehavior
  } = {},
) => {
  const host = fakeHost({ identity: { isMain: opts.isMain ?? true }, ...(opts.features === undefined ? {} : { features: opts.features }) })
  if (opts.usage !== undefined) host.setUsage(opts.usage)
  if (opts.compact !== undefined) host.setCompactBehavior(opts.compact)
  if (opts.profile !== null) host.fs.files.set(PROFILE, opts.profile ?? JSON.stringify({ endpoint: `${EP}/`, role: ROLE, token: TOKEN }))
  const mail = fakeMail(host)
  for (let i = 0; i < (opts.preload ?? 0); i++) mail.send()
  const logs: string[] = []
  const board = createSwitchboard(host, { ...opts.board, mail: { profilePath: opts.profile === null ? null : PROFILE, log: t => void logs.push(t) } })
  const started = await board.start()
  // 첫 물음(밀린 것 받기) 뒤 긴 대기가 걸리게 한다.
  await host.clock.advance(EMPTY_GAP_MS)

  return { host, mail, logs, board, started }
}

/** 세션이 넣은 턴을 실제처럼 돌렸다 끝낸다. */
export const runTurn = async (host: FakeHost) => {
  host.emit({ type: 'turn.start' })
  await flush()
  host.emit({ type: 'turn.complete' })
  await flush()
}

