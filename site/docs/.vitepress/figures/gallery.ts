/**
 * Build-time, dev-API, and CLI aggregation + integrity audit for group-managed figures (WP-F8).
 * Paths come strictly from `resolveContent()` (`content/paths.mts`).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AccessPlan } from '../access/tiers.ts'
import { tierBasePath } from '../access/tiers.ts'
import type { ContentPaths } from '../content/paths.mts'
import {
  figurePublicUrl,
  isTierAccessAllowed,
  scanLectureFigureUsage,
  type PageFigureUsage,
} from './markdown.ts'
import { loadAllGroupRegistries, type LoadedGroupRegistry } from './registry.ts'
import { resolveContainedFigureFile } from './validate.ts'
import type {
  FigureGalleryItem,
  GalleryLectureRef,
  GalleryPayload,
} from './types.ts'

export type { FigureGalleryItem, GalleryLectureRef, GalleryPayload }

export interface GroupMetaLike {
  id: string
  dir: string
  title?: string
  i18n?: { en?: { title?: string } }
}

export interface AuditFiguresInput {
  paths: Pick<ContentPaths, 'figuresDir' | 'exampleFiguresDir' | 'lecturesDir' | 'docsRoot'>
  groups: readonly GroupMetaLike[]
  localeKeys: readonly string[]
  accessPlan: AccessPlan
}

export interface AuditFiguresResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  registries: Map<string, LoadedGroupRegistry>
  usage: PageFigureUsage[]
  gallery: FigureGalleryItem[]
}

export function buildFigureAuditAndGallery(
  input: AuditFiguresInput,
  opts: { verifyFiles?: boolean; isBuild?: boolean } = {},
): AuditFiguresResult {
  const errors: string[] = []
  const warnings: string[] = []

  const groupMetaByDir = new Map<string, GroupMetaLike>()
  const knownDirs = new Set<string>(['examples/g01'])
  for (const g of input.groups) {
    groupMetaByDir.set(g.dir, g)
    knownDirs.add(g.dir)
  }

  let registries: Map<string, LoadedGroupRegistry>
  try {
    registries = loadAllGroupRegistries(input.paths, {
      verifyFiles: opts.verifyFiles ?? true,
    })
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      warnings,
      registries: new Map(),
      usage: [],
      gallery: [],
    }
  }

  for (const [group, reg] of registries) {
    warnings.push(...reg.warnings)
    knownDirs.add(group)
  }

  const usage = scanLectureFigureUsage(
    input.paths.lecturesDir,
    input.paths.docsRoot,
    [...knownDirs],
    input.localeKeys,
  )

  const tierOfDir = (groupDir: string): string => {
    const meta = groupMetaByDir.get(groupDir)
    if (!meta) return input.accessPlan.inlineTier
    return input.accessPlan.tierOfGroup[meta.id] ?? input.accessPlan.inlineTier
  }

  const usedInByKey = new Map<string, GalleryLectureRef[]>()
  for (const page of usage) {
    const pageTier = tierOfDir(page.groupDir)
    for (const cit of page.citations) {
      const targetGroup = cit.targetGroup
      const targetTier = tierOfDir(targetGroup)
      if (!isTierAccessAllowed(pageTier, targetTier, input.accessPlan.inlineTier)) {
        errors.push(
          `[figures] ${page.relPath} (tier "${pageTier}") cites restricted figure "${targetGroup}/${cit.id}" (tier "${targetTier}")`,
        )
        continue
      }
      const reg = registries.get(targetGroup)
      const entry = reg?.byId.get(cit.id)
      if (!entry) {
        errors.push(`[figures] ${page.relPath}: cited unknown figure "${targetGroup}/${cit.id}"`)
        continue
      }
      if (cit.kind !== 'mount' && entry.kind !== cit.kind) {
        errors.push(
          `[figures] ${page.relPath}: "${cit.kind === 'figure' ? 'fig' : 'tab'}:${cit.id}" expects kind="${cit.kind}" but found "${entry.kind}"`,
        )
        continue
      }
      const key = `${targetGroup}:${entry.id}`
      const list = usedInByKey.get(key) ?? []
      if (!list.some((item) => item.route === page.route)) {
        list.push({ route: page.route, title: page.title })
      }
      usedInByKey.set(key, list)
    }
  }

  const gallery: FigureGalleryItem[] = []
  for (const [group, reg] of registries) {
    const meta = groupMetaByDir.get(group)
    const groupId = meta?.id ?? group.toUpperCase()
    const groupTitle = {
      zh: meta?.title ?? group,
      en: meta?.i18n?.en?.title ?? meta?.title ?? group,
    }
    const tier = tierOfDir(group)

    for (const entry of reg.registry.figures) {
      const key = `${group}:${entry.id}`
      const usedIn = usedInByKey.get(key) ?? []
      if (usedIn.length === 0) {
        warnings.push(`${group}/${entry.id}: figure is registered but not cited in any lecture`)
      }
      const diskFile = resolveContainedFigureFile(reg.groupDir, entry.file)
      const bytes = diskFile && fs.existsSync(diskFile) ? fs.statSync(diskFile).size : 0
      const src = figurePublicUrl(group, entry.file, tier, Boolean(opts.isBuild), input.accessPlan.inlineTier)
      const originalSrc = entry.original
        ? figurePublicUrl(group, entry.original, tier, Boolean(opts.isBuild), input.accessPlan.inlineTier)
        : undefined
      gallery.push({
        group,
        groupId,
        groupTitle,
        tier,
        id: entry.id,
        kind: entry.kind,
        file: entry.file,
        src,
        originalSrc,
        width: entry.width,
        height: entry.height,
        bytes,
        caption: entry.caption,
        source: entry.source,
        doi: entry.doi,
        url: entry.url,
        sha256: entry.sha256,
        usedIn,
      })
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    registries,
    usage,
    gallery,
  }
}

function copyDirMissing(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return
  fs.mkdirSync(destDir, { recursive: true })
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name)
    const d = path.join(destDir, ent.name)
    if (ent.isDirectory()) copyDirMissing(s, d)
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d)
  }
}

/** Write public and tier-scoped `figures-gallery.json` artifacts and ensure example figures exist in `outDir`. */
export function emitFiguresDistArtifacts(
  outDir: string,
  input: AuditFiguresInput,
): AuditFiguresResult {
  copyDirMissing(input.paths.exampleFiguresDir, path.join(outDir, 'figures'))

  const res = buildFigureAuditAndGallery(input, { verifyFiles: true, isBuild: true })
  if (!res.ok) {
    throw new Error(`[figures] build failed:\n  - ${res.errors.join('\n  - ')}`)
  }
  for (const w of res.warnings) {
    console.warn(`[figures] warning: ${w}`)
  }

  const inlineTier = input.accessPlan.inlineTier
  const publicItems = res.gallery.filter((item) => item.tier === inlineTier)
  fs.writeFileSync(
    path.join(outDir, 'figures-gallery.json'),
    JSON.stringify({ version: 1, items: publicItems } satisfies GalleryPayload) + '\n',
    'utf8',
  )

  for (const tier of input.accessPlan.tiers) {
    const tierItems = res.gallery.filter((item) => item.tier === tier.id)
    const tierOut = path.join(outDir, tierBasePath(tier.id), 'figures-gallery.json')
    fs.mkdirSync(path.dirname(tierOut), { recursive: true })
    fs.writeFileSync(
      tierOut,
      JSON.stringify({ version: 1, items: tierItems } satisfies GalleryPayload) + '\n',
      'utf8',
    )
  }

  return res
}
