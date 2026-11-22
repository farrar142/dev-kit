// D6 번호 역할·presence: 연결할 때 번호를 받아 그 주소로 구독하고, 상태가 바뀔 때와 60초마다 heartbeat 로
// presence 를 보고한다. 단일 역할 -2 경고, 재시작하면 원래 번호, takeover, heartbeat 404 → 다시 번호 받기.
import { expect, test } from 'claude-code/testing'

import type { HttpInit } from './host'
import { EMPTY_GAP_MS } from './mailbox'
import { CLI_VERSION_TIMEOUT_MS, CLI_VERSION_TTL_MS, duplicateWarning, HEARTBEAT_MS, isSingleRole, singleRolesConfig } from './slot'
import { createSwitchboard } from './switchboard'
import { fakeClock, fakeHost, flush } from './testing'
import type { FakeClock, FakeHost } from './testing'

const EP = 'http://mail.test'
const TOKEN = 'tok-SECRET-456'
const PROFILE = '/home/u/.config/switchboard/p.json'
const LEASE_MS = 3 * HEARTBEAT_MS

type Row = { base: string; number: number; machine: string; directory: string; until: number; presence: Record<string, unknown> }

/** 가짜 switchboard 서버(#73 서버 계약 3·4): slot 배정·lease·takeover 와 번호 주소 메일함의 긴 대기(대기 없이 바로 답). */
const fakeServer = (clock: FakeClock) => {
  let rows: Row[] = []
  const mails: { id: number; to: string; status: 'pending' | 'read' }[] = []
  const slotBodies: { action: string; role: string; body: string; version?: string }[] = []
  let nextId = 1
  /** true 면 slot API 가 없는 옛 서버(404). */
  let legacy = false
  const live = (r: Row, now: number) => r.until > now
  /** 메일함 저장 이름: `<base>-1` 은 `<base>`. */
  const box = (role: string) => role.replace(/-1$/, '')
  const view = (r: Row, now: number, extra: Record<string, unknown> = {}) => ({
    role: `${r.base}-${r.number}`,
    base: r.base,
    number: r.number,
    machine: r.machine,
    directory: r.directory,
    other_active: rows.filter(o => o !== r && o.base === r.base && live(o, now)).length,
    reclaimed: false,
    ...extra,
  })
  const smallestFree = (base: string, now: number, skip: number[] = []) => {
    for (let n = 1; ; n++) {
      if (skip.includes(n)) continue
      const holder = rows.find(r => r.base === base && r.number === n)
      if (holder === undefined) return n
      if (!live(holder, now)) {
        rows = rows.filter(r => r !== holder)

        return n
      }
    }
  }

  const attach = (host: FakeHost) => {
    // 목록(GET /api/slots): lease 가 살아 있는 줄. 동작 경로(/api/slots/…)는 아래 처리기가 먼저 맞는다.
    host.http.route(`${EP}/api/slots`, async ({ init }: { url: string; init: HttpInit }) => {
      if (legacy) return { status: 404, text: '404 page not found' }
      if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return { status: 401, text: 'unauthorized' }
      const base = (init.headers['X-Switchboard-Role'] ?? '').replace(/-\d+$/, '')
      const now = await clock.now()
      const out = rows
        .filter(r => r.base === base && live(r, now))
        .map(r => ({ ...view(r, now), ...(typeof r.presence.session_id === 'string' ? { session_id: r.presence.session_id } : {}) }))

      return { text: JSON.stringify(out) }
    })
    host.http.route(`${EP}/api/slots/`, async ({ url, init }: { url: string; init: HttpInit }) => {
      if (legacy) return { status: 404, text: '404 page not found' }
      if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return { status: 401, text: 'unauthorized' }
      const base = (init.headers['X-Switchboard-Role'] ?? '').replace(/-\d+$/, '')
      const action = url.slice(`${EP}/api/slots/`.length)
      slotBodies.push({ action, role: init.headers['X-Switchboard-Role'] ?? '', body: init.body ?? '', ...(init.headers['X-Switchboard-Version'] === undefined ? {} : { version: init.headers['X-Switchboard-Version'] }) })
      const b = JSON.parse(init.body ?? '{}') as Record<string, unknown>
      const now = await clock.now()
      const mine = rows.find(r => r.base === base && r.machine === b.machine && r.directory === b.directory)
      const { machine: _m, directory: _d, ...presence } = b
      if (action === 'register') {
        if (mine !== undefined) {
          mine.until = now + LEASE_MS
          mine.presence = presence

          return { text: JSON.stringify(view(mine, now, { reclaimed: true })) }
        }
        const r: Row = { base, number: smallestFree(base, now), machine: String(b.machine), directory: String(b.directory), until: now + LEASE_MS, presence }
        rows.push(r)

        return { text: JSON.stringify(view(r, now)) }
      }
      if (action === 'heartbeat') {
        if (mine === undefined) return { status: 404, text: 'no slot for this machine and directory; register again' }
        mine.until = now + LEASE_MS
        mine.presence = { ...mine.presence, ...presence }

        return { text: JSON.stringify(view(mine, now)) }
      }
      if (action === 'takeover') {
        const holder = rows.find(r => r.base === base && r.number === 1)
        rows = rows.filter(r => r !== mine)
        let displaced: Row | undefined
        if (holder !== undefined && holder !== mine) {
          if (live(holder, now)) {
            holder.number = smallestFree(base, now, [1])
            displaced = holder
          } else rows = rows.filter(r => r !== holder)
        }
        const r: Row = { base, number: 1, machine: String(b.machine), directory: String(b.directory), until: now + LEASE_MS, presence }
        rows.push(r)

        return { text: JSON.stringify(view(r, now, displaced === undefined ? {} : { displaced: view(displaced, now) })) }
      }
      if (action === 'release') {
        if (mine !== undefined) mine.until = now

        return { text: JSON.stringify(mine === undefined ? {} : view(mine, now)) }
      }

      return { status: 404, text: 'not found' }
    })
    host.http.route(`${EP}/api/events/poll`, ({ url, init }: { url: string; init: HttpInit }) => {
      if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return { status: 401, text: 'unauthorized' }
      const me = box(init.headers['X-Switchboard-Role'] ?? '')
      const q = new URL(url).searchParams
      const after = q.has('after') ? Number(q.get('after')) : -1
      const events = mails.filter(m => m.to === me && m.status === 'pending' && m.id > after).map(m => ({ id: m.id, sender: 'x/y', subject: `s${m.id}`, priority: 'normal' }))

      return { text: JSON.stringify({ events, cursor: events.length > 0 ? events[events.length - 1]!.id : Math.max(after, 0) }) }
    })
  }

  return {
    attach,
    slotBodies,
    setLegacy: (v: boolean) => void (legacy = v),
    online: async () => {
      const now = await clock.now()

      return rows.filter(r => live(r, now)).map(r => `${r.base}-${r.number}@${r.machine}:${r.directory}`).sort()
    },
    row: (machine: string) => rows.find(r => r.machine === machine),
    send: (to: string) => {
      const id = nextId++
      mails.push({ id, to: box(to), status: 'pending' })

      return id
    },
  }
}

