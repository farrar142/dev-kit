// PreToolUse(Bash): 공개 저장소로 나가기 직전(git commit·git push·gh pr create/edit)에
// 올라갈 추가분만 검사해 비밀·내부 이름이 보이면 막는다(exit 2 + 이유).
//
// 검사 대상
//   - git commit : `git diff --cached` 의 + 줄(-a/--all 이면 `git diff` 도), 그 명령의 인자(-m 메시지 등),
//                  -F/--file/-t 파일 내용(`-F -` 면 heredoc·here-string)
//   - git push   : 업스트림(없으면 원격 기본 브랜치, 그것도 없으면 원격에 없는 커밋) 대비 나갈 커밋들의 + 줄과 메시지
//   - gh pr create/edit : 그 명령의 인자(제목·본문, `$(cat <<EOF …)` 포함), --body-file 내용, create 는 나갈 커밋들도
// 명령 글은 셸 문법대로 단순 명령으로 나눠 그 git·gh 명령의 인자만 본다(cd 경로·환경변수·다른 명령은 보지 않는다).
// 읽지 못하거나(닫히지 않은 따옴표 등) 트리거 꼴이 실행 자리에 있는데 설명이 안 되면($(git commit …) 등) 명령 글 전체를 본다.
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

// ── 셸 명령 읽기 ──
// 명령 글을 단순 명령으로 나눈다. 돌려주는 것: { cmds, data }
//   cmds: [{ start, words: [{ value, start }], heredocs: [본문] }]  (value 는 따옴표를 벗긴 값, `$(…)` 는 날 글 그대로)
//   data: [[시작, 끝)] — 작은따옴표 안·큰따옴표의 글자 부분·heredoc 본문처럼 실행되지 않는 글의 자리
// 닫히지 않은 따옴표·치환·heredoc 이면 null — 부른 쪽은 명령 글 전체를 검사한다(fail-closed).
const META = ' \t\n;&|()<>';

// `$(` 바로 뒤(i)부터 짝 `)` 다음 자리를 찾는다. 안의 따옴표·heredoc 은 data 로 적는다. 못 찾으면 -1.
function skipSubst(s, i, data) {
  let depth = 1;
  const pending = [];
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) return -1;
      data.push([i + 1, e]);
      i = e + 1;
    } else if (ch === '"') {
      const e = readDouble(s, i + 1, data, null);
      if (e < 0) return -1;
      i = e;
    } else if (ch === '`') {
      const e = s.indexOf('`', i + 1);
      if (e < 0) return -1;
      i = e + 1;
    } else if (s.startsWith('<<', i) && s[i + 2] !== '<') {
      const h = readDelim(s, i + 2);
      if (!h) return -1;
      pending.push(h);
      i = h.end;
    } else if (ch === '\n' && pending.length) {
      const r = readBodies(s, i, pending.splice(0), data);
      if (!r) return -1;
      i = r.pos;
    } else if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      if (--depth === 0) return i + 1;
      i++;
    } else {
      i++;
    }
  }
  return -1;
}

// 큰따옴표 안(i 는 여는 `"` 다음)을 읽어 닫는 `"` 다음 자리를 돌려준다. out 이 있으면 값을 쌓는다.
function readDouble(s, i, data, out) {
  let lit = i;
  const flush = (at) => at > lit && data.push([lit, at]);
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      flush(i);
      return i + 1;
    }
    if (ch === '\\') {
      const n = s[i + 1];
      if (out && n !== '\n') out.v += '$`"\\'.includes(n) ? n : ch + (n || '');
      i += 2;
    } else if (s.startsWith('$(', i) || ch === '`') {
      flush(i);
      const e = ch === '`' ? s.indexOf('`', i + 1) + 1 : skipSubst(s, i + 2, data);
      if (e <= 0) return -1;
      if (out) out.v += s.slice(i, e);
      i = lit = e;
    } else {
      if (out) out.v += ch;
      i++;
    }
  }
  return -1;
}

