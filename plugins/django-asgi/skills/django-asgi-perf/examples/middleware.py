"""sync·async 둘 다 받는 미들웨어 틀.

sync 전용 미들웨어가 ASGI의 async 사슬에 끼면 요청마다 async→sync→async 어댑터가 서고
(`async_to_sync`가 `CurrentThreadExecutor`를 새로 세운다), 요청 안에서 띄운 태스크가 그 실행기를
물려받아 요청이 끝난 뒤 교착할 수 있다. 둘 다 받게 써서 어댑터를 없앤다.
"""

from asgiref.sync import iscoroutinefunction, markcoroutinefunction


class BothModesMiddleware:
    sync_capable = True
    async_capable = True

    def __init__(self, get_response):
        self.get_response = get_response
        if iscoroutinefunction(get_response):
            markcoroutinefunction(self)

    def __call__(self, request):
        if iscoroutinefunction(self):
            return self.__acall__(request)
        return self.short_circuit(request) or self.get_response(request)

    async def __acall__(self, request):
        return self.short_circuit(request) or await self.get_response(request)

    def short_circuit(self, request):
        """DB·네트워크를 만지지 않는 판정만 여기서 한다(만져야 하면 async 쪽에서 `sync_to_async`로).
        응답을 돌려주면 사슬을 끊고, None이면 다음으로 넘긴다."""
        return None
