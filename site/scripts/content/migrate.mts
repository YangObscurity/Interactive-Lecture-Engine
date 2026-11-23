/**
 * scripts/content/migrate.mts — move an in-place site into a content directory (`npm run content:migrate`).
 *
 * Plan: docs/authoring/README.md (S2). Without `--apply` it only prints the plan.
 * With `--apply` it moves every personal file with `git mv` (so history follows the file), then:
 *   - turns `groups.mts` into plain data in `content/groups.ts` (no engine type import);
 *   - turns `lecture.config.ts` into a plain object in `content/site.config.ts` and writes a neutral engine
 *     default in its place (used only when there is no content directory);
 *   - writes `content/.gitignore`.
 * Nothing is deleted: a source that does not exist is skipped, and an existing target stops the run.
 * Refuses to run when a content root already exists or when the moved paths have uncommitted changes.
 *
 * Options: --apply, --repo <dir> (default: this repository), --content <dir> (default: <repo>/content).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContent } from '../../docs/.vitepress/content/paths.mts'
import { loadTsModule } from '../../docs/.vitepress/content/ts-loader.mts'

const here = path.dirname(fileURLToPath(import.meta.url))

export interface MoveItem {
  from: string
  to: string
  kind: 'dir' | 'file'
}

export interface MigratePlan {
  repoRoot: string
  contentRoot: string
  moves: MoveItem[]
  missing: string[]
  leftInPlace: string[]
}

const posix = (p: string) => p.replace(/\\/g, '/')

/** Files that stay in site/docs/public because they are engine assets or generated output. */
const LEFT_IN_PUBLIC = new Set(['exports', 'showcase', 'favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png'])

export async function planMigration(repoRoot: string, contentRoot = path.join(repoRoot, 'content')): Promise<MigratePlan> {
  // both sides come from the one path module: the in-place layout is the source, the content layout the target
  // S6: LECTURE_DEMO=0 so the engine's fallback demo content does not stand in for the in-place source
  const src = resolveContent({ repoRoot, env: { LECTURE_DEMO: '0' } })
  if (src.mode !== 'in-place') throw new Error(`a content root is already active: ${src.root}`)
  const dst = resolveContent({ repoRoot, env: { LECTURE_CONTENT_DIR: contentRoot } })
  const rel = (abs: string) => posix(path.relative(repoRoot, abs))
  const moves: MoveItem[] = []
  const missing: string[] = []
  const add = (from: string, to: string) => {
    if (!fs.existsSync(from)) {
      missing.push(rel(from))
      return
    }
    moves.push({ from: rel(from), to: rel(to), kind: fs.statSync(from).isDirectory() ? 'dir' : 'file' })
  }

  const dirs: string[] = []
  if (fs.existsSync(src.groups)) {
    const mod = await loadTsModule<{ GROUPS?: unknown; GROUP_META?: unknown }>(src.groups)
    const groups = (mod.GROUPS ?? mod.GROUP_META) as Array<{ dir?: unknown }> | undefined
    for (const g of Array.isArray(groups) ? groups : []) {
      if (typeof g?.dir === 'string' && g.dir.trim()) dirs.push(g.dir.trim())
    }
  }
  // only the top folder of each group moves (a nested group dir moves with its parent)
  const tops = [...new Set(dirs.map((d) => d.split('/')[0]!))].sort()
  for (const top of tops) add(path.join(src.lecturesDir, top), path.join(dst.lecturesDir, top))
  add(src.conceptsDir, dst.conceptsDir)
  add(src.chartsDir, dst.chartsDir)
  add(src.figuresDir, dst.figuresDir)
  for (const k of ['graph', 'graphNotion', 'graphBindings', 'notionKnowledgeGraph'] as const) add(src.graphDir[k], dst.graphDir[k])
  add(path.join(src.publicDir, 'lecture_catalog.json'), path.join(dst.publicDir, 'lecture_catalog.json'))
  add(src.groups, dst.groups)
  add(src.siteConfig, dst.siteConfig)
  add(src.siteTexts, dst.siteTexts)
  add(src.promptsFile, dst.promptsFile)
  add(src.aiToolsFile, dst.aiToolsFile)

  const moved = new Set(moves.map((m) => path.resolve(repoRoot, m.from)))
  const leftInPlace: string[] = []
  if (fs.existsSync(src.publicDir)) {
    for (const e of fs.readdirSync(src.publicDir)) {
      if (moved.has(path.resolve(src.publicDir, e))) continue
      leftInPlace.push(`${rel(path.join(src.publicDir, e))}${LEFT_IN_PUBLIC.has(e) ? '' : '  (unknown: check by hand)'}`)
    }
  }
  return { repoRoot, contentRoot, moves, missing, leftInPlace }
}

