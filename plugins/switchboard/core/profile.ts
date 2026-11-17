// Agent Mail 프로필 파일 위치. agent-mail CLI(cmd/agent-mail/cli.go configPath)와 같은 규칙을 따른다:
//  - 이름: `AGENT_MAIL_PROFILE`(영문·숫자·`-`·`_`, 64자 이하). `default` 는 `config.json`.
//  - 폴더: `AGENT_MAIL_CONFIG_DIR` 이 있으면 그 폴더 바로 아래, 없으면 Go `os.UserConfigDir()`/agent-mail
//    (Windows `%APPDATA%`, macOS `~/Library/Application Support`, 그 밖 `$XDG_CONFIG_HOME` → `~/.config`).
//  - 홈: `HOME` → `USERPROFILE`(Windows 의 Claude 프로세스에는 HOME 이 없다).
// 옛 switchboard 가 보던 `~/.config/agent-mail` 은 CLI 자리와 다를 때 뒤의 후보로 남긴다(옮기기 전 파일).

export type ProfilePlatform = 'windows' | 'macos' | 'linux' | 'wsl' | 'unknown'

/** 규칙이 읽는 환경변수. 없으면 undefined. */
export type ProfileEnv = {
  AGENT_MAIL_PROFILE?: string | undefined
  AGENT_MAIL_CONFIG_DIR?: string | undefined
  APPDATA?: string | undefined
  XDG_CONFIG_HOME?: string | undefined
  HOME?: string | undefined
  USERPROFILE?: string | undefined
}

/**
 * off: 메일함을 켜지 않는다(AGENT_MAIL_PROFILE 없음). problem: 이름이 있는데 위치를 못 정했다(화면에 알린다).
 * paths: 찾아볼 차례(앞이 CLI 자리).
 */
export type ProfileLocation = { off: true } | { problem: string } | { paths: string[] }

const PROFILE_NAME = /^[A-Za-z0-9_-]{1,64}$/

const clean = (v: string | undefined) => v?.trim() ?? ''

/** 끝의 구분자를 떼고 sep 으로 잇는다. */
const join = (sep: string, base: string, ...parts: string[]) => [base.replace(/[\\/]+$/, ''), ...parts].join(sep)

export const profileLocation = (platform: ProfilePlatform, env: ProfileEnv): ProfileLocation => {
  const name = clean(env.AGENT_MAIL_PROFILE)
  if (name === '') return { off: true }
  // 경로 글자가 든 이름은 다른 파일을 읽게 되므로 받지 않는다(CLI 도 같은 이름 규칙으로 거절한다).
  if (!PROFILE_NAME.test(name)) return { problem: `AGENT_MAIL_PROFILE 이름이 틀림(영문·숫자·-·_ 64자 이하): ${name.slice(0, 80)}` }
  const file = name === 'default' ? 'config.json' : `${name}.json`
  const win = platform === 'windows'
  const sep = win ? '\\' : '/'
  const home = clean(env.HOME) || clean(env.USERPROFILE)
  const override = clean(env.AGENT_MAIL_CONFIG_DIR)
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
  if (dir !== '') paths.push(join(sep, dir, 'agent-mail', file))
  // 옛 자리(~/.config/agent-mail): CLI 자리와 다를 때만 뒤에 둔다.
  if (home !== '') {
    const legacy = join(sep, home, '.config', 'agent-mail', file)
    if (!paths.includes(legacy)) paths.push(legacy)
  }
  if (paths.length === 0) {
    return { problem: `프로필 폴더를 못 정함: ${win ? 'APPDATA·USERPROFILE·HOME' : 'XDG_CONFIG_HOME·HOME·USERPROFILE'} 이 다 비었다(AGENT_MAIL_CONFIG_DIR 로 정할 수 있다)` }
  }

  return { paths }
}
