/**
 * concepts/toolFiles.mts - per-tier data files for the AI tools (docs-dev/CONCEPTS.md).
 *
 *   tools/concepts.json, tools/lectures.json            the inline tier (everybody who can read the site)
 *   _access/<tier>/tools/concepts.json, lectures.json   every restricted tier
 *   tools/tiers.json                                    the tiers and who may read them (root only)
 *
 * The tier split is the one of the rest of the build (access/tiers.ts): a concept or lecture appears only in the files
 * of its own tier. Inside a file, `related`, `links`, `backlinks`, `lectures` name only content the reader of THAT tier
 * may read (`neighbourhoodOf`), so a public file never mentions a restricted slug, route or title.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AccessPlan } from '../access/tiers.ts'
import { neighbourhoodOf, type ConceptGraph } from './graph.ts'
import type { ConceptRelation } from './related.ts'
import { splitLectureSections, type LectureSection, type MarkdownParser } from './lectureSections.mts'
import {
  buildGraphFromRecords,
  publishedConceptRecords,
  rootLocaleLectures,
  type ConceptRecord,
  type LectureFileEntry,
} from './node.mts'

export const TOOLS_DATA_VERSION = 1

export interface ToolConceptEntry {
  slug: string
  term: string
  english: string
  aliases: string[]
  field: string
  groups: string[]
  summary: string
  url: string
  related: ConceptRelation[]
  links: string[]
  backlinks: string[]
  lectures: Array<{ route: string; id: string; title: string; count: number }>
  markdown: string
}

export interface ToolConceptsFile {
  version: 1
  tier: string
  generatedAt: string
  concepts: ToolConceptEntry[]
}

export interface ToolLectureEntry {
  route: string
  id: string
  group: string
  title: string
  sections: LectureSection[]
}

export interface ToolLecturesFile {
  version: 1
  tier: string
  lectures: ToolLectureEntry[]
}

export interface ToolTierEntry {
  id: string
  read: 'public' | 'authenticated' | 'groups'
  groups: string[]
  /** Folder of the tier's tool files, from the web root. */
  path: string
}

export interface ToolTiersFile {
  version: 1
  tiers: ToolTierEntry[]
}

export function toolsDirOf(tier: string, inlineTier: string): string {
  return tier === inlineTier ? 'tools' : `_access/${tier}/tools`
}

export function toolTiersOf(plan: AccessPlan): ToolTierEntry[] {
  const inline: ToolTierEntry = {
    id: plan.inlineTier,
    read: plan.inlineTier === 'public' ? 'public' : 'authenticated',
    groups: [],
    path: `/${toolsDirOf(plan.inlineTier, plan.inlineTier)}/`,
  }
  const restricted = plan.tiers.map<ToolTierEntry>((t) => ({
    id: t.id,
    read: t.rule.kind === 'groups' ? 'groups' : 'authenticated',
    groups: t.rule.kind === 'groups' ? [...t.rule.groups] : [],
    path: `/${toolsDirOf(t.id, plan.inlineTier)}/`,
  }))
  return [inline, ...restricted]
}

export function conceptsFileOf(
  graph: ConceptGraph,
  records: readonly ConceptRecord[],
  tier: string,
  generatedAt: string,
): ToolConceptsFile {
  const concepts: ToolConceptEntry[] = []
  for (const rec of publishedConceptRecords(records)) {
    if (rec.tier !== tier) continue
    const hood = neighbourhoodOf(graph, rec.slug, tier)
    concepts.push({
      slug: rec.slug,
      term: rec.meta.term,
      english: rec.meta.english,
      aliases: [...rec.meta.aliases],
      field: rec.meta.field,
      groups: [...rec.meta.groups],
      summary: rec.meta.summary,
      url: rec.url,
      related: hood.related,
      links: hood.links,
      backlinks: hood.backlinks,
      lectures: hood.lectures.map((l) => ({ route: l.route, id: l.id, title: l.title, count: l.count })),
      markdown: rec.body.replace(/^\s+/, '').trimEnd(),
    })
  }
  concepts.sort((a, b) => a.slug.localeCompare(b.slug))
  return { version: TOOLS_DATA_VERSION, tier, generatedAt, concepts }
}

export function lecturesFileOf(lectures: readonly LectureFileEntry[], tier: string, md: MarkdownParser): ToolLecturesFile {
  const entries: ToolLectureEntry[] = []
  for (const lec of lectures) {
    if (lec.tier !== tier) continue
    entries.push({
      route: lec.urlPath,
      id: lec.code,
      group: lec.groupId,
      title: lec.title,
      sections: splitLectureSections(lec.raw, md, lec.title, lec.relDocsPath),
    })
  }
  entries.sort((a, b) => a.route.localeCompare(b.route))
  return { version: TOOLS_DATA_VERSION, tier, lectures: entries }
}

export interface ToolFilesInput {
  records: readonly ConceptRecord[]
  /** Every scanned lecture (all languages); translated copies are dropped here. */
  lectures: readonly LectureFileEntry[]
  accessPlan: AccessPlan
  localeKeys: readonly string[]
  md: MarkdownParser
  generatedAt?: string
}

/** Every tool file of the build, keyed by path relative to the output directory. */
export function buildToolFiles(input: ToolFilesInput): Map<string, string> {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const lectures = rootLocaleLectures(input.lectures, input.localeKeys, input.accessPlan)
  const graph = buildGraphFromRecords(input.records, lectures)
  const tiers = toolTiersOf(input.accessPlan)
  const out = new Map<string, string>()
  for (const t of tiers) {
    const dir = toolsDirOf(t.id, input.accessPlan.inlineTier)
    out.set(`${dir}/concepts.json`, JSON.stringify(conceptsFileOf(graph, input.records, t.id, generatedAt)))
    out.set(`${dir}/lectures.json`, JSON.stringify(lecturesFileOf(lectures, t.id, input.md)))
  }
  const tiersFile: ToolTiersFile = { version: TOOLS_DATA_VERSION, tiers }
  out.set('tools/tiers.json', JSON.stringify(tiersFile))
  return out
}

export function writeToolFiles(outDir: string, input: ToolFilesInput): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const [rel, body] of buildToolFiles(input)) {
    const abs = path.join(outDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body, 'utf8')
    sizes.set(rel, Buffer.byteLength(body, 'utf8'))
  }
  return sizes
}
