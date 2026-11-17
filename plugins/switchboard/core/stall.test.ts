// D8 멈춤 감지 단위 시험: 가짜 어댑터·가짜 시계로 재시도 간격·상한과 통지 한 번을 본다.
import { expect, test } from 'claude-code/testing'

import type { HostEvent } from './host'
import { createStall, retryDelay, retryText } from './stall'
import type { StallNotice } from './stall'
import { fakeHost, flush } from './testing'

const make = (retry = { baseMs: 1000, capMs: 4000, maxTries: 5 }) => {
  const host = fakeHost()
  const notices: StallNotice[] = []
  const conditions: (string | null)[] = []
  const stall = createStall(host, { retry, notify: n => void notices.push(n), setCondition: c => void conditions.push(c) })
  const ev = async (e: HostEvent) => {
    stall.onEvent(e)
    await flush()
  }

  return { host, stall, notices, conditions, ev }
}

test('멈춤: 재시도 간격은 두 배씩 늘고 상한에서 멈추며, 정한 횟수를 넘으면 한 번 알린다(가짜 시계)', async () => {
  const { host, stall, notices, ev } = make()
  const waits: number[] = []
  await ev({ type: 'turn.start' })
  for (let i = 0; i < 5; i++) {
    await ev({ type: 'stop.failure', kind: 'rate_limit' })
    await ev({ type: 'turn.complete' })
    expect(stall.state().condition).toBe('error:rate_limit')
    const before = host.turns.length
    let waited = 0
    while (host.turns.length === before && waited < 60_000) {
      await host.clock.advance(500)
      waited += 500
    }
    waits.push(waited)
    expect(host.turns.at(-1)).toBe(retryText('rate_limit', i + 1))
    // 넣은 재시도 턴이 돈다(또 실패한다).
    await ev({ type: 'turn.start' })
  }
  expect(waits).toEqual([1000, 2000, 4000, 4000, 4000])
  expect(notices).toEqual([])

  // 6번째: 다 썼다 → 재시도 없이 한 번 알린다. 다음 실패도 같은 종류면 다시 알리지 않는다.
  await ev({ type: 'stop.failure', kind: 'rate_limit' })
  await host.clock.advance(60_000)
  expect(host.turns.length).toBe(5)
  expect(notices).toEqual([{ kind: 'error', what: 'rate_limit', tries: 5 }])
  await ev({ type: 'turn.start' })
  await ev({ type: 'stop.failure', kind: 'rate_limit' })
  expect(notices.length).toBe(1)
})

test('멈춤: 재시도 뒤 턴이 문제없이 돌면 횟수를 지우고, 사람이 그새 턴을 넣으면 재시도는 거둔다', async () => {
  const { host, stall, ev } = make()
  await ev({ type: 'turn.start' })
  await ev({ type: 'stop.failure', kind: 'overloaded' })
  await host.clock.advance(1000)
  expect(host.turns.length).toBe(1)
  await ev({ type: 'turn.start' })
  await ev({ type: 'stop.failure', kind: 'overloaded' })
  expect(stall.state().tries).toBe(2)
  // 사람이 2초 안에 턴을 넣었다: 재시도는 넣지 않는다.
  await ev({ type: 'turn.start' })
  await host.clock.advance(10_000)
  expect(host.turns.length).toBe(1)
  expect(stall.state().condition).toBe(null)
  // 그 턴이 문제없이 끝났다 → 다음 턴에서 처음부터 센다.
  await ev({ type: 'turn.complete' })
  await ev({ type: 'turn.start' })
  await ev({ type: 'stop.failure', kind: 'server_error' })
  expect(stall.state().tries).toBe(1)
  await host.clock.advance(1000)
  expect(host.turns.at(-1)).toBe(retryText('server_error', 1))
})

test('멈춤: 안 풀리는 오류는 재시도하지 않고 통지 한 번, 문제없는 턴 뒤 다시 나면 또 한 번', async () => {
  const { host, stall, notices, conditions, ev } = make()
  await ev({ type: 'turn.start' })
  await ev({ type: 'stop.failure', kind: 'billing_error' })
  await ev({ type: 'turn.complete' })
  await host.clock.advance(60_000)
  expect(host.turns).toEqual([])
  expect(notices).toEqual([{ kind: 'error', what: 'billing_error' }])
  expect(conditions.at(-1)).toBe('error:billing_error')
  // 오류 뒤 입력 대기 알림은 오류가 이미 말했다: 따로 알리지 않는다.
  await ev({ type: 'notification', kind: 'idle_prompt' })
  expect(notices.length).toBe(1)
  // 사람이 다시 시켜도 같은 오류: 아직 문제없는 턴이 없었으니 다시 알리지 않는다.
  await ev({ type: 'turn.start' })
  await ev({ type: 'stop.failure', kind: 'billing_error' })
  expect(notices.length).toBe(1)
  // 문제없는 턴 하나 뒤에 다시 나면 또 알린다.
  await ev({ type: 'turn.start' })
  await ev({ type: 'turn.complete' })
  await ev({ type: 'turn.start' })
  expect(stall.state().condition).toBe(null)
  await ev({ type: 'stop.failure', kind: 'billing_error' })
  expect(notices.length).toBe(2)
})

test('기다림: 권한 창·입력 대기는 blocked:<종류> 로 두고 부모에게 한 번, 도구가 움직이면 풀린다', async () => {
  const { stall, notices, ev } = make()
  await ev({ type: 'turn.start' })
  await ev({ type: 'notification', kind: 'permission_prompt' })
  await ev({ type: 'notification', kind: 'permission_prompt' })
  expect(stall.state().condition).toBe('blocked:permission_prompt')
  expect(notices).toEqual([{ kind: 'blocked', what: 'permission_prompt' }])
  await ev({ type: 'tool.complete' })
  expect(stall.state().condition).toBe(null)
  await ev({ type: 'notification', kind: 'auth_success' })
  expect(stall.state().condition).toBe(null)
  await ev({ type: 'notification', kind: 'elicitation_dialog' })
  expect(stall.state().condition).toBe('blocked:elicitation_dialog')
  expect(notices.at(-1)).toEqual({ kind: 'blocked', what: 'elicitation_dialog' })
  expect(notices.length).toBe(2)
})

test('쉬는 세션: 턴이 끝난 뒤 idle_prompt 는 막힘이 아니다(idle 로 남고 부모 알림 없음)', async () => {
  const { stall, notices, conditions, ev } = make()
  await ev({ type: 'turn.start' })
  await ev({ type: 'turn.complete' })
  await ev({ type: 'notification', kind: 'idle_prompt' })
  expect(stall.state().condition).toBe(null)
  expect(notices).toEqual([])
  expect(conditions.filter(c => c !== null)).toEqual([])
})

test('재시도 간격 계산: 기본은 30초부터 두 배, 10분 상한', () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(n => retryDelay(n))).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
})
