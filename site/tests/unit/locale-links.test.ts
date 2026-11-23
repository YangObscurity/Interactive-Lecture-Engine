/**
 * Cross-locale link rewrite (P2d WP-I2): a real markdown-it instance with the core rule, run the way VitePress
 * does (env.relativePath of the page). Translations present: en/g01/L01 and en/g01/L03.
 */
import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import { localeLinksPlugin, rewriteLocaleHref } from '../../docs/.vitepress/plugins/localeLinks.mts'

const translated = new Set(['/g01/L01', '/g01/L03', '/courses/g01/L01'])
const opts = { localeKeys: ['en'], exists: (key: string, rootPath: string) => key === 'en' && translated.has(rootPath) }

function hrefs(src: string, relativePath: string): string[] {
  const md = new MarkdownIt({ html: true }).use(localeLinksPlugin, opts)
  const html = md.render(src, { relativePath })
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] as string)
}

describe('localeLinksPlugin (markdown-it core rule)', () => {
  it('rewrites a missing translation to the root-language page, keeping the hash', () => {
    expect(hrefs('[next](./L02) [h](./L02.md#sec) [x](L02.html#a)', 'en/g01/L01.md')).toEqual([
      '/g01/L02',
      '/g01/L02#sec',
      '/g01/L02#a',
    ])
  })

  it('handles absolute locale links, parent directories and query strings', () => {
    expect(hrefs('[a](/en/g01/L02) [b](../g02/L05.md) [c](./L02?x=1#h)', 'en/g01/L01.md')).toEqual([
      '/g01/L02',
      '/g02/L05',
      '/g01/L02?x=1#h',
    ])
  })

  it('leaves existing translations alone (relative, absolute, with extension and hash)', () => {
    expect(hrefs('[a](./L03) [b](./L03.md#s) [c](/en/g01/L03.html) [d](./L01)', 'en/g01/L02.md')).toEqual([
      './L03',
      './L03.md#s',
      '/en/g01/L03.html',
      './L01',
    ])
  })

  it('leaves non-lecture, external, anchor and root-explicit links alone', () => {
    expect(
      hrefs('[a](./index.md) [b](https://example.org/L02) [c](#top) [d](/g01/L02) [e](./notes) [f](../../g01/L02) [g](mailto:a@b.c)', 'en/g01/L01.md'),
    ).toEqual(['./index.md', 'https://example.org/L02', '#top', '/g01/L02', './notes', '../../g01/L02', 'mailto:a@b.c'])
  })

  it('never touches root-language pages (even for links that would be rewritten)', () => {
    expect(hrefs('[a](./L02) [b](/g01/L02) [c](/en/g01/L02)', 'g01/L01.md')).toEqual(['./L02', '/g01/L02', '/en/g01/L02'])
  })

  it('works for nested group directories and for pages without relativePath', () => {
    expect(hrefs('[a](./L02)', 'en/courses/g01/L01.md')).toEqual(['/courses/g01/L02'])
    const md = new MarkdownIt().use(localeLinksPlugin, opts)
    expect(md.render('[a](./L02)')).toContain('href="./L02"')
  })

  it('does nothing when no locale is enabled', () => {
    const md = new MarkdownIt().use(localeLinksPlugin, { localeKeys: [], exists: () => false })
    expect(md.render('[a](./L02)', { relativePath: 'en/g01/L01.md' })).toContain('href="./L02"')
  })

  it('rewriteLocaleHref: lecture tail forms', () => {
    const r = (h: string) => rewriteLocaleHref(h, 'en/g01/L01.md', 'en', opts)
    expect(r('./L2')).toBe('/g01/L2')
    expect(r('./l02.MD')).toBe('/g01/l02')
    expect(r('./L02x')).toBeNull()
    expect(r('')).toBeNull()
  })
})
