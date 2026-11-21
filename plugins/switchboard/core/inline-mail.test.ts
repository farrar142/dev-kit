// 일반 메일 본문 바로 넣기(#203): 본문을 CLI read 꼴로 넣고 read 로 표시한다. 길면 머리만, 못 받으면 옛 꼴로 물러난다.
import { expect, test } from 'claude-code/testing'

import { announce, MAIL_INLINE_MAX, MAIL_TURN_MAX } from './mailbox'
import { EP, inlined, setup } from './mailtest'
import { flush } from './testing'

const OLD_TAIL = 'switchboard close 7`'
const NEW_TAIL = '답하고 끝내기: switchboard reply'

test('본문 넣기: 4,000자 이하 메일은 CLI read 꼴로 본문이 들어오고 서버에서 read 가 된다', async () => {
  const { host, mail } = await setup()
  const a = mail.send('normal', '첫 줄\n둘째 줄')
  await flush()
  expect(host.turns).toEqual([`#${a} s${a}\nteam/lead → team/worker · read\n  첫 줄\n  둘째 줄`])
  expect(mail.status(a)).toBe('read')
  expect(mail.reads).toContain(a)
})

test('본문 넣기: 4,000자를 넘는 메일은 머리만 넣고 read 를 시킨다', async () => {
  const { host, mail } = await setup()
  const long = 'x'.repeat(MAIL_INLINE_MAX + 1)
  const a = mail.send('normal', long)
  await flush()
  expect(host.turns.length).toBe(1)
  expect(host.turns[0]).not.toContain('xxxx')
  expect(host.turns[0]).toContain(`switchboard read ${a}`)
  expect(host.turns[0]).toContain(`본문 ${MAIL_INLINE_MAX + 1}자`)
})

test('본문 넣기: 꼭 4,000자는 본문째 들어간다', async () => {
  const { host, mail } = await setup()
  const body = 'y'.repeat(MAIL_INLINE_MAX)
  const a = mail.send('normal', body)
  await flush()
  expect(host.turns).toEqual([inlined([a], undefined, { bodies: { [a]: body } })])
  expect(host.turns[0]).toContain(body)
})

test('본문 넣기: 여러 통이면 합쳐 8,000자까지 본문, 넘는 통은 머리만', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'turn.start' })
  const size = MAIL_TURN_MAX / 2 - 100
  const a = mail.send('normal', 'a'.repeat(size))
  const b = mail.send('normal', 'b'.repeat(size))
  const c = mail.send('normal', 'c'.repeat(300))
  await flush()
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns.length).toBe(1)
  const t = host.turns[0]!
  expect(t).toContain('a'.repeat(size))
  expect(t).toContain('b'.repeat(size))
  // a+b = 7,800자: c(300자)를 더하면 8,000자를 넘는다.
  expect(t).not.toContain('c'.repeat(300))
  expect(t).toContain(`switchboard read ${c}`)
  // 머리만 넣은 통도 서버에서 없어지지 않는다(다시 넣지 않는다).
  expect([a, b].every(i => mail.status(i) === 'read')).toBe(true)
})

test('본문 넣기: 본문을 못 받으면(서버 오류) 읽음 처리하지 않고 옛 꼴로 물러난다', async () => {
  const { host, mail } = await setup()
  host.http.route(`${EP}/api/messages/`, () => ({ status: 500, text: 'boom' }))
  const a = mail.send('normal', '본문')
  await flush()
  expect(host.turns).toEqual([announce([a])])
  expect(mail.status(a)).toBe('pending')
  expect(mail.reads).toEqual([])
})

test('본문 넣기: 본문 요청이 연결 실패여도 옛 꼴로, 읽음 처리 없음', async () => {
  const { host, mail } = await setup()
  host.http.route(`${EP}/api/messages/`, () => {
    throw new Error('connect ECONNREFUSED')
  })
  const a = mail.send('normal', '본문')
  await flush()
  expect(host.turns).toEqual([announce([a])])
  expect(mail.status(a)).toBe('pending')
})

test('본문 넣기: 본문을 받은 뒤 턴 넣기가 실패해도 메일을 잃지 않고 다시 넣는다', async () => {
  const { host, mail } = await setup()
  host.failNextSubmit()
  const a = mail.send('normal', '잃으면 안 되는 본문')
  await flush()
  expect(host.turns).toEqual([])
  await host.clock.advance(5_000)
  expect(host.turns).toEqual([inlined([a], undefined, { bodies: { [a]: '잃으면 안 되는 본문' } })])
})

test('꼬리: CLI 를 모르면(판 읽기 없음) 옛 꼬리', async () => {
  const { host, mail } = await setup()
  mail.send('normal', '', { id: 7, state: 'open' })
  await flush()
  expect(host.turns[0]).toContain(OLD_TAIL)
  expect(host.turns[0]).not.toContain(NEW_TAIL)
})

const withCli = (version: () => Promise<string | undefined>) => setup({ mail: { cliVersion: version } })

test('꼬리: CLI 가 v0.32.0 보다 낮으면 옛 꼬리', async () => {
  const { host, mail } = await withCli(async () => 'switchboard v0.31.9\n')
  mail.send('normal', '', { id: 7, state: 'open' })
  await flush()
  expect(host.turns[0]).toContain(OLD_TAIL)
  expect(host.turns[0]).not.toContain(NEW_TAIL)
})

test('꼬리: CLI 가 v0.32.0 이상이면 새 꼬리(답하고 끝내기·답 ID 로 close)', async () => {
  const { host, mail } = await withCli(async () => 'switchboard v0.32.0\n')
  const a = mail.send('normal', '', { id: 7, state: 'open' })
  await flush()
  expect(host.turns).toEqual([inlined([a], new Map([[a, 7]]), { newTail: true })])
  expect(host.turns[0]).toContain(`${NEW_TAIL} ${a} --complete … / 답 없이 끝내기: switchboard complete ${a}`)
  expect(host.turns[0]).toContain(`끝났으면 switchboard close ${a}`)
  expect(host.turns[0]).not.toContain(OLD_TAIL)
})

test('꼬리: 판 읽기가 실패·멈추면 옛 꼬리로 넣는다', async () => {
  const broken = await withCli(async () => {
    throw new Error('ENOENT')
  })
  broken.mail.send()
  await flush()
  expect(broken.host.turns.length).toBe(1)
  expect(broken.host.turns[0]).not.toContain(NEW_TAIL)

  const stuck = await withCli(() => new Promise<undefined>(() => undefined))
  stuck.mail.send()
  await flush()
  await stuck.host.clock.advance(5_000)
  expect(stuck.host.turns.length).toBe(1)
  expect(stuck.host.turns[0]).not.toContain(NEW_TAIL)
})

test('꼬리: 여러 통이면 ID 자리를 <ID> 로 둔다', async () => {
  const { host, mail } = await withCli(async () => 'switchboard v0.40.1')
  host.emit({ type: 'turn.start' })
  mail.send()
  mail.send()
  await flush()
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns[0]).toContain(`${NEW_TAIL} <ID> --complete`)
})
