/**
 * scripts/build_access_e2e.mjs - builds the dist the `access` Playwright project serves (docs-dev/ACCESS.md section 8).
 *
 *   node scripts/build_access_e2e.mjs        (npm run build:e2e:access; `npm run test:e2e:access` runs it first)
 *
 * S6: built from the engine's demo content (templates/demo-content) with the tiers of its `access.e2e.json`
 * (MEA and LOG inline, PLN `authenticated`, DAT the user group `staff`), through buildDemo of build_e2e.mjs: sync the
 * demo into site/docs, build into `site/.access-e2e/dist` (git-ignored; `docs/.vitepress/dist` is never touched), keep
 * `site/.lecture-build/access-manifest.json` as it was and put the manifest of this build next to the dist
 * (`site/.access-e2e/access-manifest.json`), put site/docs back for the site's own content, then run
 * `check:access:dist` against it, so a leak fails the e2e build before any browser starts.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDemo, E2E_CONTENT_DIR } from './build_e2e.mjs'

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const E2E_ROOT = path.join(SITE_DIR, '.access-e2e')
export const E2E_DIST = path.join(E2E_ROOT, 'dist')
export const E2E_MANIFEST = path.join(E2E_ROOT, 'access-manifest.json')

/** The access tiers of the demo build (templates/demo-content/access.e2e.json), as LECTURE_ACCESS_JSON. */
export const ACCESS_E2E_ENV = {
  LECTURE_ACCESS_JSON: JSON.stringify(JSON.parse(fs.readFileSync(path.join(E2E_CONTENT_DIR, 'access.e2e.json'), 'utf8'))),
}

async function main() {
  const code = await buildDemo({ outDir: E2E_DIST, manifestOut: E2E_MANIFEST, extra: ACCESS_E2E_ENV })
  if (code !== 0) process.exit(code)
  const r = spawnSync(process.execPath, [path.join('scripts', 'check_access_dist.mjs'), '--dist', E2E_DIST, '--manifest', E2E_MANIFEST], {
    cwd: SITE_DIR,
    env: { ...process.env, ...ACCESS_E2E_ENV },
    stdio: 'inherit',
  })
  process.exit(r.status ?? 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
