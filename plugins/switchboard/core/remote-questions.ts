// 원격 질문(#106) 서버 클라이언트: switchboard 서버의 질문 API(/api/questions…)를 부른다.
// 묻는 쪽(#111, remote-ask.ts)과 서버 질문을 끌어와 답하는 대장 쪽(#112)이 함께 쓴다.
//  - 인증은 메일함의 call(같은 `Authorization: Bearer` + `X-Switchboard-Role`·옛 `X-Agent-Mail-Role`, 지금 번호 역할)로 한다. 토큰은 여기 오지 않는다.
//  - 서버 계약: #106 댓글 「remote questions API」. 상태 코드는 그대로 돌려주고 뜻은 부르는 쪽이 정한다.
//  - 응답 모양이 틀리면 ok:false(status 는 서버의 것)로 돌려준다. 연결 실패·시간 초과는 status null.
import type { QuestionPanelQuestion } from '../types'
import type { CallIo, Mailbox, MailEvent } from './mailbox'
import { ANSWER_SUBJECT_PREFIX, isSystemSender, POLL_TIMEOUT_S } from './mailbox'
import { GROUP_REFUSAL, isGroupRefusal } from './wire'

export type RemoteOption = { label: string; description: string; preview?: string }
/** 서버 질문의 문항 하나(로컬 묶음의 문항에서 고른 것·기타 글 등 패널 상태를 뺀 것). */
export type RemoteItem = { header: string; question: string; options: RemoteOption[]; multiSelect: boolean }
/** 문항 하나의 답: selected 는 늘 배열, other 는 「기타」 글. */
export type RemoteAnswer = { selected: string[]; other?: string }
export type RemoteStatus = 'pending' | 'answered' | 'withdrawn'

/** 서버 질문 보기(view). */
export type RemoteQuestion = {
  id: string
  /** 묻는 역할(번호 역할일 수 있다). */
  asker: string
  created_at: string
  status: RemoteStatus
  questions: RemoteItem[]
  /** 답이 나기 전에는 null. */
  answers: RemoteAnswer[] | null
  /** 답이 나기 전에는 ""; 그 뒤 답한 역할 또는 "dashboard". */
  answered_by: string
  answered_at: string | null
  withdrawn_at: string | null
  /** 전역 변경 카운터(만듦·답·거둠 때 오른다). */
  seq: number
  /** 이 역할이 답할 수 있는가(대장이고 묻는 쪽과 다른 base). */
  can_answer: boolean
}

/** 서버 응답: 성공이면 value, 아니면 status(연결 실패는 null)와 짧은 까닭. */
/** 실패 응답: `code`·`askVia` 는 서버가 JSON 으로 준 때만(옛 서버는 평문이라 없다). */
export type ApiReply<T> = { ok: true; status: number; value: T } | { ok: false; status: number | null; error: string; code?: string; askVia?: string; settingsTarget?: string }

export type QuestionsApi = {
  /** POST /api/questions. 201 · 403 can_ask 꺼짐 · 400 모양 · 409 답할 대장 없음. */
  ask: (items: readonly RemoteItem[], io?: CallIo, relayTo?: readonly string[]) => Promise<ApiReply<RemoteQuestion>>
  /** GET /api/questions/{id}. 403 묻는 쪽 base 도 대장도 아님 · 404. */
  get: (id: string, io?: CallIo) => Promise<ApiReply<RemoteQuestion>>
  /** GET /api/questions?status=&limit= (새것부터). */
  list: (q?: { status?: RemoteStatus; limit?: number }, io?: CallIo) => Promise<ApiReply<RemoteQuestion[]>>
  /** GET /api/questions/poll?after=&timeout= — seq 가 after 보다 큰 보기(오름차순)와 다음 커서. */
  poll: (after: number, timeoutS?: number, io?: CallIo) => Promise<ApiReply<{ questions: RemoteQuestion[]; cursor: number }>>
  /** POST /api/questions/{id}/answer. 404 → 403 → 409(이미 답함·거둠) → 400 순. */
  answer: (id: string, answers: readonly RemoteAnswer[], io?: CallIo) => Promise<ApiReply<RemoteQuestion>>
  /** POST /api/questions/{id}/withdraw. 404 · 403 묻는 쪽 base 아님 · 409 대기 중 아님. */
  withdraw: (id: string, io?: CallIo) => Promise<ApiReply<RemoteQuestion>>
}

/** 서버 질문 id: `q_` + 32 hex. 로컬 묶음 id(`q3`)와 겹치지 않는다. */
export const REMOTE_ID = /^q_[0-9a-f]{32}$/
export const isRemoteId = (id: string) => REMOTE_ID.test(id)

