import { expect, mock, test } from 'claude-code/testing'

import { callAsk, callResolve, callSync, ledgerRecord } from '../mcp/ask.mjs'

const PANE = {
  plugin: 'switchboard',
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

const TOOL = 'mcp__plugin_switchboard_qp__ask'

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

const RESOLVE = 'mcp__plugin_switchboard_qp__resolve'
// MCP 서버로 이어진 resolve 호출(입력)들. setup 마다 비운다.
const resolved: any[] = []
// 패널이 열려 있나, 닫기 호출 기록(setup 마다 비운다).
const paneUp = { value: false }
const closes: string[] = []
// 패널이 자리를 잡았나·ui.open 기록·/questions 실행 중인가(좁은 터미널 시험, #136).
const paneSeated = { value: false }
const paneOpens: string[] = []
const commandRunning = { value: false }
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
  placed = true,
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
  paneOpens.length = 0
  on('ui.open', (_: any, e: any) => {
    paneUp.value = true
    paneOpens.push(e.id)
    // 좁은 터미널 흉내(#136): 묻지 않고 연 pane 은 기다리고, 사람이 /questions 로 열면 폭과 상관없이 자리를 잡는다.
    paneSeated.value = placed || e.origin?.kind === 'person' || commandRunning.value

    return { value: paneSeated.value ? { isPlaced: true } : { isPlaced: false, reason: 'unasked below 144 columns (now 120)' } }
  })
  on('ui.panes', () => ({ value: paneUp.value ? [{ id: 'questions', title: '질문', isPlaced: paneSeated.value }] : [] }))
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

test('ui.open이 isPlaced:false여도 질문 올릴 때 ui.log 없음', async ($, on) => {
  const logs: string[] = []
  on('ui.log', (_: any, e: any) => {
    logs.push(JSON.stringify(e))

    return { value: undefined }
  })
  await setup($, on, ['desktop'], undefined, false)
  const ran = await $.tool.call(INPUT as any)
  expect(JSON.stringify(ran)).toContain('패널에 올렸다')
  await Promise.resolve()
  await Promise.resolve()
  expect(logs.filter(l => l.includes('자리'))).toEqual([])
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
    plugin: 'switchboard',
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
    plugin: 'switchboard',
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
  on('mcp.connect', (_: any, e: any) => ({ value: { isConnected: true, server: `plugin:switchboard:${e.server}` } }))
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
  const ran = await $.tool.call({ tool: 'mcp__plugin_switchboard_qp__sync', keys: [] } as any)
  expect(JSON.stringify(ran)).toContain('내부용')
})

// AskUserQuestion 가드(#109): 질문 패널(qp)이 붙은 세션이면 막고 패널로 돌린다.
const ASK_INPUT = {
  tool: 'AskUserQuestion',
  questions: [{ question: '어느 DB를 쓸까요?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
}

async function setupAskGuard($: any, on: any, opts: { qp?: boolean; allow?: string } = {}) {
  const passed: any[] = []
  on('env.get', (_: any, e: any) => ({ value: e.name === 'SWITCHBOARD_ALLOW_ASK_USER_QUESTION' ? opts.allow : undefined }))
  on('mcp.connect', (_: any, e: any) => ({
    value: opts.qp === false
      ? { isConnected: false, reason: 'disabled', message: 'off' }
      : { isConnected: true, server: `plugin:switchboard:${e.server}` },
  }))
  // 내장 도구 자리: 통과하면 여기까지 온다.
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    passed.push(e)

    return { result: [{ type: 'text', text: 'answered' }] }
  })
  await setup($, on)

  return passed
}

test('AskUserQuestion: qp가 붙은 세션이면 막고 질문 패널 도구로 안내한다', async ($, on) => {
  const passed = await setupAskGuard($, on)
  const ran: any = await $.tool.call(ASK_INPUT as any)
  expect(passed.length).toBe(0)
  expect(String(ran.deny)).toContain('mcp__plugin_switchboard_qp__ask')
  expect(String(ran.deny)).toContain('급함')
})

test('AskUserQuestion: header가 「급함」으로 시작하는 질문이 하나라도 있으면 통과', async ($, on) => {
  const passed = await setupAskGuard($, on)
  const urgent = { ...ASK_INPUT, questions: [...ASK_INPUT.questions, { ...ASK_INPUT.questions[0], header: '급함: 배포' }] }
  const ran: any = await $.tool.call(urgent as any)
  expect(ran.deny).toBeUndefined()
  expect(passed.length).toBe(1)
})

test('AskUserQuestion: qp 서버가 안 붙은 세션이면 통과', async ($, on) => {
  const passed = await setupAskGuard($, on, { qp: false })
  const ran: any = await $.tool.call(ASK_INPUT as any)
  expect(ran.deny).toBeUndefined()
  expect(passed.length).toBe(1)
})

test('AskUserQuestion: SWITCHBOARD_ALLOW_ASK_USER_QUESTION=1 이면 통과', async ($, on) => {
  const passed = await setupAskGuard($, on, { allow: '1' })
  const ran: any = await $.tool.call(ASK_INPUT as any)
  expect(ran.deny).toBeUndefined()
  expect(passed.length).toBe(1)
})

// 원격 질문(#111): 프로필이 있는 세션의 ask 는 서버 질문으로, resolve 는 거두기로. 서버는 http.fetch 자리에서 흉내 낸다.
const RID = `q_${'c'.repeat(32)}`

const forwarded: any[] = []
async function setupRemote($: any, on: any, ask: { status: number; text: string } | 'down') {
  const hits: { url: string; method: string }[] = []
  on('env.get', (_: any, e: any) => ({ value: ({ SWITCHBOARD_PROFILE: 'sbtest', SWITCHBOARD_CONFIG_DIR: '/cfg' } as Record<string, string>)[e.name] }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path === '/cfg/sbtest.json' }))
  on('fs.read', (_: any, e: any) => ({ value: e.path === '/cfg/sbtest.json' ? JSON.stringify({ endpoint: 'http://mail.test', role: 'team/worker', token: 'tok' }) : '' }))
  on('http.fetch', (_: any, e: any) => {
    const url = String(e.url)
    const method = e.init?.method ?? 'GET'
    hits.push({ url, method })
    const reply = (status: number, body: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
    if (url.includes('/api/slots/register')) return reply(200, { role: 'team/worker-1', base: 'team/worker', number: 1, other_active: 0, reclaimed: false })
    if (url.includes('/api/slots/')) return reply(200, {})
    if (url.includes('/api/events/poll')) return reply(200, { events: [], cursor: 0 })
    if (url === 'http://mail.test/api/questions' && method === 'POST') {
      if (ask === 'down') throw new Error('connect ECONNREFUSED')

      return { value: { status: ask.status, ok: ask.status < 300, headers: {}, text: ask.text } }
    }
    if (url === `http://mail.test/api/questions/${RID}/withdraw`) return reply(200, { id: RID, status: 'withdrawn', asker: 'team/worker-1', questions: [] })

    return reply(404, { error: 'not found' })
  })
  const submitted = await setup($, on, ['desktop'], (e: any) => {
    forwarded.push(e)

    return { result: callAsk(e).content }
  })

  return { hits, submitted }
}

const VIEW = JSON.stringify({ id: RID, asker: 'team/worker-1', created_at: '', status: 'pending', questions: [], answers: null, answered_by: '', answered_at: null, withdrawn_at: null, seq: 1, can_answer: false })

test('원격 질문: 프로필이 있으면 서버 질문으로 올리고 로컬 패널에는 쌓지 않는다', async ($, on) => {
  const { hits } = await setupRemote($, on, { status: 201, text: VIEW })
  const ran = await $.tool.call(INPUT as any)
  const text = textOf(ran)
  expect(text).toContain(`원격 질문 ${RID} 로 올렸다`)
  expect(text).not.toMatch(/질문 묶음 q\d/)
  // Orca 훅이 터미널 카드를 따로 만들지 않게 서버 id 를 입력에 싣는다(#142). 로컬 묶음 key 는 없다.
  const fwd = forwarded.at(-1)
  expect(fwd.panel_remote).toBe(RID)
  expect(fwd.panel_key).toBeUndefined()
  expect(hits.some(h => h.method === 'POST' && h.url === 'http://mail.test/api/questions')).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  expect(await ui.find({ type: 'Text', text: /어느 DB를 쓸까요/ })).toBeUndefined()
  await ui.unmount()
})

test('원격 질문: 403 can_ask_off + ask_via 면 로컬로 돌리지 않고 「답 메일을 기다려라」(설정 줄·주소를 싣는다)', async ($, on) => {
  await setupRemote($, on, { status: 403, text: JSON.stringify({ error: 'can_ask is off', code: 'can_ask_off', ask_via: '<역할>', settings_target: '<설정 줄>' }) })
  const ran = await $.tool.call(INPUT as any)
  expect(String(ran.deny)).toContain('질문이 거절됐다(설정 <설정 줄>)')
  expect(String(ran.deny)).toContain('<역할> 에 질문이 전달됐다 — 답 메일을 기다려라')
  expect(String(ran.deny)).toContain('대화창에 선택지를 쓰지 마라')
  expect(String(ran.deny)).not.toContain('질문 묶음')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  expect(await ui.find({ type: 'Text', text: /어느 DB를 쓸까요/ })).toBeUndefined()
  await ui.unmount()
})

test('원격 질문: 403 can_ask_off 인데 ask_via 가 없으면 「올릴 곳이 없다 — 멈추고 보고」', async ($, on) => {
  await setupRemote($, on, { status: 403, text: JSON.stringify({ error: 'x', code: 'can_ask_off', settings_target: 'none' }) })
  const ran = await $.tool.call(INPUT as any)
  expect(String(ran.deny)).toContain('질문을 올릴 곳이 없다(설정 none) — 막힌 채 멈추고 보고하라')
})

test('원격 질문: 403 question_forbidden 은 전달 안내 없이 멈추고 보고', async ($, on) => {
  await setupRemote($, on, { status: 403, text: JSON.stringify({ error: 'x', code: 'question_forbidden' }) })
  const ran = await $.tool.call(INPUT as any)
  expect(String(ran.deny)).toContain('질문이 거절됐다')
  expect(String(ran.deny)).toContain('보고하라')
  expect(String(ran.deny)).not.toContain('답 메일을 기다려라')
})

test('원격 질문: 옛 평문 403 도 깨지지 않고 거절(올릴 곳 없음, 로컬 묶음 없음)', async ($, on) => {
  await setupRemote($, on, { status: 403, text: 'forbidden' })
  const ran = await $.tool.call(INPUT as any)
  expect(String(ran.deny)).toContain('질문을 올릴 곳이 없다')
  expect(String(ran.deny)).not.toContain('질문 묶음')
})

test('거절된 뒤 AskUserQuestion 은 여전히 막히고 안내가 「답 메일을 기다려라」다(질문 도구로 다시 올리라고 하지 않는다)', async ($, on) => {
  on('mcp.connect', (_: any, e: any) => ({ value: { isConnected: true, server: `plugin:switchboard:${e.server}` } }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: [{ type: 'text', text: 'answered' }] }))
  await setupRemote($, on, { status: 403, text: JSON.stringify({ code: 'can_ask_off', ask_via: '<역할>', settings_target: '<설정 줄>' }) })
  await $.tool.call(INPUT as any)
  const ran: any = await $.tool.call({ tool: 'AskUserQuestion', questions: INPUT.questions } as any)
  expect(String(ran.deny)).toContain('답 메일을 기다려라')
  expect(String(ran.deny)).not.toContain('같은 질문을 올려라')
})

