/**
 * access/search.ts - search documents of restricted pages (docs-dev/ACCESS.md). Pure: no
 * VitePress, no Node imports.
 *
 * VitePress 1.6.4 (MIT, https://github.com/vuejs/vitepress) builds its local-search index in `localSearchPlugin`
 * (dist/node/chunk-*.js): a page is rendered to HTML, `splitPageIntoSections` cuts the HTML at every heading that has
 * an anchor, and each section becomes one MiniSearch document `{ id, text, title, titles }`. Restricted pages must not
 * be in the built-in index (the build hands them to `_render` as an empty string), so the build renders them itself,
 * cuts them with the SAME code and writes the documents to `/_access/<tier>/search/<locale>.json`; the client adds
 * them to the index with `addAll`. `splitPageIntoSections`, `getSearchableText`, `clearHtmlTags` and the document id
 * rule below are copied from VitePress 1.6.4 with the logic unchanged; tests/unit/access-search.test.ts compares them
 * with the installed VitePress source, so an upgrade that changes them fails the test.
 */

const headingRegex = /<h(\d*).*?>(.*?<a.*? href="#.*?".*?>.*?<\/a>)<\/h\1>/gi
const headingContentRegex = /(.*?)<a.*? href="#(.*?)".*?>.*?<\/a>/i

export interface SearchSection {
  anchor: string
  titles: string[]
  text: string
}

function clearHtmlTags(str: string): string {
  return str.replace(/<[^>]*>/g, '')
}

function getSearchableText(content: string): string {
  return clearHtmlTags(content)
}

/** VitePress 1.6.4 `splitPageIntoSections`. */
export function* splitPageIntoSections(html: string): Generator<SearchSection> {
  const result = html.split(headingRegex)
  result.shift()
  let parentTitles: string[] = []
  for (let i = 0; i < result.length; i += 3) {
    const level = parseInt(result[i] as string) - 1
    const heading = result[i + 1] as string
    const headingResult = headingContentRegex.exec(heading)
    const title = clearHtmlTags(headingResult?.[1] ?? '').trim()
    const anchor = headingResult?.[2] ?? ''
    const content = result[i + 2] as string
    if (!title || !content) continue
    let titles = parentTitles.slice(0, level)
    titles[level] = title
    titles = titles.filter(Boolean)
    yield { anchor, titles, text: getSearchableText(content) }
    if (level === 0) {
      parentTitles = [title]
    } else {
      parentTitles[level] = title
    }
  }
}

/** One MiniSearch document as VitePress stores it (`fields: title, titles, text`; `storeFields: title, titles`). */
export interface SearchDocument {
  id: string
  title: string
  titles: string[]
  text: string
}

/**
 * VitePress 1.6.4 `getDocId`: base + the page path, `index.md` -> folder, `.md` dropped (cleanUrls) or `.html`.
 * `relativePath` is relative to srcDir (`g01/L01.md`). Page rewrites are not applied (this site has none).
 */
export function docIdOf(relativePath: string, base = '/', cleanUrls = true): string {
  const joined = `${base.replace(/\/?$/, '/')}${relativePath.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/')
  return joined.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, cleanUrls ? '' : '.html')
}

/** Locale of a page (VitePress `getLocaleForPath`): the first non-root locale key the path starts with, else `root`. */
export function localeOfPath(relativePath: string, localeKeys: readonly string[]): string {
  const p = relativePath.replace(/^\/+/, '')
  return localeKeys.find((k) => p.startsWith(`${k}/`)) ?? 'root'
}

/**
 * The documents of one rendered page, exactly as VitePress `indexFile` would add them to its index. Like VitePress,
 * the first section without text and titles ends the page.
 */
export function searchDocumentsOf(relativePath: string, html: string, base = '/', cleanUrls = true): SearchDocument[] {
  const fileId = docIdOf(relativePath, base, cleanUrls)
  const docs: SearchDocument[] = []
  for (const section of splitPageIntoSections(html)) {
    if (!section || !(section.text || section.titles)) break
    const { anchor, text, titles } = section
    docs.push({ id: anchor ? [fileId, anchor].join('#') : fileId, text, title: titles.at(-1) as string, titles: titles.slice(0, -1) })
  }
  return docs
}
