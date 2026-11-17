// switchboard 코어: 에이전트를 모른다. AgentHost 포트(host.ts)만 보고 세션의 바깥 상태(유휴·바쁨·compact 중,
// 사용자가 입력 중인가)를 따라간다. D2 이후의 메일함(SSE 구독·등급별 입력 줄·compact 판단·presence)이
// 이 위에 붙는다. 질문 패널 상태는 questions.ts 가 맡는다.
import type { AgentHost, CompactResult, Features } from './host'

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
}

export const createSwitchboard = (host: AgentHost): Switchboard => {
  const st: BoardState = { active: false, activity: 'idle', typing: false, lastInputAt: null }
  let off: (() => void) | undefined
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

    return true
  }

  const stop = () => {
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

  return { start, stop, state: () => ({ ...st }), compact }
}
