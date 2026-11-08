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
/plugin install security-recon@dev-kit
/plugin install idle-compact@dev-kit
/plugin install context-cap@dev-kit
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
      scripts/wait-ci.py           PR head 커밋의 상태·check-runs를 배경에서 기다렸다가 한 번만 알린다(종료 코드로 결과: 0 성공 / 1 실패 / 2 병합·닫힘 / 3 시간 초과 / 4 PR 없음 / 5 검사 없음)
      scripts/wait-deploy.py       병합 뒤 Jenkins 배포 빌드(병합 시각 뒤 첫 빌드)가 끝날 때까지 기다렸다가 한 번만 알린다(0 성공 / 1 실패 / 3 시간 초과 / 4 조회 불가 / 5 빌드 안 생김)
      scripts/ci_common.py         두 스크립트가 함께 쓰는 Jenkins 자격·기본 URL 찾기·콘솔 발췌
      tests/                       스크립트 단위 시험(`python3 -m unittest discover -s plugins/issue-track/skills/issue-track/tests`)
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
  question-panel/                  질문 패널 mod(hooks 모듈, Claude Code 2.1.312+)와 stdio MCP 서버(node)
    .mcp.json, mcp/server.mjs      MCP 서버 qp: 질문 도구 ask(mcp__plugin_question-panel_qp__ask) 하나. 상태 없이 mod가 넘긴 결과 글을 돌려준다
    mcp/ask.mjs, ask.test.mjs      서버 본체(도구 정의·JSON-RPC 처리, mod가 없을 때의 대화창 블록, Orca 채팅 세션 질문을 Orca 질문 패널 폴더에)와 node --test 시험
    mcp/orca.mjs                   Orca 채팅 세션용 진짜 환경(집 폴더 ~/.question-panel/orca-inbox 쓰기, orca run-current). server.mjs만 쓴다(mod 시험은 node: 모듈을 못 불러온다)
    hooks/register.tsx             질문 도구 호출을 감싸 묶음을 쌓고 결과 글을 서버에 넘김, resolve 도구 등록, 오른쪽 「질문」 패널(Pane) 그리기, 완료 때 「[질문 패널 답] …」로 제출,
                                   패널의 「보내기」 칸으로 자유 글 제출, 원격 표면(데스크톱 등)에서는 도구 줄·/questions 출력 줄에도 그림,
                                   답한 기록 지우기(하나·모두), 선택지 preview 펼치기
    hooks/register.test.tsx        claude plugin test 로 도는 시험(쌓기·완료 막기·다중 선택·기타 입력·삭제·기록 지우기·preview·보내기·데스크톱 줄)
    types/index.d.ts               $.state 계약(queue, draft)
  idle-compact/                    작업이 끝난 뒤 오래 입력이 없으면 자동 compact 하는 mod(hooks 모듈, Claude Code 2.1.312+)
    hooks/register.ts              turn.complete에서 30분 타이머(IDLE_MS)를 걸고, turn.start·prompt.change·prompt.submit에서 취소, 컨텍스트 MIN_PERCENT(15%) 미만이면 건너뜀
  context-cap/                     세션 컨텍스트 상한 훅(Node, issue-worker 본 세션 또는 환경변수가 있을 때 켜짐)
    hooks/context-cap.js           transcript 끝에서 마지막 본 세션 응답의 usage로 컨텍스트를 재고 UserPromptSubmit·PostToolUse·PreToolUse를 처리
    tests/                         가짜 transcript 시험(`node --test plugins/context-cap/tests`)
