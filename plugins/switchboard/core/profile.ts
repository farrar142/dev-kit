// Agent Mail 프로필 파일 위치. agent-mail CLI(cmd/agent-mail/cli.go configPath)와 같은 규칙을 따른다:
//  - 이름: `SWITCHBOARD_PROFILE`, 없으면 옛 이름 `AGENT_MAIL_PROFILE`(영문·숫자·`-`·`_`, 64자 이하). `default` 는 `config.json`.
//  - 폴더: `SWITCHBOARD_CONFIG_DIR`(없으면 옛 `AGENT_MAIL_CONFIG_DIR`)이 있으면 그 폴더 바로 아래, 없으면 Go
//    `os.UserConfigDir()` 아래 `switchboard/` 먼저, 그다음 옛 `agent-mail/`
//    (Windows `%APPDATA%`, macOS `~/Library/Application Support`, 그 밖 `$XDG_CONFIG_HOME` → `~/.config`).
//  - 홈: `HOME` → `USERPROFILE`(Windows 의 Claude 프로세스에는 HOME 이 없다).
// 옛 switchboard 가 보던 `~/.config/agent-mail` 은 CLI 자리와 다를 때 뒤의 후보로 남긴다(옮기기 전 파일).

export type ProfilePlatform = 'windows' | 'macos' | 'linux' | 'wsl' | 'unknown'

/** 규칙이 읽는 환경변수. 없으면 undefined. */
export type ProfileEnv = {
  SWITCHBOARD_PROFILE?: string | undefined
  AGENT_MAIL_PROFILE?: string | undefined
  SWITCHBOARD_CONFIG_DIR?: string | undefined
  AGENT_MAIL_CONFIG_DIR?: string | undefined
  APPDATA?: string | undefined
  XDG_CONFIG_HOME?: string | undefined
  HOME?: string | undefined
  USERPROFILE?: string | undefined
}

/**
 * off: 메일함을 켜지 않는다(SWITCHBOARD_PROFILE·AGENT_MAIL_PROFILE 없음). problem: 이름이 있는데 위치를 못 정했다(화면에 알린다).
 * paths: 찾아볼 차례(앞이 CLI 자리).
 */
export type ProfileLocation = { off: true } | { problem: string } | { paths: string[] }

const PROFILE_NAME = /^[A-Za-z0-9_-]{1,64}$/

const clean = (v: string | undefined) => v?.trim() ?? ''

/** 새 이름이 비어 있지 않으면 그것, 아니면 옛 이름. 고른 이름도 돌려준다(오류 문구용). */
export const pickEnv = (fresh: string | undefined, old: string | undefined, freshName: string, oldName: string): { value: string; name: string } =>
  clean(fresh) !== '' ? { value: clean(fresh), name: freshName } : { value: clean(old), name: oldName }

/** 끝의 구분자를 떼고 sep 으로 잇는다. */
const join = (sep: string, base: string, ...parts: string[]) => [base.replace(/[\\/]+$/, ''), ...parts].join(sep)

export const profileLocation = (platform: ProfilePlatform, env: ProfileEnv): ProfileLocation => {
  const picked = pickEnv(env.SWITCHBOARD_PROFILE, env.AGENT_MAIL_PROFILE, 'SWITCHBOARD_PROFILE', 'AGENT_MAIL_PROFILE')
  const name = picked.value
  if (name === '') return { off: true }
  // 경로 글자가 든 이름은 다른 파일을 읽게 되므로 받지 않는다(CLI 도 같은 이름 규칙으로 거절한다).
  if (!PROFILE_NAME.test(name)) return { problem: `${picked.name} 이름이 틀림(영문·숫자·-·_ 64자 이하): ${name.slice(0, 80)}` }
  const file = name === 'default' ? 'config.json' : `${name}.json`
  const win = platform === 'windows'
  const sep = win ? '\\' : '/'
  const home = clean(env.HOME) || clean(env.USERPROFILE)
  const override = pickEnv(env.SWITCHBOARD_CONFIG_DIR, env.AGENT_MAIL_CONFIG_DIR, '', '').value
  if (override !== '') return { paths: [join(sep, override, file)] }

  let dir = ''
  if (win) {
    const appdata = clean(env.APPDATA)
    dir = appdata !== '' ? appdata : home !== '' ? join(sep, home, 'AppData', 'Roaming') : ''
  } else if (platform === 'macos') {
    dir = home !== '' ? join(sep, home, 'Library', 'Application Support') : ''
  } else {
    const xdg = clean(env.XDG_CONFIG_HOME)
    dir = xdg !== '' ? xdg : home !== '' ? join(sep, home, '.config') : ''
  }
  const paths: string[] = []
  // 새 폴더(switchboard) 먼저, 없으면 옛 폴더(agent-mail).
  if (dir !== '') paths.push(join(sep, dir, 'switchboard', file), join(sep, dir, 'agent-mail', file))
  // 옛 자리(~/.config/agent-mail): CLI 자리와 다를 때만 뒤에 둔다.
  if (home !== '') {
    const legacy = join(sep, home, '.config', 'agent-mail', file)
    if (!paths.includes(legacy)) paths.push(legacy)
  }
  if (paths.length === 0) {
    return { problem: `프로필 폴더를 못 정함: ${win ? 'APPDATA·USERPROFILE·HOME' : 'XDG_CONFIG_HOME·HOME·USERPROFILE'} 이 다 비었다(SWITCHBOARD_CONFIG_DIR 로 정할 수 있다)` }
  }

  return { paths }
}
