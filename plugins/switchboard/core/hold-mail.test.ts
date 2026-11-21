// 사람 입력 중 보류: 일반 메일 턴을 미루고, 입력을 지우거나 시간이 지나면 넣는다. 긴급은 따르지 않는다. 답한 직후 읽기 보류는 없다(#172).
import { expect, test } from 'claude-code/testing'

import { inlined, runTurn, setup } from './mailtest'
import { DEFAULT_TYPING_MS, typingConfig } from './switchboard'
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
  expect(host.turns).toEqual([inlined([a])])
})

test('보류: 플러그인이 넣은 턴(메일 알림 등)은 사람 입력으로 치지 않는다', async () => {
  const { host, mail } = await setup()
  const a = mail.send()
  await flush()
  expect(host.turns).toEqual([inlined([a])])
  // 알림 턴이 낸 제출 이벤트(origin plugin)와 그 턴.
  host.emit({ type: 'input.submit', text: host.turns[0]!, origin: 'plugin' })
  await runTurn(host)
  const b = mail.send()
  await flush()
  expect(host.turns).toEqual([inlined([a]), inlined([b])])
})

test('보류: 긴급 메일은 보류를 따르지 않는다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.change', text: '쓰는 중' })
  const n = mail.send()
  const u = mail.send('urgent', '급함')
  await flush()
  expect(host.turns.length).toBe(1)
  expect(host.turns[0]).toContain('급함')
  expect(mail.status(u)).toBe('read')
  expect(host.turns.some(t => t === inlined([n]))).toBe(false)
})

// #123 사람이 안 쳤는데 입력 중으로 보아 메일을 미루던 것: 사람이 바꾼 것만 입력 중, 그것도 마지막 입력 뒤 상한까지.
test('입력 중(#123): 플러그인 채우기·엔진 쓰기(by other)는 글이 있어도 입력 중이 아니다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.change', text: '다른 플러그인이 채운 글', by: 'other' })
  const a = mail.send()
  await flush()
  expect(host.turns).toEqual([inlined([a])])
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
  expect(host.turns).toEqual([inlined([a])])
})

test('입력 중(#123): 기록 불러오기·되돌리기(by person)는 입력 중이다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.change', text: '지난번에 보낸 글', by: 'person' })
  const a = mail.send()
  await host.clock.advance(1 * MIN)
  expect(host.turns).toEqual([])
  host.emit({ type: 'input.change', text: '', by: 'person' })
  await flush()
  expect(host.turns).toEqual([inlined([a])])
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
  expect(host.turns).toEqual([inlined([a])])
})

test('입력 중(#123): 다른 쪽이 바꾼 것(by other)은 상한을 새로 세지 않는다', async () => {
  const { host, mail } = await setup({ board: { typingLimitMs: 2 * MIN } })
  host.emit({ type: 'input.change', text: '쓰는 중' })
  const a = mail.send()
  await host.clock.advance(1 * MIN)
  host.emit({ type: 'input.change', text: '쓰는 중 + 채움', by: 'other' })
  await host.clock.advance(1 * MIN)
  expect(host.turns).toEqual([inlined([a])])
})

test('입력 중(#123): 상한 0 이면 글이 있는 동안 계속 미룬다', async () => {
  const { host, mail } = await setup({ board: { typingLimitMs: 0 } })
  host.emit({ type: 'input.change', text: '쓰는 중' })
  const a = mail.send()
  await host.clock.advance(60 * MIN)
  expect(host.turns).toEqual([])
  host.emit({ type: 'input.submit', text: '쓰는 중', origin: 'user' })
  await runTurn(host)
  await flush()
  expect(host.turns).toEqual([inlined([a])])
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
// #168 빈 입력창인데 입력 중으로 남던 것: 글자처럼 안 보이는 것뿐이거나, 비움 사건이 코어에 못 닿은 경우.
test('입력 중(#168): 보이지 않는 글자(너비 0 공백·제어 문자)뿐이면 입력 중이 아니다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.change', text: '\u200b\u2060\x1b \u00a0' })
  const a = mail.send()
  await flush()
  expect(host.turns).toEqual([inlined([a])])
})

test('입력 중(#168): 비움이 코어에 안 닿아도 메일이 막히면 입력창을 읽어 비었으면 넣는다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.change', text: '쓰다 만 글' })
  host.setInputBox('') // 사건 없이 비워짐
  const a = mail.send()
  await flush()
  expect(host.turns).toEqual([inlined([a])])
})

test('입력 중(#168): 입력창을 읽어 보니 글이 있으면 계속 미루고, 읽지 못하면 사건을 믿는다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.change', text: '쓰는 중' })
  host.setInputBox('쓰는 중')
  const a = mail.send()
  await host.clock.advance(1 * MIN)
  expect(host.turns).toEqual([])
  host.setInputBox(null) // 읽기 실패
  mail.send()
  await host.clock.advance(1 * MIN)
  expect(host.turns).toEqual([])
  host.setInputBox('')
  await host.clock.advance(1 * MIN)
  expect(a).toBeGreaterThan(0)
})

test('읽기 보류 없음(#172): 짧은 턴이 끝나자마자 대기 메일이 지연 없이 들어간다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.submit', text: '해 줘', origin: 'user' })
  host.emit({ type: 'turn.start' })
  const a = mail.send()
  await flush()
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns).toEqual([inlined([a])])
})

test('읽기 보류 없음(#172): 긴 턴(10분) 뒤에도 지연 없이 들어간다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.submit', text: '오래 걸리는 일', origin: 'user' })
  host.emit({ type: 'turn.start' })
  const a = mail.send()
  await host.clock.advance(10 * MIN)
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns).toEqual([inlined([a])])
})

test('읽기 보류 없음(#172): 턴이 끝난 뒤 입력창에 글이 있으면 그것만 미룬다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.submit', text: '해 줘', origin: 'user' })
  host.emit({ type: 'turn.start' })
  host.emit({ type: 'input.change', text: '다음에는 ' })
  const a = mail.send()
  await flush()
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns).toEqual([])
  host.emit({ type: 'input.change', text: '' })
  await flush()
  expect(host.turns).toEqual([inlined([a])])
})
