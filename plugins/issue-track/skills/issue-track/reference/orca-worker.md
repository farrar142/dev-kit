# Orca 워커: 작업자 띄우기와 보고 경로 (기본 길)

조율자가 **다른 터미널·다른 기계**의 작업자(최상위 세션)를 띄울 때의 기본 길이다. 같은 세션의 서브에이전트(`SendMessage`)에는 해당 없다. switchboard 조율자가 남은 곳은 [switchboard.md](switchboard.md)(옛 길).

## 조율자: 띄우기·확인

```bash
orca orchestration worker-start --spec-file <지시서 파일> --worktree <current|path:<폴더>|new-child> \
  --agent claude --model <모델> --task-title '<저장소>#<이슈> <제목>' [--on <저장소 환경>] --json
orca orchestration worker-list [--run <run_id>]        # 살아 있는 워커·터미널 상태
orca orchestration worker-read --dispatch <D>          # 화면·기록 꼬리를 한 번
orca orchestration check                               # 들어온 status·worker_done·질문
```

- 지시서는 파일로 쓴다(`--spec-file`). 터미널 핸들·서버 주소·토큰은 적지 않는다 — 워커가 받는 프리앰블에 자기 세션 ID·Task ID·Dispatch ID·명령이 들어 있다.
- `--agent issue-worker`로 뜨지 않는다(일반 에이전트로 뜬다). 지시서 첫머리에 「이 지시서는 issue-track 순서대로 진행한다」를 적는다 — 워커는 그렇게 적혀 오면 `agents/issue-worker.md`를 읽고 그대로 따른다.
- 화면 폴링 금지: 끝났는지 `worker-read`를 주기적으로 돌리지 않는다. `status`·`worker_done`이 조율자에게 들어온다. 30분이 지나도 소식이 없을 때만 한 번 읽는다.

## 워커: 보내기

```bash
# PR 열림
orca orchestration send --from <세션 ID> --type status --subject '[<저장소>-<이슈>] PR #<번호> 열림' \
  --body '<브랜치, tip 해시>' --task-id <T> --dispatch-id <D>
# 끝(병합·정리 뒤, 막혀 멈출 때도)
orca orchestration send --from <세션 ID> --type worker_done --subject '<짧은 상태>' \
  --body '<PR·병합 SHA / 요지 / 시험 / 남은 것 / 막힌 것>' --task-id <T> --dispatch-id <D> --outcome succeeded|failed
```

- 세션 ID·T·D는 프리앰블의 값을 그대로 쓴다. 일을 못 끝냈으면 `--outcome failed`. 실패를 본문에만 적지 않는다.
- `worker_done`은 한 번만 보낸다. 보낸 뒤 성공 출력을 확인하고, 실패하면 출력이 알려 주는 복구대로 한다. 마지막 메시지에도 같은 보고를 남긴다.
