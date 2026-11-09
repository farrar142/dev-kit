# 질문 패널 (Orca 플러그인, 시제품 0.4.4 — Claude Code question-panel 0.6.3 이상과 함께)

> **풀림(question-panel 0.6.0, 2026-11-08).** 0.2.0까지는 질문이 워커에 닿지 않았다. Claude Code는 mod 도구(옛 `mcp__question-panel__ask`) 호출에 `PreToolUse`·`PostToolUse` 설정 훅을 돌리지 않고, Orca의 `agent.tool.after`는 그 훅(`orca-agent-hook`)을 타고 오기 때문이다. Claude Code question-panel 0.6.0이 질문 도구를 진짜 stdio MCP 서버(`qp`)로 옮겨, 도구 이름이 `mcp__plugin_question-panel_qp__ask`가 되었고 훅을 탄다(Claude Code 2.1.319, `matcher: "*"` 기록 훅으로 Pre·Post 둘 다, `tool_response`에 「질문 묶음 qN」 확인). 이 플러그인 0.3.0은 그 이름을 본다. 다른 이름의 질문 도구가 오면 로그에 `질문 도구 이름이 아니라 무시`를 남긴다.

Claude Code의 `question-panel` 플러그인(`plugins/question-panel/`)이 올린 객관식 질문을 **Orca 오른쪽 사이드바 「질문」 패널**에 카드로 띄우고, 사용자가 고른 답을 **질문한 Claude의 터미널에 한 줄로 넣고 Enter**를 누른다. Claude는 질문을 올린 뒤 턴을 끝내고 기다리지 않는다(비블로킹).

**0.4.0부터 Orca 채팅 UI 세션도 된다.** 채팅 세션의 질문은 Claude Code question-panel MCP 서버(0.6.1+)가 집 폴더 `~/.question-panel/orca-inbox`에 남기고, 이 플러그인이 읽어 카드로 띄운다. 답은 그 세션의 **오케스트레이션 메일함**으로 보낸다(Run에 묶였으면 `run:<run_id>`, 아니면 `orca_session_id:<세션 ID>`). 카드에 전달 경로(「터미널」·「메일함 run:run_xxxx」)가 보인다. 아래 「채팅 세션(0.4.0)」.

Claude Code 마켓플레이스 플러그인이 아니다. Orca 플러그인(`orca-plugin.json`)이라 이 폴더는 `.claude-plugin/marketplace.json`에 올리지 않는다.

## 흐름

```
Claude(Orca 터미널) ── mcp__plugin_question-panel_qp__ask ──▶ Claude Code question-panel: 질문 묶음 q3 를 쌓고 블록을 돌려줌
        │                                              (Claude는 턴을 끝낸다)
        └─ Orca agent.tool.after 훅 ──▶ 워커: 입력(질문)·결과(q3)·terminalId 를 storage("batches")에 저장
                                              │
                    패널(components) ◀────────┘ persist:'storage' atom 으로 곧바로 다시 그림
                         │ 사용자가 고르고 「답 보내기」
                         ▼
                    워커 qp.answer ── terminal.sendText(terminalId, "[질문 패널 답 q3] 1) … = … [2]", enter) ──▶ Claude
```

- 답 줄에 `q3`이 들어 있어 Claude Code 쪽 question-panel의 `prompt.submit` 훅이 같은 묶음을 「대화창에서 답함」으로 닫는다.
- 줄바꿈은 터미널에서 먼저 제출될 수 있어 한 줄(` / `로 질문 구분)로 보낸다.
- 터미널이 답을 받지 않으면(닫힘) 묶음을 대기로 남기고 패널에 경고를 띄운다.

## 되는 곳·안 되는 곳

| 세션 | 질문 카드 | 답 넣기 | 근거 |
| --- | --- | --- | --- |
| Orca 터미널에서 도는 Claude Code(question-panel 0.6.0+) | 됨(MCP 도구라 훅을 탐) | 경로는 있음(`terminal.sendText`) | 위 「풀림」 |
| Orca 채팅 UI(stream-json, `ORCA_STRUCTURED_SESSION=1`, question-panel 0.6.1+) | 됨(MCP 서버가 폴더에 남김) | 됨(오케스트레이션 메일함, `orca` CLI) | 아래 「채팅 세션(0.4.0)」 |
| SSH·WSL 호스트의 에이전트 | 안 됨 | — | Orca 문서: 도구 훅은 SSH·WSL에 아직 없다 |

