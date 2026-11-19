// 질문 경로 e2e(#157): 실제 switchboard 서버 + 플러그인 코어. 경우마다 묻는 세션에 「[질문 패널 답 q_…]」가 정확히 몇 번 들어오는지 센다.
// 서버 쪽 짝: switchboard 저장소 internal/server/questions_sot_test.go(같은 경우 이름, 같은 실패 머리 「question source of truth: …」).
// 경우 7(좁은 폭 토스트)은 Claude 모드 런타임이 필요해 hooks/register.test.tsx 의 「좁은 터미널(#136)」 시험이 맡는다(e2e/ci.sh 가 그 시험이 돌았는지 센다).
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { ASKER, askerSession, bossSession, QUESTIONS, SOT, sleep, startServer, waitFor } from './harness'
import type { BossSession, Server, Session } from './harness'

/** 답이 들어온 뒤 더 들어오는지 지켜보는 시간(긴 대기가 한 바퀴 더 돌 만큼). */
const SETTLE_MS = 1500

let server: Server
let open: Session[] = []

beforeEach(async () => {
  server = await startServer()
  open = []
})

afterEach(async () => {
  for (const s of open) await s.stop()
  await server.stop()
})

const asker = async (where?: { sessionId: string; cwd: string; label?: string }) => {
  const s = await askerSession(server, where)
  open.push(s)

  return s
}

const boss = async () => {
  const s = await bossSession(server)
  open.push(s)

  return s
}

/** 묻는 세션이 서버 질문을 올리고, 대장 패널에 뜰 때까지 기다린다. */
const ask = async (a: Session, b: BossSession) => {
  const r = await a.board.askRemote(QUESTIONS)
  assert.equal(r.kind, 'remote', `${SOT}: 묻는 세션의 ask 가 서버 질문으로 올라가지 않음(${JSON.stringify(r)})`)
  const id = r.kind === 'remote' ? r.id : ''
  await waitFor(() => b.batchOf(id)?.status === 'pending', `대장 패널에 ${id} 가 뜨지 않음`)

  return id
}

const dashboardAnswer = (id: string) => server.admin('POST', `/api/admin/questions/${id}/answer`, { answers: [{ selected: ['SQLite'], other: '' }] })

/** 묻는 세션에 답이 정확히 want 번 들어왔는가(들어온 뒤 SETTLE_MS 더 지켜본다). */
const expectDelivered = async (s: Session, id: string, want: number, what: string, ms = 10_000) => {
  if (want > 0) await waitFor(() => s.answerLines(id) >= want, `${what}이 묻는 세션에 들어오지 않음`, ms)
  await sleep(SETTLE_MS)
  const n = s.answerLines(id)
  assert.equal(n, want, `${SOT}: ${what}이 묻는 세션(${s.role})에 ${n}번 들어감(${want}번이어야 함)`)
}

/** 관리자 목록의 답 넘김 상태(waiting: 넘길 세션을 기다림, '': 넘김 끝 또는 해당 없음). */
const delivery = async (id: string) => {
  const r = await server.admin('GET', '/api/admin/questions')
  const list = (r.json as { questions?: { id: string; delivery?: string }[] } | null)?.questions ?? []

  return list.find(q => q.id === id)?.delivery ?? ''
}

const stored = async (id: string) => (await server.call('partner-a/coordinator', 'GET', `/api/questions/${id}`)).json as { status: string; answered_by: string }

test(`${SOT}: PanelAnswer — 대장 패널 답이 묻는 세션에 1번 들어가고 대장 세션 턴에는 안 들어간다`, async () => {
  const b = await boss()
  const a = await asker()
  const id = await ask(a, b)
  await b.answerOnPanel(id)
  await expectDelivered(a, id, 1, '패널 답')
  const v = await stored(id)
  assert.equal(v.status, 'answered', `${SOT}: 패널 답 뒤 서버 상태 ${v.status}`)
  assert.equal(b.batchOf(id)?.status, 'sent', `${SOT}: 패널 답 뒤 대장 패널 항목이 닫히지 않음`)
  assert.equal(b.host.turns.filter(t => t.includes(id)).length, 0, `${SOT}: 패널 답이 대장 세션 턴으로 들어감: ${JSON.stringify(b.host.turns)}`)
})

