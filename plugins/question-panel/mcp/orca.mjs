// ask.mjs 의 toOrca 가 쓰는 진짜 환경: 이 프로세스의 환경변수·집 폴더, orca CLI, 파일 쓰기.
// server.mjs 만 이 파일을 쓴다(mod 시험은 Node 모듈을 못 불러와 ask.mjs 만 가져다 쓴다).
import { spawnSync } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ORCA_INBOX_PARTS, parseRunId } from './ask.mjs'

/** Windows의 orca 는 .cmd 런처라 셸로 띄운다(인자는 고정 글자뿐이라 따옴표만 친다). */
const runOrca = (program, args) => {
  const opts = { env: process.env, encoding: 'utf8', timeout: 4000, windowsHide: true }
  const r =
    process.platform === 'win32'
      ? spawnSync(
          process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
          ['/d', '/s', '/c', `"${[program, ...args].map(a => `"${a}"`).join(' ')}"`],
          { ...opts, windowsVerbatimArguments: true },
        )
      : spawnSync(program, args, opts)

  return typeof r.stdout === 'string' ? r.stdout : ''
}

/** tools/call 하나마다 새로 만든다(now 가 그때 시각). */
export const orcaCtx = () => ({
  env: process.env,
  inboxDir: join(homedir(), ...ORCA_INBOX_PARTS),
  cwd: process.cwd(),
  now: Date.now(),
  // 이 프로세스는 그 채팅 세션의 환경(ORCA_AGENT_SESSION_ID)을 그대로 가져 그 세션의 Run 을 본다.
  runCurrent: chat => parseRunId(runOrca(chat.cli ?? 'orca', ['orchestration', 'run-current', '--json'])),
  // 다 쓴 뒤 이름을 바꿔, 플러그인이 반쯤 쓴 파일을 읽지 않게 한다.
  write: (dir, name, text) => {
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${name}.tmp`)
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, join(dir, name))
  },
  warn: msg => process.stderr.write(`[question-panel] ${msg}\n`),
})
