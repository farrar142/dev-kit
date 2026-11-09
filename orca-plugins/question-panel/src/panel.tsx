// 질문 패널(Orca 오른쪽 사이드바). 워커가 저장한 질문 묶음을 카드로 그리고, 고른 답을 워커에 보낸다.
// 워커가 그 답을 질문한 Claude의 터미널에 한 줄로 넣고 Enter를 누른다. Orca 채팅 세션의 질문(0.4.0)은
// 그 세션의 오케스트레이션 메일함으로 보낸다. 카드에 전달 경로(터미널·메일함)가 보인다.
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
  IconButton,
  plugin,
  RadioGroup,
  read,
  RelativeTime,
  Spinner,
  Row,
  set,
  Stack,
  Text,
  Textarea,
  Toolbar,
  update,
} from 'orca'
import './protocol.ts'
import {
  asBatches,
  complete,
  isMailbox,
  OTHER,
  OTHER_MAX,
  otherProblem,
  sortPicks,
  routeLabel,
  STORE_KEY,
  whereOf,
  type Batch,
  type JsonValue,
  type Picks,
  type Texts,
  withDefaults,
} from './questions.ts'

/** 워커와 같은 저장소 키. 워커가 묶음을 더하면 이 atom도 바뀐다. */
const stored = atom<JsonValue>(STORE_KEY, [], { persist: 'storage' })
/** 묶음별 고른 번호. 키는 `${terminalId}/${id}`. */
const picks = atom<Record<string, Picks>>('picks', {}, { persist: 'plugin' })
/** 묶음별 「기타」 글(0.4.4). 키는 picks 와 같다. */
const texts = atom<Record<string, Texts>>('texts', {}, { persist: 'plugin' })
const notice = atom<{ key: string; ok: boolean; text: string } | null>(null)
const busy = atom<string | null>(null)
/** 방금 지운 카드(되돌리기). */
const removed = atom<{ id: string; terminalId: string } | null>(null)

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
    cur[qi] = sortPicks([...set_])

    return { ...all, [k]: cur }
  })

const setText = (k: string, qi: number, text: string) =>
  update(texts, all => {
    const cur = [...(all[k] ?? [])]
    cur[qi] = text

    return { ...all, [k]: cur }
  })

/** 보낸 카드·지운 카드의 고른 것과 글을 지운다. */
const forget = (k: string) => {
  update(picks, ({ [k]: _, ...rest }) => rest)
  update(texts, ({ [k]: _, ...rest }) => rest)
}

// 패널의 console.warn 은 `orca plugin logs` 에 [frame] 줄로 남는다.
const trace = (msg: string) => {
  try {
    console.warn(`[question-panel/panel] ${msg}`)
  } catch {
    // 콘솔이 없는 환경이면 건너뛴다
  }
}

// 패널 문서가 (다시) 뜰 때마다 한 줄(0.4.3). Orca 가 패널을 「응답하지 않음」으로 멈추면 사이드바 탭을
// 오갈 때 문서가 새로 뜨므로, 이 줄의 간격으로 멈춤이 얼마나 잦은지 로그에서 센다(README 「무응답」).
trace(`패널 문서 로드 ${new Date().toISOString()}`)

// 패널을 열 때마다 워커가 대기 묶음의 터미널이 살아 있는지·제목·workspace 이름을 다시 확인한다.
// 결과는 저장소를 거쳐 stored atom 으로 돌아와 카드가 다시 그려진다.
void plugin.request('qp.refresh', {}, { timeoutMs: 20000 }).catch((err: unknown) =>
  trace(`refresh 실패: ${err instanceof Error ? err.message : String(err)}`),
)

// 정리(0.4.1): 확인 없이 바로 지우고, 위쪽에 「되돌리기」를 띄운다.
async function removeOne(b: Batch) {
  trace(`카드 지우기 ${b.id} terminal=${b.terminalId}`)
  const r = await plugin.request('qp.remove', { id: b.id, terminalId: b.terminalId }).catch(() => null)
  if (r?.ok === true) {
    set(removed, { id: b.id, terminalId: b.terminalId })
    forget(keyOf(b))
  }
}

