/**
 * scripts/content/sync.mts — one-way content sync from `content/` into `site/docs/` (`npm run content:sync`).
 *
 * Rules:
 *   - Does nothing and writes nothing in `in-place` mode (unless `--clean` is run with an existing manifest).
 *   - Copies `lectures/<dir>/**` -> `site/docs/<dir>/`, `charts/**` -> `site/docs/public/charts/`,
 *     `figures/**` -> `site/docs/public/figures/`, and public JSON files -> `site/docs/public/`.
 *   - Translations `lectures/en/<dir>/**` -> `site/docs/en/<dir>/` (no `index.md`, nothing directly under `en/`,
 *     never the engine's own `en/index.md`, `en/dashboard.md` or `en/[group]/`).
 *   - Records every copied file with its SHA-256 and created directories in `site/.lecture-build/content-sync.json`.
 *   - Deletes only stale files that were in the old manifest; never touches files outside the manifest.
 *   - Refuses with exit code 3 if a previously synced copy in `site/docs/` was modified in place (`--force` overwrites).
 *   - Refuses symlinks, `..` segments, absolute paths, and any target outside `site/docs/` (exit code 3).
 *   - Refuses lecture entries colliding with engine pages/directories (`index.md`, `dashboard.md`, `en`, `examples`,
 *     `public`, `.vitepress`) with exit code 3.
 *   - `--clean` removes every file listed in the manifest, empty directories created by sync, and the manifest itself.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContent, type ContentPaths, type ResolveContentOptions } from '../../docs/.vitepress/content/paths.mts'
import { loadTsModule } from '../../docs/.vitepress/content/ts-loader.mts'

export const ENGINE_COLLISION_NAMES = new Set([
  'index.md',
  'dashboard.md',
  'concepts',
  'en',
  'examples',
  'public',
  '.vitepress',
])

/**
 * Translation trees: `lectures/<key>/<group dir>/Lxx.md` -> `site/docs/<key>/<group dir>/Lxx.md` (docs-dev/I18N.md).
 * `en` is the only non-root locale the engine ships today (`zh-CN` is always the root language).
 */
export const TRANSLATION_LOCALE_KEYS: ReadonlySet<string> = new Set(['en'])

/** Engine pages inside a language folder (`site/docs/en/index.md`, `dashboard.md`, the `[group]` route) a translation may not replace. */
export const TRANSLATION_COLLISION_NAMES = new Set(['index.md', 'dashboard.md', 'concepts', 'examples', 'public', '.vitepress'])

export class ContentSyncError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode = 3) {
    super(message)
    this.name = 'ContentSyncError'
    this.exitCode = exitCode
  }
}

export interface SyncManifestEntry {
  sha256: string
  source: string
}

export interface SyncManifest {
  version: 1
  contentRoot: string
  syncedAt: string
  files: Record<string, SyncManifestEntry>
  createdDirs: string[]
}

export interface SyncOptions extends ResolveContentOptions {
  force?: boolean
  clean?: boolean
  contentPaths?: ContentPaths
  manifestFile?: string
  quiet?: boolean
  /** Dev only: also mount `<conceptsDir>/_drafts/*.md` so the draft preview page exists. Never set for a production build. */
  drafts?: boolean
}

export interface SyncResult {
  mode: 'content' | 'in-place'
  cleaned: string[]
  copied: string[]
  updated: string[]
  skipped: string[]
  deleted: string[]
  manifestFile: string
}

interface PlannedFile {
  srcAbs: string
  srcRel: string
  destRel: string
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function sha256File(file: string): string {
  return sha256Buffer(fs.readFileSync(file))
}

function isInsideOrEqual(parentReal: string, childReal: string): boolean {
  const rel = path.relative(parentReal, childReal)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function isStrictlyInside(parentReal: string, childReal: string): boolean {
  const rel = path.relative(parentReal, childReal)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Reject absolute paths, drive prefixes, `..` / `.` segments, empty segments, and backslashes masquerading as escapes. */
export function validateRelativePath(rel: string, label: string): string {
  if (!rel || rel.trim() === '') {
    throw new ContentSyncError(`[content:sync] Refusing empty path in ${label}`, 3)
  }
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\') || path.isAbsolute(rel)) {
    throw new ContentSyncError(`[content:sync] Refusing absolute path "${rel}" in ${label}`, 3)
  }
  const normalized = toPosix(rel)
  const segments = normalized.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new ContentSyncError(`[content:sync] Refusing unsafe path segment "${seg}" in "${rel}" (${label})`, 3)
    }
  }
  return segments.join('/')
}

