// ask.mjs의 타입(시험이 TypeScript에서 가져다 쓴다).
export type TextBlock = { type: 'text'; text: string }
export type McpToolResult = { content: TextBlock[]; isError?: true }
export type JsonRpcReply =
  | { jsonrpc: '2.0'; id: unknown; result: unknown }
  | { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string } }

export declare const ASK: { name: 'ask'; description: string; inputSchema: Record<string, unknown> }
export type OrcaChat = { sessionId: string; cli: string | null; userData: string | null }
export type AskCtx = {
  env: Record<string, string | undefined>
  /** Orca 질문 패널 폴더(~/.question-panel/orca-inbox). */
  inboxDir: string
  cwd: string
  now: number
  runCurrent: (chat: OrcaChat) => string | null
  write: (dir: string, name: string, text: string) => void
  warn?: (msg: string) => void
}
export declare const ORCA_INBOX_PARTS: string[]
export declare const ORCA_INBOX_VERSION: 1
export declare const ORCA_NOTE: string
export declare const orcaChat: (env: Record<string, string | undefined>) => OrcaChat | null
export declare const batchIdOf: (text: string) => string | null
export declare const parseRunId: (stdout: string) => string | null
export declare const toOrca: (questions: unknown, text: string, ctx: AskCtx) => boolean
/** mod가 넣은 panel_result가 있으면 그 글을(Orca 채팅 세션이면 Orca 질문 패널에도 남기고 안내 한 줄을 붙여), 없으면 묶음 없는 대화창 블록을 돌려준다. */
export declare const callAsk: (args: { questions?: unknown; panel_result?: unknown } | undefined, ctx?: AskCtx) => McpToolResult
export declare const handle: (msg: unknown, ctx?: AskCtx) => JsonRpcReply | undefined
