# switchboard 메일함: 다른 터미널 작업자의 보고 경로

조율자가 **다른 터미널·다른 기계**의 작업자(최상위 세션)를 띄울 때 보고가 오가는 길이다. 같은 세션의 서브에이전트(`SendMessage`)에는 해당 없다. 예전에는 Orca orchestration 메일함(`orca orchestration send`, `run:<run_id>` 주소)을 썼는데, 터미널 핸들·Run 주소를 지시서에 박았다가 세션을 다시 열 때마다 보고가 끊겨 **switchboard 메일함**(CLI `switchboard`)으로 바꿨다. 옛 명령은 쓰지 않는다.

## 주소는 역할만

- 주소는 세션·터미널 핸들이 아니라 **역할**이다(예: `myorg/boss`, `<저장소>/coordinator`, `<저장소>/worker-1`). 세션을 다시 열어도 그대로라 작업자·다른 조율자에게 고지할 것이 없다. 지시서·문서에 터미널 핸들, 서버 주소, 토큰을 적지 않는다.
- 역할마다 프로필이 깔려 있다(예: `<저장소>-coordinator`, `<저장소>-worker-1`). 토큰 파일(`~/.config/switchboard/*.json`, 옮기기 전 프로필은 옛 폴더 `~/.config/agent-mail/*.json`)은 열지도 출력하지도 않는다.
- **프로필은 반드시 환경변수 `SWITCHBOARD_PROFILE=<프로필>`로 고른다.** 옛 이름 `AGENT_MAIL_PROFILE`은 3단계까지만 대체값으로 받는다. `switchboard --profile X …`처럼 명령 앞에 쓰면 무시된다.
- CLI는 `switchboard`다(`switchboard version`). 옛 기계에 `agent-mail` 이름만 깔려 있으면 같은 인자로 그것을 쓴다(3단계에 제거).

## 작업자: 보내기

```bash
SWITCHBOARD_PROFILE=<저장소>-worker-1 switchboard send --to <저장소>/coordinator \
  --task <저장소>-<이슈> --subject '[<저장소>-<이슈>] PR #<번호> 열림' --body '<브랜치, tip 해시>'
```

- PR을 열자마자 한 통, 끝나면(병합·정리 뒤, 막혀서 멈출 때도) 보고 한 통. 본문이 길거나 따옴표가 많으면 `--body-file <파일>`.
- 받은 지시에 답할 때는 `reply <ID> --subject 'Re: …' --body '…'`로 같은 스레드에 달고, 끝났으면 `complete <ID>`.
- 성공 출력(`… → … · pending`)을 확인한다. 보낸 뒤 읽혔는지는 `switchboard outbox`의 상태(pending → read)로 본다.

## 조율자: 받기

- switchboard 플러그인이 켜진 세션은 `SWITCHBOARD_PROFILE`의 역할로 메일함을 구독하고, 새 메일이 오면 턴이 끝난 뒤 「메일 #ID 을 읽고 처리하라」 새 턴으로 세션을 깨운다. 따로 대기 스크립트를 띄우지 않는다.
- 깨어나면 그 메일을 `SWITCHBOARD_PROFILE=<저장소>-coordinator switchboard read <ID>`로 **전부** 읽고 처리한다. 끝낸 것은 `complete <ID>`로 표시한다. 놓친 것 같으면 `switchboard inbox`(최근 100통)로 본다.
- 작업자를 띄우기 전에 내 세션이 메일함을 구독하는지(`switchboard status`에서 내 역할이 online) 본다.

## 화면 폴링 금지

- 작업자 화면을 주기적으로 읽어 끝났는지 보는 감시는 쓰지 않는다. 메일이 안 오면 화면을 읽기 전에 메일 경로(역할·프로필·구독)부터 고친다.
- 예외: 작업자를 띄운 직후 「일하는지」 한 번 확인, 30분이 지나도록 보고가 없을 때 화면 꼬리를 한 번 읽는다. 화면에 완료 보고가 있고 idle이면 그 화면을 보고로 삼고, 대장 보고에 「작업자 메일 보고 누락, 화면으로 확인」이라고 적는다.

## 새 역할을 쓰기 시작할 때

작업자 쪽에서 시험 메일 하나를 보내 내 세션이 깨어나는지 본다. 지시서에 주소를 박기 전에 한다.
