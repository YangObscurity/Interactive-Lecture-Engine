/**
 * toast.ts — 学习状态切换快速屏幕中央提示（零依赖、SSR 安全、纯工程矢量风格）
 *
 * 契约：
 * 1. 任意位置（屏幕几何正中央上方 18% 处，不遮挡操作焦点）；
 * 2. 自动 1.6s 淡出；多条纵向堆叠，后进在上；
 * 3. 颜色随三态：已完成 = 极光翠绿 / 学习中 = 琥珀暖金 / 未开始 = 中性灰；
 * 4. 零 Emoji：左侧为纯工程矢量状态点（CSS 绘制），文案简洁「EX-L01 · 已完成」；
 * 5. 严格 SSR 守卫：服务端调用直接 noop。
 */

type ToastKind = '已完成' | '学习中' | '未开始'

const KIND_COLOR: Record<ToastKind, string> = {
  已完成: '#10b981',
  学习中: '#f59e0b',
  未开始: '#64748b'
}

let host: HTMLDivElement | null = null

function ensureHost(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null
  if (host && host.isConnected) return host
  host = document.createElement('div')
  host.className = 'ai-toast-host'
  host.setAttribute('aria-live', 'polite')
  document.body.appendChild(host)
  return host
}

/** 学习状态切换提示：showStatusToast('EX-L01', '已完成') */
export function showStatusToast(lectureLabel: string, kind: ToastKind): void {
  const container = ensureHost()
  if (!container) return

  const el = document.createElement('div')
  el.className = 'ai-toast-item'
  el.style.setProperty('--toast-accent', KIND_COLOR[kind] || '#64748b')
  el.innerHTML = `<span class="ai-toast-dot"></span><span class="ai-toast-text"></span>`
  const textEl = el.querySelector('.ai-toast-text')
  if (textEl) {
    textEl.textContent = `${lectureLabel} · ${kind}`
  }
  container.appendChild(el)

  // 进场（轻弹性上浮）
  requestAnimationFrame(() => el.classList.add('is-in'))
  // 1.6s 后退场，2.1s 后移除
  window.setTimeout(() => el.classList.remove('is-in'), 1600)
  window.setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el)
  }, 2100)
}
