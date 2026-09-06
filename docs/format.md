# The `bento/slides` document format

*Normative reference for the JSON document model, current as of bento/slides
**v1.0.11** (format version `1`), including the BI-style interactive-bindings
feature (`filter`/`input` elements, chart cross-filter, `computed`,
`params`/`paramValues`). The authoritative source is
[`slides/src/model.ts`](../slides/src/model.ts) — this document tracks it. If
the two disagree, the code wins; please file that as a docs bug.*

A `.bento.html` file carries one JSON document inside a single plaintext block:

```html
<script type="application/bento+json" id="bento-doc">
{ "format": "bento/slides", "version": 1, ... }
</script>
```

Everything else in the HTML file is the fixed *shell* (the runtime, styles,
license notices). The document block is the only part that changes between
saves. See [architecture.md](architecture.md) for how the file is built and
saves itself; this document specifies the JSON.

This spec is for people writing tools, generators, or agents against the
format. If you want to *author a good-looking deck*, read
[agents.md](agents.md) — it maps content to the right feature. This one is the
dry reference of every field.

---

## Conventions

- **Coordinates** are pixels in the slide space defined by `doc.size` (default
  `1280 × 720`, a 16:9 canvas). `x,y` is an element's top-left corner.
- **Colors** are any CSS color string, including `rgba(...)` for alpha.
- **Angles** are degrees. Rotation is clockwise. Gradient angles follow the CSS
  convention (`0` = bottom→top, `90` = left→right).
- **Ids are identity.** Elements that share an `id` across adjacent slides
  *morph* into each other; slide `stateOf` and element `link` both reference
  slide ids. Generators must emit deterministic, stable ids.
- **Additive & forward-compatible.** Unknown fields are preserved through
  parse → serialize. Old files must open in newer shells. Never repurpose or
  remove a field; add optional ones.
- **Pure data.** Text HTML is sanitized to an inline whitelist; chart options
  are pure JSON (no functions). A document can never carry executable code.
- **Self-contained.** Everything a view needs is in the file. External
  references (image/media URLs) are allowed but break the offline guarantee;
  embedded `data:`/`asset:` sources keep it intact.

When writing the JSON into the file block, **escape every `<` as `\u003c`** so
the string `</script>` can never appear and terminate the block.

---

## Top-level: `BentoDoc`