### 채팅 세션(0.4.0) — 왜 이렇게 했나 (Orca 소스·1.4.237 실측)

```
Claude(Orca 채팅, stream-json) ── qp ask ──▶ question-panel mod: 묶음 q3 + 대화창 블록
        │                                        MCP 서버(0.6.1): 채팅 세션이면
        │                                          ① orca orchestration run-current --json  (그 세션 신원으로)
        │                                          ② ~/.question-panel/orca-inbox/q3-<세션>.json 에 질문·세션 ID·Run·CLI 경로
        │                                          ③ 블록 끝에 「Orca 사이드바 「질문」 패널로도 답할 수 있습니다…」
        └─ (턴을 끝냄)
워커: 1.5초마다(그리고 패널을 열 때) 폴더를 읽어 묶음으로 저장하고 파일을 지운다 → 카드 「메일함 run:run_xxxx」
      「답 보내기」 → orca orchestration run-current(다시 확인) → orca orchestration send
          --to run:<run_id> | orca_session_id:<세션 ID>
          --subject '[질문 패널 답] q3'
          --body 'q3 1-2, 2-1 / [질문 패널 답] 질문 = 고른 것 / …'
      (CLI 환경: ORCA_AGENT_SESSION_ID=<세션 ID>, ORCA_STRUCTURED_SESSION=1, ORCA_USER_DATA_PATH)
Orca: 그 세션의 메일함에 넣고 세션을 깨운다 → Claude가 메일(제목·본문)을 읽고 이어 간다
```

- **질문이 플러그인에 닿는 길.** 채팅 세션에는 `agent.tool.after` 훅이 오지 않는다. Orca가 채팅 자식 환경에서 훅 변수(`AGENT_HOOK_RUNTIME_ENV_KEYS`)와 pane 신원을 지운다(`structured-session-child-env.ts`: "hooks and mobile status assume a live PTY leaf"). 대신 Claude Code가 띄우는 stdio MCP 서버는 그 세션의 환경(`ORCA_AGENT_SESSION_ID`·`ORCA_STRUCTURED_SESSION`·`ORCA_CLI_COMMAND`·`ORCA_USER_DATA_PATH`)을 그대로 받는다. mod 훅 환경에는 `process`가 없어 못 읽는다. 그래서 MCP 서버가 공유 폴더에 남긴다. 플러그인 쪽에서 남이 부를 수 있는 입구(`plugins.invokeCommand` RPC)는 `host-admin` 권한이고 CLI 명령이 없다.
- **답이 세션에 닿는 길.** 플러그인 host API에는 오케스트레이션·채팅 입력 메서드가 없다(워커 메서드는 `terminal.*`·`workspace.*`·`agent.launch` 등, capability에도 없음). `trusted-worker`는 보통 Node 프로세스라(문서: full-access plugin, 설치 때 승인) 워커가 `orca` CLI를 띄운다. 쓰는 실행 파일은 그 세션의 `ORCA_CLI_COMMAND`(이 앱의 런처 절대 경로)이고, 없으면 PATH의 `orca`. Windows의 런처는 `.cmd`라 `cmd.exe /d /s /c "…"`로 감싼다(인자 안 `"`는 `'`, `%`는 `％`, 줄바꿈은 띄어쓰기).
- **보낸이 신원.** 신원 없는 프로세스(워커 환경에는 `ORCA_*`가 없다)의 `orchestration send`는 `no_active_sender_terminal`로 거부된다(1.4.237 실측). 그래서 CLI에 그 세션의 `ORCA_AGENT_SESSION_ID`를 넣어 **질문한 세션 자신이 자기 메일함에 보내게** 한다. CLI는 주입된 세션 ID를 호출자로 쓴다(`readInjectedAgentSessionId`; 가짜 ID는 `session_caller_unknown`으로 거부됨을 실측). 자기 Run 메일함에 자기가 보낸 메일도 그 메일함에 들어간다(1.4.237, 임시 Run으로 실측: `send --to run:<자기 Run>` 뒤 `check --peek`에 보임).
- **받는 곳.** Run에 묶인 채팅 세션은 `run:<run_id>`(감시하는 `check --peek --wait`가 깬다). 묶이지 않았으면 `orca_session_id:<세션 ID>` — Orca가 모든 에이전트에게 알려 주는 공개 주소이고, 그 주소로 온 메일은 쉬는 채팅도 다시 깨워 전한다(`structured-session-mail-address.ts`). Run을 새로 만들어 묶는(`run-create`) 우회는 하지 않는다. 보내기 직전에 `run-current`를 다시 본다(질문 뒤 Run에 묶였을 수 있다). 못 읽으면 질문 때 값.
- **받는 Claude가 알아보는 모양.** Orca는 채팅 세션에 메일을 제목·본문째 사용자 메시지로 넣는다(`structured-mail-source.ts`). 본문 앞 `q3 1-2, 2-1`은 대화창 글 답과 같은 모양이라 question-panel mod의 `prompt.submit`이 그 묶음을 닫고, 뒤 `[질문 패널 답] 질문 = 고른 것`은 패널 완료 메시지와 같다. 질문 도구 설명에도 이 메일 모양을 적었다.
- **폴더 계약.** 파일 하나가 묶음 하나: `{ v: 1, id: "q3", createdAt, questions, session: { id, runId }, orcaCli, userData, cwd }`. MCP 서버는 `.이름.tmp`로 쓴 뒤 이름을 바꾸고, 워커는 `*.json`만 읽고 읽은 파일(모양이 틀린 것도)을 지운다. 묶음 ID는 `q숫자`, 세션 ID·Run ID는 글자 모양을 검사한다.
- **같은 호스트만.** MCP 서버와 Orca가 같은 집 폴더를 봐야 한다. SSH·WSL의 채팅 세션은 안 된다(세션 신원 주장도 Orca가 SSH·WSL에서 거부한다).

