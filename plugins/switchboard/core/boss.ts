// 대장 판정(#130): 이 세션의 지금 역할이 대장인가. 원격 질문 대장 쪽(remote-inbox)·참조 메일 거르기(remote-ask)·
// 권한 답 믿기(permission)가 이 판정 하나를 같이 쓴다.
//  - 구독이 (다시) 이어질 때마다(처음·끊긴 뒤·번호 역할을 받은 뒤, Mailbox.onLive) 그 역할로 GET /api/whoami 를 묻는다.
//  - 200: `is_boss` 만 본다(true 면 대장, false 면 전역 목록 SWITCHBOARD_BOSS_ROLES 에 있어도 대장 아님). 서버가 협업 묶음을 안다
//    (permissionsGated: 권한 답은 서버가 이미 부모·대장으로 가렸으므로 요청자 base 만 거른다).
//  - 404(옛 서버): 전역 목록 판정(isBossRole). 다음 연결 때 다시 묻는다.
//  - 연결 실패·시간 초과·5xx·그 밖 응답·모양 틀림: 404 와 같이 전역 목록으로 떨어지고, 다음 연결 때 다시 묻는다.
//  - 아직 안 이어졌거나 묻는 동안(답 전), 판정한 역할과 지금 역할이 다를 때(번호가 바뀌었는데 아직 안 이어짐): 대장 아님
//    (새 서버가 false 라 할 역할이 잠깐이라도 대장 패널을 켜지 않게 — 이어지면 곧 묻고, 정해지면 onChange 로 알린다).
//    권한 답은 그동안 전역 목록으로 거른다(permissionsGated 거짓).
import type { Mailbox } from './mailbox'
import { baseOf } from './permission'

/** GET /api/whoami 응답. */
export type WhoAmI = { role: string; base: string; group: string; globalBoss: boolean; bossOf: string[]; isBoss: boolean }

export type BossVerdict =
  | { kind: 'asking'; role: string }
  | { kind: 'whoami'; role: string; who: WhoAmI }
  | { kind: 'legacy'; role: string; why: string }

export type BossJudge = {
  /** 지금 역할이 대장인가(remote-inbox 를 켜고 참조 메일을 거른다). */
  isBoss: () => boolean
  /** 서버가 whoami 로 답했다(새 서버): 권한 답의 대장·부모 가림을 서버에 맡긴다. */
  permissionsGated: () => boolean
  /** 지금 판정(시험·기록용). 아직 묻지 않았으면 null. */
  verdict: () => BossVerdict | null
  /** 지금 역할로 다시 묻는다(onLive 가 부른다). */
  check: () => Promise<void>
  stop: () => void
}

/** 이 역할이 전역 대장 목록에 드는가(번호 역할이면 바탕으로 본다). */
export const isBossRole = (role: string | null, bosses: readonly string[]) =>
  role !== null && role !== '' && bosses.map(baseOf).includes(baseOf(role))

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** whoami 본문. is_boss 가 불리언이 아니면 null(모양 틀림). */
export const parseWhoami = (text: string): WhoAmI | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || typeof raw.is_boss !== 'boolean') return null
  const s = (v: unknown) => (typeof v === 'string' ? v : '')

  return {
    role: s(raw.role),
    base: s(raw.base),
    group: s(raw.group),
    globalBoss: raw.global_boss === true,
    bossOf: Array.isArray(raw.boss_of) ? raw.boss_of.filter((x): x is string => typeof x === 'string') : [],
    isBoss: raw.is_boss,
  }
}

export type BossJudgeOptions = {
  /** 전역 대장 목록(SWITCHBOARD_BOSS_ROLES, 바탕 이름). whoami 가 없는 서버에서 쓴다. */
  bosses: readonly string[]
  log?: (text: string) => void
  /** 판정이 정해질 때마다(답·실패). remote-inbox 가 쉬다가 곧 다시 보게 한다. */
  onChange?: () => void
}

export const createBossJudge = (mail: Pick<Mailbox, 'call' | 'state' | 'onLive'>, opts: BossJudgeOptions): BossJudge => {
  const log = (t: string) => {
    try {
      opts.log?.(t)
    } catch {
      // 기록이 실패해도 간다.
    }
  }
  let verdict: BossVerdict | null = null
  /** 묻기마다 올린다(늦게 온 옛 답을 버린다). */
  let seq = 0
  /** 지난번 기록한 판정 글(같은 글을 다시 남기지 않는다). */
  let said = ''
  const say = (t: string) => {
    if (t !== said) {
      said = t
      log(t)
    }
    try {
      opts.onChange?.()
    } catch {
      // 듣는 쪽의 잘못은 판정을 막지 않는다.
    }
  }
  const legacy = () => isBossRole(mail.state().role, opts.bosses)
  const current = () => {
    const role = mail.state().role

    return verdict !== null && role !== null && verdict.role === role ? verdict : null
  }

  const check = async () => {
    const role = mail.state().role
    if (role === null || role === '') return
    // 404 도 다음 연결 때는 다시 묻는다(그 사이 서버가 새 판으로 바뀔 수 있다).
    const n = ++seq
    verdict = { kind: 'asking', role }
    const r = await mail.call('/api/whoami')
    if (n !== seq) return
    if (r === null) {
      verdict = { kind: 'legacy', role, why: '연결 실패' }
      say(`switchboard 대장 판정: whoami 를 못 물음(연결 실패) — 전역 목록으로 보고 다음 연결 때 다시 묻는다`)

      return
    }
    if (r.status === 404) {
      verdict = { kind: 'legacy', role, why: '404' }
      say(`switchboard 대장 판정: 서버에 whoami 없음(옛 서버) — 전역 목록(SWITCHBOARD_BOSS_ROLES)으로 본다`)

      return
    }
    const who = r.ok ? parseWhoami(r.text) : null
    if (who === null) {
      const why = r.ok ? '응답 모양이 틀림' : `HTTP ${r.status}`
      verdict = { kind: 'legacy', role, why }
      say(`switchboard 대장 판정: whoami 실패(${why}) — 전역 목록으로 보고 다음 연결 때 다시 묻는다`)

      return
    }
    verdict = { kind: 'whoami', role, who }
    say(`switchboard 대장 판정: ${role} 는 ${who.isBoss ? '대장' : '대장 아님'}(whoami${who.group === '' ? '' : `, 묶음 ${who.group}`})`)
  }

  const off = mail.onLive(() => void check())
  // 만들기 전에 이미 이어졌으면 곧 묻는다.
  if (mail.state().status === 'live') void check()

  return {
    isBoss: () => {
      const v = current()
      if (v === null || v.kind === 'asking') return false
      if (v.kind === 'whoami') return v.who.isBoss

      return legacy()
    },
    permissionsGated: () => current()?.kind === 'whoami',
    verdict: () => verdict,
    check,
    stop: () => {
      seq++
      off()
    },
  }
}
