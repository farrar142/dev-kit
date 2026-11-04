"""wait-ci.py·wait-deploy.py가 함께 쓰는 Jenkins 도우미. 자격·토큰은 어디에도 출력하지 않는다."""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request


def _settings_env(key_pairs, start=None):
    """작업 폴더나 그 위 폴더의 .claude/settings.local.json env에서 키를 찾는다."""
    d = start or os.getcwd()
    while True:
        p = os.path.join(d, ".claude", "settings.local.json")
        if os.path.exists(p):
            try:
                env = json.load(open(p)).get("env", {})
                if all(env.get(k) for k in key_pairs):
                    return {k: env[k] for k in key_pairs}
            except Exception:
                pass
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up


def jenkins_auth():
    """(user, token) 또는 None. 환경변수 JENKINS_USER·JENKINS_TOKEN → settings.local.json env."""
    u, t = os.environ.get("JENKINS_USER"), os.environ.get("JENKINS_TOKEN")
    if u and t:
        return u, t
    env = _settings_env(["JENKINS_USER", "JENKINS_TOKEN"])
    return (env["JENKINS_USER"], env["JENKINS_TOKEN"]) if env else None


def jenkins_base_url(hint_url=""):
    """Jenkins 기본 URL(끝 슬래시 없음) 또는 None.

    환경변수 JENKINS_URL → settings.local.json env → hint_url(예: PR 커밋 상태의 빌드 링크)에서
    `/job/`보다 앞 부분을 잘라 낸다.
    """
    u = os.environ.get("JENKINS_URL")
    if not u:
        env = _settings_env(["JENKINS_URL"])
        u = env["JENKINS_URL"] if env else None
    if u:
        return u.rstrip("/")
    m = re.match(r"(https?://[^?#]*?)/job/", hint_url or "")
    return m.group(1) if m else None


class JenkinsUnavailable(Exception):
    """Jenkins가 401·403을 냈거나 연결되지 않는다. 자격이 환경에 남아 있어도(토큰을 폐기한 뒤 남은 옛 값 등) 자격 없음과 같이 다룬다."""


def jenkins_get(url, timeout=30):
    """인증을 붙여 GET하고 본문 문자열을 돌려준다. 401·403·연결 실패는 JenkinsUnavailable, 그 밖의 HTTP 오류는 그대로."""
    req = urllib.request.Request(url)
    auth = jenkins_auth()
    if auth:
        req.add_header("Authorization", "Basic " + base64.b64encode(f"{auth[0]}:{auth[1]}".encode()).decode())
    try:
        return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise JenkinsUnavailable(f"HTTP {e.code}") from e
        raise
    except OSError as e:  # URLError·시간 초과·연결 거부
        raise JenkinsUnavailable(type(e).__name__) from e


def warn_fallback(reason):
    """Jenkins를 못 써서 GitHub(gh) 길로 넘어갈 때 한 줄 경고(표준 오류). 자격 값은 찍지 않는다."""
    print(f"경고: Jenkins를 못 쓴다({reason}) — 자격 없음과 같이 GitHub(gh)로 본다", file=sys.stderr)


_PAT = re.compile(r"FAILED|ERROR |Error:|error:|예산|AssertionError|failed,|passed|Traceback|exit code")


def console_excerpt(base_url):
    """빌드 URL의 콘솔에서 실패 줄만 뽑는다(없으면 끝 25줄). 401·403·연결 실패는 JenkinsUnavailable로 올린다."""
    base = re.sub(r"/display/redirect/?$", "", base_url).rstrip("/")
    try:
        text = jenkins_get(base + "/consoleText")
    except JenkinsUnavailable:
        raise
    except Exception as e:
        return f"(Jenkins 콘솔을 못 읽음: {type(e).__name__}) {base}/consoleText"
    lines = [l for l in text.splitlines() if _PAT.search(l)]
    return "\n".join(lines[-25:]) or "\n".join(text.splitlines()[-25:])


# GitHub 대체 길에서 쓰는 이름들. CI 쪽(PR 검사·배포 잡)이 쓰는 이름과 맞아야 하므로 환경변수로 바꾼다.
# 스크립트 인자(--status-context·--comment-prefix)가 있으면 그것이 이긴다.
SETTINGS = {
    # wait-deploy.py: 배포 잡이 커밋에 다는 GitHub 커밋 상태의 context 이름
    "ISSUE_TRACK_DEPLOY_CONTEXT": "deploy",
    # wait-deploy.py: 배포 실패 PR 댓글의 첫 줄 표지
    "ISSUE_TRACK_DEPLOY_COMMENT_PREFIX": "배포 실패 — ",
    # wait-ci.py: PR 검사 실패 PR 댓글의 첫 줄 표지
    "ISSUE_TRACK_PR_COMMENT_PREFIX": "PR 검사 실패 — ",
}


def setting(key):
    """환경변수 값, 없거나 비었으면 SETTINGS의 기본값."""
    return os.environ.get(key) or SETTINGS[key]


def gh(*args):
    """gh를 돌려 표준 출력을 돌려준다. 실패하면 RuntimeError."""
    import subprocess

    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return r.stdout


def deploy_state(repo, sha, context):
    """그 커밋의 커밋 상태 중 context가 맞는 최신 것 {state, description} 또는 None."""
    d = json.loads(gh("api", f"repos/{repo}/commits/{sha}/status"))
    return next(({"state": s.get("state"), "description": s.get("description") or ""}
                 for s in d.get("statuses") or [] if s.get("context") == context), None)
