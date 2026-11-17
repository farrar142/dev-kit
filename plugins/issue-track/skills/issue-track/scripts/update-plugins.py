#!/usr/bin/env python3
"""로컬과 원격 기계(ssh 별칭)에서 한 마켓의 플러그인을 갱신하고 기계×플러그인 버전 표를 찍는다.

    update-plugins.py [--config 경로] [--marketplace 이름] [--hosts 별칭,별칭 | --local-only]
                      [--no-sessions]

기계마다 차례로:
  1. `claude plugin marketplace update <마켓>`
  2. `claude plugin list --json`에서 `<이름>@<마켓>` 설치를 찾아 `claude plugin update <이름>@<마켓> --scope <scope>`.
     scope가 local·project면 그 설치의 projectPath 폴더에서 돈다.
  3. 다시 `claude plugin list --json`을 읽어 표를 만든다(바뀐 칸은 `옛→새`).
원격은 `ssh <별칭> '<명령>'`으로 돈다. 한 기계가 실패해도 나머지는 계속하고 표에 실패를 적는다.
reload·재시작은 하지 않는다.

그다음 「옛 판으로 떠 있는 세션」을 찾는다: `agent-mail status --json`(설정의 메일 프로필)에서 online이고
registered_at이 그 기계 세션 플러그인(기본 switchboard)의 lastUpdated보다 이른 세션. 세션의 machine 이름과
ssh 별칭이 다르면 설정 update.machines로 잇는다(기본: 로컬은 hostname, 원격은 별칭 그대로).
agent-mail이 없거나 실패하면 그 표는 건너뛴다고만 찍는다.

설정: ~/.config/dev-kit/issue-track.json(환경변수 DEV_KIT_CONFIG로 바꾼다)의 update 절.
예시는 이 스킬 폴더의 issue-track.example.json.

종료 코드: 0 모두 성공 / 1 한 기계·플러그인이라도 실패 / 2 설정 오류(마켓 이름 없음 등).
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import socket
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Protocol, TypedDict

LOCAL = "local"
JSON = dict[str, "JSON"] | list["JSON"] | str | int | float | bool | None


@dataclass
class Result:
    code: int
    out: str
    err: str


class Runner(Protocol):
    def __call__(self, host: str, argv: list[str], cwd: str | None = None) -> Result: ...


def run_cmd(host: str, argv: list[str], cwd: str | None = None) -> Result:
    """host가 LOCAL이면 여기서, 아니면 `ssh <host> '<cd 폴더 &&> 명령'`으로 돌린다."""
    env = os.environ.copy()
    # 부른 세션의 역할이 설정의 프로필과 어긋나면 agent-mail이 거절한다.
    env.pop("AGENT_MAIL_ROLE", None)
    if host == LOCAL:
        full, run_cwd = argv, cwd
    else:
        line = shlex.join(argv)
        if cwd:
            line = f"cd {shlex.quote(cwd)} && {line}"
        full, run_cwd = ["ssh", "-o", "BatchMode=yes", host, line], None
    try:
        p = subprocess.run(full, cwd=run_cwd, env=env, capture_output=True, text=True, timeout=600)
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
    return cfg


def last_line(r: Result) -> str:
    lines = [l.strip() for l in (r.err + "\n" + r.out).splitlines() if l.strip()]
    return lines[-1][:120] if lines else f"종료 코드 {r.code}"


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


def install_key(i: Install) -> str:
    """같은 플러그인이 user와 local에 따로 깔릴 수 있어 표의 줄 이름에 scope·폴더를 붙인다."""
    name = i["id"].rsplit("@", 1)[0]
    if i["scope"] in ("user", "managed"):
        return name
    return f"{name} ({i['scope']}:{os.path.basename(i['projectPath'].rstrip('/')) or '?'})"


@dataclass
class MachineReport:
    host: str
    error: str | None
    before: dict[str, str]
    after: list[Install]
    failed: dict[str, str]


def list_installs(run: Runner, host: str, market: str) -> list[Install] | str:
    r = run(host, ["claude", "plugin", "list", "--json"])
    if r.code != 0:
        return f"plugin list 실패: {last_line(r)}"
    try:
        return parse_installs(r.out, market)
    except json.JSONDecodeError:
        return "plugin list 출력이 JSON이 아님"


def update_machine(run: Runner, host: str, market: str) -> MachineReport:
    r = run(host, ["claude", "plugin", "marketplace", "update", market])
    if r.code != 0:
        return MachineReport(host, f"marketplace update 실패: {last_line(r)}", {}, [], {})
    before = list_installs(run, host, market)
    if isinstance(before, str):
        return MachineReport(host, before, {}, [], {})
    failed: dict[str, str] = {}
    for i in before:
        argv = ["claude", "plugin", "update", i["id"], "--scope", i["scope"]]
        cwd = i["projectPath"] if i["scope"] in ("local", "project") and i["projectPath"] else None
        u = run(host, argv, cwd)
        if u.code != 0:
            failed[install_key(i)] = last_line(u)
    after = list_installs(run, host, market)
    if isinstance(after, str):
        return MachineReport(host, after, {install_key(i): i["version"] for i in before}, [], failed)
    return MachineReport(host, None, {install_key(i): i["version"] for i in before}, after, failed)


def render_table(reports: list[MachineReport]) -> str:
    rows: list[str] = []
    for rep in reports:
        rows += [k for k in rep.before if k not in rows]
        rows += [install_key(i) for i in rep.after if install_key(i) not in rows]
    header = ["플러그인"] + [r.host for r in reports]
    table: list[list[str]] = [header]
    for row in sorted(rows):
        line = [row]
        for rep in reports:
            if rep.error:
                line.append("실패")
                continue
            now = {install_key(i): i["version"] for i in rep.after}
            old = rep.before.get(row)
            cell = now.get(row, "-")
            if row in rep.failed:
                cell = f"실패({cell})"
            elif old and cell != old:
                cell = f"{old}→{cell}"
            line.append(cell)
        table.append(line)
    widths = [max(len(r[c]) for r in table) for c in range(len(header))]
    out = ["  ".join(c.ljust(w) for c, w in zip(r, widths)).rstrip() for r in table]
    notes = [f"- {rep.host}: {rep.error}" for rep in reports if rep.error]
    notes += [f"- {rep.host} {k}: {v}" for rep in reports for k, v in rep.failed.items()]
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

    reports = [update_machine(run, h, market) for h in [LOCAL, *hosts]]
    print(f"마켓 {market} 갱신 결과(재시작해야 새 판이 적용된다)\n")
    print(render_table(reports))

    if not a.no_sessions:
        machines = {LOCAL: hostname(), **cfg.get("machines", {})}
        argv_s = ["agent-mail", "status", "--json"]
        if cfg.get("mail_profile"):
            argv_s = ["env", f"AGENT_MAIL_PROFILE={cfg['mail_profile']}", *argv_s]
        r = run(LOCAL, argv_s)
        print()
        try:
            if r.code != 0:
                raise ValueError(last_line(r))
            stale = stale_sessions(r.out, reports, machines, cfg.get("session_plugin", "switchboard"))
        except (ValueError, json.JSONDecodeError) as e:
            print(f"옛 판 세션: agent-mail status를 못 읽어 건너뛴다({e})")
        else:
            print("옛 판으로 떠 있는 세션:" if stale else "옛 판으로 떠 있는 세션: 없음")
            for s in stale:
                print("  " + s)

    bad = any(r.error or r.failed for r in reports)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
