import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { docIdOf, localeOfPath, searchDocumentsOf, splitPageIntoSections } from '../../docs/.vitepress/access/search'

// The splitter is a copy of VitePress 1.6.4 `splitPageIntoSections`. These tests run the installed VitePress source
// itself next to the copy, so a VitePress upgrade that changes the rule fails here instead of silently changing search.
const VP_DIR = path.resolve(__dirname, '../../node_modules/vitepress/dist/node')

function loadVitePressSplitter(): (html: string) => Iterable<{ anchor: string; titles: string[]; text: string }> {
  const file = fs.readdirSync(VP_DIR).filter((f) => /^chunk-.*\.js$/.test(f)).map((f) => path.join(VP_DIR, f)).find((f) => fs.readFileSync(f, 'utf8').includes('function* splitPageIntoSections'))
  if (!file) throw new Error('splitPageIntoSections not found in the installed VitePress')
  const src = fs.readFileSync(file, 'utf8')
  const start = src.indexOf('const headingRegex')
  const end = src.indexOf('var utils$2', start)
  if (start < 0 || end < 0) throw new Error('VitePress search code moved: update access/search.ts and this test')
  return new Function(`${src.slice(start, end)}\nreturn splitPageIntoSections`)() as ReturnType<typeof loadVitePressSplitter>
}

/** HTML as VitePress renders it: headings with an id and a header-anchor link. */
const h = (level: number, id: string, text: string) => `<h${level} id="${id}" tabindex="-1">${text} <a class="header-anchor" href="#${id}" aria-label="Permalink to &quot;${text}&quot;">&ZeroWidthSpace;</a></h${level}>`

const PAGES: Record<string, string> = {
  'nested headings, inline markup, entities': [
    h(1, 'title', 'Ohm&#39;s <em>law</em>'),
    '<p>Intro paragraph with <code>code</code>.</p>',
    h(2, 'a', 'First'),
    '<p>First body &amp; more.</p>',
    h(3, 'a1', 'First, part one'),
    '<ul><li>one</li><li>two</li></ul>',
    h(3, 'a2', 'First, part two'),
    '<p>deep</p>',
    h(2, 'b', 'Second'),
    '<p>second body</p>',
  ].join('\n'),
  'skipped levels, empty sections, repeated titles': [
    h(2, 'x', 'Only h2'),
    '<p>text under h2</p>',
    h(4, 'y', 'Jumps to h4'),
    '<p>text under h4</p>',
    h(2, 'empty', 'Empty section'),
    h(2, 'x-1', 'Only h2'),
    '<div class="language-c"><pre><code>int main(void) { return 0; }</code></pre></div>',
  ].join('\n'),
  'chinese titles and no heading at all in the second half': [h(1, '第一讲', '第1讲 · 电阻'), '<p>电阻是一个器件。</p>', '<p>no heading here</p>'].join('\n'),
  'no headings': '<p>just a paragraph</p><div>and a div</div>',
  empty: '',
}

describe('splitPageIntoSections matches the installed VitePress', () => {
  const vp = loadVitePressSplitter()
  for (const [name, html] of Object.entries(PAGES)) {
    it(name, () => {
      expect([...splitPageIntoSections(html)]).toEqual([...vp(html)])
    })
  }

  it('gives the sections a reader expects for a nested page', () => {
    const sections = [...splitPageIntoSections(PAGES['nested headings, inline markup, entities'] as string)]
    expect(sections.map((s) => s.titles)).toEqual([["Ohm&#39;s law"], ['Ohm&#39;s law', 'First'], ['Ohm&#39;s law', 'First', 'First, part one'], ['Ohm&#39;s law', 'First', 'First, part two'], ['Ohm&#39;s law', 'Second']])
    expect(sections.map((s) => s.anchor)).toEqual(['title', 'a', 'a1', 'a2', 'b'])
    expect(sections[1]?.text).toBe('\nFirst body &amp; more.\n')
  })
})

describe('real markdown through the VitePress renderer', () => {
  it('the same sections as VitePress for a page rendered by VitePress itself', async () => {
    const { createMarkdownRenderer } = await import('vitepress')
    const md = await createMarkdownRenderer(path.resolve(__dirname, '..'), {}, '/')
    const src = '# Page title\n\nIntro with `code` & <b>html</b>.\n\n## Section one\n\ntext one\n\n### Sub\n\n- a\n- b\n\n## Section two\n\n```c\nint x;\n```\n'
    const html = md.render(src, { path: 'x.md', relativePath: 'x.md', cleanUrls: true })
    expect(html).toContain('header-anchor')
    expect([...splitPageIntoSections(html)]).toEqual([...loadVitePressSplitter()(html)])
    expect([...splitPageIntoSections(html)].map((s) => s.anchor)).toEqual(['page-title', 'section-one', 'sub', 'section-two'])
  }, 60_000)
})

describe('documents and ids', () => {
  it('searchDocumentsOf builds the documents VitePress indexFile adds: id with anchor, title, parent titles, text', () => {
    const docs = searchDocumentsOf('g05/L01.md', PAGES['nested headings, inline markup, entities'] as string)
    expect(docs.map((d) => d.id)).toEqual(['/g05/L01#title', '/g05/L01#a', '/g05/L01#a1', '/g05/L01#a2', '/g05/L01#b'])
    expect(docs[2]).toEqual({ id: '/g05/L01#a1', title: 'First, part one', titles: ["Ohm&#39;s law", 'First'], text: '\nonetwo\n' })
  })

  it('every restricted document of a page is what the same page would have contributed to the built-in index', () => {
    const vp = loadVitePressSplitter()
    const html = PAGES['skipped levels, empty sections, repeated titles'] as string
    const expected: Array<{ id: string; title: string; titles: string[]; text: string }> = []
    for (const s of vp(html)) {
      if (!s || !(s.text || s.titles)) break
      expected.push({ id: s.anchor ? `/p#${s.anchor}` : '/p', text: s.text, title: s.titles.at(-1) as string, titles: s.titles.slice(0, -1) })
    }
    expect(searchDocumentsOf('p.md', html)).toEqual(expected)
  })

  it('docIdOf follows getDocId: index.md -> folder, .md dropped with cleanUrls, .html otherwise, base prefixed', () => {
    expect(docIdOf('g01/L01.md')).toBe('/g01/L01')
    expect(docIdOf('g01/index.md')).toBe('/g01/')
    expect(docIdOf('index.md')).toBe('/')
    expect(docIdOf('en/g01/index.md')).toBe('/en/g01/')
    expect(docIdOf('g01/L01.md', '/', false)).toBe('/g01/L01.html')
    expect(docIdOf('g01/L01.md', '/docs/')).toBe('/docs/g01/L01')
    expect(docIdOf('examples/g01/L01.md')).toBe('/examples/g01/L01')
  })

  it('localeOfPath: the first non-root locale key that prefixes the path, else root', () => {
    expect(localeOfPath('en/g01/L01.md', ['en'])).toBe('en')
    expect(localeOfPath('g01/L01.md', ['en'])).toBe('root')
    expect(localeOfPath('english/L01.md', ['en'])).toBe('root')
    expect(localeOfPath('en/g01/L01.md', [])).toBe('root')
  })
})
