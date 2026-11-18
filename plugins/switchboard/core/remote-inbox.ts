// 원격 질문 — 대장 쪽(#112): 대장 역할 세션이 switchboard 서버 질문을 끌어와 로컬 질문 패널에 올리고, 패널의 답을 서버로 보낸다.
//  - 켜는 조건: 대장 판정(core/boss.ts — 서버 whoami 의 is_boss, 옛 서버면 대장 역할 목록 SWITCHBOARD_BOSS_ROLES)이 참일
//    때. 아니면 서버를 부르지 않고 역할만 가끔 다시 본다(번호 역할을 늦게 받는 경우).
//  - 처음: GET /api/questions?status=pending 로 채우고(대기·can_answer 만 패널에), 패널에 남은 대기 원격 묶음 중 서버 대기
//    목록에 없는 것은 닫는다(세션이 꺼진 사이 답이 났다). 커서는 그 목록과 최신 한 건의 seq 중 큰 값.
//  - 그 뒤: GET /api/questions/poll?after=<커서> 긴 대기 반복. pending·can_answer 는 올리고, answered·withdrawn 은 패널에서 닫는다.
//    같은 서버 id 는 두 번 올리지 않는다(이 세션의 기억 + 패널 큐에 같은 id 가 있으면 sink 가 거른다).
//  - 연결 실패·서버 오류는 간격을 두 배씩 늘려(상한 있음) 다시 해 본다. 400(커서가 틀림)이면 처음부터 다시 채운다.
//  - 답: POST /api/questions/{id}/answer. 200 ok, 409·404 closed(이미 답함·거둠·없음), 그 밖 failed.
//    답은 이 세션의 턴으로 넣지 않는다 — 묻는 세션이 답 메일로 받는다.
//  - 자기 질문(#138): 이 역할이 물은 질문(own)은 can_answer 가 거짓이어도 한 번 올린다(묻는 쪽은 패널에 따로 띄우지 않는다).
//    패널 답은 서버로 먼저 보내고, 서버가 받지 않으면(403·연결 실패 등) 거두고(withdraw) 답 글을 이 세션에 직접 넣게
//    돌려준다(self). 그때 settle 로 뒤에 오는 답 메일을 막는다.
import type { AgentHost, Timer } from './host'
import type { Mailbox } from './mailbox'
import { POLL_TIMEOUT_S } from './mailbox'
import { isBossRole } from './boss'
import type { RemoteAnswerOutcome } from './questions'
import { createQuestionsApi, remoteAnswerText } from './remote-questions'
import type { QuestionsApi, RemoteAnswer, RemoteQuestion } from './remote-questions'

/** 패널 쪽(어댑터가 질문 패널 코어로 잇는다). */
export type RemoteSink = {
  /** 대기 질문을 패널에 올린다. 같은 서버 id 가 이미 큐에 있으면 아무것도 안 한다. */
  offer: (q: RemoteQuestion) => Promise<void>
  /** 답이 났거나 거둔 질문을 패널에서 닫는다(없거나 이미 닫혔으면 아무것도 안 한다). */
  close: (q: RemoteQuestion) => Promise<void>
  /** 서버 대기 목록에 없는 대기 원격 묶음을 닫는다(처음 채울 때). */
  prune: (open: ReadonlySet<string>) => Promise<void>
}

export type RemoteInboxOptions = {
  /** 대장 역할 목록(바탕 이름). 비면 아무 세션도 대장이 아니다. isBoss 가 있으면 쓰지 않는다. */
  bosses: readonly string[]
  /** 대장 판정(core/boss.ts, whoami). 없으면 bosses 목록으로 본다. */
  isBoss?: () => boolean
  sink: RemoteSink
  /** 긴 대기 한 번(초, 서버 상한 55). */
  timeoutS?: number
  /** 실패 뒤 다시 해 볼 간격(ms): 처음 first, 두 배씩, max 까지. */
  retry?: { firstMs: number; maxMs: number }
  /** 대장이 아닐 때 역할을 다시 볼 간격(ms). */
  idleMs?: number
  log?: (text: string) => void
  /** 이 역할이 물은 질문인가(remote-ask owns). */
  own?: (q: RemoteQuestion) => boolean
  /** 자기 질문의 답을 세션에 직접 넣는다: 뒤에 오는 답 메일을 막는다(remote-ask settle). */
  settle?: (id: string) => void
}

export type RemoteInbox = {
  start: () => void
  stop: () => void
  /** 패널 답을 서버로. */
  answer: (id: string, answers: readonly RemoteAnswer[]) => Promise<RemoteAnswerOutcome>
  /** 지금 끌어오는 중인가(대장 역할이고 루프가 돈다). */
  active: () => boolean
  /** 대장 판정이 바뀌었을 수 있다: 대장이 아니라 쉬는 중이면 곧 다시 본다. */
  recheck: () => void
}

export const REMOTE_RETRY = { firstMs: 5_000, maxMs: 300_000 }
export const REMOTE_IDLE_MS = 60_000
/** 이 세션이 올린 서버 id 를 이만큼 기억한다. */
const REMEMBER = 500

export { isBossRole }

