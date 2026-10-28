# 고정 대기 대신 사건을 기다리기

「요청 보내고 n초 뒤 다시 확인」은 두 방향으로 틀린다. 느린 기계에서는 모자라 흔들리고, 빠른 기계에서는 남아 시험이 느려진다. 기다릴 **사건**(응답, 요소 나타남, 이동, 값 바뀜)에 이름을 붙이고 그 사건에서 풀리게 한다. Playwright에서 스트림 메시지·DOM 변화를 사건으로 받는 도우미는 [fast-stable-e2e](../../fast-stable-e2e/SKILL.md)에 있다. 여기는 찾고 바꾸는 순서와 층마다의 기법이다.

## 찾기와 바꾸는 순서

```bash
grep -rnE 'waitForTimeout|setTimeout\(|setInterval\(|sleep\(|time\.sleep|asyncio\.sleep|networkidle|while *\(' <시험·e2e 폴더> --include='*.ts' --include='*.tsx' --include='*.py'
```

앱 코드의 `setTimeout`(복사 안내를 2초 뒤 끄는 UI 등)은 대기가 아니다. 시험 폴더만 센다.

1. **건수를 센다.** 시험 파일별 목록을 PR에 적는다.
2. **무엇을 기다리는지 한 문장으로 쓴다**: 「저장 응답」「목록이 그려짐」「주소가 바뀜」. 한 문장이 안 써지면 기다릴 사건이 없는 것이다. 앱에 신호를 더한다(아래 「앱 쪽 신호」).
3. **사건 종류에 맞는 기법으로 바꾸고** 시간 값을 지운다.
4. 바꾼 시험을 부하 아래(`--repeat-each=20 --workers=4` 등)에서 반복해 흔들림이 없는지 본다. 20~30번이면 충분하다.
5. **린트로 다시 못 들어오게 막는다.**

## Playwright

| 기다릴 것 | 쓰는 것 |
| --- | --- |
| 화면의 값·보임 | web-first 단언 `await expect(locator).toHaveText(...)`·`toBeVisible()`. `expect(await locator.textContent())`처럼 값을 먼저 꺼내면 다시 보지 않는다 |
| 특정 API 응답 | `page.waitForResponse(pred)`. **동작 전에 걸고** 동작 뒤에 `await` |
| 요청이 나감 | `page.waitForRequest(pred)`. 리다이렉트처럼 응답을 못 받는 곳에서도 된다 |
| 주소 이동 | `await expect(page).toHaveURL(...)`. `waitForURL`은 이동이 도중에 취소되면 떨어진다 — 요청 둘이 함께 401을 받아 같은 로그인 주소로 두 번 이동하면 둘째가 첫째를 취소해 `ERR_ABORTED`가 났다(80번에 1번) |
| 요소 나타남·사라짐 | `locator.waitFor({ state: "visible" \| "detached" })` |
| 페이지 안 임의 조건 | `waitForFunction`은 폴링이다. 위 단언으로, 안 되면 사건마다 다시 보는 도우미로 |
| 네트워크 잠잠함 | `networkidle`은 쓰지 않는다. 폴링·스트림·분석 요청이 있으면 영영 안 오거나 엉뚱한 때 온다. 그 화면이 「그려졌다」를 뜻하는 요소를 기다린다 |

**동작 전에 건다.**

```ts
const [response] = await Promise.all([
  page.waitForResponse((r) => r.url().endsWith("/api/items") && r.request().method() === "POST"),
  page.getByTestId("submit").click(),
]);
```

화면을 연 뒤에 응답 대기를 걸어 이미 지나간 응답을 놓치고 15초를 채우던 시험 하나가 CI 시간의 대부분이었던 적이 있다.

**화면 준비 신호는 도우미 하나로.** 「목록이 실제로 그려졌다」를 뜻하는 요소를 기다리는 함수를 두고, 새 문서를 받는 모든 지점에서 먼저 부른다.

```ts
async function waitForList(page: Page) { await page.getByTestId("item-count").waitFor(); }
```

**`expect`의 다시 보는 간격은 벌어진다**(대략 100·250·500·1000ms…). 0.5초쯤 걸리는 변화를 0.3초 넘게 늦게 본다. 간격이 문제로 드러났을 때만 `expect.poll(check, { intervals: [20] })`로 좁히거나 사건 도우미로 바꾼다.

