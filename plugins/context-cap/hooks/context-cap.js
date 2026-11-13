// context-cap: 세션 컨텍스트가 상한을 넘으면 새 지시를 거절하고(SOFT), 넘김·보고 말고는 도구를 막는다(HARD).
// 환경변수 CONTEXT_CAP_SOFT / CONTEXT_CAP_HARD 로 켜고, 없으면 --agent issue-worker 본 세션만 기본값(250k/300k)으로 켠다.
// 한 스크립트가 UserPromptSubmit·PostToolUse·PreToolUse 를 hook_event_name 으로 나눠 처리한다.
// 가드레일이지 보안 경계가 아니다 — 선의의 작업자가 상한을 넘겨 계속 일하는 것을 막는 용도.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const DEFAULT_SOFT = 250000;
const DEFAULT_HARD = 300000;
const has = (v) => v !== undefined && v !== '';

// 상한을 정한다. 환경변수 CONTEXT_CAP_SOFT·HARD 중 하나라도 있으면 그 값만 쓴다(없는 쪽은 0, SOFT=0 이면 끔).
// 둘 다 없으면 `claude --agent <이름>` 으로 뜬 본 세션이고 이름이 CONTEXT_CAP_AGENTS(기본 issue-worker)에 있을 때만 기본값.
// 훅 입력: --agent 본 세션은 agent_type 만, 서브에이전트 안 도구 호출은 agent_type 과 agent_id 가 함께 온다.
function limits(input, env = process.env) {
  if (has(env.CONTEXT_CAP_SOFT) || has(env.CONTEXT_CAP_HARD)) {
    return { soft: num(env.CONTEXT_CAP_SOFT), hard: num(env.CONTEXT_CAP_HARD) };
  }
  const agent = input && input.agent_type;
  if (!agent || input.agent_id) return { soft: 0, hard: 0 };
  // CONTEXT_CAP_AGENTS='' 이면 기본 대상 없음.
  const names = (env.CONTEXT_CAP_AGENTS === undefined ? 'issue-worker' : env.CONTEXT_CAP_AGENTS)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  // 플러그인 에이전트는 'plugin:name' 으로 올 수 있어 끝 이름도 맞춰 본다.
  const bare = String(agent).split(':').pop();
  if (!names.includes(agent) && !names.includes(bare)) return { soft: 0, hard: 0 };
  return { soft: DEFAULT_SOFT, hard: DEFAULT_HARD };
}
let SOFT = 0;
let HARD = 0;
let THRESHOLD = 0;

const BLOCK_BYTES = 1 << 20; // 끝에서부터 1MB 씩 읽는다
const MAX_SCAN_BYTES = 64 << 20; // 이만큼 읽어도 못 찾으면 모른다고 본다

