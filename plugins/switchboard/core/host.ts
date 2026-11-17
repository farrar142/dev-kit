// AgentHost 포트: 코어가 에이전트(Claude Code 등)에 바라는 것 전부. 코어는 이 파일의 타입만 알고
// 에이전트 API(Claude 모드의 `$`)를 직접 부르지 않는다. 어댑터(adapters/claude.ts)가 이것을 구현하고,
// 시험은 core/testing.ts 의 가짜 어댑터를 쓴다.

/** 타이머 하나. cancel 은 여러 번 불러도 된다. */
export type Timer = { cancel: () => void }

/** 시계. 시험은 가짜 시계(FakeClock)로 시간을 움직인다. */
export type Clock = {
  now: () => Promise<number>
  /** ms 뒤 한 번. */
  after: (ms: number, fn: () => void) => Timer
  /** ms 마다. */
  every: (ms: number, fn: () => void) => Timer
}

export type HttpInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
}

/** 본문을 다 받은 응답. */
export type HttpReply = { status: number; ok: boolean; headers: Record<string, string>; text: string }

/** SSE 이벤트 하나(`event:`·`id:`·`data:` 줄을 모은 것). */
export type SseEvent = { event: string; id?: string; data: string }

/** 열린 SSE 구독. close 뒤에는 onEvent 가 더 불리지 않는다. */
export type SseStream = { close: () => void }

export type Http = {
  fetch: (url: string, init?: HttpInit) => Promise<HttpReply>
  /**
   * SSE 구독(선택). 연결이 끊기면 onEnd 를 한 번 부른다(다시 잇기는 코어 몫).
   * 없으면 그 에이전트 환경은 스트림을 못 연다(Claude 모드의 http 는 본문을 다 받아서만 준다, D1 기준).
   */
  sse?: (url: string, init: HttpInit, on: { onEvent: (e: SseEvent) => void; onEnd: (reason: string) => void }) => SseStream
}

/** 파일. 경로 해석(집 폴더 등)은 어댑터 몫이다. */
export type Fs = {
  /** 글. 없으면 null. */
  read: (path: string) => Promise<string | null>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
}

export type Services = { http: Http; clock: Clock; fs: Fs }

/** 세션이 누구인가. */
export type Identity = {
  sessionId: string
  /** 기계 이름. 에이전트가 모르면 '' (Claude 모드는 기계 이름 API가 없어 환경변수에서 읽는다). */
  machine: string
  /** 작업 폴더. */
  cwd: string
  /** 사람이 띄운 본 세션인가(서브에이전트·도구 루프가 아닌가). 코어는 본 세션에서만 일한다. */
  isMain: boolean
}

/** 컨텍스트 크기. */
export type Usage = { tokens: number; percent?: number }

export type CompactResult = { done: true } | { done: false; reason: string }

/** 포트 이벤트. 서브에이전트의 턴·도구는 어댑터가 걸러 본 세션 것만 보낸다. */
export type HostEvent =
  | { type: 'turn.start' }
  | { type: 'turn.complete' }
  /** 사용자가 입력창의 글을 바꿨다(text 는 바뀐 뒤 전체 글). */
  | { type: 'input.change'; text: string }
  /** 사용자가 글을 제출했다(입력창이 비었다). */
  | { type: 'input.submit'; text: string }
  | { type: 'compact.complete' }

export type Features = {
  /** injectMidTurn 이 있다. */
  midTurnInject: boolean
  /** compact 가 있다. */
  compact: boolean
}

export type AgentHost = {
  identity: () => Promise<Identity>
  features: Features
  services: Services
  /** 새 턴으로 실행한다. 턴이 도는 중이면 끝난 뒤 새 턴으로 간다(끼어들지 않는다). 받아들여지면 풀린다. */
  submitTurn: (text: string) => Promise<void>
  /** 실행 중인 턴의 다음 도구 호출이 끝날 때 끼워 넣는다(선택, features.midTurnInject). */
  /**
   * 붙었으면 true. 턴이 도구 호출 없이 끝나 붙지 못했으면 false 로 풀린다(그 글은 버려진다: 코어가 새 턴으로 넣는다).
   */
  injectMidTurn?: (text: string) => Promise<boolean>
  /** 대화를 줄인다(선택, features.compact). 턴이 도는 중이면 거절된다. */
  compact?: (instructions?: string) => Promise<CompactResult>
  usage: () => Promise<Usage>
  /** 이벤트 구독. 돌려준 함수로 끊는다. */
  on: (listener: (e: HostEvent) => void) => () => void
}
