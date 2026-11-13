import { atom, read, update } from 'claude-code'
import type { Hook, Register, RenderSurface } from 'claude-code'

import type { QuestionPanelBatch, QuestionPanelQuestion } from '../types'

const PANE = 'questions'
const TITLE = '질문'
// 질문 도구는 이 플러그인의 stdio MCP 서버(.mcp.json의 qp, mcp/server.mjs)가 낸다. mod 도구로 내면
// Claude Code가 PreToolUse·PostToolUse 훅을 돌리지 않아 Orca 등 바깥 도구가 질문을 못 받는다(0.6.0).
const TOOL = 'mcp__plugin_question-panel_qp__ask'
// 「대화창에서 답함」으로 닫는 도구도 MCP 서버가 낸다(0.6.3). mod 도구였을 때는 훅을 타지 않아
// Orca 질문 패널이 닫힌 줄 몰라 같은 질문에 또 답이 갔다.
const RESOLVE_TOOL = 'mcp__plugin_question-panel_qp__resolve'

// 필드가 바뀌면 태그를 올린다: 이전 버전이 저장한 값은 비어 있는 것으로 읽힌다.
const queue = atom({ plugin: 'question-panel', key: 'queue' } as const, [], {
  shape: 'queue-1',
})
// 패널 아래 「보내기」 칸에 쓰는 중인 글.
const draft = atom({ plugin: 'question-panel', key: 'draft' } as const, '')

// 데스크톱 등 원격 표면이 pane을 그리지 않을 때도 질문이 보이도록, 터미널 밖에서는
// 질문을 올린 도구 줄과 /questions 출력 줄에도 같은 내용을 그린다.
const isRemote = (surface: RenderSurface) => surface !== 'terminal'

// 질문 패널을 붙일 화면이 있는가. 터미널 REPL은 늘 terminal surface를 가진다.
// Orca 채팅(stream-json)처럼 surface가 하나도 없으면 패널도 원격 카드도 그려지지 않는다.
// 그래도 AskUserQuestion(세션을 막는다)으로 돌리지 않고 질문을 쌓은 뒤 턴을 끝낸다. Orca 채팅이면
// MCP 서버가 Orca 사이드바 질문 패널로 넘기고, 답은 메일이나 「q4 1-2」 같은 글로 온다.
const panelMode = (surfaces: readonly RenderSurface[]): 'panel' | 'no-surface' =>
  surfaces.length > 0 ? 'panel' : 'no-surface'

const NO_SURFACE_TEXT =
  '이 세션은 Claude Code 패널 화면이 없습니다(Orca 채팅 등 — Orca 사이드바 「질문」 패널에서 답할 수 있습니다). 대기 중인 질문은 아래와 같고, 글로 답해도 됩니다(예: q4 1-2).'

type RawQuestion = {
  question?: unknown
  header?: unknown
  options?: unknown
  multiSelect?: unknown
}

const OTHER_LABEL = '기타'

const isAnswered = (q: QuestionPanelQuestion) =>
  q.picked.length > 0 || q.other.trim() !== ''

const isComplete = (b: QuestionPanelBatch) => b.questions.every(isAnswered)

const chosen = (q: QuestionPanelQuestion) => {
  const list = [...q.picked]
  if (q.other.trim() !== '') list.push(`${OTHER_LABEL}: ${q.other.trim()}`)
  return list.join(', ')
}

const answerText = (b: QuestionPanelBatch) =>
  b.questions.map(q => `[질문 패널 답] ${q.question} = ${chosen(q)}`).join('\n')

// preview를 목록 항목 아래 코드 블록으로 넣는다. 본문에 든 백틱 줄보다 긴 울타리를 써서 닫히지 않게 한다.
const fenced = (text: string) => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))

  return [fence, ...text.split('\n'), fence].map(l => `  ${l}`)
}

