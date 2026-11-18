// D8 원격 권한 답·서버 시스템 통지·멈춤 통지·번호 역할 넘기기: 가짜 switchboard 서버(#73 서버 계약 4·6)로 코어를 돌린다.
import { expect, test } from 'claude-code/testing'

import type { HttpInit } from './host'
import { EMPTY_GAP_MS, SYSTEM_SUBJECT_PREFIX } from './mailbox'
import { cutBytes, trustedAnswer } from './permission'
import { createSwitchboard } from './switchboard'
import { fakeClock, fakeHost, flush } from './testing'
import type { FakeClock, FakeHost } from './testing'

const EP = 'http://mail.test'
const TOKEN = 'tok-SECRET-d8'
const PROFILE = '/home/u/.config/switchboard/p.json'
// 새 시스템 보낸이(#144). 권한 메일·서버 시스템 통지가 이 이름으로도 돈다.
const SYSTEM = 'switchboard/system'

type Mail = { id: number; to: string; sender: string; subject: string; body: string; priority: string; task_id?: string; status: 'pending' | 'read' }
type Perm = { id: string; requester: string; parent?: string; tool: string; summary: string; status: string; decision?: string; note?: string; answered_by?: string }

/** 가짜 서버: slot(presence state 검사)·메일·긴 대기(바로 답)·권한 요청/답. */
const fakeServer = (o: { strictState?: boolean; bosses?: string[] } = {}) => {
  const slots: { base: string; number: number; machine: string; parent?: string }[] = []
  const states: string[] = []
  const mails: Mail[] = []
  const perms: Perm[] = []
  const sends: { from: string; key: string | undefined; body: Record<string, unknown> }[] = []
  let nextId = 1
  /** 긴 대기 중인 요청: 새 메일이 오면 깨운다. */
  let waiters: (() => void)[] = []
  const box = (role: string) => role.replace(/-1$/, '')
  const base = (role: string) => role.replace(/-\d+$/, '')
  const put = (m: Omit<Mail, 'id' | 'status'>) => {
    const mail: Mail = { id: nextId++, status: 'pending', ...m, to: box(m.to) }
    mails.push(mail)
    const w = waiters
    waiters = []
    for (const done of w) done()

    return mail
  }

  const attach = (host: FakeHost) => {
    host.http.route(`${EP}/api/slots/`, ({ url, init }: { url: string; init: HttpInit }) => {
      if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return { status: 401 }
      const b0 = base(init.headers['X-Switchboard-Role'] ?? '')
      const action = url.slice(`${EP}/api/slots/`.length)
      const b = JSON.parse(init.body ?? '{}') as Record<string, unknown>
      if (action === 'release') return { text: '{}' }
      if (typeof b.state === 'string') {
        states.push(b.state)
        // 서버 계약 4: idle·busy·compacting 밖은 400.
        if (o.strictState === true && !['idle', 'busy', 'compacting'].includes(b.state)) return { status: 400, text: 'bad state' }
      }
      let mine = slots.find(s => s.base === b0 && s.machine === b.machine)
      if (mine === undefined) {
        let n = 1
        while (slots.some(s => s.base === b0 && s.number === n)) n++
        mine = { base: b0, number: n, machine: String(b.machine) }
        slots.push(mine)
      }
      if (typeof b.parent === 'string') mine.parent = b.parent

      return { text: JSON.stringify({ role: `${b0}-${mine.number}`, base: b0, number: mine.number, other_active: 0, reclaimed: false }) }
    })
    host.http.route(`${EP}/api/messages`, ({ url, init }: { url: string; init: HttpInit }) => {
      if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return { status: 401 }
      const me = box(init.headers['X-Switchboard-Role'] ?? '')
      if (url === `${EP}/api/messages` && init.method === 'POST') {
        const b = JSON.parse(init.body ?? '{}') as Record<string, unknown>
        sends.push({ from: init.headers['X-Switchboard-Role'] ?? '', key: init.headers['Idempotency-Key'], body: b })
        const m = put({ to: String(b.recipient), sender: init.headers['X-Switchboard-Role'] ?? '', subject: String(b.subject), body: String(b.body), priority: 'normal' })

        return { status: 201, text: JSON.stringify({ id: m.id }) }
      }
      const m = /\/api\/messages\/(\d+)(\/read)?$/.exec(url)
      const mail = m === null ? undefined : mails.find(x => x.id === Number(m[1]) && x.to === me)
      if (mail === undefined) return { status: 404 }
      mail.status = 'read'

      return { text: JSON.stringify({ id: mail.id, body: mail.body, status: 'read' }) }
    })
    host.http.route(`${EP}/api/events/poll`, async ({ url, init }: { url: string; init: HttpInit }) => {
      const me = box(init.headers?.['X-Switchboard-Role'] ?? '')
      const q = new URL(url).searchParams
      const after = q.has('after') ? Number(q.get('after')) : -1
      const timeout = Number(q.get('timeout') ?? '25')
      const list = () => mails.filter(m => m.to === me && m.status === 'pending' && m.id > after)
      // 계약의 긴 대기: 보낼 것이 없으면 새 메일이나 시간 초과까지 응답을 미룬다.
      if (list().length === 0 && timeout > 0) {
        await new Promise<void>(done => {
          waiters.push(done)
          host.clock.after(timeout * 1000, done)
        })
      }
      const events = mails
        .filter(m => m.to === me && m.status === 'pending' && m.id > after)
        .map(m => ({
          id: m.id,
          sender: m.sender,
          subject: m.subject,
          priority: m.priority,
          ...(m.task_id === undefined ? {} : { task_id: m.task_id }),
          ...(m.priority === 'urgent' ? { body: m.body } : {}),
        }))

      return { text: JSON.stringify({ events, cursor: events.length > 0 ? events[events.length - 1]!.id : Math.max(after, 0) }) }
    })
    host.http.route(`${EP}/api/permissions`, ({ url, init }: { url: string; init: HttpInit }) => {
      if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return { status: 401 }
      const who = init.headers['X-Switchboard-Role'] ?? ''
      if (url === `${EP}/api/permissions` && init.method === 'POST') {
        const b = JSON.parse(init.body ?? '{}') as Record<string, unknown>
        // 요청 시점 slot 의 parent 를 고정한다. 같은 base 면 무시.
        const slot = slots.find(s => `${s.base}-${s.number}` === who)
        const parent = slot?.parent !== undefined && base(slot.parent) !== base(who) ? slot.parent : undefined
        if (parent === undefined && (o.bosses ?? []).length === 0) return { status: 409, text: 'nobody can answer' }
        const p: Perm = { id: `perm_${perms.length + 1}`, requester: who, tool: String(b.tool), summary: String(b.summary), status: 'pending', ...(parent === undefined ? {} : { parent }) }
        perms.push(p)
        for (const to of parent === undefined ? (o.bosses ?? []) : [parent]) {
          put({ to, sender: SYSTEM, subject: `permission request: ${p.id}`, body: `${who} asks ${p.tool}`, priority: 'urgent', task_id: p.id })
        }

        return { status: 201, text: JSON.stringify({ ...p, can_answer: false }) }
      }
      const p = perms.find(x => url === `${EP}/api/permissions/${x.id}`)
      if (p === undefined) return { status: 404 }

      return { text: JSON.stringify(p) }
    })
  }

  return {
    attach,
    states,
    mails,
    perms,
    sends,
    put,
    /** 서버가 받아들인 답(누가 답할 수 있는지는 여기서 가리지 않는다: 코어의 두 번째 검사를 본다). */
    answer: (id: string, by: string, decision: 'allow' | 'deny', note?: string) => {
      const p = perms.find(x => x.id === id)!
      p.status = decision === 'allow' ? 'allowed' : 'denied'
      p.decision = decision
      p.answered_by = by
      if (note !== undefined) p.note = note
      put({ to: p.requester, sender: SYSTEM, subject: `permission ${p.status}: ${id}`, body: `${by} ${decision}`, priority: 'urgent', task_id: id })
    },
    expire: (id: string) => void (perms.find(x => x.id === id)!.status = 'expired'),
  }
}

