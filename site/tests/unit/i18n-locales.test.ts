/**
 * Locales, hreflang and first-paint script of the V2 config (P2d WP-I2). The default lecture.config.ts enables
 * zh-CN (root) + en. The translation scan of site/docs is replaced by one synthetic English lecture
 * (`/courses/g01/L01`, a nested group dir), so the tests do not depend on what content:sync left in site/docs.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  v2AbsoluteUrl,
  v2Hreflang,
  v2LocaleConfig,
  v2LocaleKeys,
  v2Locales,
  v2OtherLangs,
  v2ReadingModeHead,
  v2Search,
  v2Translations,
} from '../../docs/.vitepress/config.v2.mts'

// hoisted above the imports by vitest: config.v2.mts scans site/docs for translations when it is loaded
vi.mock('../../docs/.vitepress/i18n/scan.mts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../docs/.vitepress/i18n/scan.mts')>()),
  scanTranslations: (_docsRoot: string, keys: readonly string[]) =>
    Object.fromEntries(keys.map((k) => [k, k === 'en' ? { '/courses/g01/L01': { link: '/en/courses/g01/L01', title: "Example Lecture 1 · Ohm's Law" } } : {}])),
}))

const groups = [
  { id: 'EX', dir: 'courses/g01', title: '示例课程', i18n: { en: { title: 'Example course' } } },
  { id: 'G02', dir: 'g02', title: '第二组', temp: true },
]
const siteMeta = { name: '站点', tagline: '副标题', i18n: { en: { name: 'Site', tagline: 'Tagline' } } }

describe('v2Locales', () => {
  const locales = v2Locales({ groups, siteMeta })

  it('default config: en is the one other language and has a real translation', () => {
    expect(v2OtherLangs).toEqual(['en'])
    expect(v2LocaleKeys).toEqual(['en'])
    expect(v2Translations.en?.['/courses/g01/L01']).toMatchObject({ link: '/en/courses/g01/L01' })
    expect(v2Translations.en?.['/courses/g01/L01']?.title).toContain('Ohm')
  })

  it('root + en; every label is empty so the built-in language menu stays hidden', () => {
    expect(Object.keys(locales ?? {})).toEqual(['root', 'en'])
    expect(locales?.root).toMatchObject({ label: '', lang: 'zh-CN' })
    expect(locales?.en).toMatchObject({ label: '', lang: 'en', link: '/en/', title: 'Site', description: 'Tagline' })
  })

  it('en nav uses localized group titles and /en/ links; the temp marker is localized', () => {
    const nav = locales?.en?.themeConfig?.nav as Array<{ text: string; link?: string; items?: Array<{ text: string; link: string }> }>
    expect(nav[0]).toMatchObject({ text: 'Overview', link: '/en/' })
    expect(nav[1]?.items).toEqual([
      { text: 'EX · Example course', link: '/en/courses/g01/' },
      { text: 'G02 · 第二组 (temporary)', link: '/en/g02/' },
    ])
  })

  it('en sidebar lists only translated lectures; groups without any get no entry', () => {
    const sidebar = locales?.en?.themeConfig?.sidebar as Record<string, Array<{ items: Array<{ text: string; link: string }> }>>
    expect(Object.keys(sidebar)).toEqual(['/en/courses/g01/'])
    expect(sidebar['/en/courses/g01/']?.[0]?.items).toEqual([
      { text: v2Translations.en?.['/courses/g01/L01']?.title, link: '/en/courses/g01/L01' },
    ])
  })

  it('i18nPages is keyed by the root path', () => {
    const pages = locales?.en?.themeConfig?.i18nPages as Record<string, { title: string }>
    expect(Object.keys(pages)).toContain('/courses/g01/L01')
    expect(pages['/courses/g01/L01']?.title).toBe(v2Translations.en?.['/courses/g01/L01']?.title)
  })

  it('chrome strings are in the locale language', () => {
    expect(locales?.en?.themeConfig?.docFooter).toEqual({ prev: 'Previous lecture', next: 'Next lecture' })
  })

  it('VitePress built-in local search is disabled in favour of split WP-F3 search', () => {
    expect(v2Search()).toBeUndefined()
  })

  it('v2LocaleConfig: locales present; no srcExclude while en is enabled', () => {
    const cfg = v2LocaleConfig({ groups, siteMeta })
    expect(cfg.locales).toBeDefined()
    expect(cfg.srcExclude).toBeUndefined()
    expect(typeof cfg.transformPageData).toBe('function')
  })

  it('transformPageData applies the route params of a dynamic group page', () => {
    const cfg = v2LocaleConfig({ groups, siteMeta })
    const pageData = { title: '', description: '', params: { group: 'g02', title: 'G02 · Second', description: 'About it' } }
    cfg.transformPageData?.(pageData as never, {} as never)
    expect(pageData).toMatchObject({ title: 'G02 · Second', description: 'About it' })
    const plain = { title: 'T', description: 'D' }
    cfg.transformPageData?.(plain as never, {} as never)
    expect(plain).toEqual({ title: 'T', description: 'D' })
  })
})

describe('hreflang', () => {
  const pages = new Set(['index.md', 'en/index.md', 'g01/index.md', 'en/g01/index.md', 'g01/L01.md', 'g01/L02.md', 'en/g01/L01.md', 'only/L05.md'])
  const origin = 'https://example.org'
  const hrefOf = (tags: ReturnType<typeof v2Hreflang>) =>
    tags.map((t) => `${(t[1] as Record<string, string>).hreflang}=${(t[1] as Record<string, string>).href}`)

  it('absolute URLs respect cleanUrls and base', () => {
    expect(v2AbsoluteUrl(origin, '/', 'g01/L01.md', true)).toBe('https://example.org/g01/L01')
    expect(v2AbsoluteUrl(origin, '/', 'g01/L01.md', false)).toBe('https://example.org/g01/L01.html')
    expect(v2AbsoluteUrl(origin + '/', '/', 'index.md', true)).toBe('https://example.org/')
    expect(v2AbsoluteUrl(origin, '/', 'en/index.md', true)).toBe('https://example.org/en/')
    expect(v2AbsoluteUrl(origin, '/', 'en/g01/index.md', false)).toBe('https://example.org/en/g01/')
    expect(v2AbsoluteUrl(origin, '/docs/', 'en/g01/L01.md', true)).toBe('https://example.org/docs/en/g01/L01')
    expect(v2AbsoluteUrl(origin, 'docs', 'g01/L01.md', true)).toBe('https://example.org/docs/g01/L01')
  })

  it('both versions list both plus x-default -> root language, identical from either side', () => {
    const want = [
      'zh-CN=https://example.org/g01/L01',
      'en=https://example.org/en/g01/L01',
      'x-default=https://example.org/g01/L01',
    ]
    expect(hrefOf(v2Hreflang('g01/L01.md', pages, origin, '/', true))).toEqual(want)
    expect(hrefOf(v2Hreflang('en/g01/L01.md', pages, origin, '/', true))).toEqual(want)
  })

  it('home and group pages are paired too', () => {
    expect(hrefOf(v2Hreflang('index.md', pages, origin, '/', true))).toEqual([
      'zh-CN=https://example.org/',
      'en=https://example.org/en/',
      'x-default=https://example.org/',
    ])
    expect(hrefOf(v2Hreflang('en/g01/index.md', pages, origin, '/', true))).toContain('zh-CN=https://example.org/g01/')
  })

  it('single-version pages get nothing', () => {
    expect(v2Hreflang('g01/L02.md', pages, origin, '/', true)).toEqual([])
    expect(v2Hreflang('only/L05.md', pages, origin, '/', true)).toEqual([])
  })
})

describe('first-paint reading-mode script', () => {
  const src = (v2ReadingModeHead()[2] as string)

  function classAdded(pathname: string, flag: string | null): boolean {
    let added = false
    const run = new Function(
      'location',
      'localStorage',
      'document',
      src,
    )
    run(
      { pathname },
      { getItem: (k: string) => (k === 'lecture-reading-mode' ? flag : null) },
      { documentElement: { classList: { add: (c: string) => (added = c === 'reading-mode') } } },
    )
    return added
  }

  it('keeps the V1 behaviour for the root site', () => {
    expect(classAdded('/', '1')).toBe(false)
    expect(classAdded('/index.html', '1')).toBe(false)
    expect(classAdded('/g01/L01', '1')).toBe(true)
    expect(classAdded('/g01/', '1')).toBe(true)
    expect(classAdded('/g01/L01', '0')).toBe(false)
    expect(classAdded('/g01/L01', null)).toBe(false)
  })

  it('treats every locale home as home, but not other English pages', () => {
    for (const p of ['/en', '/en/', '/en/index.html']) expect(classAdded(p, '1'), p).toBe(false)
    expect(classAdded('/en/courses/g01/L01', '1')).toBe(true)
    expect(classAdded('/en/g01/', '1')).toBe(true)
    expect(classAdded('/english/', '1')).toBe(true)
  })
})