test('원격 질문: relay_to 를 줬는데 로컬 패널로 떨어지면 「중계되지 않음」 줄이 붙는다', async ($, on) => {
  await setupRemote($, on, 'down')
  const text = textOf(await $.tool.call({ ...INPUT, relay_to: ['team/coordinator'] } as any))
  expect(text).toContain('중계되지 않음')
  expect(text).toContain('질문 묶음 q1')
})

test('원격 질문: relay_to 가 없으면 로컬로 떨어져도 「중계되지 않음」이 없다', async ($, on) => {
  await setupRemote($, on, 'down')
  expect(textOf(await $.tool.call(INPUT as any))).not.toContain('중계되지 않음')
})

test('원격 질문: 서버에 닿지 않으면 로컬 패널로(글 첫머리가 「원격에 올리지 못했다」)', async ($, on) => {
  await setupRemote($, on, 'down')
  const text = textOf(await $.tool.call(INPUT as any))
  expect(text.startsWith('원격에 올리지 못했다')).toBe(true)
  expect(text).toContain('로컬 패널에 올렸다(서버에 닿지 않음)')
  expect(text).toContain('질문 묶음 q1')
})

test('원격 질문: resolve 에 서버 id 를 주면 거두기(withdraw)를 부른다', async ($, on) => {
  const { hits } = await setupRemote($, on, { status: 201, text: VIEW })
  const ran = await $.tool.call({ tool: RESOLVE, id: RID } as any)
  expect(hits.some(h => h.method === 'POST' && h.url === `http://mail.test/api/questions/${RID}/withdraw`)).toBe(true)
  expect(textOf(ran)).toContain(`원격 질문 ${RID}을 거뒀다`)
})

