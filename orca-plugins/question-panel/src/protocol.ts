// 패널 ↔ 워커 계약. 양쪽이 이 파일을 포함해 이름과 모양이 맞물린다.
import type { Picks } from './questions.ts'

export type Result = { ok: boolean; reason: string }

declare module 'orca' {
  interface PluginRequests {
    'qp.answer': { input: { id: string; terminalId: string; picks: Picks }; output: Result }
    'qp.clearSent': { input: Record<string, never>; output: Result }
    /** 대기 묶음마다 터미널이 살아 있는지·제목·workspace 이름을 다시 확인한다(패널을 열 때). */
    'qp.refresh': { input: Record<string, never>; output: Result }
    /** 묶음 하나를 지운다(닫힌 터미널의 카드 정리). */
    'qp.remove': { input: { id: string; terminalId: string }; output: Result }
    /** 터미널이 닫힌 묶음을 모두 지운다. */
    'qp.clearClosed': { input: Record<string, never>; output: Result }
  }
}
