# Build pipeline & memory guide (BUILD.md)

Entry point: [`site/scripts/build.mjs`](../site/scripts/build.mjs) (`npm run build` in `site/`).

## 1. Heap limit & environment variables

By default (`DEFAULT_BUILD_HEAP_MB = 8192`), `scripts/build.mjs` launches VitePress with `--max-old-space-size=8192` so the full 17-group, 448-page bilingual build has enough headroom to finish without V8 hitting the default ~4 GB old-space ceiling.

You can override or inspect this behaviour with:

| Variable | Effect |
| --- | --- |
| `LECTURE_BUILD_HEAP_MB` | Integer `>= 256` sets `--max-old-space-size=<N>`; `0`, `off`, or `auto` omits the flag and uses Node's default heap sizing. Ignored if `NODE_OPTIONS` already contains `--max-old-space-size=...`. |
| `NODE_OPTIONS` | Standard Node flag mechanism; if `--max-old-space-size=...` is set there, `build.mjs` preserves the caller's setting. |
| `LECTURE_PROFILE_MEM=1` | Samples the build child's working set (RSS on Linux, `WorkingSet64` on Windows) every 5 s and prints `[build-mem] FINAL peakWorkingSet=...MB`. |
| `LECTURE_BUILD_GROUPS=G01` | Restricts curriculum and page build to a comma-separated list of groups (fast local iteration). |
| `--audience public` | CLI switch (`npm run build -- --audience public`) setting `LECTURE_AUDIENCE=public` to exclude restricted tiers. |
| `LECTURE_CONTENT_DIR` | Content folder to build (default: `content/` at the repository root when it holds `site.config.ts` or `groups.ts`, else the in-place layout). `prebuild` runs `content:sync`, which copies the lectures, charts and figures of that folder into `site/docs/` (paths from `site/docs/.vitepress/content/paths.mts`). |

Before building content changes, run `npm run check:content` (the lecture contract, links, figures, graph, site texts; `docs/authoring/lecture-contract.md`); it is also part of `npm run check`.

When `os.totalmem()` is smaller than the configured `--max-old-space-size` limit (or `< 6144 MB`), `build.mjs` prints a warning reminding operators not to run full builds on small deploy hosts. If the child process is terminated by a signal (such as `SIGKILL` / `SIGABRT` under OOM), `build.mjs` prints the signal and small-host workarounds.

## 2. Measured memory profile (448 pages, 17 groups)

Measured with `LECTURE_PROFILE_MEM=1` on Linux x64 (`7964 MB` container RAM):

| Phase / elapsed | Working set (before F5, `8192 MB` heap) | Working set (after F5, `5120 MB` heap) | Main allocations |
| --- | --- | --- | --- |
| Startup, curriculum & canvas layout (`+5s..+15s`) | `426 -> 790 MB` | `439 -> 740 MB` | Group scan, knowledge graph merge, child `canvasWorker.mjs` (ELK + libavoid WASM) |
| Client Vite / Rollup bundle (`+20s..+75s`) | `1416 -> 3698 MB` | `1727 -> 3669 MB` | Markdown ASTs, Shiki language grammars (~250 chunks), chart dependencies |
| Server SSR bundle + search index (`+80s..+130s`) | **`5667 MB` peak** (`+140s`) | **`5650 MB` peak** (`+130s`) | SSR module graph + `@localSearchIndexroot` (`~27.7 MB` serialized full-text index) |
| Render about 450 static HTML pages (`+135s..+150s`) | `5048 -> 5148 MB` | `5448 -> 4175 MB` | Per-route SSR `renderToString` + HTML/meta injection |
| Total wall time / theme chunk | `150.12s`, `theme.*.js = 839.5 KB` | `141.10s`, `theme.*.js = 369.3 KB` | Lazy-loading `MarkdownRenderer` (`marked`/`katex`/`DOMPurify`/`shiki`) removed ~470 KB from `theme.*.js` |

