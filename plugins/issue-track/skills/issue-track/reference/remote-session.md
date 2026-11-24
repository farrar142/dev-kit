# 원격 세션에 한 건 맡기기

「이 저장소에 이것 고쳐 줘」 한 건을 다른 기계(Orca 원격 환경)의 작업자 세션에 넘기고 보고만 받는 절차다. 작업자는 그 기계의 최상위 Claude 세션이라 `SendMessage`가 닿지 않는다. 기본 길은 Orca 워커다 — 지시서는 `worker-start`, 보고는 `orchestration send`·`worker_done`(규칙은 [orca-worker.md](orca-worker.md)). switchboard 조율자가 남은 곳은 아래 「옛 길」 절차를 쓴다(주소·프로필 규칙은 [switchboard.md](switchboard.md)).

## 설정

기계마다 다른 값은 `~/.config/dev-kit/issue-track.json`(환경변수 `DEV_KIT_CONFIG`로 경로를 바꾼다)의 `delegate` 절에서 읽는다. 모양은 스킬 폴더의 `issue-track.example.json`. 파일이 없거나 그 저장소 항목이 없으면 사용자에게 값을 받아 파일에 더한 뒤 시작한다.

| 키 | 뜻 |
|---|---|
| `environment` | 작업자를 띄울 Orca 원격 환경 이름(`orca terminal create --environment`) |
| `model` | 작업자 기본 모델(`claude --model`). 티켓이 무거우면 [SKILL.md](../SKILL.md) 「1. 모델 고르기」로 바꾼다 |
| `my_mail_profile` | 나(맡기는 쪽)의 메일함 프로필 |
| `report_to` | 작업자가 보고를 보낼 역할 주소(보통 나의 역할) |
| `repos.<owner/name>.folder` | 원격 기계의 그 저장소 작업 폴더 |
| `repos.<owner/name>.worker_role` · `worker_profile` | 그 폴더 작업자의 메일 역할과 프로필 |

## 절차

1. **이슈** — `gh issue create -R <owner/name> --title … --body-file …`. 본문에 바라는 것과 받아들임 기준. 이미 이슈가 있으면 그 번호를 쓴다. 지시서는 이슈 번호를 가리키고 본문을 되풀이하지 않는다.
2. **지시서** — [SKILL.md](../SKILL.md) 「2. 지시서」 틀로 파일에 쓴다. 첫머리에 「이 지시서는 issue-track 순서대로 진행한다」를 적고, 끝에 보고 길을 박는다: **「PR을 열면 `orca orchestration send --type status`로 한 통, 끝나면(병합·정리 뒤, 막혀 멈출 때도) `worker_done`(--outcome succeeded|failed, 본문은 PR 번호·병합 SHA·시험·남은 것 다섯 줄).」** 터미널 핸들·서버 주소·토큰은 적지 않는다.
3. **작업자 띄우기** — 원격 환경이면 `--on <environment>`(설정 `environment`).
   ```bash
   orca orchestration worker-start --spec-file <지시서 파일> --worktree path:<folder> \
     --agent claude --model <model> --task-title '<저장소>#<이슈> <제목>' --on <environment> --json
   ```
   응답의 task ID·dispatch ID를 적어 둔다 — 확인·닫기에만 쓴다. 지시서에는 넣지 않는다(워커 프리앰블이 알려 준다).
4. **착수 확인** — 몇 분 뒤 `orca orchestration worker-list`로 그 워커가 active인지, `worker-read --dispatch <D>`로 화면 꼬리를 한 번 본다(권한 창·로그인이 흔하다). 그 뒤의 기다림은 화면 폴링이 아니라 메일(`worker_done`·`status`)이 조율자에게 들어오는 것을 기다린다.
5. **보고가 오면** — 읽고 결과를 확인한다(PR 병합·이슈 닫힘을 `gh`로 직접). 끝난 보고면 워커는 `--keep-open`이 아닌 한 스스로 닫힌다; 남았으면 `orca terminal close`로 닫는다. 그 일이 플러그인 새 판이었으면 사용자에게 갱신 스크립트를 안내한다(아래).

한 건이 완료 기준이다: 이슈 닫힘, PR 병합 확인, 작업자 세션 닫힘, `worker_done` 수신.

### 옛 길(switchboard 남은 조율자용)

작업자 세션을 최상위 터미널로 띄우고 지시서를 switchboard 메일로 보낸다. 설정 키 `my_mail_profile`·`report_to`·`repos.<owner/name>.worker_role`·`worker_profile`을 쓴다.

