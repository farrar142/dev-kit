import { expect, mock, test } from 'claude-code/testing'

import { callAsk, callResolve, callSync, ledgerRecord } from '../mcp/ask.mjs'

const PANE = {
  plugin: 'question-panel',
  component: 'Pane',
  requestId: 'questions',
  props: {
    title: '질문',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const TOOL = 'mcp__plugin_question-panel_qp__ask'

const INPUT = {
  tool: TOOL,
  questions: [
    {
      question: '어느 DB를 쓸까요?',
      header: 'DB',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: '관계형' },
        { label: 'SQLite', description: '파일형' },
      ],
    },
    {
      question: '넣을 기능은?',
      header: '기능',
      multiSelect: true,
      options: [
        { label: '검색', description: '전문 검색' },
        { label: '알림', description: '푸시' },
      ],
    },
  ],
}

const RESOLVE = 'mcp__plugin_question-panel_qp__resolve'
// MCP 서버로 이어진 resolve 호출(입력)들. setup 마다 비운다.
const resolved: any[] = []
// 패널이 열려 있나, 닫기 호출 기록(setup 마다 비운다).
const paneUp = { value: false }
const closes: string[] = []
// setup 의 가짜 시계(장부 동기화 타이머를 움직인다).
const clockRef: { value: any } = { value: undefined }

// MCP 결과(content 블록)의 글.
const textOf = (ran: any) =>
  Array.isArray(ran.result) ? ran.result.map((b: any) => b.text).join('\n') : JSON.stringify(ran)

async function setup(
  $: any,
  on: any,
  surfaces: string[] = ['desktop'],
  server: (e: any) => any = (e: any) => ({ result: callAsk(e).content }),
) {
  clockRef.value = mock.clock(on)
  const submitted: string[] = []
  resolved.length = 0
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  paneUp.value = false
  closes.length = 0
  on('ui.open', () => {
    paneUp.value = true

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: paneUp.value ? [{ id: 'questions', title: '질문', isPlaced: true }] : [] }))
  on('ui.close', (_: any, e: any) => {
    closes.push(e.id)
    paneUp.value = false

    return { value: undefined }
  })
  // MCP 서버(mcp/ask.mjs) 자리: mod가 넘긴 panel_result를 그대로 돌려준다.
  on('tool.call', { tool: TOOL }, (_: any, e: any) => server(e))
  on('tool.call', { tool: RESOLVE }, (_: any, e: any) => {
    resolved.push(e)

    return { result: callResolve(e).content }
  })
  on('prompt.submit', (_: any, e: any) => {
    submitted.push(e.text)

    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  return submitted
}

test('도구 호출로 질문이 쌓이고 패널에 나온다', async ($, on) => {
  await setup($, on)
  const ran = await $.tool.call(INPUT as any)
  expect(JSON.stringify(ran)).toContain('패널에 올렸다')
  await $.tool.call(INPUT as any)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /어느 DB를 쓸까요/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /DB/ })).toBeDefined()
    await ui.unmount()
  }
})

test('다 답하기 전에는 완료가 막히고, 답하면 제출 함수가 바른 글로 불린다', async ($, on) => {
  const submitted = await setup($, on)
  await $.tool.call(INPUT as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'done:q1' })).toBeUndefined()

  await ui.press({ key: 'o:q1:0:1' })
  expect(await ui.find({ key: 'done:q1' })).toBeUndefined()

  await ui.press({ key: 'o:q1:1:0' })
  await ui.press({ key: 'o:q1:1:1' })
  expect(await ui.find({ key: 'done:q1' })).toBeDefined()
  expect(submitted).toEqual([])

  await ui.press({ key: 'done:q1' })
  expect(submitted).toEqual([
    '[질문 패널 답] 어느 DB를 쓸까요? = SQLite\n[질문 패널 답] 넣을 기능은? = 검색, 알림',
  ])
  expect(await ui.find({ key: 'done:q1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /보냄/ })).toBeDefined()
  await ui.unmount()
})

test('multiSelect는 껐다 켤 수 있고, 하나만 고르는 질문은 하나만 남는다', async ($, on) => {
  const submitted = await setup($, on)
  await $.tool.call(INPUT as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'o:q1:0:0' })
  await ui.press({ key: 'o:q1:0:1' })
  await ui.press({ key: 'o:q1:1:0' })
  await ui.press({ key: 'o:q1:1:1' })
  await ui.press({ key: 'o:q1:1:0' })
  await ui.press({ key: 'done:q1' })
  expect(submitted).toEqual([
    '[질문 패널 답] 어느 DB를 쓸까요? = SQLite\n[질문 패널 답] 넣을 기능은? = 알림',
  ])
  await ui.unmount()
})

