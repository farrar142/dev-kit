# 원격 세션에 한 건 맡기기

「이 저장소에 이것 고쳐 줘」 한 건을 다른 기계(Orca 원격 환경)의 작업자 세션에 넘기고 보고만 받는 절차다. 작업자는 그 기계의 최상위 Claude 세션이라 `SendMessage`가 닿지 않는다. 지시와 보고는 Agent Mail로 오간다 — 주소·프로필 규칙은 [agent-mail.md](agent-mail.md).

## 설정

기계마다 다른 값은 `~/.config/dev-kit/issue-track.json`(환경변수 `DEV_KIT_CONFIG`로 경로를 바꾼다)의 `delegate` 절에서 읽는다. 모양은 스킬 폴더의 `issue-track.example.json`. 파일이 없거나 그 저장소 항목이 없으면 사용자에게 값을 받아 파일에 더한 뒤 시작한다.

| 키 | 뜻 |
|---|---|
| `environment` | 작업자를 띄울 Orca 원격 환경 이름(`orca terminal create --environment`) |
| `model` | 작업자 기본 모델(`claude --model`). 티켓이 무거우면 [SKILL.md](../SKILL.md) 「1. 모델 고르기」로 바꾼다 |
| `my_mail_profile` | 나(맡기는 쪽)의 Agent Mail 프로필 |
| `report_to` | 작업자가 보고를 보낼 역할 주소(보통 나의 역할) |
| `repos.<owner/name>.folder` | 원격 기계의 그 저장소 작업 폴더 |
| `repos.<owner/name>.worker_role` · `worker_profile` | 그 폴더 작업자의 메일 역할과 프로필 |

## 절차

1. **이슈** — `gh issue create -R <owner/name> --title … --body-file …`. 본문에 바라는 것과 받아들임 기준. 이미 이슈가 있으면 그 번호를 쓴다. 지시서는 이슈 번호를 가리키고 본문을 되풀이하지 않는다.
2. **작업자 세션** — Orca CLI로 원격 환경에 띄운다(Orca 실행 파일 고르기는 `orca-cli` 스킬; Linux에서 Orca 터미널 밖이면 `orca-ide`).
   ```bash
   orca terminal create --environment <environment> --worktree path:<folder> --title '<저장소>#<이슈>' \
     --command 'cd <folder> && AGENT_MAIL_PROFILE=<worker_profile> claude --model <model> --name "<저장소>#<이슈> <제목>"' --json
   orca terminal wait --environment <environment> --terminal <handle> --for tui-idle --timeout-ms 120000 --json
   ```
   응답의 터미널 `handle`(`term_…`)을 적어 둔다 — 닫을 때만 쓴다. 지시서에는 넣지 않는다. switchboard 플러그인이 켜진 세션은 `AGENT_MAIL_PROFILE`의 역할로 메일을 구독하므로 tui-idle이면 받을 준비가 된 것이다.
3. **지시서** — 파일로 써서 메일로 보낸다. 작업자 세션은 switchboard가 메일로 깨운다.
   ```bash
   AGENT_MAIL_PROFILE=<my_mail_profile> agent-mail send --to <worker_role> --task <저장소>-<이슈> \
     --subject '[<저장소>-<이슈>] <제목>' --body-file <지시서 파일>
   ```
   지시서는 [SKILL.md](../SKILL.md) 「2. 지시서」 틀을 따르고, 끝에 보고 길을 박는다: **「PR을 열면 한 통, 끝나면(병합·정리 뒤, 막혀 멈출 때도) 이 메일에 `agent-mail reply <ID>`로 보고하고 `complete <ID>`. 보고에는 PR 번호·병합 SHA·시험·남은 것.」**
4. **착수 확인** — 몇 분 뒤 `AGENT_MAIL_PROFILE=<my_mail_profile> agent-mail outbox`에서 그 메일이 pending → read로 바뀌었는지 본다. 10분 넘게 pending이면 `orca terminal read --environment <environment> --terminal <handle> --json`으로 화면 꼬리를 한 번 읽는다(권한 창·로그인·메일 구독 실패가 흔하다). 그 뒤의 기다림은 [agent-mail.md](agent-mail.md) 「조율자: 받기」 — 화면 폴링이 아니라 메일 대기.
5. **보고가 오면** — 읽고 결과를 확인한다(PR 병합·이슈 닫힘을 `gh`로 직접). 끝난 보고면 세션을 닫는다.
   ```bash
   orca terminal close --environment <environment> --terminal <handle> --tab --json
   ```
   그 일이 플러그인 새 판이었으면 사용자에게 갱신 스크립트를 안내한다(아래).

한 건이 완료 기준이다: 이슈 닫힘, PR 병합 확인, 작업자 세션 닫힘, 보고 메일 `complete`.

## 플러그인 갱신 스크립트

플러그인 새 판이 병합되면 로컬과 원격 기계에 깐다.

```bash
python3 <스킬 폴더>/scripts/update-plugins.py            # 설정의 update 절대로
python3 <스킬 폴더>/scripts/update-plugins.py --local-only
python3 <스킬 폴더>/scripts/update-plugins.py --marketplace <마켓> --hosts remote-1,remote-2 --no-sessions
```

기계마다 마켓 갱신 → 그 마켓 플러그인 갱신(local·project scope는 그 폴더에서) → 기계×플러그인 버전 표, 그리고 「옛 판으로 떠 있는 세션」(online이고 switchboard를 마지막으로 갱신하기 전에 등록한 세션)을 찍는다. reload·재시작은 하지 않는다 — 표의 세션을 언제 다시 띄울지는 사람이 정한다. `update` 절 키:

| 키 | 뜻 |
|---|---|
| `marketplace` | 갱신할 마켓 이름 |
| `hosts` | 원격 기계 ssh 별칭 목록(`ssh <별칭> '<명령>'`이 비밀번호 없이 돼야 한다) |
| `mail_profile` | `agent-mail status`를 읽을 프로필 |
| `machines` | ssh 별칭(로컬은 `local`) → Agent Mail이 보고하는 기계 이름. 없으면 별칭 그대로, 로컬은 hostname |
| `session_plugin` | 옛 판 세션을 가를 플러그인(기본 `switchboard`) |
