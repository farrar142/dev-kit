// Claude 어댑터: Claude Code 모드 API(`$`)로 AgentHost 포트를 구현한다. 코어는 이 파일을 모른다.
//  - submitTurn → $.prompt.submit({ asUser: true }) (턴이 돌면 끝난 뒤 새 턴으로 간다)
//  - injectMidTurn → 본 세션의 다음 도구 호출 결과에 context 로 붙인다(PostToolUse 리마인더와 같은 자리)
//  - compact·usage → $.session.compact·$.session.usage
//  - 이벤트 → turn.start·turn.complete·prompt.edit·prompt.change·prompt.submit·session.compact 훅(wireClaudeEvents)
//  - services → $.http·$.clock·$.fs
//  - 메일함 프로필 경로 → agent-mail CLI 규칙(AGENT_MAIL_CONFIG_DIR·APPDATA·XDG_CONFIG_HOME·HOME·USERPROFILE, mailProfilePath)
//  - 메일 전 compact 설정 → SWITCHBOARD_COMPACT_TOKENS·SWITCHBOARD_COMPACT_INSTRUCTIONS(compactEnv)
//  - 멈춤(D8) → classic.StopFailure(stop.failure)·classic.Notification(notification)·도구 호출 끝(tool.complete)
//  - 원격 권한 설정 → SWITCHBOARD_PERMISSION_WAIT_SECONDS·SWITCHBOARD_BOSS_ROLES(permissionEnv), 요약 → permissionSummary
import type { Hook, On } from 'claude-code'

import type { AgentHost, HostEvent, HttpReply } from '../core/host'
import { profileLocation } from '../core/profile'
import type { ProfileEnv, ProfilePlatform } from '../core/profile'

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

/**
 * 다음 도구 호출 결과에 붙일 글(injectMidTurn). 붙이면 기다리던 쪽을 true 로 푼다.
 * 턴이 도구 호출 없이 끝나면 expire 가 남은 글을 버리고 false 로 푼다(다음 턴의 엉뚱한 도구 결과에 붙지 않게).
 */
export const createMidTurnBox = () => {
  let waiting: { text: string; done: (attached: boolean) => void }[] = []
  const drain = (attached: boolean) => {
    const out = waiting
    waiting = []
    for (const w of out) w.done(attached)

    return out.map(w => w.text)
  }

  return {
    put: (text: string) => new Promise<boolean>(done => void waiting.push({ text, done })),
    take: (): string[] => drain(true),
    expire: (): void => void drain(false),
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
    if (e.agentId === undefined) {
      // 붙지 못한 끼워 넣기는 버린다(코어가 새 턴으로 넣는다). 턴 끝 이벤트보다 먼저.
      box.expire()
      emitter.emit({ type: 'turn.complete' })
    }

    return r
  }).catch(($, e, next) => next(e))
  // 사람이 치는 글자·붙여 넣기는 prompt.edit 로 온다(prompt.change 는 그 밖의 바뀜: 기록 불러오기·지우기·채우기).
  // 둘 다 들어야 「입력창에 글이 있음」을 안다. 0.8.1 까지는 prompt.change 만 들어 입력 중 보류가 걸리지 않았다.
  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    emitter.emit({ type: 'input.change', text: r.text })

    return r
  }).catch(($, e, next) => next(e))
  // 기록 불러오기·되돌리기만 사람이 친 글이다. 플러그인 채우기·엔진 쓰기(prefill·받아들인 완성 등)·지우기는 아니다(#123).
  // 다음 답 추천(prompt.suggest)과 「※ recap:」은 입력창을 바꾸지 않아 여기로 오지 않는다(재현으로 확인).
  on('prompt.change', ($, e, next) => {
    emitter.emit({ type: 'input.change', text: e.text, by: changeBy(e.origin.kind) })

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
    if (e.agentId === undefined) emitter.emit({ type: 'tool.complete' })
    if (e.agentId !== undefined || box.size() === 0 || r.deny !== undefined) return r

    return { ...r, context: [...(r.context ?? []), ...box.take()] }
  }).catch(($, e, next) => next(e))
}

/**
 * 멈춤(D8): 본 세션의 API 오류 멈춤과 사람 기다림 알림을 포트 이벤트로. 오류 본문(error_details)·알림 글은 넘기지 않는다.
 */
