#!/usr/bin/env node
/**
 * scripts/check_i18n_strings.mjs - hard-coded UI string gate (plan_v2_p2d_i18n.md, WP-I1).
 *
 * Scans docs/.vitepress/theme/**\/*.{vue,ts} for lines that contain CJK characters
 * (U+3400-U+9FFF, U+3000-U+303F, U+FF00-U+FFEF) outside comments (`//`, block comments, HTML comments).
 * Lines that are `console.(log|info|warn|error|debug)(` calls are ignored (developer output, not UI).
 * Every such line is a user-visible string that bypasses the dictionary (docs/.vitepress/i18n/).
 *
 * Legacy files that are rewritten in later phases (GroupKnowledgeMap, ai/*) and a few
 * functional literals are recorded in tests/i18n-hardcode-baseline.json, up to their recorded count.
 * The baseline may only go DOWN: a file above its count, or a new file with CJK lines, fails.
 *
 *   node scripts/check_i18n_strings.mjs            check
 *   node scripts/check_i18n_strings.mjs --update   rewrite the baseline (refused if any count rose;
 *                                                  the first run without a baseline seeds it)
 *
 * Same design as scripts/check_theme_contract.mjs.
 * Exit codes: 0 pass, 1 criterion failed, 2 gate broken.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SITE_DIR = path.resolve(__dirname, '..')
const THEME_DIR = path.join(SITE_DIR, 'docs', '.vitepress', 'theme')
const BASELINE = path.join(SITE_DIR, 'tests', 'i18n-hardcode-baseline.json')
const update = process.argv.includes('--update')

function fail(code, msg) {
  console.error(msg)
  process.exit(code)
}

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, filter, out)
    else if (filter(p)) out.push(p)
  }
  return out
}

/** Blank out comments but keep every newline, so line structure survives. */
function stripComments(src, ext) {
  const blank = (m) => m.replace(/[^\n]/g, ' ')
  let s = src.replace(/\/\*[\s\S]*?\*\//g, blank)
  if (ext === '.vue') s = s.replace(/<!--[\s\S]*?-->/g, blank)
  s = s.replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1')
  return s
}

const CJK_RE = /[㐀-鿿　-〿＀-￯]/
const CONSOLE_RE = /\bconsole\s*\.\s*(?:log|info|warn|error|debug)\s*\(/

const rel = (p) => path.relative(SITE_DIR, p).replace(/\\/g, '/')

function countLines(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'), path.extname(file))
  let n = 0
  for (const line of src.split('\n')) {
    if (!CJK_RE.test(line)) continue
    if (CONSOLE_RE.test(line)) continue
    n++
  }
  return n
}

const files = walk(THEME_DIR, (p) => /\.(vue|ts)$/.test(p))
if (files.length === 0) fail(2, `[i18n-strings] no files under ${THEME_DIR}`)

const counts = {}
for (const f of files) {
  const n = countLines(f)
  if (n > 0) counts[rel(f)] = n
}

let baseline = {}
const hasBaseline = fs.existsSync(BASELINE)
if (hasBaseline) {
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).files ?? {}
  } catch (e) {
    fail(2, `[i18n-strings] unreadable baseline ${BASELINE}: ${e.message}`)
  }
}

const worse = []
const better = []
for (const [f, n] of Object.entries(counts)) {
  const b = baseline[f] ?? 0
  if (n > b) worse.push(`${f}: ${n} line(s) with hard-coded CJK (baseline ${b})`)
  else if (n < b) better.push(`${f}: ${b} -> ${n}`)
}
for (const [f, b] of Object.entries(baseline)) if (!(f in counts) && b > 0) better.push(`${f}: ${b} -> 0`)

const total = Object.values(counts).reduce((a, b) => a + b, 0)
const baseTotal = Object.values(baseline).reduce((a, b) => a + b, 0)

if (update) {
  // the very first --update seeds the baseline; afterwards it can only ratchet down
  if (worse.length && hasBaseline) fail(1, `[i18n-strings] refusing --update: counts rose\n  ${worse.join('\n  ')}`)
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note: 'Lines with hard-coded CJK (outside comments and console calls) allowed in legacy theme files. May only go down (scripts/check_i18n_strings.mjs).',
        total,
        files: sorted,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`[i18n-strings] baseline written: ${total} line(s) in ${Object.keys(sorted).length} file(s)`)
}

if (worse.length && !update) {
  console.error(`[i18n-strings] hard-coded CJK above baseline:\n  ${worse.join('\n  ')}\n  move the text into docs/.vitepress/i18n/zh-CN.ts + en.ts and use useT() / translate(currentLang(), ...).`)
  process.exit(1)
}
if (better.length && !update) console.log(`[i18n-strings] improved (run with --update to ratchet the baseline down):\n  ${better.join('\n  ')}`)
console.log(`[i18n-strings] PASS - ${files.length} files, ${total} line(s) with hard-coded CJK (baseline ${update ? total : baseTotal})`)
