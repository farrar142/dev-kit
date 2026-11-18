// 셸 명령 읽기 — leak-guard/hooks/leak-guard.js 의 파서를 그대로 옮겼다(플러그인은 따로 설치되므로 공유하지 않는다).
'use strict';


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

module.exports = { parseCommands };
