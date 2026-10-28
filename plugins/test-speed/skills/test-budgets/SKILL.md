---
name: test-budgets
description: 시험 하나마다 시간 한도(로직 0.5초·백엔드 1초·E2E 3초)를 두고 러너에서 강제하는 법 — 백엔드는 CPU 초로 재고 junit에 cpu_seconds를 남기기, 느린 시험 찾기(junit·durations), 시험이 아니라 원인(비밀번호 해시·서브프로세스·첫 요청 부팅·시험 DB 마이그레이션·xdist)을 고쳐 빠르게, 고정 대기를 사건 기다리기로, 재시도 0·flaky를 덮지 않기, 한도를 처음 켜는 순서와 올리는 규칙, 전체 시험은 CI에서, 프런트 단위 시험을 node --test로. 시험이 느리다, CI가 오래 걸린다, 한도·타임아웃을 정하거나 강제한다, 시험이 가끔 떨어진다, sleep·waitForTimeout을 없앤다, 시험 문서(testing.md)를 새 저장소에 세운다 — 이럴 때 쓴다.
---

# 시험 시간 한도

시험 하나마다 **시간 한도**를 걸고, 넘으면 한도를 올리지 않고 원인을 줄인다.

## 한도

| 층 | 거치는 것 | 시험 하나 | 강제 |
|---|---|---|---|
| 로직 | 순수 함수만(네트워크·DB 없음) | 0.5초 | 백엔드와 같은 훅 |
| 백엔드 | HTTP·DB·발행 같은 서버 경계 | 1초 (CPU 초) | [examples/conftest_cpu_budget.py](examples/conftest_cpu_budget.py) |
| E2E | 브라우저로 화면을 끝까지 | 3초, 앞뒤 걸이 포함 | `timeout: 3_000`, `retries: 0` ([examples/playwright.config.snippet.ts](examples/playwright.config.snippet.ts)) |
| 프런트 단위(vitest) | | 정하지 않음 | 벽시계뿐이라 부하에 부푼다. 분포를 재고 저장소 주인과 정한다 → [reference/vitest.md](reference/vitest.md) |

- 한 시험이 두 층에 걸치면 더 바깥 층으로 친다. HTTP를 한 번이라도 거치면 백엔드다.
- 예산에서 빠지는 것은 `slow` 표지 하나뿐이다. PR CI가 돌리지 않는 느린 층(정기 빌드)에서만 돈다(수만 회 반복하는 시뮬레이션·속성 시험).
- 1.0/0.5/3초는 한 프로젝트에서 정한 값이지 보편 상수가 아니다. 새 저장소는 분포를 재고 정한다(아래 「처음 켜는 순서」).
- 저장소 문서 틀: [templates/testing.md](templates/testing.md).

## 재는 법

- **백엔드는 CPU로 잰다, 벽시계가 아니다.** 붐비는 러너에서 벽시계로 잰 한도 근처 시험은 빌드마다 번갈아 떨어진다. CPU는 일의 양에 가깝다. `time.process_time()`(이 프로세스) + `RUSAGE_CHILDREN`(자식의 user+sys)을 더해 서브프로세스를 띄우는 시험이 공짜로 빠지지 않게 한다.
  - 형제 하이퍼스레드가 바쁘면 같은 일에도 CPU가 1.6~2배 든다(부하 15에서 0.6초짜리가 1.1초). 그래서 조용한 기계의 목표는 한도의 절반(0.5초)이고, CI에는 환경변수로 보정값(예: 1.5)을 준다.
  - DB 서버가 질의를 처리하는 시간은 다른 프로세스라 안 잡힌다. 느린 질의는 DB 로그·`EXPLAIN`으로 따로 본다.
  - 기다림이 많은 시험이 대부분인 저장소면 벽시계(함수 범위 픽스처 + 본문)로 잴 수도 있다: [examples/conftest_budget.py](examples/conftest_budget.py).
