# Front-end Engine (VitePress Theme)

> **Language / 语言**: English ｜ [中文](./README.md)

> TL;DR: a lecture site = VitePress 1.6.4 + three lazily-loaded chart libraries. The theme
> is only 5 files with strictly separated responsibilities — every change should land in
> **one** file; use the section 2 matrix to locate it.

## 1. Files and responsibilities

| File | Responsibility |
|---|---|
| `site/docs/.vitepress/config.mts` | Site metadata, nav, **auto-scanned sidebar** from the `title` frontmatter of `docs/<group>/L*.md`, local search |
| `theme/index.ts` | Mount entry point: `onMounted` starts reading-mode + charts, `onUpdated` re-renders new charts after SPA navigation |
| `theme/charts.ts` | **All chart runtime logic**: skeleton generation, the three renderers, zoom, fullscreen modal, layout normalisation |
| `theme/custom.css` | Chart styles, modal styles, immersive-reading layout, anti-overlap / anti-clipping |
| `theme/reading-mode.ts` | Immersive-reading button and its localStorage state |
| `theme/reading-progress.ts` | **Reading-progress memory**: records scroll position and percentage per lecture, returns to the last-read position on entry; data source for the home page's "continue reading" list |
| `theme/cites.ts` | **In-text citation markers**: clicking a `.cite` calls `window.open(data-cite)` to **open the external link directly in a new tab** (the references section was removed site-wide; links are not allowed in the body — see `content/add-lecture.md` §8) |

## 1b. ⚠️ Logic that must run after SPA navigation has to hook `router.onAfterRouteChange`

After every navigation, VitePress's router does
`await router.onAfterRouteChange?.(href)` (`vitepress/dist/client/app/router.js`) —
**this hook is reserved for the theme; the core itself never sets it**.

```ts
enhanceApp({ app, router }) {
  const afterRoute = () => {
    if (typeof window === 'undefined') return   // build-time SSR also goes through router.go, so it must be blocked
    initCharts()
    initReadingProgress()
  }
  ;(router as any).onAfterRouteChange = afterRoute    // new name first
  ;(router as any).onAfterRouteChanged = afterRoute   // old name as fallback
}
```

**The pitfall we hit**: at first we only used `onMounted` / `onUpdated` inside `setup()`.
`onMounted` fires only on a full page load; `onUpdated` fires only when **the current
component itself** re-renders — but on SPA navigation it is the subtree that re-renders and
the root component may not update at all, so the hook never ran.
Symptom: clicking "continue reading" on the home page jumped to the target lecture but
**left the page scrolled to the top**.

## 1c. Code-block syntax highlighting (Shiki) ★

VitePress highlights with **Shiki**, and the `shiki` package ships **316 languages built
in**; VitePress will **dynamically load on demand** any language Shiki recognises:

```js
// vitepress/dist/node/chunk-*.js
function loadLanguage(name) {
  if (!isSpecialLang(lang) && !highlighter.getLoadedLanguages().includes(lang)) {
    const resolvedLang = resolveLangSync(lang)
    if (resolvedLang.length) highlighter.loadLanguageSync(resolvedLang)  // ← dynamic load
    else return false
  }
}
```

**So: get the fence tag right and you get highlighting immediately — no registration in
the config required.**

| Concept | Explanation |
|---|---|
| `markdown.languages` | Only a **preload** list (empty array by default), **not a whitelist**; it never overrides default behaviour, and appending is purely additive |
| **Special languages** | `text` / `plain` / `txt` / `plaintext` — decided by `isSpecialLang()`, **designed not to highlight** (renders as a block of grey) |
| Empty-language fence | Falls through to `defaultHighlightLang: 'txt'` → same as above, grey |
| `languageAlias` | Optional; maps e.g. `sh` → `bash` |

### The trap in this example: the content source labelled every non-C block `plain text`

```plain text   ← note: the two words "plain" + "text", not a single "text"
$ gcc -std=c99 -### hello.c
...
```

Measured: 288 such blocks — **201 were actually shell sessions**, plus 34 formulas,
19 key-value blocks, 2 kconfig and 1 assembly block.

The fix is to **re-tag the fences by content** (`scripts/retag_fences.py`, idempotent):

