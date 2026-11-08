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

export const markSent = (list: readonly Batch[], id: string, terminalId: string, line: string): Batch[] =>
  list.map(b => (b.id === id && b.terminalId === terminalId ? { ...b, status: 'sent', sent: line } : b))

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

/** 카드에 보일 「어디서 물었나」: workspace 이름 · 터미널 제목(모르면 터미널 id). */
export const whereOf = (b: Batch): string => {
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