- **본문(call)만 잰다.** 여러 시험이 같은 비싼 준비를 하면 모듈·세션 픽스처로 옮긴다. 그것이 곧 최적화다.
- 시험마다 CPU 초를 junit 속성 `cpu_seconds`로 남긴다. **junit `time`은 setup·teardown 포함, `cpu_seconds`는 본문만이다.** `time`은 큰데 `cpu_seconds`가 작으면 본문 CPU가 아니라 준비·대기다 — `pytest --durations=20 --durations-min=0.5`로 setup/call/teardown을 나눠 본다. 첫 시험의 setup이면 시험 DB 생성·마이그레이션(한 프로젝트에서 `time` 7.5초, `cpu_seconds` 0.02초), call이면 본문 안의 `sleep`·네트워크 대기다.
- 보는 법: `python3 examples/junit_slowest.py <junit.xml> [N] [임계]`.
- **훅이 일하는지 확인한다**: `TEST_CPU_LIMIT=0.001 pytest <시험 하나>`가 **실패**해야 한다. 통과하면 훅이 conftest에 안 닿은 것이다(rootdir 밖 conftest, 플러그인 이름 충돌). `grep cpu_seconds <junit.xml>`도 본다. Windows에서는 `resource`가 없어 자식 프로세스 몫을 세지 못하고 시계 눈금이 약 15ms라, 확인에는 CPU를 0.1초쯤 쓰는 시험을 고른다.
- **잴 때는 혼자 잰다.** 다른 무거운 일(전체 시험, 다른 빌드, 다른 에이전트)과 겹치면 숫자가 2배까지 흔들린다. 병렬 일꾼 수는 CI와 같은 비율로 맞춘다.

## 빨리 만드는 기법 — 이 순서로 의심한다

한 프로젝트가 처음 한도를 걸었을 때 340건이 넘었고 원인은 대부분 앞의 셋이었다. 같은 원인이 수십 건이면 시험 하나씩 고치지 말고 원인 한 곳을 고친다(해시 한 줄이 281건을 없앴다).

1. **비밀번호 해시.** 로그인·계정 생성마다 PBKDF2·bcrypt가 돌아 시험 하나가 0.5~1초를 쓴다. 시험 설정에서만 가장 빠른 해셔(Django `MD5PasswordHasher`, bcrypt rounds 최소)로. 운영 해시가 그대로인지 지키는 시험을 하나 둔다. 이것 하나로 340건 → 59건, 전체 106초 → 66초.
2. **서브프로세스 기동.** 시험마다 새 인터프리터를 띄우면 import만으로 1초가 간다. 무거운 모듈을 미리 읽어 둔 forkserver 자식에서 돌리거나, 프로세스 안에서 부른다.
3. **필요보다 큰 데이터.** 상한(50)을 보려고 53개를 만들던 시험은 상한을 설정으로 2로 줄인다.
4. **첫 요청 부팅 비용.** URLconf·라우터 스키마를 첫 요청에서 만드는 프레임워크는 워커마다 처음 요청한 시험 하나가 그 값(0.5초+)을 혼자 내고, 어느 시험일지는 실행마다 달라 빌드마다 다른 시험이 떨어진다. 세션 autouse 픽스처로 미리 치른다: [examples/conftest_preload_urlconf.py](examples/conftest_preload_urlconf.py). FastAPI는 앱 import와 `app.openapi()`.
5. **시험 DB 마이그레이션.** 워커마다 시험 DB를 마이그레이션하면 그 값이 첫 시험 setup에 붙는다. 템플릿 DB를 한 번 마이그레이션하고 `CREATE DATABASE … TEMPLATE`으로 복제한다(워커당 약 0.5초): [examples/conftest_django_db_template.py](examples/conftest_django_db_template.py)(PostgreSQL). `--reuse-db`·`--no-migrations`는 묵은 스키마를 남기니 쓰지 않는다. MySQL·psql 없는 기계·정리 실패는 [reference/db.md](reference/db.md).
6. **병렬(xdist).** `-n auto`가 기본, 직렬은 `-n 0`(한 프로젝트 1,192건: `-n 4` 84초 → `-n auto` 57초). 시험끼리 상태를 안 밟아야 한다 — 시험 DB 이름은 워커·체크아웃별로 파생, 세션·캐시 백엔드는 프로세스 안 메모리, 클래스 수준 가짜 어댑터는 autouse 픽스처로 비운다.
7. **시험과 무관한 비싼 부수 작업은 시험에서만 끈다**(시도마다 문법 검사 프로세스를 띄우던 채점 시험 등).
8. **타이머·주기·만료는 시험이 쥔다.** 시험 설정에서 최소로 두거나 가짜 시계·「한 번 돌기」 호출로 진행시킨다.

시험 DB·캐시는 시험용으로 띄운다: Postgres `--tmpfs /var/lib/postgresql/data -c fsync=off -c synchronous_commit=off -c full_page_writes=off`, Redis `--save '' --appendonly no`.

