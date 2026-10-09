// E2E 준비 도우미: 화면 앞의 사정을 API로 깔고, 그 쿠키를 브라우저에 옮겨 같은 사람으로 화면을 연다.
// 바꿀 곳: BASE, CSRF 쿠키·머리말 이름(아래는 Django 기본값 `csrftoken`·`X-CSRFToken`), CSRF 토큰을 주는 경로.
import { expect, type BrowserContext } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
const CSRF_COOKIE = 'csrftoken'
const CSRF_HEADER = 'X-CSRFToken'
const CSRF_PATH = '/api/auth/csrf'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * 한 사람의 HTTP: 쿠키 단지(세션·CSRF)를 쥐고 화면과 같은 요청을 Node `fetch`로 보낸다.
 * 한 프로젝트에서 잰 값: Playwright 요청 맥락(`page.request`) 한 번 약 20ms, Node fetch 약 5ms.
 */
export class Api {
  readonly cookies = new Map<string, string>()

  async fetch(method: Method, path: string, data?: object): Promise<Response> {
    const writing = method !== 'GET'
    if (writing && !this.cookies.has(CSRF_COOKIE)) await this.fetch('GET', CSRF_PATH)
    const headers: Record<string, string> = { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
    if (writing) {
      headers['Content-Type'] = 'application/json'
      headers[CSRF_HEADER] = this.cookies.get(CSRF_COOKIE) ?? ''
      headers.Referer = `${BASE}/`
    }
    const res = await fetch(BASE + path, { method, headers, body: writing ? JSON.stringify(data ?? {}) : undefined })
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const at = pair.indexOf('=')
      this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
    }
    return res
  }

  /** 성공을 단언하고 JSON을 돌려준다. 실패하면 상태와 본문을 메시지에 싣는다. */
  async call<T = unknown>(method: Method, path: string, data?: object): Promise<T> {
    const res = await this.fetch(method, path, data)
    const text = await res.text()
    expect(res.ok, `${method} ${path}: ${res.status} ${text}`).toBeTruthy()
    return (text ? JSON.parse(text) : null) as T
  }

  /** 쥔 쿠키를 브라우저 맥락에 옮긴다 — 화면이 같은 사람으로 열린다. */
  async share(context: BrowserContext) {
    await context.addCookies([...this.cookies].map(([name, value]) => ({ name, value, url: BASE })))
  }
}

/**
 * 시험에 필요 없는 바깥 요청(웹 글꼴·분석·광고 스크립트)을 끊는다. 망이 느리면 그것만으로 `page.goto`의 load가
 * 3초를 넘긴다. 맥락을 만든 직후 부른다.
 */
export async function offline(context: BrowserContext, hosts: RegExp = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//) {
  await context.route(hosts, (route) => route.abort())
}
