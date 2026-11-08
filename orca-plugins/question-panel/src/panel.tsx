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
  Row,
  set,
  Stack,
  Text,
  update,
} from 'orca'
import './protocol.ts'
import { asBatches, complete, STORE_KEY, type Batch, type JsonValue, type Picks } from './questions.ts'

/** 워커와 같은 저장소 키. 워커가 묶음을 더하면 이 atom도 바뀐다. */
const stored = atom<JsonValue>(STORE_KEY, [], { persist: 'storage' })
/** 묶음별 고른 번호. 키는 `${terminalId}/${id}`. */
const picks = atom<Record<string, Picks>>('picks', {}, { persist: 'plugin' })
const notice = atom<{ key: string; text: string } | null>(null)
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

async function send(b: Batch) {
  const k = keyOf(b)
  set(busy, k)
  try {
    const r = await plugin.request('qp.answer', { id: b.id, terminalId: b.terminalId, picks: read(picks)[k] ?? [] })
    set(notice, r.ok ? null : { key: k, text: r.reason })
    if (r.ok) update(picks, ({ [k]: _, ...rest }) => rest)
  } catch (err) {
    set(notice, { key: k, text: `보내지 못했습니다: ${err instanceof Error ? err.message : String(err)}` })
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
        <Text muted size="xs">
          <RelativeTime at={b.createdAt} />
        </Text>
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
        {n !== null && n.key === k ? <Callout tone="warning">{n.text}</Callout> : null}
        <Row justify="end">
          <Button
            variant="solid"
            tone="accent"
            icon="check"
            disabled={!complete(b, mine) || read(busy) !== null}
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

  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading level={2}>질문</Heading>
        <Badge tone={pending.length > 0 ? 'warning' : 'success'}>{`${pending.length}개 대기`}</Badge>
      </Row>
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