// `<<` 다음(i)에서 구분자를 읽는다: { delim, strip, end }
function readDelim(s, i) {
  let strip = false;
  if (s[i] === '-') {
    strip = true;
    i++;
  }
  while (s[i] === ' ' || s[i] === '\t') i++;
  let delim = '';
  while (i < s.length && !META.includes(s[i])) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      const e = s.indexOf(ch, i + 1);
      if (e < 0) return null;
      delim += s.slice(i + 1, e);
      i = e + 1;
    } else if (ch === '\\') {
      delim += s[i + 1] || '';
      i += 2;
    } else {
      delim += ch;
      i++;
    }
  }
  return delim ? { delim, strip, end: i } : null;
}

// 줄바꿈 자리(nl) 뒤의 heredoc 본문들을 읽는다: { pos, bodies } 또는 null
function readBodies(s, nl, list, data) {
  let pos = nl + 1;
  const bodies = [];
  for (const h of list) {
    const from = pos;
    for (;;) {
      if (pos > s.length) return null;
      let e = s.indexOf('\n', pos);
      if (e < 0) e = s.length;
      const line = s.slice(pos, e).replace(/\r$/, '');
      if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) {
        data.push([from, pos]);
        bodies.push(s.slice(from, pos));
        pos = e + 1;
        break;
      }
      pos = e + 1;
    }
  }
  return { pos: Math.min(pos, s.length), bodies };
}

function parseCommands(s) {
  const cmds = [];
  const data = [];
  let cur = null;
  let word = null;
  let pending = []; // { delim, strip, cmd }
  let target = null; // 'redir' | 'here' — 다음 낱말을 인자로 넣지 않는다
  const open = (at) => {
    if (!cur) cur = { start: at, words: [], heredocs: [] };
  };
  const begin = (at) => {
    open(at);
    if (!word) word = { v: '', start: at };
  };
  const endWord = () => {
    if (!word) return;
    if (target === 'here') cur.heredocs.push(word.v);
    else if (target !== 'redir') cur.words.push({ value: word.v, start: word.start });
    target = null;
    word = null;
  };
  const endCmd = () => {
    endWord();
    if (cur) cmds.push(cur);
    cur = null;
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") {
      begin(i);
      const e = s.indexOf("'", i + 1);
      if (e < 0) return null;
      data.push([i + 1, e]);
      word.v += s.slice(i + 1, e);
      i = e + 1;
    } else if (ch === '"') {
      begin(i);
      const e = readDouble(s, i + 1, data, word);
      if (e < 0) return null;
      i = e;
    } else if (ch === '\\') {
      if (s[i + 1] !== '\n') {
        begin(i);
        word.v += s[i + 1] || '';
      }
      i += 2;
    } else if (s.startsWith('$(', i) || ch === '`') {
      begin(i);
      const e = ch === '`' ? s.indexOf('`', i + 1) + 1 : skipSubst(s, i + 2, data);
      if (e <= 0) return null;
      word.v += s.slice(i, e);
      i = e;
    } else if (ch === '#' && !word) {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (s.startsWith('<<<', i)) {
      endWord();
      open(i);
      target = 'here';
      i += 3;
    } else if (s.startsWith('<<', i)) {
      endWord();
      open(i);
      const h = readDelim(s, i + 2);
      if (!h) return null;
      pending.push({ ...h, cmd: cur });
      i = h.end;
    } else if (ch === '<' || ch === '>' || (ch === '&' && s[i + 1] === '>')) {
      if (word && /^\d+$/.test(word.v)) word = null; // 2>&1 의 2
      endWord();
      open(i);
      i++;
      while (i < s.length && '<>&|'.includes(s[i])) i++;
      const fd = /^(?:\d+|-)(?=[\s;&|)]|$)/.exec(s.slice(i)); // >&2, <&-
      if (fd) i += fd[0].length;
      else target = 'redir';
    } else if (ch === '\n') {
      const owner = cur;
      endCmd();
      if (pending.length) {
        const r = readBodies(s, i, pending, data);
        if (!r) return null;
        pending.forEach((h, k) => (h.cmd || owner).heredocs.push(r.bodies[k]));
        pending = [];
        i = r.pos;
      } else {
        i++;
      }
    } else if (';&|()'.includes(ch)) {
      endCmd();
      i++;
    } else if (ch === ' ' || ch === '\t') {
      endWord();
      i++;
    } else {
      begin(i);
      word.v += ch;
      i++;
    }
  }
  if (pending.length) return null;
  endCmd();
  return { cmds, data };
}

