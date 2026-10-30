#!/usr/bin/env python3
"""PR의 CI 결과가 날 때까지 조용히 기다리고, 끝나면 한 번만 말한다.

    wait-ci.py <PR 번호> [--repo owner/name] [--timeout 분] [--interval 초] [--no-checks-wait 분]

- PR head 커밋 하나만 본다. push하면 head가 바뀌므로 그 커밋의 결과를 새로 기다린다.
  옛 커밋의 빨강을 새 결과로 읽지 않는다.
- 상태(commit statuses: Jenkins 등)와 check-runs(GitHub Actions)를 함께 본다.
- 끝나는 경우와 종료 코드:
  - 0 SUCCESS: 모든 검사가 초록이다.
  - 1 FAILURE: 하나라도 빨강이다. 실패 줄을 덧붙인다.
  - 2 MERGED/CLOSED: PR이 이미 닫혔다.
  - 3 TIMEOUT: 제한 시간이 지났다.
  - 4 GONE: PR을 조회하지 못한다.
  - 5 NO_CHECKS: 검사가 하나도 없는 상태가 --no-checks-wait 분(기본 3) 이어졌다. PR에 CI가 붙지
    않는 저장소(예: Jenkins가 main 병합 뒤에만 도는 곳)다. 병합 뒤 배포는 wait-deploy.py로 본다.
- 빨강일 때 Jenkins면 콘솔에서 FAILED·Error·예산 줄만 뽑는다. 자격은 다음 차례로 찾는다.
  1. 환경변수 JENKINS_USER와 JENKINS_TOKEN
  2. 작업 폴더나 그 위 폴더의 .claude/settings.local.json에 있는 env
  (찾는 코드는 ci_common.py, wait-deploy.py와 공유)
  Actions면 `gh run view --log-failed`의 끝부분을 쓴다.

배경으로 돌린다. 작업자는 Bash run_in_background, 조율자도 같다. 끝나면 부른 쪽이 깨어난다.
돌고 있는 동안에는 아무것도 찍지 않는다.
"""
import argparse
import json
import re
import subprocess
import sys
import time

from ci_common import console_excerpt

FAIL = {"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "failure", "error"}
OK = {"SUCCESS", "NEUTRAL", "SKIPPED", "success"}


def gh(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return r.stdout


def pr_state(pr, repo):
    q = ["pr", "view", str(pr), "--json", "state,headRefOid,statusCheckRollup"]
    if repo:
        q += ["--repo", repo]
    d = json.loads(gh(*q))
    checks = []
    for c in d.get("statusCheckRollup") or []:
        name = c.get("context") or c.get("name") or "?"
        if c.get("__typename") == "StatusContext" or "context" in c:
            st = c.get("state") or "PENDING"
        else:
            st = c.get("conclusion") or c.get("status") or "PENDING"
        checks.append((name, st.upper(), c.get("targetUrl") or c.get("detailsUrl") or ""))
    return d["state"], d["headRefOid"], checks


def jenkins_excerpt(url):
    return console_excerpt(url)


def actions_excerpt(url):
    m = re.search(r"/runs/(\d+)", url)
    if not m:
        return url
    try:
        out = gh("run", "view", m.group(1), "--log-failed")
    except Exception as e:
        return f"(Actions 로그를 못 읽음: {e}) {url}"
    return "\n".join(out.splitlines()[-30:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pr")
    ap.add_argument("--repo")
    ap.add_argument("--timeout", type=float, default=40, help="분")
    ap.add_argument("--interval", type=float, default=45, help="초")
    ap.add_argument("--no-checks-wait", type=float, default=3, help="검사가 하나도 없는 채로 이만큼(분) 지나면 NO_CHECKS로 끝낸다")
    a = ap.parse_args()

    deadline = time.time() + a.timeout * 60
    errors = 0
    empty_since = None
    last = ""
    while True:
        try:
            state, sha, checks = pr_state(a.pr, a.repo)
            errors = 0
        except Exception as e:
            errors += 1
            if errors >= 5:
                print(f"GONE PR #{a.pr}: {e}")
                return 4
            time.sleep(a.interval)
            continue
        short = sha[:7]
        summary = ",".join(f"{n}={s}" for n, s, _ in checks) or "(검사 없음)"
        last = f"{short} {summary}"
        if state in ("MERGED", "CLOSED"):
            print(f"{state} PR #{a.pr} {last}")
            return 2
        if checks:
            failed = [c for c in checks if c[1] in FAIL]
            if failed:
                print(f"FAILURE PR #{a.pr} {last}")
                for name, st, url in failed:
                    print(f"--- {name} {st} {url}")
                    if "jenkins" in url.lower() or "/job/" in url:
                        print(jenkins_excerpt(url))
                    elif "github.com" in url and "/actions/" in url:
                        print(actions_excerpt(url))
                return 1
            if all(c[1] in OK for c in checks):
                print(f"SUCCESS PR #{a.pr} {last}")
                return 0
        if checks:
            empty_since = None
        else:
            empty_since = empty_since or time.time()
            if time.time() - empty_since >= a.no_checks_wait * 60:
                print(f"NO_CHECKS PR #{a.pr} {last} — 이 PR에는 CI 검사가 없다. 배포가 병합 뒤에 도는 저장소면 wait-deploy.py를 쓴다")
                return 5
        if time.time() > deadline:
            print(f"TIMEOUT PR #{a.pr} {last} — 고치지 말고 「CI 멈춤」으로 보고한다")
            return 3
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
