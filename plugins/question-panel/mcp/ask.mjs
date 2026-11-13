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
// 묶음 없이 질문을 대화창 블록으로 돌려준다(패널이 없으니 QUESTION_PANEL_ECHO와 무관하게).
//
// Orca 채팅 세션(0.6.1): stream-json 채팅에는 Orca의 agent.tool.after 훅이 오지 않는다(Orca가 채팅
// 자식 환경에서 훅 변수를 지운다). 그래서 이 서버가 질문을 집 폴더 `.question-panel/orca-inbox`에
// 세션 정보와 함께 남기고, Orca 질문 패널 플러그인(0.4.0+)이 읽어 카드로 띄운 뒤 답을 이 세션의
// 오케스트레이션 메일함으로 보낸다. 이 서버는 Claude Code가 띄우므로 그 세션의 환경변수
// (ORCA_AGENT_SESSION_ID 등)를 그대로 읽는다(mod 훅 환경에는 process가 없어 못 읽는다).
//
// 닫힘 장부(0.9.0): 질문 묶음 상태의 정본. 집 폴더 `.question-panel/ledger`에 닫힌 묶음마다 파일
// `<key>.json` 하나를 배타 생성(O_EXCL)으로 만든다. 없으면 대기, 있으면 닫힘. Claude Code 패널(mod)과
// Orca 질문 패널이 둘 다 보내기 전에 이 파일을 먼저 만들어 이긴 쪽만 세션에 답을 보낸다(한 번만 간다).
// mod는 파일을 직접 못 다뤄 내부 도구 `sync`를 $.mcp.call로 부르고, Orca 워커는 같은 폴더를 직접 다룬다.
// 이 파일은 Node 모듈을 import 하지 않는다(mod 시험이 이 파일을 가져다 쓰는데, hooks 모듈은 node:
// 모듈을 못 불러온다). 환경·파일·CLI는 ctx 로 받고, 진짜 ctx 는 orca.mjs 가 만들어 server.mjs 가 넘긴다.

export const ASK = {
  name: 'ask',
  description:
    '사용자에게 객관식 질문을 한다. AskUserQuestion과 같은 모양이지만 기다리지 않는다. 질문은 「질문」 패널(Claude Code 데스크톱 앱·CLI, Orca 사이드바)에 쌓인다. 질문을 대화창에 다시 쓰지 말고 「질문 패널에 올렸습니다(q4)」 정도로 짧게 말하고 턴을 마쳐라. 답은 「[질문 패널 답] 질문 = 고른 것」 메시지나 대화창의 글(「q4 1-2」처럼 묶음 ID와 번호)로 온다. Orca 채팅 세션이면 Orca 사이드바 질문 패널의 답이 제목 「[질문 패널 답] q4」 오케스트레이션 메일로 온다(본문 「q4 1-2 / [질문 패널 답] 질문 = 고른 것」). 목록에 없는 답은 패널의 「기타」로 글이 올 수 있다(「q4 기타 / [질문 패널 답] 질문 = 기타: 글」). 선택지를 비교하려면 option의 preview에 코드·ASCII 목업·설정 예시를 마크다운으로 넣는다(AskUserQuestion의 preview와 같다).',
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
                      '선택. 이 선택지를 고르면 어떻게 되는지 보여 줄 마크다운(코드·ASCII 목업·설정 예시). 패널에서 고르거나 「미리보기」를 누르면 펼쳐지고, 대화창 블록(QUESTION_PANEL_ECHO=1일 때)에는 코드 블록으로 들어간다.',
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

// 「대화창에서 답함」으로 닫는 도구(0.6.3). 예전에는 mod 도구(mcp__question-panel__resolve)였는데,
// Claude Code가 mod 도구에는 훅을 돌리지 않아 Orca 질문 패널이 닫힌 줄 몰랐다(닫힌 묶음에 또 답이 갔다).
// MCP 서버 도구라 Orca 터미널 세션은 agent.tool.after 훅으로 보고, 채팅 세션은 이 서버가 폴더에 닫힘을 남긴다.
export const RESOLVE = {
  name: 'resolve',
  description:
    '질문 패널의 대기 중인 묶음을 「대화창에서 답함」으로 닫는다. 사용자가 패널 대신 대화창에 글로 답했는데 그 글에 묶음 ID(q4 등)가 없을 때 그 묶음 ID로 부른다. Claude Code 패널과 Orca 사이드바 질문 패널 둘 다에서 같은 질문에 또 답하는 일을 막는다.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '닫을 묶음 ID(예: q4)' },
    },
    required: ['id'],
  },
}

