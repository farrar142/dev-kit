"""오래 열린 요청(SSE·롱폴링·MCP 기다리기)의 DB 연결 돌려주기.

연결 풀(`DATABASES[...]["OPTIONS"]["pool"]`)에서 꺼낸 연결은 보통 요청 끝에 돌아간다. 몇 분씩 열린
요청은 그동안 연결을 쥐어 풀을 말린다 — DB를 만진 직후 돌려준다. 풀 연결의 `close()`는 풀에 돌려주기다.
원자 블록 안(pytest-django 시험의 트랜잭션)에서는 닫지 않는다.

쓰는 법:
    me = await released(load_state, user_id)   # sync_to_async(load_state)(user_id) 대신
    await release()                             # 오래 기다리기 직전, 이 요청 스레드가 쥔 연결을 돌려준다
"""

from collections.abc import Callable

from asgiref.sync import sync_to_async
from django.db import connection


def _release() -> None:
    if not connection.in_atomic_block:
        connection.close()


async def release() -> None:
    """지금 요청(동기 스레드)이 쥔 연결을 풀에 돌려준다."""
    await sync_to_async(_release)()


async def released[T](fn: Callable[..., T], *args, **kwargs) -> T:
    """`sync_to_async(fn)(...)`처럼 부르고, 끝나면 그 스레드의 연결을 돌려준다."""

    def run() -> T:
        try:
            return fn(*args, **kwargs)
        finally:
            _release()

    return await sync_to_async(run)()
