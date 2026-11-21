// 코어 시험 틀: 가짜 AgentHost·가짜 시계·가짜 http·가짜 fs. 에이전트 없이 코어를 바깥에서 시험한다.
// D2 이후(메일함) 시험도 이것을 쓴다: http 에 가짜 switchboard 서버 경로를 달고, clock.advance 로 시간을 움직인다.
import type {
  AgentHost,
  Clock,
  CompactResult,
  Features,
  Fs,
  HostEvent,
  Http,
  HttpInit,
  HttpReply,
  Identity,
  SseEvent,
  Timer,
  Usage,
} from './host'

/** 가짜 시계: advance 로만 시간이 간다. 그 사이 걸린 타이머를 시각 순서대로 부른다. */
export type FakeClock = Clock & {
  /** 지금 시각(동기). */
  time: () => number
  /** ms 만큼 시간을 보내며 타이머를 부른다. 타이머가 쌓은 비동기 일도 마저 돌린다. */
  advance: (ms: number) => Promise<void>
  /** 걸려 있는 타이머 수. */
  pending: () => number
}

/** 쌓인 마이크로태스크를 다 돌린다. */
export const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

export const fakeClock = (start = 1_000_000): FakeClock => {
  let now = start
  let seq = 0
  type Slot = { at: number; seq: number; every?: number; fn: () => void; live: boolean }
  const slots: Slot[] = []
  const add = (ms: number, fn: () => void, every?: number): Timer => {
    const slot: Slot = { at: now + Math.max(0, ms), seq: seq++, fn, live: true, ...(every === undefined ? {} : { every }) }
    slots.push(slot)

    return { cancel: () => void (slot.live = false) }
  }

  return {
    now: async () => now,
    time: () => now,
    after: (ms, fn) => add(ms, fn),
    every: (ms, fn) => add(ms, fn, Math.max(1, ms)),
    pending: () => slots.filter(s => s.live).length,
    advance: async ms => {
      const end = now + ms
      for (;;) {
        const due = slots.filter(s => s.live && s.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
        if (due === undefined) break
        now = due.at
        if (due.every === undefined) due.live = false
        else due.at += due.every
        due.fn()
        await flush()
      }
      now = end
      await flush()
    },
  }
}

/** 가짜 http 의 경로 처리기. 돌려준 값이 응답이다. */
export type Route = (req: { url: string; init: HttpInit }) => Partial<HttpReply> | Promise<Partial<HttpReply>>

export type FakeSse = {
  url: string
  init: HttpInit
  /** 서버 쪽에서 이벤트를 보낸다. */
  push: (e: SseEvent) => void
  /** 서버 쪽에서 끊는다. */
  end: (reason?: string) => void
  closed: () => boolean
}

export type FakeHttp = Http & {
  /** 들어온 요청(시각 순). */
  requests: { url: string; init: HttpInit }[]
  /** 앞에서부터 맞는(startsWith) 경로에 처리기를 단다. 나중에 단 것이 이긴다. */
  route: (prefix: string, handler: Route) => void
  /** 열린(또는 열렸던) SSE 구독들. */
  streams: FakeSse[]
}

export const fakeHttp = (opts: { sse?: boolean } = {}): FakeHttp => {
  const routes: { prefix: string; handler: Route }[] = []
  const requests: { url: string; init: HttpInit }[] = []
  const streams: FakeSse[] = []
  const http: FakeHttp = {
    requests,
    streams,
    route: (prefix, handler) => void routes.unshift({ prefix, handler }),
    fetch: async (url, init = {}) => {
      requests.push({ url, init })
      const r = routes.find(x => url.startsWith(x.prefix))
      if (r === undefined) return { status: 404, ok: false, headers: {}, text: '' }
      const out = await r.handler({ url, init })
      const status = out.status ?? 200

      return { status, ok: out.ok ?? (status >= 200 && status < 300), headers: out.headers ?? {}, text: out.text ?? '' }
    },
  }
  if (opts.sse !== false) {
    http.sse = (url, init, on) => {
      let closed = false
      const s: FakeSse = {
        url,
        init,
        push: e => {
          if (!closed) on.onEvent(e)
        },
        end: (reason = 'closed') => {
          if (closed) return
          closed = true
          on.onEnd(reason)
        },
        closed: () => closed,
      }
      streams.push(s)

      return { close: () => void (closed = true) }
    }
  }

  return http
}

export type FakeFs = Fs & { files: Map<string, string> }

export const fakeFs = (files: Record<string, string> = {}): FakeFs => {
  const map = new Map(Object.entries(files))

  return {
    files: map,
    read: async p => map.get(p) ?? null,
    write: async (p, t) => void map.set(p, t),
    exists: async p => map.has(p),
  }
}

export type FakeHost = AgentHost & {
  clock: FakeClock
  http: FakeHttp
  fs: FakeFs
  /** submitTurn 으로 들어온 글(받아들여진 순). */
  turns: string[]
  /** injectMidTurn 으로 들어와 도구 결과에 붙은 글. */
  injected: string[]
  /** 본 세션 도구 호출 하나가 끝났다: 기다리던 끼워 넣기를 붙인다(Claude 의 PostToolUse 자리). */
  toolCall: () => void
  /** compact 호출의 instructions. */
  compacts: (string | undefined)[]
  /** 이벤트를 보낸다(에이전트 쪽 흉내). */
  emit: (e: HostEvent) => void
  /** 다음 submitTurn 을 이 오류로 실패시킨다. */
  failNextSubmit: (reason?: string) => void
  setUsage: (u: Usage) => void
  /** readInput 이 돌려줄 입력창 글(사건 없이 바꾼다: 코어에 안 닿은 바뀜 흉내). 기본은 null = readInput 없음. */
  setInputBox: (text: string | null) => void
  /** compact 가 돌려줄 값(기본 done). done 이면 compact.complete 이벤트를 곧 보낸다. */
  setCompactResult: (r: CompactResult) => void
  /**
   * 받아들인 compact 의 끝: complete(기본, 곧 compact.complete), silent(받아들였다고 하고 완료 이벤트 없음 —
   * resume 직후 실제로 시작되지 않은 경우), hang(호출이 풀리지 않음).
   */
  setCompactBehavior: (b: CompactBehavior) => void
  /** 듣는 쪽 수. */
  listeners: () => number
}

export type CompactBehavior = 'complete' | 'silent' | 'hang'

/**
 * 가짜 어댑터. 기능 플래그를 끄면 그 메서드도 없앤다(실제 어댑터가 기능을 못 줄 때와 같다).
 * Claude 처럼 실제 서비스가 조건부로 하는 일도 흉내 낸다: 턴이 도는 중이면 compact 를 거절한다.
 */
export const fakeHost = (
  opts: { identity?: Partial<Identity>; features?: Partial<Features>; clock?: FakeClock; sse?: boolean } = {},
): FakeHost => {
  const features: Features = { midTurnInject: true, compact: true, ...opts.features }
  const clock = opts.clock ?? fakeClock()
  const http = fakeHttp({ sse: opts.sse ?? true })
  const fs = fakeFs()
  const listeners = new Set<(e: HostEvent) => void>()
  const turns: string[] = []
  const injected: string[] = []
  const compacts: (string | undefined)[] = []
  let failSubmit: string | undefined
  let usage: Usage = { tokens: 0 }
  let inputBox: string | null = null
  let compactResult: CompactResult = { done: true }
  let compactBehavior: CompactBehavior = 'complete'
  let running = false
  // 끼워 넣기는 Claude 처럼 다음 도구 호출에서야 붙고, 도구 호출 없이 턴이 끝나면 버려진다(false).
  let box: { text: string; done: (attached: boolean) => void }[] = []
  const drain = (attached: boolean) => {
    const out = box
    box = []
    for (const w of out) {
      if (attached) injected.push(w.text)
      w.done(attached)
    }
  }
  const emit = (e: HostEvent) => {
    if (e.type === 'turn.start') running = true
    if (e.type === 'turn.complete') {
      running = false
      drain(false)
    }
    for (const l of [...listeners]) l(e)
  }

  const host: FakeHost = {
    identity: async () => ({ sessionId: 'sess-1', machine: 'box-a', cwd: '/work/repo', isMain: true, ...opts.identity }),
    features,
    services: { http, clock, fs },
    clock,
    http,
    fs,
    turns,
    injected,
    toolCall: () => drain(true),
    compacts,
    emit,
    failNextSubmit: (reason = 'submit failed') => void (failSubmit = reason),
    setUsage: u => void (usage = u),
    setInputBox: t => void (inputBox = t),
    readInput: async () => {
      if (inputBox === null) throw new Error('input unreadable')

      return inputBox
    },
    setCompactResult: r => void (compactResult = r),
    setCompactBehavior: b => void (compactBehavior = b),
    listeners: () => listeners.size,
    submitTurn: async text => {
      if (failSubmit !== undefined) {
        const reason = failSubmit
        failSubmit = undefined
        throw new Error(reason)
      }
      turns.push(text)
    },
    usage: async () => usage,
    on: l => {
      listeners.add(l)

      return () => void listeners.delete(l)
    },
  }
  if (features.midTurnInject) host.injectMidTurn = text => new Promise<boolean>(done => void box.push({ text, done }))
  if (features.compact) {
    host.compact = async instructions => {
      if (running) throw new Error('turn is running')
      compacts.push(instructions)
      const r = compactResult
      if (r.done && compactBehavior === 'hang') return new Promise<CompactResult>(() => {})
      if (r.done && compactBehavior === 'complete') clock.after(0, () => emit({ type: 'compact.complete' }))

      return r
    }
  }

  return host
}
