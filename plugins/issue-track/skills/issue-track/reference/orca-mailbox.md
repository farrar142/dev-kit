# Orca 다른 터미널 작업자의 보고 경로

조율자가 Orca로 **다른 기계·다른 터미널**의 작업자를 띄울 때(`orca terminal create` + `orca orchestration send`)의 규칙이다. 같은 세션의 서브에이전트(`SendMessage`)에는 해당 없다. 바뀌는 터미널 핸들에 보고 경로를 걸었다가 작업자 보고가 전부 실패한 일이 있어 생긴 규칙이다.

## 주소는 고정 Run 메일함만

- 보고 주소는 `run:<run_id>`만 쓴다. 지시서·조율자 문서·작업자 메모리에 `term_…` 터미널 핸들을 적지 않는다.
  - 왜: 핸들은 세션을 다시 열면 바뀐다. 옛 핸들을 박아 둬서 작업자 보고가 모두 「살아 있는 창이 없다」로 실패했고, 조율자는 작업자 화면을 1분마다 읽는 감시로 때웠다(토큰 낭비).
- 조율자는 세션을 다시 열면 `orca orchestration run-use <run_id>`로 다시 묶는다. 주소가 안 바뀌므로 작업자·다른 조율자에게 고지할 것이 없다.

## 작업자: 보내기

```bash
orca orchestration send --environment <조율자 환경> --to run:<run_id> \
  --from "$ORCA_TERMINAL_HANDLE" --subject "…" --body "…"
```

- Orca 터미널 안에서만 보낸다. ssh 셸에는 핸들이 없어 거부된다.
- 조율자가 다른 환경(기계)에 있으면 `--environment`를 꼭 쓴다. 빼면 거절된다.

## 조율자: 받기

- `check --run <run_id> --peek --wait`를 도는 감시 스크립트를 `run_in_background`로 **하나만** 띄운다. 새 메일이 오면 스크립트가 끝나 조율자가 깨어난다.
  - 일반 Bash에서 `&`로 띄우지 않는다. 떠돌이 감시가 메일을 먼저 읽어 가 조율자가 못 깨어난다. 떠돌이 확인: `ps -ef | grep "orchestration check"`.
- 깨어나면 `check --run <run_id> --json`으로 읽고 **`--ack <deliveryId>`**를 한 뒤 감시를 다시 띄운다.
  - 왜: ack가 없으면 같은 묶음이 계속 다시 와서 감시가 즉시 거듭 깨어났다.
- 감시가 꺼져 있으면 보고를 늦게 안다. 작업자를 띄우기 전에 감시가 떠 있는지 본다.

```bash
# inbox-watch.sh — 새 메일이 오면 출력하고 끝남(배경 실행 → 끝나면 조율자가 깨어남)
RUN=<run_id>
while true; do
  out=$(orca orchestration check --run $RUN --peek --wait --timeout-ms 3000000 --json 2>/dev/null)
  n=$(printf '%s' "$out" | grep -oE '"count": *[0-9]+' | grep -oE '[0-9]+' | tail -1)
  [ -n "$n" ] && [ "$n" -gt 0 ] && { printf '%s\n' "$out"; exit 0; }
done
```

```bash
# inbox-read.sh — 지금 묶음을 출력하고 ack
RUN=<run_id>
out=$(orca orchestration check --run $RUN --json)
printf '%s\n' "$out"
d=$(printf '%s' "$out" | grep -oE '"deliveryId": *"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
[ -n "$d" ] && orca orchestration check --run $RUN --ack "$d" --json >/dev/null
```

## 화면 폴링 금지

- 작업자 화면을 주기적으로 읽어 끝났는지 보는 감시는 쓰지 않는다. 메일이 안 오면 화면을 읽기 전에 메일함 경로(주소·감시·ack)부터 고친다.
- 예외: 작업자를 띄운 직후 「일하는지」 한 번 확인.

## 새 주소를 쓰기 시작할 때

작업자 쪽에서 시험 메일 하나를 보내 감시가 깨어나는지 본다. 지시서에 주소를 박기 전에 한다.