export { ANSWER_SUBJECT_PREFIX }
/** 새 질문 참조(watcher) 메일 제목 머리(`[질문] <id> …`). */
export const QUESTION_SUBJECT_PREFIX = '[질문] '

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

const parseOption = (v: unknown): RemoteOption | null => {
  if (!isRecord(v) || typeof v.label !== 'string') return null

  return { label: v.label, description: str(v.description), ...(typeof v.preview === 'string' && v.preview !== '' ? { preview: v.preview } : {}) }
}

const parseItem = (v: unknown): RemoteItem | null => {
  if (!isRecord(v) || typeof v.question !== 'string' || !Array.isArray(v.options)) return null
  const options = v.options.map(parseOption)
  if (options.some(o => o === null)) return null

  return { header: str(v.header), question: v.question, options: options as RemoteOption[], multiSelect: v.multiSelect === true }
}

const parseAnswer = (v: unknown): RemoteAnswer | null => {
  if (!isRecord(v) || !Array.isArray(v.selected) || v.selected.some(s => typeof s !== 'string')) return null

  return { selected: v.selected as string[], ...(typeof v.other === 'string' && v.other !== '' ? { other: v.other } : {}) }
}

/** 보기 하나를 읽는다. 모양이 틀리면 null. */
export const parseQuestion = (v: unknown): RemoteQuestion | null => {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.status !== 'string') return null
  if (v.status !== 'pending' && v.status !== 'answered' && v.status !== 'withdrawn') return null
  const items = Array.isArray(v.questions) ? v.questions.map(parseItem) : []
  if (items.some(q => q === null)) return null
  let answers: RemoteAnswer[] | null = null
  if (Array.isArray(v.answers)) {
    const list = v.answers.map(parseAnswer)
    if (list.some(a => a === null)) return null
    answers = list as RemoteAnswer[]
  }

  return {
    id: v.id,
    asker: str(v.asker),
    created_at: str(v.created_at),
    status: v.status,
    questions: items as RemoteItem[],
    answers,
    answered_by: str(v.answered_by),
    answered_at: typeof v.answered_at === 'string' ? v.answered_at : null,
    withdrawn_at: typeof v.withdrawn_at === 'string' ? v.withdrawn_at : null,
    seq: typeof v.seq === 'number' ? v.seq : 0,
    can_answer: v.can_answer === true,
  }
}

/** 문자열 FNV-1a 32비트(16진). 키 구분용이라 충돌 방지 강도는 필요 없다. */
const fnv = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0

  return h.toString(16).padStart(8, '0')
}

const json = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 오류 응답의 짧은 까닭(서버의 error·detail 글, 없으면 본문 앞부분). */
const errorOf = (status: number, text: string): string => {
  if (isGroupRefusal(status, text)) return GROUP_REFUSAL
  const j = json(text)
  const msg = isRecord(j) ? str(j.error) || str(j.detail) || str(j.message) : text
  const one = msg.replace(/\s+/g, ' ').trim().slice(0, 200)

  return one === '' ? `HTTP ${status}` : one
}

/** 문항을 서버 모양으로: 패널 상태(picked·other·peek)는 뺀다. 빈 header 는 서버가 받지 않아 「질문」으로 채운다. */
export const toRemoteItems = (qs: readonly QuestionPanelQuestion[]): RemoteItem[] =>
  qs.map(q => ({
    header: q.header.trim() === '' ? '질문' : q.header.trim().slice(0, 12),
    question: q.question,
    options: q.options.map(o => ({ label: o.label, description: o.description, ...(o.preview === undefined ? {} : { preview: o.preview }) })),
    multiSelect: q.multiSelect,
  }))