orca-plugins/
  question-panel/                  Orca 플러그인(마켓플레이스 밖): question-panel 질문을 Orca 사이드바 카드로, 답은 그 터미널(채팅 세션은 오케스트레이션 메일함)로
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
| question-panel | 도구 `mcp__plugin_question-panel_qp__ask`(MCP 서버)·`mcp__question-panel__resolve`, 명령 `/questions`·`/questions-clear` | 모델이 결정 질문을 패널에 쌓고 턴을 끝낸다; 사용자가 답하고 완료를 누르면 답이 새 메시지로 온다(AskUserQuestion은 급한 확인만; 화면이 없는 Orca 채팅 세션은 질문이 대화창 블록으로 보이고 글로 답하거나(예: `q4 1-2`) Orca 사이드바 질문 패널로 답한다(0.6.1, 답은 `[질문 패널 답] qN` 오케스트레이션 메일)) |
| security-recon | `security-recon` | 인가 받은 새 서버·낯선 인프라를 바깥에서 점검한다, 클라우드 방화벽을 조인다, 방화벽을 좁힌 뒤 서비스가 죽었다 |
| idle-compact | 훅만(도구·명령 없음) | 설치하면 늘 켜진다. 작업이 끝나고 30분 동안 입력이 없으면 `/compact`와 같은 정리를 하고 알림을 띄운다 |
| context-cap | 훅만 | `claude --agent issue-worker` 본 세션은 기본으로, 그 밖에는 `CONTEXT_CAP_SOFT`·`CONTEXT_CAP_HARD`를 준 세션에서만 켜진다. 아래 「context-cap 쓰는 법」 |

## context-cap 쓰는 법

작업자 세션 하나에 티켓을 계속 넣으면 컨텍스트가 상한 없이 커진다(한 세션이 400k까지 간 일이 있다). 조율자 지침의 글 규칙 대신 작업자 세션 안의 훅이 직접 재서 막는다.

- **켜기(기본)**: `claude --agent issue-worker`로 뜬 본 세션은 환경변수 없이 SOFT 250000·HARD 300000으로 켜진다. 판정은 훅 입력의 `agent_type`(본 세션은 이것만 오고, 서브에이전트 안 도구 호출은 `agent_id`도 함께 온다 — claude 2.1.318에서 확인). 그래서 서브에이전트, 에이전트 없이 뜬 세션(조율자·일반 세션), 목록에 없는 에이전트 세션은 그대로다.
  - 대상 에이전트 이름은 `CONTEXT_CAP_AGENTS`(쉼표 구분, 기본 `issue-worker`, `plugin:name` 꼴은 끝 이름으로도 맞춘다). 빈 값이면 기본 대상 없음.
- **켜기(환경변수)**: `CONTEXT_CAP_SOFT`·`CONTEXT_CAP_HARD` 중 하나라도 있으면 그 값만 쓴다(없는 쪽은 0). 에이전트와 상관없이 그 세션에 걸린다.
  `env CONTEXT_CAP_SOFT=250000 CONTEXT_CAP_HARD=300000 claude …`
- **끄기**: `CONTEXT_CAP_SOFT=0`(HARD를 주지 않으면 둘 다 0이 되어 issue-worker 본 세션도 꺼진다).
- **재기**: `transcript_path`를 끝에서부터 1MB씩 읽어, 사이드체인이 아닌 마지막 assistant 응답의 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. 그보다 compact 경계가 뒤에 있으면 0으로 본다.
- **SOFT 넘음**: `UserPromptSubmit`이 새 지시를 거절한다(「컨텍스트 N k — 상한 넘음. 새 세션에서 받으라」). 프롬프트에 「넘김」·`handoff`·`handover`가 있으면 통과(`CONTEXT_CAP_HANDOFF_PATTERN`으로 바꾼다). 하네스가 넣는 자동 알림(`prompt`가 `<task-notification>`으로 시작 — claude 2.1.318에서 배경 Bash 완료·Monitor 이벤트가 이 꼴이었고, 훅 입력에 출처 필드는 없다)은 사람 지시가 아니라서 통과한다. 그래서 배경으로 건 CI·배포 대기의 완료 알림은 상한을 넘어도 작업자를 깨운다. 진행 중인 티켓은 끊지 않고, 다음 `PostToolUse`에서 한 번 「지금 티켓을 마치고 보고에 『새 세션 필요(컨텍스트 N k)』를 넣고 더 일을 받지 마라」를 알린다.
- **HARD 넘음**: `PreToolUse`가 다음만 남기고 막는다 — 이름에 `handoff`·`hand-off`·`넘김`이 든 파일의 Write/Edit/Read, 배경 작업 출력 읽기(`TaskOutput`, `…/tasks/<id>.output` Read), `SendMessage`·`ToolSearch`·`TaskStop`·`KillShell`, 그리고 조각마다 보고·마무리용인 Bash(`cd`, `echo`, `tail`·`head`, `git status|add|commit|push|log|diff|show|rev-parse|branch|stash|fetch|pull|rebase|worktree|switch|checkout`, `gh issue|pr comment|view|list|checks|status|merge|close`, `gh run view|list`, `wait-ci.py`·`wait-deploy.py` 실행, `orca orchestration send|reply`, `kill`, `fuser -k`). 하던 티켓의 CI·배포 대기, 병합, 정리는 끝낼 수 있게 둔다. 저장소 몫 정리 명령은 `CONTEXT_CAP_ALLOW_BASH`(정규식 하나)로 더한다. 따옴표 밖 명령 치환(`$(…)`·백틱)은 막는다.
- **알림 명령(선택)**: `CONTEXT_CAP_NOTIFY_CMD`가 있으면 SOFT를 처음 넘을 때 한 번 셸로 띄운다. 환경에 `CONTEXT_CAP_TOKENS`·`CONTEXT_CAP_SESSION_ID`. 기다리지 않고, 실패해도 훅은 성공.
- **중복 막기**: 세션별 상태 파일 `$TMPDIR/context-cap/<session_id>.json`(`CONTEXT_CAP_STATE_DIR`로 바꾼다).
- 선의의 작업자를 멈추는 가드레일이지 보안 경계가 아니다(따옴표 안 명령 치환 등은 거르지 않는다).

