// node --test plugins/question-panel/mcp
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ASK, callAsk, handle, ORCA_NOTE, orcaChat, parseRunId } from './ask.mjs'

const Q = [
  { question: '어느 DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: '관계형' }, { label: 'SQLite', description: '' }] },
]

test('mod가 준 panel_result를 그대로 돌려준다', () => {
  assert.deepEqual(callAsk({ questions: Q, panel_result: '질문 묶음 q3을 패널에 올렸다.' }), {
    content: [{ type: 'text', text: '질문 묶음 q3을 패널에 올렸다.' }],
  })
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

test('tools/list는 ask 하나만 낸다, 모르는 도구·메서드는 오류, 알림에는 답하지 않는다', () => {
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools.map(t => t.name), ['ask'])
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
