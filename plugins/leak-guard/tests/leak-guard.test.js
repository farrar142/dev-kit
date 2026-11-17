// node --test plugins/leak-guard/tests
// 걸리는 값은 실행 중에 조립한다 — 이 파일 자체가 leak-guard·GitHub push protection 에 걸리지 않게.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'leak-guard.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-guard-test-'));
const SKIP = process.platform === 'win32' ? '가짜 gh 가 셸 스크립트라 리눅스·macOS에서만' : false;

const CGNAT = ['100', '100', '7', '42'].join('.');
const GH_TOKEN = 'gh' + 'p_' + 'Ab1'.repeat(12);
const KEY_HEAD = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';
const INTERNAL = 'build01.example' + '.internal';

let seq = 0;
const fresh = (name) => path.join(tmp, `${name}${++seq}`);

// 가짜 gh: FAKE_GH_VIS 를 출력한다(fail 이면 실패). 부를 때마다 FAKE_GH_LOG 에 한 줄.
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, 'gh'),
  '#!/bin/sh\necho call >> "$FAKE_GH_LOG"\n[ "$FAKE_GH_VIS" = fail ] && exit 1\necho "$FAKE_GH_VIS"\n',
  { mode: 0o755 },
);

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function repo({ remote = true } = {}) {
  const dir = fresh('repo');
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-qm', 'init');
  if (remote) {
    const bare = fresh('bare');
    sh(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
    sh(dir, 'remote', 'add', 'origin', bare);
    sh(dir, 'push', '-q', 'origin', 'main');
    sh(dir, 'remote', 'set-head', 'origin', 'main');
  }
  return dir;
}

function write(dir, file, text, { stage = true } = {}) {
  fs.writeFileSync(path.join(dir, file), text);
  if (stage) sh(dir, 'add', file);
}

function run(cwd, command, { vis = 'PUBLIC', env = {} } = {}) {
  const log = fresh('ghlog');
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      FAKE_GH_VIS: vis,
      FAKE_GH_LOG: log,
      LEAK_GUARD_CACHE_DIR: fresh('cache'),
      LEAK_GUARD_PATTERNS: path.join(tmp, 'no-such-patterns.txt'),
      ...env,
    },
  });
  const ghCalls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0;
  return { code: r.status, err: r.stderr, ghCalls };
}

test('git 과 무관한 명령은 그냥 통과', { skip: SKIP }, () => {
  const r = run(tmp, `echo ${CGNAT}`);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.ghCalls, 0);
});

test('commit: 스테이지된 CGNAT IP 를 파일:줄과 패턴 이름으로 막고 값은 가린다', { skip: SKIP }, () => {
  const dir = repo();
  write(dir, 'conf.txt', `x\nhost = ${CGNAT}\n`);
  const r = run(dir, 'git commit -m "설정"');
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /conf\.txt:2 — cgnat-ip/);
  assert.ok(!r.err.includes(CGNAT), '값 전체가 나오면 안 된다');
  assert.match(r.err, /leak-guard:allow/);
});

test('commit: 깨끗한 추가분은 통과, 지운 줄(-)은 보지 않는다', { skip: SKIP }, () => {
  const dir = repo();
  write(dir, 'x.txt', `old ${CGNAT}\n`);
  sh(dir, 'commit', '-qm', 'old');
  write(dir, 'x.txt', 'new\n');
  assert.strictEqual(run(dir, 'git commit -m clean').code, 0);
});

test('commit: 개인 키 머리말·GitHub 토큰, 커밋 메시지(명령 글)도 본다', { skip: SKIP }, () => {
  const dir = repo();
  write(dir, 'k', `${KEY_HEAD}\n`);
  const r = run(dir, `git commit -m "token ${GH_TOKEN}"`);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /k:1 — private-key/);
  assert.match(r.err, /커밋 메시지:1 — github-token/);
  assert.ok(!r.err.includes(GH_TOKEN));
});

test('commit -a: 스테이지 안 된 추적 파일 변경도 본다', { skip: SKIP }, () => {
  const dir = repo();
  write(dir, 'a.txt', `hello ${CGNAT}\n`, { stage: false });
  assert.strictEqual(run(dir, 'git commit -m x').code, 0);
  assert.strictEqual(run(dir, 'git commit -am x').code, 2);
});