// 닫힘 장부를 다루는 내부 도구(0.9.0). mod가 $.mcp.call 로만 부른다(모델이 부르면 mod가 막는다).
export const SYNC = {
  name: 'sync',
  description: '질문 패널 mod 내부용(닫힘 장부 읽기·쓰기). 모델은 부르지 않는다.',
  inputSchema: {
    type: 'object',
    properties: {
      close: { type: 'object', description: '닫을 묶음 { key, state: answered|dismissed, by: claude|chat }' },
      keys: { type: 'array', items: { type: 'string' }, description: '닫혔는지 볼 묶음 key들' },
    },
  },
}

const str = v => (typeof v === 'string' ? v : '')

/**
 * 옛 동작(질문 블록을 대화창에 옮겨 적게 하는 결과)을 켰는가(0.7.0). 기본은 끔: 데스크톱 앱·CLI·Orca 모두
 * 질문 패널을 그린다. Remote Control·폰처럼 패널이 정말 안 보이는 화면에서만 QUESTION_PANEL_ECHO=1로 켠다.
 */
export const echoOn = env => /^(1|true|on|yes)$/i.test(str(env?.QUESTION_PANEL_ECHO).trim())
const BATCH_ID = /^q\d{1,6}$/
/** 묶음 ID 목록(소문자, 모양이 맞는 것만, 중복 없음). */
const batchIds = v => [...new Set((Array.isArray(v) ? v : [v]).map(x => str(x).trim().toLowerCase()).filter(x => BATCH_ID.test(x)))]

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
  'Orca 사이드바 「질문」 패널로도 답할 수 있습니다(패널에서 고른 답은 「[질문 패널 답] 묶음 ID」 오케스트레이션 메일로 옵니다). 목록에 없는 답은 패널의 「기타」로 글을 써서 보낼 수 있습니다.'

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

/**
 * `orca orchestration run-current --json` 의 Run id(없거나 못 읽으면 null).
 * 1.4.25x 기본은 짧은 모양 `{ok, result: {runId}}`, `--full`·옛 CLI는 `{ok, result: {run: {id}}}`.
 * 앞에 다른 줄이 끼어도 끝에서부터 JSON 줄을 찾는다.
 */
export const parseRunId = stdout => {
  const tryJson = t => {
    try {
      return JSON.parse(t)
    } catch {
      return null
    }
  }
  const text = String(stdout ?? '')
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('{'))
  const j = tryJson(text.trim()) ?? lines.reverse().map(tryJson).find(v => v !== null) ?? null
  const r = j?.result
  const id = typeof r?.runId === 'string' ? r.runId : r?.run?.id

  return typeof id === 'string' && /^run_[A-Za-z0-9_-]+$/.test(id) ? id : null
}

/** 질문 파일 하나(Orca 질문 패널 batchFromInbox 가 읽는 모양). */
export const inboxEntry = ({ id, questions, chat, runId, cwd, now, key }) => ({
  v: ORCA_INBOX_VERSION,
  id,
  ...(isKey(key) ? { key } : {}),
  createdAt: now,
  questions,
  session: { id: chat.sessionId, runId },
  orcaCli: chat.cli,
  userData: chat.userData,
  cwd,
})

