#!/usr/bin/env python3
"""PR의 CI 결과가 날 때까지 조용히 기다리고, 끝나면 한 번만 말한다.

    wait-ci.py <PR 번호> [--repo owner/name] [--timeout 분] [--interval 초] [--no-checks-wait 분]

병합 대기열(merge queue)을 쓰는 저장소: PR이 대기열에 있으면(GraphQL mergeQueueEntry) 검사가 초록이어도
SUCCESS로 끝내지 않고 병합(MERGED, 종료 코드 2)이나 대기열 이탈(DEQUEUED)까지 기다린다.
대기열이 없는 저장소의 동작은 그대로다.

기본 CI는 GitHub Actions PR 검사다(병합 뒤 release workflow와 배포는 wait-deploy.py가 본다).

- PR head 커밋 하나만 본다. push하면 head가 바뀌므로 그 커밋의 결과를 새로 기다린다.
  옛 커밋의 빨강을 새 결과로 읽지 않는다.
- check-runs(GitHub Actions)와 상태(commit statuses: Jenkins 등 외부 CI)를 함께 본다.
- 끝나는 경우와 종료 코드:
  - 0 SUCCESS: 모든 검사가 초록이다.
  - 1 FAILURE: 하나라도 빨강이다. 실패 줄을 덧붙인다.
  - 2 MERGED/CLOSED: PR이 이미 닫혔다.
  - 3 TIMEOUT: 제한 시간이 지났다.
  - 4 GONE: PR을 조회하지 못한다.
  - 6 DEQUEUED: 병합 대기열에 있던 PR이 병합되지 않고 대기열에서 빠졌고 아직 OPEN이다(대기열 실행 실패 등).
    실패와 구분되는 끝이다. 대기열 실행(merge_group 이벤트)의 실패 잡·로그 끝을 찾으면 덧붙인다.
    줄을 읽고 고쳐 push한 뒤 다시 대기열에 넣고 같은 명령으로 다시 기다린다.
  - 5 NO_CHECKS: 검사가 하나도 없는 상태가 --no-checks-wait 분(기본 3) 이어졌다. PR에 CI가 붙지
    않는 저장소다. 병합 뒤 배포는 wait-deploy.py로 본다.
- 빨강일 때 실패 요지를 덧붙인다.
  - Actions면 `gh run view --log-failed`의 끝부분을 쓴다(찾는 코드는 ci_common.py의 actions_excerpt).
  - Jenkins 같은 외부 CI 상태가 빨강이면(그런 CI를 쓰는 저장소용):
    - Jenkins 자격이 있으면 콘솔에서 FAILED·Error·예산 줄만 뽑는다. 자격은 다음 차례로 찾는다.
      1. 환경변수 JENKINS_USER와 JENKINS_TOKEN
      2. 작업 폴더나 그 위 폴더의 .claude/settings.local.json에 있는 env
      (찾는 코드는 ci_common.py, wait-deploy.py와 공유)
    - 자격이 없으면 PR 댓글에서 읽는다. PR 검사 잡이 실패할 때 첫 줄이 `<표지><단계> · <head 12자> · …`인
      댓글을 단다고 본다(표지 기본값 `PR 검사 실패 — `, 바꾸려면 --comment-prefix 또는 환경변수
      ISSUE_TRACK_PR_COMMENT_PREFIX). 첫 줄에 그 head SHA 앞 12자가 있는 가장 최근 댓글 본문을 출력한다.
      댓글은 빌드 끝에 붙으니 최대 60초(--comment-wait) 기다린다. 못 찾으면 그렇다고 적고 빌드 링크만 남긴다.
      그런 댓글을 달지 않는 CI면 이 길은 「댓글 없음」으로 끝난다.
    - 자격이 있어도 Jenkins가 401·403을 내거나 연결되지 않으면(토큰을 폐기한 뒤 환경에 남은 옛 값 등)
      표준 오류에 경고 한 줄을 찍고 자격 없음과 같이 PR 댓글에서 읽는다.

배경으로 돌린다. 작업자는 Bash run_in_background, 조율자도 같다. 끝나면 부른 쪽이 깨어난다.
돌고 있는 동안에는 아무것도 찍지 않는다.
"""
import argparse
import json
import re
import subprocess
import sys
import time

from ci_common import JenkinsUnavailable, actions_excerpt, console_excerpt, jenkins_auth, setting, warn_fallback

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


QUEUE_QUERY = "query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){mergeQueueEntry{state position}}}}"


def queue_entry(pr, repo):
    """PR의 병합 대기열 항목(`mergeQueueEntry`)을 dict로. 대기열에 없으면 None. 대기열 없는 저장소·조회 실패도 None."""
    try:
        name = repo or gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").strip()
        owner, _, n = name.partition("/")
        d = json.loads(gh("api", "graphql", "-f", f"query={QUEUE_QUERY}", "-F", f"o={owner}", "-F", f"n={n}", "-F", f"pr={pr}"))
        return d["data"]["repository"]["pullRequest"]["mergeQueueEntry"] or None
    except Exception:
        return None


