// E2E 공용 걸음: 시계 손잡이 · 준비용 HTTP(Node fetch + 쿠키) · 화면 기다리기.
// 경로·쿠키 이름(csrftoken)·「연결됨」 표지는 저장소에 맞게 바꾼다.
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173'

/** 한 사람의 HTTP: 쿠키(세션·CSRF)를 쥐고 화면과 같은 요청을 보낸다. Playwright 요청 맥락보다 4배쯤 빠르다. */
export class Api {
  readonly cookies = new Map<string, string>()

  async fetch(method: 'GET' | 'POST', path: string, data?: object): Promise<Response> {
    if (method === 'POST' && !this.cookies.has('csrftoken')) await this.fetch('GET', '/api/auth/csrf')
    const headers: Record<string, string> = { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json'
      headers['X-CSRFToken'] = this.cookies.get('csrftoken')!
      headers.Referer = `${BASE}/`
    }
    const res = await fetch(BASE + path, { method, headers, body: method === 'POST' ? JSON.stringify(data ?? {}) : undefined })
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const at = pair.indexOf('=')
      this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
    }
    return res
  }

  async call(method: 'GET' | 'POST', path: string, data?: object) {
    const res = await this.fetch(method, path, data)
    const text = await res.text()
    expect(res.ok, `${method} ${path}: ${res.status} ${text}`).toBeTruthy()
    return text ? JSON.parse(text) : null
  }

  /** 쥔 쿠키를 브라우저 맥락에 옮긴다 - 화면이 같은 사람으로 열린다. */
  async share(context: BrowserContext) {
    await context.addCookies([...this.cookies].map(([name, value]) => ({ name, value, url: BASE })))
  }
}

// ───── 시계 ─────
const clockApi = new Api()
const clock = (action: string, data?: object) => clockApi.call('POST', `/api/test/clock/${action}`, data)

export const pauseClock = () => clock('pause')
export const resumeClock = () => clock('resume')
/** `ticks`틱을 틱 사이 `intervalMs`ms로 감는다. 마지막 틱이 돈 뒤 돌아온다. */
export const advanceClock = (ticks: number, intervalMs = 0) => clock('advance', { ticks, interval_ms: intervalMs })

/** `target`이 보일 때까지 한 틱씩 감는다 - 서버가 틱에서 집계·넘김을 하는 화면 넘김용. 고정 대기 대신. */
export async function tickUntil(target: Locator, limit = 30) {
  for (let i = 0; i < limit; i++) {
    if (await target.isVisible()) return
    await advanceClock(1)
    if (await target.waitFor({ state: 'visible', timeout: 60 }).then(() => true, () => false)) return
  }
  await expect(target).toBeVisible({ timeout: 1 })
}

/** 화면을 열고 실시간 스트림의 첫 스냅샷이 닿을 때까지 기다린다(`ready`는 그 표지). */
export async function openGame(page: Page, ready: Locator = page.getByText('연결됨')) {
  await page.goto('/')
  await expect(ready).toBeVisible()
}

/** 바깥 글꼴 등을 받지 않는다 - 망이 느리면 그것만으로 page.goto가 3초를 넘긴다. */
export async function offline(context: BrowserContext) {
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort())
}
