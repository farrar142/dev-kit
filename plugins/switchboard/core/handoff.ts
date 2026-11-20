// 넘기기(#182, sandcorporation/switchboard#288): 세션 안에 살던 백그라운드 명령·예약·감시를 switchboard 장부로 넘긴다.
// 세션이 다시 떠도 사라지지 않게 하는 것이 목적이다. 여기는 에이전트를 모르는 순수 함수만 둔다(바꿀 명령·예약 인자·판정).
// 실제 실행(건강 검사·schedule add)과 훅 연결은 adapters/handoff.ts 가 한다.

/** 넘기기를 켜는 플랫폼. 실행기가 있는 곳만 둔다(Windows·macOS 는 실행기가 생기면 여기에 더한다). */
export const HANDOFF_PLATFORMS: readonly string[] = ['linux']

/** 실행기(job·schedule·watch)가 처음 들어간 CLI 판. `job ping` 이 없을 때 `version` 으로 대신 잰다. */
export const HANDOFF_MIN_VERSION = '0.26.0'

/** 끄는 환경변수: 0·off·false·no 면 넘기지 않는다. */
export const HANDOFF_ENV = 'SWITCHBOARD_HANDOFF'

/** CLI 실행 파일을 고르는 환경변수(없으면 PATH 의 `switchboard`). */
export const HANDOFF_CLI_ENV = 'SWITCHBOARD_CLI'

export const handoffOff = (value: string | undefined): boolean => /^(0|off|false|no)$/i.test(value?.trim() ?? '')

/** POSIX 셸 인자 하나로 감싼다. 작은따옴표만 끊어 넣으면 줄바꿈·`$`·heredoc 이 그대로 간다(bash·zsh·sh). */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** `-c` 로 원래 명령을 돌릴 셸. 세션 셸이 bash·zsh·sh 면 그것, 아니면 bash. */
export const pickShell = (shell: string | undefined): string => {
  const s = shell?.trim() ?? ''
  const base = s.split('/').pop() ?? ''

  return s !== '' && /^(bash|zsh|sh)$/.test(base) ? s : 'bash'
}

/** 꼬리표: 공백을 한 칸으로 줄인 앞 60자. */
export const handoffLabel = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 60)

