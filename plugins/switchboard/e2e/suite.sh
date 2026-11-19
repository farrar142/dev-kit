#!/usr/bin/env bash
# switchboard 기존 시험을 돌리고, 돈 시험 수가 0이면 실패로 친다(#157).
#   bash plugins/switchboard/e2e/suite.sh mod   # claude plugin test(코어·어댑터·hooks/register.test.tsx)
#   bash plugins/switchboard/e2e/suite.sh mcp   # node --test plugins/switchboard/mcp
# mod 는 질문 경로 경우 7(좁은 폭에서 패널이 자리를 못 잡으면 질문 첫 줄 토스트)이 hooks/register.test.tsx 의
# 「좁은 터미널(#136)」 시험으로 돌았는지도 센다.
set -euo pipefail

root=$(cd "$(dirname "$0")/../../.." && pwd)
plugin=$root/plugins/switchboard
out=$(mktemp)
status=0

case "${1:-}" in
  mod)
    claude plugin test "$plugin" >"$out" 2>&1 || status=$?
    tail -n 5 "$out"
    grep -E '^\(fail\)' -A3 "$out" || true
    pass=$(sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' "$out" | tail -n 1)
    narrow=$(grep -c '^(pass) 좁은 터미널(#136)' "$out" || true)
    if [ "$status" -ne 0 ]; then exit "$status"; fi
    if [ "${pass:-0}" -eq 0 ]; then echo "mod 시험이 하나도 돌지 않았다" >&2; exit 1; fi
    if [ "$narrow" -eq 0 ]; then echo "question source of truth: 경우 7(좁은 터미널 토스트, hooks/register.test.tsx)이 돌지 않았다" >&2; exit 1; fi
    echo "mod: pass $pass, 좁은 터미널(#136) $narrow"
    ;;
  mcp)
    node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination="$out" "$plugin"/mcp/*.test.mjs || status=$?
    pass=$(sed -n 's/^# pass \([0-9]*\)$/\1/p' "$out" | tail -n 1)
    if [ "$status" -ne 0 ]; then exit "$status"; fi
    if [ "${pass:-0}" -eq 0 ]; then echo "mcp 시험이 하나도 돌지 않았다" >&2; exit 1; fi
    echo "mcp: pass $pass"
    ;;
  *)
    echo "쓰는 법: $0 mod|mcp" >&2
    exit 2
    ;;
esac