test('비공개 저장소는 검사하지 않는다(가시성은 캐시)', { skip: SKIP }, () => {
  const dir = repo();
  write(dir, 'conf.txt', `${CGNAT}\n`);
  const cache = fresh('cache');
  const env = { LEAK_GUARD_CACHE_DIR: cache };
  const a = run(dir, 'git commit -m x', { vis: 'PRIVATE', env });
  assert.strictEqual(a.code, 0);
  assert.strictEqual(a.ghCalls, 1);
  const b = run(dir, 'git commit -m x', { vis: 'PRIVATE', env });
  assert.strictEqual(b.code, 0);
  assert.strictEqual(b.ghCalls, 0, '두 번째는 캐시');
  const c = run(dir, 'git commit -m x', { vis: 'PRIVATE', env: { ...env, LEAK_GUARD_TTL: '-1' } });
  assert.strictEqual(c.ghCalls, 1, 'TTL 이 지나면 다시 묻는다');
});

test('가시성을 모르면(gh 실패) 검사한다', { skip: SKIP }, () => {
  const dir = repo();
  write(dir, 'conf.txt', `${CGNAT}\n`);
  assert.strictEqual(run(dir, 'git commit -m x', { vis: 'fail' }).code, 2);
});

test('git 저장소가 아니면 통과', { skip: SKIP }, () => {
  const dir = fresh('plain');
  fs.mkdirSync(dir);
  assert.strictEqual(run(dir, 'git commit -m x').code, 0);
});

test('사용자 금지어 파일: 걸리면 파일 이름:줄 번호로, 없으면 내장만', { skip: SKIP }, () => {
  const dir = repo();
  write(dir, 'doc.md', `deploy to ${INTERNAL}\n`);
  assert.strictEqual(run(dir, 'git commit -m x').code, 0, '파일이 없으면 내장 패턴만');
  const pf = fresh('patterns');
  fs.writeFileSync(pf, '# 내부 이름\n\nexample\\.INTERNAL\n');
  const r = run(dir, 'git commit -m x', { env: { LEAK_GUARD_PATTERNS: pf } });
  assert.strictEqual(r.code, 2);
  assert.match(r.err, new RegExp(`doc\\.md:1 — ${path.basename(pf)}:3`));
  assert.ok(!r.err.includes(INTERNAL));
});

test('사용자 금지어 파일: 기본 경로는 XDG_CONFIG_HOME/leak-guard/patterns.txt', { skip: SKIP }, () => {
  const dir = repo();
  write(dir, 'doc.md', `${INTERNAL}\n`);
  const xdg = fresh('xdg');
  fs.mkdirSync(path.join(xdg, 'leak-guard'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'leak-guard', 'patterns.txt'), 'example\\.internal\n');
  const env = { LEAK_GUARD_PATTERNS: '', XDG_CONFIG_HOME: xdg };
  assert.strictEqual(run(dir, 'git commit -m x', { env }).code, 2);
});

test('사용자 금지어 파일의 정규식 오류는 고칠 줄을 알려 주며 막는다', { skip: SKIP }, () => {
  const dir = repo();
  write(dir, 'a.md', 'fine\n');
  const pf = fresh('patterns');
  fs.writeFileSync(pf, 'ok\n(unclosed\n');
  const r = run(dir, 'git commit -m x', { env: { LEAK_GUARD_PATTERNS: pf } });
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /:2 의 정규식이 잘못/);
});

test('예외 표시 leak-guard:allow 가 있는 줄은 넘긴다', { skip: SKIP }, () => {
  const dir = repo();
  write(dir, 'doc.md', `예: ${CGNAT} <!-- leak-guard:allow -->\n`);
  assert.strictEqual(run(dir, 'git commit -m x').code, 0);
});

test('cd X && git commit, git -C X commit 은 그 디렉터리를 본다', { skip: SKIP }, () => {
  const dir = repo();
  write(dir, 'conf.txt', `${CGNAT}\n`);
  assert.strictEqual(run(tmp, `cd "${dir}" && git commit -m x`).code, 2);
  assert.strictEqual(run(tmp, `git -C "${dir}" commit -m x`).code, 2);
});

