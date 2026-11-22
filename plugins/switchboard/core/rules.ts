// 규칙 원장 걸림(#219): 서버 GET /api/rules/mine 의 줄 가운데 도구 호출에 걸리는 것을 고른다.
// 계약은 switchboard 저장소 docs/rules-hints.md, 기준 구현은 internal/wire/rules.go 의 RuleMatch.Hits 다.
// 같은 입력에 같은 답을 내도록 globRE 를 그대로 옮겼다.

import type { Clock, Http, Timer } from './host'

export interface RuleMatch {
  tool?: string
  command?: string
  path?: string
}

export interface RuleHint {
  id: number
  kind: string
  topic: string
  summary: string
  match?: RuleMatch | null
}

export interface RuleHints {
  rules: RuleHint[]
}

/** 걸림 조건이 보는 도구 호출: 이름, 명령 글(셸 도구), 건드리는 파일 경로. 빈 칸은 없는 것. */
export interface ToolCall {
  tool: string
  command?: string
  path?: string
}

function quoteMeta(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

// 패턴을 앞뒤가 묶인 정규식으로 바꾼다. 경로면 * 는 '/' 앞에서 서고, ** 는 서지 않으며, '**' 뒤 '/' 는
// 디렉터리 없음도 되고, ? 는 '/' 아닌 한 글자다. 경로가 아니면 * 는 아무 글이다.
export function globRE(p: string, path: boolean): RegExp {
  let out = '^'
  for (let i = 0; i < p.length;) {
    if (path && p.startsWith('**/', i)) {
      out += '(?:.*/)?'
      i += 3
    } else if (path && p.startsWith('**', i)) {
      out += '.*'
      i += 2
    } else if (p[i] === '*' && path) {
      out += '[^/]*'
      i++
    } else if (p[i] === '*') {
      out += '.*'
      i++
    } else if (p[i] === '?' && path) {
      out += '[^/]'
      i++
    } else {
      const ch = String.fromCodePoint(p.codePointAt(i) ?? 0)
      out += quoteMeta(ch)
      i += ch.length
    }
  }
  // u: 한 글자를 코드 포인트로 센다(Go 의 [^/] 와 같다). s 는 켜지 않는다: Go 의 . 도 줄바꿈을 넘지 않는다.
  return new RegExp(out + '$', 'u')
}

const RE2_FLAGS = /^\(\?([imsU]+)\)/

/** Go(RE2) 정규식을 JS 정규식으로. 맨 앞 (?i)·(?s)·(?m) 은 JS 깃발로 옮긴다. 옮길 수 없거나 컴파일되지 않으면 null(걸리지 않음). */
export function commandRE(src: string): RegExp | null {
  let flags = ''
  let body = src
  const m = RE2_FLAGS.exec(src)
  const given = m?.[1]
  if (m !== null && given !== undefined) {
    if (given.includes('U')) return null
    flags = [...new Set(given)].join('')
    body = src.slice(m[0].length)
  }
  // RE2 의 \A·\z 는 JS 에 없다: 앞뒤 묶음으로 옮긴다(m 깃발이 없을 때만 같은 뜻).
  if (!flags.includes('m')) body = body.replace(/^\\A/, '^').replace(/\\z$/, '$')
  try {
    return new RegExp(body, flags)
  } catch {
    return null
  }
}

function emptyMatch(m: RuleMatch): boolean {
  return (m.tool ?? '') === '' && (m.command ?? '') === '' && (m.path ?? '') === ''
}

/** 호출이 주어진 조건을 모두 채우는가. 호출에 없는 칸에 건 조건은 채워지지 않고, 조건이 없으면 거짓이다. */
export function hits(m: RuleMatch | null | undefined, call: ToolCall): boolean {
  if (m == null || emptyMatch(m)) return false
  if ((m.tool ?? '') !== '' && !globRE(m.tool ?? '', false).test(call.tool)) return false
  if ((m.command ?? '') !== '') {
    const re = commandRE(m.command ?? '')
    if (re === null || (call.command ?? '') === '' || !re.test(call.command ?? '')) return false
  }
  if ((m.path ?? '') !== '' && ((call.path ?? '') === '' || !globRE(m.path ?? '', true).test(call.path ?? ''))) return false
  return true
}

/** 도구 입력에서 걸림 조건이 보는 칸을 뽑는다: command(셸), file_path·notebook_path·path(파일). */
export function toolCallOf(tool: string, input: unknown): ToolCall {
  const call: ToolCall = { tool }
  if (typeof input !== 'object' || input === null) return call
  const rec = input as Record<string, unknown> // 도구 입력은 도구마다 모양이 달라 칸을 하나씩 좁힌다
  if (typeof rec.command === 'string' && rec.command !== '') call.command = rec.command
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = rec[k]
    if (typeof v === 'string' && v !== '') {
      call.path = v
      break
    }
  }
  return call
}

/** 걸린 줄 하나를 넣을 글로. */
export function hintLine(r: RuleHint): string {
  const label = r.kind === 'decision' ? '결정' : '요령'
  return `${label} #${r.id} 참고: ${r.summary}`
}

