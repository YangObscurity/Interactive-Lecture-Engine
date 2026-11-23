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
