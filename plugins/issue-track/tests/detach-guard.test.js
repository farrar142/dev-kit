// node --test plugins/issue-track/tests
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'detach-guard.js');

function run(command, background = false, env = {}) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command, run_in_background: background } });
  return spawnSync('node', [HOOK], { input, encoding: 'utf8', env: { ...process.env, ISSUE_TRACK_ALLOW_DETACH: '', ...env } });
}
const blocked = (cmd, bg) => {
  const r = run(cmd, bg);
  assert.strictEqual(r.status, 2, `막혀야 함: ${cmd}`);
  assert.match(r.stderr, /run_in_background: true/);
};
const passes = (cmd, bg) => assert.strictEqual(run(cmd, bg).status, 0, `통과해야 함: ${cmd}`);

test('거절: wait-ci 를 & 로 떼어 띄움 (사고 꼴)', () => {
  blocked('( python3 "$W" 18 --repo x > /tmp/w.out 2>&1; echo "exit=$?" >> /tmp/w.out ) & sleep 2; echo started');
  blocked('python3 plugins/x/scripts/wait-ci.py 18 &');
  blocked('python3 wait-deploy.py --job j --pr 3 > out 2>&1 &');
});

test('거절: wait 스크립트를 nohup·setsid·disown 으로', () => {
  blocked('nohup python3 wait-ci.py 18');
  blocked('setsid python3 wait-ci.py 18');
  blocked('python3 wait-deploy.py 3 & disown');
  blocked('nohup python3 wait-ci.py 18', true); // 배경 호출 안에서도
  blocked('python3 wait-ci.py 18 &', true);
});

test('거절: 일반 명령도 & 로 떼고 wait 로 거두지 않으면', () => {
  blocked('( make test ) & sleep 1; echo started');
  blocked('pytest -x &');
  blocked('a & b & wait; c &');
  blocked('sleep 5 &\necho hi');
  blocked('wait; make test &'); // wait 가 & 보다 앞
});

test('통과: wait 로 거둠', () => {
  passes('a & b & wait');
  passes('(make a) & (make b) & wait');
  passes('a &\nb &\nwait');
  passes('a & wait $!');
});

test('통과: && 와 리다이렉션', () => {
  passes('a && b');
  passes('cmd > out 2>&1');
  passes('cmd >&2');
  passes('cmd &> out');
  passes('cmd &>> out');
  passes('cmd 2>&1 | tee x');
  passes('cmd |& tee x');
  passes('exec 3<&0');
  passes('a && b || c');
});

test('통과: 따옴표·heredoc·주석 안의 &', () => {
  passes('echo "a & b"');
  passes("echo 'a & b'");
  passes('echo a\\&b');
  passes('git commit -m "fix: A & B"');
  passes('cat <<EOF\nrun a &\nEOF');
  passes("cat <<'EOF'\nnohup x &\nEOF\necho done");
  passes('cat <<-EOF\n\trun a &\n\tEOF');
  passes('echo hi # a &');
  passes("grep 'wait-ci.py &' x");
  passes('cat <<< "a & b"');
  passes('curl "http://x/?a=1&b=2"');
});

test('통과: 기다리기 스크립트를 그대로(떼지 않고)', () => {
  passes('python3 plugins/x/scripts/wait-ci.py 18', true);
  passes('python3 wait-deploy.py --job j --pr 3 && echo ok', true);
  passes('python3 wait-ci.py 18 2>&1 | tail -n 5', true);
});

test('heredoc 뒤의 진짜 &는 잡는다', () => {
  blocked('cat <<EOF\nx\nEOF\nsleep 9 &');
});

test('배경 호출 안의 일반 &: 통과', () => {
  passes('( make test ) & sleep 1', true);
  passes('server & curl localhost; kill $!', true);
});

test('빠져나갈 길: 명령 앞 ISSUE_TRACK_ALLOW_DETACH=1, 또는 훅 환경변수', () => {
  passes('ISSUE_TRACK_ALLOW_DETACH=1 sleep 9 &');
  passes('ISSUE_TRACK_ALLOW_DETACH=1 nohup python3 wait-ci.py 1 &');
  assert.strictEqual(run('sleep 9 &', false, { ISSUE_TRACK_ALLOW_DETACH: '1' }).status, 0);
});

test('& 없는 평범한 명령·빈 명령', () => {
  passes('ls -la');
  passes('git status');
  passes('');
  passes('wait');
});

test('훅 오류는 통과', () => {
  const bad = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.strictEqual(bad.status, 0);
  const empty = spawnSync('node', [HOOK], { input: '{}', encoding: 'utf8' });
  assert.strictEqual(empty.status, 0);
});
