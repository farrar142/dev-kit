# 질문 패널 (Orca 플러그인, 시제품 0.4.0 — Claude Code question-panel 0.6.1 이상과 함께)

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

## 답이 안 들어갈 때 (0.2.0, 0.3.1)

- `terminal.sendText`는 **지금 포커스된 worktree에 그 터미널이 있을 때만** 받는다(Orca `plugin-host-method-bindings.ts`: `terminal is outside the active worktree`·`no active worktree`로 거부). 0.1.0은 이 오류를 패널에 제대로 못 보였다. 0.2.0은 거부되면 질문 훅이 준 `workspaceId`로 `workspace.open` 한 뒤 한 번 더 보낸다.
- **0.3.1: `workspace.open` 뒤 포커스가 바뀔 때까지 기다린다.** `workspace.open`은 worktree를 활성으로 바꾸라고 요청만 하고 곧 돌아온다(`worktree.activate` effect). `sendText`가 읽는 활성 worktree(저장된 workspace 세션의 `activeWorktreeId`, `terminal-interactive-wait.ts`의 `resolveActiveWorktreeContext`)는 그 뒤에 바뀐다. 1.4.253 Windows 시험에서 0.3.0은 14ms 뒤 다시 보내 같은 오류로 실패했다. 0.3.1은 `workspace.readContext`의 터미널 목록에 대상이 들 때까지(`sendText`와 같은 검사) 100ms마다 최대 3초 기다린 뒤 보낸다. 3초가 지나도 안 바뀌면 한 번 더 보내 보고, 그래도 거부되면 「그 workspace로 옮긴 뒤 다시 누르세요」를 보인다.
- **0.3.3: exited 터미널도 닫힘으로.** 1.4.253은 닫힌(exited) handle에 `terminal_handle_stale` 거부 대신 빈 출력(`tail: []`, status `exited`)을 돌려준다(Windows 실측). 플러그인 host의 `terminal.read`는 런타임 답의 status를 버리고 `{lines, truncated}`만 주므로(`plugin-host-workspace-method-bindings.ts`) status를 볼 수 없다. 그래서 출력이 빈 것도 닫힘으로 본다(질문을 낸 에이전트가 살아 있는 터미널에는 늘 출력이 있다). 판정(살아 있음/닫힘/판정 불가)마다 로그 한 줄을 남긴다.
- **0.3.2: 닫힌 터미널의 카드.** 닫힌 터미널의 handle로 `terminal.read`를 부르면 Orca가 `terminal_handle_stale`로 거부한다(`pty-terminal-summary.ts`의 `getLiveLeafForHandle`, 포커스와 무관). 워커는 패널을 열 때(`qp.refresh`), 새 질문이 올 때, 답 보내기 직전에 이것으로 대기 묶음을 확인한다. 닫혔으면 카드에 「터미널이 닫힘」을 띄우고 보내기를 막는다. 카드마다 「지우기」 버튼이 있고, 패널 위쪽에 「닫힌 터미널 카드 N개 지우기」 버튼이 있다. 다른 오류(권한 등)는 닫힘으로 보지 않는다. 카드에는 `workspace 이름 · 터미널 제목`이 보인다. 제목은 질문할 때 그 터미널이 포커스된 workspace에 있어야 알 수 있고, 모르면 터미널 id를 보인다. workspace 이름은 `workspace.list`에서 가져오고, 없으면 workspace id의 마지막 경로 이름을 쓴다.
- 포커스와 무관하게 기존 터미널에 글을 넣는 플러그인 메서드는 1.4.253에 없다. 플러그인 host 메서드 27개 중 터미널에 글을 넣는 것은 `terminal.sendText`뿐이다. Orca 내부의 `agent.launch` effect에는 기존 터미널을 다시 쓰는 `reuseTerminal`+`prompt`가 있지만, 플러그인의 `agent.launch`는 늘 새 터미널을 만들어 그 길을 열어 주지 않는다.
- 훅의 `terminalId`와 `sendText`가 받는 id는 같은 것(터미널 handle)이다(`agent-tool-call-reader.ts`의 `setAgentToolHookTerminalResolver`).
- 모든 단계가 `orca plugin logs local.question-panel --json`에 남는다. 워커 줄은 `[question-panel] …`, 패널 줄은 `[frame] … [question-panel/panel] …`:
  `worker 시작` → `hook mcp__plugin_question-panel_qp__ask terminalId=… workspaceId=… output=…` → `hook: 묶음 qN 저장` → (누르면) 패널 `답 보내기 누름` → `qp.answer 받음` → `포커스 workspace=… 터미널=… 대상 포함=true|false` → `sendText accepted=…` 또는 `sendText 실패: …` → (`workspace.open … 뒤 포커스 바뀜(Nms), 다시 보냄` 또는 `… 3000ms 안에 포커스가 대상 터미널로 안 바뀜, 그래도 한 번 보냄`) → `묶음 qN 보냄`, 패널 `워커 답 ok=…`.