test(`${SOT}: DashboardAnswer — 대시보드 답이 묻는 세션에 1번, 대장 패널 항목은 닫힌다`, async () => {
  const b = await boss()
  const a = await asker()
  const id = await ask(a, b)
  const r = await dashboardAnswer(id)
  assert.equal(r.status, 200, `${SOT}: 대시보드 답 ${r.status} ${r.text}`)
  await expectDelivered(a, id, 1, '대시보드 답')
  await waitFor(() => b.batchOf(id)?.via === 'remote-answered', `대시보드 답 뒤 대장 패널 ${id} 항목이 닫히지 않음(${JSON.stringify(b.batchOf(id))})`)
  assert.equal((await stored(id)).answered_by, 'dashboard', `${SOT}: 대시보드 답의 answered_by`)
})

test(`${SOT}: FirstAnswerWins — 패널이 먼저면 대시보드는 409, 세션에는 1번`, async () => {
  const b = await boss()
  const a = await asker()
  const id = await ask(a, b)
  await b.answerOnPanel(id)
  const late = await dashboardAnswer(id)
  assert.equal(late.status, 409, `${SOT}: 늦은 대시보드 답이 ${late.status}(409여야 함)`)
  await expectDelivered(a, id, 1, '먼저 온 패널 답')
})

test(`${SOT}: FirstAnswerWins — 대시보드가 먼저면 늦은 패널 답은 409, 패널에는 사람이 읽을 한 줄만, 세션에는 1번`, async () => {
  const b = await boss()
  const a = await asker()
  const id = await ask(a, b)
  const batch = b.batchOf(id)?.id ?? ''
  // 끌어오기가 「답이 났다」를 패널에 닫기 전에 사람이 패널에서 답한 것으로 만든다.
  const release = b.holdClose()
  try {
    const first = await dashboardAnswer(id)
    assert.equal(first.status, 200, `${SOT}: 대시보드 답 ${first.status} ${first.text}`)
    await b.answerOnPanel(id)
  } finally {
    release()
  }
  const lines = b.notes.filter(t => t.includes(batch))
  assert.equal(lines.length, 1, `${SOT}: 늦은 패널 답 뒤 패널 알림이 ${lines.length}줄(1줄이어야 함): ${JSON.stringify(b.notes)}`)
  assert.match(lines[0] ?? '', /이미 답이 났거나 거둔 질문이라 닫았습니다/, `${SOT}: 늦은 패널 답의 알림이 409 를 사람이 읽을 말로 옮기지 않음`)
  assert.equal(b.batchOf(id)?.via, 'remote-taken', `${SOT}: 늦은 패널 답 뒤 패널 항목 상태 ${b.batchOf(id)?.via}`)
  await expectDelivered(a, id, 1, '먼저 온 대시보드 답')
})

test(`${SOT}: WithdrawBeforeAnswer — 답하기 전에 거두면 세션에 0번, 대장 패널 항목은 닫힌다`, async () => {
  const b = await boss()
  const a = await asker()
  const id = await ask(a, b)
  const w = await a.board.withdrawRemote(id)
  assert.equal(w.ok, true, `${SOT}: 거두기 실패 ${JSON.stringify(w)}`)
  await waitFor(() => b.batchOf(id)?.via === 'remote-withdrawn', `거둔 뒤 대장 패널 ${id} 항목이 닫히지 않음(${JSON.stringify(b.batchOf(id))})`)
  const late = await dashboardAnswer(id)
  assert.equal(late.status, 409, `${SOT}: 거둔 질문에 대한 답이 ${late.status}(409여야 함)`)
  await expectDelivered(a, id, 0, '거둔 질문의 답')
})

