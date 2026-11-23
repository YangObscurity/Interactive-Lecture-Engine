# Access tiers (ACCESS.md)

This file covers the build side (WP-A1): configuration, tiers, output layout,
the gateway manifest, the build guards and the check script. The client side (WP-A2) reads what is described here; it is covered in sections 8 and 9.

The goal: `lecture.config.ts` says who may read which course group; the build guarantees that titles, text, chart data,
graph nodes and search content of a restricted group appear **only under the protected paths of its tier**, so an
authenticating gateway can block by path prefix. The front end makes no permission decisions; it merges what the
gateway lets through.

## 1. Configuration

```ts
// site/lecture.config.ts
access: {
  default: 'public' | 'authenticated',        // groups not listed below, home page, non-group pages; default 'public'
  groups: { G05: { read: 'authenticated' }, LR: { read: ['staff', 'ta'] } },  // string[] = gateway user-group names
  enforcement: 'none' | 'gateway',            // does the deployment have an authenticating gateway; default 'none'
}
```

- Keys of `groups` are the group `id`s of `docs/.vitepress/groups.mts`. An unknown id fails the build and lists the valid ids.
- `read: string[]` must not be empty. Names are trimmed, de-duplicated and sorted before they enter the tier id.
- This site: `access: { default: 'authenticated', enforcement: 'gateway' }` (no restricted tier, build output unchanged).
- The block is declared in `site/config/schema.ts` (`SITE_BLOCKS`, zh/en descriptions, also written to `config/schema.json`).
  Validation: `validateLectureConfig` (shape) and the build (group ids), both through `access/tiers.ts`.

## 2. Tiers

| Tier | Id | Who |
|---|---|---|
| public | `public` | everybody |
| authenticated | `authenticated` | any signed-in user |
| user groups | `grp-` + `fnv1a(sorted names joined by "\n")` as 8 hex digits | members of any of the named gateway groups |

Order: public < authenticated < group tiers (group tiers are not comparable). The same set of names always gives the
same id.

- **Inline tier** = the lowest tier of `default` (home page, non-group pages) and of every built group. Its content ships
  inside every page (`themeConfig`).
- **Restricted tiers** = every tier above the inline tier that has at least one built group. Their content lives only under
  `/_access/<tier>/` and the group folders.
- If `default` is `authenticated` but some group is `public`, the inline tier is `public`; the home page still stays inline
  (a path-prefix gateway cannot protect `/` separately).

The tier model is pure TypeScript in `site/docs/.vitepress/access/`:

| File | Content |
|---|---|
| `tiers.ts` | `resolveAccess`, `tierOfRead`, `validateAccessConfig`, `parseAccessJson`, `assertBuildGuards`, `lookupTier`, `ownerOfPath`, `pathPrefixesOf`, `chunkPatternsOf`, `lectureAccessOf`, `AccessConfigError`, `AccessGuardError` |
| `siteData.ts` | `splitSiteData`, `mergeSiteData`, `insertPlaced`, `isTierSlice`, `splitGraph`, `mergeGraph`, `groupIdOfGraphNode`; types `TierSlice`, `SiteLike`, `Placed` |
| `search.ts` | `splitPageIntoSections` (VitePress 1.6.4), `searchDocumentsOf`, `docIdOf`, `localeOfPath` |
| `build.mts` | Node side: `resolveBuildAccess`, `applyAccess`, `finalizeDist`, `getRestrictedSearchDocuments` |

## 3. Build switches and guards

| Switch | Effect |
|---|---|
| `npm run build -- --audience public` | sets `LECTURE_AUDIENCE=public`: only public groups are built (their folders are `srcExclude`d, their data is left out); no restricted tier exists. Fails if `default` is `authenticated`. |
| `LECTURE_BUILD_GROUPS=G06,G09` | build only these groups (tests, quick previews). Unknown ids fail and list the valid ones. |
| `LECTURE_ACCESS_JSON='{"default":"public",...}'` | replaces the `access` block for this build (tests); validated like the config. |
| `npm run build -- --outDir <dir>` | any other argument goes to `vitepress build docs` unchanged. |

Guards (English messages, both stop the build):

1. A restricted tier exists, or `default` is `authenticated`, and `enforcement` is not `gateway`. The message offers the two
   ways out: `enforcement: 'gateway'`, or `--audience public`.
2. `--audience public` with `default: 'authenticated'`: nothing public to build.

Guard 1 is evaluated after the audience filter, so `--audience public` on a guarded config builds.

Groups that are not built (audience, `LECTURE_BUILD_GROUPS`) are removed everywhere: pages (`srcExclude`, including
`docs/en/[group]` generated pages), navigation, sidebar, graph nodes, charts and exports in `dist`.

