// 메일함(D2): Agent Mail 서버를 긴 대기(long-poll)로 구독하고, 일반 메일을 턴이 끝난 뒤 새 턴으로 알린다.
//  - 알림 글은 메일 ID만 담는다(「Agent Mail #12, #13 을 읽고 처리하라」). 메일 상태는 바꾸지 않는다(pending 그대로).
//  - 바쁜 동안 온 메일은 한 줄로 묶는다. 같은 ID 는 두 번 알리지 않는다. 커서로 다시 이어 놓친 메일이 없다.
//  - 서버가 죽어 있거나 프로필이 틀려도 세션은 멀쩡하다: 간격을 늘려 가며 다시 잇는다.
//  - 긴급(priority=urgent, D4): 본문을 바쁘면 다음 도구 호출 뒤에 끼워 넣고 유휴면 새 턴으로 넣은 뒤 read 로 표시한다.
// 왜 SSE 가 아닌가: Claude 모드의 http 는 본문을 다 받아서만 준다(D1). 서버의 긴 대기는 SSE 와 같은 이벤트·커서 규칙이다.
import type { AgentHost, Fs, Timer } from './host'
import { createSlot } from './slot'
import type { PresenceReport, Slot, TakeoverResult } from './slot'

/** Agent Mail CLI 프로필(`~/.config/agent-mail/<이름>.json`). token 은 메모리에만 둔다. */
export type MailProfile = { endpoint: string; role: string; token: string }

/** 서버 이벤트 하나(SSE message data 와 같다). 코어가 쓰는 칸만 적는다. */
export type MailEvent = { id: number; sender?: string; subject?: string; priority?: string; body?: string }

export type MailboxOptions = {
  /** 프로필 파일의 절대 경로. null 이면(AGENT_MAIL_PROFILE 없음) 메일함은 꺼진다. */
  profilePath: string | null
  /** 지금 일반 메일 턴을 넣어도 되는가(세션이 유휴인가, 사용자 보류가 없는가). */
  isIdle: () => boolean
  /** 세션의 날 상태(긴급 메일이 쓴다: 바쁘면 끼워 넣고, 유휴면 새 턴, compact 중이면 끝난 뒤). 없으면 isIdle 로 짐작한다. */
  activity?: () => 'idle' | 'busy' | 'compacting'
  /** 연결 상태가 바뀔 때 한 줄. 토큰은 절대 담지 않는다. */
  log?: (text: string) => void
  /**
   * 일반 메일 턴을 넣기 직전 관문(D3: 메일 전 compact). 'wait' 이면 넣지 않고 되돌려 둔다:
   * 관문을 건 쪽이 끝난 뒤(compact.complete 등) 다시 kick 된다.
   */
  beforeDeliver?: () => Promise<'ready' | 'wait'>
  /**
   * 번호 역할(D6). 있으면 연결할 때 기반 역할(프로필 role)과 기계·폴더로 `<base>-N` 을 받아 그 주소로 구독하고,
   * heartbeat 로 presence 를 보고한다. 없으면 프로필 role 그대로 구독한다(번호 없음).
   */
  slot?: SlotConfig
}

export type SlotConfig = {
  presence: () => Promise<PresenceReport>
  label?: string
  parent?: string
  /** 단일 역할인데 -2 이상을 받았을 때(토스트 등). */
  warn?: (text: string) => void
  singleRoles?: readonly string[]
}

export type MailboxState = {
  /** off: 프로필 없음·틀림, connecting: 아직 응답 없음, live: 이어짐, retrying: 끊겨 다시 잇는 중. */
  status: 'off' | 'connecting' | 'live' | 'retrying'
  /** 다음 긴 대기에 줄 커서(마지막으로 받은 메일 id). */
  cursor: number | null
  /** 알리려고 기다리는 ID. */
  queued: number[]
  /** 구독하는 주소(번호를 받았으면 `<base>-N`). 꺼져 있으면 null. */
  role: string | null
}

