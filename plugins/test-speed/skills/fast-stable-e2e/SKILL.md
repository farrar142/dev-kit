---
name: fast-stable-e2e
description: Playwright E2E를 시험 하나 3초 안에, 흔들림 없이 만드는 법 — 폴링·고정 대기 대신 DOM 이벤트·MutationObserver·스트림(SSE·WebSocket) 메시지 리스너로 화면 변경을 기다리는 공용 도우미, API로 준비하고 쿠키를 옮기기, 시험 뒤 맥락 닫기, 시간에 기대는 화면은 시험이 시간을 쥐기. E2E가 느리다, 가끔 떨어진다(flaky), expect.poll·waitForTimeout·waitForFunction·toPass·retries로 버틴다, 실시간 메시지 뒤의 화면을 기다려야 한다, 금방 사라지는 상태를 놓친다, 시험이 쌓일수록 느려진다, 마감·만료 같은 시간 창이 시험에서 닫힌다 — 이럴 때 쓴다.
---

# 빠르고 흔들리지 않는 Playwright E2E

## 원칙: 이벤트로만 기다린다

폴링(`expect.poll`, `.toPass()`, `waitForFunction`, `while`+`sleep`)과 고정 대기(`waitForTimeout`)는 둘 다 나쁘다. 짧으면 흔들리고, 길면 느리고, 다시 보는 간격만큼 결과를 늦게 안다. 화면을 바꿀 수 있는 **이벤트가 올 때마다 한 번 다시 보는** 도우미로 기다린다. → [examples/e2e-support.ts](examples/e2e-support.ts)

- `watchStreams(page)`: init script가 EventSource·WebSocket을 감싼다. 메시지를 종류별로 세고, 종류별 마지막 것을 쥐고, `window`에 `e2e:message` 이벤트를 낸다. 첫 `goto` 전에 건다.
- `until`(페이지 안): `MutationObserver`·`ResizeObserver`·`e2e:message`·`transitionend`·`animationend`·`resize`·`scroll`이 올 때마다 조건을 다시 본다. 아래 도우미가 모두 이것 위에 있다.

| 도우미 | 쓰임 |
|---|---|
| `waitFor(page, check, arg?)`·`waitForIn(locator, check, arg?)` | 화면 안 조건(글자·속성·배치)이 참이 되기 |
| `arm(page, check, arg?)` → `await done()` | 행동 **전에** 걸어 두고 뒤에 기다린다. 금방 사라지는 상태(잠깐 뜨는 알림, 진행 중 표시)용 |
| `seen` → `waitForSeen(page, type, n)` | 사정을 깔기 전에 세고, 그 뒤 메시지가 오기 |
| `nextMessages(page, type, n)` | 지금부터 그 종류 메시지가 n개 더 오기 |
| `waitForMessage(page, type, where?, arg?)` | 그 종류의 마지막 메시지가 조건에 맞기(이미 맞으면 곧바로) |
| `act(page, () => click…, opts?)` | 행동의 쓰기 응답(과 비동기 처리면 그 뒤 메시지 하나)까지. 뒤따르는 `expect`가 한 번에 맞는다 |
| `openStream(page, lightUrl, streamUrl)` | 화면 없이 스트림만 열어 메시지를 기다릴 때(앱 띄우기 값을 아낀다) |
| `test`(`closeOpenedContexts`) | 시험 안에서 연 `browser.newContext()`를 시험 뒤에 닫는다 |

쓰는 법:
```ts
// 두 화면에 금방 사라지는 표시가 뜨는지 — 누르기 전에 건다
const a = await arm(pageA, (t) => document.querySelector('[aria-label="진행"]')?.textContent?.includes(t), '보내는 중')
const b = await arm(pageB, (t) => document.querySelector('[aria-label="진행"]')?.textContent?.includes(t), '받는 중')
await pageA.getByRole('button', { name: '보내기' }).click()
await Promise.all([a(), b()])
// 서버가 비동기로 처리하는 행동: 응답 + 결과 메시지 하나를 기다린 뒤 한 번 단언
await act(page, () => page.getByRole('button', { name: '저장' }).click(), { thenMessage: () => 'saved' })
await expect(page.getByRole('status')).toHaveText('저장됨')
```

- **웹 단언(`expect(locator)…`)은 기다린 뒤 한 번 맞는 데만 쓴다.** 다시 보는 간격이 있어(한 프로젝트에서 잰 값: 처음 약 0.27초, 뒤로 0.5초마다) 결과를 늦게 안다. `expect` 제한 시간을 늘리지 않는다.
- **lint로 막는다.** → [examples/eslint.e2e.mjs](examples/eslint.e2e.mjs). 도우미 파일만 뺀다. 도우미 안에서도 폴링하지 않는다.

한 프로젝트에서 잰 값: 폴링(`expect.poll` 12곳, `waitForFunction` 27곳, rAF·`while` 루프)을 이벤트 도우미로 바꾸고 아래 「맥락 닫기」를 함께 하자 전체 E2E가 6분대(실패 10개)에서 로컬 1.3분·CI 45초(110개 통과)로, 시험 중앙값이 14.6초에서 약 1.3초로 줄었다.

