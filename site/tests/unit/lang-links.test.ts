// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { STORAGE_KEYS } from '../../docs/.vitepress/site.config.mts'
import {
  hasTranslation,
  localizedLecture,
  siteLangs,
  switchTarget,
  type SiteLocales,
} from '../../docs/.vitepress/theme/core/langLinks'
import { getReaderLang, readerLang, setReaderLang } from '../../docs/.vitepress/theme/core/readerLang'

const locales: SiteLocales = {
  root: { lang: 'zh-CN' },
  en: { lang: 'en', themeConfig: { i18nPages: { '/examples/g01/L01': { title: 'Ohm' } } } },
}
const ctx = { locales, groupDirs: ['g01', 'examples/g01'] }
const [zh, en] = siteLangs(locales)

afterEach(() => {
  localStorage.clear()
  readerLang.value = null
})

describe('core/langLinks', () => {
  it('lists the root language first and nothing for a single-language site', () => {
    expect(siteLangs(locales)).toEqual([
      { lang: 'zh-CN', key: '', isRoot: true },
      { lang: 'en', key: 'en', isRoot: false },
    ])
    expect(siteLangs(undefined)).toEqual([])
    expect(siteLangs({ root: { lang: 'zh-CN' } })).toHaveLength(1)
  })

  it('knows which lectures exist in which language', () => {
    expect(hasTranslation(locales, 'en', '/examples/g01/L01')).toBe(true)
    expect(hasTranslation(locales, 'en', '/g01/L01')).toBe(false)
    expect(hasTranslation(locales, '', '/g01/L01')).toBe(true)
  })

  it('switches a lecture to its translation, else to the group page of that language', () => {
    expect(switchTarget('/examples/g01/L01', en!, ctx)).toBe('/en/examples/g01/L01')
    expect(switchTarget('/g01/L01', en!, ctx)).toBe('/en/g01/')
    expect(switchTarget('/en/examples/g01/L01', zh!, ctx)).toBe('/examples/g01/L01')
    expect(switchTarget('/en/examples/g01/L01.html', zh!, ctx)).toBe('/examples/g01/L01')
  })

  it('switches group pages, the home page and any other page', () => {
    expect(switchTarget('/g01/', en!, ctx)).toBe('/en/g01/')
    expect(switchTarget('/en/examples/g01/', zh!, ctx)).toBe('/examples/g01/')
    expect(switchTarget('/', en!, ctx)).toBe('/en/')
    expect(switchTarget('/en/', zh!, ctx)).toBe('/')
    expect(switchTarget('/en', zh!, ctx)).toBe('/')
    expect(switchTarget('/some/other', en!, ctx)).toBe('/en/')
    expect(switchTarget('/en/some/other', zh!, ctx)).toBe('/')
  })

  it('honours site.base', () => {
    expect(switchTarget('/docs/g01/L01', en!, { ...ctx, base: '/docs/' })).toBe('/en/g01/')
    expect(switchTarget('/docs/en/', zh!, { ...ctx, base: '/docs/' })).toBe('/')
  })

  it('maps a lecture row of a locale group page', () => {
    const pages = locales.en!.themeConfig!.i18nPages!
    expect(localizedLecture('/examples/g01/L01', 'orig', 'en', pages)).toEqual({ path: '/en/examples/g01/L01', title: 'Ohm', translated: true })
    expect(localizedLecture('/examples/g01/L02', 'orig', 'en', pages)).toEqual({ path: '/examples/g01/L02', title: 'orig', translated: false })
    expect(localizedLecture('/examples/g01/L02', 'orig', '', pages)).toEqual({ path: '/examples/g01/L02', title: 'orig', translated: true })
  })
})

describe('core/readerLang', () => {
  it('uses the agreed storage key and round-trips a language', () => {
    expect(STORAGE_KEYS.readerLang).toBe('lecture-reader-lang')
    expect(getReaderLang()).toBeNull()
    setReaderLang('en')
    expect(localStorage.getItem('lecture-reader-lang')).toBe('en')
    expect(getReaderLang()).toBe('en')
    expect(readerLang.value).toBe('en')
  })

  it('ignores junk in storage', () => {
    localStorage.setItem('lecture-reader-lang', 'klingon')
    expect(getReaderLang()).toBeNull()
  })
})