**신호가 정말 없을 때의 타협.** 사건이 시험 밖(다른 탭, 외부 호출)에서 오고 닿는 신호가 없으면 「한 단계씩 진행 → 짧게 기다림」 루프를 쓰되 상한(예: 30회)을 두고 끝에서 실패시킨다. 신호가 있으면 이 꼴을 쓰지 않는다.

### 린트로 막기

`waitForTimeout`은 금지가 목표다(정말 필요한 줄만 주석과 함께 예외로 푼다). e2e 폴더에만 거는 oxlint 설정의 예다. ESLint면 같은 selector를 `no-restricted-syntax`·`no-restricted-properties`로 옮긴다.

```json
"no-restricted-properties": ["error",
  { "property": "waitForTimeout", "message": "e2e는 시간으로 기다리지 않는다 — 사건으로 기다린다." },
  { "property": "waitForFunction", "message": "waitForFunction은 폴링이다." },
  { "property": "toPass", "message": "toPass는 재시도로 덮는다." },
  { "object": "expect", "property": "poll", "message": "expect.poll은 폴링이다." } ],
"no-restricted-syntax": ["error",
  { "selector": "CallExpression[callee.name=/^(setTimeout|setInterval|requestAnimationFrame)$/]", "message": "시간으로 기다리지 않는다" },
  { "selector": "WhileStatement", "message": "되풀이 루프로 기다리지 않는다" },
  { "selector": "Property[key.name='retries']:not([value.value=0])", "message": "retries는 0" } ]
```

처음 도입은 `waitForTimeout`·`setTimeout`·`networkidle` 셋만 막고, 남은 폴링은 건수를 세어 줄여 나간다. 린트가 없어도 시험 하나 3초 한도가 긴 고정 대기를 못 쓰게 하는 울타리가 된다.

## 앱 쪽 신호

화면이 「끝났다」를 스스로 알리면 시험이 시간을 짐작하지 않는다.

- **상태 속성**: 로딩 영역에 `aria-busy="false"`·`data-state="ready"`를 달고 `toHaveAttribute`로 기다린다. 없으면 「다 그려진 뒤에만 나타나는」 `data-testid` 요소나 `role="status"` 영역의 글자가 신호다.
- **연결됨 표지**: 스트림이 첫 스냅샷을 보냈다는 표지(「연결됨」)를 화면에 두고, `goto` 뒤 그것이 보일 때까지 기다린다.
- **서버 시계를 시험이 쥔다**: 시간이 의존성으로 주입돼 있으면 서버 시계를 멈춰 두고 시험이 감는다. 「n초 뒤」가 필요한 서버 일은 기다리지 않고 앞당긴다. → [fast-stable-e2e의 time-control](../../fast-stable-e2e/reference/time-control.md)
- **행동이 화면에 닿을 때까지 기다리는 도우미**: 행동 → 그 행동의 쓰기 응답 → (비동기 처리면) 그 뒤 첫 메시지까지 기다리고 돌아온다. 뒤따르는 `expect`가 한 번에 맞는다.
- **쌓이는 변화**: 「n째 줄이 붙는 것」을 `MutationObserver`로 받고 한 번만 본다. 「맨 아래가 될 때까지」 되풀이하면 늦게 따라가는 회귀를 못 잡는다.

## vitest / Testing Library

- **비동기 DOM**: `await screen.findByText(...)`, `await waitFor(() => expect(...))`. 즉시 있어야 하는 것은 `getBy*`, 없음을 단언하면 `queryBy*`. `waitFor` 안에는 단언 하나만, 부수 효과는 넣지 않는다.
- **지연·디바운스·타임아웃**: `vi.useFakeTimers()` → 동작 → `await vi.advanceTimersByTimeAsync(300)` → 단언 → `vi.useRealTimers()`. 가짜 타이머와 `findBy`를 섞으면 멈춘다(`findBy`가 타이머를 쓴다). 앞당긴 뒤 `getBy`를 쓴다.
- **네트워크**: MSW 핸들러는 즉시 응답하게 두고, 로딩 상태를 보는 시험만 `delay('infinite')`로 붙잡았다가 푼다.

## 백엔드 시험

`time.sleep`·`asyncio.sleep`으로 비동기 작업을 기다리는 시험은 작업을 동기로 돌리거나(Celery `task_always_eager` 등), 시계를 주입하거나(`freezegun`·`time-machine`), 완료 이벤트(`threading.Event.wait(timeout)`)를 기다린다. CPU 한도는 `sleep`을 못 잡는다(CPU를 쓰지 않으니). junit `time`이 크고 `cpu_seconds`가 작은 시험을 찾을 때 이 grep도 같이 돌린다.
