// 메일함(D2): Agent Mail 서버를 긴 대기(long-poll)로 구독하고, 일반 메일을 턴이 끝난 뒤 새 턴으로 알린다.
//  - 알림 글은 메일 ID만 담는다(「Agent Mail #12, #13 을 읽고 처리하라」). 메일 상태는 바꾸지 않는다(pending 그대로).
//  - 바쁜 동안 온 메일은 한 줄로 묶는다. 같은 ID 는 두 번 알리지 않는다. 커서로 다시 이어 놓친 메일이 없다.
//  - 서버가 죽어 있거나 프로필이 틀려도 세션은 멀쩡하다: 간격을 늘려 가며 다시 잇는다.
//  - 긴급(priority=urgent)은 D4 몫: 지금은 일반과 똑같이 ID로만 알린다.
// 왜 SSE 가 아닌가: Claude 모드의 http 는 본문을 다 받아서만 준다(D1). 서버의 긴 대기는 SSE 와 같은 이벤트·커서 규칙이다.
import type { AgentHost, Fs, Timer } from './host'

/** Agent Mail CLI 프로필(`~/.config/agent-mail/<이름>.json`). token 은 메모리에만 둔다. */
export type MailProfile = { endpoint: string; role: string; token: string }

/** 서버 이벤트 하나(SSE message data 와 같다). 코어가 쓰는 칸만 적는다. */
export type MailEvent = { id: number; sender?: string; subject?: string; priority?: string }

export type MailboxOptions = {
  /** 프로필 파일의 절대 경로. null 이면(AGENT_MAIL_PROFILE 없음) 메일함은 꺼진다. */
  profilePath: string | null
  /** 지금 새 턴을 넣어도 되는가(세션이 유휴인가). */
  isIdle: () => boolean
  /** 연결 상태가 바뀔 때 한 줄. 토큰은 절대 담지 않는다. */
  log?: (text: string) => void
  /**
   * 일반 메일 턴을 넣기 직전 관문(D3: 메일 전 compact). 'wait' 이면 넣지 않고 되돌려 둔다:
   * 관문을 건 쪽이 끝난 뒤(compact.complete 등) 다시 kick 된다.
   */
  beforeDeliver?: () => Promise<'ready' | 'wait'>
}

export type MailboxState = {
  /** off: 프로필 없음·틀림, connecting: 아직 응답 없음, live: 이어짐, retrying: 끊겨 다시 잇는 중. */
  status: 'off' | 'connecting' | 'live' | 'retrying'
  /** 다음 긴 대기에 줄 커서(마지막으로 받은 메일 id). */
  cursor: number | null
  /** 알리려고 기다리는 ID. */
  queued: number[]
}

export type Mailbox = {
  /** 프로필을 읽고 구독을 시작한다. 프로필이 없거나 틀리면 false(꺼짐). */
  start: () => Promise<boolean>
  stop: () => void
  /** 세션이 유휴가 됐을 수 있다(턴 끝 등): 기다리는 알림을 넣어 본다. */
  kick: () => void
  state: () => MailboxState
}

/** 한 번의 긴 대기(초). 서버 기본과 같고 상한(55초)보다 작다. */
export const POLL_TIMEOUT_S = 25
/** 응답이 이만큼(긴 대기 + 여유) 안 오면 끊긴 것으로 보고 다시 잇는다. */
export const POLL_WATCHDOG_MS = (POLL_TIMEOUT_S + 15) * 1000
/** 다시 잇기 간격: 1초에서 두 배씩, 60초까지. */
export const RETRY_MIN_MS = 1000
export const RETRY_MAX_MS = 60_000
/** 빈 응답 뒤 다음 대기까지 쉬는 시간(서버나 중간 장비가 기다리지 않고 바로 돌려줄 때 헛돌지 않게). */
export const EMPTY_GAP_MS = 1000
/** 알림 턴을 넣은 뒤 턴 시작을 기다리는 시간. 넘으면 다시 넣을 수 있다고 본다. */
export const TURN_GRACE_MS = 15_000
/** 알림 직전 「아직 pending 인가」 확인의 한도. */
export const CHECK_TIMEOUT_MS = 10_000

