// 넘기기 훅(#182): 세션의 백그라운드 Bash·Monitor·CronCreate/CronDelete/CronList·ScheduleWakeup 을 switchboard 장부로 넘긴다.
// 계약: sandcorporation/switchboard#288 「Plugin hook contract」. 무엇을 바꾸는지는 core/handoff.ts, 여기는 실행과 훅 연결이다.
//  - 켜는 조건: 플랫폼이 HANDOFF_PLATFORMS 안, SWITCHBOARD_HANDOFF 가 1·on·true·yes(기본은 꺼짐), 역할 프로필 있음, 본 세션(서브에이전트 아님).
//  - 건강: `switchboard job ping`, 없으면 `switchboard version` ≥ 0.27.0.
//  - 실패하면 원래 호출을 그대로 돌리고 결과에 「넘기지 못했다」 한 줄을 더한다. 훅 자체의 오류도 원래 호출을 막지 않는다.
import type { On } from 'claude-code'

import {
  alreadyHanded,
  cronDenyText,
  cronSchedule,
  HANDOFF_MIN_VERSION,
  HANDOFF_PLATFORMS,
  handoffOn,
  isLoopSentinel,
  jobRunCommand,
  monitorExpires,
  notHandedLine,
  pickShell,
  scheduleAddArgs,
  scheduleIdOf,
  scheduleRef,
  versionAtLeast,
  wakeupDenyText,
  wakeupIn,
  watchStartCommand,
} from '../core/handoff'
import type { ScheduleWhen } from '../core/handoff'
import { mailProfilePath } from './claude'
import type { Self } from './claude'

/** 건강 검사·CLI 호출 시간 한도. 짧게: 넘기지 못하면 원래대로 돌면 된다. */
const PING_MS = 3_000
const CALL_MS = 10_000

type Ready = { kind: 'skip' } | { kind: 'fail'; why: string } | { kind: 'ok'; cli: string; shell: string }
type Health = { ok: true } | { ok: false; why: string }

const firstLine = (s: string) => s.trim().split('\n')[0]?.slice(0, 200) ?? ''

/** 결과에 한 줄 더하기(거절이면 그대로). */
const withLine = <R extends { deny?: unknown; context?: readonly string[] }>(res: R, line: string): R =>
  res.deny !== undefined ? res : { ...res, context: [...(res.context ?? []), line] }

// 이 세션이 늦춘 깨우기로 만든 한 번짜리 예약(ScheduleWakeup stop 이 거둔다).
const wakeups = new Set<string>()

