# 文件授权与访问审计（客户端） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `docs/superpowers/specs/2026-07-30-license-audit-design.md` 里
客户端那一半：`doc.license` 签名信封的验证、水印渲染、审计上报/吊销检查（离线
模式硬阻断、fail-open），不实现服务端控制台（属于用户独立私有仓库，见 spec §5）。

**Architecture:** `kernel/src/license.ts` 是新增的 app 无关模块，复用
`kernel/src/update.ts` 已有的 ECDSA P-256/SHA-256 签名验证模式，但公钥
（`issuerPub`）来自文档本身而非硬编码——因为这是多租户能力，每个发行方有自己的
密钥对。水印渲染进 `slides/src/present.ts` + 编辑器画布；上报/吊销检查复用
`update.ts` 已有的 `offlineEnabled()` 开关做硬阻断。

**Tech Stack:** TypeScript；Web Crypto API（`crypto.subtle`，与 `update.ts`
同一套）；测试用本仓库既有的独立 Node 脚本 + `ok(cond, msg)` 手写断言约定
（参照 `scripts/test-sync.ts`），`node scripts/test-xxx.ts` 直接跑。

## Global Constraints

- 客户端**不做真正的访问阻断**：签名验证失败、吊销、离线模式——任何情况下都
  不能阻止文档内容渲染，只能显示水印/横幅（spec §4.2/§4.4，多次强调的
  fail-open 原则）。
- 离线模式（`offlineEnabled()`，`kernel/src/update.ts` 已有）必须硬阻断本计划
  新增的**所有**网络调用（上报 + 吊销检查）；水印渲染不受影响（纯本地渲染）。
- 审计上报必须在 About 对话框里如实披露，不做静默上报。
- 所有新增 `doc.license` 字段是可选的，老文件（无此字段）完全不受影响。
- 类型检查命令：`cd slides && node_modules/.bin/tsc -b`；
  `slides/node_modules/.bin/tsc -p ../kernel` 单独查 kernel。
- 网络调用一律 fire-and-forget、有超时、失败静默——不重试、不弹错误提示。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `kernel/src/license.ts`（新建） | `doc.license` 信封的类型定义、签名验证（参数化公钥）、上报/吊销检查两个网络调用（均查 `offlineEnabled()`）。 |
| `scripts/test-license.ts`（新建） | `license.ts` 的独立测试脚本：签名验证三种 case + offline-gate 测试。 |
| `kernel/src/doc.ts`（修改） | `KernelDoc` 新增 `license?: LicenseEnvelope` 字段。 |
| `slides/src/present.ts`（修改） | 演示模式挂载水印渲染 + 吊销横幅；boot 时触发一次上报。 |
| `slides/src/editor/editor.ts`（修改） | 编辑器画布同样渲染水印（复用同一渲染函数）；About 对话框新增"此文档会上报打开记录"的披露文案。 |
| `slides/src/main.ts`（修改） | boot 序列里，文档存在 `doc.license` 时调用一次 `license.ts` 的验证 + 上报。 |

---

### Task 1: 签名验证（参数化公钥）

**Files:**
- Create: `kernel/src/license.ts`
- Test: `scripts/test-license.ts`

**Interfaces:**
- Produces: `interface LicenseEnvelope { productLicenseId: string; holderId:
  string; holderName?: string; issuerPub: JsonWebKey; sig: string; watermark:
  boolean; audit?: { serverUrl: string; reportOpens?: boolean;
  checkRevocation?: boolean } }`；
  `verifyLicense(license: LicenseEnvelope): Promise<boolean>`（验证 `sig` 覆盖
  除 `sig` 自身外的所有字段，用 `license.issuerPub` 验签——签名失败返回
  `false`，绝不抛异常）。

- [ ] **Step 1: 写第一个失败测试——合法签名验证通过**

先用 Node 的 `crypto.subtle`（Node ≥ 20 支持 Web Crypto）生成一对测试用
ECDSA P-256 密钥，签一个测试 envelope，验证 `verifyLicense` 返回 `true`：

