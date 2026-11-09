// node --test plugins/question-panel/mcp
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ASK, callAsk, callResolve, echoOn, handle, ORCA_NOTE, orcaChat, parseRunId, RESOLVE } from './ask.mjs'

const Q = [
  { question: '어느 DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: '관계형' }, { label: 'SQLite', description: '' }] },
]

test('mod가 준 panel_result를 그대로 돌려준다', () => {
  assert.deepEqual(callAsk({ questions: Q, panel_result: '질문 묶음 q3을 패널에 올렸다.' }), {
    content: [{ type: 'text', text: '질문 묶음 q3을 패널에 올렸다.' }],
  })
})

test('기본은 짧은 panel_result를 돌려주고, QUESTION_PANEL_ECHO=1일 때만 블록을 옮겨 적게 하는 panel_echo를 돌려준다', () => {
  const args = { questions: Q, panel_result: '질문 묶음 q3을 패널에 올렸다. 짧게', panel_echo: '질문 묶음 q3 … 그대로 옮겨 적고' }
  const ctx = env => ({ env, home: '/h', inboxDir: '/h/i', cwd: '/h', now: 1, runCurrent: () => null, write: () => {} })
  assert.equal(callAsk(args).content[0].text, args.panel_result)
  assert.equal(callAsk(args, ctx({})).content[0].text, args.panel_result)
  assert.equal(callAsk(args, ctx({ QUESTION_PANEL_ECHO: '0' })).content[0].text, args.panel_result)
  assert.equal(callAsk(args, ctx({ QUESTION_PANEL_ECHO: '1' })).content[0].text, args.panel_echo)
  // 옛 mod(panel_echo 없음)면 켜도 panel_result
  assert.equal(callAsk({ ...args, panel_echo: undefined }, ctx({ QUESTION_PANEL_ECHO: '1' })).content[0].text, args.panel_result)
  assert.deepEqual(['1', 'true', 'ON', ' yes ', '', '0', 'no', undefined].map(v => echoOn({ QUESTION_PANEL_ECHO: v })), [true, true, true, true, false, false, false, false])
  assert.equal(echoOn(undefined), false)
})

test('도구 설명은 질문을 대화창에 다시 쓰지 말라고 한다', () => {
  assert.match(ASK.description, /대화창에 다시 쓰지 말고/)
  assert.doesNotMatch(ASK.description, /옮겨 적/)
})

test('mod가 없으면(panel_result 없음) 묶음 없이 대화창 블록을 돌려준다', () => {
  const { content, isError } = callAsk({ questions: Q })
  assert.equal(isError, undefined)
  assert.match(content[0].text, /질문 패널 mod가 없어/)
  assert.match(content[0].text, /\*\*1\. 〔DB〕 어느 DB\?\*\* \(하나만 선택\)/)
  assert.match(content[0].text, /- 2\) SQLite\n/)
  assert.doesNotMatch(content[0].text, /질문 묶음 q/)
})

test('질문이 없으면 오류', () => {
  assert.equal(callAsk({}).isError, true)
})

test('tools/list는 ask·resolve를 낸다, 모르는 도구·메서드는 오류, 알림에는 답하지 않는다', () => {
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools.map(t => t.name), ['ask', 'resolve'])
  assert.equal(RESOLVE.inputSchema.properties.panel_result, undefined)
  assert.equal(handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'toString' } }).error.code, -32602)
  assert.equal(ASK.inputSchema.properties.panel_result, undefined)
  assert.equal(handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } }).error.code, -32602)
  assert.equal(handle({ jsonrpc: '2.0', id: 3, method: 'nope' }).error.code, -32601)
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined)
})

test('server.mjs는 stdio로 initialize·tools/call에 한 줄씩 답한다', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))])
  const lines = []
  child.stdout.setEncoding('utf8').on('data', d => lines.push(...d.split('\n').filter(Boolean)))
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask', arguments: { questions: Q, panel_result: 'X q1' } } })}\n`)
  child.stdin.end()
  await once(child, 'close')
  const replies = lines.map(l => JSON.parse(l))
  assert.deepEqual(replies.map(r => r.id), [1, 2])
  assert.equal(replies[0].result.protocolVersion, '2025-06-18')
  assert.equal(replies[1].result.content[0].text, 'X q1')
})

