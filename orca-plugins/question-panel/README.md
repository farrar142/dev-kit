# 질문 패널 (Orca 플러그인, 시제품 0.3.0 — Claude Code question-panel 0.6.0 이상과 함께)

> **풀림(question-panel 0.6.0, 2026-11-08).** 0.2.0까지는 질문이 워커에 닿지 않았다. Claude Code는 mod 도구(옛 `mcp__question-panel__ask`) 호출에 `PreToolUse`·`PostToolUse` 설정 훅을 돌리지 않고, Orca의 `agent.tool.after`는 그 훅(`orca-agent-hook`)을 타고 오기 때문이다. Claude Code question-panel 0.6.0이 질문 도구를 진짜 stdio MCP 서버(`qp`)로 옮겨, 도구 이름이 `mcp__plugin_question-panel_qp__ask`가 되었고 훅을 탄다(Claude Code 2.1.319, `matcher: "*"` 기록 훅으로 Pre·Post 둘 다, `tool_response`에 「질문 묶음 qN」 확인). 이 플러그인 0.3.0은 그 이름을 본다. 다른 이름의 질문 도구가 오면 로그에 `질문 도구 이름이 아니라 무시`를 남긴다.

Claude Code의 `question-panel` 플러그인(`plugins/question-panel/`)이 올린 객관식 질문을 **Orca 오른쪽 사이드바 「질문」 패널**에 카드로 띄우고, 사용자가 고른 답을 **질문한 Claude의 터미널에 한 줄로 넣고 Enter**를 누른다. Claude는 질문을 올린 뒤 턴을 끝내고 기다리지 않는다(비블로킹).

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
| Orca 채팅 UI(stream-json, `ORCA_STRUCTURED_SESSION=1`) | **안 됨** | **안 됨** | 아래 「채팅 세션이 막힌 까닭」 |
| SSH·WSL 호스트의 에이전트 | 안 됨 | — | Orca 문서: 도구 훅은 SSH·WSL에 아직 없다 |

### 채팅 세션이 막힌 까닭 (Orca 소스 기준)

- 채팅 세션에는 터미널 pane이 없고 `ORCA_AGENT_SESSION_ID`로만 식별된다. 사용자 메시지는 renderer의 `agentSession.send` RPC로 들어간다. 플러그인 host API에는 채팅 세션에 메시지를 넣는 메서드가 없다(워커 메서드는 `terminal.*`·`agent.launch`까지).
- `agent.tool.before/after` 훅은 터미널 에이전트의 HTTP 훅 경로에서만 발화한다. 채팅 세션은 SDK `canUseTool` 경로라 플러그인 훅을 부르지 않는다. 그래서 질문이 올라온 것도 플러그인이 모른다.
- 가장 가까운 대안: `orca orchestration send --to orca_session_id:<세션 ID>`가 채팅 세션 수신함으로 메일을 넣고 그 세션에 턴으로 전달한다. 다만 플러그인 API가 아니라 CLI라서 워커가 `orca` 실행 파일을 직접 띄워야 하고, Claude Code 쪽 질문 도구는 자기 세션 ID를 모른다(훅 환경에 `process`가 없다). Orca가 플러그인 API에 「채팅 세션에 메시지 보내기」와 채팅 세션 도구 훅을 내 줘야 깔끔하게 된다.
- 그 사이 채팅 세션은 Claude Code question-panel 0.5.2의 대화창 블록 + 글 답(`q4 1-2`)으로 비블로킹을 유지한다.

## 설치 (Orca 1.4.248 이상, 데스크톱)

플러그인은 코드를 돌리므로 Orca가 승인을 묻는다(`terminal:send`·`storage:own`·`notifications:show`·`workspace:read`·`workspace:write`, 훅 `agent.tool.after`). `workspace:*`는 0.2.0에서 더했다: 포커스 확인과, 질문한 터미널의 workspace로 옮겨 다시 보내기.

```sh
# 이 저장소를 받은 뒤, Orca 호스트의 절대 경로로
orca plugin validate <dev-kit>/orca-plugins/question-panel --json
orca plugin install  <dev-kit>/orca-plugins/question-panel --json           # 종료 3 + 승인 지문을 낸다
orca plugin install  <dev-kit>/orca-plugins/question-panel --approve <지문> --json
orca plugin open local.question-panel --panel questions --json
```

개발 중에는 `orca plugin dev load <절대 경로>`(파일이 바뀌면 다시 읽는다)나 `orca plugin dev watch <절대 경로> --check --json`.

확인: Orca 터미널에서 Claude Code(question-panel 0.5.2+ 설치)를 띄우고 질문 도구를 부르게 한다 → 「질문」 패널에 카드 → 고르고 「답 보내기」 → 그 터미널에 `[질문 패널 답 q1] …` 줄이 들어가 Claude가 이어서 답한다.

## 답이 안 들어갈 때 (0.2.0)

- `terminal.sendText`는 **지금 포커스된 worktree에 그 터미널이 있을 때만** 받는다(Orca `plugin-host-method-bindings.ts`: `terminal is outside the active worktree`·`no active worktree`로 거부). 0.1.0은 이 오류를 패널에 제대로 못 보였다. 0.2.0은 거부되면 질문 훅이 준 `workspaceId`로 `workspace.open` 한 뒤 한 번 더 보낸다.
- 훅의 `terminalId`와 `sendText`가 받는 id는 같은 것(터미널 handle)이다(`agent-tool-call-reader.ts`의 `setAgentToolHookTerminalResolver`).
- 모든 단계가 `orca plugin logs local.question-panel --json`에 남는다. 워커 줄은 `[question-panel] …`, 패널 줄은 `[frame] … [question-panel/panel] …`:
  `worker 시작` → `hook mcp__plugin_question-panel_qp__ask terminalId=… workspaceId=… output=…` → `hook: 묶음 qN 저장` → (누르면) 패널 `답 보내기 누름` → `qp.answer 받음` → `포커스 workspace=… 터미널=… 대상 포함=true|false` → `sendText accepted=…` 또는 `sendText 실패: …` → (`workspace.open … 뒤 다시 보냄`) → `묶음 qN 보냄`, 패널 `워커 답 ok=…`.
- 패널 위쪽에 마지막 결과(「보냄」/「보내지 못함」+이유)가 늘 뜨고, 카드 안에도 실패 이유와 「보내는 중」이 뜬다. 카드에는 대상 터미널 id도 보인다.
- 저장 파일: Orca userData 아래 `plugins-data/local.question-panel/storage.json`(키 `batches`).

## 시험

```sh
orca plugin test orca-plugins/question-panel --json    # 시험 15건(로직 6·워커 5·패널 4)
orca plugin check orca-plugins/question-panel --json
npx tsc -p orca-plugins/question-panel                 # 먼저 orca plugin types 로 .orca/types 를 만든다
```

## 파일

- `orca-plugin.json` — trusted-worker, 패널 `questions`, 훅 `agent.tool.after`
- `src/questions.ts` — 묶음 모양과 순수 로직(훅 이벤트 → 묶음, 답 줄 만들기)
- `src/protocol.ts` — 패널 ↔ 워커 요청(`qp.answer`·`qp.clearSent`)
- `src/panel.tsx` — 질문 카드(하나만: RadioGroup, 여럿: Checkbox)
- `worker/main.ts` — 훅으로 저장, 답을 터미널에 넣기
