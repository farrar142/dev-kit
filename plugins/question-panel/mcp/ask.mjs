// 질문 패널 stdio MCP 서버의 본체(server.mjs가 표준 입출력에 잇는다). 모델에게 보이는 질문 도구 `ask`는 이것 하나다.
//
// 왜 mod 도구가 아니라 MCP 서버인가: Claude Code는 mod 도구($.tool.register)를 부를 때
// PreToolUse·PostToolUse 설정 훅을 돌리지 않는다. 진짜 MCP 서버의 도구는 돌린다. 그래야
// Orca 같은 바깥 도구가 그 훅(agent.tool.after)으로 질문을 받는다.
//
// 상태는 갖지 않는다. 묶음(q1, q2 …)과 패널은 mod(hooks/register.tsx)가 갖는다. mod의
// tool.call 훅이 이 도구 호출을 감싸 묶음을 쌓고, 모델이 읽을 결과 글을 입력의
// `panel_result`에 넣어 넘긴다. 서버는 그 글을 그대로 돌려줄 뿐이다. 그래서 PostToolUse의
// tool_response에 「질문 묶음 qN」이 들어간다.
//
// mod가 없는 세션(훅 모듈이 꺼졌거나 불러오지 못한 경우)에는 panel_result가 없다. 그때는
// 묶음 없이 질문을 대화창 블록으로 돌려준다.
//
// Orca 채팅 세션(0.6.1): stream-json 채팅에는 Orca의 agent.tool.after 훅이 오지 않는다(Orca가 채팅
// 자식 환경에서 훅 변수를 지운다). 그래서 이 서버가 질문을 집 폴더 `.question-panel/orca-inbox`에
// 세션 정보와 함께 남기고, Orca 질문 패널 플러그인(0.4.0+)이 읽어 카드로 띄운 뒤 답을 이 세션의
// 오케스트레이션 메일함으로 보낸다. 이 서버는 Claude Code가 띄우므로 그 세션의 환경변수
// (ORCA_AGENT_SESSION_ID 등)를 그대로 읽는다(mod 훅 환경에는 process가 없어 못 읽는다).
// 이 파일은 Node 모듈을 import 하지 않는다(mod 시험이 이 파일을 가져다 쓰는데, hooks 모듈은 node:
// 모듈을 못 불러온다). 환경·파일·CLI는 ctx 로 받고, 진짜 ctx 는 orca.mjs 가 만들어 server.mjs 가 넘긴다.

export const ASK = {
  name: 'ask',
  description:
    '사용자에게 객관식 질문을 한다. AskUserQuestion과 같은 모양이지만 기다리지 않는다. 질문은 오른쪽 「질문」 패널에 쌓이고, 도구 결과로 같은 질문을 담은 마크다운 블록이 돌아온다. 그 블록을 답변 글에 그대로 옮겨 적고 턴을 마쳐라(사용자가 Remote Control·폰으로 보면 패널이 보이지 않는다). 답은 패널의 완료(「[질문 패널 답] 질문 = 고른 것」 메시지)나 대화창의 글(「q4 1-2」처럼 묶음 ID와 번호)로 온다. Orca 채팅 세션이면 Orca 사이드바 질문 패널의 답이 제목 「[질문 패널 답] q4」 오케스트레이션 메일로 온다(본문 「q4 1-2 / [질문 패널 답] 질문 = 고른 것」). 선택지를 비교하려면 option의 preview에 코드·ASCII 목업·설정 예시를 마크다운으로 넣는다(AskUserQuestion의 preview와 같다).',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '질문 글' },
            header: { type: 'string', maxLength: 12, description: '12자 이내 짧은 칩 제목' },
            multiSelect: { type: 'boolean', description: '여러 개 고를 수 있으면 true' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                  preview: {
                    type: 'string',
                    description:
                      '선택. 이 선택지를 고르면 어떻게 되는지 보여 줄 마크다운(코드·ASCII 목업·설정 예시). 패널에서 고르거나 「미리보기」를 누르면 펼쳐지고, 대화창 블록에는 코드 블록으로 들어간다.',
                  },
                },
                required: ['label', 'description'],
              },
            },
          },
          required: ['question', 'header', 'options', 'multiSelect'],
        },
      },
    },
    required: ['questions'],
  },
}

const str = v => (typeof v === 'string' ? v : '')

// mod가 없을 때의 대화창 블록. 묶음 ID가 없으니 번호로만 답하게 한다.
const plainBlock = questions => {
  const lines = ['**[질문]** 질문 패널 mod가 이 세션에 없어 패널에 올리지 못했습니다. 이 대화창에 글로 답해 주세요.']
  questions.forEach((q, qi) => {
    const head = str(q?.header) === '' ? '' : `〔${str(q.header)}〕 `
    const how = q?.multiSelect === true ? '여러 개 선택 가능' : '하나만 선택'
    lines.push('', `**${qi + 1}. ${head}${str(q?.question)}** (${how})`)
    const options = Array.isArray(q?.options) ? q.options : []
    options.forEach((o, oi) => {
      const d = str(o?.description)
      lines.push(`- ${oi + 1}) ${str(o?.label)}${d === '' ? '' : ` — ${d}`}`)
    })
  })
  lines.push('', '번호로 답해도 됩니다: `1-2, 2-1`(질문 번호-선택지 번호).')

  return lines.join('\n')
}