## 바뀐 것

### 2026-11-08 — Orca 질문 패널 0.4.0·question-panel 0.6.1: 채팅 UI 세션에도 답 전달

- Orca 채팅 세션(stream-json)은 `agent.tool.after` 훅이 오지 않고 넣을 터미널도 없어 패널로 답할 수 없었다. 이제 question-panel MCP 서버가 채팅 세션의 질문을 `~/.question-panel/orca-inbox`에 세션 ID·Run·CLI 경로와 함께 남기고 대화창 블록 끝에 「Orca 사이드바 질문 패널로도 답할 수 있다」를 붙인다. Orca 플러그인이 그 폴더를 읽어 카드로 띄우고, 답은 그 세션 신원으로 `orca orchestration send --to run:<run_id>`(Run이 없으면 `orca_session_id:<id>`)로 보낸다(제목 `[질문 패널 답] qN`, 본문 `qN 1-2 / [질문 패널 답] 질문 = 고른 것`). 카드에 전달 경로와 실패 이유, 단계마다 로그. 근거는 `orca-plugins/question-panel/README.md` 「채팅 세션(0.4.0)」.

### 2026-11-08 — Orca 질문 패널 0.3.3: exited 터미널도 닫힘으로 알아보기

- 0.3.2는 닫힘을 `terminal_handle_stale` 거부로만 알아봤는데, Orca 1.4.253은 닫힌 터미널에 거부 대신 빈 출력을 돌려줘 카드가 계속 「답 보내기」 가능으로 남았다. 이제 빈 출력도 닫힘으로 본다(플러그인 host가 status를 주지 않아서). 닫힘 판정마다 로그를 남긴다.

### 2026-11-08 — Orca 질문 패널 0.3.2: 닫힌 터미널의 카드 정리, 카드에 workspace·터미널 이름

- 닫힌 터미널에서 온 옛 카드가 남아, 누르면 포커스 대기 뒤 `outside the active worktree`가 났다. 같은 q1이 두 장이라 헷갈리기도 했다. 이제 `terminal.read`가 `terminal_handle_stale`로 거부되면 그 터미널은 닫힌 것으로 본다. 확인은 패널을 열 때, 새 질문이 올 때, 보내기 직전에 한다. 닫힌 카드는 「터미널이 닫힘」으로 보이고 보내기가 막히며, 「지우기」·「닫힌 터미널 카드 N개 지우기」로 정리한다. 카드에는 workspace 이름과 터미널 제목이 보인다. 권한 `terminal:read`가 늘었다.

### 2026-11-08 — Orca 질문 패널 0.3.1: 포커스가 바뀔 때까지 기다렸다 보내기

