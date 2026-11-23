/**
 * scripts/build.mjs - `npm run build`: VitePress build plus the access switch of P3b.
 *
 *   npm run build                         same as `vitepress build docs`
 *   npm run build -- --audience public    build only public content (sets LECTURE_AUDIENCE=public)
 *   npm run build -- --outDir <dir>       every other argument goes to `vitepress build docs` unchanged
 *
 * LECTURE_BUILD_GROUPS=G01,LR limits the build to those groups and LECTURE_ACCESS_JSON=<json> replaces the `access`
 * block, both for tests (docs-dev/ACCESS.md). Exit code = the exit code of vitepress.
 */
import { execFileSync, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_BUILD_HEAP_MB = 8192
const SMALL_HOST_THRESHOLD_MB = 6144

function sampleWorkingSetMb(pid) {
  if (!pid) return 0
  try {
    if (process.platform === 'linux') {
      const rssKb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim())
      return Number.isFinite(rssKb) ? Math.round(rssKb / 1024) : 0
    }
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`],
        { encoding: 'utf8' },
      ).trim()
      const bytes = Number(out)
      return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / (1024 * 1024)) : 0
    }
  } catch {
    /* ignore */
  }
  return 0
}

/** Split `--audience <value>` / `--audience=<value>` out of the arguments. Exported for tests. */
export function parseBuildArgs(argv, env = process.env) {
  const rest = []
  let audience
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--audience') audience = argv[++i]
    else if (a.startsWith('--audience=')) audience = a.slice('--audience='.length)
    else rest.push(a)
  }
  if (audience !== undefined && audience !== 'public') {
    throw new Error(`--audience ${JSON.stringify(audience)} is not supported (only: public)`)
  }
  return { rest, env: audience ? { ...env, LECTURE_AUDIENCE: audience } : env }
}

/** Resolve `--max-old-space-size` for the build child and warn when host RAM is smaller than the configured heap. */
export function resolveBuildHeap(env = process.env, totalMemBytes = os.totalmem()) {
  const totalMb = Math.round(totalMemBytes / (1024 * 1024))
  const nodeOpts = env.NODE_OPTIONS ?? ''
  const optMatch = /--max-old-space-size=(\d+)/.exec(nodeOpts)
  let args = []
  let requestedMb = null
  let source = 'default'

  if (optMatch) {
    source = 'NODE_OPTIONS'
    requestedMb = Number(optMatch[1])
  } else if (env.LECTURE_BUILD_HEAP_MB !== undefined && env.LECTURE_BUILD_HEAP_MB !== '') {
    source = 'LECTURE_BUILD_HEAP_MB'
    const raw = env.LECTURE_BUILD_HEAP_MB.trim().toLowerCase()
    if (raw === '0' || raw === 'off' || raw === 'auto') {
      requestedMb = null
    } else {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 256) {
        throw new Error(`LECTURE_BUILD_HEAP_MB=${JSON.stringify(env.LECTURE_BUILD_HEAP_MB)} must be an integer >= 256, or 0/auto`)
      }
      requestedMb = n
      args = [`--max-old-space-size=${n}`]
    }
  } else {
    requestedMb = DEFAULT_BUILD_HEAP_MB
    args = [`--max-old-space-size=${DEFAULT_BUILD_HEAP_MB}`]
  }

  let warning = null
  if (totalMb > 0 && ((requestedMb !== null && totalMb < requestedMb) || totalMb < SMALL_HOST_THRESHOLD_MB)) {
    const limitLabel = requestedMb !== null ? `${requestedMb} MB (${source})` : 'Node default'
    warning =
      `[build] Warning: host RAM is ${totalMb} MB (< ${requestedMb !== null && totalMb < requestedMb ? limitLabel : `${SMALL_HOST_THRESHOLD_MB} MB`}). ` +
      `Full-site build peaks around ~5.7 GB RSS; avoid full builds on small deploy hosts — build in CI or use --audience public / LECTURE_BUILD_GROUPS / LECTURE_BUILD_HEAP_MB (see docs-dev/BUILD.md).`
  }
  return { args, requestedMb, source, totalMb, warning }
}

function main() {
  let parsed
  let heap
  try {
    parsed = parseBuildArgs(process.argv.slice(2))
    heap = resolveBuildHeap(parsed.env)
  } catch (e) {
    console.error(`[build] ${e.message}`)
    process.exit(2)
  }
  if (heap.warning) console.warn(heap.warning)
  const bin = path.join(SITE_DIR, 'node_modules', 'vitepress', 'bin', 'vitepress.js')
  const profileMem = parsed.env.LECTURE_PROFILE_MEM === '1'
  const child = spawn(process.execPath, [...heap.args, bin, 'build', 'docs', ...parsed.rest], { cwd: SITE_DIR, env: parsed.env, stdio: 'inherit' })
  let peakMb = 0
  let timer = null
  if (profileMem) {
    const start = Date.now()
    timer = setInterval(() => {
      const mb = sampleWorkingSetMb(child.pid)
      if (mb > peakMb) peakMb = mb
      console.log(`[build-mem] +${Math.round((Date.now() - start) / 1000)}s workingSet=${mb}MB peak=${peakMb}MB`)
    }, 5000)
    timer.unref()
  }
  child.on('exit', (code, signal) => {
    if (timer) clearInterval(timer)
    if (profileMem) console.log(`[build-mem] FINAL peakWorkingSet=${peakMb}MB`)
    if (signal) console.error(`[build] child terminated by signal ${signal} (possible OOM; try LECTURE_BUILD_HEAP_MB or --audience public — see docs-dev/BUILD.md)`)
    process.exit(code ?? (signal ? 1 : 0))
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