- 패널 위쪽에 마지막 결과(「보냄」/「보내지 못함」+이유)가 늘 뜨고, 카드 안에도 실패 이유와 「보내는 중」이 뜬다. 카드에는 대상 터미널 id도 보인다.
- 저장 파일: Orca userData 아래 `plugins-data/local.question-panel/storage.json`(키 `batches`).
- **채팅 세션(0.4.0) 로그:** `inbox: 채팅 묶음 qN 저장(질문 N개, 메일함 run:…, cli …)` → (누르면) `qp.answer 받음` → `run-current(세션 …) → run_… | Run 없음`(또는 `읽지 못함, 질문 때 값(…)을 씀: 이유`) → `orchestration send --to … --subject "[질문 패널 답] qN" (실행 파일)` → `메일 보냄 msg_… → …` 또는 `메일 보내기 실패 → …: 코드: 이유` → `묶음 qN 보냄(메일함 …)`. 폴더를 못 읽으면 `inbox(경로) 읽기 실패`, 모양이 틀린 파일은 `inbox 파일: 모양이 틀려 버림`.
- 카드에는 전달 경로 배지(「터미널」·「메일함 run:…」)와, 마지막 실패 이유가 남는다(패널을 다시 열어도). 보낸 기록에는 `보낸 곳 · 보낸 글`.

## 시험

```sh
orca plugin test orca-plugins/question-panel --json    # 시험 32건(로직 11·워커 15·패널 6)
node --test plugins/question-panel/mcp                 # Claude Code 쪽 MCP 서버(폴더에 남기기·stdio 포함) 9건
orca plugin check orca-plugins/question-panel --json
npx tsc -p orca-plugins/question-panel                 # 먼저 orca plugin types 로 .orca/types 를 만든다
```

## 파일

- `orca-plugin.json` — trusted-worker, 패널 `questions`, 훅 `agent.tool.after`
- `src/questions.ts` — 묶음 모양과 순수 로직(훅 이벤트·채팅 질문 파일 → 묶음, 답 줄·메일 본문 만들기, CLI 답 읽기)
- `src/protocol.ts` — 패널 ↔ 워커 요청(`qp.answer`·`qp.clearSent`)
- `src/panel.tsx` — 질문 카드(하나만: RadioGroup, 여럿: Checkbox)
- `worker/main.ts` — 훅·폴더로 저장, 답을 터미널에 넣거나 메일함으로 보내기
- Claude Code 쪽: `plugins/question-panel/mcp/ask.mjs`(`toOrca`: 채팅 세션 판정·질문 파일 모양·안내 한 줄)·`mcp/orca.mjs`(진짜 폴더 쓰기·`run-current`)
- `worker/io.ts`·`worker/node-io.ts` — 폴더 읽기·`orca` CLI 실행(시험은 가짜 io), `worker/node.d.ts` — 쓰는 Node API만 적은 타입