## 설치 (Orca 1.4.248 이상, 데스크톱)

플러그인은 코드를 돌리므로 Orca가 승인을 묻는다(`terminal:send`·`storage:own`·`notifications:show`·`workspace:read`·`workspace:write`, 훅 `agent.tool.after`). `workspace:*`는 0.2.0에서 더했다: 포커스 확인과, 질문한 터미널의 workspace로 옮겨 다시 보내기. `terminal:read`는 0.3.2에서 더했다: 질문한 터미널이 닫혔는지 확인(내용은 읽지 않고 1줄 읽기의 성공·실패만 본다).

```sh
# 이 저장소를 받은 뒤, Orca 호스트의 절대 경로로
orca plugin validate <dev-kit>/orca-plugins/question-panel --json
orca plugin install  <dev-kit>/orca-plugins/question-panel --json           # 종료 3 + 승인 지문을 낸다
orca plugin install  <dev-kit>/orca-plugins/question-panel --approve <지문> --json
orca plugin open local.question-panel --panel questions --json
```

개발 중에는 `orca plugin dev load <절대 경로>`(파일이 바뀌면 다시 읽는다)나 `orca plugin dev watch <절대 경로> --check --json`.

확인: Orca 터미널에서 Claude Code(question-panel 0.6.1+ 설치)를 띄우고 질문 도구를 부르게 한다 → 「질문」 패널에 카드 → 고르고 「답 보내기」 → 그 터미널에 `[질문 패널 답 q1] …` 줄이 들어가 Claude가 이어서 답한다.

확인(채팅 세션, 0.4.0): Claude Code question-panel을 0.6.1로 올린 뒤(`/plugin` 업데이트) Orca 채팅 UI에서 Claude에게 질문 도구를 부르게 한다 → 답변 블록 끝에 「Orca 사이드바 「질문」 패널로도 답할 수 있습니다…」 → 「질문」 패널에 `채팅 · <폴더> · 세션 …` 카드와 배지 「메일함 run:run_xxxx」(Run이 없으면 「메일함 orca_session_id:…」) → 고르고 「답 보내기」 → 패널에 「qN 답을 보냈습니다 — 메일함 …」 → 채팅에 제목 `[질문 패널 답] qN` 메일이 들어가 Claude가 이어서 답한다. 안 되면 `orca plugin logs local.question-panel --json`에서 `inbox:`·`run-current`·`orchestration send`·`메일 보내기 실패` 줄을 본다.

## 0.4.4 — 「기타(직접 입력)」 답, 대화창에서 닫힌 묶음