const quiet = async (read: () => Promise<string | undefined>): Promise<string | undefined> => {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/** 넘기기 환경변수: 켜기(SWITCHBOARD_HANDOFF), CLI(SWITCHBOARD_CLI), 셸(SHELL). $.env.get 은 글자 그대로의 이름만 받는다. */
async function handoffEnv($: Self): Promise<{ off: string | undefined; cli: string | undefined; shell: string | undefined }> {
  return {
    off: await quiet(() => $.env.get('SWITCHBOARD_HANDOFF')),
    cli: await quiet(() => $.env.get('SWITCHBOARD_CLI')),
    shell: await quiet(() => $.env.get('SHELL')),
  }
}

/** 건강: job ping, 없으면 version ≥ 0.27.0. 결과를 기억하지 않는다(Go CLI 두 번 띄우는 값이 싸고, 판이 바뀌면 바로 따른다). */
async function checkHealth($: Self, cli: string): Promise<Health> {
  try {
    const ping = await $.process.run([cli, 'job', 'ping'], { timeoutMs: PING_MS }).catch(() => undefined)
    if (ping?.exitCode === 0) return { ok: true }
    const v = await $.process.run([cli, 'version'], { timeoutMs: PING_MS })
    if (v.exitCode !== 0) return { ok: false, why: `${cli} version 실패(exit ${v.exitCode})` }

    return versionAtLeast(v.stdout, HANDOFF_MIN_VERSION) ? { ok: true } : { ok: false, why: `CLI ${firstLine(v.stdout) || '판 모름'} < v${HANDOFF_MIN_VERSION}` }
  } catch (err) {
    return { ok: false, why: `${cli} 실행 실패: ${firstLine(String(err))}` }
  }
}

/** 넘길 수 있나. skip 은 조용히 원래대로, fail 은 원래대로 + 한 줄. */
async function ready($: Self, agentId: unknown): Promise<Ready> {
  if (agentId !== undefined) return { kind: 'skip' }
  const env = await handoffEnv($)
  if (!handoffOn(env.off)) return { kind: 'skip' }
  let platform = 'unknown'
  try {
    platform = (await $.session.info()).platform ?? 'unknown'
  } catch {
    // 모르면 켜지 않는다
  }
  if (!HANDOFF_PLATFORMS.includes(platform)) return { kind: 'skip' }
  if ((await mailProfilePath($)).paths === null) return { kind: 'skip' }
  const cli = env.cli?.trim() || 'switchboard'
  const h = await checkHealth($, cli)
  if (!h.ok) return { kind: 'fail', why: h.why }

  return { kind: 'ok', cli, shell: pickShell(env.shell) }
}

/** CLI 를 한 번 부른다. 성공이면 stdout, 아니면 까닭. */
async function callCli($: Self, cli: string, args: string[]): Promise<{ ok: true; out: string } | { ok: false; why: string }> {
  try {
    const r = await $.process.run([cli, ...args], { timeoutMs: CALL_MS })

    return r.exitCode === 0 ? { ok: true, out: r.stdout.trim() } : { ok: false, why: firstLine(r.stderr) || `exit ${r.exitCode}` }
  } catch (err) {
    return { ok: false, why: firstLine(String(err)) }
  }
}

async function addSchedule($: Self, cli: string, when: ScheduleWhen, prompt: string): Promise<{ ok: true; id: string } | { ok: false; why: string }> {
  const r = await callCli($, cli, scheduleAddArgs(when, prompt))
  if (!r.ok) return r
  const id = /^\d+$/.exec(r.out)?.[0]

  return id === undefined ? { ok: false, why: `schedule add 의 답을 못 읽음: ${firstLine(r.out)}` } : { ok: true, id }
}

export function wireHandoff(on: On): void {
  // 1. 백그라운드 Bash → job run --wait. 하네스의 끝 알림은 바꾼 명령이 끝날 때 온다(#288 훅 시험).
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let command: string | undefined
    let line: string | undefined
    try {
      if (e.run_in_background === true && typeof e.command === 'string' && !alreadyHanded(e.command)) {
        const r = await ready($, e.agentId)
        if (r.kind === 'ok') command = jobRunCommand(r.cli, r.shell, e.command)
        else if (r.kind === 'fail') line = notHandedLine(r.why)
      }
    } catch (err) {
      line = notHandedLine(`훅 오류: ${firstLine(String(err))}`)
    }
    if (command !== undefined) return next({ ...e, command })

    return line === undefined ? next(e) : withLine(await next(e), line)
  })

  // 4. Monitor → watch start --attach. 세션이 살아 있는 동안은 줄을 지금처럼 받고, 다시 뜨면 감시가 남아 메일로 온다.
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    let command: string | undefined
    let line: string | undefined
    try {
      if (typeof e.command === 'string' && e.command.trim() !== '' && !alreadyHanded(e.command)) {
        const r = await ready($, e.agentId)
        if (r.kind === 'ok') command = watchStartCommand(r.cli, r.shell, e.command, e.description ?? '', monitorExpires(e.timeout_ms))
        else if (r.kind === 'fail') line = notHandedLine(r.why)
      }
    } catch (err) {
      line = notHandedLine(`훅 오류: ${firstLine(String(err))}`)
    }
    if (command !== undefined) return next({ ...e, command })

    return line === undefined ? next(e) : withLine(await next(e), line)
  })

  // 2. CronCreate → schedule add(cron, 또는 박힌 한 번짜리는 at). 만들었으면 호출을 거절하고 까닭에 id 를 적는다.
  on('tool.call', { tool: 'CronCreate' }, async ($, e, next) => {
    let line: string | undefined
    try {
      if (typeof e.prompt === 'string' && !isLoopSentinel(e.prompt)) {
        const r = await ready($, e.agentId)
        if (r.kind === 'fail') line = notHandedLine(r.why)
        else if (r.kind === 'ok') {
          const when = cronSchedule(String(e.cron ?? ''), e.recurring, new Date())
          if (when === undefined) line = notHandedLine('한 번짜리 cron 은 분·시·일·월이 숫자로 박힌 꼴만 넘긴다')
          else {
            const made = await addSchedule($, r.cli, when, e.prompt)
            if (made.ok) return { deny: cronDenyText(scheduleRef(made.id), !('at' in when)) }
            line = notHandedLine(made.why)
          }
        }
      }
    } catch (err) {
      line = notHandedLine(`훅 오류: ${firstLine(String(err))}`)
    }

    return line === undefined ? next(e) : withLine(await next(e), line)
  })

  // CronDelete: 넘긴 예약(sb-N)이면 schedule rm. 하네스의 cron id 면 그대로.
  on('tool.call', { tool: 'CronDelete' }, async ($, e, next) => {
    let line: string | undefined
    try {
      const id = typeof e.id === 'string' ? scheduleIdOf(e.id) : undefined
      if (id !== undefined) {
        const r = await ready($, e.agentId)
        if (r.kind === 'ok') {
          const rm = await callCli($, r.cli, ['schedule', 'rm', id])
          if (rm.ok) {
            wakeups.delete(id)

            return { result: { id: e.id } }
          }
          line = notHandedLine(`schedule rm ${id}: ${rm.why}`)
        } else if (r.kind === 'fail') line = notHandedLine(r.why)
      }
    } catch (err) {
      line = notHandedLine(`훅 오류: ${firstLine(String(err))}`)
    }

    return line === undefined ? next(e) : withLine(await next(e), line)
  })

  // CronList: 하네스의 목록 뒤에 장부의 살아 있는 예약을 붙인다.
  on('tool.call', { tool: 'CronList' }, async ($, e, next) => {
    const res = await next(e)
    try {
      const r = await ready($, e.agentId)
      if (r.kind !== 'ok') return res
      const list = await callCli($, r.cli, ['schedule', 'list', '--state', 'active'])
      if (!list.ok) return withLine(res, notHandedLine(`schedule list: ${list.why}`))
      if (list.out === '') return res

      return withLine(res, `switchboard 장부의 예약(세션 밖, 지우려면 CronDelete 에 sb-<번호>):\n${list.out}`)
    } catch {
      return res
    }
  })

  // 3. ScheduleWakeup → 한 번짜리 예약(--in). stop 이면 이 세션이 만든 것을 거두고 하네스에도 그대로 넘긴다.
  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    let line: string | undefined
    try {
      if (e.stop === true) {
        if (wakeups.size > 0) {
          const r = await ready($, e.agentId)
          if (r.kind === 'ok') for (const id of [...wakeups]) if ((await callCli($, r.cli, ['schedule', 'rm', id])).ok) wakeups.delete(id)
        }
      } else {
        const delay = wakeupIn(e.delaySeconds)
        if (typeof e.prompt === 'string' && !isLoopSentinel(e.prompt) && delay !== undefined) {
          const r = await ready($, e.agentId)
          if (r.kind === 'fail') line = notHandedLine(r.why)
          else if (r.kind === 'ok') {
            const made = await addSchedule($, r.cli, { in: delay }, e.prompt)
            if (made.ok) {
              wakeups.add(made.id)

              return { deny: wakeupDenyText(scheduleRef(made.id), delay) }
            }
            line = notHandedLine(made.why)
          }
        }
      }
    } catch (err) {
      line = notHandedLine(`훅 오류: ${firstLine(String(err))}`)
    }

    return line === undefined ? next(e) : withLine(await next(e), line)
  })
}
