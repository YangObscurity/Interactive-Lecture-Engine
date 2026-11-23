/**
 * scripts/check_access_dist.mjs - post-build access gate (docs-dev/ACCESS.md, WP-A1).
 *
 * Run after `npm run build`:
 *
 *   npm run check:access:dist [-- --dist <dir>] [-- --manifest <file>] [-- --ignore-out-dir]
 *
 * `--ignore-out-dir`: the dist was copied away from the build's out dir (the manifest records where it was built and
 * the gate refuses a dist from another place, because a stale manifest could let a leak pass).
 *
 * Reads the gateway manifest the build wrote (site/.lecture-build/access-manifest.json) and the dist
 * (docs/.vitepress/dist by default).
 *
 *   no restricted tier   prints "no restricted tiers" and passes.
 *   (lecture_catalog.json stays in dist, split like the graph: the inline copy is a text file outside every
 *   protected path, so rule 2 below catches a restricted title in it.)
 *   per restricted tier  T (all of these must hold, or the run FAILS):
 *     1. /_access/T/site-data.json, graph.json and search/<locale>.json exist and are valid JSON.
 *     2. Every lecture title and group title of T (all languages, from the manifest) is absent from EVERY text file of
 *        the dist that is not under a protected path of T: the group folders (`/<dir>/`, `/<locale>/<dir>/`),
 *        `/_access/T/` and the page chunks that match T's `pageChunkPatterns`. A hit lists file, tier and title.
 *        This includes the inline search index, the inline site data of every page and the other tiers' files.
 *        Titles that inline text shares, or shorter than 4 characters, are not searchable and are listed as a note.
 *     3. Every page of T has a bundled page chunk `assets/<path with / as _>.md.<hash>.js` and it matches a pattern of T.
 *     4. AI tool data (docs/.vitepress/concepts/toolFiles.mts): /_access/T/tools/concepts.json and lectures.json exist, are
 *        valid JSON and say `tier: T`; tools/tiers.json and the inline tools/concepts.json, lectures.json exist. Every
 *        concept slug, lecture id, lecture route and the first 32 characters of every concept summary, concept text and
 *        lecture section text of T must be absent from every tools/*.json file of a tier whose readers may not read T
 *        (the inline `tools/*.json` of a public site, files of other group tiers). A hit lists file, tier and kind.
 *   WARN only (never fails): images bundled into /assets/ by restricted pages (a path-prefix gateway cannot block
 *   them), graph node ids of T in unprotected files, page ids of T in hashmap.json.
 *
 * The check logic is exported (`checkAccessDist`) so tests/unit/access-check.test.ts can run it on a fixture,
 * including the negative case (a restricted title written into a public file must fail).
 *
 * Exit codes: 0 pass, 1 a check failed, 2 gate broken (no dist, no manifest, manifest of another build).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SITE_DIR = path.resolve(__dirname, '..')

export const DEFAULT_DIST = path.join(SITE_DIR, 'docs', '.vitepress', 'dist')
export const DEFAULT_MANIFEST = path.join(SITE_DIR, '.lecture-build', 'access-manifest.json')

const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.xml', '.txt', '.md', '.svg', '.map', '.webmanifest'])
const IMAGE_RE = /\/assets\/[^"'\s)\\]+?\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico)\b/g
const MIN_NODE_ID = 8
const MAX_LISTED = 5

/** Mirror of concepts/access.ts `canReaderTierReadConcept`: may readers of `readerTier` read content of `contentTier`? */
export function canReadTier(readerTier, contentTier) {
  if (contentTier === 'public') return true
  if (readerTier === 'public') return false
  if (contentTier === 'authenticated') return true
  return readerTier === contentTier
}

const TOOL_FILE_RE = new RegExp('^(?:_access/([^/]+)/)?tools/[^/]+[.]json$')
const SNIPPET_LEN = 32
const MIN_SNIPPET = 24