export function wireStallEvents(on: On, emitter: Emitter): void {
  on('classic.StopFailure', ($, e, next) => {
    if (e.agent_id === undefined) emitter.emit({ type: 'stop.failure', kind: e.error })

    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.Notification', ($, e, next) => {
    if (e.agent_id === undefined) emitter.emit({ type: 'notification', kind: e.notification_type })

    return next(e)
  }).catch(($, e, next) => next(e))
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 권한 요청의 짧은 요약(서버 500바이트 한도는 코어가 자른다). 셸은 명령, 파일 도구는 경로, 웹은 주소,
 * 그 밖은 입력 JSON 앞부분. 서브에이전트의 요청이면 그 종류를 앞에 붙인다.
 */
export const permissionSummary = (tool: string, input: unknown, agentType?: string): string => {
  const pick = (k: string) => (isObj(input) && typeof input[k] === 'string' ? (input[k] as string) : undefined)
  let s: string
  if (tool === 'Bash' || tool === 'PowerShell') s = pick('command') ?? ''
  else if (pick('file_path') !== undefined) s = pick('file_path') ?? ''
  else if (pick('url') !== undefined) s = pick('url') ?? ''
  else if (pick('path') !== undefined) s = pick('path') ?? ''
  else {
    try {
      s = JSON.stringify(input) ?? ''
    } catch {
      s = ''
    }
  }
  const desc = pick('description')
  const head = agentType === undefined || agentType === '' ? '' : `[${agentType}] `

  return `${head}${s}${desc !== undefined && desc !== s ? ` — ${desc}` : ''}`.slice(0, 600)
}

/** 원격 권한 답 설정 글: SWITCHBOARD_PERMISSION_WAIT_SECONDS(기본 120, 0 이면 끔)·SWITCHBOARD_BOSS_ROLES(쉼표 목록). */
export async function permissionEnv($: Self): Promise<{ wait: string | undefined; bosses: string | undefined }> {
  try {
    return { wait: await $.env.get('SWITCHBOARD_PERMISSION_WAIT_SECONDS'), bosses: await $.env.get('SWITCHBOARD_BOSS_ROLES') }
  } catch {
    return { wait: undefined, bosses: undefined }
  }
}

/** 번호 역할을 자식 프로세스(세션의 Bash 등)에 넘긴다: `agent-mail read/ack/complete` 가 번호 메일함 기준으로 돈다(D8). */
export async function exportRole($: Self, role: string): Promise<void> {
  try {
    await $.env.set('AGENT_MAIL_ROLE', role)
  } catch {
    // 못 넘겨도 메일함은 간다.
  }
}

/** 사용자 제출을 포트 이벤트로(prompt.submit 훅은 질문 패널도 쓰므로 register 가 이것을 부른다). */
export const emitSubmit = (emitter: Emitter, text: string, originKind?: string) =>
  emitter.emit({ type: 'input.submit', text, origin: submitOrigin(originKind) })

/** 모드 prompt.submit 의 origin.kind → 포트 origin. composer(터미널 입력)·bridge(Remote Control)만 사람이다. */
export const submitOrigin = (kind: string | undefined): 'user' | 'plugin' | 'other' =>
  kind === 'composer' || kind === 'bridge' ? 'user' : kind === 'plugin' ? 'plugin' : 'other'

/** 모드 prompt.change 의 origin.kind → 포트 by. history(기록 불러오기)·undo(되돌리기)만 사람이 친 글이다. */
export const changeBy = (kind: string): 'person' | 'other' => (kind === 'history' || kind === 'undo' ? 'person' : 'other')

/**
 * 기계 이름: 모드 API에는 없어 SWITCHBOARD_MACHINE, 없으면 HOSTNAME(bash 는 보통 내보내지 않는다),
 * 그것도 없으면 /etc/hostname 을 읽는다($.env.get 은 글자 그대로의 이름만 받는다). 번호 역할(D6)은 이 이름과
 * 폴더로 재시작한 세션을 알아보므로 세션마다 바뀌지 않는 값이어야 한다.
 */
async function machineOf($: Self): Promise<string> {
  try {
    const env = (await $.env.get('SWITCHBOARD_MACHINE'))?.trim() || (await $.env.get('HOSTNAME'))?.trim() || ''
    if (env !== '') return env
  } catch {
    // 아래로.
  }
  try {
    return (await $.fs.exists('/etc/hostname')) ? (await $.fs.read('/etc/hostname')).trim() : ''
  } catch {
    return ''
  }
}

/**
 * 메일함 프로필 위치: agent-mail CLI 와 같은 규칙(core/profile.ts). paths 는 찾아볼 차례, problem 은 이름은 있는데
 * 위치를 못 정한 까닭(화면에 알린다). 둘 다 없으면 메일함 꺼짐. 파일 내용(토큰)은 코어가 fs 로 읽어 메모리에만 둔다.
 */
export async function mailProfilePath($: Self): Promise<{ paths: string[] | null; problem?: string }> {
  const get = async (read: () => Promise<string | undefined>) => {
    try {
      return await read()
    } catch {
      return undefined
    }
  }
  let platform: ProfilePlatform = 'unknown'
  try {
    platform = (await $.session.info()).platform ?? 'unknown'
  } catch {
    // 모르면 리눅스 규칙(XDG·HOME). Windows 는 APPDATA 가 있으면 아래에서 가린다.
  }
  const env: ProfileEnv = {
    AGENT_MAIL_PROFILE: await get(() => $.env.get('AGENT_MAIL_PROFILE')),
    AGENT_MAIL_CONFIG_DIR: await get(() => $.env.get('AGENT_MAIL_CONFIG_DIR')),
    APPDATA: await get(() => $.env.get('APPDATA')),
    XDG_CONFIG_HOME: await get(() => $.env.get('XDG_CONFIG_HOME')),
    HOME: await get(() => $.env.get('HOME')),
    USERPROFILE: await get(() => $.env.get('USERPROFILE')),
  }
  // 플랫폼을 못 받았는데 APPDATA 가 있으면 Windows 로 본다.
  if (platform === 'unknown' && (env.APPDATA?.trim() ?? '') !== '') platform = 'windows'
  const loc = profileLocation(platform, env)
  if ('off' in loc) return { paths: null }
  if ('problem' in loc) return { paths: null, problem: loc.problem }

  return { paths: loc.paths }
}

/** 메일 전 compact 설정 글: SWITCHBOARD_COMPACT_TOKENS(기본 200k, 0·off 면 끔)·SWITCHBOARD_COMPACT_INSTRUCTIONS. */
export async function compactEnv($: Self): Promise<{ tokens: string | undefined; instructions: string | undefined }> {
  try {
    return {
      tokens: await $.env.get('SWITCHBOARD_COMPACT_TOKENS'),
      instructions: await $.env.get('SWITCHBOARD_COMPACT_INSTRUCTIONS'),
    }
  } catch {
    return { tokens: undefined, instructions: undefined }
  }
}

/** 사람 입력 뒤 메일 보류(분): SWITCHBOARD_HOLD_MINUTES(기본 3, 0 이면 시간 보류 끔). */
export async function holdEnv($: Self): Promise<string | undefined> {
  try {
    return await $.env.get('SWITCHBOARD_HOLD_MINUTES')
  } catch {
    return undefined
  }
}

/** 짧은 턴 기준(분, #125): SWITCHBOARD_HOLD_SHORT_TURN_MINUTES(기본 2, 0 이면 기준 없음 = 늘 보류). */
export async function shortTurnEnv($: Self): Promise<string | undefined> {
  try {
    return await $.env.get('SWITCHBOARD_HOLD_SHORT_TURN_MINUTES')
  } catch {
    return undefined
  }
}

/** 입력 중 보류 상한(분, #123): SWITCHBOARD_TYPING_MINUTES(기본 5, 0 이면 상한 없음). */
export async function typingEnv($: Self): Promise<string | undefined> {
  try {
    return await $.env.get('SWITCHBOARD_TYPING_MINUTES')
  } catch {
    return undefined
  }
}

/**
 * 번호 역할(D6) 환경: SWITCHBOARD_LABEL(예: 이슈 번호)·SWITCHBOARD_PARENT(부모 역할 주소)는 presence 에 싣고,
 * SWITCHBOARD_SINGLE_ROLES(쉼표 목록, 기본 boss,coordinator, off 면 없음)는 중복 경고를 걸 역할이다.
 */
export async function slotEnv($: Self): Promise<{ label: string | undefined; parent: string | undefined; singles: string | undefined }> {
  try {
    return {
      label: (await $.env.get('SWITCHBOARD_LABEL'))?.trim() || undefined,
      parent: (await $.env.get('SWITCHBOARD_PARENT'))?.trim() || undefined,
      singles: await $.env.get('SWITCHBOARD_SINGLE_ROLES'),
    }
  } catch {
    return { label: undefined, parent: undefined, singles: undefined }
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
    // 플러그인이 건 compact 는 끝나고 풀리지만 session.compact 훅이 오지 않을 수 있다(#104: resume 직후 첫 턴 전에
    // 확인). 그러면 코어가 완료를 몰라 compacting 에 갇힌다: 그 사이 훅이 없었으면 여기서 완료를 알린다.
    let hooked = false
    const off = emitter.on(e => {
      if (e.type === 'compact.complete') hooked = true
    })
    let r: Awaited<ReturnType<Self['session']['compact']>>
    try {
      r = await $.session.compact(instructions === undefined ? {} : { instructions })
    } finally {
      off()
    }
    if ('skip' in r && typeof r.skip === 'string') return { done: false, reason: r.skip }
    if (!hooked) emitter.emit({ type: 'compact.complete' })

    return { done: true }
  },
  usage: async () => {
    const { context } = await $.session.usage()

    // 모르면(resume 직후 등) 0 으로 꾸미지 않고 실패로 알린다: 코어는 판정을 건너뛰고 presence 에서 뺀다(#104).
    if (typeof context.tokens !== 'number' || !Number.isFinite(context.tokens)) throw new Error('context tokens unknown')

    return { tokens: context.tokens, ...(context.percent === undefined ? {} : { percent: context.percent }) }
  },
  on: l => emitter.on(l),
  }
}
