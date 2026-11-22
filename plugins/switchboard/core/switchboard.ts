// switchboard 코어: 에이전트를 모른다. AgentHost 포트(host.ts)만 보고 세션의 바깥 상태(유휴·바쁨·compact 중,
// 사용자가 입력 중인가)를 따라간다. D2 이후의 메일함(SSE 구독·등급별 입력 줄·compact 판단·presence)이
// 이 위에 붙는다. 질문 패널 상태는 questions.ts 가 맡는다. 메일함은 mailbox.ts(D2).
import type { AgentHost, CompactResult, Features, Http, Timer } from './host'
import { createBossJudge } from './boss'
import type { BossJudge } from './boss'
import { createMailbox } from './mailbox'
import { SYSTEM_SUBJECT_PREFIX } from './mailbox'
import type { Mailbox, MailboxOptions, MailboxState, SlotConfig } from './mailbox'
import { createPermissions } from './permission'
import type { PermissionAnswer, PermissionAsk, PermissionOptions, Permissions } from './permission'
import { createRemoteAsk } from './remote-ask'
import { createRemoteInbox } from './remote-inbox'
import type { RemoteInbox, RemoteInboxOptions, RemoteSink } from './remote-inbox'
import type { RemoteAnswer } from './remote-questions'
import type { RemoteAnswerOutcome } from './questions'
import type { RemoteAsk, RemoteAskResult, WithdrawResult } from './remote-ask'
import type { PresenceReport, TakeoverResult } from './slot'
import type { QuestionPanelQuestion } from '../types'
import { createRuleHints, createUnclassifiedHold } from './rules'
import type { RuleHintsBox, StopVerdict, ToolCall, UnclassifiedHold } from './rules'
import { createStall } from './stall'
import type { Stall, StallNotice, StallOptions } from './stall'

export type Activity = 'idle' | 'busy' | 'compacting'

export type BoardState = {
  /** start 가 본 세션임을 확인했고 stop 하지 않았다. 꺼져 있으면 아무것도 넣지 않는다. */
  active: boolean
  activity: Activity
  /** 입력창에 사용자가 쓴 글이 있다. */
  typing: boolean
  /** 마지막으로 사용자가 입력창을 바꾸거나 제출한 시각(ms). 없으면 null. */
  lastInputAt: number | null
  /** 멈춤(D8): `error:<종류>`(API 오류로 멈춤)·`blocked:<종류>`(사람을 기다림). 없으면 null. */
  condition: string | null
}

/** 실제로 쓸 수 있는 기능: 플래그가 켜져 있고 메서드도 있어야 한다. */
export const capabilities = (host: AgentHost): Features => ({
  midTurnInject: host.features.midTurnInject && host.injectMidTurn !== undefined,
  compact: host.features.compact && host.compact !== undefined,
})

