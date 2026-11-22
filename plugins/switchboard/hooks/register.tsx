import { atom, read, update } from 'claude-code'
import type { Hook, Register, RenderSurface } from 'claude-code'

import {
  claudeHost,
  createEmitter,
  createMidTurnBox,
  compactEnv,
  emitSubmit,
  exportRole,
  hookHttp,
  typingEnv,
  mailProfilePath,
  permissionEnv,
  permissionSummary,
  readCliVersion,
  slotEnv,
  wireClaudeEvents,
  wireStallEvents,
  wireStopHold,
} from '../adapters/claude'
import type { Self } from '../adapters/claude'
import { wireHandoff } from '../adapters/handoff'
import { mcpLedger, SERVER } from '../adapters/ledger'
import {
  chatBlock,
  chatClosed,
  createQuestionPanel,
  fencedPreview,
  hhmm as clock,
  isAnswered,
  isComplete,
  mentionedIds,
  normalize,
  VIA_TEXT,
} from '../core/questions'
import type { Store } from '../core/questions'
import { compactConfig, createSwitchboard, typingConfig } from '../core/switchboard'
import { bossRolesConfig, permissionWaitConfig } from '../core/permission'
import { singleRolesConfig } from '../core/slot'
import type { Switchboard } from '../core/switchboard'
import type { RemoteSink } from '../core/remote-inbox'
import type { AskRefusal } from '../core/remote-ask'
import { askRefusedText, isRemoteId, localFallbackLine, normalizeRelayTo, relayNotDeliveredLine, remoteAskText, withdrawText } from '../core/remote-ask'
import { toolCallOf } from '../core/rules'
import type { QuestionPanelBatch } from '../types'

// Claude Code 쪽 껍데기: 코어(../core)를 Claude 어댑터(../adapters/claude)로 잇고, 질문 패널을 그린다.
// 질문 패널 동작은 question-panel 0.9.0 그대로다(도구 이름만 플러그인 이름을 따라 바뀌었다).

const PANE = 'questions'
const TITLE = '질문'
// 좁은 터미널(#136): 모델이 부른 질문으로 연 패널은 「묻지 않고 연 pane」이라 144열(사람이 한 번 연 뒤로는 110열) 아래에서는
// 자리를 못 잡고 기다린다(Claude Code mod UI 규칙, 배치 옵션 없음). 그때는 질문 첫 줄을 오래 가는 토스트로 띄우고
// /questions(사람이 연 pane 은 폭과 상관없이 자리를 잡는다)를 붙인다. 대화창 줄(ui.log)은 쓰지 않는다(#128).
const NARROW_TOAST_MS = 20_000
const OPEN_HINT = '/questions 로 연다'
// 질문 도구는 이 플러그인의 stdio MCP 서버(.mcp.json의 qp, mcp/server.mjs)가 낸다. mod 도구로 내면
// Claude Code가 PreToolUse·PostToolUse 훅을 돌리지 않아 Orca 등 바깥 도구가 질문을 못 받는다.
const TOOL = 'mcp__plugin_switchboard_qp__ask'
// 「대화창에서 답함」으로 닫는 도구도 MCP 서버가 낸다.
const RESOLVE_TOOL = 'mcp__plugin_switchboard_qp__resolve'
// 닫힘 장부를 다루는 MCP 서버 내부 도구. mod가 $.mcp.call 로만 부르고, 모델이 부르면 막는다.
const SYNC_TOOL = 'mcp__plugin_switchboard_qp__sync'
// 대기 묶음이 있을 때 장부를 볼 간격. Orca 워커는 1.5초마다 본다.
const SYNC_MS = 2000

// 필드가 바뀌면 태그를 올린다: 이전 버전이 저장한 값은 비어 있는 것으로 읽힌다.
const queue = atom({ plugin: 'switchboard', key: 'queue' } as const, [], {
  shape: 'queue-1',
})
// 패널 아래 「보내기」 칸에 쓰는 중인 글.
const draft = atom({ plugin: 'switchboard', key: 'draft' } as const, '')

// 데스크톱 등 원격 표면이 pane을 그리지 않을 때도 질문이 보이도록, 터미널 밖에서는
// 질문을 올린 도구 줄과 /questions 출력 줄에도 같은 내용을 그린다.
const isRemote = (surface: RenderSurface) => surface !== 'terminal'

