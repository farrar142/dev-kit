// #166: 백그라운드 서브에이전트가 도는 동안은 메일 앞에서 compact 를 걸지 않는다.
import { expect, test } from 'claude-code/testing'

import { inlined, setup } from './mailtest'
import { flush } from './testing'

const BOARD = { compactBeforeMail: { thresholdTokens: 200_000, instructions: '메일 전 정리' } }

test('서브에이전트 1개가 도는 동안 기준 이상이어도 compact 0번, 메일 턴 1번', async () => {
  const { host, mail } = await setup({ board: BOARD })
  host.setUsage({ tokens: 300_000 })
  host.emit({ type: 'subagent.start', id: 'a1' })
  const a = mail.send()
  await flush()
  expect(host.compacts).toEqual([])
  expect(host.turns).toEqual([inlined([a])])
})

test('끝 알림 뒤에는 같은 조건에서 compact 를 먼저 건다', async () => {
  const { host, mail } = await setup({ board: BOARD })
  host.setUsage({ tokens: 300_000 })
  host.emit({ type: 'subagent.start', id: 'a1' })
  host.emit({ type: 'subagent.stop', id: 'a1' })
  mail.send()
  await flush()
  expect(host.compacts).toEqual(['메일 전 정리'])
})

test('끝 알림이 두 번 와도 수가 음수가 되지 않고, 둘이 돌면 하나가 끝나도 막는다', async () => {
  const { host, mail } = await setup({ board: BOARD })
  host.setUsage({ tokens: 300_000 })
  host.emit({ type: 'subagent.stop', id: 'zz' })
  host.emit({ type: 'subagent.start', id: 'a1' })
  host.emit({ type: 'subagent.start', id: 'a2' })
  host.emit({ type: 'subagent.stop', id: 'a1' })
  host.emit({ type: 'subagent.stop', id: 'a1' })
  mail.send()
  await flush()
  expect(host.compacts).toEqual([])
})

test('끝 알림이 없으면 한도 시간 뒤 0으로 돌아가고 알림이 한 번 뜬다', async () => {
  const warns: string[] = []
  const { host, mail } = await setup({ board: { ...BOARD, subagentLimitMs: 10_000, warn: t => void warns.push(t) } })
  host.setUsage({ tokens: 300_000 })
  host.emit({ type: 'subagent.start', id: 'a1' })
  await host.clock.advance(9_000)
  expect(warns).toEqual([])
  await host.clock.advance(2_000)
  expect(warns.length).toBe(1)
  await host.clock.advance(5_000)
  expect(warns.length).toBe(1)
  mail.send()
  await flush()
  expect(host.compacts).toEqual(['메일 전 정리'])
})
