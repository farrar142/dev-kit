// switchboard 코어: 에이전트를 모른다. AgentHost 포트(host.ts)만 보고 세션의 바깥 상태(유휴·바쁨·compact 중,
// 사용자가 입력 중인가)를 따라간다. D2 이후의 메일함(SSE 구독·등급별 입력 줄·compact 판단·presence)이
// 이 위에 붙는다. 질문 패널 상태는 questions.ts 가 맡는다. 메일함은 mailbox.ts(D2).
import type { AgentHost, CompactResult, Features } from './host'
import { createMailbox } from './mailbox'
import type { Mailbox, MailboxOptions, MailboxState } from './mailbox'

export type Activity = 'idle' | 'busy' | 'compacting'

export type BoardState = {
  /** start 가 본 세션임을 확인했고 stop 하지 않았다. 꺼져 있으면 아무것도 넣지 않는다. */
  active: boolean
  activity: Activity
  /** 입력창에 사용자가 쓴 글이 있다. */
  typing: boolean
  /** 마지막으로 사용자가 입력창을 바꾸거나 제출한 시각(ms). 없으면 null. */
  lastInputAt: number | null
}

/** 실제로 쓸 수 있는 기능: 플래그가 켜져 있고 메서드도 있어야 한다. */
export const capabilities = (host: AgentHost): Features => ({
  midTurnInject: host.features.midTurnInject && host.injectMidTurn !== undefined,
  compact: host.features.compact && host.compact !== undefined,
})

export type Switchboard = {
  /** 본 세션이면 이벤트를 듣기 시작하고 true. 서브에이전트 등이면 아무것도 하지 않고 false. */
  start: () => Promise<boolean>
  stop: () => void
  state: () => BoardState
  /**
   * 대화를 줄인다. 기능이 없으면 건너뛰고(기능 낮추기), 턴이 돌거나 이미 줄이는 중이면 하지 않는다.
   * 끝(compact.complete 이벤트)은 activity 가 idle 로 돌아오는 것으로 본다.
   */
  compact: (instructions?: string) => Promise<CompactResult>
  /** 메일함 상태(꺼져 있으면 status off). */
  mail: () => MailboxState
}

export type SwitchboardOptions = {
  /** 메일함. 없거나 profilePath 가 null 이면 꺼진다. */
  mail?: Omit<MailboxOptions, 'isIdle' | 'activity' | 'beforeDeliver'>
  /** 일반 메일 전 compact(D3). 컨텍스트가 thresholdTokens 이상이면 먼저 줄인다. 없으면 하지 않는다. */
  compactBeforeMail?: { thresholdTokens: number; instructions?: string }
}

/** 메일 전 compact 기본 기준(토큰). */
export const DEFAULT_COMPACT_TOKENS = 200_000

/**
 * 환경변수 글로 메일 전 compact 설정을 만든다. tokens: 비면 기본 200k, `0`·`off` 이면 끔(undefined),
 * 숫자가 아니면 기본. 뒤에 k 를 붙여도 된다(`150k`). instructions: 비면 에이전트 기본 요약.
 */
export const compactConfig = (
  tokens: string | undefined,
  instructions: string | undefined,
): SwitchboardOptions['compactBeforeMail'] => {
  const t = (tokens ?? '').trim().toLowerCase()
  if (t === '0' || t === 'off') return undefined
  const m = /^(\d+(?:\.\d+)?)(k?)$/.exec(t)
  const n = m === null ? DEFAULT_COMPACT_TOKENS : Math.round(Number(m[1]) * (m[2] === 'k' ? 1000 : 1))
  const ins = (instructions ?? '').trim()

  return { thresholdTokens: n > 0 ? n : DEFAULT_COMPACT_TOKENS, ...(ins === '' ? {} : { instructions: ins }) }
}

