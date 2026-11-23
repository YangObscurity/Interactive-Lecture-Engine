#!/usr/bin/env node
/**
 * scripts/check_theme_contract.mjs — `--lec-*` token contract gate.
 *
 * Scans docs/.vitepress/theme/**\/*.{css,vue,ts} and docs/.vitepress/themes/**\/theme.css:
 *
 *   1. unknown `--lec-*` names (not in theme/tokens/contract.ts)  → FAIL, everywhere;
 *   2. raw colour literals (#hex, rgb(), rgba(), hsl(), hsla(), hwb(), lab(), lch(), oklab(), oklch())
 *      in theme/** → FAIL, except:
 *        - themes/** (theme packs own their colours) and theme/tokens/** (the compiler that turns
 *          pack values into CSS);
 *        - legacy files listed in tests/theme-contract-baseline.json, up to their recorded count.
 *      The baseline may only go DOWN: a file above its count, or a new file with literals, fails.
 *
 *   node scripts/check_theme_contract.mjs            check
 *   node scripts/check_theme_contract.mjs --update   rewrite the baseline (refused if any count rose;
 *                                                    the first run without a baseline seeds it)
 *
 * Comments are ignored (CSS / JS block comments, `//` line comments, HTML comments).
 * Exit codes: 0 pass, 1 criterion failed, 2 gate broken.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SITE_DIR = path.resolve(__dirname, '..')
const VP_DIR = path.join(SITE_DIR, 'docs', '.vitepress')
const THEME_DIR = path.join(VP_DIR, 'theme')
const PACKS_DIR = path.join(VP_DIR, 'themes')
const CONTRACT_TS = path.join(THEME_DIR, 'tokens', 'contract.ts')
const BASELINE = path.join(SITE_DIR, 'tests', 'theme-contract-baseline.json')
const update = process.argv.includes('--update')

function fail(code, msg) {
  console.error(msg)
  process.exit(code)
}

// ------------------------------------------------------------------ contract names (from contract.ts)
async function loadContract() {
  let esbuild
  try {
    esbuild = await import('esbuild')
  } catch {
    fail(2, '[theme-contract] esbuild not resolvable (run npm ci)')
  }
  const { code } = await esbuild.transform(fs.readFileSync(CONTRACT_TS, 'utf8'), { loader: 'ts', format: 'esm' })
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  if (!(mod.CONTRACT_NAMES instanceof Set) || mod.CONTRACT_NAMES.size === 0) fail(2, '[theme-contract] contract.ts exports no CONTRACT_NAMES')
  return mod.CONTRACT_NAMES
}

// ------------------------------------------------------------------ scanning
function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, filter, out)
    else if (filter(p)) out.push(p)
  }
  return out
}

function stripComments(src, ext) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
  if (ext === '.vue') s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  if (ext === '.ts' || ext === '.vue') s = s.replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1')
  return s
}

const HEX_RE = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g
const FN_RE = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g
const LEC_RE = /--lec-[a-z0-9-]*/g

const rel = (p) => path.relative(SITE_DIR, p).replace(/\\/g, '/')

function scan(file) {
  const ext = path.extname(file)
  const src = stripComments(fs.readFileSync(file, 'utf8'), ext)
  const colours = (src.match(HEX_RE) || []).length + (src.match(FN_RE) || []).length
  const names = new Set(src.match(LEC_RE) || [])
  return { colours, names }
}

const contract = await loadContract()
const isKnown = (name) =>
  contract.has(name) ||
  // template prefix such as `var(--lec-cat-${slot})`
  (name.endsWith('-') && [...contract].some((c) => c.startsWith(name)))

const themeFiles = walk(THEME_DIR, (p) => /\.(css|vue|ts)$/.test(p))
const packCss = walk(PACKS_DIR, (p) => path.basename(p) === 'theme.css')
if (themeFiles.length === 0) fail(2, `[theme-contract] no files under ${THEME_DIR}`)

const unknown = []
const counts = {}
for (const f of [...themeFiles, ...packCss]) {
  const r = scan(f)
  for (const n of r.names) if (!isKnown(n)) unknown.push(`${rel(f)}: ${n}`)
  const exempt = f.startsWith(PACKS_DIR) || f.startsWith(path.join(THEME_DIR, 'tokens') + path.sep)
  if (!exempt && r.colours > 0) counts[rel(f)] = r.colours
}

// ------------------------------------------------------------------ shipped packs: map surface (S6Y AH #6)
// `--lec-canvas` is optional in the contract (a third-party pack without it keeps --lec-bg behind the maps), but the
// packs shipped with the engine give the map stage its own colour in light and dark (home-canvas prototype `--canvas`).
const SHIPPED_MODE_TOKENS = ['canvas']
const packGaps = []
for (const f of walk(PACKS_DIR, (p) => path.basename(p) === 'theme.json')) {
  let pack
  try {
    pack = JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch (e) {
    fail(2, `[theme-contract] unreadable ${rel(f)}: ${e.message}`)
  }
  for (const mode of ['light', 'dark']) {
    for (const t of SHIPPED_MODE_TOKENS) if (!pack?.modes?.[mode]?.[t]) packGaps.push(`${rel(f)}: modes.${mode}.${t} (--lec-${t})`)
  }
}
if (packGaps.length) console.error(`[theme-contract] shipped packs without the map tokens:\n  ${packGaps.join('\n  ')}`)

let baseline = {}
const hasBaseline = fs.existsSync(BASELINE)
if (hasBaseline) {
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).files ?? {}
  } catch (e) {
    fail(2, `[theme-contract] unreadable baseline ${BASELINE}: ${e.message}`)
  }
}

const worse = []
const better = []
for (const [f, n] of Object.entries(counts)) {
  const b = baseline[f] ?? 0
  if (n > b) worse.push(`${f}: ${n} colour literal(s) (baseline ${b})`)
  else if (n < b) better.push(`${f}: ${b} → ${n}`)
}
for (const [f, b] of Object.entries(baseline)) if (!(f in counts) && b > 0) better.push(`${f}: ${b} → 0`)

const total = Object.values(counts).reduce((a, b) => a + b, 0)
const baseTotal = Object.values(baseline).reduce((a, b) => a + b, 0)

if (update) {
  // the very first --update seeds the baseline; afterwards it can only ratchet down
  if (worse.length && hasBaseline) fail(1, `[theme-contract] refusing --update: counts rose\n  ${worse.join('\n  ')}`)
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(
    BASELINE,
    JSON.stringify({ note: 'Raw colour literals allowed in legacy theme files. May only go down (scripts/check_theme_contract.mjs).', total, files: sorted }, null, 2) + '\n',
  )
  console.log(`[theme-contract] baseline written: ${total} literal(s) in ${Object.keys(sorted).length} file(s)`)
}

if (unknown.length) console.error(`[theme-contract] unknown --lec-* names (not in theme/tokens/contract.ts):\n  ${unknown.join('\n  ')}`)
if (worse.length && !update) console.error(`[theme-contract] raw colour literals above baseline:\n  ${worse.join('\n  ')}\n  use --lec-* tokens (spec board §00) instead.`)
if (better.length && !update) console.log(`[theme-contract] improved (run with --update to ratchet the baseline down):\n  ${better.join('\n  ')}`)
if (unknown.length || packGaps.length || (worse.length && !update)) process.exit(1)
console.log(
  `[theme-contract] PASS — ${themeFiles.length + packCss.length} files, ${contract.size} contract names, ` +
    `${total} legacy colour literal(s) (baseline ${update ? total : baseTotal})`,
)
