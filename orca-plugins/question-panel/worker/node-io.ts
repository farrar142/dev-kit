// WorkerIo 의 실제 구현. trusted-worker 는 보통 Node 프로세스라(Orca 문서: full-access plugin)
// node: 모듈을 그대로 쓴다. 플러그인 host API 에는 오케스트레이션 메일을 보내는 메서드가 없어서
// (워커 메서드는 terminal.*·workspace.*·agent.launch 등) orca CLI 를 직접 띄운다.
import { spawn } from 'node:child_process'
import { readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { INBOX_DIR_PARTS, type CliRun } from '../src/questions.ts'
import type { InboxFile, WorkerIo } from './io.ts'

const CLI_TIMEOUT_MS = 20000
const MAX_OUTPUT = 256 * 1024
const POLL_MS = 1500

/**
 * Windows 에서 orca CLI 는 .cmd 런처라 셸 없이 띄우지 못한다(Node 가 EINVAL, PATHEXT 도 안 본다).
 * `cmd.exe /d /s /c "<한 줄>"` 로 감싼다. cmd 가 해석하는 " 와 % 는 비슷한 글자로 바꾸고, 줄바꿈은
 * 띄어쓰기로 바꾼다. 따옴표 안이라 & | < > ^ 는 그대로 글자다. 닫는 따옴표 앞 역슬래시는 두 배로
 * 한다(런처 뒤 node 가 \" 를 따옴표로 읽지 않게).
 */
export const windowsCmdLine = (program: string, args: readonly string[]): string => {
  const q = (a: string) =>
    `"${a
      .replace(/"/g, "'")
      .replace(/%/g, '％')
      .replace(/[\r\n]+/g, ' ')
      .replace(/(\\+)$/, '$1$1')}"`

  return `"${[program, ...args].map(q).join(' ')}"`
}

const runCli = (program: string, args: string[], extraEnv: Record<string, string>): Promise<CliRun> =>
  new Promise(resolve => {
    const env = { ...process.env, ...extraEnv }
    const win = process.platform === 'win32'
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = win
        ? spawn(process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', windowsCmdLine(program, args)], {
            env,
            windowsVerbatimArguments: true,
            windowsHide: true,
          })
        : spawn(program, args, { env })
    } catch (err) {
      resolve({ code: null, stdout, stderr, error: `orca 를 띄우지 못함(${program}): ${String(err)}` })

      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, CLI_TIMEOUT_MS)
    child.stdout?.on('data', (d: unknown) => {
      if (stdout.length < MAX_OUTPUT) stdout += String(d)
    })
    child.stderr?.on('data', (d: unknown) => {
      if (stderr.length < MAX_OUTPUT) stderr += String(d)
    })
    child.on('error', (err: Error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, error: `orca 를 띄우지 못함(${program}): ${err.message}` })
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout,
        stderr,
        ...(timedOut ? { error: `orca 가 ${CLI_TIMEOUT_MS}ms 안에 끝나지 않음` } : {}),
      })
    })
  })

const inboxDir = join(homedir(), ...INBOX_DIR_PARTS)

const listInbox = async (): Promise<InboxFile[]> => {
  let names: string[]
  try {
    names = await readdir(inboxDir)
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return []
    throw err
  }
  // MCP 서버는 「.이름.tmp」로 쓴 뒤 이름을 바꾼다. 다 쓴 *.json 만 읽는다.
  const files = names.filter(n => n.endsWith('.json') && !n.startsWith('.')).sort()

  return Promise.all(files.map(async name => ({ name, text: await readFile(join(inboxDir, name), 'utf8') })))
}

export const nodeIo: WorkerIo = {
  inboxDir,
  listInbox,
  removeInbox: name => rm(join(inboxDir, name), { force: true }),
  runCli,
  pollMs: POLL_MS,
}
