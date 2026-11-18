// 원격 권한 답(D8): 권한 창이 뜨기 전에 요청(도구·짧은 요약)을 switchboard 서버에 올리고, 정한 시간 안에
// 부모나 대장이 그 요청 id 로 허락·거절하면 그 한 건에만 그대로 답한다(권한 규칙은 더하지 않는다).
// 시간 안에 답이 없거나 답할 쪽이 없으면(409) 결정하지 않고 화면의 권한 창으로 넘긴다.
//  - 서버 계약: #73 댓글 「서버 계약 6」. POST /api/permissions → 201(id 는 서버 발급), 답할 쪽이 없으면 409.
//    답은 GET /api/permissions/{id} 로 읽는다. 답이 오면 서버가 요청자에게 urgent 메일(task_id = 요청 id)을 보낸다:
//    그 사이는 서버 긴 대기(/api/events/poll)로 기다려 메일이 오면 곧 상태를 다시 읽는다. 답 메일은 세션에 넣지 않고 read 로만.
//  - 기다림은 훅 안에서 돈다. Claude 모드의 훅 예산(10초)은 `$` 응답을 기다리는 동안만 멈추므로 시계 타이머가 아니라
//    `$.http` 긴 대기로 기다린다(실제로 켜 보니 타이머로 기다리면 10초 뒤 창이 뜨고 늦은 답은 버려졌다).
//  - 서버가 답할 사람을 가린다. 여기서도 한 번 더 본다: 요청자 base 의 답은 버리고, 부모 base 나 대장 목록에
//    없는 쪽의 답도 버린다(목록이 둘 다 비었으면 요청자가 아닌 쪽이면 받는다 — 서버가 이미 가렸다). 서버가 whoami 로
//    협업 묶음을 안다고 답했으면(gated, #130) 묶음 대장도 답하므로 목록은 보지 않는다.
import { POLL_TIMEOUT_S } from './mailbox'
import type { CallIo, Mailbox, MailEvent } from './mailbox'
import type { AgentHost, Http } from './host'
import { httpWhy } from './wire'

/** 답을 기다리는 시간 기본값(ms). */
export const PERMISSION_WAIT_MS = 120_000
/** 상태를 다시 읽는 간격 상한(ms). 그 사이는 서버 긴 대기로 기다리고, 메일(답 알림)이 오면 곧 읽는다. */
export const PERMISSION_POLL_MS = 25_000
/** 서버 한도(바이트). */
export const TOOL_MAX_BYTES = 128
export const SUMMARY_MAX_BYTES = 500

export type PermissionAnswer = { decision: 'allow' | 'deny'; note?: string; by: string }

export type PermissionAsk = { tool: string; summary: string }

export type PermissionOptions = {
  /** 기다리는 시간(ms). 0 이면 원격 답을 쓰지 않는다. */
  waitMs?: number
  pollMs?: number
  /** 부모 말고도 답을 받을 대장 역할(기반 역할). */
  bosses?: readonly string[]
  /**
   * 서버가 협업 묶음을 아는가(대장 판정의 whoami 가 200, core/boss.ts). 참이면 답할 쪽(부모·전역·묶음 대장)은 서버가 이미
   * 가렸으므로 부모·대장 목록으로 거르지 않고 요청자 base 만 거른다(묶음 대장의 답을 버리지 않게).
   */
  gated?: () => boolean
  log?: (text: string) => void
}

export type Permissions = {
  /** 원격 답. 답이 없거나 쓸 수 없으면 null(화면 창으로). */
  /** io.http: 기다림에 쓸 fetch(Claude 모드에서는 그 훅의 `$.http`). */
  ask: (a: PermissionAsk, io?: { http?: Pick<Http, 'fetch'> }) => Promise<PermissionAnswer | null>
  stop: () => void
}

export const baseOf = (role: string) => role.replace(/-\d+$/, '')