### Windows row (a development PC)

Measured on Windows 11, 30 GB RAM, `LECTURE_PROFILE_MEM=1`, default `8192 MB` heap, same site of about 450 pages. The sampler reads `WorkingSet64`, which counts a little more than the Linux RSS.

| Host | Peak working set | Wall time | `theme.*.js` | Canvas layout |
| --- | --- | --- | --- | --- |
| Linux x64, 7964 MB container (rows above) | `5650 - 5667 MB` | `141 - 150s` | `369.3 KB` (before F7/F10 merged) | worker, about `3.5s` |
| Windows 11, 30 GB | **`6023 MB`** (`+121s`, during page rendering) | `125.8s` | `462,658 B` (about `452 KB`, with F7/F10 merged) | `3 ms` (disk cache hit) |

The numbers in the Linux tables above are Linux numbers only; do not read them as Windows numbers.

### Heap-limit boundary measurements (Linux host, 7964 MB container)

- **`LECTURE_BUILD_HEAP_MB=4096`**: Failed at `+125s` during SSR bundling (`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`, last `Mark-Compact 4025.7 (4143.9) -> 4023.8 (4145.9) MB`, peak RSS `4939 MB`). Live old-space objects genuinely exceed `4.0 GB` on the full 448-page build until the search index (WP-F3) is trimmed.
- **`LECTURE_BUILD_HEAP_MB=5120`**: Completed cleanly in `141.10s` (`peakWorkingSet=5650MB`) and constrains V8 heap growth tighter than `8192 MB` on ~8 GB hosts.
- **Partial subset (`LECTURE_BUILD_GROUPS=G01`)**: Completed in `20.84s` with a fraction of the full-site module graph.

## 3. Canvas layout worker caching & robustness

`site/docs/.vitepress/curriculum/canvasNode.mts` hashes both `canvasWorker.mjs` contents and the serialized `CanvasWorkerInput` payload (`SHA-256`) and caches validated `CanvasBundle` JSON under `site/docs/.vitepress/cache/canvas/` (gitignored via `.vitepress/cache/`). On a warm cache, layout drops from `~3.5s` to `1-12 ms`, forwards child `stderr`, and retries once automatically on worker failure.

## 4. Building for small deploy hosts (< 8 GB RAM)

Do **not** run full `npm run build` directly on small VPS / deploy hosts (such as 2-4 GB instances; with `--max-old-space-size=8192`, Node can exhaust host memory and freeze or OOM-kill the box):

1. **Recommended (CI + upload `dist/`)**: Run `npm run build` in GitHub Actions (`.github/workflows/v2-ci.yml`) or on a workstation with `>= 8 GB` free RAM, then sync `site/docs/.vitepress/dist/` to the deploy host.
2. **8 GB shared hosts**: Ensure swap or free RAM `>= 6 GB` (or run under a lock without parallel heavy tasks) and optionally pass `LECTURE_BUILD_HEAP_MB=5120`.
3. **Local partial iteration**: Use `LECTURE_BUILD_GROUPS=G01,G05 npm run build` or `npm run dev` when working on specific groups.
4. **Public-only tier builds**: `npm run build -- --audience public` omits restricted-tier pages and assets.


## 5. Tests run on the demo content

Every test suite runs on the engine's own demo content, `templates/demo-content/` (4 groups in 2 categories, 14 lectures,
an English translation of LOG, charts, a figure pack, 3 concepts, a knowledge graph, a progress seed, `access.e2e.json`).
The owner's lectures (`content/` of a private site) never take part in a test, so the suites give the same result in a
private site repository and in the engine repository, which has no `content/` at all.

