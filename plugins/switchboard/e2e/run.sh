#!/usr/bin/env bash
# 질문 경로 e2e(#157): 고정 판 switchboard 서버 릴리스(linux_amd64)를 받아 체크섬을 확인하고, 플러그인 코어를 그 서버에 붙여 돌린다.
# 시험이 MIN 개보다 적게 통과하면(이름을 바꿔 조용히 빠짐 등) 실패다.
#   bash plugins/switchboard/e2e/run.sh
# 받은 바이너리는 SWITCHBOARD_E2E_CACHE(없으면 RUNNER_TEMP·TMPDIR 아래)에 둔다. 이미 받은 바이너리를 쓰려면 SWITCHBOARD_E2E_BIN.
set -euo pipefail

# 서버 판을 올릴 때는 VERSION 과 SHA256(그 판 checksums.txt 의 linux_amd64 줄)을 함께 바꾼다.
VERSION=v0.11.0
SHA256=b2bc3eaf2c877e34e716eb410cfc23c31d88d89036de674fb9b2c64d7a8899a2
REPO=sandcorporation/switchboard
TSX=tsx@4.23.15
MIN=7

here=$(cd "$(dirname "$0")" && pwd)

bin=${SWITCHBOARD_E2E_BIN:-}
if [ -z "$bin" ]; then
  if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
    echo "question source of truth: e2e 는 linux_amd64 서버 릴리스만 받는다(지금 $(uname -s)-$(uname -m)). SWITCHBOARD_E2E_BIN 으로 바이너리를 준다" >&2
    exit 1
  fi
  cache=${SWITCHBOARD_E2E_CACHE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/switchboard-e2e-$VERSION}
  bin=$cache/switchboard
  if [ ! -x "$bin" ]; then
    mkdir -p "$cache"
    tar_name=switchboard_${VERSION}_linux_amd64.tar.gz
    url=https://github.com/$REPO/releases/download/$VERSION
    curl -fsSL --retry 3 -o "$cache/$tar_name" "$url/$tar_name"
    curl -fsSL --retry 3 -o "$cache/checksums.txt" "$url/checksums.txt"
    # 고정한 해시와 릴리스의 checksums.txt 둘 다 맞아야 한다.
    echo "$SHA256  $cache/$tar_name" | sha256sum -c -
    grep -qx "$SHA256  $tar_name" "$cache/checksums.txt" || { echo "checksums.txt 의 $tar_name 줄이 고정한 해시와 다르다" >&2; exit 1; }
    tar -xzf "$cache/$tar_name" -C "$cache" switchboard
  fi
fi
"$bin" version

tap=$(mktemp)
status=0
SWITCHBOARD_E2E_BIN=$bin npx -y "$TSX" --test --test-force-exit \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=tap --test-reporter-destination="$tap" \
  "$here"/*.e2e.ts || status=$?

pass=$(sed -n 's/^# pass \([0-9]*\)$/\1/p' "$tap" | tail -n 1)
skipped=$(sed -n 's/^# skipped \([0-9]*\)$/\1/p' "$tap" | tail -n 1)
echo "e2e: pass ${pass:-0}, skipped ${skipped:-0} (최소 $MIN)"
if [ "$status" -ne 0 ]; then exit "$status"; fi
if [ "${pass:-0}" -lt "$MIN" ]; then
  echo "question source of truth: e2e 가 ${pass:-0}개만 통과했다(최소 $MIN개)" >&2
  exit 1
fi
