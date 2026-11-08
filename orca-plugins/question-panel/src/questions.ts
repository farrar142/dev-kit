// 질문 묶음의 모양과 순수 로직. 워커·패널·시험이 같이 쓴다(Orca API를 부르지 않는다).
//
// 흐름: Claude가 질문 도구(ASK_TOOL)를 부른다 → Orca의 agent.tool.after 훅이 입력(질문)과
// 결과(묶음 ID)를 받는다 → batchFromTool 로 묶음을 만들어 저장한다 → 패널이 카드로 그린다 →
// 사용자가 고르면 answerLine 한 줄을 그 터미널에 넣고 Enter → Claude Code에 사용자 메시지로 들어간다.

// Claude Code question-panel 0.6.0부터 질문 도구는 그 플러그인의 stdio MCP 서버(qp)가 낸다.
// 예전 mod 도구(mcp__question-panel__ask)는 Claude Code가 PostToolUse 훅을 돌리지 않아 여기 닿지 않았다.
export const ASK_TOOL = 'mcp__plugin_question-panel_qp__ask'
export const STORE_KEY = 'batches'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type Option = { label: string; description: string }
export type Question = { question: string; header: string; multiSelect: boolean; options: Option[] }

/**
 * 답을 넣는 길(0.4.0부터). 없으면 터미널(0.3.x 묶음).
 * - terminal: 질문 훅이 준 터미널에 terminal.sendText.
 * - mailbox: Orca 채팅 세션(stream-json). 넣을 터미널이 없어 그 세션의 오케스트레이션 메일함으로
 *   `orca orchestration send` 한다. Run에 묶였으면 run:<id>, 아니면 orca_session_id:<id>.
 */
export type Route =
  | { kind: 'terminal' }
  | {
      kind: 'mailbox'
      /** 질문한 채팅 세션의 ORCA_AGENT_SESSION_ID. 보낼 때 이 신원으로 CLI를 돌린다. */
      sessionId: string
      /** 질문할 때 묶여 있던 Run(`orca orchestration run-current`). 보낼 때 다시 확인한다. */
      runId: string | null
      /** 그 세션이 쓰던 Orca CLI 실행 파일(ORCA_CLI_COMMAND). 없으면 PATH의 orca. */
      cli: string | null
      /** 그 세션의 ORCA_USER_DATA_PATH(CLI가 같은 Orca를 찾게). */
      userData: string | null
    }

export type Batch = {
  /** 묶음 ID. Claude Code 쪽 question-panel이 붙인 q<N>을 그대로 쓴다(그쪽 큐도 같이 닫히게). */
  id: string
  terminalId: string
  workspaceId: string | null
  createdAt: number
  questions: Question[]
  status: 'pending' | 'sent'
  /** 보낸 답 줄(보낸 뒤 기록용). */
  sent?: string
  /** 질문한 터미널의 제목(포커스된 workspace에서 보였을 때만 안다, 0.3.2부터). */
  terminalTitle?: string
  /** 질문한 workspace의 이름(workspace.list, 0.3.2부터). */
  workspaceName?: string
  /** 질문한 터미널이 닫혔다(terminal.read 가 terminal_handle_stale, 0.3.2부터). 보내기를 막는다. */
  closed?: boolean
  /** 답을 넣는 길(0.4.0부터). 없으면 터미널. */
  route?: Route
  /** 채팅 세션이 질문한 폴더(카드에 이름만 보인다). */
  cwd?: string
  /** 마지막 보내기 실패 이유(카드에 남는다). 보내면 지운다. */
  error?: string
  /** 보낸 곳(「터미널」·「메일함 run:…」) — 보낸 기록에 보인다. */
  via?: string
}

