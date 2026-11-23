#!/usr/bin/env node
/**
 * scripts/check_i18n_dist.mjs - post-build i18n gate (plan_v2_p2d_i18n.md section 5, WP-I2).
 *
 * Run after `npm run build`, against docs/.vitepress/dist (or `--dist <dir>`):
 *
 *   1. translated pages: every dist/<key>/**\/L<digits>.html has a source docs/<key>/**\/L<digits>.md and the other
 *      way round; every `/<key>/...` link of a locale page (sidebar, nav, prev/next) points to a page in dist.
 *   2. search index: VitePress 1.6.4 emits one local-search index chunk per locale, dist/assets/chunks/
 *      @localSearchIndex<locale key>.<hash>.js (`root` for the root language). RULE: the chunk of every non-root
 *      locale must contain no CJK ideograph (U+3400-U+9FFF); the root chunk must not index any `/<key>/` page.
 *      A translation that has to quote Chinese must do it outside searchable text or accept this gate failing.
 *   3. SEO, depending on whether the build had SITE_URL (resolved like the build does: real env var, then repo-root
 *      .env; the value is never printed):
 *        set    - every page that has hreflang links lists itself (hreflang = its <html lang>), every alternate maps
 *                 to a page in dist, alternates are reciprocal (all versions carry the same set), x-default points
 *                 to the root-language version; every page that exists in >= 2 languages has them; sitemap.xml
 *                 exists, its <loc> / xhtml:link URLs exist in dist, and it has xhtml:link entries.
 *        unset  - no sitemap.xml and no `hreflang` in any page.
 *      Assumes `base` is `/` (VitePress writes the sitemap without it as well) and the default `cleanUrls`.
 *
 * Exit codes: 0 pass, 1 a check failed, 2 gate broken (no dist, unreadable config).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SITE_DIR = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(SITE_DIR, '..')
const DOCS_DIR = path.join(SITE_DIR, 'docs')

function broken(msg) {
  console.error(`[i18n-dist] GATE BROKEN: ${msg}`)
  process.exit(2)
}

const distArg = process.argv.indexOf('--dist')
const DIST = path.resolve(distArg > -1 && process.argv[distArg + 1] ? process.argv[distArg + 1] : path.join(DOCS_DIR, '.vitepress', 'dist'))
if (!fs.existsSync(path.join(DIST, 'index.html'))) broken(`no build found at ${DIST} (run npm run build first)`)

const posix = (p) => p.replace(/\\/g, '/')
const failures = []
const fail = (check, msg) => failures.push(`[${check}] ${msg}`)

function walk(dir, filter, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, filter, out)
    else if (filter(p)) out.push(p)
  }
  return out
}

// ---- inputs ----------------------------------------------------------------------------------------------
const htmlFiles = walk(DIST, (p) => p.endsWith('.html')).map((p) => posix(path.relative(DIST, p)))
const htmlSet = new Set(htmlFiles)
const readHtml = (rel) => fs.readFileSync(path.join(DIST, rel), 'utf-8')

const chunksDir = path.join(DIST, 'assets', 'chunks')
const legacySearchChunks = []
if (fs.existsSync(chunksDir)) {
  for (const f of fs.readdirSync(chunksDir)) {
    if (/^@localSearchIndex.*\.js$/.test(f)) legacySearchChunks.push(f)
  }
}

const searchRootDir = path.join(DIST, 'search')
const searchLocales = fs.existsSync(searchRootDir)
  ? fs.readdirSync(searchRootDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : []
const localeKeys = searchLocales.filter((k) => k !== 'root')

/** dist file (`en/g01/L01.html`) -> URL path (`/en/g01/L01`, `/en/g01/`, `/`). */
function urlPathOf(rel) {
  if (rel === 'index.html') return '/'
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'index.html'.length)
  return '/' + rel.slice(0, -'.html'.length)
}
/** URL path -> dist file, or null. */
function fileOfUrlPath(p) {
  const clean = decodeURI(p.split(/[?#]/, 1)[0])
  const candidates = clean.endsWith('/') ? [clean.slice(1) + 'index.html'] : [clean.slice(1) + '.html', clean.slice(1) + '/index.html']
  return candidates.find((c) => htmlSet.has(c)) ?? null
}

// ---- 1. translated pages ---------------------------------------------------------------------------------
function checkTranslatedPages() {
  for (const key of localeKeys) {
    const srcDir = path.join(DOCS_DIR, key)
    const src = fs.existsSync(srcDir) ? walk(srcDir, (p) => /[\\/]L\d+\.md$/.test(p)).map((p) => posix(path.relative(DOCS_DIR, p)).slice(0, -3)) : []
    const built = htmlFiles.filter((f) => f.startsWith(key + '/') && /(^|\/)L\d+\.html$/.test(f)).map((f) => f.slice(0, -'.html'.length))
    for (const b of built) if (!src.includes(b)) fail('pages', `dist/${b}.html has no source docs/${b}.md`)
    for (const s of src) if (!built.includes(s)) fail('pages', `docs/${s}.md was not built to dist/${s}.html`)
    for (const rel of htmlFiles.filter((f) => f.startsWith(key + '/'))) {
      const html = readHtml(rel)
      const bad = new Set()
      for (const m of html.matchAll(/href="(\/[^"]*)"/g)) {
        const href = m[1]
        if (!href.startsWith(`/${key}/`) && href !== `/${key}`) continue
        if (fileOfUrlPath(href === `/${key}` ? `/${key}/` : href) === null) bad.add(href)
      }
      for (const b of bad) fail('pages', `${rel}: link ${b} points to a page that is not in dist`)
    }
    console.log(`[i18n-dist] pages    ${key}: ${built.length} translated lecture page(s), links checked in ${htmlFiles.filter((f) => f.startsWith(key + '/')).length} page(s)`)
  }
  // a language without a search index (not enabled) must leave no folder behind
  if (!localeKeys.includes('en') && fs.existsSync(path.join(DIST, 'en'))) fail('pages', 'dist/en exists but no English search index was built (language disabled?)')
}

// ---- 2. search index -------------------------------------------------------------------------------------
function readSearchTextsForLocale(loc) {
  const dir = path.join(searchRootDir, loc)
  const out = []
  const titlesPath = path.join(dir, 'titles.json')
  if (fs.existsSync(titlesPath)) out.push({ label: `search/${loc}/titles.json`, text: fs.readFileSync(titlesPath, 'utf-8') })
  const manifestPath = path.join(dir, 'manifest.json')
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    for (const s of manifest.shards ?? []) {
      const sp = path.join(dir, s.url)
      if (!fs.existsSync(sp)) {
        fail('search', `missing shard ${posix(path.relative(DIST, sp))}`)
        continue
      }
      const raw = zlib.inflateRawSync(fs.readFileSync(sp)).toString('utf-8')
      out.push({ label: `search/${loc}/${s.url}`, text: raw })
    }
  }
  return out
}

function checkSearchIndex() {
  for (const legacy of legacySearchChunks) {
    fail('search', `legacy monolithic search chunk still present: assets/chunks/${legacy}`)
  }
  if (!searchLocales.includes('root')) {
    fail('search', 'missing dist/search/root index bundle')
  }
  const rootMan = path.join(searchRootDir, 'root', 'manifest.json')
  const rootTitles = path.join(searchRootDir, 'root', 'titles.json')
  if (fs.existsSync(rootMan) && fs.existsSync(rootTitles)) {
    const titleSize = fs.statSync(rootTitles).size
    const man = JSON.parse(fs.readFileSync(rootMan, 'utf-8'))
    let shardSum = 0
    for (const s of man.shards ?? []) {
      const sp = path.join(searchRootDir, 'root', s.url)
      if (fs.existsSync(sp)) shardSum += fs.statSync(sp).size
    }
    if (titleSize > 1024 * 1024) fail('search', `root titles.json (${titleSize} bytes) exceeds 1 MiB budget`)
    if (shardSum > 8 * 1024 * 1024) fail('search', `root shards total (${shardSum} bytes) exceeds 8 MiB budget`)
    console.log(`[i18n-dist] search   root: titles=${(titleSize / 1024).toFixed(1)} KB, shards=${(shardSum / 1024 / 1024).toFixed(2)} MB`)
  }
  for (const key of localeKeys) {
    let totalCjk = 0
    const texts = readSearchTextsForLocale(key)
    for (const item of texts) {
      const cjk = item.text.match(/[㐀-鿿]/g)
      if (cjk) {
        totalCjk += cjk.length
        const at = item.text.search(/[㐀-鿿]/)
        fail('search', `${item.label} contains ${cjk.length} CJK character(s), e.g. "${item.text.slice(Math.max(0, at - 20), at + 20).replace(/\s+/g, ' ')}"`)
      }
    }
    console.log(`[i18n-dist] search   ${key}: ${texts.length} search file(s), ${totalCjk} CJK character(s)`)
  }
  if (searchLocales.includes('root')) {
    for (const item of readSearchTextsForLocale('root')) {
      for (const key of localeKeys) {
        if (item.text.includes(`"/${key}/`)) fail('search', `${item.label} contains /${key}/ pages`)
      }
    }
  }
}

// ---- 3. hreflang + sitemap -------------------------------------------------------------------------------
async function resolveSiteUrl() {
  const envMod = await import(pathToFileURL(path.join(SITE_DIR, 'scripts', 'config', 'env.mts')).href)
  const schemaMod = await import(pathToFileURL(path.join(SITE_DIR, 'config', 'schema.ts')).href)
  const setting = schemaMod.SETTINGS.filter((s) => s.key === 'SITE_URL')
  return envMod.resolveAll(envMod.loadSources({ repoRoot: REPO_ROOT }), setting)[0]?.value || ''
}

function alternatesOf(html) {
  const out = []
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = m[0]
    if (!/\brel="alternate"/.test(tag)) continue
    const lang = /\bhreflang="([^"]*)"/.exec(tag)?.[1]
    const href = /\bhref="([^"]*)"/.exec(tag)?.[1]
    if (lang !== undefined && href !== undefined) out.push({ lang, href })
  }
  return out
}

