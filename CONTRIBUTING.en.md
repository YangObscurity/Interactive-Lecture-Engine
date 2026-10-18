# Contributing Guide

> **Language / 语言**: English ｜ [中文](./CONTRIBUTING.md)

Thanks for your interest in contributing! This document explains **how to set up the
environment, how to verify your changes, and the commit conventions**.

> What this repository open-sources is the **framework and engine** (the VitePress site
> engine, the chart rendering pipeline, and the content-conversion and quality-gate
> toolchain). The author's own lecture notes are **not included**, which is why the repo
> you see has "engine ready, content empty".

---

## I. What this project is

An **interactive VitePress site engine for technical lecture notes**:

| Directory | Purpose |
| --- | --- |
| `site/` | The site engine itself: VitePress config, theme, chart rendering, KaTeX math rendering |
| `site/docs/.vitepress/` | Site config (`config.mts`), course-group definitions, chart components, styles |
| `scripts/` | Content conversion, quality gates and audit toolchain (Python + Node) |
| `engine/` | Engine design documents |
| `content/` | Content specification and authoring contracts |
| `ops/` | Operations and deployment docs, quality audit reports |

**Core design**: one lecture = one Markdown file + one chart sidecar JSON, with no
crossing of boundaries; changes to the toolbar, styles or navigation land in exactly one
place and apply site-wide.

---