// 원격 질문 대장 쪽(#112): 대장 역할 세션은 서버 질문을 끌어와 이 패널에 올리고, 패널 답은 서버로 보낸다(세션 턴 아님).
const BID = `q_${'d'.repeat(32)}`

async function setupBoss($: any, on: any, bosses: string) {
  const hits: { url: string; method: string; body?: string }[] = []
  on('env.get', (_: any, e: any) => ({
    value: ({ SWITCHBOARD_PROFILE: 'sbboss', SWITCHBOARD_CONFIG_DIR: '/cfg', SWITCHBOARD_BOSS_ROLES: bosses } as Record<string, string>)[e.name],
  }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path === '/cfg/sbboss.json' }))
  on('fs.read', (_: any, e: any) => ({ value: e.path === '/cfg/sbboss.json' ? JSON.stringify({ endpoint: 'http://mail.test', role: 'team/lead', token: 'tok' }) : '' }))
  const view = (status: string) => ({
    id: BID,
    asker: 'team/worker-2',
    created_at: '',
    status,
    questions: [{ header: 'DB', question: '원격으로 물은 DB?', options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }], multiSelect: false }],
    answers: null,
    answered_by: '',
    answered_at: null,
    withdrawn_at: null,
    seq: 3,
    can_answer: status === 'pending',
  })
  on('http.fetch', (_: any, e: any) => {
    const url = String(e.url)
    const method = e.init?.method ?? 'GET'
    hits.push({ url, method, ...(typeof e.init?.body === 'string' ? { body: e.init.body } : {}) })
    const reply = (status: number, body: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
    if (url.includes('/api/slots/register')) return reply(200, { role: 'team/lead-1', base: 'team/lead', number: 1, other_active: 0, reclaimed: false })
    if (url.includes('/api/slots/')) return reply(200, {})
    if (url.includes('/api/events/poll')) return reply(200, { events: [], cursor: 0 })
    if (url === 'http://mail.test/api/questions?status=pending') return reply(200, { questions: [view('pending')] })
    if (url === 'http://mail.test/api/questions?limit=1') return reply(200, { questions: [view('pending')] })
    // 긴 대기는 이 시험에서 실패로 돌려 루프가 쉬게 한다.
    if (url.startsWith('http://mail.test/api/questions/poll')) return reply(503, { error: 'busy' })
    if (url === `http://mail.test/api/questions/${BID}/answer` && method === 'POST') return reply(200, { ...view('answered'), answered_by: 'team/lead-1' })

    return reply(404, { error: 'not found' })
  })
  const submitted = await setup($, on)

  return { hits, submitted }
}

