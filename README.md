# dev-kit

여러 저장소에서 다시 쓰는 Claude Code 작업 흐름과 최적화 지식 묶음이다. 한 프로젝트에서 측정·재현으로 얻은 것을 저장소와 무관한 꼴로 옮겨 둔다. Claude Code 플러그인 마켓플레이스 형식이다.

## 설치

```
/plugin marketplace add farrar142/dev-kit
/plugin install issue-track@dev-kit
/plugin install django-asgi@dev-kit
/plugin install test-speed@dev-kit
/plugin install token-diet@dev-kit
/plugin install question-panel@dev-kit
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
      scripts/wait-ci.py           PR head 커밋의 상태·check-runs를 배경에서 기다렸다가 한 번만 알린다(종료 코드로 결과)
      scripts/worker-stats.py      작업자·심부름꾼의 턴·입력 토큰·최대 컨텍스트
      reference/parallel-runs.md   체인 여럿을 나란히 돌릴 때의 함정(리뷰 포크, 통합 tip, 의미 충돌, compose -p)
  django-asgi/
    skills/django-asgi-perf/       ASGI 점검표 → reference/ (연결 풀, async 미들웨어, SSE 스냅샷·스트림 거르기), examples/
  test-speed/
    skills/test-budgets/           시험 하나 한도(0.5/1/3초, 백엔드는 CPU 초)와 강제, 빨리 만드는 기법, 처음 켜는 순서,
                                   reference/(사건 기다리기·시험 DB·vitest), examples/(CPU 훅·DB 템플릿·junit 분석·Playwright 설정·.tsx 로더)
    skills/fast-stable-e2e/        Playwright E2E를 이벤트(DOM·스트림 리스너)으로만 기다려 시험당 3초·흔들림 0, 공용 도우미·lint·시간 쥐기
    skills/mock-stack-shots/       실제 응답에서 뽑은 목 시나리오 + startStack + 데스크톱·모바일·시안 비교 스크린샷
  token-diet/
    hooks/hooks.json               아래 두 훅을 PreToolUse에 등록(Node만 쓴다)
    hooks/read-guard.js            1,000줄·80KB 넘는 파일을 limit 없이 Read하면 막는다
    hooks/block-heredoc.js         6,000자 넘는 heredoc 명령을 스크립트 파일로 옮겨 source로 실행
    skills/token-diet/             작업자 토큰 규율: 부분 읽기, 출력 끝만, 심부름꾼, 모델 고르기, 120턴 넘김, 배경 대기, CLAUDE.md 짧게
  question-panel/                  질문 패널 mod(hooks 모듈, Claude Code 2.1.312+)
    hooks/register.tsx             도구 mcp__question-panel__ask 등록, 오른쪽 「질문」 패널(Pane) 그리기, 완료 때 「[질문 패널 답] …」로 제출
    hooks/register.test.tsx        claude plugin test 로 도는 시험(쌓기·완료 막기·다중 선택·기타 입력)
    types/index.d.ts               $.state 계약(queue)
```

| 플러그인 | 스킬·에이전트 | 언제 불러오나 |
|---|---|---|
| issue-track | `issue-track` 스킬 | 「남은 이슈 차례로 1트랙으로 처리해줘」 |
| | `issue-track:issue-worker`, `issue-track:errand` 에이전트 | 조율자가 `Agent`의 `subagent_type`으로 띄운다 |
| django-asgi | `django-asgi-perf` | Django ASGI의 느린 요청, 연결 풀, SSE, async 미들웨어 |
| test-speed | `test-budgets` | 시험이 느리다, 한도를 세우거나 켠다, 고정 대기·흔들림을 없앤다 |
| | `fast-stable-e2e` | Playwright E2E가 느리거나 흔들린다, 폴링·고정 대기·재시도로 버틴다, 실시간 메시지 뒤의 화면을 기다린다 |
| | `mock-stack-shots` | 화면 작업의 확인·스크린샷 |
| token-diet | 훅 `read-guard`·`block-heredoc` | 설치하면 늘 켜진다 |
| | `token-diet` | 작업자가 토큰을 많이 쓴다, 지시서·에이전트 정의를 쓴다 |
| question-panel | 도구 `mcp__question-panel__ask`, 명령 `/questions`·`/questions-clear` | 모델이 결정 질문을 패널에 쌓고 턴을 끝낸다; 사용자가 답하고 완료를 누르면 답이 새 메시지로 온다(AskUserQuestion은 급한 확인만) |

## 바뀐 것

### 2026-10-28 — 로컬에서 쓰던 최신본을 일반화해 반영

- **새 플러그인 `token-diet`**: 큰 파일 부분 읽기 훅(`read-guard`, Python에서 Node로 옮김), 큰 heredoc 훅(`block-heredoc`), 토큰 규율 스킬.
- **issue-track 0.2.0**
  - `wait-ci.py`를 더했다. 작업자와 조율자가 PR CI를 배경에서 기다린다. 커밋 상태(Jenkins 등)와 Actions check-runs를 함께 보고, 빨강이면 실패 줄을 덧붙인다. issue-worker의 인라인 `gh` 루프는 스크립트를 못 쓸 때만 쓰는 대안으로 남겼다.
  - issue-worker: `rm -rf` 금지, `pgrep` 감시 루프 함정, 모바일 가로 넘침은 수치로 재기, 조건부 동작까지 흉내 내는 Fake, 화면 문구도 같이 고치기, `pkill` 대신 포트로 끄기, 병합 커밋 `--stat` 확인, 이슈 본문과 댓글 둘 다 읽기를 더했다.
  - 조율 스킬: 모델 표의 마지막 단계를 「더 비싼 모델 대신 티켓 쪼개기」로 바꿨다. 「CI 기다리는 중」 알림의 note 읽기, 작업 트리 말고 `origin/<기준>`으로 확인하기, 원격 브랜치 정리, 같은 꼴 티켓은 지시서 틀 파일로, 연속 한도 실패면 최적화를 먼저 하기, 큰 티켓 쪼개는 기준을 더했다.
  - `reference/parallel-runs.md`: 병렬 체인 실행의 함정.
- **test-speed 0.3.0**: `test-budgets`에 로컬 `test-speed-budget`을 합쳤다. 백엔드는 CPU 초로 재고 junit에 `cpu_seconds`를 남긴다(벽시계 훅은 대안으로 남김). 훅 동작 확인, 빨리 만드는 기법 여덟, 고치는 순서, 재시도 0과 flaky를 덮지 않기, 전체 시험은 CI에서, 한도 올리는 규칙, 처음 켜는 순서를 넣었다. 조각 다섯과 참고 문서 셋(사건 기다리기·시험 DB·vitest)을 더했다. CPU 훅은 Windows(`resource` 없음)에서도 돈다.

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
