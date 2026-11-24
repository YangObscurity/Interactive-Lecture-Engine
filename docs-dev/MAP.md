# Map engine and curriculum data (MAP.md)

Algorithms and parameters are ported unchanged from the home-canvas design prototype (version 17).

Two parts: the **curriculum data** (what the map shows) and the **map engine** (how it is panned, zoomed and labelled).
The home atlas (P4a WP-H2) and the dependency canvas (P4b) both use them. Paths are under `site/docs/.vitepress/`.

## 1. Curriculum data

### 1.1 Shape

```ts
CurriculumData {
  version: 1
  locale: string                 // locale bucket: 'root' or a locale key ('en') - what useData().localeIndex returns
  groups: {
    id; dir; title                // title in the language of the data
    category: string              // category name in that language; '' when the group has none
    catSlot: number               // colour slot 1-8 (--lec-cat-<slot>), assigned over ALL groups of the site
    lectures: { id; n; title; link; untranslated?: true }[]
    phases: { name; from; to }[]  // from / to = lecture numbers (n), inclusive
  }[]
  edges: [string, string][]       // [from, to]: `from` is a direct prerequisite of `to`; sorted
  stats: { groups; lectures; edges }
}
```

- Lecture id = the `core/route.ts` id in lower case: `g05-l19` (the id the progress store uses: no conversion needed).
- Lecture `title` has the "第N讲 ·" / "Lecture N ·" prefix removed; `n` is its number.
- English (or any non-root language): a translated lecture has its translated title and page; an untranslated one has the
  root-language title and the root-language page, and `untranslated: true` (P2d rule). Group titles and category names use
  `i18n.<lang>` of the group, else the root text.
- `catSlot` is also what `withCategorySlots` puts on `themeConfig.groups`; the curriculum carries it so a map does not need the
  site data to colour a group.

### 1.2 Sources

| Source | Where |
|---|---|
| groups, category | `groups.mts` (`category`, `i18n.en.category`); slots by first appearance through `theme/tokens/categories.ts` |
| lectures | `docs/<dir>/L<n>.md`: frontmatter `title`; translations from `docs/<locale>/...` (`i18n/scan.mts`) |
| prerequisites | union of the graph file (`<content>/graph/graph.json`; in-place `site/data/graph.json`; path from `content/paths.mts`) (node `lecture` -> lecture; edge `[from, to]`) and the frontmatter `requires: [g05/L18, ...]` |
| phases | frontmatter `phase: <name>` (consecutive lectures with one name = one phase; a lecture without one joins the phase before it; lectures before the first name form a phase named by their range); else groups of more than 8 lectures are cut automatically: `nc = ceil(n/4)` phases, the first `n % nc` one lecture bigger, named `1-4` (en dash); groups of 8 or fewer have no phases |

`requires` accepts `g05/L18`, `/g05/L18`, `courses/g01/L01`, `L18` (same group) and `g05-L18`. An edge that points at a lecture
that does not exist, or a `requires` entry that is not a reference, is dropped and the build prints a warning; edges into a group
that is not part of the build (`LECTURE_BUILD_GROUPS`) and edges of a lecture to itself are dropped quietly. The build prints one
statistics line (`[access] curriculum: ...`) and at most 20 warnings.

### 1.3 Files

