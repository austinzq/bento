// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Open / page-dwell reporting for handed-out files (`doc.analytics`).
//
// A distributed deck can say where to report that it was opened, and which
// pages were looked at for how long. Design rules, in order of importance:
//
// 1. NEVER blocks or gates the open. A report is fire-and-forget; a missing,
//    slow or refusing server is invisible to the viewer. (Gating is what the
//    licence flow in license.ts is for.)
// 2. No CORS dependence. Every report is a "simple request" — sendBeacon (or
//    a no-cors fetch) with a text/plain body — so the browser sends it without
//    a preflight and we never need to read the response. That is also why
//    a file opened from file:// (Origin: null) reports fine. The server still
//    answers `Access-Control-Allow-Origin: *` for tidiness.
// 3. Mixed content is the real blocker: a deck served over https cannot report
//    to an http endpoint (the browser drops it silently). Issuers must use an
//    https endpoint; file:// and http pages can report anywhere.
// 4. Offline opens are queued (localStorage) and flushed on the next online
//    open of ANY deck in that browser — an offline open is still counted, just
//    late. The viewer's global offline switch (update.ts) suppresses reporting
//    entirely, like every other network touch.
//
// What is sent (see OpenEvent/PagesEvent): the deck's issuer-assigned id, the
// viewer name typed at the watermark gate (if any), open time, how the file
// was opened (file/https/http), user agent, timezone, language, screen size —
// and per page: seconds on screen. No slide content ever leaves the file.

import { offlineEnabled } from './update'

export interface AnalyticsInfo {
  /** issuer's stats server base URL — https unless the deck is only ever opened locally */
  url: string
  /** issuer-assigned copy id (e.g. recipient code + deck); falls back to docId */
  id?: string
  /** report page dwell times from present mode (default true) */
  pages?: boolean
}

export interface OpenEvent {
  t: 'open'
  id: string
  docId: string
  title: string
  holder: string
  viewer: string
  at: string
  via: 'file' | 'https' | 'http' | 'other'
  ua: string
  tz: string
  lang: string
  screen: string
}

export interface PageDwell {
  id: string
  name: string
  idx: number
  sec: number
}

export interface PagesEvent {
  t: 'pages'
  id: string
  docId: string
  viewer: string
  at: string
  pages: PageDwell[]
  /** seconds across every page in this batch */
  total: number
  /** index of the page on screen when the batch was flushed */
  last: number
}

export type StatsEvent = OpenEvent | PagesEvent

export const QUEUE_KEY = 'bento-stats-queue'
const QUEUE_MAX = 50

interface QueuedEvent { url: string; ev: StatsEvent }

export interface OpenEnv {
  href: string
  ua: string
  tz: string
  lang: string
  screen: string
}

/** Where an event goes: `<url>/v1/open` (the path is deliberately not "analytics"/"track" — ad blockers). */
export const endpoint = (info: AnalyticsInfo) => `${info.url.replace(/\/+$/, '')}/v1/open`

export const openedVia = (href: string): OpenEvent['via'] =>
  href.startsWith('file:') ? 'file' : href.startsWith('https:') ? 'https' : href.startsWith('http:') ? 'http' : 'other'

/** Snapshot of the viewer's environment; injectable so tests need no window. */
export function browserEnv(): OpenEnv {
  const w = globalThis as any
  let tz = ''
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '' } catch { /* older engines */ }
  return {
    href: w.location?.href ?? '',
    ua: w.navigator?.userAgent ?? '',
    tz,
    lang: w.navigator?.language ?? '',
    screen: w.screen ? `${w.screen.width}x${w.screen.height}` : '',
  }
}

export function buildOpenEvent(
  doc: { docId: string; title: string; meta?: { subject?: string }; analytics?: AnalyticsInfo },
  viewer: string,
  env: OpenEnv,
  now: Date = new Date(),
): OpenEvent {
  return {
    t: 'open',
    id: doc.analytics?.id || doc.docId,
    docId: doc.docId,
    title: doc.title,
    holder: doc.meta?.subject ?? '',
    viewer,
    at: now.toISOString(),
    via: openedVia(env.href),
    ua: env.ua.slice(0, 160),
    tz: env.tz,
    lang: env.lang,
    screen: env.screen,
  }
}

/**
 * Accumulates seconds-on-screen per slide during a show. `enter` on every
 * slide change (and once for the opening slide), `drain` to take the batch
 * (the current slide keeps counting from now, so a mid-show flush loses
 * nothing). Clock injectable for tests.
 */
export class DwellTracker {
  private cur: { idx: number; id: string; name: string; since: number } | null = null
  private acc = new Map<number, PageDwell>()
  constructor(private readonly clock: () => number = () => Date.now()) {}

  enter(idx: number, id: string, name: string): void {
    this.settle()
    this.cur = { idx, id, name, since: this.clock() }
  }

