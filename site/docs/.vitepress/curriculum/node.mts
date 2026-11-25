/**
 * curriculum/node.mts - the Node side of the curriculum (P4a WP-H1): reads the lecture files, the translations and
 * `site/data/graph.json`, and hands plain values to `buildCurriculum` (data.ts). Imported by config.mts (build log and
 * the per-tier files written by access/build.mts `finalizeDist`) and by the data loader theme/curriculum/curriculum.data.mts;
 * never by client code.
 */
import fs from 'node:fs'
import path from 'node:path'
import { scanTranslations } from '../i18n/scan.mts'
import { translate, localeKeyOf } from '../i18n/index.ts'
import type { LangCode } from '../i18n/langs.ts'
import type { GroupMetaLike } from '../groups-source.mts'
import { groupSlots } from '../theme/tokens/categories.ts'
import { buildCurriculum } from './data.ts'
import type { CurriculumBuild, GraphLike, NotionLike, SourceGroup, SourceLecture } from './data.ts'
import { readLectureFrontmatter } from './frontmatter.ts'

export interface DiskInput {
  /** docs/ */
  docsRoot: string
  /** site/data/graph.json */
  graphFile: string
  /** site/data/graph-notion.json (P4a WP-H3: Notion 说明 / 难度 / 预估 / 链接 per graph node). Optional; a missing file means no such fields. */
  notionFile?: string
  /** Every course group of groups.mts, built or not, in declaration order (the colour slots are assigned over all of them). */
  allGroups: readonly GroupMetaLike[]
  /** Ids of the groups that are part of this build. */
  keptGroupIds: readonly string[]
  /** Language of `/`. */
  rootLang: LangCode
  /** Enabled non-root languages. */
  otherLangs: readonly LangCode[]
}

/** The lectures of one group folder: `docs/<dir>/L<digits>.md`, by number, with the frontmatter fields the curriculum reads. */
export function scanSourceLectures(docsRoot: string, dir: string): SourceLecture[] {
  const d = path.join(docsRoot, dir)
  if (!fs.existsSync(d)) return []
  return fs
    .readdirSync(d)
    .filter((f) => /^L\d+\.md$/.test(f))
    .map((f): SourceLecture => {
      const fm = readLectureFrontmatter(fs.readFileSync(path.join(d, f), 'utf8'))
      return { n: Number(f.slice(1, -3)), link: `/${dir}/${f.slice(0, -3)}`, title: fm.title, requires: fm.requires, phase: fm.phase }
    })
    .sort((a, b) => a.n - b.n)
}

/** `graph.json` as the build reads it; null when the file is missing or not a graph (the curriculum then has no graph edges). */
export function readGraphFile(file: string): GraphLike | null {
  try {
    const g: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof g === 'object' && g !== null && Array.isArray((g as GraphLike).nodes) && Array.isArray((g as GraphLike).edges)) return g as GraphLike
  } catch {
    /* missing or unreadable: no graph edges */
  }
  return null
}

/** `graph-notion.json` (node id -> properties); null when the file is missing or not an object (the lectures then have no Notion properties). */
export function readNotionFile(file: string | undefined): NotionLike | null {
  if (!file) return null
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as NotionLike
  } catch {
    /* missing or unreadable: no Notion properties */
  }
  return null
}

/** Build the curriculum of every language of the site from the files on disk. */
export function buildCurriculumFromDisk(input: DiskInput): CurriculumBuild {
  const slots = groupSlots(input.allGroups)
  const kept = new Set(input.keptGroupIds)
  // the same order as config.mts: temporary groups last (the sort is stable)
  const built = input.allGroups.filter((g) => kept.has(g.id)).sort((a, b) => Number(!!a.temp) - Number(!!b.temp))
  const groups: SourceGroup[] = built.map((g) => ({
    id: g.id,
    dir: g.dir,
    title: g.title,
    ...(g.category !== undefined ? { category: g.category } : {}),
    ...(g.temp === true ? { temp: true } : {}),
    ...(g.map !== undefined ? { map: g.map } : {}),
    ...(g.i18n ? { i18n: g.i18n } : {}),
    lectures: scanSourceLectures(input.docsRoot, g.dir),
  }))
  const keys = input.otherLangs.map(localeKeyOf)
  const scan = scanTranslations(input.docsRoot, keys)
  return buildCurriculum({
    groups,
    notBuiltDirs: input.allGroups.filter((g) => !kept.has(g.id)).map((g) => g.dir),
    graph: readGraphFile(input.graphFile),
    notion: readNotionFile(input.notionFile),
    locales: [
      { key: 'root', lang: input.rootLang },
      ...input.otherLangs.map((lang) => ({ key: localeKeyOf(lang), lang, translations: scan[localeKeyOf(lang)] ?? {} })),
    ],
    slotOf: (id) => slots.get(id) ?? 1,
    fallbackTitle: (lang, n) => translate(lang, 'lecture.fallbackTitle', { n }, input.rootLang),
  })
}

/** Log lines of the curriculum build: one stats line, then the warnings (at most `maxWarnings` listed). */
export function curriculumLog(build: CurriculumBuild, maxWarnings = 20): { stats: string; warnings: string[] } {
  const root = build.byLocale.root
  const s = root?.stats ?? { groups: 0, lectures: 0, edges: 0 }
  const count = (r: string): number => build.dropped.filter((d) => d.reason === r).length
  const e = build.edgeSources
  const stats =
    `${s.groups} groups, ${s.lectures} lectures, ${s.edges} prerequisite edges ` +
    `(graph.json ${e.graph}, requires ${e.requires}, in both ${e.both}); ` +
    `dropped ${build.dropped.length} (missing lecture ${count('missing-lecture')}, missing node ${count('missing-node')}, group not built ${count('not-built')}, self ${count('self')})`
  const warnings = build.warnings.slice(0, maxWarnings)
  if (build.warnings.length > maxWarnings) warnings.push(`... and ${build.warnings.length - maxWarnings} more`)
  return { stats, warnings }
}
