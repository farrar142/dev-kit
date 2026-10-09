# dev-kit

여러 저장소에서 다시 쓰는 Claude Code 작업 흐름과 최적화 지식 묶음이다. 한 프로젝트에서 측정·재현으로 얻은 것을 저장소와 무관한 꼴로 옮겨 둔다. Claude Code 플러그인 마켓플레이스 형식이다.

## 설치

```
/plugin marketplace add farrar142/dev-kit
/plugin install issue-track@dev-kit
/plugin install django-asgi@dev-kit
/plugin install test-speed@dev-kit
```

- 받기: `/plugin marketplace update dev-kit`.
- 머신마다 한 번 설치한다. 내용은 이 저장소 하나에서 고친다.

## 구성

```
.claude-plugin/marketplace.json
plugins/
  issue-track/                     이슈를 한 트랙으로 처리하는 조율 흐름
    agents/issue-worker.md         이슈 하나를 워크트리→시험→PR→병합→정리까지 (sonnet 기본)
    agents/errand.md               작업자의 찾기 심부름꾼 (haiku, 읽기 전용)
    skills/issue-track/            조율자: 큐·모델 고르기·지시서·확인·토큰 측정·최적화 반영
      scripts/worker-stats.py      작업자·심부름꾼의 턴·입력 토큰·최대 컨텍스트
  django-asgi/
    skills/django-asgi-perf/       ASGI 점검표 → reference/ (연결 풀, async 미들웨어, SSE 스냅샷·스트림 거르기), examples/
  test-speed/
    skills/test-budgets/           시험 하나 예산(0.5/1/3초)과 강제(pytest·Playwright·node --test), testing.md 템플릿, .tsx 로더
    skills/fast-stable-e2e/        Playwright E2E를 이벤트(DOM·스트림 리스너)으로만 기다려 시험당 3초·흔들림 0, 공용 도우미·lint·시간 쥐기
    skills/mock-stack-shots/       실제 응답에서 뽑은 목 시나리오 + startStack + 데스크톱·모바일·시안 비교 스크린샷
```

| 플러그인 | 스킬·에이전트 | 언제 불러오나 |
|---|---|---|
| issue-track | `issue-track` 스킬 | 「남은 이슈 차례로 1트랙으로 처리해줘」 |
| | `issue-track:issue-worker`, `issue-track:errand` 에이전트 | 조율자가 `Agent`의 `subagent_type`으로 띄운다 |
| django-asgi | `django-asgi-perf` | Django ASGI의 느린 요청, 연결 풀, SSE, async 미들웨어 |
| test-speed | `test-budgets` | 시험이 느리다, 예산을 세운다 |
| | `fast-stable-e2e` | Playwright E2E가 느리거나 흔들린다, 폴링·고정 대기·재시도로 버틴다, 실시간 메시지 뒤의 화면을 기다린다 |
| | `mock-stack-shots` | 화면 작업의 확인·스크린샷 |

## 저장소 쪽에서 할 일

이 묶음은 저장소마다 다른 것을 저장소 문서에서 읽는다. 새 저장소의 `CLAUDE.md`에 다음을 둔다.
- 이슈 트래커와 라벨(`ready-for-agent` 등)
- CI 종류와 PR 검사 이름, 병합 방식(작업자가 병합하나, 자동 병합 큐인가), PR CI가 돌리지 않는 시험층(정기 빌드 등)을 돌리는 법
- 시험 명령과 예산. `test-budgets`의 `templates/testing.md`에서 시작한다
- 커밋 메시지 관례

## 고치는 규칙

- **저장소와 무관한 꼴로 쓴다.** 프로젝트·라이브러리 이름, 이슈·PR 번호, 도메인 고유 낱말(게임·업무 용어), 특정 CI·인프라·저장소 경로·명령은 넣지 않는다. 한 프로젝트에서만 통하는 처방은 빼고, 저장소마다 다른 것은 「저장소 문서에서 읽는다」로 둔다. 교훈에는 측정값을 「한 프로젝트에서 잰 값」으로 함께 적는다. 예: 「13.4ms → 6.0ms」, 「196턴·45M 토큰」.
- **스킬 꼴:** `SKILL.md`에는 점검표와 규칙만 짧게 둔다. 긴 설명은 `reference/`, 붙여 쓸 코드는 `examples/`, 문서 틀은 `templates/`에 둔다. `description`에는 「언제 쓰나」를 증상 말로 적는다. 자동 불러오기가 이 문장을 보고 판단한다.
- **에이전트 정의를 바꿨으면** 이 저장소에 push한다. 설치본 캐시(`~/.claude/plugins/...`)는 직접 고치지 않는다.
