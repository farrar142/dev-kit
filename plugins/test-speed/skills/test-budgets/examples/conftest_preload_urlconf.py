"""첫 요청 부팅 비용을 워커마다 시험 전에 한 번 치른다 (Django). conftest.py 에 붙인다.

Django 는 URLconf 를 첫 요청에서야 읽는다. 라우터가 많으면 그 한 번이 CPU 0.5초를 넘어,
워커마다 처음 요청을 보낸 시험 하나가 혼자 내고 CPU 한도에 걸린다 — 어느 시험이 처음일지는
실행마다 달라 빌드마다 다른 시험이 떨어진다. 세션 픽스처는 준비 단계라 한도가 재지 않는다.
FastAPI 라면 같은 자리에서 앱 import(`from app.main import app`)와 OpenAPI 생성(`app.openapi()`)을 미리 한다.
"""

import pytest


@pytest.fixture(scope="session", autouse=True)
def _load_urlconf_before_any_test() -> None:
    from django.urls import get_resolver

    assert get_resolver().url_patterns  # 읽는 것 자체가 목적이다 — 적재를 일으킨다