| Command (in `site/`) | What it does | Port |
|---|---|---|
| `npx vitest run` (`npm test`) | unit tests; a test that needs a whole site syncs the demo into its own temporary docs folder (`tests/unit/demo-content.ts`: `syncDemoDocs`, `DEMO_ENV`, `DEMO_ACCESS_JSON`); nothing is read from `site/docs` or `content/` | none |
| `npm run build:e2e` | the demo build for Playwright: copies `templates/demo-content` to `site/.e2e-demo/content`, lays `e2e/site.config.ts` over its `site.config.ts` (the backend paths the e2e mocks: progress `rest`, `trusted-header`, companion `proxy`), builds with `LECTURE_CONTENT_DIR` pointing at the copy into `site/.e2e-demo/dist`, then puts `site/docs` back for the site's own content | none |
| `npm run test:e2e:prod` | `build:e2e`, then the `prod` project against `site/.e2e-demo/dist` (served by `tests/e2e/access-server.mjs`) | `E2E_PROD_PORT`, default 4174 |
| `npx playwright test --project dev` | `scripts/dev_e2e.mjs` (the dev web server): a fresh copy of the demo in `site/.e2e-demo/content` with the e2e site config, `content:sync --drafts` of the copy into `site/docs`, then `vitepress dev docs` with `LECTURE_CONTENT_DIR` at the copy; tests that write (Dashboard site texts, concept drafts) write into the copy. Afterwards `tests/e2e/dev-teardown.ts` puts `site/docs` back for the site's own content | `E2E_DEV_PORT`, default 5174 |
| `npm run test:e2e:access` | `build:e2e:access` (demo with the tiers of `access.e2e.json`: MEA and LOG inline, PLN `authenticated`, DAT the gateway group `staff`, into `site/.access-e2e/dist`, then `check:access:dist`), then the `access` project | `E2E_ACCESS_PORT`, default 4374 |

- `site/.e2e-demo/` and `site/.access-e2e/` are git-ignored and are the only places the e2e builds write
  (`assertE2eOutDir`); `docs/.vitepress/dist`, the deployed output, is never touched. The owner's own `npm run build`
  and `npm run dev` are unchanged and show only the owner's content again after an e2e build.
- `templates/demo-content` itself is only read. Its `site.config.ts` works without a backend (the default site of a
  fresh clone); the e2e backend settings live in `templates/demo-content/e2e/site.config.ts` and reach only the copy.
- Without `LECTURE_CONTENT_DIR` and without `<repo>/content`, the engine falls back to the demo content
  (`resolveContent` reports `demo: true`); then the Dashboard's write endpoints, concept drafting and `new:group` /
  `new:lecture` refuse to write and ask for `npm run init`. `LECTURE_DEMO=0` turns the fallback off (in-place mode:
  only lectures under `site/docs` with groups in `site/docs/.vitepress/groups.mts`, the V1 layout `content:migrate`
  reads; without them the build is an empty site and the log says to run `npm run init`). The engine has no example
  pages of its own besides the demo content (`site/docs/examples/` was removed in S6).
- The dev project's copy is a content folder of its own (`LECTURE_CONTENT_DIR` is set), so it is not the read-only
  demo fallback: the Dashboard's writes and concept drafting work there and only ever change the copy
  (`tests/unit/dev-e2e.test.ts`). Pointing `LECTURE_CONTENT_DIR` at `templates/demo-content` itself would make it
  writable too: do not; the e2e scripts always use the copy.
