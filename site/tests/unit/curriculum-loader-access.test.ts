import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import loader from '../../docs/.vitepress/theme/curriculum/curriculum.data.mts'
import { applyAccess, curriculumSliceOf, resolveBuildAccess } from '../../docs/.vitepress/access/build.mts'
import { buildCurriculumFromDisk } from '../../docs/.vitepress/curriculum/node.mts'
import { mergeCurriculum } from '../../docs/.vitepress/curriculum/split.ts'
import { resolveGroups } from '../../docs/.vitepress/groups-source.mts'
import { resolveContent } from '../../docs/.vitepress/content/paths.mts'
import type { CurriculumData } from '../../docs/.vitepress/curriculum/data.ts'
import { E2E_BUILD_ENV } from '../../scripts/build_access_e2e.mjs'

/**
 * The same three-group configuration the access e2e builds (G06 inline, G09 `authenticated`, G12 a gateway group):
 * the inline data loader must not contain a title or a lecture id of G09 / G12, the tier slices must, and merging them
 * gives the full curriculum of the three groups.
 */
const SITE = path.resolve(__dirname, '../..')
const saved = { groups: process.env.LECTURE_BUILD_GROUPS, json: process.env.LECTURE_ACCESS_JSON }

afterEach(() => {
  for (const [k, v] of [['LECTURE_BUILD_GROUPS', saved.groups], ['LECTURE_ACCESS_JSON', saved.json]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

async function setup() {
  process.env.LECTURE_BUILD_GROUPS = E2E_BUILD_ENV.LECTURE_BUILD_GROUPS
  process.env.LECTURE_ACCESS_JSON = E2E_BUILD_ENV.LECTURE_ACCESS_JSON
  const { GROUPS } = await resolveGroups()
  const plan = resolveBuildAccess(undefined, GROUPS)
  const build = buildCurriculumFromDisk({
    docsRoot: path.join(SITE, 'docs'),
    // S2: the graph sources come from the path module (content/graph/ in content mode)
    graphFile: resolveContent({ env: {} }).graphDir.graph,
    notionFile: resolveContent({ env: {} }).graphDir.graphNotion,
    allGroups: GROUPS,
    keptGroupIds: plan.keptGroupIds,
    rootLang: 'zh-CN',
    otherLangs: ['en'],
  })
  return { plan, build }
}

describe('curriculum with access tiers (e2e configuration 3)', () => {
  it('the data loader ships only the inline group: no G09 / G12 group title, lecture title or lecture id', async () => {
    const { build } = await setup()
    const inline = (await loader.load()) as Record<string, CurriculumData>
    expect(Object.keys(inline).sort()).toEqual(['en', 'root'])
    for (const bucket of ['root', 'en']) {
      expect(inline[bucket]?.groups.map((g) => g.id)).toEqual(['G06'])
      const text = JSON.stringify(inline[bucket])
      for (const g of build.byLocale[bucket]?.groups ?? []) {
        if (g.id === 'G06') continue
        expect(text).not.toContain(g.title)
        expect(text).not.toContain(`"${g.dir}-l`)
        for (const l of g.lectures) {
          expect(text).not.toContain(l.title)
          expect(text).not.toContain(l.id)
        }
      }
      // the inline part has G06 and the edges inside it
      expect(inline[bucket]?.stats.lectures).toBeGreaterThan(0)
      expect(text).toContain('G06')
    }
  })

  it('every restricted tier slice has its group titles and lecture ids, and merging them gives the full curriculum of the build', async () => {
    const { plan, build } = await setup()
    const inline = (await loader.load()) as Record<string, CurriculumData>
    expect(plan.tiers.map((t) => t.groupIds)).toEqual([['G09'], ['G12']])
    for (const bucket of ['root', 'en']) {
      const slices = plan.tiers.map((t) => curriculumSliceOf(build, plan, t.id, bucket)).filter((s) => s !== undefined)
      expect(slices).toHaveLength(2)
      for (const s of slices) {
        const text = JSON.stringify(s)
        const g = (s?.groups[0]?.value.id ?? '') as string
        const full = build.byLocale[bucket]?.groups.find((x) => x.id === g)
        expect(text).toContain(full?.title ?? 'missing')
        for (const l of full?.lectures ?? []) expect(text).toContain(l.id)
      }
      const merged = mergeCurriculum(inline[bucket] as CurriculumData, slices as NonNullable<(typeof slices)[number]>[])
      expect(merged).toEqual(build.byLocale[bucket])
    }
  })

  it('without restricted tiers the data loader ships everything', async () => {
    delete process.env.LECTURE_BUILD_GROUPS
    delete process.env.LECTURE_ACCESS_JSON
    const inline = (await loader.load()) as Record<string, CurriculumData>
    const { GROUPS } = await resolveGroups()
    expect(inline.root?.groups.map((g) => g.id)).toEqual(GROUPS.map((g) => g.id))
    expect(inline.root?.stats.edges).toBeGreaterThan(0)
  })

  it('applyAccess hands the curriculum thunk to the build end untouched (optional, not called at config time)', () => {
    let called = 0
    const cfg = applyAccess({ themeConfig: { groups: [], totals: { lectures: 0, charts: 0 } } }, {
      plan: resolveBuildAccess(undefined, []),
      allGroups: [],
      groups: [],
      localeKeys: [],
      docsRoot: path.join(SITE, 'docs'),
      curriculum: () => {
        called++
        return { byLocale: {}, dropped: [], warnings: [], edgeSources: { graph: 0, requires: 0, both: 0, union: 0 } }
      },
    })
    expect(typeof (cfg as { buildEnd?: unknown }).buildEnd).toBe('function')
    expect(called).toBe(0)
  })
})
