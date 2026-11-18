// 문제 신호 낱말과 설정 — prompt.js·gate.js 가 함께 쓴다.
//   내장 목록(BUILTIN) + 사용자 목록 파일(저장소 밖):
//     ROOT_CAUSE_SIGNALS, 없으면 $XDG_CONFIG_HOME/root-cause/signals.txt (XDG_CONFIG_HOME 이 없으면 ~/.config)
//     한 줄 하나 정규식(JavaScript, 대소문자 무시), `#` 로 시작하면 주석. 틀린 줄은 건너뛴다(관문이지 보안 경계가 아니다).
//   끄기: ROOT_CAUSE_OFF=1 (두 훅 모두)
// Windows 는 HOME 이 없을 수 있어 os.homedir()(USERPROFILE)를 쓴다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// [이름, 정규식]. 한국어는 낱말 경계가 없어 어간으로 잡는다.
const BUILTIN = [
  ['오류', /오류/],
  ['에러', /에러/],
  ['안 됨', /안\s?(?:돼|됨|되|된다|됩니다|돼요)/],
  ['깨짐', /깨(?:짐|져|졌|지)/],
  ['뜨는데', /뜨는데|떠요|뜹니다/],
  ['느림', /느려|느림|느립니다|느리게/],
  ['장애', /장애/],
  ['실패', /실패/],
  ['이상함', /이상(?:해|하|함|합니다)/],
  ['왜', /(?:^|\s)왜(?:\s|$)/],
  ['버그', /버그/],
  ['먹통·죽음', /먹통|죽었|죽어|죽음|터졌|터짐|튕/],
  ['멈춤', /멈췄|멈춰|멈춤|안\s?열/],
  ['HTTP 4xx·5xx', /(?<![\d.,:/#-])[45]\d{2}(?![\d.,:/]|\s*(?:개|줄|자|명|원|건|초|분|번|쪽|ms|px|[KMG]B|%|lines?|items?|tokens?)\b|\s*(?:개|줄|자|명|원|건|초|분|번|쪽))/],
  ['Traceback', /Traceback/],
  ['Exception', /Exception|\bpanic(?:ked)?\b|segfault/i],
  ['error', /\berrors?\b|\bfail(?:s|ed|ing|ure)?\b|\bbroken\b|\bcrash(?:es|ed|ing)?\b|\bbug\b|\boutage\b|\bregression\b|\bnot working\b|\bdoesn'?t work\b|\btimed? ?out\b/i],
];

function signalsFile() {
  if (process.env.ROOT_CAUSE_SIGNALS) return process.env.ROOT_CAUSE_SIGNALS;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'root-cause', 'signals.txt');
}

function loadSignals() {
  const out = [...BUILTIN];
  const file = signalsFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  text.split(/\r?\n/).forEach((line, i) => {
    const src = line.trim();
    if (!src || src.startsWith('#')) return;
    try {
      out.push([`${path.basename(file)}:${i + 1}`, new RegExp(src, 'i')]);
    } catch {}
  });
  return out;
}

// 걸린 신호 이름들
function signalHits(text, signals = loadSignals()) {
  if (!text) return [];
  return signals.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function disabled() {
  const v = (process.env.ROOT_CAUSE_OFF || '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

function readStdin(cb) {
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
    cb(input || {});
  });
}

module.exports = { BUILTIN, loadSignals, signalHits, signalsFile, disabled, readStdin };
