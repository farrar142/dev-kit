// 규칙 원장 걸림(#219) 시험: 걸림 조건은 서버 기준 구현(wire.RuleMatch.Hits)의 시험 사례를 그대로 옮기고,
// 받아 두기(ETag·304)·한 번만 넣기·compact 뒤 한 번 더·서버 불통·프로필 없음을 가짜 서버로 본다. 이름은 모두 지어낸 것이다.
import { expect, test } from 'claude-code/testing'

import { EP, ROLE, setup } from './mailtest'
import { createRuleHints, globRE, hintLine, hits, RULES_FRESH_MS, RULES_TIMEOUT_MS, toolCallOf } from './rules'
import type { RuleMatch, RulesCall, ToolCall } from './rules'
import { fakeClock, fakeHttp, flush } from './testing'
import type { FakeHttp } from './testing'

test('걸림 조건: 서버 시험 사례와 같은 답', () => {
  const cases: [RuleMatch, ToolCall, boolean][] = [
    // internal/wire/rules_test.go TestRuleMatch
    [{ tool: 'mcp__*' }, { tool: 'mcp__x__y' }, true],
    [{ tool: 'Bash' }, { tool: 'BashOutput' }, false],
    [{ path: '**' }, { tool: 'Read', path: '/a/b' }, true],
    [{ path: '*.go' }, { tool: 'Read', path: 'a/b.go' }, false],
    [{ path: 'a/**/*.go' }, { tool: 'Read', path: 'a/b.go' }, true],
    [{ path: 'a/?.go' }, { tool: 'Read', path: 'a/bc.go' }, false],
    [{ command: 'rm -rf' }, { tool: 'Edit' }, false],
    [{}, { tool: 'Bash' }, false],
  ]
  // internal/server/rules_hints_test.go: 계약 문서의 두 줄
  const push: RuleMatch = { tool: 'Bash', command: 'git push .*--force(\\s|$)' }
  const mig: RuleMatch = { tool: 'Edit*', path: '**/migrations/*.sql' }
  cases.push(
    [push, { tool: 'Bash', command: 'git push origin x --force' }, true],
    [push, { tool: 'Bash', command: 'git push --force-with-lease' }, false],
    [mig, { tool: 'Edit', path: '/repo/internal/store/migrations/001.sql' }, true],
    [mig, { tool: 'Edit', path: 'migrations/a/001.sql' }, false],
    [mig, { tool: 'Read', path: '/repo/migrations/001.sql' }, false],
    [mig, { tool: 'Edit', path: 'migrations/001.sql' }, true], // **/ 는 디렉터리 없음도 된다
    [mig, { tool: 'Bash', command: 'x' }, false],
  )
  for (const [m, call, want] of cases) expect([m, call, hits(m, call)]).toEqual([m, call, want])
  expect(hits(null, { tool: 'Bash' })).toBe(false)
})

test('경로는 도구가 준 그대로: 윈도 꼴 역슬래시는 / 로 바꾸지 않는다', () => {
  const win = 'C:\\repo\\migrations\\001.sql'
  expect(hits({ path: '**/migrations/*.sql' }, { tool: 'Edit', path: win })).toBe(false)
  expect(hits({ path: '**' }, { tool: 'Edit', path: win })).toBe(true)
  expect(hits({ path: '**/*.sql' }, { tool: 'Edit', path: win })).toBe(true) // 역슬래시 경로는 '/' 없는 한 조각이다
  expect(hits({ path: 'C:\\repo\\**' }, { tool: 'Edit', path: win })).toBe(true)
  expect(hits({ path: 'C:/repo/**/*.sql' }, { tool: 'Edit', path: 'C:/repo/migrations/001.sql' })).toBe(true)
})

test('glob 은 정규식 글자를 글자 그대로, * 는 경로가 아니면 아무 글', () => {
  expect(globRE('a.b(c)', true).test('a.b(c)')).toBe(true)
  expect(globRE('a.b', true).test('axb')).toBe(false)
  expect(globRE('*', false).test('a/b')).toBe(true)
  expect(globRE('*', true).test('a/b')).toBe(false)
  expect(globRE('?', true).test('가')).toBe(true) // 한 글자는 코드 포인트
})

