// @vitest-environment happy-dom
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { EMPTY_SEED, buildSeed, seedIndex } from '../../docs/.vitepress/theme/progress/seed'
import seedLoader from '../../docs/.vitepress/theme/progress/seed.data.mts'
import { resolveContent } from '../../docs/.vitepress/content/paths.mts'
import { startNotionBridge } from '../../docs/.vitepress/theme/progress/notionBridge'
import { configureProgress, createProgressStore, isTempGroupId, matchesTempGroupContext, parseProgressRuntime, parseTempGroupIds, progressRuntime, setTempGroupResolver } from '../../docs/.vitepress/theme/progress/progressStore'
import { useProgress } from '../../docs/.vitepress/theme/progress/useProgress'
import type { UseProgress } from '../../docs/.vitepress/theme/progress/useProgress'
import type { ProgressStore } from '../../docs/.vitepress/theme/progress/progressStore'
import type { NotionItem } from '../../docs/.vitepress/theme/progress/notionBridge'
import type { ProgressRecord } from '../../docs/.vitepress/theme/progress/types'
import { fromLegacyStatus, toLegacyStatus } from '../../docs/.vitepress/theme/progress/types'
import { PROGRESS_WIRE_STATUS } from '../../docs/.vitepress/site.config.mts'
import { FakeClock, FakeScheduler, MemoryStorage, ScriptedBackend, deferred, rec, settle } from './progress-helpers'
import { DEMO_CONTENT_DIR } from './demo-content'

// S6: the data loader reads the active content root when it is imported; point it at the engine's demo content
// (templates/demo-content/graph/notion_knowledge_graph.json) before the imports run, never the owner's export.
vi.hoisted(() => {
  process.env.LECTURE_CONTENT_DIR = `${__dirname}/../../../templates/demo-content`
})

const W = PROGRESS_WIRE_STATUS
const graphFile = resolveContent({ env: { LECTURE_CONTENT_DIR: DEMO_CONTENT_DIR } }).graphDir.notionKnowledgeGraph
afterAll(() => {
  delete process.env.LECTURE_CONTENT_DIR
})

describe('seed', () => {
  const node = (lectureId: string, status: string, extra: Record<string, unknown> = {}) => ({ lectureId, groupId: lectureId.split('-')[0]?.toUpperCase(), status, nodeId: `n-${lectureId}`, notionPageId: `p-${lectureId}`, completedDate: null, ...extra })

  it('maps graph nodes to records: lower-case ids, domain statuses, Notion ids, completion time only when completed', () => {
    const seed = buildSeed([
      node('G03-L07', W.completed, { completedDate: '2026-10-25T21:54:00.000+08:00' }),
      node('G03-L08', W.in_progress, { completedDate: '2026-10-25T21:54:00.000+08:00' }),
      node('G04-L01', W.not_started),
    ])
    expect(seed.records).toEqual([
      { lectureId: 'g03-l07', groupId: 'g03', status: 'completed', completedAt: '2026-10-25T21:54:00.000+08:00', updatedAt: null, notionNodeId: 'n-G03-L07', notionPageId: 'p-G03-L07' },
      { lectureId: 'g03-l08', groupId: 'g03', status: 'in_progress', completedAt: null, updatedAt: null, notionNodeId: 'n-G03-L08', notionPageId: 'p-G03-L08' },
      { lectureId: 'g04-l01', groupId: 'g04', status: 'not_started', completedAt: null, updatedAt: null, notionNodeId: 'n-G04-L01', notionPageId: 'p-G04-L01' },
    ])
    expect(seedIndex(seed).get('g03-l07')?.status).toBe('completed')
  })

  it('skips nodes without a lecture id or with an unknown status; anything that is not an array is the empty seed', () => {
    expect(buildSeed([null, 7, {}, node('', W.completed), node('G01-L01', 'done'), node('G01-L02', W.completed)]).records.map((r) => r.lectureId)).toEqual(['g01-l02'])
    expect(buildSeed({ nodes: [] })).toBe(EMPTY_SEED)
    expect(buildSeed(null)).toBe(EMPTY_SEED)
    expect(buildSeed([])).toBe(EMPTY_SEED)
  })

  it('the version is a content hash: independent of node order, different when anything changes', () => {
    const a = [node('G01-L01', W.completed), node('G01-L02', W.in_progress)]
    const v = buildSeed(a).version
    expect(v).toMatch(/^[0-9a-f]{8}$/)
    expect(buildSeed([...a].reverse()).version).toBe(v)
    expect(buildSeed([node('G01-L01', W.completed), node('G01-L02', W.completed)]).version).not.toBe(v)
  })

  it('the later node wins when a lecture appears twice', () => {
    expect(buildSeed([node('G01-L01', W.completed), node('g01-l01', W.in_progress)]).records).toHaveLength(1)
    expect(buildSeed([node('G01-L01', W.completed), node('g01-l01', W.in_progress)]).records[0]?.status).toBe('in_progress')
  })

  it('the data loader reads the real knowledge-graph export; a missing file is the empty seed', () => {
    expect(seedLoader.watch).toHaveLength(1)
    expect(path.resolve(__dirname, '../../docs/.vitepress/theme/progress', seedLoader.watch[0] as string)).toBe(graphFile)
    const nodes = JSON.parse(fs.readFileSync(graphFile, 'utf8')) as unknown[]
    const data = seedLoader.load([graphFile])
    expect(data.records.length).toBeGreaterThan(0)
    expect(data.records.length).toBeLessThanOrEqual(nodes.length)
    expect(data.records.every((r) => r.lectureId === r.lectureId.toLowerCase())).toBe(true)
    expect(seedLoader.load([])).toEqual(EMPTY_SEED)
    expect(seedLoader.load([path.join(__dirname, 'does-not-exist.json')])).toEqual(EMPTY_SEED)
  })
})

