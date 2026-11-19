// 질문 경로 e2e 틀(#157): 실제 switchboard 서버(고정 판 릴리스 바이너리)를 띄우고, 플러그인 코어를 진짜 http·진짜 시계로 붙인다.
// 묻는 세션과 대장 세션은 AgentHost 를 흉내 낸 것(realHost)이고, 그 밖(메일함·번호 역할·원격 질문 묻는 쪽·대장 끌어오기·
// 질문 패널 코어)은 hooks/register.tsx 가 잇는 것과 같은 코어다.
// 바이너리는 e2e/run.sh 가 받아 체크섬을 확인하고 SWITCHBOARD_E2E_BIN 으로 넘긴다.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import type { QuestionPanelBatch, QuestionPanelQuestion } from '../types'
import type { AgentHost, Clock, HostEvent, Http, HttpInit, HttpReply, Identity, Timer } from '../core/host'
import { createQuestionPanel } from '../core/questions'
import type { QuestionPanel, Store } from '../core/questions'
import type { RemoteSink } from '../core/remote-inbox'
import type { RemoteQuestion } from '../core/remote-questions'
import { createSwitchboard } from '../core/switchboard'
import type { Switchboard } from '../core/switchboard'
import { fakeFs } from '../core/testing'

/** 시험 역할: 대장 하나(전역 대장)와 묻는 쪽 하나. 서버 쪽 시험(questions_sot_test.go)과 같은 이름이다. */
export const BOSS = 'team/boss'
export const ASKER = 'partner-a/coordinator'

/** 실패 메시지 머리: 질문의 정본은 서버 하나다. */
export const SOT = 'question source of truth'

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a !== null ? a.port : 0
      s.close(() => done(port))
    })
  })

export const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms))

/** cond 가 참이 될 때까지(최대 ms). 안 되면 why 로 실패한다. */
export const waitFor = async (cond: () => boolean | Promise<boolean>, why: string, ms = 10_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return
    await sleep(25)
  }
  throw new Error(`${SOT}: ${why} (${ms}ms 안에 안 됨)`)
}

export type Server = {
  endpoint: string
  token: (role: string) => string
  /** 역할로 부른다(Bearer + 역할 머리). */
  call: (role: string, method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown; text: string }>
  /** 관리자(대시보드) API. */
  admin: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown; text: string }>
  log: () => string
  stop: () => Promise<void>
}

