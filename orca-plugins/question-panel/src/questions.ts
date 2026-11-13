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
  /**
   * 앞선 보내기가 실패로 끝났지만 실제로는 갔을 수 있다(CLI가 돌았고 서버가 거부하지 않았다, 0.4.1).
   * 카드에 「이미 보냈을 수 있음」을 보인다. 보내면 지운다.
   */
  maybeSent?: boolean
  /**
   * 닫힘 장부 key `<Claude 세션 ID>~q<N>~<만든 시각>`(question-panel 0.9.0+가 질문에 붙인다, 0.5.0부터).
   * 있으면 보내기 전에 장부를 차지하고, 장부에서 다른 곳의 닫힘을 읽어 카드를 닫는다. 없으면(옛 mod) 예전대로.
   */
  key?: string
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
    ...(isKey(e.input.panel_key) ? { key: e.input.panel_key } : {}),
  }
}

/** 같은 터미널의 같은 ID는 새 것으로 바꾸고, 아니면 덧붙인다. */
export const addBatch = (list: readonly Batch[], b: Batch): Batch[] => [
  ...list.filter(x => !(x.id === b.id && x.terminalId === b.terminalId)),
  b,
]

/**
 * 질문마다 고른 선택지 번호(0부터). 빈 배열이면 그 질문은 안 고른 것.
 * OTHER(-1)는 「기타 — 직접 입력」을 고른 것이다(0.4.4). 그 글은 Texts 의 같은 자리에 있다.
 */
export type Picks = number[][]
/** 질문마다 「기타」 글(0.4.4). 기타를 안 골랐으면 무시한다. */
export type Texts = string[]

/** picks 안에서 「기타」를 뜻하는 번호(0.4.4). */
export const OTHER = -1
export const OTHER_LABEL = '기타'
/** 「기타」 글 길이 상한(글자 수). 넘으면 보내기를 막는다. */
export const OTHER_MAX = 2000

/** 선택지 번호 순, 「기타」는 맨 뒤. */
export const sortPicks = (p: readonly number[]): number[] =>
  [...p].sort((a, b) => (a === OTHER ? Infinity : a) - (b === OTHER ? Infinity : b))

const textAt = (texts: Texts | undefined, i: number) => (texts?.[i] ?? '').trim()

/**
 * 「기타」 글의 문제(없으면 null). 패널은 이 글을 그 질문 아래에 보인다.
 * 기타를 골랐는데 글이 비었거나 OTHER_MAX 를 넘으면 그 질문은 답하지 않은 것으로 본다.
 */
export const otherProblem = (picks: Picks, texts: Texts | undefined, i: number): string | null => {
  if (!(picks[i] ?? []).includes(OTHER)) return null
  const t = textAt(texts, i)
  if (t === '') return '「기타」를 골랐으면 글을 써 주세요.'
  if (t.length > OTHER_MAX) return `「기타」 글은 ${OTHER_MAX}자까지입니다(지금 ${t.length}자).`

  return null
}

/**
 * 화면에 보이는 선택을 그대로 답으로 잡는다(0.4.2). 하나만 선택 질문은 라디오가 처음부터 첫 항목이
 * 선택된 모양이라, 아직 안 눌렀어도 첫 선택지를 고른 것으로 본다. 여러 개 선택은 체크 상태 그대로(기본 없음).
 * 「기타」를 고른 하나만 선택 질문은 [OTHER] 라 그대로 둔다(0.4.4).
 */
export const withDefaults = (b: Batch, picks: Picks): Picks =>
  b.questions.map((q, i) => {
    const p = picks[i] ?? []

    return !q.multiSelect && p.length === 0 && q.options.length > 0 ? [0] : p
  })

export const complete = (b: Batch, picks: Picks, texts?: Texts) =>
  b.questions.every((q, i) => {
    const p = (picks[i] ?? []).filter(n => n === OTHER || q.options[n] !== undefined)
    const count = q.multiSelect ? p.length > 0 : p.length === 1

    return count && otherProblem(picks, texts, i) === null
  })

/** 줄바꿈은 한 줄로(터미널은 줄바꿈에서 먼저 제출하고, Windows .cmd 는 줄바꿈 인자를 못 넘긴다). */
const oneLine = (t: string) => t.replace(/\s*[\r\n]+\s*/g, ' ↵ ')