const session = async (
  server: ReturnType<typeof fakeServer>,
  clock: FakeClock,
  o: { base: string; machine: string; cwd?: string; sessionId?: string; label?: string; parent?: string; singleRoles?: readonly string[]; cliVersion?: () => Promise<string | undefined> },
) => {
  const host = fakeHost({ clock, identity: { machine: o.machine, cwd: o.cwd ?? '/work/repo', sessionId: o.sessionId ?? `sess-${o.machine}` } })
  host.fs.files.set(PROFILE, JSON.stringify({ endpoint: EP, role: o.base, token: TOKEN }))
  server.attach(host)
  const logs: string[] = []
  const warnings: string[] = []
  const board = createSwitchboard(host, {
    mail: {
      profilePath: PROFILE,
      log: t => void logs.push(t),
      slot: {
        warn: t => void warnings.push(t),
        ...(o.label === undefined ? {} : { label: o.label }),
        ...(o.parent === undefined ? {} : { parent: o.parent }),
        ...(o.singleRoles === undefined ? {} : { singleRoles: o.singleRoles }),
        ...(o.cliVersion === undefined ? {} : { cliVersion: o.cliVersion }),
      },
    },
  })
  await board.start()
  await clock.advance(EMPTY_GAP_MS)

  return { host, board, logs, warnings }
}