const session = async (
  server: ReturnType<typeof fakeServer>,
  clock: FakeClock,
  o: { base?: string; machine?: string; parent?: string; label?: string; waitMs?: number; bosses?: string[] } = {},
) => {
  const host = fakeHost({ clock, identity: { machine: o.machine ?? 'box-w', cwd: '/work/repo', sessionId: 'sess-w' } })
  host.fs.files.set(PROFILE, JSON.stringify({ endpoint: EP, role: o.base ?? 'team/worker', token: TOKEN }))
  server.attach(host)
  const logs: string[] = []
  const roles: string[] = []
  const board = createSwitchboard(host, {
    log: t => void logs.push(t),
    permissions: { waitMs: o.waitMs ?? 60_000, ...(o.bosses === undefined ? {} : { bosses: o.bosses }) },
    stall: { retry: { baseMs: 1000, capMs: 1000, maxTries: 1 } },
    mail: {
      profilePath: PROFILE,
      log: t => void logs.push(t),
      slot: {
        ...(o.parent === undefined ? {} : { parent: o.parent }),
        ...(o.label === undefined ? {} : { label: o.label }),
        onRole: r => void roles.push(r),
      },
    },
  })
  await board.start()
  await clock.advance(EMPTY_GAP_MS)

  return { host, board, logs, roles }
}

