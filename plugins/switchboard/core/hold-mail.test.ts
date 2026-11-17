// D5 사람 입력 중·답한 직후 보류: 일반 메일 턴을 미루고, 입력을 지우거나 시간이 지나면 넣는다. 긴급은 따르지 않는다.
import { expect, test } from 'claude-code/testing'

import { announce } from './mailbox'
import { runTurn, setup } from './mailtest'
import { DEFAULT_HOLD_MS, DEFAULT_SHORT_TURN_MS, DEFAULT_TYPING_MS, holdConfig, shortTurnConfig, typingConfig } from './switchboard'
import { flush } from './testing'

const MIN = 60_000

test('보류: 입력창에 글이 있으면 일반 메일을 미루고, 글을 지우면 넣는다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.change', text: '이번 건은 ' })
  const a = mail.send()
  await host.clock.advance(4 * MIN)
  expect(host.turns).toEqual([])

  host.emit({ type: 'input.change', text: '' })
  await flush()
  expect(host.turns).toEqual([announce([a])])
})

test('보류: 사람이 보낸 턴이 끝난 뒤 보류 시간 동안 미루고, 지나면 넣는다(가짜 시계)', async () => {
  const { host, mail } = await setup({ board: { holdAfterUserMs: 3 * MIN } })
  host.emit({ type: 'input.submit', text: '이거 해 줘', origin: 'user' })
  host.emit({ type: 'turn.start' })
  const a = mail.send()
  await flush()
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns).toEqual([])

  await host.clock.advance(3 * MIN - 1)
  expect(host.turns).toEqual([])
  await host.clock.advance(1)
  expect(host.turns).toEqual([announce([a])])
})

test('보류: 보류 중 사람이 또 보내면 그 턴이 끝난 때부터 다시 센다', async () => {
  const { host, mail } = await setup({ board: { holdAfterUserMs: 3 * MIN } })
  host.emit({ type: 'input.submit', text: '하나', origin: 'user' })
  await runTurn(host)
  const a = mail.send()
  await host.clock.advance(2 * MIN)
  host.emit({ type: 'input.submit', text: '둘', origin: 'user' })
  await runTurn(host)
  await host.clock.advance(2 * MIN)
  expect(host.turns).toEqual([])
  await host.clock.advance(1 * MIN)
  expect(host.turns).toEqual([announce([a])])
})

test('보류: 플러그인이 넣은 턴(메일 알림 등)은 사람 입력으로 치지 않는다', async () => {
  const { host, mail } = await setup({ board: { holdAfterUserMs: 3 * MIN } })
  const a = mail.send()
  await flush()
  expect(host.turns).toEqual([announce([a])])
  // 알림 턴이 낸 제출 이벤트(origin plugin)와 그 턴.
  host.emit({ type: 'input.submit', text: host.turns[0]!, origin: 'plugin' })
  await runTurn(host)
  const b = mail.send()
  await flush()
  expect(host.turns).toEqual([announce([a]), announce([b])])
})

test('보류: 긴급 메일은 보류를 따르지 않는다', async () => {
  const { host, mail } = await setup({ board: { holdAfterUserMs: 3 * MIN } })
  host.emit({ type: 'input.change', text: '쓰는 중' })
  const n = mail.send()
  const u = mail.send('urgent', '급함')
  await flush()
  expect(host.turns.length).toBe(1)
  expect(host.turns[0]).toContain('급함')
  expect(mail.status(u)).toBe('read')
  expect(host.turns.some(t => t === announce([n]))).toBe(false)
})

test('보류: 질문 패널 답(noteUserInput)도 사람 입력이라 그 뒤 메일을 미뤄 겹치지 않는다', async () => {
  const { host, mail, board } = await setup({ board: { holdAfterUserMs: 3 * MIN } })
  // 패널이 답을 넣는다: 사람 입력으로 치고, 그 턴은 plugin origin 으로 들어온다.
  board.noteUserInput()
  host.emit({ type: 'input.submit', text: '[질문 패널 답] q1', origin: 'plugin' })
  const a = mail.send()
  await flush()
  expect(host.turns).toEqual([]) // 답 턴과 메일 턴이 겹치지 않는다.
  await runTurn(host)
  await host.clock.advance(3 * MIN)
  expect(host.turns).toEqual([announce([a])])
})

