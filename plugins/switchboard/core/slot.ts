// 번호 역할 slot·presence(D6): 기반 역할과 기계·폴더 식별자로 서버에서 번호(`<base>-N`)를 받고,
// 상태가 바뀔 때와 60초마다 heartbeat 로 lease 를 늘리며 presence(상태·컨텍스트 토큰·마지막 턴 등)를 싣는다.
//  - 서버 계약: #73 댓글 「서버 계약 3: slot·lease(#20)」「서버 계약 4: presence(#21)」.
//  - 같은 기계·폴더로 다시 뜨면 서버가 원래 번호를 돌려준다(reclaimed). heartbeat 404 → 다시 register.
//  - 단일 역할(boss·coordinator 등)인데 -2 이상을 받으면 경고한다. takeover 로 -1 을 가져올 수 있다.
//  - 토큰은 요청 머리(Authorization)에만 싣는다. 몸·기록·경고 어디에도 넣지 않는다.
import type { AgentHost, Timer } from './host'

export type PresenceState = 'idle' | 'busy' | 'compacting'

/** heartbeat 에 실을 그때그때의 presence. 모르는 칸은 빼면 서버가 이전 값을 둔다. */
export type PresenceReport = { state: PresenceState; context_tokens?: number; last_turn_at?: string }

/** 이 세션을 가리키는 식별자(서버가 같은 기계·폴더를 같은 세션으로 본다). */
export type SlotIdentity = { machine: string; directory: string; sessionId: string; label?: string; parent?: string }

/** 서버가 준 배정(쓰는 칸만). */
export type SlotGrant = { role: string; base: string; number: number; otherActive: number; reclaimed: boolean }

/** 응답에만 있는 칸: 이번 요청으로 서버가 라벨 주소 보관 메일을 이 세션에 옮긴 건수(#73 서버 계약 5, 0이면 없음). */
type GrantReply = SlotGrant & { displaced?: string; heldDelivered?: number }

export type SlotAuth = { endpoint: string; role: string; token: string }

export type SlotOptions = {
  auth: SlotAuth
  identity: SlotIdentity
  presence: () => Promise<PresenceReport>
  /** 받은 번호 역할이 바뀌었다(처음 배정, 재배정, takeover, 남의 takeover 로 밀림). */
  onRole: (role: string) => void
  /** 단일 역할인데 -2 이상을 받았다(토스트 등). */
  warn?: (text: string) => void
  log?: (text: string) => void
  /** 중복을 경고할 단일 역할 이름(기반 역할의 마지막 `/` 뒤 이름이나 전체 이름). */
  singleRoles?: readonly string[]
}

export type TakeoverResult = { ok: true; role: string; displaced?: string } | { ok: false; reason: string }

export type Slot = {
  /** 처음 배정. 실패하면(옛 서버·끊김) null 이고 heartbeat 주기마다 다시 시도한다. */
  start: () => Promise<SlotGrant | null>
  /** 상태가 바뀌었다: 곧 heartbeat 로 보고한다(돌고 있으면 그 뒤에 한 번 더). */
  report: () => void
  takeover: () => Promise<TakeoverResult>
  /** 주기를 멈추고 lease 를 바로 끝낸다. */
  stop: () => void
  grant: () => SlotGrant | null
}

/** heartbeat 주기(서버 presence 간격과 같다. lease 는 이것의 3배). */
export const HEARTBEAT_MS = 60_000
/** slot 요청 하나의 한도. 넘으면 실패로 본다. */
export const SLOT_TIMEOUT_MS = 10_000
export const DEFAULT_SINGLE_ROLES = ['boss', 'coordinator'] as const

/** 환경변수 글(쉼표 목록)로 단일 역할 목록을 만든다. 비면 기본(boss, coordinator), `off` 면 없음. */
export const singleRolesConfig = (text: string | undefined): readonly string[] => {
  const t = (text ?? '').trim()
  if (t === '') return DEFAULT_SINGLE_ROLES
  if (t.toLowerCase() === 'off') return []

  return t.split(',').map(s => s.trim()).filter(s => s !== '')
}