| Field | Type | Required | Notes |
|---|---|---|---|
| `format` | `"bento/slides"` | yes | Format discriminant. Check it before editing. |
| `version` | `number` | yes | Format version. Current: `1`. |
| `docId` | `string` (uuid) | yes* | Stable per-document identity, minted at creation. **Never regenerate it.** *Minted on load if a pre-`docId` file lacks one. |
| `title` | `string` | yes | Deck title; also synced to the HTML `<title>`. |
| `size` | `{ width, height }` | yes | Slide coordinate space in px. Default `1280 × 720`. |
| `theme` | `Theme` | yes | Deck-wide defaults (see below). |
| `slides` | `Slide[]` | yes | Linear order; state slides sit right after their parent. Must be non-empty. |
| `modified` | `string` (ISO) | yes | Last-modified timestamp. |
| `present?` | `{ slideNumber?, controls?, progress? }` | no | Present-mode Reveal chrome toggles. |
| `assets?` | `Record<string,string>` | no | Shared blobs (raw SVG markup or `data:` URIs), referenced by key as `"asset:<key>"`. |
| `fonts?` | `Array<{ family, asset, weight?, style? }>` | no | Embedded `@font-face`s injected at boot; `asset` is a key into `assets` (a woff2 data URI). |
| `layouts?` | `Slide[]` | no | Slide-shaped templates (see [Layouts](#layouts)). Absent = the built-in starter layouts are offered. |
| `computed?` | `Record<string,string>` | no | Doc-level computed properties: name → restricted expression string. See [Interactive bindings](#interactive-bindings). |
| `interactState?` | `Record<string,unknown>` | no | Last-saved snapshot of the runtime filter/input/params store. See [Interactive bindings](#interactive-bindings). |
| `collab?` | `Collab` | no | Live-collaboration credentials + CRDT state (see [Collaboration fields](#collaboration-fields)). |
| `template?` | `boolean` | no | Template file: every open mints a fresh `docId` and drops `collab` (see [File modes](#file-modes)). |
| `readonly?` | `boolean` | no | Player file: boots straight into the presentation, no editor. |

### `Theme`

| Field | Type | Notes |
|---|---|---|
| `background` | `string` | Default slide/canvas background. |
| `color` | `string` | Default text color. |
| `accent` | `string` | Single accent color; also seeds derived chart palettes. |
| `fontFamily` | `string` | Default font stack. |
| `chartPalette?` | `string[]` | Ordered series colors for new charts. Absent = derived from `accent`. |
| `table?` | `Partial<TableStyle>` | Defaults for newly inserted tables. Omitted properties use the standard table style; existing tables retain their own `style`. |

---

## `Slide`

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | `string` | yes | Stable slide id. Link + morph targets reference it. |
| `background` | `string` | yes | Slide background (CSS color). |
| `transition` | `TransitionKind` | yes | `none \| fade \| slide \| zoom \| morph`. `morph` tweens matched element ids from the previous slide. |
| `elements` | `SlideElement[]` | yes | **Array order = paint order (z).** First element is at the back. |
| `notes` | `string` | yes | Speaker notes (travel in the file; shown in speaker view). |
| `name?` | `string` | no | Friendly label for link pickers / state badges. |
| `stateOf?` | `string` | no | Marks this slide a hidden *state* variant of the slide with this id (see [Interactive states](#interactive-states)). |
| `hover?` | `{ type, dim?, default? }` | no | Present-mode hover behaviour: `type: 'focus-group'` (dim elements outside the hovered group) or `'reveal'` (`showOnHover` set swap; `default` names the resting set). |
| `comments?` | `Comment[]` | no | Review threads. Editor-only — never rendered in present/print, but saved in the file. |
| `computed?` | `Record<string,string>` | no | Slide-level computed properties — same shape as `doc.computed`, and **wins over** a doc-level entry of the same name. See [Interactive bindings](#interactive-bindings). |
| `params?` | `string[]` | no | Only meaningful on a slide living in `doc.layouts`: named parameters an instance must/can supply. Instances read them as `{{params.<name>}}`. |
| `paramValues?` | `Record<string,string>` | no | Present on a slide instantiated from a params-bearing layout — this instance's concrete values. |

### `Comment`

`{ id, author, text, at (ISO) }` plus an optional anchor and thread:

- Anchor: `elementId?` (thread pinned to an element), or `x?`/`y?` (a point in
  slide coordinates), or neither/dangling (the whole slide).
- `resolved?: boolean`; `replies?: Array<{ id, author, text, at }>`.

`window.bento.comments()` returns the flat, typed-anchor list — the entry point
for tooling that processes flagged issues in a deck.

---

## Elements

Every element carries the common `ElementBase` fields, plus type-specific ones.

### `ElementBase` (shared by all)

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Identity. Shared ids across adjacent slides morph. |
| `x, y, w, h` | `number` | Frame in slide px (top-left origin). |
| `rotation` | `number` | Degrees, clockwise. |
| `opacity` | `number` | `0..1`. |
| `shadow?` | `ShadowSpec \| ShadowSpec[]` | Drop shadow(s): `{ x?, y?, blur, color }`. An array stacks (e.g. elevation + glow). Follows the element's alpha shape. |
| `fx?` | `Fx` | Presentation behaviour — runs in present mode only (see [`fx`](#fx-presentation-effects)). |
| `link?` | `string` | While presenting, clicking jumps to this slide id. |
| `group?` | `string` | Semantic group tag — hover focus + multi-element present behaviours target it. |
| `groupId?` | `string` | *Editor* grouping (select/move as one). Distinct from `group`. |
| `showOnHover?` | `string` | In-slide hover reveal: visible only while an element whose `group` equals this value is hovered (with `slide.hover.type='reveal'`). |
| `role?` | `string` | Layout role (`title`/`subtitle`/`body`/`kicker` by convention) — drives cross-layout content moves. Free-form. |

The element `type` discriminant is one of: `text`, `shape`, `image`, `svg`,
`chart`, `table`, `media`, `filter`, `input`.

### `text`

`type: "text"` — `html` (sanitized inline subset: `b/i/u/s/code/br/span`),
`fontSize`, `fontFamily`, `fontWeight`, `color`, `align` (`left|center|right`),
`valign` (`top|middle|bottom`), `lineHeight`. Optional `letterSpacing` (px) and
`placeholder` (a dimmed prompt shown while `html` is empty; hidden in
present/print).

Text also resolves dynamic-field tokens at render time — `{{page}}`,
`{{pages}}`, `{{title}}`, `{{date}}`, `{{time}}` — with an optional zero-pad
width on page/pages (`{{page:2}}` → `06`). The model stores the raw token;
only the rendered output is resolved, so numbering re-flows when slides move.

### `shape`

`type: "shape"` — `shape: rect | ellipse | triangle | arrow | line | path`,
plus `fill`, `stroke`, `strokeWidth`, `radius` (rect corner). Options:

- `fillGradient?`: `{ angle, stops: [{ at: 0..1, color }] }` — linear gradient;
  when set it wins over `fill` (kept as the solid fallback).
- `strokeStyle?`: `solid | dashed | dotted` (wins over legacy `strokeDash?`).
- **line** shapes take their color from `fill`, draw horizontally across the
  box (rotate for vertical), and accept tips `lineStart?`/`lineEnd?` =
  `none | arrow | dot | bar`.
- **path** shapes carry `d?` (SVG path data) authored in the `pathBox?`
  viewBox `[x, y, w, h]`.

### `image`

`type: "image"` — `src` (a `data:` URI or `"asset:<key>"`), `fit`
(`contain|cover|fill`), `radius`. Embed images as `data:` URIs in `doc.assets`
and reference them to keep the file self-contained.

### `svg`

`type: "svg"` — `asset?` (key into `doc.assets` holding raw SVG markup;
preferred, dedupes) or `markup?` (inline SVG). `css?` is injected inside the
svg and scoped to it at render (hover/focus/animation styles stay contained).
Prefer composing native `shape`/`text`/`path` elements when they can morph;
use `svg` for static artwork/geography.

### `chart`

`type: "chart"` — `option` is a **pure-JSON, ECharts-*shaped*** option object
(the format is ECharts-compatible; the renderer is the in-house `charts-lite`
engine, not ECharts). Static SVG snapshots on the editor canvas / thumbnails /
print; a live interactive instance (tooltips, wheel-zoom, drag-pan) while
presenting.

- `preset?`: `bar | line | pie | scatter` — the panel's re-seed key.
- `source?`: `{ tableId }` — live binding; the chart's labels + series values
  track that table element (data only; styling/axes preserved).
- `filterKey?`: `string` — **cross-filter**. In present mode, clicking a
  category (a bar, or a pie slice) writes its label into the interact store as
  `filter.<filterKey>`, readable anywhere as `{{filter.<filterKey>}}` (see
  [Interactive bindings](#interactive-bindings)). **Bar and pie only** — line
  points aren't discrete categories in the click handler and scatter points
  are explicitly excluded (no categorical meaning). Clicking also still fires
  the element's own `link`, if set — cross-filter and drill-down compose on
  the same click.

**Chart rules that bite:**

- Bar/line series `data` must be **plain numbers**. `{value, itemStyle}` item
  objects coerce to `0`; only **pie** takes `{name, value}`.
- Color **by series**, not per bar — per-item bar colors are unsupported.
- Formatters are **template strings only** (`{b}`, `{c}`, `{d}`) — never
  functions (they can't serialize).
- **Dual y-axis**: `yAxis` may be an array of two `{type:"value"}` axes; a
  series selects one via `yAxisIndex: 0|1`. Give the second axis
  `axisLabel:{formatter:"{value}%"}` for a percentage scale.
- Unknown option keys degrade gracefully (ignored, never fatal).

### `table`

`type: "table"` — a real HTML `<table>` (table-layout fixed), rendered
identically on canvas/thumbnails/present/print.

- `columns`: `Array<{ w }>` — fractional column weights, normalised at render.
- `rows`: `Array<{ cells: TableCell[] }>` where `TableCell` = `{ html, align?,
  color?, bg?, bold? }` (`html` is the same sanitized inline subset as text).
- `header`: `boolean` — treat row 0 as a styled header.
- `style`: `TableStyle` = `{ headerBg, headerColor, zebra?, borderColor,
  borderWidth, cellPadX, cellPadY, fontSize, fontFamily?, color, radius }`.

Cohesion lives in `style`; cells carry only overrides. Morphs as a box —
cell *content* does not morph. Under live collaboration `rows` is a whole-value
LWW register (concurrent different-cell edits are last-writer-wins).

### `media`

`type: "media"` — `kind: video | audio`, `src` (a `data:` URI = embedded, an
external URL / relative path = referenced, or `"asset:<key>"`). Video also
takes `poster?` (`data:`/`asset:`/URL), `fit?` (`contain|cover|fill`),
`radius?`. Playback flags: `controls?`, `autoplay?`, `loop?`, `muted?`.

- **Autoplay fires only in present mode** (never on the canvas or in
  thumbnails), and browsers require `muted: true` for a video to autoplay — so
  `defaultMedia` mutes video by default.
- Embed only **short** clips. The editor warns above `MEDIA_EMBED_BUDGET`
  (8 MB) and offers a URL instead — a big data URI makes the file slow to open
  and save.

### `filter`

`type: "filter"` — a viewer-facing control. Its current value lives in the
runtime **interact store** under `filter.<key>`, readable anywhere in the
document as `{{filter.<key>}}` (see [Interactive bindings](#interactive-bindings)
for the full binding/reactivity model).

| Field | Type | Notes |
|---|---|---|
| `kind` | `select \| multiselect \| slider \| date-range` | Control widget. `select`/`multiselect` render a real `<select>`; `slider` renders `<input type="range">`; **`date-range` currently renders a plain `<input type="text">`** — there is no dedicated range-picker widget yet, so treat it as free text unless you also constrain it via a `pattern`-less convention in your own copy. |
| `key` | `string` | The interact-store key (`filter.<key>`). Unique per document; two filter elements sharing a `key` drive the *same* value (useful for "the same filter on two slides"). |
| `options?` | `string[]` | Static option list for `select`/`multiselect`. |
| `optionsSource?` | `{ tableId, column }` | Live option list instead: dedupe the values in that table's column (matched by header text). Table is looked up across **all** slides, not just the current one. |
| `label?` | `string` | Small caption rendered above the control. |
| `default?` | `string` | Value used when the interact store has nothing for this key yet — shown by the control **and** backfilled into `{{filter.<key>}}` reads elsewhere (see below), so a viewer who never touches the control still sees a consistent default everywhere. |

`multiselect` stores its value as a **single comma-joined string**
(`"a,b,c"`), not an array — `{{filter.<key>}}` renders that literal string.

### `input`

`type: "input"` — a viewer-facing free-value box. Same store mechanics as
`filter`, under the `input.<key>` namespace (`{{input.<key>}}`).

| Field | Type | Notes |
|---|---|---|
| `kind` | `text \| number \| date` | Sets the underlying `<input type>`. |
| `key` | `string` | The interact-store key (`input.<key>`). |
| `label?` | `string` | Small caption above the box. |
| `placeholder?` | `string` | Native input placeholder. |
| `default?` | `string` | Same backfill semantics as `filter.default`. |

---

## Interactive bindings

**Added in the BI-style interactivity feature** (filter/input controls,
chart cross-filter, computed properties, parameterized layout instances).
This is the mechanism behind `{{filter.x}}` / `{{input.x}}` / `{{params.x}}`
/ `{{computed.x}}` tokens, `chart.filterKey`, `slide.computed` /
`doc.computed`, and `slide.params` / `slide.paramValues`.

### The interact store

A single in-memory, present-mode-only key/value store (module singleton, one
per open document) with four **namespaces**, distinguished only by the key
prefix — there is no separate schema per namespace, it's just string keys:

| Prefix | Written by | Meaning |
|---|---|---|
| `filter.<key>` | A `filter` element's control, or a chart's `filterKey` click | Viewer-chosen filter value |
| `input.<key>` | An `input` element's control | Viewer-typed free value |
| `params.<name>` | Never written at runtime — derived from `slide.paramValues` | A layout instance's fixed parameter value |
| `computed.<name>` | Never written at runtime — derived every render | The evaluated result of a `computed` expression |

Only `filter.*` and `input.*` are ever actually stored/set at runtime;
`params.*` and `computed.*` are synthesized fresh into the **binding
context** on every render (see below) — `interact.set('computed.x', …)` is
not a thing.

**Persistence, two layers:**
1. **Session cache** — every `interact.set` debounce-writes the whole store
   to `localStorage['bento:interact:<docId>']` (200ms), so a reload of the
   *same* file in the *same* browser restores where the viewer left off.
2. **File** — `doc.interactState` is a plain snapshot object. A regular save
   bakes the live store into it (`interact.snapshot()`), so the state travels
   with the file and a fresh reader in a fresh browser sees it too. **"Save
   as Template"** deletes `interactState` — a template's first open should be
   pristine, not carrying the author's last filter selection. On load,
   `interact.hydrate(docId, doc.interactState)` seeds the store from the file
   and then **overlays** anything in the local session cache for that
   `docId` (session cache wins for the same doc+browser; a different
   doc/browser gets exactly what the file shipped with).

Nothing in this system ever touches the undo stack or the document's
`modified` field on its own — filter/input clicks are ephemeral runtime
state until a save.

### Binding tokens — `{{filter.x}}`, `{{input.x}}`, `{{params.x}}`, `{{computed.x}}`

Resolved **only inside a `text` element's `html`** — table cells, chart
`option` strings (tooltip formatters etc.), and svg markup do **not** resolve
these tokens; put bound values in a `text` element instead (they still stack
freely — a `text` element can sit right beside a table).

Resolution runs *after* the `{{page}}`/`{{title}}`/… dynamic-field pass (see
the `text` element section above) — both use the same `{{...}}` mustache
syntax but are two independent regexes; a `{{page}}` token is untouched by
binding resolution and vice versa.

`{{computed.foo}}` is the one token whose value is never read directly out
of the interact store — it's evaluated fresh (see below) — but it's still
written with the same `{{computed.<name>}}` syntax as the others.

### `computed` — restricted expressions

`doc.computed` / `slide.computed` are `Record<string,string>`: a name maps
to a **restricted expression string**, evaluated fresh on every render (never
cached, never itself written to `interact` — see above). Slide-level entries
win over a doc-level entry of the same name (an instance can override a
layout's default formula).

The grammar (hand-written recursive-descent parser in `slides/src/expr.ts`,
**no `eval`/`Function`, ever** — a document is data, never code):

```
expr       := ternary
ternary    := comparison ('?' ternary ':' ternary)?
comparison := additive (('==' | '!=' | '>' | '<' | '>=' | '<=') additive)*
additive   := multiplicative (('+' | '-') multiplicative)*
multiplicative := primary (('*' | '/') primary)*
primary    := NUMBER | STRING | '(' ternary ')' | IDENT | IDENT '(' args? ')'
```

- **Numbers**: bare digits (`42`, `3.14`).
- **Strings**: single- or double-quoted (`'CTA'`, `"华东"`). No escapes.
- **Variables**: a dotted identifier resolved against the same **binding
  context** the `{{…}}` tokens use — `filter.region`, `input.budget`,
  `params.tier`, `computed.other`, or `table.<tableId>.<columnHeader>`
  (below). An unresolved variable reads as `''` (empty string), never throws.
- **Functions**: **whitelist of exactly eight**: `sum`, `avg`, `count`, `min`,
  `max`, the scalar helpers `round(x, digits = 0)` and `abs(x)`, and
  `contains(haystack, needle)` — a case-insensitive substring test on the raw
  string values (empty needle matches), the fuzzy-search primitive (v1.0.11 —
  `round` is what keeps a calculator-style `{{computed.x}}` from rendering as
  `19.792000000000002`). Any other call name is a parse error. Arguments that resolve to an
  array (a `table.*.*` column reference) are flattened before aggregating, so
  `sum(table.sales.amount)` sums the whole column while `sum(1,2,3)` sums the
  literal three arguments — both are valid uses of the same function.
- **Table row filter** (`TableElement.filterBy`, v1.0.11): `{ key, column?, mode?, limit?, emptyShowsNone?, emptyText? }`.
  In present mode the table shows only body rows whose cell text matches the
  interact-store value at `key` (`filter.<k>` / `input.<k>`): `column` names a
  header cell (omitted = any cell in the row), `mode` is `contains` (default,
  case-insensitive substring) or `equals`, `limit` caps rendered rows (default
  50), and an empty value shows all rows unless `emptyShowsNone`. Rows keep
  their original `data-r` index. `emptyText` is a muted placeholder row while
  nothing matches; a filtered table renders at natural row height (a lone
  header never stretches). Pair an `input` box with a `filterBy:
  {key:'input.q', emptyShowsNone:true, limit:8}` table for an offline search box.
- **Row pick** (`TableElement.rowClick`, v1.0.11): `{ key, column?, clearKey? }` —
  in present mode clicking a body row writes that row's cell text (`column`
  header name, default first cell) to `key` and clears `clearKey`. With
  `filterBy` this is type → suggestions → click one.
- **Autocomplete** (`InputElement.suggestions`, v1.0.11): a string list or
  `{tableId, column}`, rendered as a native `<datalist>`.
- **Data-bound chart** (`ChartElement.bind`, v1.0.11): `{ data?, labels?, name? }`
  are binding paths whose resolved strings are parsed into the option at render
  time — `data` comma-separated numbers → `series[0].data`, `labels` → `xAxis.data`,
  `name` → `series[0].name`. A computed chain keyed on the viewer's pick makes one
  chart show "the trend of whatever is selected"; present mode re-mounts the live
  chart on change. The model option is never mutated.
- **Filmstrip** (`doc.present.filmstrip`, default on, v1.0.11): a thin bottom bar
  in present mode, one segment per linear slide (states fold into their parent),
  hover shows `n / N · name` (slide `name`, else its largest text), click jumps.
- **Arithmetic** (`+ - * /`) is **always numeric** — both sides are coerced
  with `parseFloat` (non-numeric → `0`). **There is no string concatenation
  operator.** To combine text with a value, don't reach for `+`; put the
  literal text around a `{{computed.x}}` token in the `text` element's `html`
  instead (`"合计：{{computed.total}} 项"`), or use the ternary to pick between
  two whole strings.
- **Comparisons** (`== != > < >= <=`) compare numerically if *both* sides
  look numeric (a real number, or a string that round-trips through `Number`
  cleanly); otherwise they compare as strings lexicographically. `==`/`!=`
  are always a plain `===`/`!==` (no numeric coercion) — `filter.region ==
  '华东'` compares strings, `computed.total > 100` compares numbers.
- **Division by zero** returns `0`, not `Infinity`/`NaN` (fail-open).
- **Cycles**: if `computed.a` references `computed.b` which references
  `computed.a`, every name on that cycle resolves to the literal string
  `'#ERROR'` — it never recurses forever.
- **Any parse or eval failure** (bad syntax, etc.) makes the token resolve
  back to its own **literal source text** wrapped in braces (e.g.
  `{{typo(}}`) — the same fail-open policy as the `{{page}}` resolver. A
  broken expression is visibly broken, never a thrown error that blanks the
  slide.

### `table.<tableId>.<columnHeader>` — reading a table into an expression

Every `table` element's columns are exposed in the binding context, keyed by
the table's `id` and its **header cell text** (via the same column-extraction
`tableChartColumns` used for chart↔table live linking) — e.g. a table with
`id: "capTable"` and a header row `Area | Count` exposes
`table.capTable.Count` as a `number[]`, one entry per body row. Only numeric
columns are exposed this way (matching the chart-linking rules — non-numeric
columns aren't included). Use it inside an aggregate function:
`"sum(table.capTable.Count)"`, `"avg(table.capTable.Count)"`,
`"max(table.capTable.Count)"`. Referencing the bare name outside a whitelisted
function (`"table.capTable.Count"` alone) yields the array's string form —
always wrap it in `sum`/`avg`/`count`/`min`/`max`.

### `params` / `paramValues` — reusable parameterized components

A slide living in `doc.layouts` can declare `params: string[]` — named slots
its own text can reference as `{{params.<name>}}` (e.g. a KPI-card layout
declares `params: ["region", "value", "delta"]` and its number text reads
`{{params.value}}`). **Params live on the whole slide, not per-element** — a
layout with three independent stat cards on one slide draws from one shared
`paramValues` bag, not per-card values; if you need independently
parameterized cards, give each its own layout (its own slide).

Instantiating that layout (`instantiateLayout(layout, paramValues)`) copies
the slide (keeping element ids, per the normal layout-instantiation rule) and
stamps `paramValues: Record<string,string>` on the copy — one concrete string
per declared param name (missing entries backfill to `''`, never `undefined`,
so the panel's "has values" check is stable). Two slides instantiated from
the same layout with different `paramValues` are two different "component
instances" sharing one visual design — this is the format's answer to a
reusable Vue-like component: the layout is the template, `paramValues` is the
props object.

### Reactivity (present mode only)

All of the above — control writes, chart cross-filter clicks, computed
re-evaluation, binding-token re-render — **only runs while presenting**. On
the editor canvas, a `filter`/`input` element shows its `default`/current
value as an inert control preview; `{{filter.x}}` etc. tokens resolve once
against whatever is currently in the store (or the element defaults) but
don't live-update as you edit other elements.

In present mode, each element that references a binding key subscribes to
exactly that key and re-renders **only itself** on change (not the whole
slide — that would replay entrance animations and reset scroll position on
unrelated elements). A `{{computed.x}}` token doesn't subscribe to a
`"computed.x"` store key (that key is never written); it's expanded, through
the whole chain of computed-referencing-computed, down to the concrete
`filter.*`/`input.*`/`params.*` leaves the formula actually reads — so a text
element only re-renders when a value its computed formula *actually depends
on* changes.

### Known limitations (MVP scope)

- Chart cross-filter (`filterKey`) works on **bar and pie only** — not line,
  not scatter.
- `filter`/`input` values are **whole-document scope** — there is no
  per-slide or per-group instancing; two controls sharing a `key` anywhere in
  the deck always drive the same value.
- Binding tokens resolve in `text` element `html` only — not in table cells,
  chart option strings, or svg markup.
- `date-range` is a plain text input today, not a calendar range-picker.
- Under live collaboration, `doc.interactState` isn't itself CRDT-merged
  (it's a plain snapshot field, same class of field as everything outside the
  CRDT-tracked slide/element tree) — treat it as last-writer-wins across
  concurrent editors, same as any other non-collab-aware document field.

---

## `fx` (presentation effects)

All `fx` behaviour runs in **present mode only**.

| Field | Type | Meaning |
|---|---|---|
| `enter?` | `'fade-up' \| 'fade' \| 'fade-down' \| 'slide-left' \| 'slide-right' \| 'slide-up' \| 'slide-down'` | Entrance animation. `fade-*` nudge ~16px; `slide-*` sweep ~120px from an edge. Only runs on non-morph arrivals. |
| `order?` | `number` | Stagger step in the entrance sequence; **equal values enter together**. |
| `countUp?` | `boolean` | Animate numeric parts of the text from 0 to their final value. |
| `ambient?` | `'kenburns'` | Continuous ambient motion for full-bleed photos. |
| `ken?` | `{ dir?, scale?, duration? }` | Ken-burns tuning. `dir: 'drift'` (default) is an endless slow yoyo zoom; `'out'`/`'in'` play once per slide entry (`'out'` starts zoomed by `scale` and settles). `duration` in seconds. |
| `loop?` | dash-march or motion-path | Continuous loop (below). |

`loop` is one of:

- `{ type: 'dash-march', distance?, duration? }` — marching dashed strokes.
- `{ type: 'motion-path', path, duration, delay?, ease?, speeds? }` — the
  element travels an SVG path **relative to its rest position** (the first
  anchor is `0,0`). `ease` sets per-lap tempo; `speeds[]` gives per-anchor speed
  multipliers (`1` = normal, `<1` dwells, `>1` rushes; length matches the
  anchor count). Never combine a motion-path loop with an entrance tween.

---

## Interactive states

A slide with `stateOf: "<parent-id>"` is a hidden variant of its parent:

- Skipped by linear navigation. Reached only by element `link`s.
- While on a state, `ArrowLeft` returns to the parent, `ArrowRight` continues
  *past* it.
- If it shares element ids with its parent (or a sibling state) and the
  transition is `morph`, the matched elements glide between the two.

State slides live adjacent to their parent in `slides[]` and render nested in
the editor sidebar. A clickable trigger should be a padded transparent hit
rect, not the label text itself.

---

## Layouts

`doc.layouts` holds `Slide`-shaped templates (plus the built-ins in `model.ts`).
Instantiating a layout **keeps element ids** — slides born from the same layout
share ids, so their common chrome morphs across transitions and stays traceable
for a re-apply merge.

Applying a layout to an existing slide matches donors first by id, then by
`role` (same element type required); the layout supplies frame + typography
while content (text `html`, `link`) rides along. Layout-owned leftovers are
dropped unless they are text someone actually wrote; user extras survive on top.

---

## Collaboration fields

`doc.collab` is optional and additive; a file with no `collab` opens as a
standalone document forever. Full design and threat model:
[collab-design.md](collab-design.md).

| Field | Type | Notes |
|---|---|---|
| `room` | `string` | Relay WebSocket URL. Room id is **random** — never derived from `docId`. Signed-scheme rooms start `w`; legacy rooms start `r`. |
| `key` | `string` | base64url AES-GCM room key — the **read** capability. Travels in every copy. |
| `on?` | `boolean` | Gates auto-join. Absent = `true` (v0.8.0 files only carried `collab` while actively shared). |
| `sync?` | `SyncStateJSON` | CRDT state (registers / liveness / text) stamped at save on shared documents. Lets an offline-edited copy rejoin as a true fork and merge two-way. Never transmitted as ops. |
| `writerPub?` | `string` | ECDSA P-256 public key (raw SPKI, base64url) — the **write** capability's public half. Travels in every copy; the relay verifies authorship against it. |
| `writerPriv?` | `string` | ECDSA private key (PKCS#8, base64url). Travels **only** in writer copies. A read-only copy is a writer copy with this stripped. |
| `role?` | `'writer' \| 'reader'` | `'reader'` = a live viewer: receives updates, never sends. |

Possession of a copy is the capability; **"Rotate keys" re-mints them to cut
old copies off** (and upgrades a legacy `r`-room to an enforced `w`-room).

---

## File modes

| Mode | Set by | Behaviour |
|---|---|---|
| **Editable deck** | (default) | Boots the editor; saves rewrite the file in place. |
| **Template** | `template: true` | Every open mints a fresh `docId` and drops `collab` (`parseDoc` strips the flag) — each opener gets an independent deck. The template file itself never changes. |
| **Player / presentation package** | `readonly: true` | Boots straight into the presentation; never shows the editor. Collab is stripped from the saved copy. |
| **Read-only live viewer** | `collab.role: 'reader'` (`writerPriv` stripped) | Boots the editor locked; receives live updates but the relay drops any write. |

Encryption is orthogonal: the `#bento-doc` block may hold a `bento/enc`
envelope (PBKDF2-SHA-256 + AES-GCM over the doc JSON) instead of plaintext
document JSON — boot shows a password gate. The envelope is still plaintext
JSON in the block, so the splice contract holds.

---

## Format invariants (do not break)

1. `format: "bento/slides"` plus **additive, optional** fields — old files open
   in newer shells; unknown fields survive parse → serialize.
2. Element **ids are identity** — morph, states, and links all key off them.
   Generators must emit deterministic ids.
3. The data-block JSON stays `<`-escaped; text HTML and chart options stay pure
   data (no functions, sanitized HTML) — a document can never smuggle code.
   `computed` expression strings follow the same rule: a restricted grammar
   evaluated by a hand-written parser, never `eval`/`Function`.
4. Asset references are `asset:` keys into `doc.assets`; a self-contained file
   fetches nothing external at view time.
5. Motion paths are stored **relative** to the element's rest position; the
   first path anchor is that position by definition.
6. Every document carries a stable `docId` — never derive it from content,
   never regenerate it on save.

## Minimal valid document

```json
{
  "format": "bento/slides",
  "version": 1,
  "title": "My deck",
  "size": { "width": 1280, "height": 720 },
  "theme": {
    "background": "#101418", "color": "#F2F0EA",
    "accent": "#FF9E8A", "fontFamily": "system-ui, sans-serif"
  },
  "slides": [
    {
      "id": "s1", "background": "#101418", "transition": "none",
      "notes": "speaker notes here",
      "elements": [
        {
          "id": "t1", "type": "text",
          "x": 96, "y": 260, "w": 1088, "h": 160,
          "rotation": 0, "opacity": 1,
          "html": "Hello from a tool.",
          "fontSize": 88, "fontFamily": "system-ui, sans-serif",
          "fontWeight": 800, "color": "#F2F0EA",
          "align": "left", "valign": "top", "lineHeight": 1.1
        }
      ]
    }
  ],
  "modified": "2026-07-19T00:00:00.000Z"
}
```

`docId` is omitted above for brevity — `parseDoc` mints one on load. When a
tool *creates* a document from scratch, generate a fresh uuid for `docId`.
