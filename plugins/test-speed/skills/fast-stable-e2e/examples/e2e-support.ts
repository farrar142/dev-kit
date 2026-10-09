// E2E 공용 도우미: 폴링 없이 「이벤트」으로만 기다린다.
//
// - 실시간 스트림(EventSource·WebSocket) 메시지를 종류별로 세고 마지막 것을 쥔다(`watchStreams`).
// - 화면 안 조건을 DOM 바뀜(MutationObserver)·크기 바뀜(ResizeObserver)·전환/애니메이션 끝·스크롤·스트림 메시지가
//   올 때마다 한 번씩 다시 본다(`until` → `waitFor`·`waitForIn`·`arm`·`waitForMessage`…). 시간 간격으로 묻지 않는다.
// - 행동 하나의 쓰기 응답(과 그 뒤 스트림 메시지)을 기다린다(`act`).
// - 시험 안에서 연 브라우저 맥락을 시험 뒤에 닫는다(`test`).
//
// 저장소에 맞게 바꿀 곳: 메시지의 종류 필드(`typeField`), SSE 이름 붙은 이벤트(`sseEvents`), `act`의 쓰기 판정.
// 이 파일만 lint의 폴링 금지에서 뺀다(examples/eslint.e2e.mjs).
import { test as base, type BrowserContext, type Locator, type Page } from '@playwright/test'

declare global {
  interface Window {
    __e2eSeen?: Record<string, number>
    __e2eLast?: Record<string, StreamMessage>
    __e2eArmed?: Record<string, Promise<unknown>>
  }
}

/** 스트림으로 온 메시지 하나. `type`은 종류 필드(또는 SSE 이벤트 이름)에서 온다. */
export type StreamMessage = { type: string; [field: string]: unknown }

type WatchOptions = { typeField: string; sseEvents: string[] }

/**
 * init script로 페이지 안에서 돈다 — 바깥 이름을 쓰지 않는다. EventSource·WebSocket을 감싸, 메시지마다 종류별 수를
 * 더하고(`__e2eSeen`), 종류별 마지막 것을 쥐고(`__e2eLast`), `window`에 `e2e:message` 이벤트를 낸다. 감싼 리스너는
 * 생성자에서 달려 앱의 리스너보다 먼저 돈다 — 이벤트가 날 때 앱은 아직 그리지 않았다(그린 것은 DOM 바뀜으로 본다).
 */
function installStreamWatch({ typeField, sseEvents }: WatchOptions) {
  window.__e2eSeen = {}
  window.__e2eLast = {}
  const record = (data: unknown, name?: string) => {
    if (typeof data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      parsed = { data }
    }
    const body = (parsed && typeof parsed === 'object' ? parsed : { data: parsed }) as Record<string, unknown>
    const type = String(name ?? body[typeField] ?? 'message')
    const message = { ...body, type }
    window.__e2eSeen![type] = (window.__e2eSeen![type] ?? 0) + 1
    window.__e2eLast![type] = message
    window.dispatchEvent(new CustomEvent('e2e:message', { detail: message }))
  }
  const NativeEventSource = window.EventSource
  if (NativeEventSource) {
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init)
        this.addEventListener('message', (e) => record((e as MessageEvent).data))
        for (const name of sseEvents) this.addEventListener(name, (e) => record((e as MessageEvent).data, name))
      }
    } as typeof EventSource
  }
  const NativeWebSocket = window.WebSocket
  if (NativeWebSocket) {
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        this.addEventListener('message', (e) => record(e.data))
      }
    } as typeof WebSocket
  }
}

/** 페이지를 열기 전에(첫 `goto` 전) 부른다. 이미 열린 문서에는 다음 탐색부터 걸린다. */
export async function watchStreams(page: Page, options: Partial<WatchOptions> = {}) {
  await page.addInitScript(installStreamWatch, { typeField: 'type', sseEvents: [], ...options })
}

/**
 * 페이지 안에서 `check(arg)`가 참이 되기를 이벤트로 기다린다. 바꿀 수 있는 이벤트가 올 때마다 한 번 다시 보고,
 * 참이 된 값으로 풀린다. 페이지 안에서 도는 함수라 바깥 이름을 쓰지 않는다(소스로 넘긴다). 스스로 시간 제한을
 * 두지 않는다 — 시험의 제한 시간이 끊는다(무엇을 기다렸는지는 `test.step` 이름으로 남긴다).
 */