export const createSwitchboard = (host: AgentHost, opts: SwitchboardOptions = {}): Switchboard => {
  const st: BoardState = { active: false, activity: 'idle', typing: false, lastInputAt: null }
  let off: (() => void) | undefined
  let mailbox: Mailbox | undefined
  /** 메일 전 compact 를 했고 아직 그 메일 턴이 돌지 않았다(줄여도 기준 위면 되풀이하지 않게). */
  let compactedForMail = false

  /**
   * 메일 턴 직전: 유휴이고 컨텍스트가 기준 이상이면 compact 를 걸고 'wait'. 완료 이벤트(compact.complete)가
   * 메일함을 다시 깨운다(시간 sleep 없음). 바쁘거나 기능이 없거나 기준 아래거나 거절되면 'ready'.
   */
  const compactBeforeMail = async (): Promise<'ready' | 'wait'> => {
    const cfg = opts.compactBeforeMail
    if (cfg === undefined || compactedForMail || !capabilities(host).compact || st.activity !== 'idle') return 'ready'
    let tokens: number
    try {
      tokens = (await host.usage()).tokens
    } catch {
      return 'ready'
    }
    if (tokens < cfg.thresholdTokens || st.activity !== 'idle') return 'ready'
    compactedForMail = true
    const r = await compact(cfg.instructions)

    // 받아들여졌으면 끝(compact.complete)까지 기다린다. 거절이면 그대로 넣는다.
    return r.done ? 'wait' : 'ready'
  }
  // 이벤트 순서대로 시각을 적는다(clock.now 는 비동기라 마지막 값만 남긴다).
  const stamp = () => {
    void host.services.clock.now().then(t => {
      st.lastInputAt = Math.max(st.lastInputAt ?? 0, t)
    })
  }

  const start = async () => {
    if (st.active) return true
    const me = await host.identity()
    if (!me.isMain) return false
    st.active = true
    off = host.on(e => {
      switch (e.type) {
        case 'turn.start':
          st.activity = 'busy'
          // 새 턴이 돌았다: 다음 메일 앞에서는 다시 compact 를 볼 수 있다.
          compactedForMail = false
          break
        case 'turn.complete':
          // compact 중에 끝난 턴(드묾)은 compact 완료가 마저 풀어 준다.
          if (st.activity === 'busy') st.activity = 'idle'
          break
        case 'compact.complete':
          st.activity = 'idle'
          break
        case 'input.change':
          st.typing = e.text.trim() !== ''
          stamp()
          break
        case 'input.submit':
          st.typing = false
          stamp()
          break
      }
    })
    // 메일함은 본 세션에서만. 듣는 순서상 위 상태가 먼저 바뀐 뒤 메일함이 턴 끝을 본다.
    if (opts.mail !== undefined) {
      mailbox = createMailbox(host, {
        ...opts.mail,
        isIdle: () => st.active && st.activity === 'idle',
        activity: () => st.activity,
        beforeDeliver: compactBeforeMail,
      })
      await mailbox.start().catch(() => false)
    }

    return true
  }

  const stop = () => {
    mailbox?.stop()
    mailbox = undefined
    off?.()
    off = undefined
    st.active = false
  }

  const compact = async (instructions?: string): Promise<CompactResult> => {
    if (!st.active) return { done: false, reason: 'inactive' }
    if (!capabilities(host).compact || host.compact === undefined) return { done: false, reason: 'unsupported' }
    if (st.activity !== 'idle') return { done: false, reason: st.activity }
    st.activity = 'compacting'
    try {
      const r = await host.compact(instructions)
      // 거절됐으면 완료 이벤트가 오지 않는다: 바로 되돌린다.
      if (!r.done && st.activity === 'compacting') st.activity = 'idle'

      return r
    } catch (err) {
      if (st.activity === 'compacting') st.activity = 'idle'

      return { done: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  const mail = (): MailboxState => mailbox?.state() ?? { status: 'off', cursor: null, queued: [] }

  return { start, stop, state: () => ({ ...st }), compact, mail }
}