- Windows 시험(1.4.253)에서 질문이 Orca 패널까지 왔지만 답 보내기가 `terminal is outside the active worktree`로 실패했다. `workspace.open`은 활성 worktree 바꾸기를 요청만 하고 돌아오는데, 0.3.0은 14ms 뒤 다시 보냈다. 0.3.1은 `workspace.readContext`에 대상 터미널이 들 때까지 100ms마다 최대 3초 기다린 뒤 보낸다. 포커스와 무관하게 기존 터미널에 넣는 플러그인 메서드는 Orca에 없다(근거는 `orca-plugins/question-panel/README.md`).

### 2026-11-08 — question-panel 0.6.0: 질문 도구를 stdio MCP 서버로, Orca 질문 패널 0.3.0

- 질문 도구를 mod 도구에서 플러그인의 stdio MCP 서버(`.mcp.json`의 `qp`, `mcp/server.mjs`, node)로 옮겼다. 이름은 `mcp__plugin_question-panel_qp__ask`. Claude Code는 mod 도구에 PreToolUse·PostToolUse 훅을 돌리지 않아 Orca(`agent.tool.after`)가 질문을 못 받았다. MCP 도구는 훅을 탄다(2.1.319 tmux 대화형 + `matcher "*"` 기록 훅으로 확인).
- 모델에게 보이는 질문 도구는 하나다(mod의 `ask` 등록을 뺐다). 상태(묶음 q1…·패널)는 지금처럼 mod 한 곳에만 있다: mod의 `tool.call` 훅이 그 MCP 호출을 감싸 묶음을 쌓고, 결과 글을 입력의 `panel_result`로 서버에 넘기면 서버가 그대로 돌려준다. 그래서 PostToolUse의 `tool_response`에 「질문 묶음 qN」이 들어간다. 서버가 답하지 못하면(거절·오류) 쌓은 묶음을 거둔다. mod가 없는 세션이면 서버가 묶음 없이 대화창 블록을 돌려준다.
- `tool.describe`로 질문 도구를 ToolSearch 뒤가 아니라 처음부터 도구 목록에 두게 했다.
- Orca 플러그인 0.3.0: 새 도구 이름을 보고, MCP 결과(content 블록 배열)에서도 묶음 ID를 읽는다. 다른 이름의 질문 도구는 로그를 남기고 무시한다.

### 2026-11-08 — Orca 질문 패널: 막힘 기록

- Windows 시험에서 Orca 워커에 `agent.tool.after`가 오지 않았다. 원인: Claude Code는 mod 도구(`mcp__question-panel__ask`)에 PreToolUse·PostToolUse 설정 훅을 내보내지 않는다(2.1.319, `matcher "*"`로 확인. Bash는 옴). Orca 도구 훅은 그 설정 훅을 타고 오므로 질문이 Orca에 닿지 않는다. 자세한 것은 `orca-plugins/question-panel/README.md`.

### 2026-11-08 — Orca 질문 패널 0.2.0: 답이 터미널에 안 들어가던 것 조사·로그

- Windows 첫 시험에서 카드는 떴지만 답이 터미널에 들어가지 않았고 로그가 비었다. Orca 소스상 `terminal.sendText`는 포커스된 worktree의 터미널만 받는다. 거부되면 질문한 workspace를 `workspace.open`으로 연 뒤 다시 보내고(`workspace:read`·`workspace:write` 권한 추가), 워커·패널 모든 단계를 `orca plugin logs`에 남기고, 실패 이유를 패널 위쪽과 카드에 보인다. 시험 15건.

### 2026-11-08 — Orca 질문 패널 시제품 0.1.0 (`orca-plugins/question-panel/`)

- Claude Code 마켓플레이스 밖의 Orca 플러그인. Orca 터미널의 Claude가 `mcp__question-panel__ask`를 부르면 훅 `agent.tool.after`가 질문을 저장하고, Orca 오른쪽 사이드바 「질문」 패널에 카드로 띄운다. 고른 답은 `terminal.sendText`로 그 터미널에 `[질문 패널 답 q3] …` 한 줄로 들어가 Claude Code 쪽 묶음도 닫힌다. Orca 채팅 UI 세션은 플러그인 API에 메시지를 넣을 길이 없고 도구 훅도 오지 않아 안 된다(까닭·대안은 그 폴더 README). 시험 11건(`orca plugin test`).

