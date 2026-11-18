// PreToolUse(Bash): 고치기·넘기기 관문.
// gh pr create · gh issue create · agent-mail send · agent-mail reply 의 제목·본문이
// 버그·오류·장애·소음 수정으로 보이는데 `근본 원인:` 줄(또는 `## 근본 원인` 절)이 없으면 막는다(exit 2 + 고칠 법).
//
// 수정으로 보는 기준(잘못 막지 않는 쪽으로 좁게)
//   - 제목: fix:/fix(…):/hotfix/bugfix 꼴, 또는 문제 신호 낱말. 단 feat:·docs:·chore:·test:·refactor: 같은 머리말이나
//           「추가·도입·문서」 같은 기능 낱말이 있으면 신호 낱말은 보지 않는다.
//   - 본문: 문제 신호 바로 뒤(또는 영어면 앞)에 소음 동사가 붙은 구절(「오류를 경고로 낮췄다」「suppressed the error」).
//           메일은 수정 동사도 본다(「실패를 재시작으로 해결」「fixed the crash」).
// 통과
//   - `근본 원인:`/`Root cause:` 줄(빈 값 아님) 또는 `## 근본 원인`/`## Root cause` 절. 기능이면 `근본 원인: 해당 없음 — <까닭>`.
//   - 짧은 확인 메일: 본문 80자 이하 + 받음·확인·완료·접수 같은 낱말.
//   - 본문 파일을 못 읽거나 명령을 읽지 못하면 통과(관문이지 보안 경계가 아니다).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCommands } = require('./shell');
const { loadSignals, disabled, readStdin } = require('./signals');

