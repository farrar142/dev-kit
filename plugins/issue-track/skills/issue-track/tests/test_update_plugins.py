"""update-plugins.py 단위 시험. ssh·claude·agent-mail 실행을 가짜 Runner로 바꿔 끼운다.

    python3 -m unittest discover -s plugins/issue-track/skills/issue-track/tests
"""
import io
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "scripts")
spec = importlib.util.spec_from_file_location("update_plugins", os.path.join(SCRIPTS, "update-plugins.py"))
up = importlib.util.module_from_spec(spec)
sys.modules["update_plugins"] = up  # dataclass가 모듈을 찾는다
spec.loader.exec_module(up)


def inst(pid, version, updated="2026-01-01T00:00:00Z", scope="user", project=None):
    e = {"id": pid, "version": version, "scope": scope, "lastUpdated": updated}
    if project:
        e["projectPath"] = project
    return e


class FakeMachines:
    """기계마다 설치 목록을 들고, `claude plugin update`가 오면 새 판으로 바꾼다."""

    def __init__(self, machines, latest, fail=(), status=None):
        self.machines = machines  # host -> list[install]
        self.latest = latest  # (id) -> (version, lastUpdated)
        self.fail = set(fail)  # (host, 단계) — 단계: "market", "list", 플러그인 id
        self.status = status
        self.calls = []

    def __call__(self, host, argv, cwd=None):
        self.calls.append((host, tuple(argv), cwd))
        if argv[:3] == ["claude", "plugin", "marketplace"]:
            if (host, "market") in self.fail:
                return up.Result(255, "", "ssh: connect to host remote-2 port 22: Connection refused")
            return up.Result(0, "updated", "")
        if argv[:4] == ["claude", "plugin", "list", "--json"]:
            if (host, "list") in self.fail:
                return up.Result(1, "", "boom")
            return up.Result(0, json.dumps(self.machines[host]), "")
        if argv[:3] == ["claude", "plugin", "update"]:
            pid = argv[3]
            if (host, pid) in self.fail:
                return up.Result(1, "", "Error: network down")
            for e in self.machines[host]:
                if e["id"] == pid and e["scope"] == argv[5]:
                    e["version"], e["lastUpdated"] = self.latest[pid]
            return up.Result(0, "ok", "")
        if "agent-mail" in argv:
            if self.status is None:
                return up.Result(127, "", "agent-mail: not found")
            return up.Result(0, json.dumps(self.status), "")
        raise AssertionError(f"모르는 명령 {argv}")


def run_main(fake, args, config=None, hostname="box-local"):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "c.json")
        with open(path, "w") as f:
            json.dump(config or {}, f)
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = up.main(["--config", path, *args], run=fake, hostname=lambda: hostname)
        return code, buf.getvalue()


LATEST = {"issue-track@kit": ("0.8.0", "2026-02-01T00:00:00Z"),
          "switchboard@kit": ("0.9.0", "2026-02-01T00:00:00Z")}


