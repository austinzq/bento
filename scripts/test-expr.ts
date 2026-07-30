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

console.log('table.<id>.<col> column refs (number[]) inside aggregate functions…')
{
  // buildBindingContext (render.ts) fills ctx['table.<id>.<col>'] with a
  // number[] straight from tableChartColumns — simulate that shape here so
  // this file stays independent of render.ts's DOM-ish import graph. The
  // end-to-end extraction (real TableElement → tableChartColumns →
  // buildBindingContext → ctx) is covered in test-render-bindings.ts.
  const ctx = { 'table.sales.amount': [10, 20, 30], 'table.sales.tax': [1, 2, 3] }
  ok(evalExpr(parseExpr('sum(table.sales.amount)'), ctx) === 60, 'sum() reduces a whole column')
  ok(evalExpr(parseExpr('avg(table.sales.amount)'), ctx) === 20, 'avg() over a column')
  ok(evalExpr(parseExpr('count(table.sales.amount)'), ctx) === 3, 'count() over a column')
  ok(evalExpr(parseExpr('min(table.sales.amount)'), ctx) === 10, 'min() over a column')
  ok(evalExpr(parseExpr('max(table.sales.amount)'), ctx) === 30, 'max() over a column')
  ok(evalExpr(parseExpr('sum(table.sales.amount, table.sales.tax)'), ctx) === 66,
    'multiple column args flatten and merge into one reduction (60 + 6)')
  ok(evalExpr(parseExpr('sum(1,2,3)'), {}) === 6, 'no regression: pure-scalar sum still works unchanged')
  ok(evalExpr(parseExpr('sum(table.sales.amount, 5)'), ctx) === 65, 'column ref mixed with a scalar arg both flatten into the same reduction')
}

console.log('unresolvable table/column references fail open…')
ok(evalExpr(parseExpr('sum(table.missing.col)'), {}) === 0,
  'missing table/column resolves the var to "" (fail-open var lookup) → num("") = 0, never throws')
ok(evalExpr(parseExpr('avg(table.missing.col)'), {}) === 0, 'same for avg on a missing ref')
ok(evalExpr(parseExpr('count(table.missing.col)'), {}) === 1, 'count() of one unresolved scalar ref is 1 (the "" collapses to a single 0, not an empty column)')

console.log('ternary + comparison…')
ok(evalExpr(parseExpr("input.budget > 100 ? '超支' : '正常'"), { 'input.budget': 200 }) === '超支', 'ternary + comparison')

console.log('string vs numeric comparison…')
ok(evalExpr(parseExpr("'2026-01-01' < '2026-02-01'"), {}) === true, 'date strings compare lexicographically (not truncated)')
ok(evalExpr(parseExpr("'2026-02-01' > '2026-01-01'"), {}) === true, 'date strings compare lexicographically (correct order)')
ok(evalExpr(parseExpr('100 > 50'), {}) === true, 'numeric comparison still works')

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