## 넘는 시험을 고치는 순서

1. `cpu_seconds`/`time`으로 **본문이 느린지 준비·대기가 느린지** 가른다.
2. 본문이면 위 1→8로 의심하고 프로파일(`cProfile`, `--durations`)로 확인한다. 원인을 짐작해 고치지 않는다 — E2E면 trace로 시험별 시간부터 잰다.
3. 시험이 정말 두 가지를 보고 있으면 쪼갠다. 시간을 나누려고 쪼개지는 않는다.
4. 그래도 안 되면 설계를 본다. 어느 층의 일인가, 이 시험에 필요한가.

## 기다림과 흔들림

- **고정 대기(`sleep`, `waitForTimeout`, 고정 timeout)를 쓰지 않는다.** 기다릴 사건(응답, 요소, 이동, 메시지)을 기다린다 → [reference/waiting-for-events.md](reference/waiting-for-events.md). Playwright 사건 도우미는 [fast-stable-e2e](../fast-stable-e2e/SKILL.md).
- **재시도는 0이다. 흔들리는 시험을 재시도·`toPass`·「일시적」 재실행으로 덮지 않는다.** CI 재시도 1회가 30초 타임아웃을 초록으로 덮어 아무도 못 본 적이 있다. 흔들리면 그 자리에서 원인을 고친다.
- 같은 한도 시험이 두 번 연달아 빨강이면 재실행하지 않는다. 그 PR을 세우고 최적화를 먼저 한다.
- 흔들림을 고쳤다는 증거는 부하 아래 반복 20~30번이면 충분하다. 재발은 CI가 잡는다.
- 같은 스택 반복에서만 나는 실패는 대개 준비 쪽이다(고정 계정에 쌓이는 하루 한도, 겹치는 고유 이름). 시험마다 새 사람·새 이름을 쓴다.

## 어디서 무엇을 돌리나

- **작업 중에는 바꾼 자리의 시험만, 전체 시험은 CI에서.** 실패하면 그 시험만 좁혀(`-k`, `-x`, `-g`) 다시 돌린다. 로컬 전체 시험은 커밋 직전에 한 번이면 된다.
- 단 프런트를 바꿨으면 그 앱의 단위 시험 전체는 로컬에서 돈다(파일 자리·설정을 읽는 구조 시험을 놓친다). 새 E2E는 단독뿐 아니라 전체 E2E 안에서도 통과시킨다(시험끼리 나눠 쓰는 상태가 깨진다).
- 한 기계를 여러 에이전트가 나눠 쓰면 `-n auto` 전체 시험을 동시에 돌리지 않는다. 코어를 서로 뺏어 한도 시험이 떨어진다. 저장소가 시험 입구 스크립트로 동시 실행 수·코어를 묶는 것도 방법이다.
- PR CI가 돌리지 않는 층(정기 빌드의 E2E·느린 시험)이 바꾼 흐름을 덮으면 병합 뒤 그 잡을 바로 돌려 본다.

## 한도를 올리고 싶을 때

- 마지막 수단이고 저장소 주인의 결정이다. 작업자 판단으로 올리지 않는다.
- 붐비는 환경 보정은 값 하나가 아니라 **환경변수로 환경별로**(로컬 1.0, CI 1.5). 시험 하나만 올리는 표지·시험별 한도는 만들지 않는다 — 예외는 쌓인다. E2E 스펙에서 `test.setTimeout`·`test.slow`로 한도를 바꾸지 않는다.
- 올릴 때는 그 시험의 `cpu_seconds` 분포(여러 번 돌린 값)와 근거를 PR에 적는다.

## 처음 켜는 순서

**먼저 재고, 넘는 시험을 고친 뒤 켠다.** 켜는 순간 관문이 붉으면 모든 PR이 막힌다.