test('push(업스트림 있음): 이미 원격에 있는 커밋은 보지 않고 나갈 커밋만 본다', { skip: SKIP }, () => {
  const dir = repo();
  sh(dir, 'branch', '--set-upstream-to=origin/main');
  write(dir, 'old.txt', `${CGNAT}\n`);
  sh(dir, 'commit', '-qm', 'old');
  sh(dir, 'push', '-q', 'origin', 'main');
  assert.strictEqual(run(dir, 'git push').code, 0);
  write(dir, 'new.txt', `${GH_TOKEN}\n`);
  sh(dir, 'commit', '-qm', 'new');
  const r = run(dir, 'git push');
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /new\.txt:1 — github-token/);
  assert.ok(!r.err.includes('old.txt'));
});

test('push(업스트림 없음): 원격 기본 브랜치 대비 나갈 커밋, 중간에 지운 값도 역사에 남으니 막는다', { skip: SKIP }, () => {
  const dir = repo();
  sh(dir, 'switch', '-qc', 'feature');
  write(dir, 'f.txt', `${CGNAT}\n`);
  sh(dir, 'commit', '-qm', 'add');
  write(dir, 'f.txt', 'gone\n');
  sh(dir, 'commit', '-qm', 'remove');
  const r = run(dir, 'git push -u origin feature');
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /f\.txt:1 — cgnat-ip/);
});

test('push: 커밋 메시지도 본다, 원격이 아예 없어도 죽지 않는다', { skip: SKIP }, () => {
  const dir = repo();
  sh(dir, 'switch', '-qc', 'feature');
  write(dir, 'n.txt', 'n\n');
  sh(dir, 'commit', '-qm', `note ${CGNAT}`);
  assert.match(run(dir, 'git push -u origin feature').err, /메시지:1 — cgnat-ip/);
  const solo = repo({ remote: false });
  assert.strictEqual(run(solo, 'git push').code, 0);
});

test('gh pr create: 제목·heredoc 본문·나갈 커밋을 본다', { skip: SKIP }, () => {
  const dir = repo();
  assert.strictEqual(run(dir, 'gh pr create --title t --body "clean"').code, 0);
  const body = `gh pr create --title t --body "$(cat <<'EOF'\n요약\n서버 ${CGNAT}\nEOF\n)"`;
  const r = run(dir, body);
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /PR 제목·본문:3 — cgnat-ip/);
  sh(dir, 'switch', '-qc', 'feature');
  write(dir, 'k.txt', `${KEY_HEAD}\n`);
  sh(dir, 'commit', '-qm', 'k');
  assert.match(run(dir, 'gh pr create --title t --body ok').err, /k\.txt:1 — private-key/);
});

test('gh pr edit --body-file: 파일 내용을 본다', { skip: SKIP }, () => {
  const dir = repo();
  const bf = path.join(dir, 'body.md');
  fs.writeFileSync(bf, `a\n${INTERNAL}\n`);
  const pf = fresh('patterns');
  fs.writeFileSync(pf, 'example\\.internal\n');
  const r = run(dir, 'gh pr edit 3 --body-file body.md', { env: { LEAK_GUARD_PATTERNS: pf } });
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /body\.md:2/);
  assert.strictEqual(run(dir, 'gh pr edit 3 --body-file body.md').code, 0);
});

// ── 나가는 내용만 본다(#94): 명령줄의 나머지(cd 경로·환경변수·다른 명령)는 보지 않는다 ──
// 금지어는 가짜 값. 저장소 폴더 이름에 넣어 cd 경로 오탐을 재현한다.
const WORD = 'acme' + 'corp';
function wordRepo() {
  const dir = repo();
  const named = path.join(tmp, `${WORD}-home${++seq}`);
  fs.renameSync(dir, named);
  const pf = fresh('patterns');
  fs.writeFileSync(pf, `${WORD}\n`);
  write(named, 'b.txt', 'clean\n');
  return { dir: named, env: { LEAK_GUARD_PATTERNS: pf } };
}

test('오탐 재현: cd 경로·git -C 경로·환경변수·앞뒤 다른 명령의 금지어는 막지 않는다', { skip: SKIP }, () => {
  const { dir, env } = wordRepo();
  for (const cmd of [
    `cd "${dir}" && git commit -m 'clean'`,
    `cd ${dir} && git commit -m "clean"`,
    `git -C "${dir}" commit -m clean`,
    `cd "${dir}"; NOTE=${WORD} git commit -qm clean 2>&1 | tail -n 3; echo ${WORD}`,
    `cd "${dir}" && git add -A && git commit -m "$(cat <<'X'\n요약: git push 하면 나간다\nX\n)" > /dev/null; echo done`,
    `cd "${dir}" && gh pr create --title t --body 'clean'`,
  ]) {
    const r = run(tmp, cmd, { env });
    assert.strictEqual(r.code, 0, `${cmd}\n${r.err}`);
  }
});

