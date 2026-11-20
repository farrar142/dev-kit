# dev-kit

Claude Code 플러그인 마켓플레이스. 이슈 처리 조율, 시험 속도, 토큰 절약, 공개 저장소 유출 방지, 세션 교환대 같은 작업 흐름을 플러그인으로 묶었다. 정의는 `.claude-plugin/marketplace.json`.

## 설치와 갱신

```
/plugin marketplace add farrar142/dev-kit
/plugin install <플러그인>@dev-kit
```

| 할 일 | 명령 |
|---|---|
| 새 판 받기 | `/plugin marketplace update dev-kit` 뒤 `claude plugin update <플러그인>@dev-kit` |
| 끄기 | `/plugin disable <플러그인>@dev-kit` |
| 여러 기계·모든 범위(user·project·local) 일괄 갱신 | `issue-track` 스킬의 `scripts/update-plugins.py` |

`update-plugins.py`는 기계(ssh 별칭, posix·PowerShell)마다 마켓과 플러그인을 갱신하고 범위별 판 표를 찍는다. 옛 판이 남으면 종료 코드 1. 설정은 `~/.config/dev-kit/issue-track.json`(`DEV_KIT_CONFIG`로 바꿈), 예시는 `plugins/issue-track/skills/issue-track/issue-track.example.json`.

## 플러그인

