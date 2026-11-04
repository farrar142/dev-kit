#!/usr/bin/env python3
"""병합 뒤 Jenkins 배포 빌드가 끝날 때까지 조용히 기다리고, 끝나면 한 번만 말한다.

    wait-deploy.py --job <잡 이름> (--pr <번호> | --since <ISO 시각>) [--repo owner/name]
                   [--jenkins-url URL] [--start-timeout 분] [--timeout 분] [--interval 초]
                   [--status-context 이름] [--comment-prefix 표지]

두 길이 있다. 고르는 규칙: Jenkins 자격(JENKINS_USER·JENKINS_TOKEN)이 있으면 Jenkins 길, 없으면 GitHub 길.
자격이 있어도 Jenkins가 401·403을 내거나 연결되지 않거나 기본 URL을 모르면(토큰을 폐기한 뒤 환경에 남은 옛 값 등)
표준 오류에 경고 한 줄을 찍고 --pr이 있으면 GitHub 길로 간다(--since뿐이면 GONE).

Jenkins 길(자격이 있을 때):
- 기준 시각 뒤에 시작된 첫 빌드를 Jenkins JSON API로 찾아 그 빌드가 끝날 때까지 기다린다.
  기준 시각은 --pr의 mergedAt(병합 안 된 PR이면 GONE) 또는 --since(예 2026-10-30T01:02:03Z).
- 잡 이름이 폴더 안이면 `폴더/잡`으로 쓴다.
- Jenkins 기본 URL: --jenkins-url → 환경변수 JENKINS_URL → settings.local.json env. 자격은
  JENKINS_USER·JENKINS_TOKEN(같은 순서). 찾는 코드는 ci_common.py(wait-ci.py와 공유). 어느 값도 출력하지 않는다.

GitHub 길(자격이 없을 때 — 작업자 기계에 Jenkins 키를 두지 않는 경우):
- 배포 잡이 기준 브랜치 커밋에 다는 GitHub 커밋 상태(시작 pending, 끝 success|failure)를
  `gh api repos/<o>/<r>/commits/<sha>/status`로 기다린다. --job은 받되 쓰지 않는다. --since만으로는 못 간다(GONE).
- 커밋 상태 이름(context): --status-context → 환경변수 ISSUE_TRACK_DEPLOY_CONTEXT → 기본 `deploy`.
  배포 잡이 그 이름으로 상태를 달아야 이 길이 동작한다(안 달면 NO_BUILD).
- 어느 커밋을 보나: PR의 병합 커밋 M에 그 상태가 있으면 M. 없으면 한 push에 PR 여러 개가 묶였거나
  M을 배포하기 전에 main이 더 움직여 **뒤 커밋이 배포된** 경우다 — 배포 잡은 늘 그때의 main 끝을 배포하고 그
  커밋에만 상태를 단다. 그래서 `compare/M...<기준 브랜치>`의 커밋을 오래된 것부터 보고 그 상태가 있는
  첫 커밋 D를 M의 배포로 친다(D는 M을 포함한다). 그 상태가 끝나기를 기다린다.
- 실패면 첫 줄이 「<표지>… · <배포 sha 12자> · …」인 PR 댓글 본문을 덧붙인다(그 PR, 없으면 D를 만든 PR).
  표지: --comment-prefix → 환경변수 ISSUE_TRACK_DEPLOY_COMMENT_PREFIX → 기본 `배포 실패 — `.
- 이 상태를 달기 전(라이브러리 반영 전)에 배포된 커밋은 상태가 없어 NO_BUILD로 끝난다.

종료 코드(두 길 같다):
  - 0 SUCCESS: 빌드가 SUCCESS로 끝났다.
  - 1 FAILURE: FAILURE·UNSTABLE·ABORTED 등. 콘솔(또는 PR 실패 댓글)에서 실패 줄을 덧붙인다.
  - 3 TIMEOUT: 빌드는 시작됐지만 --timeout 분(기본 30) 안에 안 끝났다.
  - 4 GONE: PR·Jenkins·GitHub를 조회하지 못하거나 PR이 아직 병합되지 않았다.
  - 5 NO_BUILD: 기준 시각 뒤 --start-timeout 분(기본 10) 안에 빌드(상태)가 생기지 않았다
    (웹훅 누락·잡 이름 오류일 수 있다 — 고치지 말고 보고한다).

배경으로 돌린다(Bash run_in_background). 돌고 있는 동안에는 아무것도 찍지 않는다.
"""
import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote

from ci_common import (JenkinsUnavailable, console_excerpt, deploy_state, gh, jenkins_auth, jenkins_base_url, jenkins_get, setting,
                       warn_fallback)

BAD_URL = "빌드 목록 조회 실패"
DESCENDANTS = 30  # GitHub 길: M 뒤에서 상태를 찾아볼 커밋 수


def pr_info(pr, repo):
    q = ["pr", "view", str(pr), "--json", "mergedAt,state,statusCheckRollup,mergeCommit,baseRefName,url"]
    if repo:
        q += ["--repo", repo]
    d = json.loads(gh(*q))
    if not d.get("mergedAt"):
        raise RuntimeError(f"PR #{pr}은 아직 병합되지 않았다(state={d.get('state')})")
    return d


def merged_at(pr, repo):
    d = pr_info(pr, repo)
    hint = next((c.get("targetUrl") or "" for c in d.get("statusCheckRollup") or [] if "/job/" in (c.get("targetUrl") or "")), "")
    return d["mergedAt"], hint