## 4. Output

`I` is the inline tier, `T` a restricted tier.

| Output | Inline (every page) | Restricted `T` |
|---|---|---|
| nav groups menu, `sidebar`, `groups`, `totals`, each locale's `sidebar` and `i18nPages` | groups of `I` only; `totals` counts only them; the sidebar keeps each restricted group's key with an empty placeholder group (`sidebarPlaceholder()`: no text, no items) | `/_access/T/site-data.json` (a `TierSlice`, see `siteData.ts`) |
| `themeConfig.lectureAccess` | `{ inlineTier, tiers: [T ids] }`, ids only | - |
| built-in search index | `_render` returns `''` for restricted pages (and for `frontmatter.search === false`) | `/_access/T/search/<locale>.json`: `[{ id, title, titles, text }]`, one file per locale (`root`, `en`, ...), sections cut exactly like VitePress |
| `notion_knowledge_graph.json` | nodes of `I` and nodes without a group | `/_access/T/graph.json` |
| `curriculum.data.mts` & `canvas.data.mts` | inline groups & intra-inline edges only (`map` / `canvas` strips restricted IDs) | `/_access/T/curriculum.<locale>.json`, `/_access/T/canvas.json` |
| progress seed (`seed.data.mts`) | built from the inline nodes only | arrives with `graph.json` (client side) |
| `charts/<lecture>.json` | stays | `/_access/T/charts/` |
| `exports/<groupDir>/...` and its `manifest.json` entries | stays | `/_access/T/exports/` |
| `lecture_catalog.json` | stays, inline lectures only (unchanged when nothing is restricted) | `/_access/T/lecture_catalog.json` |
| page data | `frontmatter.accessTier = <tier id>` on every group page | restricted group index pages also carry `frontmatter.groupMeta` |

`accessTier` and `groupMeta` are only written when a restricted tier exists, so a build without one differs from a build without the feature only in `themeConfig.lectureAccess`.

Files are moved in `buildEnd` (`docs/public` is already copied into `dist`); `dev` serves the source files unchanged.
A chart file used by several groups stays if an inline group uses it, otherwise it goes to the lowest restricted tier.

Known leftovers a path-prefix gateway cannot cover (the check script reports them as WARN):

- images that restricted pages import (bundled into `/assets/<name>.<hash>.png`);
- graph node ids of other tiers in `prerequisites` / `subsequents` (ids only, no titles);
- page ids (`g05_l19.md`) of restricted pages in `hashmap.json` and the `__VP_HASH_MAP__` script of every page;
- `scripts/remote_server.py` reads `lecture_catalog.json` (Dify tool search and summary, Notion page-id lookup) and
  `notion_knowledge_graph.json` from the web root (`DEPLOY_WEBROOT`). The site never reads the catalog, so it is split
  like the graph. With restricted tiers that service only sees the inline lectures unless the per-tier copies are
  deployed where it reads them (P6 folds Notion sync into the backend).

## 5. Gateway manifest

Every build writes `site/.lecture-build/access-manifest.json` (git-ignored, **not** in `dist`; it contains titles).

```jsonc
{
  "version": 1, "builtAt": "...", "outDir": "<where this build was written>",
  "audience": "all" | "public", "enforcement": "gateway", "defaultTier": "...", "inlineTier": "...",
  "localeKeys": ["en"], "removedGroupIds": ["G01", ...],
  "tiers": [{
    "id": "grp-675ca4d1",
    "rule": { "kind": "groups", "groups": ["staff"] },        // or { "kind": "authenticated" }
    "groupIds": ["G12"], "dirs": ["g12"],
    "pathPrefixes": ["/g12/", "/en/g12/", "/_access/grp-675ca4d1/"],
    "pageChunkPatterns": ["^/assets/g12_", "^/assets/en_g12_"],   // bundled page chunks of the group
    "pages": ["g12/L01.md", "en/g12/index.md", ...],
    "names": ["...titles of every language and group titles..."],
    "ambiguousNames": ["titles that inline text shares, or shorter than 4 characters"],
    "nodeIds": ["graph node ids of the tier"]
  }]
}
```

`auth:export` (P6.5) turns `rule` + `pathPrefixes` + `pageChunkPatterns` into gateway rules.

## 6. Check script

```
npm run check:access:dist [-- --dist <dir>] [-- --manifest <file>] [-- --ignore-out-dir]
```

Run it after `npm run build`. With no restricted tier it prints `no restricted tiers` and passes. With restricted tiers, per tier `T`, it FAILS when:

