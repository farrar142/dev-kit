// 질문 패널 워커. Claude의 질문 도구 호출을 훅으로 받아 저장하고, 패널이 보낸 답을 그 터미널에 넣는다.
import type { OrcaWorkerApi } from 'orca/worker'
import '../src/protocol.ts'
import {
  addBatch,
  answerLine,
  asBatches,
  batchFromTool,
  clearSent,
  complete,
  markSent,
  STORE_KEY,
  type Batch,
  type JsonValue,
} from '../src/questions.ts'

export default function activate(orca: OrcaWorkerApi) {
  const load = async () => asBatches((await orca.storage.get(STORE_KEY)) as JsonValue | null)
  const save = (list: Batch[]) => orca.storage.set(STORE_KEY, list as unknown as JsonValue) // Batch는 JSON 그대로다

  // 관찰만 하는 훅이라 Claude를 붙잡지 않는다. 결과에 묶음 ID(q<N>)가 있어 before 대신 after를 쓴다.
  orca.hooks.on('agent.tool.after', async event => {
    const list = await load()
    const b = batchFromTool(event, Date.now(), `o${list.length + 1}`)
    if (b === null) return
    await save(addBatch(list, b))
    void orca.host
      .call('notifications.show', { title: '질문 패널', body: `${b.id}: ${b.questions[0].question}` })
      .catch(() => undefined)
  })

  orca.panels.handle('qp.answer', async ({ id, terminalId, picks }) => {
    const list = await load()
    const b = list.find(x => x.id === id && x.terminalId === terminalId && x.status === 'pending')
    if (b === undefined) return { ok: false, reason: '이미 답했거나 없는 묶음입니다.' }
    if (!complete(b, picks)) return { ok: false, reason: '모든 질문에 답을 골라 주세요.' }
    const line = answerLine(b, picks)
    const { accepted } = await orca.host.call('terminal.sendText', { terminalId, text: line, enter: true })
    if (!accepted) return { ok: false, reason: '터미널이 답을 받지 않았습니다(닫혔을 수 있음).' }
    await save(markSent(list, id, terminalId, line))

    return { ok: true, reason: '' }
  })

  orca.panels.handle('qp.clearSent', async () => {
    await save(clearSent(await load()))

    return { ok: true, reason: '' }
  })
}