/** 고른 것의 이름들: 선택지 label, 「기타」는 `기타: <글>`. */
const labelsOf = (q: Question, p: readonly number[], text: string) =>
  sortPicks(p).flatMap(n =>
    n === OTHER ? [`${OTHER_LABEL}: ${oneLine(text)}`] : q.options[n] === undefined ? [] : [q.options[n].label],
  )

/** 고른 번호들: 1부터, 「기타」는 그 이름 그대로. */
const numsOf = (p: readonly number[]) => sortPicks(p).map(n => (n === OTHER ? OTHER_LABEL : String(n + 1)))

/**
 * 터미널에 넣을 한 줄. 줄바꿈은 터미널에서 먼저 제출될 수 있어 쓰지 않는다.
 * 「q3」을 담아 Claude Code 쪽 question-panel의 prompt.submit 이 그 묶음을 닫게 한다.
 * 「기타」는 `= 기타: <글> [기타]`(0.4.4).
 */
export const answerLine = (b: Batch, picks: Picks, texts?: Texts): string => {
  const parts = b.questions.map((q, i) => {
    const p = picks[i] ?? []

    return `${i + 1}) ${q.question} = ${labelsOf(q, p, textAt(texts, i)).join(', ')} [${numsOf(p).join(',')}]`
  })

  return `[질문 패널 답 ${b.id}] ${parts.join(' / ')}`.replace(/[\r\n]+/g, ' ')
}

/** 보냄으로 표시한다. via 는 보낸 곳(「터미널」·「메일함 run:…」), 남아 있던 실패 이유는 지운다. */
export const markSent = (list: readonly Batch[], id: string, terminalId: string, line: string, via = '터미널'): Batch[] =>
  list.map(b => {
    if (!(b.id === id && b.terminalId === terminalId)) return b
    const { error: _, maybeSent: __, ...rest } = b

    return { ...rest, status: 'sent', sent: line, via }
  })

// ── 대화창에서 답해 닫힌 묶음(0.4.4) ──────────────────────────────────────────

/**
 * 「대화창에서 답함」으로 닫는 도구. Claude Code question-panel 0.6.3부터 MCP 서버(qp)가 낸다.
 * 그 전에는 mod 도구(mcp__question-panel__resolve)라 Claude Code가 훅을 돌리지 않아 Orca가 몰랐고,
 * 채팅 세션은 질문 폴더에도 아무것도 남지 않았다. 그래서 닫힌 묶음이 패널에 남아 또 답이 갔다.
 */
export const RESOLVE_TOOL = 'mcp__plugin_question-panel_qp__resolve'
export const CHAT_VIA = '대화창에서 답함'

const BATCH_ID_RE = /^q\d{1,6}$/

/** 묶음 ID 목록만 골라낸다(소문자, 중복 없음). */
const idsFrom = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).flatMap(x => {
    const id = typeof x === 'string' ? x.trim().toLowerCase() : ''

    return BATCH_ID_RE.test(id) ? [id] : []
  })

/**
 * 질문 패널 도구 입력에서 닫을 묶음 ID. resolve 의 `id`, 그리고 mod 가 질문·resolve 호출에 붙이는
 * `panel_closed`(그 세션에서 대화창 글로 답해 닫힌 묶음들).
 */
export const closedIdsOf = (input: JsonValue | undefined): string[] =>
  isRecord(input) ? [...new Set([...idsFrom(input.id ?? []), ...idsFrom(input.panel_closed ?? [])])] : []

/**
 * 그 세션(terminalId)의 대기 묶음 중 ids 에 든 것을 「대화창에서 답함」으로 닫는다. 닫힘 신호보다 뒤에
 * 만든 묶음(같은 q 번호로 다시 물은 것)은 닫지 않는다.
 */
export const closeInChat = (
  list: readonly Batch[],
  terminalId: string,
  ids: readonly string[],
  at: number,
): { list: Batch[]; closed: string[] } => {
  const want = new Set(ids)
  const closed: string[] = []
  const next = list.map(b => {
    if (!(b.terminalId === terminalId && b.status === 'pending' && want.has(b.id) && b.createdAt <= at)) return b
    closed.push(b.id)
    const { error: _, maybeSent: __, ...rest } = b

    return { ...rest, status: 'sent' as const, sent: `${b.id} ${CHAT_VIA}`, via: CHAT_VIA }
  })

  return { list: next, closed }
}

export const clearSent = (list: readonly Batch[]): Batch[] => list.filter(b => b.status === 'pending')

