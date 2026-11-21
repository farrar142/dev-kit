// 답장 메일의 answers_directive: open 이면 알림에 close 안내 한 줄, done·키 없음이면 더하지 않는다.
import { expect, test } from 'claude-code/testing'

import { announce } from './mailbox'
import { inlined, setup } from './mailtest'
import { flush } from './testing'

const line = (m: number, n: number) => `메일 #${m} 은 지시 #${n} 의 답이다. #${n} 은 아직 열려 있다 — 끝났으면 \`switchboard close ${n}\`, 더 시킬 것이 있으면 reply.`

test('answers_directive open: 알림에 close 안내가 붙는다', async () => {
  const { host, mail } = await setup()
  const a = mail.send('normal', '', { id: 7, state: 'open' })
  await flush()
  expect(host.turns[0]).toContain(line(a, 7))
})

test('answers_directive done 이면 아무것도 더하지 않는다', async () => {
  const { host, mail } = await setup()
  const a = mail.send('normal', '', { id: 7, state: 'done' })
  await flush()
  expect(host.turns).toEqual([inlined([a])])
  expect(host.turns[0]).not.toContain('switchboard close')
})

test('키가 없으면 아무것도 더하지 않는다', async () => {
  const { host, mail } = await setup()
  const a = mail.send()
  await flush()
  expect(host.turns).toEqual([inlined([a])])
})

test('여러 통을 한 번에 넣어도 메일마다 붙는다', () => {
  const text = announce([3, 4, 5], new Map([[3, 10], [5, 11]]))
  expect(text).toContain(line(3, 10))
  expect(text).toContain(line(5, 11))
  expect(text).not.toContain('#4 은 지시')
})
