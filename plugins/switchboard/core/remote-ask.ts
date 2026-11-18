// 원격 질문 — 묻는 쪽(#111): 프로필이 있는 세션의 ask 를 switchboard 서버 질문으로 올리고, 답 메일을 세션 입력으로 바꾸고,
// resolve 를 거두기로 잇는다.
//  - 올리기: POST /api/questions(대장 세션도, #138). 201 이면 서버 질문, 403(can_ask 꺼짐)·409(옛 서버: 답할 대장 없음 — 결과에
//    까닭을 붙이지 않는다)·400(모양)·연결 실패·5xx 면 로컬 패널로.
//    메일함이 꺼져 있으면(프로필 없음) 묻지 않고 로컬(까닭 없음).
//  - 서버 질문은 이 세션의 로컬 패널에 올리지 않는다: 묻는 쪽 패널에 선택지가 뜨면 묻는 쪽(이 세션의 사람·Orca 사이드바)이
//    스스로 답해 버릴 수 있고, 그 답은 서버로 가지 않아 대장·대시보드의 같은 질문과 갈라진다. 손잡이는 서버 id(q_…)다.
//  - 답 메일: 서버가 묻는 역할 앞으로 보내는 시스템 메일(`switchboard/system`·옛 `agent-mail/system`, 제목 `[질문 답] <id> …`,
//    task_id = id). 이 역할 몫이면 메일함이 긴급과 같은 길로 바로 넣는다(사람 보류·입력 중 미룸 없음, #144).
//    이 역할이 물은 질문인지는 이 세션이 올린 id 목록, 없으면(compact·재시작 뒤) GET /api/questions/{id} 의 asker base 로 본다.
//    참조(watcher) 사본(다른 역할의 질문)은 손대지 않는다(평소 시스템 통지 그대로). 답 글은 보기(view)의 문항·답으로 만든다.
//  - 대장 세션(#120·#130): 원격 질문 대장 쪽이 켜지는 세션(대장 판정 isBoss, 없으면 bosses 목록)은 참조 메일
//    「[질문] q_…」「[질문 답] q_…」(이 역할이 물은 질문의 답이 아닌 것)을 세션에 넣지 않고 read 로만 표시한다 — 같은 질문이
//    대장 패널에 이미 뜬다(패널이 정본). 이 역할이 물은 질문의 답은 대장이어도 위처럼 넣는다.
//  - 대장 자기 질문(#138): 대장 세션이 올린 질문은 묻는 쪽 패널이 아니라 같은 세션의 대장 끌어오기(remote-inbox)가 한 번 띄운다
//    (owns). 패널 답을 서버가 받지 않아 이 세션이 답을 직접 넣었으면(settle) 그 뒤 오는 답 메일은 넣지 않는다.
import type { QuestionPanelQuestion } from '../types'
import { DROP_NOTICE } from './mailbox'
import type { CallIo, Mailbox, MailEvent, NoticeDrop } from './mailbox'
import { baseOf } from './permission'
import { isBossRole } from './boss'
import { answerMailId, createQuestionsApi, isRemoteId, questionMailId, remoteAnswerText, toRemoteItems } from './remote-questions'
import type { QuestionsApi, RemoteQuestion } from './remote-questions'
import { GROUP_REFUSAL } from './wire'

/** ask 결과: 서버 질문이면 그 id, 로컬이면 까닭(메일함이 꺼져 시도하지 않았으면 null). */
/** here: 이 세션의 대장 패널에도 뜬다(대장 세션). */
export type RemoteAskResult = { kind: 'remote'; id: string; asker: string; here: boolean } | { kind: 'local'; reason: string | null }

/** 거두기 결과. */
export type WithdrawResult = { ok: true } | { ok: false; status: number | null; reason: string }

