// 질문 패널 상태(코어): 묶음 쌓기·고르기·보내기·답 없이 닫기·대화창 답·닫힘 장부. 에이전트를 모른다.
// 묶음 저장은 Store 포트, 세션에 보내기는 AgentHost.submitTurn, 닫힘 장부는 선택 어댑터 LedgerLink,
// 사용자 알림은 notify 로 받는다. 그리기(패널·카드)는 에이전트 어댑터(hooks/register.tsx) 몫이다.
// question-panel 0.9.0 의 동작을 그대로 옮겼다.
import type { QuestionPanelBatch, QuestionPanelQuestion } from '../types'
import type { AgentHost } from './host'
import type { RemoteAnswer, RemoteItem, RemoteQuestion } from './remote-questions'

/** 값 하나를 들고 있는 저장소. update 는 다시 시도할 수 있어 fn 이 여러 번 돌 수 있다. */
export type Store<T> = {
  read: () => Promise<T>
  update: (fn: (v: T) => T) => Promise<unknown>
}

// ── 닫힘 장부(question-panel 0.9.0) ────────────────────────────────────────
// 질문 묶음 상태의 정본은 집 폴더의 장부(~/.question-panel/ledger, mcp/ask.mjs)다. 닫힌 묶음마다 파일 하나를
// 배타 생성으로 만들어, 이 패널과 Orca 질문 패널 중 먼저 닫은 쪽만 세션에 답을 보낸다.
export type LedgerRecord = {
  key: string
  id: string
  state: 'answered' | 'dismissed'
  by: 'claude' | 'orca' | 'chat'
  at: number
  /** Orca 질문 패널이 원격 질문 카드에 답했을 때 실은 답(서버 모양, 0.11.0). */
  answers?: RemoteAnswer[]
}
export type SyncOut = { claimed?: boolean; holder?: LedgerRecord | null; closed: Record<string, LedgerRecord>; offered?: boolean }
export type SyncArgs = {
  close?: { key: string; state: LedgerRecord['state']; by: 'claude' | 'chat' }
  keys?: string[]
  /** 원격 묶음을 Orca 질문 패널 폴더에 남긴다(0.11.0, Orca 세션일 때만). */
  offer?: { id: string; key: string; questions: RemoteItem[]; remote: { id: string; asker: string } }
}

/**
 * 닫힘 장부 어댑터(선택). 없거나 sync 가 null 이면(서버가 안 닿음) 장부 없이 혼자 돈다.
 * Orca 사이드바 질문 패널과 상태를 맞추는 길이다.
 */
export type LedgerLink = { sync: (args: SyncArgs) => Promise<SyncOut | null> }

type RawQuestion = { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown }

export const OTHER_LABEL = '기타'

export const isAnswered = (q: QuestionPanelQuestion) => q.picked.length > 0 || q.other.trim() !== ''

export const isComplete = (b: QuestionPanelBatch) => b.questions.every(isAnswered)

const chosen = (q: QuestionPanelQuestion) => {
  const list = [...q.picked]
  if (q.other.trim() !== '') list.push(`${OTHER_LABEL}: ${q.other.trim()}`)
  return list.join(', ')
}

export const answerText = (b: QuestionPanelBatch) =>
  b.questions.map(q => `[질문 패널 답] ${q.question} = ${chosen(q)}`).join('\n')

// preview를 목록 항목 아래 코드 블록으로 넣는다. 본문에 든 백틱 줄보다 긴 울타리를 써서 닫히지 않게 한다.
const fenced = (text: string) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))

  return [fence, ...text.split('\n'), fence].map(l => `  ${l}`)
}