/** 채팅 세션이면 질문을 Orca 질문 패널 폴더에 남긴다. 남겼으면 true. 실패는 stderr 에 남기고 false. */
export const toOrca = (questions, text, ctx, key) => {
  const chat = orcaChat(ctx.env)
  const id = batchIdOf(text)
  if (chat === null || id === null || !Array.isArray(questions) || questions.length === 0) return false
  try {
    const runId = ctx.runCurrent(chat)
    const name = `${id}-${chat.sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`
    const entry = inboxEntry({ id, questions, chat, runId, cwd: ctx.cwd, now: ctx.now, key })
    ctx.write(ctx.inboxDir, name, JSON.stringify(entry))

    return true
  } catch (err) {
    ctx.warn?.(`Orca 질문 패널 폴더에 남기지 못함: ${err instanceof Error ? err.message : String(err)}`)

    return false
  }
}

/** 닫힘 파일 하나(Orca 질문 패널 closeFromInbox 가 읽는 모양, 0.6.3). */
export const closedEntry = ({ ids, chat, now }) => ({
  v: ORCA_INBOX_VERSION,
  kind: 'closed',
  ids,
  session: { id: chat.sessionId },
  at: now,
})

/**
 * 채팅 세션이면 「대화창에서 답함」으로 닫힌 묶음을 Orca 질문 패널 폴더에 남긴다(0.6.3). 남겼으면 true.
 * 채팅 세션에는 Orca 훅이 오지 않아, 이것이 없으면 Orca 카드가 열린 채 남아 또 답이 간다.
 */
export const closedToOrca = (ids, ctx) => {
  const chat = orcaChat(ctx?.env)
  const list = batchIds(ids)
  if (chat === null || list.length === 0) return false
  try {
    const name = `closed-${chat.sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}-${ctx.now}-${list.join('_')}.json`
    ctx.write(ctx.inboxDir, name, JSON.stringify(closedEntry({ ids: list, chat, now: ctx.now })))

    return true
  } catch (err) {
    ctx.warn?.(`Orca 질문 패널 폴더에 닫힘을 남기지 못함: ${err instanceof Error ? err.message : String(err)}`)

    return false
  }
}