/** 알림 턴에 실린 메일 ID. */
const announced = (host: FakeHost) => host.turns.join('\n').match(/#\d+/g) ?? []

test('slot: 두 번째 세션은 -2 를 받고, 번호 없이 보낸 메일은 -1 만, -2 앞 메일은 -2 만 받는다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const a = await session(server, clock, { base: 'team/worker', machine: 'box-a' })
  const b = await session(server, clock, { base: 'team/worker', machine: 'box-b' })
  expect(a.board.mail().role).toBe('team/worker-1')
  expect(b.board.mail().role).toBe('team/worker-2')

  const toBase = server.send('team/worker')
  const toTwo = server.send('team/worker-2')
  await clock.advance(EMPTY_GAP_MS * 2)
  expect(announced(a.host)).toEqual([`#${toBase}`])
  expect(announced(b.host)).toEqual([`#${toTwo}`])
  // 단일 역할이 아니면 경고하지 않는다.
  expect(b.warnings).toEqual([])
})

test('slot: 단일 역할(boss·coordinator)에 -2 가 생기면 그 세션만 한 번 경고한다(takeover 안내)', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const a = await session(server, clock, { base: 'sandbox/boss', machine: 'box-a' })
  const b = await session(server, clock, { base: 'sandbox/boss', machine: 'box-b' })
  expect(a.warnings).toEqual([])
  expect(b.warnings.length).toBe(1)
  expect(b.warnings[0]).toContain('sandbox/boss-2')
  expect(b.warnings[0]).toContain('/switchboard-takeover')
  await clock.advance(HEARTBEAT_MS * 2) // heartbeat 마다 되풀이하지 않는다.
  expect(b.warnings.length).toBe(1)

  expect(isSingleRole('flow/coordinator', singleRolesConfig(undefined))).toBe(true)
  expect(isSingleRole('flow/worker', singleRolesConfig(undefined))).toBe(false)
  expect(isSingleRole('team/lead', singleRolesConfig('lead, x'))).toBe(true)
  expect(singleRolesConfig('off')).toEqual([])
  expect(duplicateWarning({ role: 'a/boss-2', base: 'a/boss', number: 2, otherActive: 1, reclaimed: false })).not.toContain(TOKEN)
})

test('slot: 같은 기계·폴더로 다시 뜨면 원래 번호를 돌려받는다(-1 이 재시작해도 -1, -2 도 -2)', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const a = await session(server, clock, { base: 'team/worker', machine: 'box-a' })
  const b = await session(server, clock, { base: 'team/worker', machine: 'box-b' })
  // 죽은 것처럼: 릴리스 없이 사라진다(타이머만 멈추려고 새 세션이 같은 식별자로 뜬다).
  const a2 = await session(server, clock, { base: 'team/worker', machine: 'box-a' })
  expect(a2.board.mail().role).toBe('team/worker-1')
  expect(a2.logs.join('\n')).toContain('원래 번호')
  // 깨끗이 끄고(release) 다시 켜도 아무도 안 가져갔으면 같은 번호.
  b.board.stop()
  await flush()
  expect(await server.online()).toEqual(['team/worker-1@box-a:/work/repo'])
  const b2 = await session(server, clock, { base: 'team/worker', machine: 'box-b' })
  expect(b2.board.mail().role).toBe('team/worker-2')
  a.board.stop()
})

