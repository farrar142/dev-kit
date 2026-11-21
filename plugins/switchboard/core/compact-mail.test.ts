// D3 메일 전 compact: 유휴이고 컨텍스트가 기준 이상이면 compact 하고, 완료 이벤트 뒤에 메일 턴을 넣는다(sleep 없음).
import { expect, test } from 'claude-code/testing'

import { inlined, runTurn, setup } from './mailtest'
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
  expect(host.turns).toEqual([inlined([a])])
  expect(host.compacts.length).toBe(1)
})

test('메일 전 compact: 줄여도 기준 위면 되풀이하지 않고 메일을 넣는다', async () => {
  const { host, mail } = await setup({ board: BOARD })
  host.setUsage({ tokens: 400_000 })
  const a = mail.send()
  await flush()
  await host.clock.advance(0)
  expect(host.compacts.length).toBe(1)
  expect(host.turns).toEqual([inlined([a])])

  // 메일 턴이 돈 뒤의 다음 메일 앞에서는 다시 본다.
  await runTurn(host)
  const b = mail.send()
  await flush()
  expect(host.compacts.length).toBe(2)
  await host.clock.advance(0)
  expect(host.turns).toEqual([inlined([a]), inlined([b])])
})

test('메일 전 compact: 기준 아래면 compact 하지 않는다', async () => {
  const { host, mail } = await setup({ board: BOARD })
  host.setUsage({ tokens: 199_999 })
  const a = mail.send()
  await flush()
  expect(host.compacts).toEqual([])
  expect(host.turns).toEqual([inlined([a])])
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
  expect(host.turns).toEqual([inlined([a])])
})

test('메일 전 compact: 기능 플래그가 없으면 건너뛰고 바로 넣는다', async () => {
  const { host, mail } = await setup({ board: BOARD, features: { compact: false } })
  host.setUsage({ tokens: 900_000 })
  const a = mail.send()
  await flush()
  expect(host.compacts).toEqual([])
  expect(host.turns).toEqual([inlined([a])])
})

test('메일 전 compact: 어댑터가 거절하면(done:false) 그대로 넣는다', async () => {
  const { host, mail, board } = await setup({ board: BOARD })
  host.setUsage({ tokens: 300_000 })
  host.setCompactResult({ done: false, reason: 'nothing' })
  const a = mail.send()
  await flush()
  expect(board.state().activity).toBe('idle')
  expect(host.turns).toEqual([inlined([a])])
})

test('메일 전 compact: 설정이 없으면 하지 않는다', async () => {
  const { host, mail } = await setup()
  host.setUsage({ tokens: 900_000 })
  const a = mail.send()
  await flush()
  expect(host.compacts).toEqual([])
  expect(host.turns).toEqual([inlined([a])])
})

test('메일 전 compact 설정: 환경변수 글을 읽는다(기본 200k, k 단위, 0·off 는 끔)', () => {
  expect(compactConfig(undefined, undefined)).toEqual({ thresholdTokens: 200_000 })
  expect(compactConfig('150k', '  남길 것: 이슈 번호 ')).toEqual({ thresholdTokens: 150_000, instructions: '남길 것: 이슈 번호' })
  expect(compactConfig('120000', '')).toEqual({ thresholdTokens: 120_000 })
  expect(compactConfig('0', 'x')).toBeUndefined()
  expect(compactConfig('OFF', undefined)).toBeUndefined()
  expect(compactConfig('많이', undefined)).toEqual({ thresholdTokens: 200_000 })
})

// #104: resume 직후 이미 기준을 넘은 세션. 연결 전에 와 있던 메일 앞에서 compact 를 거는데, 요청이
// 받아들여지고도 실제로는 시작되지 않으면(완료 이벤트 없음) compacting 에 갇혀 메일을 못 받았다.
const RESUMED = { ...BOARD, compactTimeoutMs: 5 * 60_000 }

test('resume 직후 기준 이상: compact 가 완료 이벤트 없이 끝나지 않으면 시간 뒤 풀고 메일을 넣는다(알림 한 번)', async () => {
  const warns: string[] = []
  const { host, mail, board } = await setup({ board: { ...RESUMED, warn: t => void warns.push(t) }, preload: 1, usage: { tokens: 243_500 }, compact: 'silent' })
  expect(host.compacts.length).toBe(1)
  expect(board.state().activity).toBe('compacting')
  expect(host.turns).toEqual([])

  await host.clock.advance(5 * 60_000)
  expect(board.state().activity).toBe('idle')
  expect(host.turns.length).toBe(1)
  expect(warns.length).toBe(1)
  expect(warns[0]).toContain('compact')

  // 같은 메일 턴이 돌기 전에는 다시 걸지 않고, 다음 메일도 막히지 않는다.
  const b = mail.send()
  await host.clock.advance(5 * 60_000)
  expect(host.compacts.length).toBe(1)
  await runTurn(host)
  expect(host.turns.at(-1)).toEqual(inlined([b]))
  expect(warns.length).toBe(1)
})

test('resume 직후 기준 이상: compact 호출이 풀리지 않아도(hang) 시간 뒤 풀고 메일을 넣는다', async () => {
  const warns: string[] = []
  const { host, board } = await setup({ board: { ...RESUMED, warn: t => void warns.push(t) }, preload: 1, usage: { tokens: 243_500 }, compact: 'hang' })
  expect(board.state().activity).toBe('compacting')
  await host.clock.advance(5 * 60_000)
  expect(board.state().activity).toBe('idle')
  expect(host.turns.length).toBe(1)
  expect(warns.length).toBe(1)
})

test('resume 직후 기준 이상: compact 가 제때 끝나면 알림 없이 메일을 넣고, 늦은 시간 초과는 아무것도 하지 않는다', async () => {
  const warns: string[] = []
  const { host, board } = await setup({ board: { ...RESUMED, warn: t => void warns.push(t) }, preload: 1, usage: { tokens: 243_500 } })
  expect(host.compacts.length).toBe(1)
  await host.clock.advance(0)
  expect(host.turns.length).toBe(1)
  host.emit({ type: 'turn.start' })
  await host.clock.advance(5 * 60_000)
  expect(board.state().activity).toBe('busy')
  expect(warns).toEqual([])
})

test('컨텍스트 토큰 수를 모르면(0·읽기 실패) 기준 판정을 하지 않고 바로 넣는다', async () => {
  const { host, mail } = await setup({ board: { ...BOARD, compactBeforeMail: { thresholdTokens: 0 } } })
  host.setUsage({ tokens: 0 })
  const a = mail.send()
  await flush()
  expect(host.compacts).toEqual([])
  expect(host.turns).toEqual([inlined([a])])
})
