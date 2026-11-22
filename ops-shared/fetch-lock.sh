# 저장소 단위 fetch 잠금 — `source` 해서 쓴다(automation-run.sh · git-fetch-locked.sh).
#
#   fetch_lock_run <저장소> <대기초> <명령> [인자…]   잠금 안에서 명령을 돌리고 그 종료 코드를 돌려준다.
#                                                     대기 시간 안에 못 잡으면 표준오류에 「잠금 대기 초과」를 쓰고 75.
#
# 왜: 같은 체크아웃(워크트리는 ref 를 공유한다)에서 fetch 둘이 같은 순간 돌면 원격 ref 갱신이 부딪혀
# `incorrect old value provided` 로 뒤쪽이 진다. 재시도로 덮지 않고 한 줄로 세운다.
#
# 잠금 파일: `<git-common-dir>/ops-shared-fetch.lock`. 쓰는 쪽은 모두 이 파일을 쓴다.
# `flock` 이 없는 환경(macOS 기본)에서는 같은 이름 뒤에 `.d` 를 붙인 디렉터리를 `mkdir` 로 잡는 대체 잠금을 쓴다
# (안에 pid 를 적어 두고, 쥔 프로세스가 죽었으면 넘겨받는다). FETCH_LOCK_FORCE_MKDIR=1 이면 flock 이 있어도 대체 잠금을 쓴다.

fetch_lock_run() {
  local repo="$1" wait_secs="$2" common lock holder rc=0
  shift 2
  common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
    || { echo "git 저장소가 아니다: $repo" >&2; return 2; }
  lock="$common/ops-shared-fetch.lock"
  if command -v flock >/dev/null 2>&1 && [ "${FETCH_LOCK_FORCE_MKDIR:-}" != 1 ]; then
    ( flock -w "$wait_secs" 9 || exit 75; "$@" ) 9>"$lock" || rc=$?
  else
    local deadline=$((SECONDS + wait_secs))
    until mkdir "$lock.d" 2>/dev/null; do
      holder="$(cat "$lock.d/pid" 2>/dev/null || true)"
      if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
        rm -f "$lock.d/pid"; rmdir "$lock.d" 2>/dev/null || true
        continue
      fi
      if [ "$SECONDS" -ge "$deadline" ]; then rc=75; break; fi
      sleep 0.2
    done
    if [ "$rc" -eq 0 ]; then
      echo $$ > "$lock.d/pid"
      "$@" || rc=$?
      rm -f "$lock.d/pid"; rmdir "$lock.d" 2>/dev/null || true
    fi
  fi
  [ "$rc" -ne 75 ] || echo "잠금 대기 초과: ${wait_secs}초 안에 $lock 을 못 잡았다" >&2
  return "$rc"
}
