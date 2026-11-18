// D7 연결 통지와 라벨 메일: 작업자가 연결되면 부모(SWITCHBOARD_PARENT)에게 「연결됨」 시스템 통지를 보내고,
// 부모 세션은 그것을 ID 대신 본문 그대로 일반 메일 뒤에 넣는다. `label:<base>/<라벨>` 앞으로 미리 보낸 메일은
// 그 라벨로 연결한 세션이 받는다(서버가 register 때 번호 주소로 옮기고 새 ID 를 준다 — #73 서버 계약 5).
import { expect, test } from 'claude-code/testing'

import type { HttpInit } from './host'
import { EMPTY_GAP_MS, RETRY_MIN_MS, SYSTEM_SUBJECT_PREFIX } from './mailbox'
import { createSwitchboard } from './switchboard'
import { fakeClock, fakeHost, flush } from './testing'
import type { FakeClock, FakeHost } from './testing'

const EP = 'http://mail.test'
const TOKEN = 'tok-SECRET-789'
const PROFILE = '/home/u/.config/switchboard/p.json'

type Mail = { id: number; to: string; sender: string; subject: string; body: string; status: 'pending' | 'read' | 'held'; addressedTo?: string; heldId?: number }

/** 가짜 switchboard 서버: slot(label 포함)·메일 보내기(라벨 주소 보관)·번호 주소 긴 대기(바로 답)·읽음. */
const fakeServer = (clock: FakeClock) => {
  const slots: { base: string; number: number; machine: string; directory: string; label?: string }[] = []
  const mails: Mail[] = []
  const sends: { role: string; key: string | undefined; body: Record<string, unknown> }[] = []
  /** 보내기 응답을 차례로 바꾼다(비면 정상). */
  const sendFaults: number[] = []
  let nextId = 1
  const roles = new Set(['team/lead', 'team/worker'])
  /** 메일함 저장 이름: `<base>-1` 은 `<base>`. */
  const box = (role: string) => role.replace(/-1$/, '')
  const roleOf = (s: { base: string; number: number }) => `${s.base}-${s.number}`

  /** 라벨 주소: `label:<base>/<라벨>`. base 없는 꼴은 400, 모르는 base 는 403. 맞는 활성 slot 이 있으면 그 주소, 없으면 보관. */
  const deliver = (to: string, m: Omit<Mail, 'id' | 'to' | 'status'>): { status: number; mail?: Mail } => {
    if (!to.startsWith('label:')) {
      if (!roles.has(to.replace(/-\d+$/, ''))) return { status: 404 }
      const mail: Mail = { id: nextId++, to: box(to), status: 'pending', ...m }
      mails.push(mail)

      return { status: 201, mail }
    }
    const rest = to.slice('label:'.length)
    const cut = rest.lastIndexOf('/')
    if (cut <= 0 || !/^[A-Za-z0-9._-]{1,128}$/.test(rest.slice(cut + 1))) return { status: 400 }
    const base = rest.slice(0, cut)
    const label = rest.slice(cut + 1)
    if (!roles.has(base)) return { status: 403 }
    const holder = slots.filter(s => s.base === base && s.label === label).sort((a, b) => a.number - b.number)[0]
    const mail: Mail = { id: nextId++, to: holder === undefined ? to : box(roleOf(holder)), status: holder === undefined ? 'held' : 'pending', addressedTo: to, ...m }
    mails.push(mail)

    return { status: 201, mail }
  }

  const attach = (host: FakeHost) => {
    host.http.route(`${EP}/api/slots/`, ({ url, init }: { url: string; init: HttpInit }) => {
      if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return { status: 401, text: 'unauthorized' }
      const base = (init.headers['X-Switchboard-Role'] ?? '').replace(/-\d+$/, '')
      const action = url.slice(`${EP}/api/slots/`.length)
      const b = JSON.parse(init.body ?? '{}') as Record<string, unknown>
      let mine = slots.find(s => s.base === base && s.machine === b.machine && s.directory === b.directory)
      if (action === 'release') return { text: '{}' }
      if (mine === undefined) {
        let n = 1
        while (slots.some(s => s.base === base && s.number === n)) n++
        mine = { base, number: n, machine: String(b.machine), directory: String(b.directory) }
        slots.push(mine)
      }
      if (typeof b.label === 'string') mine.label = b.label
      // 같은 트랜잭션에서 그 base·라벨 보관 메일을 옮긴다: 새 ID, 옛 ID 는 held_id.
      let moved = 0
      if (mine.label !== undefined) {
        const addr = `label:${base}/${mine.label}`
        for (const m of mails.filter(x => x.status === 'held' && x.to === addr)) {
          mails.splice(mails.indexOf(m), 1)
          mails.push({ ...m, id: nextId++, to: box(roleOf(mine)), status: 'pending', heldId: m.id })
          moved++
        }
      }

      return {
        text: JSON.stringify({ role: roleOf(mine), base, number: mine.number, other_active: 0, reclaimed: false, ...(moved > 0 ? { held_delivered: moved } : {}) }),
      }
    })
    host.http.route(`${EP}/api/messages`, ({ url, init }: { url: string; init: HttpInit }) => {
      if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return { status: 401, text: 'unauthorized' }
      const me = box(init.headers['X-Switchboard-Role'] ?? '')
      if (url === `${EP}/api/messages` && init.method === 'POST') {
        const b = JSON.parse(init.body ?? '{}') as Record<string, unknown>
        sends.push({ role: init.headers['X-Switchboard-Role'] ?? '', key: init.headers['Idempotency-Key'], body: b })
        const fault = sendFaults.shift()
        if (fault !== undefined) return { status: fault, text: 'fault' }
        const key = init.headers['Idempotency-Key']
        const dup = key === undefined ? undefined : sends.slice(0, -1).find(s => s.key === key && mails.some(m => m.subject === s.body.subject))
        if (dup !== undefined) return { status: 200, text: '{}' }
        const r = deliver(String(b.recipient), { sender: init.headers['X-Switchboard-Role'] ?? '', subject: String(b.subject), body: String(b.body) })

        return r.mail === undefined ? { status: r.status, text: 'bad' } : { status: 201, text: JSON.stringify({ id: r.mail.id }) }
      }
      const m = /\/api\/messages\/(\d+)(\/read)?$/.exec(url)
      const mail = m === null ? undefined : mails.find(x => x.id === Number(m[1]) && x.to === me)
      if (mail === undefined) return { status: 404, text: 'not found' }
      mail.status = 'read'

      return { text: JSON.stringify({ id: mail.id, body: mail.body, status: 'read' }) }
    })
    host.http.route(`${EP}/api/events/poll`, ({ url, init }: { url: string; init: HttpInit }) => {
      if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return { status: 401, text: 'unauthorized' }
      const me = box(init.headers['X-Switchboard-Role'] ?? '')
      const q = new URL(url).searchParams
      const after = q.has('after') ? Number(q.get('after')) : -1
      const events = mails
        .filter(m => m.to === me && m.status === 'pending' && m.id > after)
        .map(m => ({ id: m.id, sender: m.sender, subject: m.subject, priority: 'normal', ...(m.addressedTo === undefined ? {} : { addressed_to: m.addressedTo }) }))

      return { text: JSON.stringify({ events, cursor: events.length > 0 ? events[events.length - 1]!.id : Math.max(after, 0) }) }
    })
  }

  return {
    attach,
    sends,
    mails,
    failNextSends: (...codes: number[]) => void sendFaults.push(...codes),
    send: (to: string, subject = 'hi', body = '') => deliver(to, { sender: 'team/boss', subject, body }),
  }
}