// ── 지운 묶음(0.4.1) ─────────────────────────────────────────────────────────

/**
 * 지운 묶음의 기록. 같은 묶음이 채팅 질문 폴더에 남아 있어도(파일 지우기 실패 등) 다시 띄우지 않고,
 * 「되돌리기」로 되살린다. 키에 만든 시각을 넣는다: 같은 세션이 나중에 같은 q 번호로 다시 물으면 새 묶음이다.
 */
export const DISMISSED_KEY = 'dismissed'
export const DISMISSED_MAX = 100
/** 이보다 오래된 지운 기록은 버린다(0.4.3). 질문 폴더 파일은 몇 초 안에 지워지므로 넉넉하다. */
export const DISMISSED_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 지운 기록 하나. 0.4.3부터 묶음 전체(`batch`)는 되돌릴 수 있는 마지막 카드 지우기에만 남긴다.
 * 0.4.1~0.4.2는 모든 기록에 묶음 전체를 들고 있어 저장소가 지울수록 커졌다(11개에 13KB).
 */
export type Dismissed = { key: string; at: number; batch?: Batch }

export const dismissKey = (b: Pick<Batch, 'id' | 'terminalId' | 'createdAt'>) => `${b.terminalId}/${b.id}@${b.createdAt}`

export const asDismissed = (v: JsonValue | null): Dismissed[] =>
  Array.isArray(v)
    ? v.flatMap((d): Dismissed[] => {
        if (!isRecord(d) || typeof d.key !== 'string' || typeof d.at !== 'number') return []
        const [batch] = d.batch === undefined ? [] : asBatches([d.batch as JsonValue])

        return [{ key: d.key, at: d.at, ...(batch === undefined ? {} : { batch }) }]
      })
    : []

/**
 * 지운 묶음들을 기록에 더한다(새 것이 뒤). 기록은 키·시각만 남기고, `undoable` 이면 이번에 지운 묶음
 * 전체를 되돌리기용으로 붙인다(앞선 기록의 묶음은 떼어 낸다 — 패널은 마지막 지우기만 되돌린다).
 * DISMISSED_TTL_MS 보다 오래된 것과 DISMISSED_MAX 를 넘는 오래된 것은 버린다.
 */
export const addDismissed = (
  list: readonly Dismissed[],
  removed: readonly Batch[],
  now: number,
  undoable = false,
): Dismissed[] => {
  const keys = new Set(removed.map(dismissKey))

  return [
    ...list.filter(d => !keys.has(d.key) && now - d.at <= DISMISSED_TTL_MS).map(d => ({ key: d.key, at: d.at })),
    ...removed.map(batch => ({ key: dismissKey(batch), at: now, ...(undoable ? { batch } : {}) })),
  ].slice(-DISMISSED_MAX)
}

/** 정리 하나: 남길 묶음과 지운 묶음으로 나눈다. */
export const splitBy = (list: readonly Batch[], drop: (b: Batch) => boolean): { keep: Batch[]; removed: Batch[] } => ({
  keep: list.filter(b => !drop(b)),
  removed: list.filter(drop),
})

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
    ...(isKey(raw.key) ? { key: raw.key } : {}),
  }
}

/**
 * 채팅 세션의 닫힘 파일(question-panel 0.6.3+): `{v, kind:'closed', ids, session:{id}, at}`.
 * 질문 파일과 같은 폴더에 남는다. 모양이 틀리면 null.
 */
export const closeFromInbox = (raw: unknown): { terminalId: string; ids: string[]; at: number } | null => {
  if (!isRecord(raw) || raw.v !== INBOX_VERSION || raw.kind !== 'closed') return null
  const sessionId = isRecord(raw.session) ? str(raw.session.id) : ''
  const ids = idsFrom(raw.ids)
  if (!SESSION_RE.test(sessionId) || ids.length === 0 || typeof raw.at !== 'number') return null

  return { terminalId: `orca_session_id:${sessionId}`, ids, at: raw.at }
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
 * 줄바꿈을 인자로 넘기지 못해 한 줄로 쓴다. 「기타」는 번호 자리에 「기타」, 값은 `기타: <글>`(0.4.4):
 * 「q4 기타 / [질문 패널 답] 질문 = 기타: 글」.
 */
export const mailBody = (b: Batch, picks: Picks, texts?: Texts): string => {
  const nums =
    b.questions.length === 1
      ? numsOf(picks[0] ?? []).join(',')
      : b.questions.flatMap((_, i) => numsOf(picks[i] ?? []).map(n => `${i + 1}-${n}`)).join(', ')
  const parts = b.questions.map(
    (q, i) => `[질문 패널 답] ${q.question} = ${labelsOf(q, picks[i] ?? [], textAt(texts, i)).join(', ')}`,
  )

  return `${b.id} ${nums} / ${parts.join(' / ')}`.replace(/[\r\n]+/g, ' ')
}

const tryJson = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text)

    return isRecord(v) ? v : null
  } catch {
    return null
  }
}

