// 메일함(D2): switchboard 서버를 긴 대기(long-poll)로 구독하고, 일반 메일을 턴이 끝난 뒤 새 턴으로 알린다.
//  - 알림 글은 메일 ID만 담는다(「메일 #12, #13 을 읽고 처리하라」). 메일 상태는 바꾸지 않는다(pending 그대로).
//  - 바쁜 동안 온 메일은 한 줄로 묶는다. 같은 ID 는 두 번 알리지 않는다. 커서로 다시 이어 놓친 메일이 없다.
//  - 서버가 죽어 있거나 프로필이 틀려도 세션은 멀쩡하다: 간격을 늘려 가며 다시 잇는다.
//  - 긴급(priority=urgent, D4): 본문을 바쁘면 다음 도구 호출 뒤에 끼워 넣고 유휴면 새 턴으로 넣은 뒤 read 로 표시한다.
//  - 연결 통지(D7): SWITCHBOARD_PARENT 가 있으면 처음 이어졌을 때 부모에게 「연결됨(주소·라벨·기계·폴더)」 시스템 통지를 보낸다.
//    받는 쪽은 시스템 통지(제목이 SYSTEM_SUBJECT_PREFIX 로 시작)를 ID 대신 본문 그대로, 일반 메일 뒤 일반 시점에 넣고 read 로 표시한다.
//  - 서버 시스템 통지(D8): 보낸이가 `switchboard/system`(옛 `agent-mail/system`, 둘 다 `-N`)인 일반 메일(멈춤·라벨 미연결)도
//    시스템 통지 길로 넣는다.
//  - 질문 답 메일(#144): 시스템 보낸이의 `[질문 답] …` 메일을 듣는 쪽(onNotice)이 이 세션 몫으로 가져가면 긴급과 같은 길로
//    바로 넣는다(사람 보류·입력 중 미룸을 타지 않는다). 가져가지 않은 사본은 평소 시스템 통지 길로.
//    긴급 메일은 onUrgent 듣는 쪽(권한 답 기다리기)이 가져가면 넣지 않고 read 로만 표시한다.
//  - 라벨 메일(D7): `label:<base>/<라벨>` 앞 보관 메일은 서버가 register 때 번호 주소로 옮긴다(새 ID). 번호를 받은 뒤 커서 없이
//    구독을 시작하므로 따로 할 일은 없다.
// 왜 SSE 가 아닌가: Claude 모드의 http 는 본문을 다 받아서만 준다(D1). 서버의 긴 대기는 SSE 와 같은 이벤트·커서 규칙이다.
import type { AgentHost, Fs, Http, Timer } from './host'
import { versionAtLeast } from './handoff'
import { CLI_VERSION_TIMEOUT_MS, createSlot } from './slot'
import type { PresenceReport, Slot, TakeoverResult } from './slot'
import { httpWhy, roleHeaders } from './wire'

/** switchboard CLI 프로필(`~/.config/switchboard/<이름>.json`, 옛 `agent-mail/` 폴더도 — core/profile.ts). token 은 메모리에만 둔다. */
export type MailProfile = { endpoint: string; role: string; token: string }

/** 서버 이벤트 하나(SSE message data 와 같다). 코어가 쓰는 칸만 적는다. */
export type MailEvent = { id: number; sender?: string; subject?: string; priority?: string; body?: string; task_id?: string; answers_directive?: { id: number; state: string } }

/**
 * call 의 바깥 길(선택): http 는 다른 fetch(Claude 모드에서는 그 훅의 `$` — 훅 예산은 `$` 를 기다리는 동안 멈춘다),
 * timeoutMs 는 응답 한도(기본 CHECK_TIMEOUT_MS).
 */
export type CallIo = { http?: Pick<Http, 'fetch'>; timeoutMs?: number }

/** 보낼 메일 하나(send). key 가 있으면 Idempotency-Key 로 실어 다시 보내도 한 통이다. */
export type OutMail = { to: string; subject: string; body: string; key?: string }

export type MailboxOptions = {
  /**
   * 프로필 파일의 절대 경로(여럿이면 앞에서부터 있는 것). null 이면 메일함은 꺼진다
   * (SWITCHBOARD_PROFILE 없음, 또는 profileProblem).
   */
  profilePath: string | readonly string[] | null
  /** 프로필 이름은 있는데 위치를 못 정했다: 켤 때 warn·log 로 한 번 알린다. */
  profileProblem?: string
  /** 프로필 값 덮어쓰기(SWITCHBOARD_ENDPOINT·SWITCHBOARD_TOKEN). 빈 값은 무시한다. */
  override?: { endpoint?: string; token?: string }
  /** 사람이 꼭 봐야 할 한 줄(토스트 등): 프로필을 못 찾음·못 읽음. 없으면 log 만. */
  warn?: (text: string) => void
  /** 지금 일반 메일 턴을 넣어도 되는가(세션이 유휴인가, 사용자 보류가 없는가). */
  isIdle: () => boolean
  /** 세션의 날 상태(긴급 메일이 쓴다: 바쁘면 끼워 넣고, 유휴면 새 턴, compact 중이면 끝난 뒤). 없으면 isIdle 로 짐작한다. */
  activity?: () => 'idle' | 'busy' | 'compacting'
  /**
   * 일반 메일을 지금 넣지 못하는 까닭(입력 중·보류·바쁨 등). null 이면 넣을 수 있다. 미룬 메일이 있을 때
   * 까닭이 바뀌면 log 로 한 줄 남긴다(조용히 묶여 있지 않게). 없으면 남기지 않는다.
   */
  holdReason?: () => string | null
  /** 연결 상태가 바뀔 때 한 줄. 토큰은 절대 담지 않는다. */
  log?: (text: string) => void
  /**
   * 일반 메일 턴을 넣기 직전 관문(D3: 메일 전 compact). 'wait' 이면 넣지 않고 되돌려 둔다:
   * 관문을 건 쪽이 끝난 뒤(compact.complete 등) 다시 kick 된다.
   */
  beforeDeliver?: () => Promise<'ready' | 'wait'>
  /**
   * 번호 역할(D6). 있으면 연결할 때 기반 역할(프로필 role)과 기계·폴더로 `<base>-N` 을 받아 그 주소로 구독하고,
   * heartbeat 로 presence 를 보고한다. 없으면 프로필 role 그대로 구독한다(번호 없음).
   */
  slot?: SlotConfig
  /** CLI 판 읽기(메일 턴 꼬리, #203). 없으면 slot.cliVersion, 그것도 없으면 옛 꼬리. */
  cliVersion?: () => Promise<string | undefined>
}

