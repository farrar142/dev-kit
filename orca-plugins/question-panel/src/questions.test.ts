// 순수 로직 시험. `orca plugin test` 로 돈다.
import { assert, test } from 'orca/testing'
import {
  addBatch,
  answerLine,
  asBatches,
  batchFromTool,
  clearSent,
  complete,
  markSent,
  whereOf,
  workspaceNameFrom,
  type ToolEvent,
} from './questions.ts'

const EVENT: ToolEvent = {
  tool: 'mcp__plugin_question-panel_qp__ask',
  terminalId: 'term_1',
  workspaceId: 'ws_1',
  input: {
    questions: [
      {
        question: '어느 DB?',
        header: 'DB',
        multiSelect: false,
        options: [{ label: 'Postgres', description: '' }, { label: 'SQLite' }],
      },
      { question: '켤 기능', multiSelect: true, options: [{ label: '캐시' }, { label: '로그' }, { label: '' }] },
    ],
  },
  output: { content: [{ type: 'text', text: '질문 묶음 q3을 패널에 올렸다. …' }] },
}

test('질문 패널 도구 호출에서 묶음을 만들고 결과의 q<N>을 ID로 쓴다', () => {
  const b = batchFromTool(EVENT, 1000, 'o1')
  if (b === null) return assert.fail('묶음이 없다')
  assert.equal(b.id, 'q3')
  assert.equal(b.terminalId, 'term_1')
  assert.equal(b.questions.length, 2)
  assert.deepEqual(
    b.questions[1].options.map(o => o.label),
    ['캐시', '로그'],
    '빈 label 선택지는 버린다',
  )
})

test('결과에 ID가 없으면 fallback ID', () => {
  assert.equal(batchFromTool({ ...EVENT, output: 'ok' }, 1, 'o7')?.id, 'o7')
})

test('다른 도구, 터미널이 없는 호출(채팅 세션 등), 질문이 없는 호출은 무시한다', () => {
  assert.equal(batchFromTool({ ...EVENT, tool: 'Bash' }, 1, 'o1'), null)
  assert.equal(batchFromTool({ ...EVENT, terminalId: undefined }, 1, 'o1'), null)
  assert.equal(batchFromTool({ ...EVENT, input: { questions: [] } }, 1, 'o1'), null)
})

test('답 줄은 한 줄이고 묶음 ID·질문·고른 라벨·번호를 담는다', () => {
  const b = batchFromTool(EVENT, 1, 'o1')!
  assert.equal(complete(b, [[0], []]), false, '여러 개 선택 질문도 하나는 골라야 한다')
  assert.equal(complete(b, [[0, 1], [0]]), false, '하나만 선택 질문에 둘은 안 된다')
  assert.equal(complete(b, [[1], [0, 1]]), true)
  const line = answerLine(b, [[1], [0, 1]])
  assert.equal(line, '[질문 패널 답 q3] 1) 어느 DB? = SQLite [2] / 2) 켤 기능 = 캐시, 로그 [1,2]')
  assert.ok(!/\n/.test(line))
})

test('같은 터미널·ID는 바꾸고, 보낸 것만 지운다', () => {
  const b = batchFromTool(EVENT, 1, 'o1')!
  const other = { ...b, terminalId: 'term_2' }
  let list = addBatch(addBatch(addBatch([], b), other), { ...b, createdAt: 2 })
  assert.equal(list.length, 2)
  list = markSent(list, 'q3', 'term_1', 'x')
  assert.equal(list.find(x => x.terminalId === 'term_1')?.status, 'sent')
  assert.deepEqual(clearSent(list).map(x => x.terminalId), ['term_2'])
})

test('저장소 값이 틀린 모양이면 버린다', () => {
  assert.deepEqual(asBatches(null), [])
  assert.deepEqual(asBatches([{ id: 1 }, 'x']), [])
})

test('Claude Code PostToolUse의 MCP 결과(content 블록 배열)에서도 묶음 ID를 읽는다', () => {
  const b = batchFromTool({ ...EVENT, output: [{ type: 'text', text: '질문 묶음 q12을 패널에 올렸다.' }] }, 1000, 'o1')
  assert.equal(b?.id, 'q12')
})

test('workspace 이름을 모르면 workspace id의 마지막 경로 이름을 쓴다(Windows 경로 포함)', () => {
  assert.equal(workspaceNameFrom('d3076cdb::C:/Users/me/orca/workspaces/Sandcorp/data'), 'data')
  assert.equal(workspaceNameFrom('r::C:\\Users\\me\\proj\\'), 'proj')
  assert.equal(workspaceNameFrom(null), null)
  const b = batchFromTool(EVENT, 1, 'o1')
  if (b === null) return assert.fail('묶음이 없다')
  assert.equal(whereOf(b), 'ws_1 · term_1')
  assert.equal(whereOf({ ...b, workspaceName: 'Data', terminalTitle: 'claude' }), 'Data · claude')
})