def repo_of(d, repo):
    if repo:
        return repo
    m = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/", d.get("url") or "")
    if not m:
        raise RuntimeError(f"PR URL에서 저장소를 모른다: {d.get('url')}")
    return m.group(1)


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


# ---------------------------------------------------------------- GitHub 길


def deployed_commit(repo, merge_sha, base, context):
    """(배포를 맡은 커밋 sha, 상태) 또는 (None, None). 규칙은 맨 위 docstring 「어느 커밋을 보나」."""
    st = deploy_state(repo, merge_sha, context)
    if st:
        return merge_sha, st
    cmp = json.loads(gh("api", f"repos/{repo}/compare/{merge_sha}...{base}"))
    for c in (cmp.get("commits") or [])[:DESCENDANTS]:
        st = deploy_state(repo, c["sha"], context)
        if st:
            return c["sha"], st
    return None, None


def failure_comment(repo, prs, sha, prefix):
    """PR들에서 그 배포 sha의 실패 댓글(첫 줄이 prefix로 시작) 본문(최신)을 찾는다."""
    for n in prs:
        try:
            d = json.loads(gh("pr", "view", str(n), "--repo", repo, "--json", "comments"))
        except Exception:
            continue
        hits = [c.get("body") or "" for c in d.get("comments") or []
                if (c.get("body") or "").startswith(prefix) and sha[:12] in (c.get("body") or "").split("\n", 1)[0]]
        if hits:
            return hits[-1]
    return ""


def prs_of(repo, sha):
    try:
        return [p["number"] for p in json.loads(gh("api", f"repos/{repo}/commits/{sha}/pulls")) if p.get("merged_at")]
    except Exception:
        return []


def build_no(description):
    m = re.search(r"빌드 #(\d+)", description or "")
    return f"#{m.group(1)}" if m else "#?"


def wait_github(a, pr):
    try:
        d = pr_info(pr, a.repo)
        repo = repo_of(d, a.repo)
        merge_sha = (d.get("mergeCommit") or {}).get("oid")
        if not merge_sha:
            raise RuntimeError(f"PR #{pr}의 병합 커밋을 모른다")
        base = d.get("baseRefName") or "main"
    except Exception as e:
        print(f"GONE {a.job}: {e}")
        return 4
    name = f"{repo} {a.status_context}"
    start_deadline = time.time() + a.start_timeout * 60
    deadline = None
    errors = 0
    while True:
        try:
            sha, st = deployed_commit(repo, merge_sha, base, a.status_context)
            errors = 0
        except Exception as e:
            errors += 1
            if errors >= 5:
                print(f"GONE {a.job}: GitHub 커밋 상태 조회 실패 ({type(e).__name__}: {e})")
                return 4
            time.sleep(a.interval)
            continue
        if st:
            deadline = deadline or time.time() + a.timeout * 60
            via = "" if sha == merge_sha else f" (PR #{pr} 병합 커밋 {merge_sha[:12]} 뒤 커밋이 배포됨)"
            line = f"{name} {build_no(st['description'])} {sha[:12]} — {st['description']}{via}"
            if st["state"] == "success":
                print("SUCCESS " + line)
                return 0
            if st["state"] in ("failure", "error"):
                print("FAILURE " + line)
                prs = [int(pr)] + [n for n in prs_of(repo, sha) if n != int(pr)]
                print(failure_comment(repo, prs, sha, a.comment_prefix) or "(배포 실패 댓글 없음 — PR을 못 찾았거나 댓글을 못 달았다)")
                return 1
            if time.time() > deadline:
                print(f"TIMEOUT {line} — 고치지 말고 「배포 멈춤」으로 보고한다")
                return 3
        elif time.time() > start_deadline:
            print(f"NO_BUILD {name}: PR #{pr} 병합 커밋 {merge_sha[:12]}(과 뒤 커밋)에 {a.start_timeout:g}분 안에 배포 상태가 생기지 않았다 — 고치지 말고 보고한다")
            return 5
        time.sleep(a.interval)


# ---------------------------------------------------------------- main


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
    ap.add_argument("--status-context", help="GitHub 길: 배포 커밋 상태 이름(기본: 환경변수 ISSUE_TRACK_DEPLOY_CONTEXT, 없으면 deploy)")
    ap.add_argument("--comment-prefix", help="GitHub 길: 배포 실패 댓글 첫 줄 표지(기본: 환경변수 ISSUE_TRACK_DEPLOY_COMMENT_PREFIX)")
    a = ap.parse_args(argv)
    if bool(a.pr) == bool(a.since):
        ap.error("--pr 또는 --since 중 하나만 준다")
    a.status_context = a.status_context or setting("ISSUE_TRACK_DEPLOY_CONTEXT")
    a.comment_prefix = a.comment_prefix or setting("ISSUE_TRACK_DEPLOY_COMMENT_PREFIX")

    if not jenkins_auth():
        if not a.pr:
            print(f"GONE {a.job}: Jenkins 자격이 없다 — 자격 없이는 --pr로 GitHub 커밋 상태({a.status_context})를 본다")
            return 4
        return wait_github(a, a.pr)

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
        if a.pr:
            warn_fallback("기본 URL을 모른다")
            return wait_github(a, a.pr)
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
        except JenkinsUnavailable as e:
            if a.pr:
                warn_fallback(e)
                return wait_github(a, a.pr)
            print(f"GONE {a.job}: Jenkins를 못 쓴다({e}) — --pr로 GitHub 커밋 상태({a.status_context})를 본다")
            return 4
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
                try:
                    print(console_excerpt(build["url"]))
                except JenkinsUnavailable as e:
                    print(f"(Jenkins 콘솔을 못 읽음: {e}) {build['url']}")
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