// 대화창에 옮겨 적을 마크다운 블록. Remote Control·폰처럼 플러그인 UI가 오지 않는 화면에서도
// 질문이 보이고, 「q4 1-2」처럼 묶음 ID와 번호로 글로 답할 수 있게 한다.
export const chatBlock = (b: QuestionPanelBatch) => {
  const lines = [`**[질문 묶음 ${b.id}]** 패널에서 답하거나, 이 대화창에 글로 답해도 됩니다.`]
  b.questions.forEach((q, qi) => {
    const head = q.header === '' ? '' : `〔${q.header}〕 `
    const how = q.multiSelect ? '여러 개 선택 가능' : '하나만 선택'
    lines.push('', `**${qi + 1}. ${head}${q.question}** (${how})`)
    q.options.forEach((o, oi) => {
      lines.push(`- ${oi + 1}) ${o.label}${o.description === '' ? '' : ` — ${o.description}`}`)
      if (o.preview !== undefined) lines.push(...fenced(o.preview))
    })
  })
  const example =
    b.questions.length === 1 ? `\`${b.id} 2\`(선택지 번호)` : `\`${b.id} 1-2, 2-1\`(질문 번호-선택지 번호)`
  lines.push('', `번호로 답해도 됩니다: ${example}. 목록에 없는 답은 그대로 글로 적으면 됩니다.`)

  return lines.join('\n')
}

// 사용자 글에 대기 중인 묶음 ID(q4 등)가 있으면 그 묶음을 「대화창에서 답함」으로 닫는다.
// 패널에서 같은 질문에 또 답해 답이 두 번 가는 일을 막는다.
export const mentionedIds = (text: string) => new Set([...text.matchAll(/\bq(\d+)\b/gi)].map(m => `q${m[1]}`))

// 원격 묶음은 대화창 글로 닫지 않는다: 그 글은 이 세션에 갈 뿐 서버에 답이 되지 않는다.
const closeInChat = (list: QuestionPanelBatch[], ids: Set<string>) =>
  list.map(b =>
    ids.has(b.id) && b.status === 'pending' && b.remote === undefined
      ? { ...b, status: 'sent' as const, via: 'chat' as const, confirmingDelete: false }
      : b,
  )

// 대화창 글로 답해 닫힌 묶음 ID들. 질문·resolve 호출에 panel_closed 로 붙여 Orca 질문 패널 카드도 닫는다
// (prompt.submit 훅에는 바깥으로 알릴 길이 없어 다음 도구 호출에 실어 보낸다, question-panel 0.6.3).
export const chatClosed = (list: readonly QuestionPanelBatch[]) => list.filter(b => b.via !== undefined).map(b => b.id)

/** 이 패널이 닫으려 했는데 장부에 다른 곳의 닫힘이 먼저 있다(그러면 세션에 보내지 않는다). */
const lostTo = (r: SyncOut | null): LedgerRecord | null => {
  if (r === null || r.claimed !== false) return null
  // 먼저 닫은 것이 이 패널 자신(보내기 실패 뒤 다시 누름)이면 막지 않는다.
  if (r.holder?.by === 'claude') return null

  return r.holder ?? { key: '', id: '', state: 'answered', by: 'orca', at: 0 }
}

/** 장부 기록 → 이 패널의 닫힘 표시. */
const viaOf = (rec: LedgerRecord): QuestionPanelBatch['via'] =>
  rec.by === 'orca'
    ? rec.state === 'dismissed'
      ? 'orca-dismissed'
      : 'orca'
    : rec.state === 'dismissed'
      ? 'dismissed'
      : rec.by === 'chat'
        ? 'chat'
        : undefined

export const VIA_TEXT: Record<NonNullable<QuestionPanelBatch['via']>, string> = {
  chat: '대화창에서 답함',
  dismissed: '답 없이 닫음',
  orca: 'Orca에서 답함',
  'orca-dismissed': 'Orca에서 답 없이 닫음',
  'remote-answered': '다른 곳에서 답함(원격)',
  'remote-withdrawn': '묻는 쪽이 거둠(원격)',
  'remote-taken': '이미 답함·거둠(원격)',
}

// ── 원격 질문(대장 세션, 0.11.0) ─────────────────────────────────────────────