const LEAD = new Set(['{', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'command', 'exec', 'nohup', 'env', 'sudo']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

function unquote(s) {
  return s.replace(/^["']|["']$/g, '');
}

// `~/x`, Windows Git Bash 의 `/c/x` 를 node 가 아는 경로로.
function nativePath(d) {
  if (d.startsWith('~')) return path.join(os.homedir(), d.slice(1));
  const m = process.platform === 'win32' && /^\/([a-zA-Z])(?:\/(.*))?$/.exec(d);
  return m ? `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}` : d;
}

function findDir(cmd, idx, baseCwd) {
  let dir = baseCwd;
  const re = /(?:^|[;&|\n(]\s*)cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)/g;
  let m;
  const before = cmd.slice(0, idx);
  while ((m = re.exec(before))) dir = path.resolve(dir, nativePath(unquote(m[1])));
  return dir;
}

const progName = (w) => path.basename(w).replace(/\.(exe|cmd|bat|ps1)$/i, '');

// 단순 명령 → { kind, args } | { shell, script } | null
function readTrigger(words, heredocs) {
  let k = 0;
  while (k < words.length && (LEAD.has(words[k].value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].value))) k++;
  if (k >= words.length) return null;
  const prog = progName(words[k].value);
  const rest = words.slice(k + 1).map((w) => w.value);
  if (prog === 'gh' && (rest[0] === 'pr' || rest[0] === 'issue') && rest[1] === 'create') {
    return { kind: `${rest[0]}-create`, args: rest.slice(2) };
  }
  if (prog === 'agent-mail') {
    let j = 0;
    while (j < rest.length && rest[j].startsWith('-')) {
      if (!rest[j].includes('=') && (rest[j] === '--profile' || rest[j] === '--role')) j++;
      j++;
    }
    if (rest[j] === 'send' || rest[j] === 'reply') return { kind: `mail-${rest[j]}`, args: rest.slice(j + 1) };
    return null;
  }
  if (prog === 'eval') return { shell: true, script: rest.join(' ') };
  if (SHELLS.has(prog)) {
    const c = rest.indexOf('-c');
    if (c >= 0 && rest[c + 1] !== undefined) return { shell: true, script: rest[c + 1] };
    if (heredocs.length && !rest.some((w) => !w.startsWith('-'))) return { shell: true, script: heredocs.join('\n') };
  }
  return null;
}

// [{ kind, args, heredocs, dir }]
function findTriggers(cmd, cwd, depth = 0) {
  if (depth > 3) return [];
  const parsed = parseCommands(cmd);
  if (!parsed) return [];
  const out = [];
  for (const c of parsed.cmds) {
    const t = readTrigger(c.words, c.heredocs);
    if (!t) continue;
    const dir = findDir(cmd, c.start, cwd);
    if (t.shell) out.push(...findTriggers(t.script, dir, depth + 1));
    else out.push({ ...t, heredocs: c.heredocs, dir });
  }
  return out;
}

const OPTS = {
  gh: { title: ['-t', '--title'], body: ['-b', '--body'], file: ['-F', '--body-file'] },
  mail: { title: ['--subject'], body: ['--body'], file: ['--body-file'] },
};

// { title, body, unreadable }
function readMessage(t) {
  const o = t.kind.startsWith('mail') ? OPTS.mail : OPTS.gh;
  const title = [];
  const body = [];
  let unreadable = false;
  let sawBody = false;
  const readFile = (f) => {
    sawBody = true;
    if (f === '-') {
      body.push(...t.heredocs);
      if (!t.heredocs.length) unreadable = true;
      return;
    }
    try {
      body.push(fs.readFileSync(path.resolve(t.dir, nativePath(f)), 'utf8'));
    } catch {
      unreadable = true;
    }
  };
  const a = t.args;
  for (let i = 0; i < a.length; i++) {
    let w = a[i];
    let v;
    const eq = /^(--[\w-]+)=([\s\S]*)$/.exec(w);
    if (eq) [w, v] = [eq[1], eq[2]];
    const want = o.title.includes(w) || o.body.includes(w) || o.file.includes(w);
    if (!want) continue;
    if (v === undefined) v = a[++i];
    if (v === undefined) continue;
    if (o.title.includes(w)) title.push(v);
    else if (o.body.includes(w)) {
      sawBody = true;
      body.push(v);
    } else readFile(v);
  }
  // agent-mail 은 본문이 없으면 stdin 을 읽는다
  if (!sawBody && t.kind.startsWith('mail')) {
    if (t.heredocs.length) body.push(...t.heredocs);
  }
  return { title: title.join('\n'), body: body.join('\n'), unreadable };
}

const ROOT_LINE = /^[ \t>*_-]*(?:\*\*|__)?(?:근본\s?원인|root[ -]?cause)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*\S.{1,}/im;
const ROOT_HEAD = /^#{1,6}\s*(?:근본\s?원인|root[ -]?cause)[^\n]*\n+\s*\S/im;
const hasRootCause = (text) => ROOT_LINE.test(text) || ROOT_HEAD.test(text);

const FIX_TITLE = /^\s*(?:\[[^\]]*\]\s*)*(?:(?:hot|bug)?fix(?:\([^)]*\))?!?\s*[:：]|hotfix\b|bugfix\b)|\bhotfix\b/i;
const NON_FIX_TITLE = /^\s*(?:\[[^\]]*\]\s*)*(?:feat|feature|docs?|chore|test|tests|refactor|style|build|ci|release)(?:\([^)]*\))?!?\s*[:：]/i;
const FEATURE_WORDS = /추가|도입|새로|신규|만들기|만듦|문서|안내|지원|감지|알림|표시|처리|조사|\bdocs?\b|\badd(?:s|ed)?\b|\bintroduce|\bdetect|\bhandl(?:e|ing)\b/i;
// 본문 구절: 문제 신호 바로 뒤(한국어)·앞(영어)의 동사.
//   소음 동사(경고로 낮춤·걸러냄·억제·무시·우회)는 모든 명령에서, 수정 동사(고쳤·해결·fixed)는 메일에서만 본다 —
//   PR 본문의 「시험 오류 1건도 고쳤다」 같은 곁가지까지 막지 않으려고.
const NOISE_AFTER = /경고로\s?낮|수준을?\s?낮|걸러\s?(?:냈|냄|내|낸|낼)|걸렀|억제|숨겼|숨김|무시하(?:도록|게)|무시했|우회|\bsuppress(?:ed)?\b|\bsilenc(?:e|ed)\b|\bmuted?\b|\bignored?\b|\bdowngrad/i;
const NOISE_BEFORE = /\b(?:suppress(?:ed|es|ing)?|silenc(?:e[sd]?|ing)|mut(?:e[sd]?|ing)|work(?:ed)? around|ignor(?:e[sd]?|ing)|downgrad(?:e[sd]?|ing)|filter(?:ed|ing)? out)\b[^\n.]{0,25}$/i;
const FIX_AFTER = /고쳤|고침|해결(?:했|함|됨|합니다|했습니다)|재시작으로|\bfixed\b|\bresolved\b/i;
const FIX_BEFORE = /\b(?:fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|patch(?:ed|es|ing)?)\b[^\n.]{0,25}$/i;
const ACK = /받음|받았|확인|완료|접수|알겠|알았|넵|감사|\bok\b|\back\b|\bdone\b|\bnoted\b/i;
const NEAR = 25;

