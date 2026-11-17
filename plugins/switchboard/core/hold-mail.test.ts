// D5 사람 입력 중·답한 직후 보류: 일반 메일 턴을 미루고, 입력을 지우거나 시간이 지나면 넣는다. 긴급은 따르지 않는다.
import { expect, test } from 'claude-code/testing'

import { announce } from './mailbox'
import { runTurn, setup } from './mailtest'
import { DEFAULT_HOLD_MS, holdConfig } from './switchboard'
import { flush } from './testing'

const MIN = 60_000

test('보류: 입력창에 글이 있으면 일반 메일을 미루고, 글을 지우면 넣는다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'input.change', text: '이번 건은 ' })
  const a = mail.send()
  await host.clock.advance(10 * MIN)
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