- **기타.** 질문마다 선택지 아래 「기타 — 직접 입력」. 하나만 선택이면 라디오의 한 항목이라 다른 선택지와 배타, 여러 개 선택이면 체크박스라 함께 고른다. 고르면 여러 줄 글 상자(`Textarea`, 3줄)가 열리고 글자 수(`N/2000자`)가 보인다. 글이 비었거나 2000자를 넘으면 그 질문은 답하지 않은 것으로 보고 「답 보내기」를 끈다(워커도 같은 `complete`로 다시 막는다). 0.4.2의 기본 선택 규칙(하나만 선택의 빈 선택 = 첫 항목)은 그대로이고, 기타를 고른 질문은 `[OTHER]`라 기본값이 덮지 않는다.
- **답 꼴.** `picks` 안에서 기타는 `-1`(`OTHER`), 글은 `qp.answer`의 `texts`(질문마다 한 칸, 기타를 고른 질문이 있을 때만 싣는다). 번호 자리에 「기타」, 값은 `기타: <글>`(Claude Code 패널의 기타 꼴과 같다), 기타는 선택지 뒤에 온다.
  - 메일 본문(채팅 세션): `q4 기타 / [질문 패널 답] 어느 DB? = 기타: 둘 다 섞어 쓰기`, 여러 질문이면 `q4 1-기타, 2-2, 2-기타 / …`.
  - 터미널 줄: `[질문 패널 답 q4] 1) 어느 DB? = 기타: 둘 다 섞어 쓰기 [기타]`.
  - 글의 줄바꿈은 ` ↵ `로 바꿔 한 줄로 보낸다(터미널은 줄바꿈에서 먼저 제출하고, Windows `.cmd`는 줄바꿈 인자를 못 넘긴다). 글은 `spawn` 인자 배열의 한 칸으로 가서 셸이 해석하지 않는다. Windows는 `.cmd` 런처라 `cmd.exe /c` 한 줄을 거치는데, 그때만 `"`가 `'`로, `%`가 `％`로 바뀐다(0.4.0 `windowsCmdLine`).
- **닫힌 묶음에 또 답이 가던 것(2026-11-09).** 원인: `resolve`가 Claude Code **mod 도구**(`mcp__question-panel__resolve`)였다. Claude Code는 mod 도구에 `PreToolUse`·`PostToolUse` 훅을 돌리지 않으므로(위 「풀림」과 같은 이유) Orca 터미널 세션의 `agent.tool.after`가 resolve를 못 봤고, 채팅 세션은 MCP 서버가 질문 때만 폴더에 쓰고 닫힘은 남기지 않았다. 그래서 mod 패널에서는 닫힌 q3이 Orca 카드에는 대기로 남아 답 메일이 갔다.
- **고침.** question-panel 0.6.3이 resolve를 MCP 서버 도구 `mcp__plugin_question-panel_qp__resolve`로 옮겼다(mod는 `tool.call`로 감싸 자기 패널 묶음을 닫고 서버로 넘긴다).
  - 터미널 세션: 워커가 그 도구의 `agent.tool.after`를 받아 같은 터미널의 묶음을 닫는다.
  - 채팅 세션: 서버가 질문 폴더에 닫힘 파일 `closed-<세션>-<시각>-<ID들>.json`(`{v:1, kind:'closed', ids, session:{id}, at}`)을 남기고, 워커가 읽어 닫는다.
  - 대화창 글(`q4 1-2`)로 닫힌 묶음: mod의 `prompt.submit` 훅에는 바깥으로 알릴 길이 없어, 다음 질문·resolve 호출의 `panel_closed`에 실려 같은 길로 간다.
  - 닫힌 카드는 「대화창에서 답함」으로 보낸 기록에 들어가고, 패널에서 다시 보내면 워커가 「대화창에서 이미 답해 닫혔습니다」로 막는다. 닫힘 시각보다 뒤에 같은 q 번호로 다시 물은 묶음은 닫지 않는다.
- 로그: `resolve: <터미널> 의 q3 → q3 「대화창에서 답함」으로 닫음`, `inbox closed-….json: orca_session_id:… 의 q3 → …`, `hook panel_closed: …`.

## 0.4.3 — 「응답하지 않습니다」(패널 무응답) 조사와 정리

증상: 사이드바 「질문」 패널이 질문이 없을 때도 가끔 「This plugin panel stopped responding and was suspended」로 바뀌고, 다른 사이드바 패널로 갔다 와야 다시 뜬다.

