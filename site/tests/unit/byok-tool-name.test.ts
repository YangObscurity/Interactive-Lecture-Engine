import { describe, expect, it, vi } from 'vitest'
import { executeReaderToolCall } from '../../docs/.vitepress/theme/components/ai/byokClient'

describe('reader own-key tool loop: tool names from the model', () => {
  it('only a plain tool identifier becomes a request path; "." and ".." never leave /api/tools/', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    for (const bad of ['..', '.', '../ai/chat', 'a/b', 'Search', '', 'x'.repeat(70)]) {
      const res = await executeReaderToolCall(bad, '{}', fetchFn as unknown as typeof fetch, '/api/tools')
      expect(res).toEqual({ ok: false, content: JSON.stringify({ error: 'unknown_tool' }) })
    }
    expect(fetchFn).not.toHaveBeenCalled()
    const good = await executeReaderToolCall('search_concepts', '{"query":"x"}', fetchFn as unknown as typeof fetch, '/api/tools')
    expect(good.ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledWith('/api/tools/search_concepts', expect.objectContaining({ method: 'POST' }))
  })
})
