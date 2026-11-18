#!/usr/bin/env python3
"""로컬과 원격 기계(ssh 별칭)에서 한 마켓의 플러그인을 모든 범위에서 갱신하고 범위별 판 표를 찍는다.

    update-plugins.py [--config 경로] [--marketplace 이름] [--hosts 별칭,별칭 | --local-only]
                      [--no-sessions]

기계마다 차례로:
  0. 원격 셸 판별: 설정 update.shells[별칭](posix·powershell), 없으면
     `ssh <별칭> 'echo $PSVersionTable.PSVersion.Major'`가 숫자를 돌려주면 powershell, 아니면 posix.
  1. `claude plugin marketplace update <마켓>`
  2. `claude plugin list --json`에서 `<이름>@<마켓>` 설치를 모두(user·project·local, 폴더마다) 찾아
     `claude plugin update <이름>@<마켓> --scope <scope>`. local·project는 그 설치의 projectPath 폴더에서 돈다.
  3. 다시 `claude plugin list --json`을 읽고, 그 기계의 마켓 클론(marketplace list의 installLocation)에서
     플러그인마다 최신 판(marketplace.json 항목의 version, 없으면 source 폴더의 .claude-plugin/plugin.json)을 읽어
     「범위별 판」 표(기계·플러그인·범위·폴더·판·최신·상태)를 만든다. 최신 판을 못 읽으면 그 기계에 깔린 가장 높은 판.
원격 명령: posix는 `ssh <별칭> 'cd <폴더> && PATH="$HOME/.local/bin:$PATH" claude …'`,
powershell은 `ssh <별칭> "Set-Location -LiteralPath '<폴더>' -ErrorAction Stop; claude …; exit $LASTEXITCODE"`.
한 기계가 실패해도 나머지는 계속한다. reload·재시작은 하지 않는다.

그다음 「옛 판으로 떠 있는 세션」을 찾는다: `switchboard status --json`(설정의 메일 프로필)에서 online이고
registered_at이 그 기계 세션 플러그인(기본 switchboard)의 lastUpdated보다 이른 세션. 세션의 machine 이름과
ssh 별칭이 다르면 설정 update.machines로 잇는다(기본: 로컬은 hostname, 원격은 별칭 그대로).
메일 CLI는 `switchboard`를 먼저 찾고 없을 때만 옛 이름 `agent-mail`을 쓴다(3단계에 제거).
둘 다 없거나 실패하면 그 표는 건너뛴다고만 찍는다.

설정: ~/.config/dev-kit/issue-track.json(환경변수 DEV_KIT_CONFIG로 바꾼다)의 update 절.
예시는 이 스킬 폴더의 issue-track.example.json.

종료 코드: 0 모든 설치가 최신 / 1 기계·갱신 명령 실패 또는 최신보다 옛 판이 남음 / 2 설정 오류(마켓 이름 없음 등).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Protocol, TypedDict

LOCAL = "local"
POSIX = "posix"
POWERSHELL = "powershell"
RAW = "raw"  # 셸 판별용: argv를 그대로 이어 보낸다
SHELLS = (POSIX, POWERSHELL)
REMOTE_PATH_PREFIX = 'PATH="$HOME/.local/bin:$PATH"'
PS_PROBE = "echo $PSVersionTable.PSVersion.Major"
JSON = dict[str, "JSON"] | list["JSON"] | str | int | float | bool | None


@dataclass
class Result:
    code: int
    out: str
    err: str


class Runner(Protocol):
    def __call__(self, host: str, argv: list[str], cwd: str | None = None, shell: str = POSIX) -> Result: ...


_PS_BARE = re.compile(r"^[A-Za-z0-9_@./:=+-]+$")


def ps_quote(arg: str) -> str:
    if _PS_BARE.match(arg) and not arg.startswith("@"):
        return arg
    return "'" + arg.replace("'", "''") + "'"


def remote_line(argv: list[str], cwd: str | None, shell: str) -> str:
    """원격 셸이 받을 한 줄. posix는 PATH 접두(비대화형 셸에 ~/.local/bin이 없다), powershell은 접두 없이."""
    if shell == RAW:
        return " ".join(argv)
    if shell == POWERSHELL:
        exe = ps_quote(argv[0])
        cmd = " ".join([exe if exe == argv[0] else f"& {exe}", *(ps_quote(a) for a in argv[1:])])
        if cwd:
            cmd = f"Set-Location -LiteralPath {repr_ps(cwd)} -ErrorAction Stop; {cmd}"
        return f"{cmd}; exit $LASTEXITCODE"
    # $HOME은 원격 셸이 풀게 따옴표 안에 둔다.
    line = f"{REMOTE_PATH_PREFIX} {shlex.join(argv)}"
    if cwd:
        line = f"cd {shlex.quote(cwd)} && {line}"
    return line


def repr_ps(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def mail_cli(which=shutil.which) -> str:
    """메일 CLI 이름: switchboard 먼저, 없을 때만 옛 이름 agent-mail(3단계에 제거). 둘 다 없으면 switchboard."""
    if which("switchboard") or not which("agent-mail"):
        return "switchboard"
    return "agent-mail"


def run_cmd(host: str, argv: list[str], cwd: str | None = None, shell: str = POSIX) -> Result:
    """host가 LOCAL이면 여기서, 아니면 `ssh <host> '<원격 셸 한 줄>'`으로 돌린다."""
    env = os.environ.copy()
    # 부른 세션의 역할이 설정의 프로필과 어긋나면 메일 CLI가 거절한다.
    env.pop("AGENT_MAIL_ROLE", None)  # 옛 이름: 3단계에 제거
    env.pop("SWITCHBOARD_ROLE", None)
    if host == LOCAL:
        full, run_cwd = argv, cwd
    else:
        full, run_cwd = ["ssh", "-o", "BatchMode=yes", host, remote_line(argv, cwd, shell)], None
    try:
        # 원격 Windows 출력이 cp949여도 죽지 않게 바꿔 읽는다(#115).
        p = subprocess.run(full, cwd=run_cwd, env=env, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=600)
    except FileNotFoundError as e:
        return Result(127, "", str(e))
    except subprocess.TimeoutExpired:
        return Result(124, "", "시간 초과(600초)")
    return Result(p.returncode, p.stdout, p.stderr)


class Install(TypedDict):
    id: str
    version: str
    scope: str
    lastUpdated: str
    projectPath: str


class UpdateConfig(TypedDict, total=False):
    marketplace: str
    hosts: list[str]
    mail_profile: str
    machines: dict[str, str]
    session_plugin: str
    remote_claude: str
    shells: dict[str, str]


def config_path() -> str:
    return os.environ.get("DEV_KIT_CONFIG") or os.path.expanduser("~/.config/dev-kit/issue-track.json")


def load_update_config(path: str) -> UpdateConfig:
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        data: JSON = json.load(f)
    sect = data.get("update") if isinstance(data, dict) else None
    if not isinstance(sect, dict):
        return {}
    cfg: UpdateConfig = {}
    if isinstance(sect.get("marketplace"), str):
        cfg["marketplace"] = str(sect["marketplace"])
    hosts = sect.get("hosts")
    if isinstance(hosts, list):
        cfg["hosts"] = [str(h) for h in hosts]
    if isinstance(sect.get("mail_profile"), str):
        cfg["mail_profile"] = str(sect["mail_profile"])
    machines = sect.get("machines")
    if isinstance(machines, dict):
        cfg["machines"] = {str(k): str(v) for k, v in machines.items()}
    if isinstance(sect.get("session_plugin"), str):
        cfg["session_plugin"] = str(sect["session_plugin"])
    if isinstance(sect.get("remote_claude"), str) and sect["remote_claude"]:
        cfg["remote_claude"] = str(sect["remote_claude"])
    shells = sect.get("shells")
    if isinstance(shells, dict):
        cfg["shells"] = {str(k): str(v) for k, v in shells.items() if v in SHELLS}
    return cfg


def last_line(r: Result) -> str:
    lines = [l.strip() for l in (r.err + "\n" + r.out).splitlines() if l.strip()]
    return lines[-1][:120] if lines else f"종료 코드 {r.code}"


def detect_shell(run: Runner, host: str, configured: dict[str, str]) -> str:
    if host == LOCAL:
        return POSIX
    if host in configured:
        return configured[host]
    r = run(host, [PS_PROBE], shell=RAW)
    return POWERSHELL if r.code == 0 and r.out.strip().isdigit() else POSIX


def parse_installs(text: str, market: str) -> list[Install]:
    data: JSON = json.loads(text)
    out: list[Install] = []
    if not isinstance(data, list):
        return out
    for e in data:
        if not isinstance(e, dict):
            continue
        pid = e.get("id")
        if not isinstance(pid, str) or not pid.endswith("@" + market):
            continue
        out.append(Install(
            id=pid,
            version=str(e.get("version") or "?"),
            scope=str(e.get("scope") or "user"),
            lastUpdated=str(e.get("lastUpdated") or ""),
            projectPath=str(e.get("projectPath") or ""),
        ))
    return out


def folder_name(path: str) -> str:
    """POSIX·Windows 경로 모두에서 끝 폴더 이름."""
    parts = [p for p in re.split(r"[\\/]", path) if p]
    return parts[-1] if parts else ""


def plugin_name(i: Install) -> str:
    return i["id"].rsplit("@", 1)[0]


InstallKey = tuple[str, str, str]  # (id, scope, projectPath)


def ikey(i: Install) -> InstallKey:
    return (i["id"], i["scope"], i["projectPath"])


def version_tuple(v: str) -> tuple[int, ...] | None:
    nums = re.findall(r"\d+", v)
    return tuple(int(n) for n in nums) if nums else None


def is_older(v: str, latest: str) -> bool:
    a, b = version_tuple(v), version_tuple(latest)
    return a is not None and b is not None and a < b


@dataclass
class MachineReport:
    host: str
    error: str | None
    before: dict[InstallKey, str]
    after: list[Install]
    failed: dict[InstallKey, str]
    shell: str = POSIX
    latest: dict[str, str] = field(default_factory=dict)  # 플러그인 이름 -> 최신 판

    def stale(self) -> list[Install]:
        return [i for i in self.after if is_older(i["version"], self.latest.get(plugin_name(i), i["version"]))]


def list_installs(run: Runner, host: str, market: str, claude: str = "claude",
                  shell: str = POSIX) -> list[Install] | str:
    r = run(host, [claude, "plugin", "list", "--json"], shell=shell)
    if r.code != 0:
        return f"plugin list 실패: {last_line(r)}"
    try:
        return parse_installs(r.out, market)
    except json.JSONDecodeError:
        return "plugin list 출력이 JSON이 아님"


def read_text(run: Runner, host: str, path: str, shell: str) -> str | None:
    if host == LOCAL:
        argv = [sys.executable, "-c",
                "import sys; sys.stdout.write(open(sys.argv[1], encoding='utf-8').read())", path]
    elif shell == POWERSHELL:
        argv = ["Get-Content", "-Raw", "-Encoding", "UTF8", "-LiteralPath", path]
    else:
        argv = ["cat", path]
    r = run(host, argv, shell=shell)
    return r.out if r.code == 0 else None


def read_json(run: Runner, host: str, path: str, shell: str) -> JSON:
    text = read_text(run, host, path, shell)
    if text is None:
        return None
    try:
        data: JSON = json.loads(text)
    except json.JSONDecodeError:
        return None
    return data


def market_latest(run: Runner, host: str, market: str, claude: str, shell: str,
                  names: list[str]) -> dict[str, str]:
    """그 기계의 마켓 클론에서 플러그인마다 최신 판. 못 읽은 이름은 빠진다."""
    r = run(host, [claude, "plugin", "marketplace", "list", "--json"], shell=shell)
    if r.code != 0:
        return {}
    try:
        markets: JSON = json.loads(r.out)
    except json.JSONDecodeError:
        return {}
    loc = next((str(m.get("installLocation") or "") for m in markets
                if isinstance(m, dict) and m.get("name") == market), "") if isinstance(markets, list) else ""
    if not loc:
        return {}
    root = loc.rstrip("\\/")
    manifest = read_json(run, host, f"{root}/.claude-plugin/marketplace.json", shell)
    entries = manifest.get("plugins") if isinstance(manifest, dict) else None
    if not isinstance(entries, list):
        return {}
    out: dict[str, str] = {}
    for e in entries:
        if not isinstance(e, dict) or e.get("name") not in names:
            continue
        name = str(e["name"])
        if isinstance(e.get("version"), str):
            out[name] = str(e["version"])
            continue
        src = e.get("source")
        if not isinstance(src, str):
            continue
        rel = src[2:] if src.startswith("./") else src
        pj = read_json(run, host, f"{root}/{rel.strip('/')}/.claude-plugin/plugin.json", shell)
        if isinstance(pj, dict) and isinstance(pj.get("version"), str):
            out[name] = str(pj["version"])
    return out


def update_machine(run: Runner, host: str, market: str, remote_claude: str = "claude",
                   shell: str = POSIX) -> MachineReport:
    claude = "claude" if host == LOCAL else remote_claude
    r = run(host, [claude, "plugin", "marketplace", "update", market], shell=shell)
    if r.code != 0:
        return MachineReport(host, f"marketplace update 실패: {last_line(r)}", {}, [], {}, shell)
    before = list_installs(run, host, market, claude, shell)
    if isinstance(before, str):
        return MachineReport(host, before, {}, [], {}, shell)
    failed: dict[InstallKey, str] = {}
    for i in before:
        argv = [claude, "plugin", "update", i["id"], "--scope", i["scope"]]
        cwd = i["projectPath"] if i["scope"] in ("local", "project") and i["projectPath"] else None
        u = run(host, argv, cwd, shell=shell)
        if u.code != 0:
            failed[ikey(i)] = last_line(u)
    old = {ikey(i): i["version"] for i in before}
    after = list_installs(run, host, market, claude, shell)
    if isinstance(after, str):
        return MachineReport(host, after, old, [], failed, shell)
    names = sorted({plugin_name(i) for i in after})
    latest = market_latest(run, host, market, claude, shell, names)
    for i in after:  # 마켓 클론에서 못 읽은 플러그인은 이 기계에 깔린 가장 높은 판
        n = plugin_name(i)
        if n not in latest or is_older(latest[n], i["version"]):
            latest[n] = i["version"]
    return MachineReport(host, None, old, after, failed, shell, latest)


TABLE_HEADER = ["기계", "플러그인", "범위", "폴더", "판", "최신", "상태"]


def render_table(reports: list[MachineReport]) -> str:
    """범위별 판: 설치(기계·플러그인·범위·폴더)마다 한 줄."""
    table: list[list[str]] = [TABLE_HEADER]
    for rep in reports:
        if rep.error:
            table.append([rep.host, "-", "-", "-", "-", "-", "실패"])
            continue
        for i in sorted(rep.after, key=lambda i: (i["id"], i["scope"] != "user", i["scope"], i["projectPath"])):
            k = ikey(i)
            old = rep.before.get(k)
            ver = i["version"] if not old or old == i["version"] else f"{old}→{i['version']}"
            latest = rep.latest.get(plugin_name(i), i["version"])
            if k in rep.failed:
                state = "실패"
            elif is_older(i["version"], latest):
                state = "옛판"
            else:
                state = "최신"
            table.append([rep.host, plugin_name(i), i["scope"], folder_name(i["projectPath"]) or "-",
                          ver, latest, state])
    widths = [max(len(r[c]) for r in table) for c in range(len(TABLE_HEADER))]
    out = ["  ".join(c.ljust(w) for c, w in zip(r, widths)).rstrip() for r in table]
    notes = [f"- {rep.host}: {rep.error}" for rep in reports if rep.error]
    for rep in reports:
        for (pid, scope, path), msg in rep.failed.items():
            where = f"{scope}:{folder_name(path)}" if path else scope
            notes.append(f"- {rep.host} {pid.rsplit('@', 1)[0]} ({where}): {msg}")
    if notes:
        out += ["", "실패:"] + notes
    return "\n".join(out)


def parse_time(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def stale_sessions(status_text: str, reports: list[MachineReport], machines: dict[str, str],
                   plugin: str) -> list[str]:
    """online이고 registered_at이 그 기계 plugin의 lastUpdated보다 이른 세션을 `역할 기계 폴더`로."""
    data: JSON = json.loads(status_text)
    sessions = data.get("sessions") if isinstance(data, dict) else data
    if not isinstance(sessions, list):
        return []
    by_machine = {machines.get(r.host, r.host): r for r in reports if not r.error}
    out: list[str] = []
    for s in sessions:
        if not isinstance(s, dict) or s.get("online") is not True:
            continue
        rep = by_machine.get(str(s.get("machine")))
        reg = parse_time(str(s.get("registered_at") or ""))
        if rep is None or reg is None:
            continue
        directory = str(s.get("directory") or "")
        cands = [i for i in rep.after if i["id"].rsplit("@", 1)[0] == plugin]
        local = [i for i in cands if i["projectPath"] and directory.startswith(i["projectPath"])]
        user = [i for i in cands if i["scope"] in ("user", "managed")]
        pick = (local or user or [None])[0]
        upd = parse_time(pick["lastUpdated"]) if pick else None
        if upd is not None and reg < upd:
            out.append(f"{s.get('role')}  {s.get('machine')}  {directory}  (등록 {s.get('registered_at')})")
    return out


def main(argv: list[str] | None = None, run: Runner = run_cmd,
         hostname: Callable[[], str] = socket.gethostname) -> int:
    for stream in (sys.stdout, sys.stderr):  # Windows 로캘(cp949)에서 한국어 출력이 깨지지 않게
        reconf = getattr(stream, "reconfigure", None)
        if reconf:
            reconf(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--config", default=None)
    ap.add_argument("--marketplace", default=None)
    ap.add_argument("--hosts", default=None, help="쉼표로 나눈 ssh 별칭(설정보다 앞선다)")
    ap.add_argument("--local-only", action="store_true")
    ap.add_argument("--no-sessions", action="store_true")
    a = ap.parse_args(argv)

    cfg = load_update_config(a.config or config_path())
    market = a.marketplace or cfg.get("marketplace")
    if not market:
        print(f"마켓 이름이 없다: --marketplace 또는 {a.config or config_path()}의 update.marketplace", file=sys.stderr)
        return 2
    if a.local_only:
        hosts: list[str] = []
    elif a.hosts is not None:
        hosts = [h for h in a.hosts.split(",") if h]
    else:
        hosts = cfg.get("hosts", [])

    shells = cfg.get("shells", {})
    reports = [update_machine(run, h, market, cfg.get("remote_claude", "claude"), detect_shell(run, h, shells))
               for h in [LOCAL, *hosts]]
    print(f"마켓 {market} 범위별 판(재시작해야 새 판이 적용된다)\n")
    print(render_table(reports))
    stale = [(r.host, i) for r in reports for i in r.stale()]
    if stale:
        print("\n옛 판이 남은 설치:")
        for host, i in stale:
            where = f"{i['scope']}:{folder_name(i['projectPath'])}" if i["projectPath"] else i["scope"]
            print(f"- {host} {plugin_name(i)} ({where}) {i['version']}")

    if not a.no_sessions:
        machines = {LOCAL: hostname(), **cfg.get("machines", {})}
        cli = mail_cli()
        argv_s = [cli, "status", "--json"]
        if cfg.get("mail_profile"):
            prof = [f"SWITCHBOARD_PROFILE={cfg['mail_profile']}"]
            if cli == "agent-mail":  # 옛 CLI는 옛 이름만 안다: 3단계에 제거
                prof.append(f"AGENT_MAIL_PROFILE={cfg['mail_profile']}")
            argv_s = ["env", *prof, *argv_s]
        r = run(LOCAL, argv_s)
        print()
        try:
            if r.code != 0:
                raise ValueError(last_line(r))
            old_sessions = stale_sessions(r.out, reports, machines, cfg.get("session_plugin", "switchboard"))
        except (ValueError, json.JSONDecodeError) as e:
            print(f"옛 판 세션: {cli} status를 못 읽어 건너뛴다({e})")
        else:
            print("옛 판으로 떠 있는 세션:" if old_sessions else "옛 판으로 떠 있는 세션: 없음")
            for s in old_sessions:
                print("  " + s)

    bad = bool(stale) or any(r.error or r.failed for r in reports)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
