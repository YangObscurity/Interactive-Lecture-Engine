# Group-Managed Figures (`WP-F8`) — Author & Agent Recipe

Figures from papers or diagrams are owned per course group under `<figuresDir>/<group>/` (resolved via `site/docs/.vitepress/content/paths.mts`, never hardcoded).

**Short recipe: extract -> register -> cite -> check**

## 1. Extract & Register

Run [`scripts/figures/import_figure.py`](../scripts/figures/import_figure.py) on a host with `poppler` (`pdftocairo`, `pdftoppm`, `pdfinfo`, `pdfimages`), `gs`, and ImageMagick 7 (`magick`). Never bundle raw paper captions or black box borders; crop cleanly around the diagram itself.

### Vector figure / flowchart from PDF -> cropped `.svg`

```bash
python3 scripts/figures/import_figure.py \
  --source path/to/paper.pdf --page 6 \
  --crop 0.08,0.10,0.92,0.52 \
  --group lr --id cusum-detector-flow --out-rel L15/cusum-detector-flow.svg \
  --caption-zh "Gamma–Weibull CUSUM 两阶段漂移检测与适配闭环流程" \
  --caption-en "Two-stage Gamma–Weibull CUSUM drift detection and adaptation pipeline" \
  --paper "Agu et al. (JKSU-CIS 2026)" --source-num "Fig. 1" --source-page 6
```

### Raster figure or cropped chart image -> 2x `.webp`

```bash
python3 scripts/figures/import_figure.py \
  --source path/to/plot.png \
  --crop 0.04,0.03,0.96,0.90 --trim \
  --group lr --id pareto-fronts --out-rel L04/pareto-fronts.webp \
  --caption-zh "端侧推理与云卸载帕累托前沿" \
  --caption-en "Pareto fronts for on-device inference and cloud offloading" \
  --paper "Modran et al. (IEEE CSCN 2025)" --source-num "Fig. 5" --source-page 5
```

Provenance is the source citation only: paper, figure or table number, page, and DOI or URL when known. The engine keeps no licence or copyright fields (owner decision 2026-11-22). Example and demo content holds only diagrams drawn for the engine, never paper figures; the content and privacy guards keep owner material out of the open-source repo.

Rules enforced by the script and build:
- Outputs SVG for vector PDFs/SVGs and 2x WebP for raster figures/images.
- Updates `<figuresDir>/<group>/figures.json` with `width`, `height`, and `sha256` (first 12 hex; for `.svg` the checksum is taken over the file with CRLF folded to LF, so a Windows checkout still matches).
- Refuses to overwrite a different `file` with an already-registered `id`.
- For an original diagram pass `--paper original`.
- Optional `--keep-original` saves the raw source for viewer "Open original" without ever loading it on page load.

## 2. Cite in a Lecture

Mount a figure or table (wiki thumbnail right float by default, or `size="medium|full"`, `float="right|left|none"`):

```markdown
<LectureFigure id="pareto-fronts" />
<LectureFigure id="architecture" size="medium" float="none" />
<LectureFigure :ids="['energy-latency', 'pareto-fronts']" size="full" float="none" />
```

Cross-reference from prose (`fig:` for `kind: "figure"`, `tab:` for `kind: "table"`):

```markdown
如 [](fig:pareto-fronts) 所示；自定义链接文字写成 [帕累托前沿分析](fig:pareto-fronts) 或 [](tab:bench-summary)。
```

- Numbers are assigned sequentially per lecture in order of appearance, separately for figures (`图 1`) and tables (`表 1`).
- Unknown IDs or cross-tier restricted citations fail the VitePress build.

## 3. Check

```bash
cd site && npm run check:figures
```

Validates every `figures.json` against the Ajv schema, checks safe relative paths and `sha256` digests, verifies every `<LectureFigure>` and `[](fig:id)` / `[](tab:id)` citation resolves within allowed access tiers, and warns on uncited figures.
