// 미분류 답 붙들기(#221) 시험: 가짜 서버로 막기·놓아주기·제 역할만·서버 불통, 그리고 Stop 훅 배선을 본다. 이름은 모두 지어낸 것이다.
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { wireStopHold } from '../adapters/claude'
import type { StopVerdictLike } from '../adapters/claude'
import { EP, ROLE, setup } from './mailtest'
import { createUnclassifiedHold, UNCLASSIFIED_MAX_HOLDS, UNCLASSIFIED_TIMEOUT_MS } from './rules'
import type { RulesCall } from './rules'
import { fakeClock, fakeHttp } from './testing'

const ME = 'demo/worker-1'
const OTHER = 'demo/writer-2'
const A1 = { id: 'q_aaaa', asker: ME, header: '배포', answered_at: '2026-01-02T03:04:05Z' }
const A2 = { id: 'q_bbbb', asker: ME, header: '캐시', answered_at: '2026-01-02T03:05:05Z' }
const B1 = { id: 'q_cccc', asker: OTHER, header: '이름', answered_at: '2026-01-02T03:06:05Z' }

const rig = () => {
  const http = fakeHttp({ sse: false })
  const clock = fakeClock()
  let answers: unknown[] = [A1, A2]
  let mode: 'ok' | 'down' | 'error' = 'ok'
  http.route(`${EP}/api/rules/unclassified`, ({ init }) => {
    if (mode === 'down') return new Promise(() => undefined) // 멈춘 서버
    if (mode === 'error') return { status: 500, text: 'boom' }
    const body = JSON.stringify({ count: answers.length, answers })
    const etag = `"${body.length}-${answers.length}"`
    if (init.headers?.['If-None-Match'] === etag) return { status: 304 }

    return { status: 200, headers: { ETag: etag }, text: body }
  })
  const call: RulesCall = async (path, init = {}, io = {}) => {
    let timer: { cancel: () => void } | undefined
    const r = await Promise.race([
      http.fetch(`${EP}${path}`, { method: init.method ?? 'GET', headers: { ...init.headers } }),
      new Promise<null>(done => void (timer = clock.after(io.timeoutMs ?? 10_000, () => done(null)))),
    ]).finally(() => timer?.cancel())

    return r
  }
  let role: string | null = ME
  const hold = createUnclassifiedHold(call, () => role)

  return {
    http,
    clock,
    hold,
    reqs: () => http.requests.filter(q => q.url.includes('/api/rules/unclassified')),
    set: (a: unknown[]) => void (answers = a),
    setMode: (m: 'ok' | 'down' | 'error') => void (mode = m),
    setRole: (r: string | null) => void (role = r),
  }
}

test('미분류 답이 있으면 막고 까닭에 줄마다 id·머리와 할 일을 적으며, 분류되면 끝낸다', async () => {
  const r = rig()
  const v = await r.hold.check()
  expect(v.kind).toBe('block')
  const reason = v.kind === 'block' ? v.reason : ''
  const lines = reason.split('\n')
  expect(lines).toContain('q_aaaa 배포')
  expect(lines).toContain('q_bbbb 캐시')
  expect(reason).toContain('switchboard rules classify <id> --rule N')
  expect(reason).toContain('--source <id>')
  expect(reason).toContain('switchboard rules classify <id> --once')
  expect(reason).toContain(`1/${UNCLASSIFIED_MAX_HOLDS}`)
  // 제 역할로 묻는다(전역 대장도 남의 답에 붙들리지 않게)
  expect(r.reqs()[0]?.url).toBe(`${EP}/api/rules/unclassified?role=${encodeURIComponent(ME)}`)
  // 같은 몸이면 ETag 로 묻고 304 는 지닌 몸
  expect((await r.hold.check()).kind).toBe('block')
  expect(r.reqs()[1]?.init.headers?.['If-None-Match']).toBeDefined()
  // 모두 분류되면 끝낸다
  r.set([])
  expect(await r.hold.check()).toEqual({ kind: 'end' })
})

test('남의 역할 답은 세지 않는다(서버가 모든 역할 것을 줘도)', async () => {
  const r = rig()
  r.set([B1])
  expect(await r.hold.check()).toEqual({ kind: 'end' })
  r.set([B1, A1])
  const v = await r.hold.check()
  expect(v.kind === 'block' && !v.reason.includes('q_cccc') && v.reason.includes('q_aaaa')).toBe(true)
})

