"""wait-ci.py·wait-deploy.py 종료 코드별 단위 시험. gh·Jenkins 호출과 시계를 가짜로 바꾼다.

    python3 -m unittest discover -s plugins/issue-track/skills/issue-track/tests
"""
import importlib.util
import json
import os
import sys
import unittest
from unittest import mock

SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "scripts")
sys.path.insert(0, SCRIPTS)


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), os.path.join(SCRIPTS, name + ".py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# 시험이 돌리는 셸의 설정이 기본값 시험을 흔들지 않게 한다.
for _k in [k for k in os.environ if k.startswith("ISSUE_TRACK_")]:
    del os.environ[_k]

wait_ci = load("wait-ci")
wait_deploy = load("wait-deploy")
ci_common = load("ci_common")


class Clock:
    """sleep이 가짜 시간을 앞으로 보내는 시계."""

    def __init__(self):
        self.t = 1000.0

    def time(self):
        return self.t

    def sleep(self, s):
        self.t += s


def pr_json(state="OPEN", checks=()):
    return json.dumps({"state": state, "headRefOid": "abcdef1234", "statusCheckRollup": list(checks)})


def status(name, state, url="https://j.example/job/x/3/"):
    return {"__typename": "StatusContext", "context": name, "state": state, "targetUrl": url}


class WaitCi(unittest.TestCase):
    def run_ci(self, outputs, args=(), auth=("u", "t")):
        clock = Clock()
        it = iter(outputs)
        last = [None]

        def fake_gh(*a):
            try:
                last[0] = next(it)
            except StopIteration:
                pass
            return last[0]

        with mock.patch.object(wait_ci, "gh", fake_gh), mock.patch.object(wait_ci, "time", clock), \
                mock.patch.object(wait_ci, "jenkins_excerpt", lambda u: "FAILED line"), \
                mock.patch.object(wait_ci, "jenkins_auth", lambda: auth), \
                mock.patch("builtins.print") as pr:
            code = self._main(["1", *args])
        return code, "\n".join(str(c.args[0]) for c in pr.call_args_list)

    def _main(self, argv):
        with mock.patch.object(sys, "argv", ["wait-ci.py", *argv]):
            return wait_ci.main()

    def test_success(self):
        code, out = self.run_ci([pr_json(checks=[status("jenkins", "SUCCESS")])])
        self.assertEqual(code, 0)
        self.assertIn("SUCCESS", out)

    def test_failure_appends_excerpt(self):
        code, out = self.run_ci([pr_json(checks=[status("jenkins", "FAILURE")])])
        self.assertEqual(code, 1)
        self.assertIn("FAILED line", out)

    def test_failure_without_jenkins_auth_reads_pr_comment(self):
        body = "PR 검사 실패 — 검사 · abcdef1234 · node-a · 빌드 #3\n\n```\nE   assert 1 == 2\n```"
        old = {"body": "PR 검사 실패 — 검사 · 0000000000 · node-a · 빌드 #2\n옛 실패"}
        failing = pr_json(checks=[status("jenkins", "FAILURE")])
        # 첫 조회엔 댓글이 아직 없고(옛 head 것만), 다음 조회에 붙는다.
        code, out = self.run_ci([failing, json.dumps({"comments": [old]}), json.dumps({"comments": [old, {"body": body}]})], auth=None)
        self.assertEqual(code, 1)
        self.assertIn("E   assert 1 == 2", out)
        self.assertNotIn("옛 실패", out)
        self.assertNotIn("FAILED line", out)

    def test_stale_jenkins_auth_401_reads_pr_comment_with_one_warning(self):
        body = "PR 검사 실패 — 검사 · abcdef1234 · node-a · 빌드 #3\n\n```\nE   assert 1 == 2\n```"
        failing = pr_json(checks=[status("jenkins", "FAILURE")])

        def revoked(url):
            raise sys.modules["ci_common"].JenkinsUnavailable("HTTP 401")
        with mock.patch.object(wait_ci, "jenkins_excerpt", revoked):
            clock = Clock()
            outs = iter([failing, json.dumps({"comments": [{"body": body}]})])
            last = [None]

            def fake_gh(*a):
                try:
                    last[0] = next(outs)
                except StopIteration:
                    pass
                return last[0]
            with mock.patch.object(wait_ci, "gh", fake_gh), mock.patch.object(wait_ci, "time", clock), \
                    mock.patch.object(wait_ci, "jenkins_auth", lambda: ("u", "old")), mock.patch("builtins.print") as pr:
                code = self._main(["1"])
        out = "\n".join(str(c.args[0]) for c in pr.call_args_list)
        warns = [c for c in pr.call_args_list if c.kwargs.get("file") is sys.stderr]
        self.assertEqual(code, 1)
        self.assertIn("E   assert 1 == 2", out)
        self.assertEqual(len(warns), 1)
        self.assertIn("HTTP 401", str(warns[0].args[0]))

    def test_comment_prefix_from_env_then_argument(self):
        body = "CI failed: check · abcdef1234 · node-a · build #3\n\nE   boom"
        failing = pr_json(checks=[status("jenkins", "FAILURE")])
        outputs = [failing, json.dumps({"comments": [{"body": body}]})]
        code, out = self.run_ci(outputs, ["--comment-wait", "0"], auth=None)
        self.assertNotIn("E   boom", out)  # 기본 표지와 다르면 못 찾는다
        with mock.patch.dict(os.environ, {"ISSUE_TRACK_PR_COMMENT_PREFIX": "CI failed: "}):
            code, out = self.run_ci(outputs, auth=None)
        self.assertEqual(code, 1)
        self.assertIn("E   boom", out)
        with mock.patch.dict(os.environ, {"ISSUE_TRACK_PR_COMMENT_PREFIX": "다른 표지"}):
            code, out = self.run_ci(outputs, ["--comment-prefix", "CI failed: "], auth=None)
        self.assertIn("E   boom", out)

    def test_failure_without_jenkins_auth_and_no_comment_gives_up_after_wait(self):
        failing = pr_json(checks=[status("jenkins", "FAILURE")])
        code, out = self.run_ci([failing, json.dumps({"comments": []})], auth=None)
        self.assertEqual(code, 1)
        self.assertIn("댓글도 60초 안에 없다", out)
        self.assertIn("https://j.example/job/x/3/", out)

    def test_merged(self):
        code, _ = self.run_ci([pr_json(state="MERGED")])
        self.assertEqual(code, 2)

    def test_timeout_with_pending_check(self):
        code, out = self.run_ci([pr_json(checks=[status("jenkins", "PENDING")])], ["--timeout", "1", "--interval", "30"])
        self.assertEqual(code, 3)
        self.assertIn("TIMEOUT", out)

    def test_gone(self):
        def boom(*a):
            raise RuntimeError("not found")

        clock = Clock()
        with mock.patch.object(wait_ci, "gh", boom), mock.patch.object(wait_ci, "time", clock), mock.patch("builtins.print"):
            self.assertEqual(self._main(["1"]), 4)

    def test_no_checks_ends_after_default_3_minutes(self):
        code, out = self.run_ci([pr_json()], ["--interval", "45"])
        self.assertEqual(code, 5)
        self.assertIn("NO_CHECKS", out)

    def test_no_checks_option(self):
        code, _ = self.run_ci([pr_json()], ["--interval", "30", "--no-checks-wait", "1", "--timeout", "40"])
        self.assertEqual(code, 5)

    def test_checks_appearing_late_reset_the_no_checks_clock(self):
        outs = [pr_json(), pr_json(), pr_json(checks=[status("jenkins", "SUCCESS")])]
        code, _ = self.run_ci(outs, ["--interval", "100"])
        self.assertEqual(code, 0)


def build(n, ts, building=False, result="SUCCESS"):
    return {"number": n, "timestamp": ts, "building": building, "result": None if building else result, "url": f"https://j.example/job/app/{n}/"}


class WaitDeploy(unittest.TestCase):
    SINCE = "2026-10-30T01:00:00Z"

    def setUp(self):
        self.since_ms = wait_deploy.to_ms(self.SINCE)

    def run_deploy(self, snapshots, extra=()):
        """snapshots: 조회할 때마다 차례로 돌려줄 빌드 목록들(마지막 것 반복)."""
        clock = Clock()
        it = iter(snapshots)
        cur = [[]]

        def fake_get(url, timeout=30):
            try:
                cur[0] = next(it)
            except StopIteration:
                pass
            if isinstance(cur[0], Exception):
                raise cur[0]
            return json.dumps({"builds": cur[0]})

        argv = ["--job", "app", "--since", self.SINCE, "--jenkins-url", "https://j.example", *extra]
        with mock.patch.object(wait_deploy, "jenkins_get", fake_get), mock.patch.object(wait_deploy, "time", clock), \
                mock.patch.object(wait_deploy, "jenkins_auth", lambda: ("u", "t")), \
                mock.patch.object(wait_deploy, "console_excerpt", lambda u: "Error: boom"), \
                mock.patch("builtins.print") as pr:
            code = wait_deploy.main(argv)
        return code, "\n".join(str(c.args[0]) for c in pr.call_args_list)

    def test_ignores_builds_before_merge_and_waits_for_first_after(self):
        old = build(5, self.since_ms - 1000)
        running = build(6, self.since_ms + 5000, building=True)
        done = build(6, self.since_ms + 5000)
        newer = build(7, self.since_ms + 9000)
        code, out = self.run_deploy([[old], [running, old], [newer, done, old]])
        self.assertEqual(code, 0)
        self.assertIn("#6", out)

    def test_failure_has_console_excerpt(self):
        code, out = self.run_deploy([[build(6, self.since_ms + 1, result="FAILURE")]])
        self.assertEqual(code, 1)
        self.assertIn("Error: boom", out)

    def test_unstable_counts_as_failure(self):
        code, _ = self.run_deploy([[build(6, self.since_ms + 1, result="UNSTABLE")]])
        self.assertEqual(code, 1)

    def test_no_build_exit_5(self):
        code, out = self.run_deploy([[build(5, self.since_ms - 1)]], ["--start-timeout", "1", "--interval", "20"])
        self.assertEqual(code, 5)
        self.assertIn("NO_BUILD", out)

    def test_timeout_while_building(self):
        code, out = self.run_deploy([[build(6, self.since_ms + 1, building=True)]], ["--timeout", "1", "--interval", "20"])
        self.assertEqual(code, 3)
        self.assertIn("TIMEOUT", out)

    def test_jenkins_unreachable_is_gone(self):
        code, _ = self.run_deploy([OSError("down")], ["--interval", "1"])
        self.assertEqual(code, 4)

    def test_transient_error_recovers(self):
        code, _ = self.run_deploy([OSError("blip"), [build(6, self.since_ms + 1)]])
        self.assertEqual(code, 0)

    def test_unmerged_pr_is_gone(self):
        with mock.patch.object(wait_deploy, "gh", lambda *a: json.dumps({"mergedAt": None, "state": "OPEN"})), mock.patch("builtins.print"):
            self.assertEqual(wait_deploy.main(["--job", "app", "--pr", "9", "--jenkins-url", "https://j.example"]), 4)

    def test_pr_uses_merged_at(self):
        calls = []

        def fake_gh(*a):
            calls.append(a)
            return json.dumps({"mergedAt": self.SINCE, "state": "MERGED", "statusCheckRollup": []})

        with mock.patch.object(wait_deploy, "gh", fake_gh), \
                mock.patch.object(wait_deploy, "jenkins_auth", lambda: ("u", "t")), \
                mock.patch.object(wait_deploy, "jenkins_get", lambda u, timeout=30: json.dumps({"builds": [build(6, self.since_ms + 1)]})), \
                mock.patch("builtins.print"):
            self.assertEqual(wait_deploy.main(["--job", "app", "--pr", "9", "--repo", "o/r", "--jenkins-url", "https://j.example"]), 0)
        self.assertIn("--repo", calls[0])

    def test_folder_job_path(self):
        self.assertEqual(wait_deploy.job_path("team/app"), "job/team/job/app")


class Common(unittest.TestCase):
    def test_base_url_from_env_then_hint(self):
        with mock.patch.dict(os.environ, {"JENKINS_URL": "https://a.example/"}):
            self.assertEqual(ci_common.jenkins_base_url(), "https://a.example")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("JENKINS_URL", None)
            with mock.patch.object(ci_common, "_settings_env", lambda keys, start=None: None):
                self.assertEqual(ci_common.jenkins_base_url("https://b.example/job/x/3/"), "https://b.example")
                self.assertIsNone(ci_common.jenkins_base_url(""))



MERGE = "m" * 40
LATER = "d" * 40


class WaitDeployGithub(unittest.TestCase):
    """Jenkins 자격이 없을 때: PR 병합 커밋(또는 뒤 커밋)의 배포 커밋 상태(기본 이름 deploy)를 기다린다."""

    def run_gh(self, statuses, extra=(), compare=(), comments=(), auth=None, jenkins=None, argv=None, ctx="deploy", env=None):
        """statuses: {sha: [조회마다 차례로 돌려줄 state 또는 None …]} (마지막 것 반복)."""
        clock = Clock()
        seq = {k: iter(v) for k, v in statuses.items()}
        cur = {}
        calls = []

        def fake_gh(*args):
            calls.append(args)
            if args[:2] == ("pr", "view") and "comments" in args:
                return json.dumps({"comments": [{"body": b} for b in comments]})
            if args[:2] == ("pr", "view"):
                return json.dumps({"mergedAt": "2026-11-04T01:00:00Z", "state": "MERGED", "mergeCommit": {"oid": MERGE},
                                   "baseRefName": "main", "url": "https://github.com/o/r/pull/7", "statusCheckRollup": []})
            path = args[1]
            if "/compare/" in path:
                return json.dumps({"commits": [{"sha": s} for s in compare]})
            if path.endswith("/pulls"):
                return json.dumps([{"number": 8, "merged_at": "x"}])
            sha = path.split("/commits/")[1].split("/")[0]
            if sha in seq:
                try:
                    cur[sha] = next(seq[sha])
                except StopIteration:
                    pass
            st = cur.get(sha)
            return json.dumps({"statuses": [{"context": ctx, "state": st, "description": "빌드 #12 · 성공 · 빌드 node-c"}] if st else
                               [{"context": "other", "state": "success"}]})

        common = sys.modules["ci_common"]
        argv = argv or ["--job", "app", "--pr", "7", *extra]
        patches = [mock.patch.object(wait_deploy, "gh", fake_gh), mock.patch.object(common, "gh", fake_gh),
                   mock.patch.object(wait_deploy, "time", clock), mock.patch.object(wait_deploy, "jenkins_auth", lambda: auth),
                   mock.patch("builtins.print"), mock.patch.dict(os.environ, env or {})]
        if jenkins:
            patches.append(mock.patch.object(wait_deploy, "jenkins_get", jenkins))
        for p in patches:
            p.start()
        try:
            code = wait_deploy.main(argv)
            out = "\n".join(str(c.args[0]) for c in print.call_args_list)
        finally:
            for p in reversed(patches):
                p.stop()
        self.calls = calls
        return code, out

    def test_pending_then_success_on_merge_commit(self):
        code, out = self.run_gh({MERGE: [None, "pending", "pending", "success"]})
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("SUCCESS o/r deploy #12 mmmmmmmmmmmm"), out)
        self.assertNotIn("뒤 커밋", out)

    def test_status_context_default_env_and_argument(self):
        code, out = self.run_gh({MERGE: ["success"]}, ["--start-timeout", "1"], ctx="team/deploy")
        self.assertEqual(code, 5)  # 기본 이름 deploy와 다르면 못 본다
        code, out = self.run_gh({MERGE: ["success"]}, ctx="team/deploy", env={"ISSUE_TRACK_DEPLOY_CONTEXT": "team/deploy"})
        self.assertEqual(code, 0)
        self.assertIn("o/r team/deploy #12", out)
        code, out = self.run_gh({MERGE: ["success"]}, ["--status-context", "team/deploy"], ctx="team/deploy",
                                env={"ISSUE_TRACK_DEPLOY_CONTEXT": "other"})
        self.assertEqual(code, 0)

    def test_deploy_comment_prefix_from_env(self):
        comments = ["Deploy failed: deploy · mmmmmmmmmmmm · node-b · build #12\n\nError: boom"]
        code, out = self.run_gh({MERGE: ["failure"]}, comments=comments)
        self.assertNotIn("Error: boom", out)
        code, out = self.run_gh({MERGE: ["failure"]}, comments=comments, env={"ISSUE_TRACK_DEPLOY_COMMENT_PREFIX": "Deploy failed: "})
        self.assertEqual(code, 1)
        self.assertIn("Error: boom", out)

    def test_job_is_not_used_and_no_jenkins_call(self):
        def boom(url, timeout=30):
            raise AssertionError("Jenkins를 부르면 안 된다")
        code, _ = self.run_gh({MERGE: ["success"]}, jenkins=boom)
        self.assertEqual(code, 0)

    def test_batched_push_uses_first_later_commit_with_status(self):
        code, out = self.run_gh({LATER: ["pending", "success"]}, compare=["x" * 40, LATER, "z" * 40])
        self.assertEqual(code, 0)
        self.assertIn(LATER[:12], out)
        self.assertIn("뒤 커밋이 배포됨", out)

    def test_failure_prints_deploy_failure_comment(self):
        comments = ["PR 검사 실패 — 검사 · mmmmmmmmmmmm · node-a · 빌드 #3\n\nold",
                    "배포 실패 — 배포 · mmmmmmmmmmmm · node-b · 빌드 #12\n\n```\nError: boom\n```"]
        code, out = self.run_gh({MERGE: ["failure"]}, comments=comments)
        self.assertEqual(code, 1)
        self.assertTrue(out.startswith("FAILURE "), out)
        self.assertIn("Error: boom", out)
        self.assertNotIn("old", out)

    def test_error_state_is_failure_without_comment(self):
        code, out = self.run_gh({MERGE: ["error"]})
        self.assertEqual(code, 1)
        self.assertIn("배포 실패 댓글 없음", out)

    def test_no_status_is_no_build(self):
        code, out = self.run_gh({}, ["--start-timeout", "1", "--interval", "20"])
        self.assertEqual(code, 5)
        self.assertIn("NO_BUILD", out)

    def test_pending_forever_is_timeout(self):
        code, out = self.run_gh({MERGE: ["pending"]}, ["--timeout", "1", "--interval", "20"])
        self.assertEqual(code, 3)
        self.assertIn("TIMEOUT", out)

    def test_since_without_credentials_is_gone(self):
        code, out = self.run_gh({}, argv=["--job", "app", "--since", "2026-11-04T01:00:00Z"])
        self.assertEqual(code, 4)
        self.assertIn("--pr", out)

    def test_stale_credentials_403_falls_back_to_github_with_one_warning(self):
        def forbidden(url, timeout=30):
            raise sys.modules["ci_common"].JenkinsUnavailable("HTTP 403")
        code, out = self.run_gh({MERGE: ["success"]}, ["--jenkins-url", "https://j.example"], auth=("u", "stale"), jenkins=forbidden)
        self.assertEqual(code, 0)
        self.assertIn("SUCCESS", out)
        self.assertEqual(out.count("경고: Jenkins를 못 쓴다(HTTP 403)"), 1)

    def test_stale_credentials_connection_failure_falls_back_to_github(self):
        def down(url, timeout=30):
            raise sys.modules["ci_common"].JenkinsUnavailable("URLError")
        code, out = self.run_gh({MERGE: ["failure"]}, ["--jenkins-url", "https://j.example"], auth=("u", "stale"), jenkins=down)
        self.assertEqual(code, 1)
        self.assertIn("경고: Jenkins를 못 쓴다(URLError)", out)

    def test_credentials_without_base_url_fall_back_with_pr(self):
        with mock.patch.object(wait_deploy, "jenkins_base_url", lambda hint="": None):
            code, out = self.run_gh({MERGE: ["success"]}, auth=("u", "t"))
        self.assertEqual(code, 0)
        self.assertIn("기본 URL을 모른다", out)


