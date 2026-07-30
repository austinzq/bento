# BI 风格交互式绑定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 bento/slides 加入响应式数据绑定（筛选器联动、交叉筛选、钻取、观众输入、
可复用组件参数化），实现 `docs/superpowers/specs/2026-07-30-interactive-bindings-design.md`。

**Architecture:** 一个受限表达式求值器（`expr.ts`，白名单文法，无 eval/Function）+
一个运行时 pub-sub store（`interact.ts`，localStorage 会话缓存）驱动 `render.ts` 里
新增的绑定解析 pass；两个新元素类型 `filter`/`input`；图表点击交叉筛选复用同一
store；组件参数是 layout 实例上的一层作用域链；保存工作流决定运行时状态是否
merge 进文档。

**Tech Stack:** TypeScript, Vite（无打包框架），无 npm 测试运行器——本仓库的测试
约定是独立 Node 脚本 + 手写 `ok(cond, msg)` 断言（参照 `scripts/test-sync.ts`），
用 `node scripts/test-xxx.ts`（Node ≥ 23.6 原生 TS stripping）直接跑。

## Global Constraints

- 文档不可夹带可执行代码：表达式求值器必须是手写递归下降解析器，绝不能出现
  `eval(`、`new Function(`、`Function(` 调用（spec §3.3，invariant #3）。
- 所有新增文档字段必须是 optional/additive，老文件在新 shell 里必须照常打开
  （invariant #1）。
- 类型检查命令：`cd slides && node_modules/.bin/tsc -b`（或
  `slides/node_modules/.bin/tsc -p ../kernel` 单独查 kernel）。
- 不引入外部数据源、不发起任何在 present/editor 渲染路径里的网络请求（本 spec
  范围内绑定的数据只来自文档内嵌的 `table` 元素）。
- 循环依赖/未知 key 引用必须 fail-open（渲染 `#ERROR` 或空字符串），绝不抛出
  未捕获异常导致页面崩溃。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `slides/src/expr.ts`（新建） | 受限表达式文法的分词器 + 递归下降解析器 + 求值器。纯函数，不碰 DOM、不碰 store。 |
| `scripts/test-expr.ts`（新建） | `expr.ts` 的独立测试脚本。 |
| `slides/src/interact.ts`（新建） | 运行时 pub-sub store：`filter.*`/`input.*`/`params.*`/`computed.*` 命名空间；localStorage 会话持久化；依赖图 + 选择性重渲染回调。 |
| `scripts/test-interact.ts`（新建） | `interact.ts` 的独立测试脚本。 |
| `slides/src/model.ts`（修改） | 新增 `FilterElement`/`InputElement`；`ChartElement.filterKey`；`Slide.computed`/`BentoDoc.computed`；`BentoDoc.interactState`；layout `params`/实例 `paramValues`。 |
| `slides/src/render.ts`（修改） | 渲染前跑一遍绑定解析（`resolveBindings`）；`renderElement` 新增 `case 'filter'`/`case 'input'`。 |
| `kernel/src/charts.ts`（修改） | `mountChart` 新增可选 `onCategoryClick` 回调参数，点击离散类目时触发。 |
| `slides/src/present.ts`（修改） | `mountLiveCharts` 把 `chart.filterKey` 接到 `onCategoryClick`：写入 interact store + 若有 `link` 则跳转。 |
| `slides/src/editor/panels.ts`（修改） | filter/input 元素的属性面板（kind/key/options/default）；组件实例的 `params.*` 编辑区。 |
| `slides/src/editor/editor.ts`（修改） | File/About 菜单新增两个存档动作：「保存当前状态到文件」「清空并存为公版模板」。 |

---

### Task 1: 受限表达式求值器

**Files:**
- Create: `slides/src/expr.ts`
- Test: `scripts/test-expr.ts`

**Interfaces:**
- Produces: `parseExpr(src: string): ExprNode`（抛出 `ExprSyntaxError` 于非法输入）；
  `evalExpr(node: ExprNode, ctx: Record<string, unknown>): unknown`；
  `resolveExprString(src: string, ctx: Record<string, unknown>): string`（供 render.ts
  直接调用：解析失败或求值出错时返回原始 token 字面量，绝不抛出）。

- [ ] **Step 1: 写测试脚本骨架 + 第一个失败用例**

```ts
// scripts/test-expr.ts
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

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES of ${checks} checks`)
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-expr.ts`
Expected: 报错 `Cannot find module '../slides/src/expr.ts'`（文件还不存在）

- [ ] **Step 3: 实现最小可用的分词器 + 解析器 + 求值器**

```ts
// slides/src/expr.ts
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// 受限表达式文法：变量引用（filter./input./params./computed./table.）、
// 四则运算、比较、三元、白名单函数 sum/avg/count/min/max。手写递归下降，
// 绝不调用 eval/Function —— 文档字段必须是可以安全反复求值的纯数据字符串。

export class ExprSyntaxError extends Error {}

export type ExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'var'; path: string }
  | { kind: 'call'; name: string; args: ExprNode[] }
  | { kind: 'bin'; op: string; l: ExprNode; r: ExprNode }
  | { kind: 'ternary'; cond: ExprNode; then: ExprNode; else: ExprNode }

const WHITELISTED_FUNCS = new Set(['sum', 'avg', 'count', 'min', 'max'])

interface Token { kind: 'num' | 'str' | 'ident' | 'op' | 'eof'; value: string }

