export function initMathCopy() {
  if (typeof window === 'undefined') return
  if (document.body.dataset.mathCopyBound === '1') return
  document.body.dataset.mathCopyBound = '1'

  /** 一次性提示条（不依赖任何 UI 框架） */
  let tip: HTMLDivElement | null = null
  let timer = 0
  const toast = (msg: string) => {
    if (!tip) {
      tip = document.createElement('div')
      tip.className = 'math-copy-toast'
      document.body.appendChild(tip)
    }
    tip.textContent = msg
    tip.classList.add('show')
    window.clearTimeout(timer)
    timer = window.setTimeout(() => tip?.classList.remove('show'), 1400)
  }

  document.body.addEventListener('click', async (e) => {
    const el = (e.target as HTMLElement).closest?.('.math-node') as HTMLElement | null
    if (!el) return
    const tex = (el.dataset.tex || '').trim()
    if (!tex) return
    e.preventDefault()
    try {
      await navigator.clipboard.writeText(tex)
    } catch {
      // 兜底：非安全上下文 / 权限被拒时用临时 textarea
      const ta = document.createElement('textarea')
      ta.value = tex
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(ta)
    }
    el.classList.add('copied')
    window.setTimeout(() => el.classList.remove('copied'), 600)
    toast('已复制 LaTeX 源码')
  })
}
