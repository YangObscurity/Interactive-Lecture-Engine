/**
 * tests/unit/demo-content.ts - the engine's demo content (templates/demo-content) for unit tests that need a whole site.
 *
 * S6: unit tests never read the owner's lectures (content/ of the private repository) and never depend on what
 * `content:sync` last copied into site/docs. A test that needs real lecture files syncs the demo content into its own
 * temporary docs folder (`syncDemoDocs`); the demo folder itself is only read. Same result in the private repository
 * (with content/) and in the engine repository (without it).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveContent } from '../../docs/.vitepress/content/paths.mts'
import type { ContentPaths } from '../../docs/.vitepress/content/paths.mts'
import { syncContent } from '../../scripts/content/sync.mts'

export const SITE_DIR = path.resolve(__dirname, '../..')
export const DEMO_CONTENT_DIR = path.resolve(SITE_DIR, '..', 'templates', 'demo-content')
/** The environment that makes resolveContent / resolveGroups read the demo content. */
export const DEMO_ENV = { LECTURE_CONTENT_DIR: DEMO_CONTENT_DIR } as const

/** The demo's access tiers (PLN `authenticated`, DAT the gateway group `staff`, every other group inline), as LECTURE_ACCESS_JSON. */
export const DEMO_ACCESS_JSON = JSON.stringify(JSON.parse(fs.readFileSync(path.join(DEMO_CONTENT_DIR, 'access.e2e.json'), 'utf8')))

/** The groups access.e2e.json restricts, in the order it lists them (PLN, DAT). */
export const DEMO_RESTRICTED_IDS: readonly string[] = Object.keys((JSON.parse(DEMO_ACCESS_JSON) as { groups?: Record<string, unknown> }).groups ?? {})

/**
 * The demo's groups in the order groups.ts declares them (S6X: 9 groups in 3 categories). The tests that check the
 * order the engine reads take it from here; everything else (counts, inline groups) is derived from the content.
 */
export const DEMO_GROUP_ORDER = ['MEA', 'LOG', 'PRB', 'GEO', 'PLN', 'DAT', 'VIS', 'EXP', 'WRT'] as const

/** The groups of `ids` the access e2e build ships inline (not restricted by access.e2e.json), in the given order. */
export function demoInlineIds(ids: readonly string[]): string[] {
  return ids.filter((id) => !DEMO_RESTRICTED_IDS.includes(id))
}

export function demoContentPaths(): ContentPaths {
  return resolveContent({ env: DEMO_ENV })
}

export interface DemoDocs {
  /** Temporary docs folder holding the synced demo lectures (`mea/L01.md`, `en/log/L01.md`, `concepts/...`). */
  docsRoot: string
  /** The demo content paths with `docsRoot` pointing at the temporary folder. */
  paths: ContentPaths
  cleanup: () => void
}

/** Copy the demo content into a temporary docs folder with the engine's own content:sync. */
export async function syncDemoDocs(): Promise<DemoDocs> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-docs-'))
  const docsRoot = path.join(tmp, 'docs')
  fs.mkdirSync(docsRoot)
  const paths: ContentPaths = { ...demoContentPaths(), docsRoot, vpRoot: path.join(docsRoot, '.vitepress') }
  await syncContent({ contentPaths: paths, manifestFile: path.join(tmp, 'content-sync.json'), quiet: true })
  return { docsRoot, paths, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) }
}

/** Set environment variables for a test and get a function that puts the previous values back. */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/**
 * A throwaway content root that only declares course groups (`groups.ts`), made the active root through
 * LECTURE_CONTENT_DIR. For tests whose fixtures name synthetic groups (G01, G06, ...) in their own temporary docs
 * folder: without it the groups would come from whatever the repository happens to have (the owner's content/ in a
 * private site, the demo content in the engine repository). Returns a function that removes the root and puts the
 * environment back.
 */
export function useSyntheticGroups(ids: readonly string[]): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-groups-'))
  const groups = ids.map((id) => ({ id, dir: id.toLowerCase(), title: `${id} 示例组`, tagline: '', summary: '', accent: '#2563EB', tags: [], category: '示例' }))
  fs.writeFileSync(path.join(root, 'groups.ts'), `export const GROUPS = ${JSON.stringify(groups, null, 2)}\n`, 'utf8')
  const restore = setEnv({ LECTURE_CONTENT_DIR: root })
  return () => {
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
}
