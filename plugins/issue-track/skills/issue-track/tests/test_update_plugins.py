"""update-plugins.py 단위 시험. ssh·claude·switchboard 실행을 가짜 Runner로 바꿔 끼운다.

    python3 -m unittest discover -s plugins/issue-track/skills/issue-track/tests
"""
import io
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
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

    def __init__(self, machines, latest, fail=(), status=None, ps_hosts=(), markets=None, files=None):
        self.machines = machines  # host -> list[install]
        self.latest = latest  # (id) -> (version, lastUpdated)
        self.fail = set(fail)  # (host, 단계) — 단계: "market", "list", 플러그인 id
        self.status = status
        self.ps_hosts = set(ps_hosts)  # 셸 판별에 PowerShell로 답하는 기계
        self.markets = markets or {}  # host -> 마켓 클론 installLocation
        self.files = files or {}  # (host, 경로) -> 내용
        self.calls = []
        self.shells = []  # (host, argv[0], shell)

    def __call__(self, host, argv, cwd=None, shell=up.POSIX):
        self.calls.append((host, tuple(argv), cwd))
        self.shells.append((host, argv[0], shell))
        if shell == up.RAW:
            return up.Result(0, "5\r\n" if host in self.ps_hosts else ".PSVersion.Major\n", "")
        if argv[:4] == ["claude", "plugin", "marketplace", "list"]:
            loc = self.markets.get(host)
            return up.Result(0, json.dumps([{"name": "kit", "installLocation": loc}] if loc else []), "")
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
                if e["id"] == pid and e["scope"] == argv[5] and up.is_older(e["version"], self.latest[pid][0]):
                    e["version"], e["lastUpdated"] = self.latest[pid]
            return up.Result(0, "ok", "")
        if argv[0] in ("cat", "Get-Content") or (len(argv) > 1 and argv[1] == "-c"):
            text = self.files.get((host, argv[-1]))
            return up.Result(0, text, "") if text is not None else up.Result(1, "", "no such file")
        if argv[-2:] == ["status", "--json"]:
            if self.status is None:
                return up.Result(127, "", f"{argv[-3]}: not found")
            return up.Result(0, json.dumps(self.status), "")
        raise AssertionError(f"모르는 명령 {argv}")


def row(out, *cells):
    """표에서 앞 칸들이 cells인 줄을 칸 목록으로."""
    for l in out.splitlines():
        if l.split()[:len(cells)] == list(cells):
            return l.split()
    raise AssertionError(f"{cells} 줄 없음:\n{out}")


def only(*names):
    """shutil.which 대역: names에 든 실행 파일만 있다."""
    return lambda n: f"/opt/bin/{n}" if n in names else None


def run_main(fake, args, config=None, hostname="box-local", which=only("switchboard")):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "c.json")
        with open(path, "w") as f:
            json.dump(config or {}, f)
        buf = io.StringIO()
        with redirect_stdout(buf), mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": d}):
            code = up.main(["--config", path, *args], run=fake, hostname=lambda: hostname, which=which)
        return code, buf.getvalue()


LATEST = {"issue-track@kit": ("0.8.0", "2026-02-01T00:00:00Z"),
          "switchboard@kit": ("0.9.0", "2026-02-01T00:00:00Z")}


def write(root, rel, text):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