/**
 * CLI의 --json 답 한 덩어리. 실패해도 JSON을 찍으므로 stdout 을 먼저 본다. 1.4.25x 의 orchestration
 * 명령은 `--full` 이 없으면 짧은 한 줄(`{"ok":true,"result":{…}}`)을 찍는다(agent-view.ts
 * printOrchestrationFields). 앞에 다른 줄이 끼어도 읽도록 통째로 안 되면 끝에서부터 `{` 로 시작하는 줄을 본다.
 */
const parseJson = (text: string): Record<string, unknown> | null => {
  const whole = tryJson(text.trim())
  if (whole !== null) return whole
  const lines = text.split(/\r?\n/).map(l => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue
    const j = tryJson(lines[i])
    if (j !== null) return j
  }

  return null
}

/**
 * `orca orchestration run-current --json` 의 Run id. 묶인 Run이 없으면 null, 읽지 못하면 undefined.
 * 짧은 모양(기본, 1.4.25x): `{ok, result: {runId: "run_…" | null, objective}}`.
 * 긴 모양(`--full`·옛 CLI): `{ok, result: {run: {id} | null}}`.
 */
export const parseRunCurrent = (stdout: string): string | null | undefined => {
  const j = parseJson(stdout)
  if (j === null || j.ok !== true || !isRecord(j.result)) return undefined
  const r = j.result
  if ('runId' in r) {
    if (r.runId === null) return null
    const id = str(r.runId)

    return RUN_RE.test(id) ? id : undefined
  }
  if (!('run' in r)) return undefined
  if (r.run === null) return null
  const id = isRecord(r.run) ? str(r.run.id) : ''

  return RUN_RE.test(id) ? id : undefined
}

/** CLI 오류 답의 code(`{ok:false, error:{code}}`). 없으면 null. */
export const cliErrorCode = (stdout: string): string | null => {
  const j = parseJson(stdout)

  return j !== null && j.ok !== true && isRecord(j.error) && str(j.error.code) !== '' ? str(j.error.code) : null
}

/** 채팅 세션이 이 호스트에 없다(Orca가 지웠다). run-current 가 이 code 로 거부한다(orchestration-session-caller-codes.ts). */
export const SESSION_GONE = 'session_caller_unknown'

export type CliRun = {
  code: number | null
  stdout: string
  stderr: string
  error?: string
  /** 시간 안에 끝나지 않아 죽였다(돌기는 했으니 보냈을 수 있다). */
  timedOut?: boolean
}

/** 짧은 모양 `result.messageId`, 긴 모양 `result.message.id`, 여럿 `result.messageIds`, 릴레이 `result.relay.messageId`. */
const messageIdOf = (r: Record<string, unknown>): string => {
  if (typeof r.messageId === 'string') return r.messageId
  if (isRecord(r.message)) return str(r.message.id)
  if (Array.isArray(r.messageIds) && typeof r.messageIds[0] === 'string') return r.messageIds[0]
  if (isRecord(r.relay)) return str(r.relay.messageId)

  return ''
}

/**
 * `orca orchestration send --json` 결과. 실패는 종료 코드≠0 이거나 `ok:false` 일 때만이다(0.4.0은
 * `result.message.id` 가 없으면 실패로 봐서, 실제로 간 메일을 「보내지 못함」으로 띄웠다).
 * 실패일 때 maybeSent: CLI가 돌았고 서버가 거부하지도 않았다 — 실제로는 갔을 수 있다.
 */