export type Mailbox = {
  /** 프로필을 읽고 구독을 시작한다. 프로필이 없거나 틀리면 false(꺼짐). */
  start: () => Promise<boolean>
  stop: () => void
  /** 세션이 유휴가 됐을 수 있다(턴 끝 등): 기다리는 알림을 넣어 본다. */
  kick: () => void
  state: () => MailboxState
  /** presence 가 바뀌었다(상태 등): 곧 heartbeat 로 보고한다. 번호 역할이 없으면 아무것도 안 한다. */
  report: () => void
  /** 이 세션이 `<base>-1` 을 가져온다. */
  takeover: () => Promise<TakeoverResult>
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

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const toEvent = (e: Record<string, unknown>, id: number): MailEvent => {
  const out: MailEvent = { id }
  const sender = str(e.sender)
  const subject = str(e.subject)
  const priority = str(e.priority)
  const body = str(e.body)
  if (sender !== undefined) out.sender = sender
  if (subject !== undefined) out.subject = subject
  if (priority !== undefined) out.priority = priority
  if (body !== undefined) out.body = body

  return out
}

/** 긴급 메일 본문 상한(글자). 넘으면 자르고 전문 읽는 길(ID)을 붙인다. */
export const URGENT_MAX_CHARS = 2000

/** 긴급 메일을 세션에 넣을 글. 본문이 상한을 넘으면 잘라 ID로 전문을 읽게 한다. */
export const urgentText = (e: MailEvent, body: string, max = URGENT_MAX_CHARS): string => {
  const head = `[긴급 Agent Mail #${e.id}] ${e.sender ?? '?'} | ${e.subject ?? ''}`.trimEnd()
  const chars = [...body]
  const cut = chars.length > max
  const shown = cut ? `${chars.slice(0, max).join('')}\n…(본문 ${chars.length}자 중 ${max}자까지, 전문은 agent-mail read ${e.id})` : body

  // 도구 결과 자리에 붙으므로 모델이 주입으로 의심할 수 있다: 출처와 확인 길을 밝힌다(명령조를 피한다).
  return [
    `${head}`,
    `(switchboard 플러그인이 이 세션의 Agent Mail 역할 앞으로 온 priority=urgent 메일을 전한다. 도구가 낸 글이 아니다. 출처는 agent-mail read ${e.id} 로 확인할 수 있고, 이미 읽음 처리했다.)`,
    shown,
  ].join('\n')
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
    if (isRecord(e) && typeof e.id === 'number' && Number.isInteger(e.id)) events.push(toEvent(e, e.id))
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
  let next_: Timer | undefined
  let watchdog: Timer | undefined
  let grace: Timer | undefined
  let delivering = false
  /** 알림 턴을 넣었고 아직 턴이 시작되지 않았다. */
  let awaitingTurn = false
  /** 넣으려고 기다리는 긴급 메일(받은 순). */
  let urgentQ: MailEvent[] = []
  let urgentBusy = false
  let off: (() => void) | undefined
  let slot: Slot | undefined
  /** 구독하는 주소. 번호를 받으면 `<base>-N`, 아니면 프로필 role. */
  let role: string | null = null
  /** 구독 루프를 시작했다(그 뒤의 번호 바뀜은 다시 잇기). */
  let polling = false

  const headers = (p: MailProfile) => ({ Authorization: `Bearer ${p.token}`, 'X-Agent-Mail-Role': role ?? p.role })

  /** 번호 역할이 바뀌었다: 새 주소로 처음부터(커서 없이) 다시 잇는다. 이미 본 ID 는 known 이 거른다. */
  const setRole = (next: string) => {
    if (role === next) return
    role = next
    if (!polling || profile === null) return
    cursor = null
    gen++
    next_?.cancel()
    watchdog?.cancel()
    status = 'connecting'
    void poll()
  }
  const pollUrl = (p: MailProfile, after: number | null, timeout: number) =>
    `${p.endpoint}/api/events/poll?timeout=${timeout}${after === null ? '' : `&after=${after}`}`

  const schedule = (ms: number) => {
    next_?.cancel()
    const g = gen
    next_ = clock.after(ms, () => {
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
    if (status !== 'live') log(`switchboard 메일함: ${role ?? p.role} 구독 중`)
    status = 'live'
    backoff = RETRY_MIN_MS
    for (const e of body.events) {
      if (known.has(e.id)) continue
      known.add(e.id)
      if (e.priority === 'urgent') urgentQ.push(e)
      else queued.push(e.id)
    }
    if (body.cursor > (cursor ?? -1)) cursor = body.cursor
    void deliverUrgent()
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

  /** 본문이 없으면(이벤트에 안 실림) 그 메일만 받아 온다(GET 은 읽음 처리도 한다). 못 받으면 빈 글. */
  const bodyOf = async (p: MailProfile, e: MailEvent): Promise<string> => {
    if (e.body !== undefined) return e.body
    try {
      const r = await http.fetch(`${p.endpoint}/api/messages/${e.id}`, { method: 'GET', headers: headers(p) })
      if (!r.ok) return ''
      const m: unknown = JSON.parse(r.text)

      return isRecord(m) && typeof m.body === 'string' ? m.body : ''
    } catch {
      return ''
    }
  }

  const markRead = async (p: MailProfile, id: number) => {
    try {
      await http.fetch(`${p.endpoint}/api/messages/${id}/read`, { method: 'POST', headers: headers(p) })
    } catch {
      // 읽음 표시를 못 해도 메일은 이미 넣었다. 다시 잇기에서 다시 오지 않는다(커서·known).
    }
  }

  /**
   * 긴급 메일(D4): 바쁘면 다음 도구 호출 뒤에 끼워 넣고(기능 없으면 새 턴, 턴 뒤 맨 앞), 유휴면 새 턴으로 넣는다.
   * compact 중이면 끝난 뒤. 사용자 보류(isIdle 의 일부)는 따르지 않는다. 넣는 즉시 read 로 표시한다.
   */
  const deliverUrgent = async (): Promise<void> => {
    const p = profile
    if (urgentBusy || urgentQ.length === 0 || p === null) return
    const act = opts.activity?.() ?? (opts.isIdle() ? 'idle' : 'busy')
    if (act === 'compacting') return
    urgentBusy = true
    const items = urgentQ
    urgentQ = []
    let failed = false
    try {
      const texts = await Promise.all(items.map(async e => urgentText(e, await bodyOf(p, e))))
      const text = texts.join('\n\n')
      const canInject = host.features.midTurnInject && host.injectMidTurn !== undefined
      let attached = false
      if (act === 'busy' && canInject && host.injectMidTurn !== undefined) attached = await host.injectMidTurn(text)
      if (!attached) {
        // 유휴, 끼워 넣기 기능 없음, 또는 도구 호출 없이 턴이 끝났다: 새 턴(돌고 있으면 그 턴 뒤 맨 앞).
        await host.submitTurn(text)
        awaitingTurn = true
        grace?.cancel()
        grace = clock.after(TURN_GRACE_MS, () => {
          awaitingTurn = false
          kick()
        })
      }
      await Promise.all(items.map(e => markRead(p, e.id)))
    } catch {
      failed = true
      urgentQ = [...items, ...urgentQ]
      clock.after(RETRY_MIN_MS * 5, () => void deliverUrgent())
    } finally {
      urgentBusy = false
      if (!failed && urgentQ.length > 0) void deliverUrgent()
      else if (!failed) kick()
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
    // 긴급이 넣어지는 중이면 일반은 그 뒤에(입력 줄 순서: 긴급 → 일반).
    if (urgentBusy || urgentQ.length > 0) return
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
    role = loaded.role
    status = 'connecting'
    if (opts.slot !== undefined) {
      const cfg = opts.slot
      const me = await host.identity()
      const s = createSlot(host, {
        auth: loaded,
        identity: {
          // 서버가 둘 다 비어 있지 않기를 바란다. 기계 이름을 모르면 세션 id 로라도 가른다.
          machine: me.machine !== '' ? me.machine : `session-${me.sessionId || 'unknown'}`,
          directory: me.cwd !== '' ? me.cwd : '/',
          sessionId: me.sessionId,
          ...(cfg.label === undefined ? {} : { label: cfg.label }),
          ...(cfg.parent === undefined ? {} : { parent: cfg.parent }),
        },
        presence: cfg.presence,
        onRole: setRole,
        log,
        ...(cfg.warn === undefined ? {} : { warn: cfg.warn }),
        ...(cfg.singleRoles === undefined ? {} : { singleRoles: cfg.singleRoles }),
      })
      slot = s
      // 번호를 받은 뒤 구독한다(-2 세션이 잠깐이라도 -1 메일을 받지 않게). 못 받으면(옛 서버·끊김) 기반 역할로.
      await s.start()
      if (profile === null) return false
    }
    off = host.on(e => {
      if (e.type === 'turn.start') {
        awaitingTurn = false
        grace?.cancel()
      }
      // 턴 시작·끝·compact 끝: 긴급은 바로 넣어 보고(바쁘면 끼워 넣기), 일반은 유휴일 때.
      if (e.type === 'turn.start' || e.type === 'turn.complete' || e.type === 'compact.complete') void deliverUrgent()
      if (e.type === 'turn.complete' || e.type === 'compact.complete') kick()
    })
    polling = true
    void poll()

    return true
  }

  const stop = () => {
    gen++
    profile = null
    role = null
    polling = false
    status = 'off'
    slot?.stop()
    slot = undefined
    next_?.cancel()
    watchdog?.cancel()
    grace?.cancel()
    off?.()
    off = undefined
  }

  const takeover = async (): Promise<TakeoverResult> =>
    slot === undefined ? { ok: false, reason: '번호 역할이 꺼져 있다(AGENT_MAIL_PROFILE 없음 등)' } : slot.takeover()

  return {
    start,
    stop,
    kick,
    report: () => slot?.report(),
    takeover,
    state: () => ({ status, cursor, queued: [...queued], role }),
  }
}