/** `groups.mts` → plain data: drop the engine type import, the `GroupMeta` type and the annotation. */
export function toPlainGroups(src: string): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  let out = src.replace(/^import type [^\n]*\n/gm, (m) => (m.includes('./i18n/') ? '' : m))
  const typeStart = out.search(/^export type GroupMeta = \{/m)
  if (typeStart >= 0) {
    // the type block ends at the first line that is exactly "}" after its start
    const after = out.slice(typeStart)
    const end = after.search(/\r?\n\}\r?\n/)
    if (end < 0) throw new Error('groups.mts: cannot find the end of `export type GroupMeta`')
    const blockEnd = typeStart + end + after.slice(end).match(/\r?\n\}\r?\n/)![0].length
    out = out.slice(0, typeStart) + out.slice(blockEnd).replace(/^(\r?\n)+/, '')
  }
  out = out.replace(/export const GROUPS: GroupMeta\[\] =/, 'export const GROUPS =')
  if (/GroupMeta|GroupI18n/.test(out.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))) {
    throw new Error('groups.mts: a type reference is left after the conversion; convert by hand')
  }
  return out.replace(/\r?\n/g, eol)
}

/** `lecture.config.ts` → plain object (the engine validates it on load). */
export function toPlainSiteConfig(src: string): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  let out = src.replace(/^import \{ defineLectureConfig \} from [^\n]*\n/m, '')
  if (!/export default defineLectureConfig\(\{/.test(out)) {
    throw new Error('lecture.config.ts: expected `export default defineLectureConfig({ ... })`; convert by hand')
  }
  out = out.replace(/export default defineLectureConfig\(\{/, 'export default {')
  out = out.replace(/\}\)\s*$/, '}\n')
  out = out.replace(/^(\/\*\*[\s\S]*?\*\/)/, (header) =>
    header.replace(/lecture\.config\.ts[^\n]*/, "site.config.ts — this site's configuration (non-secret), read by the engine's loadLectureConfig()"),
  )
  return out.replace(/\r?\n/g, eol)
}

export const NEUTRAL_ENGINE_CONFIG = `/**
 * lecture.config.ts — the engine's default site configuration.
 *
 * Used only when there is no content directory: a site's own settings live in \`content/site.config.ts\`
 * (or the folder named by LECTURE_CONTENT_DIR), which replaces this file as a whole. The fields are
 * documented in docs/.vitepress/lecture-config.mts. Secrets never go here.
 */
import { defineLectureConfig } from './docs/.vitepress/lecture-config.mts'

export default defineLectureConfig({
  theme: 'datasheet',
  themes: ['reader'],
})
`

export const CONTENT_GITIGNORE = `# content repository: never commit secrets, raw material packs or agent workspaces
.env
.env.*
*.key
*.pem
node_modules/
_raw/
workspaces/
`

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
}

export async function applyMigration(plan: MigratePlan): Promise<void> {
  const { repoRoot, contentRoot } = plan
  for (const m of ['site.config.ts', 'groups.ts']) {
    if (fs.existsSync(path.join(contentRoot, m))) throw new Error(`a content root already exists: ${contentRoot}`)
  }
  for (const m of plan.moves) {
    if (fs.existsSync(path.join(repoRoot, m.to))) throw new Error(`target exists: ${m.to}`)
  }
  const dirty = git(repoRoot, ['status', '--porcelain', '--', ...plan.moves.map((m) => m.from)]).trim()
  if (dirty) throw new Error(`uncommitted changes under the paths to move; commit or stash first:\n${dirty}`)

  for (const m of plan.moves) {
    fs.mkdirSync(path.dirname(path.join(repoRoot, m.to)), { recursive: true })
    git(repoRoot, ['mv', m.from, m.to])
  }
  const groupsTs = path.join(contentRoot, 'groups.ts')
  if (fs.existsSync(groupsTs)) fs.writeFileSync(groupsTs, toPlainGroups(fs.readFileSync(groupsTs, 'utf8')), 'utf8')
  const siteConfig = path.join(contentRoot, 'site.config.ts')
  const engineConfig = resolveContent({ repoRoot, env: {} }).defaultSiteConfig
  if (fs.existsSync(siteConfig)) {
    fs.writeFileSync(siteConfig, toPlainSiteConfig(fs.readFileSync(siteConfig, 'utf8')), 'utf8')
    fs.writeFileSync(engineConfig, NEUTRAL_ENGINE_CONFIG, 'utf8')
  }
  fs.writeFileSync(path.join(contentRoot, '.gitignore'), CONTENT_GITIGNORE, 'utf8')
  git(repoRoot, ['add', '--', posix(path.relative(repoRoot, contentRoot)), posix(path.relative(repoRoot, engineConfig))])
}

const say = (line: string): void => {
  process.stdout.write(line + '\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
  const repoRoot = path.resolve(opt('--repo') ?? path.resolve(here, '..', '..', '..'))
  const contentRoot = path.resolve(repoRoot, opt('--content') ?? 'content')
  const plan = await planMigration(repoRoot, contentRoot)
  say(`[content:migrate] ${repoRoot} -> ${contentRoot}`)
  for (const m of plan.moves) say(`  move ${m.kind.padEnd(4)} ${m.from} -> ${m.to}`)
  for (const m of plan.missing) say(`  skip (absent) ${m}`)
  for (const m of plan.leftInPlace) say(`  stays ${m}`)
  if (!argv.includes('--apply')) {
    say('[content:migrate] dry run; pass --apply to move the files')
    return
  }
  await applyMigration(plan)
  say(`[content:migrate] moved ${plan.moves.length} item(s); run \`npm run content:sync\` and \`npm run build\` next`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[content:migrate] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(3)
  })
}
