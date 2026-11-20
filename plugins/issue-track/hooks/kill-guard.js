// PreToolUse(Bash): 패턴으로 프로세스를 죽이는 명령(pkill -f 등)을 막는다.
// 패턴은 명령줄 전체에 걸려 같은 기계의 다른 세션·작업의 프로세스까지 죽일 수 있다.
// 판단: 거절은 exit 2 + stderr. 훅 자체가 오류로 죽으면 통과(exit 0).
'use strict';

const ESCAPE = /(?:^|[\s;&|(])ISSUE_TRACK_ALLOW_PKILL=1(?=\s)/;
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'builtin', 'do', 'then', 'else']);

// 따옴표·주석·heredoc 본문의 글자를 `_` 로 가려(길이 유지) 명령 구조만 남긴다.
// 큰따옴표 안의 $( … )·백틱은 실제로 실행되므로 가리지 않는다.
function mask(cmd) {
  const n = cmd.length;
  let out = '';
  let i = 0;
  let wordEmpty = true;
  const heredocs = [];
  const blank = (s) => s.replace(/[^\s]/g, '_');
  while (i < n) {
    const c = cmd[i];
    if (c === '\\') {
      out += c + (cmd[i + 1] === undefined ? '' : '_');
      i += 2;
      wordEmpty = false;
      continue;
    }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? n : j + 1;
      out += "'" + blank(cmd.slice(i + 1, end - 1)) + (j < 0 ? '' : "'");
      i = end;
      wordEmpty = false;
      continue;
    }
    if (c === '"') {
      out += '"';
      i++;
      while (i < n && cmd[i] !== '"') {
        if (cmd[i] === '\\') { out += '__'; i += 2; continue; }
        if (cmd[i] === '$' && cmd[i + 1] === '(') {
          let depth = 0;
          let j = i + 1;
          for (; j < n; j++) {
            if (cmd[j] === '(') depth++;
            else if (cmd[j] === ')' && --depth === 0) break;
          }
          out += cmd.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        if (cmd[i] === '`') {
          const j = cmd.indexOf('`', i + 1);
          const end = j < 0 ? n : j + 1;
          out += cmd.slice(i, end);
          i = end;
          continue;
        }
        out += /\s/.test(cmd[i]) ? cmd[i] : '_';
        i++;
      }
      out += '"';
      i++;
      wordEmpty = false;
      continue;
    }
    if (c === '#' && wordEmpty) {
      const j = cmd.indexOf('\n', i);
      i = j < 0 ? n : j;
      continue;
    }
    if (c === '\n') {
      out += c;
      i++;
      while (heredocs.length) {
        const { tag, dash } = heredocs.shift();
        while (i < n) {
          let j = cmd.indexOf('\n', i);
          if (j < 0) j = n;
          let line = cmd.slice(i, j);
          i = Math.min(j + 1, n);
          if (dash) line = line.replace(/^\t+/, '');
          if (line === tag) break;
        }
      }
      wordEmpty = true;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      let j = i + 2;
      let dash = false;
      if (cmd[j] === '-') { dash = true; j++; }
      while (cmd[j] === ' ' || cmd[j] === '\t') j++;
      const m = /^(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_.-]+))/.exec(cmd.slice(j));
      if (m) {
        heredocs.push({ tag: m[1] ?? m[2] ?? m[3], dash });
        out += ' ';
        i = j + m[0].length;
      } else {
        out += '<<';
        i += 2;
      }
      wordEmpty = true;
      continue;
    }
    out += c;
    wordEmpty = /[\s;&|(){`]/.test(c);
    i++;
  }
  return out;
}

// 가린 글을 명령 조각으로 나눈다. op: 조각 앞의 연결자('|' 등), sub: `$(`·백틱으로 열린 조각인지
function segments(masked) {
  const segs = [];
  let cur = '';
  let op = '';
  let sub = false;
  const push = (nextOp, nextSub) => {
    if (cur.trim()) segs.push({ words: cur.trim().split(/\s+/), op, sub });
    cur = '';
    op = nextOp;
    sub = nextSub;
  };
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '$' && masked[i + 1] === '(') { push('(', true); i++; continue; }
    if (c === '`') { push('`', true); continue; }
    if (c === '|' || c === ';' || c === '&' || c === '\n' || c === '(' || c === ')' || c === '{' || c === '}') {
      const two = masked.slice(i, i + 2);
      if (two === '||' || two === '&&' || two === '|&') { push(two, false); i++; continue; }
      if (c === '>' ) { cur += c; continue; }
      if (c === '&' && (masked[i - 1] === '>' || masked[i - 1] === '<' || masked[i + 1] === '>')) { cur += c; continue; }
      push(c, false);
      continue;
    }
    cur += c;
  }
  push('', false);
  return segs;
}

// 환경변수 대입·sudo 같은 앞붙이를 건너뛴 명령 이름과 나머지 낱말
function resolve(words) {
  let k = 0;
  for (;;) {
    while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) k++;
    const w = words[k] && words[k].replace(/^.*\//, '');
    if (w && WRAPPERS.has(w)) {
      k++;
      while (k < words.length && /^-/.test(words[k])) k++;
      continue;
    }
    break;
  }
  const name = words[k] ? words[k].replace(/^.*\//, '') : '';
  return { name, args: words.slice(k + 1) };
}

const hasFlag = (args, short, long) =>
  args.some((a) => a === long || (new RegExp('^-[A-Za-z0-9]*' + short + '[A-Za-z0-9]*$').test(a)));

const MESSAGE =
  '패턴은 다른 세션·다른 작업의 프로세스에도 걸린다 — 띄울 때 PID 를 받아 두고(`$!`) 그 PID 로 죽여라. ' +
  'PID 를 모르면 `pgrep -af <패턴>` 으로 먼저 보고 PID 를 골라 `kill <PID>` 한다(부모 기준 `pkill -P <PID>` 는 허용). ' +
  '정말 필요하면 명령 앞에 `ISSUE_TRACK_ALLOW_PKILL=1` 을 붙인다.';

// 거절 이유 글을 돌려준다. 통과면 null.
function check(cmd) {
  if (ESCAPE.test(cmd) || process.env.ISSUE_TRACK_ALLOW_PKILL === '1') return null;
  const segs = segments(mask(cmd));
  const killLike = (s) => {
    const { name, args } = resolve(s.words);
    if (name === 'kill') return true;
    if (name === 'xargs') return args.some((a) => /^(?:kill|pkill|killall)$/.test(a.replace(/^.*\//, '')));
    return false;
  };
  for (let idx = 0; idx < segs.length; idx++) {
    const s = segs[idx];
    const { name, args } = resolve(s.words);
    if (name === 'pkill' && hasFlag(args, 'f', '--full')) return MESSAGE;
    if (name === 'killall' && hasFlag(args, 'r', '--regexp')) return MESSAGE;
    if (name === 'pgrep' && hasFlag(args, 'f', '--full')) {
      // 조회 결과를 곧장 kill 에 넘기는 꼴: `pgrep -f x | xargs kill`, `kill $(pgrep -f x)`
      const next = segs[idx + 1];
      if (next && (next.op === '|' || next.op === '|&')) {
        if (killLike(next)) return MESSAGE;
        if (resolve(next.words).name === 'while' && segs.slice(idx + 2).some(killLike)) return MESSAGE;
      }
      if (s.sub && idx > 0 && killLike(segs[idx - 1])) return MESSAGE;
    }
  }
  return null;
}

module.exports = { check, mask, segments };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let reason = null;
    try {
      const input = JSON.parse(raw);
      reason = check(String((input.tool_input || {}).command || ''));
    } catch (e) {
      process.exit(0); // 훅 오류는 통과
    }
    if (!reason) process.exit(0);
    process.stderr.write(reason + '\n');
    process.exit(2);
  });
}
