// 서버와 주고받는 머리·거절 문구(#130). 메일함·번호 역할·질문·권한이 같이 쓴다.
//  - 역할 머리: 새 이름 `X-Switchboard-Role` 과 옛 이름 `X-Agent-Mail-Role` 을 같은 값으로 함께 보낸다. 새 서버는 둘 다 받고
//    (같은 값이라 갈림이 없다), 옛 서버는 새 머리를 몰라 옛 머리로 역할을 고른다.
//  - 협업 묶음 거절: 서버가 묶음 밖 역할에 보내기·묶음 밖 자료를 403 `outside your group` 으로 막는다. 숫자 대신 사람이 읽을 한 줄로.

/** 인증 머리(토큰·역할). 토큰은 이 객체 밖으로 옮기지 않는다. */
export const roleHeaders = (token: string, role: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'X-Switchboard-Role': role,
  'X-Agent-Mail-Role': role,
})

/** 슬롯 요청에 싣는 CLI 판 머리. 값은 `vX.Y.Z`(플러그인 판이 아니라 세션이 쓰는 CLI 의 판). */
export const VERSION_HEADER = 'X-Switchboard-Version'

/** `switchboard version` 출력(「switchboard v0.31.0」)에서 `vX.Y.Z` 를 뽑는다. 못 읽으면 undefined. */
export const parseCliVersion = (text: string): string | undefined => {
  const m = /\bv(\d+\.\d+\.\d+)\b/.exec(text)

  return m === null ? undefined : `v${m[1]}`
}

export const GROUP_REFUSAL = '묶음 밖 역할에는 보낼 수 없다(받은 메일에 회신은 된다)'

/** 협업 묶음 거절(403 outside your group)인가. */
export const isGroupRefusal = (status: number, text: string): boolean => status === 403 && /outside your group/i.test(text)

/** 실패 응답의 짧은 까닭: 묶음 거절이면 사람이 읽을 한 줄, 아니면 `HTTP <코드>`. 본문은 옮기지 않는다. */
export const httpWhy = (status: number, text: string): string => (isGroupRefusal(status, text) ? `HTTP 403, ${GROUP_REFUSAL}` : `HTTP ${status}`)
