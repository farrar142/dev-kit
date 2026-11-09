// 패널 ↔ 워커 계약. 양쪽이 이 파일을 포함해 이름과 모양이 맞물린다.
import type { Picks, Texts } from './questions.ts'

export type Result = {
  ok: boolean
  reason: string
  /** 보낸 곳(「터미널」·「메일함 run:…」, 0.4.0부터). 보냈을 때만. */
  via?: string
  /** 실패했지만 실제로는 갔을 수 있다(메일함, 0.4.1). */
  maybeSent?: boolean
}

declare module 'orca' {
  interface PluginRequests {
    /** texts: 질문마다 「기타」 글(0.4.4). picks 에 OTHER(-1)가 든 질문만 쓴다. */
    'qp.answer': { input: { id: string; terminalId: string; picks: Picks; texts?: Texts }; output: Result }
    /** 답한 것·보낸 것을 모두 지운다. */
    'qp.clearSent': { input: Record<string, never>; output: Result }
    /** 대기 묶음마다 터미널이 살아 있는지·제목·workspace 이름을 다시 확인한다(패널을 열 때). */
    'qp.refresh': { input: Record<string, never>; output: Result }
    /** 묶음 하나를 지운다(지운 기록에 남아 되돌릴 수 있다, 0.4.1). */
    'qp.remove': { input: { id: string; terminalId: string }; output: Result }
    /** 방금 지운 묶음을 되살린다(0.4.1). */
    'qp.undoRemove': { input: { id: string; terminalId: string }; output: Result }
    /** 닫힌 세션(터미널 exited·채팅 세션 없음)의 대기 묶음을 모두 지운다. */
    'qp.clearClosed': { input: Record<string, never>; output: Result }
  }
}