test('권한: 요청이 부모에게 가고, 부모가 허락하면 그 답을 그대로 돌려주며 답 메일은 세션에 넣지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock, { parent: 'team/lead' })
  const pending = w.board.askPermission({ tool: 'Bash', summary: 'git push origin feature' })
  await flush()
  expect(server.perms.length).toBe(1)
  const p = server.perms[0]!
  // 요청자는 번호 주소, parent 는 slot 에서 고정.
  expect(p).toMatchObject({ requester: 'team/worker-1', parent: 'team/lead', tool: 'Bash', summary: 'git push origin feature' })
  expect(server.mails.some(m => m.to === 'team/lead' && m.priority === 'urgent' && m.task_id === p.id)).toBe(true)
  // 기다리는 동안 presence 는 blocked:permission_request.
  expect(w.board.state().condition).toBe('blocked:permission_request')
  expect(server.states).toContain('blocked:permission_request')

  server.answer(p.id, 'team/lead', 'allow')
  await clock.advance(EMPTY_GAP_MS)
  expect(await pending).toEqual({ decision: 'allow', by: 'team/lead' })
  const answerMail = server.mails.find(m => m.to === 'team/worker' && m.task_id === p.id)!
  expect(answerMail.status).toBe('read')
  expect([...w.host.turns, ...w.host.injected].join('\n')).not.toContain(p.id)
  expect(w.board.state().condition).toBe(null)
  w.board.stop()
})

test('권한: 거절은 메모와 함께, 대장 목록의 역할도 답할 수 있다', async () => {
  const clock = fakeClock()
  const server = fakeServer({ bosses: ['corp/boss'] })
  const w = await session(server, clock, { parent: 'team/lead', bosses: ['corp/boss'] })
  const pending = w.board.askPermission({ tool: 'Write', summary: '/etc/hosts' })
  await flush()
  server.answer(server.perms[0]!.id, 'corp/boss', 'deny', '운영 파일')
  // 답 알림 메일이 긴 대기를 깨운다.
  await clock.advance(EMPTY_GAP_MS)
  expect(await pending).toEqual({ decision: 'deny', note: '운영 파일', by: 'corp/boss' })
  w.board.stop()
})

test('권한: 시간 안에 답이 없거나 만료되면 null(화면 창으로), 답할 쪽이 없으면(409) 곧바로 null', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock, { parent: 'team/lead', waitMs: 20_000 })
  const late = w.board.askPermission({ tool: 'Bash', summary: 'rm build' })
  await flush()
  await clock.advance(19_000)
  let settled = false
  void late.then(() => void (settled = true))
  await flush()
  expect(settled).toBe(false)
  await clock.advance(1_000)
  expect(await late).toBe(null)
  expect(w.logs.some(l => l.includes('20초 안에 답이 없어 화면 창으로'))).toBe(true)
  // 늦게 온 답은 이미 넘긴 요청이다: 아무것도 바꾸지 않는다.
  server.answer(server.perms[0]!.id, 'team/lead', 'allow')
  await clock.advance(EMPTY_GAP_MS)

  const ex = w.board.askPermission({ tool: 'Bash', summary: 'ls' })
  await flush()
  server.expire(server.perms[1]!.id)
  await clock.advance(20_000)
  expect(await ex).toBe(null)
  w.board.stop()

  // 부모도 대장도 없다: 서버 409 → 오류가 아니라 「원격 답할 쪽 없음」.
  const v = await session(server, clock, { machine: 'box-v' })
  expect(await v.board.askPermission({ tool: 'Bash', summary: 'ls' })).toBe(null)
  expect(v.logs.some(l => l.includes('원격으로 답할 쪽이 없다'))).toBe(true)
  expect(v.logs.join('\n')).not.toContain(TOKEN)
  v.board.stop()
})

