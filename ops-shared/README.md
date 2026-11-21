# ops-shared

예약 자동화가 쓰는 저장소 비종속 도구.

- `automation-run.sh` — 사전 확인(precheck) 감싸개. 기본 브랜치 체크아웃을 fast-forward 로 따라잡고, 정상 끝 코드 밖의 끝·따라잡기 실패를 switchboard 로 알린다. 사용법은 스크립트 머리말.
- `test_automation_run.py` — 위 스크립트 시험: `python3 ops-shared/test_automation_run.py`