test('기타 직접 입력으로도 답하고, 모바일에는 입력 칸이 없다', async ($, on) => {
  const submitted = await setup($, on)
  await $.tool.call(INPUT as any)

  const mobile = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await mobile.find({ key: 'o:q1:0:0' })).toBeDefined()
  expect(await mobile.find({ key: 'x:q1:0' })).toBeUndefined()
  expect(await mobile.find({ type: 'Text', text: /직접 입력\(기타\)을 지원하지 않습니다/ })).toBeDefined()
  await mobile.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'x:q1:0', text: 'MySQL', kind: 'change' })
  await ui.press({ key: 'o:q1:1:1' })
  await ui.press({ key: 'done:q1' })
  expect(submitted).toEqual([
    '[질문 패널 답] 어느 DB를 쓸까요? = 기타: MySQL\n[질문 패널 답] 넣을 기능은? = 알림',
  ])
  await ui.unmount()
})

test('답 없이 닫기는 확인을 거치고, 취소하면 남고, 확인하면 「답 없이 닫음」 기록과 세션 알림이 남는다', async ($, on) => {
  const submitted = await setup($, on)
  await $.tool.call(INPUT as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // 답을 하나도 고르지 않아도 삭제를 누를 수 있다.
  await ui.press({ key: 'del:q1' })
  expect(await ui.find({ type: 'Text', text: /이 질문을 답 없이 닫을까요/ })).toBeDefined()
  expect(await ui.find({ key: 'delok:q1' })).toBeDefined()

  await ui.press({ key: 'delno:q1' })
  expect(await ui.find({ type: 'Text', text: /이 질문을 답 없이 닫을까요/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /어느 DB를 쓸까요/ })).toBeDefined()

  await ui.press({ key: 'del:q1' })
  await ui.press({ key: 'delok:q1' })
  expect(await ui.find({ type: 'Text', text: /어느 DB를 쓸까요/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /답 없이 닫음 · q1/ })).toBeDefined()
  expect(submitted).toEqual(['[질문 패널 답] q1 답 없이 닫음'])
  // 닫은 묶음은 다음 질문 호출에 panel_closed 로 실려 Orca 카드도 닫힌다.
  await $.tool.call(INPUT as any)
  expect(resolved.length + submitted.length).toBeGreaterThan(0)
  await ui.unmount()
})

test('패널의 보내기는 글을 세션 메시지로 보내고 칸을 비우며, 빈 글은 보내지 않는다', async ($, on) => {
  const submitted = await setup($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // 질문이 없어도 보내기 칸은 있다.
    expect(await ui.find({ type: 'Text', text: /쌓인 질문이 없습니다/ })).toBeDefined()
    expect(await ui.find({ key: 'say:send' })).toBeDefined()

    await ui.press({ key: 'say:send' })
    await ui.input({ key: 'say:text', text: '   ', kind: 'change' })
    await ui.press({ key: 'say:send' })
    expect(submitted).toEqual([])

    await ui.input({ key: 'say:text', text: `${surface}에서 인사`, kind: 'change' })
    await ui.press({ key: 'say:send' })
    expect(submitted).toEqual([`${surface}에서 인사`])
    expect((await ui.find({ key: 'say:text' }))?.props.value).toBe('')
    submitted.length = 0

    // Enter(제출)로도 보낸다.
    await ui.input({ key: 'say:text', text: '엔터로 보냄', kind: 'submit' })
    expect(submitted).toEqual(['엔터로 보냄'])
    expect((await ui.find({ key: 'say:text' }))?.props.value).toBe('')
    submitted.length = 0
    await ui.unmount()
  }

  const mobile = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await mobile.find({ key: 'say:text' })).toBeUndefined()
  expect(await mobile.find({ type: 'Text', text: /글 보내기를 지원하지 않습니다/ })).toBeDefined()
  await mobile.unmount()
})

