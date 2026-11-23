import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DATA_FILES } from '../../docs/.vitepress/site.config.mts'
import { createSidecarLoader } from '../../docs/.vitepress/theme/charts/sidecar'

const payload = { c1: { type: 'mermaid', code: 'graph TD; A-->B' } }

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('charts/sidecar', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('builds the URL from DATA_FILES.chartsDir through withBase', async () => {
    const fetchMock = vi.fn(async () => okResponse(payload))
    const loader = createSidecarLoader({ withBase: (p) => '/base' + p, fetch: fetchMock as unknown as typeof fetch })
    expect(loader.url('G01-L01')).toBe(`/base${DATA_FILES.chartsDir}/G01-L01.json`)
    await loader.load('G01-L01')
    expect(fetchMock).toHaveBeenCalledWith(`/base${DATA_FILES.chartsDir}/G01-L01.json`, { credentials: 'same-origin' })
  })

  it('caches successful payloads and dedupes concurrent loads', async () => {
    const fetchMock = vi.fn(async () => okResponse(payload))
    const loader = createSidecarLoader({ fetch: fetchMock as unknown as typeof fetch })
    const [a, b] = await Promise.all([loader.load('L'), loader.load('L')])
    expect(a).toEqual(payload)
    expect(b).toBe(a)
    const c = await loader.load('L')
    expect(c).toBe(a)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(loader.has('L')).toBe(true)
    expect(loader.size).toBe(1)
  })

  it('does not cache failures (non-200, throw, non-object) so the next visit retries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 404 }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(okResponse([1, 2]))
      .mockResolvedValueOnce(okResponse(payload))
    const loader = createSidecarLoader({ fetch: fetchMock as unknown as typeof fetch })
    expect(await loader.load('X')).toBeNull()
    expect(await loader.load('X')).toBeNull()
    expect(await loader.load('X')).toBeNull()
    expect(await loader.load('X')).toEqual(payload)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('clear() empties the cache', async () => {
    const fetchMock = vi.fn(async () => okResponse(payload))
    const loader = createSidecarLoader({ fetch: fetchMock as unknown as typeof fetch })
    await loader.load('L')
    loader.clear()
    await loader.load('L')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
