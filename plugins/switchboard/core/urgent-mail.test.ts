// D4 긴급 메일: 바쁘면 다음 도구 호출 뒤 끼워 넣고, 유휴면 새 턴. 넣는 즉시 read, 본문은 상한에서 자른다.
import { expect, test } from 'claude-code/testing'

import { NOTICE_MAX_CHARS, noticeText, MAIL_INLINE_MAX, URGENT_MAX_CHARS, urgentText } from './mailbox'
import { inlined, runTurn, setup } from './mailtest'
import { flush } from './testing'

test('긴급: 바쁜 세션에는 다음 도구 호출 뒤에 본문이 들어가고, 그때 read 가 된다', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'turn.start' })
  const id = mail.send('urgent', '배포 멈춰라')
  await flush()
  expect(host.injected).toEqual([])
  expect(mail.status(id)).toBe('pending') // 아직 안 붙었다.

  host.toolCall()
  await flush()
  expect(host.injected.length).toBe(1)
  expect(host.injected[0]).toContain(`[긴급 메일 #${id}] team/lead | s${id}`)
  expect(host.injected[0]).toContain('배포 멈춰라')
  expect(mail.status(id)).toBe('read')
  expect(host.turns).toEqual([]) // 새 턴을 만들지 않는다.
})

test('긴급: 유휴 세션에는 새 턴으로 넣고 read 로 표시한다', async () => {
  const { host, mail } = await setup()
  const id = mail.send('urgent', '지금 확인')
  await flush()
  expect(host.turns.length).toBe(1)
  expect(host.turns[0]).toContain('지금 확인')
  expect(host.injected).toEqual([])
  expect(mail.status(id)).toBe('read')
})

test('긴급: 도구 호출 없이 턴이 끝나면 버려진 끼워 넣기 대신 새 턴으로 넣는다(한 번만)', async () => {
  const { host, mail } = await setup()
  host.emit({ type: 'turn.start' })
  const id = mail.send('urgent', '늦은 지시')
  await flush()
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.injected).toEqual([])
  expect(host.turns.length).toBe(1)
  expect(host.turns[0]).toContain('늦은 지시')
  expect(mail.status(id)).toBe('read')
  host.toolCall() // 다음 턴의 도구 호출에 다시 붙지 않는다.
  expect(host.injected).toEqual([])
})

test('긴급: 본문이 상한을 넘으면 자르고 전문을 읽을 ID를 붙인다', async () => {
  const long = '가'.repeat(URGENT_MAX_CHARS + 500)
  const text = urgentText({ id: 42, sender: 'a/b', subject: 'x' }, long)
  expect(text).toContain('가'.repeat(URGENT_MAX_CHARS))
  expect(text).not.toContain('가'.repeat(URGENT_MAX_CHARS + 1))
  expect(text).toContain('먼저 switchboard read 42 로 전문을 읽어라')
  expect(urgentText({ id: 7 }, '짧음')).not.toContain('전문은')

  const { host, mail } = await setup()
  mail.send('urgent', long)
  await flush()
  expect(host.turns[0]!.length).toBeLessThan(URGENT_MAX_CHARS + 300)
})

test('긴급: 이벤트에 본문이 없으면 그 메일만 받아 온다', async () => {
  const { host, mail } = await setup()
  mail.setOmitBody(true)
  const id = mail.send('urgent', '따로 받은 본문')
  await flush()
  expect(host.http.requests.some(r => r.url.endsWith(`/api/messages/${id}`))).toBe(true)
  expect(host.turns[0]).toContain('따로 받은 본문')
  expect(mail.status(id)).toBe('read')
})

test('긴급: 끼워 넣기 기능이 없으면 새 턴으로(바쁘면 그 턴 뒤 맨 앞) 넣고, 일반 메일은 그 뒤에', async () => {
  const { host, mail } = await setup({ features: { midTurnInject: false } })
  host.emit({ type: 'turn.start' })
  const n = mail.send()
  await flush()
  const u = mail.send('urgent', '먼저')
  await flush()
  // 바쁜 중에 넣어 둔다(어댑터가 턴 뒤 새 턴으로 보낸다). 일반은 아직이다.
  expect(host.turns.length).toBe(1)
  expect(host.turns[0]).toContain('먼저')
  expect(mail.status(u)).toBe('read')
  host.emit({ type: 'turn.complete' })
  await flush()
  expect(host.turns.length).toBe(1) // 긴급 턴이 시작되기 전에는 일반을 넣지 않는다.
  await runTurn(host)
  expect(host.turns[1]).toBe(inlined([n]))
})

test('긴급: compact 중이면 끝난 뒤에 넣는다', async () => {
  const { host, mail, board } = await setup()
  host.setCompactResult({ done: true })
  await board.compact()
  const id = mail.send('urgent', '정리 뒤')
  await flush()
  expect(host.turns).toEqual([])
  await host.clock.advance(0) // compact.complete
  expect(host.turns.length).toBe(1)
  expect(mail.status(id)).toBe('read')
})

test('긴급: 같은 긴급 메일은 한 번만 넣는다', async () => {
  const { host, mail } = await setup()
  mail.send('urgent', '한 번')
  await flush()
  await runTurn(host)
  await host.clock.advance(120_000)
  expect(host.turns.length).toBe(1)
})

test('통지·긴급 본문 상한은 일반 메일과 같고, 넘으면 전문을 먼저 읽게 한다(#206)', () => {
  expect(NOTICE_MAX_CHARS).toBe(MAIL_INLINE_MAX)
  expect(URGENT_MAX_CHARS).toBe(MAIL_INLINE_MAX)
  const e = { id: 9, sender: 'switchboard/system', subject: 'x' }
  const fits = noticeText(e, '가'.repeat(2660))
  expect(fits).toContain('가'.repeat(2660))
  expect(fits).not.toContain('잘렸다')
  const cut = noticeText(e, '가'.repeat(MAIL_INLINE_MAX + 10))
  expect(cut).toContain('먼저 switchboard read 9 로 전문을 읽어라')
})
