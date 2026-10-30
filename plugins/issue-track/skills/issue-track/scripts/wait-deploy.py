#!/usr/bin/env python3
"""병합 뒤 Jenkins 배포 빌드가 끝날 때까지 조용히 기다리고, 끝나면 한 번만 말한다.

    wait-deploy.py --job <잡 이름> (--pr <번호> | --since <ISO 시각>) [--repo owner/name]
                   [--jenkins-url URL] [--start-timeout 분] [--timeout 분] [--interval 초]

- 기준 시각 뒤에 시작된 첫 빌드를 Jenkins JSON API로 찾아 그 빌드가 끝날 때까지 기다린다.
  기준 시각은 --pr의 mergedAt(병합 안 된 PR이면 GONE) 또는 --since(예 2026-10-30T01:02:03Z).
- 잡 이름이 폴더 안이면 `폴더/잡`으로 쓴다.
- 이 저장소처럼 Jenkins가 main 병합 뒤에만 돌고 커밋 상태를 GitHub에 올리지 않으면 PR에는
  검사가 없다(wait-ci.py가 NO_CHECKS로 끝난다). 그때 커밋 status를 폴링하지 말고 이 스크립트를 쓴다.
- Jenkins 기본 URL: --jenkins-url → 환경변수 JENKINS_URL → settings.local.json env. 자격은
  JENKINS_USER·JENKINS_TOKEN(같은 순서). 찾는 코드는 ci_common.py(wait-ci.py와 공유). 어느 값도 출력하지 않는다.
- 종료 코드:
  - 0 SUCCESS: 빌드가 SUCCESS로 끝났다.
  - 1 FAILURE: FAILURE·UNSTABLE·ABORTED 등. 콘솔에서 FAILED·Error 줄을 덧붙인다.
  - 3 TIMEOUT: 빌드는 시작됐지만 --timeout 분(기본 30) 안에 안 끝났다.
  - 4 GONE: PR·Jenkins를 조회하지 못하거나 PR이 아직 병합되지 않았다.
  - 5 NO_BUILD: 기준 시각 뒤 --start-timeout 분(기본 10) 안에 빌드가 생기지 않았다
    (웹훅 누락·잡 이름 오류일 수 있다 — 고치지 말고 보고한다).

배경으로 돌린다(Bash run_in_background). 돌고 있는 동안에는 아무것도 찍지 않는다.
"""
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote

from ci_common import console_excerpt, jenkins_base_url, jenkins_get

BAD_URL = "빌드 목록 조회 실패"


def gh(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return r.stdout


def merged_at(pr, repo):
    q = ["pr", "view", str(pr), "--json", "mergedAt,state,statusCheckRollup"]
    if repo:
        q += ["--repo", repo]
    d = json.loads(gh(*q))
    if not d.get("mergedAt"):
        raise RuntimeError(f"PR #{pr}은 아직 병합되지 않았다(state={d.get('state')})")
    hint = next((c.get("targetUrl") or "" for c in d.get("statusCheckRollup") or [] if "/job/" in (c.get("targetUrl") or "")), "")
    return d["mergedAt"], hint


def to_ms(iso):
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp() * 1000)


def job_path(job):
    return "/".join("job/" + quote(p) for p in job.strip("/").split("/"))


def list_builds(base, job):
    url = f"{base}/{job_path(job)}/api/json?tree=builds[number,timestamp,building,result,url]{{0,30}}"
    return json.loads(jenkins_get(url)).get("builds", [])


def first_build_after(builds, since_ms):
    after = [b for b in builds if b["timestamp"] >= since_ms]
    return min(after, key=lambda b: b["number"]) if after else None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--pr")
    ap.add_argument("--since")
    ap.add_argument("--repo")
    ap.add_argument("--jenkins-url")
    ap.add_argument("--start-timeout", type=float, default=10, help="분: 이 안에 빌드가 안 생기면 NO_BUILD")
    ap.add_argument("--timeout", type=float, default=30, help="분: 빌드가 시작된 뒤 끝나기까지")
    ap.add_argument("--interval", type=float, default=20, help="초")
    a = ap.parse_args(argv)
    if bool(a.pr) == bool(a.since):
        ap.error("--pr 또는 --since 중 하나만 준다")

    hint = ""
    try:
        if a.pr:
            since_iso, hint = merged_at(a.pr, a.repo)
        else:
            since_iso = a.since
        since_ms = to_ms(since_iso)
    except Exception as e:
        print(f"GONE {a.job}: {e}")
        return 4
    base = (a.jenkins_url or "").rstrip("/") or jenkins_base_url(hint)
    if not base:
        print("GONE Jenkins 기본 URL을 모른다 — --jenkins-url 또는 환경변수 JENKINS_URL")
        return 4

    start_deadline = time.time() + a.start_timeout * 60
    deadline = None
    errors = 0
    build = None
    while True:
        try:
            build = first_build_after(list_builds(base, a.job), since_ms)
            errors = 0
        except Exception as e:
            errors += 1
            if errors >= 5:
                print(f"GONE {a.job}: {BAD_URL} ({type(e).__name__})")
                return 4
            time.sleep(a.interval)
            continue
        if build:
            deadline = deadline or time.time() + a.timeout * 60
            if not build.get("building") and build.get("result"):
                res = build["result"]
                line = f"{res} {a.job} #{build['number']} {build['url']}"
                if res == "SUCCESS":
                    print(line)
                    return 0
                print("FAILURE " + line)
                print(console_excerpt(build["url"]))
                return 1
            if time.time() > deadline:
                print(f"TIMEOUT {a.job} #{build['number']} {build['url']} — 고치지 말고 「배포 멈춤」으로 보고한다")
                return 3
        elif time.time() > start_deadline:
            print(f"NO_BUILD {a.job}: {since_iso} 뒤 {a.start_timeout:g}분 안에 빌드가 생기지 않았다 — 고치지 말고 보고한다")
            return 5
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
