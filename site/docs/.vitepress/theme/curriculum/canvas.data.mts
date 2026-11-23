/**
 * curriculum/canvas.data.mts - VitePress data loader (build time): the INLINE dependency canvas bundle
 * (`reader` + `datasheet` compact & zones), computed in an isolated child Node process via ELK + libavoid.
 *
 * Strictly inline-tier groups and edges whose both ends are inline (P3b: restricted groups travel with
 * `/_access/<tier>/canvas.json`, see access/build.mts and theme/curriculum/canvasLoader.ts).
 * Do NOT import statically from theme code: `canvasLoader.ts` imports it dynamically into its own chunk.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLectureConfig } from '../../content/config.mts'
import { resolveContent, watchExistingFrom } from '../../content/paths.mts'
import { resolveBuildAccess } from '../../access/build.mts'
import { buildCanvasFromCurriculum } from '../../curriculum/canvasNode.mts'
import type { CanvasBundle } from '../../curriculum/canvasTypes.ts'
import { buildCurriculumFromDisk } from '../../curriculum/node.mts'
import { splitCurriculum } from '../../curriculum/split.ts'
import { resolveGroups } from '../../groups-source.mts'
import { resolveI18n } from '../../lecture-config.mts'

declare const data: CanvasBundle
export { data }

const here = path.dirname(fileURLToPath(import.meta.url))
const contentPaths = resolveContent()
const docsRoot = contentPaths.docsRoot

export default {
  watch: [...watchExistingFrom(here, [contentPaths.graphDir.graph], contentPaths.mode), '../../../*/L*.md'],
  async load(): Promise<CanvasBundle> {
    const lectureConfig = loadLectureConfig({ paths: contentPaths })
    const { GROUPS } = await resolveGroups()
    const plan = resolveBuildAccess(lectureConfig.access, GROUPS)
    const i18n = resolveI18n(lectureConfig)
    const full = buildCurriculumFromDisk({
      docsRoot,
      graphFile: contentPaths.graphDir.graph,
      notionFile: contentPaths.graphDir.graphNotion,
      allGroups: GROUPS,
      keptGroupIds: plan.keptGroupIds,
      rootLang: i18n.root,
      otherLangs: [],
    }).byLocale.root!
    const inline = splitCurriculum(full, {
      tierOfGroup: (id) => plan.tierOfGroup[id] ?? plan.inlineTier,
      inlineTier: plan.inlineTier,
    }).inline
    return buildCanvasFromCurriculum(inline)
  },
}
