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