describe('status conversion', () => {
  it('toLegacyStatus and fromLegacyStatus are inverse on the three values and null otherwise', () => {
    for (const s of ['not_started', 'in_progress', 'completed'] as const) expect(fromLegacyStatus(toLegacyStatus(s))).toBe(s)
    expect(toLegacyStatus('completed')).toBe(W.completed)
    expect(fromLegacyStatus('done')).toBeNull()
    expect(fromLegacyStatus(undefined)).toBeNull()
  })
})

function bridgeRig() {
  const clock = new FakeClock()
  const store = createProgressStore({ backend: new ScriptedBackend('local'), storage: new MemoryStorage(), now: clock.now, locks: null, scheduler: new FakeScheduler(), target: null, loadSeed: async () => ({ version: 's', records: [rec('g01-l01', 'not_started', { notionNodeId: 'node-1', notionPageId: 'page-1' })] }) })
  const single: Array<[string, string, string | undefined, string | undefined]> = []
  const batches: NotionItem[][] = []
  const stop = startNotionBridge({ store, sync: (id, status, node, page) => single.push([id, status, node, page]), batch: (items) => batches.push(items) })
  return { store, single, batches, stop }
}

describe('notion bridge', () => {
  it('forwards one user change as a single sync with the Chinese status and the Notion ids', async () => {
    const { store, single, batches } = bridgeRig()
    await store.load()
    store.set('g01-l01', 'completed')
    expect(single).toEqual([['g01-l01', W.completed, 'node-1', 'page-1']])
    expect(batches).toEqual([])
  })

  it('forwards several changes as one batch', async () => {
    const { store, single, batches } = bridgeRig()
    await store.load()
    store.setMany([{ lectureId: 'g01-l01', status: 'in_progress' }, { lectureId: 'g01-l02', status: 'completed' }])
    expect(single).toEqual([])
    expect(batches).toEqual([[
      { lectureId: 'g01-l01', status: W.in_progress, notionNodeId: 'node-1', notionPageId: 'page-1' },
      { lectureId: 'g01-l02', status: W.completed },
    ]])
  })

  it('does not forward loads, server replies or resets, and stops when asked', async () => {
    const { store, single, batches, stop } = bridgeRig()
    await store.load() // emits reset events
    store.reset()
    await store.flush()
    expect(single).toEqual([])
    stop()
    store.set('g01-l03', 'completed')
    expect(single).toEqual([])
    expect(batches).toEqual([])
  })

  it('a throwing Notion function never disturbs the store', async () => {
    const clock = new FakeClock()
    const store = createProgressStore({ backend: new ScriptedBackend('local'), storage: new MemoryStorage(), now: clock.now, locks: null, scheduler: new FakeScheduler(), target: null })
    startNotionBridge({ store, sync: () => { throw new Error('queue broke') }, batch: () => undefined })
    expect(() => store.set('g01-l01', 'completed')).not.toThrow()
    expect(store.statusOf('g01-l01')).toBe('completed')
  })

  it('skips temporary groups in single and batch updates without touching Notion, while still updating store', async () => {
    const clock = new FakeClock()
    const store = createProgressStore({
      backend: new ScriptedBackend('local'),
      storage: new MemoryStorage(),
      now: clock.now,
      locks: null,
      scheduler: new FakeScheduler(),
      target: null,
      loadSeed: async () => ({
        version: 's',
        records: [rec('g01-l01', 'not_started', { notionNodeId: 'node-1', notionPageId: 'page-1' })],
      }),
    })
    const single: Array<[string, string, string | undefined, string | undefined]> = []
    const batches: NotionItem[][] = []
    startNotionBridge({
      store,
      sync: (id, status, node, page) => single.push([id, status, node, page]),
      batch: (items) => batches.push(items),
      isTempGroup: (groupId) => groupId === 'tmp' || groupId === 'tmp2',
    })
    await store.load()

    // Pure temporary group single write -> DB/store updated, Notion skipped
    store.set('tmp-l06', 'completed')
    expect(store.statusOf('tmp-l06')).toBe('completed')
    expect(single).toEqual([])
    expect(batches).toEqual([])

    // Pure temporary group batch -> DB/store updated, Notion skipped
    store.setMany([
      { lectureId: 'tmp-l01', status: 'completed' },
      { lectureId: 'tmp2-l02', status: 'in_progress' },
    ])
    expect(store.statusOf('tmp-l01')).toBe('completed')
    expect(store.statusOf('tmp2-l02')).toBe('in_progress')
    expect(single).toEqual([])
    expect(batches).toEqual([])

    // Mixed batch -> only permanent group lectures are forwarded to Notion
    store.setMany([
      { lectureId: 'g01-l01', status: 'completed' },
      { lectureId: 'tmp-l02', status: 'completed' },
    ])
    expect(store.statusOf('tmp-l02')).toBe('completed')
    expect(single).toEqual([['g01-l01', W.completed, 'node-1', 'page-1']])
    expect(batches).toEqual([])
  })

  it('uses runtime tempGroupIds and live resolver when no custom isTempGroup option is passed', async () => {
    const clock = new FakeClock()
    const store = createProgressStore({ backend: new ScriptedBackend('local'), storage: new MemoryStorage(), now: clock.now, locks: null, scheduler: new FakeScheduler(), target: null })
    const single: Array<[string, string]> = []
    configureProgress({
      groups: [
        { id: 'G01', dir: 'g01' },
        { id: 'TMP', dir: 'tmp', temp: true },
      ],
    })
    startNotionBridge({
      store,
      sync: (id, status) => single.push([id, status]),
      batch: () => undefined,
    })
    await store.load()
    store.set('tmp-l06', 'completed')
    expect(single).toEqual([])

    // Simulate a dynamically loaded restricted temporary tier added after configureProgress()
    setTempGroupResolver((groupId) => groupId === 'dyn-tmp')
    expect(isTempGroupId('dyn-tmp', 'dyn-tmp-l01')).toBe(true)
    store.set('dyn-tmp-l01', 'in_progress')
    expect(single).toEqual([])

    store.set('g01-l01', 'completed')
    expect(single).toEqual([['g01-l01', W.completed]])

    // Restricted temporary lecture pre-merge context (`fm.groupTemp`): scopes Notion skip to current route group
    setTempGroupResolver((groupId, lectureId) =>
      matchesTempGroupContext({
        groupId,
        lectureId,
        groups: [{ id: 'G01', dir: 'g01' }],
        frontmatter: { groupTemp: true },
        routeGroup: 'rtmp',
      }),
    )
    single.length = 0
    store.setMany([
      { lectureId: 'rtmp-l02', status: 'completed' },
      { lectureId: 'g01-l01', status: 'in_progress' },
    ])
    expect(store.statusOf('rtmp-l02')).toBe('completed')
    expect(single).toEqual([['g01-l01', W.in_progress]])

    setTempGroupResolver(null)
    configureProgress(undefined)
  })
})

