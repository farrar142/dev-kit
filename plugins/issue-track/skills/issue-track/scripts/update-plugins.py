#!/usr/bin/env python3
"""로컬과 원격 기계(ssh 별칭)에서 한 마켓의 플러그인을 모든 범위에서 갱신하고 범위별 판 표를 찍는다.

    update-plugins.py [--config 경로] [--marketplace 이름] [--hosts 별칭,별칭 | --local-only]
                      [--no-sessions(무시, 옛 호출용)]

기계마다 차례로:
  0. 원격 셸 판별: 설정 update.shells[별칭](posix·powershell), 없으면
     `ssh <별칭> 'echo $PSVersionTable.PSVersion.Major'`가 숫자를 돌려주면 powershell, 아니면 posix.
  1. `claude plugin marketplace update <마켓>`
  2. `claude plugin list --json`에서 `<이름>@<마켓>` 설치를 모두(user·project·local, 폴더마다) 찾아
     `claude plugin update <이름>@<마켓> --scope <scope>`. local·project는 그 설치의 projectPath 폴더에서 돈다.
     마켓 클론의 marketplace.json 에서 빠진 플러그인(마켓에서 지운 것)의 설치는 갱신하지 않고 표에서도 빼며,
     기계마다 한 줄(「마켓에 없어 건너뜀」)로 알린다. 설치 항목은 건드리지 않는다(지우기·끄기·켜기 없음).
  3. 다시 `claude plugin list --json`을 읽고, 그 기계의 마켓 클론(marketplace list의 installLocation)에서
     플러그인마다 최신 판(marketplace.json 항목의 version, 없으면 source 폴더의 .claude-plugin/plugin.json)을 읽어
     「범위별 판」 표(기계·플러그인·범위·폴더·판·최신·상태)를 만든다. 최신 판을 못 읽으면 그 기계에 깔린 가장 높은 판.
원격 명령: posix는 `ssh <별칭> 'cd <폴더> && PATH="$HOME/.local/bin:$PATH" claude …'`,
powershell은 `ssh <별칭> "Set-Location -LiteralPath '<폴더>' -ErrorAction Stop; claude …; exit $LASTEXITCODE"`.
한 기계가 실패해도 나머지는 계속한다. reload·재시작은 하지 않는다.

세션 플러그인(switchboard)은 이 마켓이 아니라 switchboard CLI 가 깐다. 그 판과 옛 판 세션은
`switchboard plugin status`·`switchboard status`(세션마다 cli_version)가 말하므로 이 스크립트는 보지 않는다.

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
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol, TypedDict

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


def run_cmd(host: str, argv: list[str], cwd: str | None = None, shell: str = POSIX) -> Result:
    """host가 LOCAL이면 여기서, 아니면 `ssh <host> '<원격 셸 한 줄>'`으로 돌린다."""
    env = os.environ.copy()
    # 부른 세션의 역할이 설정의 프로필과 어긋나면 switchboard CLI가 거절한다.
    env.pop("SWITCHBOARD_ROLE", None)
    env.pop("AGENT_MAIL_ROLE", None)  # 옛 이름. 3단계에 제거
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
    installPath: str


class UpdateConfig(TypedDict, total=False):
    marketplace: str
    hosts: list[str]
    remote_claude: str
    shells: dict[str, str]
    skill_copy: str
    agent_copy: str


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
    if isinstance(sect.get("remote_claude"), str) and sect["remote_claude"]:
        cfg["remote_claude"] = str(sect["remote_claude"])
    if isinstance(sect.get("skill_copy"), str) and sect["skill_copy"]:
        cfg["skill_copy"] = str(sect["skill_copy"])
    if isinstance(sect.get("agent_copy"), str) and sect["agent_copy"]:
        cfg["agent_copy"] = str(sect["agent_copy"])
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
            installPath=str(e.get("installPath") or ""),
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
    gone: list[Install] = field(default_factory=list)  # 마켓에서 빠진 플러그인의 설치(갱신하지 않음)

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


def market_manifest(run: Runner, host: str, market: str, claude: str, shell: str) -> tuple[str, list[JSON]] | None:
    """그 기계의 마켓 클론 폴더와 marketplace.json 의 plugins 항목. 못 읽으면 None."""
    r = run(host, [claude, "plugin", "marketplace", "list", "--json"], shell=shell)
    if r.code != 0:
        return None
    try:
        markets: JSON = json.loads(r.out)
    except json.JSONDecodeError:
        return None
    loc = next((str(m.get("installLocation") or "") for m in markets
                if isinstance(m, dict) and m.get("name") == market), "") if isinstance(markets, list) else ""
    if not loc:
        return None
    root = loc.rstrip("\\/")
    manifest = read_json(run, host, f"{root}/.claude-plugin/marketplace.json", shell)
    entries = manifest.get("plugins") if isinstance(manifest, dict) else None
    if not isinstance(entries, list):
        return None
    return root, entries


def market_names(run: Runner, host: str, market: str, claude: str, shell: str) -> set[str] | None:
    """마켓 클론에 있는 플러그인 이름. 못 읽으면 None(그때는 아무것도 건너뛰지 않는다)."""
    m = market_manifest(run, host, market, claude, shell)
    if m is None:
        return None
    return {str(e["name"]) for e in m[1] if isinstance(e, dict) and isinstance(e.get("name"), str)}


def market_latest(run: Runner, host: str, market: str, claude: str, shell: str,
                  names: list[str]) -> dict[str, str]:
    """그 기계의 마켓 클론에서 플러그인마다 최신 판. 못 읽은 이름은 빠진다."""
    m = market_manifest(run, host, market, claude, shell)
    if m is None:
        return {}
    root, entries = m
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
    # 마켓에서 지운 플러그인의 설치(꺼진 옛 항목 등)는 갱신 명령을 보내지 않는다: 마켓에 없어 실패할 뿐이다.
    known = market_names(run, host, market, claude, shell)
    gone = [i for i in before if known is not None and plugin_name(i) not in known]
    gone_keys = {ikey(i) for i in gone}
    before = [i for i in before if ikey(i) not in gone_keys]
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
        return MachineReport(host, after, old, [], failed, shell, gone=gone)
    after = [i for i in after if ikey(i) not in gone_keys]
    names = sorted({plugin_name(i) for i in after})
    latest = market_latest(run, host, market, claude, shell, names)
    for i in after:  # 마켓 클론에서 못 읽은 플러그인은 이 기계에 깔린 가장 높은 판
        n = plugin_name(i)
        if n not in latest or is_older(latest[n], i["version"]):
            latest[n] = i["version"]
    return MachineReport(host, None, old, after, failed, shell, latest, gone)


COPY_PLUGIN = "issue-track"
COPY_SKIP = ("__pycache__", ".pytest_cache", ".bak")  # 이 이름(.bak은 앞부분)의 폴더는 건드리지 않는다


def _skipped(rel: str) -> bool:
    return any(part == s or (s == ".bak" and part.startswith(s)) for part in rel.split(os.sep) for s in COPY_SKIP)


def _files(root: str) -> list[str]:
    out: list[str] = []
    for d, dirs, names in os.walk(root):
        rel_d = os.path.relpath(d, root)
        dirs[:] = [x for x in dirs if not _skipped(os.path.join(rel_d, x))]
        out += [os.path.normpath(os.path.join(rel_d, n)) for n in names]
    return sorted(out)


def sync_skill_copy(src: str, dst: str, version: str) -> tuple[list[str], list[str]]:
    """설치된 스킬 폴더 src를 손으로 둔 복사본 dst에 맞춘다(문서·스크립트·시험 통째, 달라진 파일만 덮어쓴다).
    dst에만 있는 파일은 지우지 않는다. dst/VERSION에 판을 적는다(스크립트가 자기 판을 알게).
    반환: (새로 쓴 파일, dst에만 있는 파일)."""
    written: list[str] = []
    mine = _files(src)
    for rel in mine:
        s, d = os.path.join(src, rel), os.path.join(dst, rel)
        data = open(s, "rb").read()
        if os.path.exists(d) and open(d, "rb").read() == data:
            continue
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copyfile(s, d)
        shutil.copymode(s, d)
        written.append(rel)
    vfile = os.path.join(dst, "VERSION")
    if not os.path.exists(vfile) or open(vfile, encoding="utf-8").read().strip() != version:
        with open(vfile, "w", encoding="utf-8") as f:
            f.write(version + "\n")
        written.append("VERSION")
    extra = [r for r in _files(dst) if r not in mine and r != "VERSION"]
    return written, extra


def skill_copy_dir(cfg: UpdateConfig) -> str:
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.expanduser(cfg.get("skill_copy") or os.path.join(base, "skills", COPY_PLUGIN))


def agent_copy_dir(cfg: UpdateConfig) -> str:
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.expanduser(cfg.get("agent_copy") or os.path.join(base, "agents"))


def _backup_path(path: str, today: str) -> str:
    bak = f"{path}.bak-{today}"
    n = 2
    while os.path.exists(bak):
        bak = f"{path}.bak-{today}-{n}"
        n += 1
    return bak


def sync_agent_copies(src_dir: str, dst_dir: str, today: str) -> list[str]:
    """플러그인 agents/*.md 중 dst_dir에 같은 이름이 있는 것만 맞춘다(없는 파일은 만들지 않는다).
    다르면 덮기 전에 <이름>.bak-<날짜> 사본을 남기고, 복사본에만 있던 줄을 알린다. 반환: 결과 줄."""
    out: list[str] = []
    if not os.path.isdir(src_dir) or not os.path.isdir(dst_dir):
        return out
    for name in sorted(n for n in os.listdir(src_dir) if n.endswith(".md")):
        s, d = os.path.join(src_dir, name), os.path.join(dst_dir, name)
        if not os.path.isfile(d):
            continue
        new, old = open(s, "rb").read(), open(d, "rb").read()
        if new == old:
            out.append(f"{name}: 이미 같다")
            continue
        bak = _backup_path(d, today)
        shutil.copyfile(d, bak)
        shutil.copyfile(s, d)
        src_lines = set(new.decode("utf-8", "replace").splitlines())
        only = [ln for ln in old.decode("utf-8", "replace").splitlines() if ln.strip() and ln not in src_lines]
        line = f"{name}: 맞춤(옛 복사본 → {os.path.basename(bak)})"
        if only:
            line += f", 복사본에만 있던 줄 {len(only)}개 — 플러그인에 들일 것인지 사본에서 확인:"
            line += "".join(f"\n    {ln.strip()[:100]}" for ln in only[:5])
        out.append(line)
    return out


def local_market_plugin(run: Runner, market: str, name: str) -> tuple[str, str] | None:
    """플러그인이 깔리지 않은 기계: 로컬 마켓 클론에서 그 플러그인 폴더와 판을 찾는다."""
    r = run(LOCAL, ["claude", "plugin", "marketplace", "list", "--json"])
    if r.code != 0:
        return None
    try:
        markets: JSON = json.loads(r.out)
    except json.JSONDecodeError:
        return None
    loc = next((str(m.get("installLocation") or "") for m in markets
                if isinstance(m, dict) and m.get("name") == market), "") if isinstance(markets, list) else ""
    if not loc:
        return None
    try:
        with open(os.path.join(loc, ".claude-plugin", "marketplace.json"), encoding="utf-8") as f:
            manifest: JSON = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    entries = manifest.get("plugins") if isinstance(manifest, dict) else None
    e = next((x for x in entries if isinstance(x, dict) and x.get("name") == name), None) \
        if isinstance(entries, list) else None
    src = e.get("source") if isinstance(e, dict) else None
    if not isinstance(src, str):
        return None
    root = os.path.normpath(os.path.join(loc, src[2:] if src.startswith("./") else src))
    version = e.get("version") if isinstance(e, dict) else None
    if not isinstance(version, str):
        try:
            with open(os.path.join(root, ".claude-plugin", "plugin.json"), encoding="utf-8") as f:
                pj: JSON = json.load(f)
        except (OSError, json.JSONDecodeError):
            return None
        version = pj.get("version") if isinstance(pj, dict) else None
    return (root, version) if isinstance(version, str) and os.path.isdir(root) else None


def copy_source(run: Runner, report: "MachineReport", market: str) -> tuple[str, str, str] | None:
    """손 복사본의 원본: (플러그인 폴더, 판, 어디서). 설치된 가장 높은 판, 없으면 로컬 마켓 클론."""
    cands = [i for i in report.after if plugin_name(i) == COPY_PLUGIN and i.get("installPath")
             and os.path.isdir(i["installPath"])]
    best = max(cands, key=lambda i: version_tuple(i["version"]) or (), default=None)
    if best:
        return best["installPath"], best["version"], "설치"
    found = local_market_plugin(run, market, COPY_PLUGIN)
    return (found[0], found[1], "마켓 클론") if found else None


def sync_local_copy(run: Runner, report: "MachineReport", cfg: UpdateConfig, market: str,
                    today: str) -> str | None:
    """로컬 기계의 손 복사본(스킬 폴더, 사용자 agents/의 같은 이름 에이전트)을 설치된 판에 맞추고 결과 줄을 돌려준다.
    플러그인이 깔리지 않았으면 로컬 마켓 클론을 원본으로 쓴다. 손 복사본이 하나도 없으면 None.
    (복사본 폴더는 기계끼리 동기화되므로 원격 기계는 따로 하지 않는다.)"""
    dst = skill_copy_dir(cfg)
    adir = agent_copy_dir(cfg)
    has_skill = os.path.isdir(dst)
    has_agent = os.path.isdir(adir)
    if not has_skill and not has_agent:
        return None
    found = copy_source(run, report, market)
    if not found:
        if not has_skill:
            return None
        return f"스킬 복사본 {dst}: 설치된 {COPY_PLUGIN}도 마켓 클론도 못 찾아 건너뛴다"
    root, version, where = found
    lines: list[str] = []
    src = os.path.join(root, "skills", COPY_PLUGIN)
    if has_skill:
        if not os.path.isdir(src):
            lines.append(f"스킬 복사본 {dst}: {where}({root})에 스킬 폴더가 없어 건너뛴다")
        else:
            try:
                written, extra = sync_skill_copy(src, dst, version)
                line = f"스킬 복사본 {dst}: {version} 판에 맞춤({where}) — " + (
                    f"{len(written)}개 갱신({', '.join(written)})" if written else "이미 같다")
                if extra:
                    line += f"\n  복사본에만 있는 파일(지우지 않음): {', '.join(extra)}"
                lines.append(line)
            except OSError as e:
                lines.append(f"스킬 복사본 {dst}: 맞추지 못했다({e})")
    try:
        agents = sync_agent_copies(os.path.join(root, "agents"), adir, today)
    except OSError as e:
        agents = [f"맞추지 못했다({e})"]
    if agents:
        lines.append(f"에이전트 복사본 {adir}: {version} 판({where})\n" + "\n".join(f"  {a}" for a in agents))
    return "\n".join(lines) or None


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
    gone = [f"- {rep.host}: {gone_line(rep.gone)}" for rep in reports if rep.gone]
    if gone:
        out += ["", "마켓에 없어 건너뜀(설치 항목은 그대로):"] + gone
    return "\n".join(out)


def gone_line(gone: list[Install]) -> str:
    """마켓에서 빠진 설치를 플러그인마다 「이름 N곳(범위…)」으로."""
    by: dict[str, list[str]] = {}
    for i in gone:
        by.setdefault(plugin_name(i), []).append(i["scope"])
    parts = []
    for name in sorted(by):
        scopes = by[name]
        kinds = ", ".join(f"{sc}×{scopes.count(sc)}" if scopes.count(sc) > 1 else sc for sc in sorted(set(scopes)))
        parts.append(f"{name} {len(scopes)}곳({kinds})")
    return ", ".join(parts)


def main(argv: list[str] | None = None, run: Runner = run_cmd) -> int:
    for stream in (sys.stdout, sys.stderr):  # Windows 로캘(cp949)에서 한국어 출력이 깨지지 않게
        reconf = getattr(stream, "reconfigure", None)
        if reconf:
            reconf(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--config", default=None)
    ap.add_argument("--marketplace", default=None)
    ap.add_argument("--hosts", default=None, help="쉼표로 나눈 ssh 별칭(설정보다 앞선다)")
    ap.add_argument("--local-only", action="store_true")
    ap.add_argument("--no-sessions", action="store_true", help="무시한다(옛 판 세션 표는 없어졌다, 옛 호출용)")
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

    copy_line = sync_local_copy(run, reports[0], cfg, market, datetime.now().strftime("%Y%m%d"))
    if copy_line:
        print("\n" + copy_line)

    bad = bool(stale) or any(r.error or r.failed for r in reports)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
