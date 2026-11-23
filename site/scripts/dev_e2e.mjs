/**
 * scripts/dev_e2e.mjs - the dev server of the `dev` Playwright project, on the engine's demo content (S6 decision B).
 *
 *   node scripts/dev_e2e.mjs [--port 5174]     start (what playwright.config.ts runs for the dev project)
 *   node scripts/dev_e2e.mjs --restore         clean up after an interrupted run: stop its server, put site/docs back
 *
 * Start: a fresh copy of templates/demo-content in site/.e2e-demo/content with its e2e site config (prepareDemoCopy of
 * build_e2e.mjs), `content:sync --drafts` of that copy into site/docs (as `npm run dev` does for the site's own content),
 * then `vitepress dev docs` with LECTURE_CONTENT_DIR pointing at the copy. The copy is a content folder of its own, so
 * the Dashboard's write endpoints and concept drafting are open (not the read-only demo fallback) and write into the copy;
 * templates/demo-content itself is never changed.
 *
 * Stop: site/docs goes back to the site's own content (restoreOwnContent: `content:sync` of its content folder, or
 * `content:sync --clean` when it has none). That happens
 *   - here, when vitepress exits or this process gets Ctrl-C / SIGTERM / SIGHUP / SIGBREAK;
 *   - in the Playwright global teardown (tests/e2e/dev-teardown.ts), which kills this server first: on Windows Playwright
 *     ends its web servers with `taskkill /T /F`, which no signal handler survives;
 *   - on the next start or with `--restore`, when the state file site/.e2e-demo/dev-server.json is still there because
 *     the run was killed outright. (`npm run dev` / `npm run build` also repair site/docs with their own content:sync.)
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_ROOT, demoEnv, restoreOwnContent, syncDemo } from './build_e2e.mjs'

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Present while a dev e2e server owns site/docs: { pid, childPid, port, startedAt }. */
export const DEV_STATE_FILE = path.join(E2E_ROOT, 'dev-server.json')
const VITEPRESS = path.join(SITE_DIR, 'node_modules', 'vitepress', 'bin', 'vitepress.js')
// stderr: Playwright shows a web server's stderr (stdout is ignored in playwright.config.ts)
const log = (msg) => console.error(`[dev:e2e] ${msg}`)

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(DEV_STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

/** Kill a process and everything it started (no signal handler runs: this is the cleanup of last resort). */
function killTree(pid) {
  if (!alive(pid)) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

async function waitGone(pids, ms = 15_000) {
  const end = Date.now() + ms
  while (pids.some(alive) && Date.now() < end) await new Promise((r) => setTimeout(r, 200))
}

/**
 * Stop the dev e2e server recorded in the state file (if any is still running), put site/docs back for the site's own
 * content and remove the state file. Does nothing without a state file. Returns content:sync's exit code (0 when idle).
 */
export async function teardownDevServer(reason = 'teardown') {
  const state = readState()
  if (!state) return 0
  const pids = [state.pid, state.childPid].filter((p) => Number.isInteger(p) && p !== process.pid)
  for (const p of pids) killTree(p)
  await waitGone(pids)
  log(`${reason}: putting site/docs back for the site's own content`)
  const code = await restoreOwnContent()
  if (code === 0) fs.rmSync(DEV_STATE_FILE, { force: true })
  else log('could not put site/docs back: run `npm run content:sync` (or `node scripts/dev_e2e.mjs --restore`)')
  return code
}

function portArg(argv) {
  const i = argv.indexOf('--port')
  const raw = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--port='))?.slice('--port='.length)
  return Number(raw ?? process.env.E2E_DEV_PORT ?? 5174)
}

async function start(port) {
  const prev = readState()
  if (prev) {
    if (alive(prev.pid) || alive(prev.childPid)) {
      console.error(`[dev:e2e] another dev e2e server is running (pid ${prev.pid}, port ${prev.port}); stop it or run node scripts/dev_e2e.mjs --restore`)
      process.exit(1)
    }
    // killed outright last time: site/docs may still hold the demo
    await teardownDevServer(`leftover of an interrupted run (pid ${prev.pid}, ${prev.startedAt})`)
  }

  fs.mkdirSync(E2E_ROOT, { recursive: true })
  fs.writeFileSync(DEV_STATE_FILE, JSON.stringify({ pid: process.pid, childPid: null, port, startedAt: new Date().toISOString() }))
  const synced = syncDemo({}, ['--drafts'])
  if (synced !== 0) {
    await teardownDevServer('demo sync failed')
    process.exit(synced)
  }

  const child = spawn(process.execPath, [VITEPRESS, 'dev', 'docs', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: SITE_DIR,
    env: demoEnv(),
    stdio: 'inherit',
  })
  fs.writeFileSync(DEV_STATE_FILE, JSON.stringify({ pid: process.pid, childPid: child.pid, port, startedAt: new Date().toISOString() }))
  log(`vitepress dev on http://127.0.0.1:${port}/ (pid ${child.pid}) with LECTURE_CONTENT_DIR=${path.relative(SITE_DIR, demoEnv().LECTURE_CONTENT_DIR)}`)

  let stopping = false
  const stop = async (why, code) => {
    if (stopping) return
    stopping = true
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await waitGone([child.pid], 10_000)
      killTree(child.pid)
    }
    const restored = await teardownDevServer(why)
    process.exit(code || restored)
  }
  child.on('exit', (code, signal) => stop(`vitepress exited (${signal ?? code})`, code ?? 1))
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => stop(sig, 0))
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--restore')) {
    if (!readState()) {
      log('no dev e2e run recorded (site/.e2e-demo/dev-server.json): nothing to clean up')
      process.exit(0)
    }
    process.exit(await teardownDevServer('--restore'))
  }
  await start(portArg(argv))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
