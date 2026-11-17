// Claude 어댑터: Claude Code 모드 API(`$`)로 AgentHost 포트를 구현한다. 코어는 이 파일을 모른다.
//  - submitTurn → $.prompt.submit({ asUser: true }) (턴이 돌면 끝난 뒤 새 턴으로 간다)
//  - injectMidTurn → 본 세션의 다음 도구 호출 결과에 context 로 붙인다(PostToolUse 리마인더와 같은 자리)
//  - compact·usage → $.session.compact·$.session.usage
//  - 이벤트 → turn.start·turn.complete·prompt.change·prompt.submit·session.compact 훅(wireClaudeEvents)
//  - services → $.http·$.clock·$.fs
//  - 메일함 프로필 경로 → AGENT_MAIL_PROFILE·XDG_CONFIG_HOME·HOME(mailProfilePath)
import type { Hook, On } from 'claude-code'

import type { AgentHost, HostEvent, HttpReply } from '../core/host'

export type Self = Parameters<Hook<'session.start'>>[0]

/** 이벤트 나눠 주기. 듣는 쪽이 던져도 다른 쪽과 훅은 그대로 간다. */
export const createEmitter = () => {
  const listeners = new Set<(e: HostEvent) => void>()

  return {
    emit: (e: HostEvent) => {
      for (const l of [...listeners]) {
        try {
          l(e)
        } catch {
          // 코어의 잘못이 세션 훅을 멈추지 않게 한다.
        }
      }
    },
    on: (l: (e: HostEvent) => void) => {
      listeners.add(l)

      return () => void listeners.delete(l)
    },
  }
}

export type Emitter = ReturnType<typeof createEmitter>

/** 다음 도구 호출 결과에 붙일 글(injectMidTurn). 붙이면 기다리던 쪽을 푼다. */
export const createMidTurnBox = () => {
  let waiting: { text: string; done: () => void }[] = []

  return {
    put: (text: string) => new Promise<void>(done => void waiting.push({ text, done })),
    take: (): string[] => {
      const out = waiting
      waiting = []
      for (const w of out) w.done()

      return out.map(w => w.text)
    },
    size: () => waiting.length,
  }
}

export type MidTurnBox = ReturnType<typeof createMidTurnBox>

/** 본 세션의 이벤트를 포트 이벤트로 넘긴다. 서브에이전트(agentId 가 있는 루프)의 것은 넘기지 않는다. */
export function wireClaudeEvents(on: On, emitter: Emitter, box: MidTurnBox): void {
  // 관찰만 한다: 실패해도 원래 흐름은 그대로 간다.
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) emitter.emit({ type: 'turn.start' })

    return next(e)
  }).catch(($, e, next) => next(e))
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) emitter.emit({ type: 'turn.complete' })

    return r
  }).catch(($, e, next) => next(e))
  on('prompt.change', ($, e, next) => {
    emitter.emit({ type: 'input.change', text: e.text })

    return next(e)
  }).catch(($, e, next) => next(e))
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    emitter.emit({ type: 'compact.complete' })

    return r
  }).catch(($, e, next) => next(e))
  // injectMidTurn: 본 세션 도구 호출이 끝나면 쌓인 글을 결과의 context 로 붙인다.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || box.size() === 0 || r.deny !== undefined) return r

    return { ...r, context: [...(r.context ?? []), ...box.take()] }
  }).catch(($, e, next) => next(e))
}

/** 사용자 제출을 포트 이벤트로(prompt.submit 훅은 질문 패널도 쓰므로 register 가 이것을 부른다). */
export const emitSubmit = (emitter: Emitter, text: string) => emitter.emit({ type: 'input.submit', text })

/** 기계 이름: 모드 API에는 없어 SWITCHBOARD_MACHINE, 없으면 HOSTNAME 을 읽는다($.env.get 은 글자 그대로의 이름만 받는다). */
async function machineOf($: Self): Promise<string> {
  try {
    return (await $.env.get('SWITCHBOARD_MACHINE')) || ((await $.env.get('HOSTNAME')) ?? '')
  } catch {
    return ''
  }
}

/**
 * 메일함 프로필 경로: `AGENT_MAIL_PROFILE` 이 있으면 `$XDG_CONFIG_HOME`(없으면 `~/.config`)/agent-mail/<이름>.json,
 * 없으면 null(메일함 꺼짐). 파일 내용(토큰)은 코어가 fs 로 읽어 메모리에만 둔다.
 */
export async function mailProfilePath($: Self): Promise<string | null> {
  try {
    const name = (await $.env.get('AGENT_MAIL_PROFILE'))?.trim() ?? ''
    // 이름에 경로 글자가 있으면 다른 파일을 읽게 되므로 받지 않는다.
    if (name === '' || /[/\\]|^\.\.?$/.test(name)) return null
    const xdg = (await $.env.get('XDG_CONFIG_HOME'))?.trim() ?? ''
    const home = (await $.env.get('HOME'))?.trim() ?? ''
    const base = xdg !== '' ? xdg : home !== '' ? `${home}/.config` : ''
    if (base === '') return null

    return `${base}/agent-mail/${name}.json`
  } catch {
    return null
  }
}

/** `$` 하나로 AgentHost 를 만든다. emitter·box 는 wireClaudeEvents 에 준 것과 같아야 한다. */
export function claudeHost($: Self, emitter: Emitter, box: MidTurnBox): AgentHost {
  return {
  identity: async () => {
    let sessionId = ''
    let cwd = ''
    try {
      sessionId = await $.session.id()
    } catch {
      // 세션 id 를 못 읽는 환경(시험 등): 빈 글.
    }
    try {
      cwd = await $.session.cwd()
    } catch {
      // 위와 같다.
    }

    // 모드는 세션 프로세스에 하나 뜬다. 서브에이전트 루프는 이벤트의 agentId 로 거른다.
    return { sessionId, machine: await machineOf($), cwd, isMain: true }
  },
  features: { midTurnInject: true, compact: true },
  services: {
    clock: {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    http: {
      fetch: async (url, init): Promise<HttpReply> => {
        const r = await $.http.fetch(url, init)

        return { status: r.status, ok: r.ok, headers: r.headers, text: r.text }
      },
      // 모드 http 는 본문을 다 받아서만 준다: SSE 는 없다(D2가 길을 정한다).
    },
    fs: {
      read: async path => ((await $.fs.exists(path)) ? $.fs.read(path) : null),
      write: (path, text) => $.fs.write(path, text),
      exists: path => $.fs.exists(path),
    },
  },
  submitTurn: async text => {
    await $.prompt.submit({ text, asUser: true })
  },
  injectMidTurn: text => box.put(text),
  compact: async instructions => {
    const r = await $.session.compact(instructions === undefined ? {} : { instructions })

    return 'skip' in r && typeof r.skip === 'string' ? { done: false, reason: r.skip } : { done: true }
  },
  usage: async () => {
    const { context } = await $.session.usage()

    return { tokens: context.tokens ?? 0, ...(context.percent === undefined ? {} : { percent: context.percent }) }
  },
  on: l => emitter.on(l),
  }
}