const fakeCtx = (env, runId = 'run_xxxx') => {
  const writes = []
  const warns = []

  return {
    writes,
    warns,
    ctx: {
      env,
      inboxDir: '/home/me/.question-panel/orca-inbox',
      cwd: '/home/me/app',
      now: 7,
      runCurrent: () => runId,
      write: (dir, name, text) => writes.push({ dir, name, entry: JSON.parse(text) }),
      warn: m => warns.push(m),
    },
  }
}

const CHAT_ENV = {
  ORCA_STRUCTURED_SESSION: '1',
  ORCA_AGENT_SESSION_ID: 'sess_1',
  ORCA_CLI_COMMAND: '/opt/orca/bin/orca',
  ORCA_USER_DATA_PATH: '/home/me/.config/orca',
}

test('Orca 채팅 세션이면 질문을 Orca 질문 패널 폴더에 세션 정보와 남기고, 블록 끝에 패널 안내를 붙인다', () => {
  const f = fakeCtx(CHAT_ENV)
  const { content } = callAsk({ questions: Q, panel_result: '질문 묶음 q3을 쌓았다.\n\n**[질문 묶음 q3]** …' }, f.ctx)
  assert.equal(content[0].text, `질문 묶음 q3을 쌓았다.\n\n**[질문 묶음 q3]** …\n\n${ORCA_NOTE}`)
  assert.deepEqual(f.writes, [
    {
      dir: '/home/me/.question-panel/orca-inbox',
      name: 'q3-sess_1.json',
      entry: {
        v: 1,
        id: 'q3',
        createdAt: 7,
        questions: Q,
        session: { id: 'sess_1', runId: 'run_xxxx' },
        orcaCli: '/opt/orca/bin/orca',
        userData: '/home/me/.config/orca',
        cwd: '/home/me/app',
      },
    },
  ])
})

test('터미널 세션·mod 없는 세션은 남기지 않고, 쓰기 실패는 경고만 하고 블록은 그대로 돌려준다', () => {
  const term = fakeCtx({ ORCA_AGENT_SESSION_ID: 'sess_1' })
  assert.equal(callAsk({ questions: Q, panel_result: '질문 묶음 q3' }, term.ctx).content[0].text, '질문 묶음 q3')
  assert.equal(term.writes.length, 0)
  const noMod = fakeCtx(CHAT_ENV)
  assert.match(callAsk({ questions: Q }, noMod.ctx).content[0].text, /질문 패널 mod가 없어/)
  assert.equal(noMod.writes.length, 0)
  const broken = fakeCtx(CHAT_ENV)
  broken.ctx.write = () => {
    throw new Error('EACCES')
  }
  assert.equal(callAsk({ questions: Q, panel_result: '질문 묶음 q3' }, broken.ctx).content[0].text, '질문 묶음 q3')
  assert.deepEqual(broken.warns, ['Orca 질문 패널 폴더에 남기지 못함: EACCES'])
})

test('채팅 세션 판정과 run-current 읽기', () => {
  assert.equal(orcaChat({ ORCA_STRUCTURED_SESSION: '1' }), null)
  assert.equal(orcaChat({ ORCA_AGENT_SESSION_ID: 's' }), null)
  assert.deepEqual(orcaChat({ ORCA_STRUCTURED_SESSION: '1', ORCA_AGENT_SESSION_ID: ' s ' }), { sessionId: 's', cli: null, userData: null })
  assert.equal(parseRunId(JSON.stringify({ ok: true, result: { run: { id: 'run_ab' } } })), 'run_ab')
  assert.equal(parseRunId(JSON.stringify({ ok: true, result: { run: null } })), null)
  assert.equal(parseRunId('garbage'), null)
  // 1.4.25x 기본(짧은 모양): {ok, result: {runId}}
  assert.equal(parseRunId('{"ok":true,"result":{"runId":"run_xxxx","objective":"o"}}\n'), 'run_xxxx')
  assert.equal(parseRunId('{"ok":true,"result":{"runId":null}}'), null)
  assert.equal(parseRunId('warn: x\n{"ok":true,"result":{"runId":"run_ab"}}'), 'run_ab')
})

