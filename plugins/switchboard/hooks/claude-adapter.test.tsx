// Claude 어댑터 시험(얕게): 포트 호출이 모드 API로 이어지는지만 본다.
import { expect, test } from 'claude-code/testing'

import { claudeHost, createEmitter, createMidTurnBox, submitOrigin } from '../adapters/claude'
import type { Self } from '../adapters/claude'

// 시험의 $ 는 플러그인 $ 의 일부만 가진 Engine 이다(clock·session.usage 등이 없다). 어댑터가 쓰는 것만 부른다.
const asSelf = (e: unknown) => e as Self

test('Claude 어댑터: submitTurn 은 사용자 글로 prompt.submit 한다', async ($, on) => {
  const got: any[] = []
  on('prompt.submit', (_: any, e: any) => {
    got.push(e)

    return { text: e.text }
  })
  const host = claudeHost(asSelf($), createEmitter(), createMidTurnBox())
  await host.submitTurn('[메일] 새 지시')
  expect(got.map(e => e.text)).toEqual(['[메일] 새 지시'])
})

test('Claude 어댑터: compact 는 session.compact 로, 건너뜀은 done:false 로', async ($, on) => {
  const asked: any[] = []
  let skip: string | undefined
  on('session.compact', (_: any, e: any) => {
    asked.push(e)

    return skip === undefined ? { messages: [{ role: 'user', text: '요약', toolUses: [] }] } : { skip }
  })
  const host = claudeHost(asSelf($), createEmitter(), createMidTurnBox())

  expect(host.features).toEqual({ midTurnInject: true, compact: true })
  expect(await host.compact?.('메일 전 정리')).toEqual({ done: true })
  expect(asked[0]?.instructions).toBe('메일 전 정리')
  skip = 'nothing'
  expect(await host.compact?.()).toEqual({ done: false, reason: 'nothing' })
})

test('Claude 어댑터: identity 는 본 세션으로 답한다', async $ => {
  const me = await claudeHost(asSelf($), createEmitter(), createMidTurnBox()).identity()
  expect(me.isMain).toBe(true)
  expect(typeof me.machine).toBe('string')
})

test('Claude 어댑터: injectMidTurn 은 다음 도구 결과에 붙을 때 풀린다', async () => {
  const box = createMidTurnBox()
  let done: boolean | undefined
  const p = box.put('[긴급] 멈춰라').then(v => void (done = v))
  expect(box.size()).toBe(1)
  expect(done).toBeUndefined()
  expect(box.take()).toEqual(['[긴급] 멈춰라'])
  await p
  expect(done).toBe(true)
  expect(box.take()).toEqual([])
})

test('Claude 어댑터: 턴이 도구 호출 없이 끝나면 끼워 넣기는 false 로 풀리고 버려진다', async () => {
  const box = createMidTurnBox()
  const p = box.put('[긴급] 늦음')
  box.expire()
  expect(await p).toBe(false)
  expect(box.size()).toBe(0)
  expect(box.take()).toEqual([])
})

test('Claude 어댑터: 제출 origin 은 composer·bridge 만 사람이고 플러그인이 넣은 턴은 plugin 이다', () => {
  expect(submitOrigin('composer')).toBe('user')
  expect(submitOrigin('bridge')).toBe('user')
  expect(submitOrigin('plugin')).toBe('plugin')
  expect(submitOrigin('task-notification')).toBe('other')
  expect(submitOrigin(undefined)).toBe('other')
})