test('보류 설정: 분 단위 환경변수 글(기본 3분, 0 이면 끔)', () => {
  expect(holdConfig(undefined)).toBe(DEFAULT_HOLD_MS)
  expect(holdConfig('5')).toBe(5 * MIN)
  expect(holdConfig('0.5')).toBe(30_000)
  expect(holdConfig('0')).toBe(0)
  expect(holdConfig('곧')).toBe(DEFAULT_HOLD_MS)
})

test('보류: 0 이면 시간 보류 없이 턴이 끝나자마자 넣는다', async () => {
  const { host, mail } = await setup({ board: { holdAfterUserMs: 0 } })
  host.emit({ type: 'input.submit', text: '해 줘', origin: 'user' })
  host.emit({ type: 'turn.start' })
  const a = mail.send()
  await flush()
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns).toEqual([announce([a])])
})

// #123 사람이 안 쳤는데 입력 중으로 보아 메일을 미루던 것: 사람이 바꾼 것만 입력 중, 그것도 마지막 입력 뒤 상한까지.
test('입력 중(#123): 플러그인 채우기·엔진 쓰기(by other)는 글이 있어도 입력 중이 아니다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.change', text: '다른 플러그인이 채운 글', by: 'other' })
  const a = mail.send()
  await flush()
  expect(host.turns).toEqual([announce([a])])
})

test('입력 중(#123): 사람이 치던 글을 다른 쪽이 바꿔도 입력 중은 그대로, 비우면 풀린다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.change', text: '쓰는 중' })
  host.emit({ type: 'input.change', text: '쓰는 중 + 채움', by: 'other' })
  const a = mail.send()
  await host.clock.advance(1 * MIN)
  expect(host.turns).toEqual([])
  // 제출·지우기(clear)는 other 로 오지만 빈 글이면 입력 중을 푼다.
  host.emit({ type: 'input.change', text: '', by: 'other' })
  await flush()
  expect(host.turns).toEqual([announce([a])])
})

test('입력 중(#123): 기록 불러오기·되돌리기(by person)는 입력 중이다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.change', text: '지난번에 보낸 글', by: 'person' })
  const a = mail.send()
  await host.clock.advance(1 * MIN)
  expect(host.turns).toEqual([])
  host.emit({ type: 'input.change', text: '', by: 'person' })
  await flush()
  expect(host.turns).toEqual([announce([a])])
})

test('입력 중(#123): 마지막 사람 입력 뒤 상한(기본 5분)이 지나면 글이 남아 있어도 넣는다', async () => {
  const { host, mail, board } = await setup()
  host.emit({ type: 'input.change', text: '쓰다 만 글' })
  const a = mail.send()
  await host.clock.advance(3 * MIN)
  // 다시 치면 상한을 새로 센다.
  host.emit({ type: 'input.change', text: '쓰다 만 글 더' })
  await host.clock.advance(DEFAULT_TYPING_MS - 1)
  expect(host.turns).toEqual([])
  expect(board.state().typing).toBe(true)
  await host.clock.advance(1)
  expect(board.state().typing).toBe(false)
  expect(host.turns).toEqual([announce([a])])
})

test('입력 중(#123): 다른 쪽이 바꾼 것(by other)은 상한을 새로 세지 않는다', async () => {
  const { host, mail } = await setup({ board: { typingLimitMs: 2 * MIN } })
  host.emit({ type: 'input.change', text: '쓰는 중' })
  const a = mail.send()
  await host.clock.advance(1 * MIN)
  host.emit({ type: 'input.change', text: '쓰는 중 + 채움', by: 'other' })
  await host.clock.advance(1 * MIN)
  expect(host.turns).toEqual([announce([a])])
})