### 2026-11-08 — question-panel 0.5.2: 화면이 없는 세션도 비블로킹으로

- 0.5.1의 거부를 되돌렸다. Orca 채팅(stream-json)처럼 surface가 없는 세션에서도 `ask`는 질문을 쌓고 대화창 블록을 돌려준 뒤 턴을 끝낸다(AskUserQuestion은 세션을 막는다). 답은 「q4 1-2」 같은 글로 온다. `/questions`는 「이 세션은 패널 화면이 없습니다…」 안내와 대기 중인 묶음 블록을 낸다. 시험 20건.

### 2026-11-08 — question-panel 0.5.1: 화면이 없는 세션은 AskUserQuestion으로

- Orca 채팅(stream-json)처럼 `$.session.surfaces()`가 비어 패널을 붙일 화면이 없는 세션에서는 `ask`가 질문을 쌓지 않고 「AskUserQuestion으로 다시 물어라」로 거부하고, `/questions`는 오류 대신 「질문은 AskUserQuestion으로 받습니다」 안내를 낸다. 원격·터미널 surface가 있으면 그대로. 훅 환경에는 `process`가 없어 `ORCA_STRUCTURED_SESSION`은 읽지 못해 surface 유무만 본다. 시험 20건(`claude plugin test plugins/question-panel`).

### 2026-11-07 — issue-track 0.5.1: 지시서 틀에 컨텍스트 위생 줄

- 지시서 틀에 「컨텍스트 위생」 줄을 더했다(컴파일·시험 출력은 파일로 돌려 `head`·`grep`으로, 사용처 찾기는 `errand`에, 기계적 일괄 수정은 서브에이전트·스크립트로, 큰 파일은 범위로만). 작업자 둘이 컴파일 오류 출력으로 컨텍스트 상한에 걸려 PR 없이 넘긴 탓.

### 2026-11-05 — context-cap 0.2.1: 배경 작업 알림은 막지 않기

- SOFT를 넘은 세션에서 `UserPromptSubmit`이 하네스의 배경 작업 완료 알림(`<task-notification>`)까지 막아, 배경으로 CI 대기를 건 작업자가 깨어나지 못하고 멈췄다. 이 알림은 통과시키고 사람 지시만 막는다.
- HARD 허용에 배경 작업 출력 읽기(`TaskOutput`, `tasks/*.output` Read, `tail`·`head`)와 병합·정리(`gh pr checks|merge`, `gh issue close`, `gh run view`, `wait-ci.py`·`wait-deploy.py`, `git pull|rebase|worktree|switch|checkout`)를 더했다. 시험 22건.

### 2026-11-05 — question-panel 0.5.0: 질문 기록 지우기, 선택지 preview

- 답한 묶음(패널에서 보냄·대화창에서 답함)에 「기록 지우기」, 패널 아래에 「답한 기록 모두 지우기 (N)」. 저장된 큐에서도 빠진다. 대기 중인 묶음은 모두 지우기에서 남기고, 하나 지울 때는 예전처럼 확인을 거친다. `/questions-clear`도 같은 규칙.
- `ask`의 option에 선택 필드 `preview`(마크다운: 코드·ASCII 목업·설정 예시, AskUserQuestion의 preview와 같다). mod API에 초점 이벤트가 없어 선택지를 고르거나 옆의 「미리보기」를 누르면 선택지 목록 아래에 펼친다(다시 누르면 접힘). 코드 블록이 아닌 preview는 정렬이 유지되게 코드 블록으로 감싼다. 도구 결과의 대화창 블록에는 선택지 아래에 코드 블록으로 들어간다(본문의 백틱보다 긴 울타리). 시험 18건.

### 2026-11-05 — context-cap 0.2.0: issue-worker 본 세션은 기본으로 켜기