## 시험을 짜는 법

- **3초 예산, 예외 없음, `retries: 0`.** 재시도는 흔들림을 노랑으로 덮고 시간을 두 배로 쓴다.
- **화면 흐름마다 시험 하나.** 앞 화면까지는 **API로 준비**하고 화면으로 되풀이하지 않는다. 가입·만들기 화면은 그 화면을 덮는 시험 하나에서만 화면으로 돈다. 긴 시험을 나눌 때 단언은 모두 어딘가에 남긴다.
- **준비 요청은 Node `fetch`와 쿠키 단지로 하고, 쿠키를 맥락에 옮긴다.** → [examples/api.ts](examples/api.ts). 첫 화면에 담길 사정은 화면을 열기 **전에** 깐다(열고 나서 깔면 새로고침이 한 번 더 든다).
- **시험 안에서 연 맥락은 시험 뒤에 닫는다.** 닫지 않으면 끝난 시험의 화면이 실시간 연결을 쥔 채 남아 서버가 그 몫의 일을 계속 하고, 시험이 쌓일수록 느려진다. 위 수치의 가장 큰 원인이 이것이었다.
- **브라우저 설정:**
  - 연출 애니메이션은 `use: { contextOptions: { reducedMotion: 'reduce' } }`로 건너뛴다. 제품 CSS·코드에 `prefers-reduced-motion` 갈래가 있어야 한다.
  - 외부 글꼴·분석 스크립트는 `context.route(...).abort()`로 끊는다(`offline`). 망이 느리면 그것만으로 `page.goto`가 3초를 넘긴다.
- **스택 설정:** 빠른 비밀번호 해셔, 배경 작업 주기 최소, 시험 DB는 tmpfs. 일꾼 수(`workers`)를 CI와 같게 못 박는다 — 정하지 않으면 호스트 코어 수만큼 띄워 시험마다 몇 배로 부푼다.
- **데우기:** `globalSetup`에서 시험과 같은 길(가입 → 첫 화면)을 한 번 지난다. 안 하면 첫 시험이 서버·빌드의 첫 호출 값을 혼자 진다.
- **공유 데이터는 내 것만 센다.** 일꾼끼리 같은 서버를 쓰므로 「목록 전체 개수」 단언은 흔들린다. 고유 이름으로 내 것만 골라 센다. 서버 전체 설정을 바꾸는 시험 경로는 쓰지 않는다.
- **데이터 한도:** 서버에 개수 한도(방·자리·초대 수)가 있으면 시험 수 × 사람 수가 넘지 않는지 본다.

## 시간에 기대는 화면

마감·만료·자동 갱신처럼 시간이 흘러야 바뀌는 화면은 시험이 시간을 쥔다. 브라우저 타이머는 Playwright `page.clock`, 서버의 「지금」은 주입한 시계, 배경 주기는 끄고 「한 번 돌기」를 부른다. → [reference/time-control.md](reference/time-control.md)

## 흔들림 함정 (실제로 겪은 것)

- **「단추 개수를 세고 차례로 누르기」:** 세는 순간과 누르는 순간 사이에 단추가 사라지면(마감, 다른 사람의 행동) 사라진 단추를 끝없이 기다린다. 미리 세지 말고 「보이는 첫 단추를 누르거나, 다음 화면이 오면 그만」으로 짠다.
- **행동 뒤에 들여다보기:** 금방 사라지는 상태는 행동이 끝난 뒤엔 이미 없다. `arm`으로 먼저 건다.
- **행동 앞의 응답을 행동의 응답으로 잡기:** 화면이 스스로 보내는 쓰기(구독 갱신 등)의 응답이 행동 중에 오면 `act`가 그것을 잡는다. `waitForRequest`를 행동 직전에 걸고, 그런 경로는 `background`로 뺀다.
- **도우미 이벤트는 앱보다 먼저 난다.** `e2e:message`가 날 때 앱은 아직 그리지 않았다. 메시지 도착이 아니라 화면을 봐야 하면 `waitFor`로 DOM을 본다.
- **문서가 바뀌면 건 것이 사라진다.** 탐색·새로고침 뒤에는 다시 건다. `page.evaluate`가 「Execution context was destroyed」로 떨어지면 이것이다.
- **SSE 이름 붙은 이벤트(`event: foo`)은 `message`로 오지 않는다.** `watchStreams(page, { sseEvents: ['foo'] })`로 넘긴다.
- **도우미는 스스로 시간 제한이 없다.** 시험 제한 시간이 끊으니, 무엇을 기다렸는지 `test.step` 이름으로 남긴다.

## 끝 조건

- 모든 E2E가 시험마다 3초 안에 통과한다. 시험별 시간표(junit 등)를 PR 본문에 넣는다.
- 로컬 실제 스택에서 5번 돌려 흔들림이 없다.
- E2E가 PR CI 밖(정기 빌드)에서 돈다면 그 빌드도 초록이다.