test(`${SOT}: AskerSessionRestarts — 묻는 세션이 같은 번호로 다시 붙으면 답이 새 세션에 1번`, async () => {
  const b = await boss()
  const a1 = await asker({ sessionId: 'asker-1', cwd: '/work/asker' })
  const id = await ask(a1, b)
  const before = a1.board.mail().role
  // 세션이 끝나고(번호를 돌려주고) 같은 기계·폴더에서 새 세션으로 다시 연결된다.
  await a1.stop()
  const a2 = await asker({ sessionId: 'asker-2', cwd: '/work/asker' })
  assert.equal(a2.board.mail().role, before, `${SOT}: 재시작한 묻는 세션이 다른 번호(${a2.board.mail().role}, 전 ${before})로 붙음`)
  await b.answerOnPanel(id)
  await expectDelivered(a2, id, 1, '재시작 뒤 패널 답')
  assert.equal(a1.answerLines(id), 0, `${SOT}: 끝난 세션에 답이 들어감`)
})

test(`${SOT}: AskerBackUnderAnotherNumber — 묻는 세션이 다른 번호로 돌아와도 답은 그 세션에 1번, 옛 번호를 받은 남의 세션에는 0번`, async () => {
  const b = await boss()
  await asker({ sessionId: 'a', cwd: '/work/a' })
  const q = await asker({ sessionId: 'q', cwd: '/work/q' })
  const id = await ask(q, b)
  const old = q.board.mail().role
  await q.stop()
  const other = await asker({ sessionId: 'other', cwd: '/work/other' })
  assert.equal(other.board.mail().role, old, `${SOT}: 다른 세션이 묻던 번호 ${old} 를 받지 않음(${other.board.mail().role})`)
  const back = await asker({ sessionId: 'q-back', cwd: '/work/q' })
  assert.notEqual(back.board.mail().role, old, `${SOT}: 돌아온 묻는 세션이 옛 번호를 받음`)
  await b.answerOnPanel(id)
  await expectDelivered(back, id, 1, '다른 번호로 돌아온 뒤 패널 답')
  assert.equal(other.answerLines(id), 0, `${SOT}: 옛 번호를 받은 남의 세션(${other.board.mail().role})에 답이 들어감`)
})

test(`${SOT}: NewestLiveSlotGetsAnswer — 묻던 세션이 없으면 가장 늦게 붙은 같은 역할 세션 하나에만 1번`, async () => {
  const b = await boss()
  const q = await asker({ sessionId: 'q', cwd: '/work/q' })
  const id = await ask(q, b)
  await q.stop()
  const older = await asker({ sessionId: 'older', cwd: '/work/a' })
  const newer = await asker({ sessionId: 'newer', cwd: '/work/b' })
  await b.answerOnPanel(id)
  await expectDelivered(newer, id, 1, '묻던 세션이 없을 때의 패널 답')
  assert.equal(older.answerLines(id), 0, `${SOT}: 먼저 붙은 세션(${older.board.mail().role})에도 답이 들어감`)
})

test(`${SOT}: WaitingAnswerGoesToNextSessionOnce — 같은 역할 세션이 하나도 없으면 답은 기다렸다가 다음에 붙는 세션 하나에 1번`, async () => {
  const b = await boss()
  const a = await asker({ sessionId: 'a', cwd: '/work/a' })
  const q = await asker({ sessionId: 'q', cwd: '/work/q' })
  const id = await ask(q, b)
  await a.stop()
  await q.stop()
  await b.answerOnPanel(id)
  assert.equal(await delivery(id), 'waiting', `${SOT}: 세션이 없을 때 관리자 목록 delivery 가 waiting 이 아님`)
  const first = await asker({ sessionId: 'first', cwd: '/work/b' })
  const second = await asker({ sessionId: 'second', cwd: '/work/c' })
  await expectDelivered(first, id, 1, '기다리던 답')
  assert.equal(second.answerLines(id), 0, `${SOT}: 기다리던 답이 둘째 세션(${second.board.mail().role})에도 들어감`)
  assert.equal(await delivery(id), '', `${SOT}: 넘긴 뒤에도 관리자 목록 delivery 가 남음`)
})

