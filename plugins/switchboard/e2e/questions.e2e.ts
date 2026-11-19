// 질문 경로 e2e(#157): 실제 switchboard 서버 + 플러그인 코어. 경우마다 묻는 세션에 「[질문 패널 답 q_…]」가 정확히 몇 번 들어오는지 센다.
// 서버 쪽 짝: switchboard 저장소 internal/server/questions_sot_test.go(같은 경우 이름, 같은 실패 머리 「question source of truth: …」).
// 경우 7(좁은 폭 토스트)은 Claude 모드 런타임이 필요해 hooks/register.test.tsx 의 「좁은 터미널(#136)」 시험이 맡는다(e2e/ci.sh 가 그 시험이 돌았는지 센다).
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { askerSession, bossSession, QUESTIONS, SOT, sleep, startServer, waitFor } from './harness'
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

const asker = async (where?: { sessionId: string; cwd: string }) => {
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
const expectDelivered = async (s: Session, id: string, want: number, what: string) => {
  if (want > 0) await waitFor(() => s.answerLines(id) >= want, `${what}이 묻는 세션에 들어오지 않음`)
  await sleep(SETTLE_MS)
  const n = s.answerLines(id)
  assert.equal(n, want, `${SOT}: ${what}이 묻는 세션(${s.role})에 ${n}번 들어감(${want}번이어야 함)`)
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

test(
  `${SOT}: AskerSessionRestarts — 옛 세션이 번호를 쥔 채 재시작해 다른 번호를 받아도 답이 새 세션에 1번`,
  { skip: 'sandcorporation/switchboard#169: 답 메일이 묻던 번호 메일함으로만 가서 다른 번호의 새 세션에 닿지 않는다(서버 수정 릴리스 뒤 잇는다)' },
  async () => {
    const b = await boss()
    const a1 = await asker({ sessionId: 'asker-1', cwd: '/work/asker' })
    const id = await ask(a1, b)
    // 세션이 정상 종료 없이 죽는다: 번호를 쥔 채로 남아, 같은 폴더의 새 세션은 다음 번호를 받는다.
    a1.host.kill()
    const a2 = await asker({ sessionId: 'asker-2', cwd: '/work/asker' })
    assert.notEqual(a2.board.mail().role, a1.board.mail().role, '이 경우는 다른 번호여야 한다')
    await b.answerOnPanel(id)
    await expectDelivered(a2, id, 1, '다른 번호로 재시작한 뒤 패널 답')
  },
)

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