- Putting `site/docs` back after the dev project (`restoreOwnContent`, the same as after `build:e2e`: `content:sync` of
  the site's own content folder, or `content:sync --clean` when it has none):
  - normally `tests/e2e/dev-teardown.ts`, the global teardown Playwright registers only when the dev project is
    selected. It runs before Playwright stops its web servers, stops the dev server itself (on Windows Playwright ends
    web servers with `taskkill /T /F`, which no signal handler of the server script survives) and then restores.
    Ctrl-C of `playwright test` still runs it.
  - `scripts/dev_e2e.mjs` records its run in `site/.e2e-demo/dev-server.json` and restores by itself when vitepress
    exits or it gets Ctrl-C / SIGTERM when run on its own (`node scripts/dev_e2e.mjs --port 5174`).
  - a run killed outright (the process tree ended, no teardown) leaves the demo in `site/docs` and the state file
    behind. The next dev e2e start cleans up first ("leftover of an interrupted run"); `node scripts/dev_e2e.mjs
    --restore` does it by hand; the site's own `npm run dev` / `npm run build` repair `site/docs` anyway with their
    own `content:sync`. The leftover files are git-ignored synced copies, so `git status` stays clean meanwhile.
  - the dev web server never reuses a server already on `E2E_DEV_PORT` (it could be `npm run dev` on the site's own
    lectures): free the port first. Run one `build:e2e` / dev e2e at a time per checkout: both rewrite `site/docs` and
    the copy.
- Two checkouts can run e2e at once with different ports, e.g.
  `E2E_PROD_PORT=5794 E2E_DEV_PORT=6794 E2E_ACCESS_PORT=4894`. Put a spec path before `--project`
  (`npx playwright test tests/e2e/group-page.spec.ts --project prod`): `--project` takes several values.
- New tests take their expectations from the demo content (or from the curriculum built from it), never from a
  site's own lectures; a unit test of a pure function may use synthetic ids such as `g01` / `L02`.
- Screenshot baselines (`site/tests/e2e/__screenshots__/<spec>/prod/`) are pictures of the demo build and ship with
  the engine. They are recorded for the `prod` project only (the visual tests skip on `dev`): `visual-v2.spec.ts`
  (home, `/mea/L04`, `/mea/` in both skins and modes, desktop and mobile) and the `@visual` / `@visual-v2` tests of
  `atlas`, `canvas`, `group-page` and `slots-contract`; `visual-baseline.spec.ts` (the P0 set) only runs with
  `VISUAL_V1=1` and has no committed baselines. Re-record them only after a deliberate change of the look or of the
  demo content, and look at every new picture before committing it:
  `npm run build:e2e`, then `npx playwright test tests/e2e/visual-v2.spec.ts tests/e2e/atlas.spec.ts tests/e2e/canvas.spec.ts tests/e2e/group-page.spec.ts tests/e2e/slots-contract.spec.ts --project prod --grep "@visual" --update-snapshots`.
  A failing visual test without such a change is a regression (the diff is in `site/test-results/`), not a reason to
  update.
- CI (`.github/workflows/v2-ci.yml`, the same file in a private site repository and in the engine repository) runs
  `static` (typecheck, lint, unit tests), `build-and-gates` (`npm run build`, `check:content` and the three dist checks;
  the V1 lecture scripts only where `content/groups.ts` exists) and `e2e` (`build:e2e`, the `prod` project with
  `--grep-invert @visual`, `test:e2e:access`) on pushes and pull requests to `main` and `v2`. The screenshot baselines
  were recorded in Chrome on Windows, so CI on Linux leaves the `@visual` tests out; run them locally as above.
- `npm run screenshots:readme` (`scripts/readme_screenshots.mjs`) writes the README pictures to `<repo>/docs/screenshots/`:
  home atlas (reader light and datasheet dark), the MEA group page, a lecture with a chart and a formula, the
  dependency canvas, a concept hover card, the AI companion with one canned exchange, the Dashboard overview and a
  lecture at 390 x 844. It serves `site/.e2e-demo/dist` (and runs `build:e2e` first when there is none; `--build`
  forces it) on a free local port and answers every `/api/` request itself (no network; the Dashboard is the built
  site's read-only overview with a mocked admin session, so no dev server runs and `site/docs` is left alone apart from
  that `build:e2e`, which puts it back). `--only lecture,mobile` takes some of them, `--out <dir>` writes elsewhere. 1280 px wide viewport,
  deviceScaleFactor 1, first screen only; each file stays well under 400 KB.
