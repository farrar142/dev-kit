// 프로필 위치: switchboard CLI(configPath)와 같은 규칙(옛 이름 agent-mail 은 3단계까지 대체값). 경로는 모두 가짜 값.
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
  { name: '빈 이름 → 꺼짐', platform: 'windows', env: { SWITCHBOARD_PROFILE: '  ', APPDATA: WIN_APPDATA }, want: { off: true } },
  {
    name: 'Windows: APPDATA, HOME 없어도',
    platform: 'windows',
    env: { SWITCHBOARD_PROFILE: 'boss', APPDATA: WIN_APPDATA, USERPROFILE: WIN_HOME },
    want: { paths: [`${WIN_APPDATA}\\switchboard\\boss.json`, `${WIN_APPDATA}\\agent-mail\\boss.json`, `${WIN_HOME}\\.config\\agent-mail\\boss.json`] },
  },
  {
    name: 'Windows: APPDATA 없으면 USERPROFILE\\AppData\\Roaming',
    platform: 'windows',
    env: { SWITCHBOARD_PROFILE: 'boss', USERPROFILE: WIN_HOME },
    want: { paths: [`${WIN_APPDATA}\\switchboard\\boss.json`, `${WIN_APPDATA}\\agent-mail\\boss.json`, `${WIN_HOME}\\.config\\agent-mail\\boss.json`] },
  },
  {
    name: 'Windows: 홈은 HOME 이 USERPROFILE 보다 앞',
    platform: 'windows',
    env: { SWITCHBOARD_PROFILE: 'boss', HOME: 'D:\\h', USERPROFILE: WIN_HOME },
    want: { paths: ['D:\\h\\AppData\\Roaming\\switchboard\\boss.json', 'D:\\h\\AppData\\Roaming\\agent-mail\\boss.json', 'D:\\h\\.config\\agent-mail\\boss.json'] },
  },
  {
    name: 'Windows: XDG_CONFIG_HOME 은 보지 않는다',
    platform: 'windows',
    env: { SWITCHBOARD_PROFILE: 'boss', APPDATA: WIN_APPDATA, XDG_CONFIG_HOME: 'C:\\xdg' },
    want: { paths: [`${WIN_APPDATA}\\switchboard\\boss.json`, `${WIN_APPDATA}\\agent-mail\\boss.json`] },
  },
  {
    name: '덮어쓰기 SWITCHBOARD_CONFIG_DIR: 폴더 바로 아래, 다른 후보 없음',
    platform: 'windows',
    env: { SWITCHBOARD_PROFILE: 'boss', SWITCHBOARD_CONFIG_DIR: 'E:\\mail\\', APPDATA: WIN_APPDATA },
    want: { paths: ['E:\\mail\\boss.json'] },
  },
  {
    name: '리눅스: XDG_CONFIG_HOME → 옛 자리',
    platform: 'linux',
    env: { SWITCHBOARD_PROFILE: 'w', XDG_CONFIG_HOME: '/x/cfg', HOME: '/home/u' },
    want: { paths: ['/x/cfg/switchboard/w.json', '/x/cfg/agent-mail/w.json', '/home/u/.config/agent-mail/w.json'] },
  },
  { name: '리눅스: HOME/.config 하나', platform: 'linux', env: { SWITCHBOARD_PROFILE: 'w', HOME: '/home/u/' }, want: { paths: ['/home/u/.config/switchboard/w.json', '/home/u/.config/agent-mail/w.json'] } },
  { name: 'WSL 은 리눅스 규칙', platform: 'wsl', env: { SWITCHBOARD_PROFILE: 'w', HOME: '/home/u', APPDATA: WIN_APPDATA }, want: { paths: ['/home/u/.config/switchboard/w.json', '/home/u/.config/agent-mail/w.json'] } },
  {
    name: 'macOS: Application Support → 옛 자리',
    platform: 'macos',
    env: { SWITCHBOARD_PROFILE: 'w', HOME: '/Users/u', XDG_CONFIG_HOME: '/x' },
    want: { paths: ['/Users/u/Library/Application Support/switchboard/w.json', '/Users/u/Library/Application Support/agent-mail/w.json', '/Users/u/.config/agent-mail/w.json'] },
  },
  { name: 'default 는 config.json', platform: 'linux', env: { SWITCHBOARD_PROFILE: 'default', HOME: '/home/u' }, want: { paths: ['/home/u/.config/switchboard/config.json', '/home/u/.config/agent-mail/config.json'] } },
  {
    name: '경로 글자가 든 이름은 거절(알림)',
    platform: 'linux',
    env: { SWITCHBOARD_PROFILE: '../x', HOME: '/home/u' },
    want: { problem: 'SWITCHBOARD_PROFILE 이름이 틀림(영문·숫자·-·_ 64자 이하): ../x' },
  },
  // #130 새 이름: SWITCHBOARD_* 가 먼저, 없으면 옛 AGENT_MAIL_*.
  {
    name: '새 이름 SWITCHBOARD_PROFILE 만으로도 켠다',
    platform: 'linux',
    env: { SWITCHBOARD_PROFILE: 'w', HOME: '/home/u' },
    want: { paths: ['/home/u/.config/switchboard/w.json', '/home/u/.config/agent-mail/w.json'] },
  },
  {
    name: '새·옛 이름이 둘 다 있으면 새 이름(SWITCHBOARD_PROFILE)',
    platform: 'linux',
    env: { SWITCHBOARD_PROFILE: 'new', AGENT_MAIL_PROFILE: 'old', HOME: '/home/u' },
    want: { paths: ['/home/u/.config/switchboard/new.json', '/home/u/.config/agent-mail/new.json'] },
  },
  {
    name: '새 이름이 비었으면(공백) 옛 이름',
    platform: 'linux',
    env: { SWITCHBOARD_PROFILE: ' ', AGENT_MAIL_PROFILE: 'old', HOME: '/home/u' },
    want: { paths: ['/home/u/.config/switchboard/old.json', '/home/u/.config/agent-mail/old.json'] },
  },
  {
    name: '설정 폴더도 새 이름 SWITCHBOARD_CONFIG_DIR 이 옛 이름보다 앞',
    platform: 'linux',
    env: { SWITCHBOARD_PROFILE: 'w', SWITCHBOARD_CONFIG_DIR: '/new/', AGENT_MAIL_CONFIG_DIR: '/old', HOME: '/home/u' },
    want: { paths: ['/new/w.json'] },
  },
  {
    name: '옛 AGENT_MAIL_CONFIG_DIR 만 있으면 그 폴더(새 이름 프로필과 섞여도)',
    platform: 'linux',
    env: { SWITCHBOARD_PROFILE: 'w', AGENT_MAIL_CONFIG_DIR: '/old', HOME: '/home/u' },
    want: { paths: ['/old/w.json'] },
  },
  {
    name: '새 이름이 틀리면 그 이름으로 알린다',
    platform: 'linux',
    env: { SWITCHBOARD_PROFILE: 'a/b', AGENT_MAIL_PROFILE: 'ok', HOME: '/home/u' },
    want: { problem: 'SWITCHBOARD_PROFILE 이름이 틀림(영문·숫자·-·_ 64자 이하): a/b' },
  },
]

