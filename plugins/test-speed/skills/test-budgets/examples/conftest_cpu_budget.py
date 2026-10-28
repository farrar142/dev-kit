"""pytest 시험 하나의 CPU 한도 — conftest.py 에 붙인다.

- 시험 본문(call 단계)의 CPU 시간 = 이 프로세스 + 자식 프로세스. 벽시계가 아니다.
- 한도를 넘고 통과한 시험은 실패로 바꾼다. 준비(setup)·정리(teardown)는 재지 않는다.
- 시험마다 CPU 초를 junit 의 속성 `cpu_seconds` 로 남긴다 (`--junitxml=<경로>` 로 돌릴 때).
- 한도: 환경변수 TEST_CPU_LIMIT (초), 0 이면 끈다. 기본값은 아래 `_DEFAULT_LIMIT`.
  처음 측정만 켜는 PR 에서는 "0" 으로 두고, 한도를 켜는 PR 에서 "1.0" 으로 바꾼다 (SKILL.md 「처음 적용하는 절차」).
- 타입: `python3 -m mypy --strict --ignore-missing-imports` 통과 (스텁 없는 import 만 무시).
  pytest 9 이상은 `pytest.StashKey`·`pytest.TestReport` 를 최상위에서 낸다 (8 이하는 `_pytest.stash.StashKey`).
"""

import os
import sys
import time
from collections.abc import Generator

import pytest

_DEFAULT_LIMIT = "1.0"  # 측정 PR 에서는 "0"
_CPU_LIMIT_SECONDS = float(os.environ.get("TEST_CPU_LIMIT", _DEFAULT_LIMIT))

# item 에 속성을 붙이지 않고 stash 에 둔다 — mypy 가 속성 대입을 막고, stash 는 타입이 있다.
_spent_key = pytest.StashKey[float]()


def _extra_charged_cpu_seconds() -> float:
    """자식 프로세스 중 `RUSAGE_CHILDREN` 에 안 잡히는 몫이 있으면 여기서 더한다.

    예: multiprocessing forkserver 의 자식은 이 프로세스의 자식이 아니다 — 자식이 자기 사용량을
    돌려주게 해서 합산한다.
    그런 것이 없으면 0.0 그대로 둔다.
    """

    return 0.0


def _children_cpu_seconds() -> float:
    # Windows 에는 resource 모듈이 없다 — 그때는 자식 몫을 세지 못하고 이 프로세스 몫만 잰다.
    if sys.platform == "win32":
        return 0.0
    import resource

    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return children.ru_utime + children.ru_stime


def _cpu_seconds() -> float:
    return time.process_time() + _children_cpu_seconds() + _extra_charged_cpu_seconds()


@pytest.hookimpl(wrapper=True)
def pytest_runtest_call(item: pytest.Item) -> Generator[None, None, None]:
    started = _cpu_seconds()
    try:
        return (yield)
    finally:
        item.stash[_spent_key] = _cpu_seconds() - started


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(
    item: pytest.Item, call: pytest.CallInfo[None]
) -> Generator[None, pytest.TestReport, pytest.TestReport]:
    report = yield
    spent = item.stash.get(_spent_key, None)
    if report.when == "call" and spent is not None:
        # junitxml 은 teardown 보고서의 user_properties 를 쓰고, pytest 는 보고서마다 item 의
        # 목록을 복사한다 — item 과 report 양쪽에 넣어야 junit 에 남는다.
        item.user_properties.append(("cpu_seconds", round(spent, 3)))
        report.user_properties.append(("cpu_seconds", round(spent, 3)))
        if _CPU_LIMIT_SECONDS > 0 and spent > _CPU_LIMIT_SECONDS and report.passed:
            report.outcome = "failed"
            report.longrepr = (
                f"시험 본문이 CPU {spent:.2f}초를 썼다 — 한도 {_CPU_LIMIT_SECONDS:g}초"
                " (TEST_CPU_LIMIT). 원인을 찾아 줄인다; 한도를 늘리지 않는다."
            )
    return report