| File | Role |
|---|---|
| `curriculum/frontmatter.ts` | pure: reads `title`, `requires`, `phase` |
| `curriculum/data.ts` | pure: `buildCurriculum` (edges, `requires` merge, dropping, phases, language fallback), shapes, `isCurriculumData` |
| `curriculum/split.ts` | pure: `splitCurriculum` / `mergeCurriculum` (inverse of each other), `CurriculumSlice`, `isCurriculumSlice` |
| `curriculum/node.mts` | Node: reads the disk, `buildCurriculumFromDisk`, `curriculumLog` |
| `theme/curriculum/curriculum.data.mts` | VitePress data loader: the **inline** part, `Record<locale, CurriculumData>` |
| `theme/curriculum/loader.ts` | client: `loadCurriculum(locale)` and friends |
| `theme/curriculum/useCurriculum.ts` | Vue composable over the loader |
| `curriculum/canvasTypes.ts` | pure geometry constants & types for `CanvasBundle` (`reader` + `datasheet` `compact`/`zones`) and `CanvasTierSlice` |
| `curriculum/canvasWorker.mjs` | isolated Node child-process worker running `elkjs` + `libavoid-js` deterministically (zero timestamps/titles) |
| `curriculum/canvasNode.mts` | build-time SHA-256 memoised launcher for `canvasWorker.mjs` + `canvasSliceOf` |
| `theme/curriculum/canvasCompose.ts` | client combiner: uses exact `boardWithInline` for 1 tier or deterministic row-pack + ortho bus routing for >=2 tiers |
| `theme/curriculum/canvas.data.mts` | VitePress data loader: inline-tier `CanvasBundle` (zero restricted groups) |
| `theme/curriculum/canvasLoader.ts` | lazy `import('./canvas.data.mts')` + readable `/_access/<T>/canvas.json` fetcher |
| `access/build.mts` | `finalizeDist` writes the tier files (`ApplyAccessInput.curriculum` & `canvas.json`); the dev server serves them too |

### 1.4 Access tiers (P3b)

- The data loader outputs only the groups of the **inline** tier and the edges whose two ends are both in them.
- Every restricted tier gets `/_access/<tier>/curriculum.<locale>.json` per locale bucket (`curriculum.root.json`,
  `curriculum.en.json`) AND `/_access/<tier>/canvas.json` (`CanvasTierSlice`: exact `boardWithInline` + isolated `tierOwn`).
- `mergeCurriculum(inline, slices)` puts them back in the original order and keeps only edges whose two ends are present. Merging
  all slices gives the original; some slices give the original minus the other tiers and every edge touching them.
- Nothing restricted appears in the inline data: not a title, not a lecture id (checked in `tests/unit/curriculum-split.test.ts`,
  and in the built site by `check:access:dist`, which now also covers these files).

### 1.5 Client API (`theme/curriculum/`)

```ts
loadCurriculum(locale = 'root'): Promise<CurriculumData>        // inline + readable tiers (cached per access resolution and locale)
loadInlineCurriculum(locale?): Promise<CurriculumData>          // inline only
loadCurriculumSlices(locale?): Promise<CurriculumSlice[]>       // the readable tiers' slices only
useCurriculum({ locale?, initial? }): { data: Ref<CurriculumData | null>; loaded: Ref<boolean> }
```

- `locale` is a locale bucket. `loadCurriculum` asks the P3b access store which tiers are readable: no restricted tier configured,
  or none readable, means **no request**; each readable tier costs one GET, and only a 200 with a valid slice of that tier counts.
- Server render: the composable shows `initial`; pass the build-time data for the numbers that must be in the HTML:
  `import { data } from '../curriculum/curriculum.data.mts'` in the home component (the data lands in that component's chunk only;
  never import the loader from code that runs on every page). After mount the merged data replaces it, and again when the access
  answer changes.
- `loadCurriculum` itself uses a dynamic `import()` of the data loader, so the data is its own chunk.

## 2. Map engine (`theme/map/`)

```
geometry.ts      pure math: Transform, zoomAbout, fitTransform, clampTransform (80 px rule), boxTransform, centerOn,
                 panToTarget, ladder / ladderDown, lerp / ease, wheelFactor, wheelZooms, keyAction, isDrag
clickRule.ts     createClickRule: single click after 260 ms, a double click cancels it (pure, injectable timers)
labels.ts        LabelLayer: the canvas label layer; labelHitBox, labelPixelSize, labelOnScreen, readLabelStyle ...
viewport.ts      MapViewport: pan / zoom state machine on an <svg> + stage (DOM, no Vue)
useMapViewport / useLabelLayer / useClickRule / useInfoPanel   composables
aria.ts          mapAriaLabel / mapSvgLabel
MapStage.vue     stage + svg + label canvas + zoom buttons + hint, around your svg content
MapControls.vue  + / - / fit buttons          MapInfoPanel.vue  the info panel
index.ts         everything above
```

### 2.1 Behaviour

- **Viewport.** The view is `{ k, x, y }`; the svg element carries `transform: translate(x px, y px) scale(k)`. While the view
  moves the svg has the class `lec-moving` (CSS may use it); `commit()` ends a movement: it redraws once at the settled view,
  sets the custom property `--k` on the svg and removes the class. Scale limits 0.05 - 2.5. Panning is bounded: at least 80 px of
  the content stay inside the stage. `fit` leaves the top 56 px (HUD row) free and fills 96% of the rest.
