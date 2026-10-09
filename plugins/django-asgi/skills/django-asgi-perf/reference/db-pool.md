# DB 연결 풀과 오래 열린 요청

## 왜 `CONN_MAX_AGE`가 ASGI에서 듣지 않나

Django의 DB 연결은 스레드 지역이다. ASGI에서 동기 ORM 호출은 `sync_to_async`로 스레드 풀에서 돌고, 요청이 끝나면 `request_finished` 신호가 연결을 닫거나 수명을 확인한다. 요청마다 다른 스레드에 앉으니, 지난 요청이 남긴 연결을 이번 요청이 받지 못한다. 그래서 `CONN_MAX_AGE`를 올리면 오히려 스레드마다 닫히지 않은 연결이 쌓일 수 있다.

## 처방: psycopg 연결 풀(Django 5.1+, psycopg 3)

```python
from psycopg_pool import ConnectionPool

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        # ...
        "OPTIONS": {
            "pool": {
                "min_size": 2,
                "max_size": 40,       # 프로세스 수 × max_size < Postgres max_connections(기본 100)
                "timeout": 10,        # 풀에서 기다리는 상한(초) — 마르면 여기서 터진다
                "check": ConnectionPool.check_connection,  # 꺼낼 때 살아 있는지(DB 재시작 뒤 죽은 연결 방지)
            }
        },
    }
}
```

- 풀을 쓰면 `CONN_MAX_AGE`는 0으로 둔다(함께 쓸 수 없다).
- `pip install "psycopg[pool]"`.
- 워커 프로세스를 여럿 띄우면 상한은 프로세스마다 따로 잡힌다. `max_size`는 프로세스 수를 생각해서 정한다.

## 오래 열린 요청은 연결을 바로 돌려준다

풀에서 꺼낸 연결은 보통 요청이 끝날 때 돌아간다. SSE·롱폴링처럼 몇 분씩 열린 요청은 그동안 연결을 쥐고 있어서, 동시 접속 수가 `max_size`를 넘으면 풀이 마른다. 그런 길에서는 DB를 만진 직후 그 스레드의 연결을 닫는다. 풀 연결에서 `close()`는 풀에 돌려준다는 뜻이다. → [../examples/db.py](../examples/db.py)

```python
async def stream(request):
    me = await released(load_user_state, request.user.id)   # 쓰고 바로 돌려준다
    async for message in subscribe(me.channel):              # 기다리는 동안 연결을 쥐지 않는다
        yield encode(message)
```

규칙:
- 오래 기다리기 전에는 `await release()`, 기다리는 동안의 DB 호출은 `released(fn, ...)`로 감싼다.
- 그냥 `sync_to_async(fn)`을 쓰면 그 스레드가 연결을 쥔 채 남는다.
- 요청 밖의 배경 태스크도 같다.
- 트랜잭션(`atomic`) 안에서는 닫지 않는다. pytest-django 시험이 트랜잭션 안에서 돌기 때문이다.

## 확인하는 시험

- 오래 열린 길을 흉내 낸다. 풀 `max_size`보다 많은 동시 「DB 한 번 쓰고 오래 기다리기」를 띄운다. 그동안 보통 DB 호출이 `timeout` 안에 성공하는지 본다.
- `release`를 빼면 실패하는지도 확인한다. 시험이 실제로 무언가를 잡는지 보려는 것이다.