// 질문 패널을 붙일 화면이 있는가. 터미널 REPL은 늘 terminal surface를 가진다.
// Orca 채팅(stream-json)처럼 surface가 하나도 없으면 패널도 원격 카드도 그려지지 않는다.
// 그래도 AskUserQuestion(세션을 막는다)으로 돌리지 않고 질문을 쌓은 뒤 턴을 끝낸다.
const panelMode = (surfaces: readonly RenderSurface[]): 'panel' | 'no-surface' =>
  surfaces.length > 0 ? 'panel' : 'no-surface'

const NO_SURFACE_TEXT =
  '이 세션은 Claude Code 패널 화면이 없습니다(Orca 채팅 등 — Orca 사이드바 「질문」 패널에서 답할 수 있습니다). 대기 중인 질문은 아래와 같고, 글로 답해도 됩니다(예: q4 1-2).'

// 포트 이벤트와 도구 뒤 끼워 넣기 상자는 세션에 하나다(register 가 한 번 돈다).
const emitter = createEmitter()
const box = createMidTurnBox()
let board: Switchboard | undefined

/** mod 상태(atom)를 코어의 Store 포트로. */
const queueStore = ($: Self): Store<QuestionPanelBatch[]> => ({
  read: () => read($, queue),
  update: fn => update($, queue, fn),
})
const draftStore = ($: Self): Store<string> => ({
  read: () => read($, draft),
  update: fn => update($, draft, fn),
})

/** 이 훅의 `$.http` 를 코어의 http 로(훅 예산은 `$` 응답을 기다리는 동안 멈춘다). */
/** 질문 첫 줄(여럿이면 「외 N」). */
const headline = (qs: readonly { question: string }[]) =>
  `${qs[0]?.question ?? ''}${qs.length > 1 ? ` 외 ${qs.length - 1}` : ''}`

/** 질문 패널을 연다. 자리를 못 잡았으면(좁은 터미널) 질문을 토스트로 보이고 false. */
const openPanel = async ($: Self, toast: string): Promise<boolean> => {
  const opened = await $.ui.open({ id: PANE, title: TITLE }).catch(() => null)
  if (opened === null || opened.isPlaced) return true
  $.ui.toast(`${toast} — ${OPEN_HINT}`, { timeoutMs: NARROW_TOAST_MS })

  return false
}

/** 이 `$` 로 질문 패널 코어를 만든다(가볍다: 상태는 atom 에 있다). */
const panelOf = ($: Self) =>
  createQuestionPanel({
    queue: queueStore($),
    draft: draftStore($),
    host: claudeHost($, emitter, box),
    ledger: mcpLedger($),
    notify: text => $.ui.toast(text),
    // 원격 묶음(대장 세션, #112)의 답은 세션 턴이 아니라 서버로 간다.
    remote: {
      answer: async (id, answers) =>
        board === undefined ? { kind: 'failed', reason: '교환대가 꺼져 있음' } : board.answerRemote(id, answers),
    },
    log: text => void $.ui.log(text),
  })

/**
 * 원격 질문 대장 쪽(#112): 코어가 끌어온 서버 질문을 이 세션의 질문 패널에 올리고 닫는다.
 * 올린 묶음은 장부 도구(sync offer)로 Orca 질문 패널 폴더에도 남긴다(Orca 세션일 때만 서버가 쓴다).
 */
const remoteSink = ($: Self): RemoteSink => ({
  offer: async q => {
    const now = await $.clock.now()
    const sid = await $.session.id().catch(() => '')
    const b = await panelOf($).addRemote({ q, sessionId: sid, now })
    if (b === null || b.remote === undefined || b.key === undefined) return
    await mcpLedger($).sync({ offer: { id: b.id, key: b.key, questions: q.questions, remote: b.remote } })
    const toast = `원격 질문 ${b.id}(${q.asker || '?'}): ${q.questions[0]?.question ?? ''}`
    // 패널이 자리를 못 잡으면 openPanel 이 오래 가는 토스트(열기 안내 포함)를 대신 띄운다.
    if (panelMode(await $.session.surfaces()) !== 'panel' || (await openPanel($, toast))) $.ui.toast(toast)
  },
  close: async q => {
    await panelOf($).closeRemote(q.id, q.status === 'withdrawn' ? 'remote-withdrawn' : 'remote-answered')
  },
  prune: async open => {
    await panelOf($).pruneRemote(open)
  },
})

