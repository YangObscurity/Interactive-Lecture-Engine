import { describe, expect, it } from 'vitest'
import {
  isGroupIndex,
  isHome,
  isLecture,
  normalisePath,
  parseLecture,
  splitLocale,
} from '../../docs/.vitepress/theme/core/route'

describe('normalisePath', () => {
  const cases: Array<[string, string, string?]> = [
    ['/', '/'],
    ['', '/'],
    ['/index', '/'],
    ['/index.html', '/'],
    ['/g05/L19', '/g05/L19'],
    ['/g05/L19.html', '/g05/L19'],
    ['/g05/L19/', '/g05/L19'],
    ['/g05//L19', '/g05/L19'],
    ['/g05/L19?debug=1#sec', '/g05/L19'],
    ['/g01/', '/g01'],
    ['/g01/index.html', '/g01'],
    ['/lr/', '/lr'],
    ['/examples/g01/L01.html', '/examples/g01/L01'],
    ['/docs/g05/L19.html', '/g05/L19', '/docs/'],
    ['/docs/', '/', '/docs/'],
    ['/Tutorial', '/', '/Tutorial'],
    ['/other/g05/L19', '/other/g05/L19', '/docs/'],
  ]
  it.each(cases)('%s → %s (base %s)', (raw, want, base) => {
    expect(normalisePath(raw, base)).toBe(want)
  })
})

describe('isHome / isGroupIndex / isLecture', () => {
  const table: Array<{ path: string; home: boolean; group: boolean; lecture: boolean }> = [
    { path: '/', home: true, group: false, lecture: false },
    { path: '/index.html', home: true, group: false, lecture: false },
    { path: '/g01/', home: false, group: true, lecture: false },
    { path: '/g01/index', home: false, group: true, lecture: false },
    { path: '/lr/', home: false, group: true, lecture: false },
    { path: '/examples/g01/', home: false, group: true, lecture: false },
    { path: '/g05/L19', home: false, group: false, lecture: true },
    { path: '/g05/L19.html', home: false, group: false, lecture: true },
    { path: '/g05/L19/', home: false, group: false, lecture: true },
    { path: '/lr/L53', home: false, group: false, lecture: true },
    { path: '/spi/L00', home: false, group: false, lecture: true },
    { path: '/examples/g01/L01', home: false, group: false, lecture: true },
    { path: '/g05/L19x', home: false, group: false, lecture: false },
    { path: '/L19', home: false, group: false, lecture: false },
    { path: '/g05/intro', home: false, group: false, lecture: false },
  ]
  it.each(table)('$path', ({ path, home, group, lecture }) => {
    expect(isHome(path)).toBe(home)
    expect(isGroupIndex(path)).toBe(group)
    expect(isLecture(path)).toBe(lecture)
  })
})

describe('parseLecture', () => {
  it('flat group path, V1 lectureId format', () => {
    expect(parseLecture('/g05/L19.html')).toEqual({
      path: '/g05/L19',
      dir: 'g05',
      group: 'g05',
      topSegment: 'g05',
      lectureCode: 'L19',
      lectureNo: 19,
      lectureId: 'g05-L19',
    })
  })
  it('zero-pads to two digits, keeps 3-digit numbers', () => {
    expect(parseLecture('/g01/L1')?.lectureId).toBe('g01-L01')
    expect(parseLecture('/g01/L01')?.lectureId).toBe('g01-L01')
    expect(parseLecture('/g01/L100')?.lectureId).toBe('g01-L100')
    expect(parseLecture('/spi/L00')?.lectureNo).toBe(0)
  })
  it('lowercases the group like V1 useLectureContext', () => {
    const r = parseLecture('/G05/l19')
    expect(r?.group).toBe('g05')
    expect(r?.lectureId).toBe('g05-L19')
    expect(r?.lectureCode).toBe('L19')
    // path case is preserved (reading-progress store keys)
    expect(r?.path).toBe('/G05/l19')
  })
  it('nested dirs: group = last segment, topSegment = first (V1 reading-progress group)', () => {
    const r = parseLecture('/examples/g01/L01/')
    expect(r).toMatchObject({ dir: 'examples/g01', group: 'g01', topSegment: 'examples', lectureId: 'g01-L01' })
  })
  it('base path is stripped', () => {
    expect(parseLecture('/docs/lr/L53.html', '/docs/')?.lectureId).toBe('lr-L53')
  })
  it('rejects non-lecture paths', () => {
    for (const p of ['/', '/g01/', '/g05/L19x', '/L19', '/g05/notes', '/a b/L01', '/../L01']) {
      expect(parseLecture(p), p).toBeNull()
    }
  })
})

