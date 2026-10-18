# Interactive Lecture Rendering Engine

> 🌐 **Live Demo / 在线演示**: [https://interactive-lecture-engine.vercel.app/](https://interactive-lecture-engine.vercel.app/)  
> **Language / 语言**: English ｜ [中文](./README.md)

> A production-ready open-source rendering engine designed to transform **modern engineering and technical lecture notes** into **high-quality interactive web courses and publication-grade export documents**: native interactive diagrams (ECharts, Mermaid, WaveDrom), build-time KaTeX mathematical typesetting, SimpleMindMap closed geometric projection mind maps, oscilloscope and hardware timing simulations, collapsible quiz drawers, publication-grade export suite (A4 smart page-break avoidance / ultra-HD canvas slice images), immersive reading mode, raw-link-free `.cite` citation chips, and a pluggable AI study sidecar — fully componentised, zero-hardcoding single source of truth, and physical decoupling between content and engine.

<p>
  <a href="https://interactive-lecture-engine.vercel.app/"><img alt="Demo" src="https://img.shields.io/badge/Demo-Vercel-black?logo=vercel&style=flat-square"></a>
  <img alt="VitePress" src="https://img.shields.io/badge/VitePress-1.6.4-3451b2?style=flat-square">
  <img alt="Vue" src="https://img.shields.io/badge/Vue-3.5-42b883?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square">
  <img alt="KaTeX" src="https://img.shields.io/badge/KaTeX-0.16.47-00b894?style=flat-square">
  <img alt="ECharts" src="https://img.shields.io/badge/ECharts-5.6.0-e74c3c?style=flat-square">
  <img alt="Mermaid" src="https://img.shields.io/badge/Mermaid-11.4.18-ff6b6b?style=flat-square">
  <img alt="WaveDrom" src="https://img.shields.io/badge/WaveDrom-3.1.0-6c5ce7?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square">
</p>

---

## 📖 Overview & Architecture

**Interactive Lecture Engine** is a production-ready, interactive static courseware and documentation rendering engine tailored for rigorous technical topics (embedded systems, computer architecture, systems programming, networking, and distributed systems). Built on top of VitePress, it integrates rich interactive visual simulations and academic-grade typography.

The engine enforces a **physical decoupling between content and rendering engine**: the core engine focuses exclusively on rendering pipelines, simulation runtimes, curriculum topological mind maps, and static site compilation, while lecture notes are maintained separately as standard Markdown and sidecar JSON files.

A complete **demonstration curriculum suite** across 6 core technical domains (`site/docs/examples/`) is included out of the box, showcasing interactive charts, KaTeX mathematical typesetting, oscilloscope simulation, self-test analysis drawers, immersive reading mode, and publication-ready PDF exports.

```text
Interactive-Lecture-Engine/
├── site/                          # Rendering engine core (VitePress powered)
│   ├── docs/
│   │   ├── .vitepress/
│   │   │   ├── config.mts         # Site configuration hub (nav/sidebar/search derivation)
│   │   │   ├── site.config.mts    # Single source of truth for frontend knobs (API, keys, fonts)
│   │   │   ├── math.mts           # Build-time KaTeX math plugin
│   │   │   └── theme/             # Theme components: chart runtime / reading mode / export / AI
│   │   ├── examples/              # Minimal bundled example content source (spec baseline)
│   │   └── public/                # Static assets and showcase media
│   └── package.json               # Frontend dependencies
├── scripts/                       # Industrial toolchain (quality gates / safe build / mounting / audit)
├── content-sources/               # External courseware mount source (git-ignored to prevent leakage)
├── docs-shared/                   # Shared specifications for prose typography and sidecar JSON charts
├── content/                       # Authoring guides, formula specifications, and content integration
├── engine/                        # Core architectural design and runtime technical documentation
└── ops/                           # Operations, build concurrency locking, and audit reports
```

---

## 🌟 Visual Tour & Showcase

> All showcase screenshots below were captured from a live instance of the engine (2x ultra-HD Retina captures), demonstrating the full lifecycle from curriculum topology, interactive engineering charts, to hardware simulation and publication-grade export.

### 1. Site Overview & Knowledge Topology

| Hero Hub & Feature Matrix | SimpleMindMap Closed Geometric Projection |
|---|---|
| ![Site Overview](site/docs/public/showcase/home-overview.png) | ![SimpleMindMap Closed Geometric Projection](site/docs/public/showcase/knowledge-map.png) |
| **Hero Hub**: Real-time course metrics, one-click reading resumption, and knowledge progression entrance | **Closed Geometric Projection**: Auto-calculates bounding boxes and non-overlapping layout, zero navbar occlusion, zoom and fullscreen focus |

### 2. Native Interactive Engineering Diagrams (Pure SVG Contract · Zero Emojis)

Chart toolbars adhere strictly to a **100% pure SVG vector contract**, eliminating cross-platform emoji font discrepancies and blurry glyphs. Inline views enforce a "read-only to prevent accidental touch" rule, while one-click fullscreen modal enables pan, zoom, grid snapping, and source-code folding.

| ECharts · Dynamic Data Curves | Mermaid · Industrial Architectures & Flowcharts | WaveDrom · Hardware Timing & Registers |
|---|---|---|
| ![ECharts Curves](site/docs/public/showcase/chart-echarts.png) | ![Mermaid Flowchart](site/docs/public/showcase/chart-mermaid.png) | ![WaveDrom Timing](site/docs/public/showcase/chart-wavedrom.png) |
| Dual-axis alignment, breathing padding, crosshair hover inspection, and legend toggle | Pure SVG vector toolbar, collapsible source drawer, lossless vector zoom | Clock rising-edge alignment, bus transition simulation, and register bitfields |

### 3. Engineering Interaction & Immersive Reading

| Immersive Reading Mode (75vw Golden Text Column) | Elegant `.cite` Citation Chips |
|---|---|
| ![Immersive Reading Mode](site/docs/public/showcase/reading-mode.png) | ![Citation Chips](site/docs/public/showcase/cite-chips.png) |
| One-click sidebar collapse, widened 75vw text column, relaxed leading, and local progress memory | **Raw hyperlinks banned site-wide**; replaced by subtle chips that open safely in a new tab |

| Virtual Dual-Channel Oscilloscope (`.scope-viewer`) | Interactive Quiz Drawer (`::: details`) |
|---|---|
| ![Oscilloscope Waveform Comparison](site/docs/public/showcase/wave-compare.png) | ![Interactive Quiz Drawer](site/docs/public/showcase/quiz-drawer.png) |
| Inrush vs damped current waveform comparison, timebase graticule, and peak-to-peak metrics | Interactive quiz drawer; click to expand complete engineering derivation and pitfall analysis |

### 4. Curriculum Progression & Publication Export Suite

| Course Group Knowledge Topology | Publication-Grade Export HUD (A4 PDF / Long Canvas) |
|---|---|
| ![Course Knowledge Topology](site/docs/public/showcase/group-knowledge.png) | ![Publication Export HUD](site/docs/public/showcase/lecture-export.png) |
| Automated topology generation based on lecture sequence, phase stages, and dependencies | One-click export for A4 break-avoided PDF, continuous tiled PDF, and 2x retina PNG long image |

---

## I. Quick Start

> [!TIP]
> **Instant Live Preview**: The project is live-deployed on Vercel. Test all interactive features without local setup: [https://interactive-lecture-engine.vercel.app/](https://interactive-lecture-engine.vercel.app/).

### 1. Prerequisites
- **Node.js**: `≥ 18.0.0` (Node.js 20 LTS recommended)
- **Python**: `≥ 3.10` (used for quality gates and content pipeline; standard library only, no pip installs required)

### 2. Clone and Install Dependencies
```bash
git clone https://github.com/YangObscurity/Interactive-Lecture-Engine.git
cd Interactive-Lecture-Engine/site
npm ci
```

### 3. Start Local Dev Server (Millisecond-Level HMR)
```bash
npm run dev
# Dev server starts at http://localhost:5173
```
Open your browser to navigate and interact with bundled example courseware at `examples/g01/L01.html`.

### 4. Production Build with Safe Concurrency Lock
```bash
# Recommended safe serial build entry (acquires cross-process mutex lock to prevent build race conditions)
python ../scripts/safe_build.py --purpose "Production build verification"
```
Static artifacts will be rendered into `site/docs/.vitepress/dist`.

---

## II. Core Features & Technical Highlights

### 1. Pure SVG Vector Contract (Zero-Emoji Contract)
- **Eliminate Glyph Inconsistencies**: Web documentation frequently uses Emoji characters for UI actions, causing platform-dependent color shifts, blurry bitmaps, and font-fallback errors (tofu boxes);
- **100% Vectorized Toolbars**: All chart toolbars (Fullscreen, Source Code, Reset Zoom, Copy) are rendered via pure inline SVGs defined centrally in `site.config.mts`, ensuring crisp rendering across dark/light themes and high-DPI displays.

### 2. SimpleMindMap Closed Geometric Projection
- **Adaptive Bounding-Box Layout**: Replaces erratic third-party layout engines with a deterministic geometric projection pipeline;
- **Zero Navbar Occlusion**: Automatically parses course groups, lecture indices, learning phases, and dependency chains, performing dynamic recentering to guarantee zero overlap with sticky navigation elements.

### 3. Publication-Grade Export Suite
- **A4 Smart Page-Break Avoidance**: Injects headless Chrome print styles (`break-inside: avoid`), preventing paragraphs, code blocks, math formulas, and interactive diagrams from splitting across page breaks;
- **Canvas Ultra-HD Vector Slicing**: Integrates `html-to-image` to resample DOM trees at 2x device pixel ratio, generating ultra-HD PNG panoramic lecture strips;
- **Seamless HUD Export Menu**: Resident top-right micro-interaction HUD that detects headless Chrome / Puppeteer environments and provides real-time progress feedback.

### 4. Build-Time KaTeX Mathematical Typesetting
- **Delimiter Safety Guard**: Strictly matches `\(…\)` (inline) and `$$…$$` / `\[…\]` (display blocks), deliberately **ignoring bare `$` signs** (preventing accidental math parsing from `$1000`, NMEA `$GNRMC`, or ARP `ar$` identifiers);
- **Click-to-Copy LaTeX Source**: Math nodes compile into `<span class="math-node" data-tex="...">`, enabling readers to copy raw LaTeX source with a single click;
- **Rigorous Height & Leading Contract**: Standardizes on `\dfrac` for definitions, `\frac` for polynomial coefficients, and standard SI unit slashes, ensuring inline math perfectly matches prose line height.

### 5. Native Interactive Engineering Diagrams & Sidecar Contract
The lecture markdown requires only a clean placeholder:
```html
<figure class="chart" data-lecture="EX-L01" data-id="c1" data-type="echarts"></figure>
```
accompanied by a sidecar JSON definition:
```json
{
  "c1": {
    "type": "echarts",
    "title": "LED Forward Volt-Ampere Characteristics",
    "code": "{ \"xAxis\": { \"name\": \"Forward Voltage (V)\" }, \"yAxis\": { \"name\": \"Forward Current (mA)\" }, \"series\": [...] }"
  }
}
```
- **Supported Engines**: `echarts` (data series and curves), `mermaid` (architectures and sequence diagrams), `wavedrom` (digital hardware timing and registers);
- **Strict 1:1 Invariant**: Body `data-id` attributes and JSON keys must match **strictly 1:1**. Any discrepancy is intercepted immediately by `scripts/check_figs2.py`.

### 6. Virtual Oscilloscope & Self-Test Quiz Drawers
- **`.scope-viewer` Digital DSO**: Emulates an authentic oscilloscope graticule, trigger status badges, and dynamic peak-to-peak and frequency metric readouts for embedded tutorials;
- **Interactive Quiz Drawers**: Implemented via native VitePress `::: details` blocks, decoupling question prompts from analytical deductions to encourage active recall.

### 7. Immersive Reading & Raw-Link-Free Citation Chips
- **Immersive Mode**: Collapses sidebars and expands text width to a 75vw reading column, relaxes line height, and persists state in LocalStorage;
- **Zero Raw Hyperlinks**: Traditional markdown hyperlinks with default blue underlines break reading immersion. The engine enforces pale `.cite` chips site-wide:
  ```html
  <span class="cite" data-cite="https://..." title="https://...">Reference Title</span>
  ```
  Hovering reveals the destination URL, and clicking opens the link safely in a new browser tab.

### 8. Single Source of Truth (`site.config.mts`)
All site metadata, API endpoints, LocalStorage keys, font stacks, and diagram UI strings are centralized in `site/docs/.vitepress/site.config.mts`, eliminating scattered magic strings.

---

## III. Content-Source Separation (Decoupling the Engine from Lectures)

To guarantee **zero private courseware leakage in open-source releases and zero-copy hot reloading during local authoring**, the engine establishes a clean physical boundary:

```text
content-sources/<your-course-name>/
├── groups.mts                      # Course group metadata (ID, title, accent, description)
└── docs/
    ├── <group>/L01.md              # Lecture body (strictly matching ^L\d+\.md$)
    ├── <group>/index.md            # Group landing page
    └── public/charts/<GROUP>-L01.json # Independent sidecar chart JSON file
```

Managed via the central pipeline script `scripts/mount_content.py`:

```bash
# 1. Discover all available content sources
python scripts/mount_content.py --list

# 2. Mount a course package (NTFS junction or POSIX symlink; add --apply to execute)
python scripts/mount_content.py --mount my-course --apply

# 3. Verify figure anchors and sidecar JSON 1:1 consistency
python scripts/mount_content.py --verify

# 4. Unmount precisely (reverts to pure engine state without touching engine files)
python scripts/mount_content.py --unmount --apply

# 5. Clean non-whitelisted files (guarantees 100% open-source cleanliness)
python scripts/mount_content.py --clean
```

- **Safety Perimeter**: Core directories (`.vitepress/`, `examples/`, site icons) are protected by strict whitelisting; external sources cannot overwrite engine assets;
- **Local Authoring**: Symlinking enables instant HMR hot-refresh in VitePress upon saving changes;
- **Open-Source Publishing**: Running `--unmount` or `--clean` instantly restores a clean, credential-free, courseware-free engine skeleton.

### Dynamic Example Fallback & Exclusive Isolation

To achieve an optimal balance between an out-of-the-box demo experience and complete privacy for personal lectures, the engine features an **automatic dual-state isolation mechanism**:

1. **Unmounted State (Pure Engine / Fresh Clone)**:
   - The engine automatically activates the demo curricula and interactive charts under `site/docs/examples/`;
   - Navigation, curriculum mindmap, and sidebar are fully populated as reference implementations.
2. **Mounted State (Personal Lecture Exclusive)**:
   - When personal lectures are detected (via `mount_content.py`, `site/docs/.vitepress/groups.mts`, or course directories), the engine **automatically unloads and physically hides the example curriculum** (`examples/` is strictly excluded);
   - VitePress configuration injects `srcExclude: ['examples/**']`, ensuring example Markdown files are **never compiled, never emitted as HTML pages, and never indexed in local search**;
   - The navigation dropdown, sidebar TOC, mindmap graph, and home metrics **100% exclusively render the user's personal curriculum**, guaranteeing zero leakage and zero cross-contamination.
3. **Seamless Reversion**:
   - Running `python scripts/mount_content.py --unmount` instantly reactivates the generic demo examples for showcase mode.

---

## IV. Configuration & Zero-Credentials

Following Twelve-Factor App principles and open-source privacy standards, **no real secret, token, or private environment credential exists anywhere in this repository**:

```bash
# Copy local environment config from example template (.env is excluded by .gitignore)
cp .env.example .env
```

| Environment Variable | Description & Purpose | Default Safe Fallback |
| :--- | :--- | :--- |
| `NOTION_TOKEN` | Notion read-only integration token (optional, for content sync) | Empty |
| `DEPLOY_HOST` | Production target IP or resolved domain | `127.0.0.1` |
| `DEPLOY_PORT` | SSH / SCP remote port | `22` |
| `DEPLOY_USER` | Deployment authentication user | `deploy` |
| `DEPLOY_SSH_KEY` | Private SSH key path (cross-platform) | `~/.ssh/id_ed25519` |
| `DEPLOY_WEBROOT` | Remote Nginx webroot directory | `/var/www/lecture` |
| `DEPLOY_SITE_DOMAIN` | Production domain for post-deployment health checks | `example.com` |

Precedence order: **CLI arguments > Environment variables > `.env` file > Built-in safe fallbacks**.
During logging and debugging, `describe()` automatically masks sensitive fields to prevent secondary disclosure.

---

## V. The 12 Quality Gates Matrix

This project turns quality assurance and regression prevention into **reproducible, automated assertions**. Run the unified audit suite before any merge or release:

```bash
# Run all quality gates in one command
python scripts/audit_all.py

# Production final verification (full site build + sequential gate audit)
python scripts/audit_all.py --build
```

| ID | Gate Identifier | Script / Diagnostic | Core Assertion & Metric | Expected Result |
| :---: | :--- | :--- | :--- | :---: |
| **01** | `build` | `scripts/safe_build.py` | Full-site SSR static production build with cross-process mutex lock | `✓ rendering pages` |
| **02** | `pages` | `scripts/audit_all.py` | Total `.html` artifact count conservation with adaptive baseline | `Page Count ≥ Baseline` |
| **03** | `links` | `scripts/check_body_links.py` | HTML post-build scan asserting zero raw external hyperlinks | `<a> = 0` and `.cite > 0` |
| **04** | `angle` | `scripts/test_angle.py` | Vue compiler angle-bracket (`<`) safety escaping unit tests | **15/15 PASS** |
| **05** | `figs` | `scripts/check_figs2.py` | Markdown `<figure>` anchors ↔ sidecar JSON strictly 1:1 | **Mismatches = 0** |
| **06** | `format` | `scripts/format_audit.py` | Source LaTeX formulas (M1–M5) and typography rules (F1–F4) | **Fatal Violations = 0** |
| **07** | `bare_urls` | `scripts/audit_bare_urls.py` | Clean raw URLs and schemeless domains in Markdown prose | **Bare URL Residuals = 0** |
| **08** | `deps` | `scripts/check_deps.py` | Source `import` statements match `package.json` dependencies | **Phantom/Zombie Deps = 0** |
| **09** | `encoding` | `scripts/check_encoding.py` | Full repository UTF-8 encoding integrity (no U+FFFD, BOM, or CRLF mix) | **Encoding Defects = 0** |
| **10** | `secrets` | `scripts/scan_secrets.py` | Deep scan for leaked private keys, server IPs, and PII | **High-Risk Leaks = 0** |
| **11** | `example` | `scripts/check_example.py` | Minimal bundled example structure, metadata, and chart contract | **Example Contract Holds** |
| **12** | `docs` | `scripts/doc_audit.py` | Static check for relative links and documentation structural integrity | **Dead Links = 0** |

---

## VI. Where to Start

Navigate to relevant documentation based on your role:

| I want to… | Guide & Reference |
| :--- | :--- |
| **Understand how the engine runs** | [`engine/README.md`](./engine/README.md) |
| **Customize chart toolbars, zoom, and styles** | [`engine/charts.md`](./engine/charts.md) |
| **Add a new lecture or course group** | [`content/add-lecture.md`](./content/add-lecture.md) |
| **Review lecture prose and chart JSON contracts** | [`content/README.md`](./content/README.md) ｜ [`docs-shared/CHARTS_SPEC.md`](./docs-shared/CHARTS_SPEC.md) |
| **Plug in custom courseware** | [`content/CONTENT_SOURCE.md`](./content/CONTENT_SOURCE.md) ｜ [`content-sources/README.md`](./content-sources/README.md) |
| **Ops, production build, and visual inspection** | [`ops/README.md`](./ops/README.md) |
| **Contribute to the open-source project** | [`CONTRIBUTING.en.md`](./CONTRIBUTING.en.md) ｜ [中文版](./CONTRIBUTING.md) |
| **AI agent collaboration guidelines** | [`AGENTS.md`](./AGENTS.md) ｜ [`GEMINI.md`](./GEMINI.md) |

---

## VII. Design Principles

1. **Componentised Separation**: Content modifications never touch the theme; theme modifications never touch lecture prose;
2. **Never Hand-Write Numbers**: Lecture counts, diagram counts, and word counts are computed dynamically at build time;
3. **Single Source of Truth**: Any configuration property or data model exists in exactly one place;
4. **Configuration Externalised**: All environment parameters support injection, leaving zero secrets in code;
5. **Gates First**: Any assertion of "zero regression" must be backed by reproducible automated tests and clean exit codes.

---

## VIII. License

This project is licensed under the [MIT License](./LICENSE). You are free to use, modify, distribute, or adapt it for commercial course platforms.

> **Open-Source Scope & Ownership**:
> This open-source repository distributes the core lecture rendering engine framework and developer toolchains.
> Custom courseware attached or mounted by users remains the intellectual property of their respective creators. Directories designated for mounting content are globally excluded by `.gitignore` to maintain isolation between user materials and the public engine core.