test(`${SOT}: OtherLabelNeverGetsAnswer — 라벨이 다른 세션에는 답이 안 가고, 같은 라벨 세션이 붙을 때 1번`, async () => {
  const b = await boss()
  const busy = await asker({ sessionId: 'busy', cwd: '/work/a', label: 'issue-2' })
  const q = await asker({ sessionId: 'q', cwd: '/work/q', label: 'issue-1' })
  const id = await ask(q, b)
  await q.stop()
  await b.answerOnPanel(id)
  assert.equal(await delivery(id), 'waiting', `${SOT}: 다른 라벨 세션만 있을 때 관리자 목록 delivery 가 waiting 이 아님`)
  const taker = await asker({ sessionId: 'taker', cwd: '/work/d', label: 'issue-2' })
  const same = await asker({ sessionId: 'same', cwd: '/work/e', label: 'issue-1' })
  await expectDelivered(same, id, 1, '같은 라벨 세션에 넘긴 답')
  assert.equal(busy.answerLines(id), 0, `${SOT}: 다른 라벨 세션(busy)에 답이 들어감`)
  assert.equal(taker.answerLines(id), 0, `${SOT}: 다른 라벨 세션(taker)에 답이 들어감`)
})

test(`${SOT}: LiveAskerKeepsAnswer — 묻던 세션이 살아 있으면 뒤에 붙은 같은 역할 세션이 있어도 묻던 세션에 1번`, async () => {
  const b = await boss()
  await asker({ sessionId: 'a', cwd: '/work/a' })
  const q = await asker({ sessionId: 'q', cwd: '/work/q' })
  const id = await ask(q, b)
  const newer = await asker({ sessionId: 'newer', cwd: '/work/b' })
  await b.answerOnPanel(id)
  await expectDelivered(q, id, 1, '살아 있는 묻던 세션의 답')
  assert.equal(newer.answerLines(id), 0, `${SOT}: 뒤에 붙은 세션(${newer.board.mail().role})에 답이 들어감`)
})

// 13~16: 묻던 세션이 정상 종료 없이 죽은 경우(서버 v0.12.1, sandcorporation/switchboard#171).
// 서버를 짧은 임대로 다시 띄우고, 세션 heartbeat 도 그에 맞춰 짧게 돈다(harness). 고정 sleep 대신
// 슬롯 목록에서 임대가 끝나고 산 세션의 heartbeat 가 한 번 더 온 것을 기다린다.
const LEASE_S = 6

const leaseServer = async () => {
  await server.stop()
  server = await startServer({ slotLeaseSeconds: LEASE_S })
}

type SlotRow = { role: string; directory: string; lease_expires_at: string }

const slots = async (): Promise<SlotRow[]> => {
  const r = await server.call(ASKER, 'GET', '/api/slots')

  return Array.isArray(r.json) ? (r.json as SlotRow[]) : []
}

/** dead 의 임대가 끝나고, 그 뒤 alive 들이 heartbeat 를 한 번씩 더 보낼 때까지. */
const outliveLease = async (dead: string, alive: string[]) => {
  await waitFor(async () => !(await slots()).some(r => r.role === dead), `죽은 세션 ${dead} 의 임대가 끝나지 않음`, (LEASE_S + 10) * 1000)
  const ended = Date.now()
  await waitFor(
    async () => {
      const rows = await slots()

      return alive.every(role => rows.some(r => r.role === role && Date.parse(r.lease_expires_at) > ended + (LEASE_S - 1) * 1000))
    },
    `임대가 끝난 뒤 산 세션(${alive.join(',')})의 heartbeat 가 오지 않음`,
    10_000,
  )
}

