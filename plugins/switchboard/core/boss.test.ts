// 대장 판정(#130): 연결될 때 GET /api/whoami, 200 이면 is_boss 만, 404·연결 실패·5xx 면 전역 목록, 다음 연결 때 다시.
// 그리고 서버와 주고받는 머리·묶음 거절 문구(core/wire.ts).
import { expect, test } from 'claude-code/testing'

import { createBossJudge, parseWhoami } from './boss'
import type { MailboxState } from './mailbox'
import { flush } from './testing'
import { GROUP_REFUSAL, httpWhy, isGroupRefusal, roleHeaders } from './wire'

type Reply = { status: number; ok: boolean; text: string } | null

const whoami = (isBoss: boolean, group = '') =>
  ({ status: 200, ok: true, text: JSON.stringify({ role: 'g/x-1', base: 'g/x', group, global_boss: false, boss_of: [], is_boss: isBoss }) }) as const

/** 메일함 흉내: call 은 replies 를 차례로 돌려주고(남으면 마지막), live() 로 이어짐을 알린다. */
const fakeBox = (role: string, replies: Reply[]) => {
  const calls: string[] = []
  const taps: ((r: string) => void)[] = []
  let st: MailboxState = { status: 'connecting', cursor: null, queued: [], role }
  let i = 0
  let hold: Promise<void> | undefined

  return {
    calls,
    box: {
      call: async (path: string) => {
        calls.push(path)
        if (hold !== undefined) await hold
        const r = replies[Math.min(i, replies.length - 1)] ?? null
        i++

        return r
      },
      state: () => st,
      onLive: (fn: (r: string) => void) => {
        taps.push(fn)

        return () => void taps.splice(taps.indexOf(fn), 1)
      },
    },
    live: async (next = role) => {
      st = { ...st, status: 'live', role: next }
      for (const fn of taps) fn(next)
      await flush()
    },
    setRole: (next: string) => void (st = { ...st, role: next }),
    holdUntil: (p: Promise<void>) => void (hold = p),
  }
}

test('대장 판정: whoami 200 is_boss true 면 전역 목록에 없어도 대장(권한 답은 서버가 가림)', async () => {
  const f = fakeBox('g/lead-1', [whoami(true, 'g')])
  const j = createBossJudge(f.box, { bosses: [] })
  await f.live()
  expect(f.calls).toEqual(['/api/whoami'])
  expect(j.isBoss()).toBe(true)
  expect(j.permissionsGated()).toBe(true)
})

test('대장 판정: whoami 200 is_boss false 면 전역 목록에 있어도 대장 아님', async () => {
  const f = fakeBox('team/lead-1', [whoami(false)])
  const j = createBossJudge(f.box, { bosses: ['team/lead'] })
  await f.live()
  expect(j.isBoss()).toBe(false)
  expect(j.permissionsGated()).toBe(true)
})

test('대장 판정: whoami 404(옛 서버)면 전역 목록(SWITCHBOARD_BOSS_ROLES) 판정', async () => {
  const logs: string[] = []
  const f = fakeBox('team/lead-2', [{ status: 404, ok: false, text: 'not found' }])
  const j = createBossJudge(f.box, { bosses: ['team/lead'], log: t => void logs.push(t) })
  await f.live()
  expect(j.isBoss()).toBe(true)
  expect(j.permissionsGated()).toBe(false)
  expect(j.verdict()).toEqual({ kind: 'legacy', role: 'team/lead-2', why: '404' })
  expect(logs.some(l => l.includes('옛 서버'))).toBe(true)
  const w = fakeBox('team/worker', [{ status: 404, ok: false, text: '' }])
  const jw = createBossJudge(w.box, { bosses: ['team/lead'] })
  await w.live()
  expect(jw.isBoss()).toBe(false)
})