1. `/_access/T/site-data.json`, `graph.json` or a `search/<locale>.json` is missing or not JSON;
2. a lecture or group title of `T` (all languages) occurs in a text file that is not under a protected path of `T` (group
   folders, `/_access/T/`, page chunks matching `pageChunkPatterns`). The report lists file, tier and title. This includes the
   inline search index, the inline site data and the files of other tiers;
3. a page of `T` has no bundled page chunk, or the chunk does not match a pattern of `T`.
4. the AI tool data of the tier is missing, is not JSON or names another tier (section 10), or a `tools/*.json` file of a tier whose
   readers may not read `T` contains a concept slug, lecture id, lecture route, concept summary/text or lecture section text of `T`
   (the first 32 characters of every text are searched). The report lists file, tier and kind.

The gate refuses a dist that is not the one the manifest was written for (`outDir`), because a stale manifest could let a
leak pass; `--ignore-out-dir` is for a copied dist. Exit codes: 0 pass, 1 a check failed, 2 gate broken.

Tests: `tests/unit/access-*.test.ts` (tier model, config validation, site-data split/merge as inverse, search splitter against
the installed VitePress source, the check script including the negative case).

## 7. Tests and ports

`E2E_PROD_PORT` / `E2E_DEV_PORT` move the Playwright servers off 4174 / 5174, so two checkouts can run e2e at once:

```
E2E_PROD_PORT=4274 E2E_DEV_PORT=5274 npx playwright test --project prod
```

## 8. Client side (WP-A2)

The front end asks, the gateway decides. Code: `site/docs/.vitepress/theme/access/` (client) and `access/vitePlugins.mts` (Vite).