/** 알림 글. */
export const announce = (ids: readonly number[]) =>
  `Agent Mail ${ids.map(i => `#${i}`).join(', ')} 을 읽고 처리하라(agent-mail read <ID>).`

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 프로필 파일을 읽는다. 없거나 모양이 틀리면 이유(토큰 없이). */
export const loadProfile = async (fs: Fs, path: string): Promise<MailProfile | { error: string }> => {
  let text: string | null
  try {
    text = await fs.read(path)
  } catch {
    return { error: `프로필을 못 읽음: ${path}` }
  }
  if (text === null) return { error: `프로필 없음: ${path}` }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // JSON 오류 문구에는 파일 내용(토큰)이 섞일 수 있어 그대로 옮기지 않는다.
    return { error: `프로필이 JSON 이 아님: ${path}` }
  }
  if (!isRecord(raw)) return { error: `프로필 모양이 틀림: ${path}` }
  const { endpoint, role, token } = raw
  if (typeof endpoint !== 'string' || endpoint === '' || typeof role !== 'string' || role === '' || typeof token !== 'string' || token === '') {
    return { error: `프로필에 endpoint·role·token 이 다 있어야 함: ${path}` }
  }

  return { endpoint: endpoint.replace(/\/+$/, ''), role, token }
}

/** 긴 대기 응답을 읽는다. 모양이 틀리면 null. */
const parsePoll = (text: string): { events: MailEvent[]; cursor: number } | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || !Array.isArray(raw.events) || typeof raw.cursor !== 'number') return null
  const events: MailEvent[] = []
  for (const e of raw.events) {
    if (isRecord(e) && typeof e.id === 'number' && Number.isInteger(e.id)) events.push({ id: e.id })
  }

  return { events, cursor: raw.cursor }
}