/** role 메일함의 id 답 메일(목록은 읽음 표시를 하지 않는다). */
const answerMail = async (role: string, id: string) => {
  // 번호 역할은 바탕 역할 토큰으로 X-Switchboard-Role 만 바꿔 부른다.
  const rr = await fetch(`${server.endpoint}/api/messages?box=inbox`, {
    headers: { Authorization: `Bearer ${server.token(ASKER)}`, 'X-Switchboard-Role': role },
  })
  const list = (await rr.json().catch(() => [])) as { id: number; task_id?: string }[]

  return (Array.isArray(list) ? list : []).filter(m => m.task_id === id)
}

/** 죽은 세션 크래시: 묻고 나서 정상 종료 없이 죽고, 같은 폴더에서 새 세션이 뜬다(플러그인이 폴더에 세션 표지를 붙인다). */
const crashed = async () => {
  const b = await boss()
  await asker({ sessionId: 'keep-a', cwd: '/work/a' })
  const q = await asker({ sessionId: '1a2b3c4d-s1', cwd: '/work/q' })
  const id = await ask(q, b)
  q.host.kill()
  const back = await asker({ sessionId: '52abcdef-s2', cwd: '/work/q' })
  const row = (await slots()).find(r => r.role === back.board.mail().role)
  assert.notEqual(back.board.mail().role, q.board.mail().role, `${SOT}: 재시작한 세션이 죽은 세션의 번호를 받음`)
  assert.equal(row?.directory, '/work/q #52abcdef', `${SOT}: 재시작한 세션 폴더에 세션 표지가 없음(${row?.directory})`)

  return { b, q, back, id }
}

test(`${SOT}: CrashedAskerAnswerMovesAfterLease — 묻던 세션이 죽고 같은 폴더에서 재시작하면 임대가 끝난 뒤 답이 새 세션에 1번`, async () => {
  await leaseServer()
  const { b, q, back, id } = await crashed()
  await b.answerOnPanel(id)
  await expectDelivered(back, id, 1, '죽은 세션의 임대가 끝난 뒤 옮겨진 답', (LEASE_S + 20) * 1000)
  assert.equal((await answerMail(q.board.mail().role, id)).length, 0, `${SOT}: 죽은 세션 메일함에 답이 남음`)
})

test(`${SOT}: ReadAnswerStaysAfterLease — 죽기 전에 읽은 답은 임대가 끝나도 새 세션으로 옮기지 않는다`, async () => {
  await leaseServer()
  const { b, q, back, id } = await crashed()
  await b.answerOnPanel(id)
  const dead = q.board.mail().role
  const mails = await answerMail(dead, id)
  assert.equal(mails.length, 1, `${SOT}: 답할 때 죽은 세션의 임대가 살아 있으면 답은 그 번호 메일함에 있어야 함`)
  const opened = await fetch(`${server.endpoint}/api/messages/${mails[0].id}`, {
    headers: { Authorization: `Bearer ${server.token(ASKER)}`, 'X-Switchboard-Role': dead },
  })
  assert.equal(opened.status, 200, `${SOT}: 죽은 세션의 답 메일을 열지 못함`)
  await outliveLease(dead, [back.board.mail().role])
  await expectDelivered(back, id, 0, '읽은 답')
  assert.equal((await answerMail(dead, id)).length, 1, `${SOT}: 읽은 답이 죽은 세션 메일함에서 사라짐`)
})

test(`${SOT}: LiveSessionsInOneFolderAskerKeepsAnswer — 같은 폴더에 두 세션이 살아 있으면 묻던 세션이 답을 받고 계속 쥔다`, async () => {
  await leaseServer()
  const b = await boss()
  const q = await asker({ sessionId: '1a2b3c4d-s1', cwd: '/work/q' })
  const id = await ask(q, b)
  const sibling = await asker({ sessionId: '52abcdef-s2', cwd: '/work/q' })
  assert.equal((await slots()).find(r => r.role === sibling.board.mail().role)?.directory, '/work/q #52abcdef', `${SOT}: 둘째 세션 폴더에 세션 표지가 없음`)
  await b.answerOnPanel(id)
  await expectDelivered(q, id, 1, '같은 폴더에 함께 산 묻던 세션의 답')
  // 임대 한 바퀴를 넘겨도(둘 다 heartbeat) 답은 옮겨지지 않는다.
  const since = Date.now()
  await waitFor(
    async () => (await slots()).filter(r => [q.board.mail().role, sibling.board.mail().role].includes(r.role) && Date.parse(r.lease_expires_at) > since + LEASE_S * 1000).length === 2,
    '두 세션 heartbeat 가 임대 한 바퀴를 넘기지 않음',
    (LEASE_S + 10) * 1000,
  )
  assert.equal(sibling.answerLines(id), 0, `${SOT}: 함께 산 둘째 세션에 답이 들어감`)
  assert.equal(q.answerLines(id), 1, `${SOT}: 묻던 세션의 답 수가 1이 아님`)
})