// 대화창에 옮겨 적을 마크다운 블록. Remote Control·폰처럼 플러그인 UI가 오지 않는 화면에서도
// 질문이 보이고, 「q4 1-2」처럼 묶음 ID와 번호로 글로 답할 수 있게 한다.
const chatBlock = (b: QuestionPanelBatch) => {
  const lines = [`**[질문 묶음 ${b.id}]** 패널에서 답하거나, 이 대화창에 글로 답해도 됩니다.`]
  b.questions.forEach((q, qi) => {
    const head = q.header === '' ? '' : `〔${q.header}〕 `
    const how = q.multiSelect ? '여러 개 선택 가능' : '하나만 선택'
    lines.push('', `**${qi + 1}. ${head}${q.question}** (${how})`)
    q.options.forEach((o, oi) => {
      lines.push(`- ${oi + 1}) ${o.label}${o.description === '' ? '' : ` — ${o.description}`}`)
      if (o.preview !== undefined) lines.push(...fenced(o.preview))
    })
  })
  const example =
    b.questions.length === 1
      ? `\`${b.id} 2\`(선택지 번호)`
      : `\`${b.id} 1-2, 2-1\`(질문 번호-선택지 번호)`
  lines.push('', `번호로 답해도 됩니다: ${example}. 목록에 없는 답은 그대로 글로 적으면 됩니다.`)

  return lines.join('\n')
}

// 사용자 글에 대기 중인 묶음 ID(q4 등)가 있으면 그 묶음을 「대화창에서 답함」으로 닫는다.
// 패널에서 같은 질문에 또 답해 답이 두 번 가는 일을 막는다.
const mentionedIds = (text: string) => new Set([...text.matchAll(/\bq(\d+)\b/gi)].map(m => `q${m[1]}`))

const closeInChat = (list: QuestionPanelBatch[], ids: Set<string>) =>
  list.map(b =>
    ids.has(b.id) && b.status === 'pending'
      ? { ...b, status: 'sent' as const, via: 'chat' as const, confirmingDelete: false }
      : b,
  )

// 대화창 글로 답해 닫힌 묶음 ID들. 질문·resolve 호출에 panel_closed 로 붙여 Orca 질문 패널 카드도 닫는다
// (prompt.submit 훅에는 바깥으로 알릴 길이 없어 다음 도구 호출에 실어 보낸다, 0.6.3).
const chatClosed = (list: readonly QuestionPanelBatch[]) => list.filter(b => b.via !== undefined).map(b => b.id)

// 답한 묶음(패널에서 보냄·대화창에서 답함)만 지운다. 대기 중인 묶음은 남긴다.
const clearSent = (list: QuestionPanelBatch[]) => list.filter(b => b.status !== 'sent')

