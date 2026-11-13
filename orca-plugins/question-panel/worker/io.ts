// 워커가 Orca host API 밖에서 하는 일(0.4.0): 채팅 세션 질문 폴더 읽기, orca CLI 실행.
// 시험은 이 모양의 가짜를 넘기고, 실제 워커는 node-io.ts 를 쓴다.
import type { CliRun } from '../src/questions.ts'

export type InboxFile = { name: string; text: string }

export type WorkerIo = {
  /** 채팅 세션 질문 폴더(로그용). */
  inboxDir: string
  /** 폴더의 완성된 *.json 파일들. 폴더가 없으면 빈 배열. */
  listInbox(): Promise<InboxFile[]>
  removeInbox(name: string): Promise<void>
  /** orca CLI 를 띄운다. env 는 워커 환경 위에 덧씌운다. 던지지 않고 결과로 돌려준다. */
  runCli(program: string, args: string[], env: Record<string, string>): Promise<CliRun>
  /** 닫힘 장부 폴더(~/.question-panel/ledger, 0.5.0, 로그용). */
  ledgerDir: string
  /** 장부에 `<key>.json`을 배타 생성한다. 처음 만들었으면 true, 이미 있으면 false. */
  claimLedger(key: string, text: string): Promise<boolean>
  /** 장부 파일 글. 없으면 null. */
  readLedger(key: string): Promise<string | null>
  /** 이 패널이 차지한 장부 기록을 거둔다(보내기 실패 뒤). */
  releaseLedger(key: string): Promise<void>
  /** 폴더를 몇 ms마다 볼까. null 이면 보지 않는다(시험). */
  pollMs: number | null
}