export const parseSendResult = (
  r: CliRun,
): { ok: true; messageId: string } | { ok: false; why: string; maybeSent: boolean } => {
  const j = parseJson(r.stdout)
  if (j !== null && j.ok === false) {
    const e = isRecord(j.error) ? j.error : {}

    return { ok: false, why: `${str(e.code) || 'error'}: ${str(e.message)}`, maybeSent: false }
  }
  if (r.code === 0 && r.error === undefined) {
    return { ok: true, messageId: j !== null && isRecord(j.result) ? messageIdOf(j.result) : '' }
  }
  const ran = r.code !== null || r.timedOut === true
  if (r.error !== undefined) return { ok: false, why: r.error, maybeSent: ran }
  const tail = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).slice(-2).join(' ')

  return {
    ok: false,
    why: `orca 종료 코드 ${r.code ?? '없음'}${tail === '' ? '' : ` — ${tail.slice(0, 300)}`}`,
    maybeSent: ran,
  }
}

// ── 닫힘 장부(0.5.0, question-panel 0.9.0 과 같은 계약) ─────────────────────────
// 집 폴더 `~/.question-panel/ledger/<key>.json`. 닫힌 묶음마다 파일 하나를 배타 생성(O_EXCL)으로 만든다.
// 없으면 대기, 있으면 닫힘. Claude Code 패널(mod, MCP 서버 sync 도구)과 이 플러그인이 둘 다 보내기 전에
// 먼저 만들어 보고, 이긴 쪽만 세션에 답을 보낸다. 모양은 plugins/question-panel/mcp/ask.mjs 의 ledgerRecord.

/** 닫힘 장부 폴더(집 폴더 아래). */
export const LEDGER_DIR_PARTS = ['.question-panel', 'ledger']

const KEY_RE = /^[A-Za-z0-9_-]{1,80}~q\d{1,6}~\d{1,16}$/
export const isKey = (k: unknown): k is string => typeof k === 'string' && KEY_RE.test(k)

export type LedgerRecord = {
  v: 1
  key: string
  id: string
  state: 'answered' | 'dismissed'
  /** claude: Claude Code 패널, orca: 이 패널, chat: 대화창 글·resolve. */
  by: 'claude' | 'orca' | 'chat'
  at: number
}

export const ledgerRecord = (key: string, state: LedgerRecord['state'], at: number): LedgerRecord => ({
  v: 1,
  key,
  id: key.split('~')[1],
  state,
  by: 'orca',
  at,
})

/** 장부 파일 글 → 기록. 모양이 틀리거나(반쯤 쓴 파일 등) key가 다르면 null. */
export const parseLedger = (text: string | null, key: string): LedgerRecord | null => {
  if (text === null) return null
  let j: unknown = null
  try {
    j = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(j) || j.v !== 1 || j.key !== key || typeof j.at !== 'number') return null
  const state = j.state === 'answered' || j.state === 'dismissed' ? j.state : null
  const by = j.by === 'claude' || j.by === 'orca' || j.by === 'chat' ? j.by : null
  if (state === null || by === null) return null

  return { v: 1, key, id: key.split('~')[1], state, by, at: j.at }
}

/** 장부 기록이 이 패널 자신의 답(보내기 직전 차지)인가. 그때만 보내기를 막지 않는다. */
export const isOwnAnswer = (r: LedgerRecord) => r.by === 'orca' && r.state === 'answered'

/** 카드에 보일 닫힘 사유. */
export const ledgerVia = (r: LedgerRecord): string =>
  r.state === 'dismissed'
    ? r.by === 'orca'
      ? '답 없이 닫음'
      : 'Claude Code 패널에서 답 없이 닫음'
    : r.by === 'chat'
      ? CHAT_VIA
      : r.by === 'claude'
        ? 'Claude Code 패널에서 답함'
        : '보냄'

/** 장부에 다른 곳의 닫힘이 있는 대기 묶음을 닫는다(이 패널 자신의 답 기록은 건드리지 않는다). */
export const closeByLedger = (
  list: readonly Batch[],
  records: Readonly<Record<string, LedgerRecord>>,
): { list: Batch[]; closed: { id: string; terminalId: string; via: string }[] } => {
  const closed: { id: string; terminalId: string; via: string }[] = []
  const next = list.map(b => {
    const r = b.status === 'pending' && b.key !== undefined ? records[b.key] : undefined
    if (r === undefined || isOwnAnswer(r)) return b
    const via = ledgerVia(r)
    closed.push({ id: b.id, terminalId: b.terminalId, via })
    const { error: _, ...rest } = b

    return { ...rest, status: 'sent' as const, via }
  })

  return { list: closed.length === 0 ? [...list] : next, closed }
}