test('presence: 상태가 바뀔 때와 60초마다 heartbeat 로 상태·컨텍스트 토큰·마지막 턴·라벨·부모를 보고하고, 토큰(비밀)은 몸에 없다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const a = await session(server, clock, { base: 'team/worker', machine: 'box-a', label: 'issue-79', parent: 'team/coordinator-1' })
  const reg = JSON.parse(server.slotBodies[0]!.body) as Record<string, unknown>
  expect(server.slotBodies[0]!.action).toBe('register')
  expect(reg).toEqual({ machine: 'box-a', directory: '/work/repo', session_id: 'sess-box-a', label: 'issue-79', parent: 'team/coordinator-1', state: 'idle' })

  a.host.setUsage({ tokens: 123_456 })
  a.host.emit({ type: 'turn.start' })
  await flush()
  const busy = server.slotBodies[server.slotBodies.length - 1]!
  expect(busy.action).toBe('heartbeat')
  expect(JSON.parse(busy.body)).toMatchObject({ state: 'busy', context_tokens: 123_456 })

  a.host.emit({ type: 'turn.complete' })
  await flush()
  const idle = JSON.parse(server.slotBodies[server.slotBodies.length - 1]!.body) as Record<string, unknown>
  expect(idle.state).toBe('idle')
  expect(typeof idle.last_turn_at).toBe('string')
  expect(Number.isNaN(Date.parse(String(idle.last_turn_at)))).toBe(false)

  // 상태가 그대로면 60초마다 한 번.
  const before = server.slotBodies.length
  await clock.advance(HEARTBEAT_MS)
  expect(server.slotBodies.length).toBe(before + 1)
  await clock.advance(HEARTBEAT_MS * 2)
  expect(server.slotBodies.length).toBe(before + 3)
  // 3분이 지나도 heartbeat 가 lease 를 늘려 온라인이다.
  expect(await server.online()).toEqual(['team/worker-1@box-a:/work/repo'])

  for (const s of server.slotBodies) expect(s.body).not.toContain(TOKEN)
  for (const l of a.logs) expect(l).not.toContain(TOKEN)
  a.board.stop()
  await flush()
  expect(server.slotBodies[server.slotBodies.length - 1]!.action).toBe('release')
  expect(await server.online()).toEqual([])
})

test('takeover: -2 세션이 -1 을 가져오면 번호 없는 메일을 받고, 밀린 세션은 다음 heartbeat 에 -2 로 다시 구독한다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const a = await session(server, clock, { base: 'sandbox/coordinator', machine: 'box-a' })
  const b = await session(server, clock, { base: 'sandbox/coordinator', machine: 'box-b' })
  const r = await b.board.takeover()
  expect(r).toEqual({ ok: true, role: 'sandbox/coordinator-1', displaced: 'sandbox/coordinator-2' })
  expect(b.board.mail().role).toBe('sandbox/coordinator-1')
  await clock.advance(HEARTBEAT_MS)
  expect(a.board.mail().role).toBe('sandbox/coordinator-2')
  expect(a.warnings.length).toBe(1) // 밀린 쪽이 이제 중복이다.
  expect(a.logs.join('\n')).toContain('takeover 로 sandbox/coordinator-1 에서 밀림')

  const toBase = server.send('sandbox/coordinator')
  await clock.advance(EMPTY_GAP_MS * 2)
  expect(announced(b.host)).toEqual([`#${toBase}`])
  expect(announced(a.host)).toEqual([])
})

test('heartbeat 404(만료 뒤 남이 가져감)면 번호를 다시 받아 그 주소로 다시 구독한다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const a = await session(server, clock, { base: 'team/worker', machine: 'box-a' })
  // 서버에서 a 의 줄이 사라졌다(만료 뒤 정리 등).
  const row = server.row('box-a')!
  row.machine = 'gone'
  row.until = 0
  await session(server, clock, { base: 'team/worker', machine: 'box-b' }) // -1 이 비어 있으니 b 가 -1.
  await clock.advance(HEARTBEAT_MS)
  expect(a.board.mail().role).toBe('team/worker-2')
  expect(a.logs.join('\n')).toContain('다시 받는다')
})

test('slot API 가 없는 옛 서버면 프로필 역할 그대로 구독하고, 생기면 번호로 옮긴다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  server.setLegacy(true)
  const a = await session(server, clock, { base: 'team/worker', machine: 'box-a' })
  expect(a.board.mail().role).toBe('team/worker')
  expect(a.board.mail().status).toBe('live')
  const id = server.send('team/worker')
  await clock.advance(EMPTY_GAP_MS * 2)
  expect(announced(a.host)).toEqual([`#${id}`])
  server.setLegacy(false)
  await clock.advance(HEARTBEAT_MS)
  expect(a.board.mail().role).toBe('team/worker-1')
  expect((await a.board.takeover()).ok).toBe(true)
})

