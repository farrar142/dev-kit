# dev-kit

여러 저장소에서 다시 쓰는 Claude Code 작업 흐름과 최적화 지식 묶음이다. 한 프로젝트에서 측정·재현으로 얻은 것을 저장소와 무관한 꼴로 옮겨 둔다. Claude Code 플러그인 마켓플레이스 형식이다.

## 설치

```
/plugin marketplace add farrar142/dev-kit
/plugin install issue-track@dev-kit
/plugin install django-asgi@dev-kit
/plugin install test-speed@dev-kit
/plugin install token-diet@dev-kit
/plugin install question-panel@dev-kit   # switchboard로 옮기는 중: 아래 「question-panel → switchboard 이전」
/plugin install switchboard@dev-kit      # 협업자 PC 연결: 아래 「switchboard 협업자 연결」
/plugin install security-recon@dev-kit
/plugin install idle-compact@dev-kit
/plugin install context-cap@dev-kit
/plugin install harden@dev-kit
/plugin install leak-guard@dev-kit
/plugin install root-cause@dev-kit
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
      reference/switchboard.md     다른 터미널 작업자의 보고 경로: 메일함 역할 주소, `switchboard` CLI, `SWITCHBOARD_PROFILE` 환경변수, 플러그인 구독으로 깨우기(2026-11-13에 Orca orchestration 메일함에서 바뀜)
      scripts/ci_common.py         두 스크립트가 함께 쓰는 Jenkins 자격·기본 URL 찾기·콘솔 발췌
      tests/                       스크립트 단위 시험(`python3 -m unittest discover -s plugins/issue-track/skills/issue-track/tests`)
      scripts/worker-stats.py      작업자·심부름꾼의 턴·입력 토큰·최대 컨텍스트
      reference/parallel-runs.md   체인 여럿을 나란히 돌릴 때의 함정(리뷰 포크, 통합 tip, 의미 충돌, compose -p)
      reference/remote-session.md  한 건을 원격 기계 작업자 세션에 맡기기: 이슈 → Orca로 세션 → 지시서 메일 → 착수 확인 → 보고 뒤 세션 닫기
      scripts/update-plugins.py    로컬·원격(ssh 별칭, posix·PowerShell) 기계에서 마켓·플러그인을 모든 범위에서 갱신 → 범위별 판 표(옛 판이 남으면 종료 코드 1), 옛 판으로 떠 있는 세션 목록
      issue-track.example.json     사용자 설정(`~/.config/dev-kit/issue-track.json`, `DEV_KIT_CONFIG`) 예시 — 가짜 값
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
    .mcp.json, mcp/server.mjs      MCP 서버 qp: 질문 도구 ask(mcp__plugin_question-panel_qp__ask)와 닫기 도구 resolve(…_qp__resolve, 0.6.3). mod가 넘긴 결과 글을 돌려주고, 내부 도구 sync(0.9.0)로 닫힘 장부를 배타 생성으로 쓰고 읽는다
    mcp/ask.mjs, ask.test.mjs      서버 본체(도구 정의·JSON-RPC 처리, `QUESTION_PANEL_ECHO`일 때·mod가 없을 때의 대화창 블록, Orca 채팅 세션 질문·닫힘을 Orca 질문 패널 폴더에)와 node --test 시험
    mcp/orca.mjs                   진짜 환경(집 폴더 ~/.question-panel/orca-inbox 쓰기, 닫힘 장부 ~/.question-panel/ledger 배타 생성·읽기·14일 지난 기록 정리, orca run-current). server.mjs만 쓴다(mod 시험은 node: 모듈을 못 불러온다)
    hooks/register.tsx             질문 도구 호출을 감싸 묶음을 쌓고 결과 글을 서버에 넘김, resolve 호출도 감싸 패널 묶음을 닫음, 오른쪽 「질문」 패널(Pane) 그리기, 완료 때 「[질문 패널 답] …」로 제출,
                                   패널의 「보내기」 칸으로 자유 글 제출, 원격 표면(데스크톱 등)에서는 도구 줄·/questions 출력 줄에도 그림,
                                   답한 기록 지우기(하나·모두), 패널 닫기(X), 답 없이 닫기, 선택지 preview 펼치기,
                                   보내기·닫기 전에 닫힘 장부 차지, 2초마다 장부를 읽어 Orca에서 닫힌 묶음 닫기(0.9.0)
    hooks/register.test.tsx        claude plugin test 로 도는 시험(쌓기·완료 막기·다중 선택·기타 입력·삭제·기록 지우기·preview·보내기·데스크톱 줄)
    types/index.d.ts               $.state 계약(queue, draft)
  switchboard/                     question-panel을 대체하는 세션 교환대 mod(0.12.1, hooks 모듈·stdio MCP 서버). 질문 패널 동작은 question-panel 0.9.0 그대로
    core/host.ts                   AgentHost 포트: submitTurn·injectMidTurn?·compact?·usage·on(이벤트: 턴 시작·완료, 입력 변경·제출, compact 완료)·identity·services(http·clock·fs)·features
    core/switchboard.ts            에이전트를 모르는 코어: 본 세션에서만 켜지고 유휴·바쁨·compact 중·입력 중을 따라간다, compact(기능이 없으면 건너뜀), 메일함을 켜고 메일 전 compact 관문(compactBeforeMail·compactConfig)과 사람 입력 보류(holdAfterUserMs·holdConfig·noteUserInput)를 단다
    core/mailbox.ts                메일함(0.2.0): 프로필(endpoint·role·token, 토큰은 메모리에만)을 읽어 메일함 긴 대기(/api/events/poll)를 커서로 구독, 일반 메일 ID를 유휴 때 한 줄 새 턴으로(바쁜 동안 온 것은 묶음, 중복 없음, 그새 읽힌 메일은 뺌), 끊기면 1초→60초로 늘려 다시 잇기, 넣기 직전 관문(beforeDeliver), 긴급 메일 끼워 넣기·즉시 read(본문 2000자 상한)
    core/profile.ts                프로필 위치(0.8.1·0.12.0·0.12.5): switchboard CLI와 같은 규칙. 이름은 `SWITCHBOARD_PROFILE`, 폴더는 `SWITCHBOARD_CONFIG_DIR` → Windows `%APPDATA%`·macOS `~/Library/Application Support`·그 밖 `XDG_CONFIG_HOME` → `~/.config` 아래 `switchboard/`, 홈은 `HOME` → `USERPROFILE`. 옛 이름(3단계에 제거): `AGENT_MAIL_PROFILE`·`AGENT_MAIL_CONFIG_DIR`은 새 이름이 비었을 때만, 옛 폴더 `agent-mail/`·`~/.config/agent-mail`은 프로필 파일마다 새 폴더 뒤 후보)
    core/boss.ts                   대장 판정(0.12.0): 구독이 이어질 때마다 GET /api/whoami, 200이면 `is_boss`만, 404·연결 실패·5xx면 전역 목록(`SWITCHBOARD_BOSS_ROLES`)으로 보고 다음 연결 때 다시. remote-inbox·remote-ask·permission이 같이 쓴다
    core/wire.ts                   역할 머리(`X-Switchboard-Role`과 옛 `X-Agent-Mail-Role`을 함께)와 묶음 거절(403 `outside your group`) 문구
    core/slot.ts                   번호 역할·presence(0.6.0): /api/slots/register로 `<역할>-N`을 받고(같은 기계·폴더면 원래 번호, 그 폴더를 다른 세션이 쥐고 있으면 세션 표지를 붙여 다음 번호), 상태가 바뀔 때·60초마다 heartbeat에 presence를 싣고(404면 다시 register), 단일 역할 -2 경고, takeover, 끌 때 release
    core/stall.ts                  멈춤 감지(0.8.0): 턴 실패 종류별 재시도(30초부터 두 배, 10분 상한, 8번), 안 풀리는 오류·권한 창·입력 대기를 presence 상태(`error:<종류>`·`blocked:<종류>`)와 한 번의 통지로
    core/remote-questions.ts       원격 질문 서버 클라이언트(0.10.0): /api/questions 올리기·보기·목록·poll·답·거두기(메일함의 call 로 인증), 답 메일 판정(`[질문 답] <id>`)·답 글. 대장 쪽(#112)도 쓴다
    core/remote-inbox.ts           원격 질문 대장 쪽(0.11.0): 대장 역할이면 대기 목록으로 채우고 poll 긴 대기로 서버 질문을 패널에 올리고(같은 id 한 번), answered·withdrawn 은 닫고, 패널 답을 POST answer 로(409 는 「이미 답함·거둠」)
    core/remote-ask.ts             원격 질문 묻는 쪽(0.10.0): ask 를 서버 질문으로(403·409·400·연결 실패면 로컬 패널로), 이 역할이 물은 질문의 답 메일을 「[질문 패널 답 <id>] 질문 = 고른 것」 글로, resolve 를 거두기로
    core/permission.ts             원격 권한 답(0.8.0): 요청을 /api/permissions 에 올리고 서버 긴 대기로 답을 기다린다. 부모·대장 base가 아닌 답은 버리고, 시간 안에 답이 없거나 답할 쪽이 없으면(409) 화면 창으로
    core/mailtest.ts               시험 도우미: 가짜 switchboard 서버(긴 대기 계약)와 메일함을 켠 코어 준비
    core/questions.ts              질문 패널 상태(쌓기·고르기·완료·답 없이 닫기·대화창 답·장부 읽기). 저장은 Store 포트, 보내기는 submitTurn, 장부는 선택 어댑터 LedgerLink
    core/testing.ts                시험 틀: 가짜 어댑터(fakeHost)·가짜 시계(advance)·가짜 http(경로 처리기·SSE 밀기/끊기)·가짜 fs
    core/*.test.ts                 코어 단위 시험(가짜 어댑터로)
    e2e/questions.e2e.ts           질문 경로 e2e(#157): 실제 switchboard 서버(고정 판 릴리스)에 묻는 세션·대장 세션 코어를 진짜 http로 붙여, 답이 묻는 세션에 정확히 한 번 들어오는지 센다(패널 답·대시보드 답·먼저 온 답·거두기·재시작·다른 번호로 돌아옴·가장 늦은 세션·기다렸다 넘김·다른 라벨·살아 있는 묻던 세션·죽은 세션 재시작 뒤 임대가 끝나면 옮김·읽은 답은 그대로·같은 폴더 두 세션·같은 폴더 다른 라벨·대장 참조 메일, 서버 v0.12.1). 실패 머리 `question source of truth: …`
    e2e/harness.ts                 e2e 틀: 서버 띄우기(임시 DB·실행마다 새 토큰), 진짜 http·시계 AgentHost, 대장 패널(질문 패널 코어) 배선
    e2e/run.sh, e2e/suite.sh       run.sh: 서버 릴리스를 받아 고정 해시·checksums.txt로 확인하고 e2e를 돌린다(16개 미만 통과면 실패). suite.sh mod|mcp: 기존 시험(0개면 실패, mod는 경우 7 「좁은 터미널(#136)」이 돌았는지도). `.github/workflows/switchboard.yml`(검사 이름 `switchboard`)이 plugins/switchboard를 건드리는 PR·main push에서 셋 다 돌린다
    adapters/claude.ts             Claude 어댑터: 모드 API로 포트를 구현(prompt.submit, 도구 결과 context, session.compact·usage, 턴·입력·compact 훅, $.http·$.clock·$.fs)
    adapters/ledger.ts             선택 어댑터: 닫힘 장부(MCP 서버 qp의 sync). 서버가 안 닿으면 장부 없이 혼자 돈다
    hooks/register.tsx             껍데기: 코어를 Claude 어댑터로 잇고 질문 패널을 그린다. hooks/register.test.tsx는 question-panel 시험을 이름만 바꿔 옮긴 것
    .mcp.json, mcp/                MCP 서버 qp(question-panel과 같은 코드, 장부·Orca 폴더도 같은 ~/.question-panel). 0.8.3부터 Orca 터미널 탭 세션(`ORCA_TERMINAL_HANDLE`)의 질문·닫힘도 handle 로 Orca 폴더에
  idle-compact/                    작업이 끝난 뒤 오래 입력이 없으면 자동 compact 하는 mod(hooks 모듈, Claude Code 2.1.312+)
    hooks/register.ts              turn.complete에서 30분 타이머(IDLE_MS)를 걸고, turn.start·prompt.change·prompt.submit에서 취소, 컨텍스트 MIN_PERCENT(15%) 미만이면 건너뜀
  context-cap/                     세션 컨텍스트 상한 훅(Node, issue-worker 본 세션 또는 환경변수가 있을 때 켜짐)
    hooks/context-cap.js           transcript 끝에서 마지막 본 세션 응답의 usage로 컨텍스트를 재고 UserPromptSubmit·PostToolUse·PreToolUse를 처리
    tests/                         가짜 transcript 시험(`node --test plugins/context-cap/tests`)
  harden/
    skills/harden/                 재발 방지 사다리: 구조→정적 검사→시험→훅→스크립트→산문, 실패 메시지·산문 줄 형식·보고 한 줄
  leak-guard/                      공개 저장소 유출 막는 PreToolUse(Bash) 훅(Node)
    hooks/leak-guard.js            git commit·push·gh pr create/edit 직전에 나갈 추가분만 내장 패턴+사용자 금지어로 검사
    tests/                         임시 git 저장소·가짜 gh 시험(`node --test plugins/leak-guard/tests`, 리눅스·macOS)
  root-cause/                      근본 원인 관문 훅(Node)
    hooks/prompt.js                UserPromptSubmit: 문제 신호가 있는 입력에 「증상 → 직접 원인 → 근본 원인을 증거로, 답에 `근본 원인:` 줄」 문맥
    hooks/gate.js                  PreToolUse(Bash): gh pr/issue create·switchboard send/reply(옛 `agent-mail`도)가 수정·장애 보고로 보이는데 `근본 원인:` 줄이 없으면 막는다
    hooks/signals.js, shell.js     신호 낱말(내장+사용자 목록)·끄기, 셸 명령 읽기(leak-guard 파서를 옮김)
    tests/                         가짜 훅 입력 시험(`node --test plugins/root-cause/tests`, Windows 포함)
orca-plugins/
  question-panel/                  Orca 플러그인(마켓플레이스 밖): question-panel 질문을 Orca 사이드바 카드로, 답은 그 터미널(채팅 세션은 오케스트레이션 메일함)로, 닫힘 장부로 Claude Code 패널과 상태를 맞춤, question-panel·switchboard 도구 이름 둘 다, 터미널 탭 세션의 질문 파일(0.6.0)
```