**Orca가 판정하는 방식**(stablyai/orca main, 1.4.253 무렵 소스):
- `ui: "components"` 패널은 Orca가 화면에 그리고, 플러그인의 `src/panel.tsx`는 숨겨진 0크기 `<webview>` 게스트에서 돈다(`PluginDeclarativePanel.tsx`, `plugin-frame-element.tsx` — 이 게스트는 `backgroundThrottling=false`).
- 렌더러의 watchdog이 그 게스트에 10초마다 ping을 보내고, 5초 안에 pong이 없으면 패널을 `unresponsive`로 바꾼다(`plugin-frame-bridge.ts` `PANEL_WATCHDOG_PING_INTERVAL_MS`·`PONG_TIMEOUT_MS`, `plugin-panel-watchdog.ts`). 창이 숨겨져 있으면 ping을 건너뛴다.
- pong은 게스트 문서의 shell이 ping을 받자마자 동기로 보낸다(`plugin-panel-shell.ts` `receive`). 워커는 이 판정과 무관하다. 워커가 멈춰도 패널은 「응답하지 않음」이 되지 않는다.
- **자동 복구는 없다.** 한 번 멈춘 watchdog은 다시 돌지 않고, 문서가 그대로면 `unresponsive`를 유지한다(`use-plugin-frame-entry.ts`: 「a session rotation must not revive a frame the watchdog suspended」). 사이드바 탭을 바꾸면 패널이 새로 마운트되어서 다시 뜬다(`right-sidebar-panel-content.tsx` `key={effectiveTab}`). 플러그인 API에는 자기 패널을 다시 띄우는 메서드가 없다.

**이 플러그인 쪽에서 본 것:**
- 워커는 동기로 막는 곳이 없다. 폴더 읽기는 `fs/promises`, `orca` CLI는 `spawn`(시간 한도 20초)이고, 1.5초 폴링은 겹치지 않는다(`ingest`가 진행 중인 읽기를 같이 기다린다). 애초에 워커는 따로 뜬 프로세스라 패널의 pong을 막을 수 없다.
- 패널 문서는 질문이 없으면 빈 화면 하나와 첫 `qp.refresh` 요청뿐이다. 주기 타이머도, 저장소에 되쓰는 루프도 없다(`persist: 'storage'` atom은 저장소 값을 받을 때 다시 쓰지 않는다 — `declarative-atoms.ts` `applyStorageValue`).
- 그래서 무응답은 ping·pong이 지나는 길(렌더러 → Electron 메인 → 게스트)이나 게스트 이벤트 루프가 5초 넘게 밀릴 때 Orca가 내리는 판정으로 본다. 플러그인 코드에서는 원인을 찾지 못했다. Orca 쪽에서 고칠 몫(멈춘 패널 자동 재시도)으로 남긴다.
- 그래도 고친 것: 지운 기록(`dismissed`)이 지운 묶음 전체를 들고 있어 지울수록 저장소가 커졌다(11개에 약 13KB). 이 값은 저장소가 바뀔 때마다 게스트에 다시 읽힌다. 이제 기록은 키와 시각만 남기고, 묶음 전체는 되돌릴 수 있는 마지막 카드 지우기 하나에만 붙인다. 7일이 지난 기록은 버린다(상한 100개는 그대로). 0.4.2가 남긴 기록은 다음에 지울 때 줄어든다.
- 로그 두 줄을 더했다. 패널 `패널 문서 로드 <시각>`은 패널 문서가 (다시) 뜰 때마다, 워커 `qp.refresh 끝(Nms)`은 패널을 열 때 확인이 걸린 시간이다.

**재현·확인 방법**(Windows Orca, 0.4.3 설치 뒤):
1. 「질문」 패널을 열어 둔 채 30분 이상 평소처럼 쓴다(창을 최소화하지 않는다).
2. `orca plugin logs local.question-panel --json`에서 `[question-panel/panel] 패널 문서 로드` 줄의 시각을 본다. 패널이 멈췄다가 탭을 오가 되살아날 때마다 한 줄씩 늘어난다. 멈춘 시각 근처에 워커 줄(`qp.refresh 끝`, `inbox …`, `hook …`)이 없으면, 플러그인 일 없이 Orca 쪽 지연으로 멈춘 것이다.
3. `plugins-data\local.question-panel\storage.json`의 `dismissed` 항목에 `batch`가 마지막 하나 말고는 없는지 본다(카드 하나를 지운 뒤).

