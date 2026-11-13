// 질문 패널 워커. Claude의 질문 도구 호출을 훅으로 받아 저장하고, 패널이 보낸 답을 그 터미널에 넣는다.
// 0.4.0: Orca 채팅 세션(stream-json)의 질문은 훅이 오지 않아, Claude Code question-panel MCP 서버가 남긴
// 폴더(~/.question-panel/orca-inbox)에서 읽고, 답은 그 세션의 오케스트레이션 메일함으로 보낸다.
//
// 0.5.0: 질문 상태의 정본은 닫힘 장부(~/.question-panel/ledger, question-panel 0.9.0 과 같은 계약)다.
// 보내기 전에 장부를 배타 생성으로 차지하고(Claude Code 패널이 먼저 답했으면 보내지 않는다), 폴더를 볼 때
// 장부도 읽어 다른 곳에서 닫힌 카드를 닫는다. 대기 카드 「지우기」는 장부에 「답 없이 닫음」을 남긴다.
//
// 단계마다 orca.log 를 남긴다(`orca plugin logs local.question-panel`). 0.1.0은 로그가 없어
// 답이 어디서 끊겼는지 보이지 않았다.
import type { OrcaWorkerApi } from 'orca/worker'
import '../src/protocol.ts'
import type { Result } from '../src/protocol.ts'
import {
  addBatch,
  addDismissed,
  answerLine,
  asDismissed,
  cliErrorCode,
  DISMISSED_KEY,
  dismissKey,
  SESSION_GONE,
  splitBy,
  ASK_TOOL,
  asBatches,
  batchFromInbox,
  batchFromTool,
  CHAT_VIA,
  closedIdsOf,
  closeFromInbox,
  closeInChat,
  closeByLedger,
  isOwnAnswer,
  ledgerRecord,
  ledgerVia,
  parseLedger,
  type LedgerRecord,
  RESOLVE_TOOL,
  isMailbox,
  mailBody,
  mailSubject,
  mailTarget,
  parseRunCurrent,
  parseSendResult,
  routeLabel,
  complete,
  patchBatch,
  markSent,
  STORE_KEY,
  type Batch,
  type JsonValue,
  type Picks,
  type Route,
  type Texts,
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

type Sent = Result & { via?: string; line?: string; maybeSent?: boolean }

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
  const loadDismissed = async () => asDismissed((await orca.storage.get(DISMISSED_KEY)) as JsonValue | null)

  /** 정리 하나: drop 에 걸린 묶음을 지우고 지운 기록에 남긴다(되돌리기·다시 뜨지 않게). 지운 수. */
  const dismiss = async (drop: (b: Batch) => boolean, why: string, undoable = false): Promise<number> => {
    const { keep, removed } = splitBy(await load(), drop)
    if (removed.length === 0) return 0
    await save(keep)
    await orca.storage.set(
      DISMISSED_KEY,
      addDismissed(await loadDismissed(), removed, Date.now(), undoable) as unknown as JsonValue,
    )
    log(`${why}: ${removed.map(b => `${b.id}(${b.terminalId})`).join(', ')} 지움`)

    return removed.length
  }

  /** 보내는 중인 묶음(`${terminalId}/${id}`). 같은 묶음을 두 번 보내지 않는다. */
  const inflight = new Set<string>()

  log('worker 시작')

  /** 장부를 읽어 다른 곳(Claude Code 패널·대화창)에서 닫힌 대기 카드를 닫는다. */
  const syncLedger = async () => {
    try {
      const keyed = (await load()).filter(b => b.status === 'pending' && b.key !== undefined)
      if (keyed.length === 0) return
      const records: Record<string, LedgerRecord> = {}
      for (const b of keyed) {
        const key = b.key as string
        const r = parseLedger(await io.readLedger(key), key)
        if (r !== null) records[key] = r
      }
      if (Object.keys(records).length === 0) return
      // 저장 직전에 다시 읽는다(그사이 훅·폴더 읽기가 저장했을 수 있다).
      const r = closeByLedger(await load(), records)
      if (r.closed.length === 0) return
      await save(r.list)
      log(`장부: ${r.closed.map(c => `${c.id}(${c.terminalId}) 「${c.via}」`).join(', ')}으로 닫음`)
    } catch (err) {
      log(`장부(${io.ledgerDir}) 읽기 실패: ${describeError(err)}`)
    }
  }

  /**
   * 보내기 전에 장부를 차지한다. 이미 다른 곳이 닫았으면 카드를 그 사유로 닫고 막는 결과를 돌려준다.
   * 장부를 쓸 수 없으면(폴더 권한 등) 로그만 남기고 막지 않는다(혼자서도 돈다).
   */
  const claim = async (b: Batch, state: LedgerRecord['state']): Promise<Result | null> => {
    if (b.key === undefined) return null
    try {
      if (await io.claimLedger(b.key, JSON.stringify(ledgerRecord(b.key, state, Date.now())))) {
        log(`장부: ${b.id}(${b.key}) 차지`)

        return null
      }
      const held = parseLedger(await io.readLedger(b.key), b.key)
      // 이 패널 자신의 답 기록(앞선 보내기가 「갔을 수 있음」으로 끝남)이면 막지 않는다.
      if (held !== null && isOwnAnswer(held) && state === 'answered') return null
      const via = held === null ? '다른 곳에서 닫힘' : ledgerVia(held)
      await save(
        (await load()).map(x => {
          if (!(x.id === b.id && x.terminalId === b.terminalId && x.status === 'pending')) return x
          const { error: _, ...rest } = x

          return { ...rest, status: 'sent' as const, via }
        }),
      )
      log(`장부: ${b.id}(${b.key}) 이미 「${via}」 — 보내지 않음`)

      return { ok: false, reason: `${b.id}은(는) 이미 「${via}」 상태라 보내지 않았습니다.` }
    } catch (err) {
      log(`장부 차지 실패(막지 않고 보냄): ${describeError(err)}`)

      return null
    }
  }

  /** 보내기에 실패했으면(갔을 수 있는 경우는 빼고) 차지한 장부 기록을 거둔다. 다시 누를 수 있게. */
  const release = async (b: Batch) => {
    if (b.key === undefined) return
    await io.releaseLedger(b.key).catch(err => log(`장부 거두기 실패: ${describeError(err)}`))
  }

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
  /**
   * 그 세션의 대기 묶음을 「대화창에서 답함」으로 닫는다(0.4.4). 닫힌 카드는 보내기가 막힌다(qp.answer 는
   * 대기 묶음만 보낸다). resolve 가 Orca 에 닿지 않아 닫힌 묶음에 또 답이 가던 것을 막는다.
   */
  const closeChat = async (terminalId: string, ids: readonly string[], at: number, why: string) => {
    if (ids.length === 0) return
    await ingest()
    const r = closeInChat(await load(), terminalId, ids, at)
    if (r.closed.length > 0) await save(r.list)
    log(`${why}: ${terminalId} 의 ${ids.join(',')} → ${r.closed.length > 0 ? `${r.closed.join(',')} 「${CHAT_VIA}」으로 닫음` : '닫을 대기 묶음 없음'}`)
  }

  orca.hooks.on('agent.tool.after', async event => {
    if (event.tool === RESOLVE_TOOL) {
      const ids = closedIdsOf(event.input)
      log(`hook ${event.tool} terminalId=${event.terminalId ?? '(없음)'} ids=${ids.join(',') || '(없음)'}`)
      if (event.terminalId !== undefined && event.terminalId !== '') {
        await closeChat(event.terminalId, ids, Date.now(), 'resolve')
      }

      return
    }
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
    // mod 가 질문 호출에 붙인 panel_closed: 그새 대화창 글로 답해 닫힌 묶음들(0.4.4).
    if (event.terminalId !== undefined && event.terminalId !== '') {
      await closeChat(event.terminalId, closedIdsOf(event.input), Date.now(), 'hook panel_closed')
    }
    // 폴더 읽기(ingest)도 저장소를 고친다. 끝나기를 기다리고, 저장 직전에 다시 읽어 덮어쓰지 않는다.
    await ingest()
    const list = await load()
    const b = batchFromTool(event, Date.now(), `o${list.length + 1}`)
    if (b === null) {
      log('hook: 묶음을 만들지 못함(터미널 없음 또는 질문 없음) — 버림')

      return
    }
    const info = await whereInfo(b.terminalId, b.workspaceId)
    await save(addBatch(await load(), { ...b, ...info }))
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

  /** 채팅 세션 신원으로 CLI 를 돌릴 환경. */
  const cliEnv = (r: Extract<Route, { kind: 'mailbox' }>): Record<string, string> => ({
    ORCA_AGENT_SESSION_ID: r.sessionId,
    ORCA_STRUCTURED_SESSION: '1',
    ...(r.userData === null ? {} : { ORCA_USER_DATA_PATH: r.userData }),
  })

  /**
   * 채팅 세션의 답: 그 세션 신원(ORCA_AGENT_SESSION_ID)으로 orca CLI 를 띄워 메일을 보낸다.
   * 신원 없는 프로세스는 send 가 no_active_sender_terminal 로 거부된다(1.4.237 실측). 보내기 직전에
   * run-current 로 묶인 Run 을 다시 보고(질문 뒤 Run 에 묶였을 수 있다), 읽지 못하면 질문할 때 값을 쓴다.
   */
  const sendMail = async (b: Batch, picks: Picks, texts: Texts): Promise<Sent> => {
    if (!isMailbox(b)) return { ok: false, reason: '채팅 묶음이 아닙니다.' }
    const r = b.route
    const program = r.cli ?? 'orca'
    const env = cliEnv(r)
    const cur = await io.runCli(program, ['orchestration', 'run-current', '--json'], env)
    const now = parseRunCurrent(cur.stdout)
    if (now === undefined) {
      const p = parseSendResult(cur)
      log(`run-current(세션 ${r.sessionId}) 읽지 못함, 질문 때 값(${r.runId ?? 'Run 없음'})을 씀: ${p.ok ? '모양이 틀림' : p.why}`)
    } else log(`run-current(세션 ${r.sessionId}) → ${now ?? 'Run 없음'}`)
    const to = mailTarget(r.sessionId, now === undefined ? r.runId : now)
    const subject = mailSubject(b)
    const body = mailBody(b, picks, texts)
    log(`orchestration send --to ${to} --subject ${JSON.stringify(subject)} (${program})`)
    const res = await io.runCli(
      program,
      ['orchestration', 'send', '--to', to, '--subject', subject, '--body', body, '--json'],
      env,
    )
    const p = parseSendResult(res)
    if (!p.ok) {
      log(`메일 보내기 실패 → ${to}: ${p.why}${p.maybeSent ? ' (CLI는 돌았다 — 실제로는 갔을 수 있음)' : ''}`)

      return { ok: false, reason: `메일함(${to})으로 보내지 못했습니다 — ${p.why}`, maybeSent: p.maybeSent }
    }
    log(`메일 보냄 ${p.messageId === '' ? '(id 모름, 종료 코드 0)' : p.messageId} → ${to}`)

    return { ok: true, reason: '', via: `메일함 ${to}`, line: `${subject} ${body}` }
  }

  /** 채팅 세션이 남긴 질문 파일을 묶음으로 옮긴다. 읽은 파일은 지운다(틀린 것도 로그를 남기고 지운다). */
  // 이미 읽는 중이면 그 읽기를 같이 기다린다(패널의 qp.refresh 가 시작 때 읽기와 겹쳐도 결과를 본다).
  let ingesting: Promise<void> | null = null
  const ingest = (): Promise<void> => {
    ingesting ??= ingestOnce().finally(() => {
      ingesting = null
    })

    return ingesting
  }
  const ingestOnce = async () => {
    try {
      const files = await io.listInbox()
      if (files.length === 0) return
      // 이미 있는 묶음(보낸 것 포함)과 지운 묶음은 다시 넣지 않는다. 파일 지우기가 실패해 같은 파일이
      // 남아 있어도 보낸 카드가 대기로 되살아나 또 보내는 일이 없게.
      const have = new Set((await load()).map(dismissKey))
      const gone = new Set((await loadDismissed()).map(d => d.key))
      const added: Batch[] = []
      const closes: { terminalId: string; ids: string[]; at: number; name: string }[] = []
      for (const f of files) {
        let raw: unknown = null
        try {
          raw = JSON.parse(f.text)
        } catch {
          raw = null
        }
        const close = closeFromInbox(raw)
        const b = close === null ? batchFromInbox(raw, Date.now()) : null
        if (close !== null) closes.push({ ...close, name: f.name })
        else if (b === null) log(`inbox ${f.name}: 모양이 틀려 버림`)
        else if (gone.has(dismissKey(b))) log(`inbox ${f.name}: 지운 묶음 ${b.id}이라 다시 띄우지 않고 버림`)
        else if (have.has(dismissKey(b))) {
          // 이미 받은 묶음 — 파일만 다시 지운다.
        } else {
          have.add(dismissKey(b))
          added.push(b)
          log(`inbox: 채팅 묶음 ${b.id} 저장(질문 ${b.questions.length}개, ${routeLabel(b)}, cli ${isMailbox(b) ? (b.route.cli ?? 'PATH의 orca') : '-'})`)
        }
        await io.removeInbox(f.name).catch(err => log(`inbox ${f.name} 지우기 실패: ${describeError(err)}`))
      }
      if (added.length === 0 && closes.length === 0) return
      // 저장 직전에 다시 읽는다(그사이 훅이 저장했을 수 있다). 닫힘은 새 묶음을 넣은 뒤에 건다
      // (닫힘 시각보다 뒤에 만든 묶음은 closeInChat 이 닫지 않는다).
      let list = added.reduce(addBatch, await load())
      for (const c of closes) {
        const r = closeInChat(list, c.terminalId, c.ids, c.at)
        list = r.list
        log(`inbox ${c.name}: ${c.terminalId} 의 ${c.ids.join(',')} → ${r.closed.length > 0 ? `${r.closed.join(',')} 「${CHAT_VIA}」으로 닫음` : '닫을 대기 묶음 없음'}`)
      }
      await save(list)
      for (const b of added) {
        void orca.host
          .call('notifications.show', { title: '질문 패널', body: `${b.id}: ${b.questions[0].question}` })
          .catch(err => log(`알림 실패: ${describeError(err)}`))
      }
    } catch (err) {
      log(`inbox(${io.inboxDir}) 읽기 실패: ${describeError(err)}`)
    }
  }

  orca.panels.handle('qp.answer', async ({ id, terminalId, picks, texts = [] }) => {
    log(
      `qp.answer 받음 id=${id} terminal=${terminalId} picks=${JSON.stringify(picks)}${
        texts.some(t => t.trim() !== '') ? ` 기타 글 ${texts.map(t => t.trim().length).join('/')}자` : ''
      }`,
    )
    try {
      const list = await load()
      const b = list.find(x => x.id === id && x.terminalId === terminalId && x.status === 'pending')
      if (b === undefined) {
        const done = list.find(x => x.id === id && x.terminalId === terminalId)
        if (done?.via === CHAT_VIA) {
          log(`묶음 ${id}: 이미 「${CHAT_VIA}」으로 닫힘 — 보내지 않음`)

          return { ok: false, reason: `${id}은(는) 대화창에서 이미 답해 닫혔습니다.` }
        }

        // 장부에서 닫힌 카드(0.5.0): 「Claude Code 패널에서 답함」 등
        if (done?.status === 'sent' && done.via !== undefined && done.via !== '터미널' && !done.via.startsWith('메일함')) {
          return { ok: false, reason: `${id}은(는) 이미 「${done.via}」 상태라 보내지 않았습니다.` }
        }

        return { ok: false, reason: '이미 답했거나 없는 묶음입니다.' }
      }
      if (!complete(b, picks, texts)) return { ok: false, reason: '모든 질문에 답을 골라 주세요. 「기타」를 골랐으면 글을 2000자 안으로 써 주세요.' }
      if (isMailbox(b) && b.closed === true) {
        log(`묶음 ${id}: 채팅 세션 ${b.route.sessionId}이 Orca에 없음 — 보내지 않음`)

        return { ok: false, reason: '질문한 채팅 세션이 Orca에 없습니다. 이 카드는 「지우기」로 정리하세요.' }
      }
      const k = `${terminalId}/${id}`
      if (inflight.has(k)) {
        log(`묶음 ${id}: 이미 보내는 중 — 이번 누름은 무시`)

        return { ok: false, reason: `${id}을(를) 이미 보내는 중입니다. 끝날 때까지 기다리세요.` }
      }
      inflight.add(k)
      try {
        const blocked = await claim(b, 'answered')
        if (blocked !== null) return blocked
        if (isMailbox(b)) {
          const r = await sendMail(b, picks, texts)
          if (!r.ok && r.maybeSent !== true) await release(b)
          await save(
            r.ok
              ? markSent(await load(), id, terminalId, r.line ?? '', r.via)
              : patchBatch(await load(), id, terminalId, {
                  error: r.reason,
                  ...(r.maybeSent === true || b.maybeSent === true ? { maybeSent: true } : {}),
                }),
          )
          if (r.ok) log(`묶음 ${id} 보냄(${r.via})`)

          return r
        }

        const r = await answerTerminal(b, id, terminalId, picks, texts)
        if (!r.ok) await release(b)

        return r
      } finally {
        inflight.delete(k)
      }
    } catch (err) {
      const why = describeError(err)
      log(`qp.answer 예외: ${why}`)

      return { ok: false, reason: `워커 오류 — ${why}` }
    }
  })

  /** 터미널 묶음의 답: 그 터미널에 한 줄로 넣는다. */
  const answerTerminal = async (b: Batch, id: string, terminalId: string, picks: Picks, texts: Texts): Promise<Result> => {
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
    const line = answerLine(b, picks, texts)
    const r = await send(b, line)
    if (r.ok) {
      await save(markSent(await load(), id, terminalId, line, '터미널'))
      log(`묶음 ${id} 보냄`)
    } else await save(patchBatch(await load(), id, terminalId, { error: r.reason }))

    return { ...r, ...(r.ok ? { via: '터미널' } : {}) }
  }

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
    // 채팅 묶음: 그 세션 신원으로 run-current 를 불러 본다. 세션이 없으면(session_caller_unknown) 닫힘,
    // 있으면 지금 Run 으로 배지를 맞춘다. 쉬는 세션(not_live 등)은 닫힘으로 보지 않는다.
    for (const b of list.filter(x => x.status === 'pending' && x.closed !== true && isMailbox(x))) {
      if (!isMailbox(b)) continue
      const res = await io.runCli(b.route.cli ?? 'orca', ['orchestration', 'run-current', '--json'], cliEnv(b.route))
      const code = cliErrorCode(res.stdout)
      const now = parseRunCurrent(res.stdout)
      let patch: Partial<Batch> | null = null
      if (code === SESSION_GONE) {
        patch = { closed: true }
        log(`닫힘 판정 채팅 세션 ${b.route.sessionId}: 닫힘(${SESSION_GONE})`)
      } else if (now !== undefined && now !== b.route.runId) {
        patch = { route: { ...b.route, runId: now } }
        log(`refresh: 채팅 묶음 ${b.id} Run ${b.route.runId ?? '없음'} → ${now ?? '없음'}`)
      } else if (now === undefined) {
        log(`닫힘 판정 채팅 세션 ${b.route.sessionId}: 판정 불가(닫힘으로 보지 않음): ${code ?? `종료 코드 ${res.code ?? '없음'}`}`)
      }
      if (patch !== null) next = patchBatch(next, b.id, b.terminalId, patch)
    }
    if (next !== list) await save(next)
  }

  orca.panels.handle('qp.refresh', async () => {
    const start = Date.now()
    await ingest()
    await syncLedger()
    await refresh()
    log(`qp.refresh 끝(${Date.now() - start}ms)`)

    return { ok: true, reason: '' }
  })

  // 정리(0.4.1). 지운 묶음은 지운 기록(DISMISSED_KEY)에 남겨 되돌릴 수 있고, 질문 폴더에 같은 파일이
  // 남아 있어도 다시 띄우지 않는다(ingest).
  orca.panels.handle('qp.remove', async ({ id, terminalId }) => {
    // 살아 있는 세션의 대기 카드를 지우면 「답 없이 닫음」이다: 장부에 남겨 Claude Code 패널도 닫히게 한다
    // (그 mod 가 세션에 「qN 답 없이 닫음(Orca)」을 알린다). 이미 다른 곳이 닫았으면 그대로 지우기만.
    const b = (await load()).find(x => x.id === id && x.terminalId === terminalId)
    if (b !== undefined && b.status === 'pending' && b.closed !== true) await claim(b, 'dismissed')
    const n = await dismiss(b => b.id === id && b.terminalId === terminalId, '카드 지우기', true)

    return n === 0 ? { ok: false, reason: '이미 지웠거나 없는 묶음입니다.' } : { ok: true, reason: '' }
  })

  orca.panels.handle('qp.undoRemove', async ({ id, terminalId }) => {
    const all = await loadDismissed()
    const hit = all.filter(d => d.batch?.id === id && d.batch.terminalId === terminalId).pop()
    if (hit?.batch === undefined) return { ok: false, reason: '되돌릴 묶음이 없습니다.' }
    await save(addBatch(await load(), hit.batch))
    await orca.storage.set(DISMISSED_KEY, all.filter(d => d !== hit) as unknown as JsonValue)
    log(`묶음 ${id}(terminal ${terminalId}) 되돌림`)

    return { ok: true, reason: '' }
  })

  orca.panels.handle('qp.clearClosed', async () => {
    const n = await dismiss(b => b.status === 'pending' && b.closed === true, '닫힌 세션 묶음 정리')
    log(`닫힌 세션 묶음 ${n}개 지움`)

    return { ok: true, reason: '' }
  })

  orca.panels.handle('qp.clearSent', async () => {
    const n = await dismiss(b => b.status === 'sent', '보낸 기록 정리')
    log(`보낸 묶음 ${n}개 지움`)

    return { ok: true, reason: '' }
  })

  // 채팅 세션 질문 폴더를 본다. 훅이 있어 워커는 늘 떠 있다(pluginNeedsResidentWorker).
  void ingest().then(syncLedger)
  if (io.pollMs !== null) {
    stopPolling?.()
    const timer = setInterval(() => void ingest().then(syncLedger), io.pollMs)
    // 워커는 host 연결이 붙잡고 있다. 타이머가 프로세스를 붙잡지 않게 한다(시험이 끝나도록).
    ;(timer as unknown as { unref?: () => void }).unref?.()
    stopPolling = () => clearInterval(timer)
  }
}

export default createWorker(nodeIo)
