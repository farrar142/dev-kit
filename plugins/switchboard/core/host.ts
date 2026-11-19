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
  /**
   * 입력창의 글이 바뀌었다(text 는 바뀐 뒤 전체 글). by: person(사람이 치기·붙여 넣기·기록 불러오기·되돌리기),
   * other(플러그인 채우기·엔진 쓰기·지우기 등 사람이 친 글이 아닌 것). 없으면 person 으로 본다.
   */
  | { type: 'input.change'; text: string; by?: 'person' | 'other' }
  /** 사용자가 글을 제출했다(입력창이 비었다). */
  /**
   * 글이 제출됐다. origin: user(사람이 입력창·원격에서 보냄), plugin(플러그인이 넣은 턴: 메일 알림·질문 패널 등),
   * other(예약 작업·SDK 등). 없으면 user 로 본다.
   */
  | { type: 'input.submit'; text: string; origin?: 'user' | 'plugin' | 'other' }
  | { type: 'compact.complete' }
  /** 백그라운드 서브에이전트가 시작·끝났다(id 로 짝을 맞춘다. 같은 id 의 끝이 두 번 와도 한 번만 센다). */
  | { type: 'subagent.start'; id: string }
  | { type: 'subagent.stop'; id: string }
  /**
   * 턴이 API 오류로 멈췄다(D8). kind 는 에이전트가 나눈 오류 종류(rate_limit·overloaded·server_error·billing_error 등).
   * 오류 본문은 싣지 않는다.
   */
  | { type: 'stop.failure'; kind: string }
  /** 에이전트가 사람을 기다린다(D8, 권한 창·입력 대기 등). kind 는 알림 종류(permission_prompt·idle_prompt 등). */
  | { type: 'notification'; kind: string }
  /** 본 세션의 도구 호출 하나가 끝났다(D8: 사람 기다림이 풀린 것으로 본다). */
  | { type: 'tool.complete' }

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
  /**
   * 입력창의 지금 글을 읽는다(선택). 사건이 코어에 닿지 않아 「입력 중」이 남았을 때 실제 글로 바로잡는 데 쓴다(#168).
   * 못 읽으면(던지면) 사건으로 안 값을 그대로 믿는다.
   */
  readInput?: () => Promise<string>
  /** 이벤트 구독. 돌려준 함수로 끊는다. */
  on: (listener: (e: HostEvent) => void) => () => void
}