export type SlotConfig = {
  presence: () => Promise<PresenceReport>
  label?: string
  parent?: string
  /** 단일 역할인데 -2 이상을 받았을 때(토스트 등). */
  warn?: (text: string) => void
  singleRoles?: readonly string[]
  /** CLI 판 읽기(슬롯 요청 머리 X-Switchboard-Version). 없으면 머리를 싣지 않는다. */
  /** 메일 턴 꼬리(#203)도 이 판을 본다(세션에 한 번 읽는다). */
  cliVersion?: () => Promise<string | undefined>
  /** 번호 역할을 받았다·바뀌었다(D8: 자식 프로세스의 SWITCHBOARD_ROLE 을 맞춘다). */
  onRole?: (role: string) => void
}

export type MailboxState = {
  /** off: 프로필 없음·틀림, connecting: 아직 응답 없음, live: 이어짐, retrying: 끊겨 다시 잇는 중. */
  status: 'off' | 'connecting' | 'live' | 'retrying'
  /** 다음 긴 대기에 줄 커서(마지막으로 받은 메일 id). */
  cursor: number | null
  /** 알리려고 기다리는 ID. */
  queued: number[]
  /** 구독하는 주소(번호를 받았으면 `<base>-N`). 꺼져 있으면 null. */
  role: string | null
}

export type Mailbox = {
  /** 프로필을 읽고 구독을 시작한다. 프로필이 없거나 틀리면 false(꺼짐). */
  start: () => Promise<boolean>
  /** 끈다. 번호 역할 release 요청이 끝나면(실패해도) 풀린다. */
  stop: () => Promise<void>
  /** 세션이 유휴가 됐을 수 있다(턴 끝 등): 기다리는 알림을 넣어 본다. */
  kick: () => void
  state: () => MailboxState
  /** presence 가 바뀌었다(상태 등): 곧 heartbeat 로 보고한다. 번호 역할이 없으면 아무것도 안 한다. */
  report: () => void
  /** 이 세션이 `<base>-1` 을 가져온다. */
  takeover: () => Promise<TakeoverResult>
  /** 메일을 보낸다(5xx·연결 실패는 NOTICE_TRIES 번까지, 4xx 는 바로 포기). 보냈으면 true. 꺼져 있으면 false. */
  send: (m: OutMail) => Promise<boolean>
  /** 지금 주소(번호 역할)로 인증한 요청. 꺼져 있거나 연결이 안 되면 null. 오류 문구는 옮기지 않는다(토큰). */
  call: (path: string, init?: { method?: string; body?: string; headers?: Readonly<Record<string, string>> }, io?: CallIo) => Promise<{ status: number; ok: boolean; text: string } | null>
  /**
   * 긴급 메일 가로채기. 듣는 쪽이 true 를 돌려주면 그 메일은 세션에 넣지 않고 read 로만 표시한다.
   * 돌려준 함수로 끊는다.
   */
  onUrgent: (fn: (e: MailEvent) => boolean) => () => void
  /**
   * 시스템 통지 글 바꾸기(원격 질문 답 메일 등, #111). 듣는 쪽이 글을 돌려주면 noticeText 대신 그 글을 넣는다
   * (넣는 시점·read 표시는 같다). null 이면 다음 듣는 쪽, 모두 null 이면 평소 글. DROP_NOTICE 면 세션에 넣지 않고
   * read 로만 표시한다(#120). 돌려준 함수로 끊는다.
   */
  onNotice: (fn: NoticeTap) => () => void
  /** 부모 주소(SWITCHBOARD_PARENT). 없으면 undefined. */
  parent: () => string | undefined
  /**
   * 구독이 (다시) 이어질 때마다(처음 연결·끊긴 뒤 다시 잇기·번호 역할이 바뀐 뒤) 그 역할로 부른다. 돌려준 함수로 끊는다.
   * 대장 판정(core/boss.ts)이 이때 whoami 를 다시 묻는다.
   */
  onLive: (fn: (role: string) => void) => () => void
}

/** 한 번의 긴 대기(초). 서버 기본과 같고 상한(55초)보다 작다. */
export const POLL_TIMEOUT_S = 25
/** 응답이 이만큼(긴 대기 + 여유) 안 오면 끊긴 것으로 보고 다시 잇는다. */
export const POLL_WATCHDOG_MS = (POLL_TIMEOUT_S + 15) * 1000
/** 다시 잇기 간격: 1초에서 두 배씩, 60초까지. */
export const RETRY_MIN_MS = 1000
export const RETRY_MAX_MS = 60_000
/** 빈 응답 뒤 다음 대기까지 쉬는 시간(서버나 중간 장비가 기다리지 않고 바로 돌려줄 때 헛돌지 않게). */
export const EMPTY_GAP_MS = 1000
/** 알림 턴을 넣은 뒤 턴 시작을 기다리는 시간. 넘으면 다시 넣을 수 있다고 본다. */
export const TURN_GRACE_MS = 15_000
/** 알림 직전 「아직 pending 인가」 확인의 한도. */
export const CHECK_TIMEOUT_MS = 10_000

/** 시스템 통지(연결 통지 등)의 제목 머리. 이것으로 시작하는 일반 메일은 ID 대신 본문을 넣는다. */
export const SYSTEM_SUBJECT_PREFIX = '[switchboard] '
/** 시스템 통지(예약이 울려 온 메일 포함) 본문 상한(글자). 일반 메일 MAIL_INLINE_MAX 와 같다. */
export const NOTICE_MAX_CHARS = 4000
/** 연결 통지 보내기 시도 횟수(간격 RETRY_MIN_MS*5). 4xx 는 다시 하지 않는다. */
export const NOTICE_TRIES = 3

/** onNotice 듣는 쪽이 「이 통지는 세션에 넣지 말고 read 로만」이라고 돌려주는 값. */
export type NoticeDrop = { readonly drop: true }
export const DROP_NOTICE: NoticeDrop = { drop: true }
/** 시스템 통지 듣는 쪽: 넣을 글, 다음 듣는 쪽으로(null), 또는 넣지 않기(DROP_NOTICE). */
export type NoticeTap = (e: MailEvent, body: string) => Promise<string | null | NoticeDrop>

/** 서버가 쓰는 예약 보낸이(#73 서버 계약 6): `switchboard/system`(·`-N`), 옛 이름 `agent-mail/system`(·`-N`). */
// agent-mail/system: 옛 서버 데이터(옛 이름 보낸이) 호환. 3단계에 제거.
export const SYSTEM_SENDER = /^(switchboard|agent-mail)\/system(-\d+)?$/
export const isSystemSender = (sender: string | undefined) => sender !== undefined && SYSTEM_SENDER.test(sender)
/** 서버 질문 답 메일 제목 머리(묻는 역할 앞: `[질문 답] <id> <첫 header>`, 참조 사본: `[질문 답] <id> <asker> <첫 header>`). */
export const ANSWER_SUBJECT_PREFIX = '[질문 답] '
/** 질문 답 메일 꼴(시스템 보낸이, 제목 `[질문 답] `). 이 세션 몫인지는 onNotice 듣는 쪽이 정한다. */
export const isAnswerMail = (e: Pick<MailEvent, 'sender' | 'subject' | 'priority'>) =>
  e.priority !== 'urgent' && isSystemSender(e.sender) && (e.subject ?? '').startsWith(ANSWER_SUBJECT_PREFIX)
