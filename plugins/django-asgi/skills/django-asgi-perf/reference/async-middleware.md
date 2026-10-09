# async 사슬의 sync 전용 미들웨어

## 증상

ASGI에서 요청이 드물게 끝없이 멈춘다. 스레드 덤프(`py-spy dump`)를 보면 `CurrentThreadExecutor.run_until_future`와 `sync_to_async`가 서로를 기다린다. 요청 안에서 태스크(`asyncio.create_task`)를 띄우는 코드가 있으면 더 잘 난다.

## 원인

Django는 미들웨어 사슬을 만들 때 각 미들웨어가 sync인지 async인지 본다. sync 전용 미들웨어(`sync_capable=True, async_capable=False`, 기본값)가 async 사슬 중간에 끼면 Django가 어댑터를 넣는다. 그러면 요청마다 async → sync(`async_to_sync`) → async로 바뀐다. `async_to_sync`는 호출마다 `CurrentThreadExecutor`를 새로 세운다. 그 요청에서 띄운 태스크는 contextvars로 그 실행기를 물려받는다. 요청이 끝난 뒤 그 태스크가 `sync_to_async`를 부르면 바깥 실행기로 올라가는데, 그 스레드가 다음 요청에서 기다리고 있으면 서로를 기다린다.

어댑터 비용(요청마다 스레드 왕복)도 따로 붙는다.

## 처방

미들웨어를 sync·async 둘 다 받게 쓴다. → [../examples/middleware.py](../examples/middleware.py)

- `sync_capable = True`, `async_capable = True`
- `__init__`에서 `get_response`가 코루틴이면 `markcoroutinefunction(self)`
- `__call__`은 코루틴 모드면 `__acall__`을 돌려준다

사슬 전체가 async여야 어댑터가 사라진다. `settings.MIDDLEWARE`의 서드파티 미들웨어도 확인한다. `django.core.handlers.base`의 디버그 로그(`Asynchronous handler adapted for middleware ...`)를 켜면 어댑터가 끼는 미들웨어가 찍힌다.

## 확인

- `logging.getLogger("django.request")` DEBUG에서 「adapted」 줄이 없어야 한다.
- 시험: async 클라이언트(`AsyncClient`)로 그 미들웨어를 지나는 요청이 같은 이벤트 루프에서 끝나는지. 재현 시험은 요청 안에서 태스크를 띄우고, 요청이 끝난 뒤 그 태스크가 `sync_to_async`를 부르게 한다.