| 플러그인 | 스킬·에이전트 | 언제 불러오나 |
|---|---|---|
| issue-track | `issue-track` 스킬 | 「남은 이슈 차례로 1트랙으로 처리해줘」, 「이 저장소에 이것 고쳐 줘」「원격 기계에 맡겨」(한 건을 원격 작업자 세션에), 「플러그인 갱신」 |
| | `issue-track:issue-worker`, `issue-track:errand` 에이전트 | 조율자가 `Agent`의 `subagent_type`으로 띄운다 |
| django-asgi | `django-asgi-perf` | Django ASGI의 느린 요청, 연결 풀, SSE, async 미들웨어 |
| test-speed | `test-budgets` | 시험이 느리다, 한도를 세우거나 켠다, 고정 대기·흔들림을 없앤다 |
| | `fast-stable-e2e` | Playwright E2E가 느리거나 흔들린다, 폴링·고정 대기·재시도로 버틴다, 실시간 메시지 뒤의 화면을 기다린다 |
| | `mock-stack-shots` | 화면 작업의 확인·스크린샷 |
| token-diet | 훅 `read-guard`·`block-heredoc` | 설치하면 늘 켜진다 |
| | `token-diet` | 작업자가 토큰을 많이 쓴다, 지시서·에이전트 정의를 쓴다 |
| question-panel | 도구 `mcp__plugin_question-panel_qp__ask`·`mcp__plugin_question-panel_qp__resolve`(MCP 서버, resolve는 0.6.3부터; 그 전 이름 `mcp__question-panel__resolve`), 명령 `/questions`(열려 있으면 닫는 토글; `/questions close`는 늘 닫음, 0.8.0+)·`/questions-clear` | 모델이 결정 질문을 패널에 쌓고 턴을 끝낸다; 사용자가 답하고 완료를 누르면 답이 새 메시지로 온다(AskUserQuestion은 급한 확인만). 질문은 패널(데스크톱 앱·CLI·Orca 사이드바)에만 보이고 대화창에 다시 쓰지 않는다(0.7.0+). Orca 채팅 세션은 Orca 사이드바 질문 패널로 답한다(0.6.1+, 답은 `[질문 패널 답] qN` 오케스트레이션 메일). 글로 답해도 된다(예: `q4 1-2`). 패널이 안 보이는 화면(Remote Control·폰)에서는 환경변수 `QUESTION_PANEL_ECHO=1`로 질문을 대화창 블록으로도 옮겨 적게 한다 |
| switchboard | 도구 `mcp__plugin_switchboard_qp__ask`·`mcp__plugin_switchboard_qp__resolve`, 명령 `/questions`·`/questions-clear`·`/switchboard-takeover` | question-panel과 같다(이름의 플러그인 자리만 다르다). question-panel과 같이 켜지 않는다. 세션을 `SWITCHBOARD_PROFILE=<프로필>`로 띄우면 `$XDG_CONFIG_HOME`(없으면 `~/.config`)`/switchboard/<프로필>.json`(없으면 옛 폴더 `/agent-mail/<프로필>.json`)의 역할로 메일함을 구독해, 새 pending 메일을 턴이 끝난 뒤 「메일 #12, #13 을 읽고 처리하라」 새 턴으로 넣는다(메일 상태는 pending 그대로, 0.2.0). 프로필이 없으면 메일함은 꺼진다. 메일을 넣기 전에 유휴이고 컨텍스트가 `SWITCHBOARD_COMPACT_TOKENS`(기본 `200k`, `0`·`off`면 끔) 이상이면 compact부터 하고 끝난 뒤 넣는다. 요약 지시문은 `SWITCHBOARD_COMPACT_INSTRUCTIONS`(0.3.0). compact가 끝났는데 완료 훅이 오지 않으면 호출이 풀린 것을 완료로 보고, 5분 안에 끝나지 않으면 기다림을 풀고 메일을 넣으며 화면에 한 번 알린다. 컨텍스트 토큰 수를 모르면(0) 기준을 보지 않고 presence에도 싣지 않는다(0.8.4). 긴급 메일(`priority=urgent`)은 본문을 실행 중인 턴의 다음 도구 호출 결과 뒤에 끼워 넣고(유휴면 새 턴), 넣는 즉시 read로 표시한다(2000자 넘는 본문은 자르고 `switchboard read <ID>`를 붙인다, 0.4.0). 입력창에 글이 있는 동안과 사람이 보낸 턴(질문 패널 답 포함)이 끝난 뒤 `SWITCHBOARD_HOLD_MINUTES`분(기본 3, `0`이면 시간 보류 끔)은 일반 메일 턴을 미룬다. 긴급은 미루지 않는다(0.5.0). 연결할 때 기계·폴더로 번호(`<역할>-1`, `-2` …)를 받아 그 주소로 구독하므로 같은 프로필 세션이 둘이어도 번호 없이 온 메일은 `-1`만 받는다. 상태가 바뀔 때와 60초마다 presence(상태·컨텍스트 토큰·마지막 턴·`SWITCHBOARD_LABEL`·`SWITCHBOARD_PARENT`)를 보고한다. `boss`·`coordinator`(`SWITCHBOARD_SINGLE_ROLES`)가 `-2` 이상을 받으면 토스트로 경고하고, `/switchboard-takeover`로 `-1`을 가져온다(0.6.0). `SWITCHBOARD_PARENT`(부모 역할 주소)가 있으면 처음 연결될 때 부모에게 「연결됨(주소·라벨·기계·폴더)」 시스템 통지를 보내고, 받은 시스템 통지(제목 `[switchboard] `)는 ID 대신 본문 그대로 일반 메일 뒤에 넣는다. 띄우는 쪽이 `label:<기반 역할>/<라벨>`(예: `label:flow/worker/22`) 앞으로 미리 보낸 지시서는 `SWITCHBOARD_LABEL`이 그 라벨인 세션이 연결되자마자 받는다(0.7.0). 턴이 `rate_limit`·`overloaded`·`server_error`로 멈추면 30초부터 두 배(10분 상한, 8번까지) 뒤 「이어서 하라」 턴을 넣고, 다른 오류는 부모와 `SWITCHBOARD_BOSS_ROLES`(쉼표 목록)에, 권한 창·입력 양식은 부모에게 한 번 알린다(쉬는 세션의 `idle_prompt`는 막힘이 아니다, 0.8.5). 권한 창이 뜰 도구 호출은 먼저 부모·대장에게 요청을 올려 `SWITCHBOARD_PERMISSION_WAIT_SECONDS`초(기본 120, `0`이면 끔) 안에 온 답을 한 번만 쓰고, 없으면 평소 화면 창으로 넘긴다. Bash 자식 프로세스에는 `SWITCHBOARD_ROLE=<번호 역할>`(옛 CLI용 `AGENT_MAIL_ROLE`도)을 넘긴다(0.8.0). 질문 패널 MCP 서버(qp)가 붙은 세션의 `AskUserQuestion`은 막고 `mcp__plugin_switchboard_qp__ask`로 돌린다. 질문 `header`가 `급함`으로 시작하면 통과, `SWITCHBOARD_ALLOW_ASK_USER_QUESTION=1`이면 끈다(0.9.0). 프로필이 있는 세션의 `ask`는 switchboard 서버 질문(`q_…`)으로 올라가 대장 세션 패널·관리 대시보드에서 답하고, 답은 「[질문 패널 답 q_…] 질문 = 고른 것」 글로 들어온다. 서버가 403(`can_ask` 꺼짐)·409(답할 대장 없음)·400을 주거나 닿지 않으면 로컬 패널로 올리고 결과 글에 까닭을 적는다. 서버 질문은 묻는 세션의 패널에 띄우지 않는다. `resolve`에 `q_…`를 주면 거둔다(0.10.0). 역할(번호 역할이면 바탕)이 `SWITCHBOARD_BOSS_ROLES`에 든 대장 세션은 서버 대기 질문을 긴 대기로 끌어와 질문 패널에 「원격 질문 · 묻는 역할 …」로 띄운다(Orca 세션이면 Orca 사이드바 카드도, Orca 질문 패널 0.7.0+). 패널·Orca에서 고른 답은 `POST /api/questions/{id}/answer`로 가고 대장 세션 자신에게는 들어가지 않는다. 대시보드 등에서 먼저 답했거나 묻는 쪽이 거두면 닫히고, 409면 「이미 답함·거둠」으로 닫는다(0.11.0). 대장 세션에는 서버가 보내는 질문 참조 메일(보낸이 `switchboard/system`, 옛 이름 `agent-mail/system`, 둘 다 `-N` 포함, 제목 `[질문] q_…`·`[질문 답] q_…`)을 시스템 통지로 넣지 않고 read로만 표시한다 — 같은 질문이 패널에 이미 뜬다. 대장이 스스로 물은 질문의 답은 그대로 넣는다(0.11.1). 입력 중 보류는 사람이 친 글·기록 불러오기·되돌리기만 입력으로 보고(다음 답 추천·recap·플러그인 채우기·엔진 채우기는 아님), 마지막 입력 뒤 `SWITCHBOARD_TYPING_MINUTES`분(기본 5, `0`이면 상한 없음)이 지나면 글이 남아 있어도 메일을 넣는다(0.11.2). 서버 시스템 보낸이는 `switchboard/system`과 옛 `agent-mail/system`(·`-N`)을 함께 알아보고, 이 세션이 물은 질문의 답 메일은 긴급과 같은 길로 바로 넣는다(사람 보류·입력 중 미룸 없음, 바쁜 턴이면 다음 도구 호출 뒤, 0.12.4) |
| security-recon | `security-recon` | 인가 받은 새 서버·낯선 인프라를 바깥에서 점검한다, 클라우드 방화벽을 조인다, 방화벽을 좁힌 뒤 서비스가 죽었다 |
| idle-compact | 훅만(도구·명령 없음) | 설치하면 늘 켜진다. 작업이 끝나고 30분 동안 입력이 없으면 `/compact`와 같은 정리를 하고 알림을 띄운다 |
| context-cap | 훅만 | `claude --agent issue-worker` 본 세션은 기본으로, 그 밖에는 `CONTEXT_CAP_SOFT`·`CONTEXT_CAP_HARD`를 준 세션에서만 켜진다. 아래 「context-cap 쓰는 법」 |
| harden | `harden` | 같은 실수가 두 번째로 나왔다, 「재발 방지」「다시는 이러지 않게」「규칙에 추가해」「메모리에 적어 둬」 |
| leak-guard | 훅만 | 설치하면 늘 켜진다. 공개 저장소에서 `git commit`·`git push`·`gh pr create`/`edit` 직전에만 검사한다. 아래 「leak-guard 쓰는 법」 |
| root-cause | 훅만 | 설치하면 늘 켜진다. 문제 신고 입력에 근본 원인 문맥을 넣고, 원인 줄 없는 수정·장애 보고를 막는다. 아래 「root-cause 쓰는 법」 |

## question-panel → switchboard 이전

switchboard 0.1.0은 question-panel 0.9.0을 그대로 옮기고 코어와 AgentHost 포트를 나눈 것이다. 도구 이름만 `mcp__plugin_question-panel_qp__*`에서 `mcp__plugin_switchboard_qp__*`로 바뀐다. 두 플러그인을 함께 켜면 질문 도구(`ask`)가 둘 생기므로 기계마다 다음 순서로 옮긴다.

1. `/plugin marketplace update dev-kit` 뒤 `/plugin install switchboard@dev-kit`(켜기).
2. `/plugin disable question-panel@dev-kit`(끄기). 세션을 다시 띄운다.
3. 지침·스킬에 적힌 도구 이름을 `mcp__plugin_switchboard_qp__ask`·`…__resolve`로 바꾼다.
4. Orca를 쓰는 기계는 Orca 질문 패널을 0.5.2 이상으로 올린다(두 이름을 다 알아본다).

- 패널의 쌓인 질문은 옮겨지지 않는다(저장 키가 플러그인 이름을 따른다). 대기 중인 질문이 없을 때 옮긴다.
- 닫힘 장부·Orca 질문 폴더(`~/.question-panel/…`)는 그대로 같이 쓴다.
- 계획: 모든 기계가 옮기면 question-panel은 이 안내만 남기고 마켓플레이스에서 내린다.

## switchboard 협업자 연결

플러그인은 프로필 파일(`<설정 폴더>/switchboard/<이름>.json`)의 서버 주소·역할·토큰을 직접 읽는다. 협업자 PC에는 `switchboard` CLI가 `join` 한 번에만 필요하고, 플러그인이 붙는 데는 필요 없다.

1. 전역 대장이 1회용 코드를 만든다(대시보드 설정 「협업자」에서도 된다).

```
switchboard invite --prefix partner-a --role partner-a/alice --ttl 72h
```

2. 협업자 PC에서 코드를 쓴다.

```
switchboard join https://mail.example.com ABCD-1234 --role partner-a/alice
```

```
Role: partner-a/alice
Group: partner-a
Profile: ~/.config/switchboard/mail.example.com.json
SWITCHBOARD_PROFILE=mail.example.com
```

- `--profile NAME`이 없으면 서버 호스트 이름이 프로필 이름이 된다. 같은 이름 프로필이 있으면 코드를 쓰기 전에 실패한다.
- 프로필 파일은 권한 0600이고 토큰은 출력되지 않는다.
- `SWITCHBOARD_CONFIG_DIR`를 쓰면 출력 맨 앞에 `SWITCHBOARD_CONFIG_DIR=<폴더>` 줄도 붙는다.

3. 출력된 줄을 Claude Code 세션 env에 넣는다(`~/.claude/settings.json`).

```json
{
  "env": {
    "SWITCHBOARD_PROFILE": "mail.example.com"
  }
}
```

`SWITCHBOARD_CONFIG_DIR`가 출력됐으면 `"SWITCHBOARD_CONFIG_DIR": "<폴더>"`도 같은 `env`에 넣는다. 세션을 다시 띄우면 붙는다.

- 묶음 밖 역할에는 보낼 수 없다. 받은 메일에 회신은 된다.
- 묶음 대장(`partner-a/boss`) 판정은 서버 `/api/whoami`가 한다(switchboard 0.12.0 이상).

## context-cap 쓰는 법

작업자 세션 하나에 티켓을 계속 넣으면 컨텍스트가 상한 없이 커진다(한 세션이 400k까지 간 일이 있다). 조율자 지침의 글 규칙 대신 작업자 세션 안의 훅이 직접 재서 막는다.

