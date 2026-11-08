// ask.mjs의 타입(시험이 TypeScript에서 가져다 쓴다).
export type TextBlock = { type: 'text'; text: string }
export type McpToolResult = { content: TextBlock[]; isError?: true }
export type JsonRpcReply =
  | { jsonrpc: '2.0'; id: unknown; result: unknown }
  | { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string } }

export declare const ASK: { name: 'ask'; description: string; inputSchema: Record<string, unknown> }
/** mod가 넣은 panel_result가 있으면 그 글을, 없으면 묶음 없는 대화창 블록을 돌려준다. */
export declare const callAsk: (args: { questions?: unknown; panel_result?: unknown } | undefined) => McpToolResult
export declare const handle: (msg: unknown) => JsonRpcReply | undefined
