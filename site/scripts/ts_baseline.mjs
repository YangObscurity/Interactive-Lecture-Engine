#!/usr/bin/env node
/**
 * scripts/ts_baseline.mjs — legacy TypeScript no-regression gate.
 *
 * Runs `vue-tsc --noEmit -p tsconfig.legacy.json`, counts errors per file and
 * compares with tests/ts-baseline.json.
 *
 *   node scripts/ts_baseline.mjs           check (CI)
 *   node scripts/ts_baseline.mjs --update  rewrite the baseline
 *
 * Exit codes (AGENTS.md convention):
 *   0  pass (no file got worse; fewer errors is fine — run --update to ratchet down)
 *   1  criterion failed (a file's error count increased, or a new file has errors)
 *   2  gate itself broken (vue-tsc missing / crashed / unparseable output)
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SITE_DIR = path.resolve(__dirname, '..')
const BASELINE = path.join(SITE_DIR, 'tests', 'ts-baseline.json')
const update = process.argv.includes('--update')
const V2_RE = /^docs\/\.vitepress\/(site\.config\.mts$|lecture-config\.mts$|config\.v2\.mts$|i18n\/|figures\/|plugins\/(?:lectureThemePlugin|figuresDevPlugin)\.mts$|theme\/(core|api|progress|auth|charts|reading|pinout|home|group|ai2|debug|tokens|slots|figures)\/)/

function fail(code, msg) {
  console.error(msg)
  process.exit(code)
}

const bin = path.join(SITE_DIR, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js')
if (!fs.existsSync(bin)) fail(2, `[ts_baseline] vue-tsc not found at ${bin} (run npm ci)`)

const res = spawnSync(process.execPath, [bin, '--noEmit', '-p', 'tsconfig.legacy.json'], {
  cwd: SITE_DIR,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
if (res.error) fail(2, `[ts_baseline] failed to spawn vue-tsc: ${res.error.message}`)
const out = `${res.stdout || ''}${res.stderr || ''}`

// vue-tsc exits 0 (clean) or 1/2 (type errors). Anything else = tool crash.
const counts = {}
let total = 0
let parsed = 0
const re = /^(.+?)\((\d+),(\d+)\): error TS\d+:/
for (const line of out.split(/\r?\n/)) {
  const m = re.exec(line)
  if (!m) continue
  parsed++
  const file = m[1].replace(/\\/g, '/')
  // V2 folders are gated by the strict tsconfig.json (npm run typecheck), not by this baseline.
  if (V2_RE.test(file)) continue
  counts[file] = (counts[file] || 0) + 1
  total++
}
if (res.status !== 0 && parsed === 0) {
  fail(2, `[ts_baseline] vue-tsc exited ${res.status} but no "error TS" lines were parsed:\n${out.slice(0, 4000)}`)
}

const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))

if (update) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify({ total, files: sorted }, null, 2) + '\n', 'utf8')
  console.log(`[ts_baseline] baseline updated: ${total} errors in ${Object.keys(sorted).length} files`)
  process.exit(0)
}

if (!fs.existsSync(BASELINE)) fail(2, `[ts_baseline] missing ${BASELINE}; run with --update first`)
let base
try {
  base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).files || {}
} catch (e) {
  fail(2, `[ts_baseline] cannot parse baseline: ${e.message}`)
}

const regressions = []
const improved = []
for (const [file, n] of Object.entries(sorted)) {
  const b = base[file] || 0
  if (n > b) regressions.push(`  ${file}: ${b} -> ${n}`)
  else if (n < b) improved.push(`  ${file}: ${b} -> ${n}`)
}
for (const [file, b] of Object.entries(base)) {
  if (!(file in sorted)) improved.push(`  ${file}: ${b} -> 0`)
}

console.log(`[ts_baseline] legacy errors: ${total} (baseline ${Object.values(base).reduce((s, v) => s + v, 0)})`)
if (improved.length) console.log(`[ts_baseline] improved (run --update to ratchet):\n${improved.join('\n')}`)
if (regressions.length) {
  console.error(`[ts_baseline] FAIL: error count increased:\n${regressions.join('\n')}`)
  console.error(out.split(/\r?\n/).filter((l) => regressions.some((r) => l.replace(/\\/g, '/').startsWith(r.trim().split(':')[0]))).join('\n'))
  process.exit(1)
}
console.log('[ts_baseline] PASS')
process.exit(0)