test(`같은 묶음으로는 ${UNCLASSIFIED_MAX_HOLDS}번 막고 메모와 함께 놓아주며, 묶음이 바뀌면 다시 막는다`, async () => {
  const r = rig()
  for (let i = 1; i <= UNCLASSIFIED_MAX_HOLDS; i++) expect((await r.hold.check()).kind).toBe('block')
  const rel = await r.hold.check()
  expect(rel.kind).toBe('release')
  expect(rel.kind === 'release' && rel.note.includes('q_aaaa') && rel.note.includes('q_bbbb')).toBe(true)
  // 놓아준 묶음으로는 다시 막지 않는다
  expect(await r.hold.check()).toEqual({ kind: 'end' })
  // 하나를 분류해 묶음이 바뀌면 다시 센다
  r.set([A2])
  const v = await r.hold.check()
  expect(v.kind === 'block' && v.reason.includes(`1/${UNCLASSIFIED_MAX_HOLDS}`)).toBe(true)
})

test('서버가 안 닿거나 느리거나 오류면 턴을 끝낸다, 역할이 없으면 묻지 않는다', async () => {
  const r = rig()
  r.setMode('down')
  const slow = r.hold.check()
  await r.clock.advance(UNCLASSIFIED_TIMEOUT_MS)
  expect(await slow).toEqual({ kind: 'end' })
  r.setMode('error')
  expect(await r.hold.check()).toEqual({ kind: 'end' })
  r.setMode('ok')
  r.setRole(null)
  const before = r.reqs().length
  expect(await r.hold.check()).toEqual({ kind: 'end' })
  expect(r.reqs().length).toBe(before)
})

test('메일함 코어: 프로필 없는 세션은 서버를 부르지 않고, 있으면 제 역할 머리로 묻는다', async () => {
  const off = await setup({ profile: null })
  expect(await off.board.stopCheck()).toEqual({ kind: 'end' })
  expect(off.host.http.requests.some(q => q.url.includes('/api/rules/unclassified'))).toBe(false)

  const on = await setup()
  on.host.http.route(`${EP}/api/rules/unclassified`, () => ({
    status: 200,
    text: JSON.stringify({ count: 1, answers: [{ ...A1, asker: ROLE }] }),
  }))
  const v = await on.board.stopCheck()
  expect(v.kind).toBe('block')
  const q = on.host.http.requests.filter(x => x.url.includes('/api/rules/unclassified')).at(-1)
  expect(q?.init.headers?.['X-Switchboard-Role']).toBe(ROLE)
  expect(q?.url.endsWith(`?role=${encodeURIComponent(ROLE)}`)).toBe(true)
  await on.board.stop()
  await off.board.stop()
})

/** classic.Stop 처리기를 붙잡는 가짜 on. */
type StopHandler = ($: unknown, e: { agent_id?: string }, next: (e: unknown) => Promise<{ block?: string; additionalContext?: string[] }>) => Promise<{ block?: string; additionalContext?: string[] }>
const captureStop = (verdict: () => StopVerdictLike) => {
  let handler: StopHandler | undefined
  let asked = 0
  const fakeOn = ((name: string, h: StopHandler) => {
    if (name === 'classic.Stop') handler = h

    return { catch: () => undefined }
  }) as unknown as On // 시험용: on 의 겹친 서명 가운데 classic.Stop 하나만 흉내 낸다
  wireStopHold(fakeOn, async () => {
    asked++

    return verdict()
  })
  const $ = { http: { fetch: async () => ({ status: 200, ok: true, headers: {}, text: '' }) } }
  const run = async (e: { agent_id?: string }, prior: { block?: string; additionalContext?: string[] } = {}) => {
    if (handler === undefined) throw new Error('classic.Stop 처리기 없음')

    return handler($, e, async () => prior)
  }

  return { run, asked: () => asked }
}

test('Stop 훅: 막으면 block, 놓아주면 메모, 다른 붙들기가 막았으면 그대로 두고 묻지 않으며, 서브에이전트는 붙들지 않는다', async () => {
  let v: StopVerdictLike = { kind: 'block', reason: '분류하라' }
  const s = captureStop(() => v)
  expect(await s.run({})).toEqual({ block: '분류하라' })
  // 다른 훅의 붙들기가 먼저: 그 까닭을 가리지 않고, 세지도 않는다
  expect(await s.run({}, { block: '보고를 먼저 보내라' })).toEqual({ block: '보고를 먼저 보내라' })
  expect(s.asked()).toBe(1)
  // 서브에이전트 루프
  expect(await s.run({ agent_id: 'agent-x' })).toEqual({})
  expect(s.asked()).toBe(1)
  v = { kind: 'release', note: '놓아준다' }
  expect(await s.run({})).toEqual({ additionalContext: ['놓아준다'] })
  v = { kind: 'end' }
  expect(await s.run({})).toEqual({})
})
