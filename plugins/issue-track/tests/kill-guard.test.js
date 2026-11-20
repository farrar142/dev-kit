// node --test plugins/issue-track/tests
// 훅에 명령 글만 넣어 본다 — 진짜 프로세스를 죽이지 않는다.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'kill-guard.js');

function run(command, env = {}) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  return spawnSync('node', [HOOK], { input, encoding: 'utf8', env: { ...process.env, ISSUE_TRACK_ALLOW_PKILL: '', ...env } });
}
const blocked = (cmd) => {
  const r = run(cmd);
  assert.strictEqual(r.status, 2, `막혀야 함: ${cmd}`);
  assert.match(r.stderr, /pgrep -af/);
  assert.match(r.stderr, /\$!/);
};
const passes = (cmd) => assert.strictEqual(run(cmd).status, 0, `통과해야 함: ${cmd}`);

test('거절: pkill -f / --full', () => {
  blocked('pkill -f "sleep 600"');
  blocked('pkill -f wait-ci.py');
  blocked('pkill --full wait-ci');
  blocked('pkill -9 -f vite');
  blocked('pkill -fl vite');
  blocked('sudo pkill -f vite');
  blocked('FOO=1 pkill -f vite');
  blocked('/usr/bin/pkill -f vite');
  blocked('make stop && pkill -f vite');
  blocked('echo done; pkill -f vite || true');
  blocked('(pkill -f vite)');
});

test('거절: killall -r', () => {
  blocked('killall -r "node.*dev"');
  blocked('killall --regexp node');
  blocked('killall -9 -r node');
});

test('거절: 패턴 조회 결과를 kill 에 넘김', () => {
  blocked('pgrep -f vite | xargs kill');
  blocked('pgrep -f vite | xargs -r kill -9');
  blocked('pgrep -af vite | xargs kill');
  blocked('kill $(pgrep -f vite)');
  blocked('kill -9 `pgrep -f vite`');
  blocked('kill -9 "$(pgrep --full vite)"');
  blocked('pgrep -f vite | while read p; do kill $p; done');
});

test('통과: PID·작업 번호·부모 PID 로 죽임', () => {
  passes('kill 1234');
  passes('kill -9 1234 5678');
  passes('kill %1');
  passes('pkill -P 1234');
  passes('pkill -9 -P 1234');
  passes('kill $!');
  passes('kill "$PID"');
  passes('kill $(cat /tmp/pidfile)');
});

test('통과: 조회만 하거나 패턴 없는 조회', () => {
  passes('pgrep -af vite');
  passes('pgrep -f vite');
  passes('pgrep vite | xargs echo');
  passes('pgrep -f vite | wc -l');
  passes('ps aux | grep vite');
  passes('killall node');
  passes('pkill -x vite');
  passes('echo f | xargs kill');
});

test('통과: 따옴표·주석·heredoc 안의 낱말', () => {
  passes('echo "pkill -f 는 쓰지 마라"');
  passes("echo 'pkill -f x'");
  passes('gh issue create --title t --body "대기 셸을 pkill -f 로 끄지 마라"');
  passes('git commit -m "pkill -f 막기"');
  passes('# pkill -f vite\nls');
  passes('ls # pkill -f vite');
  passes('grep -n pkill README.md');
  passes('gh issue create --body-file - <<\'EOF\'\n패턴으로 `pkill -f x` 를 쓰면\npkill -f vite\nEOF\necho ok');
  passes('cat > f.md <<EOF\nkill $(pgrep -f x)\nEOF');
});

test('탈출구: 명령 앞 환경변수·훅 환경변수', () => {
  passes('ISSUE_TRACK_ALLOW_PKILL=1 pkill -f vite');
  assert.strictEqual(run('pkill -f vite', { ISSUE_TRACK_ALLOW_PKILL: '1' }).status, 0);
});

test('훅 오류는 통과', () => {
  const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
});