test('입력 중(#123): 상한 0 이면 글이 있는 동안 계속 미룬다', async () => {
  const { host, mail } = await setup({ board: { typingLimitMs: 0 } })
  host.emit({ type: 'input.change', text: '쓰는 중' })
  const a = mail.send()
  await host.clock.advance(60 * MIN)
  expect(host.turns).toEqual([])
  host.emit({ type: 'input.submit', text: '쓰는 중', origin: 'user' })
  await runTurn(host)
  await host.clock.advance(DEFAULT_HOLD_MS)
  expect(host.turns).toEqual([announce([a])])
})

test('입력 중(#123): typingConfig 는 분 글을 ms 로, 비거나 이상하면 기본 5분, 0 이면 상한 없음', () => {
  expect(typingConfig(undefined)).toBe(DEFAULT_TYPING_MS)
  expect(typingConfig('')).toBe(5 * MIN)
  expect(typingConfig('abc')).toBe(5 * MIN)
  expect(typingConfig('10')).toBe(10 * MIN)
  expect(typingConfig(' 0.5 ')).toBe(30_000)
  expect(typingConfig('0')).toBe(0)
})

// #125 긴 작업 턴 뒤에는 읽는 시간을 줄 까닭이 없다: 사람 턴 시작~끝이 짧은 턴 기준 이상이면 보류 없이 곧 넣는다.
test('읽기 보류(#125): 긴 턴(기준 2분 이상) 뒤에는 보류 없이 곧 메일을 넣는다', async () => {
  const { host, mail } = await setup({ board: { holdAfterUserMs: 3 * MIN } })
  host.emit({ type: 'input.submit', text: '오래 걸리는 일', origin: 'user' })
  host.emit({ type: 'turn.start' })
  const a = mail.send()
  await host.clock.advance(2 * MIN)
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns).toEqual([announce([a])])
})

test('읽기 보류(#125): 짧은 턴(기준 미만) 뒤에는 보류를 유지한다', async () => {
  const { host, mail } = await setup({ board: { holdAfterUserMs: 3 * MIN } })
  host.emit({ type: 'input.submit', text: '짧은 질문', origin: 'user' })
  host.emit({ type: 'turn.start' })
  const a = mail.send()
  await host.clock.advance(2 * MIN - 1)
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns).toEqual([])
  await host.clock.advance(3 * MIN - 1)
  expect(host.turns).toEqual([])
  await host.clock.advance(1)
  expect(host.turns).toEqual([announce([a])])
})

test('읽기 보류(#125): 기준을 바꾸면 따른다(30초), 0 이면 기준 없음이라 긴 턴도 늘 보류한다', async () => {
  const a30 = await setup({ board: { holdAfterUserMs: 3 * MIN, shortTurnMs: 30_000 } })
  a30.host.emit({ type: 'input.submit', text: '하나', origin: 'user' })
  a30.host.emit({ type: 'turn.start' })
  const m1 = a30.mail.send()
  await a30.host.clock.advance(30_000)
  a30.host.emit({ type: 'turn.complete' })
  await flush()
  expect(a30.host.turns).toEqual([announce([m1])])

  const zero = await setup({ board: { holdAfterUserMs: 3 * MIN, shortTurnMs: 0 } })
  zero.host.emit({ type: 'input.submit', text: '둘', origin: 'user' })
  zero.host.emit({ type: 'turn.start' })
  const m2 = zero.mail.send()
  await zero.host.clock.advance(30 * MIN)
  zero.host.emit({ type: 'turn.complete' })
  await flush()
  expect(zero.host.turns).toEqual([])
  await zero.host.clock.advance(3 * MIN)
  expect(zero.host.turns).toEqual([announce([m2])])
})

test('읽기 보류 설정(#125): 분 글, 비거나 이상하면 기본 2분, 0 이면 기준 없음', () => {
  expect(shortTurnConfig(undefined)).toBe(DEFAULT_SHORT_TURN_MS)
  expect(DEFAULT_SHORT_TURN_MS).toBe(2 * MIN)
  expect(shortTurnConfig('5')).toBe(5 * MIN)
  expect(shortTurnConfig('0.5')).toBe(30_000)
  expect(shortTurnConfig('0')).toBe(0)
  expect(shortTurnConfig('곧')).toBe(DEFAULT_SHORT_TURN_MS)
})