// tools/call 하나에 대한 MCP 결과. ctx(orca.mjs 의 orcaCtx)가 있으면 Orca 채팅 세션 질문을 폴더에 남긴다.
export const callAsk = (args, ctx) => {
  const prepared = args?.panel_result
  // mod 가 붙인 panel_closed: 그새 대화창 글로 답해 닫힌 묶음들. Orca 카드도 닫는다.
  if (ctx !== undefined) closedToOrca(args?.panel_closed, ctx)
  if (typeof prepared === 'string' && prepared !== '') {
    const sent = ctx !== undefined && toOrca(args?.questions, prepared, ctx, args?.panel_key)
    // mod가 넘긴 옛 결과(블록을 옮겨 적게 하는 글). QUESTION_PANEL_ECHO=1일 때만 그것을 돌려준다.
    const echo = str(args?.panel_echo)
    const text = echo !== '' && echoOn(ctx?.env) ? echo : prepared

    return { content: [{ type: 'text', text: sent ? `${text}\n\n${ORCA_NOTE}` : text }] }
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

// resolve 호출 하나. 결과 글은 mod 가 panel_result 로 넘긴다(mod 가 자기 패널의 묶음을 닫는다).
export const callResolve = (args, ctx) => {
  const ids = batchIds([args?.id, ...(Array.isArray(args?.panel_closed) ? args.panel_closed : [])])
  const id = batchIds(args?.id)[0]
  const toOrca = ctx !== undefined && closedToOrca(ids, ctx)
  const prepared = args?.panel_result
  if (typeof prepared === 'string' && prepared !== '') return { content: [{ type: 'text', text: prepared }] }
  if (id === undefined) return { isError: true, content: [{ type: 'text', text: `묶음 ID가 아니다: ${str(args?.id)}` }] }

  return {
    content: [
      {
        type: 'text',
        text: `질문 패널 mod가 없어 이 세션의 패널은 고치지 못했다.${toOrca ? ` 묶음 ${id}을 닫으라고 Orca 질문 패널에 알렸다.` : ''}`,
      },
    ],
  }
}

// ── 닫힘 장부(0.9.0) ──────────────────────────────────────────────────────────

/** Orca 질문 패널 플러그인(orca-plugins/question-panel)과 같은 폴더·모양이다. */
export const LEDGER_PARTS = ['.question-panel', 'ledger']
/** 묶음 key: `<세션 ID>~q<N>~<만든 시각 ms>`. mod가 질문 때 만든다. 파일 이름으로 그대로 쓴다. */
const KEY = /^[A-Za-z0-9_-]{1,80}~q\d{1,6}~\d{1,16}$/
export const isKey = k => typeof k === 'string' && KEY.test(k)
const STATES = new Set(['answered', 'dismissed'])
const BYS = new Set(['claude', 'orca', 'chat'])
export const ledgerName = key => `${key}.json`

/** 장부 기록 하나. state: 답함·답 없이 닫음, by: 어디서(claude = Claude Code 패널, orca = Orca 패널, chat = 대화창 글). */
export const ledgerRecord = ({ key, state, by, now }) => ({ v: 1, key, id: key.split('~')[1], state, by, at: now })

/** 장부 파일 글 → 기록(모양이 틀리거나 key가 다르면 null). */
export const parseRecord = (text, key) => {
  let j = null
  try {
    j = JSON.parse(str(text))
  } catch {
    return null
  }
  if (j === null || typeof j !== 'object' || j.v !== 1 || j.key !== key) return null
  if (!STATES.has(j.state) || !BYS.has(j.by) || typeof j.at !== 'number') return null

  return { v: 1, key, id: key.split('~')[1], state: j.state, by: j.by, at: j.at }
}

/**
 * sync: close 가 있으면 그 묶음의 닫힘을 배타 생성으로 차지해 본다(claimed: 이겼나, 졌으면 holder: 먼저 닫은 기록).
 * keys 가 있으면 그중 닫힌 것의 기록을 closed 에 담는다. 결과는 JSON 글 한 칸.
 */
export const callSync = (args, ctx) => {
  if (ctx?.claim === undefined || ctx.readText === undefined) {
    return { isError: true, content: [{ type: 'text', text: '닫힘 장부를 쓸 수 없다.' }] }
  }
  const out = { closed: {} }
  const c = args?.close
  try {
    if (c !== undefined && c !== null) {
      if (!isKey(c.key) || !STATES.has(c.state) || !BYS.has(c.by)) {
        return { isError: true, content: [{ type: 'text', text: 'close 모양이 틀렸다.' }] }
      }
      const rec = ledgerRecord({ key: c.key, state: c.state, by: c.by, now: ctx.now })
      out.claimed = ctx.claim(ctx.ledgerDir, ledgerName(c.key), JSON.stringify(rec))
      if (!out.claimed) out.holder = parseRecord(ctx.readText(ctx.ledgerDir, ledgerName(c.key)), c.key)
    }
    const keys = [...new Set(Array.isArray(args?.keys) ? args.keys.filter(isKey) : [])].slice(0, 200)
    for (const key of keys) {
      const rec = parseRecord(ctx.readText(ctx.ledgerDir, ledgerName(key)), key)
      if (rec !== null) out.closed[key] = rec
    }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `닫힘 장부 오류: ${err instanceof Error ? err.message : String(err)}` }] }
  }

  return { content: [{ type: 'text', text: JSON.stringify(out) }] }
}

const TOOLS = { [ASK.name]: callAsk, [RESOLVE.name]: callResolve, [SYNC.name]: callSync }

// JSON-RPC 요청 하나에 대한 응답(알림이면 undefined).
export const handle = (msg, ctx) => {
  if (msg === null || typeof msg !== 'object' || msg.id === undefined) return undefined
  const ok = result => ({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: str(msg.params?.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'question-panel', version: '0.9.0' },
      })
    case 'tools/list':
      return ok({ tools: [ASK, RESOLVE, SYNC] })
    case 'tools/call': {
      const name = str(msg.params?.name)
      const call = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined
      if (call === undefined) {
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `없는 도구: ${msg.params?.name}` } }
      }
      return ok(call(msg.params?.arguments, ctx))
    }
    case 'ping':
      return ok({})
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `없는 메서드: ${msg.method}` } }
  }
}