export type RemoteAsk = {
  ask: (questions: readonly QuestionPanelQuestion[], io?: CallIo) => Promise<RemoteAskResult>
  withdraw: (id: string, io?: CallIo) => Promise<WithdrawResult>
  /**
   * 메일함 시스템 통지 가로채기(onNotice 에 단다): 이 역할이 물은 질문의 답 메일이면 넣을 글, 대장 세션의 참조 메일이면
   * DROP_NOTICE, 아니면 null.
   */
  noticeText: (e: MailEvent, body: string) => Promise<string | null | NoticeDrop>
  /** 이 역할이 물은 질문인가(이 세션이 올린 id 거나 asker 가 같은 base). */
  owns: (q: Pick<RemoteQuestion, 'id' | 'asker'>) => boolean
  /** 이 질문의 답을 세션에 직접 넣었다: 뒤에 오는 답 메일은 넣지 않는다. */
  settle: (id: string) => void
  api: QuestionsApi
}

/** 이 세션이 올린 서버 질문 id 를 이만큼 기억한다(그 밖은 서버에 묻는다). */
export const REMEMBER_IDS = 100

export type RemoteAskOptions = {
  log?: (text: string) => void
  /** 대장 역할 목록(원격 질문 대장 쪽이 켜질 때만 준다). 지금 역할이 여기 들면 참조 메일을 넣지 않는다(#120). */
  bosses?: readonly string[]
  /** 대장 판정(core/boss.ts, whoami). 있으면 bosses 대신 쓴다. */
  isBoss?: () => boolean
}

export const createRemoteAsk = (mail: Pick<Mailbox, 'call' | 'state'>, opts: RemoteAskOptions = {}): RemoteAsk => {
  const api = createQuestionsApi(mail.call)
  const log = (t: string) => {
    try {
      opts.log?.(t)
    } catch {
      // 기록이 실패해도 간다.
    }
  }
  const mine: string[] = []
  const remember = (id: string) => {
    if (!mine.includes(id)) mine.push(id)
    if (mine.length > REMEMBER_IDS) mine.shift()
  }

  const boss = () => (opts.isBoss === undefined ? isBossRole(mail.state().role, opts.bosses ?? []) : opts.isBoss())

  const ask = async (questions: readonly QuestionPanelQuestion[], io?: CallIo): Promise<RemoteAskResult> => {
    if (mail.state().status === 'off') return { kind: 'local', reason: null }
    const r = await api.ask(toRemoteItems(questions), io)
    if (r.ok) {
      remember(r.value.id)
      log(`switchboard 질문: 원격 질문 ${r.value.id} 를 올렸다`)

      return { kind: 'remote', id: r.value.id, asker: r.value.asker, here: boss() }
    }
    const reason =
      r.status === null
        ? `서버에 닿지 않음`
        : r.status === 403
          ? r.error === GROUP_REFUSAL
            ? `${GROUP_REFUSAL}(403)`
            : `이 역할은 질문을 올릴 수 없음(can_ask 꺼짐, 403)`
          : r.status === 409
            ? `답할 대장 역할이 없음(409)`
            : r.status === 400
              ? `서버가 질문 모양을 거절함(400: ${r.error})`
              : `서버 오류(HTTP ${r.status}: ${r.error})`
    log(`switchboard 질문: 원격으로 못 올려 로컬 패널로 — ${reason}`)

    // 409 는 옛 서버(대장 질문을 받지 않음)다: 평소 로컬과 같게 까닭을 결과에 붙이지 않는다(#138).
    return { kind: 'local', reason: r.status === 409 ? null : reason }
  }

  const withdraw = async (id: string, io?: CallIo): Promise<WithdrawResult> => {
    const r = await api.withdraw(id, io)
    if (r.ok) return { ok: true }
    const reason =
      r.status === null
        ? '서버에 닿지 않음'
        : r.status === 409
          ? '이미 답이 났거나 거둔 질문(409)'
          : r.status === 404
            ? '서버에 없는 질문(404)'
            : r.status === 403
              ? '이 역할이 올린 질문이 아님(403)'
              : `HTTP ${r.status}: ${r.error}`

    return { ok: false, status: r.status, reason }
  }

  const settled: string[] = []
  const settle = (id: string) => {
    if (!settled.includes(id)) settled.push(id)
    if (settled.length > REMEMBER_IDS) settled.shift()
  }
  const sameBase = (asker: string) => {
    const role = mail.state().role ?? ''

    return role !== '' && asker !== '' && baseOf(asker) === baseOf(role)
  }
  const owns = (q: Pick<RemoteQuestion, 'id' | 'asker'>) => mine.includes(q.id) || sameBase(q.asker)

  const noticeText = async (e: MailEvent, body: string): Promise<string | null | NoticeDrop> => {
    // 새 질문 참조 메일: 대장 세션이면 패널이 정본이라 넣지 않는다.
    if (questionMailId(e) !== null) return boss() ? DROP_NOTICE : null
    const id = answerMailId(e)
    if (id === null) return null
    // 패널 답을 이미 세션에 넣은 자기 질문(#138): 답이 두 번 들어가지 않게 한다.
    if (settled.includes(id)) return DROP_NOTICE
    const known = mine.includes(id)
    const got = await api.get(id)
    const view = got.ok ? got.value : null
    // 이 역할(base)이 물은 질문인가: 이 세션이 올렸거나, 서버 보기의 asker 가 같은 base 다. 참조 사본은 여기서 빠진다.
    const owned = known || (view !== null && sameBase(view.asker))
    if (!owned) return boss() ? DROP_NOTICE : null
    if (view !== null && view.status === 'answered' && view.answers !== null) return remoteAnswerText(view)
    // 보기를 못 읽었다(끊김 등): 서버가 쓴 본문(문항별 「질문 = 고른 것」)을 그대로 같은 머리로 넣는다.
    const lines = body
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '')

    return [...lines.map(l => (l.startsWith('답한 쪽:') ? `(원격 질문 ${id}의 ${l})` : `[질문 패널 답 ${id}] ${l}`))].join('\n')
  }

  return { ask, withdraw, noticeText, owns, settle, api }
}

