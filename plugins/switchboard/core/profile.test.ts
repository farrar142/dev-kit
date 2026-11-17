// 프로필 위치: agent-mail CLI(configPath)와 같은 규칙. 경로는 모두 가짜 값.
import { expect, test } from 'claude-code/testing'

import { EMPTY_GAP_MS } from './mailbox'
import { EP, fakeMail, ROLE, TOKEN } from './mailtest'
import { profileLocation } from './profile'
import type { ProfileEnv, ProfilePlatform } from './profile'
import { createSwitchboard } from './switchboard'
import { fakeHost, flush } from './testing'

const WIN_HOME = 'C:\\Users\\u'
const WIN_APPDATA = 'C:\\Users\\u\\AppData\\Roaming'

const rows: { name: string; platform: ProfilePlatform; env: ProfileEnv; want: ReturnType<typeof profileLocation> }[] = [
  { name: '이름 없음 → 꺼짐', platform: 'linux', env: { HOME: '/home/u' }, want: { off: true } },
  { name: '빈 이름 → 꺼짐', platform: 'windows', env: { AGENT_MAIL_PROFILE: '  ', APPDATA: WIN_APPDATA }, want: { off: true } },
  {
    name: 'Windows: APPDATA, HOME 없어도',
    platform: 'windows',
    env: { AGENT_MAIL_PROFILE: 'boss', APPDATA: WIN_APPDATA, USERPROFILE: WIN_HOME },
    want: { paths: [`${WIN_APPDATA}\\agent-mail\\boss.json`, `${WIN_HOME}\\.config\\agent-mail\\boss.json`] },
  },
  {
    name: 'Windows: APPDATA 없으면 USERPROFILE\\AppData\\Roaming',
    platform: 'windows',
    env: { AGENT_MAIL_PROFILE: 'boss', USERPROFILE: WIN_HOME },
    want: { paths: [`${WIN_APPDATA}\\agent-mail\\boss.json`, `${WIN_HOME}\\.config\\agent-mail\\boss.json`] },
  },
  {
    name: 'Windows: 홈은 HOME 이 USERPROFILE 보다 앞',
    platform: 'windows',
    env: { AGENT_MAIL_PROFILE: 'boss', HOME: 'D:\\h', USERPROFILE: WIN_HOME },
    want: { paths: ['D:\\h\\AppData\\Roaming\\agent-mail\\boss.json', 'D:\\h\\.config\\agent-mail\\boss.json'] },
  },
  {
    name: 'Windows: XDG_CONFIG_HOME 은 보지 않는다',
    platform: 'windows',
    env: { AGENT_MAIL_PROFILE: 'boss', APPDATA: WIN_APPDATA, XDG_CONFIG_HOME: 'C:\\xdg' },
    want: { paths: [`${WIN_APPDATA}\\agent-mail\\boss.json`] },
  },
  {
    name: '덮어쓰기 AGENT_MAIL_CONFIG_DIR: 폴더 바로 아래, 다른 후보 없음',
    platform: 'windows',
    env: { AGENT_MAIL_PROFILE: 'boss', AGENT_MAIL_CONFIG_DIR: 'E:\\mail\\', APPDATA: WIN_APPDATA },
    want: { paths: ['E:\\mail\\boss.json'] },
  },
  {
    name: '리눅스: XDG_CONFIG_HOME → 옛 자리',
    platform: 'linux',
    env: { AGENT_MAIL_PROFILE: 'w', XDG_CONFIG_HOME: '/x/cfg', HOME: '/home/u' },
    want: { paths: ['/x/cfg/agent-mail/w.json', '/home/u/.config/agent-mail/w.json'] },
  },
  { name: '리눅스: HOME/.config 하나', platform: 'linux', env: { AGENT_MAIL_PROFILE: 'w', HOME: '/home/u/' }, want: { paths: ['/home/u/.config/agent-mail/w.json'] } },
  { name: 'WSL 은 리눅스 규칙', platform: 'wsl', env: { AGENT_MAIL_PROFILE: 'w', HOME: '/home/u', APPDATA: WIN_APPDATA }, want: { paths: ['/home/u/.config/agent-mail/w.json'] } },
  {
    name: 'macOS: Application Support → 옛 자리',
    platform: 'macos',
    env: { AGENT_MAIL_PROFILE: 'w', HOME: '/Users/u', XDG_CONFIG_HOME: '/x' },
    want: { paths: ['/Users/u/Library/Application Support/agent-mail/w.json', '/Users/u/.config/agent-mail/w.json'] },
  },
  { name: 'default 는 config.json', platform: 'linux', env: { AGENT_MAIL_PROFILE: 'default', HOME: '/home/u' }, want: { paths: ['/home/u/.config/agent-mail/config.json'] } },
  {
    name: '경로 글자가 든 이름은 거절(알림)',
    platform: 'linux',
    env: { AGENT_MAIL_PROFILE: '../x', HOME: '/home/u' },
    want: { problem: 'AGENT_MAIL_PROFILE 이름이 틀림(영문·숫자·-·_ 64자 이하): ../x' },
  },
]