export type Switchboard = {
  /** 본 세션이면 이벤트를 듣기 시작하고 true. 서브에이전트 등이면 아무것도 하지 않고 false. */
  start: () => Promise<boolean>
  /** 끈다. 번호 역할 release 가 끝나면 풀린다(정상 종료: 서버가 offline 통지를 보내지 않는다). */
  stop: () => Promise<void>
  state: () => BoardState
  /**
   * 대화를 줄인다. 기능이 없으면 건너뛰고(기능 낮추기), 턴이 돌거나 이미 줄이는 중이면 하지 않는다.
   * 끝(compact.complete 이벤트)은 activity 가 idle 로 돌아오는 것으로 본다.
   */
  compact: (instructions?: string) => Promise<CompactResult>
  /** 메일함 상태(꺼져 있으면 status off). */
  mail: () => MailboxState
  /** 이 세션이 `<base>-1` 을 가져온다(D6, 중복 경고를 받았을 때). */
  takeover: () => Promise<TakeoverResult>
  /**
   * 권한 창이 뜨기 전 원격 답(D8). 부모·대장이 시간 안에 답하면 그 답, 아니면 null(화면 창으로).
   * 메일함이 꺼져 있으면 바로 null.
   */
  askPermission: (a: PermissionAsk, io?: { http?: Pick<Http, 'fetch'> }) => Promise<PermissionAnswer | null>
  /**
   * 원격 질문(#111): 메일함이 켜져 있으면 서버 질문으로 올린다. 못 올리면 로컬(까닭), 메일함이 꺼져 있으면 로컬(까닭 null).
   * 답 메일은 메일함이 「[질문 패널 답 <id>] …」 글로 바꿔 넣는다.
   */
  askRemote: (questions: readonly QuestionPanelQuestion[], io?: { http?: Pick<Http, 'fetch'> }, relayTo?: readonly string[]) => Promise<RemoteAskResult>
  /** 서버 질문을 거둔다(resolve). 메일함이 꺼져 있으면 실패. */
  withdrawRemote: (id: string, io?: { http?: Pick<Http, 'fetch'> }) => Promise<WithdrawResult>
  /** 원격 질문(#112, 대장 세션): 패널 답을 서버로 보낸다. 끌어오기가 꺼져 있으면 failed. */
  answerRemote: (id: string, answers: readonly RemoteAnswer[]) => Promise<RemoteAnswerOutcome>
  /**
   * 규칙 원장(#219): 도구 호출에 걸린 규칙 줄(`결정 #N 참고: …`). 루프(본 세션 '', 서브에이전트는 그 id)마다 한 번,
   * 본 세션은 compact 뒤 한 번 더. 메일함이 꺼져 있으면(프로필 없음) 서버를 부르지 않고 빈 목록.
   */
  ruleLines: (call: ToolCall, loop: string, io?: { http?: Pick<Http, 'fetch'> }) => Promise<string[]>
  /** 규칙 원장을 다시 확인할 때가 됐으면 미리 띄운다(도구가 도는 동안 받게). */
  warmRules: (io?: { http?: Pick<Http, 'fetch'> }) => void
  /**
   * 미분류 답 붙들기(#221): 본 세션이 턴을 끝내려 할 때. 이 역할의 패널 질문 답이 분류되지 않았으면 block,
   * 같은 묶음으로 여러 번 막았으면 release(메모), 그 밖(없음·프로필 없음·서버 불통·오류)은 end.
   */
  stopCheck: (io?: { http?: Pick<Http, 'fetch'> }) => Promise<StopVerdict>
}

export type SwitchboardOptions = {
  /** 메일함. 없거나 profilePath 가 null 이면 꺼진다. */
  mail?: Omit<MailboxOptions, 'isIdle' | 'activity' | 'beforeDeliver' | 'slot'> & {
    /** 번호 역할·presence(D6). presence 내용은 코어가 채운다. 없으면 번호 없이 프로필 role 로 구독한다. */
    slot?: Omit<SlotConfig, 'presence'>
  }
  /** 일반 메일 전 compact(D3). 컨텍스트가 thresholdTokens 이상이면 먼저 줄인다. 없으면 하지 않는다. */
  compactBeforeMail?: { thresholdTokens: number; instructions?: string }
  /**
   * 입력 중 보류 상한(ms, #123). 사람이 마지막으로 입력창을 바꾼 뒤 이만큼 지나면 글이 남아 있어도 입력 중으로 보지 않는다
   * (자리를 비운 채 남은 글이 메일을 끝없이 막지 않게). 0 이면 상한 없음. 없으면 기본 5분.
   */
  typingLimitMs?: number
  /** 멈춤 감지(D8) 재시도 간격·횟수. 없으면 기본(30초부터 두 배, 10분 상한, 8번). */
  stall?: Pick<StallOptions, 'retry'>
  /** 원격 권한 답(D8). waitMs 0 이면 끈다. bosses 는 오류 통지도 받는다. */
  permissions?: Pick<PermissionOptions, 'waitMs' | 'pollMs' | 'bosses'>
  /**
   * compact 가 끝나기를 기다리는 한도(ms, #104). 이 안에 완료 이벤트가 없거나 호출이 풀리지 않으면 compacting 을
   * 풀고 기다리던 메일을 넣는다(그 메일 턴이 돌기 전에는 다시 걸지 않는다). 없으면 기본 5분.
   */
  compactTimeoutMs?: number
  /** 서브에이전트 끝 알림을 기다리는 한도(ms, 마지막 시작 뒤). 넘으면 0으로 돌리고 알린다. 0 이면 한도 없음. */
  subagentLimitMs?: number
  /**
   * 원격 질문 대장 쪽(#112). 있으면 메일함 역할이 대장(permissions.bosses)일 때 서버 질문을 끌어와 sink(질문 패널)에 올린다.
   */
  remoteQuestions?: { sink: RemoteSink } & Pick<RemoteInboxOptions, 'timeoutS' | 'retry' | 'idleMs'>
  /** 기록 한 줄(재시도·권한 등). */
  log?: (text: string) => void
  /** 화면에 한 번 알릴 것(compact 시간 초과 등). 없으면 log 로. */
  warn?: (text: string) => void
}

