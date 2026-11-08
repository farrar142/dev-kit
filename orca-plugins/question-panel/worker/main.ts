// 질문 패널 워커. Claude의 질문 도구 호출을 훅으로 받아 저장하고, 패널이 보낸 답을 그 터미널에 넣는다.
// 0.4.0: Orca 채팅 세션(stream-json)의 질문은 훅이 오지 않아, Claude Code question-panel MCP 서버가 남긴
// 폴더(~/.question-panel/orca-inbox)에서 읽고, 답은 그 세션의 오케스트레이션 메일함으로 보낸다.
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
  batchFromInbox,
  batchFromTool,
  isMailbox,
  mailBody,
  mailSubject,
  mailTarget,
  parseRunCurrent,
  parseSendResult,
  routeLabel,
  clearClosed,
  clearSent,
  complete,
  patchBatch,
  removeBatch,
  markSent,
  STORE_KEY,
  type Batch,
  type JsonValue,
  type Picks,
} from '../src/questions.ts'
import type { WorkerIo } from './io.ts'
import { nodeIo } from './node-io.ts'

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

// workspace.open 은 worktree를 활성으로 바꾸라고 요청만 하고 돌아온다. sendText 가 읽는 활성 worktree
// (저장된 workspace 세션의 activeWorktreeId)는 그 뒤에 바뀐다. 1.4.253 Windows에서 14ms 뒤 다시 보내자
// 여전히 포커스 밖이었다. 그래서 readContext 의 터미널 목록에 대상이 들 때까지(sendText 와 같은 검사) 기다린다.
export const FOCUS_WAIT_MS = 3000
export const FOCUS_POLL_MS = 100

// 닫힌 터미널의 handle 로 terminal.read 를 부르면 Orca 런타임이 terminal_handle_stale 로 거부한다
// (1.4.253 pty-terminal-summary.ts getLiveLeafForHandle). terminal.read 는 포커스를 보지 않는다.
const STALE = /terminal_handle_stale/

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type Sent = Result & { via?: string; line?: string }

/** 폴더 보기를 멈추는 함수(deactivate 가 부른다). */
let stopPolling: (() => void) | null = null

export function deactivate() {
  stopPolling?.()
  stopPolling = null
}

