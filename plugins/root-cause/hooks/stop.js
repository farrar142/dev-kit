// Stop: 이번 턴의 답에 단정한 `근본 원인:` 줄이 있는데 모양을 갖춘 `증거:` 줄이 없으면 턴을 한 번 되돌려 증거를 붙이게 한다.
//   - 답 글: Stop 입력의 last_assistant_message 가 있으면 그것, 없으면 transcript_path 꼬리(마지막 사람 입력·주입 메시지 뒤 assistant 글)
//   - 기록이 아직 안 써졌으면 짧게 한 번 다시 읽고, 그래도 못 찾으면 통과한다(관문이지 보안 경계가 아니다)
//   - stop_hook_active 면 통과(한 턴에 한 번만 되돌린다)
//   - 이번 턴 도구 호출 0 + 단정은 막지 않고 로컬 jsonl 에 기록만 한다(ROOT_CAUSE_LOG, 없으면 $XDG_STATE_HOME/root-cause/no-tool-assertions.jsonl)
//   - 끄기: ROOT_CAUSE_OFF=1
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { disabled, readStdin } = require('./signals');
const { assertedRootCauses, hasEvidenceLine } = require('./rootline');

const TAIL_BYTES = 512 * 1024;
const RETRY_MS = 300;

function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (size > len) text = text.slice(text.indexOf('\n') + 1); // 맨 앞 조각은 줄 중간일 수 있다
    return text;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const blocksOf = (m) => (m && Array.isArray(m.content) ? m.content : typeof (m && m.content) === 'string' ? [{ type: 'text', text: m.content }] : []);

// transcript 꼬리에서 이번 턴(마지막 「사람·주입」 user 메시지 뒤)의 assistant 글과 도구 호출 수.
// tool_result 만 담은 user 메시지는 턴 경계가 아니다. 찾을 게 없으면 null.
function turnFromTranscript(tail) {
  if (!tail) return null;
  const entries = [];
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  let start = -1;
  entries.forEach((e, i) => {
    const m = e && e.message;
    if (!m || (e.type !== 'user' && m.role !== 'user')) return;
    const bs = blocksOf(m);
    if (bs.length && bs.every((b) => b && b.type === 'tool_result')) return;
    start = i;
  });
  const texts = [];
  let tools = 0;
  for (const e of entries.slice(start + 1)) {
    const m = e && e.message;
    if (!m || (e.type !== 'assistant' && m.role !== 'assistant')) continue;
    for (const b of blocksOf(m)) {
      if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b && b.type === 'tool_use') tools += 1;
    }
  }
  if (!texts.length) return null;
  return { text: texts.join('\n'), tools };
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

function loadTurn(input) {
  const file = input.transcript_path;
  if (typeof file !== 'string' || !file) return null;
  let turn = turnFromTranscript(readTail(file));
  if (!turn || !assertedRootCauses(turn.text).length) {
    // 마지막 글이 아직 기록되기 전일 수 있다 — 한 번만 다시 읽는다.
    if (!turn) {
      sleepSync(RETRY_MS);
      turn = turnFromTranscript(readTail(file));
    }
  }
  return turn;
}

function logFile() {
  if (process.env.ROOT_CAUSE_LOG) return process.env.ROOT_CAUSE_LOG;
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'root-cause', 'no-tool-assertions.jsonl');
}

function recordNoTool(input, claims) {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = {
      ts: new Date().toISOString(),
      session_id: typeof input.session_id === 'string' ? input.session_id : null,
      claims: claims.slice(0, 3).map((c) => c.slice(0, 200)),
      evidence: false,
    };
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  } catch {}
}

const REASON = [
  'root-cause: 답에 단정한 `근본 원인:` 줄이 있는데 증거 줄이 없어 한 번 되돌렸습니다.',
  '고칠 법: 답 전체를 다시 쓰지 말고 `증거:` 줄 하나만 덧붙여라(근본 원인 줄 끝 괄호 `(…)` 안에 아래 꼴을 넣어도 된다). 값에 다음 중 하나가 있어야 한다 — 백틱 명령(`kubectl logs …`), 경로(`/`·`\\`), `#번호`, 커밋 sha(16진 7자 이상), 시각(`HH:MM`), `파일:줄`. 「증거: 확인함」 같은 값은 통과하지 못한다.',
  '직접 확인하지 못한 짐작이면 `근본 원인: 미확인 — <다음 확인할 것>`으로 바꿔라. 수정이 아니면 `근본 원인: 해당 없음 — <까닭>`.',
].join('\n');

// 막을 글이면 이유를, 아니면 null
function check(input) {
  if (disabled() || input.stop_hook_active) return null;
  let text;
  let tools = null;
  if (typeof input.last_assistant_message === 'string' && input.last_assistant_message) {
    text = input.last_assistant_message;
    if (!assertedRootCauses(text).length) return null;
  }
  const turn = loadTurn(input);
  if (turn) {
    tools = turn.tools;
    // 이번 턴 전체 글이 기준이다(여러 글 조각에 걸친 줄 포함).
    text = text && !turn.text.includes(text) ? `${turn.text}\n${text}` : turn.text;
  }
  if (!text) return null;
  const claims = assertedRootCauses(text);
  if (!claims.length || hasEvidenceLine(text)) return null;
  if (tools === 0) {
    recordNoTool(input, claims);
    return null;
  }
  return REASON;
}

module.exports = { check, turnFromTranscript, logFile, REASON };

if (require.main === module) {
  readStdin((input) => {
    const reason = check(input);
    if (reason) {
      process.stderr.write(reason + '\n');
      process.exit(2);
    }
    process.exit(0);
  });
}