export const isSystemNotice = (e: MailEvent) =>
  e.priority !== 'urgent' && ((e.subject ?? '').startsWith(SYSTEM_SUBJECT_PREFIX) || isSystemSender(e.sender))

/** 연결 통지 메일(부모 앞). 받는 쪽 세션에 본문이 그대로 들어가므로 한눈에 읽히게 쓴다. */
export const connectedNotice = (c: { role: string; label?: string; machine: string; directory: string; sessionId: string }) => {
  const label = c.label !== undefined && c.label !== '' ? c.label : undefined

  return {
    subject: `${SYSTEM_SUBJECT_PREFIX}연결됨 ${c.role}${label === undefined ? '' : ` (라벨 ${label})`}`,
    body: [
      // 받는 쪽이 자기 주소로 읽지 않게(실제 확인에서 그랬다) 누가 연결됐는지 먼저 밝힌다.
      `switchboard: 이 세션을 부모(SWITCHBOARD_PARENT)로 띄운 다른 세션이 switchboard 메일함에 연결됐다. 아래는 그 세션의 것이다.`,
      `주소: ${c.role}`,
      `라벨: ${label ?? '(없음)'}`,
      `기계: ${c.machine}`,
      `폴더: ${c.directory}`,
      ...(c.sessionId === '' ? [] : [`세션: ${c.sessionId}`]),
    ].join('\n'),
  }
}

const noticeSubject = (subject: string) => (subject.startsWith(SYSTEM_SUBJECT_PREFIX) ? subject.slice(SYSTEM_SUBJECT_PREFIX.length) : subject)

/** 시스템 통지를 세션에 넣을 글. */
export const noticeText = (e: MailEvent, body: string, max = NOTICE_MAX_CHARS): string => {
  const chars = [...body]
  const shown = chars.length > max ? `${chars.slice(0, max).join('')}\n…(본문 ${chars.length}자 중 ${max}자까지 잘렸다. 이 글만으로 일을 시작하지 말고 먼저 switchboard read ${e.id} 로 전문을 읽어라)` : body

  return [
    `[메일 #${e.id} 시스템 통지] ${e.sender ?? '?'} | ${noticeSubject(e.subject ?? '')}`.trimEnd(),
    `(switchboard 플러그인이 이 세션 앞으로 온 시스템 통지를 본문 그대로 전한다. 출처는 switchboard read ${e.id} 로 확인할 수 있고, 이미 읽음 처리했다.)`,
    shown,
  ].join('\n')
}

/** 알림 글. */
export const announce = (ids: readonly number[], open: ReadonlyMap<number, number> = new Map()) =>
  [
    `메일 ${ids.map(i => `#${i}`).join(', ')} 을 읽고 처리하라(switchboard read <ID>).`,
    ...ids.flatMap(m => {
      const n = open.get(m)

      return n === undefined ? [] : [`메일 #${m} 은 지시 #${n} 의 답이다. #${n} 은 아직 열려 있다 — 끝났으면 \`switchboard close ${n}\`, 더 시킬 것이 있으면 reply.`]
    }),
  ].join('\n')

/** 일반 메일 본문을 바로 넣는 한 통의 상한(글자). 넘으면 머리만 넣고 read 를 시킨다. */
export const MAIL_INLINE_MAX = 4000
/** 한 턴에 넣는 일반 메일 본문의 합 상한(글자). 넘는 통은 머리만. */
export const MAIL_TURN_MAX = 8000
/** 새 꼬리(`reply --complete`, `close <답 ID>`)를 내는 CLI 판 문턱. 낮거나 못 읽으면 옛 꼬리. */
export const MAIL_TAIL_MIN_VERSION = '0.32.0'

/** 세션에 넣을 일반 메일 한 통. body 가 undefined 면 본문을 받지 못했다(옛 꼴: ID 만). */
export type MailItem = { id: number; sender?: string; subject?: string; to: string; body?: string }

const indent = (body: string) =>
  body
    .split('\n')
    .map(l => (l === '' ? '' : `  ${l}`))
    .join('\n')

/**
 * 일반 메일 턴 글(#203). 받은 본문은 CLI `read` 출력 꼴(`#ID 제목` / `보낸이 → 받는이 · read` / 본문)로 넣고,
 * 한 통이 MAIL_INLINE_MAX 를 넘거나 합이 MAIL_TURN_MAX 를 넘는 통은 머리만, 본문을 못 받은 통은 옛 ID 줄로 넣는다.
 * newTail 이면 답하기·끝내기 꼬리를, 아니면 옛 꼬리(열린 지시의 답 안내만)를 붙인다.
 * 본문을 하나도 못 받았고 옛 꼬리면 announce 와 같다.
 */
