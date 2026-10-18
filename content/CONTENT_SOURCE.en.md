# Content Source Separation Contract

> **Language / 语言**: English ｜ [中文](./CONTENT_SOURCE.md)

> **In one sentence**: the engine and the lecture notes are fully decoupled — the
> repository ships only the **engine plus one minimal example content source**, while your
> own lectures live as an **independent content source** mounted locally and never uploaded.

---

## 1. Why it is designed this way

The core conflict before open-sourcing:

| Requirement | Conflict |
|---|---|
| The engine must be open-sourceable and reproducible by third parties | The engine was previously hard-coupled to private lectures under the same `site/docs/` tree |
| The lectures must stay local | Course groups and directory scanning were directly tied to private paths |
| Private data (Notion progress, node IDs, exam analyses) must not leak | `public/*.json` were the **direct output** of private data and were consumed by the front end via fetch |

The solution is not to "delete the lectures" — that would take the engine with it. It is to
introduce a layer of indirection, the **content source**:

```
Engine (open source)        Content source (private / third party)
site/                       content-sources/<name>/
  docs/.vitepress/            groups.mts         ← course group metadata
    config.mts  ──reads──▶    docs/gxx/Lxx.md    ← lecture body
    theme/                    docs/public/charts/<ID>-<Lxx>.json  ← chart sidecar
                              public/*.json      ← catalog / knowledge-graph data
```

At **build time** the engine mounts (symlink or copy) the selected content source into the
corresponding locations under `site/docs/`, so the build output is exactly the same; the
**content-source directory itself** is excluded from the open-source repository by
`.gitignore`.

---

## 2. Directory layout

```
<repo root>/
├─ site/                          # Engine (open source)
│  └─ docs/
│     ├─ .vitepress/              # Theme / config / build scripts
│     ├─ index.md                 # Home page (ships with the engine)
│     └─ examples/                # The engine's own **minimal example content source** (open source)
│        ├─ g01/L01.md            # 1–2 example lectures demonstrating every feature
│        └─ public/charts/EX-L01.json
├─ content-sources/               # Content-source root (**empty in the open-source repo**)
│  ├─ README.md                   # Contract documentation (open source)
│  └─ <your-course>/              # Private content source (excluded by .gitignore)
│     ├─ groups.mts
│     ├─ docs/
│     └─ public/
└─ .gitignore                     # Excludes content-sources/*/ but keeps README.md
```

---

## 3. Content source contract (v1)

A valid content source must provide:

### 3.1 `groups.mts`

Exports course-group metadata whose element structure is identical to the engine's
`GroupMeta` (`id` / `dir` / `title` / `tagline` / `summary` / `accent` / `tags` / `temp?`).

**Both export names `GROUPS` and `GROUP_META` are accepted** (implemented as
`mod.GROUPS ?? mod.GROUP_META`), so it works whether you follow this contract and write
`GROUP_META` or follow the engine's own convention and write `GROUPS`.
Optionally you may also export `SITE_META` (site name / tagline) and `SITE_FEATURES`
(home-page feature-card copy).

**The engine's actual resolution precedence and isolation contract** (matching the `resolveGroups()`
implementation in `site/docs/.vitepress/config.mts` word for word, ratified 2026-10-17):

| Precedence | File / Source | Notes & Behavior |
|---|---|---|
| 1 | `site/docs/.vitepress/content-groups.mts` | The copy introduced by `scripts/mount_content.py` when mounting a content source (auto-hides examples) |
| 2 | `site/docs/.vitepress/groups.mts` | Local private course-group definitions (auto-hides examples) |
| 2.5 | Auto-detected unconfigured course dirs | Non-system directories under `docs/` containing lecture files (auto-hides examples) |
| 3 | `site/docs/.vitepress/groups.example.mts` | Loaded **only** when no personal lectures exist (pure engine showcase fallback) |

> 💡 **Dynamic Example Fallback & Exclusive Isolation**:
> When precedence 1, 2, or 2.5 matches, the engine detects personal lectures and enters "Personal Exclusive Mode": it **strictly refuses to load the example curriculum**, and VitePress configuration sets `srcExclude: ['examples/**']` to completely exclude example Markdown files from compilation, HTML generation, and local search indexing.

> ⚠️ Why the "mounted copy" has the highest precedence: mounting is an **explicit action**,
> and an explicitly mounted content source should beat leftover local files — otherwise
> "I mounted it but nothing changed" becomes extremely hard to diagnose.
>
> ⚠️ This contract **does not use** the `CONTENT_SOURCE` environment variable (older
> documentation claimed it did, which did not match the implementation; corrected
> 2026-10-15). Mounting is always performed explicitly through `scripts/mount_content.py`.

### 3.2 `docs/` and `public/`

- `docs/<dir>/L<n>.md`: the lecture body. The filename must match `^L\d+\.md$` (the engine
  sorts and numbers lectures from this).
  - Frontmatter must contain at least `title` (**wrapped in English double quotes**) and `order`.
  - `index.md` is the course-group landing page (optional).
- `public/charts/<ID>-<Lxx>.json`: the chart sidecar. Its keys must be a **strict 1:1**
  match with the `data-id` values of the body's
  `<figure class="chart" data-lecture data-id data-type>` anchors.
- `public/lecture_catalog.json`, `public/notion_knowledge_graph.json`: optional.
  When missing, the related front-end views (global course map / knowledge map) degrade to
  placeholders — the build **does not error and is not blocked**.

### 3.3 Chart-anchor conservation (**must not be violated**)

Every `<figure class="chart" ...></figure>` in the body must have a matching key in the
sidecar JSON, and vice versa. Verification command:

```bash
python scripts/check_figs2.py     # expected: 不一致数 = 0 (0 mismatches)
```

---

## 4. Private-data boundary (must be empty in the open-source build)

The following never enters the open-source repository and is forcibly excluded by `.gitignore`:

| Path | Content | Why it is private |
|---|---|---|
| `content-sources/*/` (except `README.md`) | Your lecture bodies, charts, course-group definitions | Copyright / same source as published material |
| `workspaces/` | Lecture-enhancement / authoring / pedagogy workspaces and memory | Private workflow and project memory |
| `site/docs/<mounted-group>/` | Mounted working copies of the lectures | External mounted content |
| `site/docs/public/*.json` (real data) | Study progress, Notion node IDs, exam analyses | Private study data |
| `.env` | Notion token, server credentials | Credentials |

> The open-source build keeps the **structure** and strips the **content**:
> `content-sources/README.md` and `site/docs/examples/` document the contract and
> demonstrate usage, so a third party can load their own course from them.

---

## 5. Third-party onboarding steps (open-source users)

```bash
# 1. Clone and install
git clone <this-repo> my-course && cd my-course/site && npm ci

# 2. Create your own content source
mkdir -p ../content-sources/my-course/docs/g01 ../content-sources/my-course/public/charts

# 3. Write groups.mts (copy the template from content-sources/README.md)

# 4. Mount and build
cd .. && python scripts/mount_content.py --source content-sources/my-course
cd site && npm run build
```

---

## 6. Content Source Decoupling Architecture

The engine adopts a physical decoupling architecture between content sources and the engine core:

- **Out-of-the-Box Demo**: Fresh clones include `site/docs/examples/` as reference implementations and functional demos, ready to build and run immediately;
- **User Content Mounting**: Use `python scripts/mount_content.py --mount <source-name> --apply` to mount external course packages. The engine automatically excludes demo courses and exclusively renders user curricula;
- **Unmounting & Reset**: Run `python scripts/mount_content.py --unmount --apply` to cleanly unmount user content and restore the clean open-source engine skeleton.
