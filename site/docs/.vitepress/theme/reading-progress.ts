/**
 * reading-progress.ts — 阅读进度记忆
 *
 * 能力：
 *   1. 每讲记录滚动位置（像素 + 百分比），下次进入自动回到上次读到的位置
 *   2. 首页「继续阅读」：列出最近读过的讲次与进度（数据源）
 *
 * ⚠️ 踩过的坑（第一版就是不工作）：
 *   VitePress 在 **SPA 换页时会自己滚回顶部**，这会触发 scroll 事件。
 *   第一版把「任何滚动」都当成「用户接管」，于是刚进入新页面就被判为"用户自己滚了"，
 *   恢复定时器全被取消 —— 从首页点「继续阅读」永远停在顶部。
 *   现在改为**只认真实手势**（wheel / touchstart / keydown / mousedown）才算用户接管。
 *
 * 另一个坑：讲义页高度要等图表异步渲染完才稳定，所以恢复不能只做一次，
 * 要按百分比在若干时间点重试。
 */
import {
  STORAGE_KEYS,
  storageKeysFor,
  readRawWithFallback,
  writeRawWithDualWrite,
  removeRawWithFallback,
} from '../site.config'

/**
 * 阅读进度存储键候选表（新键优先、旧键回退）。
 *
 * ⚠️ 这张表的第一个元素必须永远是 `lecture-read-pos` —— 它是老用户浏览器里
 * 已有的键，改掉就等于把所有人的「继续阅读」进度清零。
 * 需要换命名时只能往 storageKeysFor 的第二个参数追加旧键，绝不能动第一个。
 */
const KEYS = storageKeysFor(STORAGE_KEYS.readingProgress)

const MAX_ENTRIES = 30
/**
 * 讲次页路径判据：`/<任意深度目录>/L<数字>`。
 *
 * ⚠️ 为什么不能用 `^\/([a-z0-9]+)\/(L\d+)$`：
 *   若只接受单级目录（如 `/curriculum/L01`），则无法支持嵌套路径。
 *   引擎明确支持嵌套 `dir`（如 `dir: 'examples/g01'`），实际 URL 形如 `/examples/g01/L01`。
 *   因此目录部分放宽到任意深度（非空、不含空白），讲次仍锚定 `L<数字>`。
 */
const PATH_RE = /^\/(.+?)\/(L\d+)$/i

export type ReadEntry = {
  y: number
  pct: number
  title: string
  group: string
  ts: number
}

type Store = Record<string, ReadEntry>

let timers: number[] = []
let pendingRestore = false
let userTookOver = false
let saveTimer: number | undefined

function readStore(): Store {
  const raw = readRawWithFallback(KEYS)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Store
  } catch {
    return {}
  }
}

function writeStore(s: Store) {
  // 双写：候选表里若含历史键，两份都写，回滚旧版本时进度不丢
  writeRawWithDualWrite(KEYS, JSON.stringify(s))
}

/** 彻底清空进度（含历史键，避免旧键残留被后续读取「复活」） */
function wipeStore() {
  removeRawWithFallback(KEYS)
}

function currentPath(): string | null {
  const p = location.pathname.replace(/\/+$/, '')
  const clean = p.endsWith('.html') ? p.slice(0, -5) : p
  return PATH_RE.test(clean) ? clean : null
}

function pageTitle(): string {
  const h1 = document.querySelector('.vp-doc h1')
  // 去掉 VitePress 标题锚点里的零宽空格（<a class="header-anchor">​</a>）
  const t = (h1?.textContent || document.title || '').replace(/\u200b/g, '').trim()
  return t.replace(/\s*\|\s*.*$/, '')
}

function maxScroll(): number {
  return Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
}

/** 最近读过的讲次（按时间倒序，只保留真正读了一部分的） */
export function recentReads(limit = 6): Array<ReadEntry & { path: string }> {
  const s = readStore()
  return Object.keys(s)
    .map((path) => ({ path, ...s[path] }))
    .filter((e) => e.pct > 0.02 && e.pct < 0.97)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
}

/**
 * 某课程组下「最近在读」的那一讲 —— 供组内页右侧的「继续阅读」按钮使用。
 * dir 传目录名（g01 / g02 …）。没有可恢复的记录时返回 null。
 */
export function groupResume(dir: string): (ReadEntry & { path: string }) | null {
  if (!dir) return null
  const prefix = '/' + dir.toLowerCase() + '/'
  const s = readStore()
  const cands = Object.keys(s)
    .filter((p) => p.toLowerCase().startsWith(prefix) && s[p].pct > 0.02 && s[p].pct < 0.97)
    .map((p) => ({ path: p, ...s[p] }))
    .sort((a, b) => b.ts - a.ts)
  return cands[0] || null
}