| Content signature | Language chosen |
|---|---|
| Has a `$ ` / `# ` prompt plus output lines | `shellsession` |
| A single command (idf.py / git / gcc / cmake …) | `shellsession` |
| `menuconfig`/`config` + `bool`/`depends on` … | `kconfig` (custom) |
| Starts with `.section`/`.globl`/`.text` | `asm` |
| `key = value` with no code structure | `ini` |
| Contains `= ≈ ≤ ≥ · √` with no code structure | `math` (custom, **legacy**) |
| Everything else (prose / quotations / directory trees) | left as-is |

Distribution after re-tagging: `plain` 236 → **24**, `text` 52 → **7**, with new
`shellsession` **201**, `math` **34**, `ini` **19**, `kconfig` **2**, `asm` **1**.

### Custom syntaxes (languages Shiki does not have)

`docs/.vitepress/grammars.mts` defines two TextMate grammars, registered in `config.mts`:

```ts
markdown: { languages: [KCONFIG, MATH] }   // appended to preload, does not override defaults
```

- **kconfig**: Shiki's 316 languages **do not include** kconfig (only kql/kotlin/kusto).
- **math**: a **legacy** grammar — early lecture formulas were ASCII layouts
  (`v(t) = V0 · sin(ωt)`) and the `latex` grammar produced nothing, so a math grammar was
  written by hand. **Since 2026-10-07 the site renders formulas with build-time KaTeX**
  (`docs/.vitepress/math.mts`); new formulas are always LaTeX (`\(…\)` / `$$…$$`, see the
  root `AGENTS.md` §4.9, Chinese), and the `math` fence now serves only those 67 older
  blocks (being migrated lecture by lecture).

Visual audit (screenshots from 2026-10-05): Kconfig looks identical to VS Code with the
Kconfig extension installed; shellsession distinguishes commands from output by colour;
math separates unit symbols, function names and operators clearly.

## 2. The "change this, affect that" matrix

| I want to… | Change only this |
|---|---|
| **Add an entire course group** | `docs/.vitepress/groups.mts` (add one entry) + the content directory (see `content/add-lecture.md` §7, Chinese) |
| Change a course group's title / blurb / accent / tags | The corresponding entry in `groups.mts` |
| Change the home page structure (stats bar / feature cards / reading hint) | `theme/HomeBody.vue` |
| Change the group index page (badges / stats / lecture table) | `theme/GroupIndex.vue` |
| Change the top nav / sidebar grouping logic | `config.mts` (scanning logic; usually needs no change) |
| Add or remove a toolbar button, change its label or icon | `charts.ts` → `TOOL_DEFS` + `TOOLS_BY_TYPE` |
| Change chart label copy (e.g. "data chart") | `charts.ts` → `TAG_LABEL` |
| Show or hide a button for one chart type | `charts.ts` → `TOOLS_BY_TYPE` |
| Fix title/legend/grid overlap or clipped axis names | `charts.ts` → `normalizeEchartsLayout` |
| Fullscreen modal appearance / keyboard shortcuts | The modal block in `custom.css` + `charts.ts` → `openChartModal` |
| Chart card border, palette, default height | `custom.css` |
| Swap the site icons | `docs/public/favicon.svg` + `favicon.ico` + `icon-192.png` + `apple-touch-icon.png`, declared in the `head` of `config.mts` (see `ops/README.md` §5, Chinese) |
| Home page / group index styling | The "home page" and "course group index" blocks in `custom.css` |
| Immersive reading column width, font size, top bar | The `html.reading-mode` block in `custom.css` |
| Reading-position restore strategy / hint bar | `theme/reading-progress.ts` (+ `#lecture-resume-hint` in `custom.css`) |
| Hint bar appear/dismiss duration | `HINT_HOLD` in `reading-progress.ts` **must be changed together with** the `transition` durations in `custom.css` (currently fade-in 0.24s + hold 1.1s + fade-out 0.24s, under 2s total; hovering pauses the auto-dismiss) |
| Add a lecture (so it appears in the sidebar) | **No code change**: just add `docs/<dir>/LNN.md` and it appears |
| Add or edit a chart source | That lecture's `docs/public/charts/<ID>-LNN.json` (see `content/`, Chinese) |

**Rule of thumb**: anything about "how a chart renders and which buttons it has" →
`charts.ts`; anything about "how it looks" → `custom.css`; anything about "which course
groups exist and how navigation is generated" → `groups.mts` + `config.mts`; anything
about "one lecture's content or chart data" → the corresponding file in `content/`.

**Rule of thumb**: anything about "how a chart renders and which buttons it has" →
`charts.ts`; anything about "how it looks" → `custom.css`; anything about "navigation,
titles and search" → `config.mts`; anything about "one lecture's content or chart data" →
the corresponding file in `content/`.

