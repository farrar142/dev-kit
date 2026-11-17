// 닫힘 장부 어댑터(선택, Orca 사이드바 질문 패널과 상태를 맞추는 길): 이 플러그인 MCP 서버(qp)의 내부 도구
// sync 를 $.mcp.call 로 부른다(모드는 집 폴더를 직접 못 다룬다). 서버가 없거나 안 닿으면 null 을 돌려
// 코어가 장부 없이 혼자 돈다. Orca 전용 동작(Orca 질문 폴더 쓰기·run-current)은 서버가 ORCA_* 환경변수를
// 볼 때만 한다. 장부 자체는 Orca 가 없으면 아무도 읽지 않을 뿐이다.
import type { LedgerLink, SyncOut } from '../core/questions'

import type { Self } from './claude'

export const SERVER = 'qp'

export function mcpLedger($: Self): LedgerLink {
  return {
  sync: async args => {
    try {
      const c = await $.mcp.connect(SERVER)
      if (!c.isConnected) return null
      const r = await $.mcp.call(c.server, 'sync', args)
      if (r.isError === true) return null
      const block = r.content.find(b => b.type === 'text')
      if (block === undefined || !('text' in block) || typeof block.text !== 'string') return null
      const out: unknown = JSON.parse(block.text)
      if (typeof out !== 'object' || out === null || !('closed' in out) || typeof out.closed !== 'object') return null

      return out as SyncOut // 서버(mcp/ask.mjs callSync)가 만든 JSON 경계
    } catch {
      return null
    }
  },
  }
}