export const createRemoteInbox = (
  host: Pick<AgentHost, 'services'>,
  mail: Pick<Mailbox, 'call' | 'state'>,
  opts: RemoteInboxOptions,
  api: QuestionsApi = createQuestionsApi(mail.call),
): RemoteInbox => {
  const clock = host.services.clock
  const timeoutS = Math.max(1, Math.min(POLL_TIMEOUT_S, opts.timeoutS ?? POLL_TIMEOUT_S))
  const retry = opts.retry ?? REMOTE_RETRY
  const idleMs = opts.idleMs ?? REMOTE_IDLE_MS
  const log = (t: string) => {
    try {
      opts.log?.(t)
    } catch {
      // 기록이 실패해도 간다.
    }
  }
  let running = false
  let polling = false
  let generation = 0
  let wake: { timer: Timer; done: () => void } | undefined
  const seen: string[] = []
  const remember = (id: string) => {
    seen.push(id)
    if (seen.length > REMEMBER) seen.shift()
  }
  /** 패널에 올린 자기 질문(답 글을 만들 문항). */
  const owned = new Map<string, RemoteQuestion>()
  const isOwn = (q: RemoteQuestion) => {
    try {
      return opts.own?.(q) === true
    } catch {
      return false
    }
  }

  const sleep = (ms: number) =>
    new Promise<void>(done => {
      const timer = clock.after(ms, () => {
        wake = undefined
        done()
      })
      wake = { timer, done }
    })

  const take = async (q: RemoteQuestion) => {
    try {
      if (q.status === 'pending') {
        const own = isOwn(q)
        if ((!q.can_answer && !own) || seen.includes(q.id)) return
        remember(q.id)
        if (own) {
          owned.set(q.id, q)
          if (owned.size > REMEMBER) owned.delete(owned.keys().next().value as string)
        }
        await opts.sink.offer(q)
        log(`switchboard 질문: 원격 질문 ${q.id}(${q.asker || '?'})을 패널에 올렸다`)

        return
      }
      owned.delete(q.id)
      await opts.sink.close(q)
    } catch {
      // 패널에 못 올려도 루프는 간다.
    }
  }

  /** 처음 채우기: 대기 목록 + 최신 한 건으로 커서. 실패면 null. */
  const fill = async (): Promise<number | null> => {
    const pending = await api.list({ status: 'pending' })
    if (!pending.ok) return null
    const newest = await api.list({ limit: 1 })
    if (!newest.ok) return null
    const list = [...pending.value].sort((a, b) => a.seq - b.seq)
    for (const q of list) await take(q)
    try {
      await opts.sink.prune(new Set(list.map(q => q.id)))
    } catch {
      // 닫기 실패는 다음에.
    }

    return Math.max(0, ...list.map(q => q.seq), ...newest.value.map(q => q.seq))
  }

  const loop = async (gen: number) => {
    let cursor: number | null = null
    let delay = retry.firstMs
    const live = () => running && gen === generation
    const fail = async (why: string) => {
      log(`switchboard 질문: 원격 질문을 못 읽음(${why}) — ${Math.round(delay / 1000)}초 뒤 다시`)
      await sleep(delay)
      delay = Math.min(retry.maxMs, delay * 2)
    }
    while (live()) {
      if (!(opts.isBoss ?? (() => isBossRole(mail.state().role, opts.bosses)))()) {
        polling = false
        cursor = null
        await sleep(idleMs)
        continue
      }
      polling = true
      if (cursor === null) {
        const c = await fill()
        if (!live()) break
        if (c === null) {
          await fail('목록')
          continue
        }
        cursor = c
        delay = retry.firstMs
        continue
      }
      const r = await api.poll(cursor, timeoutS)
      if (!live()) break
      if (!r.ok) {
        // 400: 커서가 틀렸다(서버가 바뀌었다 등) — 처음부터 다시 채운다.
        if (r.status === 400) cursor = null
        await fail(r.status === null ? '서버에 닿지 않음' : `HTTP ${r.status}`)
        continue
      }
      delay = retry.firstMs
      for (const q of r.value.questions) await take(q)
      cursor = Math.max(cursor, r.value.cursor)
    }
    if (gen === generation) polling = false
  }

  const start = () => {
    if (running) return
    running = true
    generation++
    void loop(generation)
  }

  const recheck = () => {
    if (!running || polling) return
    const w = wake
    wake = undefined
    w?.timer.cancel()
    w?.done()
  }

  const stop = () => {
    running = false
    generation++
    polling = false
    const w = wake
    wake = undefined
    w?.timer.cancel()
    w?.done()
  }

  const answer = async (id: string, answers: readonly RemoteAnswer[]): Promise<RemoteAnswerOutcome> => {
    const r = await api.answer(id, answers)
    if (r.ok) {
      log(`switchboard 질문: 원격 질문 ${id}에 답했다`)

      return { kind: 'ok' }
    }
    if (r.status === 409) return { kind: 'closed', reason: '이미 답이 났거나 거둔 질문(409)' }
    if (r.status === 404) return { kind: 'closed', reason: '서버에 없는 질문(404)' }
    const mine = owned.get(id)
    if (mine !== undefined) {
      // 자기 질문을 서버가 답으로 받지 않았다(대표만 답하는 질문 등): 거두고 답은 이 세션에 직접 넣는다.
      opts.settle?.(id)
      owned.delete(id)
      const w = await api.withdraw(id)
      if (!w.ok && w.status === 409) log(`switchboard 질문: 원격 질문 ${id}은 이미 답이 났거나 거둬졌다 — 패널 답을 넣는다`)
      log(`switchboard 질문: 원격 질문 ${id}(자기 질문) 패널 답을 세션에 넣는다(서버 답 ${r.status ?? '연결 실패'})`)

      return { kind: 'self', text: remoteAnswerText({ ...mine, answers: [...answers], answered_by: '이 세션 패널' }) }
    }
    if (r.status === null) return { kind: 'failed', reason: '서버에 닿지 않음' }
    if (r.status === 403) return { kind: 'failed', reason: '이 역할은 이 질문에 답할 수 없음(403)' }

    return { kind: 'failed', reason: `HTTP ${r.status}: ${r.error}` }
  }

  return { start, stop, answer, active: () => running && polling, recheck }
}
