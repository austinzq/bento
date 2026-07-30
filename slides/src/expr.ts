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

/**
 * 判断一个值是否应该按数字处理。
 * 数字类型本身或者是能转成数字的字符串（不像parseFloat那样截断）才返回true。
 */
const isNumericValue = (v: unknown): boolean => {
  if (typeof v === 'number') return true
  if (typeof v === 'string') {
    const trimmed = v.trim()
    return trimmed !== '' && !isNaN(Number(trimmed))
  }
  return false
}

export function evalExpr(node: ExprNode, ctx: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'num': return node.value
    case 'str': return node.value
    case 'var': return ctx[node.path] ?? ''
    case 'call': {
      // Each arg may resolve to a plain scalar OR a number[] (a table.<id>.<col>
      // column reference) — flatten arrays so sum(table.sales.amount) reduces
      // the whole column, while sum(1,2,3) is unaffected.
      const rawVals = node.args.map((a) => evalExpr(a, ctx))
      const vals = rawVals.flatMap((v) => (Array.isArray(v) ? v.map(num) : [num(v)]))
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
        case '>': {
          const lIsNum = isNumericValue(l)
          const rIsNum = isNumericValue(r)
          return lIsNum && rIsNum ? num(l) > num(r) : String(l) > String(r)
        }
        case '<': {
          const lIsNum = isNumericValue(l)
          const rIsNum = isNumericValue(r)
          return lIsNum && rIsNum ? num(l) < num(r) : String(l) < String(r)
        }
        case '>=': {
          const lIsNum = isNumericValue(l)
          const rIsNum = isNumericValue(r)
          return lIsNum && rIsNum ? num(l) >= num(r) : String(l) >= String(r)
        }
        case '<=': {
          const lIsNum = isNumericValue(l)
          const rIsNum = isNumericValue(r)
          return lIsNum && rIsNum ? num(l) <= num(r) : String(l) <= String(r)
        }
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