test(`${SOT}: OtherLabelInSameFolderNeverGetsAnswer — 같은 폴더라도 라벨이 다르면 답이 안 가고, 같은 라벨 세션이 붙을 때 1번`, async () => {
  await leaseServer()
  const b = await boss()
  const q = await asker({ sessionId: '1a2b3c4d-s1', cwd: '/work/q', label: 'issue-1' })
  const id = await ask(q, b)
  q.host.kill()
  const other = await asker({ sessionId: '52abcdef-s2', cwd: '/work/q', label: 'issue-2' })
  await b.answerOnPanel(id)
  await outliveLease(q.board.mail().role, [other.board.mail().role])
  await waitFor(async () => (await delivery(id)) === 'waiting', '죽은 세션 임대가 끝난 뒤 관리자 목록 delivery 가 waiting 이 아님', 10_000)
  assert.equal(other.answerLines(id), 0, `${SOT}: 같은 폴더의 다른 라벨 세션에 답이 들어감`)
  const same = await asker({ sessionId: 'same', cwd: '/work/e', label: 'issue-1' })
  await expectDelivered(same, id, 1, '같은 라벨 세션에 넘긴 답')
  assert.equal(other.answerLines(id), 0, `${SOT}: 같은 폴더의 다른 라벨 세션에 답이 들어감`)
})

test(`${SOT}: BossSkipsQuestionMail — 대장 세션에는 질문 참조 메일([질문]·[질문 답])이 턴으로 들어가지 않는다`, async () => {
  const b = await boss()
  const a = await asker()
  const id = await ask(a, b)
  await b.answerOnPanel(id)
  await expectDelivered(a, id, 1, '패널 답')
  // 참조 메일이 대장 메일함에 왔고(지켜보는 역할) 읽음으로만 표시됐다.
  type Mail = { id: number; subject: string; status: string }
  const box = (await server.call('team/boss', 'GET', '/api/messages?limit=100')).json as { messages?: Mail[] } | Mail[] | null
  const mails = (Array.isArray(box) ? box : (box?.messages ?? [])).filter(m => m.subject.includes(id))
  const subjects = mails.map(m => m.subject)
  assert.ok(subjects.some(s => s.startsWith('[질문] ')), `${SOT}: 대장 메일함에 [질문] 참조 메일이 없음: ${JSON.stringify(subjects)}`)
  assert.ok(subjects.some(s => s.startsWith('[질문 답] ')), `${SOT}: 대장 메일함에 [질문 답] 참조 메일이 없음: ${JSON.stringify(subjects)}`)
  await waitFor(async () => {
    const again = (await server.call('team/boss', 'GET', '/api/messages?limit=100')).json as { messages?: Mail[] } | Mail[] | null
    const list = (Array.isArray(again) ? again : (again?.messages ?? [])).filter(m => m.subject.includes(id))

    return list.every(m => m.status !== 'pending')
  }, `대장 세션이 질문 참조 메일을 읽음으로 표시하지 않음`)
  const leaked = b.host.turns.filter(t => t.includes(id))
  assert.equal(leaked.length, 0, `${SOT}: 질문 참조 메일이 대장 세션 턴으로 ${leaked.length}번 들어감: ${JSON.stringify(leaked)}`)
})