function until(check: (arg: unknown) => unknown, arg: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let done = false
    const events = ['e2e:message', 'transitionend', 'animationend', 'resize', 'scroll']
    const mutations = new MutationObserver(() => look())
    const sizes = new ResizeObserver(() => look())
    const stop = () => {
      done = true
      mutations.disconnect()
      sizes.disconnect()
      for (const type of events) window.removeEventListener(type, look, true)
    }
    function look() {
      if (done) return
      let value: unknown
      try {
        value = check(arg)
      } catch (error) {
        stop()
        reject(error)
        return
      }
      if (value) {
        stop()
        resolve(value)
      }
    }
    look()
    if (done) return
    mutations.observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
    if (document.documentElement) sizes.observe(document.documentElement)
    for (const type of events) window.addEventListener(type, look, true)
  })
}

const UNTIL = until.toString()

/** 페이지 안에서 `until(check, arg)`를 부르는 식. `page.evaluate`는 함수 인자를 둘 받지 못해 소스로 넘긴다. */
const untilExpression = (check: string, arg: unknown) => `(${UNTIL})(${check}, ${JSON.stringify(arg ?? null)})`

/** 화면 안 조건(DOM·배치·전역 값)이 참이 되기를 기다린다. `check`는 페이지 안에서 돈다 — 바깥 값은 `arg`로. */
export async function waitFor<A, R>(page: Page, check: (arg: A) => R, arg?: A): Promise<Awaited<R>> {
  return (await page.evaluate(untilExpression(check.toString(), arg))) as Awaited<R>
}

/** 요소 하나를 두고 `waitFor`처럼 기다린다 — `check(el, arg)`. 요소 찾기는 locator가 한다. */
export async function waitForIn<A, R>(locator: Locator, check: (el: Element, arg: A) => R, arg?: A): Promise<Awaited<R>> {
  return (await locator.evaluate(
    (el, [untilSource, checkSource, a]) => {
      const revive = (source: string) => new Function(`return (${source})`)()
      return revive(untilSource)((x: unknown) => revive(checkSource)(el, x), a)
    },
    [UNTIL, check.toString(), arg ?? null] as const,
  )) as Awaited<R>
}

/**
 * 행동 **전에** 기다림을 걸어 둔다. 관찰자를 단 뒤 돌아오고, 돌려준 함수가 「조건이 한 번이라도 참이 됐던 때」의
 * 값을 준다. 행동 뒤 금방 사라지는 상태(잠깐 뜨는 알림, 진행 중 표시, 짧은 대기열 줄)를 행동 뒤에 들여다보면 놓친다.
 * 문서가 바뀌면(탐색·새로고침) 걸어 둔 것도 사라진다.
 */
export async function arm<A, R>(page: Page, check: (arg: A) => R, arg?: A): Promise<() => Promise<Awaited<R>>> {
  const key = JSON.stringify(Math.random().toString(36).slice(2))
  await page.evaluate(`void ((window.__e2eArmed ??= {})[${key}] = ${untilExpression(check.toString(), arg)})`)
  return () => page.evaluate<unknown>(`window.__e2eArmed[${key}]`).then((value) => value as Awaited<R>)
}

/** 이 문서에서 그 종류의 스트림 메시지가 지금까지 몇 번 왔나. 사정을 깔기 **전에** 세어 둔다. */
export async function seen(page: Page, type: string): Promise<number> {
  return page.evaluate((t) => window.__e2eSeen?.[t] ?? 0, type)
}

/** 그 종류의 메시지가 모두 `count`번 오기를 기다린다(`seen` 값에 더해 쓴다). */
export async function waitForSeen(page: Page, type: string, count: number) {
  await waitFor(page, ([t, n]) => (window.__e2eSeen?.[t] ?? 0) >= n, [type, count] as const)
}

/** 지금부터 그 종류의 메시지가 `count`번 더 오기를 기다린다 — 세기와 리스너 달기를 한 번의 evaluate에서 한다. */
export async function nextMessages(page: Page, type: string, count = 1) {
  await page.evaluate(
    `((t, k) => { const from = window.__e2eSeen?.[t] ?? 0; return (${UNTIL})(([t, n]) => (window.__e2eSeen?.[t] ?? 0) >= n, [t, from + k]) })(${JSON.stringify(type)}, ${count})`,
  )
}

