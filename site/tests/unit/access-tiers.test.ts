import { describe, expect, it } from 'vitest'
import {
  AccessConfigError,
  AccessGuardError,
  assertBuildGuards,
  assertNoNestedDirs,
  chunkPatternsOf,
  chunkPrefixOf,
  lectureAccessOf,
  lookupTier,
  normalizeGroupNames,
  ownerOfPath,
  parseAccessJson,
  parseIdList,
  pathPrefixesOf,
  resolveAccess,
  tierOfRead,
  tierRank,
  validateAccessConfig,
  type AccessConfig,
} from '../../docs/.vitepress/access/tiers'
import { fnv1a } from '../../docs/.vitepress/theme/core/hash'
import { LectureConfigError, defineLectureConfig, validateLectureConfig } from '../../docs/.vitepress/lecture-config.mts'
import { loadLectureConfig } from '../../docs/.vitepress/content/config.mts'
import { readAccessEnv, resolveAccessWithoutGroups, resolveBuildAccess } from '../../docs/.vitepress/access/build.mts'
import { SITE_BLOCKS, toJSON } from '../../config/schema'
import { DEMO_ACCESS_JSON, demoContentPaths } from './demo-content'

// S6: the demo content's site config (templates/demo-content), never the owner's own
const siteConfig = loadLectureConfig({ paths: demoContentPaths() })
const DEMO_IDS = ['MEA', 'LOG', 'PLN', 'DAT']

const IDS = ['G01', 'G02', 'G03', 'XR']

describe('tier ids', () => {
  it('named tiers are their own id; a user-group tier is grp- + fnv1a of the sorted names joined by newline', () => {
    expect(tierOfRead('public')).toBe('public')
    expect(tierOfRead('authenticated')).toBe('authenticated')
    expect(tierOfRead(['staff'])).toBe(`grp-${fnv1a('staff')}`)
    expect(tierOfRead(['teachers', 'staff'])).toBe(`grp-${fnv1a('staff\nteachers')}`)
    expect(tierOfRead(['staff'])).toMatch(/^grp-[0-9a-f]{8}$/)
  })

  it('the same set of names always gives the same id (order, spaces and duplicates do not matter)', () => {
    const id = tierOfRead(['b', 'a'])
    expect(tierOfRead(['a', 'b'])).toBe(id)
    expect(tierOfRead([' a ', 'b', 'a'])).toBe(id)
    expect(tierOfRead(['a', 'c'])).not.toBe(id)
    expect(normalizeGroupNames([' z', 'a ', 'z'])).toEqual(['a', 'z'])
  })

  it('rejects an empty array, empty names and unknown values, naming the valid choices', () => {
    expect(() => tierOfRead([], 'x.read')).toThrow(/x\.read is an empty array/)
    expect(() => tierOfRead(['a', '  '], 'x.read')).toThrow(/x\.read\[1\]/)
    expect(() => tierOfRead('everyone', 'x.read')).toThrow(/'public', 'authenticated' or a non-empty array/)
    expect(() => tierOfRead(7)).toThrow(AccessConfigError)
  })

  it('orders public < authenticated < group tiers', () => {
    expect(tierRank('public')).toBeLessThan(tierRank('authenticated'))
    expect(tierRank('authenticated')).toBeLessThan(tierRank(tierOfRead(['x'])))
  })
})

