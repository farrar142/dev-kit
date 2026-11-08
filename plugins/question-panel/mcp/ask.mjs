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
export const ASK = {
  name: 'ask',
  description:
    '사용자에게 객관식 질문을 한다. AskUserQuestion과 같은 모양이지만 기다리지 않는다. 질문은 오른쪽 「질문」 패널에 쌓이고, 도구 결과로 같은 질문을 담은 마크다운 블록이 돌아온다. 그 블록을 답변 글에 그대로 옮겨 적고 턴을 마쳐라(사용자가 Remote Control·폰으로 보면 패널이 보이지 않는다). 답은 패널의 완료(「[질문 패널 답] 질문 = 고른 것」 메시지)나 대화창의 글(「q4 1-2」처럼 묶음 ID와 번호)로 온다. 선택지를 비교하려면 option의 preview에 코드·ASCII 목업·설정 예시를 마크다운으로 넣는다(AskUserQuestion의 preview와 같다).',
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

// tools/call 하나에 대한 MCP 결과.
export const callAsk = args => {
  const prepared = args?.panel_result
  if (typeof prepared === 'string' && prepared !== '') return { content: [{ type: 'text', text: prepared }] }
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
export const handle = msg => {
  if (msg === null || typeof msg !== 'object' || msg.id === undefined) return undefined
  const ok = result => ({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: str(msg.params?.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'question-panel', version: '0.6.0' },
      })
    case 'tools/list':
      return ok({ tools: [ASK] })
    case 'tools/call':
      if (msg.params?.name !== ASK.name) {
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `없는 도구: ${msg.params?.name}` } }
      }
      return ok(callAsk(msg.params?.arguments))
    case 'ping':
      return ok({})
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `없는 메서드: ${msg.method}` } }
  }
}
