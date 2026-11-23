/**
 * tests/unit/concepts-graph.test.ts - K1: `related` frontmatter, name normalisation, the concept checks, the
 * tier-bounded neighbourhood (page panels), the per-tier tool files and the lecture section splitter.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MarkdownIt from 'markdown-it'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conceptLinkPlugin } from '../../docs/.vitepress/plugins/conceptLinkPlugin.mts'
import { resolveAccess, type AccessPlan } from '../../docs/.vitepress/access/tiers.ts'
import { parseConceptMarkdown, serializeConceptMarkdown } from '../../docs/.vitepress/concepts/frontmatter.ts'
import {
  buildConceptGraph,
  checkConceptPageLinks,
  checkConcepts,
  checkDuplicateNames,
  checkRelated,
  checkUnlinkedMentions,
  conceptNamesOf,
  conceptPanelsOf,
  findUnlinkedMentions,
  neighbourhoodOf,
  normalizeConceptName,
  type CheckedConcept,
} from '../../docs/.vitepress/concepts/graph.ts'
import {
  CONCEPT_RELS,
  RELATION_ROLES,
  RELATION_ROLE_IN,
  RELATION_ROLE_OUT,
  formatRelatedField,
  parseRelatedField,
} from '../../docs/.vitepress/concepts/related.ts'
import {
  checkedConceptsOf,
  contentForDocsRoot,
  filteredOutSlugs,
  loadConceptRecords,
  runConceptChecks,
  scanLectureFiles,
  buildGraphFromRecords,
} from '../../docs/.vitepress/concepts/node.mts'
import {
  createAnchorParser,
  splitLectureSections,
  stripMarkupForTools,
} from '../../docs/.vitepress/concepts/lectureSections.mts'
import {
  buildToolFiles,
  toolTiersOf,
  type ToolConceptsFile,
  type ToolLecturesFile,
  type ToolTiersFile,
} from '../../docs/.vitepress/concepts/toolFiles.mts'

const roots: string[] = []
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop() as string, { recursive: true, force: true })
})

// ---- helpers --------------------------------------------------------------------------------------------------------

function concept(slug: string, extra: { term?: string; english?: string; aliases?: string[]; related?: string; groups?: string[]; body?: string; summary?: string } = {}): string {
  const aliases = (extra.aliases ?? []).map((a) => JSON.stringify(a)).join(', ')
  return [
    '---',
    `title: ${JSON.stringify(extra.term ?? slug)}`,
    `term: ${JSON.stringify(extra.term ?? slug)}`,
    `english: ${JSON.stringify(extra.english ?? '')}`,
    `aliases: [${aliases}]`,
    'field: "test"',
    `groups: [${(extra.groups ?? ['G01']).map((g) => JSON.stringify(g)).join(', ')}]`,
    `summary: ${JSON.stringify(extra.summary ?? `summary of ${slug}`)}`,
    'status: published',
    ...(extra.related ? [extra.related] : []),
    '---',
    '',
    `# ${extra.term ?? slug}`,
    '',
    extra.body ?? `Body of ${slug}.`,
    '',
  ].join('\n')
}

function checked(slug: string, tier: string, raw: string): CheckedConcept {
  return { slug, tier, file: `concepts/${slug}.md`, meta: parseConceptMarkdown(raw, slug).meta, raw }
}

// ---- related frontmatter ----------------------------------------------------------------------------------------------

describe('related frontmatter', () => {
  it('parses the flow and block spellings, dedupes, and types every entry as { slug, rel }', () => {
    const fm = [
      'title: x',
      'related:',
      '  - { slug: alpha, rel: prerequisite }',
      '  - slug: beta',
      '    rel: "part-of"',
      "  - { slug: 'gamma', rel: contrast }",
      '  - { slug: alpha, rel: prerequisite }',
      'status: published',
    ].join('\r\n')
    const r = parseRelatedField(fm)
    expect(r.problems).toEqual([])
    expect(r.relations).toEqual([
      { slug: 'alpha', rel: 'prerequisite' },
      { slug: 'beta', rel: 'part-of' },
      { slug: 'gamma', rel: 'contrast' },
    ])
    expect(parseRelatedField('related: [{ slug: a-b, rel: applied-in }, { slug: c, rel: generalizes }]').relations).toEqual([
      { slug: 'a-b', rel: 'applied-in' },
      { slug: 'c', rel: 'generalizes' },
    ])
    expect(parseRelatedField('related: []')).toEqual({ relations: [], problems: [] })
    expect(parseRelatedField('title: x')).toEqual({ relations: [], problems: [] })
  })

  it('reports an unknown rel, a missing field, a bad slug and a bare string instead of dropping them silently', () => {
    const r = parseRelatedField(
      ['related:', '  - { slug: alpha, rel: friend }', '  - { slug: beta }', '  - { slug: Not_Valid, rel: contrast }', '  - plain-text'].join('\n'),
    )
    expect(r.relations).toEqual([])
    expect(r.problems).toHaveLength(4)
    expect(r.problems[0]).toContain('unknown relation type "friend"')
    expect(r.problems[0]).toContain(CONCEPT_RELS.join(', '))
    expect(r.problems[1]).toContain('needs both slug and rel')
    expect(r.problems[2]).toContain('not a valid concept slug')
    expect(r.problems[3]).toContain('expected { slug, rel }')
  })

  it('parseConceptMarkdown keeps `related` on the meta, serialize writes it back, and the five relation types have an inverse role', () => {
    const raw = concept('alpha', { related: 'related:\n  - { slug: beta, rel: applied-in }\n  - { slug: gamma, rel: bogus }' })
    const parsed = parseConceptMarkdown(raw, 'alpha')
    expect(parsed.meta.related).toEqual([{ slug: 'beta', rel: 'applied-in' }])
    expect(parsed.meta.relatedProblems?.[0]).toContain('bogus')
    const written = serializeConceptMarkdown(parsed.meta, parsed.body)
    expect(written).toContain('related:\n  - { slug: beta, rel: applied-in }')
    expect(parseConceptMarkdown(written, 'alpha').meta.related).toEqual([{ slug: 'beta', rel: 'applied-in' }])
    expect(formatRelatedField([])).toBe('')
    for (const rel of CONCEPT_RELS) {
      expect(RELATION_ROLES).toContain(RELATION_ROLE_OUT[rel])
      expect(RELATION_ROLES).toContain(RELATION_ROLE_IN[rel])
    }
    // an inverse is never the same word for the two ends, except the symmetric `contrast`
    expect(RELATION_ROLE_OUT['applied-in']).toBe('applied-in')
    expect(RELATION_ROLE_IN['applied-in']).toBe('applies')
    expect(RELATION_ROLE_OUT.contrast).toBe(RELATION_ROLE_IN.contrast)
    expect(RELATION_ROLE_OUT.generalizes).toBe(RELATION_ROLE_IN['special-case'])
  })
})

// ---- names --------------------------------------------------------------------------------------------------------------

describe('name normalisation and duplicate names', () => {
  it('normalises with NFKC, lower case, and no whitespace or ASCII/CJK punctuation', () => {
    expect(normalizeConceptName('Actuation  Lease')).toBe('actuationlease')
    expect(normalizeConceptName('ＯＣＣ（乐观·并发）')).toBe('occ乐观并发')
    expect(normalizeConceptName('「执行 租约」。')).toBe('执行租约')
    expect(normalizeConceptName('base_commit-校验!')).toBe('basecommit校验')
    expect(normalizeConceptName('  ，。！ ')).toBe('')
    expect(normalizeConceptName('Ｌｅａｓｅ')).toBe(normalizeConceptName('lease'))
  })

  it('lists term, title, English name and aliases once each', () => {
    const names = conceptNamesOf({ term: '执行租约', title: '执行租约', english: 'Actuation Lease', aliases: ['Lease', 'lease', '  ', '控制权租约'] })
    expect(names.map((n) => n.name)).toEqual(['执行租约', 'Actuation Lease', 'Lease', '控制权租约'])
  })

  it('NEGATIVE: two concepts sharing a name or alias after normalising are an error naming both files; one concept repeating itself is not', () => {
    const a = checked('alpha', 'public', concept('alpha', { term: 'Optimistic Lock', aliases: ['OCC'] }))
    const b = checked('beta', 'public', concept('beta', { term: '乐观锁', english: 'optimistic-lock!' }))
    const c = checked('gamma', 'public', concept('gamma', { term: '版本号', aliases: ['ＯＣＣ'] }))
    const errors = checkDuplicateNames([a, b, c])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('concepts/alpha.md')
    expect(errors[0]).toContain('concepts/beta.md')
    expect(errors[0]).toContain('"optimisticlock"')
    expect(errors[1]).toContain('concepts/gamma.md')
    expect(checkDuplicateNames([a, checked('delta', 'public', concept('delta', { term: 'Delta', aliases: ['Delta', 'DELTA'] }))])).toEqual([])
  })
})

// ---- the other concept checks ----------------------------------------------------------------------------------------------

describe('related, concept-page link and unlinked-mention checks', () => {
  it('NEGATIVE: unknown slug, unknown rel, self relation and a stricter target are errors; a good relation is not', () => {
    const a = checked(
      'alpha',
      'public',
      concept('alpha', {
        related:
          'related:\n  - { slug: ghost, rel: contrast }\n  - { slug: alpha, rel: contrast }\n  - { slug: secret, rel: prerequisite }\n  - { slug: beta, rel: nonsense }\n  - { slug: beta, rel: contrast }',
      }),
    )
    const b = checked('beta', 'public', concept('beta'))
    const secret = checked('secret', 'authenticated', concept('secret'))
    const errors = checkRelated([a, b, secret])
    expect(errors.some((e) => e.includes('concepts/alpha.md') && e.includes('unknown concept "ghost"'))).toBe(true)
    expect(errors.some((e) => e.includes('relates to itself'))).toBe(true)
    expect(errors.some((e) => e.includes('"secret"') && e.includes('stricter'))).toBe(true)
    expect(errors.some((e) => e.includes('unknown relation type "nonsense"'))).toBe(true)
    expect(errors).toHaveLength(4)
    // the authenticated page may name the public one
    const back = checked('secret', 'authenticated', concept('secret', { related: 'related:\n  - { slug: beta, rel: applied-in }' }))
    expect(checkRelated([b, back])).toEqual([])
  })

  it('NEGATIVE: a concept: link inside a concept page to an unknown or stricter concept is an error with file and line', () => {
    const a = checked('alpha', 'public', concept('alpha', { body: 'Intro.\n\nSee [beta](concept:beta), [ghost](concept:ghost) and [s](concept:secret).' }))
    const b = checked('beta', 'public', concept('beta'))
    const s = checked('secret', 'authenticated', concept('secret'))
    const errors = checkConceptPageLinks([a, b, s])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatch(/concepts\/alpha\.md:\d+: unknown concept link "concept:ghost"/)
    expect(errors[1]).toMatch(/concepts\/alpha\.md:\d+: tier "public" cannot reference restricted concept "secret"/)
    const line = Number(/alpha\.md:(\d+)/.exec(errors[0] as string)?.[1])
    expect(a.raw.split('\n')[line - 1]).toContain('concept:ghost')
  })

  it('finds names in prose only: not in headings, code, math, link text or HTML; the longer name wins; ASCII names need word edges', () => {
    const raw = concept('alpha', {
      body: [
        '## 执行租约 in a heading',
        '',
        '执行租约 appears here, and 租约 alone is shorter. `执行租约 in code`',
        '',
        'A [执行租约](concept:actuation-lease) link, <span class="x"></span> html, and \\(执行租约\\) math.',
        '',
        '```',
        '执行租约 in a fence',
        '```',
        '',
        'OCC works, OCCUR and occurs do not; lease_id neither; Lease does.',
      ].join('\n'),
    })
    const hits = findUnlinkedMentions(raw, ['执行租约', '租约', 'OCC', 'Lease'])
    expect(hits.map((h) => h.matched)).toEqual(['执行租约', '租约', 'OCC', 'Lease'])
    const first = hits[0] as { line: number }
    expect(raw.split('\n')[first.line - 1]).toContain('appears here')
  })

  it('WARNING (not an error): a concept page naming another concept by term or alias without a link; own names and linked names are quiet', () => {
    const lease = checked('lease', 'public', concept('lease', { term: '执行租约', aliases: ['Lease'], body: '执行租约是限时凭证。它不同于普通锁。' }))
    const occ = checked(
      'occ',
      'public',
      concept('occ', { term: '乐观并发控制', aliases: ['OCC'], body: '先做再核对。典型应用是执行租约（见 [租约](concept:lease)），它的别名是 Lease。' }),
    )
    const warnings = checkUnlinkedMentions([lease, occ])
    expect(warnings.some((w) => w.includes('concepts/occ.md') && w.includes('"执行租约"') && w.includes('concept lease'))).toBe(true)
    expect(warnings.some((w) => w.includes('concepts/occ.md') && w.includes('"Lease"'))).toBe(true)
    expect(warnings.every((w) => !w.includes('concepts/lease.md'))).toBe(true)
    const result = checkConcepts([lease, occ])
    expect(result.errors).toEqual([])
    expect(result.warnings.length).toBe(warnings.length)
  })
})

// ---- tiers: panels and tool files -----------------------------------------------------------------------------------------

const PLAN: AccessPlan = resolveAccess({
  access: { default: 'public', enforcement: 'gateway', groups: { G05: { read: 'authenticated' }, LR: { read: ['staff'] } } },
  groupIds: ['G01', 'G05', 'LR'],
})
const GROUPS = [
  { id: 'G01', dir: 'g01' },
  { id: 'G05', dir: 'g05' },
  { id: 'LR', dir: 'lr' },
]
const STAFF_TIER = PLAN.tierOfGroup.LR as string

function lecture(title: string, body: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n\n${body}\n`
}

function makeSite(): { docs: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k1-concepts-'))
  roots.push(root)
  const docs = path.join(root, 'docs')
  const put = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(docs, rel)), { recursive: true })
    fs.writeFileSync(path.join(docs, rel), text, 'utf8')
  }
  // public concepts
  put(
    'concepts/pub-a.md',
    concept('pub-a', {
      term: 'Public Alpha',
      groups: ['G01'],
      related: 'related:\n  - { slug: pub-z, rel: applied-in }',
      body: 'Alpha text, see [Zed](concept:pub-z).',
    }),
  )
  put('concepts/pub-z.md', concept('pub-z', { term: 'Public Zed', groups: ['G01'], body: 'Zed text with a long enough sentence for the snippet needle to exist.' }))
  // authenticated concept: names public ones, is named by nobody public
  put(
    'concepts/auth-b.md',
    concept('auth-b', {
      term: 'Auth Beta',
      groups: ['G05'],
      related: 'related:\n  - { slug: pub-a, rel: prerequisite }',
      body: 'Beta text builds on [Alpha](concept:pub-a).',
    }),
  )
  // staff concept
  put(
    'concepts/staff-c.md',
    concept('staff-c', {
      term: 'Staff Gamma',
      groups: ['LR'],
      related: 'related:\n  - { slug: auth-b, rel: contrast }\n  - { slug: pub-z, rel: special-case }',
      body: 'Gamma text uses [Beta](concept:auth-b) and [Alpha](concept:pub-a).',
    }),
  )
  put('g01/L01.md', lecture('Public lecture', '## Intro\n\nUses [alpha](concept:pub-a) twice: [alpha](concept:pub-a).\n\n### Detail\n\nText.'))
  put('g05/L01.md', lecture('Auth lecture', '## Part\n\nSee [alpha](concept:pub-a) and [beta](concept:auth-b).'))
  put('lr/L01.md', lecture('Staff lecture', '## Secret\n\nSee [gamma](concept:staff-c). RESTRICTED-STAFF-SECTION-TEXT-12345.'))
  return { docs }
}

function loadAll(docs: string) {
  const content = contentForDocsRoot(docs)
  const records = loadConceptRecords({ content, accessPlan: PLAN, builtGroupIds: new Set(GROUPS.map((g) => g.id)), includeDrafts: false, isDev: false })
  const lectures = scanLectureFiles({ content, groups: GROUPS, accessPlan: PLAN })
  return { records, lectures }
}

describe('tier-bounded neighbourhood and page panels', () => {
  it('a page shows only what its own tier may read, both directions grouped by role; empty panels are empty lists', () => {
    const { docs } = makeSite()
    const { records, lectures } = loadAll(docs)
    expect(records.map((r) => [r.slug, r.tier])).toEqual([
      ['auth-b', 'authenticated'],
      ['pub-a', 'public'],
      ['pub-z', 'public'],
      ['staff-c', STAFF_TIER],
    ])
    const graph = buildGraphFromRecords(records, lectures)

    const pubA = conceptPanelsOf(graph, 'pub-a', 'public')
    // pub-a: applied-in pub-z (out); auth-b (prerequisite on its page) is stricter, so it is NOT shown on the public page
    expect(pubA.related).toEqual([{ role: 'applied-in', items: [expect.objectContaining({ slug: 'pub-z', term: 'Public Zed' })] }])
    expect(pubA.backlinks.map((b) => b.slug)).toEqual([])
    expect(pubA.lectures).toEqual([{ route: '/g01/L01', id: 'G01-L01', title: 'Public lecture', count: 2 }])
    expect(JSON.stringify(pubA)).not.toMatch(/auth-b|staff-c|Auth lecture|Staff lecture|G05-L01/)

    // pub-z: inverse of pub-a's applied-in, and pub-a links it; staff-c's special-case is hidden from public
    const pubZ = conceptPanelsOf(graph, 'pub-z', 'public')
    expect(pubZ.related.map((g) => g.role)).toEqual(['applies'])
    expect(pubZ.related[0]?.items.map((i) => i.slug)).toEqual(['pub-a'])
    expect(pubZ.backlinks.map((b) => b.slug)).toEqual(['pub-a'])

    // auth-b page (tier authenticated): sees public and own tier, not the staff tier
    const authB = conceptPanelsOf(graph, 'auth-b', 'authenticated')
    expect(authB.related).toEqual([{ role: 'prerequisite', items: [expect.objectContaining({ slug: 'pub-a' })] }])
    expect(authB.backlinks).toEqual([])
    expect(authB.lectures.map((l) => l.id)).toEqual(['G05-L01'])

    // the staff page sees everything below it, grouped in the fixed role order
    const staff = conceptPanelsOf(graph, 'staff-c', STAFF_TIER)
    expect(staff.related.map((g) => g.role)).toEqual(['contrast', 'generalization'])
    expect(staff.lectures.map((l) => l.id)).toEqual(['LR-L01'])

    // a concept nobody relates to and nobody cites has three empty panels
    expect(conceptPanelsOf(graph, 'nope', 'public')).toEqual({ related: [], backlinks: [], lectures: [] })
  })

  it('neighbourhoodOf: reader tier is the only bound; an inverse relation of a stricter concept never leaks to a lower tier', () => {
    const { docs } = makeSite()
    const { records, lectures } = loadAll(docs)
    const graph = buildGraphFromRecords(records, lectures)
    const asPublic = neighbourhoodOf(graph, 'pub-a', 'public')
    expect(asPublic.roles.flatMap((g) => g.slugs)).toEqual(['pub-z'])
    const asAuthenticated = neighbourhoodOf(graph, 'pub-a', 'authenticated')
    expect(asAuthenticated.roles.flatMap((g) => g.slugs).sort()).toEqual(['auth-b', 'pub-z'])
    expect(asAuthenticated.backlinks).toEqual(['auth-b'])
    expect(asAuthenticated.lectures.map((l) => l.id)).toEqual(['G01-L01', 'G05-L01'])
    const asStaff = neighbourhoodOf(graph, 'pub-a', STAFF_TIER)
    expect(asStaff.backlinks).toEqual(['auth-b', 'staff-c'])
    // buildConceptGraph on its own: links to unknown slugs and self relations are dropped
    const g = buildConceptGraph(
      [{ slug: 'x', tier: 'public', url: '/concepts/x', meta: { ...records[0]!.meta, related: [{ slug: 'x', rel: 'contrast' }, { slug: 'y', rel: 'contrast' }] }, body: '[a](concept:x) [b](concept:y)' }],
      new Map(),
    )
    expect(g.nodes.get('x')?.links).toEqual([])
    expect(g.nodes.get('x')?.related).toEqual([])
  })

  it('a pair written on both pages shows the other concept once, under the own relation of the page', () => {
    const { docs } = makeSite()
    const { records } = loadAll(docs)
    const meta = records[0]!.meta
    const g = buildConceptGraph(
      [
        { slug: 'lease', tier: 'public', url: '/concepts/lease', meta: { ...meta, related: [{ slug: 'occ', rel: 'prerequisite' }] }, body: '' },
        { slug: 'occ', tier: 'public', url: '/concepts/occ', meta: { ...meta, related: [{ slug: 'lease', rel: 'applied-in' }] }, body: '' },
        { slug: 'other', tier: 'public', url: '/concepts/other', meta: { ...meta, related: [{ slug: 'lease', rel: 'contrast' }] }, body: '' },
      ],
      new Map(),
    )
    expect(neighbourhoodOf(g, 'lease', 'public').roles).toEqual([
      { role: 'prerequisite', slugs: ['occ'] },
      { role: 'contrast', slugs: ['other'] },
    ])
    expect(neighbourhoodOf(g, 'occ', 'public').roles).toEqual([{ role: 'applied-in', slugs: ['lease'] }])
  })

  it('the checks pass on the fixture site (no error) and report the unlinked mention as a warning only', () => {
    const { docs } = makeSite()
    const { records } = loadAll(docs)
    const res = runConceptChecks(records)
    expect(res.errors).toEqual([])
    expect(checkedConceptsOf(records)).toHaveLength(4)
  })
})

describe('per-tier tool files', () => {
  it('writes concepts.json and lectures.json per tier and tiers.json at the root; restricted content stays in its own tier files', async () => {
    const { docs } = makeSite()
    const { records, lectures } = loadAll(docs)
    const md = await createAnchorParser(docs)
    const files = buildToolFiles({ records, lectures, accessPlan: PLAN, localeKeys: [], md, generatedAt: '2026-11-22T00:00:00.000Z' })

    expect([...files.keys()].sort()).toEqual(
      [
        'tools/concepts.json',
        'tools/lectures.json',
        'tools/tiers.json',
        '_access/authenticated/tools/concepts.json',
        '_access/authenticated/tools/lectures.json',
        `_access/${STAFF_TIER}/tools/concepts.json`,
        `_access/${STAFF_TIER}/tools/lectures.json`,
      ].sort(),
    )

    const tiers = JSON.parse(files.get('tools/tiers.json') as string) as ToolTiersFile
    expect(tiers).toEqual({
      version: 1,
      tiers: [
        { id: 'public', read: 'public', groups: [], path: '/tools/' },
        { id: 'authenticated', read: 'authenticated', groups: [], path: '/_access/authenticated/tools/' },
        { id: STAFF_TIER, read: 'groups', groups: ['staff'], path: `/_access/${STAFF_TIER}/tools/` },
      ],
    })
    expect(toolTiersOf(PLAN)).toEqual(tiers.tiers)

    const pub = JSON.parse(files.get('tools/concepts.json') as string) as ToolConceptsFile
    expect(pub.version).toBe(1)
    expect(pub.tier).toBe('public')
    expect(pub.generatedAt).toBe('2026-11-22T00:00:00.000Z')
    expect(pub.concepts.map((c) => c.slug)).toEqual(['pub-a', 'pub-z'])
    const pubA = pub.concepts[0]!
    expect(pubA).toMatchObject({
      slug: 'pub-a',
      term: 'Public Alpha',
      english: '',
      field: 'test',
      groups: ['G01'],
      url: '/concepts/pub-a',
      related: [{ slug: 'pub-z', rel: 'applied-in' }],
      links: ['pub-z'],
      backlinks: [],
      lectures: [{ route: '/g01/L01', id: 'G01-L01', title: 'Public lecture', count: 2 }],
    })
    expect(pubA.markdown.startsWith('# Public Alpha')).toBe(true)
    expect(pubA.markdown).not.toContain('status: published')
    expect(pub.concepts[1]!.backlinks).toEqual(['pub-a'])

    const publicText = [files.get('tools/concepts.json'), files.get('tools/lectures.json')].join('\n')
    expect(publicText).not.toMatch(/auth-b|Auth Beta|staff-c|Staff Gamma|G05-L01|LR-L01|Auth lecture|Staff lecture|RESTRICTED-STAFF-SECTION-TEXT/)

    const auth = JSON.parse(files.get('_access/authenticated/tools/concepts.json') as string) as ToolConceptsFile
    expect(auth.tier).toBe('authenticated')
    expect(auth.concepts.map((c) => c.slug)).toEqual(['auth-b'])
    expect(auth.concepts[0]).toMatchObject({
      related: [{ slug: 'pub-a', rel: 'prerequisite' }],
      links: ['pub-a'],
      backlinks: [],
      lectures: [{ route: '/g05/L01', id: 'G05-L01', title: 'Auth lecture', count: 1 }],
    })
    expect(files.get('_access/authenticated/tools/concepts.json')).not.toMatch(/staff-c|Staff Gamma|LR-L01/)

    const staff = JSON.parse(files.get(`_access/${STAFF_TIER}/tools/concepts.json`) as string) as ToolConceptsFile
    expect(staff.concepts.map((c) => c.slug)).toEqual(['staff-c'])
    expect(staff.concepts[0]!.links).toEqual(['auth-b', 'pub-a'])
    expect(staff.concepts[0]!.related).toEqual([
      { slug: 'auth-b', rel: 'contrast' },
      { slug: 'pub-z', rel: 'special-case' },
    ])

    const pubLectures = JSON.parse(files.get('tools/lectures.json') as string) as ToolLecturesFile
    expect(pubLectures.lectures.map((l) => [l.id, l.route, l.group, l.title])).toEqual([['G01-L01', '/g01/L01', 'G01', 'Public lecture']])
    expect(pubLectures.lectures[0]!.sections.map((s) => [s.heading, s.anchor])).toEqual([['Intro', 'intro'], ['Detail', 'detail']])
    const staffLectures = JSON.parse(files.get(`_access/${STAFF_TIER}/tools/lectures.json`) as string) as ToolLecturesFile
    expect(staffLectures.lectures[0]!.sections[0]!.text).toContain('RESTRICTED-STAFF-SECTION-TEXT-12345')
  })

  it('without a restricted tier everything is inline: one tier, files under tools/, nothing under _access', async () => {
    const { docs } = makeSite()
    const plan = resolveAccess({ access: { default: 'authenticated', enforcement: 'gateway' }, groupIds: ['G01', 'G05', 'LR'] })
    const content = contentForDocsRoot(docs)
    const records = loadConceptRecords({ content, accessPlan: plan, builtGroupIds: new Set(GROUPS.map((g) => g.id)), includeDrafts: false, isDev: false })
    const lectures = scanLectureFiles({ content, groups: GROUPS, accessPlan: plan })
    const files = buildToolFiles({ records, lectures, accessPlan: plan, localeKeys: [], md: await createAnchorParser(docs) })
    expect([...files.keys()].sort()).toEqual(['tools/concepts.json', 'tools/lectures.json', 'tools/tiers.json'])
    const concepts = JSON.parse(files.get('tools/concepts.json') as string) as ToolConceptsFile
    expect(concepts.tier).toBe('authenticated')
    expect(concepts.concepts.map((c) => c.slug)).toEqual(['auth-b', 'pub-a', 'pub-z', 'staff-c'])
    const tiers = JSON.parse(files.get('tools/tiers.json') as string) as ToolTiersFile
    expect(tiers.tiers).toEqual([{ id: 'authenticated', read: 'authenticated', groups: [], path: '/tools/' }])
  })

  it('drops translated copies of lectures from the files and from the counts', async () => {
    const { docs } = makeSite()
    fs.mkdirSync(path.join(docs, 'en/g01'), { recursive: true })
    fs.writeFileSync(path.join(docs, 'en/g01/L01.md'), lecture('English copy', '## Intro\n\n[alpha](concept:pub-a)'), 'utf8')
    const content = contentForDocsRoot(docs)
    const records = loadConceptRecords({ content, accessPlan: PLAN, builtGroupIds: new Set(GROUPS.map((g) => g.id)), includeDrafts: false, isDev: false, localeKeys: ['en'] })
    const lectures = scanLectureFiles({ content, groups: GROUPS, accessPlan: PLAN, localeKeys: ['en'] })
    expect(lectures.some((l) => l.relDocsPath.startsWith('en/'))).toBe(true)
    const files = buildToolFiles({ records, lectures, accessPlan: PLAN, localeKeys: ['en'], md: await createAnchorParser(docs) })
    const lecs = JSON.parse(files.get('tools/lectures.json') as string) as ToolLecturesFile
    expect(lecs.lectures.map((l) => l.route)).toEqual(['/g01/L01'])
    const concepts = JSON.parse(files.get('tools/concepts.json') as string) as ToolConceptsFile
    expect(concepts.concepts[0]!.lectures).toEqual([{ route: '/g01/L01', id: 'G01-L01', title: 'Public lecture', count: 2 }])
  })
})

// ---- lecture sections --------------------------------------------------------------------------------------------------------

describe('lecture sections for tools/lectures.json', () => {
  it('splits on ## and ### with the anchor ids VitePress generates (duplicates, {#custom}, math in the heading)', async () => {
    const md = await createAnchorParser(process.cwd())
    const raw = [
      '---',
      'title: "T"',
      '---',
      '',
      '# 第01讲 · Title',
      '',
      'Lead text before any section.',
      '',
      '## 1. 基础 Metadata',
      '',
      'First.',
      '',
      '### Details',
      '',
      'Nested detail.',
      '',
      '#### Deeper stays inside Details',
      '',
      'Deeper text.',
      '',
      '## Details',
      '',
      'Second Details heading gets a suffix.',
      '',
      '## Named {#my-anchor}',
      '',
      'Custom id.',
      '',
      '## 公式 \\(O_{\\mathrm{env}}\\) 与 `code`',
      '',
      'Math heading.',
    ].join('\n')
    const sections = splitLectureSections(raw, md, 'T')
    expect(sections.map((s) => [s.heading, s.anchor])).toEqual([
      ['第01讲 · Title', expect.any(String)],
      ['1. 基础 Metadata', '_1-基础-metadata'],
      ['Details', 'details'],
      ['Details', 'details-1'],
      ['Named', 'my-anchor'],
      [expect.stringContaining('公式'), expect.any(String)],
    ])
    expect(sections[0]!.text).toBe('Lead text before any section.')
    expect(sections[1]!.text).toBe('First.')
    expect(sections[2]!.text).toContain('Nested detail.')
    expect(sections[2]!.text).toContain('#### Deeper stays inside Details')
    expect(sections[2]!.text).not.toContain('Second Details')
    expect(sections[5]!.anchor).not.toBe('')
  })

  it('leaves out a lead that is only horizontal rules, and keeps a heading without text', async () => {
    const md = await createAnchorParser(process.cwd())
    const sections = splitLectureSections(['# T', '', '---', '', '## A', '', '### A.1', '', 'x'].join('\n'), md, 'T')
    expect(sections.map((s) => [s.heading, s.text])).toEqual([['A', ''], ['A.1', 'x']])
  })

  it('the anchor of a heading is the one in the page HTML of the site renderer', async () => {
    const md = (await createAnchorParser(process.cwd())) as unknown as { render(src: string, env: object): string }
    const body = ['# A', '', '## 2. 公式 & <b>x</b>', '', 'x', '', '## 2. 公式 & <b>x</b>', '', 'y'].join('\n')
    const html = md.render(body, {})
    const htmlIds = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1])
    const sections = splitLectureSections(body, md as never)
    expect(sections.map((s) => s.anchor)).toEqual(htmlIds)
    expect(htmlIds).toHaveLength(2)
    expect(htmlIds[0]).not.toBe(htmlIds[1])
  })

  it('strips HTML tags, comments, script/style and Vue components but keeps math, code and tables', () => {
    const text = stripMarkupForTools(
      [
        'Intro <span class="cite" data-cite="https://x.test/a>b" title="t">https://x.test/a</span> end.<!-- hidden -->',
        '',
        '<ChartPanel :data="a > b" id="c1" />',
        '<Quiz>',
        'Q?',
        '</Quiz>',
        '<script setup>const secret = 1</script>',
        '',
        '| a | b |',
        '|---|---|',
        '| x<br>y | `Vec<int>` |',
        '',
        '```cpp',
        'std::vector<int> v; // <not a tag>',
        '```',
        '',
        'Math \\(a<b and c>d\\) and $$x<y$$ stay.',
        '',
        'Line one<br/>line two.',
      ].join('\n'),
    )
    expect(text).toContain('Intro https://x.test/a end.')
    expect(text).not.toContain('hidden')
    expect(text).not.toContain('ChartPanel')
    expect(text).not.toContain('secret')
    expect(text).toContain('Q?')
    expect(text).toContain('| a | b |')
    expect(text).toContain('| x y | `Vec<int>` |')
    expect(text).toContain('std::vector<int> v; // <not a tag>')
    expect(text).toContain('\\(a<b and c>d\\)')
    expect(text).toContain('$$x<y$$')
    expect(text).toContain('Line one line two.')
  })
})

describe('concepts left out of a partial build (LECTURE_BUILD_GROUPS)', () => {
  it('a link to a published concept the group filter removed renders as plain text with a warning; unknown and stricter links still fail', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const md = new MarkdownIt()
    md.use(conceptLinkPlugin, {
      isBuild: true,
      accessPlan: PLAN,
      resolveConcept: (slug: string) => {
        if (slug === 'filtered') return { slug, tier: 'public', isDraft: false, filteredOut: true }
        if (slug === 'staff') return { slug, tier: STAFF_TIER, isDraft: false }
        return null
      },
      tierOfPage: () => 'public',
    })
    const html = md.render('See [the lease](concept:filtered) here.', { relativePath: 'concepts/x.md' })
    expect(html).toContain('the lease')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('concept:filtered'))
    expect(() => md.render('[x](concept:ghost)', { relativePath: 'g01/L01.md' })).toThrow(/Unknown or unpublished/)
    expect(() => md.render('[x](concept:staff)', { relativePath: 'g01/L01.md' })).toThrow(/Access mismatch/)
    warn.mockRestore()
  })

  it('the checks do not fail on related or concept: links to a filtered-out concept, but still on a truly unknown one', () => {
    const a = checked('alpha', 'public', concept('alpha', { related: 'related:\n  - { slug: gone, rel: contrast }\n  - { slug: ghost, rel: contrast }', body: '[g](concept:gone) [h](concept:ghost)' }))
    const strict = checkConcepts([a], { filteredOut: new Set(['gone']) })
    expect(strict.errors).toHaveLength(2)
    expect(strict.errors.every((e) => e.includes('ghost'))).toBe(true)
    expect(checkConcepts([a]).errors).toHaveLength(4)
    const { docs } = makeSite()
    const { records } = loadAll(docs)
    const partial = records.map((r) => (r.slug === 'pub-z' ? { ...r, drop: true } : r))
    expect(filteredOutSlugs(partial)).toEqual(new Set(['pub-z']))
    expect(runConceptChecks(partial).errors).toEqual([])
  })
})
