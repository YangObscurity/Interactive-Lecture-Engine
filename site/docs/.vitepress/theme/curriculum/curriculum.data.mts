/**
 * curriculum/curriculum.data.mts - VitePress data loader (build time): the INLINE part of the curriculum, one
 * `CurriculumData` per locale bucket (`root`, `en`, ...): the groups of the inline access tier and the edges whose two
 * ends are both in them (P3b: restricted groups, their titles and their lecture ids arrive with their tier's
 * `/_access/<tier>/curriculum.<locale>.json`, see access/build.mts `finalizeDist` and loader.ts).
 *
 * Do NOT import this from code that runs on every page: VitePress inlines the data into the importing chunk.
 * `loader.ts` loads it with a dynamic `import()`, so it becomes its own chunk; the home page may import it statically
 * to render the build-time numbers on the server.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLectureConfig } from '../../content/config.mts'
import { resolveContent, watchExistingFrom } from '../../content/paths.mts'
import { resolveBuildAccess } from '../../access/build.mts'
import { resolveGroups } from '../../groups-source.mts'
import { resolveI18n } from '../../lecture-config.mts'
import { buildCurriculumFromDisk } from '../../curriculum/node.mts'
import { splitCurriculum } from '../../curriculum/split.ts'
import type { CurriculumData } from '../../curriculum/data.ts'

declare const data: Record<string, CurriculumData>
export { data }

const here = path.dirname(fileURLToPath(import.meta.url))
/** docs/ (this file is docs/.vitepress/theme/curriculum/). */
const contentPaths = resolveContent()
const docsRoot = contentPaths.docsRoot

export default {
  watch: [
    ...watchExistingFrom(here, [contentPaths.graphDir.graph, contentPaths.graphDir.graphNotion], contentPaths.mode),
    '../../../*/L*.md',
  ],
  async load(): Promise<Record<string, CurriculumData>> {
    const lectureConfig = loadLectureConfig({ paths: contentPaths })
    const { GROUPS } = await resolveGroups()
    const plan = resolveBuildAccess(lectureConfig.access, GROUPS)
    const i18n = resolveI18n(lectureConfig)
    const build = buildCurriculumFromDisk({
      docsRoot,
      graphFile: contentPaths.graphDir.graph,
      notionFile: contentPaths.graphDir.graphNotion,
      allGroups: GROUPS,
      keptGroupIds: plan.keptGroupIds,
      rootLang: i18n.root,
      otherLangs: i18n.locales.filter((l) => l !== i18n.root),
    })
    const out: Record<string, CurriculumData> = {}
    for (const [bucket, full] of Object.entries(build.byLocale)) {
      out[bucket] = splitCurriculum(full, { tierOfGroup: (id) => plan.tierOfGroup[id] ?? plan.inlineTier, inlineTier: plan.inlineTier }).inline
    }
    return out
  },
}