function fixPhrase(body, signals, mail) {
  for (const [name, re] of signals) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(body))) {
      if (m[0] === '') {
        g.lastIndex++;
        continue;
      }
      const after = body.slice(m.index + m[0].length, m.index + m[0].length + NEAR).split(/[\n.。!?]/)[0];
      const before = body.slice(Math.max(0, m.index - NEAR), m.index).split(/[\n。!?]/).pop();
      const noise = NOISE_AFTER.test(after) || NOISE_BEFORE.test(before);
      const fix = mail && (FIX_AFTER.test(after) || FIX_BEFORE.test(before));
      if (noise || fix) return `${name}: 「${body.slice(Math.max(0, m.index - 8), m.index + m[0].length + 12).replace(/\s+/g, ' ').trim()}」`;
    }
  }
  return null;
}

// 수정으로 보이면 까닭 글, 아니면 null
function fixReason(title, body, signals, mail = false) {
  if (FIX_TITLE.test(title)) return `제목이 수정 꼴(${title.trim().slice(0, 60)})`;
  if (title && !NON_FIX_TITLE.test(title) && !FEATURE_WORDS.test(title)) {
    const hit = signals.find(([, re]) => re.test(title));
    if (hit) return `제목에 문제 신호 「${hit[0]}」`;
  }
  const p = body && fixPhrase(body, signals, mail);
  return p ? `본문에 수정 구절 ${p}` : null;
}

const LABEL = {
  'pr-create': 'gh pr create',
  'issue-create': 'gh issue create',
  'mail-send': 'agent-mail send',
  'mail-reply': 'agent-mail reply',
};

function check(cmd, cwd) {
  if (disabled()) return null;
  if (!/\bgh\b|agent-mail/.test(cmd)) return null;
  const triggers = findTriggers(cmd, cwd);
  if (!triggers.length) return null;
  const signals = loadSignals();
  for (const t of triggers) {
    const { title, body, unreadable } = readMessage(t);
    if (unreadable) continue;
    if (hasRootCause(`${title}\n${body}`)) continue;
    if (t.kind.startsWith('mail') && body.trim().length <= 80 && ACK.test(`${title}\n${body}`)) continue;
    const why = fixReason(title, body, signals, t.kind.startsWith('mail'));
    if (!why) continue;
    const where = !t.kind.startsWith('mail') ? 'PR·이슈 본문에 `## 근본 원인` 절 또는 ' : '';
    return [
      `root-cause: ${LABEL[t.kind]}이 수정·장애 보고로 보이는데 근본 원인이 없어 막았습니다(${why}).`,
      `고칠 법: ${where}\`근본 원인:\` 한 줄을 넣어라 — 증상을 일으킨 첫 원인(왜 처음 일어났나, 무엇이 바뀌었나)과 증거(시각 상관·변경 이력·로그).`,
      '아직 모르면 `근본 원인: 미확인 — 수정 전에 원인부터 찾아 보고하라`로 넘겨라. 수정이 아니면(기능·문서) `근본 원인: 해당 없음 — <까닭>`.',
    ].join('\n');
  }
  return null;
}

module.exports = { check, hasRootCause, fixReason, readMessage, findTriggers };

if (require.main === module) {
  readStdin((input) => {
    const cmd = (input.tool_input && input.tool_input.command) || '';
    let reason = null;
    try {
      reason = check(cmd, input.cwd || process.cwd());
    } catch {
      process.exit(0);
    }
    if (!reason) process.exit(0);
    process.stderr.write(reason + '\n');
    process.exit(2);
  });
}