  /** stop counting (show ended, tab hidden) — a later `enter` resumes */
  leave(): void {
    this.settle()
    this.cur = null
  }

  private settle(): void {
    if (!this.cur) return
    const sec = (this.clock() - this.cur.since) / 1000
    const row = this.acc.get(this.cur.idx) ?? { idx: this.cur.idx, id: this.cur.id, name: this.cur.name, sec: 0 }
    row.sec = Math.round((row.sec + sec) * 10) / 10
    this.acc.set(this.cur.idx, row)
    this.cur.since = this.clock()
  }

  get current(): number { return this.cur?.idx ?? -1 }

  /** the batch so far, ordered by slide index; empties the accumulator */
  drain(): PageDwell[] {
    this.settle()
    const rows = [...this.acc.values()].filter((r) => r.sec > 0).sort((a, b) => a.idx - b.idx)
    this.acc.clear()
    return rows
  }
}

export function buildPagesEvent(
  doc: { docId: string; analytics?: AnalyticsInfo },
  viewer: string,
  pages: PageDwell[],
  last: number,
  now: Date = new Date(),
): PagesEvent {
  return {
    t: 'pages',
    id: doc.analytics?.id || doc.docId,
    docId: doc.docId,
    viewer,
    at: now.toISOString(),
    pages,
    total: Math.round(pages.reduce((s, p) => s + p.sec, 0) * 10) / 10,
    last,
  }
}

/**
 * Hand one event to the browser. text/plain keeps it a simple request (no
 * preflight); keepalive/sendBeacon lets it outlive a closing tab. Returns
 * whether the browser accepted it — NOT whether the server got it (opaque by
 * design). Injectable transport for tests.
 */
export function sendStats(
  url: string,
  ev: StatsEvent,
  transport: { sendBeacon?: (url: string, body: Blob) => boolean; fetch?: typeof fetch } = globalThis.navigator as any,
): boolean {
  const body = JSON.stringify(ev)
  try {
    if (typeof transport?.sendBeacon === 'function') {
      return transport.sendBeacon.call(transport, url, new Blob([body], { type: 'text/plain' }))
    }
  } catch { /* fall through to fetch */ }
  const f = transport?.fetch ?? globalThis.fetch
  if (typeof f !== 'function') return false
  try {
    void f(url, { method: 'POST', mode: 'no-cors', keepalive: true, cache: 'no-store', headers: { 'content-type': 'text/plain' }, body }).catch(() => {})
    return true
  } catch {
    return false
  }
}

function readQueue(storage: Storage | undefined): QueuedEvent[] {
  try {
    const raw = storage?.getItem(QUEUE_KEY)
    const q = raw ? (JSON.parse(raw) as QueuedEvent[]) : []
    return Array.isArray(q) ? q : []
  } catch {
    return []
  }
}

function writeQueue(storage: Storage | undefined, q: QueuedEvent[]): void {
  try {
    if (q.length) storage?.setItem(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX)))
    else storage?.removeItem(QUEUE_KEY)
  } catch { /* storage off — the event is simply lost */ }
}

export function queueStats(url: string, ev: StatsEvent, storage: Storage | undefined = safeStorage()): void {
  const q = readQueue(storage)
  q.push({ url, ev })
  writeQueue(storage, q)
}

/** Send everything queued from earlier offline opens; returns how many went out. */
export function flushQueue(storage: Storage | undefined = safeStorage(), transport?: Parameters<typeof sendStats>[2]): number {
  const q = readQueue(storage)
  if (!q.length) return 0
  const left: QueuedEvent[] = []
  let sent = 0
  for (const item of q) {
    if (sendStats(item.url, item.ev, transport)) sent++
    else left.push(item)
  }
  writeQueue(storage, left)
  return sent
}

function safeStorage(): Storage | undefined {
  try { return globalThis.localStorage } catch { return undefined }
}

export type ReportOutcome = 'sent' | 'queued' | 'skipped'

/**
 * Report one event for a deck: skipped under the viewer's offline switch,
 * queued while the browser says it is offline, otherwise flushed-and-sent.
 */
export function report(info: AnalyticsInfo, ev: StatsEvent, opts: { online?: boolean; offlineSwitch?: boolean; storage?: Storage; transport?: Parameters<typeof sendStats>[2] } = {}): ReportOutcome {
  if (!info?.url) return 'skipped'
  const offlineSwitch = opts.offlineSwitch ?? offlineEnabled()
  if (offlineSwitch) return 'skipped'
  const online = opts.online ?? ((globalThis.navigator as any)?.onLine !== false)
  const url = endpoint(info)
  const storage = opts.storage ?? safeStorage()
  if (!online) {
    queueStats(url, ev, storage)
    return 'queued'
  }
  flushQueue(storage, opts.transport)
  if (sendStats(url, ev, opts.transport)) return 'sent'
  queueStats(url, ev, storage)
  return 'queued'
}