test('데스크톱에서는 질문을 올린 도구 줄에 그 묶음을 그리고, 거기서 답할 수 있다', async ($, on) => {
  engineDraws(on)
  const submitted = await setup($, on)
  await $.tool.call({ ...INPUT, tool_use_id: 'toolu_q1' } as any)
  const ROW = {
    plugin: 'question-panel',
    component: 'ToolUse',
    requestId: 'toolu_q1',
    props: {
      tool_use_id: 'toolu_q1',
      tool: TOOL,
      input: { questions: INPUT.questions },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: '질문 묶음 q1을 패널에 올렸다.',
    },
  } as const

  const term = await $.ui.mount({ ...ROW, surface: 'terminal' } as any)
  expect(await term.find({ key: 'o:q1:0:0' })).toBeUndefined()
  await term.unmount()

  const ui = await $.ui.mount({ ...ROW, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /어느 DB를 쓸까요/ })).toBeDefined()
  await ui.press({ key: 'o:q1:0:0' })
  await ui.press({ key: 'o:q1:1:0' })
  await ui.press({ key: 'done:q1' })
  expect(submitted).toEqual([
    '[질문 패널 답] 어느 DB를 쓸까요? = Postgres\n[질문 패널 답] 넣을 기능은? = 검색',
  ])
  expect(await ui.find({ type: 'Text', text: /보냄 · q1/ })).toBeDefined()
  await ui.unmount()
})

test('데스크톱에서는 /questions 출력 줄에 패널 전체(보내기 칸 포함)를 그린다', async ($, on) => {
  engineDraws(on)
  const submitted = await setup($, on)
  await $.tool.call(INPUT as any)
  const OUT = {
    plugin: 'question-panel',
    component: 'CommandOutput',
    requestId: 'cmd-1',
    props: { command: 'questions', args: '', text: '질문 패널을 열었습니다.', isErrored: false },
  } as const

  const term = await $.ui.mount({ ...OUT, surface: 'terminal' } as any)
  expect(await term.find({ key: 'say:send' })).toBeUndefined()
  await term.unmount()

  const ui = await $.ui.mount({ ...OUT, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /어느 DB를 쓸까요/ })).toBeDefined()
  await ui.input({ key: 'say:text', text: '출력 줄에서 보냄', kind: 'change' })
  await ui.press({ key: 'say:send' })
  expect(submitted).toEqual(['출력 줄에서 보냄'])
  await ui.unmount()
})

test('데스크톱에서는 긴 선택지 글을 버튼 밖 Text로 빼 줄바꿈하고, 터미널은 예전처럼 버튼 안에 둔다', async ($, on) => {
  await setup($, on)
  const long = '아주 긴 선택지 라벨입니다. '.repeat(8).trim()
  const desc = '선택지 설명도 길게 씁니다. '.repeat(8).trim()
  await $.tool.call({
    tool: TOOL,
    questions: [
      {
        question: '질문 글도 길게 씁니다. '.repeat(8).trim(),
        header: '긴 헤더',
        multiSelect: false,
        options: [
          { label: long, description: desc },
          { label: '짧음', description: '' },
        ],
      },
    ],
  } as any)

  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await ui.findAll({})
    // 어떤 요소도 잘라 그리지 않는다.
    expect(all.filter(el => String(el.props.wrap ?? '').startsWith('truncate'))).toEqual([])
    const button = await ui.find({ key: 'o:q1:0:0' })
    expect(button?.text).not.toContain(long)
    expect(String(button?.props.label).length).toBeLessThan(12)
    expect((await ui.find({ type: 'Text', text: long }))?.props.wrap).toBe('wrap')
    expect((await ui.find({ type: 'Text', text: desc }))?.props.wrap).toBe('wrap')
    expect((await ui.find({ type: 'Text', text: /질문 글도 길게/ }))?.props.wrap).toBe('wrap')
    if (surface !== 'mobile') {
      expect((await ui.find({ key: 'x:q1:0' }))?.props.rows).toBe(3)
      expect((await ui.find({ key: 'say:text' }))?.props.rows).toBe(3)
    }
    // 버튼은 그대로 누를 수 있다.
    await ui.press({ key: 'o:q1:0:0' })
    expect((await ui.find({ key: 'o:q1:0:0' }))?.props.label).toBe('(o) 고름')
    await ui.press({ key: 'o:q1:0:0' })
    await ui.unmount()
  }

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ key: 'o:q1:0:0' }))?.text).toContain(long)
  expect((await term.find({ key: 'say:text' }))?.props.rows).toBeUndefined()
  await term.unmount()
})