/** 멈춤 통지 메일(제목은 시스템 통지 머리로 시작: 받는 쪽 switchboard 가 본문 그대로 넣는다). */
export const stallNotice = (n: StallNotice, who: { role: string; label?: string; machine: string; directory: string }) => {
  const label = who.label === undefined || who.label === '' ? '' : ` (라벨 ${who.label})`
  const where = [`주소: ${who.role}${label}`, `기계: ${who.machine}`, `폴더: ${who.directory}`]
  if (n.kind === 'error') {
    const why =
      n.tries === undefined
        ? '저절로 풀리지 않는 종류라 다시 시도하지 않는다.'
        : `${n.tries}번 다시 시도했지만 풀리지 않아 멈췄다.`

    return {
      subject: `${SYSTEM_SUBJECT_PREFIX}오류 ${n.what} ${who.role}${label}`,
      body: [`switchboard: 아래 세션의 턴이 API 오류(${n.what})로 멈췄다. ${why} 사람이 살펴야 한다(오류 본문은 그 세션 화면에 있다).`, ...where].join('\n'),
    }
  }
  const what = n.what === 'permission_prompt' ? '권한 창' : n.what === 'idle_prompt' ? '입력 대기' : n.what === 'elicitation_dialog' ? '입력 양식' : n.what

  return {
    subject: `${SYSTEM_SUBJECT_PREFIX}기다림 ${n.what} ${who.role}${label}`,
    body: [`switchboard: 아래 세션이 사람을 기다린다(${what}). 그 세션 화면에서 답하거나 메일로 지시해야 이어 간다.`, ...where].join('\n'),
  }
}

/** 입력 중 보류 기본 상한(5분, #123). */
export const DEFAULT_TYPING_MS = 5 * 60_000

/** 환경변수 글(분)로 입력 중 보류 상한(ms)을 만든다. 비거나 숫자가 아니면 기본 5분, 0 이면 상한 없음. */
/** 입력창 글이 비었다고 볼 글인가: 공백·제어·보이지 않는 글자(너비 0 공백 등)뿐이면 비었다(#168). */
export const isBlank = (text: string): boolean => /^[\p{White_Space}\p{Cc}\p{Cf}]*$/u.test(text)

export const typingConfig = (minutes: string | undefined): number => {
  const t = (minutes ?? '').trim()
  if (!/^\d+(\.\d+)?$/.test(t)) return DEFAULT_TYPING_MS

  return Math.round(Number(t) * 60_000)
}

/** compact 완료를 기다리는 기본 한도(5분). */
export const DEFAULT_COMPACT_TIMEOUT_MS = 5 * 60_000
export const DEFAULT_SUBAGENT_LIMIT_MS = 4 * 60 * 60_000

/** 메일 전 compact 기본 기준(토큰). */
export const DEFAULT_COMPACT_TOKENS = 200_000

