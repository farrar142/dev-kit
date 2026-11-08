// node --test plugins/question-panel/mcp
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ASK, callAsk, handle } from './ask.mjs'

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