test('대장 판정: 연결 실패·5xx 는 전역 목록으로 떨어지고, 다음 연결 때 다시 묻는다', async () => {
  const logs: string[] = []
  const f = fakeBox('team/lead', [null, { status: 502, ok: false, text: 'bad gateway' }, whoami(false)])
  const j = createBossJudge(f.box, { bosses: ['team/lead'], log: t => void logs.push(t) })
  await f.live()
  expect(j.isBoss()).toBe(true)
  expect(j.verdict()).toEqual({ kind: 'legacy', role: 'team/lead', why: '연결 실패' })
  expect(logs.at(-1)).toContain('다음 연결 때 다시')
  // 끊겼다 다시 이어짐: 5xx 도 옛 판정.
  await f.live()
  expect(j.verdict()).toEqual({ kind: 'legacy', role: 'team/lead', why: 'HTTP 502' })
  expect(j.isBoss()).toBe(true)
  // 그다음 연결에서 새 서버가 답하면 그 답.
  await f.live()
  expect(f.calls).toEqual(['/api/whoami', '/api/whoami', '/api/whoami'])
  expect(j.isBoss()).toBe(false)
})

test('대장 판정: 모양이 틀린 200 도 전역 목록으로', async () => {
  const f = fakeBox('team/lead', [{ status: 200, ok: true, text: '{"role":"team/lead"}' }])
  const j = createBossJudge(f.box, { bosses: ['team/lead'] })
  await f.live()
  expect(j.verdict()?.kind).toBe('legacy')
  expect(j.isBoss()).toBe(true)
})

test('대장 판정: 묻는 동안은 대장 아님, 번호 역할이 바뀌면 새 역할로 다시 묻는다', async () => {
  let release = () => {}
  const f = fakeBox('team/lead', [whoami(true), whoami(false)])
  f.holdUntil(new Promise<void>(done => void (release = done)))
  const changes: number[] = []
  const j = createBossJudge(f.box, { bosses: ['team/lead'], onChange: () => void changes.push(1) })
  // 아직 안 이어짐: 묻지 않았으니 대장 아님.
  expect(j.isBoss()).toBe(false)
  await f.live()
  expect(j.isBoss()).toBe(false)
  expect(changes).toEqual([])
  release()
  await flush()
  expect(j.isBoss()).toBe(true)
  expect(changes.length).toBe(1)
  // 번호를 받았는데 아직 안 이어짐: 판정한 역할과 달라 아직 대장 아님(이어지면 다시 묻는다).
  f.setRole('team/lead-2')
  expect(j.isBoss()).toBe(false)
  expect(j.permissionsGated()).toBe(false)
  await f.live('team/lead-2')
  expect(j.verdict()).toMatchObject({ kind: 'whoami', role: 'team/lead-2' })
  expect(j.isBoss()).toBe(false)
})

test('대장 판정: 만들 때 이미 이어져 있으면 곧 묻고, stop 뒤 이어짐은 듣지 않는다', async () => {
  const f = fakeBox('team/lead', [whoami(true)])
  await f.live()
  const j = createBossJudge(f.box, { bosses: [] })
  await flush()
  expect(f.calls).toEqual(['/api/whoami'])
  expect(j.isBoss()).toBe(true)
  j.stop()
  await f.live()
  expect(f.calls.length).toBe(1)
})

test('whoami 본문 읽기', () => {
  expect(parseWhoami('{"role":"g/a-1","base":"g/a","group":"g","global_boss":false,"boss_of":["g/"],"is_boss":true}')).toEqual({
    role: 'g/a-1',
    base: 'g/a',
    group: 'g',
    globalBoss: false,
    bossOf: ['g/'],
    isBoss: true,
  })
  expect(parseWhoami('{"is_boss":"yes"}')).toBe(null)
  expect(parseWhoami('nope')).toBe(null)
})

test('머리: 새 X-Switchboard-Role 과 옛 X-Agent-Mail-Role 을 같은 값으로 함께', () => {
  expect(roleHeaders('tok', 'team/w-2')).toEqual({ Authorization: 'Bearer tok', 'X-Switchboard-Role': 'team/w-2', 'X-Agent-Mail-Role': 'team/w-2' })
})

test('묶음 거절(403 outside your group)은 사람이 읽을 한 줄로', () => {
  const body = JSON.stringify({ error: 'recipient outside your group' })
  expect(isGroupRefusal(403, body)).toBe(true)
  expect(isGroupRefusal(403, '{"error":"forbidden"}')).toBe(false)
  expect(isGroupRefusal(400, body)).toBe(false)
  expect(httpWhy(403, body)).toBe(`HTTP 403, ${GROUP_REFUSAL}`)
  expect(httpWhy(403, 'x')).toBe('HTTP 403')
  expect(GROUP_REFUSAL).toBe('묶음 밖 역할에는 보낼 수 없다(받은 메일에 회신은 된다)')
})