- **켜기(기본)**: `claude --agent issue-worker`로 뜬 본 세션은 환경변수 없이 SOFT 250000·HARD 300000으로 켜진다. 판정은 훅 입력의 `agent_type`(본 세션은 이것만 오고, 서브에이전트 안 도구 호출은 `agent_id`도 함께 온다 — claude 2.1.318에서 확인). 그래서 서브에이전트, 에이전트 없이 뜬 세션(조율자·일반 세션), 목록에 없는 에이전트 세션은 그대로다.
  - 대상 에이전트 이름은 `CONTEXT_CAP_AGENTS`(쉼표 구분, 기본 `issue-worker`, `plugin:name` 꼴은 끝 이름으로도 맞춘다). 빈 값이면 기본 대상 없음.
- **켜기(환경변수)**: `CONTEXT_CAP_SOFT`·`CONTEXT_CAP_HARD` 중 하나라도 있으면 그 값만 쓴다(없는 쪽은 0). 에이전트와 상관없이 그 세션에 걸린다.
  `env CONTEXT_CAP_SOFT=250000 CONTEXT_CAP_HARD=300000 claude …`
- **끄기**: `CONTEXT_CAP_SOFT=0`(HARD를 주지 않으면 둘 다 0이 되어 issue-worker 본 세션도 꺼진다).
- **재기**: `transcript_path`를 끝에서부터 1MB씩 읽어, 사이드체인이 아닌 마지막 assistant 응답의 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. 그보다 compact 경계가 뒤에 있으면 0으로 본다.
- **SOFT 넘음**: `UserPromptSubmit`이 새 지시를 거절한다(「컨텍스트 N k — 상한 넘음. 새 세션에서 받으라」). 프롬프트에 「넘김」·`handoff`·`handover`가 있으면 통과(`CONTEXT_CAP_HANDOFF_PATTERN`으로 바꾼다). 하네스가 넣는 자동 알림(`prompt`가 `<task-notification>`으로 시작 — claude 2.1.318에서 배경 Bash 완료·Monitor 이벤트가 이 꼴이었고, 훅 입력에 출처 필드는 없다)은 사람 지시가 아니라서 통과한다. 그래서 배경으로 건 CI·배포 대기의 완료 알림은 상한을 넘어도 작업자를 깨운다. 진행 중인 티켓은 끊지 않고, 다음 `PostToolUse`에서 한 번 「지금 티켓을 마치고 보고에 『새 세션 필요(컨텍스트 N k)』를 넣고 더 일을 받지 마라」를 알린다.
- **HARD 넘음**: `PreToolUse`가 다음만 남기고 막는다 — 이름에 `handoff`·`hand-off`·`넘김`이 든 파일의 Write/Edit/Read, 배경 작업 출력 읽기(`TaskOutput`, `…/tasks/<id>.output` Read), `SendMessage`·`ToolSearch`·`TaskStop`·`KillShell`, 그리고 조각마다 보고·마무리용인 Bash(`switchboard send|reply|complete|ack`(0.2.3+, 옛 `agent-mail`도 0.2.2+), `cd`, `echo`, `tail`·`head`, `git status|add|commit|push|log|diff|show|rev-parse|branch|stash|fetch|pull|rebase|worktree|switch|checkout`, `gh issue|pr comment|view|list|checks|status|merge|close`, `gh run view|list`, `wait-ci.py`·`wait-deploy.py` 실행, `orca orchestration send|reply`, `kill`, `fuser -k`). 하던 티켓의 CI·배포 대기, 병합, 정리는 끝낼 수 있게 둔다. 저장소 몫 정리 명령은 `CONTEXT_CAP_ALLOW_BASH`(정규식 하나)로 더한다. 따옴표 밖 명령 치환(`$(…)`·백틱)은 막는다.
- **알림 명령(선택)**: `CONTEXT_CAP_NOTIFY_CMD`가 있으면 SOFT를 처음 넘을 때 한 번 셸로 띄운다. 환경에 `CONTEXT_CAP_TOKENS`·`CONTEXT_CAP_SESSION_ID`. 기다리지 않고, 실패해도 훅은 성공.
- **중복 막기**: 세션별 상태 파일 `$TMPDIR/context-cap/<session_id>.json`(`CONTEXT_CAP_STATE_DIR`로 바꾼다).
- 선의의 작업자를 멈추는 가드레일이지 보안 경계가 아니다(따옴표 안 명령 치환 등은 거르지 않는다).

## leak-guard 쓰는 법

공개 저장소로 나갈 내용에 비밀이나 내부 이름이 섞이면 Bash 도구 호출을 막는다(exit 2, 이유는 모델에게 간다). 저장소가 공개일 때만 검사하고(`gh repo view --json visibility`, 원격 URL별로 `~/.cache/leak-guard/visibility.json`에 하루 캐시, `LEAK_GUARD_TTL`초로 바꿈), `gh`로 판별이 안 되면 검사한다.

| 명령 | 보는 것 |
|---|---|
| `git commit` | `git diff --cached`의 `+` 줄(`-a`·`--all`이면 `git diff`도), 그 commit 명령의 인자(`-m` 메시지 등), `-F`·`--file`·`-t` 파일의 내용(`-F -`면 heredoc·here-string) |
| `git push` | 나갈 커밋들의 `+` 줄과 메시지. 기준은 업스트림, 없으면 원격 기본 브랜치, 그것도 없으면 원격에 없는 커밋. 중간 커밋에서 지운 값도 역사에 남으므로 걸린다 |
| `gh pr create`·`gh pr edit` | 그 명령의 인자(제목·본문, `$(cat <<'EOF' …)` 포함), `--body-file`의 내용(`-`면 heredoc), create는 나갈 커밋들도 |

명령 글은 셸 문법(따옴표·`$(…)`·heredoc·`;`·`&&`·`|`)대로 단순 명령으로 나눠 **그 git·gh 명령의 인자만** 본다. 그래서 `cd <홈 경로>/x && git commit -m '…'`의 cd 경로, 환경변수, 앞뒤의 다른 명령에 금지어가 있어도 막지 않는다. 파일 경로 인자(`-F`·`--body-file`)는 경로가 아니라 내용을 본다. 다만 다음은 명령 글 전체를 본다(fail-closed): 읽지 못하는 명령(닫히지 않은 따옴표·heredoc), 실행 자리에 있는데 단순 명령으로 설명되지 않는 트리거(`$(git commit …)` 등), 파이프로 들어오는 메시지(`echo … | git commit -F -`). `bash -c '…'`·`eval`·`bash <<EOF`는 안의 명령을 다시 나눠 본다.

패턴은 두 겹이다.

1. 내장 일반 패턴: CGNAT 대역(100.64.0.0/10) IP, 개인 키 머리말, GitHub·Anthropic·OpenAI·AWS·Slack·Google·Stripe 토큰 꼴. <!-- leak-guard:allow -->
2. 사용자 금지어 파일(저장소 밖): `LEAK_GUARD_PATTERNS`, 없으면 `$XDG_CONFIG_HOME/leak-guard/patterns.txt`(보통 `~/.config/leak-guard/patterns.txt`). 파일이 없으면 1만 쓴다.

```
# ~/.config/leak-guard/patterns.txt — 한 줄에 정규식 하나(JavaScript 문법, 대소문자 무시). # 로 시작하면 주석, 빈 줄 무시
example\.internal
\bbuild0[0-9]\b
my-private-repo
```

- 막을 때는 `파일:줄 — 패턴 이름 [가린 값]`만 보인다. 사용자 패턴의 이름은 `patterns.txt:3`처럼 금지어 파일의 줄 번호다. 걸린 값 전체는 출력하지 않는다.
- 금지어 파일의 정규식이 틀리면 고칠 줄을 알려 주며 막는다(조용히 건너뛰지 않는다).
- 예외: 걸린 줄에 `leak-guard:allow`를 남기면 그 줄은 넘긴다(문서의 예시 IP처럼 정말 공개해도 되는 값). **이 표시는 그 줄을 공개 저장소에 그대로 내보낸다** — 내부 이름·토큰을 넘기는 데 쓰지 말고, 표시가 붙은 줄은 리뷰에서 본다. 표시는 저장소에 남아 누구나 볼 수 있으니 남용이 드러난다.
- 금지어 목록 자체를 공개 저장소에 두지 않는다. 기계마다 저장소 밖에 두거나 비공개 저장소·동기화 폴더에서 링크한다.
- 시험(`node --test plugins/leak-guard/tests`)은 가짜 `gh`가 셸 스크립트라 리눅스·macOS에서 돈다. 훅 자체는 Windows Git Bash에서도 돈다(`/c/...` 경로를 바꿔 읽는다).

## root-cause 쓰는 법

증상만 막고 「왜 처음에 일어났나」를 건너뛰지 못하게 한다. 사례: 배포 때마다 캐시 연결 오류가 쌓여 경고로 낮추고 걸러내기로 했는데, 진짜 원인은 배포가 떠다니는 태그(`redis:7-alpine` 같은)의 기반 이미지를 매번 pull해 상류가 새 이미지를 낼 때마다 상태 있는 컨테이너가 다시 만들어지던 것이었다.

| 훅 | 언제 | 하는 일 |
|---|---|---|
| UserPromptSubmit `prompt.js` | 입력에 문제 신호(오류·에러·안 돼·깨짐·뜨는데·느려·장애·실패·이상해·왜 …·버그·멈춤, 4xx·5xx 숫자, Traceback, Exception, error·fail·crash …) | 「증상 → 직접 원인 → 근본 원인(무엇이 바뀌었나)을 시각 상관·변경 이력·로그로 확인하고 답에 `근본 원인:` 줄, 모르면 `근본 원인: 미확인 — <다음 확인할 것>`, `diagnosing-bugs` 스킬」 문맥을 넣는다. 막지 않는다 |
| Stop `stop.js` | 턴이 끝날 때 | 이번 턴 답에 단정한 `근본 원인:` 줄이 있는데 모양 있는 `증거:` 줄이 없으면 한 번 되돌려(exit 2) 증거를 붙이거나 `미확인 — …`으로 바꾸게 한다 |
| PreToolUse(Bash) `gate.js` | `gh pr create`·`gh issue create`·`switchboard send`·`switchboard reply`(경로·`.exe` 꼴, 옛 `agent-mail`도) | 수정·장애 보고로 보이는데 `근본 원인:` 줄(`Root cause:`, `## 근본 원인` 절도)이 없으면 막고(exit 2) 고칠 법을 알린다 |

수정으로 보는 기준(잘못 막지 않는 쪽으로 좁게):

- 제목(`--title`·`-t`, 메일 `--subject`)이 `fix:`·`fix(…):`·`hotfix`·`bugfix` 꼴이거나 문제 신호 낱말이 있다. 단 `feat:`·`docs:`·`chore:`·`test:`·`refactor:` 같은 머리말이나 「추가·도입·문서·감지·알림·처리」 같은 기능 낱말이 있으면 제목의 신호 낱말은 보지 않는다.
- 본문(`--body`·`-b`, `--body-file`·`-F`는 파일 내용, `-`·메일 stdin은 heredoc)에 문제 신호 바로 뒤에 소음 동사(경고로 낮춤·걸러냄·억제·무시·우회, suppress·silence·ignore)가 붙은 구절이 있다. 메일은 수정 동사(고쳤·해결했·재시작으로, fixed·resolved)도 본다.

통과:

- 원인 줄이 있다. 빈 `근본 원인:`은 치지 않는다. 수정이 아니면 `근본 원인: 해당 없음 — <까닭>`으로 넘긴다.
- 짧은 확인 메일: 본문 80자 이하 + 받음·확인·완료·접수·감사·ok 같은 낱말.
- 본문 파일을 못 읽거나 명령 글을 읽지 못하면 통과한다(관문이지 보안 경계가 아니다).

설정:

- 사용자 신호 목록(저장소 밖): `ROOT_CAUSE_SIGNALS`, 없으면 `$XDG_CONFIG_HOME/root-cause/signals.txt`(보통 `~/.config/root-cause/signals.txt`). 한 줄에 정규식 하나(JavaScript, 대소문자 무시), `#` 주석. 틀린 줄은 건너뛴다. 두 훅이 같이 쓴다.
- 끄기: `ROOT_CAUSE_OFF=1`.
- 홈은 `os.homedir()`로 찾아 `HOME`이 없는 Windows(PowerShell)에서도 돈다. Git Bash의 `/c/…`·`~/…` 본문 파일 경로도 읽는다.

Stop 훅(`stop.js`):