export function clearRead(path?: string) {
  if (!path) {
    wipeStore()
    return
  }
  const s = readStore()
  delete s[path]
  writeStore(s)
}

function cancelTimers() {
  timers.forEach((t) => window.clearTimeout(t))
  timers = []
}

function save() {
  const path = currentPath()
  if (!path) return
  // 还没交互、又停在顶部：多半是刚跳进来 / VitePress 滚回顶部的中间态，别覆盖已有记录
  if (!userTookOver && window.scrollY < 40) return
  const s = readStore()
  const y = Math.round(window.scrollY)
  s[path] = {
    y,
    pct: Math.min(1, y / maxScroll()),
    title: s[path]?.title || pageTitle(),
    group: path.split('/')[1] || '',
    ts: Date.now(),
  }
  const keys = Object.keys(s)
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => s[a].ts - s[b].ts)
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete s[k])
  }
  writeStore(s)
}

// 提示条时序：快速淡入 -> 短暂停留 -> 淡出，**全程 < 2s**
// （用户要求整体出现/消失控制在 2 秒以内）
const HINT_FADE = 240    // 与 custom.css 的 transition 时长一致
const HINT_HOLD = 1100   // 停留
const HINT_OUT = 240

function showRestoreHint(pct: number) {
  document.getElementById('lecture-resume-hint')?.remove()
  const el = document.createElement('div')
  el.id = 'lecture-resume-hint'
  el.innerHTML =
    '<span>已回到上次阅读位置 · ' + Math.round(pct * 100) + '%</span>' +
    '<button type="button" data-act="top">回到顶部</button>' +
    '<button type="button" data-act="close" aria-label="关闭">✕</button>'

  let fadeTimer: number | undefined
  let killTimer: number | undefined
  const stop = () => {
    window.clearTimeout(fadeTimer)
    window.clearTimeout(killTimer)
  }
  const dismiss = () => {
    stop()
    el.classList.remove('is-in')                  // 回到基础态 = 淡出
    killTimer = window.setTimeout(() => el.remove(), HINT_OUT + 60)
  }
  const schedule = () => {
    stop()
    fadeTimer = window.setTimeout(dismiss, HINT_HOLD)
  }

  el.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).getAttribute?.('data-act')
    if (act === 'top') {
      userTookOver = true
      pendingRestore = false
      cancelTimers()
      window.scrollTo({ top: 0, behavior: 'smooth' })
      clearRead(currentPath() || undefined)
      dismiss()
    } else if (act === 'close') {
      dismiss()
    }
  })
  // 鼠标停留时暂停自动消失，方便点按钮；移开后再走完剩下的淡出流程
  el.addEventListener('mouseenter', stop)
  el.addEventListener('mouseleave', schedule)

  document.body.appendChild(el)
  window.requestAnimationFrame(() => {
    el.classList.add('is-in')
    schedule()
  })
}

function tryRestore() {
  const path = currentPath()
  if (!path || userTookOver || !pendingRestore) return
  const e = readStore()[path]
  if (!e || e.pct <= 0.03 || e.pct >= 0.97) return
  const target = Math.round(e.pct * maxScroll())
  if (Math.abs(window.scrollY - target) > 40) window.scrollTo(0, target)
}

function bindOnce() {
  if (document.body.dataset.readProgBound === '1') return
  document.body.dataset.readProgBound = '1'

  // 只有**真实手势**才算"用户接管"（VitePress 换页时的程序化滚动不算）
  const gestures: (keyof WindowEventMap)[] = ['wheel', 'touchstart', 'keydown', 'mousedown']
  gestures.forEach((ev) =>
    window.addEventListener(
      ev,
      () => {
        userTookOver = true
        pendingRestore = false
        cancelTimers()
      },
      { passive: true }
    )
  )

  window.addEventListener(
    'scroll',
    () => {
      if (pendingRestore) return // 恢复期间的滚动（含路由切换的滚回顶部）不记录
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(save, 500)
    },
    { passive: true }
  )
  window.addEventListener('beforeunload', save)
}

/** 挂载 / 每次路由切换后调用（幂等） */
export function initReadingProgress() {
  bindOnce()
  cancelTimers()
  pendingRestore = false
  userTookOver = false

  const path = currentPath()
  if (!path) return
  const e = readStore()[path]
  if (!e || e.pct <= 0.03 || e.pct >= 0.97) return

  pendingRestore = true
  showRestoreHint(e.pct)
  // 页面高度随图表渲染变化，按百分比重试
  ;[0, 400, 1200, 2400, 4000].forEach((d, i, arr) => {
    timers.push(
      window.setTimeout(() => {
        tryRestore()
        if (i === arr.length - 1) pendingRestore = false // 恢复窗口结束，之后正常记录
      }, d)
    )
  })
}