/** UTF-8 바이트 한도로 자른다(글자 중간을 끊지 않는다). 잘랐으면 끝에 …. */
export const cutBytes = (text: string, max: number): string => {
  const enc = new TextEncoder()
  if (enc.encode(text).length <= max) return text
  let out = ''
  let used = enc.encode('…').length
  for (const ch of text) {
    const n = enc.encode(ch).length
    if (used + n > max) break
    used += n
    out += ch
  }

  return `${out}…`
}

/** 환경변수 글(초)로 기다림(ms). 비거나 숫자가 아니면 기본, 0 이면 끔. */
export const permissionWaitConfig = (seconds: string | undefined): number => {
  const t = (seconds ?? '').trim()
  if (!/^\d+(\.\d+)?$/.test(t)) return PERMISSION_WAIT_MS

  return Math.round(Number(t) * 1000)
}

/** 쉼표 목록(대장 역할). 비면 없음. */
export const bossRolesConfig = (text: string | undefined): string[] =>
  (text ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
    .map(baseOf)

type Request = { id: string; requester: string; parent?: string; status: string; decision?: string; note?: string; answered_by?: string }

/** 긴 대기 응답에서 커서만. */
const parseCursor = (text: string): number | null => {
  try {
    const raw: unknown = JSON.parse(text)

    return isRecord(raw) && typeof raw.cursor === 'number' ? raw.cursor : null
  } catch {
    return null
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const parseRequest = (text: string): Request | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.status !== 'string') return null
  const out: Request = { id: raw.id, requester: typeof raw.requester === 'string' ? raw.requester : '', status: raw.status }
  if (typeof raw.parent === 'string' && raw.parent !== '') out.parent = raw.parent
  if (typeof raw.decision === 'string') out.decision = raw.decision
  if (typeof raw.note === 'string' && raw.note !== '') out.note = raw.note
  if (typeof raw.answered_by === 'string' && raw.answered_by !== '') out.answered_by = raw.answered_by

  return out
}

/** 이 답을 받는가: 요청자 base 는 안 되고, 부모·대장 목록이 있으면 그 안이어야 한다(gated 면 목록은 보지 않는다). */
export const trustedAnswer = (req: { requester: string; parent?: string }, by: string, bosses: readonly string[], gated = false): boolean => {
  if (by === '' || baseOf(by) === baseOf(req.requester)) return false
  if (gated) return true
  const allowed = new Set([...(req.parent === undefined ? [] : [baseOf(req.parent)]), ...bosses.map(baseOf)])

  return allowed.size === 0 || allowed.has(baseOf(by))
}

export const createPermissions = (host: AgentHost, mail: Pick<Mailbox, 'call' | 'onUrgent' | 'state'>, opts: PermissionOptions = {}): Permissions => {
  const { clock } = host.services
  const waitMs = Math.max(0, opts.waitMs ?? PERMISSION_WAIT_MS)
  const pollMs = Math.max(500, opts.pollMs ?? PERMISSION_POLL_MS)
  const bosses = opts.bosses ?? []
  const log = (t: string) => {
    try {
      opts.log?.(t)
    } catch {
      // 기록이 실패해도 간다.
    }
  }
  /** 기다리는 요청 id → 그만두기. */
  const waiting = new Map<string, { give: () => void }>()
  /** 이 세션이 올렸던 요청 id(최근 50개): 답 알림 메일이 늦게 와도 세션에 넣지 않는다. */
  const mine: string[] = []
  const remember = (id: string) => {
    if (!mine.includes(id)) mine.push(id)
    if (mine.length > 50) mine.shift()
  }
  // 답 알림(urgent, task_id = 요청 id)은 세션에 넣지 않고 read 로만: 기다림은 긴 대기와 상태 읽기가 맡는다.
  const offTap = mail.onUrgent((e: MailEvent) => e.task_id !== undefined && (waiting.has(e.task_id) || mine.includes(e.task_id)))

  const ask = async (a: PermissionAsk, io0?: { http?: Pick<Http, 'fetch'> }): Promise<PermissionAnswer | null> => {
    if (waitMs === 0 || mail.state().status !== 'live') return null
    const r = await mail.call('/api/permissions', {
      method: 'POST',
      body: JSON.stringify({ tool: cutBytes(a.tool, TOOL_MAX_BYTES), summary: cutBytes(a.summary.trim() || a.tool, SUMMARY_MAX_BYTES) }),
    })
    if (r === null) return null
    if (r.status === 409) {
      log('switchboard 권한: 원격으로 답할 쪽이 없다(부모·대장 없음), 화면 창으로')

      return null
    }
    const req = r.ok ? parseRequest(r.text) : null
    if (req !== null) remember(req.id)
    if (req === null) {
      log(`switchboard 권한: 요청을 못 올림(${httpWhy(r.status, r.text)}), 화면 창으로`)

      return null
    }
    log(`switchboard 권한: ${req.id} 를 올렸다(${a.tool}), ${Math.round(waitMs / 1000)}초 기다린다`)
    const io: CallIo = io0?.http === undefined ? {} : { http: io0.http }
    const deadline = (await clock.now()) + waitMs
    let given = false
    waiting.set(req.id, { give: () => void (given = true) })
    const finish = (v: PermissionAnswer | null, why: string) => {
      waiting.delete(req.id)
      remember(req.id)
      log(`switchboard 권한: ${req.id} ${why}`)

      return v
    }
    // 기다림은 서버 긴 대기(새 메일이 오거나 시간이 다 될 때까지 응답을 미룬다)로 한다: 답이 오면 서버가 요청자에게
    // urgent 메일을 보내므로 곧 깨어난다. 시계 타이머로 기다리지 않는다 — Claude 모드의 훅 예산(10초)은 `$` 응답을
    // 기다리는 동안만 멈추고, 잠·타이머 동안은 흐른다.
    let after: number | null = mail.state().cursor
    for (;;) {
      if (given) return finish(null, '메일함이 꺼져 화면 창으로')
      const g = await mail.call(`/api/permissions/${encodeURIComponent(req.id)}`, {}, io)
      const cur = g !== null && g.ok ? parseRequest(g.text) : null
      if (cur !== null) {
        if (cur.status === 'expired') return finish(null, '만료, 화면 창으로')
        if (cur.status === 'allowed' || cur.status === 'denied') {
          const by = cur.answered_by ?? ''
          const fixed = { requester: req.requester || cur.requester, ...(req.parent === undefined ? {} : { parent: req.parent }) }
          if (!trustedAnswer(fixed, by, bosses, opts.gated?.() ?? false)) return finish(null, `의 답(${by || '?'})은 부모·대장이 아니라 버린다, 화면 창으로`)
          const ans: PermissionAnswer = { decision: cur.status === 'allowed' ? 'allow' : 'deny', by }
          if (cur.note !== undefined) ans.note = cur.note

          return finish(ans, `${by} 가 ${ans.decision === 'allow' ? '허락' : '거절'}했다`)
        }
      }
      const left = deadline - (await clock.now())
      if (left <= 0) return finish(null, `${Math.round(waitMs / 1000)}초 안에 답이 없어 화면 창으로`)
      const secs = Math.max(1, Math.min(POLL_TIMEOUT_S, Math.ceil(Math.min(left, pollMs) / 1000)))
      const r = await mail.call(`/api/events/poll?timeout=${secs}${after === null ? '' : `&after=${after}`}`, {}, { ...io, timeoutMs: secs * 1000 + 15_000 })
      const body = r !== null && r.ok ? parseCursor(r.text) : null
      if (body !== null) after = Math.max(after ?? 0, body)
      else if (r === null || !r.ok) {
        // 긴 대기가 안 되면(끊김 등) 마냥 돌지 않게 한 번 쉰다(이 쉼은 예산을 쓴다: 짧게).
        await new Promise<void>(done => void clock.after(1000, done))
      }
    }
  }

  const stop = () => {
    offTap()
    for (const w of [...waiting.values()]) w.give()
  }

  return { ask, stop }
}
