import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { GateBroken, checkAccessDist, variantsOf } from '../../scripts/check_access_dist.mjs'
import { DEFAULT_BUILD_HEAP_MB, parseBuildArgs, resolveBuildHeap } from '../../scripts/build.mjs'
import { placeShared } from '../../docs/.vitepress/access/build.mts'

const TITLE = '第3讲 · VPC 虚拟私有云与混合网络'
const TITLE_Q = '第4讲 · "引号" 与 <尖括号> & 与号'
const BODY_SECRET = 'RESTRICTED_VPC_SUBNET_SECRET_9941_NEEDLE'
const TOOL_CONCEPT_SLUG = 'vpc-peering-secret'
const TOOL_SECTION_TEXT = 'Restricted peering routes between private subnets are never advertised outside the VPC.'
const TOOL_CONCEPT_TEXT = 'Peering joins two private networks so that hosts reach each other without crossing the internet.'
const roots: string[] = []

function write(root: string, rel: string, content: string): void {
  const f = path.join(root, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, content, 'utf8')
}

function writeSplitSearch(
  dist: string,
  prefix: string,
  locale: string,
  shards: Array<{ shardId: string; groupId: string; pages: string[]; sections: Array<[number, string, string[], string]> }>,
  titlePages: unknown[] = [],
): void {
  const titleJson = JSON.stringify({ v: 1, locale, groups: [], pages: titlePages })
  write(dist, `${prefix}/${locale}/titles.json`, titleJson)
  const metaShards = shards.map((s) => {
    const raw = Buffer.from(JSON.stringify({ v: 1, shardId: s.shardId, groupId: s.groupId, pages: s.pages, sections: s.sections }), 'utf8')
    const compressed = zlib.deflateRawSync(raw, { level: 9 })
    const rel = `shards/${s.shardId}.sz`
    const f = path.join(dist, `${prefix}/${locale}/${rel}`)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, compressed)
    return { shardId: s.shardId, groupId: s.groupId, url: rel, bytes: compressed.byteLength, rawBytes: raw.byteLength, pageCount: s.pages.length }
  })
  write(
    dist,
    `${prefix}/${locale}/manifest.json`,
    JSON.stringify({ v: 1, locale, titleFile: 'titles.json', titleBytes: Buffer.byteLength(titleJson), totalShardBytes: 0, totalRawShardBytes: 0, shards: metaShards }),
  )
}

/** `tools/*.json` of one tier as `concepts/toolFiles.mts` writes them (the fields the gate reads are enough). */
function writeTools(dist: string, tier: string, inlineTier: string, concept: { slug: string; summary: string; markdown: string }, lecture: { id: string; route: string; text: string }): void {
  const dir = tier === inlineTier ? 'tools' : `_access/${tier}/tools`
  write(dist, `${dir}/concepts.json`, JSON.stringify({ version: 1, tier, generatedAt: '2026-01-01T00:00:00.000Z', concepts: [{ ...concept, term: 'x', links: [], backlinks: [], lectures: [] }] }))
  write(dist, `${dir}/lectures.json`, JSON.stringify({ version: 1, tier, lectures: [{ route: lecture.route, id: lecture.id, group: 'G', title: 't', sections: [{ heading: 'h', anchor: 'h', text: lecture.text }] }] }))
}

const GROUP_TIER_TOOLS = {
  concept: { slug: 'group-only-concept', summary: 'Only the staff group may read this summary text.', markdown: 'Only the staff group may read this concept text.' },
  lecture: { id: 'G12-L01', route: '/g12/L01', text: 'Only the staff group may read this lecture section.' },
}

