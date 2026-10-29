import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { QuestionPanelBatch, QuestionPanelQuestion } from '../types'

const PANE = 'questions'
const TITLE = '질문'
const TOOL = 'mcp__question-panel__ask'

// 필드가 바뀌면 태그를 올린다: 이전 버전이 저장한 값은 비어 있는 것으로 읽힌다.
const queue = atom({ plugin: 'question-panel', key: 'queue' } as const, [], {
  shape: 'queue-1',
})

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
    for (const o of item.options as { label?: unknown; description?: unknown }[]) {
      if (typeof o?.label !== 'string' || o.label === '') {
        return '각 선택지에는 label이 필요합니다.'
      }
      options.push({
        label: o.label,
        description: typeof o.description === 'string' ? o.description : '',
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'ask',
      description:
        '사용자에게 객관식 질문을 한다. AskUserQuestion과 같은 모양이지만 기다리지 않는다. 질문은 오른쪽 「질문」 패널에 쌓이고, 사용자가 답하고 완료를 누르면 「[질문 패널 답] 질문 = 고른 것」 형식의 새 사용자 메시지로 답이 온다. 이 도구를 부른 뒤에는 답을 기다리지 말고 턴을 마쳐라.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '질문 글' },
                header: { type: 'string', maxLength: 12, description: '12자 이내 짧은 칩 제목' },
                multiSelect: { type: 'boolean', description: '여러 개 고를 수 있으면 true' },
                options: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string' },
                      description: { type: 'string' },
                    },
                    required: ['label', 'description'],
                  },
                },
              },
              required: ['question', 'header', 'options', 'multiSelect'],
            },
          },
        },
        required: ['questions'],
      },
    })
    await $.command.register({
      name: 'questions',
      description: '질문 패널을 연다',
    })
    await $.command.register({
      name: 'questions-clear',
      description: '질문 패널에서 보낸 묶음을 지운다',
    })

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const questions = normalize(e.questions)
    if (typeof questions === 'string') return { deny: `question-panel: ${questions}` }

    const now = await $.clock.now()
    const list = await read($, queue)
    const top = Math.max(0, ...list.map(b => Number(b.id.slice(1)) || 0))
    const id = `q${top + 1}`
    const batch: QuestionPanelBatch = {
      id,
      createdAt: now,
      status: 'pending',
      questions,
    }
    await update($, queue, l => [...l, batch])
    void $.ui.open({ id: PANE, title: TITLE })

    return {
      result: `질문 묶음 ${id}을 패널에 올렸다. 답은 사용자가 완료를 누르면 새 메시지로 온다.`,
    }
  })

  on('command.run', { command: 'questions' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: '질문 패널을 열었습니다.' }
  })

  on('command.run', { command: 'questions-clear' }, async $ => {
    let removed = 0
    await update($, queue, l => {
      removed = l.filter(b => b.status === 'sent').length

      return l.filter(b => b.status !== 'sent')
    })

    return { text: `보낸 묶음 ${removed}개를 지웠습니다.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    // 모바일에는 Input과 Select가 없다: 「기타」 칸은 그 표면에서 그리지 않는다.
    const Input = 'Input' in t ? t.Input : undefined
    const list = await read($, queue)

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

    const pick = (id: string, qi: number, label: string) =>
      edit(id, qi, q => {
        if (q.multiSelect) {
          const has = q.picked.includes(label)

          return {
            ...q,
            picked: has ? q.picked.filter(p => p !== label) : [...q.picked, label],
          }
        }

        return { ...q, picked: q.picked[0] === label && q.other === '' ? [] : [label], other: '' }
      })

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

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>쌓인 질문이 없습니다.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {list.map(batch => {
          if (batch.status === 'sent') {
            return (
              <Box key={`b:${batch.id}`} flexDirection="column" marginBottom={1}>
                <Text dimColor>
                  보냄 · {batch.id} · {clock(batch.createdAt)} · 질문 {batch.questions.length}개
                </Text>
              </Box>
            )
          }

          return (
            <Box key={`b:${batch.id}`} flexDirection="column" marginBottom={1}>
              <Text weight="bold">
                묶음 {batch.id} <Text dimColor>{clock(batch.createdAt)}</Text>
              </Text>
              {batch.questions.map((q, qi) => (
                <Box key={`q:${batch.id}:${qi}`} flexDirection="column" marginTop={1}>
                  <Text>
                    <Text inverse> {q.header || '질문'} </Text> <Text weight="bold">{q.question}</Text>
                    {q.multiSelect && <Text dimColor> (여러 개 선택)</Text>}
                  </Text>
                  {q.options.map((o, oi) => {
                    const isOn = q.picked.includes(o.label)
                    const mark = q.multiSelect ? (isOn ? '[x]' : '[ ]') : isOn ? '(o)' : '( )'

                    return (
                      <Button
                        key={`o:${batch.id}:${qi}:${oi}`}
                        variant={isOn ? 'primary' : undefined}
                        onPress={() => pick(batch.id, qi, o.label)}
                      >
                        {mark} {o.label}
                        {o.description !== '' && <Text dimColor> {o.description}</Text>}
                      </Button>
                    )
                  })}
                  {Input ? (
                    <Input
                      key={`x:${batch.id}:${qi}`}
                      label="기타(직접 입력)"
                      placeholder="직접 입력"
                      value={q.other}
                      onInput={text => typeOther(batch.id, qi, text)}
                      onSubmit={text => typeOther(batch.id, qi, text)}
                    />
                  ) : (
                    <Text dimColor>이 화면에서는 직접 입력(기타)을 지원하지 않습니다.</Text>
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
                <Text dimColor>
                  완료 (모든 질문에 답하면 누를 수 있습니다: {batch.questions.filter(isAnswered).length}/
                  {batch.questions.length})
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