function assertNoSymlinkPath(abs: string, label: string): void {
  if (!fs.existsSync(abs)) return
  const st = fs.lstatSync(abs)
  if (st.isSymbolicLink()) {
    throw new ContentSyncError(`[content:sync] Refusing symlink "${abs}" (${label})`, 3)
  }
}

/** Walk `docsRoot` ancestors down to `targetFile` ensuring no existing intermediate segment is a symlink. */
function assertSafeDestTarget(docsRoot: string, realDocsRoot: string, destRel: string): string {
  const safeRel = validateRelativePath(destRel, 'destination')
  const absDest = path.resolve(docsRoot, safeRel)
  if (!isStrictlyInside(realDocsRoot, absDest)) {
    throw new ContentSyncError(`[content:sync] Refusing target outside site/docs/: "${destRel}"`, 3)
  }
  let curr = docsRoot
  for (const seg of safeRel.split('/')) {
    curr = path.join(curr, seg)
    if (fs.existsSync(curr)) {
      const st = fs.lstatSync(curr)
      if (st.isSymbolicLink()) {
        throw new ContentSyncError(`[content:sync] Refusing symlink in destination path: "${curr}"`, 3)
      }
    }
  }
  return absDest
}

function walkContentDir(
  sourceRoot: string,
  destPrefix: string,
  contentRoot: string,
  realContentRoot: string,
  docsRoot: string,
  realDocsRoot: string,
  out: PlannedFile[],
  options: {
    checkLectureCollisions?: boolean
    onlyJson?: boolean
    skipPublicSubdirs?: boolean
    /** Top-level directories walked separately (translation trees under `lectures/`). */
    skipTopLevel?: ReadonlySet<string>
    /** A translation tree (`lectures/<locale key>/`): engine pages of that language and `index.md` are refused. */
    translationTree?: boolean
  } = {},
): void {
  if (!fs.existsSync(sourceRoot)) return
  assertNoSymlinkPath(sourceRoot, 'content directory')
  if (!fs.statSync(sourceRoot).isDirectory()) {
    throw new ContentSyncError(`[content:sync] Expected directory at "${sourceRoot}"`, 3)
  }

  const walk = (currDir: string, relPrefix: string, depth: number): void => {
    const entries = fs.readdirSync(currDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absEntry = path.join(currDir, entry.name)
      if (entry.isSymbolicLink() || fs.lstatSync(absEntry).isSymbolicLink()) {
        throw new ContentSyncError(`[content:sync] Refusing symlink inside content directory: "${absEntry}"`, 3)
      }
      if (entry.name === '.' || entry.name === '..') {
        throw new ContentSyncError(`[content:sync] Refusing unsafe entry "${entry.name}" in "${currDir}"`, 3)
      }
      if (depth === 0 && options.skipTopLevel?.has(entry.name) && entry.isDirectory()) {
        continue
      }
      if (depth === 0 && options.checkLectureCollisions && ENGINE_COLLISION_NAMES.has(entry.name.toLowerCase())) {
        throw new ContentSyncError(
          `[content:sync] Refusing lecture entry "${entry.name}": collides with engine page or directory (${[...ENGINE_COLLISION_NAMES].join(', ')})`,
          3,
        )
      }
      if (options.translationTree) {
        if (depth === 0 && entry.isFile()) {
          throw new ContentSyncError(
            `[content:sync] Refusing translation "${absEntry}": translations live in <locale>/<group dir>/Lxx.md, not directly under the language folder`,
            3,
          )
        }
        if (depth === 0 && (TRANSLATION_COLLISION_NAMES.has(entry.name.toLowerCase()) || entry.name.startsWith('['))) {
          throw new ContentSyncError(
            `[content:sync] Refusing translation entry "${relPrefix ? `${relPrefix}/` : ''}${entry.name}" in ${sourceRoot}: collides with an engine page of that language`,
            3,
          )
        }
        if (entry.isFile() && entry.name.toLowerCase() === 'index.md') {
          throw new ContentSyncError(
            `[content:sync] Refusing translation "${absEntry}": group pages of other languages are generated from groups.ts (i18n), not written as index.md`,
            3,
          )
        }
      }
      if (depth === 0 && options.skipPublicSubdirs && entry.isDirectory() && (entry.name === 'charts' || entry.name === 'figures')) {
        continue
      }

      const realEntry = fs.realpathSync(absEntry)
      if (!isInsideOrEqual(realContentRoot, realEntry)) {
        throw new ContentSyncError(`[content:sync] Refusing path escaping content root: "${absEntry}" -> "${realEntry}"`, 3)
      }

      const entryRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(absEntry, entryRel, depth + 1)
      } else if (entry.isFile()) {
        if (options.onlyJson && !entry.name.toLowerCase().endsWith('.json')) continue
        const destRel = destPrefix ? `${destPrefix}/${entryRel}` : entryRel
        assertSafeDestTarget(docsRoot, realDocsRoot, destRel)
        const srcRel = validateRelativePath(toPosix(path.relative(contentRoot, absEntry)), 'source')
        out.push({ srcAbs: absEntry, srcRel, destRel })
      }
    }
  }

  walk(sourceRoot, '', 0)
}

