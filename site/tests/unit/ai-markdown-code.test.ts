// @vitest-environment happy-dom
/**
 * AI companion code blocks (markdownMath.ts codeSlot): Shiki's HTML goes in after the model sanitizer, through a
 * code-only pass that keeps only Shiki's colour / font declarations. Before this, FE-002 dropped Shiki's inline
 * styles and companion code blocks had no syntax colours.
 */
import { describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import { createHighlighter } from 'shiki'
import { installHappyDomWhatwgShims } from '../setup/happyDomPurify'
import { SANITIZE_CONFIG, resolveDomPurifyInstance, type DomPurifyInstance } from '../../docs/.vitepress/theme/components/ai/markdownSanitize'
import {
  CODE_SANITIZE_CONFIG,
  codeSlot,
  filterCodeStyles,
  renderMarkdownWithMath,
} from '../../docs/.vitepress/theme/components/ai/markdownMath'

function makePurifier(): DomPurifyInstance {
  const win = new Window()
  installHappyDomWhatwgShims(win)
  const factory = DOMPurify as unknown as (w: Window) => DomPurifyInstance
  const inst = resolveDomPurifyInstance(factory(win), win)
  if (!inst) throw new Error('no DOMPurify')
  return inst
}

const purifier = makePurifier()
const highlighter = await createHighlighter({ themes: ['github-light', 'github-dark'], langs: ['python', 'c'] })

/** Same code renderer shape as MarkdownRenderer.vue: Shiki with both themes as variables, then codeSlot. */
function makeParser(highlight: (code: string, lang: string) => string): (md: string) => string {
  const marked = new Marked({ gfm: true, breaks: true })
  marked.use({
    renderer: {
      code(token: { text?: string; lang?: string }) {
        const text = token.text ?? ''
        return `<div class="ai-code-block"><div class="ai-code-body">${codeSlot(highlight(text, token.lang ?? ''), text)}</div></div>\n`
      },
    },
  })
  return (md) => marked.parse(md) as string
}

const shiki = (code: string, lang: string) => {
  const loaded = highlighter.getLoadedLanguages()
  return highlighter.codeToHtml(code, {
    lang: loaded.includes(lang) ? lang : 'text',
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  })
}

function render(md: string, highlight = shiki): HTMLDivElement {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdownWithMath(md, makeParser(highlight), purifier)
  return host
}

const tokens = (host: Element) => Array.from(host.querySelectorAll('pre.shiki code span.line > span'))

describe('AI companion code blocks: Shiki after sanitizing', () => {
  it('keeps the model sanitizer strict and the code pass narrow', () => {
    expect(SANITIZE_CONFIG.FORBID_ATTR).toContain('style')
    expect(CODE_SANITIZE_CONFIG.FORBID_TAGS).toEqual(expect.arrayContaining(['script', 'style', 'img', 'iframe', 'a', 'svg']))
    expect(CODE_SANITIZE_CONFIG.FORBID_ATTR).toEqual(expect.arrayContaining(['onerror', 'onload', 'onclick']))
  })

  it('keeps light and dark token colours (several distinct colours per theme)', () => {
    const host = render('```python\ndef mean(xs):\n    # average\n    return sum(xs) / len(xs)\n```')
    const spans = tokens(host)
    expect(spans.length).toBeGreaterThan(5)
    const light = new Set(spans.map((s) => s.getAttribute('style')?.match(/--shiki-light:(#[0-9a-f]+)/i)?.[1]))
    const dark = new Set(spans.map((s) => s.getAttribute('style')?.match(/--shiki-dark:(#[0-9a-f]+)/i)?.[1]))
    light.delete(undefined)
    dark.delete(undefined)
    expect(light.size).toBeGreaterThanOrEqual(3)
    expect(dark.size).toBeGreaterThanOrEqual(3)
    expect(host.querySelector('pre.shiki')?.getAttribute('style')).toMatch(/--shiki-dark-bg:#[0-9a-f]+/i)
    expect(host.querySelectorAll('[data-ai-math-slot]')).toHaveLength(0)
  })

  it('code text from the model stays text (HTML in code is escaped by Shiki, not parsed)', () => {
    const host = render('```c\n#include <stdio.h>\n/* <img src=x onerror=alert(1)> <script>x()</script> */\n```')
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('pre.shiki')?.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('a hostile highlighter result is cut down to colour / font declarations', () => {
    const evil = () =>
      '<pre class="shiki" style="position:fixed;inset:0;--shiki-dark-bg:#24292e" onclick="x()"><code>' +
      '<span class="line"><span style="--shiki-light:#D73A49;background:url(javascript:alert(1));--shiki-dark:#F97583">a</span>' +
      '<span style="color:red;--shiki-light:expression(alert(1));font-style:italic">b</span>' +
      '<a href="javascript:alert(1)">c</a><img src=x onerror="alert(1)"><svg onload="alert(1)"></svg></span></code></pre>'
    const host = render('```python\nx\n```', evil)
    const pre = host.querySelector('pre')!
    expect(pre.getAttribute('style')).toBe('--shiki-dark-bg:#24292e')
    expect(pre.getAttribute('onclick')).toBeNull()
    const [a, b] = tokens(host)
    expect(a?.getAttribute('style')).toBe('--shiki-light:#D73A49;--shiki-dark:#F97583')
    expect(b?.getAttribute('style')).toBe('font-style:italic')
    expect(host.querySelector('a, img, svg')).toBeNull()
    expect(host.innerHTML).not.toMatch(/javascript:|expression\(|position:fixed|onerror|onload/i)
  })

  it('the model cannot smuggle styles through the code language or a forged slot', () => {
    const host = render(
      '```python" style="position:fixed\nx = 1\n```\n\n<span data-ai-math-slot="0000000000000000-0" style="color:red">forged</span>',
    )
    expect(Array.from(host.querySelectorAll('[style]')).every((el) => !/position|color:red/.test(el.getAttribute('style') ?? ''))).toBe(true)
    expect(host.textContent).toContain('forged')
  })

  it('filterCodeStyles keeps only hex colours and font keywords', () => {
    expect(filterCodeStyles('<span style="color:#fff;--shiki-dark:#000;width:100px;--shiki-light-font-weight:bold">x</span>'))
      .toBe('<span style="color:#fff;--shiki-dark:#000;--shiki-light-font-weight:bold">x</span>')
    expect(filterCodeStyles('<span style="color:rgb(1,2,3);background-image:url(x)">x</span>')).toBe('<span>x</span>')
  })

  it('fails closed outside a render (no slot table): escaped plain code', () => {
    expect(codeSlot('<pre style="color:red"><code>x</code></pre>', '<b>x</b>')).toBe(
      '<pre class="shiki-fallback"><code>&lt;b&gt;x&lt;/b&gt;</code></pre>',
    )
  })
})
