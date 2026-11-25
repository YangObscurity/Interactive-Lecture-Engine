# Component slots (SLOTS.md)

The first slot (sidebar status) follows section 05 of the design spec board.

A theme is more than colours: it can replace the look of a **slot**, a named piece of interface the engine renders.
The engine owns the logic (data, interaction state, keyboard, focus, `aria`, progress); the theme component only draws
what it is given. A theme that does not cover a slot gets the engine default implementation.

## 1. What exists

| Slot | Contract version | Props | Where it renders |
|---|---|---|---|
| `SidebarStatus` | 1 | `{ status: 'not_started' \| 'in_progress' \| 'completed'; current: boolean; label: string }` | in front of every lecture link in the sidebar |
| `AtlasCenter` | 1 | box, title, subtitle, totals, pads | the box in the middle of the home overview map |
| `AtlasCategory` | 1 | `AtlasNodeCommon` + name, zone box, caption | a category (first column) |
| `AtlasGroup` | 1 | `AtlasNodeCommon` + strip + id, title, package, progress, open | a course group (second column) |
| `AtlasPhase` | 1 | `AtlasNodeCommon` + strip + label, open | a stage of a long group (third column) |
| `AtlasLecture` | 1 | `AtlasNodeCommon` + number, label, status | a lecture (last column) |
| `AtlasLink` | 1 | `from`, `to`, `bus`, `kind`, `on` | the link from a parent to its child |
| `GroupCard` | 1 | group fields, `ticks`, `pkg`, `next`, `temp`, `tempLabel`, `labels` | the card of a course group on the home page |
| `GroupMap` | 1 | `groupId`, `pkg`, `read`, `total`, `lectures`, `categories`, `categoryLang`, `labels` | the group map (quick navigation) of a group page |
| `CanvasBackdrop` | 1 | `zones` | category zone boxes behind datasheet boards |
| `CanvasGroup` | 1 | box, `title`, `progress`, datasheet `units` & `unitBuses` | course group blocks / DIP chips on the dependency canvas |
| `CanvasNode` | 1 | geometry, pin fields, `status`, `hover`, `locked`, `active`, `match` | lecture blocks / IC pins on the dependency canvas |
| `CanvasEdge` | 1 | `kind`, `d`, `pairKey`, `segments`, `active`, `hot` | intra-group routes, inter-group bundles / buses, trace links |
| `LectureTitleBlock` | 1 | `code`, `groupId`, `groupTitle`, `category`, `catSlot`, `eyebrow`, `title`, `nodeId`, `difficulty`, `maxStars`, `estimated`, `status`, `statusLabel`, `prev`, `next`, `notionLang`, `labels` | lecture page header card + spec table above `.vp-doc` |
| `FigureFrame` | 1 | `type`, `tagLabel`, `figureLabel`, `title`, `caption`, `buttons` | figure chrome around `.chart-body` |
| `QuizHeader` | 1 | `index`, `total`, `lectureNo`, `badge`, `heading`, `totalLabel` | self-test question strip above `.vp-doc details.details` |
| `SearchPanel` | 1 | `query`, `scope`, `currentGroupId`, `groups`, `activeIndex`, `metaText`, `loadState`, `emptyState`, `labels`, callbacks | full-site & scoped search dialog (`Ctrl+K`) |
| `NavCourseMenu` | 1 | `isOpen`, `isMobile`, `groups` (with optional `temp`), `activeGroupId`, `activeGroup`, `activeLectureIndex`, `activeColumn`, `expandedGroupIds`, `labels` (with optional `temp`), callbacks | topbar course menu (desktop flyout & mobile screen menu, spec board §04.1) |

All 18 registered slots are now implemented in v1 (`RESERVED_SLOT_NAMES` is empty).

Only register a slot that a real component needs.

## 2. Pieces