// 질문 카드와 「보내기」 칸을 그리는 함수들: pane, 도구 줄, /questions 출력 줄이 같이 쓴다.
type RenderEvent = Parameters<Hook<'ui.render'>>[1]
function kit($: Self, e: RenderEvent) {
  const t = $.ui.resolve(e)
  const { Box, Text, Button, Markdown } = t
  // 모바일에는 Input과 Select가 없다: 입력 칸은 그 표면에서 그리지 않는다. 표는 빠진 요소를
  // 빈 조각으로 채워 건네므로 'Input' in t만으로는 가릴 수 없어 표면 이름도 본다.
  const Input = e.surface !== 'mobile' && 'Input' in t ? t.Input : undefined
  // 데스크톱은 Button을 네이티브 버튼 한 줄로 그려 긴 글을 줄임표로 자른다(ButtonProps에는
  // wrap이 없다). 원격 표면에서는 버튼에 짧은 표시만 두고 글은 줄바꿈되는 Text로 뺀다.
  const remote = isRemote(e.surface)
  // 원격 표면의 입력 칸은 여러 줄로 둬 긴 글이 한눈에 보이게 한다(터미널은 그대로 한 줄).
  const rows = remote ? 3 : undefined

  const p = panelOf($)
  const { pick, togglePeek, typeOther, finish, askDelete, removeSent } = p
  const remove = p.dismiss

  const card = (batch: QuestionPanelBatch) => {
    if (batch.status === 'sent') {
      return (
        <Box key={`b:${batch.id}`} flexDirection="column" marginBottom={1}>
          <Text dimColor wrap="wrap">
            {batch.via === undefined ? (batch.remote === undefined ? '보냄' : '서버에 답함') : VIA_TEXT[batch.via]} · {batch.id} ·{' '}
            {clock(batch.createdAt)} · 질문 {batch.questions.length}개
            {batch.remote === undefined ? '' : ` · 원격 질문 · ${batch.remote.asker || '?'}`}
          </Text>
          <Button key={`delsent:${batch.id}`} label="기록 지우기" onPress={() => removeSent(batch.id)} />
        </Box>
      )
    }

    if (batch.confirmingDelete === true) {
      return (
        <Box key={`b:${batch.id}`} flexDirection="column" marginBottom={1}>
          <Text weight="bold" wrap="wrap">
            묶음 {batch.id} <Text dimColor>{clock(batch.createdAt)}</Text>
          </Text>
          <Text wrap="wrap">이 질문을 답 없이 닫을까요?</Text>
          <Button
            key={`delok:${batch.id}`}
            label="닫기 확인"
            variant="primary"
            onPress={() => remove(batch.id)}
          />
          <Button
            key={`delno:${batch.id}`}
            label="취소"
            onPress={() => askDelete(batch.id, false)}
          />
        </Box>
      )
    }

    return (
      <Box key={`b:${batch.id}`} flexDirection="column" marginBottom={1}>
        <Text weight="bold" wrap="wrap">
          묶음 {batch.id} <Text dimColor>{clock(batch.createdAt)}</Text>
          {batch.remote !== undefined && <Text dimColor> · 원격 질문 · 묻는 역할 {batch.remote.asker || '?'}</Text>}
        </Text>
        {batch.questions.map((q, qi) => (
          <Box key={`q:${batch.id}:${qi}`} flexDirection="column" marginTop={1}>
            <Text wrap="wrap">
              <Text inverse> {q.header || '질문'} </Text> <Text weight="bold">{q.question}</Text>
              {q.multiSelect && <Text dimColor> (여러 개 선택)</Text>}
            </Text>
            {q.options.map((o, oi) => {
              const isOn = q.picked.includes(o.label)
              const mark = q.multiSelect ? (isOn ? '[x]' : '[ ]') : isOn ? '(o)' : '( )'
              const peekButton =
                o.preview === undefined ? null : (
                  <Button
                    key={`pv:${batch.id}:${qi}:${oi}`}
                    label={q.peek === o.label ? '미리보기 접기' : '미리보기'}
                    onPress={() => togglePeek(batch.id, qi, o.label)}
                  />
                )

              if (remote) {
                return (
                  <Box key={`or:${batch.id}:${qi}:${oi}`} flexDirection="row" gap={1} alignItems="flex-start">
                    <Button
                      key={`o:${batch.id}:${qi}:${oi}`}
                      label={isOn ? `${mark} 고름` : `${mark} 고르기`}
                      variant={isOn ? 'primary' : undefined}
                      onPress={() => pick(batch.id, qi, o.label)}
                    />
                    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                      <Text wrap="wrap">{o.label}</Text>
                      {o.description !== '' && (
                        <Text dimColor wrap="wrap">
                          {o.description}
                        </Text>
                      )}
                      {peekButton}
                    </Box>
                  </Box>
                )
              }

              const optionButton = (
                <Button
                  key={`o:${batch.id}:${qi}:${oi}`}
                  variant={isOn ? 'primary' : undefined}
                  onPress={() => pick(batch.id, qi, o.label)}
                >
                  {mark} {o.label}
                  {o.description !== '' && <Text dimColor> {o.description}</Text>}
                </Button>
              )
              if (peekButton === null) return optionButton

              return (
                <Box key={`or:${batch.id}:${qi}:${oi}`} flexDirection="row" gap={1}>
                  {optionButton}
                  {peekButton}
                </Box>
              )
            })}
            {(() => {
              // 펼친 preview는 선택지 목록 바로 아래에 둔다(좁은 패널에서도 옆이 아니라 아래로).
              const shown = q.options.find(o => o.label === q.peek && o.preview !== undefined)
              if (shown === undefined) return null

              return (
                <Box key={`pvbox:${batch.id}:${qi}`} flexDirection="column" marginTop={1}>
                  <Text dimColor wrap="wrap">
                    미리보기 · {shown.label}
                  </Text>
                  <Markdown key={`pvmd:${batch.id}:${qi}`} text={fencedPreview(shown.preview ?? '')} />
                </Box>
              )
            })()}
            {Input ? (
              <Input
                key={`x:${batch.id}:${qi}`}
                label="기타(직접 입력)"
                placeholder="직접 입력"
                rows={rows}
                value={q.other}
                onInput={text => typeOther(batch.id, qi, text)}
                onSubmit={text => typeOther(batch.id, qi, text)}
              />
            ) : (
              <Text dimColor wrap="wrap">
                이 화면에서는 직접 입력(기타)을 지원하지 않습니다.
              </Text>
            )}
          </Box>
        ))}
        {isComplete(batch) ? (
          <Button
            key={`done:${batch.id}`}
            label="완료"
            variant="primary"
            onPress={() => finish(batch.id)}
          />
        ) : (
          <Text dimColor wrap="wrap">
            완료 (모든 질문에 답하면 누를 수 있습니다: {batch.questions.filter(isAnswered).length}/
            {batch.questions.length})
          </Text>
        )}
        <Button key={`del:${batch.id}`} label="답 없이 닫기" onPress={() => askDelete(batch.id, true)} />
      </Box>
    )
  }

  // 패널만 닫는다: 질문·답 상태는 그대로이고, 새 질문이 오면 다시 열린다.
  const closePane = () => $.ui.close({ id: PANE })

  const composer = (text: string) =>
    Input ? (
      <Box key="say" flexDirection="column" marginTop={1}>
        <Input
          key="say:text"
          label="세션에 보낼 글"
          placeholder="세션에 보낼 글"
          rows={rows}
          value={text}
          onInput={typed => p.typeDraft(typed)}
          onSubmit={typed => p.say(typed)}
        />
        <Button key="say:send" label="보내기" variant="primary" onPress={() => p.say()} />
      </Box>
    ) : (
      <Box key="say" marginTop={1}>
        <Text dimColor wrap="wrap">
          이 화면에서는 글 보내기를 지원하지 않습니다.
        </Text>
      </Box>
    )

  const panel = (list: QuestionPanelBatch[], text: string) => {
    const answered = list.filter(b => b.status === 'sent').length

    return (
      <Box flexDirection="column">
        <Button key="close" role="dismiss" label="패널 닫기" onPress={() => closePane()} />
        {list.length === 0 ? <Text dimColor wrap="wrap">
            쌓인 질문이 없습니다.
          </Text> : list.map(card)}
        {answered > 0 && (
          <Button
            key="clearsent"
            label={`답한 기록 모두 지우기 (${answered})`}
            onPress={() => p.clearAnswered()}
          />
        )}
        {composer(text)}
      </Box>
    )
  }

  return { card, panel }
}