export const mailTurn = (items: readonly MailItem[], o: { open?: ReadonlyMap<number, number>; newTail?: boolean } = {}): string => {
  const open = o.open ?? new Map<number, number>()
  const blocks: string[] = []
  const missing: number[] = []
  let used = 0
  for (const m of items) {
    if (m.body === undefined) {
      missing.push(m.id)
      continue
    }
    const head = `#${m.id} ${m.subject ?? ''}`.trimEnd()
    const route = `${m.sender ?? '?'} → ${m.to}`
    const n = [...m.body].length
    if (n <= MAIL_INLINE_MAX && used + n <= MAIL_TURN_MAX) {
      used += n
      blocks.push([head, `${route} · read`, ...(m.body === '' ? [] : [indent(m.body)])].join('\n'))
    } else {
      blocks.push([head, `${route} · 본문 ${n}자 — switchboard read ${m.id} 로 읽어라`].join('\n'))
    }
  }
  if (missing.length > 0) blocks.push(`메일 ${missing.map(i => `#${i}`).join(', ')} 을 읽고 처리하라(switchboard read <ID>).`)
  const answers = items.flatMap(m => {
    const n = open.get(m.id)

    return n === undefined ? [] : [{ m: m.id, n }]
  })
  const tail = o.newTail
    ? [
        (id => `답하고 끝내기: switchboard reply ${id} --complete … / 답 없이 끝내기: switchboard complete ${id}`)(items.length === 1 ? String(items[0]!.id) : '<ID>'),
        ...answers.map(({ m, n }) => `메일 #${m} 은 지시 #${n} 의 답이다. 끝났으면 switchboard close ${m}`),
      ]
    : answers.map(({ m, n }) => `메일 #${m} 은 지시 #${n} 의 답이다. #${n} 은 아직 열려 있다 — 끝났으면 \`switchboard close ${n}\`, 더 시킬 것이 있으면 reply.`)

  return [blocks.join('\n\n'), ...tail].join('\n')
}

/** 로그용 ID 줄: 앞 5개만. */
const ids = (xs: readonly number[]) => {
  const sorted = [...xs].sort((a, b) => a - b)

  return sorted.slice(0, 5).map(i => `#${i}`).join(', ') + (sorted.length > 5 ? ` 외 ${sorted.length - 5}` : '')
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 프로필 파일을 읽는다. 없거나 모양이 틀리면 이유(토큰 없이). */
export const loadProfile = async (fs: Fs, path: string): Promise<MailProfile | { error: string }> => {
  let text: string | null
  try {
    text = await fs.read(path)
  } catch {
    return { error: `프로필을 못 읽음: ${path}` }
  }
  if (text === null) return { error: `프로필 없음: ${path}` }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // JSON 오류 문구에는 파일 내용(토큰)이 섞일 수 있어 그대로 옮기지 않는다.
    return { error: `프로필이 JSON 이 아님: ${path}` }
  }
  if (!isRecord(raw)) return { error: `프로필 모양이 틀림: ${path}` }
  const { endpoint, role, token } = raw
  if (typeof endpoint !== 'string' || endpoint === '' || typeof role !== 'string' || role === '' || typeof token !== 'string' || token === '') {
    return { error: `프로필에 endpoint·role·token 이 다 있어야 함: ${path}` }
  }

  return { endpoint: endpoint.replace(/\/+$/, ''), role, token }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const toEvent = (e: Record<string, unknown>, id: number): MailEvent => {
  const out: MailEvent = { id }
  const sender = str(e.sender)
  const subject = str(e.subject)
  const priority = str(e.priority)
  const body = str(e.body)
  const task = str(e.task_id)
  if (task !== undefined) out.task_id = task
  const ad = e.answers_directive
  if (isRecord(ad) && typeof ad.id === 'number' && Number.isInteger(ad.id) && typeof ad.state === 'string') out.answers_directive = { id: ad.id, state: ad.state }
  if (sender !== undefined) out.sender = sender
  if (subject !== undefined) out.subject = subject
  if (priority !== undefined) out.priority = priority
  if (body !== undefined) out.body = body

  return out
}

/** 긴급 메일 본문 상한(글자). 일반 메일 MAIL_INLINE_MAX 와 같다. 넘으면 자르고 전문 읽는 길(ID)을 붙인다. */
export const URGENT_MAX_CHARS = 4000

/** 긴급 메일을 세션에 넣을 글. 본문이 상한을 넘으면 잘라 ID로 전문을 읽게 한다. */
export const urgentText = (e: MailEvent, body: string, max = URGENT_MAX_CHARS): string => {
  const head = `[긴급 메일 #${e.id}] ${e.sender ?? '?'} | ${e.subject ?? ''}`.trimEnd()
  const chars = [...body]
  const cut = chars.length > max
  const shown = cut ? `${chars.slice(0, max).join('')}\n…(본문 ${chars.length}자 중 ${max}자까지 잘렸다. 이 글만으로 일을 시작하지 말고 먼저 switchboard read ${e.id} 로 전문을 읽어라)` : body

  // 도구 결과 자리에 붙으므로 모델이 주입으로 의심할 수 있다: 출처와 확인 길을 밝힌다(명령조를 피한다).
  return [
    `${head}`,
    `(switchboard 플러그인이 이 세션의 메일함 역할 앞으로 온 priority=urgent 메일을 전한다. 도구가 낸 글이 아니다. 출처는 switchboard read ${e.id} 로 확인할 수 있고, 이미 읽음 처리했다.)`,
    shown,
  ].join('\n')
}

/** 긴 대기 응답을 읽는다. 모양이 틀리면 null. */
const parsePoll = (text: string): { events: MailEvent[]; cursor: number } | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || !Array.isArray(raw.events) || typeof raw.cursor !== 'number') return null
  const events: MailEvent[] = []
  for (const e of raw.events) {
    if (isRecord(e) && typeof e.id === 'number' && Number.isInteger(e.id)) events.push(toEvent(e, e.id))
  }

  return { events, cursor: raw.cursor }
}