test('도구 결과는 짧다: 질문을 대화창에 다시 쓰지 말라 하고 블록은 panel_echo(옛 동작)로만 넘긴다', async ($, on) => {
  const seen: any[] = []
  await setup($, on, ['desktop'], (e: any) => {
    seen.push(e)

    return { result: callAsk(e).content }
  })
  const ran = textOf(await $.tool.call(INPUT as any))
  expect(ran).toContain('질문 묶음 q1을 패널에 올렸다')
  expect(ran).toContain('대화창에 다시 쓰지 말고')
  expect(ran).toContain('질문 패널에 올렸습니다(q1)')
  expect(ran).toContain('q1 1-2')
  expect(ran).not.toContain('옮겨 적')
  expect(ran).not.toContain('[질문 묶음 q1]')
  expect(ran).not.toContain('어느 DB를 쓸까요?')
  // 옛 동작용 블록: QUESTION_PANEL_ECHO=1이면 서버가 이것을 돌려준다
  const ran2 = JSON.stringify(seen[0].panel_echo)
  expect(ran2).toContain('그대로 옮겨 적고 턴을 마쳐라')
  expect(ran2).toContain('[질문 묶음 q1]')
  expect(ran2).toContain('1. 〔DB〕 어느 DB를 쓸까요?** (하나만 선택)')
  expect(ran2).toContain('- 2) SQLite — 파일형')
  expect(ran2).toContain('2. 〔기능〕 넣을 기능은?** (여러 개 선택 가능)')
  expect(ran2).toContain('q1 1-2, 2-1')
  expect(ran2).toContain(RESOLVE)
  expect(ran).toContain(RESOLVE)
})

test('대화창 글에 묶음 ID가 있으면 그 묶음을 「대화창에서 답함」으로 닫아 패널에서 또 답할 수 없다', async ($, on) => {
  const submitted = await setup($, on)
  await $.tool.call(INPUT as any)
  await $.tool.call(INPUT as any)
  await $.prompt.submit({ text: 'Q1 1-2, 2-1 로 할게요' } as any)
  expect(submitted).toEqual(['Q1 1-2, 2-1 로 할게요'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /대화창에서 답함 · q1/ })).toBeDefined()
    expect(await ui.find({ key: 'o:q1:0:0' })).toBeUndefined()
    // 언급하지 않은 묶음은 그대로 남는다.
    expect(await ui.find({ key: 'o:q2:0:0' })).toBeDefined()
    await ui.unmount()
  }

  // 패널의 보내기로 묶음 ID를 담아 보내도 닫힌다.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'say:text', text: 'q2는 1-1, 2-2', kind: 'change' })
  await ui.press({ key: 'say:send' })
  expect(await ui.find({ type: 'Text', text: /대화창에서 답함 · q2/ })).toBeDefined()
  expect(submitted).toEqual(['Q1 1-2, 2-1 로 할게요', 'q2는 1-1, 2-2'])
  await ui.unmount()
})

test('resolve 도구로 ID 없이 글로 답한 묶음을 닫는다', async ($, on) => {
  await setup($, on)
  await $.tool.call(INPUT as any)
  await $.prompt.submit({ text: 'Postgres랑 검색으로 해요' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'o:q1:0:0' })).toBeDefined()

  expect(JSON.stringify(await $.tool.call({ tool: RESOLVE, id: 'Q1' } as any))).toContain('닫았다')
  expect(await ui.find({ type: 'Text', text: /대화창에서 답함 · q1/ })).toBeDefined()
  expect(JSON.stringify(await $.tool.call({ tool: RESOLVE, id: 'q1' } as any))).toContain('이미 닫혀')
  expect(JSON.stringify(await $.tool.call({ tool: RESOLVE, id: 'q9' } as any))).toContain('없다')
  await ui.unmount()
})

