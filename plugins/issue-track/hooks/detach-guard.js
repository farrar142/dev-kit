// PreToolUse(Bash): 셸 `&` 로 떼어 띄운 기다리기를 막는다.
// 떼어 낸 프로세스는 하네스가 모르는 고아가 되어 끝나도 세션에 알림이 오지 않는다.
// 판단: 거절은 exit 2 + stderr. 훅 자체가 오류로 죽으면 통과(exit 0).
'use strict';

const WAIT_SCRIPT = /wait-(?:ci|deploy)\.py/;
const ESCAPE = /(?:^|[\s;&|(])ISSUE_TRACK_ALLOW_DETACH=1(?=\s)/;
const DETACHERS = new Set(['nohup', 'setsid', 'disown']);

// 명령 글을 훑어 따옴표·주석·heredoc 밖의 사건만 모은다.
// amps: 떼어 띄우는 `&` 의 위치 / waits: 명령 자리의 `wait` 위치 / detachers: 명령 자리의 nohup 등
function scan(cmd) {
  const amps = [];
  const waits = [];
  const detachers = [];
  const heredocs = []; // 줄이 끝나면 건너뛸 {tag, dash}
  let atCmd = true;
  let word = '';
  let wordStart = 0;
  let wordQuoted = false;
  let i = 0;
  const n = cmd.length;

  const endWord = () => {
    if (word === '' && !wordQuoted) return;
    if (atCmd && !wordQuoted) {
      if (word === 'wait') waits.push(wordStart);
      else if (DETACHERS.has(word)) detachers.push(wordStart);
    }
    // 환경변수 대입(A=1 cmd)은 명령 자리를 유지한다
    if (!(atCmd && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) atCmd = false;
    word = '';
    wordQuoted = false;
  };
  const startWord = () => {
    if (word === '' && !wordQuoted) wordStart = i;
  };

  while (i < n) {
    const c = cmd[i];
    if (c === '\\') {
      startWord();
      word += c + (cmd[i + 1] || '');
      i += 2;
      continue;
    }
    if (c === "'") {
      startWord();
      wordQuoted = true;
      const j = cmd.indexOf("'", i + 1);
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (c === '"') {
      startWord();
      wordQuoted = true;
      i++;
      while (i < n && cmd[i] !== '"') i += cmd[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '#' && word === '' && !wordQuoted) {
      const j = cmd.indexOf('\n', i);
      i = j < 0 ? n : j;
      continue;
    }
    if (c === '\n') {
      endWord();
      i++;
      // 대기 중인 heredoc 본문을 건너뛴다
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
      atCmd = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] === '<') { // <<< here-string
      endWord();
      i += 3;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<') {
      endWord();
      let j = i + 2;
      let dash = false;
      if (cmd[j] === '-') { dash = true; j++; }
      while (cmd[j] === ' ' || cmd[j] === '\t') j++;
      const m = /^(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_.-]+))/.exec(cmd.slice(j));
      if (m) {
        heredocs.push({ tag: m[1] ?? m[2] ?? m[3], dash });
        j += m[0].length;
      }
      i = j;
      continue;
    }
    if (c === '&') {
      const prev = cmd[i - 1];
      const next = cmd[i + 1];
      endWord();
      if (next === '&') { atCmd = true; i += 2; continue; } // &&
      if (next === '>') { i += 1; continue; } // &> &>>
      if (prev === '>' || prev === '<') { i += 1; continue; } // 2>&1 >&2 <&3
      if (prev === '|') { atCmd = true; i += 1; continue; } // |&
      amps.push(i);
      atCmd = true;
      i += 1;
      continue;
    }
    if (c === ';' || c === '|' || c === '(' || c === '{' || c === '`') {
      endWord();
      atCmd = true;
      i += c === '|' && cmd[i + 1] === '|' ? 2 : 1;
      continue;
    }
    startWord();
    word += c;
    i++;
  }
  endWord();
  return { amps, waits, detachers };
}

const MESSAGE =
  '셸 `&`·nohup·setsid·disown 으로 떼어 띄운 프로세스는 하네스가 모르는 고아가 되어, 끝나도 세션에 알림이 오지 않는다. ' +
  '같은 명령을 `&` 없이 Bash 도구의 `run_in_background: true` 로 띄워라(끝나면 그 호출이 너를 깨운다). ' +
  '같은 명령 안에서 `wait` 로 거두는 것은 허용된다. ' +
  '정말 필요하면 명령 앞에 `ISSUE_TRACK_ALLOW_DETACH=1` 을 붙인다.';

// 거절 이유 글을 돌려준다. 통과면 null.
function check(cmd, background) {
  if (ESCAPE.test(cmd) || process.env.ISSUE_TRACK_ALLOW_DETACH === '1') return null;
  const { amps, waits, detachers } = scan(cmd);
  const unwaited = amps.filter((p) => !waits.some((w) => w > p));
  // 기다리기 스크립트를 떼어 띄우면 배경 호출 안에서도 알림이 미리 끝난다
  if (WAIT_SCRIPT.test(cmd) && (unwaited.length || detachers.length)) return MESSAGE;
  if (background) return null;
  return unwaited.length ? MESSAGE : null;
}

module.exports = { check, scan };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let reason = null;
    try {
      const input = JSON.parse(raw);
      const ti = input.tool_input || {};
      reason = check(String(ti.command || ''), ti.run_in_background === true);
    } catch (e) {
      process.exit(0); // 훅 오류는 통과
    }
    if (!reason) process.exit(0);
    process.stderr.write(reason + '\n');
    process.exit(2);
  });
}