| File (under `site/docs/.vitepress/`) | Role |
|---|---|
| `theme/slots/contract.ts` | pure data and checks: `SLOT_CONTRACT_VERSION`, slot names, per-slot versions, default files, the `engine` range and `components` rules. No imports: the build and `doctor` read it |
| `theme/slots/registry.ts` | typed props per slot (`SlotProps`), the lazily loaded engine default of each slot |
| `theme/slots/runtime.ts` | which implementation renders now; follows `<html data-lec-theme>` after mount |
| `theme/slots/LecSlot.ts`, `theme/slots/index.ts` | `<LecSlot name="..." v-bind="props" />`, wired to the virtual module |
| `theme/slots/default/*.vue`, `default/parts/` | engine defaults (reader look) of the slots and their helper parts |
| `theme/slots/VPSidebarItem.vue` | host: the VitePress 1.6.4 sidebar item with `<LecSlot name="SidebarStatus">` added (see section 7) |
| `plugins/lectureThemePlugin.mts` | validates packs, serves `virtual:lecture-components` |
| `themes/datasheet/components/*.vue`, `components/parts/` | datasheet implementations (solder pad, atlas chips and pins, device card) |
| `site/tests/fixtures/theme-packs/minimal-slot/` | example third-party pack (tests and docs only, not enabled on this site) |

## 3. `theme.json` fields

In `$extensions["org.lecture-engine"]`:

```json
"engine": "^1",
"components": { "SidebarStatus": "./components/SidebarStatus.vue" }
```

- `engine`: slot contract range, only the form `^<major>`. The engine implements `SLOT_CONTRACT_VERSION` (1). A pack that asks for
  another major fails the build; the message names the theme, the range and the engine version. `npm run doctor` reports the same.
- `components`: slot name -> `.vue` path relative to the pack folder.
  - the key must be a registered slot name; an unknown name fails and the message lists all slots;
  - the file must exist, must stay inside the pack folder (also through symbolic links), and must be a `.vue` file;
  - `components` without `engine` fails.
- A pack with tokens and `theme.css` only needs neither field and behaves as before.

## 4. Writing a theme component

1. Create `components/SidebarStatus.vue` in your pack folder.
2. Declare the props of the contract (copy them from `SidebarStatusProps` in `theme/slots/registry.ts`) and draw them.
3. Keep these rules; the cross-theme e2e (`tests/e2e/slots-contract.spec.ts`) asserts them:
   - **one root element**; `<LecSlot>` falls `data-slot` and `data-slot-impl` through to it (set `data-slot` yourself as well, it is harmless);
   - put `data-status="<status>"` on the root (the contract tests read it);
   - the root exposes `label` as its accessible name, for example `role="img"` with `:aria-label="label"`; the marker sits inside the lecture link,
     so the link's name is "label + lecture title";
   - do not handle clicks, focus or keys: the link around you does it; do not read the progress store, you get `status`;
   - colours and sizes come from `--lec-*` variables only (`--lec-done`, `--lec-border`, `--lec-line-mid`, `--lec-status-radius`, `--lec-space-2`);
     no colour literals (the theme-contract gate scans `theme/**`; packs own their colours in `theme.json`, not in components);
   - the look follows the spec board: unread hollow, reading half filled from the bottom, read solid, 9 px, stroke `--lec-line-mid`.
4. Register it in `theme.json` (`engine` + `components`).
5. Name the pack in `lecture.config.ts` (section 5). A pack inside this repo is built with the site: run `npm run build`.

The example pack is the shortest complete one: `site/tests/fixtures/theme-packs/minimal-slot/` (a test fixture of
`tests/unit/slots-contract.test.ts`; copy it as the start of your own pack).

## 5. Third-party packs (`themePacks`)

```ts
// site/lecture.config.ts
themePacks: ['tests/fixtures/theme-packs/minimal-slot'],   // folders relative to site/, each with a theme.json
theme: 'datasheet',
themes: ['reader', 'minimal-slot'],                  // a pack id can be named like a built-in theme
```

- Pack ids must not repeat a built-in id (`reader`, `datasheet`) or another pack. Duplicates fail the build.
- Tokens compile like a built-in theme's: shared tokens are inherited from `reader` when omitted, contrast is checked, `themeOverrides` apply.
- A pack with `components` is **code**: it runs in the build and in every reader's browser. Treat installing it like adding an npm dependency.
  `npm run doctor` lists every pack and marks those with code: `含代码（n 个组件）`.
- A token-only pack (`theme.json` + `theme.css`) runs no code.

## 6. How a slot resolves

`virtual:lecture-components` (generated by `lectureThemePlugin.mts`):

```js
export const SLOT_DEFAULT_THEME = 'datasheet'
export const SLOT_STATIC = { SidebarStatus: { impl: 'datasheet', component: __static0 } }   // site default theme, in the bundle
export const SLOT_COMPONENTS = { <themeId>: { <slot>: { impl, load } } }                     // every enabled theme, lazy
```