for (const r of rows) {
  test(`프로필 위치: ${r.name}`, () => {
    expect(profileLocation(r.platform, r.env)).toEqual(r.want)
  })
}

test('프로필 위치: 홈·설정 폴더를 하나도 못 정하면 problem', () => {
  expect('problem' in profileLocation('windows', { SWITCHBOARD_PROFILE: 'boss' })).toBe(true)
  expect('problem' in profileLocation('linux', { SWITCHBOARD_PROFILE: 'boss' })).toBe(true)
})

const PROFILE_JSON = JSON.stringify({ endpoint: EP, role: ROLE, token: TOKEN })

/** 메일함을 켠 코어: 후보 경로·problem·파일을 정해 띄운다. */
const boot = async (mail: { paths: string[] | null; problem?: string; files?: Record<string, string>; override?: { endpoint?: string; token?: string } }) => {
  const host = fakeHost()
  for (const [p, t] of Object.entries(mail.files ?? {})) host.fs.files.set(p, t)
  const server = fakeMail(host)
  const logs: string[] = []
  const warns: string[] = []
  const board = createSwitchboard(host, {
    mail: {
      profilePath: mail.paths,
      ...(mail.problem === undefined ? {} : { profileProblem: mail.problem }),
      ...(mail.override === undefined ? {} : { override: mail.override }),
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

test('메일함: SWITCHBOARD_PROFILE 은 있는데 프로필이 어디에도 없으면 화면에 한 번 알리고 서버에 묻지 않는다', async () => {
  const { server, warns, logs } = await boot({ paths: ['/c/switchboard/w.json', '/h/.config/switchboard/w.json'] })
  expect(warns).toEqual(['switchboard 메일함 꺼짐: 프로필 없음: /c/switchboard/w.json, /h/.config/switchboard/w.json'])
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

test('메일함: SWITCHBOARD_PROFILE 이 없으면(경로 null, problem 없음) 조용히 꺼진다', async () => {
  const { warns, logs } = await boot({ paths: null })
  expect(warns).toEqual([])
  expect(logs).toEqual([])
})

test('메일함(#130): 새 폴더(switchboard)에 없으면 옛 폴더(agent-mail)의 프로필로 잇는다', async () => {
  const { host, server, warns } = await boot({
    paths: ['/h/.config/switchboard/w.json', '/h/.config/agent-mail/w.json'],
    files: { '/h/.config/agent-mail/w.json': PROFILE_JSON },
  })
  const id = server.send()
  await flush()
  expect(warns).toEqual([])
  expect(host.turns[0]).toContain(`#${id}`)
})

test('메일함(#148): 프로필 단위로 찾는다 — 새 폴더에 다른 프로필만 있어도 이 프로필은 옛 폴더에서 찾는다', async () => {
  const loc = profileLocation('linux', { SWITCHBOARD_PROFILE: 'w', HOME: '/h' })
  if (!('paths' in loc)) throw new Error('paths 없음')
  const other = JSON.stringify({ endpoint: 'http://other.test', role: 'team/other', token: 'tok-other' })
  const { host, server, warns } = await boot({
    paths: loc.paths,
    files: { '/h/.config/switchboard/other.json': other, '/h/.config/agent-mail/w.json': PROFILE_JSON },
  })
  const id = server.send()
  await flush()
  expect(warns).toEqual([])
  expect(host.turns[0]).toContain(`#${id}`)
})

test('메일함(#130): 새 폴더에 있으면 그것을 쓴다(옛 폴더의 깨진 파일은 보지 않는다)', async () => {
  const { host, server, warns } = await boot({
    paths: ['/h/.config/switchboard/w.json', '/h/.config/agent-mail/w.json'],
    files: { '/h/.config/switchboard/w.json': PROFILE_JSON, '/h/.config/agent-mail/w.json': '{ broken' },
  })
  const id = server.send()
  await flush()
  expect(warns).toEqual([])
  expect(host.turns[0]).toContain(`#${id}`)
})

test('메일함(#130): SWITCHBOARD_ENDPOINT·SWITCHBOARD_TOKEN 덮어쓰기가 프로필 값보다 앞선다', async () => {
  const stale = JSON.stringify({ endpoint: 'http://old.test/', role: ROLE, token: 'tok-old' })
  const { host, server, warns } = await boot({ paths: ['/h/w.json'], files: { '/h/w.json': stale }, override: { endpoint: `${EP}/`, token: TOKEN } })
  const id = server.send()
  await flush()
  expect(warns).toEqual([])
  expect(server.polls.length).toBeGreaterThan(0)
  expect(host.turns[0]).toContain(`#${id}`)
})