def queue_failure(pr, repo):
    """그 PR의 대기열 실행(merge_group)에서 가장 최근 실패한 실행의 실패 잡·로그 끝. 못 찾으면 None."""
    try:
        q = ["run", "list", "--event", "merge_group", "--limit", "30", "--json", "databaseId,headBranch,conclusion,url,name"]
        if repo:
            q += ["--repo", repo]
        runs = json.loads(gh(*q))
    except Exception:
        return None
    for r in runs:  # 최신순
        if f"/pr-{pr}-" in (r.get("headBranch") or "") and (r.get("conclusion") or "") in ("failure", "cancelled", "timed_out", "startup_failure"):
            return f"--- 대기열 실행 {r.get('name') or '?'} {r.get('conclusion')} {r.get('url') or ''}\n" + actions_excerpt(r.get("url") or "")
    return None


def jenkins_excerpt(url):
    return console_excerpt(url)


def failure_comment(pr, repo, sha, prefix, wait_s=60, step_s=10):
    """그 head SHA에 대한 실패 댓글(첫 줄이 prefix로 시작) 본문(가장 최근 것). 없으면 wait_s초까지 다시 본다. 끝내 없으면 None."""
    q = ["pr", "view", str(pr), "--json", "comments"]
    if repo:
        q += ["--repo", repo]
    deadline = time.time() + wait_s
    while True:
        try:
            comments = json.loads(gh(*q)).get("comments") or []
        except Exception:
            comments = []
        for c in reversed(comments):
            body = c.get("body") or ""
            first = body.split("\n", 1)[0]
            if first.startswith(prefix) and sha[:12] in first:
                return body
        if time.time() >= deadline:
            return None
        time.sleep(step_s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pr")
    ap.add_argument("--repo")
    ap.add_argument("--timeout", type=float, default=40, help="분")
    ap.add_argument("--interval", type=float, default=45, help="초")
    ap.add_argument("--no-checks-wait", type=float, default=3, help="검사가 하나도 없는 채로 이만큼(분) 지나면 NO_CHECKS로 끝낸다")
    ap.add_argument("--comment-wait", type=float, default=60, help="Jenkins 자격이 없을 때 실패 댓글을 기다리는 시간(초)")
    ap.add_argument("--comment-prefix", help="실패 댓글 첫 줄 표지(기본: 환경변수 ISSUE_TRACK_PR_COMMENT_PREFIX, 없으면 「PR 검사 실패 — 」)")
    a = ap.parse_args()

    deadline = time.time() + a.timeout * 60
    errors = 0
    empty_since = None
    was_queued = False
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
        queued = queue_entry(a.pr, a.repo) is not None
        if was_queued and not queued:
            # 병합 직후 state와 대기열 조회가 어긋날 수 있다 — 잠시 뒤 다시 본다
            time.sleep(min(a.interval, 10))
            try:
                state, sha, checks = pr_state(a.pr, a.repo)
            except Exception:
                pass
            else:
                last = f"{sha[:7]} " + (",".join(f"{n}={s}" for n, s, _ in checks) or "(검사 없음)")
            if state in ("MERGED", "CLOSED"):
                print(f"{state} PR #{a.pr} {last}")
                return 2
            if queue_entry(a.pr, a.repo) is None:
                print(f"DEQUEUED PR #{a.pr} {last} — 병합 대기열에서 빠졌고 아직 OPEN이다. 실패 줄을 읽고 고쳐 push한 뒤 다시 대기열에 넣는다")
                print(queue_failure(a.pr, a.repo) or "(대기열 실행의 실패 기록을 찾지 못했다)")
                return 6
            queued = True
        if queued:
            was_queued = True
            empty_since = None
            if time.time() > deadline:
                print(f"TIMEOUT PR #{a.pr} {last} (병합 대기열) — 고치지 말고 「CI 멈춤」으로 보고한다")
                return 3
            time.sleep(a.interval)
            continue
        if checks:
            failed = [c for c in checks if c[1] in FAIL]
            if failed:
                print(f"FAILURE PR #{a.pr} {last}")
                for name, st, url in failed:
                    print(f"--- {name} {st} {url}")
                    if "jenkins" in url.lower() or "/job/" in url:
                        excerpt = None
                        if jenkins_auth():
                            try:
                                excerpt = jenkins_excerpt(url)
                            except JenkinsUnavailable as e:
                                warn_fallback(e)
                        if excerpt is not None:
                            print(excerpt)
                        else:
                            body = failure_comment(a.pr, a.repo, sha, a.comment_prefix or setting("ISSUE_TRACK_PR_COMMENT_PREFIX"), a.comment_wait)
                            print(body or f"(Jenkins 자격이 없고 {sha[:12]}의 실패 댓글도 {a.comment_wait:g}초 안에 없다) {url}")
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