- `impl` is the theme id that provides the component, or `default` for the engine implementation. It is what `data-slot-impl` shows.
- Fallback: a theme that does not list a slot maps it to the engine default. A slot the engine does not know about is a build error.
- The site default theme's components (or the engine default, if the default theme has none) are imported **statically**, so SSR renders them.
  Everything else is `import()`ed on demand; a file that is already static is reused, never put in two chunks.
- Runtime, per `<LecSlot>`: the server render and the **first client render** use the site default theme's implementation, so hydration
  matches. After mount the runtime reads `<html data-lec-theme>` (written before first paint by the head script of `theme/tokens/prefs.ts`)
  and watches it. If the active theme covers the slot with a different implementation, it loads that component and swaps it in once it
  has arrived; until then the default one stays. A failed load keeps the default and is not retried. One `MutationObserver` serves all instances.
- Status in the sidebar is `not_started` until the progress store is ready (what SSR rendered), then follows the store.
- Only readers who changed the theme preference see the shape switch. Measured on a production build (reader preference, datasheet
  default, `/g05/L19`): about 60 to 130 ms from the slot runtime starting on mount until the swapped component is in the DOM
  (`tests/e2e/slots-contract.spec.ts`, "swap timing").

## 7. The sidebar host

VitePress documents replacing an internal component with a Vite alias whose `find` matches the component file
(`config.v2.mts`, `v2ViteAlias`, hooked up in `config.mts` as `vite.resolve.alias`). `theme/slots/VPSidebarItem.vue` is a copy of
VitePress **1.6.4** `VPSidebarItem.vue` (MIT, the licence and the changes are at the top of the file). Changes: the `<LecSlot>` in front of lecture
links, the script lines that compute status, and the two imports of VitePress internals (`useSidebarControl` from its `dist` path,
`VPLink` from the public `vitepress/theme-without-fonts` export). Collapse, active link and `aria` behaviour are the original's.

- Only lecture links (`/<dir>/L<n>`, with or without a locale prefix, decided by `theme/core/route.ts`) get a marker; group titles and other links do not.
- When VitePress is upgraded, diff the new `VPSidebarItem.vue` against this copy and port the change. The version is pinned in `site/package.json`.
- `tests/e2e/slots-contract.spec.ts` and the access e2e cover marker count per link, active item and links; the existing specs that count `.VPSidebar a.link` cover the rest.

## 8. Versions

- `SLOT_CONTRACT_VERSION` (now 1) is the major version of the whole slot contract. A change old components cannot cope with raises it:
  a prop removed, renamed or retyped, a required prop added, a root-element or accessibility rule tightened. Adding an optional prop does not.
- Each slot also has its own version (`SLOT_VERSIONS`), used to see which slot changed; the pack's `engine` range is matched against the contract version.
- On a major bump, update the built-in components, the example pack and this file together; third-party packs fail the build until they move to `^<new major>`.

## 9. Tests

- Unit: `tests/unit/slots-contract.test.ts` (fields, one error case per rule, registry, virtual module, `themePacks`, doctor),
  `tests/unit/slots-runtime.test.ts` (`<LecSlot>` resolve, swap, fallback, SSR markup).
- E2E: `tests/e2e/slots-contract.spec.ts`: one set of assertions per enabled theme (add a row to `THEMES` when a theme gets its own component),
  swap timing, and two screenshot baselines of the sidebar (`v2-sidebar-status-<theme>-light-desktop.png`).
