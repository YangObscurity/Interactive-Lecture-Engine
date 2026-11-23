/**
 * toast.ts — 学习状态切换快速屏幕中央提示（零依赖、SSR 安全、纯工程矢量风格）
 *
 * 契约：
 * 1. 任意位置（屏幕几何正中央上方 18% 处，不遮挡操作焦点）；
 * 2. 自动 1.6s 淡出；多条纵向堆叠，后进在上；
 * 3. 颜色随三态：已完成 = 极光翠绿 / 学习中 = 琥珀暖金 / 未开始 = 中性灰；
 * 4. 零 Emoji：左侧为纯工程矢量状态点（CSS 绘制），文案简洁「G03-L08 · 已完成」；
 * 5. 严格 SSR 守卫：服务端调用直接 noop。
 */

import { currentLang, translate } from '../../../i18n/index.ts'
import { toLegacyStatus, type ProgressStatus } from '../../progress/types'

const COLOR_BY_STATUS: Record<ProgressStatus, string> = {
  completed: 'var(--lec-done)',
  in_progress: 'var(--lec-warning)',
  not_started: 'var(--lec-text-muted)',
}

const LEGACY_STATUS_LOOKUP: Record<string, ProgressStatus> = {
  [toLegacyStatus('completed')]: 'completed',
  [toLegacyStatus('in_progress')]: 'in_progress',
  [toLegacyStatus('not_started')]: 'not_started',
  completed: 'completed',
  in_progress: 'in_progress',
  not_started: 'not_started',
}

function statusLabelForToast(status: ProgressStatus): string {
  const lang = currentLang()
  if (status === 'completed') return translate(lang, 'ai.lpcStatusCompleted')
  if (status === 'in_progress') return translate(lang, 'ai.lpcStatusInProgress')
  return translate(lang, 'ai.lpcStatusNotStarted')
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

function pushToast(text: string, accent: string): void {
  const container = ensureHost()
  if (!container) return

  const el = document.createElement('div')
  el.className = 'ai-toast-item'
  el.style.setProperty('--toast-accent', accent)
  el.innerHTML = `<span class="ai-toast-dot"></span><span class="ai-toast-text"></span>`
  const textEl = el.querySelector('.ai-toast-text')
  if (textEl) {
    textEl.textContent = text
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

/** 学习状态切换提示 */
export function showStatusToast(lectureLabel: string, kind: string): void {
  const status: ProgressStatus = LEGACY_STATUS_LOOKUP[kind] ?? 'not_started'
  pushToast(`${lectureLabel} · ${statusLabelForToast(status)}`, COLOR_BY_STATUS[status])
}

/** 一般提示（例如写入被后端拒绝）：文案由调用方按当前语言给出，危险色状态点 */
export function showMessageToast(message: string): void {
  pushToast(message, 'var(--lec-danger)')
}
