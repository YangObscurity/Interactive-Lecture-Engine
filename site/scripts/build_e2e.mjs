/**
 * scripts/build_e2e.mjs - builds the engine's demo content (templates/demo-content, also the fallback content of a site
 * without its own) into the dist the `prod` Playwright project serves (`npm run build:e2e`; `npm run test:e2e:prod`
 * runs it first).
 *
 *   node scripts/build_e2e.mjs
 *
 * The e2e suites never run on a site's own lectures: this script copies the demo content to `site/.e2e-demo/content`
 * with its e2e site config (prepareDemoCopy), syncs that copy into site/docs with LECTURE_CONTENT_DIR, builds into `site/.e2e-demo/dist` (git-ignored; `docs/.vitepress/dist` is never touched) and then
 * puts site/docs back the way the site's own build expects it: `content:sync` of the site's own content folder, or
 * `content:sync --clean` when there is none (in-place mode). So the next `npm run build` / `npm run dev` shows only the
 * site's own content (their prebuild / predev sync would repair it anyway, even after an interrupted e2e build).
 * The gateway manifest the build writes to `site/.lecture-build/access-manifest.json` is kept as it was; the one of the
 * e2e build goes next to its dist.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The engine's demo content (read only: also the fallback site of a clone without content of its own). */
export const E2E_CONTENT_DIR = path.resolve(SITE_DIR, '..', 'templates', 'demo-content')
export const E2E_ROOT = path.join(SITE_DIR, '.e2e-demo')
/** The throw-away copy every e2e build and the dev project run on (git-ignored with site/.e2e-demo/). */
export const E2E_CONTENT_COPY = path.join(E2E_ROOT, 'content')
export const E2E_DIST = path.join(E2E_ROOT, 'dist')
export const E2E_MANIFEST = path.join(E2E_ROOT, 'access-manifest.json')
const BUILD_MANIFEST = path.join(SITE_DIR, '.lecture-build', 'access-manifest.json')
const SYNC = path.join('scripts', 'content', 'sync.mts')

/**
 * Fresh copy of the demo content for the e2e suites (S6 decision B): templates/demo-content -> site/.e2e-demo/content,
 * with `e2e/site.config.ts` (the backend paths the specs mock: progress rest, trusted-header, companion proxy) in place
 * of the demo's own backend-free site.config.ts and without the e2e/ folder. Writes of the dev project's Dashboard and
 * concept tests land in this copy; the demo content itself is never changed. Returns the copy's path.
 */
export function prepareDemoCopy(copyDir = E2E_CONTENT_COPY) {
  const rel = path.relative(E2E_ROOT, copyDir)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`refusing to copy the demo content to ${copyDir}: it must lie below site/.e2e-demo/`)
  fs.rmSync(copyDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(copyDir), { recursive: true })
  fs.cpSync(E2E_CONTENT_DIR, copyDir, { recursive: true })
  fs.copyFileSync(path.join(copyDir, 'e2e', 'site.config.ts'), path.join(copyDir, 'site.config.ts'))
  fs.rmSync(path.join(copyDir, 'e2e'), { recursive: true, force: true })
  return copyDir
}

/** Environment of every step that must see the demo content (the copy). `extra` (e.g. LECTURE_ACCESS_JSON) on top. */
export function demoEnv(extra = {}) {
  return { ...process.env, LECTURE_CONTENT_DIR: E2E_CONTENT_COPY, ...extra }
}

/** The environment without the demo: the site's own content (LECTURE_CONTENT_DIR as the caller had it, or none). */
function ownEnv() {
  return { ...process.env }
}

function run(args, env) {
  const r = spawnSync(process.execPath, args, { cwd: SITE_DIR, env, stdio: 'inherit' })
  return r.status ?? 1
}

/**
 * Make a fresh demo copy (prepareDemoCopy) and sync it into site/docs. `args` go to content:sync (the dev project
 * passes `--drafts`, as `npm run dev` does). Exit code of content:sync.
 */
export function syncDemo(extra = {}, args = []) {
  prepareDemoCopy()
  return run([SYNC, ...args], demoEnv(extra))
}

/**
 * Put site/docs back for the site's own build: sync its own content folder, or remove every synced copy when the site
 * has none (in-place mode, e.g. the engine repository). Exit code of content:sync.
 */
export async function restoreOwnContent() {
  const { resolveContent } = await import('../docs/.vitepress/content/paths.mts')
  const own = ownEnv()
  const mode = resolveContent({ env: own }).mode
  return run(mode === 'content' ? [SYNC] : [SYNC, '--clean'], own)
}

/** The only folders an e2e build may write into (and empty first): below site/.e2e-demo/ or site/.access-e2e/. */
export const E2E_OUT_ROOTS = [E2E_ROOT, path.join(SITE_DIR, '.access-e2e')]

/** Throws unless `outDir` lies strictly below one of E2E_OUT_ROOTS (the roots themselves and site/ are refused). */
export function assertE2eOutDir(outDir) {
  const abs = path.resolve(SITE_DIR, outDir)
  const inside = E2E_OUT_ROOTS.some((root) => {
    const rel = path.relative(root, abs)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  })
  if (!inside) {
    throw new Error(`refusing to build the demo into ${abs}: the output must lie below site/.e2e-demo/ or site/.access-e2e/`)
  }
  return abs
}

/** Sync the demo, build it into `outDir` with `extra` env, restore site/docs. Returns the exit code. */
export async function buildDemo({ outDir = E2E_DIST, manifestOut = E2E_MANIFEST, extra = {} } = {}) {
  outDir = assertE2eOutDir(outDir)
  manifestOut = assertE2eOutDir(manifestOut)
  const before = fs.existsSync(BUILD_MANIFEST) ? fs.readFileSync(BUILD_MANIFEST) : null
  fs.mkdirSync(path.dirname(outDir), { recursive: true })
  fs.rmSync(outDir, { recursive: true, force: true })
  let code
  try {
    code = syncDemo(extra)
    if (code === 0) code = run([path.join('scripts', 'build.mjs'), '--outDir', outDir], demoEnv(extra))
    if (code === 0 && fs.existsSync(BUILD_MANIFEST)) fs.copyFileSync(BUILD_MANIFEST, manifestOut)
  } finally {
    if (before) fs.writeFileSync(BUILD_MANIFEST, before)
    else fs.rmSync(BUILD_MANIFEST, { force: true })
    const restored = await restoreOwnContent()
    if (restored !== 0) {
      console.error('[build:e2e] could not put site/docs back for the site\'s own content: run `npm run content:sync` before `npm run build`')
      code ||= restored
    }
  }
  return code
}

async function main() {
  const code = await buildDemo()
  if (code !== 0) process.exit(code)
  console.log(`[build:e2e] demo content built into ${path.relative(SITE_DIR, E2E_DIST)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
