#!/usr/bin/env node
/**
 * scripts/privacy/scan.mjs — the privacy gate of the open-source engine repository (S3).
 *
 * Three gates use it: the pre-commit hook (`--staged`), CI (`--tracked` and `--dir <dist>`), and a manual audit.
 * It fails (exit 1) on:
 *   - a path outside the engine allowlist (scripts/privacy/engine-paths.txt), or under content/;
 *   - generic personal or secret patterns built in here (local user paths, e-mail addresses, key material,
 *     long tokens, Notion ids);
 *   - personal terms that never live in this repository: LECTURE_PRIVACY_TERMS (newline or comma separated),
 *     plus the files named by LECTURE_PRIVACY_TERMS_FILE, content/.privacy-terms and
 *     ~/.config/lecture-engine/privacy-terms.txt (one term per line, `#` comments).
 * A line can opt out of the generic patterns (never of the personal terms) with `privacy-scan: allow`.
 * Matches are printed masked, so the report itself leaks nothing.
 * Submodules (gitlinks, mode 160000) are never read: one outside the allowlist is refused like any path, an allowed one is
 * reported as `skipped submodule <path>`; a folder named on the command line is reported as `skipped directory <path>`.
 *
 * Usage: node scripts/privacy/scan.mjs (--staged | --tracked | --dir <folder> | <files...>) [--no-paths] [--json]
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '..', '..')

/** Generic rules: shapes, not people. */
export const GENERIC_RULES = [
  // any Windows drive path is a machine's own path; system and temp folders, one-letter test paths like C:\x and
  // placeholder users like C:\Users\me or C:\Users\<you> are documentation; a letter right after `(?` / `(?-` or a backslash is regex
  // syntax, not a drive (`(?i:\b…`, `[\w:\x{80}…]` in the shiki grammars of a built site)
  { id: 'local-path', re: /(?<!\(\?-?|\\)\b[A-Za-z]:[\\/]+(?!(?:Windows|Program Files(?: \(x86\))?|ProgramData|[Tt]e?mp|My #\d|\w(?:\.\w+)?)(?:[\\/'"`\s]|$)|Users[\\/]+(?:[Mm]e|[Nn]ame|NAME~1|[Aa]dmin|[Uu]ser|x|[Yy]ou|[Pp]ublic|[Dd]efault|[Ee]xample|<[^>]*>)(?:[\\/'"`\s]|$)|<)[\w$~.-]/g },
  { id: 'home-path', re: /\/(?:home|Users)\/(?!user\b|runner\b|example\b|you\b|me\b|jane\b|name\b)[a-z][\w.-]+\//gi },
  // an address: not the password part of a URL (user:pw@host), not a reserved test domain, a real top-level domain
  { id: 'email', re: /(?<![\w.+:/-])[\w.+-]+@(?!(?:example\.(?:com|org|net)|users\.noreply\.github\.com|anthropic\.com)\b)[\w-]+(?:\.[\w-]+)*\.(?!(?:invalid|test|example|localhost)\b)[A-Za-z]{2,}\b/g },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { id: 'api-token', re: /\b(?:sk-[A-Za-z0-9_-]{20,}|app-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{20,}|secret_[A-Za-z0-9]{30,}|ntn_[A-Za-z0-9]{30,})\b/g },
  { id: 'bearer-literal', re: /Bearer\s+(?!<|\$|\{|REPLACE|\*)[A-Za-z0-9._-]{24,}/g },
  { id: 'notion-id', re: /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi },
]

/** Obvious placeholders that only look like a finding: sk-xxxx..., app-xxxx..., an all-zero uuid prefix. */
export function isPlaceholder(ruleId, match) {
  if (ruleId === 'api-token') {
    const body = match.replace(/^(?:sk-|app-|ghp_|xox[abp]-|secret_|ntn_)/, '')
    return /^(.)\1+$/.test(body) || /x{8,}/i.test(body)
  }
  if (ruleId === 'notion-id') return /^0{8}/.test(match)
  return false
}

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.zip', '.gz', '.tgz', '.mp4', '.webm'])

/** Lock files carry package integrity data and dependency authors; SVG path data and ids look like uuids. */
const LOCK_FILE = /package-lock\.json$|\.lock$|pnpm-lock\.yaml$/
const SKIP_RULES_FOR = [
  { re: LOCK_FILE, rules: new Set(['notion-id', 'email']) },
  { re: /\.svg$/i, rules: new Set(['notion-id']) },
  // a build's shared bundles (dist assets/chunks/: VitePress, Vue, shiki grammars): third-party code whose minified
  // identifiers and regexes take token and uuid shapes. Page bundles (assets/*.js, where lecture text lands) are not skipped,
  // and personal terms and e-mail are checked everywhere.
  { re: /^assets\/chunks\/[^/]+\.js$/, rules: new Set(['api-token', 'notion-id', 'bearer-literal']) },
]
const skipped = (rel, ruleId) => SKIP_RULES_FOR.some((s) => s.re.test(rel) && s.rules.has(ruleId))

export function loadTerms({ env = process.env, repoRoot = REPO_ROOT, home = os.homedir() } = {}) {
  const terms = new Set()
  const addAll = (text) => {
    for (const raw of text.split(/[\n,]/)) {
      const t = raw.replace(/#.*$/, '').trim()
      if (t.length >= 3) terms.add(t)
    }
  }
  if (env.LECTURE_PRIVACY_TERMS) addAll(env.LECTURE_PRIVACY_TERMS)
  const files = [env.LECTURE_PRIVACY_TERMS_FILE, path.join(repoRoot, 'content', '.privacy-terms'), path.join(home, '.config', 'lecture-engine', 'privacy-terms.txt')]
  for (const f of files) if (f && fs.existsSync(f)) addAll(fs.readFileSync(f, 'utf8'))
  return [...terms]
}

export function loadAllowlist(repoRoot = REPO_ROOT) {
  const file = path.join(repoRoot, 'scripts', 'privacy', 'engine-paths.txt')
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : []
  return lines.map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean)
}

/** `dir/` allows the folder, `name` an exact path, `!pattern` excludes again (last match wins). */
export function pathAllowed(rel, allowlist) {
  const p = rel.replace(/\\/g, '/')
  if (p === 'content' || p.startsWith('content/')) return false
  let ok = false
  for (const raw of allowlist) {
    const neg = raw.startsWith('!')
    const pat = neg ? raw.slice(1) : raw
    const hit = pat.endsWith('/') ? p.startsWith(pat) : p === pat
    if (hit) ok = !neg
  }
  return ok
}

const mask = (s) => (s.length <= 4 ? '*'.repeat(s.length) : `${s.slice(0, 2)}${'*'.repeat(Math.min(8, s.length - 3))}${s.slice(-1)}`)

export function scanText(rel, text, terms) {
  const hits = []
  const lowerTerms = terms.map((t) => [t, t.toLowerCase()])
  text.split(/\r?\n/).forEach((line, i) => {
    const lower = line.toLowerCase()
    // the copyright holder of a LICENSE file is named on purpose (only that one line of a file called LICENSE)
    const licenseHolder = /(^|\/)LICENSE$/.test(rel) && /^Copyright \(c\) \d{4}(?:-\d{4})? \S/.test(line)
    for (const [t, lt] of lowerTerms) {
      if (licenseHolder) break
      if (lower.includes(lt)) hits.push({ file: rel, line: i + 1, rule: 'personal-term', match: mask(t) })
    }
    if (line.includes('privacy-scan: allow')) return
    for (const r of GENERIC_RULES) {
      if (skipped(rel, r.id)) continue
      for (const m of line.matchAll(r.re)) {
        if (isPlaceholder(r.id, m[0])) continue
        hits.push({ file: rel, line: i + 1, rule: r.id, match: mask(m[0]) })
      }
    }
  })
  return hits
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

/** A gitlink (mode 160000) is a submodule: a commit id in the index and a folder (often empty) in the work tree. */
const GITLINK = '160000'

/** `git ls-files -z --stage` records: `<mode> <object> <stage>\t<path>`. */
export function parseLsFilesStage(out) {
  return out.split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t')
    return { mode: rec.slice(0, rec.indexOf(' ')), rel: rec.slice(tab + 1) }
  })
}

/** `git diff --cached --raw -z --no-renames` records: `:<old mode> <new mode> <old> <new> <status>\0<path>\0`. */
export function parseDiffRaw(out) {
  const parts = out.split('\0')
  const recs = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i].startsWith(':')) break
    recs.push({ mode: parts[i].slice(1).split(' ')[1], rel: parts[i + 1] })
  }
  return recs
}

function readEntries(argv) {
  if (argv.includes('--staged')) {
    const recs = parseDiffRaw(git(['diff', '--cached', '--raw', '-z', '--no-renames', '--diff-filter=ACMR']))
    return recs.map(({ mode, rel }) => ({ rel, skip: mode === GITLINK ? 'submodule' : '', read: () => execFileSync('git', ['show', `:${rel}`], { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 }) }))
  }
  if (argv.includes('--tracked')) {
    // merge conflicts list a path once per stage
    const seen = new Set()
    const recs = parseLsFilesStage(git(['ls-files', '-z', '--stage'])).filter((r) => !seen.has(r.rel) && seen.add(r.rel))
    return recs.map(({ mode, rel }) => ({ rel, skip: mode === GITLINK ? 'submodule' : '', read: () => fs.readFileSync(path.join(REPO_ROOT, rel)) }))
  }
  if (argv.includes('--dir')) {
    const dir = path.resolve(argv[argv.indexOf('--dir') + 1])
    const out = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name)
        // a linked folder is walked like a folder (a dist has none; readFileSync on it would throw EISDIR)
        if (e.isDirectory() || (e.isSymbolicLink() && fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory())) walk(abs)
        else out.push({ rel: path.relative(dir, abs).replace(/\\/g, '/'), read: () => fs.readFileSync(abs), dist: true })
      }
    }
    walk(dir)
    return out
  }
  return argv.filter((a) => !a.startsWith('--')).map((f) => ({
    rel: path.relative(REPO_ROOT, path.resolve(f)).replace(/\\/g, '/'),
    skip: fs.statSync(f, { throwIfNoEntry: false })?.isDirectory() ? 'directory' : '',
    read: () => fs.readFileSync(f),
  }))
}

