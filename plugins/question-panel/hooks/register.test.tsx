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

test('도구 결과에 대화창에 옮겨 적을 마크다운 블록(묶음 ID·번호·선택 방식·글로 답하는 법)이 있다', async ($, on) => {
  await setup($, on)
  const ran = JSON.stringify(await $.tool.call(INPUT as any))
  expect(ran).toContain('그대로 옮겨 적고 턴을 마쳐라')
  expect(ran).toContain('[질문 묶음 q1]')
  expect(ran).toContain('1. 〔DB〕 어느 DB를 쓸까요?** (하나만 선택)')
  expect(ran).toContain('- 2) SQLite — 파일형')
  expect(ran).toContain('2. 〔기능〕 넣을 기능은?** (여러 개 선택 가능)')
  expect(ran).toContain('q1 1-2, 2-1')
  expect(ran).toContain('mcp__question-panel__resolve')
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

  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__question-panel__resolve', id: 'q1' } as any))).toContain('닫았다')
  expect(await ui.find({ type: 'Text', text: /대화창에서 답함 · q1/ })).toBeDefined()
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__question-panel__resolve', id: 'q1' } as any))).toContain('이미 닫혀')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__question-panel__resolve', id: 'q9' } as any))).toContain('없다')
  await ui.unmount()
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
  await $.prompt.submit({ text: 'q2 1-1, 2-1' })

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

test('도구 결과 블록에 preview를 선택지 아래 코드 블록으로 넣는다', async ($, on) => {
  await setup($, on)
  const ran = (await $.tool.call(PREVIEW_INPUT as any)) as any
  const text = String(ran.result ?? JSON.stringify(ran))
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
  expect(String(ran.result ?? JSON.stringify(ran))).not.toContain('```')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'pv:q1:0:0' })).toBeUndefined()
  expect(await ui.find({ key: 'pv:q1:0:1' })).toBeUndefined()
  await ui.unmount()
})