class UpdatePlugins(unittest.TestCase):
    def test_updates_every_machine_and_prints_version_table(self):
        fake = FakeMachines({
            "local": [inst("issue-track@kit", "0.7.0"), inst("other@else", "1.0.0")],
            "remote-1": [inst("issue-track@kit", "0.8.0"), inst("switchboard@kit", "0.8.0")],
        }, LATEST)
        code, out = run_main(fake, ["--hosts", "remote-1", "--no-sessions"], {"update": {"marketplace": "kit"}})
        self.assertEqual(code, 0)
        self.assertIn(("remote-1", ("claude", "plugin", "marketplace", "update", "kit"), None), fake.calls)
        lines = out.splitlines()
        self.assertTrue(any(l.split() == ["issue-track", "0.7.0→0.8.0", "0.8.0"] for l in lines), out)
        self.assertTrue(any(l.split() == ["switchboard", "-", "0.8.0→0.9.0"] for l in lines), out)
        self.assertNotIn("other", out)  # 다른 마켓 플러그인은 건드리지 않는다

    def test_local_scope_update_runs_in_project_folder_with_scope_flag(self):
        fake = FakeMachines({"local": [inst("switchboard@kit", "0.8.0", scope="local", project="/w/app")]}, LATEST)
        code, out = run_main(fake, ["--marketplace", "kit", "--local-only", "--no-sessions"])
        self.assertEqual(code, 0)
        self.assertIn(("local", ("claude", "plugin", "update", "switchboard@kit", "--scope", "local"), "/w/app"),
                      fake.calls)
        self.assertIn("switchboard (local:app)", out)

    def test_one_machine_failing_does_not_stop_others(self):
        fake = FakeMachines({
            "local": [inst("issue-track@kit", "0.7.0")],
            "remote-1": [inst("issue-track@kit", "0.7.0")],
            "remote-2": [inst("issue-track@kit", "0.7.0")],
        }, LATEST, fail=[("remote-1", "market"), ("remote-2", "issue-track@kit")])
        code, out = run_main(fake, ["--no-sessions"],
                             {"update": {"marketplace": "kit", "hosts": ["remote-1", "remote-2"]}})
        self.assertEqual(code, 1)
        row = next(l for l in out.splitlines() if l.startswith("issue-track"))
        self.assertEqual(row.split(), ["issue-track", "0.7.0→0.8.0", "실패", "실패(0.7.0)"])
        self.assertIn("- remote-1: marketplace update 실패: ssh: connect to host remote-2 port 22: Connection refused", out)
        self.assertIn("- remote-2 issue-track: Error: network down", out)

    def test_missing_marketplace_is_config_error(self):
        code, _ = run_main(FakeMachines({}, LATEST), ["--local-only"])
        self.assertEqual(code, 2)

    def test_stale_sessions_registered_before_switchboard_update(self):
        fake = FakeMachines({
            "local": [inst("switchboard@kit", "0.8.0")],
            "remote-1": [inst("switchboard@kit", "0.8.0")],
        }, LATEST, status={"sessions": [
            {"role": "myorg/boss", "machine": "box-local", "directory": "/w/a", "online": True,
             "registered_at": "2026-01-15T00:00:00Z"},
            {"role": "app/worker-1", "machine": "build-box", "directory": "/w/b", "online": True,
             "registered_at": "2026-03-01T00:00:00Z"},
            {"role": "app/worker-2", "machine": "build-box", "directory": "/w/c", "online": False,
             "registered_at": "2026-01-15T00:00:00Z"},
            {"role": "app/coordinator", "machine": "build-box", "directory": "/w/d", "online": True,
             "registered_at": "2026-01-20T00:00:00Z"},
            {"role": "x/elsewhere", "machine": "unknown", "directory": "/w/e", "online": True,
             "registered_at": "2026-01-01T00:00:00Z"},
        ]})
        cfg = {"update": {"marketplace": "kit", "hosts": ["remote-1"], "mail_profile": "boss",
                          "machines": {"remote-1": "build-box"}}}
        code, out = run_main(fake, [], cfg)
        self.assertEqual(code, 0)
        stale = out.split("옛 판으로 떠 있는 세션:")[1]
        self.assertIn("myorg/boss", stale)
        self.assertIn("app/coordinator", stale)
        for role in ("app/worker-1", "app/worker-2", "x/elsewhere"):
            self.assertNotIn(role, stale)
        self.assertIn(("local", ("env", "AGENT_MAIL_PROFILE=boss", "agent-mail", "status", "--json"), None),
                      fake.calls)

    def test_stale_check_prefers_local_scope_install_for_its_folder(self):
        fake = FakeMachines({"local": [
            inst("switchboard@kit", "0.9.0", updated="2026-02-01T00:00:00Z"),
            inst("switchboard@kit", "0.8.0", updated="2025-12-01T00:00:00Z", scope="local", project="/w/old"),
        ]}, {"switchboard@kit": ("0.9.0", "2026-02-01T00:00:00Z")}, status={"sessions": [
            {"role": "a/r", "machine": "box-local", "directory": "/w/old/sub", "online": True,
             "registered_at": "2026-01-01T00:00:00Z"},
        ]})
        # local 설치 갱신이 실패해 옛 lastUpdated가 남으면 그 폴더 세션은 옛 판이 아니다(같은 판을 쓰고 있다).
        fake.fail.add(("local", "switchboard@kit"))
        _, out = run_main(fake, ["--marketplace", "kit", "--local-only"])
        self.assertIn("옛 판으로 떠 있는 세션: 없음", out)

    def test_agent_mail_missing_skips_session_table(self):
        fake = FakeMachines({"local": [inst("issue-track@kit", "0.8.0")]}, LATEST)
        code, out = run_main(fake, ["--marketplace", "kit", "--local-only"])
        self.assertEqual(code, 0)
        self.assertIn("옛 판 세션: agent-mail status를 못 읽어 건너뛴다(agent-mail: not found)", out)

    def test_remote_command_goes_through_ssh_with_cd(self):
        calls = []

        class P:
            returncode, stdout, stderr = 0, "", ""

        orig = up.subprocess.run
        up.subprocess.run = lambda argv, **kw: calls.append((argv, kw.get("cwd"))) or P()
        try:
            up.run_cmd("remote-1", ["claude", "plugin", "update", "a@kit", "--scope", "local"], "/w/my app")
            up.run_cmd("local", ["claude", "plugin", "list", "--json"], "/w/x")
        finally:
            up.subprocess.run = orig
        self.assertEqual(calls[0], (["ssh", "-o", "BatchMode=yes", "remote-1",
                                     "cd '/w/my app' && PATH=\"$HOME/.local/bin:$PATH\" claude plugin update a@kit --scope local"], None))
        self.assertEqual(calls[1], (["claude", "plugin", "list", "--json"], "/w/x"))

    def test_remote_command_prefixes_path_unexpanded_locally(self):
        calls = []

        class P:
            returncode, stdout, stderr = 0, "", ""

        orig = up.subprocess.run
        up.subprocess.run = lambda argv, **kw: calls.append(argv) or P()
        try:
            up.run_cmd("mac", ["claude", "plugin", "list", "--json"])
        finally:
            up.subprocess.run = orig
        self.assertEqual(calls[0][-1], 'PATH="$HOME/.local/bin:$PATH" claude plugin list --json')

    def test_remote_claude_setting_used_only_for_remote_hosts(self):
        calls = []

        def fake(host, argv, cwd=None):
            calls.append((host, argv[0]))
            return up.Result(0, "[]" if "list" in argv else "ok", "")

        up.update_machine(fake, "mac", "kit", "/opt/bin/claude")
        up.update_machine(fake, up.LOCAL, "kit", "/opt/bin/claude")
        self.assertEqual({c for h, c in calls if h == "mac"}, {"/opt/bin/claude"})
        self.assertEqual({c for h, c in calls if h == up.LOCAL}, {"claude"})

    def test_remote_claude_read_from_config(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "c.json")
            with open(path, "w") as f:
                json.dump({"update": {"remote_claude": "~/bin/claude"}}, f)
            self.assertEqual(up.load_update_config(path)["remote_claude"], "~/bin/claude")

    def test_non_utf8_output_does_not_raise(self):
        code = "import sys; sys.stdout.buffer.write(b'\\xff\\xfe\\xb0\\xa1 ok')"
        orig = up.subprocess.run
        real = orig
        up.subprocess.run = lambda argv, **kw: real([sys.executable, "-c", code], **kw)
        try:
            r = up.run_cmd(up.LOCAL, ["claude"])
        finally:
            up.subprocess.run = orig
        self.assertEqual(r.code, 0)
        self.assertIn("ok", r.out)


if __name__ == "__main__":
    unittest.main()