// preview가 이미 코드 블록이면 그대로, 아니면 글자 그대로 보이게(ASCII 목업 정렬 유지) 코드 블록으로 감싼다.
const fencedPreview = (text: string) =>
  /^\s*(```|~~~)/.test(text) ? text : fenced(text).map(l => l.slice(2)).join('\n')

const clock = (ms: number) => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

const normalize = (raw: unknown): QuestionPanelQuestion[] | string => {
  if (!Array.isArray(raw) || raw.length === 0) return 'questions가 비었습니다.'
  const out: QuestionPanelQuestion[] = []
  for (const item of raw as RawQuestion[]) {
    if (typeof item?.question !== 'string' || item.question.trim() === '') {
      return '각 질문에는 question 글이 필요합니다.'
    }
    if (!Array.isArray(item.options) || item.options.length === 0) {
      return '각 질문에는 options가 하나 이상 필요합니다.'
    }
    const options = []
    for (const o of item.options as { label?: unknown; description?: unknown; preview?: unknown }[]) {
      if (typeof o?.label !== 'string' || o.label === '') {
        return '각 선택지에는 label이 필요합니다.'
      }
      options.push({
        label: o.label,
        description: typeof o.description === 'string' ? o.description : '',
        ...(typeof o.preview === 'string' && o.preview.trim() !== '' ? { preview: o.preview } : {}),
      })
    }
    out.push({
      question: item.question,
      header: typeof item.header === 'string' ? item.header.slice(0, 12) : '',
      options,
      multiSelect: item.multiSelect === true,
      picked: [],
      other: '',
    })
  }
  return out
}

// 질문 카드와 「보내기」 칸을 그리는 함수들: pane, 도구 줄, /questions 출력 줄이 같이 쓴다.
type RenderSelf = Parameters<Hook<'ui.render'>>[0]
type RenderEvent = Parameters<Hook<'ui.render'>>[1]
function kit($: RenderSelf, e: RenderEvent) {
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

  const edit = (
    id: string,
    qi: number,
    change: (q: QuestionPanelQuestion) => QuestionPanelQuestion,
  ) =>
    update($, queue, l =>
      l.map(b =>
        b.id !== id || b.status !== 'pending'
          ? b
          : { ...b, questions: b.questions.map((q, i) => (i === qi ? change(q) : q)) },
      ),
    )

  // 고르면 그 선택지의 preview를 펼친다(있으면). 초점 이벤트가 없어 누름을 「초점」으로 본다.
  const pick = (id: string, qi: number, label: string) =>
    edit(id, qi, q => {
      const hasPreview = q.options.some(o => o.label === label && o.preview !== undefined)
      const peek = hasPreview ? label : q.peek
      if (q.multiSelect) {
        const has = q.picked.includes(label)

        return {
          ...q,
          peek,
          picked: has ? q.picked.filter(p => p !== label) : [...q.picked, label],
        }
      }

      return { ...q, peek, picked: q.picked[0] === label && q.other === '' ? [] : [label], other: '' }
    })

  // 고르지 않고 preview만 펼치거나 접는다.
  const togglePeek = (id: string, qi: number, label: string) =>
    edit(id, qi, q => ({ ...q, peek: q.peek === label ? undefined : label }))

  const typeOther = (id: string, qi: number, text: string) =>
    edit(id, qi, q => ({ ...q, other: text, picked: q.multiSelect ? q.picked : text.trim() === '' ? q.picked : [] }))

  const finish = async (id: string) => {
    let sent = undefined as QuestionPanelBatch | undefined
    await update($, queue, l => {
      // update는 다시 시도할 수 있어 이 클로저가 여러 번 돈다: 마지막 판정만 남긴다.
      sent = undefined

      return l.map(b => {
        if (b.id !== id || b.status !== 'pending' || !isComplete(b)) return b
        sent = b

        return { ...b, status: 'sent' as const }
      })
    })
    if (sent === undefined) return
    // 큐에 들어가는 제출: 턴이 진행 중이어도 끼어들지 않고 턴이 끝나면 새 턴으로 간다.
    // 결과를 기다리지 않는다(턴이 시작될 때야 돌아온다). 실패하면 대기로 되돌린다.
    $.prompt.submit({ text: answerText(sent), asUser: true }).catch(() => {
      void update($, queue, l =>
        l.map(b => (b.id === id ? { ...b, status: 'pending' as const } : b)),
      )
      $.ui.toast('답을 보내지 못했습니다. 다시 완료를 눌러 주세요.')
    })
  }

  // 자유 글을 답과 같은 길(큐에 들어가는 사용자 메시지)로 보낸다. 빈 글은 보내지 않는다.
  const say = async (typed?: string) => {
    let text = ''
    await update($, draft, d => {
      text = (typed ?? d).trim()

      return text === '' ? d : ''
    })
    if (text === '') return
    const ids = mentionedIds(text)
    if (ids.size > 0) void update($, queue, l => closeInChat(l, ids))
    $.prompt.submit({ text, asUser: true }).catch(() => {
      void update($, draft, d => (d === '' ? text : d))
      $.ui.toast('글을 보내지 못했습니다. 다시 보내기를 눌러 주세요.')
    })
  }

  const askDelete = (id: string, confirming: boolean) =>
    update($, queue, l =>
      l.map(b => (b.id === id && b.status === 'pending' ? { ...b, confirmingDelete: confirming } : b)),
    )

  // 답한(보낸·대화창에서 답한) 묶음은 확인 없이 지운다. 대기 중인 묶음은 아래 remove의 확인을 거친다.
  const removeSent = (id: string) => update($, queue, l => l.filter(b => !(b.id === id && b.status === 'sent')))

  // 답 없이 닫는다(0.8.0): 묶음은 「답 없이 닫음」 기록으로 남기고(Orca 질문 패널 카드도 다음 도구 호출에
  // panel_closed 로 닫힌다), 세션에는 「qN 답 없이 닫음」을 한 줄 보내 모델이 기다리지 않게 한다.
  const remove = async (id: string) => {
    let closed = false
    await update($, queue, l => {
      closed = false

      return l.map(b => {
        if (b.id !== id || b.status !== 'pending' || b.confirmingDelete !== true) return b
        closed = true

        return { ...b, status: 'sent' as const, via: 'dismissed' as const, confirmingDelete: false }
      })
    })
    if (!closed) return
    $.prompt.submit({ text: `[질문 패널 답] ${id} 답 없이 닫음`, asUser: true }).catch(() => {
      $.ui.toast('세션에 닫음을 알리지 못했습니다.')
    })
  }

  const card = (batch: QuestionPanelBatch) => {
    if (batch.status === 'sent') {
      return (
        <Box key={`b:${batch.id}`} flexDirection="column" marginBottom={1}>
          <Text dimColor wrap="wrap">
            {batch.via === 'chat' ? '대화창에서 답함' : batch.via === 'dismissed' ? '답 없이 닫음' : '보냄'} · {batch.id} · {clock(batch.createdAt)} · 질문{' '}
            {batch.questions.length}개
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
          onInput={typed => update($, draft, () => typed)}
          onSubmit={typed => say(typed)}
        />
        <Button key="say:send" label="보내기" variant="primary" onPress={() => say()} />
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
            onPress={() => update($, queue, clearSent)}
          />
        )}
        {composer(text)}
      </Box>
    )
  }

  return { card, panel }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'questions',
      description: '질문 패널을 연다(열려 있으면 닫는다). /questions close 는 늘 닫는다',
    })
    await $.command.register({
      name: 'questions-clear',
      description: '질문 패널에서 답한 묶음(보냄·대화창에서 답함)을 모두 지운다. 대기 중인 묶음은 남긴다',
    })

    return next(e)
  })

  // MCP 서버의 도구는 기본으로 ToolSearch 뒤에 숨는다. 예전 mod 도구(isDeferred: false)처럼
  // 처음부터 도구 목록에 두어, 모델이 AskUserQuestion 대신 이것을 바로 고르게 한다.
  on('tool.describe', { tool: TOOL }, async (_$, e, next) => ({ ...(await next(e)), isDeferred: false }))
  on('tool.describe', { tool: RESOLVE_TOOL }, async (_$, e, next) => ({ ...(await next(e)), isDeferred: false }))

  // 질문 도구 호출을 감싼다: 묶음을 쌓고 모델이 읽을 결과 글을 만들어 입력의 panel_result로
  // MCP 서버에 넘긴다(서버는 그 글을 그대로 돌려준다). next를 거쳐야 MCP 호출과 함께
  // PreToolUse·PostToolUse 훅이 돌고, 그 tool_response에 「질문 묶음 qN」이 담긴다.
  on('tool.call', { tool: TOOL }, async ($, e, next) => {
    const questions = normalize(e.questions)
    if (typeof questions === 'string') return { deny: `question-panel: ${questions}` }
    const mode = panelMode(await $.session.surfaces())

    const now = await $.clock.now()
    const list = await read($, queue)
    const top = Math.max(0, ...list.map(b => Number(b.id.slice(1)) || 0))
    const id = `q${top + 1}`
    const batch: QuestionPanelBatch = {
      id,
      createdAt: now,
      status: 'pending',
      questions,
      toolUseId: e.tool_use_id,
    }
    await update($, queue, l => [...l, batch])
    // 결과 글은 짧게: 데스크톱 앱·CLI·Orca(터미널·채팅) 모두 질문 패널을 그리므로 질문을 대화창에
    // 다시 쓰지 않게 한다(0.7.0). 패널이 정말 안 보이는 화면(Remote Control·폰)용 옛 결과(블록을 옮겨
    // 적게 하는 글)는 panel_echo로 따로 넘기고, MCP 서버가 QUESTION_PANEL_ECHO=1일 때만 그것을 돌려준다
    // (훅 환경에는 process가 없어 환경변수는 서버만 읽는다).
    const replyLine = `답은 「[질문 패널 답] …」 메시지(Orca면 제목 「[질문 패널 답] ${id}」 메일)나 사용자의 글(「${id} 1-2」 같은)로 온다. 묶음 ID 없이 글로 답이 오면 ${RESOLVE_TOOL}로 이 묶음을 닫아라.`
    const panelResult = [
      `질문 묶음 ${id}을 패널에 올렸다. 질문을 대화창에 다시 쓰지 말고 「질문 패널에 올렸습니다(${id})」 정도로 짧게 말하고 턴을 마쳐라. AskUserQuestion으로 다시 묻지 마라.`,
      replyLine,
    ].join('\n')
    const panelEcho = [
      `질문 묶음 ${id}을 패널에 올렸다. 아래 블록을 답변 글에 그대로 옮겨 적고 턴을 마쳐라. AskUserQuestion으로 다시 묻지 마라.`,
      replyLine,
      '',
      chatBlock(batch),
    ].join('\n')
    if (mode === 'panel') {
      void $.ui.open({ id: PANE, title: TITLE }).then(opened => {
        if (!opened.isPlaced) $.ui.log(`질문 패널이 아직 자리를 못 잡았습니다: ${opened.reason}`)
      })
    }

    const ran = await next({ ...e, panel_result: panelResult, panel_echo: panelEcho, panel_closed: chatClosed(list) })
    // 서버가 답하지 못했거나(꺼짐·오류) 훅이 막았으면 모델은 묶음을 모른다: 쌓은 묶음을 거둔다.
    if (ran.deny !== undefined || ran.isError === true) await update($, queue, l => l.filter(b => b.id !== id))

    return ran
  })

  // 이 세션의 패널 묶음을 닫고, MCP 서버로 이어 보낸다(next). 서버 호출이라 Orca 터미널 세션은
  // agent.tool.after 훅으로 닫힘을 보고, 채팅 세션은 서버가 Orca 질문 패널 폴더에 닫힘을 남긴다.
  on('tool.call', { tool: RESOLVE_TOOL }, async ($, e, next) => {
    const id = typeof e.id === 'string' ? e.id.trim().toLowerCase() : ''
    let found = undefined as QuestionPanelBatch | undefined
    let after: QuestionPanelBatch[] = []
    await update($, queue, l => {
      found = l.find(b => b.id === id)
      after = closeInChat(l, new Set([id]))

      return after
    })
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
    const ids = mentionedIds(e.text)
    if (ids.size > 0) await update($, queue, l => closeInChat(l, ids))

    return next(e)
  })

  on('command.run', { command: 'questions' }, async ($, e) => {
    const arg = typeof e.args === 'string' ? e.args.trim().toLowerCase() : ''
    const isUp = (await $.ui.panes()).some(p => p.id === PANE)
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

  on('command.run', { command: 'questions-clear' }, async $ => {
    let removed = 0
    await update($, queue, l => {
      removed = l.length - clearSent(l).length

      return clearSent(l)
    })

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
