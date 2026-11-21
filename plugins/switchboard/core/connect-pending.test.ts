// 연결 전에 와 있던 pending 메일: 처음 연결·다시 연결 때 먼저 배달한다. 미룸(입력 중·보류)·관문은 그대로 따르고,
// 미루는 동안은 까닭을 한 줄 남긴다(조용히 묶여 있지 않게). 이미 read 인 것은 넣지 않는다.
import { expect, test } from 'claude-code/testing'

import { RETRY_MIN_MS } from './mailbox'
import { inlined, runTurn, setup } from './mailtest'
import { flush } from './testing'

const MIN = 60_000

test('연결 전 pending: 처음 연결하면 밀려 있던 일반 메일을 한 줄로 넣고 몇 통인지 남긴다', async () => {
  const { host, logs } = await setup({ preload: 2 })
  await flush()
  expect(host.turns).toEqual([inlined([1, 2])])
  expect(logs).toContain('switchboard 메일함: 밀려 있던 일반 메일 2통(#1, #2)을 넣는다')
})

test('연결 전 pending: 연결 전에 이미 read 가 된 메일은 넣지 않는다', async () => {
  // preload 뒤 #1 을 읽고 나서 띄우는 대신: 세션이 넣기 직전 확인에서 걸러진다.
  const { host, mail } = await setup({ preload: 0 })
  const a = mail.send()
  const b = mail.send()
  mail.read(a)
  await flush()
  expect(host.turns).toEqual([inlined([b])])
})

test('연결 전 pending: 입력창에 글이 있으면 미루고 그 까닭을 한 번만 남긴 뒤, 비우면 넣는다', async () => {
  const { host, mail, logs } = await setup()
  host.emit({ type: 'input.change', text: '쓰는 중' })
  const a = mail.send()
  const b = mail.send()
  await host.clock.advance(4 * MIN)
  expect(host.turns).toEqual([])
  const held = logs.filter(l => l.includes('미룸'))
  expect(held).toEqual(['switchboard 메일함: 일반 메일 2통(#1, #2) 미룸 — 입력창에 글이 있음(비우거나 보내면, 마지막 입력 5분 뒤 넣는다)'])

  host.emit({ type: 'input.change', text: '' })
  await flush()
  expect(host.turns).toEqual([inlined([a, b])])
})

test('연결 전 pending: 끊긴 동안 온 메일은 다시 이을 때 넣고, 이미 넣은 메일은 다시 넣지 않는다', async () => {
  const { host, mail, logs } = await setup({ preload: 1 })
  await flush()
  expect(host.turns).toEqual([inlined([1])])
  await runTurn(host)
  mail.setDown(true)
  await host.clock.advance(RETRY_MIN_MS)
  // 세션이 #1 을 아직 읽지 않았어도(pending 그대로) 다시 넣지 않는다.
  const b = mail.send()
  mail.setDown(false)
  await host.clock.advance(RETRY_MIN_MS * 4)
  await flush()
  expect(host.turns).toEqual([inlined([1]), inlined([b])])
  expect(logs).toContain(`switchboard 메일함: 밀려 있던 일반 메일 1통(#${b})을 넣는다`)
})