- **Wheel.** Zooms about the pointer, 140 ms to settle. It acts only after a click on the map (`active`) or with Ctrl / Cmd held;
  otherwise the page scrolls. Esc, or a press outside the stage, leaves the active state.
- **Keys** (stage focused, not while typing in an input inside it): `+` `=` zoom in by 1.25, `-` out, arrows pan 80 px, `Esc`.
- **Drag.** More than 4 px of travel is a drag; a press without travel activates the map. `viewport.wasDragged` is true during the
  click that ends a drag: a click handler should ignore it.
- **Animation.** `panTo` (320 ms) and `zoomToBox` (380 ms) ease out cubic and land on a ladder scale (`2^(n/4)`); with
  `prefers-reduced-motion: reduce` they jump (read at the start of every animation). Any new movement cancels a running one.
- **Ladder.** Only while an animated zoom runs, the label font size is `size * ladder(k)` instead of `size * k` (a handful of glyph
  sizes is reused; the last frame already has the final size). Drag, wheel and the settled frame use the exact size.
- **Resize.** A map the reader has not touched is fitted again; one the reader has moved keeps its view (clamped).
- **Click rule.** `createClickRule().click(single)` runs `single` after 260 ms unless another click or a `dblclick(double)`
  comes first; `dblclick` runs at once and cancels the pending single click. One rule for lectures and groups: single click opens,
  double click looks closer.
- **Text is not selectable** on the stage (`user-select: none`).
- **No opacity transitions** on many elements (the map stylesheet has none; only the info panel fades).

### 2.2 The label layer

Every `<text>` stays in the svg (class names, CSS rules, data) but is `display: none` (the stage stylesheet does it); one `<canvas>`
over the svg draws the labels that are on screen at screen-pixel size.

- Position: the `x` / `y` attributes plus the `translate(...)` of the element's `transform`, `rotate(...)` for rotation,
  `text-anchor` for the alignment.
- Look: read with `getComputedStyle` (font style, weight, size, family, fill, underline, `paint-order: stroke` halo, opacity as the
  product of the element and all its ancestors up to the svg). A `MutationObserver` re-reads only the text whose `class` changed,
  or the texts under an element whose class changed; a class change on the svg itself re-reads all, except the zoom-level classes
  `lec-moving` and `lod-*`. A change of `class`, `data-lec-theme`, `data-lec-tint`, `data-lec-size`, `data-lec-font` on `<html>`,
  `prefers-color-scheme` and `document.fonts.ready` re-read all.
