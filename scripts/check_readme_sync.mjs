#!/usr/bin/env node
/**
 * Deterministic README style lock & sync gate (docs-dev/README_SYNC.md).
 *
 * Enforces without LLM calls:
 *   1. Visual & structural lock on README.md and README.en.md (brand SVGs, badges, H2 parity, <details> parity, links & anchors).
 *   2. Calm factual register check (blocks hype/marketing slogans and decorative heading emojis).
 *   3. 100% env var parity between server/.env.example and server/README.md §8, plus server/README.md link & anchor checks.
 *   4. Optional git diff check (--base <sha> --head <sha>):
 *      - Hard error if README.md is changed without README.en.md (or vice versa), unless [skip-readme-sync] is set.
 *      - Non-blocking GitHub Step Summary advisory when public config/routes/Dashboard/scripts change without README edits.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '..')

const GIT_REF_RE = /^[A-Za-z0-9_./~^-]{1,128}$/

const BANNED_ZH_SLOGANS = [
  '革命性',
  '颠覆性',
  '赋能',
  '无缝衔接',
  '丝滑体验',
  '企业级',
  '全方位',
  '一站式解决',
  '震撼发布',
  '强力驱动',
  '超强性能',
]

const BANNED_EN_PHRASES = [
  /\brevolutionary\b/gi,
  /\bgame[- ]changing\b/gi,
  /\bseamlessly\b/gi,
  /\bunlock the power\b/gi,
  /\bcutting[- ]edge\b/gi,
  /\benterprise[- ]grade\b/gi,
  /\bsupercharge\b/gi,
  /\bempower(?:s|ing)?\b/gi,
  /\bbest[- ]in[- ]class\b/gi,
  /\bnext[- ]generation\b/gi,
]

const HEADING_EMOJI_RE = /^#{1,6}\s+[\p{Extended_Pictographic}]/u

const REQUIRED_ROOT_ASSETS = [
  'docs/brand/banner-light.svg',
  'docs/brand/banner-dark.svg',
  'docs/brand/hero.png',
  'docs/brand/hero-dark.png',
]

const SURFACE_CODE_PATTERNS = [
  /^server\/\.env\.example$/,
  /^server\/src\/config\/schema\.ts$/,
  /^server\/src\/app\.ts$/,
  /^server\/src\/routes\//,
  /^site\/docs\/\.vitepress\/theme\/dashboard\//,
  /^site\/package\.json$/,
  /^docs-dev\/(?!README_SYNC\.md$)/,
]

export function stripCodeBlocksAndInlineCode(markdown) {
  const lines = markdown.split(/\r?\n/)
  const out = []
  let fenceChar = ''
  let fenceLen = 0
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fenceChar) {
        fenceChar = marker[0]
        fenceLen = marker.length
        continue
      }
      if (marker[0] === fenceChar && marker.length >= fenceLen && line.trim() === marker) {
        fenceChar = ''
        fenceLen = 0
        continue
      }
    }
    if (!fenceChar) {
      out.push(line.replace(/`[^`\n]*`/g, ''))
    }
  }
  return out.join('\n')
}

export function githubHeadingSlug(rawHeading) {
  const plain = rawHeading
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
  let slug = ''
  for (const ch of plain) {
    if (ch === ' ') {
      slug += '-'
    } else if (ch === '-' || ch === '_' || /[\p{L}\p{N}]/u.test(ch)) {
      slug += ch
    }
  }
  return slug.replace(/^-+|-+$/g, '') || 'section'
}

export function collectHeadingSlugs(markdown) {
  const clean = stripCodeBlocksAndInlineCode(markdown)
  const counts = new Map()
  const slugs = new Set()
  const h2 = []
  for (const line of clean.split(/\r?\n/)) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (!m) continue
    const base = githubHeadingSlug(m[2])
    const seen = counts.get(base) ?? 0
    counts.set(base, seen + 1)
    const slug = seen === 0 ? base : `${base}-${seen}`
    slugs.add(slug)
    if (m[1].length === 2) h2.push({ title: m[2].trim(), slug })
  }
  return { slugs, h2 }
}

export function extractLocalRefsAndAnchors(markdown) {
  const clean = stripCodeBlocksAndInlineCode(markdown)
  const fileRefs = []
  const anchors = []

  const addTarget = (raw) => {
    const trimmed = raw.trim().replace(/^<|>$/g, '')
    if (!trimmed) return
    // Strip optional markdown title `"..."` or `'...'`
    const noTitle = trimmed.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '').trim()
    if (!noTitle) return
    if (noTitle.startsWith('#')) {
      anchors.push(decodeURIComponent(noTitle.slice(1)))
      return
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(noTitle)) return
    const pathPart = noTitle.split('#')[0].split('?')[0]
    if (pathPart) fileRefs.push(decodeURIComponent(pathPart))
  }

  // HTML src / srcset / href attributes
  for (const m of clean.matchAll(/\b(?:href|src|srcset)\s*=\s*"([^"]+)"/gi)) {
    const attrName = m[0].split('=')[0].toLowerCase()
    if (attrName === 'srcset') {
      for (const candidate of m[1].split(',')) {
        const firstToken = candidate.trim().split(/\s+/)[0]
        if (firstToken) addTarget(firstToken)
      }
    } else {
      addTarget(m[1])
    }
  }

  // Markdown links & images `[label](target)`
  for (const m of clean.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) {
    addTarget(m[1])
  }

  return { fileRefs, anchors }
}

export function checkBannedHype(markdown, fileLabel) {
  const errors = []
  const clean = stripCodeBlocksAndInlineCode(markdown)
  const lines = clean.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (HEADING_EMOJI_RE.test(line)) {
      errors.push(`${fileLabel}: heading uses raw emoji instead of brand SVG icon: ${line.trim()}`)
    }
    for (const word of BANNED_ZH_SLOGANS) {
      if (line.includes(word)) {
        errors.push(`${fileLabel}: banned slogan phrase "${word}" in prose`)
      }
    }
    for (const re of BANNED_EN_PHRASES) {
      re.lastIndex = 0
      const hit = line.match(re)
      if (hit) {
        errors.push(`${fileLabel}: banned hype term "${hit[0]}" in prose`)
      }
    }
  }
  return errors
}

export function validateLinksAndAnchors(markdown, absFilePath, repoRoot) {
  const errors = []
  const relLabel = path.relative(repoRoot, absFilePath).replace(/\\/g, '/')
  const baseDir = path.dirname(absFilePath)
  const { slugs } = collectHeadingSlugs(markdown)
  const { fileRefs, anchors } = extractLocalRefsAndAnchors(markdown)

  for (const anchor of anchors) {
    if (!slugs.has(anchor) && !slugs.has(anchor.toLowerCase())) {
      errors.push(`${relLabel}: broken internal anchor #${anchor}`)
    }
  }

  const rootResolved = path.resolve(repoRoot)
  for (const ref of fileRefs) {
    const resolved = path.resolve(baseDir, ref)
    if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
      errors.push(`${relLabel}: path escapes repository root: ${ref}`)
      continue
    }
    if (!fs.existsSync(resolved)) {
      errors.push(`${relLabel}: missing referenced file: ${ref}`)
    }
  }
  return errors
}

export function extractEnvVarsFromExample(envExampleText) {
  const keys = []
  const seen = new Set()
  for (const rawLine of envExampleText.split(/\r?\n/)) {
    const m = rawLine.match(/^([A-Z][A-Z0-9_]*)=/)
    if (!m) continue
    if (!seen.has(m[1])) {
      seen.add(m[1])
      keys.push(m[1])
    }
  }
  return keys
}

export function extractTableVarsFromServerReadme(serverReadmeText) {
  const lines = serverReadmeText.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => /^##\s+8\.\s+/.test(l))
  if (startIdx < 0) return null
  const vars = []
  const seen = new Set()
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s+/.test(line)) break
    const rowMatch = line.match(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/)
    if (rowMatch && !seen.has(rowMatch[1])) {
      seen.add(rowMatch[1])
      vars.push(rowMatch[1])
    }
  }
  return vars
}

export function analyzeChangedFiles(changedFiles, skipTagPresent = false) {
  const errors = []
  const advisories = []
  const set = new Set(changedFiles.map((f) => f.replace(/\\/g, '/')))

  const changedZh = set.has('README.md')
  const changedEn = set.has('README.en.md')
  if (changedZh !== changedEn && !skipTagPresent) {
    errors.push(
      changedZh
        ? 'PR updated README.md without syncing README.en.md (add [skip-readme-sync] if intentionally omitted).'
        : 'PR updated README.en.md without syncing README.md (add [skip-readme-sync] if intentionally omitted).',
    )
  }

  const changedSurface = [...set].filter((f) => SURFACE_CODE_PATTERNS.some((re) => re.test(f)))
  const changedAnyReadme = changedZh || changedEn || set.has('server/README.md')
  if (changedSurface.length > 0 && !changedAnyReadme && !skipTagPresent) {
    advisories.push(
      `Surface files changed (${changedSurface.join(', ')}) without updating README*.md or server/README.md. Verify whether user-facing facts need updating (or add [skip-readme-sync] for internal-only changes).`,
    )
  }

  return { errors, advisories }
}

export function checkReadmes(repoRoot = REPO_ROOT) {
  const errors = []

  const zhPath = path.join(repoRoot, 'README.md')
  const enPath = path.join(repoRoot, 'README.en.md')
  const srvPath = path.join(repoRoot, 'server', 'README.md')
  const envExamplePath = path.join(repoRoot, 'server', '.env.example')

  for (const [label, p] of [
    ['README.md', zhPath],
    ['README.en.md', enPath],
    ['server/README.md', srvPath],
    ['server/.env.example', envExamplePath],
  ]) {
    if (!fs.existsSync(p)) {
      errors.push(`Missing required file: ${label}`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const zhText = fs.readFileSync(zhPath, 'utf8')
  const enText = fs.readFileSync(enPath, 'utf8')
  const srvText = fs.readFileSync(srvPath, 'utf8')
  const envExampleText = fs.readFileSync(envExamplePath, 'utf8')

  // 1. Visual & structural lock on README.md & README.en.md
  for (const [label, txt, pairTarget] of [
    ['README.md', zhText, './README.en.md'],
    ['README.en.md', enText, './README.md'],
  ]) {
    if (!txt.includes(pairTarget)) {
      errors.push(`${label}: missing bilingual switcher link to ${pairTarget}`)
    }
    if (!txt.includes('-2155c4?style=flat-square')) {
      errors.push(`${label}: missing locked #2155c4 flat-square badge palette`)
    }
    for (const asset of REQUIRED_ROOT_ASSETS) {
      if (!txt.includes(asset)) {
        errors.push(`${label}: missing locked brand asset ${asset}`)
      }
    }
  }

  const zhMeta = collectHeadingSlugs(zhText)
  const enMeta = collectHeadingSlugs(enText)
  if (zhMeta.h2.length !== enMeta.h2.length) {
    errors.push(
      `README.md has ${zhMeta.h2.length} H2 sections while README.en.md has ${enMeta.h2.length}; keep top-level sections paired.`,
    )
  }

  const zhDetailsCount = (zhText.match(/<details>/g) ?? []).length
  const enDetailsCount = (enText.match(/<details>/g) ?? []).length
  if (zhDetailsCount < 6 || zhDetailsCount !== enDetailsCount) {
    errors.push(
      `Locked <details> accordions mismatch: README.md has ${zhDetailsCount}, README.en.md has ${enDetailsCount} (expected >= 6 and equal).`,
    )
  }

  // 2. Links, anchors & banned hype across all three READMEs
  for (const [label, txt, absPath] of [
    ['README.md', zhText, zhPath],
    ['README.en.md', enText, enPath],
    ['server/README.md', srvText, srvPath],
  ]) {
    errors.push(...validateLinksAndAnchors(txt, absPath, repoRoot))
    errors.push(...checkBannedHype(txt, label))
  }

  // 3. Env-var parity: server/.env.example <-> server/README.md §8
  const expectedEnvVars = extractEnvVarsFromExample(envExampleText)
  const documentedVars = extractTableVarsFromServerReadme(srvText)
  if (!documentedVars) {
    errors.push('server/README.md: missing "## 8. ..." configuration reference table')
  } else {
    const docSet = new Set(documentedVars)
    const expSet = new Set(expectedEnvVars)
    const missing = expectedEnvVars.filter((k) => !docSet.has(k))
    const extra = documentedVars.filter((k) => !expSet.has(k))
    if (missing.length > 0) {
      errors.push(`server/README.md §8 is missing env vars from server/.env.example: ${missing.join(', ')}`)
    }
    if (extra.length > 0) {
      errors.push(`server/README.md §8 lists env vars absent from server/.env.example: ${extra.join(', ')}`)
    }
  }

  for (let sec = 1; sec <= 10; sec++) {
    if (!new RegExp(`^##\\s+${sec}\\.\\s+`, 'm').test(srvText)) {
      errors.push(`server/README.md: missing section ## ${sec}.`)
    }
  }
  if (!/^##\s+AI tools\b/m.test(srvText)) {
    errors.push('server/README.md: missing section ## AI tools')
  }

  return { ok: errors.length === 0, errors }
}

function getGitChangedFiles(base, head, repoRoot) {
  if (!GIT_REF_RE.test(base) || !GIT_REF_RE.test(head)) {
    throw new Error(`Invalid git ref arguments: base=${base}, head=${head}`)
  }
  const stdout = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseCliArgs(argv) {
  const opts = { base: '', head: '', summaryFile: '', skipSync: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--base' && argv[i + 1]) opts.base = argv[++i]
    else if (arg === '--head' && argv[i + 1]) opts.head = argv[++i]
    else if (arg === '--summary-file' && argv[i + 1]) opts.summaryFile = argv[++i]
    else if (arg === '--skip-readme-sync') opts.skipSync = true
  }
  return opts
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv)
  const res = checkReadmes(REPO_ROOT)
  const errors = [...res.errors]
  const warnings = []

  const envSkip = /\[skip-readme-sync\]/i.test(`${process.env.PR_TITLE ?? ''}\n${process.env.PR_BODY ?? ''}\n${process.env.COMMIT_MESSAGE ?? ''}`)
  if (opts.base && opts.head && !/^0+$/.test(opts.base)) {
    const changed = getGitChangedFiles(opts.base, opts.head, REPO_ROOT)
    const diffCheck = analyzeChangedFiles(changed, opts.skipSync || envSkip)
    errors.push(...diffCheck.errors)
    warnings.push(...diffCheck.advisories)
  }

  if (opts.summaryFile) {
    const lines = [
      '### README Sync & Style Lock',
      '',
      errors.length === 0 ? '- Status: **PASS**' : `- Status: **FAIL** (${errors.length} error(s))`,
      ...errors.map((e) => `- Error: ${e}`),
      ...warnings.map((w) => `- Advisory: ${w}`),
      '',
    ]
    fs.appendFileSync(opts.summaryFile, lines.join('\n'), 'utf8')
  }

  for (const w of warnings) console.warn(`[readme-sync:advisory] ${w}`)
  if (errors.length > 0) {
    for (const e of errors) console.error(`[readme-sync:error] ${e}`)
    return 1
  }

  console.log('readme-sync passed: README.md, README.en.md, and server/README.md match style lock and env parity.')
  return 0
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  process.exitCode = main()
}