// mod 타입 환경에는 DOM·node 전역 타입이 없다.
const nap = (ms: number) =>
  new Promise<void>(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(r, ms))

const until = async (ok: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return true
    await nap(5)
  }

  return false
}

test('원격 질문 대장: 서버 질문이 패널에 묻는 역할과 함께 뜨고, 답은 서버로 가며 세션에는 넣지 않는다', async ($, on) => {
  const { hits, submitted } = await setupBoss($, on, 'team/lead')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  expect(await until(async () => (await ui.find({ type: 'Text', text: /원격으로 물은 DB/ })) !== undefined)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /묻는 역할 team\/worker-2/ })).toBeDefined()
  await ui.press({ key: 'o:q1:0:1' })
  await ui.press({ key: 'done:q1' })
  expect(await until(() => hits.some(h => h.method === 'POST' && h.url.endsWith(`/${BID}/answer`)))).toBe(true)
  const post = hits.find(h => h.method === 'POST' && h.url.endsWith(`/${BID}/answer`))!
  expect(JSON.parse(post.body ?? '{}')).toEqual({ answers: [{ selected: ['SQLite'] }] })
  expect(submitted).toEqual([])
  expect(await until(async () => (await ui.find({ type: 'Text', text: /서버에 답함/ })) !== undefined)).toBe(true)
  await ui.unmount()
})

test('원격 질문 대장: 대장 역할이 아니면 서버 질문을 끌어오지 않는다', async ($, on) => {
  const { hits } = await setupBoss($, on, 'team/other')
  await nap(50)
  expect(hits.some(h => h.url.includes('/api/questions'))).toBe(false)
})