1. **측정만 켠다.** `conftest_cpu_budget.py`를 붙이고 `_DEFAULT_LIMIT`을 `"0"`(끔)으로 둔다. `--junitxml`을 더하고 CI가 있으면 junit을 산출물로 남긴다. 훅 확인을 한다.
2. **분포를 본다.** `junit_slowest.py`로 한도와 목표를 넘는 시험 수를 센다. 붐빌 때와 조용할 때를 비교한다.
3. **넘는 시험을 고친다.** 원인 한 곳이 여러 건을 없애는지부터. PR마다 남은 건수를 적는다. 넘는 시험이 0건이면 1단계와 4단계를 한 PR로 합쳐도 된다.
4. **한도를 켠다.** CI가 시험을 돌리면 CI에 현재 최댓값보다 약간 높은 값을 주고 단계마다 내려 1.0으로 간다. 관문이 로컬 명령(`make check`)이면 기본값을 바로 1.0으로 켜고 `TEST_CPU_LIMIT ?= 1.0`처럼 덮어쓸 수 있게 둔다.
5. **E2E는 `timeout: 3_000`으로 바꾸기 전에** Playwright JSON/list 리포트로 분포를 본다. 3초를 넘는 시험을 먼저 고친다(준비는 화면이 아니라 API로, 로그인 비용을 줄여서, 고정 대기를 사건으로). 재시도 0은 같은 PR에서.
6. **요약을 저장소 문서에 남긴다**: 한도, 환경변수 이름, 올리는 규칙, junit 보는 법.

| 공통 | 저장소마다 다른 것 |
|---|---|
| CPU 훅 + `cpu_seconds` | 환경변수 이름, CI에 줄 값, junit 경로 |
| xdist, 상태 격리 | 시험 DB 이름 파생, 세션·캐시 백엔드 |
| 첫 요청 부팅을 세션 픽스처로 | Django는 URLconf, FastAPI는 앱 import·`app.openapi()` |
| Playwright `timeout`·`retries`·`trace` | 앱 기동 방식, 워커 수 상한(메모리), 시드 방식 |
| 비밀번호 해시를 시험에서만 싸게 | 해시 설정 위치 |

FastAPI는 시험 DB를 만드는 방식(alembic·`create_all`)이 저장소마다 달라 템플릿 복제 조각을 그대로 못 붙인다. 같은 생각(한 번 만들고 복제)을 그 저장소의 DB 준비 픽스처에 맞춰 새로 쓴다. E2E가 없는 저장소(API·라이브러리·CLI)는 백엔드 한도만 건다.

## 프런트 단위 시험: vitest 없이 node --test

- `.ts` 시험은 Node가 타입만 지워 그대로 돈다. `.tsx`는 [examples/tsx-loader.mjs](examples/tsx-loader.mjs)를 `--import`로 붙인다. 이미 devDependency인 TypeScript로 JSX만 풀고 CSS 같은 자산은 빈 모듈로 바꾼다. 새 의존성이 없다.
  ```json
  "test:unit": "node --test --test-timeout=2000 --import ./test/tsx.mjs \"src/**/*.test.ts\" \"src/**/*.test.tsx\""
  ```
- `--test-timeout=2000`은 멈춘 시험이 러너를 붙잡지 않게 하는 감시견이다. 한도 자체는 보고된 시간으로 본다.
- 컴포넌트는 `react-dom/server`의 `renderToStaticMarkup`으로 그려 글자·구조를 단언한다. DOM이 없으므로 `useEffect`는 돌지 않고 첫 그림만 본다. 앱 빌드의 `tsconfig`에서는 `*.test.tsx`를 뺀다.
- 한 프로젝트에서 잰 값: `.tsx` 지원을 더한 뒤 프런트 단위 시험 전체가 0.92초 → 1.08초(TypeScript를 처음 싣는 값).

## 붙일 조각 (`examples/`)

- `conftest_cpu_budget.py` — CPU 한도 훅 + junit `cpu_seconds`(기본값). 한도 0.001로 실제 pytest를 돌려 실패로 바뀌는 것까지 확인했다.
- `conftest_budget.py` — 벽시계 방식(함수 범위 픽스처 + 본문, 로직·백엔드 두 한도). 기다림이 많은 저장소용.
- `conftest_django_db_template.py` — Django + pytest-django + xdist + PostgreSQL 시험 DB 템플릿 복제. 타입만 확인했다 — 붙인 뒤 `-n 0`과 `-n 2`로 한 번씩 돌린다.
- `conftest_preload_urlconf.py` — 첫 요청 부팅 비용 미리 치르기(Django).
- `junit_slowest.py` — junit에서 느린 시험과 준비가 느린 후보 뽑기. `cpu_seconds`가 없으면(vitest) `time` 기준.
- `playwright.config.snippet.ts` — `timeout: 3_000`, `retries: 0`, `trace: "retain-on-failure"`, 워커 환경변수.
- `tsx-loader.mjs` — node --test용 `.tsx` 로더.