async function checkSeo() {
  let siteUrl = ''
  try {
    siteUrl = await resolveSiteUrl()
  } catch (e) {
    broken(`cannot resolve SITE_URL: ${e instanceof Error ? e.message : e}`)
  }
  const sitemap = path.join(DIST, 'sitemap.xml')

  if (!siteUrl) {
    if (fs.existsSync(sitemap)) fail('seo', 'SITE_URL is not set but dist/sitemap.xml exists')
    const withHreflang = htmlFiles.filter((f) => readHtml(f).includes('hreflang'))
    for (const f of withHreflang.slice(0, 10)) fail('seo', `SITE_URL is not set but ${f} has hreflang`)
    if (withHreflang.length > 10) fail('seo', `... and ${withHreflang.length - 10} more page(s) with hreflang`)
    console.log('[i18n-dist] seo      SITE_URL not set: no sitemap.xml, no hreflang')
    return
  }

  let origin
  try {
    origin = new URL(siteUrl).origin
  } catch {
    broken('SITE_URL is set but is not a valid URL')
  }
  const rootLang = /<html[^>]*\blang="([^"]*)"/.exec(readHtml('index.html'))?.[1]
  const versions = new Map() // rel -> alternates
  const langOf = new Map()
  for (const rel of htmlFiles) {
    const html = readHtml(rel)
    langOf.set(rel, /<html[^>]*\blang="([^"]*)"/.exec(html)?.[1])
    const alts = alternatesOf(html)
    if (alts.length) versions.set(rel, alts)
  }

  const absOf = (rel) => origin + urlPathOf(rel)
  const toRel = (href) => (href.startsWith(origin) ? fileOfUrlPath(href.slice(origin.length) || '/') : null)
  const key = (alts) => alts.map((a) => `${a.lang}=${a.href}`).sort().join('|')

  for (const [rel, alts] of versions) {
    const self = alts.filter((a) => a.lang !== 'x-default' && a.href === absOf(rel))
    if (self.length !== 1) fail('seo', `${rel}: does not list itself exactly once in its hreflang links`)
    else if (self[0].lang !== langOf.get(rel)) fail('seo', `${rel}: lists itself as hreflang="${self[0].lang}" but its <html lang> is "${langOf.get(rel)}"`)
    const defaults = alts.filter((a) => a.lang === 'x-default')
    if (defaults.length !== 1) fail('seo', `${rel}: expected exactly one x-default, found ${defaults.length}`)
    else {
      const target = toRel(defaults[0].href)
      const rootAlt = alts.find((a) => a.lang === rootLang)
      if (!rootAlt || rootAlt.href !== defaults[0].href) fail('seo', `${rel}: x-default is not the root-language (${rootLang}) version`)
      else if (target && keyOfLocale(target) !== null) fail('seo', `${rel}: x-default points to a locale page (${target})`)
    }
    for (const a of alts) {
      if (a.lang === 'x-default') continue
      const target = toRel(a.href)
      if (!target) {
        fail('seo', `${rel}: alternate ${a.lang} -> ${a.href.replace(origin, '<site>')} is not a page in dist`)
        continue
      }
      if (key(versions.get(target) ?? []) !== key(alts)) fail('seo', `${rel}: alternates are not reciprocal with ${target} (the two pages carry different hreflang sets)`)
    }
  }

  // every page that exists in >= 2 languages must have hreflang
  for (const k of localeKeys) {
    for (const rel of htmlFiles.filter((f) => f.startsWith(k + '/'))) {
      const rest = rel.slice(k.length + 1)
      if (htmlSet.has(rest) && !versions.has(rel)) fail('seo', `${rel} has a root-language twin (${rest}) but no hreflang links`)
      if (htmlSet.has(rest) && !versions.has(rest)) fail('seo', `${rest} has a translation (${rel}) but no hreflang links`)
    }
  }

  if (!fs.existsSync(sitemap)) fail('seo', 'SITE_URL is set but dist/sitemap.xml does not exist')
  else {
    const xml = fs.readFileSync(sitemap, 'utf-8')
    const links = [...xml.matchAll(/<xhtml:link\b[^>]*>/g)]
    if (localeKeys.length && !links.length) fail('seo', 'sitemap.xml has no xhtml:link entries')
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      if (!toRel(m[1])) fail('seo', `sitemap.xml: ${m[1].replace(origin, '<site>')} is not a page in dist`)
    }
    for (const l of links) {
      const href = /\bhref="([^"]*)"/.exec(l[0])?.[1] ?? ''
      if (!toRel(href)) fail('seo', `sitemap.xml: xhtml:link ${href.replace(origin, '<site>')} is not a page in dist`)
    }
    console.log(`[i18n-dist] seo      SITE_URL set: ${versions.size} page(s) with hreflang, sitemap.xml with ${links.length} xhtml:link entr${links.length === 1 ? 'y' : 'ies'}`)
  }

  function keyOfLocale(rel) {
    return localeKeys.find((k) => rel.startsWith(k + '/')) ?? null
  }
}

checkTranslatedPages()
checkSearchIndex()
await checkSeo()

if (failures.length) {
  const shown = failures.slice(0, 40)
  console.error(`[i18n-dist] FAIL - ${failures.length} problem(s):\n  ${shown.join('\n  ')}${failures.length > shown.length ? `\n  ... and ${failures.length - shown.length} more` : ''}`)
  process.exit(1)
}
console.log(`[i18n-dist] PASS - ${htmlFiles.length} page(s), locales: root${localeKeys.length ? ', ' + localeKeys.join(', ') : ' only'}`)
