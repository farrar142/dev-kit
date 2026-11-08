// 질문 패널(Orca 오른쪽 사이드바). 워커가 저장한 질문 묶음을 카드로 그리고, 고른 답을 워커에 보낸다.
// 워커가 그 답을 질문한 Claude의 터미널에 한 줄로 넣고 Enter를 누른다.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Collapsible,
  EmptyState,
  Heading,
  plugin,
  RadioGroup,
  read,
  RelativeTime,
  Spinner,
  Row,
  set,
  Stack,
  Text,
  update,
} from 'orca'
import './protocol.ts'
import { asBatches, complete, STORE_KEY, whereOf, type Batch, type JsonValue, type Picks } from './questions.ts'

/** 워커와 같은 저장소 키. 워커가 묶음을 더하면 이 atom도 바뀐다. */
const stored = atom<JsonValue>(STORE_KEY, [], { persist: 'storage' })
/** 묶음별 고른 번호. 키는 `${terminalId}/${id}`. */
const picks = atom<Record<string, Picks>>('picks', {}, { persist: 'plugin' })
const notice = atom<{ key: string; ok: boolean; text: string } | null>(null)
const busy = atom<string | null>(null)

const keyOf = (b: Batch) => `${b.terminalId}/${b.id}`

const pickOne = (k: string, qi: number, n: number) =>
  update(picks, all => {
    const cur = [...(all[k] ?? [])]
    cur[qi] = [n]

    return { ...all, [k]: cur }
  })

const toggle = (k: string, qi: number, n: number, on: boolean) =>
  update(picks, all => {
    const cur = [...(all[k] ?? [])]
    const set_ = new Set(cur[qi] ?? [])
    if (on) set_.add(n)
    else set_.delete(n)
    cur[qi] = [...set_].sort((a, b) => a - b)

    return { ...all, [k]: cur }
  })

// 패널의 console.warn 은 `orca plugin logs` 에 [frame] 줄로 남는다.
const trace = (msg: string) => {
  try {
    console.warn(`[question-panel/panel] ${msg}`)
  } catch {
    // 콘솔이 없는 환경이면 건너뛴다
  }
}

// 패널을 열 때마다 워커가 대기 묶음의 터미널이 살아 있는지·제목·workspace 이름을 다시 확인한다.
// 결과는 저장소를 거쳐 stored atom 으로 돌아와 카드가 다시 그려진다.
void plugin.request('qp.refresh', {}, { timeoutMs: 20000 }).catch((err: unknown) =>
  trace(`refresh 실패: ${err instanceof Error ? err.message : String(err)}`),
)

const removeOne = (b: Batch) => {
  trace(`카드 지우기 ${b.id} terminal=${b.terminalId}`)
  void plugin.request('qp.remove', { id: b.id, terminalId: b.terminalId }).catch(() => undefined)
}

async function send(b: Batch) {
  const k = keyOf(b)
  const chosen = read(picks)[k] ?? []
  trace(`답 보내기 누름 ${b.id} terminal=${b.terminalId} picks=${JSON.stringify(chosen)}`)
  set(busy, k)
  set(notice, null)
  try {
    const r = await plugin.request(
      'qp.answer',
      { id: b.id, terminalId: b.terminalId, picks: chosen },
      { timeoutMs: 20000 },
    )
    trace(`워커 답 ok=${r.ok} reason=${r.reason}`)
    set(notice, r.ok ? { key: k, ok: true, text: `${b.id} 답을 터미널에 넣었습니다.` } : { key: k, ok: false, text: r.reason })
    if (r.ok) update(picks, ({ [k]: _, ...rest }) => rest)
  } catch (err) {
    const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined // HostError
    const text = `워커에 닿지 못했습니다${typeof code === 'string' ? ` (${code})` : ''}: ${
      err instanceof Error ? err.message : String(err)
    }`
    trace(text)
    set(notice, { key: k, ok: false, text })
  } finally {
    set(busy, null)
  }
}

