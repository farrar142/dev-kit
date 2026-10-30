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
    def run_ci(self, outputs, args=()):
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


if __name__ == "__main__":
    unittest.main()
