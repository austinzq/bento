# Working in this repo — agents & tools

Guidance for AI coding agents (Claude Code, Codex, Antigravity, …) and human
contributors. This file is the **tool-agnostic contract**; Claude Code also
reads `CLAUDE.md` (the deep architecture guide for `slides/`). If your tool
only reads one file, read this one, then follow the pointers.

## What this project is

bento — office documents as single self-contained HTML files. One file = the
document + viewer + editor; it saves itself, updates itself over a signed
channel, and optionally syncs E2EE through a blind relay. `slides/` is the
shipped app. Starting now: **bento/spaces** (Notion/notes-like),
**bento/dash** (spreadsheet + tables), **bento/vault** (document library).

**Naming and casing — lowercase everywhere.** The platform is `bento`, the
wordmark is `bento/.`, and apps are `bento/slides`, `bento/spaces`,
`bento/dash`, `bento/vault`. This applies to UI strings and prose as well as
format constants — do not write "Bento Slides" in new copy. The `/` in the
wordmark is decorative: anywhere a name is stored or typed (filenames, URLs,
package names) it is plain `bento`. Full reasoning and the rejected candidates
are in `docs/DECISIONS.md` — don't reopen them.

## Read before writing code

- `docs/PLATFORM.md` — invariants every Bento app must honor. Breaking these
  bricks files already shipped to users.
- `docs/PARALLEL-WORK.md` — branch/merge discipline when many agents work at
  once (you are probably one of them).
- `docs/DECISIONS.md` — settled decisions. Don't relitigate them in code;
  append new ones.
- `CLAUDE.md` — deep architecture + hard-won gotchas, authoritative for
  `slides/` internals.
- `docs/collab-design.md` — the sync/collab spec + threat model.

## Hard rules (each one has broken something before)

1. **Never let a literal `</script>` into a bundle or document block.** JSON in
   the doc block escapes `<` as `<`; builders concatenate around it.
2. **The `#bento-doc` block stays plaintext, same id, regex-extractable.**
   That's the splice contract (`docs/PLATFORM.md`) — updaters already shipped
   in old files are frozen code that depends on it.
3. **Never regenerate a document's `docId`.** It's the document's identity for
   recovery, sync, and future merge.
4. **After any change to `slides/src/sync/crdt.ts`, run
   `node scripts/test-sync.ts`.** The convergence rig has caught 15+ ordering
   bugs; a green typecheck means nothing for CRDT correctness.
5. **A password-protected deck never carries a plaintext preview of page one.**
   Saves write a static first-page render into the shell for file-manager
   thumbnails (`kernel/src/save.ts`, `slides/src/preview.ts`); `bento/enc` decks
   are vetoed and any existing preview is stripped. Run
   `node scripts/test-preview.ts` after touching that path.
6. **New UI strings go into ALL i18n catalogs** (ja, zh-Hans, zh-Hant, es, fr,
   de, it). English-string-as-key; never call `t()` in module-level consts.
7. **Never edit `site/`** — it's generated. Sources are `site-src/` and the
   `scripts/build-*.mjs` tooling. Same for `dist-single/`.
8. **No AI co-author trailers on commits** (no `Co-Authored-By: Claude` or
   similar), and no bot identities in git history.
9. **Releases are cut locally by the maintainer only.** Never touch signing
   keys (`~/.bento/release-key.json`), never attempt to release, publish, or
   deploy from an agent session unless the maintainer explicitly asks.
10. **External PRs get provenance checks** before merge (`gh api users/<login>`)
   — AI-agent/bot contributions are not merged.
11. **Verify before claiming done**: typecheck, build, and exercise the change
    in a browser when it's user-visible. Report failures honestly.

## Commands

```sh
cd slides
npm install
npm run dev            # dev server (see .claude/launch.json for ports)
npm run build:single   # → dist-single/Bento_Slides.bento.html (the product)
node_modules/.bin/tsc -b            # typecheck
node ../scripts/test-sync.ts        # CRDT convergence rig (SEEDS/STEPS/ACTORS env)
node ../scripts/test-preview.ts     # first-page preview rig (encryption veto, output safety)
node ../scripts/shell-gate.mjs dist-single/Bento_Slides.bento.html   # splice conformance
```

## 把 PPT/PDF 做成 bento 时——先跑 pptx_extract，别徒手读

用户丢一个 .pptx 让你转 bento，**不要直接自己读 pptx 凭印象重做**。PowerPoint 常把
文字塞进多层嵌套的组合形状（group shape）里，只读顶层 shape 会静默丢掉一大截
（2026-09-10 jinna 那份实测 24 页 476 块文字、**32% 藏在组合里读不到**，导致"数据掉了"、
读不全的页被"自由发挥"脑补，来回改了八轮）。流程固定三步：

```sh
# ① 先量会漏多少（顶层 vs 递归全部）
python3 ../scripts/pptx_extract.py coverage workspace/inbox/xxx.pptx
# ② 出结构化底座（每页全部文本+表格+分组归属路径），照它写 bento，不徒手读 pptx
python3 ../scripts/pptx_extract.py extract workspace/inbox/xxx.pptx -o /tmp/src.json
# ③ 交付前数据覆盖门禁：从成品 .bento.html 的 bento-doc JSON 抽所有字符串存 produced.txt，
#    比对源 PPT 的数字/专有词有没有丢。数字丢=退出码1，绝不交付
python3 ../scripts/pptx_extract.py cover-check workspace/inbox/xxx.pptx --produced /tmp/produced.txt
```

铁律：
- **图片式页面 / OLE 对象**：`extract` 会标 `kind=image/ole`——文字提取不到，
  必须逐页把源 PPT 渲染成图**照着原图对位**，绝不脑补（jinna 明说"发挥的成分有点多"）。
- **忠于原稿**：分组归属、扉页总结、卡片格式照搬源结构，不自由重组；要优化排版另说。
- cover-check 只查"数据有没有丢"（对 bento 卡片化重排免疫），措辞/顺序/视觉靠 page-verify。

morning-picks / quarterly-design 等要处理 PPT 的项目同样适用，脚本无 bento 依赖可直接复用。

## Repo layout

```
slides/           Bento Slides app (src/, single-file build)
server/           Cloudflare workers: sync relay, guestbook daemon
scripts/          build, release, signing, guestbook, site tooling
site-src/         authored landing/guestbook/404 pages (site/ is generated)
docs/             architecture, platform spec, releasing, collab design
```

New apps will live beside `slides/` (working names `spaces/`, `dash/`); the
shared kernel extraction is tracked in `docs/DECISIONS.md`.
