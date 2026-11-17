// 코어 단위 시험: 가짜 어댑터(fakeHost)와 가짜 시계로 돈다. 에이전트 API를 쓰지 않는다.
import { expect, test } from 'claude-code/testing'

import { capabilities, createSwitchboard } from './switchboard'
import { fakeClock, fakeHost, flush } from './testing'

test('코어: 본 세션이면 시작해 턴 시작·완료를 따라 바쁨·유휴를 안다', async () => {
  const host = fakeHost()
  const board = createSwitchboard(host)
  expect(await board.start()).toBe(true)
  expect(board.state()).toMatchObject({ active: true, activity: 'idle', typing: false })

  host.emit({ type: 'turn.start' })
  expect(board.state().activity).toBe('busy')
  host.emit({ type: 'turn.complete' })
  expect(board.state().activity).toBe('idle')
})

test('코어: 서브에이전트(본 세션 아님)에서는 동작하지 않는다', async () => {
  const host = fakeHost({ identity: { isMain: false } })
  const board = createSwitchboard(host)
  expect(await board.start()).toBe(false)
  expect(host.listeners()).toBe(0)
  host.emit({ type: 'turn.start' })
  expect(board.state()).toMatchObject({ active: false, activity: 'idle' })
  expect(await board.compact()).toEqual({ done: false, reason: 'inactive' })
  expect(host.compacts).toEqual([])
})

test('코어: 입력창에 글이 있으면 입력 중, 제출하면 풀리고 마지막 입력 시각을 가짜 시계로 적는다', async () => {
  const clock = fakeClock(5_000)
  const host = fakeHost({ clock })
  const board = createSwitchboard(host)
  await board.start()

  host.emit({ type: 'input.change', text: 'q4 ' })
  await flush()
  expect(board.state()).toMatchObject({ typing: true, lastInputAt: 5_000 })

  await clock.advance(1_500)
  host.emit({ type: 'input.change', text: '   ' })
  await flush()
  expect(board.state()).toMatchObject({ typing: false, lastInputAt: 6_500 })

  host.emit({ type: 'input.change', text: '답' })
  host.emit({ type: 'input.submit', text: '답' })
  await flush()
  expect(board.state().typing).toBe(false)
})

test('코어: 유휴일 때 compact 하고 완료 이벤트 뒤에 유휴로 돌아온다', async () => {
  const host = fakeHost()
  const board = createSwitchboard(host)
  await board.start()

  expect(await board.compact('메일 전 정리')).toEqual({ done: true })
  expect(host.compacts).toEqual(['메일 전 정리'])
  expect(board.state().activity).toBe('compacting')
  await host.clock.advance(0)
  expect(board.state().activity).toBe('idle')
})

test('코어: 턴이 도는 중이면 compact 하지 않는다', async () => {
  const host = fakeHost()
  const board = createSwitchboard(host)
  await board.start()
  host.emit({ type: 'turn.start' })

  expect(await board.compact()).toEqual({ done: false, reason: 'busy' })
  expect(host.compacts).toEqual([])
  expect(board.state().activity).toBe('busy')
})

test('코어: 에이전트가 compact 를 거절하면 바로 유휴로 되돌린다', async () => {
  const host = fakeHost()
  host.setCompactResult({ done: false, reason: 'nothing to compact' })
  const board = createSwitchboard(host)
  await board.start()

  expect(await board.compact()).toEqual({ done: false, reason: 'nothing to compact' })
  expect(board.state().activity).toBe('idle')
})

test('코어: 기능 플래그가 없으면 기능을 낮춘다(compact 건너뜀, 끼워 넣기 없음)', async () => {
  const host = fakeHost({ features: { compact: false, midTurnInject: false } })
  expect(host.compact).toBeUndefined()
  expect(host.injectMidTurn).toBeUndefined()
  expect(capabilities(host)).toEqual({ compact: false, midTurnInject: false })

  const board = createSwitchboard(host)
  await board.start()
  expect(await board.compact()).toEqual({ done: false, reason: 'unsupported' })
  expect(board.state().activity).toBe('idle')
})

test('코어: stop 하면 이벤트를 더 듣지 않는다', async () => {
  const host = fakeHost()
  const board = createSwitchboard(host)
  await board.start()
  expect(host.listeners()).toBe(1)
  board.stop()
  expect(host.listeners()).toBe(0)
  host.emit({ type: 'turn.start' })
  expect(board.state()).toMatchObject({ active: false, activity: 'idle' })
})

// ── 시험 틀 자체 ──────────────────────────────────────────────────────────────

test('가짜 시계: advance 한 만큼만, 시각 순서대로 타이머를 부르고 cancel 한 것은 부르지 않는다', async () => {
  const clock = fakeClock(0)
  const seen: string[] = []
  clock.after(300, () => seen.push(`after300@${clock.time()}`))
  const tick = clock.every(100, () => seen.push(`every@${clock.time()}`))
  const gone = clock.after(150, () => seen.push('cancelled'))
  gone.cancel()

  await clock.advance(250)
  expect(seen).toEqual(['every@100', 'every@200'])
  tick.cancel()
  await clock.advance(100)
  expect(seen).toEqual(['every@100', 'every@200', 'after300@300'])
  expect(await clock.now()).toBe(350)
  expect(clock.pending()).toBe(0)
})

test('가짜 http: 경로 처리기로 답하고 요청을 적으며, SSE 는 서버 쪽에서 밀고 끊는다', async () => {
  const host = fakeHost()
  host.http.route('https://mail.example/api/inbox', ({ init }) => ({ text: JSON.stringify({ auth: init.headers?.authorization }) }))

  const r = await host.services.http.fetch('https://mail.example/api/inbox?role=worker', {
    headers: { authorization: 'Bearer test' },
  })
  expect(r).toMatchObject({ status: 200, ok: true })
  expect(JSON.parse(r.text)).toEqual({ auth: 'Bearer test' })
  expect((await host.services.http.fetch('https://mail.example/none')).status).toBe(404)
  expect(host.http.requests.map(q => q.url)).toEqual(['https://mail.example/api/inbox?role=worker', 'https://mail.example/none'])

  const got: string[] = []
  const ends: string[] = []
  const sse = host.services.http.sse
  expect(sse).toBeDefined()
  sse?.('https://mail.example/api/stream', {}, { onEvent: e => got.push(`${e.event}:${e.data}`), onEnd: r => ends.push(r) })
  const s = host.http.streams[0]
  s?.push({ event: 'message', data: '1' })
  s?.end('reset')
  s?.push({ event: 'message', data: '2' })
  expect(got).toEqual(['message:1'])
  expect(ends).toEqual(['reset'])

  expect(fakeHost({ sse: false }).services.http.sse).toBeUndefined()
})
