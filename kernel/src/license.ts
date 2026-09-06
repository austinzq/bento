// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Licence resolution for v2 encrypted files (see save.ts EncEnvelope.license).
//
// A licensed copy cannot be opened with the password alone: the AES key is
// HKDF(PBKDF2(password) ‖ secret), and the secret lives on the issuer's
// licence server. Opening = password → proof → server hands back the secret
// (if the licence is active and not expired) → decrypt. The secret is cached
// locally, encrypted under the password, with the server's timestamp, so the
// file keeps opening offline for at most `maxOfflineDays` (the server's value
// wins over the one baked into the file — the issuer can tighten it
// centrally). Past the grace window, or after a revocation the client has
// seen, the file refuses to open until the server is reachable again.
//
// Honest limits: this is "must phone home within N days", not DRM. A viewer
// who backs up localStorage or turns the clock back extends the grace; the
// plaintext can be copied out once open. The viewer-side offline switch
// (update.ts offlineEnabled) blocks the server call like any other network
// touch — such a viewer runs purely on the cached grace.

import { offlineEnabled } from './update'
import { eb64, passwordKeyFor, type LicenseInfo } from './save'

export type LicenseState =
  | 'active'          // server confirmed just now
  | 'grace'           // server unreachable (or offline switch), cached secret within maxOfflineDays
  | 'expired-grace'   // cached secret older than maxOfflineDays — needs the network
  | 'unreachable'     // no cache and no server — needs the network
  | 'revoked'         // server says revoked (cache cleared)
  | 'expired'         // server says expired (cache cleared)
  | 'bad_proof'       // server says the password does not match this licence

export interface LicenseStatus {
  state: LicenseState
  secret?: Uint8Array
  checkedAt?: string
  /** whole days of grace left (grace state only) */
  graceLeftDays?: number
  maxOfflineDays?: number
}

interface KeyReply {
  status: 'active' | 'revoked' | 'expired' | 'bad_proof'
  secret?: string
  checkedAt?: string
  maxOfflineDays?: number
  expires?: string
}

interface CacheEntry {
  iv: string
  secretEnc: string
  checkedAt: string
  maxOfflineDays: number
}

const CACHE_PREFIX = 'bento-lic-'
const FETCH_TIMEOUT_MS = 6000

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** What the client shows the server to prove it holds the password — never the password itself. */
export const proofFor = (id: string, password: string) => sha256Hex(`${id}:${password}`)

async function cacheKey(license: LicenseInfo, password: string): Promise<CryptoKey> {
  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bento-lic:${license.id}`))).slice(0, 16)
  return passwordKeyFor(password, salt)
}

async function readCache(license: LicenseInfo, password: string): Promise<{ secret: Uint8Array; entry: CacheEntry } | null> {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + license.id)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry
    const key = await cacheKey(license, password)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: eb64.dec(entry.iv) as BufferSource }, key, eb64.dec(entry.secretEnc) as BufferSource)
    return { secret: new Uint8Array(pt), entry }
  } catch {
    return null // no cache, unreadable storage, or a different password
  }
}

async function writeCache(license: LicenseInfo, password: string, secret: Uint8Array, checkedAt: string, maxOfflineDays: number): Promise<void> {
  try {
    const iv = new Uint8Array(12)
    crypto.getRandomValues(iv)
    const key = await cacheKey(license, password)
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, secret as BufferSource)
    const entry: CacheEntry = { iv: eb64.enc(iv), secretEnc: eb64.enc(new Uint8Array(ct)), checkedAt, maxOfflineDays }
    localStorage.setItem(CACHE_PREFIX + license.id, JSON.stringify(entry))
  } catch {
    /* storage unavailable — the file still opens this time */
  }
}

export function clearLicenseCache(id: string): void {
  try { localStorage.removeItem(CACHE_PREFIX + id) } catch { /* ignore */ }
}

/** POST {serverUrl}/v1/key/{id} with the proof; null when the server can't be reached. */
async function fetchKey(license: LicenseInfo, proof: string): Promise<KeyReply | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${license.serverUrl.replace(/\/$/, '')}/v1/key/${encodeURIComponent(license.id)}`, {
      method: 'POST', mode: 'cors', cache: 'no-store', signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof, holder: license.holder }),
    })
    const body = (await res.json()) as KeyReply
    if (!body || typeof body.status !== 'string') return null
    return body
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the secret for a licensed file. Order: live server (unless the
 * viewer's offline switch is on) → cached grace → refuse. `now` is
 * injectable for tests.
 */
export async function resolveLicense(license: LicenseInfo, password: string, now: Date = new Date()): Promise<LicenseStatus> {
  const proof = await proofFor(license.id, password)
  if (!offlineEnabled()) {
    const reply = await fetchKey(license, proof)
    if (reply) {
      if (reply.status === 'active' && reply.secret) {
        const secret = eb64.dec(reply.secret)
        const checkedAt = reply.checkedAt || now.toISOString()
        const maxOfflineDays = typeof reply.maxOfflineDays === 'number' ? reply.maxOfflineDays : license.maxOfflineDays
        await writeCache(license, password, secret, checkedAt, maxOfflineDays)
        return { state: 'active', secret, checkedAt, maxOfflineDays }
      }
      if (reply.status === 'revoked' || reply.status === 'expired') {
        clearLicenseCache(license.id)
        return { state: reply.status }
      }
      if (reply.status === 'bad_proof') return { state: 'bad_proof' }
    }
  }
  const cached = await readCache(license, password)
  if (cached) {
    const ageDays = (now.getTime() - Date.parse(cached.entry.checkedAt)) / 86_400_000
    const max = cached.entry.maxOfflineDays
    if (ageDays >= 0 && ageDays <= max) {
      return { state: 'grace', secret: cached.secret, checkedAt: cached.entry.checkedAt, maxOfflineDays: max, graceLeftDays: Math.max(0, Math.ceil(max - ageDays)) }
    }
    return { state: 'expired-grace', maxOfflineDays: max, checkedAt: cached.entry.checkedAt }
  }
  return { state: 'unreachable' }
}