```ts
// scripts/test-license.ts
import { verifyLicense, type LicenseEnvelope } from '../kernel/src/license.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) }
}

const subtle = globalThis.crypto.subtle

async function signEnvelope(
  fields: Omit<LicenseEnvelope, 'sig' | 'issuerPub'>,
  keyPair: CryptoKeyPair,
): Promise<LicenseEnvelope> {
  const issuerPub = (await subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey
  const payload = JSON.stringify({ ...fields, issuerPub })
  const sigBuf = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, new TextEncoder().encode(payload),
  )
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
  return { ...fields, issuerPub, sig }
}

console.log('valid signature verifies…')
{
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const env = await signEnvelope(
    { productLicenseId: 'prod-1', holderId: 'holder-1', watermark: true },
    kp,
  )
  ok(await verifyLicense(env) === true, 'valid signature over untampered fields verifies')
}

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES of ${checks} checks`)
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-license.ts`
Expected: `Cannot find module '../kernel/src/license.ts'`

- [ ] **Step 3: 实现 `license.ts` 的类型 + 验证函数**

```ts
// kernel/src/license.ts
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// 文件授权与访问审计——客户端一半。见
// docs/superpowers/specs/2026-07-30-license-audit-design.md。
//
// 与 update.ts 的签名验证同一套 ECDSA P-256/SHA-256 crypto 原语，但公钥
// 来自文档本身（issuerPub）而非硬编码——这是多租户能力，Bento 不维护发行方
// 白名单。签名只做防篡改，不做"发行方是否可信"的判断；后者是发行方私有
// 服务自己账号体系的事。
//
// 服务端只需要提供两个端点（不在本仓库实现，见 spec §4.3）：
//   POST {serverUrl}/report  body: {productLicenseId, holderId, docId, timestamp} → 204
//   GET  {serverUrl}/status/{productLicenseId}/{holderId} → {status:"active"|"revoked"}

import { offlineEnabled } from './update.ts'

export interface LicenseEnvelope {
  productLicenseId: string
  holderId: string
  holderName?: string
  issuerPub: JsonWebKey
  sig: string
  watermark: boolean
  audit?: {
    serverUrl: string
    reportOpens?: boolean
    checkRevocation?: boolean
  }
}

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

/**
 * Verify `license.sig` covers every field EXCEPT `sig` itself, signed by the
 * key embedded in `license.issuerPub`. Never throws — a malformed envelope,
 * a bad key import, or a signature mismatch all resolve to `false`, and the
 * caller treats `false` as "ignore this doc.license entirely" (fail-open,
 * never blocks the document from rendering).
 */
