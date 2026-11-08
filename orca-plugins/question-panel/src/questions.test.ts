// 순수 로직 시험. `orca plugin test` 로 돈다.
import { assert, test } from 'orca/testing'
import {
  addBatch,
  addDismissed,
  answerLine,
  asDismissed,
  cliErrorCode,
  DISMISSED_MAX,
  dismissKey,
  asBatches,
  batchFromTool,
  clearSent,
  complete,
  withDefaults,
  batchFromInbox,
  mailBody,
  mailTarget,
  markSent,
  parseRunCurrent,
  parseSendResult,
  routeLabel,
  whereOf,
  workspaceNameFrom,
  type ToolEvent,
} from './questions.ts'

const EVENT: ToolEvent = {
  tool: 'mcp__plugin_question-panel_qp__ask',
  terminalId: 'term_1',
  workspaceId: 'ws_1',
  input: {
    questions: [
      {
        question: '어느 DB?',
        header: 'DB',
        multiSelect: false,
        options: [{ label: 'Postgres', description: '' }, { label: 'SQLite' }],
      },
      { question: '켤 기능', multiSelect: true, options: [{ label: '캐시' }, { label: '로그' }, { label: '' }] },
    ],
  },
  output: { content: [{ type: 'text', text: '질문 묶음 q3을 패널에 올렸다. …' }] },
}

test('질문 패널 도구 호출에서 묶음을 만들고 결과의 q<N>을 ID로 쓴다', () => {
  const b = batchFromTool(EVENT, 1000, 'o1')
  if (b === null) return assert.fail('묶음이 없다')
  assert.equal(b.id, 'q3')
  assert.equal(b.terminalId, 'term_1')
  assert.equal(b.questions.length, 2)
  assert.deepEqual(
    b.questions[1].options.map(o => o.label),
    ['캐시', '로그'],
    '빈 label 선택지는 버린다',
  )
})

test('결과에 ID가 없으면 fallback ID', () => {
  assert.equal(batchFromTool({ ...EVENT, output: 'ok' }, 1, 'o7')?.id, 'o7')
})

test('다른 도구, 터미널이 없는 호출(채팅 세션 등), 질문이 없는 호출은 무시한다', () => {
  assert.equal(batchFromTool({ ...EVENT, tool: 'Bash' }, 1, 'o1'), null)
  assert.equal(batchFromTool({ ...EVENT, terminalId: undefined }, 1, 'o1'), null)
  assert.equal(batchFromTool({ ...EVENT, input: { questions: [] } }, 1, 'o1'), null)
})

test('답 줄은 한 줄이고 묶음 ID·질문·고른 라벨·번호를 담는다', () => {
  const b = batchFromTool(EVENT, 1, 'o1')!
  assert.equal(complete(b, [[0], []]), false, '여러 개 선택 질문도 하나는 골라야 한다')
  assert.equal(complete(b, [[0, 1], [0]]), false, '하나만 선택 질문에 둘은 안 된다')
  assert.equal(complete(b, [[1], [0, 1]]), true)
  const line = answerLine(b, [[1], [0, 1]])
  assert.equal(line, '[질문 패널 답 q3] 1) 어느 DB? = SQLite [2] / 2) 켤 기능 = 캐시, 로그 [1,2]')
  assert.ok(!/\n/.test(line))
})

test('같은 터미널·ID는 바꾸고, 보낸 것만 지운다', () => {
  const b = batchFromTool(EVENT, 1, 'o1')!
  const other = { ...b, terminalId: 'term_2' }
  let list = addBatch(addBatch(addBatch([], b), other), { ...b, createdAt: 2 })
  assert.equal(list.length, 2)
  list = markSent(list, 'q3', 'term_1', 'x')
  assert.equal(list.find(x => x.terminalId === 'term_1')?.status, 'sent')
  assert.deepEqual(clearSent(list).map(x => x.terminalId), ['term_2'])
})

test('저장소 값이 틀린 모양이면 버린다', () => {
  assert.deepEqual(asBatches(null), [])
  assert.deepEqual(asBatches([{ id: 1 }, 'x']), [])
})

test('Claude Code PostToolUse의 MCP 결과(content 블록 배열)에서도 묶음 ID를 읽는다', () => {
  const b = batchFromTool({ ...EVENT, output: [{ type: 'text', text: '질문 묶음 q12을 패널에 올렸다.' }] }, 1000, 'o1')
  assert.equal(b?.id, 'q12')
})