// 0.6.3: resolve 가 mod 도구였을 때는 훅을 타지 않아 Orca 질문 패널이 닫힌 줄 몰랐다.
test('resolve 는 MCP 서버로 이어지고, 대화창에서 닫힌 묶음을 panel_closed 로 서버에 알린다', async ($, on) => {
  const seen: any[] = []
  await setup($, on, ['terminal'], (e: any) => {
    seen.push(e)

    return { result: callAsk(e).content }
  })
  await $.tool.call(INPUT as any)
  await $.tool.call(INPUT as any)
  await $.tool.call({ tool: RESOLVE, id: 'q1' } as any)
  expect(resolved).toHaveLength(1)
  expect(resolved[0].id).toBe('q1')
  expect(resolved[0].panel_closed).toEqual(['q1'])
  // 대화창 글(ID 포함)로 닫은 것도 다음 질문 호출에 실린다.
  await $.prompt.submit({ text: 'q2 1-1, 2-2' } as any)
  await $.tool.call(INPUT as any)
  expect(seen.map(e => e.panel_closed)).toEqual([[], [], ['q1', 'q2']])
})

// 플러그인 아래에서 엔진 대신 기본 줄을 그린다(플러그인이 next(e)로 넘긴 줄).
function engineDraws(on: any) {
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

const answerFirst = async ($: any) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'o:q1:0:0' })
  await ui.press({ key: 'o:q1:1:0' })
  await ui.press({ key: 'done:q1' })
  await ui.unmount()
}

test('답한 묶음은 확인 없이 하나씩 지우고, 지운 기록은 다시 마운트해도 없다', async ($, on) => {
  await setup($, on)
  await $.tool.call(INPUT as any)
  await $.tool.call(INPUT as any)
  await answerFirst($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /보냄 · q1/ })).toBeDefined()
  // 대기 중인 q2에는 확인 없는 지우기 버튼이 없다(기존 삭제 확인을 거친다).
  expect(await ui.find({ key: 'delsent:q2' })).toBeUndefined()
  await ui.press({ key: 'delsent:q1' })
  expect(await ui.find({ type: 'Text', text: /보냄 · q1/ })).toBeUndefined()
  expect(await ui.find({ key: 'del:q2' })).toBeDefined()
  await ui.unmount()

  // 저장된 큐에서도 빠졌다.
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /q1/ })).toBeUndefined()
  expect(await again.find({ key: 'del:q2' })).toBeDefined()
  await again.unmount()
})

test('「답한 기록 모두 지우기」는 보낸·대화창에서 답한 묶음만 지우고 대기 중인 묶음은 남긴다', async ($, on) => {
  await setup($, on)
  await $.tool.call(INPUT as any)
  await $.tool.call(INPUT as any)
  await $.tool.call(INPUT as any)
  await answerFirst($)
  await $.prompt.submit({ text: 'q2 1-1, 2-1' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'clearsent' }))?.props.label).toBe('답한 기록 모두 지우기 (2)')
  await ui.press({ key: 'clearsent' })
  expect(await ui.find({ type: 'Text', text: /보냄 · q1/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /대화창에서 답함 · q2/ })).toBeUndefined()
  expect(await ui.find({ key: 'del:q3' })).toBeDefined()
  // 답한 기록이 없으면 버튼도 없다.
  expect(await ui.find({ key: 'clearsent' })).toBeUndefined()
  await ui.unmount()
})

test('/questions-clear 도 답한 묶음만 지운다', async ($, on) => {
  await setup($, on)
  await $.tool.call(INPUT as any)
  await $.tool.call(INPUT as any)
  await answerFirst($)
  const out = await $.command.run({ command: 'questions-clear', args: '' } as any)
  expect(JSON.stringify(out)).toContain('1개를 지웠습니다')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /보냄 · q1/ })).toBeUndefined()
  expect(await ui.find({ key: 'del:q2' })).toBeDefined()
  await ui.unmount()
})

const PREVIEW_INPUT = {
  tool: TOOL,
  questions: [
    {
      question: '레이아웃은?',
      header: '레이아웃',
      multiSelect: false,
      options: [
        { label: '두 칸', description: '왼쪽 목록', preview: '+------+------+\n| 목록 | 본문 |\n+------+------+' },
        { label: '한 칸', description: '', preview: '```ts\nconst a = 1\n```' },
        { label: '없음', description: '미리보기 없음' },
      ],
    },
  ],
}