function writeAllTools(dist: string): void {
  write(dist, 'tools/tiers.json', JSON.stringify({ version: 1, tiers: [] }))
  writeTools(dist, 'public', 'public', { slug: 'resistor-basics', summary: 'Resistors limit current in a circuit.', markdown: 'Resistors limit current in a circuit, as Ohm law says.' }, { id: 'G06-L01', route: '/g06/L01', text: 'Public resistor notes about colour codes and tolerance bands.' })
  writeTools(dist, 'authenticated', 'public', { slug: TOOL_CONCEPT_SLUG, summary: TOOL_CONCEPT_TEXT, markdown: TOOL_CONCEPT_TEXT }, { id: 'G09-L01', route: '/g09/L01', text: TOOL_SECTION_TEXT })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(dist: string, rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(dist, rel), 'utf8'))
}

/** A tiny dist: a public group g06, a restricted group g09 (tier `authenticated`), one locale `en`. */
function fixture(): { dist: string; manifest: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'access-check-'))
  roots.push(root)
  const dist = path.join(root, 'dist')
  write(dist, 'index.html', '<html><script>__VP_SITE_DATA__=JSON.parse("{}")</script></html>')
  write(dist, 'g06/L01.html', '<html><h1>public lecture</h1></html>')
  write(dist, 'g09/L01.html', `<html><h1>${TITLE}</h1></html>`)
  write(dist, 'en/g09/index.html', `<html>${TITLE_Q.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</html>`)
  write(dist, 'assets/g06_L01.md.AAAAAAAA.js', 'export default "public"')
  write(dist, 'assets/g09_L01.md.BBBBBBBB.js', `export default ${JSON.stringify(TITLE)}; const img="/assets/diagram.CCCCCCCC.png"`)
  write(dist, 'assets/en_g09_index.md.DDDDDDDD.js', 'export default "en"')
  writeSplitSearch(dist, 'search', 'root', [{ shardId: 'g06', groupId: 'G06', pages: ['/g06/L01'], sections: [[0, 's1', ['Intro'], 'public resistor notes']] }])
  writeSplitSearch(dist, 'search', 'en', [])
  write(dist, 'hashmap.json', JSON.stringify({ 'g06_l01.md': 'AAAAAAAA', 'g09_l01.md': 'BBBBBBBB' }))
  write(dist, '_access/authenticated/site-data.json', JSON.stringify({ title: TITLE }))
  write(dist, '_access/authenticated/graph.json', '[]')
  writeSplitSearch(
    dist,
    '_access/authenticated/search',
    'root',
    [{ shardId: 'g09', groupId: 'G09', pages: ['/g09/L01'], sections: [[0, 's1', ['VPC'], BODY_SECRET]] }],
    [[0, 1, 'G09-L01', '/g09/L01', TITLE, []]],
  )
  writeSplitSearch(dist, '_access/authenticated/search', 'en', [])
  write(dist, 'notion_knowledge_graph.json', '[]')
  writeAllTools(dist)
  const manifest = path.join(root, 'access-manifest.json')
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      outDir: dist.split(path.sep).join('/'),
      localeKeys: ['en'],
      inlineTier: 'public',
      tiers: [
        {
          id: 'authenticated',
          rule: { kind: 'authenticated' },
          groupIds: ['G09'],
          dirs: ['g09'],
          pathPrefixes: ['/g09/', '/en/g09/', '/_access/authenticated/'],
          pageChunkPatterns: ['^/assets/g09_', '^/assets/en_g09_'],
          pages: ['g09/L01.md', 'en/g09/index.md'],
          names: [TITLE, TITLE_Q],
          ambiguousNames: [],
          nodeIds: [],
        },
      ],
    }),
  )
  return { dist, manifest }
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('check_access_dist', () => {
  it('passes a dist whose restricted titles live only under the protected paths; lists the bundled image as a warning', () => {
    const { dist, manifest } = fixture()
    const r = checkAccessDist({ dist, manifest })
    expect(r.failures).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => /1 image\(s\) are bundled into \/assets\/.*diagram\.CCCCCCCC\.png/.test(w))).toBe(true)
    expect(r.warnings.some((w) => /1 page id\(s\) are listed in hashmap\.json/.test(w))).toBe(true)
  })

  it('NEGATIVE: a restricted title written into a public page makes it fail, naming file, tier and title', () => {
    const { dist, manifest } = fixture()
    fs.appendFileSync(path.join(dist, 'g06/L01.html'), `<p>${TITLE}</p>`)
    const r = checkAccessDist({ dist, manifest })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(/\[leak\] g06\/L01\.html \(tier authenticated\).*第3讲 · VPC/)
  })

  it('NEGATIVE: titles or restricted body text are found in public search titles.json, inflated public shards, inline site data and HTML', () => {
    const a = fixture()
    write(a.dist, 'search/root/titles.json', JSON.stringify({ v: 1, locale: 'root', groups: [], pages: [[0, 1, 'G09-L01', '/g09/L01', TITLE, []]] }))
    expect(checkAccessDist(a).failures.join('\n')).toContain('search/root/titles.json')
    const s = fixture()
    writeSplitSearch(s.dist, 'search', 'root', [{ shardId: 'g06', groupId: 'G06', pages: ['/g06/L01'], sections: [[0, 's1', ['Leak'], `public text with ${BODY_SECRET}`]] }])
    expect(checkAccessDist(s).failures.join('\n')).toContain('search/root/shards/g06.sz')
    const l = fixture()
    write(l.dist, 'assets/chunks/@localSearchIndexroot.EEEEEEEE.js', "const t='{}'")
    expect(checkAccessDist(l).failures.join('\n')).toMatch(/\[search-legacy\]/)
    const b = fixture()
    // inline site data: a JSON string inside JSON.parse("...")
    fs.appendFileSync(path.join(b.dist, 'index.html'), `<script>JSON.parse(${JSON.stringify(JSON.stringify({ t: TITLE_Q }))})</script>`)
    expect(checkAccessDist(b).failures.join('\n')).toMatch(/index\.html \(tier authenticated\)/)
    const c = fixture()
    fs.appendFileSync(path.join(c.dist, 'g06/L01.html'), `<p>${TITLE_Q.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</p>`)
    expect(checkAccessDist(c).failures.join('\n')).toMatch(/g06\/L01\.html/)
  })

  it('NEGATIVE: a title in a page chunk that no tier pattern protects, and a page chunk outside the patterns, fail', () => {
    const a = fixture()
    write(a.dist, 'assets/other_L01.md.FFFFFFFF.js', `export default ${JSON.stringify(TITLE)}`)
    expect(checkAccessDist(a).failures.join('\n')).toContain('assets/other_L01.md.FFFFFFFF.js')
    const b = fixture()
    const m = JSON.parse(fs.readFileSync(b.manifest, 'utf8'))
    m.tiers[0].pageChunkPatterns = ['^/assets/zzz_']
    fs.writeFileSync(b.manifest, JSON.stringify(m))
    expect(checkAccessDist(b).failures.join('\n')).toMatch(/matches none of/)
    const c = fixture()
    fs.rmSync(path.join(c.dist, 'assets/g09_L01.md.BBBBBBBB.js'))
    expect(checkAccessDist(c).failures.join('\n')).toMatch(/no bundled page chunk for g09\/L01\.md/)
  })

  it("NEGATIVE: one tier's titles inside another tier's protected path fail too", () => {
    const { dist, manifest } = fixture()
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    m.tiers.push({ id: 'grp-12345678', rule: { kind: 'groups', groups: ['x'] }, groupIds: ['G12'], dirs: ['g12'], pathPrefixes: ['/g12/', '/_access/grp-12345678/'], pageChunkPatterns: ['^/assets/g12_'], pages: [], names: ['Secret group lecture title'], ambiguousNames: [], nodeIds: [] })
    fs.writeFileSync(manifest, JSON.stringify(m))
    write(dist, '_access/grp-12345678/site-data.json', '{}')
    write(dist, '_access/grp-12345678/graph.json', '[]')
    writeTools(dist, 'grp-12345678', 'public', GROUP_TIER_TOOLS.concept, GROUP_TIER_TOOLS.lecture)
    writeSplitSearch(dist, '_access/grp-12345678/search', 'root', [])
    writeSplitSearch(dist, '_access/grp-12345678/search', 'en', [])
    fs.appendFileSync(path.join(dist, 'g09/L01.html'), '<p>Secret group lecture title</p>')
    const r = checkAccessDist({ dist, manifest })
    expect(r.failures.join('\n')).toMatch(/\[leak\] g09\/L01\.html \(tier grp-12345678\)/)
  })

  it('tool data: passes when each tool file names only content its tier may read (a restricted file may name public content)', () => {
    const { dist, manifest } = fixture()
    const restricted = readJson(dist, '_access/authenticated/tools/concepts.json')
    restricted.concepts[0].links = ['resistor-basics']
    restricted.concepts[0].lectures = [{ route: '/g06/L01', id: 'G06-L01', title: 'public lecture', count: 1 }]
    write(dist, '_access/authenticated/tools/concepts.json', JSON.stringify(restricted))
    const r = checkAccessDist({ dist, manifest })
    expect(r.failures).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('NEGATIVE tool data: a restricted slug, id, route, summary or section text in a public tools/*.json fails, naming file, tier and kind', () => {
    const slug = fixture()
    const c = readJson(slug.dist, 'tools/concepts.json')
    c.concepts[0].links = [TOOL_CONCEPT_SLUG]
    write(slug.dist, 'tools/concepts.json', JSON.stringify(c))
    expect(checkAccessDist(slug).failures.join('\n')).toMatch(/\[leak\] tools\/concepts\.json \(tier authenticated\).*concept slug.*vpc-peering-secret/)

    const lec = fixture()
    const l = readJson(lec.dist, 'tools/lectures.json')
    l.lectures[0].sections[0].text += `\n${TOOL_SECTION_TEXT}`
    write(lec.dist, 'tools/lectures.json', JSON.stringify(l))
    expect(checkAccessDist(lec).failures.join('\n')).toMatch(/\[leak\] tools\/lectures\.json \(tier authenticated\).*lecture text/)

    const ids = fixture()
    const l2 = readJson(ids.dist, 'tools/lectures.json')
    l2.lectures.push({ route: '/g09/L01', id: 'G09-L01', group: 'G09', title: 'x', sections: [] })
    write(ids.dist, 'tools/lectures.json', JSON.stringify(l2))
    expect(checkAccessDist(ids).failures.join('\n')).toMatch(/tools\/lectures\.json \(tier authenticated\).*lecture id, lecture route/)

    const summary = fixture()
    const c2 = readJson(summary.dist, 'tools/concepts.json')
    c2.concepts[0].summary = TOOL_CONCEPT_TEXT
    write(summary.dist, 'tools/concepts.json', JSON.stringify(c2))
    expect(checkAccessDist(summary).failures.join('\n')).toMatch(/tools\/concepts\.json \(tier authenticated\).*concept summary/)
  })

  it('NEGATIVE tool data: content of one group tier in the tools file of another tier fails; a missing or mislabelled tool file fails', () => {
    const { dist, manifest } = fixture()
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    m.tiers.push({ id: 'grp-12345678', rule: { kind: 'groups', groups: ['x'] }, groupIds: ['G12'], dirs: ['g12'], pathPrefixes: ['/g12/', '/_access/grp-12345678/'], pageChunkPatterns: ['^/assets/g12_'], pages: [], names: ['Secret group lecture title'], ambiguousNames: [], nodeIds: [] })
    fs.writeFileSync(manifest, JSON.stringify(m))
    write(dist, '_access/grp-12345678/site-data.json', '{}')
    write(dist, '_access/grp-12345678/graph.json', '[]')
    writeSplitSearch(dist, '_access/grp-12345678/search', 'root', [])
    writeSplitSearch(dist, '_access/grp-12345678/search', 'en', [])
    writeTools(dist, 'grp-12345678', 'public', GROUP_TIER_TOOLS.concept, GROUP_TIER_TOOLS.lecture)
    expect(checkAccessDist({ dist, manifest }).failures).toEqual([])
    const a = readJson(dist, '_access/authenticated/tools/concepts.json')
    a.concepts[0].links = ['group-only-concept']
    write(dist, '_access/authenticated/tools/concepts.json', JSON.stringify(a))
    expect(checkAccessDist({ dist, manifest }).failures.join('\n')).toMatch(/\[leak\] _access\/authenticated\/tools\/concepts\.json \(tier grp-12345678\)/)

    const miss = fixture()
    fs.rmSync(path.join(miss.dist, '_access/authenticated/tools/lectures.json'))
    fs.rmSync(path.join(miss.dist, 'tools/tiers.json'))
    const f = checkAccessDist(miss).failures.join('\n')
    expect(f).toMatch(/_access\/authenticated\/tools\/lectures\.json is missing/)
    expect(f).toMatch(/tools\/tiers\.json is missing/)

    const wrong = fixture()
    const w = readJson(wrong.dist, 'tools/concepts.json')
    w.tier = 'authenticated'
    write(wrong.dist, 'tools/concepts.json', JSON.stringify(w))
    expect(checkAccessDist(wrong).failures.join('\n')).toMatch(/tools\/concepts\.json says tier "authenticated", expected "public"/)
  })

  it('fails when a tier file is missing or not JSON', () => {
    const a = fixture()
    fs.rmSync(path.join(a.dist, '_access/authenticated/graph.json'))
    write(a.dist, '_access/authenticated/search/en/titles.json', '<html>login</html>')
    const f = checkAccessDist(a).failures.join('\n')
    expect(f).toMatch(/graph\.json is missing/)
    expect(f).toMatch(/search\/en\/titles\.json is not valid JSON/)
  })

  it('NEGATIVE: the inline lecture_catalog.json may stay in dist, but a restricted title in it is a leak', () => {
    const a = fixture()
    write(a.dist, 'lecture_catalog.json', JSON.stringify([{ id: 'G06-L01', group: 'G06', title: 'public lecture' }]))
    write(a.dist, '_access/authenticated/lecture_catalog.json', JSON.stringify([{ id: 'G09-L01', group: 'G09', title: TITLE }]))
    expect(checkAccessDist(a).ok).toBe(true)
    write(a.dist, 'lecture_catalog.json', JSON.stringify([{ id: 'G09-L01', group: 'G09', title: TITLE }]))
    expect(checkAccessDist(a).failures.join('\n')).toMatch(/\[leak\] lecture_catalog\.json \(tier authenticated\)/)
  })

  it('no restricted tiers: says so and passes (the catalog stays); a stray dist/_access still fails', () => {
    const { dist, manifest } = fixture()
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    m.tiers = []
    fs.writeFileSync(manifest, JSON.stringify(m))
    fs.rmSync(path.join(dist, '_access'), { recursive: true })
    const r = checkAccessDist({ dist, manifest })
    expect(r.ok).toBe(true)
    expect(r.notes).toContain('no restricted tiers')
    write(dist, 'lecture_catalog.json', '[]')
    expect(checkAccessDist({ dist, manifest }).ok).toBe(true)
    write(dist, '_access/x/site-data.json', '{}')
    expect(checkAccessDist({ dist, manifest }).ok).toBe(false)
  })

  it('refuses a missing dist, a missing manifest and a manifest of another out dir (a stale manifest must not let a leak pass)', () => {
    const { dist, manifest } = fixture()
    expect(() => checkAccessDist({ dist: path.join(dist, 'nope'), manifest })).toThrow(GateBroken)
    expect(() => checkAccessDist({ dist, manifest: path.join(dist, 'nope.json') })).toThrow(/no access manifest/)
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    m.outDir = '/somewhere/else'
    fs.writeFileSync(manifest, JSON.stringify(m))
    expect(() => checkAccessDist({ dist, manifest })).toThrow(/written for the build in/)
    expect(checkAccessDist({ dist, manifest, ignoreOutDir: true }).ok).toBe(true)
  })

  it('variantsOf: raw, JSON-escaped, doubly escaped and HTML-escaped spellings', () => {
    const v = variantsOf('a "b" <c> & d')
    expect(v).toContain('a "b" <c> & d')
    expect(v).toContain('a \\"b\\" <c> & d')
    expect(v.some((s) => s.includes('&quot;b&quot; &lt;c&gt; &amp; d'))).toBe(true)
    expect(variantsOf('plain')).toEqual(['plain'])
  })
})

