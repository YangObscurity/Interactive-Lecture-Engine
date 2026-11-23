/**
 * plugins/conceptLinkPlugin.mts - markdown-it plugin for `[text](concept:slug)` links & concept H1 layout.
 *
 * Behavior (§5.2):
 *   - Uses markdown-it's native inline link tokens so links inside Markdown tables, *emphasis*, **bold**,
 *     and mixed inline markup work cleanly without splitting table pipes (`|`).
 *   - Code blocks & inline code never emit `link_open` tokens, so backticked examples stay untouched.
 *   - Rewrites `<a href="concept:slug">` into `<a class="lec-term" data-concept="slug" href="/concepts/slug">`
 *     (or `/_access/<tier>/concepts/slug` for restricted concepts during production build).
 *   - Build guard: throws when a lecture cites an unknown/unpublished `slug`, OR when a lecture in tier X
 *     cites a concept whose tier readers of X cannot access.
 *   - On concept pages themselves (`concepts/*.md` / `_access/<tier>/concepts/*.md`), removes the leading H1
 *     heading tokens so `ConceptHeaderBar.vue` owns the single semantic `<h1>` title.
 */
import { TIER_PUBLIC, type AccessPlan } from '../access/tiers.ts'
import { canReaderTierReadConcept, conceptDraftPreviewUrl, conceptPageUrl } from '../concepts/access.ts'

export interface ConceptTokenLike {
  type: string
  tag: string
  content?: string
  children?: ConceptTokenLike[] | null
  attrGet(name: string): string | number | null
  attrSet(name: string, value: string): void
}

export interface ConceptStateCoreLike {
  tokens: ConceptTokenLike[]
  env?: unknown
}

export interface ConceptMarkdownItLike {
  core: {
    ruler: {
      after(afterName: string, ruleName: string, rule: (state: ConceptStateCoreLike) => void): void
    }
  }
}

export interface ConceptLinkTarget {
  slug: string
  tier: string
  isDraft: boolean
  /** Published, but left out of this (partial) build by LECTURE_BUILD_GROUPS: the link becomes plain text. */
  filteredOut?: boolean
}

export interface ConceptLinkPluginOptions {
  isBuild: boolean
  accessPlan: AccessPlan
  resolveConcept: (slug: string, relPath: string) => ConceptLinkTarget | null
  tierOfPage: (relPath: string) => string
  isConceptPagePath?: (relPath: string) => boolean
}

function addClass(token: ConceptTokenLike, cls: string): void {
  const existing = String(token.attrGet('class') ?? '')
  const parts = existing.split(/\s+/).filter(Boolean)
  if (!parts.includes(cls)) parts.push(cls)
  token.attrSet('class', parts.join(' '))
}

function defaultIsConceptPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/')
  return /(?:^|\/)concepts\/[^/]+\.md$/.test(norm) || /(?:^|\/)concepts\/_drafts\/[^/]+\.md$/.test(norm)
}

function stripLeadingConceptH1(tokens: ConceptTokenLike[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (!tok) continue
    if (tok.type === 'heading_open' && tok.tag === 'h1') {
      let closeIdx = i + 1
      while (closeIdx < tokens.length && tokens[closeIdx]?.type !== 'heading_close') {
        closeIdx++
      }
      const removeCount = closeIdx < tokens.length ? closeIdx - i + 1 : 1
      tokens.splice(i, removeCount)
      return
    }
    if (tok.type.startsWith('paragraph_open') || tok.type.startsWith('heading_open')) {
      return
    }
  }
}

export function conceptLinkPlugin(md: ConceptMarkdownItLike, opts: ConceptLinkPluginOptions): void {
  const isConceptPath = opts.isConceptPagePath ?? defaultIsConceptPath

  md.core.ruler.after('inline', 'lec-concept-links', (state: ConceptStateCoreLike) => {
    const env = (state.env ?? {}) as { relativePath?: string; path?: string }
    const relPath = (env.relativePath ?? env.path ?? '').replace(/\\/g, '/')

    if (relPath && isConceptPath(relPath)) {
      stripLeadingConceptH1(state.tokens)
    }

    for (const blockToken of state.tokens) {
      if (blockToken.type !== 'inline' || !blockToken.children) continue
      const children = blockToken.children
      for (let ci = 0; ci < children.length; ci++) {
        const child = children[ci] as ConceptTokenLike
        if (child.type !== 'link_open') continue
        const rawHref = String(child.attrGet('href') ?? '')
        if (!rawHref.startsWith('concept:')) continue

        const rest = rawHref.slice('concept:'.length)
        const hashIdx = rest.indexOf('#')
        const slug = (hashIdx >= 0 ? rest.slice(0, hashIdx) : rest).trim()
        const fragment = hashIdx >= 0 ? rest.slice(hashIdx) : ''
        if (!slug) continue

        const target = opts.resolveConcept(slug, relPath)
        if (target?.filteredOut) {
          // exists and is published, but not part of this partial build: plain text, not a failure
          for (let cj = ci + 1; cj < children.length; cj++) {
            if (children[cj]?.type === 'link_close') {
              const close = children[cj] as ConceptTokenLike
              child.tag = 'span'
              close.tag = 'span'
              ;(child as unknown as { attrs: unknown }).attrs = null
              break
            }
          }
          addClass(child, 'lec-term-filtered')
          console.warn(`[concepts] WARN: "concept:${slug}" in "${relPath || '<unknown>'}" points to a concept left out of this partial build; rendered as plain text`)
          continue
        }
        const lectureTier = relPath ? opts.tierOfPage(relPath) : opts.accessPlan.inlineTier || TIER_PUBLIC

        if (!target || (opts.isBuild && target.isDraft)) {
          if (opts.isBuild) {
            throw new Error(
              `[concepts] Unknown or unpublished concept link "concept:${slug}" in "${relPath || '<unknown>'}"`,
            )
          }
          addClass(child, 'lec-term')
          addClass(child, 'is-missing')
          child.attrSet('data-concept', slug)
          child.attrSet('data-concept-missing', '1')
          child.attrSet('href', `${conceptDraftPreviewUrl(slug)}${fragment}`)
          continue
        }

        if (opts.isBuild && !isConceptPath(relPath) && !canReaderTierReadConcept(lectureTier, target.tier)) {
          throw new Error(
            `[concepts] Access mismatch in "${relPath}": tier "${lectureTier}" cannot reference concept "${slug}" (tier "${target.tier}")`,
          )
        }

        const resolvedHref = target.isDraft
          ? `${conceptDraftPreviewUrl(slug)}${fragment}`
          : `${conceptPageUrl(slug, target.tier, opts.accessPlan.inlineTier, !opts.isBuild)}${fragment}`

        addClass(child, 'lec-term')
        child.attrSet('data-concept', slug)
        child.attrSet('href', resolvedHref)
      }
    }
  })
}
