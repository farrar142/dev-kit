// 목 서버 + vite + Playwright 브라우저를 한 번에 세운다(스크린샷 스크립트와 직접 짜는 확인 스크립트가 함께 쓴다).
// `./server.mjs`의 `startMock(scenario, opts)`는 `{ url, close, scenario }`을 돌려주는 목 API 서버다(저장소마다 짠다).
// vite가 API를 목 서버로 프록시하게 `API_TARGET` 같은 환경 변수를 vite 설정에서 읽는다.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { startMock } from './server.mjs'

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..')

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

/** 번들 크로뮴이 이 Playwright 판과 안 맞으면 `~/.cache/ms-playwright/`의 chromium 중 가장 새것을 쓴다. */
export function cachedChromium() {
  const root = join(homedir(), '.cache', 'ms-playwright')
  if (!existsSync(root)) return undefined
  const found = readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map((d) => join(root, d, 'chrome-linux64', 'chrome'))
    .find(existsSync)
  return found
}

export async function launchBrowser() {
  try {
    return await chromium.launch()
  } catch {
    const executablePath = cachedChromium()
    if (!executablePath) throw new Error('Playwright 브라우저가 없다: pnpm exec playwright-core install chromium')
    return chromium.launch({ executablePath })
  }
}

async function until(url, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`vite가 ${ms}ms 안에 뜨지 않았다: ${url}`)
}

/** 그룹째 내린다. vite는 `pnpm` 아래 자식으로 뜨므로 부모에게만 보내면 자식이 고아로 남는다. */
function killGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
}

/** 부르는 쪽이 예외·신호로 끝나도 띄운 vite를 내린다. */
const live = new Set()
const onSignal = (sig) => {
  for (const c of live) killGroup(c)
  process.exit(sig === 'SIGINT' ? 130 : 143)
}
let hooked = false
function hookExit() {
  if (hooked) return
  hooked = true
  process.on('exit', () => {
    for (const c of live) killGroup(c)
  })
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
}

/** 시나리오 하나로 목 서버·vite를 세우고 `{ app, mock, close }`를 돌려준다. `app`이 브라우저로 열 주소다.
 * vite는 제 프로세스 그룹으로 띄워 `close()`가 그룹째 내리고, `close()` 없이 끝나도(예외·Ctrl-C) 프로세스가 끝날 때 내린다. */
export async function startStack(scenario, opts = {}) {
  const mock = await startMock(scenario, opts)
  const port = await freePort()
  const vite = spawn('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: FRONTEND,
    env: { ...process.env, API_TARGET: mock.url },
    stdio: 'ignore',
    detached: true,
  })
  live.add(vite)
  hookExit()
  const close = async () => {
    killGroup(vite)
    live.delete(vite)
    await mock.close()
  }
  try {
    await until(`http://127.0.0.1:${port}/`)
  } catch (e) {
    await close()
    throw e
  }
  return { app: `http://127.0.0.1:${port}`, mock, close }
}