/**
 * 그 종류의 마지막 메시지가 `where(message, arg)`에 맞기를 기다린다. 이미 온 마지막 것이 맞으면 곧바로 풀린다 —
 * 상태를 통째로 실어 오는 메시지라면 마지막 것이 곧 지금 상태다(증분 메시지라면 `nextMessages`를 쓴다).
 */
export async function waitForMessage<A>(
  page: Page,
  type: string,
  where: (message: StreamMessage, arg: A) => unknown = () => true,
  arg?: A,
): Promise<StreamMessage> {
  const check = `([t, a]) => { const m = window.__e2eLast?.[t]; return m !== undefined && (${where.toString()})(m, a) ? m : null }`
  return (await page.evaluate(untilExpression(check, [type, arg ?? null]))) as StreamMessage
}

/**
 * 화면 없이 스트림만 연다. 같은 출처의 가벼운 주소(작은 JSON 응답)에 붙어 EventSource 하나를 연다 — 앱을 띄우는
 * 값(한 프로젝트에서 0.6초)을 치르지 않고 서버가 보내는 메시지만 기다릴 때. `watchStreams`를 먼저 걸어 둔다.
 */
export async function openStream(page: Page, lightUrl: string, streamUrl: string, firstType?: string) {
  await page.goto(lightUrl, { waitUntil: 'commit' })
  await page.evaluate((url) => void new EventSource(url), streamUrl)
  if (firstType) await waitForSeen(page, firstType, 1)
}

type ActOptions = {
  /** 행동의 쓰기 요청인가. 기본: `/api/` 아래 POST·PUT·PATCH·DELETE */
  isWrite?: (url: string, method: string) => boolean
  /** 화면이 행동과 상관없이 스스로 보내는 쓰기(구독 갱신 등) — 이것의 응답을 행동의 응답으로 잡지 않는다 */
  background?: string[]
  /** 응답 뒤 서버가 비동기로 처리하는 요청이면, 그 결과를 실어 올 스트림 메시지 종류 */
  thenMessage?: (url: string) => string | undefined
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * 행동 하나를 하고 그것이 화면에 닿기를 기다린다: 행동이 보낸 쓰기 요청의 응답, 그리고(비동기 처리면) 그 뒤 스트림
 * 메시지 하나. 뒤따르는 `expect`가 다시 보기 없이 한 번에 맞는다. `page.request`로 보낸 API 요청은 감싸지 않는다.
 */
export async function act(page: Page, action: () => Promise<unknown>, options: ActOptions = {}) {
  const isWrite = options.isWrite ?? ((url, method) => url.includes('/api/') && WRITE.has(method))
  const background = options.background ?? []
  // 행동 **뒤에** 나간 요청만 본다 — 앞서 나간 쓰기의 응답을 행동의 응답으로 잡으면 뒤의 단언이 너무 이르다.
  const sent = page.waitForRequest((r) => isWrite(r.url(), r.method()) && !background.some((p) => r.url().endsWith(p)))
  await action()
  const request = await sent
  await request.response()
  const type = options.thenMessage?.(request.url())
  if (type) await nextMessages(page, type)
}

/**
 * 이 저장소의 `test`: 시험 안에서 `browser.newContext()`로 연 맥락을 시험 뒤에 닫는다. 닫지 않으면 끝난 시험의
 * 화면이 실시간 연결을 쥔 채 남아 서버가 그 몫의 일을 계속 하고, 시험이 쌓일수록 느려진다.
 * `@playwright/test`의 `test` 대신 이것을 가져다 쓴다.
 */
export const test = base.extend<{ closeOpenedContexts: void }>({
  closeOpenedContexts: [
    async ({ browser }, use) => {
      const opened: BrowserContext[] = []
      const open = browser.newContext.bind(browser)
      browser.newContext = async (...args) => {
        const context = await open(...args)
        opened.push(context)
        return context
      }
      await use()
      browser.newContext = open
      await Promise.all(opened.map((context) => context.close().catch(() => undefined)))
    },
    { auto: true },
  ],
})
export { expect } from '@playwright/test'
