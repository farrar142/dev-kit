// `node --test --import ./test/tsx.mjs`: 단위 시험이 `.tsx`(화면 조각)를 읽게 한다. vitest·jest 없이.
// `.ts`는 Node(22.18+/23.6+)가 타입만 지워 그대로 읽고, `.tsx`만 TypeScript로 JSX를 풀어 넘긴다(`react-jsx`, 타입 검사 없음).
// TypeScript는 `.tsx`를 처음 만날 때 한 번 싣는다 - `.ts`만 읽는 시험 파일은 값을 치르지 않는다.
// CSS 같은 자산 import는 빈 모듈로 바꾼다(번들러 몫이다).
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
let ts

const ASSET = /\.(css|svg|png|jpe?g|webp|woff2?)$/

registerHooks({
  load(url, context, nextLoad) {
    const path = url.startsWith('file:') ? new URL(url).pathname : ''
    if (ASSET.test(path)) return { format: 'module', source: 'export default ""', shortCircuit: true }
    if (!path.endsWith('.tsx')) return nextLoad(url, context)
    ts ??= require('typescript')
    const file = fileURLToPath(url)
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
        verbatimModuleSyntax: true,
        sourceMap: false,
        inlineSourceMap: true,
      },
    })
    return { format: 'module', source: outputText, shortCircuit: true }
  },
})
