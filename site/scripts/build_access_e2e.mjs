/**
 * scripts/build_access_e2e.mjs - builds the dist the `access` Playwright project serves (docs-dev/ACCESS.md section 8).
 *
 *   node scripts/build_access_e2e.mjs        (npm run build:e2e:access; `npm run test:e2e:access` runs it first)
 *
 * Three groups with one inline, one `authenticated` and one user-group tier, built into `site/.access-e2e/dist`
 * (git-ignored); `docs/.vitepress/dist` is never touched. The build writes the gateway manifest to the one place the
 * build always writes it (`site/.lecture-build/access-manifest.json`); this script keeps that file as it was and puts
 * the manifest of the e2e build next to the dist (`site/.access-e2e/access-manifest.json`), then runs
 * `check:access:dist` against it, so a leak fails the e2e build before any browser starts.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const E2E_ROOT = path.join(SITE_DIR, '.access-e2e')
export const E2E_DIST = path.join(E2E_ROOT, 'dist')
export const E2E_MANIFEST = path.join(E2E_ROOT, 'access-manifest.json')
const BUILD_MANIFEST = path.join(SITE_DIR, '.lecture-build', 'access-manifest.json')

export const E2E_BUILD_ENV = {
  LECTURE_BUILD_GROUPS: 'G06,G09,G12',
  LECTURE_ACCESS_JSON: JSON.stringify({ default: 'public', enforcement: 'gateway', groups: { G09: { read: 'authenticated' }, G12: { read: ['staff'] } } }),
}

function run(args) {
  const r = spawnSync(process.execPath, args, { cwd: SITE_DIR, env: { ...process.env, ...E2E_BUILD_ENV }, stdio: 'inherit' })
  return r.status ?? 1
}

function main() {
  const before = fs.existsSync(BUILD_MANIFEST) ? fs.readFileSync(BUILD_MANIFEST) : null
  fs.mkdirSync(E2E_ROOT, { recursive: true })
  if (path.relative(SITE_DIR, E2E_DIST).startsWith('..')) throw new Error('refusing to build outside site/')
  fs.rmSync(E2E_DIST, { recursive: true, force: true })
  let code
  try {
    code = run([path.join('scripts', 'build.mjs'), '--outDir', E2E_DIST])
    if (code === 0 && fs.existsSync(BUILD_MANIFEST)) fs.copyFileSync(BUILD_MANIFEST, E2E_MANIFEST)
  } finally {
    if (before) fs.writeFileSync(BUILD_MANIFEST, before)
    else fs.rmSync(BUILD_MANIFEST, { force: true })
  }
  if (code !== 0) process.exit(code)
  process.exit(run([path.join('scripts', 'check_access_dist.mjs'), '--dist', E2E_DIST, '--manifest', E2E_MANIFEST]))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