/** 기반 역할이 단일 역할인가: 전체 이름이나 마지막 `/` 뒤 이름이 목록에 있으면. */
export const isSingleRole = (base: string, singles: readonly string[]) =>
  singles.includes(base) || singles.includes(base.slice(base.lastIndexOf('/') + 1))

export const duplicateWarning = (g: SlotGrant) =>
  `switchboard: ${g.base} 는 하나만 떠야 하는 역할인데 이 세션이 ${g.role} 를 받았다(다른 활성 세션 ${g.otherActive}개). ` +
  `번호 없이 온 메일은 ${g.base}-1 이 받는다. 이 세션이 맡아야 하면 /switchboard-takeover.`

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const parseGrant = (text: string): GrantReply | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const { role, base, number } = raw
  if (typeof role !== 'string' || typeof base !== 'string' || typeof number !== 'number') return null
  const g: GrantReply = {
    role,
    base,
    number,
    otherActive: typeof raw.other_active === 'number' ? raw.other_active : 0,
    reclaimed: raw.reclaimed === true,
  }
  if (isRecord(raw.displaced) && typeof raw.displaced.role === 'string') g.displaced = raw.displaced.role
  if (typeof raw.held_delivered === 'number' && raw.held_delivered > 0) g.heldDelivered = raw.held_delivered

  return g
}

type Action = 'register' | 'heartbeat' | 'takeover' | 'release'
type Reply = { kind: 'ok'; grant: GrantReply } | { kind: 'status'; status: number } | { kind: 'error' }