class JenkinsGet(unittest.TestCase):
    """ci_common.jenkins_get: 401·403·연결 실패만 JenkinsUnavailable."""

    def call(self, exc):
        import urllib.error
        common = sys.modules["ci_common"]

        def urlopen(req, timeout=30):
            raise exc(req.full_url) if callable(exc) else exc
        with mock.patch.object(common.urllib.request, "urlopen", urlopen), mock.patch.object(common, "jenkins_auth", lambda: ("u", "old")):
            return common.jenkins_get("https://j.example/api/json")

    def http(self, code):
        import urllib.error
        return urllib.error.HTTPError("https://j.example/api/json", code, "x", {}, None)

    def test_401_and_403(self):
        common = sys.modules["ci_common"]
        for code in (401, 403):
            with self.assertRaises(common.JenkinsUnavailable) as cm:
                self.call(self.http(code))
            self.assertIn(str(code), str(cm.exception))

    def test_connection_failure(self):
        import urllib.error
        common = sys.modules["ci_common"]
        for e in (urllib.error.URLError("refused"), TimeoutError("slow"), ConnectionRefusedError()):
            with self.assertRaises(common.JenkinsUnavailable):
                self.call(e)

    def test_other_http_errors_stay(self):
        import urllib.error
        with self.assertRaises(urllib.error.HTTPError):
            self.call(self.http(404))

    def test_console_excerpt_reraises_unavailable(self):
        common = sys.modules["ci_common"]

        def forbidden(url, timeout=30):
            raise common.JenkinsUnavailable("HTTP 401")
        with mock.patch.object(common, "jenkins_get", forbidden), self.assertRaises(common.JenkinsUnavailable):
            common.console_excerpt("https://j.example/job/x/3/")


if __name__ == "__main__":
    unittest.main()