/** 장부를 읽어 다른 곳(Orca 질문 패널 등)에서 닫힌 대기 묶음을 닫는다. */
export const pollLedger = ($: Self) => panelOf($).poll()

// 내장 질문 도구. 질문 패널을 쓸 수 있는 세션이면 막는다(#109).
const ASK_USER_QUESTION = 'AskUserQuestion'
// 질문 header 가 이 말로 시작하면 급한 확인으로 보고 통과시킨다.
const URGENT = '급함'
const ASK_DENY_REASON =
  `switchboard: ${TOOL}로 같은 질문을 올려라(입력 모양이 같다). 답을 받기 전에 한 걸음도 못 나가는 급한 확인이면 ` +
  `질문 header를 \`${URGENT}\`으로 시작해 AskUserQuestion을 다시 불러라.`

// 이 세션에서 질문이 서버에 거절된 마지막 사유(#176). 있으면 AskUserQuestion 막는 안내가 「질문 도구로 다시 올려라」를 되풀이하지 않는다.
let lastRefusal: AskRefusal | null = null

const isUrgent = (questions: unknown): boolean =>
  Array.isArray(questions) &&
  questions.some(
    (q: unknown) =>
      typeof q === 'object' && q !== null && 'header' in q && typeof q.header === 'string' && q.header.trim().startsWith(URGENT),
  )

