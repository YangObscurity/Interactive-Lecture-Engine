// @vitest-environment happy-dom
/**
 * AI companion maths (markdownMath.ts): the model's Markdown/HTML is sanitized first with the unchanged
 * model sanitizer (FE-002, no `style`), KaTeX output is put in afterwards and only passes a KaTeX-only
 * pass that keeps its inline layout styles. XSS corpus for both the HTML and the TeX side.
 */
import { describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import { installHappyDomWhatwgShims } from '../setup/happyDomPurify'
import {
  SANITIZE_CONFIG,
  resolveDomPurifyInstance,
  type DomPurifyInstance,
} from '../../docs/.vitepress/theme/components/ai/markdownSanitize'
import {
  KATEX_OPTIONS,
  KATEX_SANITIZE_CONFIG,
  MAX_TEX_LENGTH,
  mathSlot,
  renderKatexHtml,
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

/** Same delimiters and slot calls as MarkdownRenderer.vue's mathBlock / mathInline extensions. */
function makeParser(): (md: string) => string {
  const marked = new Marked({ gfm: true, breaks: true })
  marked.use({
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        start: (src: string) => src.indexOf('$$'),
        tokenizer(src: string) {
          const m = /^\$\$([\s\S]*?)\$\$/.exec(src)
          return m ? { type: 'mathBlock', raw: m[0], text: (m[1] ?? '').trim() } : undefined
        },
        renderer: (t) => `<div class="math-node math-block" data-tex="x">${mathSlot(String(t.text), true)}</div>\n`,
      },
      {
        name: 'mathInline',
        level: 'inline',
        start: (src: string) => src.indexOf('$'),
        tokenizer(src: string) {
          const m = /^\$(?!\s)([^$\n]+?)(?<!\s|\$)\$(?!\d)/.exec(src)
          return m ? { type: 'mathInline', raw: m[0], text: (m[1] ?? '').trim() } : undefined
        },
        renderer: (t) => `<span class="math-node math-inline">${mathSlot(String(t.text), false)}</span>`,
      },
    ],
  })
  return (md) => marked.parse(md) as string
}

const purifier = makePurifier()
const parse = makeParser()

function render(md: string): { html: string; host: HTMLDivElement } {
  const html = renderMarkdownWithMath(md, parse, purifier)
  const host = document.createElement('div')
  host.innerHTML = html
  return { html, host }
}

/** Every attribute in the rendered tree (TeX source shows up as inert text, so check attributes, not text). */
function allAttrs(host: Element): Array<[string, string]> {
  return Array.from(host.querySelectorAll('*')).flatMap((el) =>
    Array.from(el.attributes, (a): [string, string] => [a.name.toLowerCase(), a.value]),
  )
}

