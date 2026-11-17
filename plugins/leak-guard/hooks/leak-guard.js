// PreToolUse(Bash): 공개 저장소로 나가기 직전(git commit·git push·gh pr create/edit)에
// 올라갈 추가분만 검사해 비밀·내부 이름이 보이면 막는다(exit 2 + 이유).
//
// 검사 대상
//   - git commit : `git diff --cached` 의 + 줄(-a/--all 이면 `git diff` 도), 명령 글(커밋 메시지)
//   - git push   : 업스트림(없으면 원격 기본 브랜치, 그것도 없으면 원격에 없는 커밋) 대비 나갈 커밋들의 + 줄과 메시지
//   - gh pr create/edit : 명령 글(제목·본문 인자, heredoc 포함), --body-file 내용, create 는 나갈 커밋들도
// 패턴
//   1. 내장 일반 패턴(BUILTIN)
//   2. 사용자 금지어 파일(저장소 밖): LEAK_GUARD_PATTERNS, 없으면 $XDG_CONFIG_HOME/leak-guard/patterns.txt
//      (XDG_CONFIG_HOME 이 없으면 ~/.config). 한 줄 하나 정규식, `#` 로 시작하면 주석, 대소문자 무시.
// 예외: 걸린 줄에 `leak-guard:allow` 가 있으면 그 줄은 넘긴다.
// 공개 저장소일 때만 검사한다(`gh repo view --json visibility`, 원격 URL 별 캐시, TTL LEAK_GUARD_TTL 초, 기본 86400).
// 판별이 안 되면 검사한다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ALLOW_MARK = 'leak-guard:allow';

const BUILTIN = [
  ['cgnat-ip', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{22,}/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['slack-webhook', /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['stripe-live-key', /\b[rs]k_live_[0-9A-Za-z]{24,}/],
];

const MAX_FINDINGS = 10;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

function patternsFile() {
  if (process.env.LEAK_GUARD_PATTERNS) return process.env.LEAK_GUARD_PATTERNS;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'leak-guard', 'patterns.txt');
}

// 사용자 패턴을 읽는다. 정규식 오류는 { error } 로 돌려 막는 쪽에서 알린다(보안 경계라 조용히 넘기지 않는다).
function loadUserPatterns() {
  const file = patternsFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { patterns: [] };
  }
  const patterns = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const src = lines[i].trim();
    if (!src || src.startsWith('#')) continue;
    try {
      patterns.push([`${path.basename(file)}:${i + 1}`, new RegExp(src, 'i')]);
    } catch (e) {
      return { error: `${file}:${i + 1} 의 정규식이 잘못됐습니다(${e.message}). 그 줄을 고치거나 # 로 주석 처리하세요.` };
    }
  }
  return { patterns };
}

function mask(v) {
  return v.length <= 4 ? '*'.repeat(v.length) : `${v.slice(0, 2)}${'*'.repeat(3)}(${v.length}자)`;
}

function scanLine(text, where, patterns, findings) {
  if (text.includes(ALLOW_MARK)) return;
  for (const [name, re] of patterns) {
    const m = re.exec(text);
    if (m) {
      findings.push(`${where} — ${name} [${mask(m[0])}]`);
      return;
    }
  }
}

function scanText(text, label, patterns, findings) {
  text.split(/\r?\n/).forEach((l, i) => scanLine(l, `${label}:${i + 1}`, patterns, findings));
}

