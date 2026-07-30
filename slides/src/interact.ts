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

/** Safe merge: copy only own enumerable properties, skip __proto__/constructor/prototype. */
function safeMerge(target: Record<string, unknown>, source: Record<string, unknown> | null | undefined) {
  if (!source || typeof source !== 'object') return
  // Use Object.getOwnPropertyNames to also catch non-enumerable keys, but still filter dangerous ones
  for (const k of Object.getOwnPropertyNames(source)) {
    if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
      const desc = Object.getOwnPropertyDescriptor(source, k)
      if (desc && desc.enumerable) {
        target[k] = (source as any)[k]
      }
    }
  }
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
      // Ignore dangerous keys to prevent accidental pollution
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return
      values[key] = value
      persist()
      for (const cb of subs.get(key) ?? []) cb()
    },
    get(key) {
      // Block access to dangerous keys
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined
      return values[key]
    },
    subscribe(key, cb) {
      // Ignore subscriptions to dangerous keys
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return () => {} // no-op unsubscribe
      }
      if (!subs.has(key)) subs.set(key, new Set())
      subs.get(key)!.add(cb)
      return () => subs.get(key)?.delete(cb)
    },
    snapshot() {
      return { ...values }
    },
    hydrate(docId, saved) {
      currentDocId = docId
      // Clear all previous values to prevent cross-document data contamination
      for (const k of Object.keys(values)) delete values[k]
      // Safely merge doc.interactState (base state)
      safeMerge(values, saved)
      try {
        const cached = localStorage.getItem(`bento:interact:${docId}`)
        if (cached) safeMerge(values, JSON.parse(cached))
      } catch {
        /* corrupt/unavailable cache — fall back to `saved` only */
      }
    },
  }
}

/** Module-level singleton the app boots against (main.ts calls hydrate once). */
export const interact = createInteractStore()