## 0.4.2 — 처음부터 선택돼 보이는 선택지로 바로 보내기

- 증상: 하나만 선택 질문의 라디오는 값이 없어도 첫 항목이 체크된 모양으로 그려지는데, 답 저장소(`picks`)는 비어 있어 `complete`가 false였다. 「답 보내기」가 꺼져 있다가 다른 항목을 눌렀다 돌아와야 켜졌다.
- 고침: `withDefaults`로 하나만 선택 질문의 빈 선택을 `[0]`으로 채워 화면·보내기 판단·전송 값을 맞췄다. 여러 개 선택은 기본 체크가 없으므로 그대로(하나는 눌러야 함).

## 0.4.1 — 보낸 메일을 실패로 띄우던 것, 정리 기능

- **원인.** Orca 1.4.25x의 `orchestration send`·`run-current`는 `--full`이 없으면 짧은 한 줄 JSON을 찍는다(`agent-view.ts`의 `printOrchestrationFields`: `{"ok":true,"result":{"messageId":"msg_…"}}`, `{"ok":true,"result":{"runId":"run_…"|null,"objective":…}}`). 0.4.0은 긴 모양(`result.message.id`, `result.run.id`)만 읽었다. 그래서 (1) 실제로 간 메일을 「보내지 못함 — orca 종료 코드 0 — {"ok":true,…}」로 띄웠고, 다시 누르면 같은 메일이 또 갔다. (2) `run-current`도 못 읽어 질문 때 값으로 떨어졌는데, 그 값도 MCP 서버(0.6.1)가 같은 이유로 못 읽어 null이었다 — 그래서 Run에 묶인 세션인데 `orca_session_id:`로 보냈다. 세션 ID 주입 자체는 맞다: CLI가 `ORCA_AGENT_SESSION_ID`를 증거로 보내고 Orca가 세션 신원으로 호출자를 정한다(`orchestration-session-caller.ts`, 그 세션의 터미널 handle 증거는 버린다).
- **판정.** 실패는 종료 코드≠0 이거나 `ok:false`일 때만이다. 종료 코드 0이면 결과 모양을 몰라도 성공(`메일 보냄 (id 모름, 종료 코드 0)`). 메시지 id는 `result.messageId`·`result.message.id`·`result.messageIds[0]`·`result.relay.messageId`에서 찾는다. Run은 `result.runId`(짧은 모양)와 `result.run.id`(긴 모양) 둘 다 읽는다. MCP 서버(question-panel 0.6.2)도 같다.
- **중복 막기.** 워커가 보내는 중인 묶음을 기억해 두 번째 누름을 「이미 보내는 중」으로 돌려보낸다(패널도 보내는 중에는 버튼을 끈다). 보낸 묶음은 다시 보낼 수 없다. 실패했어도 CLI가 돌았고 서버가 거부하지 않았으면(종료 코드≠0 인데 `ok:false`가 아님, 시간 초과) 카드에 「이미 보냈을 수 있음」 경고를 남기고 버튼을 「다시 보내기」로 바꾼다. 보내면 경고를 지운다.
- **정리.** 카드마다 ×(확인 없이 바로 지우고 위쪽에 「되돌리기」), 패널 위쪽 「정리」 줄에 「답한 것·보낸 것 모두 지우기 (N)」·「닫힌 세션 질문 지우기 (N)」. 닫힌 세션 = 터미널이 닫힘(0.3.2·0.3.3) 또는 채팅 세션이 Orca에 없음: 패널을 열 때(`qp.refresh`) 채팅 묶음마다 그 세션 신원으로 `run-current`를 불러 `session_caller_unknown`이면 닫힘(쉬는 세션 `session_caller_not_live` 등은 닫힘으로 보지 않는다). 살아 있으면 배지의 Run도 지금 값으로 맞춘다.
- **다시 뜨지 않게.** 지운 묶음은 저장소 키 `dismissed`에 `<terminalId>/<qN>@<만든 시각>`으로 남는다(최근 100개, 되돌리기에 씀). 질문 폴더 파일은 원래 읽자마자 지우지만, 지우기가 실패해 남아 있어도 지운 묶음이면 버리고, 이미 받은 묶음(보낸 것 포함)이면 다시 넣지 않는다(보낸 카드가 대기로 되살아나 또 보내는 일이 없게). 시각이 키에 들어 있어 같은 세션이 나중에 같은 q 번호로 다시 물으면 새 묶음으로 뜬다.
- **저장소 경합.** 패널의 `qp.refresh`가 시작 때 폴더 읽기와 겹치면 그 읽기를 같이 기다린다. 훅과 폴더 읽기는 저장 직전에 다시 읽어 서로 덮어쓰지 않는다.