- A pack in a real build: put it in `themePacks` and `themes`, then `npm run build` (the unit tests build the example pack's theme and virtual module without a page build).

## 10. Atlas slots and `GroupCard` (P4a WP-H2)

Engine: `theme/map/atlas/` (`AtlasMap.vue`, `model.ts` tree and presets, `layout.ts`, `skins.ts` geometry, `focus.ts`, `props.ts`); contract:
The atlas (`docs-dev/MAP.md`) draws SVG, so these components follow extra rules (the cross-theme e2e
`tests/e2e/atlas.spec.ts` asserts them):

- **One root `<g>`** (a link: one `<path>`). Coordinates in the props are canvas units, offset applied, `y` is the row's centre line,
  `side` is -1 on the left of the centre (mirror everything: text anchors, pads, pins), 1 on the right.
- **Text is `<text>`**, painted by the canvas label layer from the CSS classes you declare: use `--lec-font-body`, `--lec-font-heading`,
  `--lec-font-mono` and the sizes the layout measured (`skins.ts`, `SKIN_METRICS.<skin>.fonts`; a component that uses other sizes
  overflows its column). Mark text for the zoom levels with `data-label-kind`: `num` (lecture number), `name` (lecture name) and
  `meta` (phase label) vanish when zoomed out; unmarked text always shows.
- **Every label has a transparent hit rectangle** with the class `lec-map-hit`, as a direct child of the root (the e2e geometry check
  takes the direct `rect.lec-map-hit`, `rect.am-chip` and `rect.am-root-box` children as the node's box: no two nodes may overlap and no link may
  cross another node).
- **Parts the engine handles** carry `data-atlas-part="toggle"` (the +/- button) or `"strip"` (the collapsed status strip, one mark
  per lecture in three kinds: read, reading, unread). The engine puts `data-node` (and `data-link` on a link) on the root; do not handle clicks, hover or keys.
- **Highlight and search** arrive as props: `highlight` (`''`, `on`, `hover`, `pre`, `post`) and `match`. Put them on the root as the
  classes `on`, `hover`, `pre`, `post`, `match`. Dimming of everything else is CSS on an engine wrapper: `:global(.am-dim) .am-node:not(.on)`,
  `:global(.am-searching) .am-node:not(.match):not(.cat-hit)` and, for links, `:global(.am-dim) .am-link:not(.on)`.
- **Reserved boxes.** The geometry of a skin (row heights, column gaps, where a link leaves a parent and enters a child) is in
  `theme/map/atlas/skins.ts`. The implementation of `AtlasCenter` decides the skin: `datasheet` gets the datasheet metrics, every other
  implementation (the engine default and any pack) gets the reader metrics, so a pack with its own atlas looks should draw inside the reader boxes.
  A pack that implements one atlas slot should implement all six.
- **Status strip heights (spec board 13.1):** read tall, reading middle, unread short; in the datasheet skin the pads are solid, half and hollow.
- **Group chip name** `DIP-n` / `SOIC-n`: `n` is the lecture count made even, `SOIC` up to 8 lectures (`packageName` in `model.ts`).
- Reader defaults: category-coloured curves, underlined labels, round +/- buttons, status dots. Datasheet: spec board 12 / 13 only (main chip, zone boxes,
  group chips with pads, port labels `PA0-3`, horizontal pins, right-angle traces); no new shapes.

`GroupCard` is an ordinary HTML slot (`<a>` root, `data-group`): reader = the card of spec board 13.1 (category colour on the left edge only, a strip of ticks
in three heights, hover changes the border colour only); datasheet = the device card (heavy top rule, ruled table, the package of 12 laid flat with one pin
per lecture, the padding pin dashed and marked NC, pitch 8 above 48 pins). The strip and the package are `aria-hidden`; the read count and the next line are text.

Server render: the first client render and the server use the site default theme's atlas components and estimated text widths; after mount the
widths are measured and, for a reader whose theme differs, the components swap (the same rule as section 6).

## 11. `GroupMap` and `layout.edges` (P4a WP-H3)

Details of the group page: `docs-dev/GROUP.md`. `GroupMap` is an ordinary HTML slot: reader = the progress grid and the per-category bars,
datasheet = the DIP of spec board 12 without port brackets. Rules (asserted by `tests/e2e/group-page.spec.ts`):

- **One root element.** Every lecture is a real `<a href="{lectures[i].href}" data-lecture="{id}" data-status="read|reading|unread">` and a direct grid item:
  never `display: contents` on a link (Chrome cannot focus it). `data-ready=""` when `ready` is true. Put `label` in `aria-label`. DOM order = lecture order.
- A category bar is a `<button data-lane="{index}">`; the engine scrolls to the lane.
- Do not handle clicks, double clicks or keys: the engine delegates them on `[data-lecture]` and `[data-lane]` (single click opens after the
  double-click window, double click or Space tracks the lecture in the lecture map).
- Names of categories are Notion titles (Chinese): put `:lang="categoryLang || undefined"` on them.

`theme.json` field **`layout.edges`** (in `$extensions["org.lecture-engine"]`): `"curve"` (default) or `"orthogonal"`, the line style of the group page's lecture map
(datasheet: `orthogonal`). The theme plugin fails the build on another value or an unknown `layout` field, `npm run doctor` reports the same; the engine reads it
from `virtual:lecture-components` (`THEME_LAYOUT`) and follows `<html data-lec-theme>`.