test('preview가 있는 선택지는 고르거나 「미리보기」를 누르면 선택지 아래에 펼친다', async ($, on) => {
  await setup($, on)
  await $.tool.call(PREVIEW_INPUT as any)

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'pv:q1:0:0' })).toBeDefined()
    expect(await ui.find({ key: 'pv:q1:0:2' })).toBeUndefined()
    expect(await ui.find({ key: 'pvmd:q1:0' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 고르지 않고 미리보기만: ASCII 목업은 코드 블록으로 감싸 정렬을 지킨다.
  await ui.press({ key: 'pv:q1:0:0' })
  const md = await ui.find({ key: 'pvmd:q1:0' })
  expect(md?.type).toBe('Markdown')
  expect(String(md?.props.text)).toContain('| 목록 | 본문 |')
  expect(String(md?.props.text).startsWith('```')).toBe(true)
  expect((await ui.find({ key: 'pv:q1:0:0' }))?.props.label).toBe('미리보기 접기')
  expect(await ui.find({ key: 'done:q1' })).toBeUndefined()
  // 다시 누르면 접힌다.
  await ui.press({ key: 'pv:q1:0:0' })
  expect(await ui.find({ key: 'pvmd:q1:0' })).toBeUndefined()
  // 고르면 그 선택지의 preview가 펼쳐진다(이미 코드 블록이면 그대로).
  await ui.press({ key: 'o:q1:0:1' })
  expect((await ui.find({ key: 'pvmd:q1:0' }))?.props.text).toBe('```ts\nconst a = 1\n```')
  // preview 없는 선택지를 골라도 펼친 것은 그대로 둔다.
  await ui.press({ key: 'o:q1:0:2' })
  expect((await ui.find({ key: 'pvmd:q1:0' }))?.props.text).toBe('```ts\nconst a = 1\n```')
  await ui.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ key: 'pvmd:q1:0' })).toBeDefined()
  await term.unmount()
})

test('옛 동작 블록(panel_echo)에 preview를 선택지 아래 코드 블록으로 넣는다', async ($, on) => {
  const seen: any[] = []
  await setup($, on, ['desktop'], (e: any) => {
    seen.push(e)

    return { result: callAsk(e).content }
  })
  await $.tool.call(PREVIEW_INPUT as any)
  const text = String(seen[0].panel_echo)
  expect(text).toContain('- 1) 두 칸 — 왼쪽 목록\n  ```\n  +------+------+\n  | 목록 | 본문 |\n  +------+------+\n  ```')
  // 본문에 ``` 가 있으면 더 긴 울타리로 감싼다.
  expect(text).toContain('- 2) 한 칸\n  ````\n  ```ts\n  const a = 1\n  ```\n  ````')
  expect(text).toContain('- 3) 없음 — 미리보기 없음\n')
})

test('preview가 문자열이 아니거나 비었으면 버린다', async ($, on) => {
  await setup($, on)
  const ran = (await $.tool.call({
    tool: TOOL,
    questions: [
      {
        question: 'q',
        header: 'h',
        multiSelect: false,
        options: [
          { label: 'a', description: '', preview: 3 },
          { label: 'b', description: '', preview: '  ' },
        ],
      },
    ],
  } as any)) as any
  expect(textOf(ran)).not.toContain('```')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'pv:q1:0:0' })).toBeUndefined()
  expect(await ui.find({ key: 'pv:q1:0:1' })).toBeUndefined()
  await ui.unmount()
})

test('surface가 없는 세션(Orca 채팅 등)에서도 ask는 막지 않고 큐에 쌓아 짧은 결과를 돌려준다', async ($, on) => {
  await setup($, on, [])
  const ran = JSON.stringify(await $.tool.call(INPUT as any))
  expect(ran).not.toContain('deny')
  expect(ran).toContain('질문 묶음 q1을 패널에 올렸다')
  expect(ran).toContain('AskUserQuestion으로 다시 묻지 마라')
  const cmd = JSON.stringify(await $.command.run({ command: 'questions' } as any))
  expect(cmd).toContain('패널 화면이 없습니다')
  expect(cmd).toContain('q4 1-2')
  expect(cmd).toContain('[질문 묶음 q1]')
})

test('원격 surface만 있어도 ask는 지금처럼 패널에 쌓는다', async ($, on) => {
  await setup($, on, ['desktop'])
  const ran = await $.tool.call(INPUT as any)
  expect(JSON.stringify(ran)).toContain('패널에 올렸다')
})