test('권한: 부모·대장이 아닌 쪽의 답과 요청자 base 의 답은 버리고 화면 창으로', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock, { parent: 'team/lead' })
  const a = w.board.askPermission({ tool: 'Bash', summary: 'x' })
  await flush()
  server.answer(server.perms[0]!.id, 'team/worker-2', 'allow')
  await clock.advance(EMPTY_GAP_MS)
  expect(await a).toBe(null)
  const b = w.board.askPermission({ tool: 'Bash', summary: 'y' })
  await flush()
  server.answer(server.perms[1]!.id, 'other/stranger', 'allow')
  await clock.advance(EMPTY_GAP_MS)
  expect(await b).toBe(null)
  expect(w.logs.some(l => l.includes('부모·대장이 아니라 버린다'))).toBe(true)
  w.board.stop()

  // 판정 규칙 자체.
  expect(trustedAnswer({ requester: 'team/worker-1', parent: 'team/lead-1' }, 'team/lead-3', [])).toBe(true)
  expect(trustedAnswer({ requester: 'team/worker-1', parent: 'team/lead' }, 'corp/boss', ['corp/boss'])).toBe(true)
  expect(trustedAnswer({ requester: 'team/worker-1', parent: 'team/lead' }, 'corp/boss', [])).toBe(false)
  expect(trustedAnswer({ requester: 'team/worker-1' }, 'corp/boss', [])).toBe(true)
  expect(trustedAnswer({ requester: 'team/worker-1' }, 'team/worker', [])).toBe(false)
  expect(trustedAnswer({ requester: 'team/worker-1' }, '', [])).toBe(false)
  // 서버가 whoami 로 협업 묶음을 안다(gated, #130): 묶음 대장의 답도 받고, 요청자 base 는 여전히 버린다.
  expect(trustedAnswer({ requester: 'g/worker-1', parent: 'g/lead' }, 'g/boss', ['corp/boss'], true)).toBe(true)
  expect(trustedAnswer({ requester: 'g/worker-1', parent: 'g/lead' }, 'g/worker-2', ['corp/boss'], true)).toBe(false)
})

test('권한: 도구·요약은 서버 바이트 한도로 자른다', () => {
  expect(cutBytes('abc', 10)).toBe('abc')
  const cut = cutBytes('가'.repeat(200), 500)
  expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(500)
  expect(cut.endsWith('…')).toBe(true)
})

test('presence: 서버가 error:·blocked: 상태를 400 으로 거절하면 기본 상태로 다시 보내고 그 뒤로는 기본만', async () => {
  const clock = fakeClock()
  const server = fakeServer({ strictState: true })
  const w = await session(server, clock, { parent: 'team/lead', waitMs: 10_000 })
  const before = server.states.length
  const p = w.board.askPermission({ tool: 'Bash', summary: 'x' })
  await flush()
  await flush()
  expect(server.states.slice(before)).toEqual(['blocked:permission_request', 'idle'])
  expect(w.logs.some(l => l.includes('idle·busy·compacting 만 보고한다'))).toBe(true)
  await clock.advance(10_000)
  expect(await p).toBe(null)
  w.host.emit({ type: 'turn.start' })
  w.host.emit({ type: 'stop.failure', kind: 'billing_error' })
  await flush()
  await flush()
  expect(server.states.slice(before + 2).every(s => ['idle', 'busy', 'compacting'].includes(s))).toBe(true)
  w.board.stop()
})