test('slot: 같은 기계·폴더의 두 번째 세션은 첫 세션의 번호를 뺏지 않고 다음 번호를 받는다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const a = await session(server, clock, { base: 'team/coordinator', machine: 'box-a', sessionId: 'aaaaaaaa-1111' })
  const b = await session(server, clock, { base: 'team/coordinator', machine: 'box-a', sessionId: 'bbbbbbbb-2222' })
  expect(a.board.mail().role).toBe('team/coordinator-1')
  expect(b.board.mail().role).toBe('team/coordinator-2')
  expect(b.logs).toContain('switchboard slot: 같은 기계·폴더를 다른 세션(team/coordinator-1)이 쓰고 있어 따로 번호를 받는다')
  expect(await server.online()).toEqual(['team/coordinator-1@box-a:/work/repo', 'team/coordinator-2@box-a:/work/repo #bbbbbbbb'])

  // 두 번째를 닫아도 첫 세션은 -1 그대로(heartbeat 가 이어진다).
  await b.board.stop()
  await clock.advance(HEARTBEAT_MS * 4)
  expect(a.board.mail().role).toBe('team/coordinator-1')
  expect(await server.online()).toEqual(['team/coordinator-1@box-a:/work/repo'])
})

test('slot: 같은 세션이 다시 뜨면(resume) 원래 번호를 되찾는다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const a = await session(server, clock, { base: 'team/worker', machine: 'box-a', sessionId: 'aaaaaaaa-1111' })
  expect(a.board.mail().role).toBe('team/worker-1')
  // 죽은 채(release 없이, lease 는 살아 있음) 같은 세션 id 로 다시 뜬다: 자기 줄이므로 같은 번호.
  const again = await session(server, clock, { base: 'team/worker', machine: 'box-a', sessionId: 'aaaaaaaa-1111' })
  expect(again.board.mail().role).toBe('team/worker-1')
  expect(again.logs.some(l => l.includes('따로 번호'))).toBe(false)
})

test('slot: 두 번째 세션도 resume 하면 그 세션 표지로 원래 번호(-2)를 되찾는다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  await session(server, clock, { base: 'team/worker', machine: 'box-a', sessionId: 'aaaaaaaa-1111' })
  const b = await session(server, clock, { base: 'team/worker', machine: 'box-a', sessionId: 'bbbbbbbb-2222' })
  expect(b.board.mail().role).toBe('team/worker-2')
  // 첫 세션이 살아 있는 동안 두 번째가 죽었다가(release 없이) 같은 id 로 다시 뜬다.
  const again = await session(server, clock, { base: 'team/worker', machine: 'box-a', sessionId: 'bbbbbbbb-2222' })
  expect(again.board.mail().role).toBe('team/worker-2')
})

test('slot: 같은 기계·폴더에 다른 세션이 없으면 폴더 그대로 등록한다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const a = await session(server, clock, { base: 'team/worker', machine: 'box-a', sessionId: 'aaaaaaaa-1111' })
  expect(a.board.mail().role).toBe('team/worker-1')
  expect(server.slotBodies.filter(x => x.action === 'register').map(x => (JSON.parse(x.body) as { directory: string }).directory)).toEqual(['/work/repo'])
})

test('presence: 서브에이전트가 돌면 subagents 를 싣고, 0이면 싣지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const a = await session(server, clock, { base: 'team/worker', machine: 'box-a' })
  a.host.emit({ type: 'subagent.start', id: 'a1' })
  await flush()
  expect(JSON.parse(server.slotBodies[server.slotBodies.length - 1]!.body)).toMatchObject({ state: 'idle', subagents: 1 })
  a.host.emit({ type: 'subagent.stop', id: 'a1' })
  await flush()
  expect(JSON.parse(server.slotBodies[server.slotBodies.length - 1]!.body)).not.toHaveProperty('subagents')
  a.board.stop()
})