// 앞에 `NAME=값` 환경 지정이 붙어도, 경로가 붙어도(`/x/switchboard`), `--profile NAME` 이 끼어도 같은 것으로 본다.
const HANDED = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(['"]?)(?:[^\s'"]*\/)?switchboard(?:\.exe)?\1(?:\s+--(?:profile|role)[ =]\S+)*\s+(?:job\s+run|watch\s+start)\b/

/** 이미 넘긴 명령인가(`switchboard job run`·`watch start` 로 시작). 다시 감싸지 않는다. */
export const alreadyHanded = (command: string): boolean => HANDED.test(command)

/** 백그라운드 Bash 를 넘긴 명령: 실행기에 맡기고 끝날 때까지 기다린다(첫 줄에 `switchboard job <id>` 가 stderr 로 찍힌다). */
export const jobRunCommand = (cli: string, shell: string, command: string): string =>
  `${shellQuote(cli)} job run --wait --label ${shellQuote(handoffLabel(command))} -- ${shellQuote(shell)} -c ${shellQuote(command)}`

/** Monitor 의 시간 한도(ms)를 `--expires` 값으로. 없거나 0 이면 undefined(CLI 기본 7d). 분 단위로 올림. */
export const monitorExpires = (timeoutMs: number | undefined): string | undefined =>
  typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? `${Math.max(1, Math.ceil(timeoutMs / 60_000))}m` : undefined

/** Monitor 를 넘긴 명령: 감시를 띄우고 붙어서 줄을 그대로 받는다. 세션이 죽으면 감시는 남고 줄은 메일로 온다. */
export const watchStartCommand = (cli: string, shell: string, command: string, label: string, expires?: string): string =>
  [
    shellQuote(cli),
    'watch start --attach',
    ...(expires === undefined ? [] : [`--expires ${expires}`]),
    `--label ${shellQuote(handoffLabel(label) || handoffLabel(command))}`,
    `-- ${shellQuote(shell)} -c ${shellQuote(command)}`,
  ].join(' ')

/** 하네스 안에서만 뜻이 있는 /loop 표지(`<<autonomous-loop>>` 등). 메일로 오면 뜻이 없으니 넘기지 않는다. */
export const isLoopSentinel = (prompt: string): boolean => /^\s*<<[a-z-]+>>\s*$/.test(prompt)

export type ScheduleWhen = { cron: string } | { at: string; expires?: string } | { in: string }

const pad = (n: number) => String(n).padStart(2, '0')
const DAY_MS = 86_400_000

/**
 * CronCreate 를 schedule add 인자로. recurring(기본 true)이면 `--cron` 그대로.
 * 한 번만(recurring false)이면 분·시·일·월이 숫자로 박힌 꼴만 `--at YYYY-MM-DD HH:MM`(지났으면 내년)으로 바꾼다.
 * 그 밖의 한 번짜리는 다음 울림을 여기서 셈하지 않고 undefined(넘기지 않는다).
 * 7일(CLI 기본 만료) 뒤면 `--expires` 를 하루 넉넉히 붙인다.
 */
export const cronSchedule = (cron: string, recurring: boolean | undefined, now: Date): ScheduleWhen | undefined => {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  if (recurring !== false) return { cron: fields.join(' ') }
  const [mi, ho, dom, mon] = fields.slice(0, 4).map(f => (/^\d{1,2}$/.test(f) ? Number(f) : NaN))
  if ([mi, ho, dom, mon].some(n => Number.isNaN(n))) return undefined
  if (mi > 59 || ho > 23 || dom < 1 || dom > 31 || mon < 1 || mon > 12) return undefined
  let year = now.getFullYear()
  let at = new Date(year, mon - 1, dom, ho, mi)
  if (at.getTime() <= now.getTime()) at = new Date(++year, mon - 1, dom, ho, mi)
  if (at.getMonth() !== mon - 1) return undefined // 2월 30일 같은 없는 날
  const text = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  const days = Math.ceil((at.getTime() - now.getTime()) / DAY_MS)

  return days >= 7 ? { at: text, expires: `${days + 1}d` } : { at: text }
}

/** ScheduleWakeup 의 지연(초)을 `--in` 으로. 하네스처럼 [60, 3600] 으로 자르고 분 단위로 올린다(CLI 는 초를 받지 않는다). */
export const wakeupIn = (delaySeconds: number | undefined): string | undefined => {
  if (typeof delaySeconds !== 'number' || !Number.isFinite(delaySeconds)) return undefined
  const s = Math.min(3600, Math.max(60, delaySeconds))

  return `${Math.ceil(s / 60)}m`
}

/** `switchboard schedule add` 의 argv(CLI 이름 뒤). */
export const scheduleAddArgs = (when: ScheduleWhen, prompt: string, label?: string): string[] => [
  'schedule',
  'add',
  ...('cron' in when ? ['--cron', when.cron] : 'at' in when ? ['--at', when.at, ...(when.expires ? ['--expires', when.expires] : [])] : ['--in', when.in]),
  '--label',
  handoffLabel(label ?? prompt) || 'schedule',
  '--prompt',
  prompt,
]

/** 모델에게 보일 예약 id. CronDelete 가 이것(또는 숫자만)을 받으면 schedule rm 으로 잇는다. */
export const scheduleRef = (id: string): string => `sb-${id}`

/** CronDelete 의 id 가 넘긴 예약이면 서버 id(숫자), 아니면 undefined(하네스의 cron). */
export const scheduleIdOf = (ref: string): string | undefined => /^(?:sb-)?(\d+)$/.exec(ref.trim())?.[1]

export const cronDenyText = (ref: string, recurring: boolean): string =>
  `switchboard: 이 예약은 세션 안이 아니라 switchboard 장부에 ${ref} 로 만들었다(세션이 다시 떠도 남는다). ` +
  `${recurring ? '울릴 때마다' : '울리면'} 프롬프트가 이 역할의 메일로 온다. 다시 만들지 마라. 지우려면 CronDelete 에 id ${ref} 를 넘긴다.`

export const wakeupDenyText = (ref: string, when: string): string =>
  `switchboard: 늦춘 깨우기를 switchboard 장부에 한 번짜리 예약 ${ref}(${when} 뒤)로 만들었다(세션이 다시 떠도 남는다). ` +
  `때가 되면 프롬프트가 이 역할의 메일로 온다. 다시 부르지 마라.`

export const notHandedLine = (why: string): string => `switchboard: 이 호출은 세션 안에서 그대로 돌았다(장부로 넘기지 못했다: ${why}).`

/** `vX.Y.Z` 를 견준다. 못 읽으면 false. */
export const versionAtLeast = (text: string, min: string): boolean => {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (m === null) return false
  const want = min.split('.').map(Number)
  const have = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i]

  return true
}