- 답 글은 Stop 입력의 `last_assistant_message`를 먼저 쓰고, 이번 턴(마지막 사람·주입 user 메시지 뒤. 도구 결과만 담은 메시지는 경계가 아니다)의 transcript 글을 더해 본다. 기록이 아직 없으면 0.3초 뒤 한 번 다시 읽고, 그래도 못 찾으면 통과한다.
- 걸리는 줄: `근본 원인:` 값이 단정일 때. `해당 없음 — …`·`미확인 — …`은 걸리지 않는다. 코드 펜스·인용(`>`) 안의 줄은 뺀다. 줄 정의는 `gate.js`와 같은 모듈(`hooks/rootline.js`)에서 쓴다.
- 통과: `증거:` 줄 값에 백틱 명령, 경로(`/`·`\`), `#번호`, 커밋 sha(16진 7자 이상), 시각(`HH:MM`), `파일:줄` 중 하나가 있다. 「증거: 확인함」은 통과하지 못한다.
- 한 턴에 한 번만 되돌린다(`stop_hook_active`가 true면 통과).
- 이번 턴 도구 호출이 0인 단정은 막지 않고 기록만 한다: `ROOT_CAUSE_LOG`, 없으면 `$XDG_STATE_HOME/root-cause/no-tool-assertions.jsonl`(보통 `~/.local/state/root-cause/…`). 한 줄에 시각·세션 id·단정 줄(200자까지). 오탐 비율을 잰 뒤 막을지 정한다.
- 끄기는 같은 `ROOT_CAUSE_OFF=1`. SubagentStop은 다루지 않는다.

## 소개 글

왜 이렇게 만들었는지는 아래 글에 적었다.

- [토큰 줄이기·작업자 운영](https://sandcorp.co.kr/blog/devkit-1-tokens-orchestration)
- [시험 속도](https://sandcorp.co.kr/blog/devkit-2-test-speed)
- [훅·질문 패널](https://sandcorp.co.kr/blog/devkit-3-hooks-panel)
- [짧은 개발 팁 모음](https://sandcorp.co.kr/tips)

## 바뀐 것

### 2026-11-19 — root-cause 0.2.1: HTTP 4xx·5xx 신호 오탐 (#155)

- 「HTTP 4xx·5xx」 신호가 16진 ID(`q_7d415b54`)·sha 안의 숫자에 걸리던 것을, 숫자 앞뒤에 영문자·숫자·`_`가 붙으면 제외하도록 고쳤다(한글이 붙은 「500에러」는 그대로 잡힌다).
- 「[질문 패널 답」으로 시작하는 입력은 사용자가 고른 선택지를 옮긴 글이라 검사하지 않는다.

### 2026-11-19 — root-cause 0.2.0: 근본 원인 줄에 증거를 요구하는 Stop 훅 (#153)

- 대화창 보고의 단정한 `근본 원인:` 줄에 `증거:` 줄이 없으면 턴을 한 번 되돌린다. 「근본 원인 줄」 정의는 `rootline.js` 한 곳으로 모아 `gate.js`와 같이 쓴다.
- 도구 호출 0인 단정은 막지 않고 로컬 jsonl에 기록만 한다.
- 시험: root-cause 25건.

### 2026-11-18 — switchboard 0.12.6·issue-track 0.9.2: 옛 이름 남은 것 (#149)

- #148에 이어 남은 옛 이름을 걷었다. issue-track `reference/switchboard.md`가 은퇴한 대기 스크립트(`agent-mail-wait`)와 「메일은 세션을 깨우지 않는다」를 가르치고 있었다. 조율자는 switchboard 플러그인 구독으로 깨어난다고 고쳤다.
- switchboard가 세션에 넣는 글의 표시 이름 「Agent Mail」을 「메일」로(「메일 #12 을 읽고 처리하라」「[긴급 메일 #N]」「[메일 #N 시스템 통지]」), 주석·문서의 「Agent Mail 서버」를 「switchboard 서버」로 바꿨다. 이 글을 읽어 들이는 곳은 없다(Orca 질문 패널은 「원격 질문 q_… 로 올렸다」만 본다).

### 2026-11-18 — 옛 이름 agent-mail 걷어내기: switchboard 0.12.5·root-cause 0.1.1·context-cap 0.2.3·issue-track 0.9.1 (#148)

- 메일함 이름을 `switchboard`로 정본화했다. 옛 이름 `agent-mail`·`AGENT_MAIL_*`은 3단계에 지울 대체값으로만 남기고 그 자리에 `3단계에 제거` 주석을 달았다.
- switchboard: `SWITCHBOARD_*` 환경변수가 정본, `AGENT_MAIL_*`은 새 이름이 비었을 때만. 설정 폴더는 프로필 파일마다 `switchboard/` → 옛 `agent-mail/` 순으로 찾는다(새 폴더에 다른 프로필만 있어도 이 프로필은 옛 폴더에서 찾는다). 세션에 넣는 안내 문구의 CLI를 `switchboard read <ID>`로.
- root-cause: 관문이 `switchboard send`·`reply`를 거른다(`~/.local/bin/switchboard`·절대 경로·`switchboard.exe`·`SWITCHBOARD_PROFILE=x switchboard …` 꼴 포함). 옛 `agent-mail send/reply`도 함께.
- context-cap: HARD 허용 Bash에 `switchboard send|reply|complete|ack`(경로·`.exe`·`SWITCHBOARD_PROFILE=` 앞붙이).
- issue-track: `reference/agent-mail.md` → `reference/switchboard.md`, 문서·작업자 지시의 명령을 `switchboard …`로. `update-plugins.py`는 `switchboard`를 먼저 찾고 없을 때만 `agent-mail`을 부른다.
- 시험: switchboard mod 246건·MCP 22건, root-cause 14건, context-cap 22건, issue-track 69건.

### 2026-11-18 — root-cause 0.1.0: 근본 원인 관문 (#146)

- 새 플러그인. 문제 신고 입력에 근본 원인 문맥을 넣는 UserPromptSubmit 훅과, 수정·장애 보고(`gh pr create`·`gh issue create`·`agent-mail send`·`reply`)에 `근본 원인:` 줄이 없으면 막는 PreToolUse(Bash) 훅. 위 「root-cause 쓰는 법」.
- 이 저장소의 지난 PR 72건·이슈 74건에 돌려 보니 PR 2건(그중 1건은 실제 수정), 이슈 5건(모두 실제 버그 신고)이 걸렸다.
- 시험: `node --test plugins/root-cause/tests` 13건.

### 2026-11-18 — switchboard 0.12.4: 새 시스템 보낸이 `switchboard/system`과 질문 답 바로 넣기 (#144)

- 원인 둘: 서버가 시스템 메일을 새 보낸이 `switchboard/system`으로 보내는데 mod는 `agent-mail/system`(·`-N`)만 시스템 보낸이로 알아봐 `[질문 답]` 메일이 일반 메일이 됐다(「일반 메일 1통 미룸 — 답 읽는 시간 보류」). 보낸이가 맞아도 시스템 통지는 일반 메일과 같은 관문(유휴·사람 보류·입력 중)을 타서, 패널에서 답한 직후 온 답 메일은 보류 시간 동안 들어가지 않았다.
- 시스템 보낸이 판별(`core/mailbox.ts` `isSystemSender`)이 `switchboard/system`·`agent-mail/system`과 그 `-N`을 함께 알아본다. 답 메일 판별(`answerMailId`)·참조 메일 거르기·서버 시스템 통지가 이 하나를 쓴다.
- 시스템 보낸이의 `[질문 답] …` 메일은 긴급과 같은 길: 이 세션이 물은 질문이면(`onNotice`가 글을 주면) 유휴면 새 턴, 바쁘면 다음 도구 호출 결과 뒤에 「[질문 패널 답 …]」을 넣고 read 처리한다. 이미 세션에 직접 넣은 답(#138 settle)과 대장 세션의 참조 사본은 read로만. 다른 역할 질문의 참조 사본은 평소 시스템 통지 길(보류 따름).
- 시험: mod 245건(새 5: 새 보낸이 답이 보류 시간 안에 바로 1회, 입력 중에도 바로·일반 메일은 미룸, 바쁜 턴에 끼워 넣기, 옛 보낸이, 참조 사본은 보류 따름; 권한·서버 시스템 통지 시험을 새 보낸이로), MCP 22건, `tsc --noEmit -p plugins/switchboard` 초록. 운영 서버 확인은 하지 않았다.

### 2026-11-18 — switchboard 0.12.3·Orca 질문 패널 0.7.1: 원격 질문의 Orca 답이 두 번 들어가던 것 (#142)

- 원인: Orca 터미널 세션의 `agent.tool.after` 훅(`orca-plugins/question-panel/worker/main.ts`)이 서버 질문으로 올린 `ask` 호출에도 터미널 카드를 만들었다. 결과 글에 「질문 묶음 qN」이 없어 `o<N>` id를 붙였고, 같은 질문의 원격 카드(대장 끌어오기가 올린 `v: 2` 파일)와 카드가 둘이 됐다. 원격 카드 답은 서버·세션으로 한 번, `oN` 카드 답은 터미널에 「[질문 패널 답 oN] …」으로 한 번 더 들어갔다.
- switchboard: 서버 질문으로 올린 `ask`는 MCP 호출 입력에 `panel_remote: q_…`를 싣는다.
- Orca 질문 패널: 입력의 `panel_remote` 또는 결과 글의 「원격 질문 q_… 로 올렸다」가 있으면 훅에서 카드를 만들지 않는다(옛 switchboard도 결과 글로 걸린다). 서버 질문의 Orca 카드는 원격 카드 하나뿐이고, 그 답은 장부 → 대장 switchboard → 서버(200이면 답 메일, 403이면 거두고 세션에 직접) 한 길로 한 번 들어간다. 대장 세션이 아닌 Orca 터미널 세션의 서버 질문도 터미널 카드가 생기지 않는다.
- Orca 질문 패널은 따로 설치한다(`orca-plugins/question-panel/README.md` 「설치」). 0.7.0 그대로면 `oN` 카드가 계속 생긴다.
- 시험: mod 240건(`claude plugin test plugins/switchboard`), MCP 22건(`node --test plugins/switchboard/mcp`), `tsc --noEmit -p plugins/switchboard` 초록, Orca 72건(Orca 설치의 `orca-test-register.mjs`로 `node --test`). Orca 쪽 tsc 는 `.orca/types`를 만들지 못해 못 돌렸다.

### 2026-11-18 — issue-track 0.9.0: update-plugins 원격 PowerShell·모든 범위·범위별 판 검증 (#140, #127)

- 원격 셸 판별: 설정 `update.shells: {"<별칭>": "powershell"|"posix"}`가 먼저, 없으면 `ssh <별칭> 'echo $PSVersionTable.PSVersion.Major'`가 숫자면 PowerShell, 아니면 posix. PowerShell 원격은 `PATH=` 접두 없이 `Set-Location -LiteralPath '<폴더>' -ErrorAction Stop; claude plugin update <id> --scope local; exit $LASTEXITCODE` 꼴로 돈다(작은따옴표는 `''`). posix 원격은 그대로 `cd '<폴더>' && PATH="$HOME/.local/bin:$PATH" claude …`.
- `plugin list --json`의 설치를 범위마다(user·project·local, 폴더마다) 갱신하고, 끝에 다시 읽어 「범위별 판」 표(기계·플러그인·범위·폴더·판·최신·상태)를 찍는다. 최신 판은 그 기계 마켓 클론(`plugin marketplace list --json`의 `installLocation`)의 `marketplace.json` 항목 version, 없으면 source 폴더의 `.claude-plugin/plugin.json`. 못 읽으면 그 기계에 깔린 가장 높은 판.
- 종료 코드 1: 기계 명령(마켓 갱신·목록) 실패, 갱신 명령 실패, 최신보다 옛 판이 남은 설치(표 아래 「옛 판이 남은 설치」). Windows 경로의 폴더 이름(`C:\work\proj` → `proj`)도 표에 나온다.

### 2026-11-18 — switchboard 0.12.2: 대장 질문도 서버 먼저 (#138)

- 0.12.1의 「대장 세션 `ask`는 `POST /api/questions` 없이 로컬」을 되돌린다. 역할과 무관하게 서버에 먼저 올리고, 연결 실패·5xx·403·400이면 지금처럼 까닭을 붙여 로컬 패널로 간다. 409(대장 질문을 받지 않는 옛 서버)면 까닭 줄 없이 로컬로 간다.
- 대장 자기 질문: 묻는 쪽 결과 글은 「이 세션의 질문 패널과 관리 대시보드에 뜬다」로 바뀌고, 패널에는 같은 세션의 대장 끌어오기(`remote-inbox`)가 한 번만 올린다 — 서버가 `can_answer: false`로 줘도 이 역할이 물은 질문(올린 id 또는 같은 base asker)이면 올린다. 같은 서버 id는 두 번 올리지 않는다.
- 패널 답: 먼저 `POST /api/questions/{id}/answer`. 200이면 서버의 답 메일이 세션에 한 번 들어간다. 409·404면 「이미 답함·거둠」으로 닫는다(대시보드 답 메일이 들어간다). 403(대표만 답하는 질문)·연결 실패·그 밖 오류면 서버 질문을 거두고(withdraw) 답 글 「[질문 패널 답 q_…] 질문 = 고른 것」을 세션에 직접 넣는다. 그 뒤 같은 id의 답 메일은 넣지 않고 read로만 표시한다.
- 좁은 터미널 토스트·`/questions` 열기(0.12.1)는 그대로다.

### 2026-11-18 — switchboard 0.12.1: 대장 질문은 로컬로, 좁은 터미널에서도 질문 보이기 (#136)

- 대장 세션(`core/boss.ts` 판정이 대장)의 `ask`는 `POST /api/questions`를 부르지 않고 곧장 로컬 패널에 올린다. 결과 글에 「답할 대장 역할이 없음(409)」 줄이 붙지 않는다. 판정 전(연결 전·whoami 묻는 중)과 대장 아닌 세션은 그대로 올려 보고, 403·409·400·연결 실패면 까닭을 붙여 로컬로 간다.
- 좁은 터미널: 모델이 부른 질문으로 연 패널은 Claude Code가 「묻지 않고 연 pane」으로 보아 144열(사람이 한 번 연 뒤로는 110열) 아래에서는 자리를 주지 않고 기다리게 한다. `$.ui.open`에는 아래칸 같은 배치 옵션이 없다(`placement`는 데스크톱 앱의 `widget`뿐). 그래서 패널이 자리를 못 잡으면 `질문 q3: 어느 DB를 쓸까요? 외 1 — /questions 로 연다` 토스트를 20초 띄운다(원격 질문 대장 쪽도 같다). 대화창 줄(`ui.log`)은 0.11.4대로 남기지 않는다.
- `/questions`: 자리를 못 잡고 기다리는 패널은 열린 것으로 치지 않아, 좁은 터미널에서 `/questions`를 치면 닫히지 않고 열린다(사람이 연 pane은 폭과 상관없이 자리를 잡는다).

### 2026-11-18 — switchboard 0.12.0: 협업 묶음 대장 판정·SWITCHBOARD_* 이름 (#130)

- 대장 판정: 메일함 구독이 이어질 때마다(처음·끊긴 뒤·번호 역할을 받은 뒤) `GET /api/whoami`를 묻는다. 200이면 `is_boss`만 본다 — true면 원격 질문 대장 쪽(서버 질문 끌어오기)·참조 메일 거르기를 켜고, false면 `SWITCHBOARD_BOSS_ROLES`에 들어 있어도 끈다. 404(옛 서버)면 지금처럼 전역 목록으로 본다. 연결 실패·시간 초과·5xx·모양이 틀린 응답도 전역 목록으로 떨어지고 다음 연결 때 다시 묻는다. 묻는 동안·아직 안 이어졌을 때는 대장이 아니다(판정이 나면 곧 다시 본다). 판정은 `core/boss.ts` 하나로 모아 remote-inbox·remote-ask·permission이 같이 쓴다.
- 권한 답: whoami가 200인 서버(협업 묶음을 아는 서버)에서는 답한 쪽을 부모·전역 대장 목록으로 거르지 않고 요청자 base만 버린다. 답할 쪽(부모·전역 대장·묶음 대장)은 서버가 이미 가렸고, 그러지 않으면 묶음 대장의 답을 버리게 된다.
- 이름: 새 이름이 먼저고 옛 이름도 읽는다. 프로필 `SWITCHBOARD_PROFILE` > `AGENT_MAIL_PROFILE`, 폴더 `SWITCHBOARD_CONFIG_DIR` > `AGENT_MAIL_CONFIG_DIR`, 설정 폴더 아래 `switchboard/` 먼저 그다음 `agent-mail/`. `SWITCHBOARD_ENDPOINT`·`SWITCHBOARD_TOKEN`(옛 `AGENT_MAIL_ENDPOINT`·`AGENT_MAIL_TOKEN`)이 있으면 프로필의 주소·토큰을 덮어쓴다. 역할은 env에서 읽지 않는다(자식 셸에 넘긴 번호 역할을 다음 세션이 물려받아 잘못 구독하지 않게). `AGENT_MAIL_PROFILE`만 가진 세션은 그대로 돈다.
- 머리: `X-Switchboard-Role`과 옛 `X-Agent-Mail-Role`을 같은 값으로 함께 보낸다(새 서버는 둘 다 받고, 옛 서버는 옛 머리로 역할을 고른다). 자식 셸에는 번호 역할을 `SWITCHBOARD_ROLE`과 `AGENT_MAIL_ROLE` 둘 다로 넘긴다.
- 묶음 거절: 보내기·번호 역할(presence)·권한 요청·질문 API가 403 `outside your group`을 받으면 숫자 대신 「묶음 밖 역할에는 보낼 수 없다(받은 메일에 회신은 된다)」로 남긴다. switchboard는 metrics·progress API를 부르지 않으므로 묶음 역할에서 막을 호출은 없다.

### 2026-11-17 — switchboard 0.11.4: 질문 올릴 때 패널 자리 알림 없애기 (#128)

- 질문 도구를 부를 때 패널이 아직 자리를 못 잡았어도 「질문 패널이 아직 자리를 못 잡았습니다」 줄을 대화창에 남기지 않는다. 패널은 그대로 열기를 기다리고, 명시적으로 패널을 여는 명령(/questions 등)의 「열지 못했습니다」 안내는 그대로다.

### 2026-11-17 — switchboard 0.11.3: 긴 작업 턴 뒤에는 읽기 보류 없음 (#125)

- 사람이 지시하고 세션이 오래 작업한 턴이 끝나도 메일이 「사람 입력 뒤 보류」로 3분 더 늦게 들어오던 것을 고친다. 사람 턴이 시작된 때(사람 입력 시각)부터 끝날 때까지가 `SWITCHBOARD_HOLD_SHORT_TURN_MINUTES`분(기본 2) 이상이면 끝난 뒤 읽기 보류를 걸지 않고 곧 메일을 넣는다. 짧은 턴(대화)은 예전처럼 `SWITCHBOARD_HOLD_MINUTES`분 동안 미룬다.
- `SWITCHBOARD_HOLD_SHORT_TURN_MINUTES=0`은 「기준 없음」이다: 턴이 아무리 길어도 예전처럼 늘 보류한다(보류를 끄려면 `SWITCHBOARD_HOLD_MINUTES=0`).
- 상태 글자를 「답 읽는 시간 보류(SWITCHBOARD_HOLD_MINUTES)」로 바꿔 입력 중 보류와 구분한다. 입력 중 보류·긴급 메일 규칙은 그대로다.

### 2026-11-17 — switchboard 0.11.2: 추천·recap을 입력으로 보지 않기 (#123)

- 사람이 안 쳤는데 「입력창에 글이 있음」으로 일반 메일을 미루던 것을 고친다. 재현(Haiku, tmux 대화형): 다음 답 추천은 `prompt.suggest`(origin `suggestion`)만 오고 입력창을 바꾸지 않으며, 「※ recap:」(3분 자리 비움 뒤)과 `/recap`은 `prompt.*` 이벤트를 내지 않았다. 기록 불러오기는 `prompt.change` origin `history`, 제출·Esc·Ctrl+C는 `clear`, 되돌리기는 `undo`, 사람이 친 글은 `prompt.edit`(origin `composer`)로 왔다. 이 기계에서는 두 의심 경로 모두 재현되지 않아, 원인으로 남은 `prompt.change`의 `plugin`(다른 플러그인 채우기)·`engine`(prefill·받아들인 완성 등)·`app`을 막고 상한을 걸었다.
- 입력 중은 `prompt.edit`과 `prompt.change`의 `history`·`undo`만 켠다. 그 밖의 `prompt.change`는 입력창을 비웠을 때만 따른다(입력 중을 푼다).
- 마지막 사람 입력 뒤 `SWITCHBOARD_TYPING_MINUTES`분(기본 5, `0`이면 상한 없음)이 지나면 글이 남아 있어도 입력 중을 풀고 메일을 넣는다. 미룸 까닭에 「마지막 입력 N분 뒤」를 적는다.
- 시험: mod 195건(코어 7·어댑터 2 추가), 서버 22건.

### 2026-11-17 — switchboard 0.11.1: boss 세션은 질문 watcher 메일을 넣지 않기 (#120)

- 대장 세션(원격 질문 대장 쪽이 켜지는 세션: 패널이 있고 역할이 `SWITCHBOARD_BOSS_ROLES`에 듦)에 서버의 참조 메일 「[질문] q_…」「[질문 답] q_…」(보낸이 `agent-mail/system`, task_id `q_…`)이 시스템 통지로 본문째 들어오던 것을 막는다. 같은 질문이 패널에 이미 뜨므로 세션에는 넣지 않고 read로만 표시한다. 대장이 스스로 물은 질문의 답은 그대로 「[질문 패널 답 …]」으로 넣는다.
- 메일함 `onNotice` 듣는 쪽이 `DROP_NOTICE`를 돌려주면 그 통지는 넣지 않고 read로만 표시한다. 한 묶음이 모두 걸러지면 턴을 열지 않는다.
- 대장이 아닌 세션은 그대로(자기 질문 답 → 「[질문 패널 답 …]」, 참조 사본 → 평소 통지).
- 시험: mod 186건(코어 4 추가), 서버 22건. Orca 질문 패널은 바꾸지 않았다(이 기계에 Orca 시험 하네스가 없어 못 돌림).

### 2026-11-17 — switchboard 0.11.0: 원격 질문 — boss 패널 (#112)

- 상위 #106의 대장 쪽. 메일함 역할(번호 역할이면 바탕)이 `SWITCHBOARD_BOSS_ROLES`(원격 권한 답과 같은 판정)에 들면 켠다. 아니면 질문 API를 부르지 않는다.
- 시작할 때 `GET /api/questions?status=pending`으로 채우고, 그 뒤 `GET /api/questions/poll?after=<커서>` 긴 대기(서버 상한 55초)를 반복한다. `pending`이고 `can_answer`인 질문을 로컬 질문 패널에 묶음 qN으로 올리고 카드에 「원격 질문 · 묻는 역할 …」을 보인다. 같은 서버 id는 두 번 올리지 않는다(패널 큐에 같은 id가 있으면 재시작 뒤에도). 시작할 때 서버 대기 목록에 없는 대기 원격 묶음은 닫는다.
- 패널에서 고른 답(선택 label들·「기타」 글)은 `{answers:[{selected:[…], other?}]}`로 `POST /answer`. 200이면 닫고(「서버에 답함」), 409·404면 「이미 답함·거둠(원격)」으로 닫고, 닿지 않으면 대기로 되돌린다. 대장 세션 자신에게는 답을 턴으로 넣지 않는다. poll에 `answered`·`withdrawn`이 오면 닫는다. 연결 실패는 5초부터 두 배(5분 상한)로 다시 해 본다. 세션이 끝나면 루프를 멈춘다.
- 원격 묶음은 답 없이 닫아도 이 패널에서만 내리고(서버 질문은 그대로), 대화창 글(「q4 1-2」)로 닫히지 않는다.
- Orca 사이드바: 올린 묶음을 장부 도구 `sync`의 `offer`로 Orca 질문 폴더에 v2 파일(`remote:{id, asker}`)로 남긴다. Orca 질문 패널 0.7.0은 그 카드의 답을 터미널·메일함에 넣지 않고 닫힘 장부 기록에 `answers`로 남기고, 대장 세션의 switchboard가 장부를 보다가 그 답을 서버로 보낸다. 옛 Orca 질문 패널(v1만 읽음)은 v2 파일을 버려 대장 터미널에 답이 들어가지 않는다.
- 시험: mod 182건(코어 12·껍데기 2 추가), 서버 22건, Orca 70건.

### 2026-11-17 — switchboard 0.10.0: 원격 질문 — 묻는 쪽 (#111)

- 상위 #106: 질문을 Agent Mail 서버 객체로. 이 판은 묻는 쪽만(대장 세션이 서버 질문을 패널에 띄우는 쪽은 #112).
- `ask`: 메일함이 켜져 있으면(`AGENT_MAIL_PROFILE`) `POST /api/questions`로 올린다(문항에서 패널 상태는 빼고, 빈 header는 「질문」). 201이면 결과 글이 「원격 질문 q_… 로 올렸다」이고, 403(`can_ask` 꺼짐)·409(답할 대장 없음)·400·연결 실패면 「원격 질문으로 올리지 못해 로컬 패널에 올렸다(까닭)」 뒤에 평소 로컬 결과가 온다. 모델이 질문을 모르게 되면(서버 오류·훅이 막음) 서버 질문도 거둔다.
- 서버 질문은 묻는 세션의 로컬 패널에 띄우지 않는다: 그 패널(과 Orca 사이드바)에 선택지가 뜨면 묻는 쪽에서 답해 버릴 수 있고, 그 답은 서버로 가지 않아 대장·대시보드의 같은 질문과 갈라진다. 손잡이는 서버 id다. 결과 글에 「질문 묶음 qN」을 쓰지 않아 Orca 카드로도 옮겨지지 않는다.
- 답 메일(`agent-mail/system`, 제목 `[질문 답] <id> …`, `task_id`=id): 이 세션이 올린 id이거나 `GET /api/questions/{id}`의 asker가 같은 base이면 시스템 통지 대신 「[질문 패널 답 <id>] 질문 = 고른 것」 줄과 「(원격 질문 <id>의 답 · 답한 쪽: …)」로 넣고 read 처리한다. 역할 주소 메일이라 compact·재시작 뒤에도 온다(올린 기록이 없으면 서버 보기로 판정). 보기를 못 읽으면 메일 본문 줄에 같은 머리를 단다. 다른 역할 질문의 참조(watcher) 사본은 평소 시스템 통지 그대로.
- `resolve`에 `q_…`를 주면 `POST /api/questions/{id}/withdraw`. 409면 「이미 답이 났거나 거둔 질문」으로 안내한다.
- 서버 클라이언트 `core/remote-questions.ts`(`createQuestionsApi(call)` → ask·get·list·poll·answer·withdraw)는 #112가 그대로 쓴다. 메일함에 시스템 통지 글 바꾸기 `onNotice`를 더했다.
- 시험: mod 168건(코어 10·껍데기 4 추가), 서버 20건.

### 2026-11-17 — switchboard 0.9.0: AskUserQuestion을 질문 패널로 돌리기 (#109)

- 증상: 「질문은 질문 패널로」 규칙이 문서에 있는데도 세션이 `AskUserQuestion`을 써 세션이 블로킹됐다.
- `tool.call` 훅으로 `AskUserQuestion`을 막고, 이유로 「`mcp__plugin_switchboard_qp__ask`로 같은 질문을 올려라(입력 모양이 같다). 급한 확인이면 header를 `급함`으로 시작해 다시 불러라」를 돌려준다.
- 통과: 질문 하나라도 `header`가 `급함`으로 시작할 때, qp 서버가 붙지 않은 세션(`$.mcp.connect('qp')`가 연결 아님), `SWITCHBOARD_ALLOW_ASK_USER_QUESTION=1`.
- 시험: mod 154건(가드 시험 4건 추가).

### 2026-11-18 — issue-track 0.8.2: SWITCHBOARD_* 새 이름 우선 (#132)

- 문서의 명령 예시를 `SWITCHBOARD_PROFILE=<프로필> agent-mail …`로 바꿨다(옛 `AGENT_MAIL_PROFILE`도 받는다, 같은 CLI가 `switchboard`로도 깔린다). `update-plugins.py`는 `SWITCHBOARD_PROFILE`(옛 CLI용으로 `AGENT_MAIL_PROFILE`도 같은 값)로 부르고 환경에서 `SWITCHBOARD_ROLE`·`AGENT_MAIL_ROLE`을 뺀다.

### 2026-11-17 — issue-track 0.8.1: update-plugins Windows 로캘·원격 PATH (#115)

- `update-plugins.py`가 Windows 한국어 로캘(cp949)에서 출력 읽기 예외·한국어 깨짐을 냈다 → subprocess를 `encoding="utf-8", errors="replace"`로, stdout·stderr도 utf-8로 reconfigure.
- ssh 비대화형 셸 PATH에 `~/.local/bin`이 없어 `claude: command not found` → 원격 명령 앞에 `PATH="$HOME/.local/bin:$PATH"`를 붙이고, 설정 `update.remote_claude`로 원격 claude 경로를 바꿀 수 있다. Windows는 `py <스킬 폴더>/scripts/update-plugins.py`.
- 시험: 새 4건, 스크립트 시험 전체 59건.

### 2026-11-17 — issue-track 0.8.0: 원격 세션에 일 맡기기·플러그인 갱신 스크립트 (#110)

- 조율 세션이 손으로 되풀이하던 두 절차를 담았다: 한 건을 원격 기계 작업자 세션에 맡기기(19건), 플러그인 새 판을 기계마다 깔기(약 13회).
- 새 스킬을 만들지 않고 `issue-track`을 넓혔다. 둘 다 「이슈를 작업자에게 맡기고 보고를 받아 확인한다」는 같은 조율자 일이고, 지시서 틀·모델 고르기·Agent Mail 보고 길(`reference/agent-mail.md`)을 그대로 쓴다. SKILL.md에 「6. 원격 세션에 한 건 맡기기」 절(짧게), 절차는 `reference/remote-session.md`, description에 「이 저장소에 이것 고쳐 줘」「원격 기계에 맡겨」「플러그인 갱신」 갈래.
- `scripts/update-plugins.py`(표준 라이브러리만): 로컬과 `ssh <별칭>`에서 `claude plugin marketplace update` → `claude plugin list --json`의 그 마켓 플러그인을 `claude plugin update <id> --scope <scope>`(local·project는 그 폴더에서) → 기계×플러그인 표(`옛→새`, 실패 칸). 한 기계가 실패해도 계속하고 종료 코드 1. 그다음 `agent-mail status --json`에서 online이고 그 기계 switchboard의 lastUpdated보다 먼저 등록한 세션을 「옛 판」으로 찍는다(로컬 scope 설치는 그 폴더 세션에). reload·재시작은 하지 않는다.
- 설정은 저장소 밖 `~/.config/dev-kit/issue-track.json`(`DEV_KIT_CONFIG`)의 `delegate`·`update` 절, 저장소에는 가짜 값의 `issue-track.example.json`만.
- 시험: 새 8건(`tests/test_update_plugins.py`, 명령 실행 함수를 가짜로 주입), 스크립트 시험 전체 55건.

### 2026-11-17 — switchboard 0.8.5: 쉬는 세션을 막힘으로 보지 않기 (#107)

- 증상: 일을 마치고 쉬는 상주 세션이 `blocked:idle_prompt`(대시보드 「막힘」)로 보이고 부모에게 「기다림」 메일이 갔다. Claude Code는 사람이 친 턴(예: /compact) 뒤 60초에 `idle_prompt` 알림을 낸다.
- `idle_prompt`는 조용한 알림으로 둔다: status는 idle, 부모 알림 없음. blocked는 `permission_prompt`·`elicitation_dialog` 등 실제 사람을 기다리는 알림만. 오류(`error:*`) 동작은 그대로.
- 안 한 것: 턴 안에서 열린 로컬 질문(AskUserQuestion)을 blocked로 보는 일(훅 이벤트가 없어 따로 이슈감).
- 시험: mod 150건(`core/stall.test.ts` 기대 변경 + 쉬는 세션 idle 시험 1건 추가).

### 2026-11-17 — switchboard 0.8.4: resume 직후 compact에 갇히지 않기 (#104)

- 증상: `claude --resume`으로 이어 띄운 세션(시작 때 243.5k)이 서버에 `compacting 0.0k`로 머물고, 일반 메일이 메일 전 compact 관문에 막혀 pending으로 남았다. 손으로 `/compact`를 넣어야 풀렸다.
- 원인(work에서 재현): 메일 전 compact가 부른 `$.session.compact`는 요약을 돌려주며 정상으로 풀렸지만, 코어가 완료로 기다리던 `session.compact` 훅이 오지 않았다(resume 직후 첫 턴 전). 코어는 완료 이벤트로만 `compacting`을 풀어서 영영 갇혔다. 컨텍스트 토큰 수를 모를 때 0으로 보고해 `0.0k`로 보였다.
- Claude 어댑터: 받아들인 compact 호출이 풀렸는데 그 사이 훅이 없었으면 스스로 완료를 알린다. 토큰 수를 모르면 0 대신 실패로 알린다.
- 코어: compact를 건 뒤 5분 안에 완료가 없거나 호출이 풀리지 않으면 `compacting`을 풀고 기다리던 메일을 넣으며 화면에 한 번 알린다(그 메일 턴 전에는 다시 걸지 않는다). 토큰 수를 모르면(0) 기준 판정을 하지 않고 presence에도 싣지 않는다.
- 실제로 켜 봄(work, Haiku, `SWITCHBOARD_COMPACT_TOKENS=5k`로 46k 세션을 resume한 뒤 바로 메일): 0.8.3은 `compacting`에서 2분 반 넘게 메일이 pending이었다. 0.8.4는 10초 안에 한 번 배달·complete. 어댑터 보정을 뺀 사본으로는 약 5분 뒤 알림 한 줄과 함께 한 번 배달됐다.
- 시험: mod 149건(compact 5건 추가: resume 직후 완료 훅 없음·호출 안 풀림·제때 끝남·토큰 모름, 어댑터 완료 알림).

### 2026-11-17 — switchboard 0.8.3·Orca 질문 패널 0.6.0: 터미널 탭 세션의 질문도 Orca 사이드바로 (#102)

- 증상: Orca 터미널 탭으로 뜬 Claude 세션의 질문이 Claude Code 패널에만 쌓이고 Orca 사이드바 질문 패널에 뜨지 않았다(대장 Windows). MCP 서버는 채팅 UI 세션(`ORCA_STRUCTURED_SESSION`·`ORCA_AGENT_SESSION_ID`)일 때만 Orca 질문 폴더에 남겼고, 터미널 세션은 Orca `agent.tool.after` 훅에만 기댔다.
- switchboard: 채팅 세션이 아니고 `ORCA_TERMINAL_HANDLE`(`term_…`)이 있으면 질문을 `~/.question-panel/orca-inbox/<qN>-<handle>.json`에 `session:{terminal}`·`workspaceId`·key 와 남기고, 결과 글 끝에 「답은 이 터미널에 `[질문 패널 답 qN] …` 글로 들어온다」 안내를 붙인다. 대화창에서 닫힌 묶음은 `session:{terminal}` 닫힘 파일로 남긴다. 채팅 세션 길(Run 메일)은 그대로이고, 두 환경 변수가 다 있으면 채팅이 먼저다.
- Orca 질문 패널(`orca-plugins/question-panel`): 그 파일을 터미널 묶음으로 받아 답을 `terminal.sendText`로 그 터미널에 넣는다(훅 길과 같은 길, Agent Mail 역할이 없는 세션에서도 된다). 훅과 파일로 같은 질문이 두 번 와도 카드는 하나다. 닫힘 장부 규칙은 그대로.
- 실제로 켜 봄(work Linux Orca 1.4.254): 새 터미널 탭의 Haiku 세션이 쓴 질문 파일이 위 모양이었고, Orca 플러그인 코드가 그 파일을 터미널 묶음으로 읽어 만든 답 줄을 `orca terminal send`로 넣자 세션이 답으로 받았다. 이 기계 Orca 런타임에는 플러그인 서비스가 없어 사이드바 카드는 Windows에서 확인한다.
- 시험: switchboard MCP 20건(터미널 탭 3건 추가), mod 144건, Orca 플러그인 67건(5건 추가).

### 2026-11-17 — switchboard 0.8.2: 같은 폴더 두 세션의 번호, 입력 중 보류 (#99, #100)

- 번호 역할: 서버는 (base, 기계, 폴더)로 번호를 되찾아 주므로 같은 기계·폴더의 두 번째 세션이 첫 세션의 번호를 가져갔다. 이제 번호를 받기 전에 `GET /api/slots`로 살아 있는 줄을 보고, 같은 기계·폴더를 다른 세션 id가 쥐고 있으면 폴더 뒤에 세션 표지(` #<세션 id 앞 8자>`)를 붙여 등록해 다음 번호를 받는다. 같은 세션(resume)은 같은 표지라 원래 번호를 되찾는다. 서버 계약은 그대로다(서버가 identity에 session_id를 넣어 주면 표지는 필요 없다).
- 입력 중 보류: 이 CLI 판에서 사람이 치는 글자·붙여 넣기는 `prompt.edit`로 오고 `prompt.change`는 기록 불러오기·지우기·채우기에만 온다. 0.5.0부터 `prompt.change`만 들어 입력창에 글이 있어도 일반 메일이 들어갔다. 이제 `prompt.edit`도 듣고, 다시 뜰 때(reload·resume) `$.prompt.read()`로 입력창을 읽어 시작한다. urgent는 그대로 바로 넣는다.
- 실제로 켜 봄(Linux, Haiku): 같은 폴더 두 세션이 -2·-3을 받았고, 강제 종료 뒤 `--resume`한 세션은 원래 번호로 돌아왔다(정상 종료는 번호를 release 하므로 다시 뜨면 그때 비어 있는 번호). 입력창에 글을 둔 채 보낸 메일은 「미룸 — 입력창에 글이 있음」으로 미뤘다가 글을 지우자 들어갔다.
- 시험 메모: work의 `~/.bashrc`에 `alias claude='claude --dangerously-skip-permissions'`가 있어 권한 창 시험은 `command claude`로 띄운다. 플러그인을 local 범위로 켤 때는 `claude plugin install --scope local`을 쓴다.
- 시험: mod 144건(같은 폴더 두 세션·resume 4건 추가).

### 2026-11-17 — switchboard 0.8.1: Windows 프로필 경로와 연결 전 메일 (#97)

- 프로필 위치를 agent-mail CLI와 같은 규칙으로 정한다: `AGENT_MAIL_CONFIG_DIR`이 있으면 그 폴더 바로 아래, 없으면 Go `os.UserConfigDir()`와 같이 Windows `%APPDATA%`(없으면 `<홈>\AppData\Roaming`), macOS `~/Library/Application Support`, 그 밖 `$XDG_CONFIG_HOME`(없으면 `~/.config`) 아래 `agent-mail/<이름>.json`. 이름 `default`는 `config.json`. 홈은 `HOME` → `USERPROFILE`(Windows의 Claude 프로세스에는 `HOME`이 없어 0.8.0까지는 조용히 메일함을 건너뛰었다). CLI 자리에 없으면 옛 자리 `~/.config/agent-mail`도 본다.
- `AGENT_MAIL_PROFILE`이 있는데 프로필을 못 찾거나 못 읽거나 이름이 틀리면 토스트와 기록 줄로 한 번 알린다(전에는 기록 줄만, Windows에서는 그마저 없었다).
- 연결 전 pending 메일: 처음 잇거나 다시 이을 때 밀려 있던 일반 메일을 「밀려 있던 일반 메일 N통(#…)을 넣는다」로 남기고 넣는다(전과 같은 미룸·compact 관문). 입력 중·사람 입력 뒤 보류로 미루면 「일반 메일 N통(#…) 미룸 — <까닭>」을 까닭이 바뀔 때 한 번 남긴다. 서버는 커서 없는 긴 대기에 그 역할의 pending 전부를 주므로 서버 변경은 없다.
- 시험: mod 140건(경로 규칙 14·후보·알림 5·연결 전 배달 5 추가).

### 2026-11-17 — leak-guard 0.2.0: 나가는 내용만 검사 (#94)

- 0.1.0은 `git commit`·`gh pr create/edit` 명령 글 **전체**를 금지어로 봐서 `cd <홈 경로>/… && git commit -m '…'`처럼 나가지 않는 cd 경로·환경변수·다른 명령에 걸려 막았다. 이제 명령 글을 셸 문법대로 나눠 그 git·gh 명령의 인자(메시지·제목·본문)와 `-F`·`--body-file` 파일 내용, `-F -`의 heredoc만 본다. 스테이지된 diff·push 검사, 공개 저장소에서만, `leak-guard:allow` 계약은 그대로다.
- 읽지 못하거나 설명이 안 되는 트리거는 전처럼 명령 글 전체를 본다. `bash -c`·`eval`·`bash <<EOF`는 안을 다시 나눈다.
- 막을 때 위치 이름이 `명령:N`에서 `커밋 메시지:N`·`PR 제목·본문:N`으로 바뀌었다(전체를 볼 때만 `명령:N`).
- 시험: 24건(오탐 재현·인용 방식별 메시지·`-F` 파일·diff·PR 본문·fail-closed 6건 추가).

### 2026-11-17 — switchboard 0.8.0: 멈춤 감지와 원격 권한 답 (#81)

- spec #73의 D8. 서버 계약 6(#24)을 따른다. heartbeat가 끊긴 세션(offline)과 연결되지 않은 라벨은 서버가 알리고, mod는 그 시스템 메일(`agent-mail/system`)을 0.7.0의 시스템 통지 길로 본문 그대로 넣는다.
- 멈춤: `StopFailure`가 `rate_limit`·`overloaded`·`server_error`면 30초부터 두 배씩(10분 상한) 기다려 「이어서 하라」 턴을 넣는다. 8번을 넘기거나 다른 종류(`billing_error` 등)면 재시도 없이 presence 상태를 `error:<종류>`로 두고 부모와 대장(`SWITCHBOARD_BOSS_ROLES`)에게 한 번 알린다(오류 본문은 싣지 않는다). 사람이 그새 턴을 넣으면 재시도는 거둔다. 권한 창·입력 대기 알림(`Notification`)은 `blocked:<종류>`로 두고 부모에게 한 번 알린다.
- presence 상태: 지금 서버는 `idle`·`busy`·`compacting`만 받는다(그 밖은 400). 400이면 그 세션은 자세한 상태 없이 셋만 보고한다. 서버가 `error:`·`blocked:`를 받게 되면 고칠 것 없이 보인다.
- 원격 권한 답: `PermissionRequest` 훅이 요청(도구·짧은 요약)을 `/api/permissions`에 올리고 `SWITCHBOARD_PERMISSION_WAIT_SECONDS`초 기다린다. 답은 요청 때 정해진 부모 base나 대장만 유효하다(서버가 정하고, mod도 요청자 base·남의 답은 버린다). 시간 안에 답이 없거나, 만료됐거나, 답할 쪽이 없으면(409: 부모가 없거나 같은 base이고 서버 `AGENT_MAIL_BOSS_ROLES`도 없음) 평소 화면 창으로 넘어간다. 답은 한 번만 쓰고 「항상 허용」 규칙은 만들지 않는다. 답 알림(urgent, task_id = 요청 id)은 세션에 넣지 않는다.
- 훅 예산: 모드 훅은 10초 예산이 있고, 예산은 `$` 응답을 기다리는 동안만 멈춘다. 처음에는 시계 타이머로 기다렸더니 10초 뒤 화면 창이 뜨고 늦게 온 허락은 버려졌다(실제로 켜 봄). 그래서 기다림을 그 훅의 `$.http`로 거는 서버 긴 대기로 바꿨다.
- 번호 역할: 연결해 번호를 받으면 `AGENT_MAIL_ROLE=<번호 역할>`을 Bash 자식에 넘긴다. 세션 안의 `agent-mail read/complete`가 번호 주소로 돌아 D7의 「번호 역할 메일이 pending으로 남음」이 닫힌다. 정상 종료(`session.end`)에는 번호를 release 해 offline 통지가 나지 않게 한다.
- 실제로 켜 봄(Haiku 두 세션, 같은 base의 부모·자식, 운영 서버): 자식 셸의 `AGENT_MAIL_ROLE`이 번호 역할이었고, 번호 주소로 온 메일을 자식이 read·complete 하자 complete가 됐다. 연결·권한 창 기다림·offline 통지가 부모 세션에 본문 그대로 들어갔다. 같은 base 부모라 권한 요청은 409로 바로 화면 창으로 넘어갔다.
- 시험: mod 116건(멈춤 5건, 권한·메일 11건, 요약 1건 추가).

### 2026-11-17 — switchboard 0.7.0: 연결 통지와 라벨 메일 (#80)

- spec #73의 D7. `SWITCHBOARD_PARENT`가 있으면 메일함이 처음 이어졌을 때 부모 주소로 「연결됨」 메일(제목 `[switchboard] 연결됨 <주소> (라벨 <라벨>)`, 본문에 주소·라벨·기계·폴더·세션 id)을 보낸다. 같은 연결에서는 한 번만(`Idempotency-Key`), 서버 오류면 5초 간격으로 3번까지, 4xx(없는 부모 등)는 기록만 한다.
- 받는 쪽: 제목이 `[switchboard] `로 시작하는 일반 메일은 시스템 통지다. 「#N 을 읽고 처리하라」 대신 출처 줄과 본문(2000자 상한)을 일반 메일과 같은 시점·보류·compact 관문으로, 일반 메일 뒤에 넣고 read로 표시한다.
- 라벨 메일: 주소 꼴은 spec의 `label:<라벨>`이 아니라 **`label:<기반 역할>/<라벨>`**이다(서버 계약 5, 대표 결정). base 없는 `label:<x>`는 400, 남의 base는 403. 세션 쪽은 `SWITCHBOARD_LABEL=<라벨>` 그대로다. 그 라벨의 세션이 없으면 서버가 보관했다가 register 때 번호 주소로 옮긴다(새 ID, 옛 ID는 `held_id`). 메일함은 번호를 받은 뒤 커서 없이 구독을 시작하므로 연결 직후 알림으로 들어간다. 옮긴 건수(`held_delivered`)는 기록에 남긴다.
- 실제로 켜 봄(Haiku 두 세션, 운영 서버): 라벨 메일을 먼저 보내 보관(held)시키고 라벨로 세션을 띄우자 새 ID로 옮겨져 첫 턴에 들어갔고, 부모로 지정한 다른 세션에 연결 통지가 본문 그대로 들어갔다. 부모 세션이 통지의 주소를 자기 주소로 읽어 첫 줄에 「이 세션을 부모로 띄운 다른 세션」을 밝혔다.
- 시험: mod 99건(연결 통지·라벨 메일 4건 추가).

### 2026-11-17 — switchboard 0.6.0: 번호 역할·presence·중복 경고·takeover (#79)

- spec #73의 D6. 메일함을 켤 때 프로필 역할(기반)과 기계·폴더로 `POST /api/slots/register`를 불러 `<역할>-N` 번호를 받고, 그 번호 주소로 구독한다. 그래서 같은 프로필 세션이 둘이면 `-1`·`-2`로 나뉘고, 번호 없이 보낸 메일은 `-1`만 받는다. 같은 기계·폴더로 다시 뜨면 서버가 원래 번호를 돌려준다. 기계 이름은 `SWITCHBOARD_MACHINE` → `HOSTNAME` → `/etc/hostname` 순으로 읽는다. 같은 폴더에서 세션을 둘 띄우면 같은 세션으로 보인다.
- presence: 상태가 바뀔 때(유휴·바쁨·compact 중)와 60초마다 `heartbeat`에 상태·컨텍스트 토큰·마지막 턴 시각·세션 id·`SWITCHBOARD_LABEL`·`SWITCHBOARD_PARENT`를 싣는다. 토큰(비밀)은 요청 머리에만 있다. heartbeat가 404(만료 뒤 남이 가져감)면 번호를 다시 받는다. 응답의 역할이 바뀌었으면(남의 takeover로 밀림) 새 주소로 다시 구독한다. 세션이 죽으면 lease(3분) 뒤 offline이다.
- 기반 역할 이름(전체 또는 마지막 `/` 뒤)이 `SWITCHBOARD_SINGLE_ROLES`(쉼표 목록, 기본 `boss,coordinator`, `off`면 끔)에 있는데 `-2` 이상을 받으면 토스트로 한 번 경고한다. `/switchboard-takeover`는 이 세션이 `-1`을 가져오고, 이전 `-1`은 다른 번호로 밀린다.
- slot API가 없는 옛 서버면 프로필 역할 그대로 구독하고, 60초마다 다시 번호를 받아 본다.
- 시험: mod 95건(번호·presence 7건 추가).

### 2026-11-17 — leak-guard 0.1.0: 공개 저장소 유출 막는 훅 (#86)

- 새 플러그인. Bash의 `git commit`·`git push`·`gh pr create`/`edit` 직전에 나갈 추가분만 내장 비밀 패턴과 저장소 밖 사용자 금지어 파일로 검사해 걸리면 막는다. 공개 저장소에서만 검사하고 판별이 안 되면 검사한다. 아래 「leak-guard 쓰는 법」.
- 시험 18건(걸림·안 걸림·비공개·캐시·gh 실패·금지어 파일 없음·정규식 오류·예외 표시·업스트림 있음/없음·원격 없음·PR 본문·body-file).

### 2026-11-17 — switchboard 0.5.0: 사람 입력 중·답한 직후 메일 보류 (#78)

- spec #73의 D5. 입력창에 글이 있는 동안은 일반 메일 턴을 미루고, 글을 지우면 곧 넣는다. 사람이 보낸 짧은 턴(`SWITCHBOARD_HOLD_SHORT_TURN_MINUTES`분 미만, 기본 2)이 끝나면 그때부터 `SWITCHBOARD_HOLD_MINUTES`분(기본 3, `0`이면 끔) 동안도 미룬다(답을 읽는 동안). 긴 턴 뒤에는 미루지 않는다(0.11.3). 보류가 풀리면 쌓인 메일을 한 줄로 넣는다. 긴급 메일은 보류를 따르지 않는다.
- 포트 이벤트 `input.submit`에 `origin`(user·plugin·other)을 실었다. Claude 어댑터에서는 모드 `prompt.submit`의 `origin.kind`가 `composer`·`bridge`일 때만 사람이다. 메일 알림 턴(origin plugin)은 사람 입력으로 치지 않는다.
- 질문 패널에서 답하거나 「보내기」로 넣은 턴은 플러그인 origin이지만 사람이 한 일이다. 그래서 패널 포트의 `submitTurn`이 `noteUserInput()`을 불러 사람 입력으로 친다. 패널 답 턴과 메일 턴이 같은 입력 줄에서 겹치지 않는다.
- 시험: mod 88건(보류 8건, 어댑터 1건 추가).

### 2026-11-17 — harden 0.1.0: 재발 방지 사다리 스킬 (#85)

- 새 플러그인. 같은 실수가 반복되면 규칙 문서에 한 줄 더하기 전에 구조·정적 검사·시험·훅·스크립트·산문 여섯 칸을 위에서부터 따져 되는 첫 칸의 장치로 막는다.
- 막는 장치의 실패 메시지는 원인과 고칠 법을 말하고, 산문 줄은 무엇·왜(출처)·지울 조건을 담으며, 장치가 생기면 그 산문을 같은 작업에서 지운다. 공개 저장소의 장치에는 일반 패턴만 두고 구체 금지어는 저장소 밖에 둔다.
- 보고에 「재발 방지: <칸> — …」 한 줄.

### 2026-11-17 — switchboard 0.4.0: 긴급 메일 끼워 넣기 (#77)

- spec #73의 D4. `priority=urgent` 메일은 본문을 넣는다. 세션이 바쁘면 실행 중인 턴의 다음 도구 호출 결과 뒤(PostToolUse 자리)에, 유휴면 새 턴으로, compact 중이면 끝난 뒤에 넣는다. 넣는 즉시 `POST /api/messages/{id}/read`로 읽음 처리한다. 긴급은 일반 메일보다 먼저 들어간다.
- 본문은 2000자에서 자르고 「전문은 agent-mail read <ID>」를 붙인다. 이벤트에 본문이 없으면 `GET /api/messages/{id}`로 그 메일만 받아 온다.
- AgentHost 포트 `injectMidTurn`은 이제 붙었으면 `true`를 돌려준다. 턴이 도구 호출 없이 끝나면 남은 글을 버리고 `false`로 풀린다. 그러면 코어가 같은 글을 새 턴으로 넣는다. 그래서 다음 턴의 엉뚱한 도구 결과에 붙지도, 두 번 들어가지도 않는다. 끼워 넣기 기능이 없는 어댑터는 새 턴으로 넣는다(바쁘면 그 턴 뒤 맨 앞).
- 실제로 켜 봄: 바쁜 세션(Haiku)에 긴급 메일을 보내자 다음 도구 호출 뒤에 본문이 붙고 곧바로 read가 됐다. 처음 글(「지금 하던 일보다 먼저 따르라」)은 도구 결과에 섞인 주입으로 의심받아 무시됐다. 그래서 출처(switchboard가 이 역할 앞 urgent 메일을 전함)와 확인 길(`agent-mail read <ID>`)을 밝히는 글로 바꿨고, 그 뒤로는 세션이 따랐다.
- 시험: mod 79건(긴급 8건, 어댑터 1건 추가).

### 2026-11-17 — switchboard 0.3.0: 일반 메일 전에 compact (#76)

- spec #73의 D3. 일반 메일 턴을 넣기 직전에 세션이 유휴이고 컨텍스트가 기준 이상이면 compact부터 하고, compact 완료 이벤트가 온 뒤에 메일 턴을 넣는다(시간 sleep 없음). 바쁜 동안에는 하지 않고, 턴이 끝나 유휴가 되면 한다.
- 기준은 `SWITCHBOARD_COMPACT_TOKENS`(기본 `200k`, `150k`·`120000`처럼 쓰고 `0`·`off`면 끔), 요약 지시문은 `SWITCHBOARD_COMPACT_INSTRUCTIONS`(없으면 에이전트 기본 요약)다. 세션마다 환경변수로 주므로 역할별로 달리 둘 수 있다.
- 줄인 뒤에도 기준 위면 같은 메일 앞에서 되풀이하지 않고 넣는다(새 턴이 돈 뒤 다음 메일 앞에서 다시 본다). 어댑터에 compact 기능이 없거나 compact가 거절되면 건너뛰고 바로 넣는다.
- 시험: mod 70건(메일 전 compact 8건 추가). 가짜 Agent Mail 서버는 `core/mailtest.ts`로 옮겨 다음 티켓도 쓴다.

### 2026-11-17 — switchboard 0.2.0: Agent Mail 일반 메일로 세션 깨우기 (#75)

- spec #73의 D2. `AGENT_MAIL_PROFILE`이 있는 본 세션은 Agent Mail을 구독하고, 새 pending 메일 ID를 턴이 끝난 뒤 새 턴(「Agent Mail #12, #13 을 읽고 처리하라(agent-mail read <ID>).」)으로 넣는다. 바쁜 동안 온 메일은 한 줄로 묶고, 알릴 때 이미 읽힌 메일은 뺀다. 메일 상태는 바꾸지 않는다.
- 구독은 SSE가 아니라 긴 대기(`GET /api/events/poll?after=<커서>&timeout=25`)다: 모드 `$.http.fetch`가 본문을 다 받아서만 주기 때문이다. 이벤트·커서 규칙은 SSE와 같아 커서로 다시 이으면 놓치는 메일이 없고, 같은 ID는 두 번 알리지 않는다. 세션이 막 뜨면 쌓여 있던 pending을 한 번 알린다.
- 서버가 죽거나 응답이 멈추면(40초 감시) 1초에서 60초까지 간격을 늘려 다시 잇는다. 세션은 그대로 돈다. 끊김·이어짐은 대화창에 흐린 한 줄(`$.ui.log`, 모델에는 안 감)로만 남긴다.
- 토큰은 프로필에서 읽어 요청 머리에만 싣는다(URL·알림 글·기록에 안 나옴, 시험으로 못 박음). 프로필 이름에 경로 글자가 있으면 받지 않는다. 긴급(priority=urgent)은 아직 일반과 같다(D4).
- 시험: mod 62건(메일함 13건 추가). 실제로 프로필 worker-1 세션을 `--plugin-dir`로 띄워 메일 한 통으로 깨어나 읽고 complete하는 것, 바쁜 동안 보낸 두 통이 「#178, #179」 한 줄로 묶이는 것을 확인했다.

### 2026-11-17 — switchboard 0.1.0: question-panel을 옮기고 코어·AgentHost 포트를 나눔 (#74)

- spec #73의 첫 티켓(D1). 동작은 바꾸지 않는 프리팩터다. 새 플러그인 `plugins/switchboard`가 question-panel 0.9.0을 대체한다(옛 플러그인은 아직 남긴다, 위 「이전」).
- 코어(`core/`)는 Claude 모드 API를 모른다. 세션 상태 추적(`switchboard.ts`)과 질문 패널 상태(`questions.ts`)가 AgentHost 포트(`host.ts`)·Store·LedgerLink만 본다. Claude 어댑터(`adapters/claude.ts`)가 포트를 모드 API에 잇는다. 모드 로더 제약 때문에 `$`를 받는 어댑터 함수는 함수 선언(`function f($)`)으로 두고 `$.env.get`에는 글자 그대로의 이름을 쓴다.
- Orca 사이드바 연동은 선택 어댑터다: 장부(`adapters/ledger.ts`)는 MCP 서버가 닿을 때만 쓰고, Orca 전용 동작(Orca 질문 폴더·run-current)은 서버가 `ORCA_*` 환경변수를 볼 때만 한다. Orca 질문 패널 0.5.2는 switchboard 도구 이름도 알아본다.
- 모드 http는 본문을 다 받아서만 주므로 Claude 어댑터에는 SSE(`services.http.sse`)가 없다. D2가 길을 정한다.
- 시험: mod 49건(`claude plugin test plugins/switchboard` — 옮긴 question-panel 시험 30, 코어 15, Claude 어댑터 4), 서버 17건(`node --test plugins/switchboard/mcp`).

### 2026-11-13 — Orca 질문 패널 0.5.1: 「기타」 글 상자의 한글 겹침 (#66)

- 증상: 「기타」 상자에 한글을 치면 마지막 음절이 한 번 더 들어갔다(오늘→오느늘, 안녕→안녀녕).
- 원인(추정, 실기 확인 못 함): 상자를 제어(`value={text}`)로 그려, 조합 중 입력마다 `onChange`→상태→호스트가 값을 되돌려 쓰며 조합 중인 글자를 덮었다. 패널에는 조합 이벤트·폴링으로 상자를 갈아 끼우는 코드가 없고 Enter 보내기도 없다(`onSubmit` 안 씀).
- 고침: 비제어(`defaultValue`)로 바꿨다. 값은 `onChange`로 상태에 모으기만 하고 상자에 다시 쓰지 않는다. 시험 61건(+1: `value` 없음·다시 그려도 값 한 번). 조합 이벤트 자체는 시험 도구가 못 흉내 낸다.
- Claude Code 패널(`plugins/question-panel`)의 `Input`도 제어(`value`)지만 호스트가 그리는 컴포넌트라 비제어 속성이 있는지 알 수 없어 건드리지 않았다.

### 2026-11-13 — question-panel 0.9.0·Orca 질문 패널 0.5.0: 질문 상태의 정본을 하나로 (#64)

- 증상: 같은 질문이 Claude Code 패널과 Orca 사이드바 패널에 같이 뜨는데, Claude Code 패널에서 답해도 Orca 카드가 닫히지 않아 또 답할 수 있었다. 원인: 상태가 두 벌(mod 저장 값, Orca 워커 storage)이고 Claude Code → Orca 길이 없었다. mod 「완료」는 묶음 ID 없는 `[질문 패널 답] 질문 = 답` 줄만 세션에 보내고(도구 호출이 아니라 Orca 훅도, MCP 서버도 거치지 않음), 0.6.3의 `panel_closed`는 `via`가 있는 묶음(대화창 답·답 없이 닫음)만 다음 도구 호출 때 실어서 패널에서 보낸 묶음은 영영 안 실렸다. 반대로 Orca 카드 「지우기」는 Orca 안에서만 지워 Claude Code 패널이 대기로 남았다.
- 고침: 질문 묶음 상태의 정본을 집 폴더의 **닫힘 장부** `~/.question-panel/ledger/<key>.json`으로 모았다. 닫힌 묶음마다 파일 하나를 배타 생성(`O_EXCL`)으로 만들고, 두 패널 모두 세션에 보내기 **전에** 먼저 만들어 이긴 쪽만 보낸다(세션에는 한 번만 간다). key는 `<Claude 세션 ID>~q<N>~<만든 시각>`이라 여러 세션이 동시에 물어도 섞이지 않는다. mod가 질문 입력에 `panel_key`로 붙이고, Orca는 훅 입력(터미널 세션)·질문 파일의 `key`(채팅 세션)로 받는다.
  - Claude Code 쪽: mod는 파일을 직접 못 다뤄 MCP 서버 `qp`의 내부 도구 `sync`를 `$.mcp.call`로 부른다(모델이 부르면 mod가 막는다). 대기 묶음이 있을 때만 2초마다 장부를 읽어 「Orca에서 답함」·「Orca에서 답 없이 닫음」으로 닫는다. Orca에서 답 없이 닫았으면 세션에 `[질문 패널 답] qN 답 없이 닫음(Orca)` 한 줄을 보낸다. 대화창 글(`q4 1-2`)·`resolve`·「답 없이 닫기」도 장부에 남긴다.
  - Orca 쪽: 1.5초마다 도는 폴더 읽기에 장부 읽기를 더해 「Claude Code 패널에서 답함」 등으로 카드를 닫는다. 「답 보내기」는 장부를 먼저 차지하고, 졌으면 보내지 않는다. 터미널·메일함으로 못 보냈으면(갔을 수 있는 경우 빼고) 차지를 거둔다. 대기 카드 「지우기」는 장부에 「답 없이 닫음」을 남긴다.
  - 혼자일 때: Orca가 없으면 장부를 아무도 안 읽을 뿐이다. MCP 서버가 안 닿으면 mod는 예전처럼 바로 보낸다. key 없는 묶음(옛 mod)은 Orca가 예전처럼 다룬다. 옛 길(`panel_closed`, 닫힘 파일)도 버전이 섞인 기계를 위해 남겼다. 도구 이름·답 꼴은 그대로.
- 시험: mod 30건(`claude plugin test plugins/question-panel`), 서버 17건(`node --test plugins/question-panel/mcp`), Orca 60건(`orca-plugins/question-panel/README.md` 「시험」).

### 2026-11-17 — issue-track 0.7.0: wait-deploy가 병합과 배포 사이의 release workflow를 본다

- 배포 흐름이 바뀌었다: PR → Actions PR 검사 → 병합 → Actions release workflow(검사·이미지 빌드, 끝에 배포용 브랜치를 fast-forward) → 배포 잡이 그 커밋에 커밋 상태를 단다. 옛 wait-deploy는 병합 뒤 10분 안에 배포 상태가 없으면 NO_BUILD로 끝나, release가 오래 걸리면(실행기 대기 10~40분) 거짓 NO_BUILD, release가 실패하면 원인을 가린 채 「웹훅 누락일 수 있다」로 끝났다.
- `wait-deploy.py` GitHub 길: 배포 상태가 없을 때 병합 커밋(과 뒤 커밋)에 걸린 workflow 실행을 전부 본다(`--workflow 이름`으로 좁힘). 대기·진행 중이면 `--start-timeout` 시계를 세지 않고 끝난 뒤부터 센다. 전체 상한 `--max-wait`(기본 90분)은 TIMEOUT(3). 실행이 모두 끝났고 실패가 있는데 배포 상태가 없으면 **`FAILURE_PRE_DEPLOY`**(종료 1) — 실패 workflow·잡 이름·URL과 `--log-failed` 끝 30줄. 실행이 0개면(Actions 없음) 옛 동작 그대로. Jenkins 길은 바꾸지 않았다.
- `actions_excerpt`를 `ci_common.py`로 옮겨 두 스크립트가 같이 쓴다(`commit_runs`·`failed_job_names` 추가). 두 스크립트 docstring, `issue-worker`·`issue-track` 스킬 문서는 Actions를 기본으로, Jenkins를 「그런 CI를 쓰는 저장소용」으로 다시 썼다.
- 시험: 스크립트 단위 시험 47건(새 분기 7건: 진행 중 시계 멈춤, 끝난 뒤 NO_BUILD, 상한 TIMEOUT, FAILURE_PRE_DEPLOY, 뒤 커밋·`--workflow`, 배포 상태 우선, 실행 0개).

### 2026-11-13 — issue-track 0.6.0·context-cap 0.2.2: Agent Mail로 보고

- 회사 세션 메일함이 Orca orchestration 메일함(`orca orchestration send`, `run:<run_id>` 주소)에서 Agent Mail(역할 주소, CLI `agent-mail`)로 바뀌었다. `issue-worker`·`issue-track` 스킬이 새 길을 가르친다: 프로필은 `AGENT_MAIL_PROFILE=<프로필>` 환경변수로(v0.2.1은 명령 앞 `--profile`을 무시한다), 보고는 `send --to <받는 역할> --task … --subject … --body …`, 답은 `reply <ID>`, 끝나면 `complete <ID>`. 메일은 세션을 깨우지 않아 받는 쪽이 대기 스크립트로 기다린다. `reference/orca-mailbox.md`는 `reference/agent-mail.md`로 바꿔 다시 썼고 참조를 고쳤다.
- context-cap의 HARD 허용 Bash에 `agent-mail send|reply|complete|ack`을 더했다(작업자가 한도 넘은 뒤에도 보고·넘김 메일은 보낼 수 있게). `orca orchestration send|reply`도 옛 세션용으로 그대로 둔다.
- 질문 패널 코드(`orca-plugins/question-panel`, `mcp/ask.mjs`)는 Orca 기능 자체라 그대로 둔다. 이 저장소에 실제 서버 주소·Run id·토큰은 없었다(문서는 예시 꼴 역할 이름만 쓴다).
- 지금 `~/.claude`의 issue-track 스킬·에이전트 판과 diff 하니 dev-kit과 같았다(작업 기계의 해당 파일은 아직 Agent Mail 이전 판).

### 2026-11-13 — question-panel 0.8.0: 패널 닫기, 답 없이 닫기

- 패널을 닫는 길이 없었다. 패널 맨 위에 「패널 닫기」(`role="dismiss"`), `/questions`는 열려 있으면 닫는 토글, `/questions close`(`닫기`)는 늘 닫는다. 닫아도 질문·답 상태는 그대로이고 새 질문이 오면 다시 열린다.
- 대기 중 묶음의 「삭제」는 모델에 아무 말도 하지 않고 묶음을 지워 모델이 답을 기다렸고 Orca 카드는 남았다. 이제 「답 없이 닫기」(확인을 거침)가 묶음을 「답 없이 닫음」 기록(`via: 'dismissed'`)으로 남기고 세션에 `[질문 패널 답] qN 답 없이 닫음` 한 줄을 보낸다. 기록은 다음 질문·`resolve` 호출의 `panel_closed`에 실려 Orca 카드도 닫힌다(기존 길). Orca 질문 패널은 이미 카드 ×(지우기)가 있어 바꾸지 않았다.
- 시험: mod 24건(`claude plugin test plugins/question-panel`).

### 2026-11-09 — question-panel 0.7.0: 질문을 대화창에 다시 옮겨 적지 않기

- Claude Code 데스크톱 앱·CLI·Orca(터미널 탭·채팅 UI) 모두 질문 패널을 그리게 되어, `ask` 결과의 「아래 블록을 답변 글에 그대로 옮겨 적고 턴을 마쳐라」와 질문 블록이 중복이 되었다. 이제 결과는 짧다: 「질문 묶음 qN을 패널에 올렸다. 질문을 대화창에 다시 쓰지 말고 「질문 패널에 올렸습니다(qN)」 정도로 짧게 말하고 턴을 마쳐라」와 답이 오는 길(「[질문 패널 답] …」 메시지·메일, 「qN 1-2」 글, ID 없는 글이면 `resolve`). 도구 설명도 같이 고쳤다.
- 패널이 정말 안 보이는 화면(Remote Control·폰)용으로 옛 동작을 남겼다: Claude Code를 띄우는 환경에 `QUESTION_PANEL_ECHO=1`(`true`·`on`·`yes`도 됨, `settings.json`의 `env`도 됨)이면 예전처럼 블록을 옮겨 적게 하는 결과를 돌려준다. mod 훅 환경에는 `process`가 없어 mod는 두 글(`panel_result`·`panel_echo`)을 모두 MCP 서버에 넘기고, 환경변수는 서버가 읽어 고른다. mod가 없는 세션은 패널이 없으니 지금처럼 블록을 돌려준다.
- 시험: mod 23건(`claude plugin test plugins/question-panel`), 서버 13건(`node --test plugins/question-panel/mcp`).

### 2026-11-09 — Orca 질문 패널 0.4.4·question-panel 0.6.3: 「기타(직접 입력)」 답, 닫힌 묶음에 또 답이 가던 것

- Orca 질문 카드에 질문마다 「기타 — 직접 입력」이 생겼다. 고르면 여러 줄 글 상자가 열리고(2000자까지), 하나만 선택이면 다른 선택지와 배타, 여러 개 선택이면 함께 고른다. 글이 비면 보내지 않는다. 답 꼴은 번호 자리에 「기타」: 메일 본문 `q4 기타 / [질문 패널 답] 질문 = 기타: 글`, 터미널 줄 `[질문 패널 답 q4] 1) 질문 = 기타: 글 [기타]`.
- `resolve`(대화창에서 답함)로 닫은 묶음이 Orca 카드에는 열린 채 남아 또 답이 갔다. resolve가 mod 도구라 Claude Code가 훅을 돌리지 않았고(Orca 터미널 세션의 `agent.tool.after`가 못 봄), 채팅 세션은 질문 폴더에 닫힘을 남기는 길이 없었다. resolve를 MCP 서버 도구(`mcp__plugin_question-panel_qp__resolve`)로 옮겨 터미널 세션은 훅으로, 채팅 세션은 서버가 남기는 닫힘 파일로 Orca 카드를 「대화창에서 답함」으로 닫는다. 대화창 글(`q4 1-2`)로 닫힌 묶음은 다음 질문·resolve 호출에 실려 간다. 근거는 `orca-plugins/question-panel/README.md` 「0.4.4」.

### 2026-11-08 — Orca 질문 패널 0.4.3: 「응답하지 않습니다」 조사, 지운 기록 줄이기

- 패널 무응답은 Orca 렌더러 watchdog이 판정한다. 패널 코드가 도는 숨은 게스트가 ping에 5초 안에 답하지 않으면 멈추고, 자동 복구는 없다(탭을 오가야 다시 뜬다). 플러그인 코드(워커·패널)에서는 막는 곳을 찾지 못해 Orca 쪽 몫으로 남겼다. 지운 기록(`dismissed`)은 묶음 전체 대신 키만 남겨 저장소가 커지지 않게 했고, 패널 문서가 다시 뜰 때마다 로그를 남겨 멈춤 빈도를 셀 수 있게 했다. 근거와 확인 방법은 `orca-plugins/question-panel/README.md` 「0.4.3」.

### 2026-11-08 — Orca 질문 패널 0.4.2: 처음부터 선택돼 보이는 선택지로 바로 보내기

- 하나만 선택 질문은 라디오가 첫 항목 체크 모양인데 답 저장소는 비어 있어 「답 보내기」가 꺼져 있었다. 이제 안 눌러도 첫 선택지가 답으로 잡힌다(여러 개 선택은 기본 없음). 근거는 `orca-plugins/question-panel/README.md` 「0.4.2」.

### 2026-11-08 — Orca 질문 패널 0.4.1·question-panel 0.6.2: 보낸 메일을 실패로 띄우던 것, 정리 기능

- 채팅 세션 답 메일이 실제로 갔는데 카드가 「보내지 못함 — orca 종료 코드 0 — {"ok":true,"result":{"messageId":…}}」로 떴고, 다시 누르면 같은 메일이 또 갔다. Orca 1.4.25x의 `orchestration send`·`run-current`가 `--full` 없이는 짧은 JSON(`result.messageId`, `result.runId`)을 찍는데 긴 모양만 읽었기 때문이다. `run-current`도 못 읽어 Run에 묶인 세션인데 `orca_session_id:`로 보냈다. 이제 실패는 종료 코드≠0·`ok:false`일 때만이고 두 모양을 다 읽는다(MCP 서버도).
- 중복 막기: 보내는 중 두 번째 누름은 거절, 실제로 갔을 수 있는 실패는 카드에 「이미 보냈을 수 있음」.
- 정리: 카드마다 ×(되돌리기), 위쪽 「답한 것·보낸 것 모두 지우기」·「닫힌 세션 질문 지우기」(터미널 닫힘·채팅 세션 없음 = `session_caller_unknown`). 지운 묶음은 질문 폴더에 파일이 남아도 다시 뜨지 않는다. 근거는 `orca-plugins/question-panel/README.md` 「0.4.1」.

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
- 사용자 글(대화창, 패널 「보내기」)에 대기 중인 묶음 ID가 있으면 그 묶음을 「대화창에서 답함」으로 닫아 패널에서 또 답하지 못하게 한다. ID 없이 글로 답하면 모델이 새 도구 `mcp__question-panel__resolve`로 닫는다(0.6.3부터 MCP 서버 도구 `mcp__plugin_question-panel_qp__resolve`).

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