/** 서버 질문으로 올렸을 때 모델이 읽을 결과 글. 「질문 묶음 qN」을 쓰지 않는다(MCP 서버가 Orca 카드로 옮기지 않게). */
export const remoteAskText = (id: string, asker: string, resolveTool: string, here = false) =>
  [
    here
      ? `원격 질문 ${id} 로 올렸다(switchboard 서버, 묻는 역할 ${asker || '?'}). 이 세션의 질문 패널과 관리 대시보드에 뜬다.`
      : `원격 질문 ${id} 로 올렸다(switchboard 서버, 묻는 역할 ${asker || '?'}). 이 세션의 질문 패널에는 띄우지 않는다 — 대장 세션의 패널이나 관리 대시보드에서 사람이 답한다.`,
    `질문을 대화창에 다시 쓰지 말고 「원격 질문으로 올렸습니다(${id})」 정도로 짧게 말하고 턴을 마쳐라. AskUserQuestion으로 다시 묻지 마라.`,
    `답은 「[질문 패널 답 ${id}] 질문 = 고른 것」 메시지로 온다(세션이 compact·재시작돼도 역할 주소 메일로 온다). 답을 받기 전에 필요 없어지면 ${resolveTool}(id=${id})로 거둬라.`,
  ].join('\n')

/** 로컬 패널로 돌아갔을 때 결과 글 앞에 붙일 한 줄. */
export const localFallbackLine = (reason: string) => `원격 질문으로 올리지 못해 로컬 패널에 올렸다(${reason}).`

/** resolve(서버 질문) 결과 글. */
export const withdrawText = (id: string, r: WithdrawResult) =>
  r.ok
    ? `원격 질문 ${id}을 거뒀다(withdrawn). 패널·대시보드에서 닫힌다.`
    : r.status === 409
      ? `원격 질문 ${id}은 거두지 못했다: 이미 답이 났거나 거둔 질문이다. 답이 났으면 「[질문 패널 답 ${id}] …」 메시지가 온다.`
      : `원격 질문 ${id}을 거두지 못했다: ${r.reason}.`

export { isRemoteId }