export const createMailbox = (host: AgentHost, opts: MailboxOptions): Mailbox => {
  const { http, clock } = host.services
  const log = (text: string) => {
    try {
      opts.log?.(text)
    } catch {
      // 기록이 실패해도 메일함은 간다.
    }
  }
  let profile: MailProfile | null = null
  let status: MailboxState['status'] = 'off'
  let cursor: number | null = null
  /** 큐에 넣었거나 이미 알린 ID. 다시 오면 거른다. */
  const known = new Set<number>()
  let queued: number[] = []
  /** 일반 메일 id → 그 답이 닫지 않은(open) 지시 id. */
  const openDirective = new Map<number, number>()
  /** 기다리는 일반 메일의 머리(보낸이·제목). */
  const meta = new Map<number, MailEvent>()
  /**
   * 받아 두고 아직 턴에 넣지 못한 일반 메일 본문(#203). 본문 GET 이 read 로 바꿨을 수 있어 pending 확인에서 빼지 않고,
   * 다음 시도에 다시 받지 않는다. 넣으면 지운다.
   */
  const bodies = new Map<number, string>()
  /** CLI 판(세션에 한 번, 슬롯 머리와 메일 꼬리가 함께 쓴다). */
  let versionRead: Promise<string | undefined> | undefined
  const readVersion = opts.cliVersion ?? opts.slot?.cliVersion
  const cliVersion = readVersion === undefined
    ? undefined
    : () => {
        versionRead ??= (async () => {
          let timer: Timer | undefined
          try {
            return await Promise.race([readVersion(), new Promise<undefined>(done => void (timer = clock.after(CLI_VERSION_TIMEOUT_MS, () => done(undefined))))]).finally(() => timer?.cancel())
          } catch {
            return undefined
          }
        })()

        return versionRead
      }
  /** 새 꼬리를 내도 되는가: CLI 가 MAIL_TAIL_MIN_VERSION 이상. 못 읽으면 옛 꼬리. */
  const newTail = async () => {
    const v = await cliVersion?.()

    return v !== undefined && versionAtLeast(v, MAIL_TAIL_MIN_VERSION)
  }
  /** 돌고 있는 일의 세대. stop·다시 잇기 때 올려 늦게 온 응답을 버린다. */
  let gen = 0
  let backoff = RETRY_MIN_MS
  let next_: Timer | undefined
  let watchdog: Timer | undefined
  let grace: Timer | undefined
  let delivering = false
  /** 알림 턴을 넣었고 아직 턴이 시작되지 않았다. */
  let awaitingTurn = false
  /** 넣으려고 기다리는 시스템 통지(받은 순). 일반 메일 뒤에 넣는다. */
  let noticeQ: MailEvent[] = []
  /** 바로 길에서 본문을 받아 둔 채 평소 길로 넘긴 통지 ID(본문 GET 이 read 로 바꿨을 수 있어 pending 확인에서 빼지 않는다). */
  const fetched = new Set<number>()
  /** 이번 start 에서 연결 통지를 보냈다(보내는 중 포함). */
  let notified = false
  /** start 마다 올린다(stop 뒤 늦게 도는 연결 통지 재시도를 버린다). */
  let epoch = 0
  /** 이번 start 시각(연결 통지의 Idempotency-Key). */
  let startedAt = 0
  /** slot 에 넘긴 세션 식별(연결 통지에 쓴다). */
  let me: { machine: string; directory: string; sessionId: string } | null = null
  /** 넣으려고 기다리는 긴급 메일(받은 순). */
  let urgentQ: MailEvent[] = []
  /** 긴급 길로 넣으려는 질문 답 메일(#144, 받은 순). */
  let answerQ: MailEvent[] = []
  let urgentBusy = false
  /** 긴급 메일 가로채는 쪽(onUrgent). */
  const urgentTaps = new Set<(e: MailEvent) => boolean>()
  /** 시스템 통지 글 바꾸는 쪽(onNotice). */
  const noticeTaps = new Set<NoticeTap>()
  /** 이어짐을 듣는 쪽(onLive). */
  const liveTaps = new Set<(role: string) => void>()
  /** 듣는 쪽이 가져간 글(DROP_NOTICE 면 null). 아무도 가져가지 않으면 undefined. */
  const claimed = async (e: MailEvent, body: string): Promise<string | null | undefined> => {
    for (const fn of [...noticeTaps]) {
      try {
        const text = await fn(e, body)
        if (text === null) continue

        return typeof text === 'string' ? text : null
      } catch {
        // 듣는 쪽의 잘못은 통지를 막지 않는다: 평소 글로.
      }
    }

    return undefined
  }
  /** 넣을 글. null 이면 넣지 않는다(듣는 쪽이 DROP_NOTICE). */
  const noticeOf = async (e: MailEvent, body: string): Promise<string | null> => {
    const text = await claimed(e, body)

    return text === undefined ? noticeText(e, body) : text
  }
  /** 가로챈 긴급 메일: 넣지 않고 read 로만. */
  const tapped = (e: MailEvent) => {
    for (const fn of [...urgentTaps]) {
      try {
        if (fn(e)) return true
      } catch {
        // 듣는 쪽의 잘못은 메일을 막지 않는다: 그대로 넣는다.
      }
    }

    return false
  }
  let off: (() => void) | undefined
  let slot: Slot | undefined
  /** 구독하는 주소. 번호를 받으면 `<base>-N`, 아니면 프로필 role. */
  let role: string | null = null
  /** 구독 루프를 시작했다(그 뒤의 번호 바뀜은 다시 잇기). */
  let polling = false

  const headers = (p: MailProfile) => roleHeaders(p.token, role ?? p.role)

  /** 번호 역할이 바뀌었다: 새 주소로 처음부터(커서 없이) 다시 잇는다. 이미 본 ID 는 known 이 거른다. */
  const setRole = (next: string) => {
    if (role === next) return
    role = next
    if (!polling || profile === null) return
    cursor = null
    gen++
    next_?.cancel()
    watchdog?.cancel()
    status = 'connecting'
    void poll()
  }
  const pollUrl = (p: MailProfile, after: number | null, timeout: number) =>
    `${p.endpoint}/api/events/poll?timeout=${timeout}${after === null ? '' : `&after=${after}`}`

  const schedule = (ms: number) => {
    next_?.cancel()
    const g = gen
    next_ = clock.after(ms, () => {
      if (g === gen) void poll()
    })
  }

  const fail = (why: string) => {
    if (status !== 'retrying') log(`switchboard 메일함: 끊김(${why}), 다시 잇는다`)
    status = 'retrying'
    gen++
    schedule(backoff)
    backoff = Math.min(backoff * 2, RETRY_MAX_MS)
  }

  const poll = async () => {
    const p = profile
    if (p === null) return
    const g = ++gen
    watchdog?.cancel()
    watchdog = clock.after(POLL_WATCHDOG_MS, () => {
      if (g === gen) fail('응답 없음')
    })
    let reply
    try {
      // 처음 잇거나 다시 이을 때는 기다리지 않고 밀린 것부터 받는다(이어졌는지도 곧 안다).
      const wait = status === 'live' ? POLL_TIMEOUT_S : 0
      reply = await http.fetch(pollUrl(p, cursor, wait), { method: 'GET', headers: headers(p) })
    } catch {
      // 오류 문구에 요청 머리(토큰)가 섞일 수 있어 옮기지 않는다.
      if (g === gen) {
        watchdog.cancel()
        fail('연결 실패')
      }

      return
    }
    if (g !== gen) return
    watchdog.cancel()
    if (!reply.ok) return fail(`HTTP ${reply.status}`)
    const body = parsePoll(reply.text)
    if (body === null) return fail('응답 모양이 틀림')
    const connecting = status !== 'live'
    if (connecting) log(`switchboard 메일함: ${role ?? p.role} 구독 중`)
    status = 'live'
    if (connecting) {
      const now = role ?? p.role
      for (const fn of [...liveTaps]) {
        try {
          fn(now)
        } catch {
          // 듣는 쪽의 잘못은 구독을 막지 않는다.
        }
      }
    }
    if (!notified) {
      notified = true
      void notifyParent(epoch)
    }
    backoff = RETRY_MIN_MS
    for (const e of body.events) {
      if (known.has(e.id)) continue
      known.add(e.id)
      if (e.priority === 'urgent' && tapped(e)) void markRead(p, e.id)
      else if (e.priority === 'urgent') urgentQ.push(e)
      else if (isAnswerMail(e)) answerQ.push(e)
      else if (isSystemNotice(e)) noticeQ.push(e)
      else {
        queued.push(e.id)
        meta.set(e.id, e)
        if (e.answers_directive?.state === 'open') openDirective.set(e.id, e.answers_directive.id)
      }
    }
    if (body.cursor > (cursor ?? -1)) cursor = body.cursor
    // (다시) 이었을 때 밀려 있던 일반 메일: 몇 통인지 남긴다(연결 전 메일이 들어가는지 화면에서 보이게).
    if (connecting && queued.length > 0) log(`switchboard 메일함: 밀려 있던 일반 메일 ${queued.length}통(${ids(queued)})을 넣는다`)
    void deliverUrgent()
    kick()
    // 받은 것이 있으면 곧바로 다음 대기(뒤에 더 있을 수 있다), 비었으면 잠깐 쉬고.
    if (body.events.length > 0) void poll()
    else schedule(EMPTY_GAP_MS)
  }

  /** 메일 한 통(send). 5xx·연결 실패는 tries 번까지 간격을 두고 다시, 4xx 는 바로 포기. */
  const sendMail = async (m: OutMail, ep: number, what = `「${m.subject}」 메일을`, tries = NOTICE_TRIES): Promise<boolean> => {
    const p = profile
    if (ep !== epoch || p === null) return false
    let why: string
    try {
      const r = await http.fetch(`${p.endpoint}/api/messages`, {
        method: 'POST',
        headers: { ...headers(p), 'Content-Type': 'application/json', ...(m.key === undefined ? {} : { 'Idempotency-Key': m.key }) },
        body: JSON.stringify({ recipient: m.to, subject: m.subject, body: m.body }),
      })
      if (r.ok) return true
      why = httpWhy(r.status, r.text)
      if (r.status >= 400 && r.status < 500) tries = 1
    } catch {
      // 오류 문구에 요청 머리(토큰)가 섞일 수 있어 옮기지 않는다.
      why = '연결 실패'
    }
    if (ep !== epoch || profile === null) return false
    if (tries <= 1) {
      log(`switchboard 메일함: ${m.to} 에 ${what} 못 보냄(${why})`)

      return false
    }
    await new Promise<void>(done => void clock.after(RETRY_MIN_MS * 5, done))

    return sendMail(m, ep, what, tries - 1)
  }

  /** 부모에게 연결 통지를 보낸다(SWITCHBOARD_PARENT 가 있을 때만). 실패해도 메일함은 간다. */
  const notifyParent = async (ep: number): Promise<void> => {
    if (ep !== epoch || profile === null) return
    const parent = opts.slot?.parent
    if (parent === undefined || parent === '' || me === null || role === null) return
    const label = opts.slot?.label
    const n = connectedNotice({ role, machine: me.machine, directory: me.directory, sessionId: me.sessionId, ...(label === undefined ? {} : { label }) })
    // 다시 보내도 한 통만(같은 세션·주소의 이번 연결).
    const key = `switchboard-connected-${me.sessionId || me.machine}-${role}-${startedAt}`
    if (await sendMail({ to: parent, subject: n.subject, body: n.body, key }, ep, '연결 통지를')) log(`switchboard 메일함: ${parent} 에 연결 통지를 보냈다`)
  }

  const call: Mailbox['call'] = async (path, init = {}, io = {}) => {
    const p = profile
    if (p === null) return null
    let timer: Timer | undefined
    try {
      const r = await Promise.race([
        (io.http ?? http).fetch(`${p.endpoint}${path}`, {
          method: init.method ?? 'GET',
          headers: { ...headers(p), ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
          ...(init.body === undefined ? {} : { body: init.body }),
        }),
        new Promise<null>(done => void (timer = clock.after(io.timeoutMs ?? CHECK_TIMEOUT_MS, () => done(null)))),
      ]).finally(() => timer?.cancel())

      return r === null ? null : { status: r.status, ok: r.ok, text: r.text }
    } catch {
      return null
    }
  }

  /** 지금도 pending 인 ID 만 남긴다(바쁜 동안 세션이 스스로 읽은 메일은 알리지 않는다). 못 물으면 그대로. */
  const stillPending = async (p: MailProfile, ids: number[]): Promise<number[]> => {
    try {
      // 멈춘 요청이 알림을 막지 않게 한도를 건다(넘으면 거르지 않고 알린다).
      let timer: Timer | undefined
      const r = await Promise.race([
        http.fetch(pollUrl(p, null, 0), { method: 'GET', headers: headers(p) }),
        new Promise<null>(done => void (timer = clock.after(CHECK_TIMEOUT_MS, () => done(null)))),
      ]).finally(() => timer?.cancel())
      if (r === null) return ids
      const body = r.ok ? parsePoll(r.text) : null
      // 한 응답은 200건까지: 꽉 찼으면 뒤쪽은 모르므로 거르지 않는다.
      if (body === null || body.events.length >= 200) return ids
      const live = new Set(body.events.map(e => e.id))

      return ids.filter(i => live.has(i))
    } catch {
      return ids
    }
  }

  /** 본문이 없으면(이벤트에 안 실림) 그 메일만 받아 온다(GET 은 읽음 처리도 한다). 못 받으면 빈 글. */
  const bodyOf = async (p: MailProfile, e: MailEvent): Promise<string> => {
    if (e.body !== undefined) return e.body
    try {
      const r = await http.fetch(`${p.endpoint}/api/messages/${e.id}`, { method: 'GET', headers: headers(p) })
      if (!r.ok) return ''
      const m: unknown = JSON.parse(r.text)

      return isRecord(m) && typeof m.body === 'string' ? m.body : ''
    } catch {
      return ''
    }
  }

  /** 일반 메일 본문(#203). 못 받으면(서버 오류·모양 틀림·연결 실패) undefined — 옛 꼴로 물러난다. */
  const fullBodyOf = async (p: MailProfile, id: number): Promise<string | undefined> => {
    try {
      let timer: Timer | undefined
      const r = await Promise.race([
        http.fetch(`${p.endpoint}/api/messages/${id}`, { method: 'GET', headers: headers(p) }),
        new Promise<null>(done => void (timer = clock.after(CHECK_TIMEOUT_MS, () => done(null)))),
      ]).finally(() => timer?.cancel())
      if (r === null || !r.ok) return undefined
      const m: unknown = JSON.parse(r.text)

      return isRecord(m) && typeof m.body === 'string' ? m.body : undefined
    } catch {
      return undefined
    }
  }

  const markRead = async (p: MailProfile, id: number) => {
    try {
      await http.fetch(`${p.endpoint}/api/messages/${id}/read`, { method: 'POST', headers: headers(p) })
    } catch {
      // 읽음 표시를 못 해도 메일은 이미 넣었다. 다시 잇기에서 다시 오지 않는다(커서·known).
    }
  }

  /**
   * 긴급 메일(D4): 바쁘면 다음 도구 호출 뒤에 끼워 넣고(기능 없으면 새 턴, 턴 뒤 맨 앞), 유휴면 새 턴으로 넣는다.
   * compact 중이면 끝난 뒤. 사용자 보류(isIdle 의 일부)는 따르지 않는다. 넣는 즉시 read 로 표시한다.
   */
  const deliverUrgent = async (): Promise<void> => {
    const p = profile
    if (urgentBusy || (urgentQ.length === 0 && answerQ.length === 0) || p === null) return
    const act = opts.activity?.() ?? (opts.isIdle() ? 'idle' : 'busy')
    if (act === 'compacting') return
    urgentBusy = true
    const items = urgentQ
    const answers = answerQ
    urgentQ = []
    answerQ = []
    let failed = false
    /** 넣지 않고 read 로만 표시할 것(듣는 쪽이 DROP_NOTICE). */
    let dropped: MailEvent[] = []
    let sent: MailEvent[] = []
    try {
      const texts = await Promise.all(items.map(async e => urgentText(e, await bodyOf(p, e))))
      // 질문 답 메일(#144): 이 세션 몫(듣는 쪽이 글을 준 것)만 여기서. 아무도 가져가지 않은 사본은 평소 통지 길로.
      for (const e of answers) {
        const body = await bodyOf(p, e)
        const text = await claimed(e, body)
        if (text === undefined) {
          fetched.add(e.id)
          noticeQ.push({ ...e, body })
        } else if (text === null) dropped.push(e)
        else {
          texts.push(text)
          sent.push(e)
        }
      }
      await Promise.all(dropped.map(e => markRead(p, e.id)))
      dropped = []
      if (texts.length === 0) return
      const text = texts.join('\n\n')
      const canInject = host.features.midTurnInject && host.injectMidTurn !== undefined
      let attached = false
      if (act === 'busy' && canInject && host.injectMidTurn !== undefined) attached = await host.injectMidTurn(text)
      if (!attached) {
        // 유휴, 끼워 넣기 기능 없음, 또는 도구 호출 없이 턴이 끝났다: 새 턴(돌고 있으면 그 턴 뒤 맨 앞).
        await host.submitTurn(text)
        awaitingTurn = true
        grace?.cancel()
        grace = clock.after(TURN_GRACE_MS, () => {
          awaitingTurn = false
          kick()
        })
      }
      await Promise.all([...items, ...sent].map(e => markRead(p, e.id)))
    } catch {
      failed = true
      urgentQ = [...items, ...urgentQ]
      // 아직 넣지 않은 답 메일만 되돌린다(평소 길로 넘긴 사본은 noticeQ 에 있다).
      answerQ = [...sent, ...dropped, ...answers.filter(e => !sent.includes(e) && !dropped.includes(e) && !fetched.has(e.id)), ...answerQ]
      clock.after(RETRY_MIN_MS * 5, () => void deliverUrgent())
    } finally {
      urgentBusy = false
      if (!failed && (urgentQ.length > 0 || answerQ.length > 0)) void deliverUrgent()
      else if (!failed) kick()
    }
  }

  /** 마지막으로 남긴 보류 까닭(같은 까닭은 한 번만). */
  let lastHeld: string | null = null
  const noteHeld = () => {
    if (queued.length === 0 || opts.holdReason === undefined) return
    let why: string | null
    try {
      why = opts.holdReason()
    } catch {
      return
    }
    if (why === null || why === lastHeld) return
    lastHeld = why
    log(`switchboard 메일함: 일반 메일 ${queued.length}통(${ids(queued)}) 미룸 — ${why}`)
  }

  const gate = async (): Promise<'ready' | 'wait'> => {
    try {
      return (await opts.beforeDeliver?.()) ?? 'ready'
    } catch {
      return 'ready'
    }
  }

  /** 시스템 통지: 일반 메일과 같은 시점·관문으로, ID 대신 본문을 넣고 read 로 표시한다. */
  const deliverNotices = (p: MailProfile) => {
    delivering = true
    let items = noticeQ
    noticeQ = []
    let failed = false
    void (async () => {
      // 바쁜 동안 세션이 스스로 읽은 통지는 넣지 않는다.
      const live = new Set(await stillPending(p, items.map(e => e.id)))
      items = items.filter(e => live.has(e.id) || fetched.has(e.id))
      for (const e of items) fetched.delete(e.id)
      if (profile === null || items.length === 0) return
      if (!opts.isIdle() || (await gate()) === 'wait') {
        noticeQ = [...items, ...noticeQ]

        return
      }
      if (profile === null) return
      try {
        const texts = (await Promise.all(items.map(async e => noticeOf(e, await bodyOf(p, e))))).filter((t): t is string => t !== null)
        // 모두 거른 통지(#120)면 턴을 열지 않고 read 로만.
        if (texts.length > 0) {
          await host.submitTurn(texts.join('\n\n'))
          awaitingTurn = true
          grace?.cancel()
          grace = clock.after(TURN_GRACE_MS, () => {
            awaitingTurn = false
            kick()
          })
        }
        await Promise.all(items.map(e => markRead(p, e.id)))
      } catch {
        failed = true
        noticeQ = [...items, ...noticeQ]
        clock.after(RETRY_MIN_MS * 5, () => kick())
      }
    })().finally(() => {
      delivering = false
      if (!awaitingTurn && !failed) kick()
    })
  }

  const kick = () => {
    // 긴급이 넣어지는 중이면 일반은 그 뒤에(입력 줄 순서: 긴급 → 일반).
    if (urgentBusy || urgentQ.length > 0 || answerQ.length > 0) return
    if (delivering || awaitingTurn || profile === null) return
    if (!opts.isIdle()) {
      noteHeld()

      return
    }
    lastHeld = null
    // 입력 줄 순서: 일반 메일 → 시스템 통지.
    if (queued.length === 0) {
      if (noticeQ.length > 0) deliverNotices(profile)

      return
    }
    delivering = true
    const p = profile
    const ids = [...queued].sort((a, b) => a - b)
    queued = []
    let failed = false
    void (async () => {
      // 본문을 받아 둔 메일(#203)은 서버에서 read 일 수 있다: pending 확인에서 빼지 않는다.
      const live = new Set(await stillPending(p, ids))
      const send = ids.filter(i => live.has(i) || bodies.has(i))
      for (const i of ids) if (!send.includes(i)) meta.delete(i)
      if (profile === null) return
      if (send.length === 0) return
      // 확인하는 사이 턴이 시작됐으면 다음 턴 끝으로 미룬다.
      if (!opts.isIdle()) {
        queued = [...send, ...queued]

        return
      }
      // 관문(메일 전 compact 등): 기다리라면 되돌려 두고 끝난 뒤의 kick 에 맡긴다.
      if ((await gate()) === 'wait') {
        queued = [...send, ...queued]

        return
      }
      if (profile === null) return
      try {
        // 본문을 받는다(#203). 못 받은 통은 옛 꼴(ID 만)로 넣고 읽음 처리하지 않는다.
        await Promise.all(
          send.filter(i => !bodies.has(i)).map(async i => {
            const b = await fullBodyOf(p, i)
            if (b !== undefined) bodies.set(i, b)
          }),
        )
        const to = role ?? p.role
        const items: MailItem[] = send.map(i => {
          const e = meta.get(i)
          const body = bodies.get(i)

          return {
            id: i,
            to,
            ...(e?.sender === undefined ? {} : { sender: e.sender }),
            ...(e?.subject === undefined ? {} : { subject: e.subject }),
            ...(body === undefined ? {} : { body }),
          }
        })
        await host.submitTurn(mailTurn(items, { open: openDirective, newTail: await newTail() }))
        const got = send.filter(i => bodies.has(i))
        for (const m of send) {
          openDirective.delete(m)
          meta.delete(m)
          bodies.delete(m)
        }
        // 본문을 넣은 통만 읽음 처리한다(GET 이 이미 했을 수 있지만 서버마다 다를 수 있다).
        await Promise.all(got.map(i => markRead(p, i)))
        awaitingTurn = true
        grace?.cancel()
        grace = clock.after(TURN_GRACE_MS, () => {
          awaitingTurn = false
          kick()
        })
      } catch {
        // 넣지 못했다: 되돌려 놓고 잠시 뒤 다시.
        failed = true
        queued = [...send, ...queued]
        clock.after(RETRY_MIN_MS * 5, () => kick())
      }
    })().finally(() => {
      delivering = false
      // 확인하는 사이 새로 쌓인 것이 있으면 이어서(넣기가 실패했으면 위의 재시도에 맡긴다).
      if (!awaitingTurn && !failed) kick()
    })
  }

  const start = async () => {
    if (profile !== null) return true
    const disabled = (why: string) => {
      // 프로필 이름이 있는데 조용히 꺼지면 안 된다: 화면에도 한 번.
      const line = `switchboard 메일함 꺼짐: ${why}`
      log(line)
      try {
        opts.warn?.(line)
      } catch {
        // 알리기 실패가 시작을 막지 않는다.
      }

      return false
    }
    if (opts.profilePath === null) return opts.profileProblem === undefined ? false : disabled(opts.profileProblem)
    const paths = typeof opts.profilePath === 'string' ? [opts.profilePath] : [...opts.profilePath]
    if (paths.length === 0) return false
    let loaded: MailProfile | { error: string } = { error: `프로필 없음: ${paths.join(', ')}` }
    for (const path of paths) {
      const r = await loadProfile(host.services.fs, path)
      // 없는 파일만 다음 후보로 넘어간다. 있는데 못 읽거나 틀리면 그 까닭을 알린다.
      if ('error' in r && r.error.startsWith('프로필 없음')) continue
      loaded = r
      break
    }
    if ('error' in loaded) return disabled(loaded.error)
    const ep = opts.override?.endpoint?.trim() ?? ''
    const tk = opts.override?.token?.trim() ?? ''
    if (ep !== '') loaded = { ...loaded, endpoint: ep.replace(/\/+$/, '') }
    if (tk !== '') loaded = { ...loaded, token: tk }
    profile = loaded
    role = loaded.role
    status = 'connecting'
    epoch++
    notified = false
    noticeQ = []
    startedAt = await clock.now()
    if (opts.slot !== undefined) {
      const cfg = opts.slot
      const id = await host.identity()
      // 서버가 둘 다 비어 있지 않기를 바란다. 기계 이름을 모르면 세션 id 로라도 가른다.
      me = {
        machine: id.machine !== '' ? id.machine : `session-${id.sessionId || 'unknown'}`,
        directory: id.cwd !== '' ? id.cwd : '/',
        sessionId: id.sessionId,
      }
      const s = createSlot(host, {
        auth: loaded,
        identity: {
          ...me,
          ...(cfg.label === undefined ? {} : { label: cfg.label }),
          ...(cfg.parent === undefined ? {} : { parent: cfg.parent }),
        },
        presence: cfg.presence,
        onRole: r => {
          setRole(r)
          try {
            cfg.onRole?.(r)
          } catch {
            // 바깥(환경변수 등)의 잘못이 구독을 막지 않는다.
          }
        },
        log,
        ...(cfg.warn === undefined ? {} : { warn: cfg.warn }),
        ...(cfg.singleRoles === undefined ? {} : { singleRoles: cfg.singleRoles }),
        ...(cliVersion === undefined ? {} : { cliVersion }),
      })
      slot = s
      // 번호를 받은 뒤 구독한다(-2 세션이 잠깐이라도 -1 메일을 받지 않게). 못 받으면(옛 서버·끊김) 기반 역할로.
      await s.start()
      if (profile === null) return false
    }
    off = host.on(e => {
      if (e.type === 'turn.start') {
        awaitingTurn = false
        grace?.cancel()
      }
      // 턴 시작·끝·compact 끝: 긴급은 바로 넣어 보고(바쁘면 끼워 넣기), 일반은 유휴일 때.
      if (e.type === 'turn.start' || e.type === 'turn.complete' || e.type === 'compact.complete') void deliverUrgent()
      if (e.type === 'turn.complete' || e.type === 'compact.complete') kick()
    })
    polling = true
    void poll()

    return true
  }

  const stop = () => {
    gen++
    epoch++
    profile = null
    role = null
    polling = false
    status = 'off'
    const released = slot?.stop() ?? Promise.resolve()
    slot = undefined
    next_?.cancel()
    watchdog?.cancel()
    grace?.cancel()
    off?.()
    off = undefined

    return released
  }

  const takeover = async (): Promise<TakeoverResult> =>
    slot === undefined ? { ok: false, reason: '번호 역할이 꺼져 있다(SWITCHBOARD_PROFILE 없음 등)' } : slot.takeover()

  return {
    start,
    stop,
    kick,
    report: () => slot?.report(),
    takeover,
    state: () => ({ status, cursor, queued: [...queued], role }),
    send: m => sendMail(m, epoch),
    call,
    onUrgent: fn => {
      urgentTaps.add(fn)

      return () => void urgentTaps.delete(fn)
    },
    onNotice: fn => {
      noticeTaps.add(fn)

      return () => void noticeTaps.delete(fn)
    },
    onLive: fn => {
      liveTaps.add(fn)

      return () => void liveTaps.delete(fn)
    },
    parent: () => {
      const v = opts.slot?.parent

      return v === undefined || v === '' ? undefined : v
    },
  }
}