async function undoRemove() {
  const last = read(removed)
  if (last === null) return
  trace(`되돌리기 ${last.id} terminal=${last.terminalId}`)
  set(removed, null)
  await plugin.request('qp.undoRemove', last).catch(() => null)
}

const clearAll = (what: 'qp.clearSent' | 'qp.clearClosed') => {
  trace(`정리 ${what}`)
  set(removed, null)
  void plugin.request(what, {}).catch(() => undefined)
}

async function send(b: Batch) {
  const k = keyOf(b)
  const chosen = withDefaults(b, read(picks)[k] ?? [])
  const written = b.questions.map((_, i) => (chosen[i] ?? []).includes(OTHER) ? (read(texts)[k]?.[i] ?? '') : '')
  trace(`답 보내기 누름 ${b.id} terminal=${b.terminalId} picks=${JSON.stringify(chosen)}`)
  set(busy, k)
  set(notice, null)
  try {
    const r = await plugin.request(
      'qp.answer',
      // 「기타」를 고른 질문이 있을 때만 글을 싣는다(그 밖의 요청 모양은 0.4.3과 같다).
      { id: b.id, terminalId: b.terminalId, picks: chosen, ...(written.some(t => t !== '') ? { texts: written } : {}) },
      { timeoutMs: 20000 },
    )
    trace(`워커 답 ok=${r.ok} reason=${r.reason}`)
    set(
      notice,
      r.ok
        ? { key: k, ok: true, text: `${b.id} 답을 보냈습니다 — ${r.via ?? routeLabel(b)}` }
        : {
            key: k,
            ok: false,
            text: r.maybeSent === true ? `${r.reason} (실제로는 갔을 수 있습니다 — 채팅을 먼저 확인하세요)` : r.reason,
          },
    )
    if (r.ok) forget(k)
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

const OTHER_TEXT = '기타 — 직접 입력'

/** 「기타」를 고르면 열리는 여러 줄 글 상자와 글자 수(0.4.4). 비었거나 OTHER_MAX 를 넘으면 보내기가 꺼진다. */
function OtherBox({ k, qi, text, problem }: { k: string; qi: number; text: string; problem: string | null }) {
  const len = text.trim().length
  const bad = problem !== null && len > 0

  return (
    <Stack gap="xs">
      <Textarea
        label={`${qi + 1}번 기타 답`}
        labelHidden
        rows={3}
        placeholder="목록에 없는 답을 글로 쓰세요"
        invalid={bad}
        value={text}
        onChange={v => setText(k, qi, v)}
      />
      <Text size="xs" tone={bad ? 'danger' : 'neutral'} muted={!bad}>
        {bad ? problem : `${len}/${OTHER_MAX}자${len === 0 ? ' · 글을 써야 보낼 수 있습니다' : ''}`}
      </Text>
    </Stack>
  )
}

function BatchCard({ b }: { b: Batch }) {
  const k = keyOf(b)
  const mine = withDefaults(b, read(picks)[k] ?? [])
  const myTexts = read(texts)[k] ?? []
  const n = read(notice)
  // 지금 막 실패한 이유가 있으면 그것을, 없으면 저장된 마지막 실패 이유를 보인다.
  const failure = n !== null && n.key === k ? (n.ok ? null : n.text) : (b.error ?? null)
  const closedText = isMailbox(b) ? '채팅 세션이 없음' : '터미널이 닫힘'
  const sending = read(busy) === k

  return (
    <Card title={`질문 묶음 ${b.id}`}>
      <Stack gap="md">
        <Row gap="xs">
          {b.closed === true ? <Badge tone="danger">{closedText}</Badge> : null}
          <Badge tone="neutral">{routeLabel(b)}</Badge>
          <Text muted size="xs">
            <RelativeTime at={b.createdAt} />
            {` · ${whereOf(b)}`}
          </Text>
          <IconButton
            icon="close"
            label={`${b.id} 카드 지우기`}
            variant="ghost"
            size="sm"
            disabled={sending}
            onPress={() => removeOne(b)}
          />
        </Row>
        {b.closed === true ? (
          <Callout tone="warning" title={closedText}>
            {isMailbox(b)
              ? '이 질문을 한 채팅 세션이 Orca에 없어 답을 보낼 곳이 없습니다. 「지우기」로 정리하세요.'
              : '이 질문을 한 터미널이 닫혀 답을 넣을 곳이 없습니다. 「지우기」로 정리하세요.'}
          </Callout>
        ) : null}
        {b.maybeSent === true ? (
          <Callout tone="warning" title="이미 보냈을 수 있음">
            {`앞선 보내기는 실패로 끝났지만 실제로는 갔을 수 있습니다. 채팅에 「[질문 패널 답] ${b.id}」 메일이 왔는지 먼저 확인하고, 안 왔을 때만 다시 보내세요.`}
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
              )).concat(
                <Checkbox
                  label={OTHER_TEXT}
                  checked={(mine[qi] ?? []).includes(OTHER)}
                  onChange={on => toggle(k, qi, OTHER, on)}
                />,
              )
            ) : (
              <RadioGroup
                label={q.question}
                labelHidden
                {...(mine[qi]?.[0] === undefined ? {} : { value: String(mine[qi][0]) })}
                options={[
                  ...q.options.map((o, oi) => ({
                    value: String(oi),
                    label: o.label,
                    ...(o.description === '' ? {} : { description: o.description }),
                  })),
                  { value: String(OTHER), label: OTHER_TEXT },
                ]}
                onChange={v => pickOne(k, qi, Number(v))}
              />
            )}
            {(mine[qi] ?? []).includes(OTHER) ? (
              <OtherBox k={k} qi={qi} text={myTexts[qi] ?? ''} problem={otherProblem(mine, myTexts, qi)} />
            ) : null}
          </Stack>
        ))}
        {failure === null ? null : <Callout tone="danger" title="보내지 못함">{failure}</Callout>}
        {sending ? <Spinner label={isMailbox(b) ? '메일함에 보내는 중' : '터미널에 보내는 중'} /> : null}
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
            disabled={b.closed === true || !complete(b, mine, myTexts) || read(busy) !== null}
            onPress={() => send(b)}
          >
            {b.error === undefined ? '답 보내기' : '다시 보내기'}
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
  const gone = read(removed)

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
      {sent.length === 0 && closed.length === 0 ? null : (
        <Toolbar label="정리" gap="xs">
          {sent.length === 0 ? null : (
            <Button variant="ghost" size="sm" icon="delete" onPress={() => clearAll('qp.clearSent')}>
              {`답한 것·보낸 것 모두 지우기 (${sent.length})`}
            </Button>
          )}
          {closed.length === 0 ? null : (
            <Button variant="ghost" size="sm" icon="delete" onPress={() => clearAll('qp.clearClosed')}>
              {`닫힌 세션 질문 지우기 (${closed.length})`}
            </Button>
          )}
        </Toolbar>
      )}
      {gone === null ? null : (
        <Callout tone="neutral" title="카드를 지웠습니다">
          <Row justify="between" gap="xs">
            <Text size="sm">{`${gone.id} 카드를 지웠습니다.`}</Text>
            <Button variant="ghost" size="sm" onPress={() => undoRemove()}>
              되돌리기
            </Button>
          </Row>
        </Callout>
      )}
      {pending.length === 0 ? (
        <EmptyState
          icon="bot"
          title="대기 중인 질문이 없습니다"
          description="Claude가 질문 패널 도구로 물으면 여기에 카드가 뜹니다. 답을 고르면 그 Claude 터미널에 한 줄로 들어갑니다(채팅 세션이면 그 세션의 오케스트레이션 메일함으로 갑니다)."
        />
      ) : (
        pending.map(b => <BatchCard b={b} />)
      )}
      {sent.length === 0 ? null : (
        <Collapsible title={`보낸 답 ${sent.length}개`}>
          <Stack gap="sm">
            {sent.map(b => (
              <Text size="xs" muted>
                {`${b.via ?? '터미널'} · ${b.sent ?? b.id}`}
              </Text>
            ))}
          </Stack>
        </Collapsible>
      )}
    </Stack>
  )
}