test('workspace 이름을 모르면 workspace id의 마지막 경로 이름을 쓴다(Windows 경로 포함)', () => {
  assert.equal(workspaceNameFrom('d3076cdb::C:/Users/me/orca/workspaces/Sandcorp/data'), 'data')
  assert.equal(workspaceNameFrom('r::C:\\Users\\me\\proj\\'), 'proj')
  assert.equal(workspaceNameFrom(null), null)
  const b = batchFromTool(EVENT, 1, 'o1')
  if (b === null) return assert.fail('묶음이 없다')
  assert.equal(whereOf(b), 'ws_1 · term_1')
  assert.equal(whereOf({ ...b, workspaceName: 'Data', terminalTitle: 'claude' }), 'Data · claude')
})

test('채팅 질문 파일: 버전·묶음 ID·세션 id·질문이 맞아야 묶음이 되고, 이상한 Run id 는 버린다', () => {
  const ok = {
    v: 1,
    id: 'q7',
    questions: [{ question: '고를까?', options: [{ label: '예' }, { label: '아니오' }] }],
    session: { id: 'sess_1', runId: 'run_xxxx' },
    orcaCli: 'C:\\Orca\\orca.cmd',
    cwd: 'C:\\work\\app',
  }
  const b = batchFromInbox(ok, 9)
  assert.equal(b?.terminalId, 'orca_session_id:sess_1')
  assert.equal(b?.createdAt, 9)
  assert.deepEqual(b?.route, { kind: 'mailbox', sessionId: 'sess_1', runId: 'run_xxxx', cli: 'C:\\Orca\\orca.cmd', userData: null })
  assert.equal(whereOf(b!), '채팅 · app · 세션 sess_1')
  assert.equal(routeLabel(b!), '메일함 run:run_xxxx')
  assert.equal(batchFromInbox({ ...ok, v: 2 }, 0), null)
  assert.equal(batchFromInbox({ ...ok, id: 'q7; rm' }, 0), null)
  assert.equal(batchFromInbox({ ...ok, session: { id: '-x' } }, 0), null)
  assert.equal(batchFromInbox({ ...ok, questions: [] }, 0), null)
  assert.equal(batchFromInbox({ ...ok, session: { id: 'sess_1', runId: 'run x' } }, 0)?.route?.kind, 'mailbox')
  assert.equal(routeLabel(batchFromInbox({ ...ok, session: { id: 'sess_1', runId: 'run x' } }, 0)!), '메일함 orca_session_id:sess_1')
  assert.equal(mailTarget('s', null), 'orca_session_id:s')
})

test('메일 본문: 질문 하나면 「q7 2」, 줄바꿈 없이 「[질문 패널 답] 질문 = 고른 것」', () => {
  const b = batchFromInbox(
    { v: 1, id: 'q7', questions: [{ question: '고를까?\n정말?', options: [{ label: '예' }, { label: '아니오' }] }], session: { id: 's' } },
    0,
  )!
  assert.equal(mailBody(b, [[1]]), 'q7 2 / [질문 패널 답] 고를까? 정말? = 아니오')
})

test('CLI 답 읽기: run-current 의 Run·없음·못 읽음, send 의 성공·오류·실행 실패', () => {
  assert.equal(parseRunCurrent(JSON.stringify({ ok: true, result: { run: { id: 'run_ab12' } } })), 'run_ab12')
  assert.equal(parseRunCurrent(JSON.stringify({ ok: true, result: { run: null } })), null)
  assert.equal(parseRunCurrent('nope'), undefined)
  assert.deepEqual(parseSendResult({ code: 0, stdout: JSON.stringify({ ok: true, result: { message: { id: 'msg_1' } } }), stderr: '' }), {
    ok: true,
    messageId: 'msg_1',
  })
  assert.deepEqual(
    parseSendResult({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'x', message: 'y' } }), stderr: '' }),
    { ok: false, why: 'x: y', maybeSent: false },
  )
  assert.deepEqual(parseSendResult({ code: null, stdout: '', stderr: '', error: 'ENOENT' }), {
    ok: false,
    why: 'ENOENT',
    maybeSent: false,
  })
  assert.deepEqual(parseSendResult({ code: 2, stdout: '', stderr: 'a\nUnknown command: orchestration' }), {
    ok: false,
    why: 'orca 종료 코드 2 — a Unknown command: orchestration',
    maybeSent: true,
  })
})