async function validateGroupsDirs(paths: ContentPaths): Promise<void> {
  if (!fs.existsSync(paths.groups)) return
  assertNoSymlinkPath(paths.groups, 'groups.ts')
  try {
    const mod = await loadTsModule(paths.groups)
    const rawGroups = mod.GROUPS ?? mod.GROUP_META
    if (!Array.isArray(rawGroups)) return
    for (const item of rawGroups) {
      if (!item || typeof item !== 'object') continue
      const dir = (item as { dir?: unknown }).dir
      if (typeof dir !== 'string') continue
      const safe = validateRelativePath(dir, 'groups.ts dir')
      const top = safe.split('/')[0] ?? ''
      if (ENGINE_COLLISION_NAMES.has(top.toLowerCase())) {
        throw new ContentSyncError(
          `[content:sync] Refusing group dir "${dir}" in groups.ts: collides with engine directory "${top}"`,
          3,
        )
      }
    }
  } catch (err) {
    if (err instanceof ContentSyncError) throw err
    // Syntax/runtime issues in groups.ts are reported by groups-source/build, not masked here
  }
}

function readManifest(manifestFile: string, docsRoot: string, realDocsRoot: string): SyncManifest | null {
  if (!fs.existsSync(manifestFile)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (err) {
    throw new ContentSyncError(
      `[content:sync] Invalid manifest JSON at ${manifestFile}: ${err instanceof Error ? err.message : String(err)}`,
      3,
    )
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    throw new ContentSyncError(`[content:sync] Unsupported manifest format in ${manifestFile}`, 3)
  }
  const m = parsed as SyncManifest
  const files = m.files && typeof m.files === 'object' ? m.files : {}
  for (const destRel of Object.keys(files)) {
    assertSafeDestTarget(docsRoot, realDocsRoot, destRel)
  }
  const createdDirs = Array.isArray(m.createdDirs) ? m.createdDirs : []
  for (const dirRel of createdDirs) {
    assertSafeDestTarget(docsRoot, realDocsRoot, dirRel)
  }
  return {
    version: 1,
    contentRoot: typeof m.contentRoot === 'string' ? m.contentRoot : '',
    syncedAt: typeof m.syncedAt === 'string' ? m.syncedAt : '',
    files,
    createdDirs,
  }
}

function ensureDirTracked(absDir: string, docsRoot: string, createdDirs: Set<string>): void {
  if (fs.existsSync(absDir)) return
  const missing: string[] = []
  let curr = absDir
  while (curr !== docsRoot && !fs.existsSync(curr)) {
    missing.push(curr)
    const parent = path.dirname(curr)
    if (parent === curr) break
    curr = parent
  }
  fs.mkdirSync(absDir, { recursive: true })
  for (const d of missing) {
    const rel = toPosix(path.relative(docsRoot, d))
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      createdDirs.add(rel)
    }
  }
}