describe('validateAccessConfig', () => {
  it('accepts no block and the documented shapes', () => {
    expect(validateAccessConfig(undefined)).toEqual({})
    const ok: AccessConfig = { default: 'authenticated', enforcement: 'gateway', groups: { G01: { read: 'public' }, G02: { read: ['staff'] } } }
    expect(validateAccessConfig(ok, IDS)).toBe(ok)
  })

  it('lists the valid group ids for an unknown group', () => {
    expect(() => validateAccessConfig({ groups: { G99: { read: 'public' } } }, IDS)).toThrow('access.groups.G99 is not a course group (valid ids: G01, G02, G03, XR)')
  })

  it('lists the valid values for bad values and rejects unknown keys', () => {
    expect(() => validateAccessConfig({ default: 'private' })).toThrow('access.default = "private" is not one of public | authenticated')
    expect(() => validateAccessConfig({ enforcement: 'proxy' })).toThrow('access.enforcement = "proxy" is not one of none | gateway')
    expect(() => validateAccessConfig({ groups: { G01: { read: [] } } }, IDS)).toThrow(/access\.groups\.G01\.read is an empty array/)
    expect(() => validateAccessConfig({ groups: { G01: { read: 'staff' } } }, IDS)).toThrow(/not valid: use 'public', 'authenticated'/)
    expect(() => validateAccessConfig({ groups: { G01: {} } }, IDS)).toThrow(/must be an object like \{ read/)
    expect(() => validateAccessConfig({ groups: { G01: { read: 'public', who: 1 } } }, IDS)).toThrow(/access\.groups\.G01\.who is not a setting/)
    expect(() => validateAccessConfig({ mode: 'x' })).toThrow('access.mode is not a setting (expected default, groups, enforcement)')
    expect(() => validateAccessConfig('public')).toThrow(/access must be an object/)
  })

  it('prefixes the source: lecture.config.ts or LECTURE_ACCESS_JSON', () => {
    expect(() => validateAccessConfig({ default: 'x' }, undefined, 'LECTURE_ACCESS_JSON')).toThrow(/^LECTURE_ACCESS_JSON: access\.default/)
    expect(() => parseAccessJson('{nope', IDS)).toThrow(/LECTURE_ACCESS_JSON is not valid JSON/)
    expect(() => parseAccessJson('{"groups":{"G77":{"read":"public"}}}', IDS)).toThrow(/LECTURE_ACCESS_JSON: access\.groups\.G77 is not a course group/)
    expect(parseAccessJson('{"default":"authenticated"}', IDS)).toEqual({ default: 'authenticated' })
  })

  it('validateLectureConfig runs it (and maps the error), with the group list when the build passes it', () => {
    expect(() => defineLectureConfig({ theme: 'reader', access: { default: 'authenticated', enforcement: 'gateway' } })).not.toThrow()
    expect(() => defineLectureConfig({ theme: 'reader', access: { default: 'nope' as 'public' } })).toThrow(LectureConfigError)
    expect(() => validateLectureConfig({ theme: 'reader', access: { groups: { G9: { read: 'public' } } } }, { groupIds: IDS })).toThrow(/valid ids: G01, G02, G03, XR/)
    expect(() => validateLectureConfig({ theme: 'reader', access: { groups: { G9: { read: 'public' } } } })).not.toThrow()
    expect(() => validateLectureConfig(siteConfig, { groupIds: DEMO_IDS })).not.toThrow()
    expect(() => validateLectureConfig({ theme: 'reader', access: JSON.parse(DEMO_ACCESS_JSON) as AccessConfig }, { groupIds: DEMO_IDS })).not.toThrow()
  })

  it('the schema declares the block with zh and en descriptions and the same values the validator uses', () => {
    const f = SITE_BLOCKS.access.fields
    for (const d of [SITE_BLOCKS.access.description, f.default.description, f.enforcement.description, f.groups.description]) {
      expect(d.zh.length).toBeGreaterThan(0)
      expect(d.en.length).toBeGreaterThan(0)
    }
    expect(f.default.values).toEqual(['public', 'authenticated'])
    expect(f.enforcement.values).toEqual(['none', 'gateway'])
    expect(toJSON().blocks.access).toBe(SITE_BLOCKS.access)
  })
})

describe('resolveAccess', () => {
  it('no block: everything public, no restricted tier, inline public', () => {
    const p = resolveAccess({ groupIds: IDS })
    expect(p.inlineTier).toBe('public')
    expect(p.tiers).toEqual([])
    expect(p.enforcement).toBe('none')
    expect(p.keptGroupIds).toEqual(IDS)
    expect(lectureAccessOf(p)).toEqual({ inlineTier: 'public', tiers: [] })
  })

  it("this site's config: default authenticated: the inline tier is authenticated, nothing is restricted", () => {
    const p = resolveAccess({ access: { default: 'authenticated', enforcement: 'gateway' }, groupIds: IDS })
    expect(p.inlineTier).toBe('authenticated')
    expect(p.tiers).toEqual([])
    expect(Object.values(p.tierOfGroup).every((t) => t === 'authenticated')).toBe(true)
  })

  it('a public group makes the inline tier public even when the default is authenticated; the others become restricted', () => {
    const p = resolveAccess({ access: { default: 'authenticated', groups: { G01: { read: 'public' } } }, groupIds: IDS })
    expect(p.inlineTier).toBe('public')
    expect(p.tiers.map((t) => t.id)).toEqual(['authenticated'])
    expect(p.tiers[0]?.groupIds).toEqual(['G02', 'G03', 'XR'])
  })

  it('default public + an authenticated group + a user-group group: inline public, two restricted tiers with their rules', () => {
    const p = resolveAccess({ access: { groups: { G02: { read: 'authenticated' }, G03: { read: ['staff', 'ta'] } } }, groupIds: IDS })
    expect(p.inlineTier).toBe('public')
    const staff = tierOfRead(['ta', 'staff'])
    expect(p.tiers.map((t) => t.id).sort()).toEqual(['authenticated', staff].sort())
    expect(p.tiers.find((t) => t.id === staff)).toEqual({ id: staff, rule: { kind: 'groups', groups: ['staff', 'ta'] }, groupIds: ['G03'] })
    expect(p.tiers.find((t) => t.id === 'authenticated')?.rule).toEqual({ kind: 'authenticated' })
    expect(lectureAccessOf(p).tiers).toHaveLength(2)
  })

  it('groups with the same set of user-group names share one tier', () => {
    const p = resolveAccess({ access: { groups: { G01: { read: ['b', 'a'] }, G02: { read: ['a', 'b'] } } }, groupIds: IDS })
    expect(p.tiers).toHaveLength(1)
    expect(p.tiers[0]?.groupIds).toEqual(['G01', 'G02'])
  })

  it('the lectureAccess object carries tier ids only (no group names, no lecture titles)', () => {
    const p = resolveAccess({ access: { groups: { G03: { read: ['secret-lab'] } } }, groupIds: IDS })
    expect(JSON.stringify(lectureAccessOf(p))).not.toMatch(/secret-lab|G03/)
  })

  it('LECTURE_BUILD_GROUPS keeps only those groups; an unknown id lists the valid ones; the inline tier follows the kept groups', () => {
    const p = resolveAccess({ access: { default: 'authenticated', groups: { G01: { read: 'public' } } }, groupIds: IDS, buildGroups: ['G02', 'G03'] })
    expect(p.keptGroupIds).toEqual(['G02', 'G03'])
    expect(p.removedGroupIds).toEqual(['G01', 'XR'])
    expect(p.inlineTier).toBe('authenticated')
    expect(p.tiers).toEqual([])
    expect(() => resolveAccess({ groupIds: IDS, buildGroups: ['G01', 'G77'] })).toThrow('LECTURE_BUILD_GROUPS names unknown course group(s) G77 (valid ids: G01, G02, G03, XR)')
    expect(() => resolveAccess({ groupIds: IDS, buildGroups: [] })).toThrow(/LECTURE_BUILD_GROUPS is empty/)
  })

  it('--audience public builds only public groups: no restricted tier is left', () => {
    const p = resolveAccess({ access: { groups: { G02: { read: 'authenticated' }, G03: { read: ['x'] } } }, groupIds: IDS, audience: 'public' })
    expect(p.audience).toBe('public')
    expect(p.keptGroupIds).toEqual(['G01', 'XR'])
    expect(p.removedGroupIds).toEqual(['G02', 'G03'])
    expect(p.tiers).toEqual([])
    expect(p.inlineTier).toBe('public')
  })

  it("--audience public with default 'authenticated' fails: nothing public to build", () => {
    const f = () => resolveAccess({ access: { default: 'authenticated', enforcement: 'gateway', groups: { G01: { read: 'public' } } }, groupIds: IDS, audience: 'public' })
    expect(f).toThrow(AccessGuardError)
    expect(f).toThrow(/no public content to build/)
  })
})

describe('build guards', () => {
  const plan = (access: AccessConfig, extra: { audience?: 'public' } = {}) => resolveAccess({ access, groupIds: IDS, ...extra })

  it('restricted tiers without enforcement gateway fail, offering the two ways out', () => {
    const p = plan({ groups: { G02: { read: 'authenticated' } } })
    expect(() => assertBuildGuards(p)).toThrow(AccessGuardError)
    expect(() => assertBuildGuards(p)).toThrow(/enforcement: 'gateway'/)
    expect(() => assertBuildGuards(p)).toThrow(/--audience public/)
  })

  it("default 'authenticated' without gateway fails even with no restricted tier", () => {
    expect(() => assertBuildGuards(plan({ default: 'authenticated' }))).toThrow(/access\.default is 'authenticated'/)
  })

  it('passes with the gateway, with nothing restricted, and for the audience-public build of a config without gateway', () => {
    expect(() => assertBuildGuards(plan({ enforcement: 'gateway', groups: { G02: { read: 'authenticated' } } }))).not.toThrow()
    expect(() => assertBuildGuards(plan({}))).not.toThrow()
    expect(() => assertBuildGuards(plan({ groups: { G02: { read: ['x'] } } }, { audience: 'public' }))).not.toThrow()
  })

  it('resolveBuildAccess applies LECTURE_ACCESS_JSON over the config and runs the guards', () => {
    const groups = IDS.map((id) => ({ id, dir: id.toLowerCase() }))
    const json = JSON.stringify({ groups: { G02: { read: 'authenticated' } } })
    expect(() => resolveBuildAccess({ enforcement: 'gateway' }, groups, { LECTURE_ACCESS_JSON: json })).toThrow(AccessGuardError)
    const gw = JSON.stringify({ enforcement: 'gateway', groups: { G02: { read: 'authenticated' } } })
    expect(resolveBuildAccess(undefined, groups, { LECTURE_ACCESS_JSON: gw }).tiers.map((t) => t.id)).toEqual(['authenticated'])
    // the audience-public build of the guarded config passes and has no restricted tier
    expect(resolveBuildAccess(undefined, groups, { LECTURE_ACCESS_JSON: json, LECTURE_AUDIENCE: 'public' }).tiers).toEqual([])
    // an invalid override is validated like the config
    expect(() => resolveBuildAccess(undefined, groups, { LECTURE_ACCESS_JSON: '{"default":"x"}' })).toThrow(/LECTURE_ACCESS_JSON: access\.default/)
    expect(() => resolveBuildAccess(undefined, groups, { LECTURE_BUILD_GROUPS: 'G01,NOPE' })).toThrow(/NOPE/)
  })

  it('reads the environment: audience only "public", ids trimmed, empty values ignored', () => {
    expect(readAccessEnv({})).toEqual({})
    expect(readAccessEnv({ LECTURE_AUDIENCE: 'public', LECTURE_BUILD_GROUPS: ' G01 , XR,,', LECTURE_ACCESS_JSON: ' ' })).toEqual({ audience: 'public', buildGroups: ['G01', 'XR'] })
    expect(() => readAccessEnv({ LECTURE_AUDIENCE: 'staff' })).toThrow(/only: public/)
    expect(parseIdList(undefined)).toBeUndefined()
    expect(parseIdList('  ')).toBeUndefined()
  })

  it('nested group folders in different tiers are refused', () => {
    const groups = [{ id: 'A', dir: 'x' }, { id: 'B', dir: 'x/y' }]
    expect(() => assertNoNestedDirs(groups, { A: 'public', B: 'authenticated' })).toThrow(/nest/)
    expect(() => assertNoNestedDirs(groups, { A: 'authenticated', B: 'authenticated' })).not.toThrow()
  })
})

describe('lookups used by the graph, the seed and the paths', () => {
  const plan = resolveAccess({ access: { groups: { G02: { read: 'authenticated' } } }, groupIds: IDS, buildGroups: ['G01', 'G02'] })

  it('lookupTier: built groups by id (case-insensitive), null for groups left out, default for ids the plan does not know', () => {
    expect(lookupTier(plan, 'g01')).toBe('public')
    expect(lookupTier(plan, 'G02')).toBe('authenticated')
    expect(lookupTier(plan, 'G03')).toBeNull()
    expect(lookupTier(plan, 'XYZ')).toBeNull() // build limited, not listed
    expect(lookupTier(resolveAccess({ groupIds: IDS }), 'XYZ')).toBe('public')
  })

  it('the seed loader plan (no group list) agrees with the build plan for the groups of the config', () => {
    const access: AccessConfig = { default: 'authenticated', enforcement: 'gateway', groups: { G01: { read: 'public' }, G03: { read: ['x'] } } }
    const full = resolveAccess({ access, groupIds: IDS })
    const lite = resolveAccessWithoutGroups(access, {})
    expect(lite.inlineTier).toBe(full.inlineTier)
    for (const id of IDS) expect(lookupTier(lite, id), id).toBe(lookupTier(full, id))
    const limited = resolveAccessWithoutGroups(access, { LECTURE_BUILD_GROUPS: 'G02' })
    expect(lookupTier(limited, 'G01')).toBeNull()
    expect(lookupTier(limited, 'G02')).toBe('authenticated')
    expect(limited.inlineTier).toBe('authenticated')
  })

  const groups = [{ id: 'G01', dir: 'g01' }, { id: 'EX', dir: 'courses/g01' }]
  it('ownerOfPath: group folder, locale prefix, longest folder, null for non-group pages', () => {
    expect(ownerOfPath('g01/L01.md', groups, ['en'])).toEqual({ groupId: 'G01', dir: 'g01', locale: null })
    expect(ownerOfPath('/en/g01/index.md', groups, ['en'])).toEqual({ groupId: 'G01', dir: 'g01', locale: 'en' })
    expect(ownerOfPath('/courses/g01/L02', groups, ['en'])).toEqual({ groupId: 'EX', dir: 'courses/g01', locale: null })
    expect(ownerOfPath('index.md', groups, ['en'])).toBeNull()
    expect(ownerOfPath('en/index.md', groups, ['en'])).toBeNull()
    expect(ownerOfPath('g010/L01.md', groups, ['en'])).toBeNull()
    expect(ownerOfPath('en/g01/L01.md', groups, [])).toBeNull()
  })

  it('gateway paths and page chunk patterns of a group', () => {
    expect(pathPrefixesOf('courses/g01', ['en'])).toEqual(['/courses/g01/', '/en/courses/g01/'])
    expect(chunkPrefixOf('courses/g01')).toBe('courses_g01_')
    expect(chunkPrefixOf('g05', 'en')).toBe('en_g05_')
    expect(chunkPatternsOf('g05', ['en'])).toEqual(['^/assets/g05_', '^/assets/en_g05_'])
    expect(new RegExp((chunkPatternsOf('g05', ['en'])[0] as string)).test('/assets/g05_L01.md.Dlc0bFKV.js')).toBe(true)
    expect(new RegExp((chunkPatternsOf('g05', ['en'])[0] as string)).test('/assets/g050_L01.md.x.js')).toBe(false)
  })
})
