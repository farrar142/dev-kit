#!/usr/bin/env bash
# fetch 를 저장소 단위 잠금(fetch-lock.sh) 안에서 돌린다 — 사람·다른 세션이 자동화와 같은 체크아웃에 fetch 할 때 쓴다.
#
#   git-fetch-locked.sh [fetch 인자…]        예) git-fetch-locked.sh -q origin main
#
# 저장소는 현재 디렉터리(AUTOMATION_RUN_REPO 로 바꾼다). 대기는 AUTOMATION_RUN_LOCK_WAIT 초(기본 60),
# 넘기면 「잠금 대기 초과」로 75 로 끝난다.
set -uo pipefail
# shellcheck source=fetch-lock.sh
. "$(dirname "${BASH_SOURCE[0]}")/fetch-lock.sh"
repo="${AUTOMATION_RUN_REPO:-.}"
fetch_lock_run "$repo" "${AUTOMATION_RUN_LOCK_WAIT:-60}" git -C "$repo" fetch "$@"
