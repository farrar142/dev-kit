// 질문 패널 워커. Claude의 질문 도구 호출을 훅으로 받아 저장하고, 패널이 보낸 답을 그 터미널에 넣는다.
//
// 단계마다 orca.log 를 남긴다(`orca plugin logs local.question-panel`). 0.1.0은 로그가 없어
// 답이 어디서 끊겼는지 보이지 않았다.
import type { OrcaWorkerApi } from 'orca/worker'
import '../src/protocol.ts'
import type { Result } from '../src/protocol.ts'
import {
  addBatch,
  answerLine,
  ASK_TOOL,
  asBatches,
  batchFromTool,
  clearSent,
  complete,
  markSent,
  STORE_KEY,
  type Batch,
  type JsonValue,
} from '../src/questions.ts'

/** host.call 이 던진 오류를 「code: message」 한 줄로. */
export const describeError = (err: unknown): string => {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code // HostError 는 code 를 단다

    return typeof code === 'string' ? `${code}: ${err.message}` : err.message
  }

  return String(err)
}

// terminal.sendText 는 포커스된 worktree에 그 터미널이 있을 때만 받는다(Orca plugin-host-method-bindings).
const OUTSIDE_FOCUS = /outside the active worktree|no active worktree/

export default function activate(orca: OrcaWorkerApi) {
  const log = (msg: string) => orca.log(`[question-panel] ${msg}`)
  const load = async () => asBatches((await orca.storage.get(STORE_KEY)) as JsonValue | null)
  const save = (list: Batch[]) => orca.storage.set(STORE_KEY, list as unknown as JsonValue) // Batch는 JSON 그대로다

  log('worker 시작')

  // 관찰만 하는 훅이라 Claude를 붙잡지 않는다. 결과에 묶음 ID(q<N>)가 있어 before 대신 after를 쓴다.
  orca.hooks.on('agent.tool.after', async event => {
    if (event.tool !== ASK_TOOL) return
    log(
      `hook ${event.tool} terminalId=${event.terminalId ?? '(없음)'} workspaceId=${event.workspaceId ?? '(없음)'} output=${
        event.output === undefined ? '(없음)' : JSON.stringify(event.output).slice(0, 120)
      }`,
    )
    const list = await load()
    const b = batchFromTool(event, Date.now(), `o${list.length + 1}`)
    if (b === null) {
      log('hook: 묶음을 만들지 못함(터미널 없음 또는 질문 없음) — 버림')

      return
    }
    await save(addBatch(list, b))
    log(`hook: 묶음 ${b.id} 저장(질문 ${b.questions.length}개, terminal ${b.terminalId})`)
    void orca.host
      .call('notifications.show', { title: '질문 패널', body: `${b.id}: ${b.questions[0].question}` })
      .catch(err => log(`알림 실패: ${describeError(err)}`))
  })

  const send = async (b: Batch, line: string): Promise<Result> => {
    const attempt = async (): Promise<Result> => {
      const { accepted } = await orca.host.call('terminal.sendText', { terminalId: b.terminalId, text: line, enter: true })
      log(`sendText accepted=${accepted}`)

      return accepted
        ? { ok: true, reason: '' }
        : { ok: false, reason: `터미널(${b.terminalId})이 입력을 받지 않았습니다(accepted=false).` }
    }
    try {
      return await attempt()
    } catch (err) {
      const why = describeError(err)
      log(`sendText 실패: ${why}`)
      if (!OUTSIDE_FOCUS.test(why) || b.workspaceId === null) {
        return { ok: false, reason: `터미널에 넣지 못했습니다 — ${why}` }
      }
      // 질문한 터미널이 지금 포커스된 workspace 밖이다. 그 workspace를 연 뒤 한 번 더.
      try {
        await orca.host.call('workspace.open', { workspaceId: b.workspaceId })
        log(`workspace.open ${b.workspaceId} 뒤 다시 보냄`)

        return await attempt()
      } catch (err2) {
        const why2 = describeError(err2)
        log(`다시 보내기 실패: ${why2}`)

        return {
          ok: false,
          reason: `질문한 터미널이 지금 보고 있는 workspace 밖입니다. 그 workspace로 옮긴 뒤 다시 누르세요 — ${why2}`,
        }
      }
    }
  }

  orca.panels.handle('qp.answer', async ({ id, terminalId, picks }) => {
    log(`qp.answer 받음 id=${id} terminal=${terminalId} picks=${JSON.stringify(picks)}`)
    try {
      const list = await load()
      const b = list.find(x => x.id === id && x.terminalId === terminalId && x.status === 'pending')
      if (b === undefined) return { ok: false, reason: '이미 답했거나 없는 묶음입니다.' }
      if (!complete(b, picks)) return { ok: false, reason: '모든 질문에 답을 골라 주세요.' }
      const ctx = await orca.host.call('workspace.readContext', {}).catch(() => null)
      log(
        `포커스 workspace=${ctx?.displayName ?? '(없음)'} 터미널=${
          ctx === null ? '-' : ctx.terminals.map(t => t.id).join(',')
        } 대상 포함=${ctx?.terminals.some(t => t.id === terminalId) ?? false}`,
      )
      const line = answerLine(b, picks)
      const r = await send(b, line)
      if (r.ok) {
        await save(markSent(await load(), id, terminalId, line))
        log(`묶음 ${id} 보냄`)
      }

      return r
    } catch (err) {
      const why = describeError(err)
      log(`qp.answer 예외: ${why}`)

      return { ok: false, reason: `워커 오류 — ${why}` }
    }
  })

  orca.panels.handle('qp.clearSent', async () => {
    await save(clearSent(await load()))
    log('보낸 기록 지움')

    return { ok: true, reason: '' }
  })
}