test('통지: 서버 시스템 보낸이(멈춤·라벨 미연결)의 일반 메일은 본문 그대로 넣고 read 로 표시한다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const lead = await session(server, clock, { base: 'team/lead', machine: 'box-l' })
  const m = server.put({ to: 'team/lead', sender: SYSTEM, subject: 'offline: team/worker-1', body: 'label 81, machine box-w, last report 3m ago', priority: 'normal' })
  await clock.advance(EMPTY_GAP_MS)
  await flush()
  const text = lead.host.turns.join('\n')
  expect(text).toContain(`[메일 #${m.id} 시스템 통지] ${SYSTEM} | offline: team/worker-1`)
  expect(text).toContain('label 81, machine box-w')
  expect(text).not.toContain('을 읽고 처리하라')
  expect(m.status).toBe('read')
  lead.board.stop()
})

test('통지: 안 풀리는 오류는 부모와 대장에게, 기다림은 부모에게 시스템 통지로 한 번 보낸다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock, { parent: 'team/lead', label: '81', bosses: ['corp/boss'] })
  w.host.emit({ type: 'turn.start' })
  w.host.emit({ type: 'stop.failure', kind: 'authentication_failed' })
  w.host.emit({ type: 'turn.complete' })
  await flush()
  await flush()
  const errs = server.sends.filter(s => String(s.body.subject).includes('오류 authentication_failed'))
  expect(errs.map(s => s.body.recipient).sort()).toEqual(['corp/boss', 'team/lead'])
  expect(String(errs[0]!.body.subject).startsWith(SYSTEM_SUBJECT_PREFIX)).toBe(true)
  expect(String(errs[0]!.body.subject)).toContain('team/worker-1 (라벨 81)')
  expect(String(errs[0]!.body.body)).toContain('폴더: /work/repo')

  w.host.emit({ type: 'turn.start' })
  w.host.emit({ type: 'notification', kind: 'permission_prompt' })
  w.host.emit({ type: 'notification', kind: 'permission_prompt' })
  await flush()
  await flush()
  const blocked = server.sends.filter(s => String(s.body.subject).includes('기다림 permission_prompt'))
  expect(blocked.map(s => s.body.recipient)).toEqual(['team/lead'])
  expect(String(blocked[0]!.body.body)).toContain('권한 창')
  expect(server.states).toContain('blocked:permission_prompt')
  expect(JSON.stringify(server.sends)).not.toContain(TOKEN)
  w.board.stop()
})

test('번호 역할: 받은 <base>-N 을 onRole 로 넘긴다(어댑터가 자식 프로세스의 SWITCHBOARD_ROLE 로 쓴다)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const a = await session(server, clock, { machine: 'box-a' })
  const b = await session(server, clock, { machine: 'box-b' })
  expect(a.roles).toEqual(['team/worker-1'])
  expect(b.roles).toEqual(['team/worker-2'])
  a.board.stop()
  b.board.stop()
})

test('권한: 기다림은 넘겨받은 http(훅의 $)로 서버 긴 대기를 걸고, 시간이 지난 뒤 온 답 메일도 세션에 넣지 않는다', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock, { parent: 'team/lead', waitMs: 30_000 })
  const via: string[] = []
  const http = { fetch: (url: string, init?: HttpInit) => (via.push(url), w.host.http.fetch(url, init)) }
  const p = w.board.askPermission({ tool: 'Bash', summary: 'x' }, { http })
  await flush()
  await clock.advance(30_000)
  expect(await p).toBe(null)
  const id = server.perms[0]!.id
  expect(via.some(u => u.endsWith(`/api/permissions/${id}`))).toBe(true)
  // 긴 대기는 남은 시간(최대 25초) 만큼 건다.
  expect(via.some(u => u.includes('/api/events/poll?timeout=25'))).toBe(true)
  server.answer(id, 'team/lead', 'allow')
  await clock.advance(EMPTY_GAP_MS)
  await flush()
  expect([...w.host.turns, ...w.host.injected].join('\n')).not.toContain(id)
  expect(server.mails.find(m => m.task_id === id && m.to === 'team/worker')!.status).toBe('read')
  await w.board.stop()
})

test('끄기: stop 은 번호 역할 release 가 끝난 뒤 풀린다(정상 종료는 offline 통지 대상이 아니다)', async () => {
  const clock = fakeClock()
  const server = fakeServer()
  const w = await session(server, clock)
  await w.board.stop()
  expect(w.host.http.requests.some(r => r.url === `${EP}/api/slots/release`)).toBe(true)
})