- **Styles are read once, not per frame.** The first paint after a `collect()` / class change reads the labels that are on screen,
  idle time (`requestIdle` seam) reads the rest, and the results are kept across frames (cleared on a re-read of everything, element
  caches cleared when an ancestor's class changes). Internal `passCache` is invalidated upon any SVG DOM mutation (node additions, removals, or attribute changes) to ensure layout recalculations never reuse stale geometry. So once the layer has settled, a pan, drag or zoom frame calls no
  `getComputedStyle` (unit test and `atlas.spec.ts` drag test spy on it).
- **Web fonts.** `display: none` text makes the browser fetch nothing, and a canvas draw is not promised to start the download of
  the unicode-range slices (Chrome 157 does), so the layer collects the characters of its labels per distinct font (style, weight, family) and calls
  `document.fonts.load(font, chars)` for what it has not asked for, then repaints when the load resolves and on `loadingdone`.
  Before this the layer never repainted on `loadingdone`, so a paint that ran while a slice was still loading kept the fallback
  glyphs (the live tofu report of 2026-11-21; root cause inferred, not reproduced in e2e).
  **Labels wait for their slices (2026-11-22).** While a unicode-range slice that covers a label's characters is not loaded
  (`document.fonts.check(font, text)` is false) the label is not drawn; the paint after the load (or after `FONT_GIVE_UP_MS` = 3 s,
  when the layer draws with the fallback) draws it. A canvas draw in the loading state uses the fallback list, and where that has no glyph
  for a character the result is the tofu box; on the author's machine (system CJK fonts) the fallback glyphs show instead, the
  wait window was measured (5 paints with fallback glyphs for the 8 s the files were held back) but the box itself was not reproduced.
  The layer reports `ready` (`LabelProbe.ready`, option `onReady`, `MapStage` emits `ready`): every visible label drawn with its real font
  (or given up) and every label styled. `HomeBody.vue` shows a mask with a spinner over the map region until then (`.hb-map-region`,
  `data-map-state`), and sets `<html data-home-map>` before the first paint from the stored mode (`core/homeMapMode.ts`).
  `canvas.lecLabels` (`LabelProbe`: `paints`, `fontsReady`, `waiting`, `gaveUp`, `drawn`, `ready`) is the test hook; e2e waits for it (`waitForLabelPaint` in
  `tests/e2e/fixtures.ts`) before a screenshot, and `tests/e2e/map-fonts.spec.ts` delays every `*.woff2` by 3 s. A map that measures
  text itself (`AtlasMap`) re-measures on `loadingdone`.
- Visibility: a label is drawn only for scales `minK <= k < maxK` (`data-min-zoom` / `data-max-zoom` on the text or an ancestor;
  default always), only if its size on screen is at least 4 px, its opacity above 0.01, and its anchor is at most 600 px beside or
  60 px above / below the stage. Pass `visible(label, k)` and `kindOf(el)` to `LabelLayerOptions` for another rule.
- **Hit shapes.** A hidden text cannot be clicked: give every label a transparent shape in the svg, class `lec-map-hit`
  (`fill: transparent; stroke: none`); `labelHitBox(x, y, width, size, anchor)` computes its rectangle in canvas units.
- After the svg content is re-rendered call `collect()` (or give `MapStage` a changing `labelsKey`).

### 2.3 Mounting a map (WP-H2)

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { MapStage, MapInfoPanel, mapAriaLabel, useInfoPanel, useClickRule } from '../map'   // via the .vue files and index.ts
const stage = ref<InstanceType<typeof MapStage> | null>(null)
const info = useInfoPanel()
const clicks = useClickRule()
// stage.value.viewport.fit() / .zoomToBox(box, { panelOpen }) / .panTo(cx, cy) / .zoomBy(1.4) / .setView(t)
// stage.value.collectLabels() after a re-render
</script>
<template>
  <MapStage ref="stage" :width="W" :height="H" :aria-label="mapAriaLabel(lang, { groups, lectures })" :labels-key="layoutKey" :on-escape="clearLock">
    <template #hud><input class="search" ...></template>
    <template #defs>...</template>
    <!-- svg content in canvas units: shapes, lines, <text> with their lec-map-hit rectangles -->
    <template #overlay><MapInfoPanel :content="info.content.value" :open="info.open.value" /></template>
  </MapStage>
</template>
```

`MapStage` props: `width`, `height` (content, canvas units), `ariaLabel`, `svgLabel`, `ignore` (selector of HUD and panels, default
`.lec-map-hud, .lec-map-panel`), `onEscape` (return true when you took Esc), `labelsKey`, `labelOptions`, `bare` (no built-in
buttons and hint). Slots: `hud` (top left), `defs`, default (svg content), `overlay`. Emits `commit(Transform)`. Exposed:
`viewport` (commands and state refs: `fit`, `zoomBy`, `zoomAt`, `panBy`, `panTo`, `zoomToBox`, `setView`, `transform`,
`active`, `touched`, `moving`, and the `MapViewport` object as `viewport.viewport.value` with `on('place' | 'commit' | 'state' |
'resize')`, `view`, `wasDragged`), `labels` (`layer`, `collect`), `collectLabels`, `stage`, `svg`.

Elements over the stage carry `lec-map-hud` (rows of buttons and inputs) or `lec-map-panel` (panels): a press or wheel on them does
not drag or zoom the map. The info panel (`MapInfoPanel` + `useInfoPanel`): top right, does not follow the pointer, takes no
clicks, fades out 140 ms after `hide()`, and is not shown when the window is narrower than 700 px.

Accessibility: the stage has an `aria-label` from `mapAriaLabel` (group and lecture counts, how to operate); the group cards and
group pages outside the map are the linear path to the same content.

### 2.4 Tests

`tests/unit/map-geometry.test.ts` (zoom about a point, fit, bounds with the 80 px rule, ladder, jump targets, input rules),
`map-click-rule.test.ts`, `map-viewport.test.ts` (happy-dom: wheel gate, drag, keys, animation, reduced motion, resize),
`map-labels.test.ts` (happy-dom with a recording 2D context: culling, ladder sizes, style refresh).

## 3. The home atlas (P4a WP-H2)

`theme/map/atlas/`: `AtlasMap.vue` (mounted by `HomeBody.vue`), `model.ts` (tree, expansion presets, package names, search match), `layout.ts` (the two-sided
tidy tree; pure, text widths injected), `skins.ts` (row heights and link anchors per skin), `focus.ts` (hover branch, prerequisites, follow-ups, search rows),
`props.ts` (laid-out node to slot props), `measure.ts` (canvas text widths). Slots and their rules: `SLOTS.md` section 10.

- **Expansion.** Four presets: `reading` (default; a group opens when something in it is being read, a phase when anything there has progress), `progress`, `all`,
  `none`. A `+/-`, a strip, a double click or a search jump sets a choice for that node (a new preset clears them). The reader's preset is kept in
  `STORAGE_KEYS.atlasExpand` (`lecture:atlas-expand`); the site default is `home.atlasExpand` in `lecture.config.ts` (`themeConfig.lectureHome`).
- **Interaction** (one event delegate on the svg group): single click opens a lecture or the group page (after the 260 ms window), double click zooms (a lecture: to its
  group; a group or phase: opens all and zooms, never below 70%); a phase label toggles; a category click zooms to it; +/- and strips keep the clicked row in place; hover lights
  the branch (info panel: prerequisites and follow-ups; those inside a collapsed phase light the phase row); search: Enter locates, Enter again steps to the next hit.
- **Label zoom levels:** big group ids below 22%, numbers and phase labels from 22%, lecture names from 45% (`data-label-kind`).
- **Performance.** The layout is a few milliseconds; the cost of a change is the browser's style and layout of the svg (about 3300 elements fully open).
  Components are resolved once per slot and rendered directly (no wrapper per node); the new view is fitted before Vue patches the svg, so no layout is forced inside the click.

## 4. The dependency canvas (P4b)

`theme/map/canvas/`: `CanvasMap.vue` (mounted lazily by `HomeBody.vue` when `mapMode === 'graph'`), `model.ts` (pure view-model builder, reader Beziers, datasheet ortho trace router, counter-clockwise DIP pinout resolver), `CanvasTracePanel.vue` (`#focusbar` floating trace panel).

- **Slots:** `CanvasBackdrop`, `CanvasGroup`, `CanvasNode`, `CanvasEdge` (default reader + `datasheet` theme pack with `compact` / `zones` toggle).
- **SVG Draw-Order & Layering:**
  `CanvasMap.vue` enforces a strict SVG element rendering hierarchy:
  `groups -> intraEdges -> nodes -> traceEdges -> bigLabels`.
  Intra-group edges render beneath node components so node cards remain cleanly readable, while active trace edges and big LOD group labels render on top to keep trace journeys unobstructed.
- **Marker Geometry:**
  Arrowheads (`#cv-ah*`) define `markerUnits="userSpaceOnUse"`, ensuring arrow indicators maintain crisp, predictable physical dimensions independent of SVG coordinate scaling across all zoom levels.
- **LOD labels:** group big IDs (`big`) `< 0.22`; group titles + numbers (`mid`, `num`, active `ann`) `>= 0.22`; lecture titles + NC (`name`, `nc`) `>= 0.45`.
- **Trace & bundles:** single click opens (260 ms delay), dblclick group zooms box, dblclick lecture enters trace lock (zooms with trace panel inset), click bundle locks cross-group pair and shows datasheet `ann-tag` annotations only inside `.bundle-g.on`.
- **Node Trace Roles:**
  During trace locking, nodes are dynamically assigned crisp visual roles:
  `locked` (the primary selected lecture), `pre` (direct prerequisites along the upstream chain), `post` (direct subsequents along the downstream chain), and `pair` (the counterpart endpoint in bundle locks), establishing distinct visual priority and high-contrast styling.