describe('locale prefix (P2d)', () => {
  const keys = ['en']

  it('splitLocale removes a whole-segment prefix only', () => {
    expect(splitLocale('/en/g01/L03', keys)).toEqual({ locale: 'en', path: '/g01/L03' })
    expect(splitLocale('/en/', keys)).toEqual({ locale: 'en', path: '/' })
    expect(splitLocale('/en', keys)).toEqual({ locale: 'en', path: '/' })
    expect(splitLocale('/en/index.html', keys)).toEqual({ locale: 'en', path: '/index.html' })
    expect(splitLocale('/en#top', keys)).toEqual({ locale: 'en', path: '/#top' })
    expect(splitLocale('/g01/L03', keys)).toEqual({ locale: null, path: '/g01/L03' })
    expect(splitLocale('/english/L03', keys)).toEqual({ locale: null, path: '/english/L03' })
    expect(splitLocale('/g01/en/L03', keys)).toEqual({ locale: null, path: '/g01/en/L03' })
    expect(splitLocale('/en/g01/L03', [])).toEqual({ locale: null, path: '/en/g01/L03' })
  })

  it('isHome treats /<key>/ as home, only when the key is given', () => {
    for (const p of ['/en', '/en/', '/en/index', '/en/index.html']) {
      expect(isHome(p, '/', keys), p).toBe(true)
      expect(isGroupIndex(p, '/', keys), p).toBe(false)
    }
    // without keys `/en/` is an ordinary group index (single-language behaviour unchanged)
    expect(isHome('/en/')).toBe(false)
    expect(isGroupIndex('/en/')).toBe(true)
    expect(isHome('/', '/', keys)).toBe(true)
  })

  it('isGroupIndex / isLecture look behind the prefix', () => {
    expect(isGroupIndex('/en/g01/', '/', keys)).toBe(true)
    expect(isGroupIndex('/en/examples/g01/index.html', '/', keys)).toBe(true)
    expect(isGroupIndex('/en/g01/L03', '/', keys)).toBe(false)
    expect(isLecture('/en/g01/L03.html', '/', keys)).toBe(true)
    expect(isLecture('/en/', '/', keys)).toBe(false)
  })

  it('parseLecture gives the same path for both languages and tags the locale', () => {
    const zh = parseLecture('/examples/g01/L01', '/', keys)
    const en = parseLecture('/en/examples/g01/L01.html', '/', keys)
    expect(zh?.locale).toBeUndefined()
    expect(en?.locale).toBe('en')
    expect(en?.path).toBe('/examples/g01/L01')
    expect(en?.path).toBe(zh?.path)
    expect(en).toMatchObject({ dir: 'examples/g01', group: 'g01', topSegment: 'examples', lectureId: 'g01-L01' })
    expect(en?.lectureId).toBe(zh?.lectureId)
  })

  it('base and locale prefix combine', () => {
    const r = parseLecture('/docs/en/lr/L53.html', '/docs/', keys)
    expect(r).toMatchObject({ locale: 'en', path: '/lr/L53', lectureId: 'lr-L53' })
    expect(isHome('/docs/en/', '/docs/', keys)).toBe(true)
  })

  it('without keys the result is the single-language one (no locale field)', () => {
    expect(parseLecture('/g05/L19.html')).not.toHaveProperty('locale')
    expect(parseLecture('/en/g05/L19.html')?.path).toBe('/en/g05/L19')
  })
})
