/**
 * P4b canvas layout unit & stress tests:
 *   1. Cross-process byte determinism + zero wall-clock `ms` fields;
 *   2. 7 synthetic stress cases ported from the home-canvas prototype (overlap=0, through=0, diagonal=0, endErr=0);
 *   3. Demo site curriculum build (templates/demo-content: every group on the map, metrics hold for reader + datasheet compact & zones);
 *   4. P3b access-tier slice isolation on the demo's access e2e tiers (`inline` excludes restricted group/lecture ids, `tier` contains only `inline + tier`).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveBuildAccess } from '../../docs/.vitepress/access/build.mts'
import { measureDatasheetBoard, measureReaderBoard } from '../../docs/.vitepress/curriculum/canvasMetrics'
import { buildCanvasFromCurriculum, canvasCacheKey, canvasSliceOf, runCanvasWorker } from '../../docs/.vitepress/curriculum/canvasNode.mts'
import type { CanvasWorkerInput } from '../../docs/.vitepress/curriculum/canvasTypes'
import { buildCurriculumFromDisk } from '../../docs/.vitepress/curriculum/node.mts'
import { splitCurriculum } from '../../docs/.vitepress/curriculum/split'
import { resolveGroups } from '../../docs/.vitepress/groups-source.mts'
import { DEMO_ACCESS_JSON, DEMO_ENV, demoContentPaths, setEnv, syncDemoDocs } from './demo-content'
import type { DemoDocs } from './demo-content'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function mkInput(counts: number[], density: number, crossDensity: number, seed = 1, offMapIds: string[] = []): CanvasWorkerInput {
  const rand = rng(seed)
  const groups = counts.map((n, gi) => {
    const id = 'G' + String(gi + 1).padStart(2, '0')
    const dir = id.toLowerCase()
    const catSlot = (gi % 6) + 1
    return {
      id,
      dir,
      catSlot,
      lectures: Array.from({ length: n }, (_, k) => ({ id: `${dir}-l${String(k + 1).padStart(2, '0')}`, n: k + 1 })),
    }
  })
  const edges: Array<[string, string]> = []
  const seen = new Set<string>()
  const add = (s: string, t: string) => {
    const k = `${s}>${t}`
    if (!seen.has(k)) {
      seen.add(k)
      edges.push([s, t])
    }
  }
  for (const g of groups) {
    for (let i = 0; i < g.lectures.length; i++) {
      for (let j = i + 1; j < g.lectures.length; j++) {
        if (rand() < density / Math.max(1, j - i)) add(g.lectures[i]!.id, g.lectures[j]!.id)
      }
    }
  }
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (rand() < crossDensity) {
        const a = groups[i]!.lectures[Math.floor(rand() * groups[i]!.lectures.length)]!
        const b = groups[j]!.lectures[Math.floor(rand() * groups[j]!.lectures.length)]!
        add(a.id, b.id)
      }
    }
  }
  return { groups, edges, offMapIds }
}

const STRESS_CASES: Array<[string, CanvasWorkerInput, { checkOverlaps?: boolean }]> = [
  ['1 giant group (150 lectures)', mkInput([150, 20, 15], 0.9, 0.3, 1), { checkOverlaps: false }],
  ['40 groups', mkInput(Array.from({ length: 40 }, (_, i) => 6 + ((i * 7) % 24)), 0.7, 0.08, 2), {}],
  ['mixed 2..80 lectures', mkInput([2, 80, 3, 60, 4, 50, 2, 35, 5, 18], 0.8, 0.25, 3), {}],
  ['no dependencies', mkInput([15, 25, 10, 45, 8], 0, 0, 4), {}],
  ['dense cross-group bundles', mkInput([12, 12, 12, 12, 12, 12], 0.5, 1.0, 5), {}],
  ['star topology', (() => {
    const inp = mkInput([18, 12, 12, 12, 12, 12, 12], 0.4, 0, 6)
    for (let i = 1; i < inp.groups.length; i++) {
      inp.edges.push([inp.groups[0]!.lectures[0]!.id, inp.groups[i]!.lectures[0]!.id])
      inp.edges.push([inp.groups[0]!.lectures[2]!.id, inp.groups[i]!.lectures[1]!.id])
    }
    return inp
  })(), {}],
  ['single 120-lecture chain', (() => {
    const inp = mkInput([120], 0, 0, 7)
    for (let i = 0; i < 119; i++) inp.edges.push([inp.groups[0]!.lectures[i]!.id, inp.groups[0]!.lectures[i + 1]!.id])
    return inp
  })(), { checkOverlaps: false }],
]

const savedEnv = { groups: process.env.LECTURE_BUILD_GROUPS, json: process.env.LECTURE_ACCESS_JSON }
afterEach(() => {
  for (const [k, v] of [['LECTURE_BUILD_GROUPS', savedEnv.groups], ['LECTURE_ACCESS_JSON', savedEnv.json]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// S6: the real-site cases run on the engine's demo content (templates/demo-content), synced into a temporary docs folder
let demo: DemoDocs
let restoreDemoEnv: () => void
beforeAll(async () => {
  demo = await syncDemoDocs()
  restoreDemoEnv = setEnv({ ...DEMO_ENV })
})
afterAll(() => {
  restoreDemoEnv?.()
  demo?.cleanup()
})

/** The root-locale curriculum of the demo content with the current access environment. */
async function demoCurriculum() {
  const { GROUPS } = await resolveGroups()
  const plan = resolveBuildAccess(undefined, GROUPS)
  const paths = demoContentPaths()
  const cur = buildCurriculumFromDisk({
    docsRoot: demo.docsRoot,
    graphFile: paths.graphDir.graph,
    notionFile: paths.graphDir.graphNotion,
    allGroups: GROUPS,
    keptGroupIds: plan.keptGroupIds,
    rootLang: 'zh-CN',
    otherLangs: [],
  }).byLocale.root!
  return { GROUPS, plan, cur }
}