## 답이 안 들어갈 때 (0.2.0, 0.3.1)

- `terminal.sendText`는 **지금 포커스된 worktree에 그 터미널이 있을 때만** 받는다(Orca `plugin-host-method-bindings.ts`: `terminal is outside the active worktree`·`no active worktree`로 거부). 0.1.0은 이 오류를 패널에 제대로 못 보였다. 0.2.0은 거부되면 질문 훅이 준 `workspaceId`로 `workspace.open` 한 뒤 한 번 더 보낸다.
- **0.3.1: `workspace.open` 뒤 포커스가 바뀔 때까지 기다린다.** `workspace.open`은 worktree를 활성으로 바꾸라고 요청만 하고 곧 돌아온다(`worktree.activate` effect). `sendText`가 읽는 활성 worktree(저장된 workspace 세션의 `activeWorktreeId`, `terminal-interactive-wait.ts`의 `resolveActiveWorktreeContext`)는 그 뒤에 바뀐다. 1.4.253 Windows 시험에서 0.3.0은 14ms 뒤 다시 보내 같은 오류로 실패했다. 0.3.1은 `workspace.readContext`의 터미널 목록에 대상이 들 때까지(`sendText`와 같은 검사) 100ms마다 최대 3초 기다린 뒤 보낸다. 3초가 지나도 안 바뀌면 한 번 더 보내 보고, 그래도 거부되면 「그 workspace로 옮긴 뒤 다시 누르세요」를 보인다.
- **0.3.3: exited 터미널도 닫힘으로.** 1.4.253은 닫힌(exited) handle에 `terminal_handle_stale` 거부 대신 빈 출력(`tail: []`, status `exited`)을 돌려준다(Windows 실측). 플러그인 host의 `terminal.read`는 런타임 답의 status를 버리고 `{lines, truncated}`만 주므로(`plugin-host-workspace-method-bindings.ts`) status를 볼 수 없다. 그래서 출력이 빈 것도 닫힘으로 본다(질문을 낸 에이전트가 살아 있는 터미널에는 늘 출력이 있다). 판정(살아 있음/닫힘/판정 불가)마다 로그 한 줄을 남긴다.
- **0.3.2: 닫힌 터미널의 카드.** 닫힌 터미널의 handle로 `terminal.read`를 부르면 Orca가 `terminal_handle_stale`로 거부한다(`pty-terminal-summary.ts`의 `getLiveLeafForHandle`, 포커스와 무관). 워커는 패널을 열 때(`qp.refresh`), 새 질문이 올 때, 답 보내기 직전에 이것으로 대기 묶음을 확인한다. 닫혔으면 카드에 「터미널이 닫힘」을 띄우고 보내기를 막는다. 카드마다 「지우기」 버튼이 있고, 패널 위쪽에 「닫힌 세션 질문 지우기 (N)」 버튼이 있다(0.4.1에서 이름을 바꿨다). 다른 오류(권한 등)는 닫힘으로 보지 않는다. 카드에는 `workspace 이름 · 터미널 제목`이 보인다. 제목은 질문할 때 그 터미널이 포커스된 workspace에 있어야 알 수 있고, 모르면 터미널 id를 보인다. workspace 이름은 `workspace.list`에서 가져오고, 없으면 workspace id의 마지막 경로 이름을 쓴다.
- 포커스와 무관하게 기존 터미널에 글을 넣는 플러그인 메서드는 1.4.253에 없다. 플러그인 host 메서드 27개 중 터미널에 글을 넣는 것은 `terminal.sendText`뿐이다. Orca 내부의 `agent.launch` effect에는 기존 터미널을 다시 쓰는 `reuseTerminal`+`prompt`가 있지만, 플러그인의 `agent.launch`는 늘 새 터미널을 만들어 그 길을 열어 주지 않는다.
- 훅의 `terminalId`와 `sendText`가 받는 id는 같은 것(터미널 handle)이다(`agent-tool-call-reader.ts`의 `setAgentToolHookTerminalResolver`).
- 모든 단계가 `orca plugin logs local.question-panel --json`에 남는다. 워커 줄은 `[question-panel] …`, 패널 줄은 `[frame] … [question-panel/panel] …`:
  `worker 시작` → `hook mcp__plugin_question-panel_qp__ask terminalId=… workspaceId=… output=…` → `hook: 묶음 qN 저장` → (누르면) 패널 `답 보내기 누름` → `qp.answer 받음` → `포커스 workspace=… 터미널=… 대상 포함=true|false` → `sendText accepted=…` 또는 `sendText 실패: …` → (`workspace.open … 뒤 포커스 바뀜(Nms), 다시 보냄` 또는 `… 3000ms 안에 포커스가 대상 터미널로 안 바뀜, 그래도 한 번 보냄`) → `묶음 qN 보냄`, 패널 `워커 답 ok=…`.