## II. Prerequisites

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | **≥ 20** | Site build and front-end toolchain |
| npm | ships with Node | Dependency installation |
| Python | **≥ 3.10** | Quality-gate scripts (measured on 3.14 on the repo's dev machine) |

The Python scripts **use the standard library only** — no `pip install` needed.

```bash
git clone <repository-url>
cd <repository-dir>
```

---

## III. Install and build

All front-end commands run from the `site/` directory:

```bash
cd site
npm ci          # install strictly from package-lock.json for reproducibility
npm run build   # production build, output in site/docs/.vitepress/dist/
```

Local development preview (with hot reload — editing Markdown refreshes instantly):

```bash
cd site
npm run dev     # VitePress dev server, http://localhost:5173 by default
```

> **Tip**: during development prefer `npm run dev` for second-level hot-reload feedback;
> run a full `npm run build` as the production hard gate only when you are about to commit.

---

## IV. Quality gates before committing (must read)

This repository has its own **quality gates**, all executed from the **repository root**.
Make sure they pass before opening a PR.

### 4.1 Angle-bracket rule unit tests (must pass in any repository state)

```bash
python scripts/test_angle.py
```

Covers how the Vue template compiler treats a bare `<` (escaping in prose, stripping
placeholder angle brackets from inline code, no escaping inside code fences, protecting
whitelisted HTML tags).
**Expected output**: `15/15 通过` (15/15 passed), exit code 0.

These are **pure-function unit tests that read no lecture content**, so they always run
even in an empty engine repository.

### 4.2 figure anchor ↔ chart JSON contract

```bash
python scripts/check_figs2.py
```

Verifies that each lecture's `<figure class="chart">` anchors carry
`data-lecture` / `data-id` / `data-type` values matching
`site/docs/public/charts/<ID>-Lxx.json` in a strict **1:1 bidirectional** correspondence.
**Expected output**: `不一致数: 0` (0 mismatches), exit code 0.

> ⚠️ **This script exits non-zero (1) when it finds no lectures at all**, because it has
> built-in protection against the "vacuous PASS" risk — an empty scan set proves nothing.
> In an engine repository **without lectures**, **skip** this gate (CI already does).

### 4.3 Hard criterion for external links in the body

```bash
python scripts/check_body_links.py
```

Scans every `L*.html` in the build output and asserts that no raw hyperlink to an external
site may appear — the only legal form for an external link is the `.cite` chip
(`<span class="cite" data-cite="…">`), which renders as a `<span>`, not an `<a>`.
**Expected output**: `结论: PASS` (conclusion: PASS).

> ⚠️ This script requires a **prior `npm run build`** (it reads `dist/`).
> Note also that **it prints `FAIL` on an empty scan set while still exiting 0**
> (the conclusion is not reflected in the exit code — a known defect). CI therefore
> additionally asserts that `结论: PASS` appears in the output rather than trusting the
> exit code alone. In an engine repository **without lectures**, **skip** this gate
> (CI already does).

### 4.4 End-to-end verification (when lectures are present)

```bash
cd site && npm ci && npm run build && cd ..
python scripts/test_angle.py
python scripts/check_figs2.py
python scripts/check_body_links.py
```

---

## V. Code style

### 5.1 General

- **Comments and documentation are written in Chinese** (this is a Chinese-language project).
- Indentation and line endings are governed by [`.editorconfig`](.editorconfig) and
  [`.gitattributes`](.gitattributes): **UTF-8 encoding, LF line endings, one trailing
  newline at end of file**. The repository stores everything as LF so cross-platform work
  produces no line-ending diff noise. Please do not submit whole-file line-ending changes.
- Strip trailing whitespace before committing (except for the **two or more** trailing
  spaces that Markdown uses for hard line breaks).

### 5.2 TypeScript / front-end

- Follow the **strict style**: no implicit `any`; annotate types wherever you can.
- Site configuration and theme code live in `site/docs/.vitepress/`.
- Before changing charts or the theme, read the corresponding design document under
  `engine/` so you understand the existing contract first.

### 5.3 Python (`scripts/`)

- Follow **PEP 8**: 4-space indentation.
- Scripts must be **cross-platform**: derive paths from the script's own location and
  **never hardcode absolute paths**
  (`pathlib.Path(__file__).resolve().parents[1]` is the established convention).
- Scripts should support `--help` and return meaningful exit codes: **0 = pass, non-zero = fail**.
- When printing a conclusion, **reflect it in the exit code too** — that is what makes it
  usable by CI.

### 5.4 Markdown (lecture content, if you contribute a content source)

- **The only legal form for an external link is the `.cite` chip**; raw Markdown links and
  bare URLs are forbidden.
- In prose, a `<` followed by an ASCII letter or underscore must be escaped as `&lt;`;
  one followed by a digit, space or Chinese character stays as-is.
- Placeholder angle brackets inside inline code (such as `` `<name>` ``) must be removed.
- **Formulas are always LaTeX** (`\( … \)` inline, `$$ … $$` display); do not use ASCII art.
- Code fences need canonical language tags (`bash` / `shellsession` / `kconfig` / `asm` /
  `ini` / `text`, …). Never write `plain text` with a space.
- Keep a blank line before a `---` horizontal rule (otherwise it is parsed as a Setext heading).
- See the content-specification documents under [`content/`](content/) for details.

---

## VI. Commit conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/), with
**the description written in Chinese**:

```
<type>(<scope>): <short description>
```

| Type | Purpose |
| --- | --- |
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Refactor (no external behaviour change) |
| `chore` | Build, dependencies, configuration and other chores |
| `test` | Test-related |
| `style` | Formatting (no logic change) |

Examples:

```
feat(charts): 支持 wavedrom 时序图全屏缩放
fix(theme): 修复 mermaid 标签被正文行高顶高导致文字不居中
docs(content): 补充 LaTeX 分式尺寸的降级判据
```

**Commit granularity**: one commit does one thing. It is **forbidden** to mix
"rule/configuration changes" with "content changes" in the same commit.

---

## VII. Pull request flow

1. Branch off `main`: `git checkout -b feat/your-feature`
2. Make your changes and get the relevant gates from section IV passing.
3. Commit and push, then open a PR (the PR template loads automatically — fill in every item).
4. In the PR description, state **what changed, why, and how it was verified**.
5. If your change touches the chart contract or the content specification, include the
   gates' **actual output** in the PR.

Maintainers will review as soon as they can. Please be patient and kind — see
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Chinese).

---

## VIII. Pre-commit checklist

- [ ] `cd site && npm ci && npm run build` succeeds
- [ ] `python scripts/test_angle.py` → `15/15 通过`
- [ ] (if lectures are present) `python scripts/check_figs2.py` → `不一致数: 0`
- [ ] (if lectures are present) `python scripts/check_body_links.py` → `结论: PASS`
- [ ] No build artifacts such as `node_modules/`, `dist/` or caches are committed
- [ ] No secrets, tokens or private keys are committed (see `.gitignore`)
- [ ] The commit message follows section VI

---

## IX. Reporting issues

- **Bugs**: use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) (Chinese).
- **Feature requests**: use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) (Chinese).

Search for an existing issue before filing a new one. **Never paste secrets or tokens into an issue.**
