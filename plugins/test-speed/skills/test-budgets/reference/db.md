# 시험 DB 사정 (Django·pytest)

SKILL.md 「빨리 만드는 기법」 5·6번의 상세. 조각은 `examples/conftest_django_db_template.py`(PostgreSQL 전용).

## MySQL

- `CREATE DATABASE … TEMPLATE` 가 없어 템플릿 복제 조각은 쓰지 못한다.
- **직렬(`-n 0`)이면 복제할 일이 없다** — 시험 DB 는 한 번만 만든다.
- xdist 를 쓰면 워커마다 마이그레이션을 다시 돈다. 두 저장소에서 잰 의견: MySQL 은 워커당 마이그레이션이 수 초(한 저장소에서 약 8초)라 워커를 늘려도 이득이 작다. 시험이 수백 건 안팎이면 직렬이 더 단순하고 비슷하게 빠르다. 워커를 늘리기 전에 `-n 0` 과 `-n 2` 의 전체 시간을 재서 고른다.

## 기계에 psql 이 없을 때

시험 DB 를 지우거나 목록을 볼 때 `psql` 대신 psycopg 로 한다.

```python
import psycopg
with psycopg.connect(host=H, port=P, user=U, password=PW, dbname="postgres", autocommit=True) as c:
    c.execute('DROP DATABASE IF EXISTS "test_mydb"')
```

## 시험 DB 정리가 실패할 때

- **연결 풀 시험이 연결을 쥐고 있다.** 세션 끝 teardown 이 「다른 세션이 쓰는 중」 경고로 DB 를 못 지운다. 풀을 여는 시험이 끝에서 풀을 닫게 하거나, 세션 종료 훅에서 풀을 먼저 닫은 뒤 지운다. teardown 실패는 시험 결과를 바꾸지 않고 경고로만 남긴다(조각이 그렇게 한다).
- **시험 DB 이름이 고정이면** 직전 실행이 못 지운 DB 때문에 다음 실행이 「이미 있음」으로 선다. 실행 사이에 drop 을 넣는다(Makefile 의 시험 대상 앞 단계, 또는 위 psycopg 한 줄). 이름을 워커·체크아웃별로 파생하면(예: 체크아웃 경로 해시) 이 문제가 줄지만 남은 DB 는 쌓인다.

## 빠른 비밀번호 해시

- 놓는 자리는 **시험 전용 설정 모듈**(예: `config/test_settings.py`)도 된다. `PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]` 한 줄이고 pytest 의 `DJANGO_SETTINGS_MODULE` 이 그것을 가리키면 운영 설정에는 손이 닿지 않는다.
- **운영 해시가 안 바뀌었는지 지키는 시험을 둔다**: 운영 설정 모듈을 import 해서 `PASSWORD_HASHERS[0]` 이 PBKDF2(또는 그 저장소가 쓰는 강한 해시)인지 단언한다. 시험 설정 한 줄이 새어 나가는 사고를 막는다.