/**
 * A submodule outside the allowlist is still refused (the gitlink and .gitmodules would ship); an allowed one is not read
 * (the folder is not this repository's file, and is empty when the submodule is not checked out) and is reported via onSkip,
 * like a folder named on the command line (scan it with --dir).
 */
export function scanEntries(entries, { terms, allowlist, checkPaths, onSkip = () => {} }) {
  const hits = []
  for (const e of entries) {
    if (e.skip === 'directory') {
      onSkip(`skipped directory ${e.rel}`)
      continue
    }
    if (checkPaths && !e.dist && !pathAllowed(e.rel, allowlist)) {
      hits.push({ file: e.rel, line: 0, rule: 'path-not-allowed', match: '' })
      continue
    }
    if (e.skip) {
      onSkip(`skipped ${e.skip} ${e.rel}`)
      continue
    }
    if (BINARY_EXT.has(path.extname(e.rel).toLowerCase())) continue
    const text = decodeText(e.read())
    if (text === null) continue
    hits.push(...scanText(e.rel, text, terms))
  }
  return hits
}

/**
 * Text of a file, or null for binary data (a NUL byte). UTF-16 with a byte order mark is text: Windows PowerShell 5.1 writes
 * `>` redirects that way, and those NUL bytes must not make a file of personal notes look binary.
 */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))).swap16().toString('utf16le')
  if (buf.includes(0)) return null
  return buf.toString('utf8')
}

function main() {
  const argv = process.argv.slice(2)
  const terms = loadTerms()
  const allowlist = loadAllowlist()
  const entries = readEntries(argv)
  const skippedEntries = []
  const hits = scanEntries(entries, { terms, allowlist, checkPaths: !argv.includes('--no-paths'), onSkip: (msg) => skippedEntries.push(msg) })
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ files: entries.length, terms: terms.length, skipped: skippedEntries, hits }, null, 1) + '\n')
  } else {
    for (const s of skippedEntries) process.stdout.write(`[privacy-scan] ${s}\n`)
    for (const h of hits) process.stdout.write(`${h.file}${h.line ? `:${h.line}` : ''}  ${h.rule}${h.match ? `  ${h.match}` : ''}\n`)
    process.stdout.write(`[privacy-scan] ${entries.length} file(s), ${terms.length} personal term(s), ${hits.length} hit(s)\n`)
    if (!terms.length) process.stdout.write('[privacy-scan] note: no personal terms loaded (set LECTURE_PRIVACY_TERMS or content/.privacy-terms)\n')
  }
  process.exit(hits.length ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
