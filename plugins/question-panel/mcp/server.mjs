// 질문 패널 stdio MCP 서버: 한 줄에 JSON-RPC 메시지 하나(MCP stdio 전송). 본체는 ask.mjs.
import { createInterface } from 'node:readline'

import { handle } from './ask.mjs'
import { orcaCtx } from './orca.mjs'

createInterface({ input: process.stdin }).on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const reply = handle(msg, orcaCtx())
  if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`)
})