describe('file placement and the build switch', () => {
  it('placeShared: inline use wins, unbuilt-only is dropped, else the lowest restricted tier (ties by id)', () => {
    expect(placeShared(['public', 'authenticated'], 'public')).toEqual({ action: 'stay' })
    expect(placeShared([null, null], 'public')).toEqual({ action: 'drop' })
    expect(placeShared(['grp-bbbbbbbb', 'authenticated'], 'public')).toEqual({ action: 'move', tier: 'authenticated' })
    expect(placeShared(['grp-bbbbbbbb', 'grp-aaaaaaaa', null], 'public')).toEqual({ action: 'move', tier: 'grp-aaaaaaaa' })
  })

  it('--audience public becomes LECTURE_AUDIENCE=public and is not passed on to vitepress; other arguments are', () => {
    expect(parseBuildArgs(['--audience', 'public', '--outDir', 'x'], { A: '1' })).toEqual({ rest: ['--outDir', 'x'], env: { A: '1', LECTURE_AUDIENCE: 'public' } })
    expect(parseBuildArgs(['--audience=public'], {}).env).toEqual({ LECTURE_AUDIENCE: 'public' })
    expect(parseBuildArgs(['--outDir', 'x'], { A: '1' })).toEqual({ rest: ['--outDir', 'x'], env: { A: '1' } })
    expect(() => parseBuildArgs(['--audience', 'staff'], {})).toThrow(/only: public/)
  })

  it('resolveBuildHeap respects NODE_OPTIONS / LECTURE_BUILD_HEAP_MB and warns when host RAM is smaller', () => {
    const GiB = 1024 * 1024 * 1024
    const defSmall = resolveBuildHeap({}, 4 * GiB)
    expect(defSmall.args).toEqual([`--max-old-space-size=${DEFAULT_BUILD_HEAP_MB}`])
    expect(defSmall.requestedMb).toBe(DEFAULT_BUILD_HEAP_MB)
    expect(defSmall.warning).toContain('4096 MB')

    const defLarge = resolveBuildHeap({}, 16 * GiB)
    expect(defLarge.args).toEqual([`--max-old-space-size=${DEFAULT_BUILD_HEAP_MB}`])
    expect(defLarge.warning).toBeNull()

    const override = resolveBuildHeap({ LECTURE_BUILD_HEAP_MB: '4096' }, 8 * GiB)
    expect(override.args).toEqual(['--max-old-space-size=4096'])
    expect(override.source).toBe('LECTURE_BUILD_HEAP_MB')
    expect(override.warning).toBeNull()

    const auto = resolveBuildHeap({ LECTURE_BUILD_HEAP_MB: '0' }, 8 * GiB)
    expect(auto.args).toEqual([])
    expect(auto.requestedMb).toBeNull()

    const viaNodeOpts = resolveBuildHeap({ NODE_OPTIONS: '--max-old-space-size=6144' }, 8 * GiB)
    expect(viaNodeOpts.args).toEqual([])
    expect(viaNodeOpts.source).toBe('NODE_OPTIONS')

    expect(() => resolveBuildHeap({ LECTURE_BUILD_HEAP_MB: '100' }, 8 * GiB)).toThrow(/LECTURE_BUILD_HEAP_MB/)
  })
})
