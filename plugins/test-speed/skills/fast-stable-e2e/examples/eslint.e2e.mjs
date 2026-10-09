// E2E 시험에서 폴링·시간 대기·재시도를 lint로 막는다(ESLint flat config 조각, 코어 규칙만 쓴다).
// 이벤트 도우미 파일(e2e-support.ts)만 뺀다. oxlint는 `no-restricted-properties`를 그대로 받고,
// `no-restricted-syntax`는 JS 플러그인(`jsPlugins`)으로 붙인다 — 같은 선택자를 쓴다.
const WAIT = '이벤트 도우미(waitFor·waitForMessage·arm·act)로 기다린다.'

export default [
  {
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    ignores: ['e2e/e2e-support.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'expect', property: 'poll', message: `E2E는 폴링하지 않는다 — ${WAIT}` },
        { property: 'toPass', message: `되풀이해 다시 보지 않는다 — ${WAIT}` },
        { property: 'waitForTimeout', message: `시간으로 기다리지 않는다 — ${WAIT}` },
        { property: 'waitForFunction', message: `waitForFunction은 폴링이다 — waitFor(이벤트마다 다시 본다)를 쓴다.` },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name=/^(setTimeout|setInterval|requestAnimationFrame)$/]',
          message: `시간·프레임으로 기다리지 않는다 — ${WAIT}`,
        },
        {
          selector: 'CallExpression[callee.property.name=/^(setTimeout|setInterval|requestAnimationFrame)$/]',
          message: `시간·프레임으로 기다리지 않는다 — ${WAIT}`,
        },
        { selector: 'WhileStatement', message: `되풀이 루프로 기다리지 않는다 — ${WAIT}` },
        { selector: 'DoWhileStatement', message: `되풀이 루프로 기다리지 않는다 — ${WAIT}` },
        {
          selector: 'ForStatement > .test AwaitExpression, ForStatement > AwaitExpression.test',
          message: `조건에 await가 든 for는 되풀이 조회다 — ${WAIT}`,
        },
        {
          selector: "Property[key.name='retries']:not([value.value=0])",
          message: '다시 돌리지 않는다(retries 0) — 흔들리면 원인을 고친다.',
        },
      ],
    },
  },
]