const LEAD = new Set(['{', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'command', 'exec', 'nohup', 'env', 'sudo']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

// 단순 명령의 낱말에서 트리거를 읽는다: { kind, at, gitC: [], args: [값] } | { shell, script } | null
function readTrigger(words, heredocs) {
  let k = 0;
  while (k < words.length && (LEAD.has(words[k].value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].value))) k++;
  if (k >= words.length) return null;
  const prog = path.basename(words[k].value);
  const rest = words.slice(k + 1).map((w) => w.value);
  if (prog === 'git') {
    const gitC = [];
    let j = 0;
    while (j < rest.length && rest[j].startsWith('-')) {
      if (rest[j] === '-C') gitC.push(rest[++j]);
      else if (rest[j] === '-c') j++;
      j++;
    }
    if (rest[j] === 'commit' || rest[j] === 'push') return { kind: rest[j], at: words[k].start, atEnd: words[k].start + words[k].value.length, gitC, args: rest.slice(j + 1) };
    return null;
  }
  if (prog === 'gh' && rest[0] === 'pr' && (rest[1] === 'create' || rest[1] === 'edit')) {
    return { kind: `pr-${rest[1]}`, at: words[k].start, atEnd: words[k].start + words[k].value.length, gitC: [], args: rest.slice(2) };
  }
  if (prog === 'eval') return { shell: true, script: rest.join(' ') };
  if (SHELLS.has(prog)) {
    const c = rest.indexOf('-c');
    if (c >= 0 && rest[c + 1] !== undefined) return { shell: true, script: rest[c + 1] };
    if (heredocs.length && !rest.some((w) => !w.startsWith('-'))) return { shell: true, script: heredocs.join('\n') };
  }
  return null;
}

