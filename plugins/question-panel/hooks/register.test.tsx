import { expect, mock, test } from 'claude-code/testing'

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

const TOOL = 'mcp__question-panel__ask'

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

async function setup($: any, on: any) {
  mock.clock(on)
  const submitted: string[] = []
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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

test('삭제는 확인을 거치고, 취소하면 남고, 확인하면 답 없이 사라진다', async ($, on) => {
  const submitted = await setup($, on)
  await $.tool.call(INPUT as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // 답을 하나도 고르지 않아도 삭제를 누를 수 있다.
  await ui.press({ key: 'del:q1' })
  expect(await ui.find({ type: 'Text', text: /이 질문을 지울까요/ })).toBeDefined()
  expect(await ui.find({ key: 'delok:q1' })).toBeDefined()

  await ui.press({ key: 'delno:q1' })
  expect(await ui.find({ type: 'Text', text: /이 질문을 지울까요/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /어느 DB를 쓸까요/ })).toBeDefined()

  await ui.press({ key: 'del:q1' })
  await ui.press({ key: 'delok:q1' })
  expect(await ui.find({ type: 'Text', text: /어느 DB를 쓸까요/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /쌓인 질문이 없습니다/ })).toBeDefined()
  expect(submitted).toEqual([])
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

// 플러그인 아래에서 엔진 대신 기본 줄을 그린다(플러그인이 next(e)로 넘긴 줄).
function engineDraws(on: any) {
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}
