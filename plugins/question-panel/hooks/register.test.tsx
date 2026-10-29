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