| File | Content |
|---|---|
| `theme/access/resolve.ts` | `resolveAccess` (pure, `fetch` and `withBase` passed in): per tier `GET /_access/<tier>/site-data.json` with `redirect: 'manual'`, `credentials: 'same-origin'`, `cache: 'no-store'`; readable only on 200 + a valid `TierSlice` of that tier (`isTierSlice`). No restricted tier configured: no request. `loadMergedGraph`, `loadTierGraphs` |
| `theme/access/store.ts` | page-lifetime state: `configureAccess` (from `enhanceApp`), `getAccess`, `startAccess` (from the theme `onMounted`: merges the slices into `siteData.value` with `mergeSiteData`, hands the tiers' graph nodes to `progressStore.extendSeed(buildSeed(...))`, resolves again when `subscribeSession` reports another signed-in user), `loadGraph` (the one graph loader) |
| `theme/access/useAccess.ts` | composable: `ready`, `readable` (tier ids), `version`, `loadGraph` |
| `theme/access/paths.ts` | `tierAssetPrefix`, `setPageTier` / `getPageTier`: charts and exports of a page with `frontmatter.accessTier = T` come from `/_access/T/charts/` and `/_access/T/exports/` in a production build when `T` is in `lectureAccess.tiers`; dev and every other page use the plain paths |
| `theme/access/searchIndex.ts`, `searchRuntime.ts` | built-in index (JSON string) + `addAll` of the readable tiers' `search/<locale>.json`, loaded with VitePress' own MiniSearch options (`fields`, `storeFields`, `search.options.miniSearch.options`); untouched and request-free without a readable tier |
| `access/vitePlugins.mts` | `accessSearchPlugin` (`enforce: 'pre'`, resolves only the exact id `@localSearchIndex`; per-locale ids stay with VitePress; it still calls VitePress' own `load` for the id, because that call is what indexes the pages in a production build), `accessDevPlugin` (dev only: serves `/_access/<tier>/...` from the source data), added to `vite.plugins` by `applyAccess` only when a restricted tier exists |

Rules worth knowing:

- Merging happens only after mount, never before hydration, so server and first client render agree. The sidebar items of a restricted lecture page appear when the slice has arrived. Because the inline sidebar keeps an empty placeholder under the group's key, the page is laid out with its sidebar column from the server render: the article does not move sideways (it moved 160 px, CLS 0.35, without the placeholder). The e2e asserts that, and that the shift around the sidebar arriving stays below 0.1 (measured 0.04-0.07; about 0.017 of it is a nav-bar shift every page has, see P5). The placeholder reveals only the folder path, which page ids and chunk names already reveal.
- Identity changes behind a gateway reload the page (sign-in and sign-out are redirects), so seeds added by `extendSeed` and maps loaded once per page are never left over from another reader within one page lifetime.
- `GroupIndex.vue` renders from `frontmatter.groupMeta` when present, so restricted group pages are complete in the server HTML.
- Nothing under `theme/access/` imports `validateAccessConfig` / `resolveAccess` of `access/tiers.ts`; the page bundle carries only `mergeSiteData`, `isTierSlice`, `mergeGraph` and `tierBasePath`.
- The progress store gained `extendSeed(seed)`: it seeds only lectures with no server record, no pending write and no seed record, then emits `reset`. It also survives a reload of the build seed.
- Dev: `LECTURE_ACCESS_JSON=... LECTURE_BUILD_GROUPS=... npm run dev` serves `/_access/<tier>/(site-data.json | graph.json | curriculum.<locale>.json | canvas.json | search/<locale>.json | lecture_catalog.json | charts/* | exports/*)` to everybody (there is no gateway in dev).

## 9. Access e2e

```
npm run test:e2e:access          # builds the dist, then runs the `access` Playwright project
npm run build:e2e:access         # only the build (site/.access-e2e/dist, git-ignored; docs/.vitepress/dist is never touched)
E2E_ACCESS_PORT=4575 npx playwright test --project access --repeat-each=3
```

- Build (`scripts/build_access_e2e.mjs`): `LECTURE_BUILD_GROUPS=G06,G09,G12` and an `access` block with G09 `authenticated` and G12 for the gateway group `staff`; then `check:access:dist` runs on it. The build always writes its manifest to `site/.lecture-build/access-manifest.json`; the script restores that file afterwards and keeps the e2e manifest at `site/.access-e2e/access-manifest.json`.
- Server: `tests/e2e/access-server.mjs` (clean URLs, 404 page), started by the project's `webServer` on `E2E_ACCESS_PORT` (default 4374).
- The `access` project exists only with `--project access`; `prod` and `dev` ignore `access.spec.ts`, so the normal run is neither extended nor slowed down.
- Gateway: `context.route` answers 403 for denied paths. Anonymous: `/_access/authenticated/**`, `/_access/grp-*/**`, `/g09/**`, `/g12/**`, `/en/g09/**`, `/en/g12/**` and `/assets/{g09,g12,en_g09,en_g12}_*`. Signed-in: only `grp-*` and G12. Staff: nothing.
- Per scenario: group cards and totals on the home page (inline numbers come from the server HTML), the nav groups menu, the sidebar of each allowed group, search for a distinctive G09 and G12 word, the merged graph (node total and the `graph.json` requests), no page error, no hydration warning. Signed-in and staff also check the server HTML of `/g09/` (via `request.get`), the chart request path and measure the layout shift of the sidebar appearing.
- `tests/e2e/no-access-requests.spec.ts` (prod and dev): this site, no restricted tier, zero requests to `/_access/` on home, group page, lecture page and search.

## 10. Concept tool data (K1)

`docs/.vitepress/concepts/toolFiles.mts` writes the data the AI tools read (contract: `docs-dev/CONCEPTS.md`), in
`buildEnd`, with the same tier split as everything else:

| File | Where |
|---|---|
| `concepts.json`, `lectures.json` of the inline tier | `tools/` |
| `concepts.json`, `lectures.json` of a restricted tier `T` | `/_access/T/tools/` (covered by the tier's `pathPrefixes`, no new gateway rule) |
| `tiers.json` (`{ version: 1, tiers: [{ id, read: 'public' \| 'authenticated' \| 'groups', groups, path }] }`) | `tools/` only; `path` is the folder of the tier's files |

- A concept or lecture is only in the files of its own tier. Inside a file, `related`, `links`, `backlinks` and `lectures` name only content the reader
  of that tier may read (`neighbourhoodOf` in `concepts/graph.ts`, the one place that applies `canReaderTierReadConcept`), so a public file never
  names a restricted slug, route or title. The page panels at the end of a concept page use the same function with the tier of the page.
- `related` and `concept:` links inside a concept page may only name concepts the page's own tier can read (build error otherwise).
- Only the root language is listed; translated copies of lectures are left out and not counted.
- `lectures.json` sections: split at `##` and `###` (flat), `anchor` is the id VitePress gives the heading (taken from VitePress' own markdown-it
  token stream, so duplicates `-1`, `{#custom}` ids and math in headings agree with the page), `text` is the section Markdown without HTML tags,
  comments, `<script>`/`<style>` and Vue components; math, code and tables stay. Text before the first `##` is a lead section named after the H1.
- Size for this site (373 lectures + 31 others, 404 files, 11 360 sections): `concepts.json` 63 KiB, `lectures.json` 19 MB (7.6 MB gzip), `tiers.json` 0.1 KiB.
- Dev: the dev server serves the same URLs. Checks of the concept pages (`related`, duplicate names, `concept:` links, unlinked mentions) run in
  `npm run check:figures`; the errors also stop `npm run build`.
