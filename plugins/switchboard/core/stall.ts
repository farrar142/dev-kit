// 멈춤 감지(D8): 턴이 API 오류로 멈추거나 사람을 기다리면 알아서 이어 가거나 위에 알린다.
//  - 저절로 풀릴 수 있는 오류(rate_limit·overloaded·server_error)는 간격을 두 배씩 늘려(상한 있음) 「이어서 하라」 턴을 넣는다.
//    정한 횟수를 넘거나 그 밖의 오류는 condition 을 `error:<종류>` 로 두고 부모·대장에게 한 번 알린다(오류 본문은 안 넣는다).
//  - 사람을 기다리는 알림(권한 창·입력 양식 등; 쉬는 세션의 idle_prompt 는 제외)은 condition 을 `blocked:<종류>` 로 두고 부모에게 한 번 알린다.
//  - 다음 턴이 문제없이 돌면(그 턴에 오류가 없으면) 횟수와 「알렸음」을 지운다. 사람이 그새 턴을 넣으면 재시도는 거둔다.
//  - 심장박동 끊김(offline)과 라벨 미연결 통지는 서버가 한다(#73 서버 계약 6).
import type { AgentHost, HostEvent, Timer } from './host'

/** 저절로 풀릴 수 있는 오류 종류(Claude Code 의 분류). */
export const RETRYABLE = ['rate_limit', 'overloaded', 'server_error'] as const
/** 첫 재시도까지(ms). 그 뒤 두 배씩. */
export const RETRY_BASE_MS = 30_000
/** 재시도 간격 상한(ms). */
export const RETRY_CAP_MS = 10 * 60_000
/** 이만큼 이어서 실패하면 안 풀리는 오류로 보고 알린다. */
export const RETRY_MAX_TRIES = 8
/** 알리지 않는 알림 종류(사람을 기다리는 것이 아니다. idle_prompt 는 사람이 친 턴 뒤 60초마다 오는 쉬는 신호). */
export const QUIET_NOTIFICATIONS = ['auth_success', 'idle_prompt'] as const

export type StallNotice = {
  /** error: 안 풀리는 오류(부모와 대장), blocked: 사람을 기다림(부모). */
  kind: 'error' | 'blocked'
  /** 오류·알림 종류. */
  what: string
  /** error 일 때 재시도를 다 썼으면 그 횟수. */
  tries?: number
}

export type StallOptions = {
  /** condition 이 바뀌었다(null 이면 풀림). presence 에 싣는다. */
  setCondition: (c: string | null) => void
  notify: (n: StallNotice) => void
  retry?: { baseMs?: number; capMs?: number; maxTries?: number }
  log?: (text: string) => void
}

export type Stall = {
  onEvent: (e: HostEvent) => void
  stop: () => void
  /** 시험·상태 표시용. */
  state: () => { tries: number; retryAt: number | null; condition: string | null }
}

export const retryDelay = (tries: number, baseMs = RETRY_BASE_MS, capMs = RETRY_CAP_MS) => Math.min(capMs, baseMs * 2 ** Math.max(0, tries))

export const retryText = (kind: string, n: number) =>
  `switchboard: 직전 턴이 API 오류(${kind})로 멈췄다(${n}번째 다시 시도). 하던 일을 이어서 하라. 이미 끝났으면 짧게 끝났다고만 하라.`

export const createStall = (host: AgentHost, opts: StallOptions): Stall => {
  const { clock } = host.services
  const baseMs = opts.retry?.baseMs ?? RETRY_BASE_MS
  const capMs = opts.retry?.capMs ?? RETRY_CAP_MS
  const maxTries = opts.retry?.maxTries ?? RETRY_MAX_TRIES
  let tries = 0
  let timer: Timer | undefined
  let retryAt: number | null = null
  /** 이번 턴(마지막 turn.start 뒤)에 오류가 났다. */
  let failedThisTurn = false
  /** 알린 오류 종류(문제없는 턴이 돌 때까지 다시 알리지 않는다). */
  const notifiedErrors = new Set<string>()
  /** 이번 기다림을 알렸다(도구·턴이 움직이면 풀린다). */
  let blockedNotified = false
  let condition: string | null = null
  const set = (c: string | null) => {
    if (condition === c) return
    condition = c
    try {
      opts.setCondition(c)
    } catch {
      // presence 를 못 바꿔도 재시도·통지는 간다.
    }
  }
  const tell = (n: StallNotice) => {
    try {
      opts.notify(n)
    } catch {
      // 위와 같다.
    }
  }
  const cancel = () => {
    timer?.cancel()
    timer = undefined
    retryAt = null
  }
  const unblock = () => {
    blockedNotified = false
    if (condition?.startsWith('blocked:')) set(null)
  }

  const onFailure = (kind: string) => {
    failedThisTurn = true
    cancel()
    set(`error:${kind}`)
    if ((RETRYABLE as readonly string[]).includes(kind) && tries < maxTries) {
      const ms = retryDelay(tries, baseMs, capMs)
      tries++
      const n = tries
      opts.log?.(`switchboard: API 오류(${kind}), ${Math.round(ms / 1000)}초 뒤 이어서 하라고 넣는다(${n}/${maxTries})`)
      void clock.now().then(t => {
        if (timer !== undefined) retryAt = t + ms
      })
      timer = clock.after(ms, () => {
        timer = undefined
        retryAt = null
        void host.submitTurn(retryText(kind, n)).catch(() => undefined)
      })

      return
    }
    if (notifiedErrors.has(kind)) return
    notifiedErrors.add(kind)
    const exhausted = (RETRYABLE as readonly string[]).includes(kind)
    tell(exhausted ? { kind: 'error', what: kind, tries } : { kind: 'error', what: kind })
  }

  const onEvent = (e: HostEvent) => {
    switch (e.type) {
      case 'turn.start':
        // 사람이나 다른 메일이 턴을 넣었다: 기다리던 재시도는 할 일이 없다.
        cancel()
        // 앞 턴이 문제없이 끝났으면 처음부터 센다.
        if (!failedThisTurn) {
          tries = 0
          notifiedErrors.clear()
        }
        failedThisTurn = false
        unblock()
        if (condition?.startsWith('error:')) set(null)
        break
      case 'turn.complete':
      case 'tool.complete':
        unblock()
        break
      case 'stop.failure':
        onFailure(e.kind)
        break
      case 'notification':
        if ((QUIET_NOTIFICATIONS as readonly string[]).includes(e.kind)) break
        // 오류로 멈춘 뒤의 입력 대기는 오류 쪽이 이미 말한다.
        if (condition?.startsWith('error:')) break
        set(`blocked:${e.kind}`)
        if (blockedNotified) break
        blockedNotified = true
        tell({ kind: 'blocked', what: e.kind })
        break
    }
  }

  return { onEvent, stop: cancel, state: () => ({ tries, retryAt, condition }) }
}