// 0.4.1: Windows Orca 1.4.253 의 실제 출력. 메일은 갔는데 0.4.0 은 「보내지 못함」으로 띄웠다.
test('CLI 짧은 결과(1.4.25x 기본): send 의 messageId, run-current 의 runId 를 읽는다', () => {
  const real = '{"ok":true,"result":{"messageId":"msg_6e38a5a1a9b0"}}'
  assert.deepEqual(parseSendResult({ code: 0, stdout: `${real}\n`, stderr: '' }), { ok: true, messageId: 'msg_6e38a5a1a9b0' })
  // 앞에 다른 줄이 끼어도, 종료 코드 0 인데 모르는 모양이어도 성공이다(실패는 코드≠0·ok:false 만).
  assert.deepEqual(parseSendResult({ code: 0, stdout: `note: hi\n${real}`, stderr: '' }), {
    ok: true,
    messageId: 'msg_6e38a5a1a9b0',
  })
  assert.deepEqual(parseSendResult({ code: 0, stdout: 'Sent msg_1', stderr: '' }), { ok: true, messageId: '' })
  assert.deepEqual(parseSendResult({ code: 0, stdout: '{"ok":true,"result":{"relay":{"messageId":"msg_r"}}}', stderr: '' }), {
    ok: true,
    messageId: 'msg_r',
  })
  // 종료 코드 0 이어도 ok:false 면 실패이고, 서버가 거부했으니 보냈을 리 없다.
  assert.deepEqual(parseSendResult({ code: 0, stdout: '{"ok":false,"error":{"code":"c","message":"m"}}', stderr: '' }), {
    ok: false,
    why: 'c: m',
    maybeSent: false,
  })
  // 시간 초과: 돌기는 했으니 보냈을 수 있다.
  assert.deepEqual(parseSendResult({ code: null, stdout: '', stderr: '', error: 'slow', timedOut: true }), {
    ok: false,
    why: 'slow',
    maybeSent: true,
  })
  assert.equal(parseRunCurrent('{"ok":true,"result":{"runId":"run_xxxx","objective":"o"}}'), 'run_xxxx')
  assert.equal(parseRunCurrent('{"ok":true,"result":{"runId":null}}'), null)
  assert.equal(parseRunCurrent('{"ok":true,"result":{"runId":"nope"}}'), undefined)
  assert.equal(parseRunCurrent('{"ok":true,"result":{}}'), undefined)
  assert.equal(cliErrorCode('{"ok":false,"error":{"code":"session_caller_unknown","message":"x"}}'), 'session_caller_unknown')
  assert.equal(cliErrorCode('{"ok":true,"result":{"runId":null}}'), null)
})

test('지운 기록: 키에 만든 시각이 들고, 같은 묶음은 하나만, 오래된 것부터 버린다', () => {
  const b = { ...batchFromTool(EVENT, 7, 'x')!, id: 'q1' }
  assert.equal(dismissKey(b), 'term_1/q1@7')
  const one = addDismissed([], [b], 100)
  const again = addDismissed(one, [b], 200)
  assert.equal(again.length, 1)
  assert.equal(again[0].at, 200)
  const many = addDismissed(
    [],
    Array.from({ length: DISMISSED_MAX + 5 }, (_, i) => ({ ...b, createdAt: i })),
    0,
  )
  assert.equal(many.length, DISMISSED_MAX)
  assert.equal(many[0].batch.createdAt, 5)
  assert.deepEqual(asDismissed(JSON.parse(JSON.stringify(one))), one)
  assert.deepEqual(asDismissed([{ key: 1 }, 'x'] as never), [])
})

test('withDefaults: 하나만 선택은 빈 선택을 첫 항목으로 채우고, 여러 개 선택은 그대로 둔다(0.4.2)', () => {
  const b = {
    id: 'q1',
    terminalId: 't',
    workspaceId: 'w',
    createdAt: 1,
    status: 'pending',
    questions: [
      { question: 'a', header: '', multiSelect: false, options: [{ label: 'x', description: '' }, { label: 'y', description: '' }] },
      { question: 'b', header: '', multiSelect: true, options: [{ label: 'x', description: '' }] },
    ],
  } as const
  const q = b as unknown as Parameters<typeof withDefaults>[0]
  assert.deepEqual(withDefaults(q, []), [[0], []])
  assert.deepEqual(withDefaults(q, [[1], [0]]), [[1], [0]])
  assert.equal(complete(q, withDefaults(q, [])), false)
  assert.equal(complete(q, withDefaults(q, [[], [0]])), true)
})