| 플러그인 | 판 | 종류 | 하는 일 |
|---|---|---|---|
| [issue-track](#issue-track) | 0.11.0 | 스킬·에이전트·스크립트·훅 | GitHub 이슈를 작업자에게 맡기는 조율자 |
| [switchboard](#switchboard) | 0.14.0 | mod·MCP | 세션 교환대: 질문 패널, 메일함 구독, 대장 질문, 백그라운드 작업 넘기기 |
| [question-panel](#question-panel) | 0.9.0 | mod·MCP | switchboard 이전의 질문 패널 |
| [test-speed](#test-speed) | 0.3.0 | 스킬 3 | 시험 시간 한도, 빠르고 안 흔들리는 E2E, 목 스택 화면 확인 |
| [token-diet](#token-diet) | 0.1.0 | 훅 2·스킬 | 큰 파일 읽기·큰 heredoc 막기, 작업자 토큰 규율 |
| [context-cap](#context-cap) | 0.2.3 | 훅 | 세션 컨텍스트 상한 |
| [idle-compact](#idle-compact) | 0.1.0 | mod | 입력 없이 30분이면 자동 compact |
| [leak-guard](#leak-guard) | 0.2.0 | 훅 | 공개 저장소로 나가는 비밀·금지어 차단 |
| [root-cause](#root-cause) | 0.1.1 | 훅 | 근본 원인 줄 없는 수정·장애 보고 차단 |
| [harden](#harden) | 0.1.0 | 스킬 | 재발 방지 장치 고르기 |
| [django-asgi](#django-asgi) | 0.1.1 | 스킬 | Django ASGI 성능·정합성 |
| [security-recon](#security-recon) | 0.1.0 | 스킬 | 인가 받은 서버의 외부 보안 점검 |

Orca 플러그인 [`orca-plugins/question-panel`](orca-plugins/question-panel/README.md)은 마켓플레이스 밖이다.

### issue-track

- 스킬 `issue-track`: 열린 이슈를 한 트랙으로 `issue-worker`에게 차례로 맡기거나, 한 건을 원격 기계의 작업자 세션에 Orca·메일로 맡긴다. 결과 확인, 작업자 내리기, 토큰 측정, 지시서 개선까지.
- 에이전트 `issue-track:issue-worker`(sonnet, 이슈 하나를 워크트리 → 시험 → PR → 병합 → 정리), `issue-track:errand`(haiku, 읽기 전용 찾기 심부름꾼).
- 스크립트(`skills/issue-track/scripts/`):

| 스크립트 | 쓰임 |
|---|---|
| `wait-ci.py <PR> [--repo] [--timeout] [--interval] [--no-checks-wait]` | PR head 커밋의 check-runs·commit status를 기다렸다 한 번 알림. 종료 코드 0 성공 · 1 실패 · 2 병합/닫힘 · 3 시간 초과 · 4 없음 · 5 검사 없음 · 6 병합 대기열 이탈(DEQUEUED) |
| `wait-deploy.py --job <이름> (--pr <번호> \| --since <시각>)` | 병합 뒤 배포(GitHub 커밋 상태 또는 Jenkins 빌드)를 기다렸다 한 번 알림 |
| `update-plugins.py` | 위 「설치와 갱신」 |
| `worker-stats.py [agentId…]` | 작업자·심부름꾼의 턴·입력 토큰·최대 컨텍스트 |

- 참고(`reference/`): `parallel-runs.md`(체인 병렬 함정), `remote-session.md`(원격 세션에 맡기기), `switchboard.md`(작업자 보고 경로).
- `wait-ci.py`(0.11.0): 병합 대기열에 있는 PR은 검사가 초록이어도 병합될 때까지 기다리고, 병합 없이 대기열에서 빠져 OPEN으로 남으면 `DEQUEUED`(종료 코드 6)로 끝내 대기열 실행(`merge_group`)의 실패 줄을 덧붙인다. 대기열이 없는 저장소는 그대로.
- 훅 `detach-guard`(PreToolUse·Bash, 0.10.0): 셸 `&`로 떼어 띄운 명령은 끝나도 세션에 알림이 오지 않아 작업자가 멈춘다. 이를 거절하고 「`&` 없이 `run_in_background: true`로 띄워라」고 안내한다.
  - 거절: 같은 명령 안에서 `wait`로 거두지 않은 `&`(`( … ) & sleep 1`). `wait-ci.py`·`wait-deploy.py`를 `&`·`nohup`·`setsid`·`disown`으로 띄우는 꼴은 `run_in_background: true` 호출 안에서도 거절.
  - 통과: `&&`, `2>&1`·`>&2`·`&>`·`|&`, 따옴표·주석·heredoc 안의 `&`, `… & … ; wait`, `run_in_background: true` 호출 안의 그 밖의 `&`.
  - 빠져나갈 길: 명령 앞에 `ISSUE_TRACK_ALLOW_DETACH=1`(또는 훅 프로세스 환경변수). 훅이 오류로 죽으면 통과.
- 시험: `python3 -m unittest discover -s plugins/issue-track/skills/issue-track/tests`, `node --test plugins/issue-track/tests`

### switchboard

question-panel을 대체하는 세션 교환대. 에이전트를 모르는 코어(`core/`)와 `AgentHost` 포트, Claude 어댑터(`adapters/`)로 나뉜다.

- 질문 도구(MCP 서버 `qp`, node 필요): `mcp__plugin_switchboard_qp__ask`·`…__resolve`. 오른쪽 「질문」 패널에 쌓고 사용자가 원할 때 답한다. 답은 「[질문 패널 답] 질문 = 답」으로 돌아온다.
- 명령: `/questions`(패널 토글, `/questions close`), `/questions-clear`(답한 기록 지우기), `/switchboard-takeover`(번호 역할 -1 가져오기).
- 메일함: `SWITCHBOARD_PROFILE`이 있는 세션이 메일함을 긴 대기로 구독해, 일반 메일은 턴이 끝난 뒤 「메일 #N 을 읽고 처리하라」 새 턴으로, 긴급(`priority=urgent`) 메일은 실행 중인 턴에 끼워 넣는다. 사람이 입력 중이면 보류한다. 유휴이고 컨텍스트가 기준 이상이면 메일 전에 compact.
- 번호 역할(`<역할>-N`)·presence 보고, 멈춤 감지, 원격 권한 답, 원격 질문(서버 질문으로 올리고, 대장 세션은 패널에서 받아 답).
- 넘기기(기본 꺼짐, `SWITCHBOARD_HANDOFF=1`로 켠다. 리눅스, CLI v0.30.0 이상, 프로필 있는 본 세션): 세션이 다시 떠도 남게 switchboard 장부로 넘긴다. 넘기기 전에 `SWITCHBOARD_CLI`로 고른 CLI의 `switchboard job ping`을 부르고 종료 코드 0일 때만 넘긴다(성공은 30초 기억, 실패는 기억하지 않는다). 0이 아니면(10 config·11 data·12 server·13 token·14 runner, 시간 초과·실행 실패 포함) 원래 호출 그대로 돌고 결과에 종료 코드 이름을 단 「넘기지 못했다」 한 줄이 붙는다. 넘긴 명령이 exit 125(실행기가 못 뜸)로 끝나면 아무것도 넘기지 않고 돌지도 않은 것이라 stderr 줄대로 명령을 직접 돌린다.

| 도구 | 넘긴 꼴 |
|---|---|
| Bash `run_in_background` | `switchboard job run --wait --label <앞 60자> -- <셸> -c <원래 명령>`(첫 줄 `switchboard job <id>`, 다시 뜬 세션은 `job wait <id>`) |
| Monitor(명령) | `switchboard watch start --attach --expires <timeout_ms> --label <설명> -- <셸> -c <원래 명령>` |
| CronCreate | `schedule add --cron`(한 번짜리는 분·시·일·월이 박힌 꼴만 `--at`), 호출은 거절하고 까닭에 `sb-<id>`. 울림은 메일로 온다 |
| CronDelete·CronList | `sb-<id>`는 `schedule rm`, 목록 뒤에 `schedule list` |
| ScheduleWakeup | `schedule add --in <분>`, 거절. `stop`은 이 세션이 만든 것을 거둔다 |
- 환경변수:

| 이름 | 뜻 |
|---|---|
| `SWITCHBOARD_PROFILE` | 프로필 이름. 없으면 메일함을 켜지 않는다 |
| `SWITCHBOARD_CONFIG_DIR` | 설정 폴더(기본은 OS별 설정 폴더 아래 `switchboard/`) |
| `SWITCHBOARD_ENDPOINT`·`SWITCHBOARD_TOKEN` | 서버 주소·토큰(프로필 파일 대신) |
| `SWITCHBOARD_BOSS_ROLES` | 서버가 대장 판정을 못 줄 때 쓰는 대장 역할 목록 |
| `SWITCHBOARD_TYPING_MINUTES` | 입력 중 메일 보류 상한(분) |
| `SWITCHBOARD_COMPACT_TOKENS`·`SWITCHBOARD_COMPACT_INSTRUCTIONS` | 메일 전 compact 기준·지시 |
| `SWITCHBOARD_ALLOW_ASK_USER_QUESTION=1` | qp가 붙은 세션에서도 `AskUserQuestion` 허용 |
| `SWITCHBOARD_HANDOFF=1` | 넘기기 켜기(`on`·`true`·`yes`도 같다). 기본은 꺼짐 |
| `SWITCHBOARD_CLI` | 넘기기가 부르는 CLI(기본 PATH의 `switchboard`) |

- 프로필 파일은 `<설정 폴더>/switchboard/<이름>.json`(서버 주소·역할·토큰). 세션 env 예(`~/.claude/settings.json`):

```json
{ "env": { "SWITCHBOARD_PROFILE": "example" } }
```

- 옛 `AGENT_MAIL_*` 환경변수와 `agent-mail/` 설정 폴더는 대체값으로 읽는다.
- question-panel과 함께 켜지 않는다(질문 도구가 둘이 된다).
- 시험(`plugins/switchboard/e2e/`):

| 명령 | 돌리는 것 |
|---|---|
| `bash plugins/switchboard/e2e/suite.sh mod` | `claude plugin test`: 코어·어댑터·`hooks/*.test.tsx`. 좁은 터미널(#136) 시험이 돌았는지도 센다 |
| `bash plugins/switchboard/e2e/suite.sh mcp` | `node --test plugins/switchboard/mcp/*.test.mjs` |
| `bash plugins/switchboard/e2e/run.sh` | 질문 경로 e2e: 고정 판 switchboard 서버 릴리스(linux_amd64, 체크섬 확인)를 받아 플러그인 코어를 붙이고, 답이 묻는 세션에 정확히 몇 번 들어오는지 센다(대장 패널·대시보드 답, 먼저 온 답 우선, 거두기, 세션 재시작·다른 번호·같은 폴더 두 세션, 라벨이 다른 세션, 대장 세션의 질문 참조 메일). `SWITCHBOARD_E2E_BIN`으로 받은 바이너리를 줄 수 있다 |

시험이 0개 돌거나 e2e가 16개보다 적게 통과하면 실패다.

### question-panel

switchboard의 질문 패널 부분만 있던 앞 판. 도구 이름은 `mcp__plugin_question-panel_qp__*`. switchboard로 옮기는 순서:

1. `/plugin install switchboard@dev-kit`
2. `/plugin disable question-panel@dev-kit`, 세션 다시 띄우기
3. 지침·스킬에 적힌 도구 이름을 `mcp__plugin_switchboard_qp__ask`·`…__resolve`로 바꾸기
4. Orca를 쓰면 Orca 질문 패널을 갱신(두 이름을 다 알아본다)

패널에 쌓인 질문은 옮겨지지 않는다(저장 키가 플러그인 이름을 따른다). 닫힘 장부와 Orca 질문 폴더(`~/.question-panel/`)는 둘이 같이 쓴다. 시험: `node --test plugins/question-panel/mcp`.

### test-speed

| 스킬 | 다루는 것 |
|---|---|
| `test-budgets` | 시험 하나 한도(로직 0.5초·백엔드 1초·E2E 3초, 백엔드는 CPU 초)와 러너에서 강제, 느린 시험 원인 고치기, 고정 대기를 사건 기다리기로, 처음 켜는 순서. `examples/`에 conftest·junit 분석·Playwright 설정 |
| `fast-stable-e2e` | Playwright E2E를 DOM·스트림 리스너로만 기다려 흔들림 없이, 공용 도우미·eslint 규칙, 시간 쥐기 |
| `mock-stack-shots` | 실제 직렬화에서 뽑은 목 시나리오, 목 서버 + 개발 서버 + Playwright를 세우고 내리는 `startStack`, 데스크톱·모바일 스크린샷 |

### token-diet

- 훅 `read-guard`(PreToolUse·Read): 1,000줄·80KB를 넘는 파일을 `limit` 없이 읽으면 막는다. `READ_GUARD_MAX_LINES`·`READ_GUARD_MAX_BYTES`로 바꾼다.
- 훅 `block-heredoc`(PreToolUse·Bash): 6,000자를 넘는 명령을 스크립트 파일로 옮겨 `source`로 실행한다.
- 스킬 `token-diet`: 부분 읽기, 출력 끝만 보기, 심부름꾼, 모델 고르기, 컨텍스트가 커지면 넘기기, 배경 대기.

### context-cap

PreToolUse·PostToolUse·UserPromptSubmit 훅. transcript의 마지막 본 세션 응답 usage로 컨텍스트를 재서 SOFT를 넘으면 새 지시를 거절하고, HARD를 넘으면 넘김 문서 쓰기와 보고 말고는 도구를 막는다.

- `claude --agent issue-worker` 본 세션은 SOFT 250000·HARD 300000으로 기본 켜진다. 대상 에이전트는 `CONTEXT_CAP_AGENTS`(쉼표 구분, 기본 `issue-worker`).
- 그 밖의 세션은 `CONTEXT_CAP_SOFT`·`CONTEXT_CAP_HARD`를 주면 켜진다. `CONTEXT_CAP_SOFT=0`이면 끈다.
- 보안 경계가 아니라 작업자를 멈추는 가드레일이다.
- 시험: `node --test plugins/context-cap/tests`

### idle-compact

작업(턴)이 끝난 뒤 30분 동안 입력이 없으면 대화를 compact 한다. 입력창에 쓰거나 새 턴이 시작되면 타이머를 취소하고, 컨텍스트가 15% 미만이면 건너뛴다. 도구·명령 없음.

### leak-guard

PreToolUse(Bash) 훅. 공개 저장소에서 `git commit`·`git push`·`gh pr create`/`edit` 직전에 나갈 추가분(diff의 `+` 줄, 커밋 메시지, PR 제목·본문)만 검사해 걸리면 `파일:줄 — 패턴 이름`만 알리고 막는다(exit 2).

- 저장소 공개 여부는 `gh repo view --json visibility`로 판별해 하루 캐시(`LEAK_GUARD_TTL` 초). 판별이 안 되면 검사한다.
- 패턴: 내장 일반 패턴(CGNAT 대역(100.64.0.0/10) IP, 개인 키 머리말, 주요 서비스 토큰 꼴)과 저장소 밖 금지어 파일 `LEAK_GUARD_PATTERNS`(없으면 `~/.config/leak-guard/patterns.txt`). 한 줄에 정규식 하나(JavaScript, 대소문자 무시), `#` 주석. <!-- leak-guard:allow -->
- 예외는 줄의 `leak-guard:allow` 표시. 그 줄은 그대로 공개된다.
- 시험: `node --test plugins/leak-guard/tests`(가짜 `gh`가 셸 스크립트라 리눅스·macOS)

### root-cause

| 훅 | 하는 일 |
|---|---|
| UserPromptSubmit `prompt.js` | 문제 신고 입력(오류·장애·실패·4xx/5xx·Traceback 등)에 「증상 → 직접 원인 → 근본 원인을 증거로, 답에 `근본 원인:` 줄」 문맥을 넣는다. 막지 않는다 |
| PreToolUse(Bash) `gate.js` | `gh pr create`·`gh issue create`·`switchboard send`·`switchboard reply`가 수정·장애 보고로 보이는데 `근본 원인:` 줄이 없으면 막는다. 수정이 아니면 `근본 원인: 해당 없음 — <까닭>` |

사용자 신호 목록은 `ROOT_CAUSE_SIGNALS`(없으면 `~/.config/root-cause/signals.txt`), 끄기는 `ROOT_CAUSE_OFF=1`. 시험: `node --test plugins/root-cause/tests`

### harden

스킬 `harden`. 같은 실수가 두 번째로 나오면 규칙 문서에 한 줄 더하기 전에 구조 → 정적 검사 → 시험 → 훅 → 스크립트 순으로 막을 장치를 고르고, 산문은 무엇·왜·지울 조건 한 줄로 쓴다.

### django-asgi

스킬 `django-asgi-perf`. 연결 풀, 오래 열린 요청(SSE·롱폴링)의 연결 돌려주기, async 미들웨어, SSE 스냅샷·스트림 순번 거르기. `reference/`와 `examples/`.

### security-recon

스킬 `security-recon`. 서면 인가를 받은 서버·인스턴스를 바깥에서 점검한다: 인가·범위 확인, 두 지점 블랙박스 점검(포트·TLS·헤더·인증 강제·IDOR·CORS·운영 API 문서), 이중 차단과 외부 재검증, 방화벽 레퍼런스(`reference/clouds.md`). 인가 없는 대상에는 쓰지 않는다.

## 저장소 구조

```
.claude-plugin/marketplace.json   마켓플레이스 정의
.github/workflows/switchboard.yml switchboard 검사(아래)
plugins/<이름>/                   플러그인(.claude-plugin/plugin.json, skills·agents·hooks·mcp)
orca-plugins/question-panel/      Orca 플러그인(마켓플레이스 밖)
```

## 검사

`.github/workflows/switchboard.yml`(워크플로 이름 `switchboard`, ubuntu-24.04): `mod`·`mcp`·`run.sh`를 차례로 돌린다. `plugins/switchboard/**`나 워크플로 파일이 바뀐 PR과 main push에서만 뜬다. 그 밖의 경로(README 등)만 바꾼 PR에는 검사가 없다. 다른 플러그인의 시험은 위 플러그인 절의 명령으로 로컬에서 돈다.