/** agent.tool.after 훅 이벤트에서 쓰는 부분. */
export type ToolEvent = {
  tool: string
  terminalId?: string
  workspaceId: string | null
  input: JsonValue
  output?: JsonValue
  callId?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

const normalize = (raw: unknown): Question[] => {
  if (!Array.isArray(raw)) return []

  return raw.flatMap(q => {
    if (!isRecord(q)) return []
    const question = str(q.question)
    const options = (Array.isArray(q.options) ? q.options : []).flatMap(o =>
      isRecord(o) && str(o.label) !== '' ? [{ label: str(o.label), description: str(o.description) }] : [],
    )
    if (question === '' || options.length === 0) return []

    return [{ question, header: str(q.header), multiSelect: q.multiSelect === true, options }]
  })
}

/** 도구 결과 안의 「질문 묶음 q<N>」에서 ID를 찾는다. 결과 모양(문자열·content 배열)에 기대지 않는다. */
export const batchIdFrom = (output: JsonValue | undefined): string | null => {
  if (output === undefined) return null
  const m = JSON.stringify(output).match(/질문 묶음 (q\d+)/)

  return m === null ? null : m[1]
}

/**
 * 질문 패널 도구 호출이면 묶음을 만든다. 터미널을 모르면(답을 넣을 곳이 없으면) null.
 * fallbackId 는 결과에서 ID를 못 찾았을 때 쓴다.
 */
export const batchFromTool = (e: ToolEvent, now: number, fallbackId: string): Batch | null => {
  if (e.tool !== ASK_TOOL || e.terminalId === undefined || e.terminalId === '') return null
  if (!isRecord(e.input)) return null
  const questions = normalize(e.input.questions)
  if (questions.length === 0) return null

  return {
    id: batchIdFrom(e.output) ?? fallbackId,
    terminalId: e.terminalId,
    workspaceId: e.workspaceId,
    createdAt: now,
    questions,
    status: 'pending',
  }
}

/** 같은 터미널의 같은 ID는 새 것으로 바꾸고, 아니면 덧붙인다. */
export const addBatch = (list: readonly Batch[], b: Batch): Batch[] => [
  ...list.filter(x => !(x.id === b.id && x.terminalId === b.terminalId)),
  b,
]

/** 질문마다 고른 선택지 번호(0부터). 빈 배열이면 그 질문은 안 고른 것. */
export type Picks = number[][]

export const complete = (b: Batch, picks: Picks) =>
  b.questions.every((q, i) => {
    const p = picks[i] ?? []

    return q.multiSelect ? p.length > 0 : p.length === 1
  })

/**
 * 터미널에 넣을 한 줄. 줄바꿈은 터미널에서 먼저 제출될 수 있어 쓰지 않는다.
 * 「q3」을 담아 Claude Code 쪽 question-panel의 prompt.submit 이 그 묶음을 닫게 한다.
 */
export const answerLine = (b: Batch, picks: Picks): string => {
  const parts = b.questions.map((q, i) => {
    const labels = (picks[i] ?? []).flatMap(n => (q.options[n] === undefined ? [] : [q.options[n].label]))
    const nums = (picks[i] ?? []).map(n => n + 1).join(',')

    return `${i + 1}) ${q.question} = ${labels.join(', ')} [${nums}]`
  })

  return `[질문 패널 답 ${b.id}] ${parts.join(' / ')}`.replace(/[\r\n]+/g, ' ')
}

/** 보냄으로 표시한다. via 는 보낸 곳(「터미널」·「메일함 run:…」), 남아 있던 실패 이유는 지운다. */
export const markSent = (list: readonly Batch[], id: string, terminalId: string, line: string, via = '터미널'): Batch[] =>
  list.map(b => {
    if (!(b.id === id && b.terminalId === terminalId)) return b
    const { error: _, ...rest } = b

    return { ...rest, status: 'sent', sent: line, via }
  })

export const clearSent = (list: readonly Batch[]): Batch[] => list.filter(b => b.status === 'pending')

/** 저장소에서 읽은 값을 묶음 목록으로(모양이 틀린 것은 버린다). */
export const asBatches = (v: JsonValue | null): Batch[] =>
  Array.isArray(v)
    ? v.flatMap(b =>
        isRecord(b) && typeof b.id === 'string' && typeof b.terminalId === 'string' && Array.isArray(b.questions)
          ? [b as unknown as Batch] // 저장소에는 이 모듈이 쓴 값만 들어간다
          : [],
      )
    : []

/** 카드에 보일 「어디서 물었나」: workspace 이름 · 터미널 제목(모르면 터미널 id). 채팅은 「채팅 · 폴더 이름」. */
export const whereOf = (b: Batch): string => {
  if (b.route?.kind === 'mailbox') {
    const dir = b.cwd === undefined ? null : workspaceNameFrom(b.cwd)

    return ['채팅', dir, `세션 ${b.route.sessionId.slice(0, 8)}`].filter(x => x !== null && x !== '').join(' · ')
  }
  const ws = b.workspaceName ?? workspaceNameFrom(b.workspaceId)

  return [ws, b.terminalTitle ?? b.terminalId].filter(x => x !== null && x !== '').join(' · ')
}

/** workspace.list 에 없을 때 workspace id(「repo::C:/…/data」)의 마지막 경로 이름. */
export const workspaceNameFrom = (workspaceId: string | null): string | null => {
  if (workspaceId === null) return null
  const tail = workspaceId.split('::').pop() ?? ''
  const name = tail.split(/[\\/]/).filter(Boolean).pop()

  return name === undefined || name === '' ? null : name
}

/** 같은 터미널·같은 ID 묶음에 필드를 덧씌운다. */
export const patchBatch = (list: readonly Batch[], id: string, terminalId: string, patch: Partial<Batch>): Batch[] =>
  list.map(b => (b.id === id && b.terminalId === terminalId ? { ...b, ...patch } : b))

/** 묶음 하나를 지운다. */
export const removeBatch = (list: readonly Batch[], id: string, terminalId: string): Batch[] =>
  list.filter(b => !(b.id === id && b.terminalId === terminalId))

/** 터미널이 닫힌 대기 묶음을 모두 지운다. */
export const clearClosed = (list: readonly Batch[]): Batch[] => list.filter(b => b.closed !== true)

// ── 채팅 세션(메일함 경로, 0.4.0) ─────────────────────────────────────────────

/**
 * Claude Code question-panel MCP 서버(0.6.1+)가 채팅 세션의 질문을 남기는 폴더. 집 폴더 아래
 * `.question-panel/orca-inbox`. 파일 하나가 묶음 하나(JSON, INBOX_VERSION). 워커가 읽고 지운다.
 * 채팅 세션에는 agent.tool.after 훅이 오지 않아서다(Orca가 채팅 자식 환경에서 훅 변수를 지운다,
 * structured-session-child-env.ts).
 */
export const INBOX_DIR_PARTS = ['.question-panel', 'orca-inbox'] as const
export const INBOX_VERSION = 1

export const isMailbox = (b: Batch): b is Batch & { route: Extract<Route, { kind: 'mailbox' }> } =>
  b.route?.kind === 'mailbox'

const ID_RE = /^q\d{1,6}$/
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/
const RUN_RE = /^run_[A-Za-z0-9_-]{1,80}$/

const optStr = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** 받은 파일 하나를 묶음으로. 모양이 틀리면 null(워커가 로그를 남기고 버린다). */
export const batchFromInbox = (raw: unknown, now: number): Batch | null => {
  if (!isRecord(raw) || raw.v !== INBOX_VERSION) return null
  const id = str(raw.id)
  const session = isRecord(raw.session) ? raw.session : null
  const sessionId = session === null ? '' : str(session.id)
  if (!ID_RE.test(id) || !SESSION_RE.test(sessionId)) return null
  const questions = normalize(raw.questions)
  if (questions.length === 0) return null
  const runId = optStr(session?.runId)
  const cwd = optStr(raw.cwd)

  return {
    id,
    terminalId: `orca_session_id:${sessionId}`,
    workspaceId: null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    questions,
    status: 'pending',
    route: {
      kind: 'mailbox',
      sessionId,
      runId: runId !== null && RUN_RE.test(runId) ? runId : null,
      cli: optStr(raw.orcaCli),
      userData: optStr(raw.userData),
    },
    ...(cwd === null ? {} : { cwd }),
  }
}

/** 메일 받는 곳: Run에 묶였으면 run:<id>(채팅 세션이 감시하는 메일함), 아니면 그 세션 주소. */
export const mailTarget = (sessionId: string, runId: string | null) =>
  runId === null ? `orca_session_id:${sessionId}` : `run:${runId}`

/** 카드에 보일 전달 경로. */
export const routeLabel = (b: Batch): string =>
  isMailbox(b) ? `메일함 ${mailTarget(b.route.sessionId, b.route.runId)}` : '터미널'

export const mailSubject = (b: Batch) => `[질문 패널 답] ${b.id}`

/**
 * 메일 본문 한 줄: 「q3 1-2, 2-1 / [질문 패널 답] 질문 = 고른 것 / …」.
 * 앞의 「q3 …」은 대화창 글 답(「q4 1-2」)과 같은 모양이라 Claude Code 쪽 question-panel이 묶음을 닫고,
 * 뒤는 패널 완료 메시지(「[질문 패널 답] 질문 = 고른 것」)와 같은 모양이다. Windows의 .cmd 실행 파일이
 * 줄바꿈을 인자로 넘기지 못해 한 줄로 쓴다.
 */
export const mailBody = (b: Batch, picks: Picks): string => {
  const nums =
    b.questions.length === 1
      ? (picks[0] ?? []).map(n => n + 1).join(',')
      : b.questions.flatMap((_, i) => (picks[i] ?? []).map(n => `${i + 1}-${n + 1}`)).join(', ')
  const parts = b.questions.map((q, i) => {
    const labels = (picks[i] ?? []).flatMap(n => (q.options[n] === undefined ? [] : [q.options[n].label]))

    return `[질문 패널 답] ${q.question} = ${labels.join(', ')}`
  })

  return `${b.id} ${nums} / ${parts.join(' / ')}`.replace(/[\r\n]+/g, ' ')
}

/** CLI의 --json 답 한 덩어리. 실패해도 JSON을 찍으므로 stdout 을 먼저 본다. */
const parseJson = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text.trim())

    return isRecord(v) ? v : null
  } catch {
    return null
  }
}