test('명령 조건: 어디서든 찾고, 컴파일되지 않으면 걸리지 않으며, 맨 앞 (?i) 는 깃발로', () => {
  expect(hits({ command: 'deploy' }, { tool: 'Bash', command: 'make deploy now' })).toBe(true)
  expect(hits({ command: '(' }, { tool: 'Bash', command: '(' })).toBe(false)
  expect(hits({ command: '(?i)drop table' }, { tool: 'Bash', command: 'psql -c "DROP TABLE x"' })).toBe(true)
  expect(hits({ command: 'drop table' }, { tool: 'Bash', command: 'DROP TABLE x' })).toBe(false)
  expect(hits({ command: '\\Agit\\z' }, { tool: 'Bash', command: 'git' })).toBe(true)
  expect(hits({ command: '\\Agit\\z' }, { tool: 'Bash', command: 'git status' })).toBe(false)
})

test('도구 입력에서 명령과 파일 경로를 뽑고, 줄은 종류마다 결정·요령', () => {
  expect(toolCallOf('Bash', { command: 'ls', description: 'x' })).toEqual({ tool: 'Bash', command: 'ls' })
  expect(toolCallOf('Edit', { file_path: '/w/a.ts', old_string: 'a' })).toEqual({ tool: 'Edit', path: '/w/a.ts' })
  expect(toolCallOf('NotebookEdit', { notebook_path: '/w/n.ipynb' })).toEqual({ tool: 'NotebookEdit', path: '/w/n.ipynb' })
  expect(toolCallOf('mcp__x__y', null)).toEqual({ tool: 'mcp__x__y' })
  expect(hintLine({ id: 3, kind: 'decision', topic: 't', summary: '공용 가지에 강제 push 금지' })).toBe('결정 #3 참고: 공용 가지에 강제 push 금지')
  expect(hintLine({ id: 4, kind: 'tip', topic: 't', summary: '한 번 더 돌린 뒤 로그를 읽는다' })).toBe('요령 #4 참고: 한 번 더 돌린 뒤 로그를 읽는다')
})

const MINE = {
  rules: [
    { id: 12, kind: 'decision', topic: 'release', summary: 'no force push', match: { tool: 'Bash', command: 'git push .*--force(\\s|$)' } },
    { id: 9, kind: 'tip', topic: 'db', summary: 'migrations only add columns', match: { tool: 'Edit*', path: '**/migrations/*.sql' } },
    { id: 7, kind: 'tip', topic: 'ci', summary: 'no match row' },
  ],
}
const PUSH: ToolCall = { tool: 'Bash', command: 'git push origin x --force' }

/** 가짜 서버 + 메일함 call 과 같은 모양의 호출(시간 초과는 가짜 시계로). */
const rig = () => {
  const http = fakeHttp({ sse: false })
  const clock = fakeClock()
  let etag = '"e1"'
  let body: unknown = MINE
  let down = false
  const hitBodies: string[] = []
  http.route(`${EP}/api/rules/mine`, ({ init }) => {
    if (down) return new Promise(() => undefined) // 멈춘 서버
    if (init.headers?.['If-None-Match'] === etag) return { status: 304 }

    return { status: 200, headers: { ETag: etag }, text: JSON.stringify(body) }
  })
  http.route(`${EP}/api/rules/hits`, ({ init }) => {
    hitBodies.push(init.body ?? '')
    if (down) return new Promise(() => undefined)

    return { status: 500 }
  })
  const call: RulesCall = async (path, init = {}, io = {}) => {
    let timer: { cancel: () => void } | undefined
    const r = await Promise.race([
      http.fetch(`${EP}${path}`, { method: init.method ?? 'GET', headers: { ...init.headers }, ...(init.body === undefined ? {} : { body: init.body }) }),
      new Promise<null>(done => void (timer = clock.after(io.timeoutMs ?? 10_000, () => done(null)))),
    ]).finally(() => timer?.cancel())

    return r
  }
  const box = createRuleHints(call, clock)
  const mineCalls = (h: FakeHttp) => h.requests.filter(q => q.url.endsWith('/api/rules/mine'))

  return {
    http,
    clock,
    box,
    hitBodies,
    mine: () => mineCalls(http),
    setEtag: (v: string, b: unknown) => {
      etag = v
      body = b
    },
    setDown: (v: boolean) => void (down = v),
  }
}

test('걸린 줄을 한 번만 넣고 hits 를 보낸다(실패는 삼킨다)', async () => {
  const r = rig()
  expect(await r.box.lines(PUSH, '')).toEqual(['결정 #12 참고: no force push'])
  await flush()
  expect(r.hitBodies).toEqual(['{"ids":[12]}'])
  expect(await r.box.lines(PUSH, '')).toEqual([])
  expect(await r.box.lines({ tool: 'Edit', path: '/w/migrations/001.sql' }, '')).toEqual(['요령 #9 참고: migrations only add columns'])
  expect(await r.box.lines({ tool: 'Read', path: '/w/a' }, '')).toEqual([])
  // 서브에이전트 루프는 따로 센다
  expect(await r.box.lines(PUSH, 'agent-a')).toEqual(['결정 #12 참고: no force push'])
  expect(r.mine().length).toBe(1)
})

