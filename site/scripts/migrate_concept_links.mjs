/**
 * scripts/migrate_concept_links.mjs
 *
 * One-off migration from legacy `[[concept:slug]]` / `[[concept:slug|display]]` syntax
 * to Markdown link syntax `[display](concept:slug)` while skipping code fences, inline code,
 * and math spans.
 *
 * Usage:
 *   node scripts/migrate_concept_links.mjs           # dry-run report
 *   node scripts/migrate_concept_links.mjs --apply   # rewrite matching files in place
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContent } from '../docs/.vitepress/content/paths.mts'
import { parseConceptMarkdown } from '../docs/.vitepress/concepts/frontmatter.ts'
import { computeMathRangesInBody } from '../docs/.vitepress/concepts/sourceRewriter.ts'

const WIKI_CONCEPT_RE = /\[\[concept:([a-z0-9-]+)(?:\|([^\]\n]+))?\]\]/gi

function maskProtectedRegions(source) {
  const masked = source.split('')
  const blank = (start, end) => {
    for (let i = start; i < end && i < masked.length; i++) {
      if (masked[i] !== '\n' && masked[i] !== '\r') masked[i] = '\u0000'
    }
  }

  // Fenced code blocks (``` or ~~~)
  const fenceRe = /^([ \t]*)(`{3,}|~{3,})[^\n]*\r?\n[\s\S]*?\r?\n\1\2[ \t]*(?=\r?\n|$)/gm
  let m
  while ((m = fenceRe.exec(source)) !== null) {
    blank(m.index, m.index + m[0].length)
  }

  // Inline code spans
  const codeSpanRe = /(`+)([^`\n]+?)\1/g
  while ((m = codeSpanRe.exec(source)) !== null) {
    blank(m.index, m.index + m[0].length)
  }

  // Math spans
  for (const r of computeMathRangesInBody(source)) {
    blank(r.start, r.end)
  }

  return masked.join('')
}

/**
 * Migrate legacy `[[concept:...]]` links in a single Markdown string.
 * @param {string} markdown
 * @param {(slug: string) => string | undefined} [resolveTerm]
 */
export function migrateLegacyConceptLinks(markdown, resolveTerm) {
  const src = markdown ?? ''
  if (!src.includes('[[concept:')) {
    return { nextMarkdown: src, replacements: 0 }
  }
  const masked = maskProtectedRegions(src)
  let out = ''
  let cursor = 0
  let replacements = 0

  WIKI_CONCEPT_RE.lastIndex = 0
  let match
  while ((match = WIKI_CONCEPT_RE.exec(masked)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const origMatch = src.slice(start, end)
    const parsed = /^\[\[concept:([a-z0-9-]+)(?:\|([^\]\n]+))?\]\]$/i.exec(origMatch)
    if (!parsed) continue
    const slug = parsed[1].toLowerCase()
    const explicitLabel = parsed[2]?.trim()
    const display = explicitLabel || resolveTerm?.(slug) || slug
    out += src.slice(cursor, start) + `[${display}](concept:${slug})`
    cursor = end
    replacements++
  }
  out += src.slice(cursor)
  return { nextMarkdown: out, replacements }
}

function collectMarkdownFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.vitepress' || entry.name === 'dist') continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) collectMarkdownFiles(abs, out)
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(abs)
  }
  return out
}

function buildTermMap(conceptsDir) {
  const map = new Map()
  if (!fs.existsSync(conceptsDir)) return map
  for (const f of collectMarkdownFiles(conceptsDir)) {
    const slug = path.basename(f, '.md')
    const parsed = parseConceptMarkdown(fs.readFileSync(f, 'utf8'), slug)
    if (parsed.meta.term) map.set(slug, parsed.meta.term)
  }
  return map
}

function main() {
  const apply = process.argv.includes('--apply')
  const content = resolveContent()
  const terms = buildTermMap(content.conceptsDir)
  const files = new Set([
    ...collectMarkdownFiles(content.lecturesDir),
    ...collectMarkdownFiles(content.conceptsDir),
  ])

  let touchedFiles = 0
  let totalReplacements = 0
  for (const file of [...files].sort()) {
    const raw = fs.readFileSync(file, 'utf8')
    const { nextMarkdown, replacements } = migrateLegacyConceptLinks(raw, (slug) => terms.get(slug))
    if (replacements > 0) {
      touchedFiles++
      totalReplacements += replacements
      console.log(`${apply ? '[migrated]' : '[would-migrate]'} ${path.relative(content.root, file)}: ${replacements} link(s)`)
      if (apply) fs.writeFileSync(file, nextMarkdown, 'utf8')
    }
  }
  console.log(`[migrate-concepts] ${apply ? 'applied' : 'dry-run'}: ${totalReplacements} link(s) across ${touchedFiles} file(s)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
