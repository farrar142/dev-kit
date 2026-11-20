// 넘기기 훅(#182) 시험: 훅 입력 → 바뀐 입력(내장 도구 자리에 닿은 것) 또는 거절 까닭.
// CLI 는 process.run 흉내로, 플랫폼·환경변수는 session.info·env.get 흉내로 둔다.
import { expect, test } from 'claude-code/testing'

type Opts = {
  platform?: string
  env?: Record<string, string | undefined>
  /** argv(CLI 이름 뒤) → 답. 없으면 exit 0, 빈 출력. */
  cli?: (args: string[]) => { exitCode?: number; stdout?: string; stderr?: string } | 'throw'
}

const BASE_ENV = { SWITCHBOARD_PROFILE: 'worker', HOME: '/home/u', SHELL: '/bin/bash' }

// 흉내 CLI: job ping 은 없는 판(0.27.0)처럼 exit 2, version 은 v0.27.0.
const cli026 = (args: string[]) =>
  args[0] === 'job' && args[1] === 'ping'
    ? { exitCode: 2, stderr: 'switchboard: unknown action' }
    : args[0] === 'version'
      ? { stdout: 'switchboard v0.27.0\n' }
      : { exitCode: 0, stdout: '' }

async function setup(on: any, opts: Opts = {}) {
  const calls: string[][] = []
  const passed: any[] = []
  const env: Record<string, string | undefined> = { ...BASE_ENV, ...opts.env }
  on('session.info', () => ({ value: { platform: opts.platform ?? 'linux' } }))
  on('env.get', (_: any, e: any) => ({ value: env[e.name] }))
  on('process.run', (_: any, e: any) => {
    calls.push([...e.argv])
    const r = (opts.cli ?? cli026)(e.argv.slice(1))
    if (r === 'throw') throw new Error('spawn ENOENT')

    return { value: { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // 내장 도구 자리: 훅을 지나 여기까지 오면 원래(또는 바뀐) 입력으로 돈다.
  for (const tool of ['Bash', 'Monitor', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'])
    on('tool.call', { tool }, (_: any, e: any) => {
      passed.push(e)

      return { result: tool === 'CronList' ? { jobs: [] } : { ok: true } }
    })

  return { calls, passed }
}

const words = (s: string) => s.match(/'(?:[^']|'\\'')*'|\S+/g) ?? []

test('백그라운드 Bash: job run --wait 로 바꾼다(첫 출력 줄에 작업 id)', async ($, on) => {
  const { passed } = await setup(on)
  const cmd = `cat <<'EOF'\nit's $HOME\nEOF`
  await $.tool.call({ tool: 'Bash', command: cmd, run_in_background: true, description: 'd' } as any)
  expect(passed.length).toBe(1)
  const out: string = passed[0].command
  expect(out.startsWith(`'switchboard' job run --wait --label `)).toBe(true)
  expect(out.endsWith(` -- '/bin/bash' -c 'cat <<'\\''EOF'\\''\nit'\\''s $HOME\nEOF'`)).toBe(true)
  expect(passed[0].description).toBe('d')
})

test('앞(전경) Bash 와 이미 넘긴 명령은 그대로', async ($, on) => {
  const { passed, calls } = await setup(on)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  await $.tool.call({ tool: 'Bash', command: 'switchboard job run --wait -- make', run_in_background: true } as any)
  expect(passed.map(p => p.command)).toEqual(['ls', 'switchboard job run --wait -- make'])
  expect(calls.length).toBe(0)
})

test('끄기: SWITCHBOARD_HANDOFF=0 이면 아무것도 바꾸지 않고 CLI 도 안 부른다', async ($, on) => {
  const { passed, calls } = await setup(on, { env: { SWITCHBOARD_HANDOFF: '0' } })
  await $.tool.call({ tool: 'Bash', command: 'sleep 1', run_in_background: true } as any)
  const ran: any = await $.tool.call({ tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'p' } as any)
  expect(passed.map(p => p.command ?? p.prompt)).toEqual(['sleep 1', 'p'])
  expect(ran.deny).toBe(undefined)
  expect(calls.length).toBe(0)
})

test('리눅스가 아니면(macOS·Windows) 바꾸지 않는다', async ($, on) => {
  const { passed, calls } = await setup(on, { platform: 'macos' })
  await $.tool.call({ tool: 'Bash', command: 'sleep 1', run_in_background: true } as any)
  await $.tool.call({ tool: 'Monitor', command: 'tail -f x', description: 'x', timeout_ms: 1000 } as any)
  expect(passed.map(p => p.command)).toEqual(['sleep 1', 'tail -f x'])
  expect(calls.length).toBe(0)
})

test('역할 프로필 없는 세션은 넘기지 않는다', async ($, on) => {
  const { passed, calls } = await setup(on, { env: { SWITCHBOARD_PROFILE: undefined } })
  await $.tool.call({ tool: 'Bash', command: 'sleep 1', run_in_background: true } as any)
  expect(passed[0].command).toBe('sleep 1')
  expect(calls.length).toBe(0)
})

test('건강 실패(옛 CLI): 원래 명령 그대로 돌고 결과에 「넘기지 못했다」 한 줄', async ($, on) => {
  const { passed } = await setup(on, { cli: a => (a[0] === 'version' ? { stdout: 'switchboard v0.16.0' } : { exitCode: 2 }) })
  const ran: any = await $.tool.call({ tool: 'Bash', command: 'sleep 1', run_in_background: true } as any)
  expect(passed[0].command).toBe('sleep 1')
  expect(String(ran.context)).toContain('넘기지 못했다')
  expect(String(ran.context)).toContain('v0.16.0')
})

test('CLI 가 없으면(실행 실패) 원래 명령 그대로', async ($, on) => {
  const { passed } = await setup(on, { cli: () => 'throw' })
  const ran: any = await $.tool.call({ tool: 'Bash', command: 'sleep 1', run_in_background: true } as any)
  expect(passed[0].command).toBe('sleep 1')
  expect(String(ran.context)).toContain('넘기지 못했다')
})

test('job ping 이 있으면 그것으로 건강을 잰다', async ($, on) => {
  const { passed, calls } = await setup(on, { cli: a => (a[0] === 'job' && a[1] === 'ping' ? { exitCode: 0 } : { exitCode: 1 }) })
  await $.tool.call({ tool: 'Bash', command: 'sleep 1', run_in_background: true } as any)
  expect(passed[0].command.startsWith(`'switchboard' job run`)).toBe(true)
  expect(calls.map(c => c.slice(1).join(' '))).toEqual(['job ping'])
})

test('SWITCHBOARD_CLI 로 실행 파일을 고르고, 바꾼 명령도 그것을 쓴다', async ($, on) => {
  const { passed, calls } = await setup(on, { env: { SWITCHBOARD_CLI: '/opt/sb/switchboard' } })
  await $.tool.call({ tool: 'Bash', command: 'sleep 1', run_in_background: true } as any)
  expect(calls[0][0]).toBe('/opt/sb/switchboard')
  expect(passed[0].command.startsWith(`'/opt/sb/switchboard' job run`)).toBe(true)
})

test('Monitor: watch start --attach --expires --label 설명 으로 바꾼다', async ($, on) => {
  const { passed } = await setup(on)
  await $.tool.call({ tool: 'Monitor', command: "tail -f log | grep --line-buffered 'ERR'", description: '오류 감시', timeout_ms: 300_000 } as any)
  expect(words(passed[0].command).slice(0, 9)).toEqual(["'switchboard'", 'watch', 'start', '--attach', '--no-extend', '--expires', '300000ms', '--label', "'오류 감시'"])
  expect(passed[0].command.endsWith(`-c 'tail -f log | grep --line-buffered '\\''ERR'\\'''`)).toBe(true)
  expect(passed[0].timeout_ms).toBe(300_000)
})

test('Monitor: 웹소켓 감시는 그대로', async ($, on) => {
  const { passed } = await setup(on)
  await $.tool.call({ tool: 'Monitor', ws: { url: 'ws://x.test' }, description: 'w', timeout_ms: 1000 } as any)
  expect(passed[0].command).toBe(undefined)
})

test('CronCreate: cron 예약을 만들고 거절, 까닭에 예약 id 와 「메일로 온다」', async ($, on) => {
  const { passed, calls } = await setup(on, { cli: a => (a[0] === 'schedule' ? { stdout: '17\n' } : cli026(a)) })
  const ran: any = await $.tool.call({ tool: 'CronCreate', cron: '0 9 * * 1-5', prompt: '아침 점검' } as any)
  expect(passed.length).toBe(0)
  expect(String(ran.text ?? ran.deny)).toContain('sb-17')
  expect(String(ran.text ?? ran.deny)).toContain('메일로 온다')
  expect(calls.at(-1)!.slice(1)).toEqual(['schedule', 'add', '--cron', '0 9 * * 1-5', '--label', '아침 점검', '--prompt', '아침 점검'])
})

test('CronCreate: schedule add 가 실패하면 하네스 cron 으로 그대로 + 한 줄', async ($, on) => {
  const { passed } = await setup(on, { cli: a => (a[0] === 'schedule' ? { exitCode: 1, stderr: 'switchboard: server returned 500' } : cli026(a)) })
  const ran: any = await $.tool.call({ tool: 'CronCreate', cron: '0 9 * * *', prompt: 'p' } as any)
  expect(passed.length).toBe(1)
  expect(String(ran.context)).toContain('server returned 500')
})

test('CronCreate: /loop 표지 프롬프트와 못 바꾸는 한 번짜리는 그대로', async ($, on) => {
  const { passed } = await setup(on, { cli: a => (a[0] === 'schedule' ? { stdout: '1' } : cli026(a)) })
  await $.tool.call({ tool: 'CronCreate', cron: '*/5 * * * *', prompt: '<<autonomous-loop>>' } as any)
  const ran: any = await $.tool.call({ tool: 'CronCreate', cron: '*/5 * * * *', prompt: 'p', recurring: false } as any)
  expect(passed.length).toBe(2)
  expect(String(ran.context)).toContain('한 번짜리')
})

test('CronDelete: sb-N 은 schedule rm, 하네스 id 는 그대로', async ($, on) => {
  const { passed, calls } = await setup(on)
  const ran: any = await $.tool.call({ tool: 'CronDelete', id: 'sb-17' } as any)
  expect(ran.deny).toBe(undefined)
  expect(calls.at(-1)!.slice(1)).toEqual(['schedule', 'rm', '17'])
  await $.tool.call({ tool: 'CronDelete', id: 'a1b2c3d4' } as any)
  expect(passed.map(p => p.id)).toEqual(['a1b2c3d4'])
})

test('CronList: 하네스 목록 뒤에 장부의 예약을 붙인다', async ($, on) => {
  const { passed } = await setup(on, { cli: a => (a[0] === 'schedule' ? { stdout: '#17  active  cron "0 9 * * *"  next …  team/worker  p\n' } : cli026(a)) })
  const ran: any = await $.tool.call({ tool: 'CronList' } as any)
  expect(passed.length).toBe(1)
  expect(String(ran.context)).toContain('#17  active')
})

test('ScheduleWakeup: once 예약(--in 분)을 만들고 거절, stop 은 그것을 거두고 하네스에도 넘긴다', async ($, on) => {
  const { passed, calls } = await setup(on, { cli: a => (a[0] === 'schedule' && a[1] === 'add' ? { stdout: '23' } : cli026(a)) })
  const ran: any = await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 270, reason: 'r', prompt: '빌드 확인' } as any)
  expect(String(ran.text ?? ran.deny)).toContain('sb-23')
  expect(calls.at(-1)!.slice(1)).toEqual(['schedule', 'add', '--in', '270s', '--label', '빌드 확인', '--prompt', '빌드 확인'])
  expect(passed.length).toBe(0)
  await $.tool.call({ tool: 'ScheduleWakeup', stop: true } as any)
  expect(calls.at(-1)!.slice(1)).toEqual(['schedule', 'rm', '23'])
  expect(passed.length).toBe(1)
})

test('ScheduleWakeup: 자율 /loop 표지는 그대로', async ($, on) => {
  const { passed } = await setup(on)
  await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 120, reason: 'r', prompt: '<<autonomous-loop-dynamic>>' } as any)
  expect(passed.length).toBe(1)
})
