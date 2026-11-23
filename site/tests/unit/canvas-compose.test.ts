/**
 * P4b: client composition & loader of pre-computed canvas layouts across P3b access tiers.
 */
import { describe, expect, it } from 'vitest'
import { emptyCanvasBundle, type CanvasBundle, type CanvasTierSlice } from '../../docs/.vitepress/curriculum/canvasTypes'
import { runCanvasWorker } from '../../docs/.vitepress/curriculum/canvasNode.mts'
import { composeCanvas } from '../../docs/.vitepress/theme/curriculum/canvasCompose'
import { loadCanvasWith, type CanvasLoadDeps } from '../../docs/.vitepress/theme/curriculum/canvasLoader'
import type { AccessDeps, AccessResult } from '../../docs/.vitepress/theme/access/resolve'

function makeSlice(tier: string, withInlineIds: string[], ownIds: string[], edges: Array<[string, string]>, ownCatOffset = 1): CanvasTierSlice {
  const mk = (ids: string[], off = 0) =>
    ids.map((id, i) => ({
      id,
      dir: id.toLowerCase(),
      catSlot: ((i + off) % 3) + 1,
      lectures: Array.from({ length: 4 }, (_, k) => ({ id: `${id.toLowerCase()}-l0${k + 1}`, n: k + 1 })),
    }))
  const ownEdges = edges.filter(([a, b]) => ownIds.some((id) => a.startsWith(id.toLowerCase())) && ownIds.some((id) => b.startsWith(id.toLowerCase())))
  return {
    version: 1,
    tier,
    boardWithInline: runCanvasWorker({ groups: mk(withInlineIds, 0), edges }),
    tierOwn: runCanvasWorker({ groups: mk(ownIds, ownCatOffset), edges: ownEdges }),
  }
}

describe('composeCanvas & loadCanvasWith', () => {
  const allEdges: Array<[string, string]> = [
    ['g06-l01', 'g09-l02'],
    ['g09-l02', 'g12-l03'],
    ['g06-l02', 'g12-l01'],
  ]
  const inline = runCanvasWorker({
    groups: [{ id: 'G06', dir: 'g06', catSlot: 1, lectures: [1, 2, 3, 4].map((n) => ({ id: `g06-l0${n}`, n })) }],
    edges: [],
  })
  const authSlice = makeSlice('authenticated', ['G06', 'G09'], ['G09'], [['g06-l01', 'g09-l02']], 1)
  const staffSlice = makeSlice('grp-675ca4d1', ['G06', 'G12'], ['G12'], [['g06-l02', 'g12-l01']], 2)

  it('0 readable tiers returns inline untouched', () => {
    expect(composeCanvas(inline, [], [])).toBe(inline)
  })

  it('1 readable tier uses its exact ELK + libavoid boardWithInline', () => {
    const merged = composeCanvas(inline, [authSlice], [['g06-l01', 'g09-l02']])
    expect(merged).toBe(authSlice.boardWithInline)
    expect(merged.reader.groups.map((g) => g.id).sort()).toEqual(['G06', 'G09'])
  })

  it('>=2 readable tiers compose all groups cleanly with cross-tier bundles and buses, no overlap', () => {
    const merged = composeCanvas(inline, [authSlice, staffSlice], allEdges)
    expect(merged.reader.groups.map((g) => g.id).sort()).toEqual(['G06', 'G09', 'G12'])
    expect(merged.reader.bundles.length).toBe(3)
    expect(Object.keys(merged.datasheet.compact.units).sort()).toEqual(['G06', 'G09', 'G12'])
    expect(merged.datasheet.compact.buses.length).toBe(3)
    expect(merged.datasheet.zones.zones.length).toBeGreaterThanOrEqual(2)
    // zero overlap between composed reader group boxes
    const gs = merged.reader.groups
    for (let i = 0; i < gs.length; i++) {
      for (let j = i + 1; j < gs.length; j++) {
        const a = gs[i]!
        const b = gs[j]!
        const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlaps, `${a.id} overlaps ${b.id}`).toBe(false)
      }
    }
  })

  it('loadCanvasWith makes zero HTTP requests when no restricted tier is readable and ignores invalid slices', async () => {
    const calls: string[] = []
    const http: AccessDeps = {
      withBase: (p) => p,
      fetch: (async (url: string) => {
        calls.push(url)
        if (url === '/_access/authenticated/canvas.json') return { status: 200, json: async () => authSlice } as Response
        if (url === '/_access/grp-675ca4d1/canvas.json') return { status: 403, json: async () => ({}) } as Response
        return { status: 404, json: async () => ({}) } as Response
      }) as typeof fetch,
    }

    const noTiers: CanvasLoadDeps = { inline: async () => inline, access: async () => ({ tiers: [] }), http: () => http }
    expect(await loadCanvasWith(noTiers, [])).toBe(inline)
    expect(calls).toEqual([])

    const access: AccessResult = {
      tiers: ['authenticated', 'grp-675ca4d1'].map((id) => ({
        id,
        slice: { version: 1, tier: id, groups: [], totals: { lectures: 0, charts: 0 }, locales: {} },
      })),
    }
    const partial = await loadCanvasWith({ inline: async () => inline, access: async () => access, http: () => http }, allEdges)
    expect(calls.sort()).toEqual(['/_access/authenticated/canvas.json', '/_access/grp-675ca4d1/canvas.json'])
    expect(partial.reader.groups.map((g) => g.id).sort()).toEqual(['G06', 'G09'])

    const broken = await loadCanvasWith(
      { inline: async () => Promise.reject(new Error('boom')) as Promise<CanvasBundle>, access: async () => ({ tiers: [] }), http: () => http },
      [],
    )
    expect(broken).toEqual(emptyCanvasBundle())
  })
})