/** 받은 몸을 좁힌다. 모양이 틀리면 null. */
export function parseRuleHints(body: unknown): RuleHints | null {
  if (typeof body !== 'object' || body === null || !('rules' in body) || !Array.isArray(body.rules)) return null
  const rules: RuleHint[] = []
  for (const r of body.rules as unknown[]) {
    if (typeof r !== 'object' || r === null) continue
    const o = r as Record<string, unknown> // JSON 경계: 칸마다 좁힌다
    if (typeof o.id !== 'number' || typeof o.summary !== 'string') continue
    const hint: RuleHint = { id: o.id, kind: typeof o.kind === 'string' ? o.kind : '', topic: typeof o.topic === 'string' ? o.topic : '', summary: o.summary }
    if (typeof o.match === 'object' && o.match !== null) {
      const mm = o.match as Record<string, unknown> // JSON 경계
      hint.match = {
        tool: typeof mm.tool === 'string' ? mm.tool : undefined,
        command: typeof mm.command === 'string' ? mm.command : undefined,
        path: typeof mm.path === 'string' ? mm.path : undefined,
      }
    }
    rules.push(hint)
  }
  return { rules }
}

/** 서버 호출 하나(메일함의 call 과 같은 모양). 실패·시간 초과는 null. */
export type RulesCall = (
  path: string,
  init?: { method?: string; body?: string; headers?: Readonly<Record<string, string>> },
  io?: { http?: Pick<Http, 'fetch'>; timeoutMs?: number },
) => Promise<{ status: number; ok: boolean; text: string; headers?: Readonly<Record<string, string>> } | null>

/** 규칙 요청 한도(ms): 넘으면 지닌 몸으로 간다. 도구 호출을 눈에 띄게 늦추지 않게 짧다. */
export const RULES_TIMEOUT_MS = 1500
/** 이 시간(ms) 안에 다시 확인했으면 지닌 몸을 그대로 쓴다. 세션 시작·compact 뒤에는 곧 다시 확인한다. */
export const RULES_FRESH_MS = 60_000

export type RuleHintsBox = {
  /** 다시 확인할 때가 됐으면 GET /api/rules/mine 을 띄운다(기다리지 않는다). */
  warm: (io?: { http?: Pick<Http, 'fetch'> }) => void
  /** 호출에 걸린 줄 가운데 이 루프(본 세션 '', 서브에이전트는 그 id)에 아직 안 넣은 것을 글로 돌려주고 hits 를 보낸다. */
  lines: (call: ToolCall, loop: string, io?: { http?: Pick<Http, 'fetch'> }) => Promise<string[]>
  /** compact 뒤: 본 세션에 넣은 번호를 비우고 다음 호출에서 다시 확인한다. */
  compacted: () => void
}

const header = (h: Readonly<Record<string, string>> | undefined, name: string): string | undefined => {
  if (h === undefined) return undefined
  const k = Object.keys(h).find(x => x.toLowerCase() === name)

  return k === undefined ? undefined : h[k]
}

export function createRuleHints(call: RulesCall, clock: Pick<Clock, 'after'>): RuleHintsBox {
  let body: RuleHints | null = null
  let etag: string | undefined
  let fresh = false
  let freshTimer: Timer | undefined
  let inflight: Promise<void> | null = null
  const seen = new Map<string, Set<number>>()

  const revalidate = (io?: { http?: Pick<Http, 'fetch'> }): Promise<void> => {
    if (inflight !== null) return inflight
    inflight = (async () => {
      const r = await call('/api/rules/mine', etag === undefined ? {} : { headers: { 'If-None-Match': etag } }, { ...io, timeoutMs: RULES_TIMEOUT_MS })
      if (r === null) return // 안 닿으면 지닌 몸(없으면 아무것도 넣지 않는다). 다음 호출에서 다시 해 본다.
      if (r.status === 200) {
        try {
          const parsed = parseRuleHints(JSON.parse(r.text))
          if (parsed !== null) {
            body = parsed
            etag = header(r.headers, 'etag')
          }
        } catch {
          // 몸을 못 읽으면 지닌 몸으로.
        }
      }
      // 304 는 지닌 몸 그대로. 그 밖의 답(401·404 옛 서버 등)도 지닌 몸으로 가고, 한동안 다시 묻지 않는다.
      fresh = true
      freshTimer?.cancel()
      freshTimer = clock.after(RULES_FRESH_MS, () => void (fresh = false))
    })()
      .catch(() => undefined)
      .finally(() => void (inflight = null))

    return inflight
  }

  return {
    warm: io => {
      if (!fresh) void revalidate(io)
    },
    lines: async (call0, loop, io) => {
      if (!fresh) await revalidate(io)
      const rules = body?.rules ?? []
      let mine = seen.get(loop)
      const hit: RuleHint[] = []
      for (const r of rules) {
        if (mine?.has(r.id) === true || !hits(r.match, call0)) continue
        if (mine === undefined) seen.set(loop, (mine = new Set()))
        mine.add(r.id)
        hit.push(r)
      }
      if (hit.length === 0) return []
      // 세는 것은 덤이다: 실패는 삼키고 기다리지 않는다.
      void call('/api/rules/hits', { method: 'POST', body: JSON.stringify({ ids: hit.map(r => r.id) }) }, { ...io, timeoutMs: RULES_TIMEOUT_MS }).catch(() => null)

      return hit.map(hintLine)
    },
    compacted: () => {
      seen.delete('')
      fresh = false
    },
  }
}
