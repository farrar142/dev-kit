"""wait-ci.py·wait-deploy.py가 함께 쓰는 Jenkins 도우미. 자격·토큰은 어디에도 출력하지 않는다."""
import base64
import json
import os
import re
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


def jenkins_get(url, timeout=30):
    """인증을 붙여 GET하고 본문 문자열을 돌려준다."""
    req = urllib.request.Request(url)
    auth = jenkins_auth()
    if auth:
        req.add_header("Authorization", "Basic " + base64.b64encode(f"{auth[0]}:{auth[1]}".encode()).decode())
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "replace")


_PAT = re.compile(r"FAILED|ERROR |Error:|error:|예산|AssertionError|failed,|passed|Traceback|exit code")


def console_excerpt(base_url):
    """빌드 URL의 콘솔에서 실패 줄만 뽑는다(없으면 끝 25줄)."""
    base = re.sub(r"/display/redirect/?$", "", base_url).rstrip("/")
    try:
        text = jenkins_get(base + "/consoleText")
    except Exception as e:
        return f"(Jenkins 콘솔을 못 읽음: {type(e).__name__}) {base}/consoleText"
    lines = [l for l in text.splitlines() if _PAT.search(l)]
    return "\n".join(lines[-25:]) or "\n".join(text.splitlines()[-25:])