/**
 * AskUserQuestion 을 막을 이유. 통과면 undefined.
 * 막는 조건: 환경변수로 끄지 않았고, 급한 질문이 아니며, 질문 패널 MCP 서버(qp)가 이 세션에 붙어 있다.
 * qp 판정은 $.mcp.connect(SERVER).isConnected: 서버가 꺼졌거나 실패했거나 승인 전이면 패널로 보낼 길이 없으니 통과.
 */
async function askUserQuestionDenial($: Self, questions: unknown): Promise<string | undefined> {
  // 값이 1이면 막지 않는다($.env.get 은 글자 그대로의 이름만 받는다).
  const allow = await $.env.get('SWITCHBOARD_ALLOW_ASK_USER_QUESTION').catch(() => undefined)
  if (allow?.trim() === '1') return undefined
  if (isUrgent(questions)) return undefined
  const qp = await $.mcp.connect(SERVER).catch(() => undefined)
  if (qp?.isConnected !== true) return undefined

  return lastRefusal === null ? ASK_DENY_REASON : `switchboard: ${askRefusedText(lastRefusal)}`
}

export const register: Register = on => {
  // 포트 이벤트(턴·입력·compact)를 코어로 넘긴다. 관찰만 하므로 세션 흐름은 그대로다.
  // 규칙 원장(#219): 걸린 규칙 줄을 도구 결과의 context 로. 프로필 없는 세션은 board 에 규칙이 없어 아무것도 하지 않는다.
  wireClaudeEvents(on, emitter, box, {
    warm: http => board?.warmRules({ http }),
    lines: async (http, e) => (await board?.ruleLines(toolCallOf(e.tool, e), e.agentId ?? '', { http })) ?? [],
  })
  // 미분류 답 붙들기(#221): 이 역할의 패널 질문 답이 분류되지 않았으면 턴 끝을 막는다. 프로필 없는 세션은 board 가 end.
  wireStopHold(on, async http => (await board?.stopCheck({ http })) ?? { kind: 'end' })
  // 멈춤 감지(D8): API 오류 멈춤·사람 기다림을 코어로.
  wireStallEvents(on, emitter)
  // 백그라운드 명령·예약·감시를 switchboard 장부로 넘긴다(#182). 끄기: SWITCHBOARD_HANDOFF=0.
  wireHandoff(on)
  // 정상 종료(/exit·/clear 등): 번호 역할을 release 한다. 안 하면 lease 가 끝날 때 서버가 부모에게 offline 통지를 보낸다.
  on('session.end', async ($, e, next) => {
    const b = board
    board = undefined
    lastRefusal = null
    await b?.stop()

    return next(e)
  }).catch(($, e, next) => next(e))
  // 원격 권한 답(D8): 창이 뜨기 전에 부모·대장에게 묻는다. 시간 안에 답이 없으면 창으로(next). 그 한 건에만, 규칙은 더하지 않는다.
  on('classic.PermissionRequest', async ($, e, next) => {
    const b = board
    if (b === undefined) return next(e)
    // 기다림은 이 훅의 `$.http` 긴 대기로 한다: 훅 예산(10초)은 `$` 응답을 기다리는 동안 멈춘다.
    const ans = await b.askPermission(
      { tool: e.tool_name, summary: permissionSummary(e.tool_name, e.tool_input, e.agent_type) },
      { http: hookHttp($) },
    )
    if (ans === null) return next(e)
    if (ans.decision === 'allow') return { decision: { behavior: 'allow' } }

    return { decision: { behavior: 'deny', message: `${ans.by} 가 원격으로 거절했다${ans.note === undefined ? '' : `: ${ans.note}`}` } }
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'questions',
      description: '질문 패널을 연다(열려 있으면 닫는다). /questions close 는 늘 닫는다',
    })
    await $.command.register({
      name: 'questions-clear',
      description: '질문 패널에서 답한 묶음(보냄·대화창에서 답함)을 모두 지운다. 대기 중인 묶음은 남긴다',
    })
    await $.command.register({
      name: 'switchboard-takeover',
      description: '이 세션이 메일함 역할의 -1 번호를 가져온다(번호 없이 온 메일을 받는다). 지금 -1 은 다른 번호로 밀린다',
    })
    // 코어를 띄운다: 세션 상태를 따라가고, SWITCHBOARD_PROFILE 이 있으면 메일함(D2)도 켠다.
    void board?.stop()
    const ce = await compactEnv($)
    const compactBeforeMail = compactConfig(ce.tokens, ce.instructions)
    const se = await slotEnv($)
    const pe = await permissionEnv($)
    const mp = await mailProfilePath($)
    board = createSwitchboard(claudeHost($, emitter, box), {
      log: text => void $.ui.log(text),
      warn: text => void $.ui.toast(text),
      permissions: { waitMs: permissionWaitConfig(pe.wait), bosses: bossRolesConfig(pe.bosses) },
      // 대장 역할 세션이면 서버 질문을 끌어와 이 패널에 올린다(#112).
      remoteQuestions: { sink: remoteSink($) },
      mail: {
        profilePath: mp.paths,
        ...(mp.problem === undefined ? {} : { profileProblem: mp.problem }),
        ...(mp.override === undefined ? {} : { override: mp.override }),
        log: text => void $.ui.log(text),
        warn: text => void $.ui.toast(text),
        slot: {
          ...(se.label === undefined ? {} : { label: se.label }),
          ...(se.parent === undefined ? {} : { parent: se.parent }),
          singleRoles: singleRolesConfig(se.singles),
          cliVersion: () => readCliVersion($),
          warn: text => void $.ui.toast(text),
          // 세션의 Bash 가 `switchboard read/ack/complete` 를 번호 메일함으로 하게(D8).
          onRole: role => void exportRole($, role),
        },
      },
      ...(compactBeforeMail === undefined ? {} : { compactBeforeMail }),
      typingLimitMs: typingConfig(await typingEnv($)),
    })
    await board.start().catch(() => false)
    // 다시 뜰 때(reload·resume) 입력창에 이미 글이 있으면 입력 중으로 시작한다.
    try {
      const draft = (await $.prompt.read()).text
      if (draft.trim() !== '') emitter.emit({ type: 'input.change', text: draft })
    } catch {
      // 입력창을 못 읽으면 다음 편집에서 안다.
    }
    // 닫힘 장부를 본다: Orca 질문 패널에서 답하거나 닫은 묶음을 곧 닫는다.
    $.clock.every(SYNC_MS, () => void pollLedger($).catch(() => undefined))

    return next(e)
  })

  // MCP 서버의 도구는 기본으로 ToolSearch 뒤에 숨는다. 예전 mod 도구(isDeferred: false)처럼
  // 처음부터 도구 목록에 두어, 모델이 AskUserQuestion 대신 이것을 바로 고르게 한다.
  on('tool.describe', { tool: TOOL }, async (_$, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: RESOLVE_TOOL }, async (_$, e, next) => ({ ...(await next(e)), isDeferred: false }))
  // 장부 도구는 mod 내부용이다($.mcp.call 은 tool.call 을 거치지 않는다). 모델의 호출은 막는다.
  on('tool.call', { tool: SYNC_TOOL }, async () => ({ deny: 'switchboard: sync 는 질문 패널 내부용 도구다. 부르지 마라.' }))
  // AskUserQuestion 은 세션을 블로킹한다(#109): 질문 패널을 쓸 수 있으면 막고 패널로 돌린다.
  on('tool.call', { tool: ASK_USER_QUESTION }, async ($, e, next) => {
    const reason = await askUserQuestionDenial($, e.questions)

    return reason === undefined ? next(e) : { deny: reason }
  })

  // 질문 도구 호출을 감싼다: 묶음을 쌓고 모델이 읽을 결과 글을 만들어 입력의 panel_result로
  // MCP 서버에 넘긴다(서버는 그 글을 그대로 돌려준다). next를 거쳐야 MCP 호출과 함께
  // PreToolUse·PostToolUse 훅이 돌고, 그 tool_response에 「질문 묶음 qN」이 담긴다.
  on('tool.call', { tool: TOOL }, async ($, e, next) => {
    const questions = normalize(e.questions)
    if (typeof questions === 'string') return { deny: `switchboard: ${questions}` }
    const mode = panelMode(await $.session.surfaces())
    const relayTo = normalizeRelayTo(e.relay_to)

    // 원격 질문(#111): 프로필이 있으면 먼저 서버 질문으로 올린다. 서버 질문은 이 세션의 패널에 올리지 않는다
    // (묻는 쪽이 스스로 답하지 않게 — remote-ask.ts 머리말). 못 올리면 까닭을 결과 글에 적고 로컬 패널로.
    const remote = board === undefined ? { kind: 'local' as const, reason: null } : await board.askRemote(questions, { http: hookHttp($) }, relayTo)
    if (remote.kind === 'remote') {
      lastRefusal = null
      const text = remoteAskText(remote.id, remote.asker, RESOLVE_TOOL, remote.here)
      // panel_remote(#142): Orca 터미널 세션의 agent.tool.after 훅이 이 호출로 터미널 카드(oN)를 따로 만들지 않게 서버 id 를 싣는다.
      // 같은 질문의 Orca 카드는 대장 끌어오기가 원격 카드로 하나만 올린다(답이 터미널로 한 번 더 들어가지 않게).
      const ran = await next({ ...e, panel_result: text, panel_echo: text, panel_closed: chatClosed(await read($, queue)), panel_remote: remote.id })
      // 모델이 질문을 모르게 됐으면(서버 꺼짐·훅이 막음) 서버 질문도 거둔다.
      if (ran.deny !== undefined || ran.isError === true) await board?.withdrawRemote(remote.id, { http: hookHttp($) })

      return ran
    }
    if (remote.kind === 'refused') {
      lastRefusal = { askVia: remote.askVia, settingsTarget: remote.settingsTarget, code: remote.code }

      return { deny: askRefusedText(lastRefusal) }
    }
    const fallback = [...(remote.reason === null ? [] : [localFallbackLine(remote.reason)]), ...(relayTo.length === 0 ? [] : [relayNotDeliveredLine])]

    const now = await $.clock.now()
    const sid = await $.session.id().catch(() => '')
    const p = panelOf($)
    const { batch, before } = await p.add({ questions, toolUseId: e.tool_use_id, sessionId: sid, now })
    const { id, key } = batch
    // 결과 글은 짧게: 데스크톱 앱·CLI·Orca(터미널·채팅) 모두 질문 패널을 그리므로 질문을 대화창에
    // 다시 쓰지 않게 한다. 패널이 정말 안 보이는 화면(Remote Control·폰)용 옛 결과(블록을 옮겨
    // 적게 하는 글)는 panel_echo로 따로 넘기고, MCP 서버가 QUESTION_PANEL_ECHO=1일 때만 그것을 돌려준다
    // (훅 환경에는 process가 없어 환경변수는 서버만 읽는다).
    const replyLine = `답은 「[질문 패널 답] …」 메시지(Orca면 제목 「[질문 패널 답] ${id}」 메일)나 사용자의 글(「${id} 1-2」 같은)로 온다. 묶음 ID 없이 글로 답이 오면 ${RESOLVE_TOOL}로 이 묶음을 닫아라.`
    const panelResult = [
      ...fallback,
      `질문 묶음 ${id}을 패널에 올렸다. 질문을 대화창에 다시 쓰지 말고 「질문 패널에 올렸습니다(${id})」 정도로 짧게 말하고 턴을 마쳐라. AskUserQuestion으로 다시 묻지 마라.`,
      replyLine,
    ].join('\n')
    const panelEcho = [
      ...fallback,
      `질문 묶음 ${id}을 패널에 올렸다. 아래 블록을 답변 글에 그대로 옮겨 적고 턴을 마쳐라. AskUserQuestion으로 다시 묻지 마라.`,
      replyLine,
      '',
      chatBlock(batch),
    ].join('\n')
    if (mode === 'panel') void openPanel($, `질문 ${id}: ${headline(questions)}`)

    const ran = await next({ ...e, panel_result: panelResult, panel_echo: panelEcho, panel_closed: chatClosed(before), panel_key: key })
    // 서버가 답하지 못했거나(꺼짐·오류) 훅이 막았으면 모델은 묶음을 모른다: 쌓은 묶음을 거둔다.
    if (ran.deny !== undefined || ran.isError === true) await p.drop(id)

    return ran
  })

  // 이 세션의 패널 묶음을 닫고, MCP 서버로 이어 보낸다(next). 서버 호출이라 Orca 터미널 세션은
  // agent.tool.after 훅으로 닫힘을 보고, 채팅 세션은 서버가 Orca 질문 패널 폴더에 닫힘을 남긴다.
  on('tool.call', { tool: RESOLVE_TOOL }, async ($, e, next) => {
    const id = typeof e.id === 'string' ? e.id.trim().toLowerCase() : ''
    // 서버 질문(q_…, #111)은 거둔다(POST /withdraw). 로컬 패널에는 없다.
    if (isRemoteId(id)) {
      const r = board === undefined ? { ok: false as const, status: null, reason: '메일함이 꺼져 있음' } : await board.withdrawRemote(id, { http: hookHttp($) })

      return next({ ...e, id, panel_result: withdrawText(id, r), panel_closed: chatClosed(await read($, queue)) })
    }
    const found = (await read($, queue)).find(b => b.id === id)
    await panelOf($).closeByChat(new Set([id]))
    const after = await read($, queue)
    const text =
      found === undefined
        ? `묶음 ${id}이 없다.`
        : found.status !== 'pending'
          ? `묶음 ${id}은 이미 닫혀 있다.`
          : `묶음 ${id}을 「대화창에서 답함」으로 닫았다.`

    return next({ ...e, id, panel_result: text, panel_closed: chatClosed(after) })
  })

  // 사용자가 대화창에 묶음 ID를 넣어 답하면(「q4 2번」) 패널의 그 묶음을 닫는다.
  on('prompt.submit', async ($, e, next) => {
    emitSubmit(emitter, e.text, e.origin?.kind)
    const ids = mentionedIds(e.text)
    if (ids.size > 0) await panelOf($).closeByChat(ids)

    return next(e)
  })

  on('command.run', { command: 'questions' }, async ($, e) => {
    const arg = typeof e.args === 'string' ? e.args.trim().toLowerCase() : ''
    // 자리를 못 잡고 기다리는 pane(좁은 터미널, #136)은 열린 것으로 치지 않는다: 그때 /questions 는 닫지 않고 연다.
    const isUp = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
    if (arg === 'close' || arg === '닫기' || (arg === '' && isUp)) {
      await $.ui.close({ id: PANE })

      return { text: '질문 패널을 닫았습니다. 쌓인 질문은 그대로 있고, 새 질문이 오면 다시 열립니다.' }
    }
    if (panelMode(await $.session.surfaces()) === 'no-surface') {
      const pending = (await read($, queue)).filter(b => b.status === 'pending')

      return { text: [NO_SURFACE_TEXT, ...pending.map(b => `\n${chatBlock(b)}`)].join('\n') }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    if (!opened.isPlaced) {
      return { text: `질문 패널을 열지 못했습니다(${opened.reason}). 질문은 이 줄 아래에 그립니다.` }
    }

    return { text: '질문 패널을 열었습니다.' }
  })

  on('command.run', { command: 'switchboard-takeover' }, async () => {
    if (board === undefined) return { text: 'switchboard 가 아직 켜지지 않았습니다.' }
    const r = await board.takeover()
    if (!r.ok) return { text: `takeover 실패: ${r.reason}` }

    return { text: `이 세션이 ${r.role} 입니다.${r.displaced === undefined ? '' : ` 이전 보유 세션은 ${r.displaced} 로 옮겨졌습니다.`}` }
  })

  on('command.run', { command: 'questions-clear' }, async $ => {
    const removed = await panelOf($).clearAnswered()

    return { text: `보낸 묶음 ${removed}개를 지웠습니다.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [list, text] = await Promise.all([read($, queue), read($, draft)])

    return kit($, e).panel(list, text)
  })

  // 원격 표면에서는 /questions 출력 줄 자리에 패널 전체를 그린다(pane이 안 보여도 쓸 수 있게).
  on('ui.render', { component: 'CommandOutput', props: { command: 'questions' } }, async ($, e, next) => {
    if (!isRemote(e.surface)) return next(e)
    const [list, text] = await Promise.all([read($, queue), read($, draft)])

    return kit($, e).panel(list, text)
  })

  // 원격 표면에서는 질문을 올린 도구 줄 자리에 그 묶음의 카드를 그린다.
  on('ui.render', { component: 'ToolUse', props: { tool: TOOL } }, async ($, e, next) => {
    if (!isRemote(e.surface)) return next(e)
    const list = await read($, queue)
    const batch = list.find(b => b.toolUseId !== undefined && b.toolUseId === e.props.tool_use_id)
    if (batch === undefined) return next(e)

    return kit($, e).card(batch)
  })
}