export async function verifyLicense(license: LicenseEnvelope): Promise<boolean> {
  try {
    const { sig, ...signedFields } = license
    const key = await crypto.subtle.importKey(
      'jwk', license.issuerPub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    )
    const payload = new TextEncoder().encode(JSON.stringify(signedFields))
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64ToBytes(sig), payload)
  } catch {
    return false
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test-license.ts`
Expected: `ALL PASS (1 checks)`

- [ ] **Step 5: 补充篡改字段 + 公钥不匹配两种失败 case**

```ts
// 追加到 scripts/test-license.ts，在 process.exit 之前

console.log('tampered field fails verification…')
{
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const env = await signEnvelope(
    { productLicenseId: 'prod-1', holderId: 'holder-1', watermark: true },
    kp,
  )
  const tampered: LicenseEnvelope = { ...env, holderId: 'holder-EVIL' }
  ok(await verifyLicense(tampered) === false, 'tampered holderId fails verification')
}

console.log('wrong public key fails verification…')
{
  const kp1 = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const kp2 = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const env = await signEnvelope(
    { productLicenseId: 'prod-1', holderId: 'holder-1', watermark: true },
    kp1,
  )
  const wrongKeyEnv: LicenseEnvelope = { ...env, issuerPub: (await subtle.exportKey('jwk', kp2.publicKey)) as JsonWebKey }
  ok(await verifyLicense(wrongKeyEnv) === false, 'signature made with a different key fails verification')
}

console.log('malformed envelope never throws…')
{
  const malformed = { productLicenseId: 'x' } as unknown as LicenseEnvelope
  let threw = false
  let result = true
  try { result = await verifyLicense(malformed) } catch { threw = true }
  ok(!threw, 'malformed envelope does not throw')
  ok(result === false, 'malformed envelope resolves to false')
}
```

- [ ] **Step 6: 跑测试确认全部通过**

Run: `node scripts/test-license.ts`
Expected: `ALL PASS (4 checks)`

- [ ] **Step 7: Commit**

```bash
git add kernel/src/license.ts scripts/test-license.ts
git commit -m "feat: doc.license 签名信封验证（参数化公钥，防篡改而非发行方白名单）"
```

---

### Task 2: 上报 + 吊销检查（离线硬阻断）

**Files:**
- Modify: `kernel/src/license.ts`（新增两个网络调用函数）
- Modify: `scripts/test-license.ts`（新增 offline-gate 测试）

**Interfaces:**
- Consumes: `offlineEnabled` from `kernel/src/update.ts`（已有）
- Produces: `reportOpen(license: LicenseEnvelope, docId: string): void`
  （fire-and-forget，离线时直接 no-op，不发请求）；
  `checkRevocation(license: LicenseEnvelope): Promise<'active' | 'revoked' |
  'unknown'>`（离线或请求失败/超时时返回 `'unknown'`，调用方对 `'unknown'`
  的处理是"什么都不显示"，只有明确拿到 `'revoked'` 才显示横幅）。

- [ ] **Step 1: 写失败测试——离线模式下上报不发请求**

```ts
// 追加到 scripts/test-license.ts，在最终 process.exit 之前

console.log('offline mode hard-blocks reportOpen and checkRevocation…')
{
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  ;(globalThis as any).fetch = (...args: unknown[]) => { fetchCalls++; return originalFetch(...(args as [any])) }
  ;(globalThis as any).localStorage = { getItem: (k: string) => (k === 'bento-offline' ? 'on' : null), setItem() {} }

  const { reportOpen, checkRevocation } = await import('../kernel/src/license.ts')
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const env = await signEnvelope(
    { productLicenseId: 'prod-1', holderId: 'holder-1', watermark: true, audit: { serverUrl: 'https://example.invalid', reportOpens: true, checkRevocation: true } },
    kp,
  )
  reportOpen(env, 'doc-1')
  const status = await checkRevocation(env)
  ok(fetchCalls === 0, 'offline mode: zero fetch calls for report or revocation check')
  ok(status === 'unknown', 'offline mode: checkRevocation resolves to unknown, never revoked')

  ;(globalThis as any).fetch = originalFetch
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-license.ts`
Expected: `reportOpen is not a function` / `checkRevocation is not a function`
（函数还不存在）

- [ ] **Step 3: 实现两个网络函数**

追加到 `kernel/src/license.ts`：

```ts
/**
 * Best-effort, fire-and-forget: POST {serverUrl}/report. Never awaited by
 * callers, never throws, never retries. Offline mode is a hard no-op (zero
 * network touch) — checked BEFORE anything else, same policy update.ts uses
 * for update checks.
 */
export function reportOpen(license: LicenseEnvelope, docId: string): void {
  if (offlineEnabled()) return
  if (!license.audit?.reportOpens || !license.audit.serverUrl) return
  const body = JSON.stringify({
    productLicenseId: license.productLicenseId,
    holderId: license.holderId,
    docId,
    timestamp: new Date().toISOString(),
  })
  fetch(`${license.audit.serverUrl}/report`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, cache: 'no-store',
  }).catch(() => { /* fire-and-forget: failures are invisible to the viewer */ })
}

/**
 * GET {serverUrl}/status/:productLicenseId/:holderId. Returns 'unknown' on
 * offline mode, disabled checkRevocation, network failure, timeout, or a
 * malformed response — the caller must treat 'unknown' as "show nothing",
 * never as a revocation signal. Only an explicit {status:"revoked"} response
 * produces 'revoked'.
 */
export async function checkRevocation(license: LicenseEnvelope): Promise<'active' | 'revoked' | 'unknown'> {
  if (offlineEnabled()) return 'unknown'
  if (!license.audit?.checkRevocation || !license.audit.serverUrl) return 'unknown'
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(
      `${license.audit.serverUrl}/status/${encodeURIComponent(license.productLicenseId)}/${encodeURIComponent(license.holderId)}`,
      { cache: 'no-store', signal: controller.signal },
    )
    clearTimeout(timeout)
    if (!res.ok) return 'unknown'
    const data = (await res.json()) as { status?: string }
    return data.status === 'revoked' ? 'revoked' : data.status === 'active' ? 'active' : 'unknown'
  } catch {
    return 'unknown'
  }
}
```

- [ ] **Step 4: 跑测试确认全部通过**

Run: `node scripts/test-license.ts`
Expected: `ALL PASS (6 checks)`

- [ ] **Step 5: Commit**

```bash
git add kernel/src/license.ts scripts/test-license.ts
git commit -m "feat: 上报/吊销检查——离线模式硬阻断，失败fail-open为unknown"
```

---

### Task 3: `KernelDoc` 信封字段

**Files:**
- Modify: `kernel/src/doc.ts`

**Interfaces:**
- Produces: `KernelDoc.license?: LicenseEnvelope`

- [ ] **Step 1: 加字段**

```ts
// kernel/src/doc.ts
import type { LicenseEnvelope } from './license.ts'