for (const r of rows) {
  test(`프로필 위치: ${r.name}`, () => {
    expect(profileLocation(r.platform, r.env)).toEqual(r.want)
  })
}

test('프로필 위치: 홈·설정 폴더를 하나도 못 정하면 problem', () => {
  expect('problem' in profileLocation('windows', { AGENT_MAIL_PROFILE: 'boss' })).toBe(true)
  expect('problem' in profileLocation('linux', { AGENT_MAIL_PROFILE: 'boss' })).toBe(true)
})

const PROFILE_JSON = JSON.stringify({ endpoint: EP, role: ROLE, token: TOKEN })

/** 메일함을 켠 코어: 후보 경로·problem·파일을 정해 띄운다. */
const boot = async (mail: { paths: string[] | null; problem?: string; files?: Record<string, string> }) => {
  const host = fakeHost()
  for (const [p, t] of Object.entries(mail.files ?? {})) host.fs.files.set(p, t)
  const server = fakeMail(host)
  const logs: string[] = []
  const warns: string[] = []
  const board = createSwitchboard(host, {
    mail: {
      profilePath: mail.paths,
      ...(mail.problem === undefined ? {} : { profileProblem: mail.problem }),
      log: t => void logs.push(t),
      warn: t => void warns.push(t),
    },
  })
  await board.start()
  await host.clock.advance(EMPTY_GAP_MS)

  return { host, server, logs, warns, board }
}

test('메일함: 앞 후보가 없으면 다음 후보(옛 자리)의 프로필로 잇는다', async () => {
  const { host, server, warns } = await boot({ paths: ['C:\\a\\agent-mail\\w.json', 'C:\\h\\.config\\agent-mail\\w.json'], files: { 'C:\\h\\.config\\agent-mail\\w.json': PROFILE_JSON } })
  const id = server.send()
  await flush()
  expect(warns).toEqual([])
  expect(host.turns.length).toBe(1)
  expect(host.turns[0]).toContain(`#${id}`)
})

test('메일함: AGENT_MAIL_PROFILE 은 있는데 프로필이 어디에도 없으면 화면에 한 번 알리고 서버에 묻지 않는다', async () => {
  const { server, warns, logs } = await boot({ paths: ['/c/agent-mail/w.json', '/h/.config/agent-mail/w.json'] })
  expect(warns).toEqual(['switchboard 메일함 꺼짐: 프로필 없음: /c/agent-mail/w.json, /h/.config/agent-mail/w.json'])
  expect(logs).toContain(warns[0])
  expect(server.polls).toEqual([])
})

test('메일함: 프로필이 있는데 깨져 있으면 다음 후보로 넘어가지 않고 그 까닭을 알린다', async () => {
  const { server, warns } = await boot({ paths: ['/c/w.json', '/h/w.json'], files: { '/c/w.json': '{ not json tok-SECRET', '/h/w.json': PROFILE_JSON } })
  expect(warns).toEqual(['switchboard 메일함 꺼짐: 프로필이 JSON 이 아님: /c/w.json'])
  expect(warns.join('')).not.toContain('SECRET')
  expect(server.polls).toEqual([])
})

test('메일함: 위치를 못 정했으면(problem) 그 까닭을 알린다', async () => {
  const { warns } = await boot({ paths: null, problem: '프로필 폴더를 못 정함' })
  expect(warns).toEqual(['switchboard 메일함 꺼짐: 프로필 폴더를 못 정함'])
})

test('메일함: AGENT_MAIL_PROFILE 이 없으면(경로 null, problem 없음) 조용히 꺼진다', async () => {
  const { warns, logs } = await boot({ paths: null })
  expect(warns).toEqual([])
  expect(logs).toEqual([])
})
