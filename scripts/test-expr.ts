import { parseExpr, evalExpr, resolveExprString } from '../slides/src/expr.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) }
}

console.log('literal + variable lookup…')
ok(evalExpr(parseExpr('filter.region'), { 'filter.region': '华东' }) === '华东', 'variable resolves')
ok(evalExpr(parseExpr('filter.region'), {}) === '', 'missing key resolves to empty string, not throw')

console.log('whitelisted functions…')
ok(evalExpr(parseExpr('sum(1,2,3)'), {}) === 6, 'sum works')
ok(evalExpr(parseExpr('avg(2,4)'), {}) === 3, 'avg works')
ok(evalExpr(parseExpr('max(1,5,2)'), {}) === 5, 'max works')

console.log('ternary + comparison…')
ok(evalExpr(parseExpr("input.budget > 100 ? '超支' : '正常'"), { 'input.budget': 200 }) === '超支', 'ternary + comparison')

console.log('malformed expressions never throw via resolveExprString…')
ok(resolveExprString('filter.(((', {}) === '{{filter.(((}}', 'syntax error falls back to literal token')
ok(resolveExprString('unknownFunc(1)', {}) === '{{unknownFunc(1)}}', 'non-whitelisted function falls back to literal token')

console.log('no eval/Function in source (static check)…')
{
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../slides/src/expr.ts', import.meta.url), 'utf8')
  ok(!/\beval\s*\(/.test(src), 'no eval( call in expr.ts')
  ok(!/new\s+Function\s*\(/.test(src), 'no new Function( call in expr.ts')
}

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES of ${checks} checks`)
process.exit(failures ? 1 : 0)
