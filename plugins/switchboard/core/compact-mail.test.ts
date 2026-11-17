// D3 메일 전 compact: 유휴이고 컨텍스트가 기준 이상이면 compact 하고, 완료 이벤트 뒤에 메일 턴을 넣는다(sleep 없음).
import { expect, test } from 'claude-code/testing'

import { announce } from './mailbox'
import { runTurn, setup } from './mailtest'
import { compactConfig } from './switchboard'
import { flush } from './testing'

const BOARD = { compactBeforeMail: { thresholdTokens: 200_000, instructions: '메일 전 정리' } }

test('메일 전 compact: 기준 이상·유휴면 compact 하고, 완료 이벤트 뒤에야 메일을 넣는다', async () => {
  const { host, mail, board } = await setup({ board: BOARD })
  host.setUsage({ tokens: 250_000 })
  const a = mail.send()
  await flush()
  expect(host.compacts).toEqual(['메일 전 정리'])
  expect(board.state().activity).toBe('compacting')
  expect(host.turns).toEqual([]) // 완료 전에는 넣지 않는다.

  host.setUsage({ tokens: 30_000 })
  await host.clock.advance(0) // 가짜 어댑터가 compact.complete 를 보낸다(시간은 흐르지 않는다).
  expect(host.turns).toEqual([announce([a])])
  expect(host.compacts.length).toBe(1)
})

test('메일 전 compact: 줄여도 기준 위면 되풀이하지 않고 메일을 넣는다', async () => {
  const { host, mail } = await setup({ board: BOARD })
  host.setUsage({ tokens: 400_000 })
  const a = mail.send()
  await flush()
  await host.clock.advance(0)
  expect(host.compacts.length).toBe(1)
  expect(host.turns).toEqual([announce([a])])

  // 메일 턴이 돈 뒤의 다음 메일 앞에서는 다시 본다.
  await runTurn(host)
  const b = mail.send()
  await flush()
  expect(host.compacts.length).toBe(2)
  await host.clock.advance(0)
  expect(host.turns).toEqual([announce([a]), announce([b])])
})

test('메일 전 compact: 기준 아래면 compact 하지 않는다', async () => {
  const { host, mail } = await setup({ board: BOARD })
  host.setUsage({ tokens: 199_999 })
  const a = mail.send()
  await flush()
  expect(host.compacts).toEqual([])
  expect(host.turns).toEqual([announce([a])])
})

test('메일 전 compact: 바쁜 동안은 compact 하지 않고, 턴이 끝난 뒤 유휴에서 한다', async () => {
  const { host, mail } = await setup({ board: BOARD })
  host.setUsage({ tokens: 300_000 })
  host.emit({ type: 'turn.start' })
  const a = mail.send()
  await host.clock.advance(1_000)
  expect(host.compacts).toEqual([])
  expect(host.turns).toEqual([])

  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.compacts.length).toBe(1)
  await host.clock.advance(0)
  expect(host.turns).toEqual([announce([a])])
})

test('메일 전 compact: 기능 플래그가 없으면 건너뛰고 바로 넣는다', async () => {
  const { host, mail } = await setup({ board: BOARD, features: { compact: false } })
  host.setUsage({ tokens: 900_000 })
  const a = mail.send()
  await flush()
  expect(host.compacts).toEqual([])
  expect(host.turns).toEqual([announce([a])])
})

test('메일 전 compact: 어댑터가 거절하면(done:false) 그대로 넣는다', async () => {
  const { host, mail, board } = await setup({ board: BOARD })
  host.setUsage({ tokens: 300_000 })
  host.setCompactResult({ done: false, reason: 'nothing' })
  const a = mail.send()
  await flush()
  expect(board.state().activity).toBe('idle')
  expect(host.turns).toEqual([announce([a])])
})

test('메일 전 compact: 설정이 없으면 하지 않는다', async () => {
  const { host, mail } = await setup()
  host.setUsage({ tokens: 900_000 })
  const a = mail.send()
  await flush()
  expect(host.compacts).toEqual([])
  expect(host.turns).toEqual([announce([a])])
})

test('메일 전 compact 설정: 환경변수 글을 읽는다(기본 200k, k 단위, 0·off 는 끔)', () => {
  expect(compactConfig(undefined, undefined)).toEqual({ thresholdTokens: 200_000 })
  expect(compactConfig('150k', '  남길 것: 이슈 번호 ')).toEqual({ thresholdTokens: 150_000, instructions: '남길 것: 이슈 번호' })
  expect(compactConfig('120000', '')).toEqual({ thresholdTokens: 120_000 })
  expect(compactConfig('0', 'x')).toBeUndefined()
  expect(compactConfig('OFF', undefined)).toBeUndefined()
  expect(compactConfig('많이', undefined)).toEqual({ thresholdTokens: 200_000 })
})