function BatchCard({ b }: { b: Batch }) {
  const k = keyOf(b)
  const mine = read(picks)[k] ?? []
  const n = read(notice)

  return (
    <Card title={`질문 묶음 ${b.id}`}>
      <Stack gap="md">
        <Row gap="xs">
          {b.closed === true ? <Badge tone="danger">터미널이 닫힘</Badge> : null}
          <Text muted size="xs">
            <RelativeTime at={b.createdAt} />
            {` · ${whereOf(b)}`}
          </Text>
        </Row>
        {b.closed === true ? (
          <Callout tone="warning" title="터미널이 닫힘">
            이 질문을 한 터미널이 닫혀 답을 넣을 곳이 없습니다. 「지우기」로 정리하세요.
          </Callout>
        ) : null}
        {b.questions.map((q, qi) => (
          <Stack gap="xs">
            <Row gap="xs">
              {q.header === '' ? null : <Badge tone="accent">{q.header}</Badge>}
              <Text weight="semibold">{`${qi + 1}. ${q.question}`}</Text>
            </Row>
            {q.multiSelect ? (
              q.options.map((o, oi) => (
                <Checkbox
                  label={o.label}
                  {...(o.description === '' ? {} : { description: o.description })}
                  checked={(mine[qi] ?? []).includes(oi)}
                  onChange={on => toggle(k, qi, oi, on)}
                />
              ))
            ) : (
              <RadioGroup
                label={q.question}
                labelHidden
                {...(mine[qi]?.[0] === undefined ? {} : { value: String(mine[qi][0]) })}
                options={q.options.map((o, oi) => ({
                  value: String(oi),
                  label: o.label,
                  ...(o.description === '' ? {} : { description: o.description }),
                }))}
                onChange={v => pickOne(k, qi, Number(v))}
              />
            )}
          </Stack>
        ))}
        {n !== null && n.key === k && !n.ok ? <Callout tone="danger" title="보내지 못함">{n.text}</Callout> : null}
        {read(busy) === k ? <Spinner label="터미널에 보내는 중" /> : null}
        <Row justify="end" gap="xs">
          {b.closed === true ? (
            <Button variant="ghost" size="sm" icon="delete" onPress={() => removeOne(b)}>
              지우기
            </Button>
          ) : null}
          <Button
            variant="solid"
            tone="accent"
            icon="check"
            disabled={b.closed === true || !complete(b, mine) || read(busy) !== null}
            onPress={() => send(b)}
          >
            답 보내기
          </Button>
        </Row>
      </Stack>
    </Card>
  )
}

export default function Panel() {
  const all = asBatches(read(stored))
  const pending = all.filter(b => b.status === 'pending').sort((a, b) => b.createdAt - a.createdAt)
  const sent = all.filter(b => b.status === 'sent')
  const last = read(notice)
  const closed = pending.filter(b => b.closed === true)

  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading level={2}>질문</Heading>
        <Badge tone={pending.length > 0 ? 'warning' : 'success'}>{`${pending.length}개 대기`}</Badge>
      </Row>
      {last === null ? null : (
        <Callout tone={last.ok ? 'success' : 'danger'} title={last.ok ? '보냄' : '보내지 못함'}>
          {last.text}
        </Callout>
      )}
      {closed.length === 0 ? null : (
        <Row justify="end">
          <Button variant="ghost" size="sm" icon="delete" onPress={() => void plugin.request('qp.clearClosed', {})}>
            {`닫힌 터미널 카드 ${closed.length}개 지우기`}
          </Button>
        </Row>
      )}
      {pending.length === 0 ? (
        <EmptyState
          icon="bot"
          title="대기 중인 질문이 없습니다"
          description="Claude가 질문 패널 도구로 물으면 여기에 카드가 뜹니다. 답을 고르면 그 Claude 터미널에 한 줄로 들어갑니다."
        />
      ) : (
        pending.map(b => <BatchCard b={b} />)
      )}
      {sent.length === 0 ? null : (
        <Collapsible title={`보낸 답 ${sent.length}개`}>
          <Stack gap="sm">
            {sent.map(b => (
              <Text size="xs" muted>
                {b.sent ?? b.id}
              </Text>
            ))}
            <Row justify="end">
              <Button variant="ghost" size="sm" icon="delete" onPress={() => void plugin.request('qp.clearSent', {})}>
                보낸 기록 지우기
              </Button>
            </Row>
          </Stack>
        </Collapsible>
      )}
    </Stack>
  )
}
