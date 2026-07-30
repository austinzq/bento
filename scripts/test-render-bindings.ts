// 验证 buildBindingContext（slides/src/render.ts）的 computed 依赖求值：
// 必须按依赖图（DFS + visiting 标记）求值，而不是按 Object.keys 插入顺序线性
// 求值——否则「前向引用」（被引用的 computed 字段写在引用它的字段后面）会静默
// 读到空字符串，真正的环也不会被识别成 '#ERROR'。跟 test-expr.ts 一样手写
// 断言，不引入测试框架。
//
// render.ts 的相对导入（'./model'/'./charts'/'./expr'/'./interact'）没带
// 显式后缀——tsc(moduleResolution: bundler) 和 Vite 都认识，但 Node 原生 TS
// stripping 的 ESM resolver 不会自动补后缀。ts-ext-loader.mjs 是给本地验证
// 脚本用的一个极小 resolve hook（解析失败且路径无后缀时依次试 .ts/.tsx），
// 不改动任何生产代码，也不影响 tsc -b / Vite 的真实构建。

import { register } from 'node:module'
register(new URL('./ts-ext-loader.mjs', import.meta.url))

const { buildBindingContext } = await import('../slides/src/render.ts')
const { interact } = await import('../slides/src/interact.ts')
const { evalExpr, parseExpr } = await import('../slides/src/expr.ts')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) }
}

// buildBindingContext(doc, slide) 只在乎 doc.computed/slide.computed/
// slide.paramValues，其余字段这里用不到，运行时（类型已被 stripping 抹掉）
// 传最小形状即可。
const emptyDoc = (computed: Record<string, string>) => ({ computed, slides: [] }) as any
const emptySlide = { elements: [], paramValues: undefined, computed: undefined } as any

console.log('前向引用：total 写在被依赖的 a/b 前面…')
{
  const ctx = buildBindingContext(
    emptyDoc({ total: 'computed.a + computed.b', a: '5', b: '10' }),
    emptySlide,
  )
  ok(ctx['computed.a'] === '5', 'computed.a itself resolves')
  ok(ctx['computed.b'] === '10', 'computed.b itself resolves')
  ok(ctx['computed.total'] === '15', 'forward-referenced computed.total resolves via dependency order (not insertion order → would be 0/"" if naively linear)')
}

console.log('真环：a 依赖 b，b 依赖 a…')
{
  const ctx = buildBindingContext(
    emptyDoc({ a: 'computed.b', b: 'computed.a' }),
    emptySlide,
  )
  ok(Object.values({ a: ctx['computed.a'], b: ctx['computed.b'] }).every((v) => v === '#ERROR'),
    'both cycle members resolve to #ERROR, not silently wrong/empty values')
}

console.log('自环：a 引用自己…')
{
  const ctx = buildBindingContext(
    emptyDoc({ a: 'computed.a + 1' }),
    emptySlide,
  )
  ok(ctx['computed.a'] === '#ERROR', 'self-referencing computed field resolves to #ERROR, never recurses forever')
}

console.log('table.<tableId>.<column> 聚合：buildBindingContext 用 tableChartColumns 填充列数据…')
{
  // 真实 TableElement 结构：header 行 + 3 行数字数据。tableChartColumns（复用
  // 自 model.ts，syncLinkedChart 已在用）负责"表头文本→列名 + 数字列提取"，
  // buildBindingContext 不重新实现这套逻辑，只是把结果写进 ctx。
  // expr.ts 的分词器目前只认 [A-Za-z0-9_.]（不支持中文标识符——这是分词器本身
  // 既有的限制，跟本次改动无关，不在本task范围内），所以这里表头列名用英文，
  // 跟task描述里的 sum(table.sales.amount) 示例保持一致，也是真实用法。
  const cell = (html: string) => ({ html })
  const table = {
    id: 'sales',
    type: 'table',
    header: true,
    columns: [{ w: 1 }, { w: 1 }, { w: 1 }],
    rows: [
      { cells: [cell('产品'), cell('amount'), cell('tax')] },
      { cells: [cell('A'), cell('100'), cell('10')] },
      { cells: [cell('B'), cell('200'), cell('20')] },
      { cells: [cell('C'), cell('300'), cell('15')] },
    ],
  } as any
  const doc = { computed: {}, slides: [{ elements: [table] }] } as any
  const slide = doc.slides[0]
  const ctx = buildBindingContext(doc, slide)

  ok(Array.isArray(ctx['table.sales.amount']), 'ctx carries the column as a number[], not a string')
  ok(JSON.stringify(ctx['table.sales.amount']) === JSON.stringify([100, 200, 300]), '列数据按行序正确提取')
  ok(JSON.stringify(ctx['table.sales.tax']) === JSON.stringify([10, 20, 15]), '第二个数字列也被提取')

  ok(evalExpr(parseExpr('sum(table.sales.amount)'), ctx) === 600, 'sum(table.sales.amount) 对整列求和 = 600')
  ok(evalExpr(parseExpr('avg(table.sales.amount)'), ctx) === 200, 'avg(table.sales.amount) = 200')
  ok(evalExpr(parseExpr('count(table.sales.amount)'), ctx) === 3, 'count(table.sales.amount) = 3')
  ok(evalExpr(parseExpr('min(table.sales.amount)'), ctx) === 100, 'min(table.sales.amount) = 100')
  ok(evalExpr(parseExpr('max(table.sales.amount)'), ctx) === 300, 'max(table.sales.amount) = 300')
  ok(evalExpr(parseExpr('sum(table.sales.amount, table.sales.tax)'), ctx) === 645,
    '多列参数合并求和 = 600 + 45')

  ok(evalExpr(parseExpr('sum(table.sales.missing)'), ctx) === 0,
    '列名对不上时 ctx 里没有对应 key，var 解析成 "" → num("") = 0，不抛异常')
  ok(evalExpr(parseExpr('sum(table.nosuchtable.amount)'), ctx) === 0,
    'tableId 对不上时同样 fail-open 成 0')
}

console.log('健全性检查：interact store 没有因为这几次调用被污染…')
ok(Object.keys(interact.snapshot()).length === 0, 'buildBindingContext never writes into the interact store, only reads it')

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES of ${checks} checks`)
process.exit(failures ? 1 : 0)