/**
 * 환경변수 글로 메일 전 compact 설정을 만든다. tokens: 비면 기본 200k, `0`·`off` 이면 끔(undefined),
 * 숫자가 아니면 기본. 뒤에 k 를 붙여도 된다(`150k`). instructions: 비면 에이전트 기본 요약.
 */
export const compactConfig = (
  tokens: string | undefined,
  instructions: string | undefined,
): SwitchboardOptions['compactBeforeMail'] => {
  const t = (tokens ?? '').trim().toLowerCase()
  if (t === '0' || t === 'off') return undefined
  const m = /^(\d+(?:\.\d+)?)(k?)$/.exec(t)
  const n = m === null ? DEFAULT_COMPACT_TOKENS : Math.round(Number(m[1]) * (m[2] === 'k' ? 1000 : 1))
  const ins = (instructions ?? '').trim()

  return { thresholdTokens: n > 0 ? n : DEFAULT_COMPACT_TOKENS, ...(ins === '' ? {} : { instructions: ins }) }
}

export const createSwitchboard = (host: AgentHost, opts: SwitchboardOptions = {}): Switchboard => {
  const st: BoardState = { active: false, activity: 'idle', typing: false, lastInputAt: null, condition: null }
  let stall: Stall | undefined
  let permissions: Permissions | undefined
  let rules: RuleHintsBox | undefined
  let unclassified: UnclassifiedHold | undefined
  let boss: BossJudge | undefined
  let remote: { ask: RemoteAsk; off: () => void } | undefined
  let inbox: RemoteInbox | undefined
  /** 원격 권한 답을 기다리는 건수(그동안 presence 는 blocked:permission_request). */
  let permWaiting = 0
  let stallCondition: string | null = null
  let self: { machine: string; cwd: string } = { machine: '', cwd: '' }
  const meSet = (id: { machine: string; cwd: string }) => {
    self = { machine: id.machine, cwd: id.cwd }
  }
  const log = (t: string) => {
    try {
      opts.log?.(t)
    } catch {
      // 기록이 실패해도 간다.
    }
  }
  const syncCondition = () => {
    const next = permWaiting > 0 ? 'blocked:permission_request' : stallCondition
    if (st.condition === next) return
    st.condition = next
    mailbox?.report()
  }
  /** 멈춤 통지: 오류는 부모와 대장, 기다림은 부모. 받을 쪽이 없거나 메일함이 꺼져 있으면 기록만. */
  const notifyStall = (n: StallNotice) => {
    const m = mailbox
    const role = m?.state().role ?? null
    const parent = m?.parent()
    const to = [...new Set([...(parent === undefined ? [] : [parent]), ...(n.kind === 'error' ? (opts.permissions?.bosses ?? []) : [])])]
    if (m === undefined || role === null || to.length === 0) {
      log(`switchboard: ${n.kind === 'error' ? `API 오류(${n.what})로 멈췄다` : `사람을 기다린다(${n.what})`}, 알릴 곳 없음`)

      return
    }
    const label = opts.mail?.slot?.label
    const text = stallNotice(n, { role, machine: self.machine, directory: self.cwd, ...(label === undefined ? {} : { label }) })
    void host.services.clock.now().then(t => {
      for (const r of to) void m.send({ to: r, ...text, key: `switchboard-${n.kind}-${n.what}-${role}-${r}-${t}` })
    })
  }
  let off: (() => void) | undefined
  let mailbox: Mailbox | undefined
  /** 메일 전 compact 를 했고 아직 그 메일 턴이 돌지 않았다(줄여도 기준 위면 되풀이하지 않게). */
  let compactedForMail = false
  const typingMs = Math.max(0, opts.typingLimitMs ?? DEFAULT_TYPING_MS)
  /** 돌고 있는 백그라운드 서브에이전트(id). 끝 알림이 없어도 subagentLimitMs 뒤에는 비운다. */
  const subagents = new Set<string>()
  const subagentLimitMs = Math.max(0, opts.subagentLimitMs ?? DEFAULT_SUBAGENT_LIMIT_MS)
  let subagentWatch: Timer | undefined
  const armSubagentWatch = () => {
    subagentWatch?.cancel()
    subagentWatch = undefined
    if (subagents.size === 0 || subagentLimitMs === 0) return
    const watch = host.services.clock.after(subagentLimitMs, () => {
      if (subagentWatch !== watch) return
      subagentWatch = undefined
      const n = subagents.size
      if (n === 0) return
      subagents.clear()
      const text = `switchboard: 서브에이전트 ${n}개의 끝 알림이 ${Math.round(subagentLimitMs / 360_000) / 10}시간 안에 오지 않아 끝난 것으로 본다`
      log(text)
      try {
        ;(opts.warn ?? log)(text)
      } catch {
        // 알림이 실패해도 간다.
      }
      mailbox?.report()
      mailbox?.kick()
    })
    subagentWatch = watch
  }
  /** 마지막 턴이 끝난 시각(RFC3339, presence 용). */
  let lastTurnAt: string | undefined
  /** presence: 상태·컨텍스트 토큰·마지막 턴. 토큰 수를 못 읽으면 빼고 보낸다(서버가 이전 값을 둔다). */
  const presence = async (): Promise<PresenceReport> => {
    const out: PresenceReport = { state: st.activity }
    if (st.condition !== null) out.condition = st.condition
    try {
      // 0 은 「모름」이다(resume 직후 등): 보내면 서버가 0.0k 로 보인다.
      const t = Math.round((await host.usage()).tokens)
      if (t > 0) out.context_tokens = t
    } catch {
      // 모르면 뺀다.
    }
    if (lastTurnAt !== undefined) out.last_turn_at = lastTurnAt
    if (subagents.size > 0) out.subagents = subagents.size

    return out
  }
  /** 입력 중 상한 타이머: 사람이 마지막으로 바꾼 뒤 typingMs 가 지나면 입력 중을 풀고 메일함을 깨운다(#123). */
  let typingTimer: Timer | undefined
  const setTyping = (on: boolean) => {
    typingTimer?.cancel()
    typingTimer = undefined
    st.typing = on
    if (!on || typingMs <= 0) return
    typingTimer = host.services.clock.after(typingMs, () => {
      typingTimer = undefined
      st.typing = false
      mailbox?.kick()
    })
  }
  /**
   * 입력 중인데 메일이 막혔다: 입력창의 실제 글을 읽어 비었으면 풀고 메일함을 깨운다(#168). 사건이 코어에 못 닿은
   * 비움(어댑터가 듣지 못한 경로)을 바로잡는 안전망이다. 읽는 중이면 또 읽지 않고, 못 읽으면 아무것도 안 한다.
   */
  let verifying = false
  const verifyTyping = () => {
    if (verifying || host.readInput === undefined) return
    verifying = true
    void host
      .readInput()
      .then(text => {
        if (st.typing && isBlank(text)) {
          setTyping(false)
          mailbox?.kick()
        }
      })
      .catch(() => undefined)
      .finally(() => void (verifying = false))
  }
  const held = () => {
    if (st.typing) verifyTyping()

    return st.typing
  }

  /**
   * 메일 턴 직전: 유휴이고 컨텍스트가 기준 이상이면 compact 를 걸고 'wait'. 완료 이벤트(compact.complete)가
   * 메일함을 다시 깨운다(시간 sleep 없음). 바쁘거나 기능이 없거나 기준 아래거나 거절되면 'ready'.
   */
  const compactBeforeMail = async (): Promise<'ready' | 'wait'> => {
    const cfg = opts.compactBeforeMail
    if (cfg === undefined || compactedForMail || !capabilities(host).compact || st.activity !== 'idle') return 'ready'
    // 서브에이전트가 도는 동안은 부모의 맥락이 결과를 기다리는 중이라 자르지 않는다.
    if (subagents.size > 0) return 'ready'
    let tokens: number
    try {
      tokens = (await host.usage()).tokens
    } catch {
      return 'ready'
    }
    // 모르면(0·NaN) 판정하지 않는다.
    if (!(tokens > 0) || tokens < cfg.thresholdTokens || st.activity !== 'idle') return 'ready'
    compactedForMail = true
    const r = await compact(cfg.instructions)

    // 받아들여졌으면 끝(compact.complete)까지 기다린다. 거절이면 그대로 넣는다.
    return r.done ? 'wait' : 'ready'
  }
  // 이벤트 순서대로 시각을 적는다(clock.now 는 비동기라 마지막 값만 남긴다).
  const stamp = () => {
    void host.services.clock.now().then(t => {
      st.lastInputAt = Math.max(st.lastInputAt ?? 0, t)
    })
  }

  const start = async () => {
    if (st.active) return true
    const me = await host.identity()
    if (!me.isMain) return false
    st.active = true
    meSet(me)
    stall = createStall(host, {
      ...(opts.stall?.retry === undefined ? {} : { retry: opts.stall.retry }),
      setCondition: c => {
        stallCondition = c
        syncCondition()
      },
      notify: notifyStall,
      log,
    })
    off = host.on(e => {
      stall?.onEvent(e)
      const was = st.activity
      switch (e.type) {
        case 'turn.start':
          st.activity = 'busy'
          // 새 턴이 돌았다: 다음 메일 앞에서는 다시 compact 를 볼 수 있다.
          compactedForMail = false
          break
        case 'turn.complete':
          // compact 중에 끝난 턴(드묾)은 compact 완료가 마저 풀어 준다.
          if (st.activity === 'busy') st.activity = 'idle'
          void host.services.clock.now().then(t => {
            lastTurnAt = new Date(t).toISOString()
          })
          break
        case 'subagent.start':
          subagents.add(e.id)
          armSubagentWatch()
          mailbox?.report()
          break
        case 'subagent.stop':
          if (subagents.delete(e.id)) {
            armSubagentWatch()
            mailbox?.report()
          }
          break
        case 'compact.complete':
          rules?.compacted()
          st.activity = 'idle'
          compactWatch?.cancel()
          compactWatch = undefined
          break
        case 'input.change': {
          const was = st.typing
          // 사람이 바꾼 것(치기·기록 불러오기·되돌리기)만 입력 중으로 친다. 플러그인 채우기·엔진 쓰기(prefill 등)는
          // 비웠을 때만 따른다(#123). 사람이 바꿀 때마다 상한을 다시 센다.
          const person = (e.by ?? 'person') === 'person'
          const empty = isBlank(e.text)
          if (person || empty) setTyping(!empty)
          if (person) stamp()
          // 입력창을 비웠다: 미룬 메일을 넣어 본다.
          if (was && !st.typing) mailbox?.kick()
          break
        }
        case 'input.submit':
          // 플러그인이 넣은 턴(메일 알림 등)은 사람 입력이 아니다: 입력창도 그대로다.
          if ((e.origin ?? 'user') !== 'user') break
          setTyping(false)
          stamp()
          break
      }
      // 상태가 바뀌면 곧 presence 를 보고한다(60초 주기와 따로).
      if (st.activity !== was) mailbox?.report()
    })
    // 메일함은 본 세션에서만. 듣는 순서상 위 상태가 먼저 바뀐 뒤 메일함이 턴 끝을 본다.
    if (opts.mail !== undefined) {
      const { slot, ...mail } = opts.mail
      mailbox = createMailbox(host, {
        ...mail,
        ...(slot === undefined ? {} : { slot: { ...slot, presence } }),
        isIdle: () => st.active && st.activity === 'idle' && !held(),
        // 턴·compact 는 곧 끝나므로 남기지 않는다. 사람 쪽 보류만 까닭을 남긴다.
        holdReason: () =>
          st.typing
            ? `입력창에 글이 있음(비우거나 보내면${typingMs > 0 ? `, 마지막 입력 ${typingMs / 60_000}분 뒤` : ''} 넣는다)`
            : null,
        activity: () => st.activity,
        beforeDeliver: compactBeforeMail,
      })
      await mailbox.start().catch(() => false)
      // 규칙 원장(#219): 프로필이 없으면 call 이 서버를 부르지 않는다. 세션 시작에 미리 받아 둔다.
      if (mailbox.state().status !== 'off') {
        rules = createRuleHints(mailbox.call, host.services.clock)
        rules.warm()
        const mb = mailbox
        unclassified = createUnclassifiedHold(mailbox.call, () => mb.state().role)
      }
      // 대장 판정 하나(#130): 연결될 때마다 whoami, 옛 서버·실패면 전역 목록. 권한·질문 양쪽이 같이 쓴다.
      const judge = createBossJudge(mailbox, { bosses: opts.permissions?.bosses ?? [], log, onChange: () => inbox?.recheck() })
      boss = judge
      permissions = createPermissions(host, mailbox, { ...opts.permissions, gated: judge.permissionsGated, log })
      // 대장 쪽(아래 inbox)이 켜지는 세션만 대장 판정을 준다: 참조 질문 메일을 패널에 맡기고 세션에 넣지 않는다(#120).
      const ask = createRemoteAsk(mailbox, { log, ...(opts.remoteQuestions === undefined ? {} : { isBoss: judge.isBoss }) })
      remote = { ask, off: mailbox.onNotice(ask.noticeText) }
      const rq = opts.remoteQuestions
      if (rq !== undefined && mailbox.state().status !== 'off') {
        const { sink, ...rest } = rq
        inbox = createRemoteInbox(host, mailbox, { ...rest, sink, bosses: opts.permissions?.bosses ?? [], isBoss: judge.isBoss, log, own: ask.owns, settle: ask.settle })
        inbox.start()
      }
    }

    return true
  }

  const stop = () => {
    compactWatch?.cancel()
    compactWatch = undefined
    permissions?.stop()
    permissions = undefined
    rules = undefined
    unclassified = undefined
    boss?.stop()
    boss = undefined
    remote?.off()
    remote = undefined
    inbox?.stop()
    inbox = undefined
    stall?.stop()
    stall = undefined
    const done = mailbox?.stop() ?? Promise.resolve()
    mailbox = undefined
    subagentWatch?.cancel()
    subagentWatch = undefined
    typingTimer?.cancel()
    typingTimer = undefined
    off?.()
    off = undefined
    st.active = false

    return done
  }

  /** 걸려 있는 compact 의 감시 타이머(완료 이벤트가 오면 끈다). */
  let compactWatch: Timer | undefined
  const compactTimeoutMs = Math.max(0, opts.compactTimeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS)
  /**
   * compact 가 한도 안에 끝나지 않았다(#104: resume 직후 받아들여지고도 시작되지 않음 등): compacting 을 풀고
   * 화면에 한 번 알리고 메일함을 깨운다. compactedForMail 은 그대로라 그 메일 턴 전에는 다시 걸지 않는다.
   */
  const giveUpCompact = () => {
    compactWatch = undefined
    if (st.activity !== 'compacting') return
    st.activity = 'idle'
    const min = Math.round(compactTimeoutMs / 6_000) / 10
    const text = `switchboard: compact 가 ${min}분 안에 끝나지 않아 기다리지 않고 메일을 넣는다(필요하면 /compact 를 손으로)`
    log(text)
    try {
      ;(opts.warn ?? log)(text)
    } catch {
      // 알림이 실패해도 간다.
    }
    mailbox?.report()
    mailbox?.kick()
  }
  const compact = async (instructions?: string): Promise<CompactResult> => {
    if (!st.active) return { done: false, reason: 'inactive' }
    if (!capabilities(host).compact || host.compact === undefined) return { done: false, reason: 'unsupported' }
    if (st.activity !== 'idle') return { done: false, reason: st.activity }
    st.activity = 'compacting'
    mailbox?.report()
    compactWatch?.cancel()
    // 호출이 풀리지 않아도(hang) 한도에서 「거절」로 끝낸다. 완료 이벤트가 오지 않아도 같은 타이머가 푼다.
    let timedOut: (r: CompactResult) => void = () => {}
    const timeout = new Promise<CompactResult>(done => (timedOut = done))
    const watch = host.services.clock.after(compactTimeoutMs, () => {
      timedOut({ done: false, reason: 'timeout' })
      if (compactWatch === watch) giveUpCompact()
    })
    compactWatch = watch
    try {
      const r = await Promise.race([host.compact(instructions), timeout])
      // 거절됐으면 완료 이벤트가 오지 않는다: 바로 되돌린다(시간 초과는 giveUpCompact 가 이미 풀었다).
      if (!r.done) {
        if (compactWatch === watch) {
          watch.cancel()
          compactWatch = undefined
        }
        if (st.activity === 'compacting') {
          st.activity = 'idle'
          mailbox?.report()
        }
      }

      return r
    } catch (err) {
      if (compactWatch === watch) {
        watch.cancel()
        compactWatch = undefined
      }
      if (st.activity === 'compacting') {
        st.activity = 'idle'
        mailbox?.report()
      }

      return { done: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }


  const mail = (): MailboxState => mailbox?.state() ?? { status: 'off', cursor: null, queued: [], role: null }
  const takeover = async (): Promise<TakeoverResult> =>
    mailbox === undefined ? { ok: false, reason: '메일함이 꺼져 있다(SWITCHBOARD_PROFILE 없음)' } : mailbox.takeover()

  const askPermission = async (a: PermissionAsk, io?: { http?: Pick<Http, 'fetch'> }): Promise<PermissionAnswer | null> => {
    const p = permissions
    if (!st.active || p === undefined) return null
    permWaiting++
    syncCondition()
    try {
      return await p.ask(a, io)
    } catch {
      return null
    } finally {
      permWaiting--
      syncCondition()
    }
  }

  const askRemote = async (questions: readonly QuestionPanelQuestion[], io?: { http?: Pick<Http, 'fetch'> }, relayTo?: readonly string[]): Promise<RemoteAskResult> => {
    const r = remote
    if (!st.active || r === undefined) return { kind: 'local', reason: null }
    try {
      return await r.ask.ask(questions, io?.http === undefined ? {} : { http: io.http }, relayTo)
    } catch {
      return { kind: 'local', reason: '서버에 닿지 않음' }
    }
  }

  const withdrawRemote = async (id: string, io?: { http?: Pick<Http, 'fetch'> }): Promise<WithdrawResult> => {
    const r = remote
    if (!st.active || r === undefined) return { ok: false, status: null, reason: '메일함이 꺼져 있음(SWITCHBOARD_PROFILE 없음)' }
    try {
      return await r.ask.withdraw(id, io?.http === undefined ? {} : { http: io.http })
    } catch {
      return { ok: false, status: null, reason: '서버에 닿지 않음' }
    }
  }

  const answerRemote = async (id: string, answers: readonly RemoteAnswer[]): Promise<RemoteAnswerOutcome> => {
    const r = inbox
    if (!st.active || r === undefined) return { kind: 'failed', reason: '원격 질문 끌어오기가 꺼져 있음' }
    try {
      return await r.answer(id, answers)
    } catch {
      return { kind: 'failed', reason: '서버에 닿지 않음' }
    }
  }

  const ruleLines = async (call: ToolCall, loop: string, io?: { http?: Pick<Http, 'fetch'> }): Promise<string[]> => {
    try {
      return (await rules?.lines(call, loop, io)) ?? []
    } catch {
      return []
    }
  }
  const warmRules = (io?: { http?: Pick<Http, 'fetch'> }): void => rules?.warm(io)
  const stopCheck = async (io?: { http?: Pick<Http, 'fetch'> }): Promise<StopVerdict> => {
    try {
      const v = (await unclassified?.check(io)) ?? { kind: 'end' }
      if (v.kind === 'release') log(v.note)

      return v
    } catch {
      return { kind: 'end' }
    }
  }

  return { start, stop, state: () => ({ ...st }), compact, mail, takeover, askPermission, askRemote, withdrawRemote, answerRemote, ruleLines, warmRules, stopCheck }
}