test('좁은 터미널(#136): 패널이 자리를 못 잡으면 질문 첫 줄을 오래 가는 토스트로 띄우고, 대화창 줄은 남기지 않는다', async ($, on) => {
  const toasts: { text: string; timeoutMs?: number }[] = []
  const logs: string[] = []
  on('ui.toast', (_: any, e: any) => {
    toasts.push({ text: e.text, timeoutMs: e.options?.timeoutMs ?? e.timeoutMs })

    return { value: undefined }
  })
  on('ui.log', (_: any, e: any) => {
    logs.push(e.text)

    return { value: undefined }
  })
  await setup($, on, ['terminal'], undefined, false)
  await $.tool.call(INPUT as any)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(toasts.length).toBe(1)
  expect(toasts[0]!.text).toMatch(/^질문 q\d+: 어느 DB를 쓸까요\? 외 1 — \/questions 로 연다$/)
  expect(toasts[0]!.timeoutMs).toBeGreaterThanOrEqual(10_000)
  expect(logs).toEqual([])
})

test('좁은 터미널(#136): 패널이 자리를 잡으면 토스트를 띄우지 않는다', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  await setup($, on, ['terminal'])
  await $.tool.call(INPUT as any)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(toasts).toEqual([])
})

test('좁은 터미널(#136): 자리를 못 잡고 기다리는 패널이면 /questions 는 닫지 않고 연다', async ($, on) => {
  await setup($, on, ['terminal'], undefined, false)
  await $.tool.call(INPUT as any)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(paneSeated.value).toBe(false)
  commandRunning.value = true
  try {
    expect(JSON.stringify(await $.command.run({ command: 'questions', args: '' } as any))).toContain('열었습니다')
  } finally {
    commandRunning.value = false
  }
  expect(closes).toEqual([])
  expect(paneSeated.value).toBe(true)
})

// 규칙 원장(#219): 프로필 있는 세션은 도구 호출에 걸린 규칙을 context 한 줄로 받고, 같은 줄은 다시 받지 않는다.
test('규칙 원장: 걸린 규칙을 도구 결과의 context 로 한 번 넣고 hits 를 보내며, 막힌 호출에는 넣지 않는다', async ($, on) => {
  const hits: string[] = []
  on('env.get', (_: any, e: any) => ({ value: ({ SWITCHBOARD_PROFILE: 'sbtest', SWITCHBOARD_CONFIG_DIR: '/cfg' } as Record<string, string>)[e.name] }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path === '/cfg/sbtest.json' }))
  on('fs.read', (_: any, e: any) => ({ value: e.path === '/cfg/sbtest.json' ? JSON.stringify({ endpoint: 'http://mail.test', role: 'team/worker', token: 'tok' }) : '' }))
  on('http.fetch', (_: any, e: any) => {
    const url = String(e.url)
    const reply = (status: number, body: unknown) => ({ value: { status, ok: status < 300, headers: { etag: '"r1"' }, text: JSON.stringify(body) } })
    if (url.includes('/api/slots/register')) return reply(200, { role: 'team/worker-1', base: 'team/worker', number: 1, other_active: 0, reclaimed: false })
    if (url.includes('/api/slots/')) return reply(200, {})
    if (url.includes('/api/events/poll')) return reply(200, { events: [], cursor: 0 })
    if (url === 'http://mail.test/api/rules/mine') {
      return reply(200, { rules: [{ id: 5, kind: 'decision', topic: 'release', summary: 'no force push', match: { tool: 'Bash', command: '--force' } }] })
    }
    if (url === 'http://mail.test/api/rules/hits') {
      hits.push(String(e.init?.body))
      throw new Error('connect ECONNREFUSED') // 세기 실패는 삼킨다
    }

    return reply(404, { error: 'not found' })
  })
  on('tool.call', { tool: 'Bash' }, (_: any, e: any) => (e.command === 'blocked --force' ? { deny: 'no' } : { result: { stdout: 'ok', stderr: '', interrupted: false } }))
  await setup($, on)
  const blocked: any = await $.tool.call({ tool: 'Bash', command: 'blocked --force' } as any)
  expect(blocked.deny).toBe('no')
  const first: any = await $.tool.call({ tool: 'Bash', command: 'git push origin x --force' } as any)
  expect(first.context).toEqual(['결정 #5 참고: no force push'])
  const again: any = await $.tool.call({ tool: 'Bash', command: 'git push origin y --force' } as any)
  expect(again.context ?? []).toEqual([])
  const other: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(other.context ?? []).toEqual([])
  expect(hits).toEqual(['{"ids":[5]}'])
})
