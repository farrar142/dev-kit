// 넘기기(#182) 순수 함수 시험: 따옴표·이미 넘긴 명령·cron 바꾸기·판 견주기.
import { expect, test } from 'claude-code/testing'

import {
  alreadyHanded,
  cronSchedule,
  handoffLabel,
  handoffOn,
  isLoopSentinel,
  jobRunCommand,
  monitorExpires,
  pickShell,
  scheduleAddArgs,
  scheduleIdOf,
  shellQuote,
  versionAtLeast,
  wakeupIn,
  watchStartCommand,
} from './handoff'

// 작은 POSIX 셸 단어 읽기(작은따옴표·큰따옴표 없는 부분·공백): 감싼 인자가 셸에서 원래 글자 그대로 하나로 돌아오는지 본다.
const shellWords = (s: string): string[] => {
  const out: string[] = []
  let cur: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      if (end < 0) throw new Error('닫히지 않은 작은따옴표')
      cur = (cur ?? '') + s.slice(i + 1, end)
      i = end
    } else if (c === '\\') {
      cur = (cur ?? '') + s[++i]
    } else if (c === ' ') {
      if (cur !== null) out.push(cur)
      cur = null
    } else cur = (cur ?? '') + c
  }
  if (cur !== null) out.push(cur)

  return out
}

const NASTY = `cat <<'EOF' > "$HOME/x"\nit's $PATH and \`id\` "q" \\n\nEOF\necho 'a'"b" $((1+2)) && printf '%s\\n' "$@"`

test('따옴표: 작은따옴표·줄바꿈·heredoc·$·백틱이 셸 인자 하나로 그대로 돌아온다', () => {
  expect(shellWords(shellQuote(NASTY))).toEqual([NASTY])
  expect(shellWords(shellQuote(''))).toEqual([''])
  expect(shellWords(shellQuote("'"))).toEqual(["'"])
})

test('백그라운드 Bash: job run --wait --label 앞 60자 -- 셸 -c 원래 명령', () => {
  const cmd = jobRunCommand('switchboard', 'bash', NASTY)
  const w = shellWords(cmd)
  expect(w.slice(0, 5)).toEqual(['switchboard', 'job', 'run', '--wait', '--label'])
  expect(w[5]).toBe(handoffLabel(NASTY))
  expect(w[5].length).toBe(60)
  expect(w[5]).not.toContain('\n')
  expect(w.slice(6)).toEqual(['--', 'bash', '-c', NASTY])
})

test('Monitor: watch start --attach --no-extend --expires <ms>ms --label 설명 -- 셸 -c 원래 명령', () => {
  const w = shellWords(watchStartCommand('/opt/sb', '/bin/zsh', "tail -f log | grep 'ERR'", '오류 줄', monitorExpires(300_000)))
  expect(w).toEqual(['/opt/sb', 'watch', 'start', '--attach', '--no-extend', '--expires', '300000ms', '--label', '오류 줄', '--', '/bin/zsh', '-c', "tail -f log | grep 'ERR'"])
  expect(shellWords(watchStartCommand('sb', 'bash', 'x', '', undefined))).toEqual(['sb', 'watch', 'start', '--attach', '--label', 'x', '--', 'bash', '-c', 'x'])
  expect(monitorExpires(0)).toBe(undefined)
  expect(monitorExpires(61_000)).toBe('61000ms')
})

test('이미 넘긴 명령은 다시 감싸지 않는다', () => {
  expect(alreadyHanded('switchboard job run --wait -- make')).toBe(true)
  expect(alreadyHanded("  /home/u/.local/bin/switchboard job run -- bash -c 'x'")).toBe(true)
  expect(alreadyHanded('SWITCHBOARD_PROFILE=w switchboard --profile w watch start --attach -- tail -f x')).toBe(true)
  expect(alreadyHanded('switchboard job list')).toBe(false)
  expect(alreadyHanded('echo switchboard job run')).toBe(false)
  expect(alreadyHanded('python3 wait-ci.py 12')).toBe(false)
})