class SkillCopy(unittest.TestCase):
    def test_sync_overwrites_changed_keeps_extra_and_writes_version(self):
        with tempfile.TemporaryDirectory() as t:
            src, dst = os.path.join(t, "src"), os.path.join(t, "dst")
            write(src, "SKILL.md", "new")
            write(src, "scripts/wait-ci.py", "new")
            write(src, "reference/switchboard.md", "doc")
            write(dst, "SKILL.md", "old")
            write(dst, "scripts/wait-ci.py", "new")
            write(dst, "scripts/worker-stats.py", "mine")
            write(dst, ".bak-1/x.py", "keep")
            write(dst, "scripts/__pycache__/x.pyc", "c")
            written, extra = up.sync_skill_copy(src, dst, "0.12.1")
            self.assertEqual(sorted(written), ["SKILL.md", "VERSION", os.path.join("reference", "switchboard.md")])
            self.assertEqual(extra, [os.path.join("scripts", "worker-stats.py")])
            self.assertEqual(open(os.path.join(dst, "SKILL.md")).read(), "new")
            self.assertEqual(open(os.path.join(dst, "scripts/worker-stats.py")).read(), "mine")
            self.assertEqual(open(os.path.join(dst, "VERSION")).read().strip(), "0.12.1")
            self.assertEqual(up.sync_skill_copy(src, dst, "0.12.1")[0], [])  # 두 번째는 할 일 없음

    def test_main_syncs_local_copy_from_install_path_and_names_extras(self):
        with tempfile.TemporaryDirectory() as t:
            src, dst = os.path.join(t, "cache", "issue-track", "0.8.0", "skills", "issue-track"), os.path.join(t, "copy")
            write(src, "scripts/wait-ci.py", "v8")
            write(dst, "scripts/wait-ci.py", "v1")
            write(dst, "scripts/worker-stats.py", "mine")
            e = inst("issue-track@kit", "0.7.0")
            e["installPath"] = os.path.join(t, "cache", "issue-track", "0.8.0")
            fake = FakeMachines({"local": [e]}, LATEST)
            code, out = run_main(fake, ["--local-only", "--no-sessions"], {"update": {"marketplace": "kit", "skill_copy": dst}})
            self.assertEqual(code, 0)
            self.assertEqual(open(os.path.join(dst, "scripts/wait-ci.py")).read(), "v8")
            self.assertIn("0.8.0 판에 맞춤", out)
            self.assertIn("worker-stats.py", out)
            self.assertTrue(os.path.exists(os.path.join(dst, "scripts/worker-stats.py")))

    def test_main_without_copy_folder_says_nothing(self):
        fake = FakeMachines({"local": [inst("issue-track@kit", "0.7.0")]}, LATEST)
        code, out = run_main(fake, ["--local-only", "--no-sessions"], {"update": {"marketplace": "kit", "skill_copy": "/nonexistent/x"}})
        self.assertNotIn("스킬 복사본", out)


