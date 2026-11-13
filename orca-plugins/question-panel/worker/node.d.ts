// node-io.ts 가 쓰는 Node API 만 최소로 적은 타입(.orca/types 에는 Node 타입이 없다). 런타임은 진짜 Node.
declare const process: {
  env: Record<string, string | undefined>
  platform: string
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
}

declare module 'node:fs/promises' {
  export function readdir(path: string): Promise<string[]>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function rm(path: string, options?: { force?: boolean }): Promise<void>
  export function writeFile(path: string, data: string, options: { encoding: 'utf8'; flag: string }): Promise<void>
  export function mkdir(path: string, options: { recursive: true }): Promise<string | undefined>
}

declare module 'node:child_process' {
  type Stream = { on(event: 'data', listener: (chunk: unknown) => void): void } | null
  export type ChildProcess = {
    stdout: Stream
    stderr: Stream
    kill(): boolean
    on(event: 'error', listener: (err: Error) => void): void
    on(event: 'close', listener: (code: number | null) => void): void
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: { env: Record<string, string | undefined>; windowsVerbatimArguments?: boolean; windowsHide?: boolean },
  ): ChildProcess
}
