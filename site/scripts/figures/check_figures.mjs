#!/usr/bin/env node
/**
 * scripts/figures/check_figures.mjs — integrity check for group-managed figures (WP-F8).
 *
 * Uses `jiti` so `node scripts/figures/check_figures.mjs` resolves `.ts`/`.mts` modules cleanly.
 * Also runs the concept checks (docs/.vitepress/concepts/graph.ts): errors (`related` problems, two concepts with the
 * same name or alias, an unknown or too-strict `concept:` link inside a concept page) fail the run; the warning (a
 * concept page names another concept without linking it) is listed. This is the content check concept pages go
 * through (`npm run check` includes it); `npm run build` stops on the same errors.
 * Exit codes: 0 pass (warnings allowed), 1 check failed, 2 gate broken.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url)

async function loadContext() {
  const { resolveBuildAccess } = await jiti.import('../../docs/.vitepress/access/build.mts')
  const { loadLectureConfig } = await jiti.import('../../docs/.vitepress/content/config.mts')
  const { resolveContent } = await jiti.import('../../docs/.vitepress/content/paths.mts')
  const { resolveGroups } = await jiti.import('../../docs/.vitepress/groups-source.mts')
  const { resolveI18n } = await jiti.import('../../docs/.vitepress/lecture-config.mts')
  const { localeKeyOf } = await jiti.import('../../docs/.vitepress/i18n/langs.ts')

  const paths = resolveContent()
  const config = loadLectureConfig({ paths })
  const i18n = resolveI18n(config)
  const localeKeys = i18n.locales.filter((l) => l !== i18n.root).map(localeKeyOf)
  const { GROUPS } = await resolveGroups()
  const accessPlan = resolveBuildAccess(config.access, GROUPS)
  return { paths, GROUPS, localeKeys, accessPlan }
}

export async function runFiguresCheck() {
  const { buildFigureAuditAndGallery } = await jiti.import('../../docs/.vitepress/figures/gallery.ts')
  const { paths, GROUPS, localeKeys, accessPlan } = await loadContext()
  return buildFigureAuditAndGallery(
    {
      paths,
      groups: GROUPS,
      localeKeys,
      accessPlan,
    },
    { verifyFiles: true, isBuild: false },
  )
}

/** Concept checks of the content on disk: `{ concepts, errors, warnings }`. */
export async function runConceptsCheck() {
  const { loadConceptRecords, publishedConceptRecords, runConceptChecks } = await jiti.import('../../docs/.vitepress/concepts/node.mts')
  const { paths, GROUPS, localeKeys, accessPlan } = await loadContext()
  const records = loadConceptRecords({
    content: paths,
    accessPlan,
    builtGroupIds: new Set(GROUPS.map((g) => g.id)),
    includeDrafts: false,
    isDev: false,
    localeKeys,
  })
  const res = runConceptChecks(records)
  return { concepts: publishedConceptRecords(records).length, errors: res.errors, warnings: res.warnings }
}

async function main() {
  const res = await runFiguresCheck()
  const concepts = await runConceptsCheck()
  const citedCount = res.gallery.filter((x) => x.usedIn.length > 0).length
  console.log(
    `[check:figures] groups=${res.registries.size} figures=${res.gallery.length} cited=${citedCount} warnings=${res.warnings.length}`,
  )
  for (const w of res.warnings) {
    console.warn(`[check:figures] WARN: ${w}`)
  }
  console.log(`[check:figures] concepts=${concepts.concepts} errors=${concepts.errors.length} warnings=${concepts.warnings.length}`)
  for (const w of concepts.warnings) {
    console.warn(`[check:figures] WARN: ${w}`)
  }
  if (!res.ok || concepts.errors.length > 0) {
    for (const err of res.errors) {
      console.error(`[check:figures] FAIL: ${err}`)
    }
    for (const err of concepts.errors) {
      console.error(`[check:figures] FAIL: ${err}`)
    }
    process.exit(1)
  }
  console.log('[check:figures] PASS')
}

const isCli =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  main().catch((err) => {
    console.error(`[check:figures] BROKEN:`, err)
    process.exit(2)
  })
}