/** 실제 switchboard 서버를 임시 DB·임시 역할 토큰으로 띄운다. 토큰·관리자 비밀은 실행마다 새로 만든다. */
export const startServer = async (): Promise<Server> => {
  const bin = process.env.SWITCHBOARD_E2E_BIN
  if (bin === undefined || bin === '') throw new Error('SWITCHBOARD_E2E_BIN 이 없다: plugins/switchboard/e2e/run.sh 로 돌린다')
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'sb-e2e-'))
  const secret = () => randomBytes(16).toString('hex')
  const tokens: Record<string, string> = { [BOSS]: secret(), [ASKER]: secret() }
  const adminSecret = secret()
  let out = ''
  const child: ChildProcess = spawn(bin, [], {
    env: {
      PATH: process.env.PATH ?? '',
      // DB_PATH·LISTEN_ADDR 은 접두어 없는 이름이다(서버 internal/config).
      LISTEN_ADDR: `127.0.0.1:${port}`,
      DB_PATH: join(dir, 'mail.db'),
      SWITCHBOARD_TOKENS: Object.entries(tokens)
        .map(([r, t]) => `${r}=${t}`)
        .join(','),
      SWITCHBOARD_BOSS_ROLES: BOSS,
      SWITCHBOARD_ADMIN_PROXY_TOKEN: adminSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', d => void (out += String(d)))
  child.stderr?.on('data', d => void (out += String(d)))
  const endpoint = `http://127.0.0.1:${port}`
  const send = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const r = await fetch(`${endpoint}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await r.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }

    return { status: r.status, json, text }
  }
  const call = (role: string, method: string, path: string, body?: unknown) =>
    send(method, path, { Authorization: `Bearer ${tokens[role] ?? ''}`, 'X-Switchboard-Role': role }, body)
  const admin = (method: string, path: string, body?: unknown) =>
    send(method, path, { 'X-Switchboard-Admin': adminSecret, 'X-Switchboard-Dashboard': '1', 'Sec-Fetch-Site': 'same-origin' }, body)
  await waitFor(
    async () => {
      try {
        return (await call(BOSS, 'GET', '/api/whoami')).status === 200
      } catch {
        return false
      }
    },
    `서버가 뜨지 않음: ${out.slice(-400)}`,
    15_000,
  )
  // 묻는 쪽이 질문을 올릴 수 있게(can_ask), 대장은 질문 참조 메일([질문]·[질문 답])도 받게(watchers).
  const set = await admin('PUT', '/api/admin/question-settings/default', { can_ask: true, watchers: [BOSS], discord: false })
  if (set.status !== 200) throw new Error(`question settings: ${set.status} ${set.text}`)

  return {
    endpoint,
    token: role => tokens[role] ?? '',
    call,
    admin,
    log: () => out,
    stop: async () => {
      if (child.exitCode !== null) return
      const gone = new Promise<void>(done => child.once('exit', () => done()))
      child.kill('SIGTERM')
      await Promise.race([gone, sleep(3000)])
      if (child.exitCode === null) child.kill('SIGKILL')
    },
  }
}

/** 진짜 시계. */
const realClock = (): Clock & { cancelAll: () => void } => {
  const live = new Set<ReturnType<typeof setTimeout>>()
  const after = (ms: number, fn: () => void): Timer => {
    const t = setTimeout(() => {
      live.delete(t)
      fn()
    }, Math.max(0, ms))
    live.add(t)

    return {
      cancel: () => {
        clearTimeout(t)
        live.delete(t)
      },
    }
  }
  const every = (ms: number, fn: () => void): Timer => {
    const t = setInterval(fn, Math.max(1, ms))
    live.add(t)

    return {
      cancel: () => {
        clearInterval(t)
        live.delete(t)
      },
    }
  }

  return {
    now: async () => Date.now(),
    after,
    every,
    cancelAll: () => {
      for (const t of live) {
        clearTimeout(t)
        clearInterval(t)
      }
      live.clear()
    },
  }
}

/** 진짜 http(node fetch). kill 뒤에는 모든 요청이 연결 실패로 끝난다(세션이 죽은 것). */
const realHttp = (): Http & { kill: () => void } => {
  let dead = false
  const live = new Set<AbortController>()

  return {
    fetch: async (url: string, init: HttpInit = {}): Promise<HttpReply> => {
      if (dead) throw new Error('connect ECONNREFUSED (session is gone)')
      const ac = new AbortController()
      live.add(ac)
      try {
        const r = await fetch(url, {
          method: init.method ?? 'GET',
          ...(init.headers === undefined ? {} : { headers: init.headers }),
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: ac.signal,
        })
        const headers: Record<string, string> = {}
        r.headers.forEach((v, k) => void (headers[k] = v))

        return { status: r.status, ok: r.ok, headers, text: await r.text() }
      } finally {
        live.delete(ac)
      }
    },
    kill: () => {
      dead = true
      for (const ac of live) ac.abort()
      live.clear()
    },
  }
}

export type RealHost = AgentHost & {
  /** submitTurn 으로 들어온 글(세션 턴). */
  turns: string[]
  /** 세션이 죽는다: 요청이 끊기고 타이머가 멈춘다(정상 종료 없이). */
  kill: () => void
}

const realHost = (identity: Identity): RealHost => {
  const listeners = new Set<(e: HostEvent) => void>()
  const turns: string[] = []
  const http = realHttp()
  const clock = realClock()
  const fs = fakeFs()

  return {
    identity: async () => identity,
    features: { midTurnInject: false, compact: false },
    services: { http, clock, fs },
    turns,
    submitTurn: async text => void turns.push(text),
    usage: async () => ({ tokens: 0 }),
    on: l => {
      listeners.add(l)

      return () => void listeners.delete(l)
    },
    kill: () => {
      http.kill()
      clock.cancelAll()
    },
  }
}

/** 메모리 저장소(질문 패널 큐·초안). */
const memStore = <T>(init: T): Store<T> & { value: () => T } => {
  let v = init

  return {
    read: async () => v,
    update: async fn => {
      v = fn(v)
    },
    value: () => v,
  }
}

export type Session = {
  role: string
  host: RealHost
  board: Switchboard
  /** 세션에 들어온 「[질문 패널 답 <id>]」 글 수. */
  answerLines: (id: string) => number
  stop: () => Promise<void>
}

const profilePath = (name: string) => `/home/ci/.config/switchboard/${name}.json`

const openSession = async (
  server: Server,
  role: string,
  where: { sessionId: string; cwd: string; label?: string },
  extra: Parameters<typeof createSwitchboard>[1] = {},
): Promise<Session> => {
  const host = realHost({ sessionId: where.sessionId, machine: 'ci-box', cwd: where.cwd, isMain: true })
  const path = profilePath(where.sessionId)
  ;(host.services.fs as ReturnType<typeof fakeFs>).files.set(path, JSON.stringify({ endpoint: `${server.endpoint}/`, role, token: server.token(role) }))
  const logs: string[] = []
  const board = createSwitchboard(host, {
    ...extra,
    permissions: { waitMs: 0, bosses: [BOSS] },
    mail: { profilePath: path, log: t => void logs.push(t), slot: where.label === undefined ? {} : { label: where.label } },
    log: t => void logs.push(t),
  })
  if (!(await board.start())) throw new Error(`${role}: 교환대가 켜지지 않음`)
  await waitFor(() => board.mail().status === 'live', `${role} 메일함이 이어지지 않음: ${logs.slice(-5).join(' / ')}`)

  return {
    role,
    host,
    board,
    // 문항 하나짜리 질문이라 한 번 들어오면 머리도 한 번이다(같은 턴에 두 번 붙어도 센다).
    answerLines: id => host.turns.reduce((n, t) => n + t.split(`[질문 패널 답 ${id}]`).length - 1, 0),
    stop: async () => {
      await board.stop().catch(() => undefined)
      host.kill()
    },
  }
}

/** 묻는 세션(번호 역할로 붙는다). */
export const askerSession = (server: Server, where: { sessionId: string; cwd: string; label?: string } = { sessionId: 'asker-1', cwd: '/work/asker' }) =>
  openSession(server, ASKER, where)

export type BossSession = Session & {
  panel: QuestionPanel
  /** 패널 큐(묶음들). */
  batches: () => QuestionPanelBatch[]
  /** 이 서버 질문의 패널 묶음. */
  batchOf: (rid: string) => QuestionPanelBatch | undefined
  /** 패널이 사람에게 띄운 한 줄(토스트). */
  notes: string[]
  /** 끌어오기가 「답이 났다·거뒀다」로 패널을 닫는 것을 잠시 붙든다(늦게 온 poll 흉내). 풀면 붙든 닫기를 마저 한다. */
  holdClose: () => () => void
  /** 패널에서 각 문항의 첫 선택지를 골라 완료한다(hooks/register.tsx 의 패널 완료와 같은 코어 호출). */
  answerOnPanel: (rid: string) => Promise<void>
}

/** 대장 세션: 서버 질문을 끌어와 질문 패널 코어에 올리고, 패널 답을 서버로 보낸다(register.tsx 의 remoteSink·panelOf 배선). */
export const bossSession = async (server: Server): Promise<BossSession> => {
  const queue = memStore<QuestionPanelBatch[]>([])
  const draft = memStore('')
  const notes: string[] = []
  let board: Switchboard | undefined
  let held: Promise<void> | null = null
  const panelHost = { submitTurn: async (text: string) => void boss.host.turns.push(text) }
  const panel = createQuestionPanel({
    queue,
    draft,
    host: panelHost,
    notify: t => void notes.push(t),
    remote: { answer: async (id, answers) => (board === undefined ? { kind: 'failed', reason: '교환대가 꺼져 있음' } : board.answerRemote(id, answers)) },
  })
  const sink: RemoteSink = {
    offer: async (q: RemoteQuestion) => {
      await panel.addRemote({ q, sessionId: 'boss-1', now: Date.now() })
    },
    close: async (q: RemoteQuestion) => {
      if (held !== null) await held
      await panel.closeRemote(q.id, q.status === 'withdrawn' ? 'remote-withdrawn' : 'remote-answered')
    },
    prune: async open => {
      await panel.pruneRemote(open)
    },
  }
  const s = await openSession(server, BOSS, { sessionId: 'boss-1', cwd: '/work/boss' }, { remoteQuestions: { sink, timeoutS: 5 } })
  board = s.board
  const boss: BossSession = {
    ...s,
    panel,
    notes,
    batches: () => queue.value(),
    batchOf: rid => queue.value().find(b => b.remote?.id === rid),
    holdClose: () => {
      let release = () => {}
      held = new Promise<void>(done => (release = done))

      return () => {
        held = null
        release()
      }
    },
    answerOnPanel: async rid => {
      const b = queue.value().find(x => x.remote?.id === rid)
      if (b === undefined) throw new Error(`${SOT}: 대장 패널에 ${rid} 묶음이 없음`)
      for (const [i, q] of b.questions.entries()) await panel.pick(b.id, i, q.options[0]?.label ?? '')
      await panel.finish(b.id)
    },
  }

  return boss
}

/** 시험 질문(문항 하나, 선택지 둘). */
export const QUESTIONS: QuestionPanelQuestion[] = [
  {
    question: '어느 DB를 쓸까요?',
    header: 'DB',
    multiSelect: false,
    options: [
      { label: 'Postgres', description: '관계형' },
      { label: 'SQLite', description: '파일형' },
    ],
    picked: [],
    other: '',
  },
]