test('CLI 판: register·heartbeat 요청에 X-Switchboard-Version 을 싣고, 판 읽기는 캐시 수명 안에서는 다시 부르지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  let reads = 0
  const a = await session(server, clock, {
    base: 'team/worker',
    machine: 'box-a',
    cliVersion: async () => {
      reads++

      return 'switchboard v0.31.0\n'
    },
  })
  a.host.emit({ type: 'turn.start' })
  await flush()
  await clock.advance(HEARTBEAT_MS)
  expect(server.slotBodies.map(b => b.action)).toEqual(expect.arrayContaining(['register', 'heartbeat']))
  for (const b of server.slotBodies) expect(b.version).toBe('v0.31.0')
  expect(reads).toBe(1)
  a.board.stop()
})

test('CLI 판: 캐시 수명이 지나면 다시 읽어 새 판을 싣고, 다시 읽기가 실패하면 앞의 판이 남는다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const outputs: (string | 'fail' | 'hang')[] = ['switchboard v0.31.0', 'switchboard v0.32.0', 'fail', 'hang']
  let reads = 0
  const a = await session(server, clock, {
    base: 'team/worker',
    machine: 'box-a',
    cliVersion: () => {
      const o = outputs[reads++]!
      if (o === 'hang') return new Promise<string>(() => undefined)

      return o === 'fail' ? Promise.resolve(undefined) : Promise.resolve(o)
    },
  })
  const last = () => server.slotBodies[server.slotBodies.length - 1]!.version
  // 수명 안: 다시 부르지 않는다.
  a.host.emit({ type: 'turn.start' })
  await flush()
  await clock.advance(HEARTBEAT_MS * 5)
  expect(reads).toBe(1)
  expect(last()).toBe('v0.31.0')
  // 수명 뒤: 다시 읽고 새 판을 싣는다(그 heartbeat 는 앞 판으로 나가도 다음 것부터 새 판).
  await clock.advance(CLI_VERSION_TTL_MS)
  await flush()
  await clock.advance(HEARTBEAT_MS)
  expect(reads).toBe(2)
  expect(last()).toBe('v0.32.0')
  // 다시 읽기 실패: 앞의 판이 남는다.
  await clock.advance(CLI_VERSION_TTL_MS)
  await flush()
  await clock.advance(HEARTBEAT_MS)
  expect(reads).toBe(3)
  expect(last()).toBe('v0.32.0')
  // 다시 읽기가 멈춰도 heartbeat 는 밀리지 않고 앞의 판을 싣는다.
  await clock.advance(CLI_VERSION_TTL_MS)
  const before = server.slotBodies.length
  await clock.advance(HEARTBEAT_MS)
  expect(reads).toBe(4)
  expect(server.slotBodies.length).toBeGreaterThan(before)
  expect(last()).toBe('v0.32.0')
  a.board.stop()
})

test('CLI 판: 읽기 실패·이상한 출력·시간 초과면 머리만 빼고 번호 받기·heartbeat 는 그대로다', async () => {
  const cases: [string, () => Promise<string | undefined>][] = [
    ['CLI 없음', async () => undefined],
    ['오류', async () => Promise.reject(new Error('spawn ENOENT'))],
    ['이상한 출력', async () => 'switchboard dev-build'],
    ['시간 초과', () => new Promise<string>(() => undefined)],
  ]
  for (const [name, cliVersion] of cases) {
    const clock = fakeClock()
    const server = fakeServer(clock)
    const started = session(server, clock, { base: 'team/worker', machine: 'box-a', cliVersion })
    // 판 읽기가 멈춰도 번호 받기는 한도 뒤에 이어진다.
    await flush()
    await clock.advance(CLI_VERSION_TIMEOUT_MS)
    const a = await started
    await clock.advance(HEARTBEAT_MS)
    expect(server.slotBodies.map(b => b.action), name).toEqual(expect.arrayContaining(['register', 'heartbeat']))
    for (const b of server.slotBodies) expect(b.version, name).toBeUndefined()
    expect(await server.online(), name).toEqual(['team/worker-1@box-a:/work/repo'])
    a.board.stop()
  }
})
