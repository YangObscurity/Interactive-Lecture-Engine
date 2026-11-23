/**
 * markdownSanitize.ts — Fail-closed HTML sanitizer helpers for AI companion Markdown output (FE-001 / FE-002).
 */

export interface SanitizeConfig {
  USE_PROFILES?: Record<string, boolean>
  ADD_TAGS?: string[]
  ADD_ATTR?: string[]
  FORBID_TAGS?: string[]
  FORBID_ATTR?: string[]
}

export type DomPurifySanitizeFn = (dirty: string, config?: SanitizeConfig) => string

export interface DomPurifyInstance {
  sanitize: DomPurifySanitizeFn
  addHook?: (
    entryPoint: 'afterSanitizeAttributes' | string,
    hook: (node: Element, data: unknown, config: unknown) => void,
  ) => void
}

export const SANITIZE_CONFIG: Readonly<SanitizeConfig> = Object.freeze({
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: [
    'semantics', 'annotation', 'mstyle', 'mspace', 'mpadded',
    'mphantom', 'mfrac', 'msqrt', 'mroot', 'munder', 'mover',
    'munderover', 'msup', 'msub', 'msubsup', 'mtable', 'mtr',
    'mtd', 'mlabeledtr', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext',
  ],
  // `style` and `display` intentionally excluded (FE-002); `target` controlled exclusively by hook with rel
  ADD_ATTR: [
    'aria-hidden', 'data-tex', 'data-code', 'data-lang', 'rel', 'tabindex',
    'xmlns', 'mathvariant', 'encoding', 'viewBox', 'width', 'height',
    'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'rx', 'ry', 'r', 'cx', 'cy',
  ],
  FORBID_TAGS: [
    'script', 'style', 'iframe', 'object', 'embed', 'form',
    'input', 'textarea', 'select', 'meta', 'link', 'base',
    'img', 'picture', 'source', 'video', 'audio',
  ],
  FORBID_ATTR: [
    'style', 'onerror', 'onload', 'onclick', 'onmouseover', 'onmouseout',
    'onmouseenter', 'onmouseleave', 'onfocus', 'onblur', 'onkeydown', 'onkeyup', 'onsubmit',
  ],
})

const SAFE_LINK_PROTOCOL_RE = /^(?:https?:|mailto:|\/|#)/i
const hookedInstances = new WeakSet<object>()

function isSafeHref(href: string): boolean {
  const trimmed = href.trim()
  if (!trimmed) return false
  // Strip ASCII control characters & spaces when inspecting protocol scheme
  const compact = trimmed.replace(/[\u0000-\u0020]+/g, '')
  if (/^[a-z][a-z0-9+.-]*:/i.test(compact)) {
    return /^(?:https?:|mailto:)/i.test(compact)
  }
  return SAFE_LINK_PROTOCOL_RE.test(trimmed) || !compact.includes(':')
}

function installLinkSecurityHook(inst: DomPurifyInstance): void {
  if (typeof inst.addHook !== 'function') return
  if (hookedInstances.has(inst)) return
  hookedInstances.add(inst)
  inst.addHook('afterSanitizeAttributes', (node: Element) => {
    if (!node || typeof node.tagName !== 'string' || node.tagName.toUpperCase() !== 'A') return
    const href = node.getAttribute('href') || ''
    if (!isSafeHref(href)) {
      node.removeAttribute('href')
      node.removeAttribute('target')
      node.removeAttribute('rel')
      return
    }
    // Always enforce noopener noreferrer on every link; allow target="_blank" only with it
    node.setAttribute('rel', 'noopener noreferrer')
    const rawTarget = node.getAttribute('target')
    if (rawTarget === '_blank' || /^https?:/i.test(href.trim())) {
      node.setAttribute('target', '_blank')
    } else {
      node.removeAttribute('target')
    }
  })
}

export function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function resolveDomPurifyInstance(purifyModule: unknown, win: unknown): DomPurifyInstance | null {
  if (!win) return null
  const mod = purifyModule as
    | (DomPurifyInstance & { default?: ((w: unknown) => DomPurifyInstance) | DomPurifyInstance })
    | ((w: unknown) => DomPurifyInstance)
    | null
    | undefined
  try {
    let inst: DomPurifyInstance | null = null
    if (typeof mod === 'function') {
      const maybe = mod as ((w: unknown) => DomPurifyInstance) & Partial<DomPurifyInstance>
      inst = typeof maybe.sanitize === 'function' ? (maybe as DomPurifyInstance) : maybe(win)
    } else if (mod && typeof mod.sanitize === 'function') {
      inst = mod
    } else if (mod?.default) {
      if (typeof mod.default === 'function') {
        const d = mod.default as ((w: unknown) => DomPurifyInstance) & Partial<DomPurifyInstance>
        inst = typeof d.sanitize === 'function' ? (d as DomPurifyInstance) : d(win)
      } else if (typeof mod.default.sanitize === 'function') {
        inst = mod.default
      }
    }
    if (!inst || typeof inst.sanitize !== 'function') return null
    installLinkSecurityHook(inst)
    return inst
  } catch {
    return null
  }
}

export function resolveDomPurifyFn(purifyModule: unknown, win: unknown): DomPurifySanitizeFn | null {
  const inst = resolveDomPurifyInstance(purifyModule, win)
  if (!inst) return null
  return inst.sanitize
}

/**
 * Fail-closed HTML sanitizer:
 * - Never returns raw HTML during SSR, when DOMPurify is missing, or when sanitization throws.
 * - Falls back to HTML-escaped `<pre class="ai-sanitize-fallback">` text instead.
 */
export function sanitizeHtmlFailClosed(
  rawHtml: string,
  purify: DomPurifySanitizeFn | DomPurifyInstance | null,
): string {
  if (typeof window === 'undefined' || !purify) {
    return `<pre class="ai-sanitize-fallback">${escapeHtml(rawHtml)}</pre>`
  }
  try {
    let fn: DomPurifySanitizeFn
    const maybeInst = purify as DomPurifyInstance
    if (typeof maybeInst.sanitize === 'function') {
      installLinkSecurityHook(maybeInst)
      fn = (d, c) => maybeInst.sanitize(d, c)
    } else if (typeof purify === 'function') {
      fn = purify
    } else {
      return `<pre class="ai-sanitize-fallback">${escapeHtml(rawHtml)}</pre>`
    }
    return fn(rawHtml, {
      USE_PROFILES: { ...(SANITIZE_CONFIG.USE_PROFILES ?? {}) },
      ADD_TAGS: [...(SANITIZE_CONFIG.ADD_TAGS ?? [])],
      ADD_ATTR: [...(SANITIZE_CONFIG.ADD_ATTR ?? [])],
      FORBID_TAGS: [...(SANITIZE_CONFIG.FORBID_TAGS ?? [])],
      FORBID_ATTR: [...(SANITIZE_CONFIG.FORBID_ATTR ?? [])],
    })
  } catch {
    return `<pre class="ai-sanitize-fallback">${escapeHtml(rawHtml)}</pre>`
  }
}
