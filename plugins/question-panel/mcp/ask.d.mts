// ask.mjs의 타입(시험이 TypeScript에서 가져다 쓴다).
export type TextBlock = { type: 'text'; text: string }
export type McpToolResult = { content: TextBlock[]; isError?: true }
export type JsonRpcReply =
  | { jsonrpc: '2.0'; id: unknown; result: unknown }
  | { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string } }

export declare const ASK: { name: 'ask'; description: string; inputSchema: Record<string, unknown> }
export declare const RESOLVE: { name: 'resolve'; description: string; inputSchema: Record<string, unknown> }
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
/** QUESTION_PANEL_ECHO=1 등으로 옛 동작(질문 블록을 대화창에 옮겨 적게 하는 결과)을 켰는가(0.7.0). */
export declare const echoOn: (env: Record<string, string | undefined> | undefined) => boolean
export declare const orcaChat: (env: Record<string, string | undefined>) => OrcaChat | null
export declare const batchIdOf: (text: string) => string | null
export declare const parseRunId: (stdout: string) => string | null
export declare const toOrca: (questions: unknown, text: string, ctx: AskCtx) => boolean
/** mod가 넣은 panel_result가 있으면 그 글을(QUESTION_PANEL_ECHO=1이고 panel_echo가 있으면 그 옛 블록 글을, Orca 채팅 세션이면 Orca 질문 패널에도 남기고 안내 한 줄을 붙여), 없으면 묶음 없는 대화창 블록을 돌려준다. */
export declare const callAsk: (
  args: { questions?: unknown; panel_result?: unknown; panel_echo?: unknown; panel_closed?: unknown } | undefined,
  ctx?: AskCtx,
) => McpToolResult
export type ClosedEntry = { v: 1; kind: 'closed'; ids: string[]; session: { id: string }; at: number }
export declare const closedEntry: (a: { ids: string[]; chat: OrcaChat; now: number }) => ClosedEntry
/** 채팅 세션이면 닫힌 묶음을 Orca 질문 패널 폴더에 남긴다(0.6.3). */
export declare const closedToOrca: (ids: unknown, ctx: AskCtx) => boolean
/** resolve: mod가 넣은 panel_result를 돌려주고, 채팅 세션이면 Orca 폴더에 닫힘을 남긴다(0.6.3). */
export declare const callResolve: (
  args: { id?: unknown; panel_result?: unknown; panel_closed?: unknown } | undefined,
  ctx?: AskCtx,
) => McpToolResult
export declare const handle: (msg: unknown, ctx?: AskCtx) => JsonRpcReply | undefined
