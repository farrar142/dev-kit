import type { Register, Timer } from 'claude-code'

// Claude의 작업(턴)이 끝난 뒤 사용자가 IDLE_MS 동안 아무것도 입력하지 않으면 대화를 compact 한다.
// - 새 턴이 시작되거나(프롬프트 제출·백그라운드 알림 포함) 입력창에 글을 쓰면 타이머를 취소한다.
// - 컨텍스트가 MIN_PERCENT 미만이면 정리할 게 적으니 건너뛴다.
const IDLE_MS = 30 * 60 * 1000
const MIN_PERCENT = 15

export const register: Register = on => {
  let timer: Timer | undefined

  const cancel = () => {
    timer?.cancel()
    timer = undefined
  }

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) cancel()
    return next(e)
  })

  on('prompt.change', ($, e, next) => {
    cancel()
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    cancel()
    return next(e)
  }).catch(($, e, next) => next(e)) // 관찰만 한다. 실패해도 프롬프트는 그대로 보낸다.

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    cancel()
    timer = $.clock.after(IDLE_MS, () => {
      timer = undefined
      void (async () => {
        try {
          const { context } = await $.session.usage()
          if ((context.percent ?? 0) < MIN_PERCENT) return
          const { skip } = await $.session.compact()
          if (skip === undefined) $.ui.toast('idle-compact: 30분 동안 입력이 없어 대화를 정리했어요')
        } catch {
          // 그 사이 턴이 시작되면 compact 가 거절된다. 다음 턴이 끝날 때 다시 건다.
        }
      })()
    })
    return result
  })
}
