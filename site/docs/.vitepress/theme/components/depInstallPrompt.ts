/**
 * depInstallPrompt.ts —— 选装依赖（puppeteer）的右下角引导提示条
 *
 * 功能定位：
 *   在本地开发环境下，当检测到未安装可选导出依赖（puppeteer）时，
 *   在右下角提供非阻塞的交互卡片引导，支持一键安装与实时进度反馈。
 *
 * 设计要点：
 *   1. **不是 toast，是可驻留的面板**：安装是分钟级操作，转瞬即逝的 toast
 *      无法承载进度条与操作按钮。故做成右下角**卡片**，带关闭按钮，
 *      完成后自动淡出。
 *   2. **SSE 消费进度**：`POST <api>/dep-install` 是 `text/event-stream`，
 *      逐事件更新百分比与文案。为什么不用轮询：见后端注释。
 *   3. **三态**：idle（未装，给安装按钮）/ running（进度条 + 取消）/ done|error。
 *   4. **失败要看得见**：错误直接显示在后端给的 message 里（含回退结果），
 *      并提供「重试」。
 *   5. **SSR 安全**：服务端调用直接 noop。
 *   6. **只在 dev 有意义**：生产站点没有该 API，探测失败时静默不打扰。
 */

type Phase = 'idle' | 'running' | 'done' | 'error'

let card: HTMLDivElement | null = null
let abortCtl: AbortController | null = null

function isDev(): boolean {
  if (typeof window === 'undefined') return false
  // dev server 的端口不固定（5173/5300/5400...），故按 hostname 判定而非端口
  const h = location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

function apiBase(): string {
  // 与 site.config.mts 的 LECTURE_EXPORT.apiPath 保持一致。
  // 这里硬编码是**有意的**：该提示条只在本地 dev 出现，
  // 且它本身就是「配置层缺失时的兜底引导」——若还要依赖配置，
  // 配置错了就完全没有提示了。
  return '/api/generate-export'
}

function ensureCard(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null
  if (card && card.isConnected) return card
  card = document.createElement('div')
  card.className = 'dep-prompt'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-live', 'polite')
  card.innerHTML = `
    <div class="dep-prompt-head">
      <span class="dep-prompt-title">导出功能可用性</span>
      <button class="dep-prompt-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="dep-prompt-body"></div>
    <div class="dep-prompt-bar" hidden><i></i></div>
    <div class="dep-prompt-actions"></div>
  `
  document.body.appendChild(card)
  card.querySelector('.dep-prompt-close')?.addEventListener('click', () => dismiss())
  return card
}

function setBody(html: string) {
  const el = ensureCard()?.querySelector('.dep-prompt-body')
  if (el) el.innerHTML = html
}

function setActions(buttons: Array<{ label: string; primary?: boolean; onClick: () => void }>) {
  const host = ensureCard()?.querySelector('.dep-prompt-actions')
  if (!host) return
  host.innerHTML = ''
  for (const b of buttons) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'dep-prompt-btn' + (b.primary ? ' is-primary' : '')
    btn.textContent = b.label
    btn.addEventListener('click', b.onClick)
    host.appendChild(btn)
  }
}

function setProgress(pct: number | null, note?: string) {
  const bar = card?.querySelector('.dep-prompt-bar') as HTMLElement | null
  if (!bar) return
  if (pct === null) {
    bar.hidden = true
    return
  }
  bar.hidden = false
  const fill = bar.querySelector('i') as HTMLElement | null
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`
  if (note !== undefined) {
    const tip = bar.querySelector('.dep-prompt-note') as HTMLElement | null
    if (tip) tip.textContent = note
  }
}

function dismiss() {
  abortCtl?.abort()
  abortCtl = null
  if (card?.parentNode) card.parentNode.removeChild(card)
  card = null
}

/** 启动一键安装（消费 SSE 进度）。 */
async function startInstall() {
  setBody('正在安装 <code>puppeteer</code>（约 300MB，含 Chromium）…<br/>只装在 <code>site/</code> 目录下，不影响其它项目。')
  setProgress(0)
  setActions([{ label: '取消安装', onClick: () => cancelInstall() }])

  abortCtl = new AbortController()
  try {
    const res = await fetch(`${apiBase()}/dep-install`, {
      method: 'POST',
      signal: abortCtl.signal,
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      // SSE：事件以空行分隔
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const line = chunk.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        let ev: any
        try {
          ev = JSON.parse(line.slice(5).trim())
        } catch {
          continue
        }
        handleEvent(ev)
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return
    showError(String(e?.message || e))
  }
}

function handleEvent(ev: any) {
  const pct = typeof ev?.pct === 'number' ? ev.pct : null
  if (ev?.message) setBody(String(ev.message))
  setProgress(pct)
  if (ev?.phase === 'done') {
    setProgress(100)
    setActions([])
    // 完成后 3s 自动淡出，不打扰
    window.setTimeout(() => dismiss(), 3000)
  } else if (ev?.phase === 'error') {
    showError(String(ev.message || '安装失败'))
  } else if (ev?.phase === 'rollback') {
    setBody(`${ev.message}<br/><span class="dep-prompt-dim">正在清理残留，回到安装前的干净状态…</span>`)
  }
}

function showError(msg: string) {
  setProgress(null)
  setBody(`<span class="dep-prompt-err">${msg}</span>`)
  setActions([
    { label: '重试安装', primary: true, onClick: () => startInstall() },
    { label: '稍后再说', onClick: () => dismiss() },
  ])
}

async function cancelInstall() {
  try {
    await fetch(`${apiBase()}/dep-cancel`, { method: 'POST' })
  } catch {
    /* 取消失败不阻塞 UI —— 后端会自行收尾 */
  }
  setBody('已请求取消，正在回退清理…')
}

/**
 * 入口：检查选装依赖状态，未装则在右下角给出**可一键安装**的引导。
 * 重复调用安全（卡片已存在时不重复创建）。
 */
export async function checkOptionalDeps(): Promise<void> {
  if (!isDev()) return
  try {
    const res = await fetch(`${apiBase()}/dep-status`)
    if (!res.ok) return
    const st = await res.json()
    if (st?.installed) return // 已装 → 不打扰

    ensureCard()
    setProgress(null)
    setBody(
      `导出功能需要 <code>puppeteer</code>（无头浏览器）。<br/>` +
      `<span class="dep-prompt-dim">${st?.hint || ''}</span>`
    )
    setActions([
      { label: '一键安装到本地', primary: true, onClick: () => startInstall() },
      { label: '暂不需要', onClick: () => dismiss() },
    ])
  } catch {
    /* dev API 不可用时静默 —— 该提示是锦上添花，绝不能影响站点 */
  }
}