/** What identifies a tier's content inside its tool files: quoted slugs, ids and routes, and the start of every text. */
function toolNeedles(concepts, lectures) {
  const needles = []
  const add = (kind, value) => {
    if (typeof value === 'string' && value) needles.push({ kind, value })
  }
  const snippet = (kind, text) => {
    const t = typeof text === 'string' ? text.trim() : ''
    // code, table and rule starts are boilerplate shared across lectures; only prose-like starts identify a text
    if (t.length < MIN_SNIPPET || /^(?:`{3}|~{3}|[|]|-{3})/.test(t)) return
    if ((t.slice(0, SNIPPET_LEN).match(/[\p{L}\p{N}]/gu) ?? []).length < 12) return
    add(kind, t.slice(0, SNIPPET_LEN))
  }
  for (const c of concepts?.concepts ?? []) {
    if (typeof c.slug === 'string' && c.slug.length >= 4) add('concept slug', JSON.stringify(c.slug))
    snippet('concept summary', c.summary)
    snippet('concept text', c.markdown)
  }
  for (const l of lectures?.lectures ?? []) {
    if (typeof l.id === 'string' && l.id.length >= 4) add('lecture id', JSON.stringify(l.id))
    if (typeof l.route === 'string' && l.route.length >= 4) add('lecture route', JSON.stringify(l.route))
    for (const sec of l.sections ?? []) snippet('lecture text', sec.text)
  }
  return needles
}

const posix = (p) => p.replace(/\\/g, '/')

/** Thrown for a broken gate (exit code 2). */
export class GateBroken extends Error {}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** Spellings a title can have inside a text file: raw, JSON string, JSON string inside a JSON string, HTML-escaped. */
export function variantsOf(name) {
  const once = JSON.stringify(name).slice(1, -1)
  const twice = JSON.stringify(once).slice(1, -1)
  const html = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return [...new Set([name, once, twice, html])]
}

/**
 * Run the checks. `opts.dist` / `opts.manifest`: paths. Returns `{ ok, failures, warnings, notes }`; throws GateBroken
 * when the inputs are missing or belong to another build.
 */
export function checkAccessDist(opts = {}) {
  const dist = path.resolve(opts.dist ?? DEFAULT_DIST)
  const manifestPath = path.resolve(opts.manifest ?? DEFAULT_MANIFEST)
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new GateBroken(`no build found at ${dist} (run npm run build first)`)
  if (!fs.existsSync(manifestPath)) throw new GateBroken(`no access manifest at ${manifestPath} (written by npm run build)`)
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    throw new GateBroken(`access manifest ${manifestPath} is not valid JSON: ${e.message}`)
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.tiers)) throw new GateBroken(`access manifest ${manifestPath} has an unknown format`)
  if (!opts.ignoreOutDir && manifest.outDir && path.resolve(manifest.outDir) !== dist) {
    throw new GateBroken(`the manifest was written for the build in ${manifest.outDir}, not ${dist}: build again, or pass --manifest of the matching build`)
  }

  const failures = []
  const warnings = []
  const notes = []
  const fail = (msg) => failures.push(msg)

  const tiers = manifest.tiers
  if (tiers.length === 0) {
    if (fs.existsSync(path.join(dist, '_access'))) fail('[tiers] dist/_access exists although the manifest has no restricted tier')
    for (const n of ['tools/tiers.json', 'tools/concepts.json', 'tools/lectures.json']) {
      const f = path.join(dist, n)
      if (!fs.existsSync(f)) continue
      try {
        JSON.parse(fs.readFileSync(f, 'utf8'))
      } catch {
        fail(`[tier-files] ${n} is not valid JSON`)
      }
    }
    notes.push('no restricted tiers')
    return { ok: failures.length === 0, failures, warnings, notes }
  }

  const files = walk(dist)
  const rel = (f) => posix(path.relative(dist, f))
  const relFiles = files.map(rel)
  const assetsLower = relFiles.filter((r) => r.startsWith('assets/'))

  // ---- 1. tier files
  const localeKeys = manifest.localeKeys ?? []
  const bodyNeedles = new Map(tiers.map((t) => [t.id, new Set()]))
  for (const t of tiers) {
    const base = `_access/${t.id}`
    const need = [`${base}/site-data.json`, `${base}/graph.json`]
    for (const l of ['root', ...localeKeys]) {
      need.push(`${base}/search/${l}/manifest.json`, `${base}/search/${l}/titles.json`)
    }
    for (const n of need) {
      const f = path.join(dist, n)
      if (!fs.existsSync(f)) {
        fail(`[tier-files] tier ${t.id}: ${n} is missing`)
        continue
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (n.endsWith('/manifest.json')) {
          const locBase = n.slice(0, -'/manifest.json'.length)
          for (const shard of parsed.shards ?? []) {
            const sp = path.join(dist, locBase, shard.url)
            if (!fs.existsSync(sp)) {
              fail(`[tier-files] tier ${t.id}: ${locBase}/${shard.url} is missing`)
              continue
            }
            try {
              const inflated = zlib.inflateRawSync(fs.readFileSync(sp)).toString('utf8')
              const shardJson = JSON.parse(inflated)
              for (const sec of shardJson.sections ?? []) {
                const txt = typeof sec[3] === 'string' ? sec[3].trim() : ''
                if (txt.length >= 24) bodyNeedles.get(t.id).add(txt.slice(0, 32))
              }
            } catch {
              fail(`[tier-files] tier ${t.id}: ${locBase}/${shard.url} is not valid deflated JSON`)
            }
          }
        }
      } catch {
        fail(`[tier-files] tier ${t.id}: ${n} is not valid JSON`)
      }
    }
  }

  for (const c of relFiles.filter((r) => r.startsWith('assets/chunks/') && /^assets\/chunks\/@localSearchIndex.*\.js$/.test(r))) {
    fail(`[search-legacy] unexpected monolithic local search chunk: ${c}`)
  }

  // ---- 3. page chunks (before the scan so the failure list reads in order)
  for (const t of tiers) {
    const patterns = (t.pageChunkPatterns ?? []).map((p) => new RegExp(p))
    for (const page of t.pages ?? []) {
      const prefix = `assets/${page.replace(/\//g, '_')}.`
      const chunks = assetsLower.filter((a) => a.startsWith(prefix) && a.endsWith('.js'))
      if (chunks.length === 0) {
        fail(`[page-chunks] tier ${t.id}: no bundled page chunk for ${page} (expected assets/${page.replace(/\//g, '_')}.<hash>.js)`)
        continue
      }
      for (const c of chunks) {
        if (!patterns.some((re) => re.test(`/${c}`))) fail(`[page-chunks] tier ${t.id}: /${c} (page ${page}) matches none of ${JSON.stringify(t.pageChunkPatterns)}`)
      }
    }
  }

  // ---- 2. restricted names outside the protected paths
  const protectedBy = (t) => {
    const prefixes = t.pathPrefixes ?? []
    const patterns = (t.pageChunkPatterns ?? []).map((p) => new RegExp(p))
    return (r) => {
      const url = `/${r}`
      return prefixes.some((p) => url.startsWith(p)) || patterns.some((re) => re.test(url))
    }
  }
  const isProtected = new Map(tiers.map((t) => [t.id, protectedBy(t)]))
  const variants = new Map(tiers.map((t) => [t.id, (t.names ?? []).map((n) => ({ name: n, forms: variantsOf(n) }))]))
  for (const t of tiers) {
    if ((t.ambiguousNames ?? []).length) notes.push(`tier ${t.id}: ${t.ambiguousNames.length} title(s) are shared with inline text or shorter than 4 characters and cannot be searched`)
    if ((t.names ?? []).length === 0) fail(`[names] tier ${t.id} has no titles in the manifest: nothing to search for (broken build?)`)
  }

  const hits = new Map() // JSON [tier, file] -> Set(names)
  const nodeHits = new Map() // tier -> Map(file -> Set(ids))
  const imageRefs = new Map() // tier -> Set(images)
  const pathNeedles = new Map(
    tiers.map((t) => [
      t.id,
      (t.dirs ?? []).flatMap((d) => [`"/${d}/`, ...localeKeys.map((k) => `"/${k}/${d}/`)]),
    ]),
  )
  // Collect inline public search text to skip common boilerplate phrases that happen to appear in inline prose too
  let inlineSearchCorpus = ''
  for (const r of relFiles) {
    if (!r.startsWith('search/')) continue
    const f = path.join(dist, r)
    if (r.endsWith('.json')) inlineSearchCorpus += '\n' + fs.readFileSync(f, 'utf8')
    else if (r.endsWith('.sz')) {
      try {
        inlineSearchCorpus += '\n' + zlib.inflateRawSync(fs.readFileSync(f)).toString('utf8')
      } catch {
        fail(`[search-corrupt] ${r} could not be inflated`)
      }
    }
  }
  const uniqueBodyNeedles = new Map(
    tiers.map((t) => [t.id, [...bodyNeedles.get(t.id)].filter((needle) => !t.ambiguousNames?.includes(needle) && needle.length >= 24)]),
  )

  for (const file of files) {
    const r = rel(file)
    const isCompressedShard = r.endsWith('.sz')
    if (!TEXT_EXT.has(path.extname(file).toLowerCase()) && !isCompressedShard) continue
    let text
    if (isCompressedShard) {
      try {
        text = zlib.inflateRawSync(fs.readFileSync(file)).toString('utf8')
      } catch {
        continue
      }
    } else {
      text = fs.readFileSync(file, 'utf8')
    }
    const isPublicSearch = r.startsWith('search/')
    for (const t of tiers) {
      const prot = isProtected.get(t.id)(r)
      if (prot) {
        if (!isCompressedShard) {
          for (const m of text.matchAll(IMAGE_RE)) (imageRefs.get(t.id) ?? imageRefs.set(t.id, new Set()).get(t.id)).add(m[0])
        }
        continue
      }
      for (const { name, forms } of variants.get(t.id)) {
        if (forms.some((f) => text.includes(f))) {
          const key = JSON.stringify([t.id, r])
          if (!hits.has(key)) hits.set(key, new Set())
          hits.get(key).add(name)
        }
      }
      if (isPublicSearch) {
        for (const prefixNeedle of pathNeedles.get(t.id) ?? []) {
          if (text.includes(prefixNeedle)) {
            const key = JSON.stringify([t.id, r])
            if (!hits.has(key)) hits.set(key, new Set())
            hits.get(key).add(prefixNeedle)
          }
        }
        for (const snippetNeedle of uniqueBodyNeedles.get(t.id) ?? []) {
          // Only flag if public search text actually matches a restricted body needle AND not an accidental inline lecture shared string
          if (text.includes(snippetNeedle) && inlineSearchCorpus.includes(snippetNeedle)) {
            // Confirm it's genuinely inside this file (since inlineSearchCorpus concatenated all search files)
            const key = JSON.stringify([t.id, r])
            if (!hits.has(key)) hits.set(key, new Set())
            hits.get(key).add(snippetNeedle)
          }
        }
      }
      if (r.endsWith('.json') || r.endsWith('.js') || r.endsWith('.html')) {
        for (const id of t.nodeIds ?? []) {
          if (id.length >= MIN_NODE_ID && text.includes(`"${id}"`)) {
            const perTier = nodeHits.get(t.id) ?? nodeHits.set(t.id, new Map()).get(t.id)
            if (!perTier.has(r)) perTier.set(r, new Set())
            perTier.get(r).add(id)
          }
        }
      }
    }
  }
  for (const [key, names] of hits) {
    const [tier, file] = JSON.parse(key)
    const list = [...names]
    fail(`[leak] ${file} (tier ${tier}) contains ${list.length} restricted title(s): ${list.slice(0, MAX_LISTED).map((n) => JSON.stringify(n)).join(', ')}${list.length > MAX_LISTED ? ', ...' : ''}`)
  }

  // ---- figures: restricted tier figures & registries stay strictly under _access/<tier>/figures/
  const restrictedFigureNeedles = new Map()
  for (const t of tiers) {
    const figsRoot = path.join(dist, `_access/${t.id}/figures`)
    const needles = new Set()
    for (const dir of t.dirs ?? []) {
      const publicFigDir = path.join(dist, 'figures', ...dir.split('/'))
      if (fs.existsSync(publicFigDir)) {
        fail(`[leak] public figures/${dir} still present for restricted tier ${t.id}`)
      }
      const regPath = path.join(figsRoot, ...dir.split('/'), 'figures.json')
      if (!fs.existsSync(regPath)) continue
      try {
        const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'))
        for (const f of reg.figures ?? []) {
          if (typeof f.file === 'string' && f.file) needles.add(`${dir}/${f.file}`)
          if (typeof f.caption?.zh === 'string' && f.caption.zh.length >= 12) needles.add(f.caption.zh)
          if (typeof f.caption?.en === 'string' && f.caption.en.length >= 12) needles.add(f.caption.en)
          if (typeof f.source?.paper === 'string' && f.source.paper.length >= 12) needles.add(f.source.paper)
        }
      } catch {
        fail(`[tier-files] tier ${t.id}: unreadable ${rel(regPath)}`)
      }
    }
    if (needles.size > 0) restrictedFigureNeedles.set(t.id, [...needles])
  }
  if (restrictedFigureNeedles.size > 0) {
    for (const file of files) {
      const r = rel(file)
      if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue
      const text = fs.readFileSync(file, 'utf8')
      for (const [tierId, needles] of restrictedFigureNeedles) {
        if (isProtected.get(tierId)(r)) continue
        const found = needles.filter((n) => variantsOf(n).some((form) => text.includes(form)))
        if (found.length > 0) {
          fail(`[leak] ${r} (tier ${tierId}) leaks restricted figure data: ${found.slice(0, MAX_LISTED).map((x) => JSON.stringify(x)).join(', ')}`)
        }
      }
    }
  }

  // ---- tool data: files of every tier exist, and no tool file names content its readers may not read
  const inlineTier = manifest.inlineTier ?? 'public'
  const readJson = (n) => {
    const f = path.join(dist, n)
    if (!fs.existsSync(f)) {
      fail(`[tier-files] ${n} is missing`)
      return null
    }
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'))
    } catch {
      fail(`[tier-files] ${n} is not valid JSON`)
      return null
    }
  }
  readJson('tools/tiers.json')
  const toolTiers = [{ id: inlineTier, dir: 'tools' }, ...tiers.map((t) => ({ id: t.id, dir: `_access/${t.id}/tools` }))]
  const toolData = new Map()
  for (const tt of toolTiers) {
    const concepts = readJson(`${tt.dir}/concepts.json`)
    const lectures = readJson(`${tt.dir}/lectures.json`)
    for (const [n, data] of [[`${tt.dir}/concepts.json`, concepts], [`${tt.dir}/lectures.json`, lectures]]) {
      if (data && data.tier !== tt.id) fail(`[tier-files] ${n} says tier ${JSON.stringify(data.tier)}, expected ${JSON.stringify(tt.id)}`)
    }
    toolData.set(tt.id, { concepts, lectures })
  }
  const ownCache = new Map()
  const ownSnippets = (tierId) => {
    if (!ownCache.has(tierId)) {
      const d = toolData.get(tierId)
      ownCache.set(tierId, new Set(toolNeedles(d?.concepts, d?.lectures).map((n) => n.value)))
    }
    return ownCache.get(tierId)
  }
  for (const t of tiers) {
    const data = toolData.get(t.id)
    const needles = toolNeedles(data?.concepts, data?.lectures).map((n) => ({ ...n, forms: variantsOf(n.value) }))
    if (needles.length === 0) continue
    for (const r of relFiles) {
      const m = TOOL_FILE_RE.exec(r)
      if (!m) continue
      const fileTier = m[1] ?? inlineTier
      if (fileTier === t.id || canReadTier(fileTier, t.id)) continue
      const text = fs.readFileSync(path.join(dist, r), 'utf8')
      // text that starts the same way in the file's own tier (a shared boilerplate section, the same code block) is not a leak
      const own = ownSnippets(fileTier)
      const found = needles.filter((n) => !(n.kind.endsWith('text') && own.has(n.value)) && n.forms.some((f) => text.includes(f)))
      if (found.length === 0) continue
      const kinds = [...new Set(found.map((n) => n.kind))]
      fail(`[leak] ${r} (tier ${t.id}) contains ${found.length} restricted tool item(s) (${kinds.join(', ')}): ${found.slice(0, MAX_LISTED).map((n) => JSON.stringify(n.value)).join(', ')}${found.length > MAX_LISTED ? ', ...' : ''}`)
    }
  }

  // ---- warnings
  for (const t of tiers) {
    const imgs = [...(imageRefs.get(t.id) ?? [])].sort()
    if (imgs.length) warnings.push(`tier ${t.id}: ${imgs.length} image(s) are bundled into /assets/ by restricted pages and cannot be blocked by prefix: ${imgs.slice(0, MAX_LISTED).join(', ')}${imgs.length > MAX_LISTED ? ', ...' : ''}`)
    const nodes = nodeHits.get(t.id)
    if (nodes?.size) {
      const all = new Set([...nodes.values()].flatMap((s) => [...s]))
      warnings.push(`tier ${t.id}: ${all.size} graph node id(s) of the tier appear in ${nodes.size} unprotected file(s) (ids only, no titles; prerequisites/subsequents of inline nodes): ${[...nodes.keys()].slice(0, MAX_LISTED).join(', ')}`)
    }
    const hashmap = path.join(dist, 'hashmap.json')
    if (fs.existsSync(hashmap)) {
      try {
        const keys = Object.keys(JSON.parse(fs.readFileSync(hashmap, 'utf8')))
        const mine = new Set((t.pages ?? []).map((p) => p.replace(/\//g, '_').toLowerCase()))
        const n = keys.filter((k) => mine.has(k)).length
        if (n) warnings.push(`tier ${t.id}: ${n} page id(s) are listed in hashmap.json and in the __VP_HASH_MAP__ script of every page (ids such as g05_l19.md, no titles)`)
      } catch {
        /* an unreadable hashmap.json is not this gate's concern */
      }
    }
  }
  return { ok: failures.length === 0, failures, warnings, notes }
}

function main() {
  const argv = process.argv.slice(2)
  const arg = (name) => {
    const i = argv.indexOf(name)
    return i > -1 ? argv[i + 1] : undefined
  }
  let result
  try {
    result = checkAccessDist({ dist: arg('--dist'), manifest: arg('--manifest'), ignoreOutDir: argv.includes('--ignore-out-dir') })
  } catch (e) {
    if (e instanceof GateBroken) {
      console.error(`[access-dist] GATE BROKEN: ${e.message}`)
      process.exit(2)
    }
    throw e
  }
  for (const n of result.notes) console.log(`[access-dist] note: ${n}`)
  for (const w of result.warnings) console.log(`[access-dist] WARN: ${w}`)
  if (result.ok) {
    console.log(`[access-dist] PASS${result.notes.includes('no restricted tiers') ? ' (no restricted tiers)' : ''}`)
    return
  }
  for (const f of result.failures) console.error(`[access-dist] FAIL ${f}`)
  console.error(`[access-dist] FAIL: ${result.failures.length} problem(s)`)
  process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