describe('canvas layout worker', () => {
  it('runs deterministically across two separate child processes with zero ms fields', () => {
    const inp = mkInput([10, 14, 6], 0.75, 0.4, 19)
    const a = runCanvasWorker(inp, { noCache: true })
    const b = runCanvasWorker(inp, { noCache: true })
    const sa = JSON.stringify(a)
    expect(sa).toBe(JSON.stringify(b))
    expect(sa).not.toContain('"ms"')
  })

  for (const [label, inp, opts] of STRESS_CASES) {
    it(`stress [${label}]: zero node overlaps, zero through-node edges, zero diagonal/endErr buses`, () => {
      const bundle = runCanvasWorker(inp, { noCache: true })
      const rm = measureReaderBoard(bundle.reader)
      expect(rm.nodeOverlap).toBe(0)
      expect(rm.edgesThroughNodes).toBe(0)
      if (opts.checkOverlaps !== false) expect(rm.edgeOverlaps).toBe(0)

      for (const mode of ['compact', 'zones'] as const) {
        const dm = measureDatasheetBoard(bundle.datasheet[mode])
        expect(dm.diagonal, `${mode} diagonal`).toBe(0)
        expect(dm.endErr, `${mode} endErr`).toBe(0)
        expect(dm.throughUnits, `${mode} throughUnits`).toBe(0)
        if (opts.checkOverlaps !== false) expect(dm.overlaps, `${mode} overlaps`).toBe(0)
      }
    }, 120_000)
  }

  it('demo site curriculum: every group is on the map (all have prerequisite edges) and all quality gates hold', async () => {
    delete process.env.LECTURE_BUILD_GROUPS
    delete process.env.LECTURE_ACCESS_JSON
    const { GROUPS, cur } = await demoCurriculum()
    expect(GROUPS.map((g) => g.id)).toEqual(['MEA', 'LOG', 'PLN', 'DAT'])
    expect(cur.stats.lectures).toBe(14)

    const bundle = buildCanvasFromCurriculum(cur)
    expect(bundle.reader.offMap).toEqual([])
    expect(bundle.reader.groups.map((g) => g.id)).toEqual(GROUPS.filter((g) => g.map !== false).map((g) => g.id))

    const rm = measureReaderBoard(bundle.reader)
    expect(rm.nodeOverlap).toBe(0)
    expect(rm.edgesThroughNodes).toBe(0)
    expect(rm.edgeOverlaps).toBe(0)
    expect(rm.unreadable).toBe(0)

    for (const mode of ['compact', 'zones'] as const) {
      const dm = measureDatasheetBoard(bundle.datasheet[mode])
      expect(dm.endErr).toBe(0)
      expect(dm.diagonal).toBe(0)
      expect(dm.throughUnits).toBe(0)
      if (mode === 'compact') expect(dm.overlaps).toBe(0)
      expect(dm.unreadable).toBe(0)
    }
  }, 30_000)

  it('access split: inline canvas excludes restricted ids and per-tier slice covers only inline + own tier', async () => {
    // the access e2e tiers of the demo: MEA and LOG inline, PLN authenticated, DAT the gateway group staff
    delete process.env.LECTURE_BUILD_GROUPS
    process.env.LECTURE_ACCESS_JSON = DEMO_ACCESS_JSON
    const { plan, cur: full } = await demoCurriculum()

    const inlineCur = splitCurriculum(full, { tierOfGroup: (id) => plan.tierOfGroup[id] ?? plan.inlineTier, inlineTier: plan.inlineTier }).inline
    const inlineBundle = buildCanvasFromCurriculum(inlineCur)
    const inlineText = JSON.stringify(inlineBundle)
    expect(inlineBundle.reader.groups.map((g) => g.id)).toEqual(['MEA', 'LOG'])
    expect(inlineText).not.toContain('PLN')
    expect(inlineText).not.toContain('pln-')
    expect(inlineText).not.toContain('DAT')
    expect(inlineText).not.toContain('dat-')

    const authTier = plan.tiers.find((t) => t.groupIds.includes('PLN'))!.id
    const staffTier = plan.tiers.find((t) => t.groupIds.includes('DAT'))!.id
    const authSlice = canvasSliceOf(full, plan, authTier)
    expect(authSlice.boardWithInline.reader.groups.map((g) => g.id).sort()).toEqual(['LOG', 'MEA', 'PLN'])
    expect(JSON.stringify(authSlice)).not.toContain('dat-')
    expect(authSlice.tierOwn.reader.groups.map((g) => g.id)).toEqual(['PLN'])

    const staffSlice = canvasSliceOf(full, plan, staffTier)
    expect(staffSlice.boardWithInline.reader.groups.map((g) => g.id).sort()).toEqual(['DAT', 'LOG', 'MEA'])
    expect(JSON.stringify(staffSlice)).not.toContain('pln-')
    expect(staffSlice.tierOwn.reader.groups.map((g) => g.id)).toEqual(['DAT'])
  }, 30_000)

  it('auto-excludes groups without any prerequisite edge while keeping map: false as manual override', () => {
    const inp: CanvasWorkerInput = {
      groups: [
        { id: 'G01', dir: 'g01', catSlot: 1, lectures: [{ id: 'g01-l01', n: 1 }, { id: 'g01-l02', n: 2 }] },
        { id: 'G02', dir: 'g02', catSlot: 2, map: false, lectures: [{ id: 'g02-l01', n: 1 }, { id: 'g02-l02', n: 2 }] },
        { id: 'G03', dir: 'g03', catSlot: 3, lectures: [{ id: 'g03-l01', n: 1 }, { id: 'g03-l02', n: 2 }] },
      ],
      edges: [
        ['g01-l01', 'g01-l02'],
        ['g02-l01', 'g02-l02'],
      ],
    }
    const bundle = runCanvasWorker(inp, { noCache: true })
    expect(bundle.reader.offMap.sort()).toEqual(['G02', 'G03'])
    expect(bundle.reader.groups.map((g) => g.id)).toEqual(['G01'])
  })

  it('ignores a corrupt or truncated disk cache file, recomputes and replaces it (byte-identical output)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-cache-bad-'))
    const cacheDir = path.join(tmp, 'cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      // a new input per probe: the in-memory map of the process cannot answer, only the disk file is read
      const probes = ['truncated', 'wrong-shape', 'empty'] as const
      probes.forEach((kind, i) => {
        const inp: CanvasWorkerInput = {
          groups: [{ id: 'G01', dir: 'g01', catSlot: 1, lectures: [{ id: 'g01-l01', n: 1 }, { id: 'g01-l02', n: 2 }, { id: `g01-l0${3 + i}`, n: 3 + i }] }],
          edges: [['g01-l01', 'g01-l02']],
        }
        const want = JSON.stringify(runCanvasWorker(inp, { noCache: true }))
        const file = path.join(cacheDir, `${canvasCacheKey(JSON.stringify(inp))}.json`)
        fs.writeFileSync(file, kind === 'truncated' ? want.slice(0, Math.floor(want.length / 2)) : kind === 'wrong-shape' ? '{"reader":1}' : '', 'utf8')
        const got = JSON.stringify(runCanvasWorker(inp, { cacheDir }))
        expect(got, kind).toBe(want)
        expect(fs.readFileSync(file, 'utf8'), `${kind}: the bad file was replaced`).toBe(want)
      })
    } finally {
      stdoutSpy.mockRestore()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }, 60_000)

  it('disk cache hits on repeated input, invalidates on worker change, retries once and forwards stderr', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-cache-'))
    const cacheDir = path.join(tmp, 'cache')
    const marker = path.join(tmp, 'runs.txt')
    const worker = path.join(tmp, 'worker.mjs')
    const inp: CanvasWorkerInput = {
      groups: [{ id: 'G01', dir: 'g01', catSlot: 1, lectures: [{ id: 'g01-l01', n: 1 }] }],
      edges: [['g01-l01', 'g01-l01']],
    }
    const bundlePayload = JSON.stringify(runCanvasWorker(inp, { noCache: true }))
    fs.writeFileSync(
      worker,
      `import fs from 'node:fs'\n` +
        `fs.readFileSync(0, 'utf8')\n` +
        `fs.appendFileSync(${JSON.stringify(marker)}, '1\\n')\n` +
        `const n = fs.readFileSync(${JSON.stringify(marker)}, 'utf8').trim().split('\\n').length\n` +
        `if (n === 1) { process.stderr.write('transient worker stderr\\n'); process.exit(2) }\n` +
        `process.stdout.write(${JSON.stringify(bundlePayload)})\n`,
      'utf8',
    )
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const k1 = canvasCacheKey(JSON.stringify(inp), worker)
      const a = runCanvasWorker(inp, { cacheDir, workerPath: worker })
      const b = runCanvasWorker(inp, { cacheDir, workerPath: worker })
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      expect(fs.existsSync(path.join(cacheDir, `${k1}.json`))).toBe(true)
      // Attempt 1 failed (stderr forwarded + retried once), attempt 2 succeeded, third call hit disk/mem cache
      expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(2)
      expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('transient worker stderr'))).toBe(true)
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('retrying once'))).toBe(true)
      expect(stdoutSpy.mock.calls.some((c) => String(c[0]).includes('[canvas] layout'))).toBe(true)

      fs.appendFileSync(worker, '\n// worker changed\n', 'utf8')
      const k2 = canvasCacheKey(JSON.stringify(inp), worker)
      expect(k2).not.toBe(k1)
      runCanvasWorker(inp, { cacheDir, workerPath: worker })
      expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(3)
    } finally {
      stderrSpy.mockRestore()
      stdoutSpy.mockRestore()
      warnSpy.mockRestore()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
