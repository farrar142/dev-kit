---
name: test-budgets
description: 시험 하나마다 시간 예산(로직 0.5초·백엔드 1초·E2E 3초)을 두고 러너에서 강제하는 법, 느린 시험을 시험이 아니라 로직·준비 구조를 고쳐 빠르게 하는 처방, 프런트 단위 시험을 vitest 없이 node --test로 .tsx까지 돌리는 법. 시험이 느리다, 시험 시간 예산을 정하거나 강제하고 싶다, CI가 오래 걸린다, 시험 문서(testing.md)를 새 저장소에 세운다 — 이럴 때 쓴다.
---

# 시험 시간 예산

## 예산

| 층 | 거치는 것 | 시험 하나 |
|---|---|---|
| 로직 | 순수 함수만(네트워크·DB 없음) | 0.5초 |
| 백엔드 | HTTP·DB·발행 같은 서버 경계 | 1초 |
| E2E | 브라우저로 화면을 끝까지 | 3초 |

- **무엇을 재나:** 시험 본문에 그 시험만을 위한 준비(함수 범위 픽스처)를 더한 시간이다. 여럿이 나눠 쓰는 세션·모듈 픽스처는 세지 않는다. 그래서 준비를 공통 픽스처로 옮기는 것이 곧 최적화다.
- **어디로 분류하나:** 한 시험이 두 층에 걸치면 더 바깥 층으로 친다. HTTP를 한 번이라도 거치면 백엔드다.
- **예외 표지:** 예산에서 빠지는 것은 `slow` 표지 하나뿐이다. PR CI가 돌리지 않는 느린 시험층(정기 빌드)에서만 돈다. 수만 회 반복하는 시뮬레이션·속성 시험 같은 것이 여기에 든다.
- **템플릿:** 저장소 문서로 그대로 쓸 수 있게 [templates/testing.md](templates/testing.md)를 두었다.

## 강제

- **pytest:** [examples/conftest_budget.py](examples/conftest_budget.py)를 쓴다. 함수 범위 픽스처 준비와 본문을 합쳐 재고, 넘으면 통과한 시험도 실패로 바꾼다. 끝나지 않는 시험은 `pytest-timeout`(예: 10초, `signal` 방식)이 끊고 모든 스레드 스택을 찍는다.
  - CI 기계가 붐비면 벽시계로 잰 1초 근처 시험이 빌드마다 번갈아 떨어진다. 그러면 백엔드 예산을 CPU 시간(`time.process_time()` + 자식 프로세스 몫 `resource.getrusage(RUSAGE_CHILDREN)`)으로 잰다. 기다림이 많은 시험은 벽시계가 맞으니 저장소마다 고른다.
- **Playwright:** `timeout`과 `expect.timeout`을 3000으로 두고 `retries: 0`.
- **node --test:** `--test-timeout=2000`. 멈춘 시험이 러너를 붙잡지 않게 하는 감시견이다. 예산 자체는 보고된 시간으로 본다.

## 느리면: 시험이 아니라 로직을 고친다

**하지 않는 것:**
- 예산 늘리기, 시험 쪼개서 시간 나누기, 단언 줄이기, `skip`·`slow`로 빼기.
- 고정 시간 대기(`sleep`, 고정 timeout).

**하는 것:**
- **준비는 공통 픽스처로:** 콘텐츠 적재, 앱·DB 기동, 브라우저, 로그인 세션은 세션 범위로 한 번만 만든다. 각 시험은 트랜잭션 되돌리기나 복사본으로 격리한다.
- **일부러 느린 계산은 시험 설정에서 최소로:** 비밀번호 해셔는 MD5, 키 늘리기 반복 수는 최소로.
- **시간을 기다리지 않기:** 타이머·배경 작업 주기·만료는 시험 설정에서 최소로 두거나 시험이 직접 진행시킨다(가짜 시계, 「한 번 돌기」 호출). E2E라면 [fast-stable-e2e](../fast-stable-e2e/SKILL.md) 스킬을 본다.
- **느린 시험 찾기:** 러너의 시험별 시간부터 본다. `pytest --durations=10`, junit 시간이 그것이다.
- **흔들림 확인 반복:** 20~30번이면 충분하다. 재발은 CI가 잡는다.
- **잴 때는 혼자 잰다.** 다른 무거운 일(전체 시험, 다른 빌드, 다른 에이전트)과 겹치면 숫자가 2배까지 흔들린다. 병렬 일꾼 수는 CI와 같은 비율로 맞춰 잰다.

## 시험 DB·캐시는 시험용으로

- Postgres: `--tmpfs /var/lib/postgresql/data`, `-c fsync=off -c synchronous_commit=off -c full_page_writes=off`
- Redis: `--save '' --appendonly no`
- 같은 Postgres를 여러 작업 사본(워크트리)이 함께 쓰면, 시험 DB 이름에 사본별 꼬리표를 붙인다. 그래야 서로의 시험 DB를 지우지 않는다.
- 시험 DB를 여러 개 띄우면(일꾼마다, 서버 쌍마다) 마이그레이션을 매번 돌리지 않는다. 마이그레이션 내용의 해시로 이름 지은 템플릿 DB를 한 번 만들고(동시 생성은 advisory lock으로 막는다) `CREATE DATABASE … TEMPLATE <템플릿>`으로 복제한다. 한 프로젝트에서 잰 값: DB 하나 준비가 migrate·flush 7~9초에서 복제 한 번으로.

## 프런트 단위 시험: vitest 없이 node --test

- `.ts` 시험은 Node가 타입만 지워 그대로 돈다.
- `.tsx`(컴포넌트)는 [examples/tsx-loader.mjs](examples/tsx-loader.mjs)를 `--import`로 붙인다. 이 로더는 이미 devDependency인 TypeScript로 JSX만 풀고, CSS 같은 자산은 빈 모듈로 바꾼다. 새 의존성이 없다.
  ```json
  "test:unit": "node --test --test-timeout=2000 --import ./test/tsx.mjs \"src/**/*.test.ts\" \"src/**/*.test.tsx\""
  ```
- 컴포넌트는 `react-dom/server`의 `renderToStaticMarkup`으로 그려 글자·구조를 단언한다. DOM이 없으므로 `useEffect`는 돌지 않고 첫 그림만 본다.
- `tsconfig`의 앱 빌드에서는 `*.test.tsx`를 뺀다.
- 한 프로젝트에서 잰 값: `.tsx` 지원을 더한 뒤 프런트 단위 시험 전체 시간이 0.92초에서 1.08초로 늘었다. TypeScript를 처음 싣는 데 드는 값이다.