const session = async (
  server: ReturnType<typeof fakeServer>,
  clock: FakeClock,
  o: { base: string; machine: string; label?: string; parent?: string },
) => {
  const host = fakeHost({ clock, identity: { machine: o.machine, cwd: '/work/repo', sessionId: `sess-${o.machine}` } })
  host.fs.files.set(PROFILE, JSON.stringify({ endpoint: EP, role: o.base, token: TOKEN }))
  server.attach(host)
  const logs: string[] = []
  const board = createSwitchboard(host, {
    mail: {
      profilePath: PROFILE,
      log: t => void logs.push(t),
      slot: { ...(o.label === undefined ? {} : { label: o.label }), ...(o.parent === undefined ? {} : { parent: o.parent }) },
    },
  })
  await board.start()
  await clock.advance(EMPTY_GAP_MS)

  return { host, board, logs }
}

/** 세션이 넣은 턴을 실제처럼 돌렸다 끝낸다. */
const runTurn = async (host: FakeHost) => {
  host.emit({ type: 'turn.start' })
  await flush()
  host.emit({ type: 'turn.complete' })
  await flush()
}

test('연결 통지: 작업자가 연결되면 부모가 「연결됨(주소·라벨·기계·폴더)」을 본문 그대로 받고 read 가 된다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const lead = await session(server, clock, { base: 'team/lead', machine: 'box-l' })
  const worker = await session(server, clock, { base: 'team/worker', machine: 'box-w', label: '22', parent: 'team/lead' })
  await clock.advance(EMPTY_GAP_MS)

  expect(worker.board.mail().role).toBe('team/worker-1')
  expect(server.sends.length).toBe(1)
  expect(server.sends[0]!.body.recipient).toBe('team/lead')
  expect(String(server.sends[0]!.body.subject).startsWith(SYSTEM_SUBJECT_PREFIX)).toBe(true)
  expect(server.sends[0]!.key).toBeDefined()
  expect(JSON.stringify(server.sends[0]!.body)).not.toContain(TOKEN)

  expect(lead.host.turns.length).toBe(1)
  const turn = lead.host.turns[0]!
  expect(turn).toContain('시스템 통지')
  expect(turn).toContain('주소: team/worker-1')
  expect(turn).toContain('라벨: 22')
  expect(turn).toContain('기계: box-w')
  expect(turn).toContain('폴더: /work/repo')
  // ID 만 담는 일반 알림(「… 을 읽고 처리하라」)이 아니다.
  expect(turn).not.toContain('을 읽고 처리하라')
  const notice = server.mails.find(m => m.subject.startsWith(SYSTEM_SUBJECT_PREFIX))!
  expect(notice.status).toBe('read')

  // 다시 잇기·heartbeat 로 통지가 또 가지 않는다.
  await runTurn(lead.host)
  await clock.advance(120_000)
  expect(server.sends.length).toBe(1)
  expect(lead.host.turns.length).toBe(1)
  lead.board.stop()
  worker.board.stop()
})

