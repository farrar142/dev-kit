// 메일함(D2) 코어 시험: 가짜 어댑터와 가짜 switchboard 서버(긴 대기)로 바깥에서 본다.
// 보는 것: 어떤 메일이 언제 어떤 글로 세션에 들어가는가, 서버에 무엇을 보내는가(토큰이 새지 않는가).
import { expect, test } from 'claude-code/testing'

import { createMailbox, RETRY_MAX_MS } from './mailbox'
import { EP, inlined, PROFILE, ROLE, runTurn, setup, TOKEN } from './mailtest'
import { createSwitchboard } from './switchboard'
import { fakeHost, flush } from './testing'
import { GROUP_REFUSAL } from './wire'

test('메일함: 유휴 세션은 메일 한 통으로 깨어나 본문을 담은 새 턴을 받는다', async () => {
  const { host, mail, board } = await setup()
  expect(board.mail().status).toBe('live')
  expect(host.turns).toEqual([])

  const id = mail.send()
  await flush()
  expect(host.turns).toEqual([inlined([id])])
  expect(host.turns[0]).toBe('#1 s1\nteam/lead → team/worker · read')
})

test('메일함: 바쁜 동안 쌓인 메일은 턴이 끝난 뒤 한 줄로 묶인다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'turn.start' })
  const a = mail.send()
  await flush()
  const b = mail.send()
  await flush()
  const c = mail.send()
  await flush()
  expect(host.turns).toEqual([])

  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns).toEqual([inlined([a, b, c])])
})

test('메일함: 같은 ID 를 두 번 알리지 않고, 알림 턴이 시작되기 전 온 메일은 그 턴 뒤에 알린다', async () => {
  const { host, mail } = await setup()
  const a = mail.send()
  await flush()
  // 알림 턴이 아직 시작되지 않았다: 새 메일은 그 턴 뒤로.
  const b = mail.send()
  await flush()
  expect(host.turns).toEqual([inlined([a])])

  await runTurn(host)
  expect(host.turns).toEqual([inlined([a]), inlined([b])])
  await runTurn(host)
  // 시간이 흘러 긴 대기가 몇 번 돌아도(a·b 는 아직 pending) 다시 알리지 않는다.
  await host.clock.advance(120_000)
  await runTurn(host)
  expect(host.turns.length).toBe(2)
})

test('메일함: 세션이 막 떴을 때 쌓여 있던 pending 메일을 한 번 알린다', async () => {
  const { host } = await setup({ preload: 3 })
  expect(host.turns).toEqual([inlined([1, 2, 3])])
  await runTurn(host)
  await host.clock.advance(60_000)
  expect(host.turns.length).toBe(1)
})

test('메일함: 바쁜 동안 세션이 스스로 읽은 메일은 알리지 않는다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'turn.start' })
  const a = mail.send()
  const b = mail.send()
  await flush()
  mail.read(a)
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns).toEqual([inlined([b])])
})

test('메일함: 서버가 죽어도 세션은 멀쩡하고, 간격을 늘려 다시 이어 끊긴 동안 온 메일을 빠짐없이 받는다', async () => {
  const { host, mail, board, logs } = await setup()
  const a = mail.send()
  await flush()
  await runTurn(host)
  expect(host.turns).toEqual([inlined([a])])

  mail.setDown(true)
  await flush()
  expect(board.mail().status).toBe('retrying')
  // 죽어 있는 동안 다시 잇기 간격이 늘어난다(1·2·4·8초…).
  const before = mail.polls.length
  await host.clock.advance(60_000)
  const tries = host.http.requests.length
  await host.clock.advance(60_000)
  expect(host.http.requests.length - tries).toBeLessThanOrEqual(2)
  expect(mail.polls.length).toBe(before) // 죽은 동안은 서버에 닿지 않았다.

  // 세션은 그동안에도 턴을 돌릴 수 있다.
  await runTurn(host)
  // 죽은 동안 들어온 메일(서버 쪽 저장).
  mail.setDown(false)
  const b = mail.send()
  const c = mail.send()
  await host.clock.advance(RETRY_MAX_MS)
  expect(board.mail().status).toBe('live')
  // 다시 이을 때 마지막 커서로 묻는다.
  expect(mail.polls[mail.polls.length - 1]?.after).toBeGreaterThanOrEqual(a)
  expect(host.turns).toEqual([inlined([a]), inlined([b, c])])
  expect(logs.some(l => l.includes('끊김'))).toBe(true)
})

test('메일함: 응답이 오지 않으면(멈춘 연결) 감시 시간 뒤 다시 잇는다', async () => {
  const { host, mail, board } = await setup()
  // 서버가 요청을 붙잡고 영영 답하지 않는다.
  host.http.route(`${EP}/api/events/poll`, () => new Promise(() => undefined))
  await host.clock.advance(30_000) // 앞서 걸린 긴 대기가 25초에 비어서 돌아오고, 다음 요청은 멈춘다.
  await host.clock.advance(60_000)
  expect(board.mail().status).toBe('retrying')
  expect(mail.polls.length).toBeGreaterThan(0)
})

