# Interactive Lecture Engine

A static site engine for interactive engineering lectures: Markdown lectures with live charts, figures, concept pages,
a course map, reading progress and an optional AI reading companion. Built on VitePress, with an optional backend
(`server/`, lecture-api) for progress sync, identity behind a gateway, and the companion.

Your own lectures never live in this repository. They live in a separate content folder (`content/`, its own
private git repository), which this repository ignores.

## Quick start

```bash
cd site
npm ci
npm run init          # creates content/ from templates/content (site texts are left empty for you to fill in)
npm run new:group -- --id G01 --dir g01 --title "My first course"
npm run new:lecture -- --group G01 --title "Lecture one"
npm run check:content # the lecture contract, links, figures, site texts
npm run dev           # http://localhost:5174, content/ is copied into the site as you edit
npm run build         # static site in site/docs/.vitepress/dist
```

Without a `content/` folder the engine builds its built-in examples.

## Where things are

| Folder | What |
|---|---|
| `site/` | the VitePress site: themes, components, build plugins, checks, tests |
| `server/` | lecture-api (optional): progress, sessions, gateway identity, AI proxy and tools |
| `templates/content/` | the starting point of a new content folder |
| `docs/authoring/` | for authors and coding agents: rules, the lecture contract, recipes |
| `docs-dev/` | for maintainers: configuration, build, access tiers, deployment, gateway, backups |
| `scripts/` | lecture checks, deployment helpers, graph importers, the privacy gate |

## For coding agents

Read `AGENTS.md` first. Write content only in `content/`, create files with the scaffolding commands, and run
`npm run check:content` and `npm run doctor` before handing work over.

## Privacy

`scripts/privacy/scan.mjs` refuses personal data, secrets and content in this repository (pre-commit hook:
`node scripts/privacy/install-hook.mjs`; CI: `.github/workflows/privacy.yml`). Secrets belong in `.env`, which is
never committed.