describe('site runtime settings', () => {
  it('parses lectureModules and the group list out of themeConfig, with defaults for anything missing', () => {
    expect(parseProgressRuntime(undefined)).toEqual({ adapter: 'local', endpoint: '/api/db', notionSync: false, authAdapter: 'none', sessionEndpoint: undefined, groupIds: [], tempGroupIds: [] })
    const rt = parseProgressRuntime({
      lectureModules: { progress: { adapter: 'rest', endpoint: '/svc', notionSync: true }, auth: { adapter: 'trusted-header', sessionEndpoint: '/svc/session' } },
      groups: [{ dir: 'courses/G01' }, { dir: 'xr', id: 'XR', temp: true }, { id: 'no-dir' }, null],
    })
    expect(rt).toEqual({ adapter: 'rest', endpoint: '/svc', notionSync: true, authAdapter: 'trusted-header', sessionEndpoint: '/svc/session', groupIds: ['g01', 'xr'], tempGroupIds: ['xr'] })
    expect(parseTempGroupIds({ groups: [{ id: 'TMP1', dir: 'courses/tmp-one', temp: true }, { id: 'G02', dir: 'g02' }, { id: 'NO_DIR', temp: true }] })).toEqual(['tmp-one', 'no_dir'])
  })

  it('keeps id and dir namespaces separate so temp id never blocks another permanent dir', async () => {
    const clock = new FakeClock()
    const store = createProgressStore({ backend: new ScriptedBackend('local'), storage: new MemoryStorage(), now: clock.now, locks: null, scheduler: new FakeScheduler(), target: null })
    const single: Array<[string, string]> = []
    const groups = [
      { id: 'G01', dir: 'scratch', temp: true },
      { id: 'G02', dir: 'g01' },
    ]
    configureProgress({ groups })
    setTempGroupResolver((groupId, lectureId) => matchesTempGroupContext({ groupId, lectureId, groups }))
    startNotionBridge({ store, sync: (id, status) => single.push([id, status]), batch: () => undefined })
    await store.load()

    store.set('scratch-l01', 'completed')
    expect(single).toEqual([])

    store.set('g01-l01', 'completed')
    expect(single).toEqual([['g01-l01', W.completed]])

    expect(isTempGroupId('G01')).toBe(true)
    expect(isTempGroupId('g01', 'g01-l01')).toBe(false)
    expect(isTempGroupId('scratch', 'scratch-l01')).toBe(true)

    setTempGroupResolver(null)
    configureProgress(undefined)
  })

  it('configureProgress sets the runtime the singleton uses', () => {
    const rt = configureProgress({ lectureModules: { progress: { adapter: 'rest', notionSync: true } } })
    expect(rt.adapter).toBe('rest')
    expect(progressRuntime().notionSync).toBe(true)
    configureProgress(undefined)
    expect(progressRuntime().adapter).toBe('local')
  })
})