test('연결 통지: 부모가 없으면 보내지 않고, 시스템 통지는 일반 메일 뒤에 넣는다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  const lead = await session(server, clock, { base: 'team/lead', machine: 'box-l' })
  const solo = await session(server, clock, { base: 'team/worker', machine: 'box-s' })
  expect(server.sends.length).toBe(0)

  // 부모가 바쁜 동안 일반 메일과 연결 통지가 함께 쌓인다.
  lead.host.emit({ type: 'turn.start' })
  await flush()
  const normal = server.send('team/lead', 'plain').mail!.id
  const worker = await session(server, clock, { base: 'team/worker', machine: 'box-w', parent: 'team/lead' })
  await clock.advance(EMPTY_GAP_MS)
  expect(lead.host.turns.length).toBe(0)

  lead.host.emit({ type: 'turn.complete' })
  await flush()
  await clock.advance(EMPTY_GAP_MS)
  expect(lead.host.turns.length).toBe(1)
  expect(lead.host.turns[0]).toContain(`#${normal}`)
  expect(lead.host.turns[0]).not.toContain('시스템 통지')

  await runTurn(lead.host)
  expect(lead.host.turns.length).toBe(2)
  expect(lead.host.turns[1]).toContain('주소: team/worker-2')
  expect(lead.host.turns[1]).toContain('라벨: (없음)')
  for (const s of [lead, solo, worker]) s.board.stop()
})

test('연결 통지: 서버 오류면 같은 키로 다시 보내고, 4xx 는 한 번만 시도하고 기록한다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  server.failNextSends(503)
  const w = await session(server, clock, { base: 'team/worker', machine: 'box-w', parent: 'team/lead' })
  expect(server.sends.length).toBe(1)
  await clock.advance(RETRY_MIN_MS * 5)
  expect(server.sends.length).toBe(2)
  expect(server.sends[1]!.key).toBe(server.sends[0]!.key)
  expect(server.mails.filter(m => m.to === 'team/lead').length).toBe(1)
  w.board.stop()

  const v = await session(server, clock, { base: 'team/worker', machine: 'box-v', parent: 'nobody/here' })
  const before = server.sends.length
  await clock.advance(RETRY_MIN_MS * 20)
  expect(server.sends.length).toBe(before)
  expect(v.logs.some(l => l.includes('연결 통지를 못 보냄(HTTP 404)'))).toBe(true)
  expect(v.logs.join('\n')).not.toContain(TOKEN)
  v.board.stop()
})

test('라벨 메일: 세션이 뜨기 전 label:<base>/<라벨> 앞으로 보낸 지시서를 그 라벨로 연결한 세션이 곧바로 받는다', async () => {
  const clock = fakeClock()
  const server = fakeServer(clock)
  // 꼴이 틀리면 거절: base 없는 라벨은 400, 모르는 base 는 403.
  expect(server.send('label:22').status).toBe(400)
  expect(server.send('label:other/role/22').status).toBe(403)
  const held = server.send('label:team/worker/22', '지시서').mail!
  expect(held.status).toBe('held')

  // 다른 라벨 세션은 받지 않는다.
  const other = await session(server, clock, { base: 'team/worker', machine: 'box-o', label: '99' })
  await clock.advance(EMPTY_GAP_MS)
  expect(other.host.turns.length).toBe(0)

  const w = await session(server, clock, { base: 'team/worker', machine: 'box-w', label: '22' })
  const moved = server.mails.find(m => m.heldId === held.id)!
  expect(moved.id).not.toBe(held.id)
  expect(moved.to).toBe('team/worker-2')
  expect(w.host.turns.length).toBe(1)
  expect(w.host.turns[0]).toContain(`#${moved.id}`)
  expect(w.logs.some(l => l.includes('보관된 메일 1건이 team/worker-2'))).toBe(true)
  expect(other.host.turns.length).toBe(0)

  // 이미 연결된 라벨 앞으로는 보관 없이 바로 간다.
  const direct = server.send('label:team/worker/22', '둘째').mail!
  expect(direct.status).toBe('pending')
  await runTurn(w.host)
  await clock.advance(EMPTY_GAP_MS)
  expect(w.host.turns.at(-1)).toContain(`#${direct.id}`)
  other.board.stop()
  w.board.stop()
})