// unified diff(여러 커밋의 `git log -p` 도)에서 + 줄만 파일:줄로 검사한다.
function scanPatch(patch, patterns, findings, prefix = '') {
  let file = '?';
  let line = 0;
  let commit = '';
  for (const l of patch.split('\n')) {
    if (l.startsWith('\x01')) {
      commit = l.slice(1, 8) + ' ';
    } else if (l.startsWith('+++ ')) {
      file = l.slice(4).replace(/^b\//, '');
    } else if (l.startsWith('@@')) {
      const m = /\+(\d+)/.exec(l);
      line = m ? Number(m[1]) : 0;
    } else if (l.startsWith('+')) {
      scanLine(l.slice(1), `${prefix}${commit}${file}:${line}`, patterns, findings);
      line++;
    } else if (l.startsWith(' ')) {
      line++;
    }
  }
}

function resolveRef(cwd, ref) {
  const out = git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return out ? out.trim() : null;
}

// 나갈 커밋 범위의 제외 목록: 업스트림 → 원격 기본 브랜치 → 원격에 있는 모든 것.
function outgoingExcludes(cwd, tip, branch) {
  if (branch) {
    const up = resolveRef(cwd, `${branch}@{upstream}`);
    if (up) return [up];
  }
  const remoteHead = git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  for (const ref of [remoteHead && remoteHead.trim(), 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    if (ref && resolveRef(cwd, ref)) return [ref];
  }
  return ['--remotes'];
}

function scanOutgoing(cwd, tipRef, patterns, findings) {
  const tip = resolveRef(cwd, tipRef);
  if (!tip) return;
  let branch = null;
  const sym = git(cwd, ['rev-parse', '--symbolic-full-name', tipRef]);
  if (sym && sym.trim().startsWith('refs/heads/')) branch = sym.trim().slice('refs/heads/'.length);
  const excludes = outgoingExcludes(cwd, tip, branch);
  const range = [tip, '--not', ...excludes];
  const msgs = git(cwd, ['log', '--format=%x01%H%n%B', ...range]);
  if (msgs) {
    let commit = '';
    let n = 0;
    for (const l of msgs.split('\n')) {
      if (l.startsWith('\x01')) {
        commit = l.slice(1, 8);
        n = 0;
        continue;
      }
      n++;
      scanLine(l, `커밋 ${commit} 메시지:${n}`, patterns, findings);
    }
  }
  const patch = git(cwd, ['log', '-p', '--no-color', '--no-ext-diff', '--format=%x01%H', ...range]);
  if (patch) scanPatch(patch, patterns, findings);
}

// 명령에서 git·gh 가 돌 디렉터리를 찾는다: 앞선 `cd X`, `git -C X`.
function findDir(cmd, idx, baseCwd) {
  let dir = baseCwd;
  const before = cmd.slice(0, idx);
  const re = /(?:^|[;&|\n(]\s*)cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)/g;
  let m;
  while ((m = re.exec(before))) {
    dir = path.resolve(dir, nativePath(unquote(m[1])));
  }
  return dir;
}

function unquote(s) {
  return s.replace(/^["']|["']$/g, '');
}

// `~/x`, Windows Git Bash 의 `/c/x` 를 node 가 아는 경로로.
function nativePath(d) {
  if (d.startsWith('~')) return path.join(os.homedir(), d.slice(1));
  const m = process.platform === 'win32' && /^\/([a-zA-Z])(?:\/(.*))?$/.exec(d);
  return m ? `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}` : d;
}

// 트리거를 찾는다. 반환: [{ kind, dir, args }]
function findTriggers(cmd, cwd) {
  const out = [];
  const gitRe = /\bgit((?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+(commit|push)\b([^\n;&|]*)/g;
  let m;
  while ((m = gitRe.exec(cmd))) {
    let dir = findDir(cmd, m.index, cwd);
    const c = /-C\s+("[^"]*"|'[^']*'|\S+)/.exec(m[1]);
    if (c) dir = path.resolve(dir, nativePath(unquote(c[1])));
    out.push({ kind: m[2], dir, args: m[3] });
  }
  const ghRe = /\bgh\s+pr\s+(create|edit)\b/g;
  while ((m = ghRe.exec(cmd))) {
    out.push({ kind: `pr-${m[1]}`, dir: findDir(cmd, m.index, cwd), args: cmd.slice(m.index) });
  }
  return out;
}

function cacheFile() {
  const base = process.env.LEAK_GUARD_CACHE_DIR || path.join(os.homedir(), '.cache', 'leak-guard');
  return path.join(base, 'visibility.json');
}

// 'PUBLIC' | 'PRIVATE' | 'INTERNAL' | null(모름)
function visibility(dir) {
  const remote = git(dir, ['remote', 'get-url', 'origin']);
  const key = remote ? remote.trim() : null;
  const ttl = (Number(process.env.LEAK_GUARD_TTL) || 86400) * 1000;
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {}
  if (key && cache[key] && Date.now() - cache[key].at < ttl) return cache[key].v;
  const r = spawnSync('gh', ['repo', 'view', '--json', 'visibility', '-q', '.visibility'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  });
  const v = r.status === 0 ? (r.stdout || '').trim().toUpperCase() : '';
  if (!['PUBLIC', 'PRIVATE', 'INTERNAL'].includes(v)) return null;
  if (key) {
    cache[key] = { v, at: Date.now() };
    try {
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
      fs.writeFileSync(cacheFile(), JSON.stringify(cache));
    } catch {}
  }
  return v;
}

function check(cmd, cwd) {
  const triggers = findTriggers(cmd, cwd);
  if (!triggers.length) return null;
  const findings = [];
  let user = null;
  for (const t of triggers) {
    if (git(t.dir, ['rev-parse', '--git-dir']) === null) continue;
    const vis = visibility(t.dir);
    if (vis === 'PRIVATE' || vis === 'INTERNAL') continue;
    if (!user) {
      user = loadUserPatterns();
      if (user.error) return `leak-guard: ${user.error}`;
    }
    const patterns = [...BUILTIN, ...user.patterns];
    if (t.kind === 'commit') {
      scanPatch(git(t.dir, ['diff', '--cached', '--no-color', '--no-ext-diff']) || '', patterns, findings);
      if (/(?:^|\s)(?:--all|-[a-zA-Z]*a[a-zA-Z]*)(?=\s|$)/.test(t.args)) {
        scanPatch(git(t.dir, ['diff', '--no-color', '--no-ext-diff']) || '', patterns, findings);
      }
      scanText(cmd, '명령', patterns, findings);
    } else if (t.kind === 'push') {
      const words = t.args.trim().split(/\s+/).filter((w) => w && !w.startsWith('-'));
      let tipRef = 'HEAD';
      if (words.length >= 2) {
        const src = words[1].replace(/^\+/, '').split(':')[0];
        if (src && resolveRef(t.dir, src)) tipRef = src;
      }
      scanOutgoing(t.dir, tipRef, patterns, findings);
    } else {
      scanText(cmd, '명령', patterns, findings);
      const bf = /(?:--body-file|-F)[\s=]+("[^"]*"|'[^']*'|\S+)/.exec(t.args);
      if (bf && unquote(bf[1]) !== '-') {
        const f = path.resolve(t.dir, unquote(bf[1]));
        try {
          scanText(fs.readFileSync(f, 'utf8'), path.basename(f), patterns, findings);
        } catch {}
      }
      if (t.kind === 'pr-create') scanOutgoing(t.dir, 'HEAD', patterns, findings);
    }
  }
  const uniq = [...new Set(findings)];
  if (!uniq.length) return null;
  const shown = uniq.slice(0, MAX_FINDINGS).map((f) => `  - ${f}`);
  if (uniq.length > MAX_FINDINGS) shown.push(`  - … 외 ${uniq.length - MAX_FINDINGS}건`);
  return [
    'leak-guard: 공개 저장소로 나갈 내용에 비밀·내부 이름으로 보이는 것이 있어 막았습니다(값은 가렸습니다).',
    ...shown,
    '고칠 법: 그 값을 지우거나 환경변수·저장소 밖 설정으로 옮기고, 이미 커밋했다면 커밋을 고친 뒤(amend·rebase) 다시 하세요.',
    `오탐이고 정말 공개해도 되는 값이면 그 줄에 \`${ALLOW_MARK}\` 표시를 남기세요(검토자에게 보입니다).`,
  ].join('\n');
}

module.exports = { check, BUILTIN };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      process.exit(0);
    }
    const cmd = (input.tool_input && input.tool_input.command) || '';
    if (!/\bgit\b|\bgh\b/.test(cmd)) process.exit(0);
    const reason = check(cmd, input.cwd || process.cwd());
    if (!reason) process.exit(0);
    process.stderr.write(reason + '\n');
    process.exit(2);
  });
}
