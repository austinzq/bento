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

console.log('hydrate: second hydrate clears previous document\'s values…')
{
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
  }
  const s = createInteractStore()
  // First document hydration
  s.hydrate('doc1', { 'filter.region': '华东', 'input.budget': 100 })
  ok(s.get('filter.region') === '华东', 'first hydrate sets filter.region')
  ok(s.get('input.budget') === 100, 'first hydrate sets input.budget')
  // Second document hydration with different docId
  s.hydrate('doc2', { 'filter.region': '华西' })
  ok(s.get('filter.region') === '华西', 'second hydrate updates filter.region')
  ok(s.get('input.budget') === undefined, 'input.budget from first doc is cleared after second hydrate')
}

console.log('hydrate: __proto__ pollution is prevented (via JSON)…')
{
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
  }
  const s = createInteractStore()
  // Simulate untrusted data from JSON (e.g., from doc.interactState or localStorage)
  const jsonStr = '{"__proto__":{"polluted":"yes"},"safe.key":"ok"}'
  const untrusted = JSON.parse(jsonStr)
  s.hydrate('doc1', untrusted)
  ok(s.get('safe.key') === 'ok', 'safe keys are hydrated normally')
  ok((({} as any).polluted) === undefined, 'Object.prototype is not polluted by __proto__')
  ok(s.get('__proto__') === undefined, '__proto__ key itself is not stored in values')
}

console.log('hydrate: constructor key is not stored…')
{
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
  }
  const s = createInteractStore()
  // Untrusted data with constructor key
  const jsonStr = '{"constructor":{"prototype":{"evil":"payload"}},"normal":"value"}'
  const untrusted = JSON.parse(jsonStr)
  s.hydrate('doc1', untrusted)
  ok(s.get('normal') === 'value', 'normal keys from pollution attempt are hydrated')
  ok(s.get('constructor') === undefined, 'constructor key is not stored')
  ok(s.get('prototype') === undefined, 'prototype key is not stored')
}

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES of ${checks} checks`)
process.exit(failures ? 1 : 0)