test('ETag 로 다시 확인하고 304 면 지닌 몸, compact 뒤에는 다시 확인하고 한 번 더 넣는다', async () => {
  const r = rig()
  r.box.warm()
  await flush()
  expect(r.mine().length).toBe(1)
  expect(await r.box.lines(PUSH, '')).toEqual(['결정 #12 참고: no force push'])
  // 한동안은 다시 묻지 않는다
  r.box.warm()
  await r.box.lines(PUSH, '')
  expect(r.mine().length).toBe(1)
  // 신선함이 지나면 If-None-Match 로 묻고 304 면 지닌 몸
  await r.clock.advance(RULES_FRESH_MS)
  expect(await r.box.lines(PUSH, 'agent-b')).toEqual(['결정 #12 참고: no force push'])
  expect(r.mine().length).toBe(2)
  expect(r.mine()[1]?.init.headers?.['If-None-Match']).toBe('"e1"')
  // compact: 본 세션은 한 번 더, 서브에이전트 기록은 그대로. 바뀐 원장을 받는다.
  r.setEtag('"e2"', { rules: [MINE.rules[0], { id: 20, kind: 'decision', topic: 'x', summary: 'new row', match: { tool: 'Bash' } }] })
  r.box.compacted()
  expect(await r.box.lines(PUSH, '')).toEqual(['결정 #12 참고: no force push', '결정 #20 참고: new row'])
  expect(r.mine().length).toBe(3)
  expect(await r.box.lines(PUSH, 'agent-b')).toEqual(['결정 #20 참고: new row'])
})

test('서버가 멈추면 한도 안에 지닌 몸으로 가고, 처음부터 안 닿으면 아무것도 넣지 않는다', async () => {
  const r = rig()
  r.setDown(true)
  const first = r.box.lines(PUSH, '')
  await r.clock.advance(RULES_TIMEOUT_MS)
  expect(await first).toEqual([])
  // 받은 적이 생긴 뒤 다시 멈추면 지닌 몸
  r.setDown(false)
  await r.clock.advance(RULES_FRESH_MS)
  expect(await r.box.lines({ tool: 'Edit', path: 'migrations/1.sql' }, '')).toEqual(['요령 #9 참고: migrations only add columns'])
  r.setDown(true)
  r.box.compacted()
  const again = r.box.lines(PUSH, '')
  await r.clock.advance(RULES_TIMEOUT_MS)
  expect(await again).toEqual(['결정 #12 참고: no force push'])
})

test('메일함 코어: 프로필 없는 세션은 서버를 부르지 않고, 있으면 compact 뒤 한 번 더', async () => {
  const off = await setup({ profile: null })
  expect(await off.board.ruleLines(PUSH, '')).toEqual([])
  expect(off.host.http.requests.some(q => q.url.includes('/api/rules'))).toBe(false)

  const on = await setup()
  on.host.http.route(`${EP}/api/rules/mine`, () => ({ status: 200, headers: { ETag: '"x"' }, text: JSON.stringify(MINE) }))
  on.host.http.route(`${EP}/api/rules/hits`, () => ({ status: 200, text: '{"counted":[12]}' }))
  await on.host.clock.advance(RULES_FRESH_MS) // 시작 때 받은 몸(가짜 메일 서버의 404)이 묵게
  expect(await on.board.ruleLines(PUSH, '')).toEqual(['결정 #12 참고: no force push'])
  expect(await on.board.ruleLines(PUSH, '')).toEqual([])
  const mine = on.host.http.requests.filter(q => q.url.endsWith('/api/rules/mine'))
  expect(mine.at(-1)?.init.headers?.['X-Switchboard-Role']).toBe(ROLE)
  on.host.emit({ type: 'compact.complete' })
  expect(await on.board.ruleLines(PUSH, '')).toEqual(['결정 #12 참고: no force push'])
  const hitsSent = on.host.http.requests.filter(q => q.url.endsWith('/api/rules/hits'))
  expect(hitsSent.length).toBe(2)
  expect(hitsSent[0]?.init.method).toBe('POST')
  await on.board.stop()
  await off.board.stop()
})
