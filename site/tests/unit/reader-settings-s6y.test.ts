/**
 * S6Y F6: reader-settings helpers in tokens/prefs.ts.
 *  - defaultBodyFont (audit-spec #12): with no font saved the settings panel highlights the theme's own default.
 *    Values below are the computed `--lec-font-body*` of the two engine themes on the demo build (S1 probe, 2026-11-23).
 *  - syncAppearanceSwitch (audit-spec #22): VitePress' switch gets the real aria-checked after hydration.
 */
import { describe, expect, it } from 'vitest'
import { defaultBodyFont, syncAppearanceSwitch } from '../../docs/.vitepress/theme/tokens/prefs'

function style(vars: Record<string, string>): Pick<CSSStyleDeclaration, 'getPropertyValue'> {
  return { getPropertyValue: (n: string) => vars[n] ?? '' }
}

const READER_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
const READER_SERIF = '"Songti SC", SimSun, "Noto Serif CJK SC", serif'
const DS_SERIF = '"Noto Serif SC Variable", "Noto Serif SC", "Songti SC", SimSun, serif'
const DS_SANS = '"Noto Sans SC Variable", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif'

describe('defaultBodyFont', () => {
  it('reader: body = sans stack -> sans (the panel used to say serif)', () => {
    expect(defaultBodyFont(style({ '--lec-font-body': READER_SANS, '--lec-font-body-serif': READER_SERIF, '--lec-font-body-sans': READER_SANS }))).toBe('sans')
  })
  it('datasheet: body = serif stack -> serif', () => {
    expect(defaultBodyFont(style({ '--lec-font-body': DS_SERIF, '--lec-font-body-serif': DS_SERIF, '--lec-font-body-sans': DS_SANS }))).toBe('serif')
  })
  it('ignores spacing differences after commas', () => {
    expect(defaultBodyFont(style({ '--lec-font-body': DS_SANS.replace(/, /g, ','), '--lec-font-body-serif': DS_SERIF, '--lec-font-body-sans': DS_SANS }))).toBe('sans')
  })
  it('a theme without the two variants falls back on the generic family', () => {
    expect(defaultBodyFont(style({ '--lec-font-body': 'Georgia, serif' }))).toBe('serif')
    expect(defaultBodyFont(style({ '--lec-font-body': 'Inter, sans-serif' }))).toBe('sans')
    expect(defaultBodyFont(style({}))).toBe('sans')
  })
})

describe('syncAppearanceSwitch', () => {
  it('writes aria-checked on every VitePress appearance switch', () => {
    const attrs: Array<Record<string, string>> = [{}, {}]
    const doc = {
      querySelectorAll: (sel: string) => (sel === '.VPSwitchAppearance' ? attrs.map((a) => ({ setAttribute: (k: string, v: string) => (a[k] = v) })) : []),
    } as unknown as Document
    syncAppearanceSwitch(true, doc)
    expect(attrs).toEqual([{ 'aria-checked': 'true' }, { 'aria-checked': 'true' }])
    syncAppearanceSwitch(false, doc)
    expect(attrs.map((a) => a['aria-checked'])).toEqual(['false', 'false'])
  })
  it('is a no-op without a document (SSR)', () => {
    expect(() => syncAppearanceSwitch(true, undefined)).not.toThrow()
  })
})
