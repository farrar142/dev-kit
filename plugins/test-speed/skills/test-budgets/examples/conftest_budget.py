"""시험 하나 시간 예산을 pytest에서 강제한다 — 루트 conftest.py에 붙인다.

예산 = 함수 범위 픽스처 준비 + 본문. 세션·모듈 픽스처 준비는 세지 않는다(공통 픽스처로 옮기면 빨라진다).
DB·HTTP 픽스처를 쓰면 백엔드 예산, 아니면 로직 예산. `@pytest.mark.slow`는 예산에서 빠진다(PR CI가 돌리지 않는 느린 층 전용).
넘으면 통과한 시험도 실패로 바꾼다 — 고치는 쪽은 시험이 아니라 로직이다.
"""

import time
from collections.abc import Iterator

import pytest

LOGIC_BUDGET = 0.5
BACKEND_BUDGET = 1.0
# 이 픽스처를 하나라도 쓰면 백엔드로 친다 — 저장소에 맞게 더한다(예: "api_client", "live_server")
BACKEND_FIXTURES = {"db", "transactional_db", "client", "async_client", "django_db_setup"}
SPENT = pytest.StashKey[float]()


def budget_of(item: pytest.Item) -> float:
    if item.get_closest_marker("slow"):
        return float("inf")
    names = set(getattr(item, "fixturenames", ()))
    if names & BACKEND_FIXTURES or item.get_closest_marker("integration"):
        return BACKEND_BUDGET
    return LOGIC_BUDGET


@pytest.hookimpl(wrapper=True)
def pytest_fixture_setup(fixturedef, request) -> Iterator[None]:
    """함수 범위 픽스처의 준비 시간만 예산에 센다."""
    started = time.perf_counter()
    try:
        return (yield)
    finally:
        if fixturedef.scope == "function":
            node = request.node
            node.stash[SPENT] = node.stash.get(SPENT, 0.0) + time.perf_counter() - started


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo):
    report = yield
    if call.when == "call" and report.passed:
        spent = item.stash.get(SPENT, 0.0) + call.duration
        budget = budget_of(item)
        if spent > budget:
            report.outcome = "failed"
            report.longrepr = (
                f"시간 예산 초과: {spent:.2f}초 > {budget}초 (함수 범위 픽스처 준비 + 본문). "
                "시험이 아니라 로직을 최적화한다."
            )
    return report