export interface KernelDoc {
  docId: string
  title: string
  /** optional signed licensing/audit envelope — see license.ts. Additive:
   *  absent on every document that isn't using this capability. */
  license?: LicenseEnvelope
}
```

- [ ] **Step 2: 类型检查**

Run: `slides/node_modules/.bin/tsc -p kernel`
Expected: 无错误（`BentoDoc` 结构性满足 `KernelDoc`，新增字段是可选的）

- [ ] **Step 3: Commit**

```bash
git add kernel/src/doc.ts
git commit -m "feat(kernel): KernelDoc 新增可选 license 信封字段"
```

---

### Task 4: 水印渲染 + 吊销横幅

**Files:**
- Modify: `slides/src/present.ts`（演示模式挂载水印 + 横幅）
- Modify: `slides/src/editor/editor.ts`（编辑器画布同样渲染水印，复用同一函数）

**Interfaces:**
- Consumes: `verifyLicense`/`checkRevocation` from `kernel/src/license.ts`
  （Task 1/2）；`BentoDoc.license`（Task 3 令其结构性可用）
- Produces: `renderLicenseWatermark(license: LicenseEnvelope | undefined,
  host: HTMLElement): void`（在 `slides/src/present.ts` 里定义并导出，
  `editor.ts` 直接 import 复用，保证两处视觉/行为一致——这是延续本次会话里
  BI 交互设计"一个渲染器，四个场景"同一条原则）；
  `showRevocationBanner(host: HTMLElement): () => void`（返回一个关闭函数）。

- [ ] **Step 1: 在 `present.ts` 实现水印渲染函数**

```ts
// slides/src/present.ts（新增，靠近其他挂载函数）
import { verifyLicense, checkRevocation, type LicenseEnvelope } from '../../kernel/src/license.ts'

/** Persistent, non-blocking corner watermark. Verifies the signature before
 *  trusting `holderName` — a tampered/unsigned license renders nothing. */
export async function renderLicenseWatermark(
  license: LicenseEnvelope | undefined,
  host: HTMLElement,
): Promise<void> {
  host.querySelector('[data-bento-license-watermark]')?.remove()
  if (!license || !license.watermark) return
  if (!(await verifyLicense(license))) return
  const el = document.createElement('div')
  el.dataset.bentoLicenseWatermark = '1'
  el.style.cssText =
    'position:absolute;left:8px;bottom:8px;font-size:11px;opacity:0.55;' +
    'color:inherit;pointer-events:none;z-index:100;user-select:none'
  el.textContent = `授权给：${license.holderName ?? license.holderId}`
  host.appendChild(el)
}

/** Best-effort revocation check; shows a dismissible banner ONLY on an
 *  explicit 'revoked' response — network failure/offline/unknown show
 *  nothing (fail-open, never implies revocation from silence). */