/** 서버 질문 문항 → 패널 문항(고른 것 없음). */
export const panelQuestions = (items: readonly RemoteItem[]): QuestionPanelQuestion[] =>
  items.map(q => ({
    question: q.question,
    header: q.header,
    options: q.options.map(o => ({ label: o.label, description: o.description, ...(o.preview === undefined ? {} : { preview: o.preview }) })),
    multiSelect: q.multiSelect,
    picked: [],
    other: '',
  }))

/** 패널 답 → 서버 답: 고른 label 들, 「기타」 글은 other. */
export const remoteAnswers = (b: QuestionPanelBatch): RemoteAnswer[] =>
  b.questions.map(q => (q.other.trim() === '' ? { selected: [...q.picked] } : { selected: [...q.picked], other: q.other.trim() }))

/**
 * 서버에 답을 보낸 결과: ok(200), closed(409·404 — 이미 답함·거둠·없음), failed(연결 실패 등, 다시 해 볼 수 있음),
 * self(이 세션이 물은 질문이라 서버가 답을 받지 않았다 — text 를 이 세션 입력으로 넣는다, #138).
 */
export type RemoteAnswerOutcome =
  | { kind: 'ok' }
  | { kind: 'closed'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'self'; text: string }
/** 원격 묶음의 답을 서버로 보내는 길(대장 세션의 코어). */
export type RemoteAnswerPort = { answer: (id: string, answers: RemoteAnswer[]) => Promise<RemoteAnswerOutcome> }


export const sessionKey = (sid: string, id: string, now: number) =>
  `${sid.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'session'}~${id}~${Math.floor(now)}`

// 답한 묶음(패널에서 보냄·대화창에서 답함)만 지운다. 대기 중인 묶음은 남긴다.
export const clearSent = (list: QuestionPanelBatch[]) => list.filter(b => b.status !== 'sent')

