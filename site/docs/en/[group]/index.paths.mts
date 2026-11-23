/**
 * English group pages (/en/<dir>/): one page per resolved course group, `group` = the group's `dir`
 * (it may contain `/`, e.g. `courses/g01`). A group that has a real `docs/en/<dir>/index.md` keeps it.
 * `title` / `description` are applied by `transformPageData` in config.v2.mts (frontmatter cannot use params).
 *
 * Another language adds its own copy of this folder (`docs/<localeKeyOf(lang)>/[group]/`) with `LANG`
 * changed; nothing else is needed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveGroups } from '../../.vitepress/groups-source.mts'
import { loadLectureConfig } from '../../.vitepress/content/config.mts'
import { resolveBuildAccess } from '../../.vitepress/access/build.mts'
import { pickLocalized, type LangCode } from '../../.vitepress/i18n/index.ts'
import type { GroupI18n } from '../../.vitepress/i18n/data.ts'

const LANG: LangCode = 'en'
/** docs/en/ — this file sits in docs/en/[group]/, so a real group page is <langDir>/<dir>/index.md. */
const langDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type GroupLike = { id: string; dir: string; title: string; tagline: string; i18n?: GroupI18n }

/** Route params of the generated group pages; groups with a real `<langDir>/<dir>/index.md` are skipped. Exported for tests. */
export function groupPageParams(groups: readonly GroupLike[], dir: string, lang: LangCode) {
  return groups
    .filter((g) => !fs.existsSync(path.join(dir, g.dir, 'index.md')))
    .map((g) => ({
      params: {
        group: g.dir,
        title: `${g.id} · ${pickLocalized(g, lang, 'title')}`,
        description: pickLocalized(g, lang, 'tagline'),
      },
    }))
}

export default {
  async paths() {
    const { GROUPS } = await resolveGroups()
    const lectureConfig = loadLectureConfig()
    // P3b: groups left out of the build (--audience public, LECTURE_BUILD_GROUPS) get no English group page either
    const built = resolveBuildAccess(lectureConfig.access, GROUPS).keptGroupIds
    return groupPageParams(GROUPS.filter((g) => built.includes(g.id)), langDir, LANG)
  },
}