// 옛 방식: 명령 글에서 트리거 꼴을 정규식으로 찾는다(파서가 설명하지 못한 것을 잡는 그물). [{ kind, dir, args, at }]
function regexTriggers(cmd, cwd) {
  const out = [];
  const gitRe = /\bgit((?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+(commit|push)\b([^\n;&|]*)/g;
  let m;
  while ((m = gitRe.exec(cmd))) {
    let dir = findDir(cmd, m.index, cwd);
    const c = /-C\s+("[^"]*"|'[^']*'|\S+)/.exec(m[1]);
    if (c) dir = path.resolve(dir, nativePath(unquote(c[1])));
    out.push({ kind: m[2], dir, at: m.index, args: m[3].trim().split(/\s+/).filter(Boolean) });
  }
  const ghRe = /\bgh\s+pr\s+(create|edit)\b/g;
  while ((m = ghRe.exec(cmd))) {
    out.push({ kind: `pr-${m[1]}`, dir: findDir(cmd, m.index, cwd), at: m.index, args: [] });
  }
  return out;
}

// 트리거를 찾는다. 반환: [{ kind, dir, args: [값], heredocs: [본문], whole?: 명령 글 }]
//   whole 이 있으면 나가는 부분을 가려내지 못한 것이라 그 명령 글 전체를 검사한다.
function findTriggers(cmd, cwd, depth = 0) {
  const loose = regexTriggers(cmd, cwd);
  if (!loose.length) return [];
  const parsed = depth < 3 ? parseCommands(cmd) : null;
  if (!parsed) return loose.map((t) => ({ ...t, heredocs: [], whole: cmd }));
  const out = [];
  const explained = [];
  for (const c of parsed.cmds) {
    const t = readTrigger(c.words, c.heredocs);
    if (!t) continue;
    if (t.shell) {
      out.push(...findTriggers(t.script, findDir(cmd, c.start, cwd), depth + 1));
      continue;
    }
    let dir = findDir(cmd, c.start, cwd);
    for (const d of t.gitC) dir = path.resolve(dir, nativePath(d));
    explained.push([t.at, t.atEnd]);
    out.push({ kind: t.kind, dir, args: t.args, heredocs: c.heredocs });
  }
  const within = (spans, at) => spans.some(([a, b]) => at >= a && at < b);
  for (const t of loose) {
    if (!within(explained, t.at) && !within(parsed.data, t.at)) out.push({ ...t, heredocs: [], whole: cmd });
  }
  return out;
}

// 나가는 글을 모은다: [[이름, 글]]. 파일 경로 인자는 빼고 그 파일 내용을 넣는다.
// stdin(`-`)인데 heredoc·here-string 이 없으면 무엇이 들어올지 모르니 명령 글 전체를 넣는다(fail-closed).
//   fileOpts: 값이 파일 경로인 선택지, valueOpts: 값을 받는 짧은 선택지 글자(뭉친 `-am` 꼴을 풀 때)
function payload(t, label, fileOpts, shortWithValue, cmd) {
  const out = [];
  const readFile = (f) => {
    if (f === '-') {
      if (t.heredocs.length) t.heredocs.forEach((h) => out.push([label, h]));
      else out.push(['명령', cmd]);
      return;
    }
    const abs = path.resolve(t.dir, nativePath(f));
    try {
      out.push([path.basename(abs), fs.readFileSync(abs, 'utf8')]);
    } catch {}
  };
  const a = t.args;
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    const eq = /^(--[\w-]+)=([\s\S]*)$/.exec(w);
    if (eq && fileOpts.includes(eq[1])) {
      readFile(eq[2]);
    } else if (fileOpts.includes(w)) {
      if (i + 1 < a.length) readFile(a[++i]);
    } else if (/^-[A-Za-z]/.test(w) && !w.startsWith('--')) {
      // 뭉친 짧은 선택지: 값을 받는 글자가 나오면 나머지(없으면 다음 낱말)가 그 값
      let j = 1;
      while (j < w.length && !shortWithValue.includes(w[j])) j++;
      if (j >= w.length) continue;
      const v = j + 1 < w.length ? w.slice(j + 1) : a[++i];
      if (v === undefined) continue;
      if (fileOpts.includes(`-${w[j]}`)) readFile(v);
      else out.push([label, v]);
    } else {
      out.push([label, w]);
    }
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

const COMMIT_FILE_OPTS = ['-F', '--file', '-t', '--template'];
const COMMIT_SHORT_VALUE = 'mFtcC';
const PR_FILE_OPTS = ['-F', '--body-file'];
const PR_SHORT_VALUE = 'tbFBHTRalmpr';

// commit 의 -a/--all(뭉친 `-am` 도). 값 받는 글자 뒤의 a 는 값이라 보지 않는다.
function commitAll(args) {
  return args.some((w) => {
    if (w === '--all') return true;
    if (!/^-[A-Za-z]+$/.test(w)) return false;
    for (const ch of w.slice(1)) {
      if (ch === 'a') return true;
      if (COMMIT_SHORT_VALUE.includes(ch)) return false;
    }
    return false;
  });
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
    const scanAll = (texts) => texts.forEach(([label, text]) => scanText(text, label, patterns, findings));
    if (t.whole) scanAll([['명령', t.whole]]);
    if (t.kind === 'commit') {
      scanPatch(git(t.dir, ['diff', '--cached', '--no-color', '--no-ext-diff']) || '', patterns, findings);
      if (commitAll(t.args)) {
        scanPatch(git(t.dir, ['diff', '--no-color', '--no-ext-diff']) || '', patterns, findings);
      }
      if (!t.whole) scanAll(payload(t, '커밋 메시지', COMMIT_FILE_OPTS, COMMIT_SHORT_VALUE, cmd));
    } else if (t.kind === 'push') {
      const words = t.args.filter((w) => w && !w.startsWith('-'));
      let tipRef = 'HEAD';
      if (words.length >= 2) {
        const src = words[1].replace(/^\+/, '').split(':')[0];
        if (src && resolveRef(t.dir, src)) tipRef = src;
      }
      scanOutgoing(t.dir, tipRef, patterns, findings);
    } else {
      if (!t.whole) scanAll(payload(t, 'PR 제목·본문', PR_FILE_OPTS, PR_SHORT_VALUE, cmd));
      else {
        const bf = /(?:--body-file|-F)[\s=]+("[^"]*"|'[^']*'|\S+)/.exec(t.whole.slice(t.at));
        if (bf && unquote(bf[1]) !== '-') {
          const f = path.resolve(t.dir, unquote(bf[1]));
          try {
            scanText(fs.readFileSync(f, 'utf8'), path.basename(f), patterns, findings);
          } catch {}
        }
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