export const createSlot = (host: AgentHost, opts: SlotOptions): Slot => {
  const { http, clock } = host.services
  const singles = opts.singleRoles ?? DEFAULT_SINGLE_ROLES
  const say = (fn: ((t: string) => void) | undefined, text: string) => {
    try {
      fn?.(text)
    } catch {
      // 기록·경고가 실패해도 slot 은 간다.
    }
  }
  let grant: SlotGrant | null = null
  let stopped = false
  let tick: { cancel: () => void } | undefined
  /** heartbeat·register 가 도는 중. 그새 온 report 는 dirty 로 남겨 끝난 뒤 한 번 더. */
  let inflight = false
  let dirty = false
  let warnedFor: string | null = null
  let failing = false

  const body = async (action: Action): Promise<string> => {
    const id = opts.identity
    const b: Record<string, string | number> = { machine: id.machine, directory: id.directory }
    if (id.sessionId !== '') b.session_id = id.sessionId
    if (id.label !== undefined && id.label !== '') b.label = id.label
    if (id.parent !== undefined && id.parent !== '') b.parent = id.parent
    if (action !== 'release') {
      try {
        const p = await opts.presence()
        b.state = p.state
        if (p.context_tokens !== undefined && Number.isInteger(p.context_tokens) && p.context_tokens >= 0) b.context_tokens = p.context_tokens
        if (p.last_turn_at !== undefined) b.last_turn_at = p.last_turn_at
      } catch {
        // presence 를 못 모으면 lease 만 늘린다.
      }
    }

    return JSON.stringify(b)
  }

  const call = async (action: Action): Promise<Reply> => {
    const a = opts.auth
    let timer: Timer | undefined
    try {
      const r = await Promise.race([
        (async () =>
          http.fetch(`${a.endpoint}/api/slots/${action}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${a.token}`, 'X-Agent-Mail-Role': a.role, 'Content-Type': 'application/json' },
            body: await body(action),
          }))(),
        new Promise<null>(done => void (timer = clock.after(SLOT_TIMEOUT_MS, () => done(null)))),
      ]).finally(() => timer?.cancel())
      if (r === null) return { kind: 'error' }
      if (!r.ok) return { kind: 'status', status: r.status }
      const g = parseGrant(r.text)

      return g === null ? { kind: 'error' } : { kind: 'ok', grant: g }
    } catch {
      // 오류 문구에 요청 머리(토큰)가 섞일 수 있어 옮기지 않는다.
      return { kind: 'error' }
    }
  }

  const accept = (g: GrantReply, how: 'register' | 'heartbeat' | 'takeover') => {
    const was = grant?.role
    grant = { role: g.role, base: g.base, number: g.number, otherActive: g.otherActive, reclaimed: g.reclaimed }
    if (failing) say(opts.log, `switchboard slot: 다시 이어짐(${g.role})`)
    failing = false
    if (was !== g.role) {
      const why =
        how === 'register' ? (g.reclaimed ? '(원래 번호)' : '') : how === 'heartbeat' && was !== undefined ? `(다른 세션의 takeover 로 ${was} 에서 밀림)` : ''
      say(opts.log, `switchboard slot: ${g.role}${why} 로 구독한다`)
      opts.onRole(g.role)
    }
    // 보관 메일은 서버가 이미 이 주소로 옮겼다(새 ID): 구독이 그대로 받는다. 여기서는 기록만.
    if (g.heldDelivered !== undefined) say(opts.log, `switchboard slot: 라벨 ${opts.identity.label ?? '?'} 앞으로 보관된 메일 ${g.heldDelivered}건이 ${g.role} 로 왔다`)
    if (g.number >= 2 && isSingleRole(g.base, singles)) {
      if (warnedFor !== g.role) {
        warnedFor = g.role
        say(opts.warn, duplicateWarning(g))
      }
    } else warnedFor = null
  }

  const failed = (what: string, r: Reply) => {
    if (!failing) say(opts.log, `switchboard slot: ${what} 실패(${r.kind === 'status' ? `HTTP ${r.status}` : '연결·응답'}), ${HEARTBEAT_MS / 1000}초 뒤 다시`)
    failing = true
  }

  const register = async (): Promise<SlotGrant | null> => {
    const r = await call('register')
    if (stopped) return null
    if (r.kind === 'ok') {
      accept(r.grant, 'register')

      return grant
    }
    failed('번호 받기', r)

    return null
  }

  /** 한 번 보고: 번호가 없으면 register, 있으면 heartbeat(404 면 남에게 넘어갔다: 다시 register). */
  const beat = async () => {
    if (stopped) return
    if (inflight) {
      dirty = true

      return
    }
    inflight = true
    try {
      do {
        dirty = false
        if (grant === null) {
          await register()
          continue
        }
        const r = await call('heartbeat')
        if (stopped) return
        if (r.kind === 'ok') accept(r.grant, 'heartbeat')
        else if (r.kind === 'status' && r.status === 404) {
          say(opts.log, `switchboard slot: ${grant.role} lease 가 남에게 넘어감, 번호를 다시 받는다`)
          grant = null
          await register()
        } else failed('heartbeat', r)
      } while (dirty && !stopped)
    } finally {
      inflight = false
    }
  }

  const start = async () => {
    stopped = false
    tick?.cancel()
    tick = clock.every(HEARTBEAT_MS, () => void beat())
    inflight = true
    try {
      return await register()
    } finally {
      inflight = false
      if (dirty) void beat()
    }
  }

  const takeover = async (): Promise<TakeoverResult> => {
    if (stopped) return { ok: false, reason: '메일함이 꺼져 있다' }
    const r = await call('takeover')
    if (r.kind !== 'ok') {
      const reason =
        r.kind === 'status' ? (r.status === 409 ? `${opts.auth.role}-1 이 따로 등록된 역할이다(HTTP 409)` : `HTTP ${r.status}`) : '연결·응답 실패'

      return { ok: false, reason }
    }
    accept(r.grant, 'takeover')

    return r.grant.displaced === undefined ? { ok: true, role: r.grant.role } : { ok: true, role: r.grant.role, displaced: r.grant.displaced }
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    tick?.cancel()
    tick = undefined
    if (grant !== null) {
      grant = null
      void call('release')
    }
  }

  return { start, report: () => void beat(), takeover, stop, grant: () => (grant === null ? null : { ...grant }) }
}