const HANDOFF_PROMPT = new RegExp(process.env.CONTEXT_CAP_HANDOFF_PATTERN || '넘김|handoff|hand[ -]off|handover', 'i');
const HANDOFF_FILE = /handoff|hand-off|넘김/i;
// 하네스가 UserPromptSubmit 으로 넣는 자동 알림. claude 2.1.318 에서 배경 Bash 완료·Monitor 이벤트 모두
// prompt 가 이 태그로 시작했다(훅 입력에 출처 필드는 없다). 사람 지시가 아니므로 SOFT 에서도 통과시킨다.
const HARNESS_PROMPT = /^\s*<task-notification>/;
// 배경 작업 출력 파일(<임시>/<프로젝트>/<세션>/tasks/<id>.output). HARD 에서도 읽게 둔다.
const TASK_OUTPUT_FILE = /[\\/]tasks[\\/][^\\/]+\.output$/;
const ALWAYS_ALLOWED_TOOLS = new Set(['SendMessage', 'ToolSearch', 'TaskStop', 'KillShell', 'TaskOutput']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
// HARD 넘은 뒤에도 허용하는 Bash 조각(명령을 &&·;·| 로 나눈 각 조각이 하나에 맞아야 한다).
// 「하던 티켓은 끝낸다」: 보고·넘김에 더해 CI·배포 기다리기, 병합, 정리까지 남긴다.
const GIT_SUB = '(status|add|commit|push|log|diff|show|rev-parse|branch|stash|fetch|pull|rebase|worktree|switch|checkout)';
const BASH_ALLOW = [
  /^cd(\s|$)/,
  /^(echo|printf|pwd|date|true)(\s|$)/,
  /^(tail|head)(\s|$)/,
  new RegExp(`^git\\s+${GIT_SUB}(\\s|$)`),
  new RegExp(`^git\\s+-C\\s+\\S+\\s+${GIT_SUB}(\\s|$)`),
  /^gh\s+(issue|pr)\s+(comment|view|list|checks|status|merge|close)(\s|$)/,
  /^gh\s+run\s+(view|list)(\s|$)/,
  /^(python3?|py)\s+\S*wait-(ci|deploy)\.py(\s|$)/,
  /^orca\s+orchestration\s+(send|reply)(\s|$)/,
  /^(AGENT_MAIL_PROFILE=\S+\s+)?(\S*\/)?agent-mail\s+(send|reply|complete|ack)(\s|$)/,
  /^(kill|fuser\s+-k)(\s|$)/,
];
if (process.env.CONTEXT_CAP_ALLOW_BASH) {
  try {
    BASH_ALLOW.push(new RegExp(process.env.CONTEXT_CAP_ALLOW_BASH));
  } catch {
    /* 잘못된 정규식은 무시 */
  }
}

const k = (n) => `${Math.round(n / 1000)}k`;

// transcript JSONL 을 끝에서부터 읽어 본 세션의 현재 컨텍스트 토큰을 돌려준다.
// compact 경계를 먼저 만나면 0(정리 뒤 아직 응답 없음), 못 찾으면 null.
function measure(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    let pos = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let scanned = 0;
    while (pos > 0 && scanned < MAX_SCAN_BYTES) {
      const len = Math.min(BLOCK_BYTES, pos);
      pos -= len;
      scanned += len;
      const block = Buffer.alloc(len);
      fs.readSync(fd, block, 0, len, pos);
      const buf = carry.length ? Buffer.concat([block, carry]) : block;
      // 맨 앞 조각은 줄 중간일 수 있다 — 파일 처음이 아니면 다음 블록으로 넘긴다.
      let end = buf.length;
      let i = buf.lastIndexOf(10, end - 1);
      while (i >= 0) {
        const r = judge(buf.subarray(i + 1, end));
        if (r !== undefined) return r;
        end = i;
        i = end > 0 ? buf.lastIndexOf(10, end - 1) : -1;
      }
      carry = buf.subarray(0, end);
      if (pos === 0 && carry.length) {
        const r = judge(carry);
        if (r !== undefined) return r;
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// 한 줄을 보고: 숫자(답) / undefined(계속 찾기).
function judge(lineBuf) {
  if (lineBuf.length < 10) return undefined;
  const s = lineBuf.toString('utf8');
  const isAssistant = s.includes('"assistant"');
  const isBoundary = s.includes('compact_boundary');
  if (!isAssistant && !isBoundary) return undefined;
  let d;
  try {
    d = JSON.parse(s);
  } catch {
    return undefined;
  }
  if (!d || d.isSidechain) return undefined;
  if (d.type === 'system' && d.subtype === 'compact_boundary') return 0;
  if (d.type !== 'assistant') return undefined;
  const m = d.message || {};
  const u = m.usage;
  if (!u || m.model === '<synthetic>') return undefined;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

function stateFile(sessionId) {
  const dir = process.env.CONTEXT_CAP_STATE_DIR || path.join(os.tmpdir(), 'context-cap');
  const id = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return { dir, file: path.join(dir, `${id}.json`) };
}
function loadState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(sessionId).file, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(sessionId, st) {
  try {
    const { dir, file } = stateFile(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(st));
  } catch {
    /* 상태를 못 남겨도 훅은 성공 */
  }
}

// SOFT 를 처음 넘을 때 한 번 알림 명령을 띄운다. 기다리지 않고, 실패해도 무시한다.
function notifyOnce(sessionId, st, tokens) {
  const cmd = process.env.CONTEXT_CAP_NOTIFY_CMD;
  if (!cmd || st.notifyRan) return;
  st.notifyRan = true;
  try {
    const child = spawn(cmd, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        CONTEXT_CAP_TOKENS: String(tokens),
        CONTEXT_CAP_SESSION_ID: String(sessionId || ''),
      },
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 무시 */
  }
}

function emit(obj) {
  // Windows 콘솔 인코딩에서 깨지지 않게 비 ASCII 를 \u 이스케이프로.
  process.stdout.write(
    JSON.stringify(obj).replace(/[\u0080-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
  );
}

// 따옴표 안·heredoc 본문을 지운 뒤 &&·||·;·|·줄바꿈으로 나눈다.
function bashSegments(cmd) {
  let s = String(cmd || '');
  s = s.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2(?=\s|$|\))/g, '');
  s = s.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""');
  if (/\$\(|`/.test(s)) return null; // 따옴표 밖 명령 치환은 판단하지 않고 막는다
  return s
    .split(/&&|\|\||;|\||\n/)
    .map((x) => x.trim().replace(/^(\w+=\S*\s+)+/, '').replace(/^rtk\s+/, ''))
    .filter(Boolean);
}
function bashAllowed(cmd) {
  const segs = bashSegments(cmd);
  if (!segs || !segs.length) return false;
  return segs.every((seg) => BASH_ALLOW.some((re) => re.test(seg)));
}
function toolAllowedAtHard(tool, input) {
  if (ALWAYS_ALLOWED_TOOLS.has(tool)) return true;
  const file = String((input && (input.file_path || input.path)) || '');
  if (FILE_TOOLS.has(tool)) return HANDOFF_FILE.test(file);
  if (tool === 'Read') return TASK_OUTPUT_FILE.test(file) || HANDOFF_FILE.test(path.basename(file));
  if (tool === 'Bash') return bashAllowed(input && input.command);
  return false;
}

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
  if (!input || typeof input !== 'object') process.exit(0);
  if (input.hook_event_name === 'UserPromptSubmit' && HARNESS_PROMPT.test(String(input.prompt || ''))) process.exit(0);
  ({ soft: SOFT, hard: HARD } = limits(input));
  if (!SOFT && !HARD) process.exit(0);
  // SOFT 가 없으면 HARD 가 SOFT 몫(거절·알림)도 한다.
  THRESHOLD = SOFT || HARD;
  const event = input.hook_event_name;
  const tokens = measure(input.transcript_path);
  if (tokens == null || tokens < THRESHOLD) process.exit(0);
  const sid = input.session_id;

  if (event === 'UserPromptSubmit') {
    if (HANDOFF_PROMPT.test(String(input.prompt || ''))) process.exit(0);
    const st = loadState(sid);
    notifyOnce(sid, st, tokens);
    saveState(sid, st);
    emit({
      decision: 'block',
      reason: `context-cap: 컨텍스트 ${k(tokens)} — 상한(${k(THRESHOLD)}) 넘음. 새 세션에서 받으라. (넘김 문서를 쓰라는 지시는 「넘김」·handoff 를 넣으면 받는다)`,
    });
    process.exit(0);
  }

  if (event === 'PostToolUse') {
    const st = loadState(sid);
    if (st.softNotified) process.exit(0);
    st.softNotified = true;
    notifyOnce(sid, st, tokens);
    saveState(sid, st);
    emit({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `context-cap: 컨텍스트 ${k(tokens)} — 상한(${k(THRESHOLD)}) 넘음. 지금 티켓을 마치고 보고에 「새 세션 필요(컨텍스트 ${k(tokens)})」를 넣고 더 일을 받지 마라.` +
          (HARD ? ` ${k(HARD)}를 넘으면 넘김 문서 쓰기와 보고 말고는 도구가 막힌다.` : ''),
      },
    });
    process.exit(0);
  }

  if (event === 'PreToolUse') {
    if (!HARD || tokens < HARD) process.exit(0);
    if (toolAllowedAtHard(input.tool_name, input.tool_input)) process.exit(0);
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `context-cap: 컨텍스트 ${k(tokens)} — HARD 상한(${k(HARD)}) 넘음. 넘김 문서를 쓰고 보고한 뒤 멈춰라. ` +
          '허용: 이름에 handoff·넘김이 든 파일의 Write/Edit/Read, 배경 작업 출력 읽기(TaskOutput, tasks/*.output Read, tail·head), ' +
          '마무리용 Bash(git status·add·commit·push·fetch·pull·rebase·worktree·branch, gh pr checks·view·merge·comment, gh issue close·comment, gh run view, wait-ci.py·wait-deploy.py, orca orchestration send·reply, echo, kill), SendMessage.',
      },
    });
    process.exit(0);
  }
  process.exit(0);
});
