#!/usr/bin/env bash
# 자동화 사전 확인(precheck) 감싸개 — 기본 브랜치 체크아웃을 원격으로 따라잡은 뒤 본 명령을 부르고,
# 「정상 종료 코드」가 아닌 실패는 메일함(switchboard)에 드러낸다.
#
#   automation-run.sh <이름> [--ok 0,1] [--to <받는 곳>] [--profile <프로필>] [--task <task>] -- <명령> [인자…]
#
#   이름      알림 상태 파일 이름이자 메일 제목에 붙는다.
#   --ok      본 명령의 정상 종료 코드(기본 0,1). 이 안의 코드는 그대로 돌려주고 알리지 않는다 —
#             precheck 의 「있음(0)」「없음(1)」이다. 그 밖의 코드(127·2·3…)는 알리고 그 코드로 끝난다.
#   --to/--profile/--task  알릴 주소·보내는 프로필·task. 환경변수 AUTOMATION_RUN_TO·_PROFILE·_TASK 로도 준다
#             (인자가 이긴다). 받는 곳이 없으면 알리지 않고 표준오류에만 남긴다.
#
# 왜: 자동화 실행기는 precheck 가 0 이 아니면 어떤 코드든 건너뜀으로 넘긴다. 체크아웃이 묵어 스크립트가 없어도(127)
# 운영에 못 닿아도(2) 「없음(1)」과 똑같이 조용하다. 또 체크아웃을 따라잡는 장치가 없으면 묵은 코드로 돈다.
#
# 잠금: 따라잡기(fetch → fast-forward) 전체를 저장소 단위 잠금(fetch-lock.sh) 안에서 돌린다 — 같은 체크아웃에서
# 자동화 둘이 같은 분에 fetch 하면 ref 갱신이 부딪힌다. AUTOMATION_RUN_LOCK_WAIT(기본 60)초 안에 못 잡으면 재시도 없이
# 원인 `lock`(「잠금 대기 초과」)으로 알리고 70 으로 끝난다. `flock` 이 없는 환경은 mkdir 대체 잠금(fetch-lock.sh 머리말).
# 사람·다른 세션은 같은 잠금을 쓰는 git-fetch-locked.sh 로 fetch 한다.
#
# 따라잡기: 체크아웃이 기본 브랜치에 있고, 추적 파일이 깨끗하고, 원격보다 앞서지 않을 때만 `merge --ff-only`.
# 아니면 건드리지 않고 알린다(다른 세션의 커밋을 버리지 않는다). 따라잡기에 실패하면 본 명령을 돌리지 않고 70 으로 끝난다.
#
# 알림: 같은 원인(sync·rc<코드>)은 처음 한 번, 이어지면 REPEAT_SECS(기본 1시간)마다 한 번. 정상으로 돌아오면 한 번.
# 상태는 `$AUTOMATION_RUN_STATE_DIR/<이름>.state` 한 파일(`원인 마지막_알림_epoch`).
#
# 환경변수: AUTOMATION_RUN_REPO(기본: 이 스크립트가 있는 저장소 루트 — 보통 체크아웃 경로를 준다) · _REMOTE(origin)
# · _BRANCH(main) · _STATE_DIR(~/.cache/automation-run) · _REPEAT_SECS(3600) · _LOCK_WAIT(60) · _SWITCHBOARD(switchboard)
set -uo pipefail

# shellcheck source=fetch-lock.sh
. "$(dirname "${BASH_SOURCE[0]}")/fetch-lock.sh"
REPO="${AUTOMATION_RUN_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_DIR="${AUTOMATION_RUN_STATE_DIR:-$HOME/.cache/automation-run}"
REMOTE="${AUTOMATION_RUN_REMOTE:-origin}"
BRANCH="${AUTOMATION_RUN_BRANCH:-main}"
REPEAT_SECS="${AUTOMATION_RUN_REPEAT_SECS:-3600}"
LOCK_WAIT="${AUTOMATION_RUN_LOCK_WAIT:-60}"
RELAY_TO="${AUTOMATION_RUN_TO:-}"
RELAY_PROFILE="${AUTOMATION_RUN_PROFILE:-}"
RELAY_TASK="${AUTOMATION_RUN_TASK:-automation-run}"
SWITCHBOARD="${AUTOMATION_RUN_SWITCHBOARD:-switchboard}"

usage() { sed -n '2,10p' "$0" >&2; exit 2; }