/** io 를 받아 activate 를 만든다. 시험은 가짜 io 를 넘긴다. */
export const createWorker = (io: WorkerIo) => function activate(orca: OrcaWorkerApi) {
  const log = (msg: string) => orca.log(`[question-panel] ${msg}`)
  const load = async () => asBatches((await orca.storage.get(STORE_KEY)) as JsonValue | null)
  const save = (list: Batch[]) => orca.storage.set(STORE_KEY, list as unknown as JsonValue) // Batch는 JSON 그대로다

  log('worker 시작')

  /** 터미널 제목(포커스된 workspace에 있을 때만 보인다)과 workspace 이름. 모르면 비운다. */
  const whereInfo = async (
    terminalId: string,
    workspaceId: string | null,
  ): Promise<{ terminalTitle?: string; workspaceName?: string }> => {
    const [ctx, list] = await Promise.all([
      orca.host.call('workspace.readContext', {}).catch(() => null),
      workspaceId === null ? null : orca.host.call('workspace.list', {}).catch(() => null),
    ])
    const title = ctx?.terminals.find(t => t.id === terminalId)?.title
    const name = list?.workspaces.find(w => w.id === workspaceId)?.name

    return { ...(title === undefined ? {} : { terminalTitle: title }), ...(name === undefined ? {} : { workspaceName: name }) }
  }

  /**
   * 터미널이 닫혔나. 닫힘 = terminal.read 가 stale 로 거부하거나, 출력(lines)이 비었다.
   * 1.4.253 에서 닫힌(exited) handle 은 거부 대신 빈 tail 을 돌려주는데, 플러그인 host 의 terminal.read
   * 는 런타임 답의 status 를 버리고 {lines, truncated} 만 준다(plugin-host-workspace-method-bindings.ts).
   * 질문을 낸 에이전트가 살아 있는 터미널에는 늘 출력이 있으므로 빈 출력을 닫힘으로 본다.
   * 다른 오류(권한·연결)는 판정 불가로 보고 막지 않는다. 판정마다 한 줄 남긴다.
   */
  const isClosed = async (terminalId: string): Promise<boolean> => {
    try {
      const read = await orca.host.call('terminal.read', { terminalId, maxLines: 1 })
      if (read.lines.length === 0) {
        log(`닫힘 판정 ${terminalId}: 닫힘(terminal.read 출력이 비었다 — exited)`)

        return true
      }
      log(`닫힘 판정 ${terminalId}: 살아 있음`)

      return false
    } catch (err) {
      const why = describeError(err)
      if (STALE.test(why)) {
        log(`닫힘 판정 ${terminalId}: 닫힘(terminal_handle_stale)`)

        return true
      }
      log(`닫힘 판정 ${terminalId}: 판정 불가(닫힘으로 보지 않음): ${why}`)

      return false
    }
  }

  // 관찰만 하는 훅이라 Claude를 붙잡지 않는다. 결과에 묶음 ID(q<N>)가 있어 before 대신 after를 쓴다.
  orca.hooks.on('agent.tool.after', async event => {
    if (event.tool !== ASK_TOOL) {
      // 이름이 바뀐 질문 도구(옛 mod 도구 등)가 오면 왜 무시하는지 남긴다. 다른 도구는 조용히 넘긴다.
      if (event.tool.includes('question-panel')) log(`hook ${event.tool}: 질문 도구 이름이 아니라 무시(기대: ${ASK_TOOL})`)
      return
    }
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
    const info = await whereInfo(b.terminalId, b.workspaceId)
    await save(addBatch(list, { ...b, ...info }))
    log(
      `hook: 묶음 ${b.id} 저장(질문 ${b.questions.length}개, terminal ${b.terminalId}, 제목 ${
        info.terminalTitle ?? '(모름)'
      }, workspace ${info.workspaceName ?? '(모름)'})`,
    )
    // 새 질문이 올 때 예전 카드도 다시 본다(그새 닫힌 터미널의 카드를 「닫힘」으로).
    await refresh().catch(err => log(`refresh 실패: ${describeError(err)}`))
    void orca.host
      .call('notifications.show', { title: '질문 패널', body: `${b.id}: ${b.questions[0].question}` })
      .catch(err => log(`알림 실패: ${describeError(err)}`))
  })

  /** 대상 터미널이 포커스된 worktree에 들 때까지 기다린다. 들면 걸린 ms, 시간 안에 안 들면 null. */
  const waitFocus = async (terminalId: string): Promise<number | null> => {
    const start = Date.now()
    for (;;) {
      const ctx = await orca.host.call('workspace.readContext', {}).catch(() => null)
      if (ctx?.terminals.some(t => t.id === terminalId) === true) return Date.now() - start
      if (Date.now() - start >= FOCUS_WAIT_MS) return null
      await sleep(FOCUS_POLL_MS)
    }
  }

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
        const waited = await waitFocus(b.terminalId)
        log(
          waited === null
            ? `workspace.open ${b.workspaceId} 뒤 ${FOCUS_WAIT_MS}ms 안에 포커스가 대상 터미널로 안 바뀜, 그래도 한 번 보냄`
            : `workspace.open ${b.workspaceId} 뒤 포커스 바뀜(${waited}ms), 다시 보냄`,
        )

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

  /**
   * 채팅 세션의 답: 그 세션 신원(ORCA_AGENT_SESSION_ID)으로 orca CLI 를 띄워 메일을 보낸다.
   * 신원 없는 프로세스는 send 가 no_active_sender_terminal 로 거부된다(1.4.237 실측). 보내기 직전에
   * run-current 로 묶인 Run 을 다시 보고(질문 뒤 Run 에 묶였을 수 있다), 읽지 못하면 질문할 때 값을 쓴다.
   */
  const sendMail = async (b: Batch, picks: Picks): Promise<Sent> => {
    if (!isMailbox(b)) return { ok: false, reason: '채팅 묶음이 아닙니다.' }
    const r = b.route
    const program = r.cli ?? 'orca'
    const env: Record<string, string> = {
      ORCA_AGENT_SESSION_ID: r.sessionId,
      ORCA_STRUCTURED_SESSION: '1',
      ...(r.userData === null ? {} : { ORCA_USER_DATA_PATH: r.userData }),
    }
    const cur = await io.runCli(program, ['orchestration', 'run-current', '--json'], env)
    const now = parseRunCurrent(cur.stdout)
    if (now === undefined) {
      const p = parseSendResult(cur)
      log(`run-current(세션 ${r.sessionId}) 읽지 못함, 질문 때 값(${r.runId ?? 'Run 없음'})을 씀: ${p.ok ? '모양이 틀림' : p.why}`)
    } else log(`run-current(세션 ${r.sessionId}) → ${now ?? 'Run 없음'}`)
    const to = mailTarget(r.sessionId, now === undefined ? r.runId : now)
    const subject = mailSubject(b)
    const body = mailBody(b, picks)
    log(`orchestration send --to ${to} --subject ${JSON.stringify(subject)} (${program})`)
    const res = await io.runCli(
      program,
      ['orchestration', 'send', '--to', to, '--subject', subject, '--body', body, '--json'],
      env,
    )
    const p = parseSendResult(res)
    if (!p.ok) {
      log(`메일 보내기 실패 → ${to}: ${p.why}`)

      return { ok: false, reason: `메일함(${to})으로 보내지 못했습니다 — ${p.why}` }
    }
    log(`메일 보냄 ${p.messageId} → ${to}`)

    return { ok: true, reason: '', via: `메일함 ${to}`, line: `${subject} ${body}` }
  }

  /** 채팅 세션이 남긴 질문 파일을 묶음으로 옮긴다. 읽은 파일은 지운다(틀린 것도 로그를 남기고 지운다). */
  let ingesting = false
  const ingest = async () => {
    if (ingesting) return
    ingesting = true
    try {
      const files = await io.listInbox()
      if (files.length === 0) return
      let list = await load()
      const added: Batch[] = []
      for (const f of files) {
        let raw: unknown = null
        try {
          raw = JSON.parse(f.text)
        } catch {
          raw = null
        }
        const b = batchFromInbox(raw, Date.now())
        if (b === null) log(`inbox ${f.name}: 모양이 틀려 버림`)
        else {
          list = addBatch(list, b)
          added.push(b)
          log(`inbox: 채팅 묶음 ${b.id} 저장(질문 ${b.questions.length}개, ${routeLabel(b)}, cli ${isMailbox(b) ? (b.route.cli ?? 'PATH의 orca') : '-'})`)
        }
        await io.removeInbox(f.name).catch(err => log(`inbox ${f.name} 지우기 실패: ${describeError(err)}`))
      }
      if (added.length === 0) return
      await save(list)
      for (const b of added) {
        void orca.host
          .call('notifications.show', { title: '질문 패널', body: `${b.id}: ${b.questions[0].question}` })
          .catch(err => log(`알림 실패: ${describeError(err)}`))
      }
    } catch (err) {
      log(`inbox(${io.inboxDir}) 읽기 실패: ${describeError(err)}`)
    } finally {
      ingesting = false
    }
  }

  orca.panels.handle('qp.answer', async ({ id, terminalId, picks }) => {
    log(`qp.answer 받음 id=${id} terminal=${terminalId} picks=${JSON.stringify(picks)}`)
    try {
      const list = await load()
      const b = list.find(x => x.id === id && x.terminalId === terminalId && x.status === 'pending')
      if (b === undefined) return { ok: false, reason: '이미 답했거나 없는 묶음입니다.' }
      if (!complete(b, picks)) return { ok: false, reason: '모든 질문에 답을 골라 주세요.' }
      if (isMailbox(b)) {
        const r = await sendMail(b, picks)
        await save(
          r.ok
            ? markSent(await load(), id, terminalId, r.line ?? '', r.via)
            : patchBatch(await load(), id, terminalId, { error: r.reason }),
        )
        if (r.ok) log(`묶음 ${id} 보냄(${r.via})`)

        return r
      }
      if (b.closed === true || (await isClosed(terminalId))) {
        if (b.closed !== true) await save(patchBatch(await load(), id, terminalId, { closed: true }))
        log(`묶음 ${id}: 터미널 ${terminalId}이 닫힘 — 보내지 않음`)

        return { ok: false, reason: '질문한 터미널이 닫혔습니다. 이 카드는 「지우기」로 정리하세요.' }
      }
      const ctx = await orca.host.call('workspace.readContext', {}).catch(() => null)
      log(
        `포커스 workspace=${ctx?.displayName ?? '(없음)'} 터미널=${
          ctx === null ? '-' : ctx.terminals.map(t => t.id).join(',')
        } 대상 포함=${ctx?.terminals.some(t => t.id === terminalId) ?? false}`,
      )
      const line = answerLine(b, picks)
      const r = await send(b, line)
      if (r.ok) {
        await save(markSent(await load(), id, terminalId, line, '터미널'))
        log(`묶음 ${id} 보냄`)
      } else await save(patchBatch(await load(), id, terminalId, { error: r.reason }))

      return { ...r, ...(r.ok ? { via: '터미널' } : {}) }
    } catch (err) {
      const why = describeError(err)
      log(`qp.answer 예외: ${why}`)

      return { ok: false, reason: `워커 오류 — ${why}` }
    }
  })

  /** 대기 묶음마다 터미널이 닫혔는지 보고, 모르던 제목·workspace 이름을 채운다. */
  const refresh = async () => {
    const list = await load()
    let next = list
    // 채팅 묶음은 터미널이 없어 닫힘을 보지 않는다.
    for (const b of list.filter(x => x.status === 'pending' && x.closed !== true && !isMailbox(x))) {
      const patch: Partial<Batch> = (await isClosed(b.terminalId)) ? { closed: true } : {}
      if (b.terminalTitle === undefined || b.workspaceName === undefined) {
        const info = await whereInfo(b.terminalId, b.workspaceId)
        if (b.terminalTitle === undefined && info.terminalTitle !== undefined) patch.terminalTitle = info.terminalTitle
        if (b.workspaceName === undefined && info.workspaceName !== undefined) patch.workspaceName = info.workspaceName
      }
      if (Object.keys(patch).length > 0) {
        next = patchBatch(next, b.id, b.terminalId, patch)
        log(`refresh: 묶음 ${b.id}(terminal ${b.terminalId}) ${JSON.stringify(patch)}`)
      }
    }
    if (next !== list) await save(next)
  }

  orca.panels.handle('qp.refresh', async () => {
    await ingest()
    await refresh()

    return { ok: true, reason: '' }
  })

  orca.panels.handle('qp.remove', async ({ id, terminalId }) => {
    await save(removeBatch(await load(), id, terminalId))
    log(`묶음 ${id}(terminal ${terminalId}) 지움`)

    return { ok: true, reason: '' }
  })

  orca.panels.handle('qp.clearClosed', async () => {
    const list = await load()
    const next = clearClosed(list)
    await save(next)
    log(`닫힌 터미널 묶음 ${list.length - next.length}개 지움`)

    return { ok: true, reason: '' }
  })

  orca.panels.handle('qp.clearSent', async () => {
    await save(clearSent(await load()))
    log('보낸 기록 지움')

    return { ok: true, reason: '' }
  })

  // 채팅 세션 질문 폴더를 본다. 훅이 있어 워커는 늘 떠 있다(pluginNeedsResidentWorker).
  void ingest()
  if (io.pollMs !== null) {
    stopPolling?.()
    const timer = setInterval(() => void ingest(), io.pollMs)
    // 워커는 host 연결이 붙잡고 있다. 타이머가 프로세스를 붙잡지 않게 한다(시험이 끝나도록).
    ;(timer as unknown as { unref?: () => void }).unref?.()
    stopPolling = () => clearInterval(timer)
  }
}

export default createWorker(nodeIo)
