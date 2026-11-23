/**
 * plugins/localeLinks.mts - markdown-it core rule that keeps links in translated pages alive (P2d, plan 3.4).
 *
 * A translator writes `[next](./L02)` as in the root-language file. When `docs/<key>/<dir>/L02.md` does not
 * exist yet, the link is rewritten to the root-language lecture (`/<dir>/L02`), hash and query kept, so
 * readers land on the original page and the dead-link check sees a real page. Rules:
 *   - only pages under `<key>/` are touched; root-language pages never are;
 *   - only lecture links (last segment `L<digits>`, with or without `.md` / `.html`, relative or absolute);
 *   - a link whose translation exists is left alone; external links, anchors and other links are left alone;
 *   - an explicit link to the root language (`/g01/L02` from an English page) is left alone.
 *
 * It is a CORE rule (works on tokens after inline parsing), not a render rule: VitePress's own `link_open`
 * render rule, which normalises hrefs and collects dead-link candidates, runs later and sees the new href.
 */
import { posix } from 'node:path'

/**
 * The few markdown-it members used here. VitePress bundles its own markdown-it types, which differ from
 * `@types/markdown-it`, so a structural type keeps the plugin usable with both (see math.mts, same reason).
 */
interface LinkToken {
  type: string
  children?: LinkToken[] | null
  attrGet(name: string): string | number | null
  attrSet(name: string, value: string): void
}
interface CoreState {
  env: unknown
  tokens: LinkToken[]
}
export interface MarkdownItLike {
  core: { ruler: { push(name: string, rule: (state: CoreState) => void): void } }
}

export interface LocaleLinksOptions {
  /** Non-root locale keys, e.g. `['en']`. */
  localeKeys: readonly string[]
  /** Does the translation of the root lecture path (`/g01/L03`) exist in this locale? */
  exists: (localeKey: string, rootPath: string) => boolean
}

const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
const LECTURE_TAIL_RE = /(?:^|\/)L\d+(?:\.md|\.html)?$/i

/** Locale key of a page (`en/g01/L01.md` -> `en`), or null for a root-language page. */
function pageLocale(relativePath: string, localeKeys: readonly string[]): string | null {
  const head = relativePath.replace(/\\/g, '/').split('/')[0]
  return localeKeys.find((k) => k === head) ?? null
}

/**
 * New href for `href` found on a page of locale `key` at `relativePath`, or null to leave it alone.
 * Exported for tests.
 */
export function rewriteLocaleHref(href: string, relativePath: string, key: string, opts: LocaleLinksOptions): string | null {
  if (!href || href.startsWith('#') || EXTERNAL_RE.test(href)) return null
  const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(href)
  const pathPart = m?.[1] ?? ''
  if (!pathPart || !LECTURE_TAIL_RE.test(pathPart)) return null

  const pageDir = posix.dirname('/' + relativePath.replace(/\\/g, '/'))
  const resolved = posix.normalize(pathPart.startsWith('/') ? pathPart : posix.join(pageDir, pathPart))
  const prefix = `/${key}/`
  // an absolute link to the root language, or a relative one that climbs out of the locale folder, is deliberate
  if (!resolved.startsWith(prefix)) return null
  const rootPath = '/' + resolved.slice(prefix.length).replace(/\.(?:md|html)$/i, '')
  if (opts.exists(key, rootPath)) return null
  return rootPath + (m?.[2] ?? '') + (m?.[3] ?? '')
}

export function localeLinksPlugin(md: MarkdownItLike, opts: LocaleLinksOptions): void {
  if (!opts.localeKeys.length) return
  md.core.ruler.push('locale_links', (state: CoreState) => {
    const env = state.env as { relativePath?: string } | undefined
    const relativePath = env?.relativePath
    if (!relativePath) return
    const key = pageLocale(relativePath, opts.localeKeys)
    if (key === null) return
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue
      for (const tok of block.children) {
        if (tok.type !== 'link_open') continue
        const href = tok.attrGet('href')
        if (typeof href !== 'string') continue
        const next = rewriteLocaleHref(href, relativePath, key, opts)
        if (next !== null) tok.attrSet('href', next)
      }
    }
  })
}
