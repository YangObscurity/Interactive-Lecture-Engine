/**
 * reading/codeHeader.ts — Spec Board §09 persistent code block header bar.
 *
 * Replaces VitePress's hover-only floating copy button with a persistent header:
 * - Language identifier on the left;
 * - Accessible copy button on the right with visible label ("复制" / "Copy");
 * - Copy feedback ("已复制" / "Copied" or "复制失败" / "Copy failed") for ~1500 ms;
 * - Delegated click handler on document.body (AppFeature) so it never double-binds
 *   across SPA route transitions;
 * - PageFeature mounts headers on initial visit and each SPA navigation.
 */
import type { AppFeature, PageContext, PageFeature } from '../core/types'
import { currentLang, translate } from '../../i18n/index.ts'

const FEEDBACK_MS = 1500
const timers = new WeakMap<HTMLElement, number>()

/**
 * Copies plain text to the clipboard with fallback for non-secure contexts
 * or headless browsers without clipboard permissions.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fallback below
  }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.contain = 'strict'
    el.style.position = 'absolute'
    el.style.left = '-9999px'
    el.style.fontSize = '12pt'
    const selection = document.getSelection()
    const originalRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    document.body.appendChild(el)
    el.select()
    el.selectionStart = 0
    el.selectionEnd = text.length
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    if (originalRange && selection) {
      selection.removeAllRanges()
      selection.addRange(originalRange)
    }
    return Boolean(ok)
  } catch {
    return false
  }
}

/**
 * Extracts plain text from the code block, ignoring diff markers and VitePress ignore spans,
 * and stripping leading '$ ' / '> ' prompts for shell commands.
 */
export function extractCodeText(block: HTMLElement): string {
  const pre = block.querySelector('pre')
  if (!pre) return ''
  const isShell = /language-(shellscript|shell|bash|sh|zsh)/.test(block.className)
  const ignoredNodes = ['.vp-copy-ignore', '.diff.remove']
  const clone = pre.cloneNode(true) as HTMLElement
  clone.querySelectorAll(ignoredNodes.join(',')).forEach((node) => node.remove())
  let text = clone.textContent || ''
  if (isShell) {
    text = text.replace(/^ *(\$|>) /gm, '')
  }
  return text
}

/**
 * Extracts the language identifier from VitePress's .lang element or class name.
 */
export function extractLanguage(block: HTMLElement): string {
  const langEl = block.querySelector(':scope > span.lang, span.lang')
  const langText = (langEl?.textContent || '').trim()
  if (langText) return langText
  const m = block.className.match(/\blanguage-([a-zA-Z0-9_+-]+)/)
  return m?.[1] || 'text'
}

/**
 * Mounts or refreshes the .code-head on a single code block.
 */
export function mountCodeHead(block: HTMLElement): void {
  // Skip hidden mermaid blocks (rendered as charts) or blocks inside charts
  if (block.closest('.chart-code') || block.closest('figure.chart')) return
  if (block.style.display === 'none' || block.dataset.mermaidRendered === '1') return
  const prev = block.previousElementSibling
  if (prev && (prev.classList.contains('inline-mermaid') || prev.matches('figure.chart[data-type="mermaid"]'))) {
    return
  }

  const lang = currentLang()
  const copyLabel = translate(lang, 'code.copy')

  let head = block.querySelector(':scope > .code-head') as HTMLElement | null
  if (head) {
    // Already has header: refresh button text & aria-label for current locale if not in feedback state
    const langName = extractLanguage(block)
    const btn = head.querySelector('button[data-copy]') as HTMLElement | null
    if (btn && !btn.classList.contains('copied') && !btn.classList.contains('copy-failed')) {
      btn.textContent = copyLabel
      btn.setAttribute('aria-label', `${copyLabel} (${langName})`)
    }
    return
  }

  const langName = extractLanguage(block)

  head = document.createElement('div')
  head.className = 'code-head'

  const langSpan = document.createElement('span')
  langSpan.className = 'code-lang'
  langSpan.textContent = langName

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.setAttribute('data-copy', '')
  btn.setAttribute('aria-label', `${copyLabel} (${langName})`)
  btn.textContent = copyLabel

  head.appendChild(langSpan)
  head.appendChild(btn)
  block.prepend(head)
}

/**
 * Scans the container for code blocks and installs persistent headers.
 */
export function installCodeHeaders(root: ParentNode = document): void {
  const blocks = root.querySelectorAll<HTMLElement>('.vp-doc div[class*="language-"], .vp-doc .code')
  for (const block of Array.from(blocks)) {
    mountCodeHead(block)
  }
}

/**
 * PageFeature: runs on every page visit / SPA navigation.
 */
export const codeHeaderFeature: PageFeature = {
  id: 'code-header',
  mount(_ctx: PageContext) {
    if (typeof document === 'undefined') return
    const root = (document.querySelector('.vp-doc') as HTMLElement | null) ?? document.body
    installCodeHeaders(root)
  },
}

/**
 * AppFeature: installed once for the application lifetime. Delegated click handler on document.body
 * ensures copy behavior never double-binds across SPA route transitions.
 */
export const codeCopyFeature: AppFeature = {
  id: 'code-copy',
  install(signal: AbortSignal) {
    if (typeof document === 'undefined') return

    document.body.addEventListener(
      'click',
      async (e) => {
        const target = e.target as HTMLElement | null
        const btn = target?.closest?.('.code-head button[data-copy], .code-head button') as HTMLButtonElement | null
        if (!btn) return

        const block = btn.closest('.code, div[class*="language-"]') as HTMLElement | null
        if (!block) return

        e.preventDefault()
        const text = extractCodeText(block)
        const lang = currentLang()
        const success = await copyToClipboard(text)

        const activeTimer = timers.get(btn)
        if (activeTimer) {
          window.clearTimeout(activeTimer)
        }

        if (success) {
          btn.textContent = translate(lang, 'code.copied')
          btn.classList.add('copied')
          btn.classList.remove('copy-failed')
        } else {
          btn.textContent = translate(lang, 'code.copyFailed')
          btn.classList.add('copy-failed')
          btn.classList.remove('copied')
        }

        const tid = window.setTimeout(() => {
          btn.textContent = translate(currentLang(), 'code.copy')
          btn.classList.remove('copied', 'copy-failed')
          timers.delete(btn)
        }, FEEDBACK_MS)

        timers.set(btn, tid)
      },
      { signal }
    )
  },
}
