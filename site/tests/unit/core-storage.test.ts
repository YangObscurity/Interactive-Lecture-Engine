// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { STORAGE_KEYS } from '../../docs/.vitepress/site.config.mts'
import {
  __setLegacyAliasesForTests,
  getFlag,
  getJson,
  getRaw,
  keysOf,
  remove,
  setFlag,
  setJson,
  setRaw,
} from '../../docs/.vitepress/theme/core/storage'

afterEach(() => {
  __setLegacyAliasesForTests(null)
  localStorage.clear()
})

describe('core/storage', () => {
  it('uses the V1 key names unchanged', () => {
    expect(keysOf('readingMode')).toEqual(['lecture-reading-mode'])
    expect(keysOf('readingProgress')).toEqual(['lecture-read-pos'])
    expect(STORAGE_KEYS.readingProgress).toBe('lecture-read-pos')
  })

  it('flags are stored as "1" / "0" in the V1 key', () => {
    setFlag('readingMode', true)
    expect(localStorage.getItem('lecture-reading-mode')).toBe('1')
    expect(getFlag('readingMode')).toBe(true)
    setFlag('readingMode', false)
    expect(localStorage.getItem('lecture-reading-mode')).toBe('0')
    expect(getFlag('readingMode')).toBe(false)
  })

  it('reads V1 data written by V1 code', () => {
    const v1 = { '/g01/L01': { y: 1200, pct: 0.4, title: 'T', group: 'g01', ts: 1 } }
    localStorage.setItem('lecture-read-pos', JSON.stringify(v1))
    expect(getJson('readingProgress', {})).toEqual(v1)
  })

  it('json: fallback on missing / corrupt / invalid', () => {
    expect(getJson('readingProgress', { a: 1 })).toEqual({ a: 1 })
    localStorage.setItem('lecture-read-pos', '{not json')
    expect(getJson('readingProgress', {})).toEqual({})
    localStorage.setItem('lecture-read-pos', '[1,2]')
    const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
    expect(getJson('readingProgress', {}, isObj)).toEqual({})
  })

  it('setJson round-trips and leaves other keys untouched', () => {
    localStorage.setItem('tut_neon_progress_all_map', '{"x":1}')
    setJson('readingProgress', { '/g05/L19': { y: 1, pct: 0.5, title: '', group: 'g05', ts: 2 } })
    expect(JSON.parse(localStorage.getItem('lecture-read-pos') as string)['/g05/L19'].pct).toBe(0.5)
    expect(localStorage.getItem('tut_neon_progress_all_map')).toBe('{"x":1}')
  })

  it('legacy aliases: read falls back, writes dual-write, remove clears all', () => {
    __setLegacyAliasesForTests({ readingMode: ['old-reading-mode'] })
    localStorage.setItem('old-reading-mode', '1')
    expect(getRaw('readingMode')).toBe('1')
    setRaw('readingMode', '0')
    expect(localStorage.getItem('lecture-reading-mode')).toBe('0')
    expect(localStorage.getItem('old-reading-mode')).toBe('0')
    // current key wins once present
    localStorage.setItem('old-reading-mode', '1')
    expect(getRaw('readingMode')).toBe('0')
    remove('readingMode')
    expect(localStorage.getItem('lecture-reading-mode')).toBeNull()
    expect(localStorage.getItem('old-reading-mode')).toBeNull()
  })

  it('never throws when storage is broken', () => {
    const ls = window.localStorage
    const getItem = ls.getItem
    const setItem = ls.setItem
    ls.getItem = () => {
      throw new Error('denied')
    }
    ls.setItem = () => {
      throw new Error('quota')
    }
    try {
      expect(getFlag('readingMode')).toBe(false)
      expect(() => setFlag('readingMode', true)).not.toThrow()
      expect(getJson('readingProgress', 'fb')).toBe('fb')
    } finally {
      ls.getItem = getItem
      ls.setItem = setItem
    }
  })
})
