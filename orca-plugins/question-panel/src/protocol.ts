// 패널 ↔ 워커 계약. 양쪽이 이 파일을 포함해 이름과 모양이 맞물린다.
import type { Picks } from './questions.ts'

export type Result = { ok: boolean; reason: string }

declare module 'orca' {
  interface PluginRequests {
    'qp.answer': { input: { id: string; terminalId: string; picks: Picks }; output: Result }
    'qp.clearSent': { input: Record<string, never>; output: Result }
  }
}