/** A component that renders `render(useProgress(store))` and optionally listens for rejected writes. */
function probe(store: ProgressStore, render: (p: UseProgress) => string, onRejected?: (e: { id: string; status: string }) => void) {
  return defineComponent({
    setup() {
      const p = useProgress(store)
      if (onRejected) p.onRejected(onRejected)
      return () => h('p', render(p))
    },
  })
}

describe('useProgress', () => {
  it('renders everything as not started until mounted and ready, then follows the store', async () => {
    const clock = new FakeClock()
    const backend = new ScriptedBackend('local')
    const gate = deferred<{ ok: true; records: ProgressRecord[]; serverDate: null }>()
    backend.sendResults.push(gate.promise)
    const store = createProgressStore({ backend, storage: new MemoryStorage(), now: clock.now, locks: null, scheduler: new FakeScheduler(), target: null, loadSeed: async () => ({ version: 's', records: [rec('g01-l01', 'completed')] }) })
    const w = mount(probe(store, (p) => `${p.ready.value}|${p.statusOf('g01-l01')}|${p.countCompleted(['g01-l01', 'g01-l02'])}|${p.pending.value}|${p.syncState.value}`))
    expect(w.text()).toBe('false|not_started|0|0|idle')
    await store.load()
    await nextTick()
    expect(w.text()).toBe('true|completed|1|0|idle')
    store.set('g01-l02', 'completed')
    await settle()
    await nextTick()
    expect(w.text()).toBe('true|completed|2|1|sending')
    gate.resolve({ ok: true, records: [rec('g01-l02', 'completed')], serverDate: null })
    await store.flush()
    await settle()
    await nextTick()
    expect(w.text()).toBe('true|completed|2|0|idle')
    w.unmount()
    store.set('g01-l03', 'completed') // after unmount: no listener left, no error
  })

  it('exposes the completion time reactively and only when ready', async () => {
    const clock = new FakeClock()
    const store = createProgressStore({ backend: new ScriptedBackend('local'), storage: new MemoryStorage(), now: clock.now, locks: null, scheduler: new FakeScheduler(), target: null, loadSeed: async () => ({ version: 's', records: [rec('g01-l01', 'completed', { completedAt: '2026-10-01T00:00:00.000Z' })] }) })
    const w = mount(probe(store, (p) => `${p.completedAtOf('g01-l01')}|${p.completedAtOf('g01-l02')}`))
    expect(w.text()).toBe('null|null')
    await store.load()
    await nextTick()
    expect(w.text()).toBe('2026-10-01T00:00:00.000Z|null')
    store.set('g01-l02', 'completed')
    await nextTick()
    expect(w.text()).toBe(`2026-10-01T00:00:00.000Z|${clock.iso()}`)
    w.unmount()
  })

  it('reports rejected writes to the component', async () => {
    const clock = new FakeClock()
    const backend = new ScriptedBackend('local')
    backend.sendResults.push({ ok: false, error: { retryable: false, status: 422 } })
    const store = createProgressStore({ backend, storage: new MemoryStorage(), now: clock.now, locks: null, scheduler: new FakeScheduler(), target: null })
    const rejected: Array<{ id: string; status: string }> = []
    const w = mount(probe(store, () => '', (e) => rejected.push(e)))
    await store.load()
    store.set('g01-l01', 'completed')
    await store.flush()
    expect(rejected).toEqual([{ id: 'g01-l01', status: 'completed' }])
    w.unmount()
  })
})