1. 작업자 세션:
   ```bash
   orca terminal create --environment <environment> --worktree path:<folder> --title '<저장소>#<이슈>' \
     --command 'cd <folder> && SWITCHBOARD_PROFILE=<worker_profile> claude --model <model> --name "<저장소>#<이슈> <제목>"' --json
   orca terminal wait --environment <environment> --terminal <handle> --for tui-idle --timeout-ms 120000 --json
   ```
   터미널 `handle`(`term_…`)은 닫을 때만 쓴다. 지시서에는 넣지 않는다.
2. 지시서 메일:
   ```bash
   SWITCHBOARD_PROFILE=<my_mail_profile> switchboard send --to <worker_role> --task <저장소>-<이슈> \
     --subject '[<저장소>-<이슈>] <제목>' --body-file <지시서 파일>
   ```
   끝에 「PR을 열면 한 통, 끝나면 이 메일에 `switchboard reply <ID>`로 보고하고 `complete <ID>`」를 박는다.
3. 착수 확인: `switchboard outbox`에서 pending → read. 10분 넘게 pending이면 `orca terminal read … --json`으로 화면 꼬리를 한 번 읽는다. 기다림은 [switchboard.md](switchboard.md) 「조율자: 받기」.
4. 끝나면 `orca terminal close --environment <environment> --terminal <handle> --tab --json`. 완료 기준에는 보고 메일 `complete`가 들어간다.

## 플러그인 갱신 스크립트

플러그인 새 판이 병합되면 로컬과 원격 기계에 깐다.

```bash
python3 <스킬 폴더>/scripts/update-plugins.py            # 설정의 update 절대로. Windows는 python3 대신 py 런처: py <스킬 폴더>/scripts/update-plugins.py
python3 <스킬 폴더>/scripts/update-plugins.py --local-only
python3 <스킬 폴더>/scripts/update-plugins.py --marketplace <마켓> --hosts remote-1,remote-2
```

기계마다 셸 판별 → 마켓 갱신 → 그 마켓 플러그인을 설치된 모든 범위(user·project·local, local·project는 그 폴더에서)에서 갱신 → 범위별 판 표(기계·플러그인·범위·폴더·판·최신·상태; 최신은 그 기계 마켓 클론의 판)를 찍는다. 마켓 클론의 `marketplace.json` 에서 빠진 플러그인(마켓에서 지운 것)의 설치는 갱신하지 않고 표에서 빼며 「마켓에 없어 건너뜀」 아래 기계마다 한 줄로 알린다(설치 항목은 그대로 둔다). reload·재시작은 하지 않는다. 세션 플러그인(switchboard)은 이 마켓이 아니라 switchboard CLI 가 깔므로, 그 판과 옛 판으로 떠 있는 세션은 `switchboard plugin status`·`switchboard status`(세션마다 `cli_version`)로 본다. `--no-sessions` 는 옛 호출을 깨지 않으려고 받기만 한다. 종료 코드: 0 모든 설치가 최신 / 1 기계·갱신 명령 실패 또는 옛 판이 남은 설치 / 2 설정 오류. `update` 절 키:

| 키 | 뜻 |
|---|---|
| `marketplace` | 갱신할 마켓 이름 |
| `hosts` | 원격 기계 ssh 별칭 목록(`ssh <별칭> '<명령>'`이 비밀번호 없이 돼야 한다) |
| `remote_claude` | 원격 기계의 claude 실행 파일(기본 `claude`). posix 원격은 `PATH="$HOME/.local/bin:$PATH" <remote_claude> plugin …`으로 나간다(ssh 비대화형 셸 PATH 보완) |
| `skill_copy` | 손으로 둔 스킬 복사본 폴더(기본 `~/.claude/skills/issue-track`). 폴더가 있으면 갱신 스크립트가 로컬에서 설치된 판의 스킬 폴더(문서·스크립트·시험)를 거기에 맞추고 `VERSION`을 적는다. 복사본에만 있는 파일은 지우지 않고 이름만 알린다. 그 기계에 issue-track 이 깔려 있지 않으면 로컬 마켓 클론의 플러그인 폴더를 원본으로 쓴다 |
| `agent_copy` | 손으로 둔 에이전트 정의 폴더(기본 `~/.claude/agents`). 플러그인 `agents/` 와 같은 이름의 파일만 설치된 판(없으면 마켓 클론)으로 맞추고, 다르면 덮기 전에 `<이름>.md.bak-<날짜>` 사본을 남기고 복사본에만 있던 줄을 알린다. 없는 이름은 만들지 않는다 |
| `shells` | ssh 별칭 → 원격 셸(`posix`·`powershell`). 없는 별칭은 `ssh <별칭> 'echo $PSVersionTable.PSVersion.Major'`로 판별한다. PowerShell은 접두 없이 `Set-Location -LiteralPath '<폴더>' -ErrorAction Stop; claude plugin update <id> --scope local; exit $LASTEXITCODE` |