test('감싼 명령 자신도 이미 넘긴 것으로 본다(따옴표 친 CLI 이름)', () => {
  // 훅이 만든 명령이 다시 훅에 들어와도(재시도·다른 플러그인) 두 번 감싸지 않는다.
  expect(alreadyHanded(jobRunCommand('switchboard', 'bash', 'x'))).toBe(true)
  expect(alreadyHanded(watchStartCommand('/x/switchboard', 'bash', 'x', 'l'))).toBe(true)
})

test('셸 고르기·켜기 값·꼬리표', () => {
  expect(pickShell('/usr/bin/zsh')).toBe('/usr/bin/zsh')
  expect(pickShell('/usr/bin/fish')).toBe('bash')
  expect(pickShell(undefined)).toBe('bash')
  expect(['1', 'on', 'ON', ' true ', 'yes'].map(handoffOn)).toEqual([true, true, true, true, true])
  expect(['', '0', 'off', 'no', 'false', 'enable', undefined].map(handoffOn)).toEqual([false, false, false, false, false, false, false])
  expect(handoffLabel('a\n  b\tc')).toBe('a b c')
})

test('CronCreate: 되풀이는 --cron 그대로, 박힌 한 번짜리는 --at, 그 밖의 한 번짜리는 넘기지 않는다', () => {
  const now = new Date(2026, 10, 20, 12, 0) // 2026-11-20 12:00 로컬
  expect(cronSchedule('*/5 * * * *', undefined, now)).toEqual({ cron: '*/5 * * * *' })
  expect(cronSchedule('0 9 * * 1-5', true, now)).toEqual({ cron: '0 9 * * 1-5' })
  expect(cronSchedule('30 14 20 11 *', false, now)).toEqual({ at: '2026-11-20 14:30' })
  // 지난 때는 내년, 7일 넘으면 만료를 늘린다
  expect(cronSchedule('0 9 20 11 *', false, now)).toEqual({ at: '2027-11-20 09:00', expires: '366d' })
  expect(cronSchedule('0 9 1 12 *', false, now)).toEqual({ at: '2026-12-01 09:00', expires: '12d' })
  expect(cronSchedule('*/5 * * * *', false, now)).toBe(undefined)
  expect(cronSchedule('0 9 30 2 *', false, now)).toBe(undefined)
  expect(cronSchedule('bad', true, now)).toBe(undefined)
})

test('ScheduleWakeup: 지연을 [60, 3600] 으로 자르고 분으로 올린다', () => {
  expect(wakeupIn(30)).toBe('60s')
  expect(wakeupIn(270)).toBe('270s')
  expect(wakeupIn(99_999)).toBe('3600s')
  expect(wakeupIn(undefined)).toBe(undefined)
})

test('schedule add 인자와 예약 id', () => {
  expect(scheduleAddArgs({ cron: '0 9 * * *' }, '아침 점검')).toEqual(['schedule', 'add', '--cron', '0 9 * * *', '--label', '아침 점검', '--prompt', '아침 점검'])
  expect(scheduleAddArgs({ at: '2026-12-01 09:00', expires: '12d' }, 'p')).toEqual(['schedule', 'add', '--at', '2026-12-01 09:00', '--expires', '12d', '--label', 'p', '--prompt', 'p'])
  expect(scheduleAddArgs({ in: '5m' }, 'p\nq')).toEqual(['schedule', 'add', '--in', '5m', '--label', 'p q', '--prompt', 'p\nq'])
  expect(scheduleIdOf('sb-12')).toBe('12')
  expect(scheduleIdOf('12')).toBe('12')
  expect(scheduleIdOf('a1b2c3d4')).toBe(undefined)
  expect(isLoopSentinel('<<autonomous-loop-dynamic>>')).toBe(true)
  expect(isLoopSentinel('/loop 5m check <<x>>')).toBe(false)
})

test('판 견주기', () => {
  expect(versionAtLeast('switchboard v0.30.0\n', '0.30.0')).toBe(true)
  expect(versionAtLeast('switchboard v0.30.1', '0.30.0')).toBe(true)
  expect(versionAtLeast('switchboard v0.29.9', '0.30.0')).toBe(false)
  expect(versionAtLeast('switchboard v1.0.0', '0.30.0')).toBe(true)
  expect(versionAtLeast('switchboard v0.26.0', '0.30.0')).toBe(false)
  expect(versionAtLeast('dev', '0.30.0')).toBe(false)
})