// ── Orca 채팅 세션 → Orca 질문 패널 ──────────────────────────────────────────

/** Orca 질문 패널 플러그인(orca-plugins/question-panel)과 같은 폴더·모양이다. */
export const ORCA_INBOX_PARTS = ['.question-panel', 'orca-inbox']
export const ORCA_INBOX_VERSION = 1
export const ORCA_NOTE =
  'Orca 사이드바 「질문」 패널로도 답할 수 있습니다(패널에서 고른 답은 「[질문 패널 답] 묶음 ID」 오케스트레이션 메일로 옵니다).'

/** Orca 채팅 세션(stream-json)이면 세션 정보, 아니면 null. 터미널 세션은 Orca 훅이 질문을 가져간다. */
export const orcaChat = env => {
  const sessionId = str(env?.ORCA_AGENT_SESSION_ID).trim()
  if (str(env?.ORCA_STRUCTURED_SESSION) === '' || sessionId === '') return null

  return {
    sessionId,
    cli: str(env.ORCA_CLI_COMMAND).trim() || null,
    userData: str(env.ORCA_USER_DATA_PATH).trim() || null,
  }
}

/** mod가 만든 결과 글의 「질문 묶음 q3」. */
export const batchIdOf = text => text.match(/질문 묶음 (q\d+)/)?.[1] ?? null

/** `orca orchestration run-current --json` 의 Run id(없거나 못 읽으면 null). */
export const parseRunId = stdout => {
  try {
    const id = JSON.parse(stdout)?.result?.run?.id

    return typeof id === 'string' && /^run_[A-Za-z0-9_-]+$/.test(id) ? id : null
  } catch {
    return null
  }
}

/** 질문 파일 하나(Orca 질문 패널 batchFromInbox 가 읽는 모양). */
export const inboxEntry = ({ id, questions, chat, runId, cwd, now }) => ({
  v: ORCA_INBOX_VERSION,
  id,
  createdAt: now,
  questions,
  session: { id: chat.sessionId, runId },
  orcaCli: chat.cli,
  userData: chat.userData,
  cwd,
})

/** 채팅 세션이면 질문을 Orca 질문 패널 폴더에 남긴다. 남겼으면 true. 실패는 stderr 에 남기고 false. */
export const toOrca = (questions, text, ctx) => {
  const chat = orcaChat(ctx.env)
  const id = batchIdOf(text)
  if (chat === null || id === null || !Array.isArray(questions) || questions.length === 0) return false
  try {
    const runId = ctx.runCurrent(chat)
    const name = `${id}-${chat.sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`
    const entry = inboxEntry({ id, questions, chat, runId, cwd: ctx.cwd, now: ctx.now })
    ctx.write(ctx.inboxDir, name, JSON.stringify(entry))

    return true
  } catch (err) {
    ctx.warn?.(`Orca 질문 패널 폴더에 남기지 못함: ${err instanceof Error ? err.message : String(err)}`)

    return false
  }
}

// tools/call 하나에 대한 MCP 결과. ctx(orca.mjs 의 orcaCtx)가 있으면 Orca 채팅 세션 질문을 폴더에 남긴다.
export const callAsk = (args, ctx) => {
  const prepared = args?.panel_result
  if (typeof prepared === 'string' && prepared !== '') {
    const sent = ctx !== undefined && toOrca(args?.questions, prepared, ctx)

    return { content: [{ type: 'text', text: sent ? `${prepared}\n\n${ORCA_NOTE}` : prepared }] }
  }
  const questions = Array.isArray(args?.questions) ? args.questions : []
  if (questions.length === 0) return { isError: true, content: [{ type: 'text', text: 'questions가 비었다.' }] }

  return {
    content: [
      {
        type: 'text',
        text: ['질문 패널 mod가 없어 묶음을 쌓지 못했다. 아래 블록을 답변 글에 그대로 옮겨 적고 턴을 마쳐라. 답은 대화창의 글로 온다.', '', plainBlock(questions)].join('\n'),
      },
    ],
  }
}

// JSON-RPC 요청 하나에 대한 응답(알림이면 undefined).
export const handle = (msg, ctx) => {
  if (msg === null || typeof msg !== 'object' || msg.id === undefined) return undefined
  const ok = result => ({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: str(msg.params?.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'question-panel', version: '0.6.1' },
      })
    case 'tools/list':
      return ok({ tools: [ASK] })
    case 'tools/call':
      if (msg.params?.name !== ASK.name) {
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `없는 도구: ${msg.params?.name}` } }
      }
      return ok(callAsk(msg.params?.arguments, ctx))
    case 'ping':
      return ok({})
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `없는 메서드: ${msg.method}` } }
  }
}