describe('AI companion maths: sanitize first, KaTeX after', () => {
  it('keeps the model sanitizer strict (style still forbidden for model content)', () => {
    expect(SANITIZE_CONFIG.FORBID_ATTR).toContain('style')
    expect(SANITIZE_CONFIG.ADD_ATTR).not.toContain('style')
    expect(KATEX_SANITIZE_CONFIG.FORBID_TAGS).toEqual(expect.arrayContaining(['script', 'style', 'img', 'iframe', 'a']))
    expect(KATEX_SANITIZE_CONFIG.FORBID_ATTR).toEqual(expect.arrayContaining(['onerror', 'onload', 'onclick']))
  })

  it('keeps KaTeX layout styles for fractions, radicals and scripts', () => {
    const { host } = render('分式 $\\frac{a}{b}$、上下标 $x_i^2$\n\n$$\\sqrt{x^2+1} = \\dfrac{1}{2}$$')
    expect(host.querySelectorAll('.katex')).toHaveLength(3)
    expect(host.querySelector('.math-inline .katex .mfrac')).not.toBeNull()
    expect(host.querySelector('.math-block .katex-display .sqrt svg path')).not.toBeNull()
    expect(host.querySelector('.msupsub')).not.toBeNull()
    // the inline styles KaTeX needs (vlist heights, struts, svg sizes) survive
    const styled = Array.from(host.querySelectorAll('.katex-html [style]'))
    expect(styled.length).toBeGreaterThan(5)
    expect(styled.some((el) => /height:/.test(el.getAttribute('style') ?? ''))).toBe(true)
    // (MathML is checked in the browser e2e: happy-dom does not put <math> in the MathML namespace)
    expect(host.querySelectorAll('[data-ai-math-slot]')).toHaveLength(0)
  })

  it('still strips style, script, event attributes and img from model HTML next to maths', () => {
    const { html, host } = render(
      '<div style="color:red" onclick="alert(1)">a</div>\n\n$x$\n\n' +
        '<span class="katex" style="position:fixed;inset:0">fake</span>\n\n' +
        '<img src=x onerror="alert(2)"><script>window.__x=1</script><style>*{display:none}</style>\n\n' +
        '<svg onload="alert(3)"><circle r="1"></circle></svg><a href="javascript:alert(4)">j</a>',
    )
    expect(host.querySelector('div:not(.math-node)')?.getAttribute('style') ?? null).toBeNull()
    const fake = Array.from(host.querySelectorAll('span.katex')).find((el) => el.textContent === 'fake')
    expect(fake).toBeDefined()
    expect(fake?.getAttribute('style') ?? null).toBeNull()
    expect(host.querySelectorAll('img, script, style')).toHaveLength(0)
    expect(html).not.toMatch(/onerror|onload|onclick|javascript:|position:fixed/i)
    expect(host.querySelectorAll('.math-inline .katex')).toHaveLength(1)
  })

  it('ignores forged slot placeholders (nonce is per render)', () => {
    const { host } = render('<span data-ai-math-slot="0000000000000000-0"></span> $y$')
    const forged = host.querySelector('[data-ai-math-slot]')
    expect(forged).not.toBeNull()
    expect(forged?.innerHTML).toBe('')
    expect(host.querySelectorAll('.katex')).toHaveLength(1)
  })

  it('runs KaTeX untrusted with bounded sizes and expansion', () => {
    expect(KATEX_OPTIONS.trust).toBe(false)
    expect(KATEX_OPTIONS.maxSize).toBeGreaterThan(0)
    expect(KATEX_OPTIONS.maxSize).toBeLessThanOrEqual(50)
    expect(KATEX_OPTIONS.maxExpand).toBeGreaterThan(0)
    expect(KATEX_OPTIONS.maxExpand).toBeLessThanOrEqual(1000)
    expect(KATEX_OPTIONS.throwOnError).toBe(false)
  })

  it.each([
    ['\\href{javascript:alert(1)}{x}', '\\href'],
    ['\\url{javascript:alert(1)}', '\\url'],
    ['\\htmlClass{evil}{x}', '\\htmlClass'],
    ['\\htmlStyle{position:fixed;inset:0;color:red}{x}', '\\htmlStyle'],
    ['\\htmlId{evil}{x}', '\\htmlId'],
    ['\\htmlData{foo=bar}{x}', '\\htmlData'],
    ['\\includegraphics{https://evil.test/a.png}', '\\includegraphics'],
  ])('renders untrusted %s as inert text, never as a link, class, id, style or image', (tex, command) => {
    const { host } = render(`$${tex}$`)
    // KaTeX shows an unsupported (untrusted) command as its name in errorColor; arguments are dropped
    expect(host.querySelector('.katex-html')?.textContent).toContain(command)
    expect(host.querySelectorAll('a, img, [href], [src]')).toHaveLength(0)
    expect(host.querySelector('.evil, #evil, [data-foo]')).toBeNull()
    for (const [name, value] of allAttrs(host)) {
      expect(name.startsWith('on')).toBe(false)
      expect(value).not.toMatch(/javascript:|position:\s*fixed|color:\s*red|evil/i)
    }
  })

  it('escapes HTML typed inside TeX and rejects CSS smuggled through \\color', () => {
    const { host } = render(
      '$\\text{<img src=x onerror=alert(1)><script>alert(2)</script>}$ ' +
        '$\\color{red;background:url(https://evil.test)}{x}$ $\\textcolor{red\\"onmouseover=alert(3)}{y}$',
    )
    expect(host.querySelectorAll('img, script')).toHaveLength(0)
    // shown as text (KaTeX turns spaces in \text into no-break spaces)
    expect(host.querySelector('.katex-html')?.textContent).toMatch(/<img\ssrc=x\sonerror=alert\(1\)>/)
    expect(host.querySelectorAll('.katex-error')).toHaveLength(2)
    for (const [name, value] of allAttrs(host)) {
      expect(name.startsWith('on')).toBe(false)
      if (name === 'style') expect(value).not.toMatch(/background|url\(/i)
    }
  })

  it('clamps huge sizes and stops macro bombs', () => {
    const { host } = render('$\\rule{100000em}{1em}\\kern{100000em}\\hspace{9999em}$')
    const ems = allAttrs(host)
      .filter(([name]) => name === 'style')
      .flatMap(([, value]) => Array.from(value.matchAll(/(-?\d+(?:\.\d+)?)em/g), (m) => Math.abs(Number(m[1]))))
    expect(ems.length).toBeGreaterThan(0)
    expect(Math.max(...ems)).toBeLessThanOrEqual(KATEX_OPTIONS.maxSize)
    const t0 = Date.now()
    const bomb = renderKatexHtml('\\def\\a{\\a\\a}\\a', false)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(bomb).toContain('katex-error')
    expect(renderKatexHtml('x'.repeat(MAX_TEX_LENGTH + 1), false)).toContain('katex-fallback')
  })

  it('fails closed without a sanitizer and outside a render', () => {
    const html = renderMarkdownWithMath('$\\frac{a}{b}$ <b onclick="x()">b</b>', parse, null)
    expect(html.startsWith('<pre class="ai-sanitize-fallback">')).toBe(true)
    expect(html).not.toContain('class="katex"')
    expect(html).not.toContain('<b')
    expect(mathSlot('<b>x</b>', false)).toBe('<span class="katex-fallback">&lt;b&gt;x&lt;/b&gt;</span>')
  })
})
