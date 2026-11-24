/**
 * Build-time / Node loader for group-managed figure registries (`figures.json`).
 * Every disk path resolves strictly via `resolveContent()` (`content/paths.mts`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ContentPaths } from '../content/paths.mts'
import type { FigureEntry, FiguresRegistry } from './types.ts'
import { validateFiguresRegistry } from './validate.ts'

export interface LoadedGroupRegistry {
  group: string
  groupDir: string
  registryPath: string
  registry: FiguresRegistry
  byId: Map<string, FigureEntry>
  warnings: string[]
}

export function figuresRegistryFile(groupDir: string, figuresRoot: string): string {
  return path.join(figuresRoot, ...groupDir.split('/'), 'figures.json')
}

export function figureDiskDir(groupDir: string, figuresRoot: string): string {
  return path.join(figuresRoot, ...groupDir.split('/'))
}

export function resolveGroupForPage(
  relativePath: string,
  groupDirs: readonly string[],
  localeKeys: readonly string[],
): string | null {
  const norm = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = norm.split('/')
  const stripped = parts[0] && localeKeys.includes(parts[0]) ? parts.slice(1).join('/') : norm

  // Longest directory prefix wins so nested dirs like `courses/g01` match cleanly.
  const sortedDirs = [...groupDirs].sort((a, b) => b.length - a.length)
  for (const dir of sortedDirs) {
    if (stripped.startsWith(dir + '/') || stripped === dir) return dir
  }
  const firstSlash = stripped.lastIndexOf('/')
  if (firstSlash <= 0) return null
  return stripped.slice(0, firstSlash)
}

export function loadGroupRegistry(
  group: string,
  paths: Pick<ContentPaths, 'figuresDir'>,
  opts: { verifyFiles?: boolean } = {},
): LoadedGroupRegistry | null {
  const regPath = figuresRegistryFile(group, paths.figuresDir)
  if (!existsSync(regPath)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(regPath, 'utf8'))
  } catch (err) {
    throw new Error(`[figures] failed to parse ${regPath}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const groupDir = figureDiskDir(group, paths.figuresDir)
  const res = validateFiguresRegistry(raw, {
    expectedGroup: group,
    groupDir,
    verifyFiles: opts.verifyFiles ?? false,
  })
  if (!res.ok || !res.registry) {
    throw new Error(`[figures] invalid registry ${regPath}:\n  - ${res.errors.join('\n  - ')}`)
  }
  const byId = new Map<string, FigureEntry>()
  for (const f of res.registry.figures) byId.set(f.id, f)
  return {
    group,
    groupDir,
    registryPath: regPath,
    registry: res.registry,
    byId,
    warnings: res.warnings,
  }
}

/** Discover every directory containing a `figures.json` under a root directory. */
export function discoverFigureGroups(figuresRoot: string): string[] {
  if (!existsSync(figuresRoot)) return []
  const found: string[] = []
  const walk = (dir: string, relParts: string[]) => {
    const regFile = path.join(dir, 'figures.json')
    if (relParts.length > 0 && existsSync(regFile) && statSync(regFile).isFile()) {
      found.push(relParts.join('/'))
      return
    }
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      walk(path.join(dir, ent.name), [...relParts, ent.name])
    }
  }
  walk(figuresRoot, [])
  return found.sort()
}

export function loadAllGroupRegistries(
  paths: Pick<ContentPaths, 'figuresDir'>,
  opts: { verifyFiles?: boolean; extraGroups?: readonly string[] } = {},
): Map<string, LoadedGroupRegistry> {
  const discovered = new Set<string>([
    ...discoverFigureGroups(paths.figuresDir),
    ...(opts.extraGroups ?? []),
  ])
  const out = new Map<string, LoadedGroupRegistry>()
  for (const g of [...discovered].sort()) {
    const loaded = loadGroupRegistry(g, paths, opts)
    if (loaded) out.set(g, loaded)
  }
  return out
}

export function localizeFigureCaption(entry: FigureEntry, localeKey: string): string {
  if (localeKey === 'en') return entry.caption.en || entry.caption.zh
  return entry.caption.zh || entry.caption.en
}

/**
 * The source line under a figure: "出处：<论文>，原文 Fig. 3，第 2 页" / "Source: <paper>, original Fig. 3, p. 2".
 * `source.number` is the paper's own figure number and is labelled as such, so it can't be mistaken for the engine's
 * per-lecture number (图 5-2, figures/numbering.ts). No middle-dot joins (spec board 17; S6Y audit-spec #23).
 */
export function formatFigureSource(entry: FigureEntry, localeKey: string): string {
  const en = localeKey === 'en'
  const hasPage = entry.source.page !== undefined && entry.source.page !== ''
  if (en) {
    let s = `Source: ${entry.source.paper}`
    if (entry.source.number) s += `, original ${entry.source.number}`
    if (hasPage) s += `, p. ${entry.source.page}`
    return s
  }
  let s = `出处：${entry.source.paper}`
  if (entry.source.number) s += `，原文 ${entry.source.number}`
  if (hasPage) s += `，第 ${entry.source.page} 页`
  return s
}