export async function maybeShowRevocationBanner(
  license: LicenseEnvelope | undefined,
  host: HTMLElement,
): Promise<() => void> {
  if (!license) return () => {}
  const status = await checkRevocation(license)
  if (status !== 'revoked') return () => {}
  const banner = document.createElement('div')
  banner.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:10001;background:#5b2020;color:#fff;' +
    'font-size:13px;padding:8px 16px;display:flex;justify-content:space-between;align-items:center'
  banner.innerHTML = '<span>此授权可能已失效，请联系发行方</span>'
  const close = document.createElement('button')
  close.textContent = '✕'
  close.style.cssText = 'background:none;border:none;color:#fff;cursor:pointer;font-size:14px'
  close.addEventListener('click', () => banner.remove())
  banner.appendChild(close)
  document.body.appendChild(banner)
  return () => banner.remove()
}
```

- [ ] **Step 2: 在演示模式 boot 处调用**

在 `present.ts` 里演示模式启动的入口函数（`startPresentation`，main.ts 里
`import { startPresentation } from './present'` 已确认存在）内部，拿到
`doc`/顶层容器 `overlay` 之后追加：

```ts
void renderLicenseWatermark(doc.license, overlay)
void maybeShowRevocationBanner(doc.license, overlay)
```

（`overlay` 替换为 `startPresentation` 函数体内实际代表演示层根容器的变量名
——先读该函数体确认真实变量名，不要凭空套用。）

- [ ] **Step 3: 在编辑器画布挂同一个水印函数**

在 `slides/src/editor/editor.ts` 里，找到画布容器初始化/每次文档加载后
刷新的地方（`Editor` 类的构造函数或 `mount`/`render` 类方法），追加：

```ts
import { renderLicenseWatermark } from '../present'
// …
void renderLicenseWatermark(this.store.doc.license, this.canvasHost)
```

（`this.canvasHost` 替换为 `Editor` 类里实际代表画布根 DOM 节点的属性名。）

- [ ] **Step 4: 类型检查**

Run: `cd slides && node_modules/.bin/tsc -b`
Expected: 无错误

- [ ] **Step 5: 手动验证**

Run: `cd slides && npm run dev`。用 devtools 手动给当前文档塞一个
`doc.license = {..., watermark:true, holderName:'测试用户'}`（签名可以先
用一个总是返回 `true` 的 mock，或者跳过验签直接观察水印 DOM 是否出现），
确认演示模式和编辑器画布左下角都出现"授权给：测试用户"。

- [ ] **Step 6: Commit**

```bash
git add slides/src/present.ts slides/src/editor/editor.ts
git commit -m "feat: 授权水印渲染 + 吊销横幅（fail-open，演示/编辑器画布行为一致）"
```

---

### Task 5: 上报调用 + About 对话框披露文案

**Files:**
- Modify: `slides/src/main.ts`（boot 序列里触发一次上报）
- Modify: `slides/src/editor/editor.ts`（About 对话框追加披露文案）

**Interfaces:**
- Consumes: `reportOpen` from `kernel/src/license.ts`（Task 2）

- [ ] **Step 1: 在 `main.ts` 的 `bootWith` 里触发一次上报**

在 `main.ts:101` 起的 `bootWith(doc)` 函数体内，`new Store(doc)`/`new
Editor(...)` 之后追加：

```ts
if (doc.license) reportOpen(doc.license, doc.docId)
```

并在文件顶部新增 `import { reportOpen } from '../../kernel/src/license.ts'`。

- [ ] **Step 2: About 对话框追加披露文案**

在 `editor.ts` 的 `openAbout`（约 2479 行起）函数体内，找到渲染对话框内容
的地方，若 `this.store.doc.license?.audit?.reportOpens` 为真，追加一段
文案节点：

```ts
if (this.store.doc.license?.audit?.reportOpens) {
  const notice = document.createElement('p')
  notice.style.cssText = 'font-size:12px;opacity:0.7;margin-top:8px'
  notice.textContent = t('This document reports opens to its issuer for licensing/audit purposes.')
  // 具体插入位置：紧跟对话框里既有的版本号/更新检查文案之后，同一个
  // dialog 容器变量（照抄 openAbout 函数体内已有的 DOM 拼装写法）
}
```

（`t(...)` 复用既有 i18n 机制——若该字符串需要进多语言包，按仓库既有 i18n
流程新增 key，此步骤只要求把英文源串接入 `openAbout`，多语言包补齐是
`slides/src/i18n/packs/` 下的既有翻译工作流，不在本任务展开。）

- [ ] **Step 3: 类型检查**

Run: `cd slides && node_modules/.bin/tsc -b`
Expected: 无错误

- [ ] **Step 4: 手动验证**

Run: `cd slides && npm run dev`。给文档塞一个 `doc.license.audit.reportOpens
= true` 且 Offline mode 关闭，打开 devtools Network 面板，刷新页面，
确认发出了一次 `POST {serverUrl}/report`；打开 About 对话框确认披露文案
显示。再打开 Offline mode，刷新页面，确认 Network 面板里**没有**这次
请求。

- [ ] **Step 5: Commit**

```bash
git add slides/src/main.ts slides/src/editor/editor.ts
git commit -m "feat: boot时触发一次审计上报 + About对话框披露文案"
```

---

## Self-Review Notes

- **Spec 覆盖**：E1(Task1,3) / E2(Task1,2,4,5) / E3(接口契约，Task2的函数
  直接对应 spec §4.3 的两个端点) / E4(Task1,2 的测试 + 各任务里的 fail-open
  行为) 均有对应任务。
- **占位符扫描**：无 TBD；Task4/5 里两处"替换为实际变量名"的说明是刻意的
  ——`startPresentation`/`Editor` 类的内部变量名在写计划时未逐字确认真实
  命名，要求执行者先读该函数体再替换，不是留空。
- **类型一致性**：`LicenseEnvelope` 的字段名（`productLicenseId`/
  `holderId`/`holderName`/`issuerPub`/`sig`/`watermark`/`audit.serverUrl`/
  `audit.reportOpens`/`audit.checkRevocation`）在 Task1-5 全部引用点保持
  一致，与 spec §4.1 的字段表逐一对应。
- **范围边界**：Task2 的 `reportOpen`/`checkRevocation` 只实现"调用"这一侧；
  服务端两个端点的实现（账号、数据库、控制台）不在本计划——与 spec §5
  记录的排除范围一致，未在本计划内意外扩大范围。
