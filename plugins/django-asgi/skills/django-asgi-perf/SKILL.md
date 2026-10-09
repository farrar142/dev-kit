---
name: django-asgi-perf
description: Django를 ASGI(uvicorn·daphne·hypercorn)로 돌릴 때의 성능·정합성 점검표와 처방. 요청이 느리다, DB 연결이 요청마다 새로 맺힌다, 연결 풀이 마른다, SSE·롱폴링·웹소켓처럼 오래 열린 요청이 있다, async 뷰·미들웨어를 쓴다, 실시간 스트림이 갱신을 잃거나 두 번 보낸다, ASGI에서 요청이 서로를 기다리며 멈춘다 — 이런 Django ASGI 작업에 쓴다.
---

# Django + ASGI 성능·정합성

ASGI 아래의 Django는 WSGI와 다르게 움직이는 곳이 몇 군데 있다. 아래 점검표를 위에서부터 보고, 걸리는 항목의 참고 문서를 연다. 각 항목은 실제 프로젝트에서 측정·재현한 것이다.

## 점검표

| # | 증상 | 원인 | 처방 | 참고 |
|---|---|---|---|---|
| 1 | 로그인한 요청마다 10~20ms가 더 붙는다. `pg_stat_activity`의 새 세션이 요청 수만큼 늘어난다 | ASGI에서는 요청의 동기 부분이 매번 다른 스레드에서 돈다. 연결은 스레드에 묶이고 요청 끝에 닫히므로 **`CONN_MAX_AGE`를 올려도 재사용되지 않는다** | Django 5.1+ psycopg 연결 풀(`DATABASES[...]["OPTIONS"]["pool"]`) | [reference/db-pool.md](reference/db-pool.md) |
| 2 | 연결 풀을 켠 뒤, 동시 접속이 늘면 `PoolTimeout`이 나거나 요청이 멈춘다 | SSE·롱폴링·MCP 기다리기처럼 몇 분씩 열린 요청이 DB를 한 번 만진 뒤 연결을 끝까지 쥔다 | DB를 쓴 직후 그 스레드의 연결을 풀에 돌려준다(`release()`·`released()`) | [reference/db-pool.md](reference/db-pool.md), [examples/db.py](examples/db.py) |
| 3 | 요청이 가끔 끝없이 멈춘다. 스택을 보면 `sync_to_async`·`CurrentThreadExecutor`가 서로를 기다린다 | sync 전용 미들웨어가 async 사슬에 끼면 요청마다 `async_to_sync`가 실행기를 새로 세운다. 그 요청에서 띄운 태스크가 요청이 끝난 뒤 그 실행기를 물려받아 교착한다 | 미들웨어를 sync·async 둘 다 받게 쓴다 | [reference/async-middleware.md](reference/async-middleware.md), [examples/middleware.py](examples/middleware.py) |
| 4 | SSE에서 접속 직후 1틱(1초) 안의 갱신이 화면에 닿지 않는다. 다음 갱신 때 따라잡는다 | 스트림이 「스냅샷과 같은 시각 이하」를 이미 받은 것으로 보고 버린다. 틱을 기다리지 않고 바로 발행하는 갱신은 스냅샷과 시각이 같다 | 스냅샷을 읽는 자리에서 같은 채널에 울타리 메시지를 내고, 울타리 앞의 것만 버린다 | [reference/sse-snapshot-fence.md](reference/sse-snapshot-fence.md) |
| 5 | 가입·로그인이 들어간 시험·E2E가 느리다 | 운영 비밀번호 해셔가 일부러 느리다(한 번에 0.8초) | 시험·E2E 설정에서만 빠른 해셔 | 아래 「시험 설정」 |

## 시험 설정에서 빠르게

- `PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]`는 시험·E2E 설정에만 둔다. 운영에는 두지 않는다.
- 시험 Postgres는 `--tmpfs` 위에 두고 `fsync=off`. 컨테이너 안에서만 쓰면 `POSTGRES_HOST_AUTH_METHOD=trust`.
- 아웃박스나 배경 적용기의 주기(예: 1초)가 E2E 화면 대기에 그대로 더해진다. E2E 설정에서는 주기를 0.05초 정도로 줄인다.
- 연결 풀은 시험 설정에서도 켜 둔다. 운영과 다른 연결 수명으로 시험하면 #2 같은 문제를 못 잡는다. pytest의 트랜잭션 안에서는 연결을 닫지 않는다(`connection.in_atomic_block` 확인).

## 측정하는 법

- **요청 하나:** 같은 끝점을 20번 불러 중앙값을 본다. 첫 번째 값은 버린다.
- **새 연결 수:** 요청 N번 전후의 Postgres 세션 수를 비교한다. `select count(*) from pg_stat_activity where datname=...`, 또는 `backend_start`가 측정 시작 뒤인 행을 센다.
- **고갈:** 오래 열린 요청을 풀 상한의 두 배쯤 열어 둔다. 그 상태에서 보통 요청 20번이 모두 200이고 지연이 늘지 않는지, 세션 수가 상한에서 멈추는지 본다(프로세스 수 × `max_size` < Postgres `max_connections`).
- 고치기 전과 뒤의 숫자를 PR 본문에 적는다.