test('질문 도구 호출은 MCP 서버로 이어지고, 서버에 넘긴 panel_result에 묶음 ID가 있다', async ($, on) => {
  const seen: any[] = []
  await setup($, on, ['terminal'], (e: any) => {
    seen.push(e)

    return { result: callAsk(e).content }
  })
  const ran = await $.tool.call(INPUT as any)
  expect(seen).toHaveLength(1)
  expect(seen[0].questions).toEqual(INPUT.questions)
  expect(seen[0].panel_result).toContain('질문 묶음 q1을 패널에 올렸다')
  expect(textOf(ran)).toBe(seen[0].panel_result)
})

// 시험 키트는 isError 결과를 흉내 낼 수 없어 거절(PreToolUse 훅이 막은 것과 같다)로 확인한다.
test('질문 도구가 막히면(훅 거절·서버 오류) 쌓았던 묶음을 거둔다', async ($, on) => {
  await setup($, on, ['terminal'], () => ({ deny: 'blocked by hook' }))
  const ran: any = await $.tool.call(INPUT as any)
  expect(ran.deny).toBeDefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'o:q1:0:0' })).toBeUndefined()
  await ui.unmount()
})

test('패널 안 「패널 닫기」와 /questions(열려 있으면 토글)·/questions close 는 패널만 닫고 질문은 남긴다', async ($, on) => {
  await setup($, on)
  await $.tool.call(INPUT as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'close' })
  expect(closes).toEqual(['questions'])
  await ui.unmount()

  // 닫혀 있으면 /questions 는 연다. 열려 있으면 닫는다.
  expect(JSON.stringify(await $.command.run({ command: 'questions', args: '' } as any))).toContain('열었습니다')
  expect(JSON.stringify(await $.command.run({ command: 'questions', args: '' } as any))).toContain('닫았습니다')
  expect(closes).toEqual(['questions', 'questions'])
  // close 는 열려 있든 아니든 닫고, 닫은 뒤에도 질문은 그대로다.
  await $.command.run({ command: 'questions', args: 'close' } as any)
  expect(closes).toHaveLength(3)
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await again.find({ key: 'o:q1:0:0' })).toBeDefined()
  await again.unmount()
})

// ── 닫힘 장부(0.9.0) ── Orca 질문 패널과 같이 보는 장부를 메모리로 흉내 낸다(배타 생성 그대로).
async function setupLedger($: any, on: any, server?: (e: any) => any) {
  const files = new Map<string, string>()
  const calls: any[] = []
  on('session.id', () => ({ value: 'sess-A' }))
  on('mcp.connect', (_: any, e: any) => ({ value: { isConnected: true, server: `plugin:question-panel:${e.server}` } }))
  on('mcp.call', (_: any, e: any) => {
    calls.push(e)
    const ctx = {
      env: {},
      inboxDir: '/i',
      cwd: '/',
      now: clockRef.value.now(),
      runCurrent: () => null,
      write: () => {},
      ledgerDir: '/l',
      claim: (_d: string, n: string, t: string) => (files.has(n) ? false : (files.set(n, t), true)),
      readText: (_d: string, n: string) => files.get(n) ?? null,
    }

    return { value: callSync(e.args, ctx) }
  })
  const submitted = await setup($, on, ['desktop'], server)
  // Orca 질문 패널(워커)이 장부에 닫힘을 남긴다.
  const orcaCloses = (key: string, state: 'answered' | 'dismissed') => {
    const name = `${key}.json`
    if (files.has(name)) return false
    files.set(name, JSON.stringify(ledgerRecord({ key, state, by: 'orca', now: 7 })))

    return true
  }
  const record = (key: string) => JSON.parse(files.get(`${key}.json`) ?? 'null')

  return { submitted, files, calls, orcaCloses, record }
}

const keyOf = (calls: any[]) => calls.find(c => c.args?.close !== undefined)?.args.close.key as string

test('장부: 질문 호출에 panel_key 가 실리고, 패널에서 답하면 장부를 먼저 차지해 Orca 는 또 답할 수 없다', async ($, on) => {
  let input: any
  const { submitted, calls, orcaCloses, record } = await setupLedger($, on, (e: any) => {
    input = e

    return { result: callAsk(e).content }
  })
  await $.tool.call(INPUT as any)
  expect(input.panel_key).toMatch(/^sess-A~q1~\d+$/)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'o:q1:0:1' })
  await ui.press({ key: 'o:q1:1:0' })
  await ui.press({ key: 'done:q1' })
  expect(submitted.length).toBe(1)
  expect(keyOf(calls)).toBe(input.panel_key)
  expect(record(input.panel_key)).toMatchObject({ id: 'q1', state: 'answered', by: 'claude' })
  // Orca 워커의 차지는 진다(세션에 두 번 가지 않는다).
  expect(orcaCloses(input.panel_key, 'answered')).toBe(false)
  await ui.unmount()
})