function tokenize(src: string): Token[] {
  const toks: Token[] = []
  let i = 0
  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c)
  const isIdentPart = (c: string) => /[A-Za-z0-9_.]/.test(c)
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      toks.push({ kind: 'num', value: src.slice(i, j) }); i = j; continue
    }
    if (c === "'" || c === '"') {
      const quote = c
      let j = i + 1
      while (j < src.length && src[j] !== quote) j++
      toks.push({ kind: 'str', value: src.slice(i + 1, j) }); i = j + 1; continue
    }
    if (isIdentStart(c)) {
      let j = i + 1
      while (j < src.length && isIdentPart(src[j])) j++
      toks.push({ kind: 'ident', value: src.slice(i, j) }); i = j; continue
    }
    const two = src.slice(i, i + 2)
    if (['==', '!=', '>=', '<='].includes(two)) { toks.push({ kind: 'op', value: two }); i += 2; continue }
    if ('+-*/()?:,><'.includes(c)) { toks.push({ kind: 'op', value: c }); i++; continue }
    throw new ExprSyntaxError(`unexpected character '${c}' at ${i}`)
  }
  toks.push({ kind: 'eof', value: '' })
  return toks
}

/** Recursive-descent parser. Precedence: ternary < comparison < additive < multiplicative < primary. */
function parseTokens(toks: Token[]): ExprNode {
  let pos = 0
  const peek = () => toks[pos]
  const next = () => toks[pos++]
  const expect = (value: string) => {
    if (peek().value !== value) throw new ExprSyntaxError(`expected '${value}' got '${peek().value}'`)
    return next()
  }

  function parseTernary(): ExprNode {
    const cond = parseComparison()
    if (peek().value === '?') {
      next()
      const then = parseTernary()
      expect(':')
      const els = parseTernary()
      return { kind: 'ternary', cond, then, else: els }
    }
    return cond
  }
  function parseComparison(): ExprNode {
    let l = parseAdditive()
    while (['==', '!=', '>', '<', '>=', '<='].includes(peek().value)) {
      const op = next().value
      l = { kind: 'bin', op, l, r: parseAdditive() }
    }
    return l
  }
  function parseAdditive(): ExprNode {
    let l = parseMultiplicative()
    while (peek().value === '+' || peek().value === '-') {
      const op = next().value
      l = { kind: 'bin', op, l, r: parseMultiplicative() }
    }
    return l
  }
  function parseMultiplicative(): ExprNode {
    let l = parsePrimary()
    while (peek().value === '*' || peek().value === '/') {
      const op = next().value
      l = { kind: 'bin', op, l, r: parsePrimary() }
    }
    return l
  }
  function parsePrimary(): ExprNode {
    const t = peek()
    if (t.kind === 'num') { next(); return { kind: 'num', value: parseFloat(t.value) } }
    if (t.kind === 'str') { next(); return { kind: 'str', value: t.value } }
    if (t.value === '(') { next(); const e = parseTernary(); expect(')'); return e }
    if (t.kind === 'ident') {
      next()
      if (peek().value === '(') {
        if (!WHITELISTED_FUNCS.has(t.value)) throw new ExprSyntaxError(`unknown function '${t.value}'`)
        next()
        const args: ExprNode[] = []
        if (peek().value !== ')') {
          args.push(parseTernary())
          while (peek().value === ',') { next(); args.push(parseTernary()) }
        }
        expect(')')
        return { kind: 'call', name: t.value, args }
      }
      return { kind: 'var', path: t.value }
    }
    throw new ExprSyntaxError(`unexpected token '${t.value}'`)
  }

  const node = parseTernary()
  if (peek().kind !== 'eof') throw new ExprSyntaxError(`unexpected trailing token '${peek().value}'`)
  return node
}

export function parseExpr(src: string): ExprNode {
  return parseTokens(tokenize(src))
}

const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v ?? '0')) || 0)

export function evalExpr(node: ExprNode, ctx: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'num': return node.value
    case 'str': return node.value
    case 'var': return ctx[node.path] ?? ''
    case 'call': {
      const vals = node.args.map((a) => num(evalExpr(a, ctx)))
      switch (node.name) {
        case 'sum': return vals.reduce((a, b) => a + b, 0)
        case 'avg': return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
        case 'count': return vals.length
        case 'min': return vals.length ? Math.min(...vals) : 0
        case 'max': return vals.length ? Math.max(...vals) : 0
        default: throw new ExprSyntaxError(`unknown function '${node.name}'`)
      }
    }
    case 'bin': {
      const l = evalExpr(node.l, ctx), r = evalExpr(node.r, ctx)
      switch (node.op) {
        case '+': return num(l) + num(r)
        case '-': return num(l) - num(r)
        case '*': return num(l) * num(r)
        case '/': return num(r) === 0 ? 0 : num(l) / num(r)
        case '==': return l === r
        case '!=': return l !== r
        case '>': return num(l) > num(r)
        case '<': return num(l) < num(r)
        case '>=': return num(l) >= num(r)
        case '<=': return num(l) <= num(r)
        default: throw new ExprSyntaxError(`unknown operator '${node.op}'`)
      }
    }
    case 'ternary': return evalExpr(node.cond, ctx) ? evalExpr(node.then, ctx) : evalExpr(node.else, ctx)
  }
}

/**
 * Render-time entry point: never throws. Parse/eval failure → the ORIGINAL
 * token text (fail-open, same policy as the existing {{page}} resolver).
 */