/** `orca orchestration run-current --json` 의 Run id. 묶인 Run이 없으면 null, 읽지 못하면 undefined. */
export const parseRunCurrent = (stdout: string): string | null | undefined => {
  const j = parseJson(stdout)
  if (j === null || j.ok !== true || !isRecord(j.result)) return undefined
  const run = j.result.run
  if (run === null) return null
  const id = isRecord(run) ? str(run.id) : ''

  return RUN_RE.test(id) ? id : undefined
}

export type CliRun = { code: number | null; stdout: string; stderr: string; error?: string }

/** `orca orchestration send --json` 결과: 보낸 메시지 id, 아니면 사람이 읽을 이유. */
export const parseSendResult = (r: CliRun): { ok: true; messageId: string } | { ok: false; why: string } => {
  const j = parseJson(r.stdout)
  if (j !== null && j.ok === true && isRecord(j.result) && isRecord(j.result.message)) {
    return { ok: true, messageId: str(j.result.message.id) }
  }
  if (j !== null && isRecord(j.error)) {
    return { ok: false, why: `${str(j.error.code)}: ${str(j.error.message)}` }
  }
  if (r.error !== undefined) return { ok: false, why: r.error }
  const tail = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).slice(-2).join(' ')

  return { ok: false, why: `orca 종료 코드 ${r.code ?? '없음'}${tail === '' ? '' : ` — ${tail.slice(0, 300)}`}` }
}