function pruneEmptyDirs(docsRoot: string, realDocsRoot: string, createdDirs: Set<string>): void {
  const ordered = [...createdDirs].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a))
  for (const dirRel of ordered) {
    const absDir = assertSafeDestTarget(docsRoot, realDocsRoot, dirRel)
    if (!fs.existsSync(absDir)) {
      createdDirs.delete(dirRel)
      continue
    }
    const entries = fs.readdirSync(absDir)
    if (entries.length === 0) {
      fs.rmdirSync(absDir)
      createdDirs.delete(dirRel)
    }
  }
}

/** Remove every file listed in `content-sync.json`, prune empty created directories, and delete the manifest. */
export function cleanSyncedContent(options: SyncOptions = {}): SyncResult {
  const paths = options.contentPaths ?? resolveContent(options)
  const docsRoot = paths.docsRoot
  const realDocsRoot = fs.realpathSync(docsRoot)
  const manifestFile = options.manifestFile ?? path.join(paths.siteRoot, '.lecture-build', 'content-sync.json')
  const manifest = readManifest(manifestFile, docsRoot, realDocsRoot)
  const cleaned: string[] = []

  if (!manifest) {
    return {
      mode: paths.mode,
      cleaned,
      copied: [],
      updated: [],
      skipped: [],
      deleted: [],
      manifestFile,
    }
  }

  for (const destRel of Object.keys(manifest.files)) {
    const absDest = assertSafeDestTarget(docsRoot, realDocsRoot, destRel)
    if (fs.existsSync(absDest)) {
      fs.rmSync(absDest, { force: true })
      cleaned.push(destRel)
    }
  }

  const dirs = new Set(manifest.createdDirs)
  pruneEmptyDirs(docsRoot, realDocsRoot, dirs)
  fs.rmSync(manifestFile, { force: true })

  if (!options.quiet) {
    process.stdout.write(`[content:sync] cleaned ${cleaned.length} file(s) and removed manifest\n`)
  }
  return {
    mode: paths.mode,
    cleaned,
    copied: [],
    updated: [],
    skipped: [],
    deleted: cleaned,
    manifestFile,
  }
}