export function resolveExprString(src: string, ctx: Record<string, unknown>): string {
  try {
    const result = evalExpr(parseExpr(src), ctx)
    return result === undefined || result === null ? '' : String(result)
  } catch {
    return `{{${src}}}`
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test-expr.ts`
Expected: `ALL PASS (2 checks)`

- [ ] **Step 5: 补充覆盖白名单函数、三元、非法输入、无 eval 路径的用例**

```ts
// 追加到 scripts/test-expr.ts，在 process.exit 之前

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
```

- [ ] **Step 6: 跑测试确认全部通过**

Run: `node scripts/test-expr.ts`
Expected: `ALL PASS (9 checks)`

- [ ] **Step 7: Commit**

```bash
git add slides/src/expr.ts scripts/test-expr.ts
git commit -m "feat: 受限表达式求值器（filter/input/computed绑定的求值内核）"
```

---

### Task 2: 运行时 interact store

**Files:**
- Create: `slides/src/interact.ts`
- Test: `scripts/test-interact.ts`

**Interfaces:**
- Consumes: 无（独立模块）
- Produces: `interact.set(key: string, value: unknown): void`；
  `interact.get(key: string): unknown`；
  `interact.subscribe(key: string, cb: () => void): () => void`（返回取消订阅函数）；
  `interact.snapshot(): Record<string, unknown>`；
  `interact.hydrate(docId: string, saved?: Record<string, unknown>): void`（boot 时调用：
  先加载 `saved`（来自 `doc.interactState`），再用 localStorage 会话缓存覆盖同名 key）；
  `interact.persistToLocalStorage(docId: string): void`（`set` 内部自动 debounce 调用）。

- [ ] **Step 1: 写第一个失败测试**

```ts
// scripts/test-interact.ts
import { createInteractStore } from '../slides/src/interact.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) }
}

console.log('set/get/subscribe basics…')
{
  const s = createInteractStore()
  let fired = 0
  const unsub = s.subscribe('filter.region', () => { fired++ })
  s.set('filter.region', '华东')
  ok(s.get('filter.region') === '华东', 'get returns the set value')
  ok(fired === 1, 'subscriber fired once on set')
  unsub()
  s.set('filter.region', '华南')
  ok(fired === 1, 'unsubscribed callback does not fire again')
}

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES of ${checks} checks`)
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-interact.ts`
Expected: `Cannot find module '../slides/src/interact.ts'`

- [ ] **Step 3: 实现 `interact.ts`**

```ts
// slides/src/interact.ts
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// 运行时响应式状态：filter.*/input.*/params.*/computed.* 四个命名空间的值。
// 两层持久化：会话内 localStorage 缓存（bento:interact:<docId>），只有用户
// 显式触发"保存到文件"时才 merge 进 doc.interactState（main.ts/editor.ts 负责）。
// 这里只管运行时状态本身，不碰文档 model、不碰 undo 栈。

export interface InteractStore {
  set(key: string, value: unknown): void
  get(key: string): unknown
  subscribe(key: string, cb: () => void): () => void
  snapshot(): Record<string, unknown>
  hydrate(docId: string, saved?: Record<string, unknown>): void
}

export function createInteractStore(): InteractStore {
  const values: Record<string, unknown> = {}
  const subs = new Map<string, Set<() => void>>()
  let currentDocId: string | null = null
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  function persist() {
    if (!currentDocId) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      try {
        localStorage.setItem(`bento:interact:${currentDocId}`, JSON.stringify(values))
      } catch {
        /* storage unavailable — session cache is best-effort */
      }
    }, 200)
  }

  return {
    set(key, value) {
      values[key] = value
      persist()
      for (const cb of subs.get(key) ?? []) cb()
    },
    get(key) {
      return values[key]
    },
    subscribe(key, cb) {
      if (!subs.has(key)) subs.set(key, new Set())
      subs.get(key)!.add(cb)
      return () => subs.get(key)?.delete(cb)
    },
    snapshot() {
      return { ...values }
    },
    hydrate(docId, saved) {
      currentDocId = docId
      Object.assign(values, saved ?? {})
      try {
        const cached = localStorage.getItem(`bento:interact:${docId}`)
        if (cached) Object.assign(values, JSON.parse(cached))
      } catch {
        /* corrupt/unavailable cache — fall back to `saved` only */
      }
    },
  }
}

/** Module-level singleton the app boots against (main.ts calls hydrate once). */
export const interact = createInteractStore()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test-interact.ts`
Expected: `ALL PASS (3 checks)`

- [ ] **Step 5: 补充 hydrate 优先级测试（localStorage 覆盖 saved，且损坏缓存不崩溃）**

```ts
// 追加到 scripts/test-interact.ts，在 process.exit 之前

console.log('hydrate: doc.interactState is the base, localStorage session cache wins…')
{
  // 用 globalThis.localStorage 模拟浏览器环境（Node 无原生 localStorage）
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
  }
  store.set('bento:interact:doc1', JSON.stringify({ 'filter.region': '会话缓存值' }))
  const s = createInteractStore()
  s.hydrate('doc1', { 'filter.region': '文件里的值', 'input.budget': 100 })
  ok(s.get('filter.region') === '会话缓存值', 'localStorage session cache overrides doc.interactState')
  ok(s.get('input.budget') === 100, 'keys only present in doc.interactState still hydrate')
}

console.log('hydrate: corrupt localStorage cache does not throw…')
{
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
  }
  store.set('bento:interact:doc2', 'not json{{{')
  const s = createInteractStore()
  let threw = false
  try { s.hydrate('doc2', { 'filter.x': 'ok' }) } catch { threw = true }
  ok(!threw, 'corrupt cache does not throw')
  ok(s.get('filter.x') === 'ok', 'falls back to saved state when cache is corrupt')
}
```

- [ ] **Step 6: 跑测试确认全部通过**

Run: `node scripts/test-interact.ts`
Expected: `ALL PASS (7 checks)`

- [ ] **Step 7: Commit**

```bash
git add slides/src/interact.ts scripts/test-interact.ts
git commit -m "feat: 运行时 interact store（filter/input/params/computed 状态 + localStorage会话缓存）"
```

---

### Task 3: 文档模型扩展

**Files:**
- Modify: `slides/src/model.ts:86` (`ElementBase`，无需改动，仅参照)
- Modify: `slides/src/model.ts:222-229` (`ChartElement`)
- Modify: `slides/src/model.ts:302-303` (`SlideElement` union)
- Modify: `slides/src/model.ts:325-350` (`Slide`)
- Modify: `slides/src/model.ts:352` 起的 `BentoDoc`（新增 `interactState`/`computed`；需先读取该 interface 的完整字段列表以确认插入位置——不改动既有字段顺序，只 append）

**Interfaces:**
- Consumes: 无
- Produces: `FilterElement`、`InputElement` 类型；`SlideElement`
  联合类型新增这两个 variant；`ChartElement.filterKey?: string`；
  `Slide.computed?: Record<string, string>`；`BentoDoc.computed?:
  Record<string, string>`；`BentoDoc.interactState?: Record<string, unknown>`；
  layout 相关：给 `Slide` 加 `params?: string[]`（仅当它作为 layout 使用时有意义，
  字段本身对所有 slide 都是可选的）与实例化产物的 `paramValues?: Record<string,
  string>`。

- [ ] **Step 1: 在 `model.ts` 里新增两个元素接口和 filterKey 字段**

紧跟在 `ChartElement`（约 222-229 行）之后插入：

```ts
export interface ChartElement extends ElementBase {
  type: 'chart'
  preset?: string
  option: Record<string, unknown>
  source?: { tableId: string }
  /** cross-filter: clicking a discrete category writes it to interact store
   *  under this key (bar/pie only — see spec §4.3 MVP scope note). */
  filterKey?: string
}

/** A viewer-facing filter control — writes its current value to the
 *  interact store under `key`, readable elsewhere as `{{filter.<key>}}`. */
export interface FilterElement extends ElementBase {
  type: 'filter'
  kind: 'select' | 'multiselect' | 'slider' | 'date-range'
  key: string
  optionsSource?: { tableId: string; column: string }
  options?: string[]
  label?: string
  default?: string
}

/** A viewer input box — writes its current value to the interact store
 *  under `key`, readable elsewhere as `{{input.<key>}}`. */
export interface InputElement extends ElementBase {
  type: 'input'
  kind: 'text' | 'number' | 'date'
  key: string
  label?: string
  placeholder?: string
  default?: string
}
```

- [ ] **Step 2: 把新类型加进 `SlideElement` 联合并给 Slide 加 computed/params**

```ts
export type SlideElement =
  | TextElement | ShapeElement | ImageElement | SvgElement | ChartElement | TableElement | MediaElement
  | FilterElement | InputElement
```

在 `Slide` 接口末尾（`comments?: Comment[]` 之后）追加：

```ts
  /** slide-level computed properties: name → whitelisted expression string
   *  (see expr.ts). Referenced elsewhere as {{computed.<name>}}. */
  computed?: Record<string, string>
  /** when this slide is used as a layout (doc.layouts), the named params an
   *  instance must/can supply; instances read them as {{params.<name>}}. */
  params?: string[]
  /** present on a slide INSTANTIATED from a params-bearing layout — the
   *  concrete values for this instance. */
  paramValues?: Record<string, string>
```

- [ ] **Step 3: 给 `BentoDoc` 加 `computed`/`interactState`**

先读取 `BentoDoc` 接口当前的完整字段列表（`model.ts:352` 起，跨越到下一个
`export`/闭合 `}` 为止），确认插入点在最后一个已有字段之后、闭合大括号之前，
原样追加（不要重排已有字段）：

```ts
  /** doc-level computed properties, same semantics as Slide.computed. */
  computed?: Record<string, string>
  /** last-saved snapshot of the interact runtime store (filter/input/params
   *  selections). Only written when the user chooses "保存当前状态到文件";
   *  a "清空并存为公版模板" save clears this back to undefined. */
  interactState?: Record<string, unknown>
```

- [ ] **Step 4: 类型检查**

Run: `cd slides && node_modules/.bin/tsc -b`
Expected: 报错列出所有还没处理 `case 'filter'`/`case 'input'` 的 switch 语句
（`render.ts` 的 `renderElement`），这是预期中的下一步任务要修的——**此刻**
只需确认 `model.ts` 自身没有语法/类型错误（错误应只指向 render.ts 里因为
switch 不穷尽导致的 TS 报错，而不是 model.ts 内部报错）。

- [ ] **Step 5: Commit**

```bash
git add slides/src/model.ts
git commit -m "feat(model): 新增 filter/input 元素类型、chart.filterKey、computed、interactState、layout params 字段"
```

---

### Task 4: 渲染集成——绑定解析 + filter/input 渲染

**Files:**
- Modify: `slides/src/render.ts:1-30`（`RenderOpts`/`FieldContext` 附近，新增绑定上下文类型）
- Modify: `slides/src/render.ts:502-681`（`renderElement`：绑定解析 pass + 新 case）

**Interfaces:**
- Consumes: `resolveExprString` from `slides/src/expr.ts`（Task 1）；
  `interact` from `slides/src/interact.ts`（Task 2）；`FilterElement`/
  `InputElement` from `slides/src/model.ts`（Task 3）
- Produces: `buildBindingContext(doc: BentoDoc, slide: Slide): Record<string,
  unknown>`（收集 `filter.*`/`input.*`/`params.*` 值 + 求值 `computed.*`，
  循环依赖时该 computed key 值为 `'#ERROR'`）；`resolveBindings(html: string,
  ctx: Record<string, unknown>): string`（在 `resolveFields` 之后再跑一遍，
  替换 `{{filter.x}}` 等 token）。`RenderOpts` 新增 `bindingCtx?:
  Record<string, unknown>`。

- [ ] **Step 1: 在 `render.ts` 顶部新增绑定上下文构建函数**

紧跟在既有的 `resolveFields`（约 58-75 行）之后插入：

```ts
import { resolveExprString } from './expr'
import { interact } from './interact'

/**
 * Collect the binding context for one slide: current filter/input/params
 * values from the interact store, plus this slide's (and the doc's)
 * computed properties evaluated against that same context. Cycle detection:
 * a computed name currently being evaluated that's referenced again
 * resolves to '#ERROR' instead of recursing forever.
 */
export function buildBindingContext(doc: BentoDoc, slide: Slide): Record<string, unknown> {
  const ctx: Record<string, unknown> = { ...interact.snapshot() }
  if (slide.paramValues) {
    for (const [k, v] of Object.entries(slide.paramValues)) ctx[`params.${k}`] = v
  }
  const computedDefs = { ...(doc.computed ?? {}), ...(slide.computed ?? {}) }
  const evaluating = new Set<string>()
  const resolveComputed = (name: string): unknown => {
    const key = `computed.${name}`
    if (key in ctx) return ctx[key]
    if (evaluating.has(name)) return '#ERROR'
    const expr = computedDefs[name]
    if (expr === undefined) return ''
    evaluating.add(name)
    ctx[key] = resolveExprString(expr, ctx)
    evaluating.delete(name)
    return ctx[key]
  }
  for (const name of Object.keys(computedDefs)) resolveComputed(name)
  return ctx
}

/** Resolve {{filter.x}}/{{input.x}}/{{params.x}}/{{computed.x}} tokens against
 *  a binding context. Run AFTER resolveFields (page/title/date tokens). */
export function resolveBindings(html: string, ctx?: Record<string, unknown>): string {
  if (!ctx || html.indexOf('{{') < 0) return html
  return html.replace(/\{\{\s*((?:filter|input|params|computed)\.[A-Za-z0-9_]+)\s*\}\}/g, (_m, path: string) =>
    resolveExprString(path, ctx),
  )
}
```

- [ ] **Step 2: 在 `RenderOpts` 加字段，并在文本渲染路径里接上 `resolveBindings`**

```ts
export interface RenderOpts {
  svgAsImage?: boolean
  hidePlaceholders?: boolean
  liveMedia?: boolean
  fields?: FieldContext
  /** filter/input/params/computed values for THIS slide render pass. */
  bindingCtx?: Record<string, unknown>
}
```

在 `case 'text':` 里原有一行

```ts
inner.innerHTML = resolveMath(sanitizeHtml(resolveFields(el.html, opts.fields)))
```

改为

```ts
inner.innerHTML = resolveMath(sanitizeHtml(resolveBindings(resolveFields(el.html, opts.fields), opts.bindingCtx)))
```

- [ ] **Step 3: `renderSlide` 计算并传入 `bindingCtx`**

```ts
export function renderSlide(slide: Slide, doc: BentoDoc, opts: RenderOpts = {}): HTMLElement {
  const surface = document.createElement('div')
  surface.className = 'bento-slide'
  surface.dataset.slideId = slide.id
  surface.style.width = `${doc.size.width}px`
  surface.style.height = `${doc.size.height}px`
  surface.style.background = slide.background
  const fields = opts.fields ?? fieldContext(doc, slide)
  const bindingCtx = opts.bindingCtx ?? buildBindingContext(doc, slide)
  for (const el of slide.elements) surface.appendChild(renderElement(el, doc, { ...opts, fields, bindingCtx }))
  return surface
}
```

- [ ] **Step 4: 新增 `case 'filter'`/`case 'input'` 渲染分支**

在 `renderElement` 的 `switch (el.type) { ... }` 里，`case 'svg':` 分支之后追加：

```ts
    case 'filter': {
      node.dataset.filterKey = el.key
      const wrap = document.createElement('div')
      wrap.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;gap:4px;justify-content:center'
      if (el.label) {
        const lbl = document.createElement('label')
        lbl.textContent = el.label
        lbl.style.cssText = 'font-size:12px;opacity:0.7'
        wrap.appendChild(lbl)
      }
      const current = (opts.bindingCtx?.[`filter.${el.key}`] as string) ?? el.default ?? ''
      if (el.kind === 'select' || el.kind === 'multiselect') {
        const sel = document.createElement('select')
        sel.multiple = el.kind === 'multiselect'
        const opts_ = el.options ?? []
        for (const o of opts_) {
          const opt = document.createElement('option')
          opt.value = o; opt.textContent = o
          opt.selected = el.kind === 'multiselect' ? current.split(',').includes(o) : current === o
          sel.appendChild(opt)
        }
        sel.addEventListener('change', () => {
          const value = el.kind === 'multiselect'
            ? [...sel.selectedOptions].map((o) => o.value).join(',')
            : sel.value
          interact.set(`filter.${el.key}`, value)
        })
        wrap.appendChild(sel)
      } else {
        const input = document.createElement('input')
        input.type = el.kind === 'date-range' ? 'text' : 'range'
        input.value = current
        input.addEventListener('input', () => interact.set(`filter.${el.key}`, input.value))
        wrap.appendChild(input)
      }
      node.appendChild(wrap)
      break
    }
    case 'input': {
      node.dataset.inputKey = el.key
      const wrap = document.createElement('div')
      wrap.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;gap:4px;justify-content:center'
      if (el.label) {
        const lbl = document.createElement('label')
        lbl.textContent = el.label
        lbl.style.cssText = 'font-size:12px;opacity:0.7'
        wrap.appendChild(lbl)
      }
      const input = document.createElement('input')
      input.type = el.kind
      input.placeholder = el.placeholder ?? ''
      input.value = (opts.bindingCtx?.[`input.${el.key}`] as string) ?? el.default ?? ''
      input.addEventListener('input', () => interact.set(`input.${el.key}`, input.value))
      wrap.appendChild(input)
      node.appendChild(wrap)
      break
    }
```

- [ ] **Step 5: 类型检查**

Run: `cd slides && node_modules/.bin/tsc -b`
Expected: 无错误（switch 现在穷尽了 `SlideElement` 的所有 variant）

- [ ] **Step 6: 手动验证——起 dev server，在浏览器里确认绑定 token 生效**

Run: `cd slides && npm run dev`，打开 `http://localhost:5173`。用 About →
"Copy document JSON"（或直接在浏览器 devtools 里跑
`window.bento?.loadDoc?.(...)`，若已暴露）加一个 `type:'text'` 元素其
`html` 含 `{{filter.region}}`，以及一个 `type:'filter'` 元素 `key:'region'`；
拖动/选择 filter 控件，确认文本元素的绑定 token 位置内容跟着变化。

Expected: 修改 filter 控件的值后，页面上引用了 `{{filter.region}}` 的文本
立即更新（此步骤此时是"重渲染整个 slide"级别的验证，Task 6 会把它收紧为
"只重渲染依赖该 key 的元素"）。

- [ ] **Step 7: Commit**

```bash
git add slides/src/render.ts
git commit -m "feat(render): 绑定解析pass + filter/input元素渲染"
```

---

### Task 5: 图表交叉筛选点击 + 钻取

**Files:**
- Modify: `kernel/src/charts.ts:741`（`mountChart` 签名 + `wireTooltips` 邻近处新增 click 监听）
- Modify: `slides/src/present.ts:734`（`mountLiveCharts`：把 `chart.filterKey` 接上 `onCategoryClick`）

**Interfaces:**
- Consumes: `interact` from `slides/src/interact.ts`（Task 2）；已有的
  `catWindow(d, view)` 辅助函数（`kernel/src/charts.ts` 内部，`wireTooltips`
  已经在用，直接复用同一套类目定位逻辑）
- Produces: `mountChart(el, host, fromOption?, onCategoryClick?: (label:
  string) => void): () => void`（新增第 4 个可选参数，向后兼容——不传时行为
  与现在完全一致）

- [ ] **Step 1: 扩展 `mountChart` 签名，加一个 click 监听**

在 `kernel/src/charts.ts` 的 `mountChart` 函数签名处：

```ts
export function mountChart(
  el: ChartLike,
  host: HTMLElement,
  fromOption?: Record<string, unknown>,
  onCategoryClick?: (label: string) => void,
): () => void {
```

在 `wireTooltips` 函数定义之后（同一作用域内，`draw` 函数调用 `wireTooltips(svg,
opt)` 之后那一行）新增一个独立的 `wireClicks` 函数并在 `draw` 里也调用它：

```ts
  function wireClicks(svg: SVGSVGElement, opt: Opt) {
    if (!onCategoryClick) return
    const d = digest(opt, w, h)
    svg.addEventListener('click', (ev) => {
      const target = ev.target as Element & { __cat?: number }
      if (typeof target.__cat !== 'number') return
      const { cats, i0 } = catWindow(d, view)
      const label = cats[target.__cat - i0] ?? cats[target.__cat]
      if (label !== undefined) onCategoryClick(String(label))
    })
  }
```

并在 `draw` 函数体内，紧跟 `wireTooltips(svg, opt)` 之后追加一行：

```ts
    wireTooltips(svg, opt)
    wireClicks(svg, opt)
```

- [ ] **Step 2: 类型检查**

Run: `cd slides && node_modules/.bin/tsc -b`
Expected: 无错误（新参数是可选的，所有既有调用点不受影响）

- [ ] **Step 3: `present.ts` 里把 `chart.filterKey` 接上**

在 `mountLiveCharts`（`present.ts:734` 附近）里，找到调用 `mountChart(...)`
的那一行（渲染每个 chart 元素时），改为传入回调：

```ts
mountChart(el, host, fromOption, el.filterKey
  ? (label: string) => {
      interact.set(`filter.${el.filterKey}`, label)
      // 钻取：交叉筛选 + 现有 link 机制共用同一次点击——el.link 已经在
      // present.ts 别处的 [data-link] click 监听里处理跳转，这里只需要
      // 确保 filter 状态先落地，跳转逻辑不用重复实现。
    }
  : undefined)
```

需要在 `present.ts` 顶部加 `import { interact } from './interact'`。

- [ ] **Step 4: 手动验证**

Run: `cd slides && npm run dev`，构造一个带 `chart.filterKey='region'` 的
图表 + 一个引用 `{{filter.region}}` 的文本元素，进入 present 模式，点击图表
的一个柱子/扇区。

Expected: 文本元素内容变为被点击的类目标签；若图表元素同时设置了
`link`，点击后应跳转到目标 slide（复用既有 `[data-link]` 点击处理，
Step 3 的注释已说明不需要额外代码）。

- [ ] **Step 5: Commit**

```bash
git add kernel/src/charts.ts slides/src/present.ts
git commit -m "feat: 图表点击交叉筛选（chart.filterKey → interact store，钻取复用现有link机制）"
```

---

### Task 6: 依赖图 + 选择性重渲染

**Files:**
- Modify: `slides/src/present.ts`（演示模式：某个 interact key 变化时只重渲染依赖它的元素，而不是整个 slide）

**Interfaces:**
- Consumes: `interact.subscribe` from Task 2；`buildBindingContext` from Task 4
- Produces: `wireBindingReactivity(slide: Slide, section: HTMLElement, doc:
  BentoDoc): () => void`（返回清理函数，随 slide 离场时调用）：对 slide 里
  每个含 `{{filter./input./params./computed.}}` token 的元素，静态扫描出它
  引用的 key，订阅这些 key，变化时只重渲染这一个元素（用
  `renderElement` 替换该元素在 DOM 里对应的节点）。

- [ ] **Step 1: 实现依赖扫描 + 订阅**

在 `present.ts` 里新增（放在 `mountLiveCharts` 附近，因为二者都是"进入某个
slide 时要挂的运行时行为"）：

```ts
const BINDING_TOKEN_RE = /\{\{\s*((?:filter|input|params|computed)\.[A-Za-z0-9_]+)\s*\}\}/g

function bindingKeysIn(el: SlideElement): string[] {
  const text = el.type === 'text' ? el.html : ''
  const keys = new Set<string>()
  for (const m of text.matchAll(BINDING_TOKEN_RE)) keys.add(m[1])
  return [...keys]
}

/** Subscribe each element with binding tokens to its dependencies; on change,
 *  re-render just that element (not the whole slide). Returns a cleanup fn. */
function wireBindingReactivity(slide: Slide, section: HTMLElement, doc: BentoDoc): () => void {
  const unsubs: Array<() => void> = []
  for (const el of slide.elements) {
    const keys = bindingKeysIn(el)
    if (!keys.length) continue
    const rerender = () => {
      const nodeEl = section.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
      if (!nodeEl) return
      const ctx = buildBindingContext(doc, slide)
      const fresh = renderElement(el, doc, { fields: fieldContext(doc, slide), bindingCtx: ctx })
      nodeEl.replaceWith(fresh)
    }
    for (const key of keys) unsubs.push(interact.subscribe(key, rerender))
  }
  return () => unsubs.forEach((u) => u())
}
```

- [ ] **Step 2: 在进入/离开 slide 的地方接上调用**

在 `present.ts` 里 slide 切换完成、`mountLiveCharts` 被调用的同一处，追加
`wireBindingReactivity` 的调用并保存其清理函数，在离开该 slide 时调用清理
（具体挂载点：跟随既有 `mountLiveCharts(doc.slides[toIdx], to, ...)` 调用
的那次切换收尾逻辑，在同一个函数里 push 一次 `wireBindingReactivity` 调用，
并在下一次切换开始时对上一次返回的清理函数调用一次）。

- [ ] **Step 3: 类型检查**

Run: `cd slides && node_modules/.bin/tsc -b`
Expected: 无错误

- [ ] **Step 4: 手动验证——只有依赖的元素重渲染，不是整个slide**

Run: `cd slides && npm run dev`。构造一页含两个文本元素：A 引用
`{{filter.region}}`，B 是普通静态文本且带一个 `fx.enter` 入场动画。进入
present 模式，等入场动画播完，改变 filter 值。

Expected: 只有 A 的内容变化；B 不应该重新播放入场动画（证明它没有被
整体重渲染，只有 A 被替换）。

- [ ] **Step 5: Commit**

```bash
git add slides/src/present.ts
git commit -m "feat: 绑定依赖图——interact key变化只重渲染依赖它的元素"
```

---

### Task 7: 组件参数作用域链

**Files:**
- Modify: `slides/src/model.ts`（layout 实例化函数——需先定位现有的"实例化时保留元素id"的函数，大概率名为类似 `instantiateLayout`/`applyLayout`，在 `duplicateSlide`/`instantiate` 附近，约 890-940 行区域已在前面探索中见过 `stateOf`/`id` 复制逻辑）
- Modify: `slides/src/render.ts`（`buildBindingContext` 里补上 `params.*` 落到全局的兜底——Task 4 已经写了 `slide.paramValues` 优先级最高这一半，这里补的是"实例没提供某 param 时落到 layout 声明的默认值"）

**Interfaces:**
- Consumes: `Slide.params`/`Slide.paramValues` from Task 3
- Produces: 实例化函数在保留元素 id 的同时，把 `paramValues` 挂到新实例上
  （缺省的 param 从调用方传入的默认值兜底，若都没有则该 `params.x` 在绑定
  上下文里解析为空字符串——复用 Task 1 `evalExpr` 里 `ctx[node.path] ?? ''`
  已有的兜底行为，不需要新写代码）。

- [ ] **Step 1: 定位现有实例化函数**

Run: `grep -n "function.*[Ii]nstantiate\|function.*[Aa]pplyLayout\|function duplicateSlide" slides/src/model.ts`

Expected: 找到实例化 layout 为真实 slide 的函数定义行号（供下一步精确修改）。

- [ ] **Step 2: 给实例化函数加一个可选的 `paramValues` 入参**

找到该函数后，在其参数列表末尾新增一个可选参数
`paramValues?: Record<string, string>`，函数体内在返回新 slide 对象之前
加一行：

```ts
if (layout.params?.length) {
  copy.paramValues = { ...paramValues }
}
```

（`copy` 替换为该函数里实际用于表示"新实例"的变量名——按 Step 1 grep 到的
真实变量名调整，不要凭空发明一个不存在的变量名。）

- [ ] **Step 3: 类型检查**

Run: `cd slides && node_modules/.bin/tsc -b`
Expected: 无错误

- [ ] **Step 4: 手动验证作用域链——实例值优先于全局，缺省落到空字符串**

Run: `cd slides && npm run dev`。构造一个 layout，`params:['region']`，其
内部文本元素 `html` 含 `{{params.region}}`；实例化两份，一份
`paramValues:{region:'华东'}`，一份不传 `paramValues`。

Expected: 第一份显示"华东"；第二份显示空字符串（token 消失，不报错、
不崩溃）——与全局 `{{filter.region}}` 互不干扰（同一实例内两种 token
并存时各自解析各自的命名空间）。

- [ ] **Step 5: Commit**

```bash
git add slides/src/model.ts
git commit -m "feat(model): 组件实例参数作用域链（params.* 优先实例值，缺省为空）"
```

---

### Task 8: 编辑器属性面板

**Files:**
- Modify: `slides/src/editor/panels.ts`（新增 filter/input 元素的属性面板分支；组件实例的 `params.*` 编辑区）

**Interfaces:**
- Consumes: `FilterElement`/`InputElement`/`Slide.paramValues` from Task 3；
  `Store.commit` from `slides/src/store.ts`（面板改值时走正常的 model 编辑
  路径，会进 undo 栈——这跟 Task 2 的 interact store 是两回事：面板编辑的
  是 `default`/`options`/`label` 这些**文档字段**，不是运行时的当前选中值）

- [ ] **Step 1: 定位 panels.ts 里现有元素类型的属性面板写法**

Run: `grep -n "case 'shape'\|case 'image'\|function.*[Pp]anel" slides/src/editor/panels.ts`

Expected: 找到既有面板按元素 type 分支渲染表单控件的模式（供下一步照抄同一
套 DOM 构建/`store.commit` 调用风格）。

- [ ] **Step 2: 新增 filter/input 面板分支**

按 Step 1 找到的既有模式，新增两个分支：filter 面板暴露
`kind`（下拉选择 select/multiselect/slider/date-range）、`key`（文本框）、
`label`（文本框）、`default`（文本框）、`optionsSource`（tableId+column
两个下拉，或 `options` 的逗号分隔文本框）；input 面板暴露 `kind`、`key`、
`label`、`placeholder`、`default`。每个控件的 `change`/`input` 事件里调用
`store.commit(() => { el.xxx = newValue })`（跟既有元素面板同一套写法，
具体调用形态照抄 Step 1 grep 到的真实代码，不要发明新的 API）。

同时新增：当选中的元素所在 slide 有 `paramValues` 时，追加一个"参数"分区，
列出 `Object.keys(slide.paramValues)`，每个 key 一个文本框，编辑时
`store.commit(() => { slide.paramValues![k] = newValue })`。

- [ ] **Step 3: 类型检查**

Run: `cd slides && node_modules/.bin/tsc -b`
Expected: 无错误

- [ ] **Step 4: 手动验证**

Run: `cd slides && npm run dev`。插入一个 filter 元素，在属性面板里改
`key`/`label`/`options`，确认画布上的下拉框选项和标签同步更新；改
`default` 后刷新页面，确认演示模式打开时下拉框预选中该默认值。

- [ ] **Step 5: Commit**

```bash
git add slides/src/editor/panels.ts
git commit -m "feat(editor): filter/input元素属性面板 + 组件实例参数编辑区"
```

---

### Task 9: 保存工作流

**Files:**
- Modify: `slides/src/editor/editor.ts`（About/File 菜单新增两个动作，参照
  `openAbout`/`checkForUpdates` 的既有菜单项写法，约 2478-2650 行区域）

**Interfaces:**
- Consumes: `interact.snapshot()` from Task 2；`Store`（读取/替换当前
  `doc.interactState`，走 `store.commit`）；既有的 `serializeAuto`/
  `downloadFile`/`hasFileHandle`/`writeUpdatedFile` 等（`save.ts` 已有，
  `openAbout` 邻近的菜单动作已经在用这套，照抄调用方式）

- [ ] **Step 1: 定位 About 对话框里现有的菜单动作写法**

Run: `grep -n "Duplicate as new deck\|btn(ICONS" slides/src/editor/editor.ts | head -20`

Expected: 找到"Duplicate as new deck"这类既有动作按钮的构建代码（同一
对话框内，供照抄按钮创建 + 点击回调 + 触发保存的完整调用链）。

- [ ] **Step 2: 新增「保存当前状态到文件」动作**

在 About 对话框里，紧邻 Step 1 找到的既有动作按钮之后，新增一个按钮，
点击回调：

```ts
() => {
  this.store.commit(() => {
    this.store.doc.interactState = interact.snapshot()
  })
  // 复用既有保存路径（跟手动 Ctrl+S 走同一个函数——具体函数名以
  // save.ts 里实际暴露的顶层保存入口为准，照抄 editor.ts 其他保存
  // 按钮已经在调用的那一个，不要新发明一个保存路径）
  this.save()
}
```

- [ ] **Step 3: 新增「清空并存为公版模板」动作**

同一位置追加第二个按钮：

```ts
() => {
  this.store.commit(() => {
    this.store.doc.interactState = undefined
  })
  this.save()
}
```

（若产品上还想让"清空"顺带把 filter/input 元素的 `default` 保持不变、
只清运行时快照——上面这行已经是这个语义：`interactState` 只是运行时
快照的落盘位置，`default` 字段本来就没被这条路径动过。）

- [ ] **Step 4: 类型检查**

Run: `cd slides && node_modules/.bin/tsc -b`
Expected: 无错误

- [ ] **Step 5: 手动验证——保存/清空往返**

Run: `cd slides && npm run dev`。插入一个 filter 元素并选中一个值，点击
「保存当前状态到文件」，重新打开保存出来的文件，确认 filter 选中值原样
恢复。再对同一份文档点击「清空并存为公版模板」，重新打开，确认 filter
回到 `default`（或空）。

- [ ] **Step 6: Commit**

```bash
git add slides/src/editor/editor.ts
git commit -m "feat(editor): 保存工作流——保存当前状态到文件 / 清空存为公版模板"
```

---

## Self-Review Notes

- **Spec 覆盖**：A(Task1,2) / B(Task3,4,5) / C(Task7) / D(Task6,8,9) 四段均有
  对应任务；MVP 范围限定（bar/pie only）体现在 Task5 Step1 的 `wireClicks`
  只处理离散类目命中（`__cat`），未处理连续型图表，与 spec 一致。
- **占位符扫描**：无 TBD/TODO；Task7/8/9 里"照抄既有写法"的步骤都先给了
  `grep` 定位命令，实现步骤要求以 grep 到的真实代码为准，不是让执行者
  凭空发明——这是刻意为之（这三处涉及的既有函数名在写计划时未逐字确认，
  要求执行者先读后写，而不是我在此处编造可能不存在的函数签名）。
- **类型一致性**：`FilterElement.key`/`InputElement.key`、
  `chart.filterKey`、`interact.set('filter.'+key, ...)` 的命名空间前缀
  （`filter.`/`input.`/`params.`/`computed.`）在 Task1/2/3/4/5/6 里全部
  一致引用，没有出现命名漂移。
