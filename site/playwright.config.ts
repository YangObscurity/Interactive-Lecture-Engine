/**
 * Playwright config.
 *
 * Two projects against the same specs:
 *   - prod: the demo-content build of `npm run build:e2e` (site/.e2e-demo/dist, from templates/demo-content) served by
 *           tests/e2e/access-server.mjs on 4174 (`npm run test:e2e:prod` builds and runs it)
 *   - dev : `vitepress dev` on 5174 (the V2 dev port; 5173 is reserved for V1), started by scripts/dev_e2e.mjs on a copy
 *           of the same demo content (site/.e2e-demo/content); tests/e2e/dev-teardown.ts puts site/docs back afterwards
 * The ports can be moved with E2E_PROD_PORT / E2E_DEV_PORT (defaults as above).
 *
 * Locally we drive the installed Google Chrome (`channel: 'chrome'`) so no browser download is
 * needed; on CI we use Playwright's bundled chromium.
 *
 * All specs import `test` from tests/e2e/fixtures.ts, which routes every `**\/api/**` request to
 * local fixtures — the real backend is never reached.
 */
import { defineConfig, devices } from '@playwright/test'

const CI = !!process.env.CI
// Two checkouts can run e2e at the same time: E2E_PROD_PORT / E2E_DEV_PORT move the servers off the defaults.
const PROD_PORT = Number(process.env.E2E_PROD_PORT ?? 4174)
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 5174)
// P3b: the `access` project serves its own dist (npm run build:e2e:access) with tests/e2e/access-server.mjs
const ACCESS_PORT = Number(process.env.E2E_ACCESS_PORT ?? 4374)
const ACCESS_SPEC = '**/access.spec.ts'
// S6: the dist of `npm run build:e2e` (scripts/build_e2e.mjs): the engine's demo content, never the site's own lectures
const E2E_DEMO_DIST = '.e2e-demo/dist'

/**
 * Playwright starts every `webServer` entry regardless of `--project`, so only launch the servers
 * for the projects actually selected on the command line (no `--project` = prod and dev; `access` only when asked for).
 */
function selectedProjects(): Set<string> {
  const argv = process.argv
  const out = new Set<string>()
  argv.forEach((a, i) => {
    if (a === '--project' && argv[i + 1]) out.add(argv[i + 1])
    else if (a.startsWith('--project=')) out.add(a.slice('--project='.length))
  })
  return out.size ? out : new Set(['prod', 'dev'])
}
const wanted = selectedProjects()

const browserUse = CI
  ? { ...devices['Desktop Chrome'] }
  : { ...devices['Desktop Chrome'], channel: 'chrome' as const }

export default defineConfig({
  testDir: 'tests/e2e',
  snapshotPathTemplate: 'tests/e2e/__screenshots__/{testFilePath}/{projectName}/{arg}{ext}',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: CI,
  workers: 2,
  retries: CI ? 1 : 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: Number(process.env.VISUAL_TOLERANCE ?? 0),
      animations: 'disabled',
      caret: 'hide',
    },
  },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'prod',
      testIgnore: ACCESS_SPEC,
      use: { ...browserUse, baseURL: `http://127.0.0.1:${PROD_PORT}` },
    },
    {
      name: 'dev',
      testIgnore: ACCESS_SPEC,
      use: { ...browserUse, baseURL: `http://127.0.0.1:${DEV_PORT}` },
    },
    // P3b access tiers: a dist built with three groups in three tiers, a gateway simulated with page.route
    // (docs-dev/ACCESS.md section 8). Listed only when selected (`--project access`), so a plain `playwright test` does not run it;
    // worker processes re-read this file without the command line and must know the project (TEST_WORKER_INDEX is set there).
    ...(wanted.has('access') || process.env.TEST_WORKER_INDEX !== undefined
      ? [
          {
            name: 'access',
            testMatch: ACCESS_SPEC,
            use: { ...browserUse, baseURL: `http://127.0.0.1:${ACCESS_PORT}` },
          },
        ]
      : []),
  ],
  webServer: [
    wanted.has('prod') && {
      // S6: the prod project runs on the engine's demo content (templates/demo-content), built by `npm run build:e2e`
      // into its own folder; `docs/.vitepress/dist` (the site's own build, the one that is deployed) is not served here
      command: `node tests/e2e/access-server.mjs --dir ${E2E_DEMO_DIST} --port ${PROD_PORT}`,
      url: `http://127.0.0.1:${PROD_PORT}/`,
      reuseExistingServer: !CI,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    wanted.has('access') && {
      command: `node tests/e2e/access-server.mjs --dir .access-e2e/dist --port ${ACCESS_PORT}`,
      url: `http://127.0.0.1:${ACCESS_PORT}/`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    wanted.has('dev') && {
      // S6 decision B: the dev project runs on a throw-away copy of the demo content (site/.e2e-demo/content, synced into
      // site/docs, LECTURE_CONTENT_DIR at the copy; Dashboard / concept writes land in the copy). site/docs is put back
      // for the site's own content by tests/e2e/dev-teardown.ts (or the script's own exit / next start / --restore).
      command: `node scripts/dev_e2e.mjs --port ${DEV_PORT}`,
      url: `http://127.0.0.1:${DEV_PORT}/`,
      // never reuse a server already on the port: it could be `npm run dev` on the site's own lectures
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ].filter((x): x is Exclude<typeof x, false> => Boolean(x)),
  // the dev server script swaps site/docs to the demo copy: put it back (Playwright stops web servers with taskkill /F on Windows)
  ...(wanted.has('dev') ? { globalTeardown: './tests/e2e/dev-teardown.ts' } : {}),
})