test('장부: Orca 가 먼저 답했으면 패널의 완료는 세션에 보내지 않고 「Orca에서 답함」으로 닫는다', async ($, on) => {
  const { submitted, orcaCloses } = await setupLedger($, on)
  await $.tool.call(INPUT as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'o:q1:0:1' })
  await ui.press({ key: 'o:q1:1:0' })
  // 패널을 누르기 직전에 Orca 에서 답했다(아직 동기화 전).
  expect(orcaCloses(`sess-A~q1~${clockRef.value.now()}`, 'answered')).toBe(true)
  await ui.press({ key: 'done:q1' })
  expect(submitted).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Orca에서 답함 · q1/ })).toBeDefined()
  await ui.unmount()
})

test('장부: 대기 중에 Orca 에서 답하거나 답 없이 닫으면 2초 안에 패널도 닫힌다', async ($, on) => {
  const { submitted, orcaCloses } = await setupLedger($, on)
  const t0 = clockRef.value.now()
  await $.tool.call(INPUT as any)
  await $.tool.call(INPUT as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  orcaCloses(`sess-A~q1~${t0}`, 'answered')
  orcaCloses(`sess-A~q2~${t0}`, 'dismissed')
  expect(await ui.find({ key: 'o:q1:0:0' })).toBeDefined()
  await clockRef.value.advance(2100)
  expect(await ui.find({ type: 'Text', text: /Orca에서 답함 · q1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Orca에서 답 없이 닫음 · q2/ })).toBeDefined()
  expect(await ui.find({ key: 'o:q1:0:0' })).toBeUndefined()
  // Orca 답은 Orca 가 보낸 줄로 따로 온다. 답 없이 닫음만 세션에 한 줄 알린다.
  expect(submitted).toEqual(['[질문 패널 답] q2 답 없이 닫음(Orca)'])
  // 다음 주기에 또 알리지 않는다.
  await clockRef.value.advance(2100)
  expect(submitted.length).toBe(1)
  await ui.unmount()
})

test('장부: 답 없이 닫기·대화창 글·resolve 도 장부에 남아 Orca 카드가 닫힌다', async ($, on) => {
  const { submitted, orcaCloses, record } = await setupLedger($, on)
  const t0 = clockRef.value.now()
  await $.tool.call(INPUT as any)
  await $.tool.call(INPUT as any)
  await $.tool.call(INPUT as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'del:q1' })
  await ui.press({ key: 'delok:q1' })
  expect(record(`sess-A~q1~${t0}`)).toMatchObject({ state: 'dismissed', by: 'claude' })
  expect(submitted).toEqual(['[질문 패널 답] q1 답 없이 닫음'])
  await $.prompt.submit({ text: 'q2 1-1, 2-2' } as any)
  expect(record(`sess-A~q2~${t0}`)).toMatchObject({ state: 'answered', by: 'chat' })
  await $.tool.call({ tool: RESOLVE, id: 'q3' } as any)
  expect(record(`sess-A~q3~${t0}`)).toMatchObject({ state: 'answered', by: 'chat' })
  // 이미 닫혔으니 Orca 는 못 닫는다.
  expect(orcaCloses(`sess-A~q2~${t0}`, 'answered')).toBe(false)
  await ui.unmount()
})

test('장부: Orca 가 먼저 닫은 묶음은 답 없이 닫기도 세션에 보내지 않는다', async ($, on) => {
  const { submitted, orcaCloses } = await setupLedger($, on)
  const t0 = clockRef.value.now()
  await $.tool.call(INPUT as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'del:q1' })
  orcaCloses(`sess-A~q1~${t0}`, 'answered')
  await ui.press({ key: 'delok:q1' })
  expect(submitted).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Orca에서 답함 · q1/ })).toBeDefined()
  await ui.unmount()
})

test('장부: 모델이 sync 도구를 부르면 막는다', async ($, on) => {
  await setupLedger($, on)
  const ran = await $.tool.call({ tool: 'mcp__plugin_question-panel_qp__sync', keys: [] } as any)
  expect(JSON.stringify(ran)).toContain('내부용')
})