test('메시지 속 금지어는 인용 방식과 상관없이 막는다(작은따옴표·큰따옴표·$(cat <<EOF)·-F - heredoc·here-string)', { skip: SKIP }, () => {
  const { dir, env } = wordRepo();
  const cases = [
    [`git commit -m 'x ${WORD}'`, /커밋 메시지:1 — patterns/],
    [`git commit -m "x ${WORD}"`, /커밋 메시지:1/],
    [`git commit -qm"${WORD}"`, /커밋 메시지:1/],
    [`git commit --message="${WORD}"`, /커밋 메시지:1/],
    [`git commit -m t -m "둘째 문단 ${WORD}"`, /커밋 메시지:1/],
    [`git commit -m "$(cat <<'EOF'\n제목\n\n본문 ${WORD}\nEOF\n)"`, /커밋 메시지:4/],
    [`git commit -F - <<'EOF'\n제목\n${WORD}\nEOF`, /커밋 메시지:2/],
    [`git commit -F - <<< "${WORD}"`, /커밋 메시지:1/],
  ];
  for (const [cmd, re] of cases) {
    const r = run(tmp, `cd "${dir}" && ${cmd}`, { env });
    assert.strictEqual(r.code, 2, cmd);
    assert.match(r.err, re, cmd);
  }
});

test('commit -F 파일: 경로가 아니라 내용을 본다', { skip: SKIP }, () => {
  const { dir, env } = wordRepo();
  const msg = path.join(dir, `${WORD}-msg.txt`);
  fs.writeFileSync(msg, 'clean\n');
  assert.strictEqual(run(dir, `git commit -F "${msg}"`, { env }).code, 0);
  fs.writeFileSync(msg, `a\n${WORD}\n`);
  const r = run(dir, `git commit --file=${msg}`, { env });
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /-msg\.txt:2/);
});

test('스테이지된 diff 속 금지어는 cd 를 거쳐도 막는다', { skip: SKIP }, () => {
  const { dir, env } = wordRepo();
  write(dir, 'c.txt', `${WORD}\n`);
  const r = run(tmp, `cd "${dir}" && git commit -m clean`, { env });
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /c\.txt:1/);
});

test('gh pr: 제목·본문(작은따옴표·-b·--title=·body-file -) 속 금지어는 막는다', { skip: SKIP }, () => {
  const { dir, env } = wordRepo();
  for (const cmd of [
    `gh pr create --title '${WORD}' --body ok`,
    `gh pr edit 3 -b "x ${WORD}"`,
    `gh pr edit 3 --title="${WORD}"`,
    `gh pr edit 3 --body-file - <<'EOF'\n${WORD}\nEOF`,
  ]) {
    const r = run(tmp, `cd "${dir}" && ${cmd}`, { env });
    assert.strictEqual(r.code, 2, cmd);
  }
});

test('fail-closed: 읽지 못하는 명령·치환 속 git commit·bash -c 는 그 안까지 본다', { skip: SKIP }, () => {
  const { dir, env } = wordRepo();
  // 닫히지 않은 따옴표 → 명령 글 전체
  assert.strictEqual(run(dir, `echo '${WORD}; git commit -m x`, { env }).code, 2);
  // $(git commit …) 은 단순 명령으로 읽히지 않으니 명령 글 전체
  assert.strictEqual(run(dir, `r=$(git commit -m x); echo ${WORD}`, { env }).code, 2);
  // bash -c '…', eval, bash <<EOF 는 안의 명령을 다시 읽는다
  assert.strictEqual(run(dir, `bash -c 'git commit -m "${WORD}"'`, { env }).code, 2);
  assert.strictEqual(run(dir, `bash -c 'cd /nowhere-${WORD} || git commit -m clean'`, { env }).code, 0);
  assert.strictEqual(run(dir, `eval "git commit -m ${WORD}"`, { env }).code, 2);
  assert.strictEqual(run(dir, `bash <<'EOF'\ngit commit -m "${WORD}"\nEOF`, { env }).code, 2);
  // stdin 메시지인데 heredoc 이 없으면(파이프) 명령 글 전체
  assert.strictEqual(run(dir, `echo ${WORD} | git commit -F -`, { env }).code, 2);
});
