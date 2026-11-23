// @vitest-environment happy-dom
/**
 * Reader preferences (third override layer, P2b plumbing): the inline <head> script and the
 * runtime `applyPrefs` must produce identical <html> attributes for any stored value, including
 * garbage; storage failures never throw. Plus category → slot assignment.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { STORAGE_KEYS } from '../../docs/.vitepress/site.config.mts'
import { computeCustomTint } from '../../docs/.vitepress/theme/tokens/customTint'
import {
  GROUP_DESC_ATTR,
  PREFS_STORAGE_KEY,
  applyPrefs,
  headScript,
  prefAttrs,
  readPrefs,
  sanitizePrefs,
  writePrefs,
  type ThemeRuntime,
} from '../../docs/.vitepress/theme/tokens/prefs'
import { assignCategorySlots, groupColor, groupSlots, UNCATEGORISED } from '../../docs/.vitepress/theme/tokens/categories'

const RT: ThemeRuntime = {
  defaultTheme: 'datasheet',
  themes: [
    { id: 'datasheet', label: '器件手册', tints: [] },
    { id: 'reader', label: '阅读', tints: ['sepia', 'green'] },
  ],
}
const ATTRS = ['data-lec-theme', 'data-lec-tint', 'data-lec-size', 'data-lec-font'] as const

function clearAttrs() {
  for (const a of ATTRS) document.documentElement.removeAttribute(a)
}
function snapshot() {
  return Object.fromEntries(ATTRS.map((a) => [a, document.documentElement.getAttribute(a)]))
}
function runHeadScript() {
  clearAttrs()
  new Function(headScript(RT))()
  return snapshot()
}
function runApply() {
  clearAttrs()
  applyPrefs(document.documentElement, readPrefs(), RT)
  return snapshot()
}

afterEach(() => {
  localStorage.clear()
  clearAttrs()
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute(GROUP_DESC_ATTR)
})

describe('reader prefs: head script ≡ applyPrefs', () => {
  const cases: Array<[string, string | null]> = [
    ['nothing stored', null],
    ['reader + sepia + 18 + serif', JSON.stringify({ theme: 'reader', tint: 'sepia', fontSize: 18, bodyFont: 'serif' })],
    ['datasheet ignores reader tint', JSON.stringify({ theme: 'datasheet', tint: 'sepia' })],
    ['unknown theme → default', JSON.stringify({ theme: 'neon', tint: 'green' })],
    ['default size 17 → no attribute', JSON.stringify({ theme: 'reader', fontSize: 17 })],
    ['size not in whitelist', JSON.stringify({ fontSize: 19 })],
    ['size as string', JSON.stringify({ fontSize: '18' })],
    ['dark tint is VP appearance, not an attribute', JSON.stringify({ theme: 'reader', tint: 'dark' })],
    ['bad font', JSON.stringify({ bodyFont: 'comic' })],
    ['injection attempt', JSON.stringify({ theme: 'reader"><script>', tint: 'x" onload="y', bodyFont: 'sans' })],
    ['__proto__ theme', JSON.stringify({ theme: '__proto__' })],
    ['not JSON', '{oops'],
    ['JSON null', 'null'],
    ['JSON number', '42'],
  ]
  it.each(cases)('%s', (_name, raw) => {
    if (raw !== null) localStorage.setItem(PREFS_STORAGE_KEY, raw)
    const fromHead = runHeadScript()
    const fromApply = runApply()
    expect(fromHead).toEqual(fromApply)
    expect(fromHead['data-lec-theme']).toMatch(/^(datasheet|reader)$/)
  })

  it('expected attributes for a full reader preference', () => {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ theme: 'reader', tint: 'green', fontSize: 20, bodyFont: 'sans' }))
    expect(runHeadScript()).toEqual({
      'data-lec-theme': 'reader',
      'data-lec-tint': 'green',
      'data-lec-size': '20',
      'data-lec-font': 'sans',
    })
  })

  it('storage that throws still yields the default theme', () => {
    const orig = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('denied') } })
    try {
      expect(runHeadScript()).toEqual({ 'data-lec-theme': 'datasheet', 'data-lec-tint': null, 'data-lec-size': null, 'data-lec-font': null })
      expect(readPrefs()).toEqual({})
      expect(() => writePrefs({ theme: 'reader' })).not.toThrow()
    } finally {
      if (orig) Object.defineProperty(window, 'localStorage', orig)
    }
  })

  it('the head script embeds only whitelisted literals', () => {
    const src = headScript(RT)
    expect(src).toContain('"datasheet"')
    expect(src).toContain('[16,18,20]')
    expect(src).not.toMatch(/innerHTML|eval\(|document\.write/)
  })
})

describe('reader prefs: storage', () => {
  it('writePrefs merges, sanitises and removes undefined fields', () => {
    writePrefs({ theme: 'reader', fontSize: 18 })
    writePrefs({ tint: 'sepia', fontSize: 99 })
    expect(readPrefs()).toEqual({ theme: 'reader', tint: 'sepia' })
    writePrefs({ theme: undefined, tint: undefined })
    expect(localStorage.getItem(PREFS_STORAGE_KEY)).toBeNull()
  })
  it('sanitizePrefs drops malformed fields', () => {
    expect(sanitizePrefs({ theme: 'Reader', tint: 3, fontSize: 16, bodyFont: 'serif', extra: 1 })).toEqual({ fontSize: 16, bodyFont: 'serif' })
    expect(sanitizePrefs('x')).toEqual({})
  })
  it('prefAttrs falls back to the default theme', () => {
    expect(prefAttrs({ theme: 'nope' }, RT)['data-lec-theme']).toBe('datasheet')
  })
})

describe('category slots', () => {
  it('assigns slots by first appearance, wrapping after slotCount', () => {
    const groups = [
      { id: 'G01', category: '硬件与固件' },
      { id: 'G02', category: '编程语言' },
      { id: 'G03', category: '硬件与固件' },
      { id: 'G04', category: '网络与云' },
      { id: 'LR', category: '研究' },
    ]
    expect([...groupSlots(groups)]).toEqual([['G01', 1], ['G02', 2], ['G03', 1], ['G04', 3], ['LR', 4]])
    expect([...assignCategorySlots(groups, 3).values()]).toEqual([1, 2, 3, 1])
  })
  it('groups without a category share one bucket that takes the next free slot', () => {
    const slots = groupSlots([{ id: 'A', category: 'x' }, { id: 'B' }, { id: 'C', category: '  ' }, { id: 'D', category: 'y' }])
    expect([...slots]).toEqual([['A', 1], ['B', 2], ['C', 2], ['D', 3]])
    expect(assignCategorySlots([{ id: 'B' }]).get(UNCATEGORISED)).toBe(1)
  })
  it('is order-sensitive and deterministic', () => {
    const a = [{ id: '1', category: 'p' }, { id: '2', category: 'q' }]
    expect(groupSlots(a).get('2')).toBe(2)
    expect(groupSlots([...a].reverse()).get('2')).toBe(1)
  })
  it('rejects a bad slot count; accent overrides the slot colour', () => {
    expect(() => assignCategorySlots([], 0)).toThrow(RangeError)
    expect(groupColor(3)).toBe('var(--lec-cat-3)')
    expect(groupColor(3, '#3B82F6')).toBe('#3B82F6')
  })
})

describe('headScript: first-paint custom tint, theme layer & group-desc default (D-10)', () => {
  it('applies custom tint before first paint for reader only, ignores bad contrast, and applies group-desc + safe theme layer tokens', () => {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ theme: 'reader' }))
    localStorage.setItem(STORAGE_KEYS.readerCustomTint, JSON.stringify({ hue: 42, lightness: 95 }))
    localStorage.setItem(STORAGE_KEYS.groupDesc, '0')
    localStorage.setItem(
      STORAGE_KEYS.readerThemeLayer,
      JSON.stringify({
        modes: {
          light: {
            accent: '#2155C4',
            danger: 'red;position:fixed',
          },
        },
      }),
    )

    new Function(headScript(RT))()

    const expected = computeCustomTint(42, 95)
    expect(document.documentElement.getAttribute(GROUP_DESC_ATTR)).toBe('closed')
    expect(document.documentElement.style.getPropertyValue('--lec-bg')).toBe(expected.bgHex)
    expect(document.documentElement.style.getPropertyValue('--lec-danger')).toBe('')

    // Switching to datasheet prevents reader custom tint from painting
    document.documentElement.removeAttribute('style')
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ theme: 'datasheet' }))
    localStorage.setItem(STORAGE_KEYS.groupDesc, '1')
    new Function(headScript(RT))()
    expect(document.documentElement.getAttribute(GROUP_DESC_ATTR)).toBe('open')
    expect(document.documentElement.style.getPropertyValue('--lec-bg')).toBe('')
  })

  it('paints exactly the tokens computeCustomTint() computes, for light and dark lightness', () => {
    for (const [hue, lightness] of [[42, 95], [210, 12], [0, 70], [300, 30]] as const) {
      document.documentElement.removeAttribute('style')
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ theme: 'reader' }))
      localStorage.setItem(STORAGE_KEYS.readerCustomTint, JSON.stringify({ hue, lightness }))
      new Function(headScript(RT))()
      const expected = computeCustomTint(hue, lightness)
      for (const [prop, val] of Object.entries(expected.tokens)) {
        const got = document.documentElement.style.getPropertyValue(prop)
        if (expected.pass) expect(got.toUpperCase(), `${prop} @${hue}/${lightness}`).toBe(val.toUpperCase())
        else expect(got, `${prop} @${hue}/${lightness}`).toBe('')
      }
    }
  })
})