export const createMailbox = (host: AgentHost, opts: MailboxOptions): Mailbox => {
  const { http, clock } = host.services
  const log = (text: string) => {
    try {
      opts.log?.(text)
    } catch {
      // 기록이 실패해도 메일함은 간다.
    }
  }
  let profile: MailProfile | null = null
  let status: MailboxState['status'] = 'off'
  let cursor: number | null = null
  /** 큐에 넣었거나 이미 알린 ID. 다시 오면 거른다. */
  const known = new Set<number>()
  let queued: number[] = []
  /** 돌고 있는 일의 세대. stop·다시 잇기 때 올려 늦게 온 응답을 버린다. */
  let gen = 0
  let backoff = RETRY_MIN_MS
  let next: Timer | undefined
  let watchdog: Timer | undefined
  let grace: Timer | undefined
  let delivering = false
  /** 알림 턴을 넣었고 아직 턴이 시작되지 않았다. */
  let awaitingTurn = false
  let off: (() => void) | undefined

  const headers = (p: MailProfile) => ({ Authorization: `Bearer ${p.token}`, 'X-Agent-Mail-Role': p.role })
  const pollUrl = (p: MailProfile, after: number | null, timeout: number) =>
    `${p.endpoint}/api/events/poll?timeout=${timeout}${after === null ? '' : `&after=${after}`}`

  const schedule = (ms: number) => {
    next?.cancel()
    const g = gen
    next = clock.after(ms, () => {
      if (g === gen) void poll()
    })
  }

  const fail = (why: string) => {
    if (status !== 'retrying') log(`switchboard 메일함: 끊김(${why}), 다시 잇는다`)
    status = 'retrying'
    gen++
    schedule(backoff)
    backoff = Math.min(backoff * 2, RETRY_MAX_MS)
  }

  const poll = async () => {
    const p = profile
    if (p === null) return
    const g = ++gen
    watchdog?.cancel()
    watchdog = clock.after(POLL_WATCHDOG_MS, () => {
      if (g === gen) fail('응답 없음')
    })
    let reply
    try {
      // 처음 잇거나 다시 이을 때는 기다리지 않고 밀린 것부터 받는다(이어졌는지도 곧 안다).
      const wait = status === 'live' ? POLL_TIMEOUT_S : 0
      reply = await http.fetch(pollUrl(p, cursor, wait), { method: 'GET', headers: headers(p) })
    } catch {
      // 오류 문구에 요청 머리(토큰)가 섞일 수 있어 옮기지 않는다.
      if (g === gen) {
        watchdog.cancel()
        fail('연결 실패')
      }

      return
    }
    if (g !== gen) return
    watchdog.cancel()
    if (!reply.ok) return fail(`HTTP ${reply.status}`)
    const body = parsePoll(reply.text)
    if (body === null) return fail('응답 모양이 틀림')
    if (status !== 'live') log(`switchboard 메일함: ${p.role} 구독 중`)
    status = 'live'
    backoff = RETRY_MIN_MS
    for (const e of body.events) {
      if (known.has(e.id)) continue
      known.add(e.id)
      queued.push(e.id)
    }
    if (body.cursor > (cursor ?? -1)) cursor = body.cursor
    kick()
    // 받은 것이 있으면 곧바로 다음 대기(뒤에 더 있을 수 있다), 비었으면 잠깐 쉬고.
    if (body.events.length > 0) void poll()
    else schedule(EMPTY_GAP_MS)
  }

  /** 지금도 pending 인 ID 만 남긴다(바쁜 동안 세션이 스스로 읽은 메일은 알리지 않는다). 못 물으면 그대로. */
  const stillPending = async (p: MailProfile, ids: number[]): Promise<number[]> => {
    try {
      // 멈춘 요청이 알림을 막지 않게 한도를 건다(넘으면 거르지 않고 알린다).
      let timer: Timer | undefined
      const r = await Promise.race([
        http.fetch(pollUrl(p, null, 0), { method: 'GET', headers: headers(p) }),
        new Promise<null>(done => void (timer = clock.after(CHECK_TIMEOUT_MS, () => done(null)))),
      ]).finally(() => timer?.cancel())
      if (r === null) return ids
      const body = r.ok ? parsePoll(r.text) : null
      // 한 응답은 200건까지: 꽉 찼으면 뒤쪽은 모르므로 거르지 않는다.
      if (body === null || body.events.length >= 200) return ids
      const live = new Set(body.events.map(e => e.id))

      return ids.filter(i => live.has(i))
    } catch {
      return ids
    }
  }

  const gate = async (): Promise<'ready' | 'wait'> => {
    try {
      return (await opts.beforeDeliver?.()) ?? 'ready'
    } catch {
      return 'ready'
    }
  }

  const kick = () => {
    if (delivering || awaitingTurn || queued.length === 0 || profile === null || !opts.isIdle()) return
    delivering = true
    const p = profile
    const ids = [...queued].sort((a, b) => a - b)
    queued = []
    let failed = false
    void (async () => {
      const send = await stillPending(p, ids)
      if (profile === null) return
      if (send.length === 0) return
      // 확인하는 사이 턴이 시작됐으면 다음 턴 끝으로 미룬다.
      if (!opts.isIdle()) {
        queued = [...send, ...queued]

        return
      }
      // 관문(메일 전 compact 등): 기다리라면 되돌려 두고 끝난 뒤의 kick 에 맡긴다.
      if ((await gate()) === 'wait') {
        queued = [...send, ...queued]

        return
      }
      if (profile === null) return
      try {
        await host.submitTurn(announce(send))
        awaitingTurn = true
        grace?.cancel()
        grace = clock.after(TURN_GRACE_MS, () => {
          awaitingTurn = false
          kick()
        })
      } catch {
        // 넣지 못했다: 되돌려 놓고 잠시 뒤 다시.
        failed = true
        queued = [...send, ...queued]
        clock.after(RETRY_MIN_MS * 5, () => kick())
      }
    })().finally(() => {
      delivering = false
      // 확인하는 사이 새로 쌓인 것이 있으면 이어서(넣기가 실패했으면 위의 재시도에 맡긴다).
      if (!awaitingTurn && !failed) kick()
    })
  }

  const start = async () => {
    if (profile !== null) return true
    if (opts.profilePath === null) return false
    const loaded = await loadProfile(host.services.fs, opts.profilePath)
    if ('error' in loaded) {
      log(`switchboard 메일함 꺼짐: ${loaded.error}`)

      return false
    }
    profile = loaded
    status = 'connecting'
    off = host.on(e => {
      if (e.type === 'turn.start') {
        awaitingTurn = false
        grace?.cancel()
      }
      // 턴 끝·compact 끝: 쌓인 알림을 넣어 본다(유휴 판단은 isIdle).
      if (e.type === 'turn.complete' || e.type === 'compact.complete') kick()
    })
    void poll()

    return true
  }

  const stop = () => {
    gen++
    profile = null
    status = 'off'
    next?.cancel()
    watchdog?.cancel()
    grace?.cancel()
    off?.()
    off = undefined
  }

  return { start, stop, kick, state: () => ({ status, cursor, queued: [...queued] }) }
}
