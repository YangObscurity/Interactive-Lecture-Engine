/**
 * math.mts — 构建期 KaTeX 渲染
 *
 * 设计取舍：
 *   1. **构建期渲染**（SSR），不引入客户端重型渲染库：
 *      首屏即渲染公式、零闪烁，且与交互组件分工明确。
 *   2. **保留 TeX 源码**：输出标准 HTML+MathML，并把源码注入 `data-tex` 支持点击复制。
 *   3. **分隔符只认三种转义形态**：
 *        行内 `\( … \)`   行间 `\[ … \]`   行间 `$$ … $$`
 *      刻意**不接管裸 `$…$`**：避免散文中的货币符号或协议字段名吞噬排版。
 *   4. ` ```math ` 围栏保持文本语法高亮展示。
 *   5. `throwOnError: false`：构建不中断；公式语法错误由格式审计脚本负责校验拦截。
 */
import katex from 'katex'

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const escAttr = (s: string) => String(s).replace(/[&<>"]/g, (c) => ESC[c as keyof typeof ESC])

function render(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,          // 构建不中断；由格式审计脚本负责报错
    errorColor: '#ef4444',
    strict: false,
    output: 'htmlAndMathml',      // 带 MathML → 可复制、可被读屏
  })
}

/** 行内 `\( … \)` */
function inlineRule(state: any, silent: boolean): boolean {
  const src: string = state.src
  const pos = state.pos
  if (src.charCodeAt(pos) !== 0x5c || src[pos + 1] !== '(') return false
  const end = src.indexOf('\\)', pos + 2)
  if (end < 0 || src.indexOf('\n', pos) >= 0 && src.indexOf('\n', pos) < end) return false
  if (!silent) {
    const token = state.push('math_inline', 'math', 0)
    token.content = src.slice(pos + 2, end)
  }
  state.pos = end + 2
  return true
}

/** 行间 `$$ … $$` 与 `\[ … \]`（支持同行与跨行） */
function blockRule(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const src: string = state.src
  let pos = start
  let close: string
  if (src.startsWith('$$', pos)) { pos += 2; close = '$$' }
  else if (src.startsWith('\\[', pos)) { pos += 2; close = '\\]' }
  else return false

  const lineEnd = state.eMarks[startLine]
  const same = src.indexOf(close, pos)
  if (same >= 0 && same < lineEnd) {
    if (silent) return true
    const token = state.push('math_block', 'math', 0)
    token.block = true
    token.content = src.slice(pos, same)
    token.map = [startLine, startLine + 1]
    state.line = startLine + 1
    return true
  }

  let line = startLine
  let found = -1
  let foundLine = -1
  for (;;) {
    line++
    if (line >= endLine) break
    const s = state.bMarks[line] + state.tShift[line]
    const e = state.eMarks[line]
    const idx = src.indexOf(close, s)
    if (idx >= 0 && idx < e) { found = idx; foundLine = line; break }
  }
  if (silent) return true
  if (found < 0) return false   // 未闭合 → 不吞内容，交还后续规则
  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.map = [startLine, foundLine + 1]
  const first = src.slice(pos, state.eMarks[startLine])
  const mid = []
  for (let i = startLine + 1; i < foundLine; i++) {
    mid.push(src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]))
  }
  token.content = [first, ...mid, src.slice(state.bMarks[foundLine] + state.tShift[foundLine], found)].join('\n')
  state.line = foundLine + 1
  return true
}

export function mathPlugin(md: any) {
  md.inline.ruler.before('escape', 'math_inline', inlineRule)
  md.block.ruler.before('fence', 'math_block', blockRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.renderer.rules.math_inline = (tokens: any[], idx: number) => {
    const raw = tokens[idx].content
    const tex = raw.replace(/\u200b/g, '')
    return `<span class="math-node math-inline" data-tex="${escAttr(tex)}" title="点击复制 LaTeX">${render(tex, false)}</span>`
  }
  md.renderer.rules.math_block = (tokens: any[], idx: number) => {
    const raw = tokens[idx].content
    const tex = raw.replace(/\u200b/g, '')
    return `<div class="math-node math-block" data-tex="${escAttr(tex)}" title="点击复制 LaTeX">${render(tex, true)}</div>\n`
  }
}