test('메일함: 토큰은 머리에만 실리고 URL·알림 글·기록 어디에도 나오지 않는다', async () => {
  const { host, mail, logs } = await setup()
  mail.send()
  await flush()
  mail.setDown(true)
  await host.clock.advance(10_000)
  mail.setDown(false)
  await host.clock.advance(RETRY_MAX_MS)
  // 틀린 JSON 프로필도: 오류 글에 내용이 섞이지 않는다.
  const bad = await setup({ profile: `{"endpoint":"${EP}","token":"${TOKEN}",` })

  const seen = [
    ...host.http.requests.map(r => r.url),
    ...host.turns,
    ...logs,
    ...bad.logs,
    JSON.stringify(host.http.requests.map(r => r.init.body ?? '')),
  ].join('\n')
  expect(host.http.requests.length).toBeGreaterThan(0)
  expect(host.http.requests.every(r => r.init.headers?.Authorization === `Bearer ${TOKEN}`)).toBe(true)
  expect(seen.includes(TOKEN)).toBe(false)
})

test('메일함: 프로필이 없으면 꺼지고 서버에 묻지 않는다', async () => {
  const none = await setup({ profile: null })
  expect(none.started).toBe(true) // 코어(질문 패널 등)는 돈다.
  expect(none.board.mail().status).toBe('off')
  expect(none.host.http.requests).toEqual([])

  const missing = fakeHost()
  const board = createSwitchboard(missing, { mail: { profilePath: '/nope.json' } })
  await board.start()
  expect(board.mail().status).toBe('off')
  expect(missing.http.requests).toEqual([])

  const partial = await setup({ profile: JSON.stringify({ endpoint: EP, role: ROLE }) })
  expect(partial.board.mail().status).toBe('off')
  expect(partial.logs.join('\n')).toContain('token')
})

test('메일함: 서브에이전트(본 세션 아님)에서는 동작하지 않는다', async () => {
  const { host, mail, started, board } = await setup({ isMain: false, preload: 1 })
  expect(started).toBe(false)
  mail.send()
  await host.clock.advance(60_000)
  expect(board.mail().status).toBe('off')
  expect(host.http.requests).toEqual([])
  expect(host.turns).toEqual([])
})

test('메일함: 턴을 넣지 못하면 되돌려 두었다 다시 알린다', async () => {
  const { host, mail } = await setup()
  host.failNextSubmit()
  const a = mail.send()
  await flush()
  expect(host.turns).toEqual([])
  await host.clock.advance(5_000)
  expect(host.turns).toEqual([inlined([a])])
})

test('메일함: 알림 직전 확인 요청이 멈춰도 한도 뒤 알린다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'turn.start' })
  const a = mail.send()
  await flush()
  // 이제부터 즉시 물음(timeout=0)은 영영 답하지 않는다.
  host.http.route(`${EP}/api/events/poll?timeout=0`, () => new Promise(() => undefined))
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns).toEqual([])
  await host.clock.advance(10_000)
  expect(host.turns).toEqual([inlined([a])])
})

test('메일함: stop 하면 더 묻지도 알리지도 않는다', async () => {
  const { host, mail, board } = await setup()
  board.stop()
  const n = host.http.requests.length
  mail.send()
  await host.clock.advance(120_000)
  expect(host.turns).toEqual([])
  expect(host.http.requests.length).toBe(n)
})

test('메일함(#130): 묶음 밖 역할로 보내기가 403 outside your group 이면 사람이 읽을 한 줄로 남기고 다시 하지 않는다', async () => {
  const host = fakeHost()
  host.fs.files.set(PROFILE, JSON.stringify({ endpoint: EP, role: ROLE, token: TOKEN }))
  host.http.route(`${EP}/api/events/poll`, () => ({ text: JSON.stringify({ events: [], cursor: 0 }) }))
  const posts: Record<string, string>[] = []
  host.http.route(`${EP}/api/messages`, ({ init }) => {
    posts.push(init.headers ?? {})

    return { status: 403, text: JSON.stringify({ error: 'recipient outside your group' }) }
  })
  const logs: string[] = []
  const box = createMailbox(host, { profilePath: PROFILE, isIdle: () => true, log: t => void logs.push(t) })
  expect(await box.start()).toBe(true)
  expect(await box.send({ to: 'other/x', subject: 's', body: 'b' })).toBe(false)
  expect(posts.length).toBe(1)
  expect(posts[0]!['X-Switchboard-Role']).toBe(ROLE)
  expect(posts[0]!['X-Agent-Mail-Role']).toBe(ROLE)
  expect(logs.at(-1)).toBe(`switchboard 메일함: other/x 에 「s」 메일을 못 보냄(HTTP 403, ${GROUP_REFUSAL})`)
  await box.stop()
})