test('server.mjs: Orca 채팅 세션 환경이면 집 폴더에 질문 파일을 남기고(orca 를 못 띄우면 Run 없이) 안내를 붙인다', async () => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'qp-home-'))
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ORCA_STRUCTURED_SESSION: '1',
        ORCA_AGENT_SESSION_ID: 'sess_t',
        ORCA_CLI_COMMAND: join(home, 'no-such-orca'),
      },
    })
    const lines = []
    child.stdout.setEncoding('utf8').on('data', d => lines.push(...d.split('\n').filter(Boolean)))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { questions: Q, panel_result: '질문 묶음 q2' } } })}\n`)
    child.stdin.end()
    await once(child, 'close')
    assert.equal(JSON.parse(lines[0]).result.content[0].text, `질문 묶음 q2\n\n${ORCA_NOTE}`)
    const dir = join(home, '.question-panel', 'orca-inbox')
    assert.deepEqual(readdirSync(dir), ['q2-sess_t.json'])
    const entry = JSON.parse(readFileSync(join(dir, 'q2-sess_t.json'), 'utf8'))
    assert.deepEqual(entry.session, { id: 'sess_t', runId: null })
    assert.equal(entry.orcaCli, join(home, 'no-such-orca'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// 0.6.3: resolve 가 mod 도구였을 때는 Orca 질문 패널(채팅 세션은 폴더 경로)에 닫힘이 닿지 않았다.
test('resolve: 채팅 세션이면 닫힌 묶음(id·panel_closed)을 Orca 질문 패널 폴더에 남기고 mod 글을 돌려준다', () => {
  const f = fakeCtx(CHAT_ENV)
  const r = callResolve({ id: 'Q3', panel_result: '묶음 q3을 「대화창에서 답함」으로 닫았다.', panel_closed: ['q1', 'q3', 'bad'] }, f.ctx)
  assert.equal(r.content[0].text, '묶음 q3을 「대화창에서 답함」으로 닫았다.')
  assert.deepEqual(f.writes, [
    {
      dir: '/home/me/.question-panel/orca-inbox',
      name: 'closed-sess_1-7-q3_q1.json',
      entry: { v: 1, kind: 'closed', ids: ['q3', 'q1'], session: { id: 'sess_1' }, at: 7 },
    },
  ])
  // 터미널 세션은 Orca 훅이 resolve 호출을 보므로 남기지 않는다.
  const term = fakeCtx({ ORCA_AGENT_SESSION_ID: 'sess_1' })
  callResolve({ id: 'q3', panel_result: 'x' }, term.ctx)
  assert.deepEqual(term.writes, [])
  // mod 가 없으면 서버 글, ID가 틀리면 오류.
  const noMod = fakeCtx(CHAT_ENV)
  assert.match(callResolve({ id: 'q3' }, noMod.ctx).content[0].text, /Orca 질문 패널에 알렸다/)
  assert.equal(callResolve({ id: 'nope' }).isError, true)
})

test('ask: mod 가 붙인 panel_closed 도 채팅 세션이면 닫힘 파일로 남기고, 안내에 「기타」를 적는다', () => {
  const f = fakeCtx(CHAT_ENV)
  callAsk({ questions: Q, panel_result: '질문 묶음 q4를 쌓았다.', panel_closed: ['q3'] }, f.ctx)
  assert.deepEqual(
    f.writes.map(w => w.name),
    ['closed-sess_1-7-q3.json', 'q4-sess_1.json'],
  )
  assert.match(ORCA_NOTE, /「기타」/)
  assert.match(ASK.description, /기타: 글/)
  const empty = fakeCtx(CHAT_ENV)
  callAsk({ questions: Q, panel_result: '질문 묶음 q4를 쌓았다.', panel_closed: [] }, empty.ctx)
  assert.deepEqual(empty.writes.map(w => w.name), ['q4-sess_1.json'])
})