class UpdatePlugins(unittest.TestCase):
    def test_updates_every_machine_and_prints_version_table(self):
        fake = FakeMachines({
            "local": [inst("issue-track@kit", "0.7.0"), inst("other@else", "1.0.0")],
            "remote-1": [inst("issue-track@kit", "0.8.0"), inst("switchboard@kit", "0.8.0")],
        }, LATEST)
        code, out = run_main(fake, ["--hosts", "remote-1", "--no-sessions"], {"update": {"marketplace": "kit"}})
        self.assertEqual(code, 0)
        self.assertIn(("remote-1", ("claude", "plugin", "marketplace", "update", "kit"), None), fake.calls)
        self.assertEqual(row(out, "local", "issue-track"), ["local", "issue-track", "user", "-", "0.7.0→0.8.0", "0.8.0", "최신"])
        self.assertEqual(row(out, "remote-1", "issue-track"), ["remote-1", "issue-track", "user", "-", "0.8.0", "0.8.0", "최신"])
        self.assertEqual(row(out, "remote-1", "switchboard"), ["remote-1", "switchboard", "user", "-", "0.8.0→0.9.0", "0.9.0", "최신"])
        self.assertNotIn("other", out)  # 다른 마켓 플러그인은 건드리지 않는다

    def test_local_scope_update_runs_in_project_folder_with_scope_flag(self):
        fake = FakeMachines({"local": [inst("switchboard@kit", "0.8.0", scope="local", project="/w/app")]}, LATEST)
        code, out = run_main(fake, ["--marketplace", "kit", "--local-only", "--no-sessions"])
        self.assertEqual(code, 0)
        self.assertIn(("local", ("claude", "plugin", "update", "switchboard@kit", "--scope", "local"), "/w/app"),
                      fake.calls)
        self.assertEqual(row(out, "local", "switchboard"), ["local", "switchboard", "local", "app", "0.8.0→0.9.0", "0.9.0", "최신"])

    def test_one_machine_failing_does_not_stop_others(self):
        fake = FakeMachines({
            "local": [inst("issue-track@kit", "0.7.0")],
            "remote-1": [inst("issue-track@kit", "0.7.0")],
            "remote-2": [inst("issue-track@kit", "0.7.0")],
        }, LATEST, fail=[("remote-1", "market"), ("remote-2", "issue-track@kit")])
        code, out = run_main(fake, ["--no-sessions"],
                             {"update": {"marketplace": "kit", "hosts": ["remote-1", "remote-2"]}})
        self.assertEqual(code, 1)
        self.assertEqual(row(out, "local", "issue-track")[-1], "최신")
        self.assertEqual(row(out, "remote-1"), ["remote-1", "-", "-", "-", "-", "-", "실패"])
        self.assertEqual(row(out, "remote-2", "issue-track")[-1], "실패")
        self.assertIn("- remote-1: marketplace update 실패: ssh: connect to host remote-2 port 22: Connection refused", out)
        self.assertIn("- remote-2 issue-track (user): Error: network down", out)

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
        self.assertIn(("local", ("env", "SWITCHBOARD_PROFILE=boss", "AGENT_MAIL_PROFILE=boss", "switchboard", "status", "--json"), None),
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

    def test_mail_cli_missing_skips_session_table(self):
        fake = FakeMachines({"local": [inst("issue-track@kit", "0.8.0")]}, LATEST)
        code, out = run_main(fake, ["--marketplace", "kit", "--local-only"], which=only())
        self.assertEqual(code, 0)
        self.assertIn("옛 판 세션: switchboard status를 못 읽어 건너뛴다(switchboard: not found)", out)

    def test_mail_cli_prefers_switchboard_then_old_name(self):
        self.assertEqual(up.mail_cli(only("switchboard", "agent-mail")), "switchboard")
        self.assertEqual(up.mail_cli(only("agent-mail")), "agent-mail")
        self.assertEqual(up.mail_cli(only()), "switchboard")
        fake = FakeMachines({"local": [inst("issue-track@kit", "0.8.0")]}, LATEST, status={"sessions": []})
        run_main(fake, ["--marketplace", "kit", "--local-only"], which=only("agent-mail"))
        self.assertIn(("local", ("agent-mail", "status", "--json"), None), fake.calls)

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

    def test_role_env_removed_from_child_env(self):
        envs = []

        class P:
            returncode, stdout, stderr = 0, "", ""

        orig_run, orig_env = up.subprocess.run, dict(os.environ)
        up.subprocess.run = lambda argv, **kw: envs.append(kw["env"]) or P()
        os.environ["AGENT_MAIL_ROLE"] = "x/worker-1"
        os.environ["SWITCHBOARD_ROLE"] = "x/worker-1"
        try:
            up.run_cmd("local", ["claude", "plugin", "list", "--json"])
        finally:
            up.subprocess.run = orig_run
            os.environ.clear()
            os.environ.update(orig_env)
        self.assertNotIn("AGENT_MAIL_ROLE", envs[0])
        self.assertNotIn("SWITCHBOARD_ROLE", envs[0])

    def test_remote_claude_setting_used_only_for_remote_hosts(self):
        calls = []

        def fake(host, argv, cwd=None, shell=up.POSIX):
            calls.append((host, argv[0]))
            return up.Result(0, "[]" if "list" in argv else "ok", "")

        up.update_machine(fake, "mac", "kit", "/opt/bin/claude")
        up.update_machine(fake, up.LOCAL, "kit", "/opt/bin/claude")
        self.assertEqual({c for h, c in calls if h == "mac"}, {"/opt/bin/claude"})
        self.assertEqual({c for h, c in calls if h == up.LOCAL}, {"claude"})

    def test_powershell_remote_line_has_no_path_prefix_and_sets_location(self):
        calls = []

        class P:
            returncode, stdout, stderr = 0, "", ""

        orig = up.subprocess.run
        up.subprocess.run = lambda argv, **kw: calls.append(argv) or P()
        try:
            up.run_cmd("win", ["claude", "plugin", "update", "switchboard@kit", "--scope", "local"],
                       "C:\\work\\it's proj", shell=up.POWERSHELL)
            up.run_cmd("win", ["claude", "plugin", "list", "--json"], shell=up.POWERSHELL)
            up.run_cmd("win", ["C:\\Program Files\\claude.exe", "plugin", "list"], shell=up.POWERSHELL)
        finally:
            up.subprocess.run = orig
        self.assertEqual(calls[0][:4], ["ssh", "-o", "BatchMode=yes", "win"])
        self.assertEqual(calls[0][-1], "Set-Location -LiteralPath 'C:\\work\\it''s proj' -ErrorAction Stop; "
                                       "claude plugin update switchboard@kit --scope local; exit $LASTEXITCODE")
        self.assertEqual(calls[1][-1], "claude plugin list --json; exit $LASTEXITCODE")
        self.assertEqual(calls[2][-1], "& 'C:\\Program Files\\claude.exe' plugin list; exit $LASTEXITCODE")
        self.assertNotIn("PATH=", "".join(c[-1] for c in calls))

    def test_shell_from_config_skips_probe_and_probe_detects_powershell(self):
        machines = {"local": [], "win": [inst("switchboard@kit", "0.8.0")],
                    "ps-auto": [inst("switchboard@kit", "0.8.0")], "linux": [inst("switchboard@kit", "0.8.0")]}
        fake = FakeMachines(machines, LATEST, ps_hosts={"ps-auto"})
        code, _ = run_main(fake, ["--hosts", "win,ps-auto,linux", "--no-sessions"],
                           {"update": {"marketplace": "kit", "shells": {"win": "powershell"}}})
        self.assertEqual(code, 0)
        probed = {h for h, _, sh in fake.shells if sh == up.RAW}
        self.assertEqual(probed, {"ps-auto", "linux"})  # 설정에 있는 win과 로컬은 묻지 않는다
        used = {h: {sh for hh, a, sh in fake.shells if hh == h and sh != up.RAW} for h in machines}
        self.assertEqual(used, {"local": {up.POSIX}, "win": {up.POWERSHELL},
                                "ps-auto": {up.POWERSHELL}, "linux": {up.POSIX}})

    def test_windows_local_scope_updates_in_its_folder_and_every_scope_is_listed(self):
        fake = FakeMachines({"local": [], "win": [
            inst("switchboard@kit", "0.8.0"),
            inst("switchboard@kit", "0.8.0", scope="local", project="C:\\work\\proj"),
        ]}, LATEST, ps_hosts={"win"})
        code, out = run_main(fake, ["--marketplace", "kit", "--hosts", "win", "--no-sessions"])
        self.assertEqual(code, 0)
        self.assertIn(("win", ("claude", "plugin", "update", "switchboard@kit", "--scope", "local"), "C:\\work\\proj"),
                      fake.calls)
        self.assertIn(("win", ("claude", "plugin", "update", "switchboard@kit", "--scope", "user"), None), fake.calls)
        self.assertEqual(row(out, "win", "switchboard", "user"), ["win", "switchboard", "user", "-", "0.8.0→0.9.0", "0.9.0", "최신"])
        self.assertEqual(row(out, "win", "switchboard", "local"), ["win", "switchboard", "local", "proj", "0.8.0→0.9.0", "0.9.0", "최신"])

    def test_older_than_market_clone_fails_with_code_1(self):
        # 갱신 명령은 성공했지만 local 범위가 마켓 클론의 판(plugin.json)보다 옛 판으로 남는다.
        clone = "C:\\Users\\me\\.claude\\plugins\\marketplaces\\kit"
        fake = FakeMachines({"local": [], "win": [
            inst("switchboard@kit", "0.9.0"),
            inst("switchboard@kit", "0.8.0", scope="local", project="C:\\work\\proj"),
        ]}, {"switchboard@kit": ("0.8.0", "2026-02-01T00:00:00Z")}, ps_hosts={"win"},
            markets={"win": clone},
            files={("win", clone + "/.claude-plugin/marketplace.json"):
                   json.dumps({"plugins": [{"name": "switchboard", "source": "./plugins/switchboard"}]}),
                   ("win", clone + "/plugins/switchboard/.claude-plugin/plugin.json"): json.dumps({"version": "0.9.0"})})
        code, out = run_main(fake, ["--marketplace", "kit", "--hosts", "win", "--no-sessions"])
        self.assertEqual(code, 1)
        self.assertEqual(row(out, "win", "switchboard", "user")[-2:], ["0.9.0", "최신"])
        self.assertEqual(row(out, "win", "switchboard", "local")[-3:], ["0.8.0", "0.9.0", "옛판"])
        self.assertIn("- win switchboard (local:proj) 0.8.0", out)
        self.assertIn(("win", "Get-Content", up.POWERSHELL), fake.shells)

    def test_market_clone_newer_than_every_install_fails(self):
        fake = FakeMachines({"local": [inst("switchboard@kit", "0.8.0")]},
                            {"switchboard@kit": ("0.8.0", "2026-02-01T00:00:00Z")}, markets={"local": "/m/kit"},
                            files={("local", "/m/kit/.claude-plugin/marketplace.json"):
                                   json.dumps({"plugins": [{"name": "switchboard", "version": "1.0.0"}]})})
        code, out = run_main(fake, ["--marketplace", "kit", "--local-only", "--no-sessions"])
        self.assertEqual(code, 1)
        self.assertEqual(row(out, "local", "switchboard")[-3:], ["0.8.0", "1.0.0", "옛판"])

    def test_remote_list_failure_after_update_fails_with_code_1(self):
        fake = FakeMachines({"local": [], "win": [inst("switchboard@kit", "0.8.0")]}, LATEST,
                            fail=[("win", "list")], ps_hosts={"win"})
        code, out = run_main(fake, ["--marketplace", "kit", "--hosts", "win", "--no-sessions"])
        self.assertEqual(code, 1)
        self.assertEqual(row(out, "win")[-1], "실패")
        self.assertIn("- win: plugin list 실패: boom", out)

    def test_folder_name_handles_windows_and_posix_paths(self):
        self.assertEqual(up.folder_name("C:\\work\\proj\\"), "proj")
        self.assertEqual(up.folder_name("/w/app/"), "app")
        self.assertEqual(up.folder_name(""), "")

    def test_shells_read_from_config_ignores_unknown_values(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "c.json")
            with open(path, "w") as f:
                json.dump({"update": {"shells": {"win": "powershell", "box": "cmd"}}}, f)
            self.assertEqual(up.load_update_config(path)["shells"], {"win": "powershell"})

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