/** Synchronize content files into `site/docs/` and update `site/.lecture-build/content-sync.json`. */
export async function syncContent(options: SyncOptions = {}): Promise<SyncResult> {
  if (options.clean) {
    return cleanSyncedContent(options)
  }

  const paths = options.contentPaths ?? resolveContent(options)
  const manifestFile = options.manifestFile ?? path.join(paths.siteRoot, '.lecture-build', 'content-sync.json')

  if (paths.mode === 'in-place') {
    return {
      mode: 'in-place',
      cleaned: [],
      copied: [],
      updated: [],
      skipped: [],
      deleted: [],
      manifestFile,
    }
  }

  if (!fs.existsSync(paths.root)) {
    throw new ContentSyncError(`[content:sync] Content directory does not exist: ${paths.root}`, 3)
  }
  assertNoSymlinkPath(paths.root, 'content root')
  if (!fs.statSync(paths.root).isDirectory()) {
    throw new ContentSyncError(`[content:sync] Content root is not a directory: ${paths.root}`, 3)
  }
  assertNoSymlinkPath(paths.docsRoot, 'site/docs')
  if (fs.existsSync(paths.siteConfig)) assertNoSymlinkPath(paths.siteConfig, 'site.config.ts')

  const realContentRoot = fs.realpathSync(paths.root)
  const realDocsRoot = fs.realpathSync(paths.docsRoot)

  await validateGroupsDirs(paths)

  const planned: PlannedFile[] = []
  walkContentDir(paths.lecturesDir, '', paths.root, realContentRoot, paths.docsRoot, realDocsRoot, planned, {
    checkLectureCollisions: true,
    skipTopLevel: TRANSLATION_LOCALE_KEYS,
  })
  for (const key of TRANSLATION_LOCALE_KEYS) {
    walkContentDir(path.join(paths.lecturesDir, key), key, paths.root, realContentRoot, paths.docsRoot, realDocsRoot, planned, {
      translationTree: true,
    })
  }
  if (fs.existsSync(paths.conceptsDir)) {
    assertNoSymlinkPath(paths.conceptsDir, 'concepts')
    for (const entry of fs.readdirSync(paths.conceptsDir, { withFileTypes: true })) {
      // Never sync `_drafts/` into site/docs during production or content sync
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const absSrc = path.join(paths.conceptsDir, entry.name)
      assertNoSymlinkPath(absSrc, `concepts/${entry.name}`)
      const realSrc = fs.realpathSync(absSrc)
      if (!isInsideOrEqual(realContentRoot, realSrc)) {
        throw new ContentSyncError(`[content:sync] Refusing path escaping content root: "${absSrc}"`, 3)
      }
      const destRel = `concepts/${entry.name}`
      assertSafeDestTarget(paths.docsRoot, realDocsRoot, destRel)
      planned.push({
        srcAbs: absSrc,
        srcRel: validateRelativePath(toPosix(path.relative(paths.root, absSrc)), 'source'),
        destRel,
      })
    }
    const draftsDir = path.join(paths.conceptsDir, '_drafts')
    if (options.drafts && fs.existsSync(draftsDir)) {
      assertNoSymlinkPath(draftsDir, 'concepts/_drafts')
      for (const entry of fs.readdirSync(draftsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const absSrc = path.join(draftsDir, entry.name)
        assertNoSymlinkPath(absSrc, `concepts/_drafts/${entry.name}`)
        const realSrc = fs.realpathSync(absSrc)
        if (!isInsideOrEqual(realContentRoot, realSrc)) {
          throw new ContentSyncError(`[content:sync] Refusing path escaping content root: "${absSrc}"`, 3)
        }
        const destRel = `concepts/_drafts/${entry.name}`
        assertSafeDestTarget(paths.docsRoot, realDocsRoot, destRel)
        planned.push({
          srcAbs: absSrc,
          srcRel: validateRelativePath(toPosix(path.relative(paths.root, absSrc)), 'source'),
          destRel,
        })
      }
    }
  }
  walkContentDir(paths.chartsDir, 'public/charts', paths.root, realContentRoot, paths.docsRoot, realDocsRoot, planned)
  walkContentDir(paths.figuresDir, 'public/figures', paths.root, realContentRoot, paths.docsRoot, realDocsRoot, planned)

  const seenDest = new Set(planned.map((p) => p.destRel))

  if (fs.existsSync(paths.graphDir.notionKnowledgeGraph)) {
    assertNoSymlinkPath(paths.graphDir.notionKnowledgeGraph, 'notion_knowledge_graph.json')
    const realGraph = fs.realpathSync(paths.graphDir.notionKnowledgeGraph)
    if (!isInsideOrEqual(realContentRoot, realGraph)) {
      throw new ContentSyncError(
        `[content:sync] Refusing path escaping content root: "${paths.graphDir.notionKnowledgeGraph}"`,
        3,
      )
    }
    if (fs.statSync(paths.graphDir.notionKnowledgeGraph).isFile()) {
      const destRel = 'public/notion_knowledge_graph.json'
      assertSafeDestTarget(paths.docsRoot, realDocsRoot, destRel)
      planned.push({
        srcAbs: paths.graphDir.notionKnowledgeGraph,
        srcRel: validateRelativePath(toPosix(path.relative(paths.root, paths.graphDir.notionKnowledgeGraph)), 'source'),
        destRel,
      })
      seenDest.add(destRel)
    }
  }

  const publicFiles: PlannedFile[] = []
  walkContentDir(paths.publicDir, 'public', paths.root, realContentRoot, paths.docsRoot, realDocsRoot, publicFiles, {
    onlyJson: true,
    skipPublicSubdirs: true,
  })
  for (const pf of publicFiles) {
    if (!seenDest.has(pf.destRel)) {
      planned.push(pf)
      seenDest.add(pf.destRel)
    }
  }

  const oldManifest = readManifest(manifestFile, paths.docsRoot, realDocsRoot)

  // Check for in-place modifications on all previously synced files BEFORE modifying anything on disk.
  if (!options.force) {
    const plannedByDest = new Map(planned.map((p) => [p.destRel, p.srcAbs]))
    for (const [destRel, entry] of Object.entries(oldManifest?.files ?? {})) {
      const absDest = assertSafeDestTarget(paths.docsRoot, realDocsRoot, destRel)
      if (!fs.existsSync(absDest)) continue
      const diskHash = sha256File(absDest)
      // The engine's dev tools (concept workflow, e2e helpers) write the source and its copy together:
      // a copy that already equals its current source is not a local edit.
      const src = plannedByDest.get(destRel)
      if (diskHash !== entry.sha256 && !(src && sha256File(src) === diskHash)) {
        throw new ContentSyncError(
          `[content:sync] Refusing to overwrite locally modified file "${destRel}": ` +
            `edit the source in content/ (${paths.root}) instead, or pass --force to overwrite.`,
          3,
        )
      }
    }
    // A file that is not in the manifest is not ours (an engine file or a lecture still living in site/docs/):
    // never overwrite it with different content.
    for (const item of planned) {
      if (oldManifest?.files[item.destRel]) continue
      const absDest = assertSafeDestTarget(paths.docsRoot, realDocsRoot, item.destRel)
      if (fs.existsSync(absDest) && sha256File(absDest) !== sha256File(item.srcAbs)) {
        throw new ContentSyncError(
          `[content:sync] Refusing to overwrite "${item.destRel}": it exists in site/docs/ but was not copied by content:sync. ` +
            'Move or remove it, or pass --force to overwrite.',
          3,
        )
      }
    }
  }

  const createdDirs = new Set<string>(oldManifest?.createdDirs ?? [])
  const nextFiles: Record<string, SyncManifestEntry> = {}
  const copied: string[] = []
  const updated: string[] = []
  const skipped: string[] = []
  const deleted: string[] = []

  // Delete stale files that existed in oldManifest but are no longer present in content/.
  if (oldManifest) {
    for (const destRel of Object.keys(oldManifest.files)) {
      if (seenDest.has(destRel)) continue
      const absDest = assertSafeDestTarget(paths.docsRoot, realDocsRoot, destRel)
      if (fs.existsSync(absDest)) {
        fs.rmSync(absDest, { force: true })
        deleted.push(destRel)
      }
    }
  }

  for (const item of planned) {
    const absDest = assertSafeDestTarget(paths.docsRoot, realDocsRoot, item.destRel)
    const buf = fs.readFileSync(item.srcAbs)
    const srcHash = sha256Buffer(buf)
    const existed = fs.existsSync(absDest)
    const prevHash = existed ? sha256File(absDest) : null

    if (prevHash === srcHash) {
      skipped.push(item.destRel)
      // an identical file we did not write stays unmanaged: `--clean` must never delete it
      if (!oldManifest?.files[item.destRel]) continue
    } else {
      ensureDirTracked(path.dirname(absDest), paths.docsRoot, createdDirs)
      fs.writeFileSync(absDest, buf)
      if (existed) updated.push(item.destRel)
      else copied.push(item.destRel)
    }
    nextFiles[item.destRel] = { sha256: srcHash, source: item.srcRel }
  }

  pruneEmptyDirs(paths.docsRoot, realDocsRoot, createdDirs)

  const manifest: SyncManifest = {
    version: 1,
    contentRoot: paths.root,
    syncedAt: new Date().toISOString(),
    files: nextFiles,
    createdDirs: [...createdDirs].sort(),
  }
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  if (!options.quiet) {
    process.stdout.write(
      `[content:sync] ${paths.root} -> site/docs/: ${copied.length} copied, ${updated.length} updated, ${deleted.length} deleted, ${skipped.length} unchanged\n`,
    )
  }

  return {
    mode: 'content',
    cleaned: [],
    copied,
    updated,
    skipped,
    deleted,
    manifestFile,
  }
}

export function parseSyncArgs(argv: readonly string[]): { clean: boolean; force: boolean; quiet: boolean; drafts: boolean } {
  return {
    clean: argv.includes('--clean'),
    force: argv.includes('--force'),
    quiet: argv.includes('--quiet'),
    drafts: argv.includes('--drafts'),
  }
}

async function main(): Promise<void> {
  const args = parseSyncArgs(process.argv.slice(2))
  await syncContent(args)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    if (err instanceof ContentSyncError) {
      console.error(err.message)
      process.exit(err.exitCode)
    }
    console.error(`[content:sync] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
