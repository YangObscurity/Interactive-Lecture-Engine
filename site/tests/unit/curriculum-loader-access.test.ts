import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyAccess, curriculumSliceOf, resolveBuildAccess } from '../../docs/.vitepress/access/build.mts'
import { buildCurriculumFromDisk } from '../../docs/.vitepress/curriculum/node.mts'
import { mergeCurriculum } from '../../docs/.vitepress/curriculum/split.ts'
import { resolveGroups } from '../../docs/.vitepress/groups-source.mts'
import type { CurriculumData } from '../../docs/.vitepress/curriculum/data.ts'
import { DEMO_ACCESS_JSON, DEMO_ENV, demoContentPaths, setEnv, syncDemoDocs } from './demo-content'
import type { DemoDocs } from './demo-content'

/**
 * The configuration the access e2e builds, on the engine's demo content (templates/demo-content, access.e2e.json:
 * MEA and LOG inline, PLN `authenticated`, DAT the gateway group `staff`): the inline data loader must not contain a
 * title or a lecture id of PLN / DAT, the tier slices must, and merging them gives the full curriculum of the build.
 * The demo lectures are synced into a temporary docs folder; the data loader reads it through a resolveContent that
 * points `docsRoot` there (TEST_DEMO_DOCS_ROOT), so neither site/docs nor the owner's content is read.
 */
vi.mock('../../docs/.vitepress/content/paths.mts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../docs/.vitepress/content/paths.mts')>()
  return {
    ...actual,
    resolveContent: (options?: Parameters<typeof actual.resolveContent>[0]) => {
      const paths = actual.resolveContent(options)
      const docsRoot = process.env.TEST_DEMO_DOCS_ROOT
      return docsRoot ? { ...paths, docsRoot } : paths
    },
  }
})

const SITE = path.resolve(__dirname, '../..')
const INLINE = ['MEA', 'LOG']
let demo: DemoDocs
let restoreBase: () => void
let restoreCase: (() => void) | undefined
let loader: { load: () => Promise<unknown> }

beforeAll(async () => {
  demo = await syncDemoDocs()
  restoreBase = setEnv({ ...DEMO_ENV, TEST_DEMO_DOCS_ROOT: demo.docsRoot, LECTURE_DEMO: undefined })
  // imported only now: the loader resolves its paths when the module is evaluated
  loader = (await import('../../docs/.vitepress/theme/curriculum/curriculum.data.mts')).default
})

afterEach(() => {
  restoreCase?.()
  restoreCase = undefined
})

afterAll(() => {
  restoreBase?.()
  demo?.cleanup()
})

async function setup() {
  restoreCase = setEnv({ LECTURE_BUILD_GROUPS: undefined, LECTURE_ACCESS_JSON: DEMO_ACCESS_JSON })
  const { GROUPS } = await resolveGroups()
  const plan = resolveBuildAccess(undefined, GROUPS)
  const paths = demoContentPaths()
  const build = buildCurriculumFromDisk({
    docsRoot: demo.docsRoot,
    graphFile: paths.graphDir.graph,
    notionFile: paths.graphDir.graphNotion,
    allGroups: GROUPS,
    keptGroupIds: plan.keptGroupIds,
    rootLang: 'zh-CN',
    otherLangs: ['en'],
  })
  return { plan, build }
}

describe('curriculum with access tiers (the access e2e configuration on the demo content)', () => {
  it('the data loader ships only the inline groups: no PLN / DAT group title, lecture title or lecture id', async () => {
    const { build } = await setup()
    const inline = (await loader.load()) as Record<string, CurriculumData>
    expect(Object.keys(inline).sort()).toEqual(['en', 'root'])
    for (const bucket of ['root', 'en']) {
      expect(inline[bucket]?.groups.map((g) => g.id)).toEqual(INLINE)
      const text = JSON.stringify(inline[bucket])
      for (const g of build.byLocale[bucket]?.groups ?? []) {
        if (INLINE.includes(g.id)) continue
        expect(text).not.toContain(g.title)
        expect(text).not.toContain(`"${g.dir}-l`)
        for (const l of g.lectures) {
          expect(text).not.toContain(l.title)
          expect(text).not.toContain(l.id)
        }
      }
      // the inline part has MEA and LOG and the edges inside them
      expect(inline[bucket]?.stats.lectures).toBeGreaterThan(0)
      expect(inline[bucket]?.stats.edges).toBeGreaterThan(0)
      for (const id of INLINE) expect(text).toContain(id)
    }
  })

  it('every restricted tier slice has its group titles and lecture ids, and merging them gives the full curriculum of the build', async () => {
    const { plan, build } = await setup()
    const inline = (await loader.load()) as Record<string, CurriculumData>
    expect(plan.tiers.map((t) => t.groupIds)).toEqual([['PLN'], ['DAT']])
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
    restoreCase = setEnv({ LECTURE_BUILD_GROUPS: undefined, LECTURE_ACCESS_JSON: undefined })
    const inline = (await loader.load()) as Record<string, CurriculumData>
    const { GROUPS } = await resolveGroups()
    expect(GROUPS.map((g) => g.id)).toEqual(['MEA', 'LOG', 'PLN', 'DAT'])
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