- 패널 위쪽에 마지막 결과(「보냄」/「보내지 못함」+이유)가 늘 뜨고, 카드 안에도 실패 이유와 「보내는 중」이 뜬다. 카드에는 대상 터미널 id도 보인다.
- 저장 파일: Orca userData 아래 `plugins-data/local.question-panel/storage.json`(키 `batches`, 지운 기록 `dismissed` — 0.4.3부터 키·시각만, 마지막 카드 지우기만 묶음 전체).
- **채팅 세션(0.4.0) 로그:** `inbox: 채팅 묶음 qN 저장(질문 N개, 메일함 run:…, cli …)` → (누르면) `qp.answer 받음` → `run-current(세션 …) → run_… | Run 없음`(또는 `읽지 못함, 질문 때 값(…)을 씀: 이유`) → `orchestration send --to … --subject "[질문 패널 답] qN" (실행 파일)` → `메일 보냄 msg_… → …` 또는 `메일 보내기 실패 → …: 코드: 이유` → `묶음 qN 보냄(메일함 …)`. 폴더를 못 읽으면 `inbox(경로) 읽기 실패`, 모양이 틀린 파일은 `inbox 파일: 모양이 틀려 버림`.
- 카드에는 전달 경로 배지(「터미널」·「메일함 run:…」)와, 마지막 실패 이유가 남는다(패널을 다시 열어도). 보낸 기록에는 `보낸 곳 · 보낸 글`.

## 시험

```sh
orca plugin test orca-plugins/question-panel --json    # 시험 56건(로직 18·워커 27·패널 11)
node --test plugins/question-panel/mcp                 # Claude Code 쪽 MCP 서버(폴더에 남기기·resolve·stdio 포함) 11건
orca plugin check orca-plugins/question-panel --json
npx tsc -p orca-plugins/question-panel                 # 먼저 orca plugin types 로 .orca/types 를 만든다
```

## 파일

- `orca-plugin.json` — trusted-worker, 패널 `questions`, 훅 `agent.tool.after`
- `src/questions.ts` — 묶음 모양과 순수 로직(훅 이벤트·채팅 질문 파일 → 묶음, 답 줄·메일 본문 만들기, CLI 답 읽기)
- `src/protocol.ts` — 패널 ↔ 워커 요청(`qp.answer`(0.4.4부터 `texts`)·`qp.refresh`·`qp.remove`·`qp.undoRemove`·`qp.clearSent`·`qp.clearClosed`)
- `src/panel.tsx` — 질문 카드(하나만: RadioGroup, 여럿: Checkbox, 둘 다 「기타」+Textarea)
- `worker/main.ts` — 훅·폴더로 저장, 답을 터미널에 넣거나 메일함으로 보내기
- Claude Code 쪽: `plugins/question-panel/mcp/ask.mjs`(`toOrca`: 채팅 세션 판정·질문 파일 모양·안내 한 줄)·`mcp/orca.mjs`(진짜 폴더 쓰기·`run-current`)
- `worker/io.ts`·`worker/node-io.ts` — 폴더 읽기·`orca` CLI 실행(시험은 가짜 io), `worker/node.d.ts` — 쓰는 Node API만 적은 타입