- 환경변수가 없어도 `claude --agent issue-worker` 본 세션(훅 입력 `agent_type`이 있고 `agent_id`가 없음)은 SOFT 250000·HARD 300000. 환경변수가 우선, `CONTEXT_CAP_SOFT=0`으로 끄고, 대상은 `CONTEXT_CAP_AGENTS`로 바꾼다. 시험 20건.

### 2026-11-05 — context-cap 0.1.0 추가

- 작업자 세션 컨텍스트 상한 훅. 환경변수가 있을 때만 SOFT 넘으면 새 지시 거절과 한 번 알림, HARD 넘으면 넘김·보고 말고는 도구 막기. 시험 14건(`node --test plugins/context-cap/tests`).

### 2026-11-04 — issue-track 0.5.0: Jenkins 자격 없이 CI·배포 기다리기, 최상위 세션 보고 길

- **`wait-ci.py`**: Jenkins 자격이 없거나 Jenkins가 401·403·연결 실패면 PR의 실패 댓글(첫 줄 표지 + head SHA 앞 12자)에서 실패 줄을 읽는다. 옛 자격으로 실패하면 표준 오류에 경고 한 줄.
- **`wait-deploy.py`**: 같은 조건에서 GitHub 커밋 상태로 배포를 기다린다. 병합 커밋에 상태가 없으면 함께 배포된 뒤 커밋을 찾는다. 실패면 배포 실패 PR 댓글을 덧붙인다.
- 상태 이름·댓글 표지는 환경변수(`ISSUE_TRACK_DEPLOY_CONTEXT`·`ISSUE_TRACK_DEPLOY_COMMENT_PREFIX`·`ISSUE_TRACK_PR_COMMENT_PREFIX`)나 인자(`--status-context`·`--comment-prefix`)로 바꾼다. 기본 상태 이름은 `deploy`.
- 공유 로직은 `ci_common.py`로, 시험 40건(`tests/test_wait_scripts.py`). 이 기계의 Jenkins 자격에 따라 결과가 갈리던 시험 하나를 고쳤다.
- **issue-worker**: 「부른 쪽에 닿게 보내기」 절 — 지시서의 보고 명령이 우선, 서브에이전트면 `SendMessage`, 최상위 세션(「You are the main conversation」)이면 지시서의 명령을 Bash로 실행하고 성공 출력을 확인한다. `tools` 목록을 정의에 둔다.

### 2026-11-03 — 외부 보안 점검 플러그인

- **새 플러그인 `security-recon` 0.1.0**: 인가·범위 확인을 1단계 문지기로 두고, 서로 다른 두 네트워크 지점에서 공개 경로로 포트·TLS·보안 헤더·애플리케이션 면(인증 강제·IDOR·CORS 자격증명·운영 자동 API 문서)을 재는 절차, 클라우드 방화벽 + 내부 주소 바인딩의 이중 차단과 외부 재스캔 폐곡선, 방화벽을 좁힐 때 사설 대역 허용을 먼저 남기라는 교훈. `reference/clouds.md`에 OCI·AWS·GCP 기본값과 체크 포인트. 공격 페이로드는 다루지 않는다.

### 2026-11-02 — idle-compact 0.1.0 추가

- Claude의 작업(턴)이 끝난 뒤 30분 동안 입력이 없으면 대화를 자동으로 compact 한다. 입력창에 글을 쓰거나 프롬프트·백그라운드 알림으로 새 턴이 시작되면 타이머를 취소한다. 서브에이전트의 턴은 세지 않는다.
- 컨텍스트가 15% 미만이면 건너뛴다. 시간·문턱은 `hooks/register.ts` 맨 위의 `IDLE_MS`·`MIN_PERCENT`.

### 2026-11-02 — question-panel 0.4.0: 질문을 대화창에도

- `ask`의 도구 결과에 질문 묶음의 마크다운 블록(묶음 ID, 질문, 번호 붙은 선택지와 설명, 선택 방식, 「`q4 1-2`처럼 번호로 답해도 된다」)을 넣고, 도구 설명으로 모델이 그 블록을 답변 글에 그대로 옮겨 적게 한다. Remote Control·폰처럼 플러그인 UI가 오지 않는 화면에서도 질문이 보인다. 터미널 패널은 그대로다.
- 사용자 글(대화창, 패널 「보내기」)에 대기 중인 묶음 ID가 있으면 그 묶음을 「대화창에서 답함」으로 닫아 패널에서 또 답하지 못하게 한다. ID 없이 글로 답하면 모델이 새 도구 `mcp__question-panel__resolve`로 닫는다.