export const createQuestionsApi = (call: Mailbox['call']): QuestionsApi => {
  const go = async <T>(
    path: string,
    init: { method?: string; body?: string; headers?: Readonly<Record<string, string>> },
    io: CallIo | undefined,
    parse: (v: unknown) => T | null,
  ): Promise<ApiReply<T>> => {
    const r = await call(path, init, io)
    if (r === null) return { ok: false, status: null, error: '서버에 닿지 않음' }
    if (!r.ok) {
      const j = json(r.text)
      const code = isRecord(j) ? str(j.code) : ''
      const askVia = isRecord(j) ? str(j.ask_via).trim() : ''
      const settingsTarget = isRecord(j) ? str(j.settings_target).trim() : ''

      return { ok: false, status: r.status, error: errorOf(r.status, r.text), ...(code === '' ? {} : { code }), ...(askVia === '' ? {} : { askVia }), ...(settingsTarget === '' ? {} : { settingsTarget }) }
    }
    const value = parse(json(r.text))
    if (value === null) return { ok: false, status: r.status, error: '응답 모양이 틀림' }

    return { ok: true, status: r.status, value }
  }
  const one = (path: string) => `/api/questions/${encodeURIComponent(path)}`
  const listOf = (v: unknown): RemoteQuestion[] | null => {
    if (!isRecord(v) || !Array.isArray(v.questions)) return null
    const list = v.questions.map(parseQuestion)

    return list.some(q => q === null) ? null : (list as RemoteQuestion[])
  }

  return {
    // 같은 문항을 다시 보내도 서버가 전달 메일을 겹쳐 만들지 않게 내용으로 Idempotency-Key 를 만든다(#176).
    ask: (items, io, relayTo) => {
      // relay_to: 답 원문을 받을 역할들. 비었으면 칸을 뺀다(옛 서버는 모르는 칸을 무시한다).
      const body = JSON.stringify({ questions: items, ...(relayTo === undefined || relayTo.length === 0 ? {} : { relay_to: relayTo }) })

      return go('/api/questions', { method: 'POST', body, headers: { 'Idempotency-Key': `switchboard-ask-${fnv(body)}` } }, io, parseQuestion)
    },
    get: (id, io) => go(one(id), {}, io, parseQuestion),
    list: (q = {}, io) => {
      const params = [
        ...(q.status === undefined ? [] : [`status=${q.status}`]),
        ...(q.limit === undefined ? [] : [`limit=${Math.floor(q.limit)}`]),
      ]

      return go(`/api/questions${params.length === 0 ? '' : `?${params.join('&')}`}`, {}, io, listOf)
    },
    poll: (after, timeoutS = POLL_TIMEOUT_S, io) =>
      go(
        `/api/questions/poll?after=${Math.max(0, Math.floor(after))}&timeout=${Math.max(0, Math.floor(timeoutS))}`,
        {},
        { ...io, timeoutMs: io?.timeoutMs ?? Math.max(0, timeoutS) * 1000 + 15_000 },
        v => {
          const list = listOf(v)

          return list === null || !isRecord(v) || typeof v.cursor !== 'number' ? null : { questions: list, cursor: v.cursor }
        },
      ),
    answer: (id, answers, io) => go(`${one(id)}/answer`, { method: 'POST', body: JSON.stringify({ answers }) }, io, parseQuestion),
    withdraw: (id, io) => go(`${one(id)}/withdraw`, { method: 'POST' }, io, parseQuestion),
  }
}

/** 시스템 보낸이·제목 머리 `<prefix><id> …`·(있으면) 같은 task_id 인 메일의 질문 id. */
const subjectId = (e: Pick<MailEvent, 'sender' | 'subject' | 'task_id'>, prefix: string): string | null => {
  if (!isSystemSender(e.sender)) return null
  const subject = e.subject ?? ''
  if (!subject.startsWith(prefix)) return null
  const id = subject.slice(prefix.length).split(/\s/)[0] ?? ''
  if (!isRemoteId(id)) return null
  if (e.task_id !== undefined && e.task_id !== '' && e.task_id !== id) return null

  return id
}

/** 이 메일이 서버의 질문 답 메일이면 그 질문 id(시스템 보낸이, 제목 `[질문 답] <id> …`, task_id 가 있으면 같아야 한다). */
export const answerMailId = (e: Pick<MailEvent, 'sender' | 'subject' | 'task_id'>): string | null => subjectId(e, ANSWER_SUBJECT_PREFIX)

/** 이 메일이 서버의 새 질문 참조(watcher) 메일이면 그 질문 id(시스템 보낸이, 제목 `[질문] <id> …`, #120). */
export const questionMailId = (e: Pick<MailEvent, 'sender' | 'subject' | 'task_id'>): string | null => subjectId(e, QUESTION_SUBJECT_PREFIX)

/** 문항 하나의 답 글(로컬 답과 같은 꼴: 고른 label 을 「, 」로, 기타 글은 `기타: …`). */
export const remoteChosen = (a: RemoteAnswer | undefined): string => {
  const list = [...(a?.selected ?? [])]
  const other = a?.other?.trim() ?? ''
  if (other !== '') list.push(`기타: ${other}`)

  return list.join(', ')
}

/** 답한 서버 질문을 세션에 넣을 글: 로컬 답(`[질문 패널 답] 질문 = 고른 것`)과 같은 꼴에 서버 id 를 붙인다. */
export const remoteAnswerText = (q: RemoteQuestion): string =>
  [
    ...q.questions.map((item, i) => `[질문 패널 답 ${q.id}] ${item.question} = ${remoteChosen(q.answers?.[i])}`),
    `(원격 질문 ${q.id}의 답 · 답한 쪽: ${q.answered_by || '?'})`,
  ].join('\n')