// preview가 이미 코드 블록이면 그대로, 아니면 글자 그대로 보이게(ASCII 목업 정렬 유지) 코드 블록으로 감싼다.
export const fencedPreview = (text: string) =>
  /^\s*(```|~~~)/.test(text) ? text : fenced(text).map(l => l.slice(2)).join('\n')

/** 시:분. */
export const hhmm = (ms: number) => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

/** 모델이 넘긴 questions 를 묶음의 질문으로. 틀렸으면 까닭 글. */
export const normalize = (raw: unknown): QuestionPanelQuestion[] | string => {
  if (!Array.isArray(raw) || raw.length === 0) return 'questions가 비었습니다.'
  const out: QuestionPanelQuestion[] = []
  for (const item of raw as RawQuestion[]) {
    if (typeof item?.question !== 'string' || item.question.trim() === '') {
      return '각 질문에는 question 글이 필요합니다.'
    }
    if (!Array.isArray(item.options) || item.options.length === 0) {
      return '각 질문에는 options가 하나 이상 필요합니다.'
    }
    const options = []
    for (const o of item.options as { label?: unknown; description?: unknown; preview?: unknown }[]) {
      if (typeof o?.label !== 'string' || o.label === '') {
        return '각 선택지에는 label이 필요합니다.'
      }
      options.push({
        label: o.label,
        description: typeof o.description === 'string' ? o.description : '',
        ...(typeof o.preview === 'string' && o.preview.trim() !== '' ? { preview: o.preview } : {}),
      })
    }
    out.push({
      question: item.question,
      header: typeof item.header === 'string' ? item.header.slice(0, 12) : '',
      options,
      multiSelect: item.multiSelect === true,
      picked: [],
      other: '',
    })
  }
  return out
}

export type QuestionPanelDeps = {
  queue: Store<QuestionPanelBatch[]>
  /** 패널 아래 「보내기」 칸에 쓰는 중인 글. */
  draft: Store<string>
  host: Pick<AgentHost, 'submitTurn'>
  /** 닫힘 장부(선택 어댑터). */
  ledger?: LedgerLink
  /** 사용자에게 짧게 알린다(토스트 등). */
  notify: (text: string) => void
  /** 원격 묶음의 답을 서버로(0.11.0). 없으면 원격 묶음에 답할 수 없다. */
  remote?: RemoteAnswerPort
  /** 기록 한 줄(선택). */
  log?: (text: string) => void
}

export type QuestionPanel = ReturnType<typeof createQuestionPanel>

export const createQuestionPanel = ({ queue, draft, host, ledger, notify, remote, log }: QuestionPanelDeps) => {
  const sync = async (args: SyncArgs) => (ledger === undefined ? null : ledger.sync(args).catch(() => null))
  const send = (text: string, onFail: () => void) => {
    // 결과를 기다리지 않는다(턴이 시작될 때야 풀린다). 실패하면 onFail.
    host.submitTurn(text).catch(onFail)
  }

  /** 새 묶음을 쌓는다. */
  const add = async (a: { questions: QuestionPanelQuestion[]; toolUseId?: string; sessionId: string; now: number }) => {
    const list = await queue.read()
    const top = Math.max(0, ...list.map(b => Number(b.id.slice(1)) || 0))
    const id = `q${top + 1}`
    const batch: QuestionPanelBatch = {
      id,
      createdAt: a.now,
      status: 'pending',
      questions: a.questions,
      ...(a.toolUseId === undefined ? {} : { toolUseId: a.toolUseId }),
      key: sessionKey(a.sessionId, id, a.now),
    }
    await queue.update(l => [...l, batch])

    return { batch, before: list }
  }

  /** 쌓았던 묶음을 거둔다(모델이 묶음을 모르게 됐을 때). */
  const drop = (id: string) => queue.update(l => l.filter(b => b.id !== id))

  const edit = (id: string, qi: number, change: (q: QuestionPanelQuestion) => QuestionPanelQuestion) =>
    queue.update(l =>
      l.map(b =>
        b.id !== id || b.status !== 'pending'
          ? b
          : { ...b, questions: b.questions.map((q, i) => (i === qi ? change(q) : q)) },
      ),
    )

  // 고르면 그 선택지의 preview를 펼친다(있으면). 초점 이벤트가 없어 누름을 「초점」으로 본다.
  const pick = (id: string, qi: number, label: string) =>
    edit(id, qi, q => {
      const hasPreview = q.options.some(o => o.label === label && o.preview !== undefined)
      const peek = hasPreview ? label : q.peek
      if (q.multiSelect) {
        const has = q.picked.includes(label)

        return { ...q, peek, picked: has ? q.picked.filter(p => p !== label) : [...q.picked, label] }
      }

      return { ...q, peek, picked: q.picked[0] === label && q.other === '' ? [] : [label], other: '' }
    })

  // 고르지 않고 preview만 펼치거나 접는다.
  const togglePeek = (id: string, qi: number, label: string) =>
    edit(id, qi, q => ({ ...q, peek: q.peek === label ? undefined : label }))

  const typeOther = (id: string, qi: number, text: string) =>
    edit(id, qi, q => ({ ...q, other: text, picked: q.multiSelect ? q.picked : text.trim() === '' ? q.picked : [] }))

  const finish = async (id: string) => {
    let sent = undefined as QuestionPanelBatch | undefined
    await queue.update(l => {
      // update는 다시 시도할 수 있어 이 클로저가 여러 번 돈다: 마지막 판정만 남긴다.
      sent = undefined

      return l.map(b => {
        if (b.id !== id || b.status !== 'pending' || !isComplete(b)) return b
        sent = b

        return { ...b, status: 'sent' as const }
      })
    })
    if (sent === undefined) return
    if ((sent as QuestionPanelBatch).remote !== undefined) return finishRemote(sent as QuestionPanelBatch)
    // 장부에서 먼저 닫는다: Orca 질문 패널이 먼저 답했으면 보내지 않는다(세션에는 한 번만 간다).
    const key = (sent as QuestionPanelBatch).key
    if (key !== undefined) {
      const lost = lostTo(await sync({ close: { key, state: 'answered', by: 'claude' } }))
      if (lost !== null) {
        void queue.update(l => l.map(b => (b.id === id ? { ...b, via: viaOf(lost) } : b)))
        notify(`${id}은(는) 이미 ${VIA_TEXT[viaOf(lost) ?? 'orca']} 상태라 보내지 않았습니다.`)

        return
      }
    }
    // 큐에 들어가는 제출: 턴이 진행 중이어도 끼어들지 않고 턴이 끝나면 새 턴으로 간다.
    send(answerText(sent), () => {
      void queue.update(l => l.map(b => (b.id === id ? { ...b, status: 'pending' as const } : b)))
      notify('답을 보내지 못했습니다. 다시 완료를 눌러 주세요.')
    })
  }

  const sendRemote = async (b: QuestionPanelBatch, answers: RemoteAnswer[]): Promise<RemoteAnswerOutcome> => {
    const rid = b.remote?.id ?? ''
    if (remote === undefined) return { kind: 'failed', reason: '서버에 답할 길이 없음(메일함 꺼짐)' }
    try {
      return await remote.answer(rid, answers)
    } catch {
      return { kind: 'failed', reason: '서버에 닿지 않음' }
    }
  }

  const setVia = (id: string, via: QuestionPanelBatch['via']) =>
    queue.update(l => l.map(b => (b.id === id ? { ...b, status: 'sent' as const, via, confirmingDelete: false } : b)))

  /**
   * 원격 묶음을 패널에서 끝냈다(이미 sent 로 바꿈): 서버에 답을 보낸다. 세션에는 아무것도 넣지 않는다(대장 세션 자신의 턴이 아니다).
   * 200 이면 장부에 닫힘을 남겨 Orca 카드도 닫고, 409·404 면 「이미 답함·거둠」으로 닫고, 실패면 대기로 되돌린다.
   */
  const finishRemote = async (b: QuestionPanelBatch) => {
    const r = await sendRemote(b, remoteAnswers(b))
    if (r.kind === 'failed') {
      await queue.update(l => l.map(x => (x.id === b.id ? { ...x, status: 'pending' as const } : x)))
      notify(`원격 질문 답을 보내지 못했습니다(${r.reason}). 다시 완료를 눌러 주세요.`)

      return
    }
    if (r.kind === 'closed') await setVia(b.id, 'remote-taken')
    if (r.kind === 'self') send(r.text, () => notify('답을 세션에 넣지 못했습니다.'))
    if (b.key !== undefined) await sync({ close: { key: b.key, state: 'answered', by: 'claude' } })
    notify(
      r.kind === 'ok'
        ? `${b.id} 답을 서버에 보냈습니다(원격 질문 · ${b.remote?.asker || '?'}).`
        : r.kind === 'self'
          ? `${b.id} 답을 세션에 보냈습니다.`
          : `${b.id}은(는) 이미 답이 났거나 거둔 질문이라 닫았습니다(${r.reason}).`,
    )
  }

  /** 서버 질문을 패널에 올린다. 같은 서버 id 가 큐에 있으면(대기든 닫혔든) 올리지 않고 null. */
  const addRemote = async (a: { q: RemoteQuestion; sessionId: string; now: number }) => {
    let added = undefined as QuestionPanelBatch | undefined
    await queue.update(l => {
      added = undefined
      if (l.some(b => b.remote?.id === a.q.id)) return l
      const top = Math.max(0, ...l.map(b => Number(b.id.slice(1)) || 0))
      const id = `q${top + 1}`
      added = {
        id,
        createdAt: a.now,
        status: 'pending',
        questions: panelQuestions(a.q.questions),
        key: sessionKey(a.sessionId, id, a.now),
        remote: { id: a.q.id, asker: a.q.asker },
      }

      return [...l, added]
    })

    return added ?? null
  }

  /** 다른 곳(대시보드·다른 대장)에서 답했거나 묻는 쪽이 거둔 서버 질문의 대기 묶음을 닫는다. 닫았으면 true. */
  const closeRemote = async (rid: string, via: 'remote-answered' | 'remote-withdrawn' | 'remote-taken') => {
    let key = undefined as string | undefined
    let closed = false
    await queue.update(l => {
      closed = false
      key = undefined

      return l.map(b => {
        if (b.remote?.id !== rid || b.status !== 'pending') return b
        closed = true
        key = b.key

        return { ...b, status: 'sent' as const, via, confirmingDelete: false }
      })
    })
    if (closed && key !== undefined) await sync({ close: { key, state: via === 'remote-withdrawn' ? 'dismissed' : 'answered', by: 'claude' } })

    return closed
  }

  /** 서버에서 대기가 아닌(목록에 없는) 대기 원격 묶음을 닫는다(세션이 꺼진 사이 답이 났을 때). */
  const pruneRemote = async (open: ReadonlySet<string>) => {
    const gone = (await queue.read()).filter(b => b.status === 'pending' && b.remote !== undefined && !open.has(b.remote.id))
    for (const b of gone) await closeRemote(b.remote?.id ?? '', 'remote-taken')

    return gone.length
  }

  // 대화창 글(「q4 1-2」·resolve)로 닫는다. 장부에도 「대화창에서 답함」을 남겨 Orca 카드가 곧 닫히게 한다.
  const closeByChat = async (ids: Set<string>) => {
    let keys: string[] = []
    await queue.update(l => {
      keys = l.filter(b => ids.has(b.id) && b.status === 'pending' && b.remote === undefined && b.key !== undefined).map(b => b.key as string)

      return closeInChat(l, ids)
    })
    await Promise.all(keys.map(key => sync({ close: { key, state: 'answered', by: 'chat' } })))
  }

  // 자유 글을 답과 같은 길(큐에 들어가는 사용자 메시지)로 보낸다. 빈 글은 보내지 않는다.
  const say = async (typed?: string) => {
    let text = ''
    await draft.update(d => {
      text = (typed ?? d).trim()

      return text === '' ? d : ''
    })
    if (text === '') return
    const ids = mentionedIds(text)
    if (ids.size > 0) void closeByChat(ids)
    send(text, () => {
      void draft.update(d => (d === '' ? text : d))
      notify('글을 보내지 못했습니다. 다시 보내기를 눌러 주세요.')
    })
  }

  const typeDraft = (text: string) => draft.update(() => text)

  const askDelete = (id: string, confirming: boolean) =>
    queue.update(l => l.map(b => (b.id === id && b.status === 'pending' ? { ...b, confirmingDelete: confirming } : b)))

  // 답한(보낸·대화창에서 답한) 묶음은 확인 없이 지운다. 대기 중인 묶음은 dismiss 의 확인을 거친다.
  const removeSent = (id: string) => queue.update(l => l.filter(b => !(b.id === id && b.status === 'sent')))

  // 답 없이 닫는다: 묶음은 「답 없이 닫음」 기록으로 남기고, 세션에는 「qN 답 없이 닫음」을 한 줄 보내
  // 모델이 기다리지 않게 한다.
  const dismiss = async (id: string) => {
    let closed = false
    let wasRemote = false
    let key = undefined as string | undefined
    await queue.update(l => {
      closed = false
      wasRemote = false
      key = undefined

      return l.map(b => {
        if (b.id !== id || b.status !== 'pending' || b.confirmingDelete !== true) return b
        closed = true
        wasRemote = b.remote !== undefined
        key = b.key

        return { ...b, status: 'sent' as const, via: 'dismissed' as const, confirmingDelete: false }
      })
    })
    if (!closed) return
    if (key !== undefined) {
      const lost = lostTo(await sync({ close: { key, state: 'dismissed', by: 'claude' } }))
      if (lost !== null) {
        void queue.update(l => l.map(b => (b.id === id ? { ...b, via: viaOf(lost) } : b)))

        return
      }
    }
    // 원격 묶음은 이 패널에서만 내린다(서버 질문은 그대로 — 대시보드·다른 대장이 답할 수 있다). 세션에 알릴 것도 없다.
    if (wasRemote) return
    send(`[질문 패널 답] ${id} 답 없이 닫음`, () => notify('세션에 닫음을 알리지 못했습니다.'))
  }

  /** 답한 묶음을 모두 지우고 지운 수를 돌려준다. */
  const clearAnswered = async () => {
    let removed = 0
    await queue.update(l => {
      removed = l.length - clearSent(l).length

      return clearSent(l)
    })

    return removed
  }

  /**
   * 장부를 읽어 다른 곳(Orca 질문 패널·다른 길)에서 닫힌 대기 묶음을 닫는다. 대기 묶음이 없으면 부르지 않는다.
   * Orca에서 답 없이 닫았으면 세션에 「qN 답 없이 닫음(Orca)」 한 줄을 보낸다(모델이 기다리지 않게).
   * Orca에서 답했으면 답은 Orca가 보낸 줄·메일로 따로 온다.
   */
  const poll = async () => {
    if (ledger === undefined) return
    const keys = (await queue.read()).filter(b => b.status === 'pending' && b.key !== undefined).map(b => b.key as string)
    if (keys.length === 0) return
    const r = await sync({ keys })
    if (r === null) return
    let shut: QuestionPanelBatch[] = []
    const forward = new Map<string, RemoteAnswer[] | null>()
    await queue.update(l => {
      shut = []
      forward.clear()

      return l.map(b => {
        const rec = b.status === 'pending' && b.key !== undefined ? r.closed[b.key] : undefined
        // 이 패널 자신의 기록(보내기 실패로 대기로 되돌린 묶음)은 그대로 둔다.
        if (rec === undefined || rec.by === 'claude') return b
        const next = { ...b, status: 'sent' as const, via: viaOf(rec), confirmingDelete: false }
        shut.push(next)
        if (b.remote !== undefined && rec.by === 'orca' && rec.state === 'answered') forward.set(b.id, rec.answers ?? null)

        return next
      })
    })
    for (const b of shut.filter(x => x.via === 'orca-dismissed' && x.remote === undefined)) {
      send(`[질문 패널 답] ${b.id} 답 없이 닫음(Orca)`, () => notify('세션에 닫음을 알리지 못했습니다.'))
    }
    // Orca 사이드바에서 답한 원격 묶음: 장부 기록에 실린 답을 서버로 보낸다(세션에는 넣지 않는다).
    for (const b of shut.filter(x => forward.has(x.id))) {
      const answers = forward.get(b.id) ?? null
      if (answers === null || answers.length !== b.questions.length) {
        notify(`${b.id}: Orca 질문 패널이 원격 질문 답을 싣지 않아 서버에 보내지 못했습니다(Orca 질문 패널 0.7.0+ 필요).`)
        continue
      }
      const r = await sendRemote(b, answers)
      if (r.kind === 'ok') log?.(`switchboard 질문: ${b.id}(원격 ${b.remote?.id ?? '?'}) Orca 답을 서버에 보냈다`)
      else if (r.kind === 'self') send(r.text, () => notify('답을 세션에 넣지 못했습니다.'))
      else if (r.kind === 'closed') await setVia(b.id, 'remote-taken')
      else {
        // 대기로 되돌린다: 장부의 Orca 기록이 남아 있어 다음 장부 보기에서 다시 보낸다.
        await queue.update(l =>
          l.map(x => {
            if (x.id !== b.id) return x
            const { via: _, ...rest } = x

            return { ...rest, status: 'pending' as const }
          }),
        )
        log?.(`switchboard 질문: ${b.id} Orca 답을 서버에 보내지 못함(${r.reason}) — 다시 해 본다`)
      }
    }
  }

  return {
    add,
    drop,
    pick,
    togglePeek,
    typeOther,
    finish,
    say,
    typeDraft,
    askDelete,
    removeSent,
    dismiss,
    closeByChat,
    clearAnswered,
    poll,
    addRemote,
    closeRemote,
    pruneRemote,
  }
}
