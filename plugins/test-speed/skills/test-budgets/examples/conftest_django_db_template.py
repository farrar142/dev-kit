"""Django + pytest-django + xdist: 시험 DB 를 워커마다 마이그레이션하지 않고 템플릿에서 복제한다.

한 프로젝트의 시험 DB 템플릿 모듈과 conftest 를 한 파일로 줄여 일반화한 것.
PostgreSQL 전용 (`CREATE DATABASE … TEMPLATE`). 이 파일째 conftest.py 에 합치거나 `tests/db_template_plugin.py`
로 두고 conftest 에서 `pytest_plugins = ["tests.db_template_plugin"]` 로 부른다.

적용 전에 확인: 이 조각은 `mypy --strict --ignore-missing-imports` 로 타입만 확인했다(django·pytest-django·
xdist·psycopg 를 설치한 환경에서 통과; 스텁이 없으면 import 오류가 나므로 무시한다). 동작은 확인하지 않았다. 새 저장소에서는 `-n 0` 과 `-n 2` 둘 다로 돌려
(1) 시험이 서고 (2) 세션 뒤 `_tpl` DB 가 남지 않는지(`\\l`) 본다.

동작:
- xdist 컨트롤러가 워커를 띄우는 동안(`pytest_sessionstart`, trylast) 템플릿 DB `<시험DB이름>_tpl` 을 한 번
  만들고 마이그레이션한다. 워커는 그동안 수집한다.
- 워커의 `django_db_setup` 은 `CREATE DATABASE <워커DB> TEMPLATE <템플릿>` 로 복제한다 (1초 미만).
- 누가 먼저 만드나는 Postgres 자문 잠금이, 지난 실행의 템플릿이 아닌가는 DB COMMENT 에 적은 세션 표가 가른다.
- `--reuse-db`·`--no-migrations` 는 막는다 (묵은 스키마를 쓰지 않으려고).
"""

import uuid
from collections.abc import Generator
from typing import Any

import pytest
from django.db import connections

TEMPLATE_SUFFIX = "_tpl"
WORKERINPUT_KEY = "db_template_token"
_CONTROLLER_TOKEN = uuid.uuid4().hex


def session_token(config: pytest.Config) -> str:
    workerinput = getattr(config, "workerinput", None)
    if workerinput:
        return str(workerinput[WORKERINPUT_KEY])
    return _CONTROLLER_TOKEN


def template_db_name(test_db_name: str, worker_id: str | None) -> str:
    base = test_db_name
    if worker_id and base.endswith(f"_{worker_id}"):
        base = base[: -len(worker_id) - 1]
    return base + TEMPLATE_SUFFIX


def _build_template(template: str, verbosity: int) -> None:
    """Django 의 보통 길(create_test_db: CREATE → migrate)을 템플릿 이름으로 한 번 돈다."""

    from django.conf import settings

    conn = connections["default"]
    old_name = conn.settings_dict["NAME"]
    old_test_name = conn.settings_dict["TEST"]["NAME"]
    with conn._nodb_cursor() as cursor:
        cursor.execute(f"DROP DATABASE IF EXISTS {conn.ops.quote_name(template)}")
    conn.settings_dict["TEST"]["NAME"] = template
    try:
        conn.creation.create_test_db(verbosity=verbosity, autoclobber=True, serialize=False)
    finally:
        conn.settings_dict["TEST"]["NAME"] = old_test_name
        conn.close()  # 템플릿에 연결이 남아 있으면 복제가 거절된다
        settings.DATABASES[conn.alias]["NAME"] = old_name
        conn.settings_dict["NAME"] = old_name


def _ensure_template(template: str, token: str, verbosity: int) -> bool:
    """template 이 이 세션(token)의 것이 되게 한다. 만들었으면 True."""

    conn = connections["default"]
    with conn._nodb_cursor() as cursor:
        # 트랜잭션 잠금: 세션 잠금은 트랜잭션 모드 풀러(pgbouncer) 뒤에서 문장마다 다른 서버 연결에 떨어질 수 있다.
        with cursor.db.connection.transaction():
            cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [template])
            cursor.execute(
                "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = %s",
                [template],
            )
            row = cursor.fetchone()
            if row is not None and row[0] == token:
                return False
            _build_template(template, verbosity)
            cursor.execute(f"COMMENT ON DATABASE {conn.ops.quote_name(template)} IS %s", [token])
            return True