## 3. Runtime data flow

```
docs/<group>/EX-L01.md
  └ <figure class="chart" data-lecture="EX-L01" data-id="c1" data-type="mermaid"></figure>
        │  (this single line is all the lecture contains; everything else is generated at runtime)
        ▼
fetch /charts/EX-L01.json   →   { "c1": { "type": "...", "code": "..." } }
        │
        ▼
charts.ts  initCharts()                       ← idempotent, safe for repeated onUpdated calls
  ├ ensureSkeleton(fig)      builds .chart-body + label + toolbar + source fold
  ├ injectSource(fig, code)  fills details.chart-code
  ├ normalizeEchartsLayout() echarts only; fixes title/legend/grid/axis-name positions
  ├ renderMermaid / renderEcharts / renderWavedrom
  └ fig.dataset.chartStatus = ok | loading | missing | error | unknown-type
```

**Diagnostics**: inspect `<figure data-chart-status>` directly in the browser. Stuck at
`loading` means the fetch or the render is hanging; stuck at `missing` means the `data-id`
in the Markdown does not exist in the JSON.

## 4. Building

```bash
cd site && npm run build        # → docs/.vitepress/dist
```

**Restart the preview server after every build**: `vitepress preview` does not notice
changes to `dist` and keeps serving the old HTML → which references chunks already
overwritten by the new build → `404` → **Vue never mounts**.
The symptom is confusing: the `figure` elements are all there (SSR output), but
`__CHARTS_DONE__` stays `undefined` and `lecture-reading-btn` does not exist.
For troubleshooting, see `ops/README.md` (Chinese).

## 5. Established constraints (all of them hard-won)

- **Leave blank lines around `figure`**: only then does markdown-it treat it as a
  standalone `html_block`. The compact form was a requirement of the old renderer; the
  standard blank-line form is now universal.
- **mermaid `foreignObject`** defaults to `overflow:hidden` with a height exactly equal to
  lines × line-height, so the end of a Chinese line gets clipped → CSS forces
  `overflow:visible!important`.
- **The inline echarts height** is decided by
  `figure.chart[data-type='echarts'] .chart-body{height:430px}`; the modal must override it
  with a rule of **equal specificity and without `!important`**, otherwise the inline
  `width/height` that JS writes for zooming wins and squashes it.
- **Immersive reading requires all three pieces changed together**: `--vp-nav-height`,
  `.VPContent{padding-top}` and the top-bar background. Hiding the sidebar alone makes the
  top bar "see through".
- **SPA idempotence**: `initCharts` is guarded by `[data-rendered]`, the toolbar by
  `data-tools-bound`, and event delegation is bound on the `figure` (the toolbar gets
  rebuilt, so binding to the buttons would break).
- **Font race**: mermaid must wait for `document.fonts.ready` before rendering, otherwise it
  estimates height with the fallback font and overflows once the Chinese font arrives; but
  there must be a timeout fallback (2.5s), or the whole page hangs in some environments.
- **`h2` carries a horizontal rule that pushes the heading down**: VitePress's `.vp-doc h2`
  has `border-top:1px` + `padding-top:24px` at specificity `(0,1,1)`; writing only
  `.gi-title { border-top:0 }` (`(0,1,0)`) **gets overridden** → the group index heading
  gains an odd rule beneath it, is pushed down 24px and looks misaligned with the badges.
  **Overriding it requires raising specificity**:
  `.vp-doc h2.gi-title { border-top:0; padding-top:0; margin:0 }`.
- **Flex decides wrapping before shrinking**: `flex: 1 1 auto` judges fit by **content
  width**, so a long title (~430px) plus a left button (290px) exceeds the container
  (688px) → it wraps to the next line and then fills the whole line.
  To get "same line and fill the remaining width" you must use **`flex: 1 1 0`**
  (basis 0, wrapping then depends only on `min-width`).
- **Whitespace inside inline elements**: newlines and indentation inside an `<a>` tag
  render as a space, making the button label look off-centre → wrap the text in a `<span>`
  and use `inline-flex + align-items:center`.
- **The zero-width space in `header-anchor`**: VitePress inserts
  `<a class="header-anchor"></a>` into headings, so reading `h1.textContent` picks up a
  `\u200b` → the title stored in localStorage carries an invisible character and needs
  `.replace(/\u200b/g,'')`.