notify() { # notify <제목> <본문> — 보냈으면 0
  [ -n "$RELAY_TO" ] || { echo "알릴 주소가 없다(--to 또는 AUTOMATION_RUN_TO)" >&2; return 1; }
  local out rc=0
  out="$(SWITCHBOARD_PROFILE="$RELAY_PROFILE" "$SWITCHBOARD" send --to "$RELAY_TO" --task "$RELAY_TASK" \
           --subject "$1" --body "$2" 2>&1)" || rc=$?
  [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -Eq '^#[0-9]+ '
}

# problem <원인> <한 줄 설명> <자세히> — 같은 원인이면 REPEAT_SECS 안에는 다시 보내지 않는다.
problem() {
  local cause="$1" summary="$2" detail="$3" now last="" prev=""
  now="$(date +%s)"
  if [ -f "$STATE_FILE" ]; then read -r prev last < "$STATE_FILE" || true; fi
  if [ "$prev" = "$cause" ] && [ -n "$last" ] && [ $((now - last)) -lt "$REPEAT_SECS" ]; then
    return 0
  fi
  if notify "[자동화] $NAME 실패 — $summary" "$summary
$detail
(같은 원인은 $((REPEAT_SECS / 60))분마다 한 번, 회복하면 한 번 알린다)"; then
    mkdir -p "$STATE_DIR" && printf '%s %s\n' "$cause" "$now" > "$STATE_FILE"
  else
    echo "알리지 못했다: $summary" >&2
  fi
}

recovered() {
  [ -f "$STATE_FILE" ] || return 0
  if notify "[자동화] $NAME 회복" "$NAME 이 다시 정상으로 돈다."; then
    rm -f "$STATE_FILE"
  fi
}

# 따라잡기 — 성공이면 0, 실패면 까닭 한 줄을 표준출력에 내고 1.
catch_up() {
  cd "$REPO" 2>/dev/null || { echo "체크아웃을 찾지 못했다: $REPO"; return 1; }
  local cur err
  cur="$(git symbolic-ref --short -q HEAD || true)"
  [ "$cur" = "$BRANCH" ] || { echo "체크아웃이 $BRANCH 에 있지 않다(${cur:-분리된 HEAD})"; return 1; }
  err="$(git fetch -q "$REMOTE" "$BRANCH" 2>&1)" || { echo "git fetch 실패: $(printf '%s' "$err" | tail -n 3)"; return 1; }
  git rev-parse -q --verify "$REMOTE/$BRANCH" >/dev/null || { echo "$REMOTE/$BRANCH 를 찾지 못했다"; return 1; }
  if git merge-base --is-ancestor "$REMOTE/$BRANCH" HEAD; then
    if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$REMOTE/$BRANCH")" ]; then
      echo "체크아웃이 $REMOTE/$BRANCH 보다 앞서 있다(푸시되지 않은 커밋)"; return 1
    fi
    return 0
  fi
  git merge-base --is-ancestor HEAD "$REMOTE/$BRANCH" || { echo "체크아웃이 $REMOTE/$BRANCH 와 갈라졌다"; return 1; }
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "체크아웃에 커밋하지 않은 변경이 있어 따라잡지 않았다"; return 1; }
  err="$(git merge -q --ff-only "$REMOTE/$BRANCH" 2>&1)" || { echo "merge --ff-only 실패: $(printf '%s' "$err" | tail -n 3)"; return 1; }
}

main() {
  [ "$#" -ge 3 ] || usage
  NAME="$1"; shift
  [[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || usage
  STATE_FILE="$STATE_DIR/$NAME.state"
  local ok="0,1"
  while [ "${1:-}" != "--" ] && [ "$#" -gt 0 ]; do
    case "$1" in
      --ok) ok="${2:-}"; shift 2 ;;
      --to) RELAY_TO="${2:-}"; shift 2 ;;
      --profile) RELAY_PROFILE="${2:-}"; shift 2 ;;
      --task) RELAY_TASK="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [ "${1:-}" = "--" ] || usage
  shift
  [ "$#" -gt 0 ] || usage

  local reason
  local sync_rc=0
  reason="$(fetch_lock_run "$REPO" "$LOCK_WAIT" catch_up 2>&1)" || sync_rc=$?
  if [ "$sync_rc" -ne 0 ]; then
    echo "$reason" >&2
    if [ "$sync_rc" -eq 75 ]; then
      problem lock "체크아웃 fetch 잠금 대기 초과" "$reason
체크아웃: $REPO"
    else
      problem sync "체크아웃을 최신 $BRANCH 로 따라잡지 못했다" "$reason
체크아웃: $REPO"
    fi
    return 70
  fi

  cd "$REPO"  # catch_up 은 서브셸에서 돌았다 — 본 명령은 체크아웃에서 돈다.
  local errfile rc=0
  errfile="$(mktemp)"
  "$@" 2>"$errfile" || rc=$?
  cat "$errfile" >&2
  if [[ ",$ok," == *",$rc,"* ]]; then
    recovered
  else
    problem "rc$rc" "명령이 종료 코드 $rc 로 끝났다" "명령: $*
종료 코드: $rc
표준오류 끝: $(tail -n 5 "$errfile")"
  fi
  rm -f "$errfile"
  return "$rc"
}

{ main "$@"; exit $?; }