### 2026-11-02 — question-panel 0.3.1: 데스크톱에서 긴 글이 잘리지 않게

- 데스크톱은 `Button`을 네이티브 버튼 한 줄로 그려 긴 라벨을 줄임표로 자른다(`ButtonProps`에는 `wrap`이 없다). 원격 표면(데스크톱·VS Code·모바일)에서는 선택지 버튼에 `( ) 고르기`·`(o) 고름` 같은 짧은 표시만 두고, 라벨과 설명은 옆의 `Text wrap="wrap"`으로 줄바꿈해 다 보인다. 터미널은 예전처럼 버튼 안에 다 그린다.
- 질문 글·헤더·묶음 제목·안내 글의 바깥 `Text`에 `wrap="wrap"`을 명시했다(터미널 기본값과 같아 터미널 모양은 그대로).
- 원격 표면의 「기타」 입력과 「세션에 보낼 글」 칸은 `rows={3}`의 여러 줄 칸이다.

### 2026-11-02 — question-panel 0.3.0: 데스크톱에서도 보이게, 패널에서 글 보내기

- 패널 아래 「세션에 보낼 글」 칸과 「보내기」 버튼(Enter도 같다). 답 제출과 같은 `$.prompt.submit({ text, asUser: true })`로 세션에 사용자 메시지를 넣는다. 빈 글은 보내지 않고, 보내면 칸을 비운다. 모바일은 입력 칸이 없어 안내만 그린다.
- 터미널 밖 표면(데스크톱·VS Code·모바일)에서는 pane과 함께, 질문을 올린 도구 줄(`ToolUse`)에 그 묶음 카드를, `/questions` 출력 줄(`CommandOutput`)에 패널 전체를 그린다. 데스크톱 앱이 pane을 그리지 않아도 질문에 답하고 글을 보낼 수 있다.
- `$.ui.open`이 `isPlaced: false`를 돌려주면 사유를 `$.ui.log`·명령 출력에 남긴다(전에는 버렸다).
- 모바일의 「기타」 칸 안내가 이제 실제로 나온다(표가 빠진 요소를 빈 조각으로 채워 `Input in t`가 늘 참이었다).

### 2026-10-30 — 병합 뒤에만 배포가 도는 저장소 대응

- **issue-track 0.3.0**
  - `wait-ci.py`: 검사가 하나도 없는 상태가 3분(`--no-checks-wait`) 이어지면 종료 코드 5 `NO_CHECKS`로 곧바로 끝난다. Jenkins가 main 병합 뒤에만 돌고 커밋 상태를 올리지 않는 저장소에서 40분 `TIMEOUT`을 기다리지 않는다.
  - `wait-deploy.py`(새): 병합 시각(`--pr`의 mergedAt 또는 `--since`) 뒤에 시작된 첫 Jenkins 빌드를 찾아 끝날 때까지 기다리고 한 번만 알린다. 실패면 콘솔 실패 줄을 덧붙인다. 빌드가 10분 안에 안 생기면 5 `NO_BUILD`. Jenkins 자격·기본 URL 찾기는 `ci_common.py`로 뽑아 `wait-ci.py`와 공유한다.
  - issue-worker: NO_CHECKS 처리와 「병합 뒤 배포는 커밋 status를 폴링하지 말고 `wait-deploy.py`」를 넣었다. 조율 스킬 지시서 절·CI 알림 절에도 반영했다.
  - 조율 스킬: 로컬 사본에만 있던 「조율자 세션 컨텍스트 — compact가 기본」 절을 가져왔다(프로젝트 이름 뺌).
  - 단위 시험(`skills/issue-track/tests/`): gh·Jenkins·시계를 가짜로 바꿔 종료 코드별 경우를 덮는다.

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