def pytest_configure_node(node: Any) -> None:
    # xdist 컨트롤러가 워커를 띄울 때 세션 표를 넘긴다 — 모두가 같은 템플릿을 알아본다.
    node.workerinput[WORKERINPUT_KEY] = session_token(node.config)


@pytest.hookimpl(trylast=True)
def pytest_sessionstart(session: pytest.Session) -> None:
    config = session.config
    if (
        hasattr(config, "workerinput")
        or not config.pluginmanager.hasplugin("dsession")
        or config.option.collectonly
    ):
        return
    from pytest_django.plugin import blocking_manager_key

    conn = connections["default"]
    template = template_db_name(conn.creation._get_test_db_name(), None)
    with config.stash[blocking_manager_key].unblock():
        _ensure_template(template, session_token(config), config.option.verbose)


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session: pytest.Session) -> None:
    # 컨트롤러(또는 -n 0)가 워커가 내려간 뒤 템플릿을 지운다. 실패해도 시험 결과를 바꾸지 않는다.
    if hasattr(session.config, "workerinput"):
        return
    import psycopg
    from django.conf import settings

    default = settings.DATABASES["default"]
    template = template_db_name(default["TEST"]["NAME"], None)
    try:
        with psycopg.connect(
            host=default["HOST"], port=default["PORT"], user=default["USER"],
            password=default["PASSWORD"], dbname="postgres", autocommit=True, connect_timeout=5,
        ) as raw:
            raw.execute(f'DROP DATABASE IF EXISTS "{template}"')
    except Exception:  # noqa: BLE001 - 이미 없거나 DB 가 내려간 뒤다
        pass


@pytest.fixture(scope="session")
def django_db_setup(
    request: pytest.FixtureRequest,
    django_test_environment: Any,
    django_db_blocker: Any,
    django_db_use_migrations: bool,
    django_db_keepdb: bool,
    django_db_createdb: bool,
    django_db_modify_db_settings: Any,
) -> Generator[None, None, None]:
    from django.conf import settings
    from django.test.utils import teardown_databases

    if django_db_keepdb or not django_db_use_migrations:
        raise pytest.UsageError("--reuse-db·--no-migrations 는 쓰지 않는다 — 시험 DB 는 템플릿 복제로 선다.")
    verbosity = request.config.option.verbose
    with django_db_blocker.unblock():
        conn = connections["default"]
        old_name = conn.settings_dict["NAME"]
        worker_db = conn.creation._get_test_db_name()
        worker_id = getattr(request.config, "workerinput", {}).get("workerid")
        template = template_db_name(worker_db, worker_id)
        quote = conn.ops.quote_name
        # 컨트롤러가 미리 만들었으면 건너뛴다. -n 0 이나 못 만든 경우엔 여기서 만든다.
        _ensure_template(template, session_token(request.config), verbosity)
        with conn._nodb_cursor() as cursor:
            cursor.execute(f"DROP DATABASE IF EXISTS {quote(worker_db)}")
            cursor.execute(f"CREATE DATABASE {quote(worker_db)} TEMPLATE {quote(template)}")
        settings.DATABASES[conn.alias]["NAME"] = worker_db
        conn.settings_dict["NAME"] = worker_db
        for alias in connections:  # DB 거울(TEST.MIRROR)이 있으면 같은 이름을 가리키게 한다
            if connections[alias].settings_dict["TEST"].get("MIRROR") == conn.alias:
                connections[alias].creation.set_as_test_mirror(conn.settings_dict)
        conn.ensure_connection()
        old_config = [(conn, old_name, True)]
    yield
    with django_db_blocker.unblock():
        try:
            teardown_databases(old_config, verbosity=verbosity)
        except Exception as exc:  # noqa: BLE001
            request.node.warn(pytest.PytestWarning(f"시험 DB 를 지우지 못했다: {exc!r}"))
