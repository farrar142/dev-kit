// node --test plugins/root-cause/tests
// 훅에 가짜 입력 JSON 을 stdin 으로 넣어 본다. 셸 스크립트를 쓰지 않아 Windows 에서도 돈다.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROMPT = path.join(__dirname, '..', 'hooks', 'prompt.js');
const GATE = path.join(__dirname, '..', 'hooks', 'gate.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-cause-test-'));
const cfg = path.join(tmp, 'cfg');

function run(hook, input, env = {}) {
  const base = { ...process.env, XDG_CONFIG_HOME: cfg };
  delete base.ROOT_CAUSE_OFF;
  delete base.ROOT_CAUSE_SIGNALS;
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...base, ...env },
    windowsHide: true,
  });
  return r;
}

const prompt = (text, env) => run(PROMPT, { hook_event_name: 'UserPromptSubmit', prompt: text }, env);
const bash = (command, env) => run(GATE, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: tmp }, env);

function context(r) {
  assert.strictEqual(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return null;
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}
const blocked = (r) => r.status === 2;

// ── UserPromptSubmit ──

test('문제 신고에는 근본 원인 문맥을 넣는다', () => {
  for (const p of [
    '배포할 때마다 Redis 연결 오류가 쌓여',
    '로그인이 안 돼요',
    '대시보드가 느려졌어',
    '왜 컨테이너가 다시 만들어지지?',
    'API가 502 줘',
    'Traceback (most recent call last):\n  File "x.py"',
    'NullPointerException at Foo',
    'the build is broken after merge',
  ]) {
    const c = context(prompt(p));
    assert.ok(c, p);
    assert.match(c, /근본 원인:/);
    assert.match(c, /diagnosing-bugs/);
  }
});

test('신호 없는 입력은 그대로 둔다', () => {
  for (const p of ['README에 설치 절차 추가해 줘', '새 화면 만들어 줘, 버튼 3개', '400개 줄 정리', 'PR #412 병합해 줘', 'v0.5.0 배포']) {
    assert.strictEqual(context(prompt(p)), null, p);
  }
});

test('ROOT_CAUSE_OFF=1 이면 끈다', () => {
  assert.strictEqual(context(prompt('오류가 나요', { ROOT_CAUSE_OFF: '1' })), null);
  assert.ok(!blocked(bash("gh pr create --title 'fix: 로그인 오류' --body '고침'", { ROOT_CAUSE_OFF: '1' })));
});

test('사용자 신호 목록(~/.config/root-cause/signals.txt)을 더한다', () => {
  fs.mkdirSync(path.join(cfg, 'root-cause'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'root-cause', 'signals.txt'), '# 주석\n\n먹었다\n[잘못된(정규식\n');
  try {
    assert.ok(context(prompt('설정이 먹었다 안 먹었다 해')));
    assert.strictEqual(context(prompt('잘 먹었다')) !== null, true);
    assert.strictEqual(context(prompt('점심 메뉴')), null);
  } finally {
    fs.rmSync(path.join(cfg, 'root-cause'), { recursive: true });
  }
});

test('HOME 이 없어도(Windows) 돈다', () => {
  const env = { HOME: '', XDG_CONFIG_HOME: '' };
  assert.ok(context(prompt('오류가 나요', env)));
  assert.ok(blocked(bash("gh pr create --title 'fix: 로그인 오류' --body '고침'", env)));
});

// ── PreToolUse(Bash) 관문 ──

test('원인 줄 없는 수정 PR·이슈는 막는다', () => {
  for (const c of [
    "gh pr create --title 'fix: 배포 때 Redis 연결 오류' --body '경고로 낮췄다'",
    "cd /x && gh pr create -t 'hotfix 결제' -b '급함'",
    "gh pr create --title 'Redis 연결 오류 경고로 낮추기' --body '소음 줄이기'",
    "gh issue create --title '배포마다 502 오류' --body '재현: 배포 직후'",
    "gh pr create --title 'redis: 정리' --body \"$(cat <<'EOF'\n## 무엇\n연결 오류를 경고로 낮췄다.\nEOF\n)\"",
  ]) {
    const r = bash(c);
    assert.ok(blocked(r), c);
    assert.match(r.stderr, /근본 원인:/);
    assert.match(r.stderr, /미확인 — 수정 전에 원인부터 찾아 보고하라/);
  }
});

test('원인 줄·절이 있으면 통과', () => {
  for (const c of [
    "gh pr create --title 'fix: 배포 때 Redis 연결 오류' --body \"$(cat <<'EOF'\n## 근본 원인\n배포 스크립트가 떠다니는 태그를 pull 해 상태 있는 컨테이너가 다시 만들어졌다(배포 시각과 오류 시각 일치).\nEOF\n)\"",
    "gh pr create --title 'fix: 오류' --body '근본 원인: 미확인 — 배포 로그와 이미지 digest 비교'",
    "gh issue create --title '502 오류' --body '- **근본 원인:** 업스트림 타임아웃 설정이 바뀜(커밋 abc)'",
    "gh pr create --title 'fix: crash' --body 'Root cause: nil map after config reload'",
  ]) {
    assert.ok(!blocked(bash(c)), c);
  }
});

test('빈 원인 줄은 원인으로 치지 않는다', () => {
  assert.ok(blocked(bash("gh pr create --title 'fix: 오류' --body '근본 원인:'")));
});

test('--body-file 은 파일을 읽어 본다', () => {
  const without = path.join(tmp, 'without.md');
  const withLine = path.join(tmp, 'with.md');
  fs.writeFileSync(without, '## 무엇\n오류를 걸러냈다\n');
  fs.writeFileSync(withLine, '## 무엇\n오류를 걸러냈다\n\n근본 원인: 재시도 루프가 같은 요청을 두 번 보냄\n');
  assert.ok(blocked(bash(`gh pr create --title 'fix: 오류' --body-file ${without}`)));
  assert.ok(!blocked(bash(`gh pr create --title 'fix: 오류' --body-file ${withLine}`)));
  assert.ok(!blocked(bash(`gh pr create --title 'fix: 오류' -F ${path.basename(withLine)}`)), '상대 경로는 cwd 기준');
  assert.ok(!blocked(bash(`gh pr create --title 'fix: 오류' --body-file=${withLine}`)));
  assert.ok(!blocked(bash(`gh pr create --title 'fix: 오류' --body-file ${path.join(tmp, 'nope.md')}`)), '못 읽으면 통과');
});

test('기능·문서 PR 은 막지 않는다', () => {
  for (const c of [
    "gh pr create --title 'feat: 오류 화면 추가' --body '새 오류 페이지'",
    "gh pr create --title 'docs: 장애 대응 안내' --body '문서'",
    "gh pr create --title 'switchboard 0.13.0: 질문 패널 정렬' --body \"$(cat <<'EOF'\n## 시험\n245건 초록, 실패 0건. 실패하면 다시 시도한다.\nEOF\n)\"",
    "gh pr create --title '결제 오류 화면 추가' --body '새 화면'",
    "gh pr create --fill",
    "gh pr view 12",
    "gh issue list --search 오류",
    "echo 'gh pr create --title \"fix: 오류\"'",
  ]) {
    assert.ok(!blocked(bash(c)), c);
  }
});

test('수정·장애를 넘기는 메일은 원인 줄이 없으면 막는다', () => {
  for (const c of [
    "SWITCHBOARD_PROFILE=worker-1 ~/.local/bin/switchboard send --to team/boss --subject '[t] 배포 오류 처리' --body '배포 때 Redis 연결 오류가 쌓여서 경고로 낮췄고 남은 메시지는 걸러냈습니다. 다음 배포부터 조용할 것입니다. 시험은 초록입니다. 확인 부탁드립니다. 오류 추적기에서 규칙을 하나 더했습니다. 상세는 PR을 봐 주세요. 감사합니다.'",
    "switchboard --profile w send --to team/lead --subject '보고' --body-file - <<'EOF'\n## 한 것\n로그인 실패를 재시작으로 해결했습니다.\nEOF",
    "switchboard reply 42 --body 'fixed the crash by catching the panic in the worker loop and moving on to the next job, all tests green now, please merge'",
  ]) {
    assert.ok(blocked(bash(c)), c);
  }
});

test('원인 줄 있는 메일·짧은 확인 메일·일반 보고는 통과', () => {
  for (const c of [
    "switchboard send --to team/boss --subject '[t] 배포 오류' --body '경고로 낮췄다.\n근본 원인: 배포가 떠다니는 태그를 pull 해 상태 있는 컨테이너를 다시 만듦'",
    "switchboard reply 42 --body '받았습니다. 오류 고친 것 확인했습니다.'",
    "switchboard send --to team/boss --subject '[t] 완료' --body '확인 완료'",
    "switchboard send --to team/boss --subject '[t] 결제 화면' --body '새 결제 화면을 추가했습니다. 시험 120건 초록, 실패 0.'",
    "switchboard inbox --status pending",
    "switchboard read 12",
  ]) {
    assert.ok(!blocked(bash(c)), c);
  }
});

test('경로·.exe 가 붙은 switchboard 도 거른다', () => {
  for (const c of [
    "/usr/local/bin/switchboard send --to team/boss --subject '보고' --body 'fixed the crash by catching the panic in the worker loop and moving on to the next job, all tests green now, please merge'",
    "SWITCHBOARD_PROFILE=w switchboard.exe reply 42 --body 'fixed the crash by catching the panic in the worker loop and moving on to the next job, all tests green now, please merge'",
    "'C:\\Users\\u\\.local\\bin\\switchboard.exe' send --to team/boss --subject '보고' --body 'fixed the crash by catching the panic in the worker loop and moving on to the next job, all tests green now, please merge'",
    "switchboard --role team/worker-1 send --to team/boss --subject '[t] 배포 오류 처리' --body '로그인 실패를 재시작으로 해결했습니다.'",
  ]) {
    assert.ok(blocked(bash(c)), c);
  }
});

// 옛 이름 agent-mail: 3단계에 제거
test('옛 이름 agent-mail send/reply 도 3단계 전까지 거른다', () => {
  assert.ok(blocked(bash("AGENT_MAIL_PROFILE=worker-1 ~/.local/bin/agent-mail send --to team/boss --subject '보고' --body-file - <<'EOF'\n로그인 실패를 재시작으로 해결했습니다.\nEOF")));
  assert.ok(blocked(bash("agent-mail reply 42 --body 'fixed the crash by catching the panic in the worker loop and moving on to the next job, all tests green now, please merge'")));
  assert.ok(!blocked(bash("agent-mail send --to team/boss --subject '[t] 배포 오류' --body '경고로 낮췄다.\n근본 원인: 태그가 떠다녔다'")));
  assert.ok(!blocked(bash("agent-mail read 12")));
});

test('막을 때 부른 이름을 그대로 알린다', () => {
  const r = bash("switchboard reply 42 --body 'fixed the crash by catching the panic in the worker loop and moving on to the next job, all tests green now, please merge'");
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /root-cause: switchboard reply이/);
});

test('bash -c 안의 명령도 본다', () => {
  assert.ok(blocked(bash("bash -c \"gh pr create --title 'fix: 오류' --body '고침'\"")));
});
