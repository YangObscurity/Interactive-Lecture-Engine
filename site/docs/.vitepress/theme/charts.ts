/**
 * charts.ts — 讲义图表运行时（移植自 tools/lecture-pdf/scripts/interactive.js）
 * mermaid: 滚轮缩放 / 拖动 / 双击复位
 * echarts: 原生 tooltip / 图例开关 / 工具箱 + 自适应
 * wavedrom: 渲染 + 缩放拖动
 * 图表源码从 sidecar JSON(/charts/<lecture>.json) 懒加载，按页按需引入三库。
 */
type ChartDef = { type: string; code: string }

// 字体栈 / 标签文案 / 工具条定义 / 图表数据目录 全部来自 site.config.mts：
// 这些是会因部署与受众而变的展示层配置，不该埋在运行时逻辑里
import {
  CHART_FONT,
  CHART_TAG_LABELS,
  CHART_TOOLS_BY_TYPE,
  CHART_TOOL_DEFS,
  CHART_MERMAID_THEMES,
  CHART_ECHARTS_GRID,
  CHART_INLINE_MERMAID,
  DATA_FILES,
} from '../site.config'

const FONT = CHART_FONT
const cache = new Map<string, Record<string, ChartDef>>()
let zoomSeq = 0

/* ================= 单一来源：标签文案与工具条 =================
   改 site.config.mts 的 CHART_TAG_LABELS / CHART_TOOLS_BY_TYPE → 20 讲 63 张图全部同步生效。
   讲义 md 里只保留 <figure class="chart" data-lecture data-id data-type></figure>，
   body / 标签 / 工具条 / 源码折叠全部由 ensureSkeleton + injectSource 运行时产出。 */
const TAG_LABEL: Record<string, string> = CHART_TAG_LABELS
/* 内联视图**不提供任何缩放/拖动**（滚轮或拖动会打断阅读、且极易误触）；
   缩放能力全部收进全屏层（openChartModal）。全屏层里 echarts 改容器尺寸重绘、
   矢量图改 SVG 实际尺寸，都保持锐利。 */
const TOOLS_BY_TYPE: Record<string, string[]> = CHART_TOOLS_BY_TYPE
const TOOL_DEFS: Record<string, [string, string, string]> = CHART_TOOL_DEFS

type FigState = {
  api: ZoomApi | null
  extra?: { resize?: () => void; chart?: any; body?: HTMLElement }
}
const figStates = new WeakMap<HTMLElement, FigState>()

/** 运行时生成 figure 骨架：.chart-body + 标签 + 工具条。幂等，可被 onUpdated 反复调用。 */
function ensureSkeleton(fig: HTMLElement) {
  const type = fig.dataset.type || ''
  if (!fig.id && fig.dataset.lecture && fig.dataset.id) {
    fig.id = 'fig-' + fig.dataset.lecture + '-' + fig.dataset.id
  }
  let body = fig.querySelector('.chart-body') as HTMLElement | null
  if (!body) {
    body = document.createElement('div')
    body.className = 'chart-body'
    fig.insertBefore(body, fig.firstChild)
  }
  // 标签 + 工具条每次重建：任何文案/按钮改动立即对所有讲义生效
  const cap = document.createElement('figcaption')
  cap.className = 'chart-cap'
  const tag = document.createElement('span')
  tag.className = 'chart-tag t-' + type
  tag.textContent = TAG_LABEL[type] || type
  const tools = document.createElement('span')
  tools.className = 'chart-tools'
  tools.innerHTML = (TOOLS_BY_TYPE[type] || TOOLS_BY_TYPE.mermaid)
    .map((k) => {
      const d = TOOL_DEFS[k]
      return (
        '<button type="button" data-act="' + d[0] + '" title="' + d[1] +
        '" aria-label="' + d[1] + '">' + d[2] + '</button>'
      )
    })
    .join('')
  cap.appendChild(tag)
  cap.appendChild(tools)
  const old = fig.querySelector('figcaption.chart-cap')
  if (old) fig.replaceChild(cap, old)
  else fig.appendChild(cap)
}

async function loadCharts(lecture: string): Promise<Record<string, ChartDef> | null> {
  if (cache.has(lecture)) return cache.get(lecture)!
  const url = `${DATA_FILES.chartsDir}/${lecture}.json`
  try {
    let res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) {
      const fallbackUrl = `/examples/public/charts/${lecture}.json`
      const resFallback = await fetch(fallbackUrl, { credentials: 'same-origin' }).catch(() => null)
      if (resFallback && resFallback.ok) res = resFallback
    }
    if (!res.ok) {
      console.error('[chart] fetch non-200:', url, res.status)
      return null
    }
    const data = (await res.json()) as Record<string, ChartDef>
    cache.set(lecture, data)
    return data
  } catch (e) {
    console.error('[chart] fetch threw:', url, e)
    return null
  }
}

/* 内联不再有滚轮缩放 / 拖动 / 双击复位 —— 这些交互只允许出现在全屏层里。
   （此前内联用 makeZoomable 绑过 wheel/drag/dblclick，已移除。） */

type ZoomApi = {
  zoom: (f: number) => void
  reset: () => void
  /** 直接设到指定倍率 —— 矢量图用它实现"打开即自适应" */
  zoomTo?: (scale: number) => void
}

/** 内联视图里，单击图表本体是否应进全屏。
 *  echarts：彻底禁用本体点击放大交互，把点击完全交给 echarts 原生交互；其余类型保持 true。 */
function enlargeOnBodyClick(fig: HTMLElement, _e: MouseEvent): boolean {
  if (fig.dataset.type === 'echarts') return false
  return true
}

function attachTools(
  fig: HTMLElement,
  api: ZoomApi | null,
  extra?: { resize?: () => void; chart?: any; body?: HTMLElement }
) {
  figStates.set(fig, { api, extra })
  // 事件委托到 figure 本身：工具条会被 ensureSkeleton 重建，绑在按钮上会失效
  if (fig.dataset.toolsBound) return
  fig.dataset.toolsBound = '1'
  fig.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const hit = t.closest?.('[data-act]') as HTMLElement | null
    if (hit && fig.contains(hit)) {
      const act = hit.getAttribute('data-act')
      const st = figStates.get(fig)
      if (act === 'expand' || act === 'big') openChartModal(fig)
      else if (act === 'src') {
        const d = fig.querySelector('details.chart-code') as HTMLDetailsElement | null
        if (d) d.open = !d.open
      } else if (act === 'resize') st?.extra?.resize?.()
      return
    }
    /* 内联视图唯一允许的交互：单击图表本体 -> 进全屏。
       标签 / 工具条 / 源码折叠（details）都不触发。 */
    const body = fig.querySelector('.chart-body')
    if (!body || !t || !body.contains(t)) return
    if (!enlargeOnBodyClick(fig, e)) return
    openChartModal(fig)
  })
}

/** 把源码塞进可折叠的 details，便于对照阅读 */
function injectSource(fig: HTMLElement, code: string) {
  if (fig.querySelector('details.chart-code')) return
  const d = document.createElement('details')
  d.className = 'chart-code'
  const s = document.createElement('summary')
  s.textContent = '图表源码'
  const pre = document.createElement('pre')
  const el = document.createElement('code')
  el.textContent = code
  pre.appendChild(el)
  d.appendChild(s)
  d.appendChild(pre)
  fig.appendChild(d)
}

function showError(body: HTMLElement, msg: string) {
  body.innerHTML = ''
  const div = document.createElement('div')
  div.className = 'chart-error'
  div.textContent = msg
  body.appendChild(div)
}

/* ---------------- 三类渲染器 ---------------- */

/**
 * 规整 Mermaid 源码中的常见语法兼容性瑕疵 —— 即「语法自愈」。
 *
 * 为什么需要它：讲义作者写的是**散文里的图**，不是严格的 mermaid 程序。
 * 任何一处语法瑕疵，mermaid 的默认行为都是抛 lexer/parser 异常，
 * 结果是整张图变成一个红框错误（俗称"红屏"），读者什么也看不到。
 * 下面三类是实测最高频的瑕疵，全部可在**不改作者原意**的前提下自动修复：
 *
 *   1. flowchart 边线标签含括号/等号（如 `-->|文字 (注)|`）——
 *      mermaid 会把 `(` 当成节点形状声明，误判为非法语法。
 *      修法：给标签补上双引号。**只在标签真含特殊字符时才动它**，
 *      避免给本来正常的标签套引号（那会改变渲染出的文字）。
 *   2. stateDiagram-v2 里的 `classDef default` ——
 *      该语法在状态图分支不被支持，直接抛错。修法：剔除该行。
 *   3. sequenceDiagram 报文里的分号 `;` ——
 *      `;` 在 mermaid 里是**语句分隔符**，会从中间截断报文；
 *      `#` 则是实体转义起始符，`#xx` 会被当转义序列解析失败。
 *      修法：分号替换为全角「，」（语义等价、视觉自然），剔除 `#xx`。
 *
 * 设计原则：**只做加法与最小改写，绝不重排结构**。自愈失败的图仍会
 * 走原有的 try/catch 报错路径，不会因为自愈而静默画错。
 */
function normalizeMermaidCode(code: string): string {
  if (!code) return code
  let lines = code.split('\n')
  // 先判定图的种类：三类瑕疵的修法互斥，必须按图类型分别处理
  const isStateDiagram = lines.some((l) => /^\s*stateDiagram/i.test(l))
  const isSequenceDiagram = lines.some((l) => /^\s*sequenceDiagram/i.test(l))

  // 瑕疵 2：状态图不认识 classDef default，整行剔除
  if (isStateDiagram) {
    lines = lines.filter((l) => !/^\s*classDef\s+default\s+/i.test(l))
  }

  const result = lines.map((line) => {
    // 瑕疵 3：时序图的报文行 —— 只改「冒号之后」的报文正文，绝不碰参与者名
    if (isSequenceDiagram) {
      const match = line.match(
        /^(\s*[\w\u4e00-\u9fa5]+(?:\s*-->>|\s*->>|\s*->|\s*-->)\s*[\w\u4e00-\u9fa5]+:\s*)(.+)$/
      )
      if (match) {
        const prefix = match[1]
        let msg = match[2].trim()
        // 分号会截断语句：换成全角逗号，语义不变且不会触发解析器
        if (msg.includes(';') && !msg.startsWith('"')) {
          msg = msg.replace(/;/g, '，')
        }
        // `#xx` 会被当作 HTML 实体转义起始符而报错，直接剔除
        msg = msg.replace(/#xx/g, '')
        return prefix + msg
      }
      return line
    }

    // 瑕疵 1：边线标签补引号 —— 仅当标签含 () 或 == 且尚未加引号时
    return line.replace(
      /([=-]>|<==>|==>|-\.->)\s*\|([^"|\n]+?)\|\s*([A-Za-z0-9_\[])/g,
      (m, arrow, label, target) => {
        const trimmed = label.trim()
        if (
          (trimmed.includes('(') || trimmed.includes(')') || trimmed.includes('==')) &&
          !trimmed.startsWith('"')
        ) {
          return `${arrow}|"${trimmed}"|${target}`
        }
        return m
      }
    )
  })

  return result.join('\n')
}

/**
 * 已渲染 mermaid 图的「原始源码」登记表 —— 暗色重绘的唯一依据。
 *
 * 为什么存**原始**源码而不是 normalize 之后的：重绘必须与首次渲染
 * 走完全相同的入口（renderMermaid 内部再 normalize 一次），
 * 否则反复切换主题会导致源码被 normalize 多次叠加（如引号越套越多）。
 */
const mermaidCodeMap = new Map<HTMLElement, string>()

/**
 * ECharts 源码登记表 —— 与 mermaidCodeMap 同构，供主题切换时重绘。
 *
 * ⚠️ 为什么必须有（**这里踩过坑**）：暗色重绘机制最初**只覆盖 mermaid**，
 *    ECharts 既没登记、也没设 `backgroundColor`。而 ECharts 的底色是
 *    `init()` 时烧进 canvas 的（不是 CSS 变量），于是切到深色主题后
 *    卡片与页面都变暗，**画布仍是近白**（实测像素 `rgba(250,250,250,1)`
 *    在浅/深色下逐字节相同）——深色页面上出现一大块刺眼白图。
 *    同理存**原始 code**，重绘走同一入口，避免 normalize 叠加。
 */
const echartsCodeMap = new Map<HTMLElement, string>()
let themeObserver: MutationObserver | null = null
let themeTimer: any = null

/** 当前是否深色模式。集中一处判定，避免各渲染器各写一遍类名检查。 */
function isDarkMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

/**
 * 监听主题切换，在深/浅色切换后**以新主题重绘所有 mermaid 图**。
 *
 * 为什么必须重绘、而不能只靠 CSS：mermaid 把节点底色、文字色、连线色
 * 在渲染时就**烧进了 SVG 的 fill/stroke 属性**（不是 CSS 变量），
 * 换主题时这些属性不会跟着变，于是深色页面上仍是一张白底图 ——
 * 对比度极低，几乎不可读。
 *
 * 两个工程要点：
 *   1. **防抖 80ms**：VitePress 切换主题会连续改动 <html> 的 class
 *      （dark + 若干过渡类），不加防抖会触发多次全量重绘，明显卡顿。
 *   2. **惰性清理**：SPA 换页后旧 figure 已脱离 document，
 *      在重绘循环里顺手把这类条目从 Map 中删除，避免内存随浏览累积。
 */
function watchThemeChanges() {
  if (themeObserver || typeof window === 'undefined') return
  let lastIsDark = isDarkMode()
  themeObserver = new MutationObserver(() => {
    const curIsDark = isDarkMode()
    if (curIsDark !== lastIsDark) {
      lastIsDark = curIsDark
      clearTimeout(themeTimer)
      themeTimer = setTimeout(async () => {
        for (const [fig, code] of mermaidCodeMap) {
          if (document.contains(fig)) {
            try {
              await renderMermaid(fig, code)
            } catch (e) {
              console.warn('[chart] theme re-render failed:', e)
            }
          } else {
            mermaidCodeMap.delete(fig)
          }
        }
        // ECharts 同样必须重绘：其底色与坐标轴/文字色在 init 时烧进 canvas，
        // 不重绘则深色页面上残留一块白底（见 echartsCodeMap 注释）。
        for (const [fig, code] of echartsCodeMap) {
          if (document.contains(fig)) {
            try {
              await renderEcharts(fig, code)
            } catch (e) {
              console.warn('[chart] theme re-render failed (echarts):', e)
            }
          } else {
            echartsCodeMap.delete(fig)
          }
        }
      }, 80)
    }
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
}

async function renderMermaid(fig: HTMLElement, rawCode: string) {
  // 入口统一自愈：无论来自 sidecar JSON 还是 Markdown 围栏，都过同一道规整
  const code = normalizeMermaidCode(rawCode)
  // 登记原始源码，供主题切换时重绘（存原始值，见 mermaidCodeMap 注释）
  mermaidCodeMap.set(fig, rawCode)
  const body = fig.querySelector('.chart-body') as HTMLElement
  const mod: any = await import('mermaid')
  const mermaid = mod.default || mod
  const dark = isDarkMode()

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    // 主题随当前配色走：深色用 dark，浅色用 base（可被 themeVariables 完全接管）
    theme: dark ? CHART_MERMAID_THEMES.dark : CHART_MERMAID_THEMES.light,
    fontFamily: FONT,
    // ⚠️ wrappingWidth 默认 200：mermaid 会把它写成标签 div 的 max-width。
    // 讲义里大量用 `<br/>` 分行的**长中文行**（一行常 >200px），被 200 卡住后
    // 文字会溢出节点框、并整体偏移（截图里的"字体偏移"就是这个）。
    // 放开到 1000，让标签按实际内容取宽。
    flowchart: { htmlLabels: true, useMaxWidth: false, wrappingWidth: 1000 },
    // 深色模式额外注入精细配色；浅色留空，直接用 base 的默认值
    themeVariables: dark ? { ...CHART_MERMAID_THEMES.darkVars } : { darkMode: false },
  })
  // ⚠️ 每次渲染必须用**全新**的 id：mermaid.render 会在文档里临时插入
  // 同名 SVG 元素，复用 id 会让第二次渲染（主题切换）取到上一次的残留节点。
  const cleanId = (fig.dataset.id || 'm').replace(/[^A-Za-z0-9_]/g, '')
  const id = 'm' + zoomSeq++ + '_' + cleanId
  const out = await mermaid.render(id, code)
  body.innerHTML = out.svg
  attachTools(fig, null)
  bindInlineFit(fig, body)
}

async function renderEcharts(fig: HTMLElement, code: string) {
  const body = fig.querySelector('.chart-body') as HTMLElement
  let opt: any
  try {
    opt = JSON.parse(code)
  } catch {
    showError(body, 'echarts 配置解析失败')
    return
  }
  const mod: any = await import('echarts')
  const echarts = mod.default && mod.default.init ? mod.default : mod
  opt.animation = false
  opt.textStyle = Object.assign({}, opt.textStyle, { fontFamily: FONT })
  // 主题感知的画布底色：ECharts 默认画布是近白，深色主题下会形成刺眼白块。
  // 显式与「图表卡片底色」对齐（配置见 site.config.mts 的图表主题变量）。
  // 允许使用者在自己的 option 里覆盖（Object.assign 把用户值放后面）。
  // 只在深色下覆盖（浅色留 transparent 让卡片底色透出，与改前观感一致）。
  // 用户在自己的 option 里显式设了 backgroundColor 时以其为准。
  if (!opt.backgroundColor && isDarkMode()) {
    opt.backgroundColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--vp-code-block-bg').trim() || '#161618'
  }
  // 登记源码：主题切换时据此重绘（存原始 code，见 echartsCodeMap 注释）
  echartsCodeMap.set(fig, code)
  opt.toolbox = Object.assign(
    {
      right: 10,
      top: 6,
      itemSize: 13,
      feature: {
        saveAsImage: { title: '保存为图片', pixelRatio: 2 },
        dataView: { title: '查看数据', readOnly: true, lang: ['数据视图', '关闭', '刷新'] },
        restore: { title: '还原' },
      },
    },
    opt.toolbox || {}
  )
  opt.tooltip = Object.assign({ confine: true }, opt.tooltip || {})
  // 通用布局归一：修 title/legend/grid 互相压字（只在真重叠时下移，不破坏已手工调好的图）
  normalizeEchartsLayout(opt, body.clientWidth || 660, body.clientHeight || 430)
  // ★ 必须先销毁旧实例（**这里是真正的根因**）。
  //   `echarts.init()` 在**同一容器**上第二次调用时会**直接返回已有实例**
  //   （控制台警告 "There is a chart instance already initialized on the dom"），
  //   于是 `setOption` 作用在旧实例上 —— **canvas 元素根本没被重建**。
  //   而 ECharts 的画布底色与坐标轴色是 `init()` 时烧进 canvas 的，
  //   所以切主题后旧的白底一直留着（实测像素 rgba(250,250,250) 浅/深逐字节相同）。
  //   只加「登记 + 重绘循环 + backgroundColor」是不够的 —— 那三项都已就位却仍不生效，
  //   就是因为漏了这一步。
  echarts.getInstanceByDom(body as HTMLElement)?.dispose()
  const chart = echarts.init(body, null, { renderer: 'canvas' })
  ;(body as any).__echarts_instance__ = chart
  ;(fig as any).__chart_resize__ = () => chart.resize()
  chart.setOption(opt, true)
  const ro = new ResizeObserver(() => chart.resize())
  ro.observe(body)
  attachTools(
    fig,
    { reset: () => chart.dispatchAction({ type: 'restore' }) },
    {
      resize: () => chart.resize(),
      chart,
      body,
      dispose: () => {
        ro.disconnect()
        chart.dispose()
      },
    }
  )
}

async function renderWavedrom(fig: HTMLElement, code: string) {
  const body = fig.querySelector('.chart-body') as HTMLElement
  const mod: any = await import('wavedrom')
  const WD = mod.default && mod.default.renderWaveForm ? mod.default : mod
  // renderWaveForm 内部读取 window.WaveSkin
  const w = window as any
  if (!w.WaveSkin && WD.waveSkin) w.WaveSkin = WD.waveSkin
  if (!w.WaveSkin) {
    showError(body, 'wavedrom 皮肤未加载')
    return
  }
  let src: any
  try {
    src = JSON.parse(code)
  } catch {
    showError(body, 'wavedrom 源解析失败')
    return
  }
  const prefix = 'wd_' + (zoomSeq++) + '_'
  const holder = document.createElement('div')
  holder.id = prefix + '0'
  body.appendChild(holder)
  try {
    WD.renderWaveForm(0, src, prefix)
    attachTools(fig, null)
    bindInlineFit(fig, body)
  } catch (e: any) {
    showError(body, 'wavedrom 渲染失败：' + String(e?.message || e).slice(0, 160))
  }
}

/* ================= 通用布局归一：修图表元素互相压字 ================= */

/** 把 ECharts 的 % / px / 数字一律换算成像素 */
function toPx(v: any, base: number, dflt: number): number {
  if (v == null || v === '') return dflt
  if (typeof v === 'number') return v
  const s = String(v).trim()
  if (s.slice(-1) === '%') {
    const n = parseFloat(s)
    return isNaN(n) ? dflt : (n / 100) * base
  }
  const n = parseFloat(s)
  return isNaN(n) ? dflt : n
}

/**
 * title / legend / grid 重叠归一 —— 修“标题和图例糊成一行”这类高频通用问题。
 *
 * 根因：ECharts 里 title 与 legend 的默认位置都是 top:0 + left:center，
 * 只要源码 JSON 没显式写 top，两者就画在同一坐标上，
 * 于是标题文字与图例完全叠字（多系列图尤其明显）。
 *
 * 约束：**只在作者没写、或写了但确实重叠时才往下挪，绝不向上移**，
 * 因此已经手工调好 top/grid 的图不会被破坏。
 *
 * 本函数同时承担 **grid 兜底与 containLabel 强制开启** 的职责 ——
 * 见下方第 3 步，那是坐标轴文字被裁切的根因所在。
 */
function normalizeEchartsLayout(opt: any, boxW: number, boxH: number) {
  const asArr = (v: any) => (v == null ? [] : Array.isArray(v) ? v : [v])
  const titles = asArr(opt.title).filter((t: any) => t && (t.text || t.subtext))
  const legends = asArr(opt.legend).filter((l: any) => l && l.data)

  /* ⚠️ 这里**不能**因「没有 title/legend」就提前 return。
     下面第 3 步的 grid 兜底与 containLabel 兜底对**所有直角坐标系图**生效，
     而一张只有 xAxis/yAxis、没有标题图例的纯折线图恰恰最需要 containLabel
     —— 它的纵轴刻度文字同样会被 Canvas 裁掉。
     早期版本在此提前返回，导致「无标题图」整类图都拿不到兜底，
     且日志与截图完全看不出异常，属**静默失效**，故此处去掉该早退。 */

  // 确保至少存在一个 grid 对象：直角坐标系的所有兜底都挂在 grid 上，
  // 若作者没写 grid，先补一个空对象，后续步骤才能统一处理
  if (opt.grid == null) opt.grid = [{}]
  const grids = asArr(opt.grid)

  // --- 1) 标题：显式化默认位置，并按宽度估算要占几行 ---
  let titleBottom = 0
  if (titles.length) {
    const t = titles[0]
    if (t.top == null) t.top = 4
    if (t.left == null && t.right == null) t.left = 'center'
    const fs = Number(t.textStyle && t.textStyle.fontSize) || 14
    const subFs = t.subtext ? Number(t.subtextStyle && t.subtextStyle.fontSize) || 12 : 0
    let w = 0
    for (const ch of String(t.text || '')) w += ch.charCodeAt(0) > 255 ? fs : fs * 0.6
    const avail = Math.max(120, boxW * 0.86)
    const lines = Math.max(1, Math.ceil(w / avail))
    titleBottom =
      toPx(t.top, boxH, 4) +
      Math.round(fs * 1.45 * lines) +
      (subFs ? Math.round(subFs * 1.5) + 4 : 0) +
      8
  }

  // --- 2) 图例：未写 top 就放到标题下；写了但压在标题上则下移 ---
  let legendBottom = 0
  if (legends.length) {
    const l = legends[0]
    const declared = l.top
    const asIs = declared == null ? -1 : toPx(declared, boxH, -1)
    let top = asIs === -1 ? (titles.length ? titleBottom : 4) : asIs
    if (titles.length && top < titleBottom) top = titleBottom
    if (top !== asIs) l.top = top
    if (l.left == null && l.right == null) l.left = 'center'
    legendBottom = top + 30 // 单行图例行高 + 窄屏折两行的余量
  }

  // --- 3) 绘图区兜底：containLabel + 边距下限 + 让位给标题/图例 ---
  // needTop 只在确实存在标题/图例时才有意义；否则保持作者设定
  const needTop = (legendBottom || titleBottom)
    ? Math.ceil((legendBottom || titleBottom) + 12)
    : null
  const FB = CHART_ECHARTS_GRID.fallback
  for (const g of grids) {
    if (!g) continue

    /* ★ containLabel：ECharts 的默认值是 **false** —— 意味着坐标轴刻度文字
       与轴名称**不参与布局计算**，会直接画到 grid 之外被 Canvas 裁掉
       （纵轴 "1000.00" 只剩 "1000.0"，中文轴名整段消失）。
       本站强制开启：宁可绘图区小一圈，也不允许任何文字被切。
       即使作者显式写了 false 也覆盖 —— 「文字被切」在讲义里从来不是想要的效果，
       而想要的紧凑留白可以靠 grid 边距微调找回，两者不冲突。 */
    if (CHART_ECHARTS_GRID.containLabel) {
      g.containLabel = true
    } else if (g.containLabel == null) {
      // 开关关掉时补一个显式 false，保证行为可预期（而不是依赖 ECharts 默认值）
      g.containLabel = false
    }

    // 边距下限兜底：只抬下限，绝不压缩作者已写的大值
    if (g.left == null) g.left = FB.left
    else if (toPx(g.left, boxW, FB.left) < FB.left) g.left = FB.left

    if (g.right == null) g.right = FB.right
    else if (toPx(g.right, boxW, FB.right) < FB.right) g.right = FB.right

    if (g.bottom == null) g.bottom = FB.bottom
    else if (toPx(g.bottom, boxH, FB.bottom) < FB.bottom) g.bottom = FB.bottom

    // 让位给标题/图例：首行数据被文字盖住是同类高频问题
    if (needTop != null) {
      if (g.top == null) g.top = needTop
      else if (toPx(g.top, boxH, 60) < needTop) g.top = needTop
    }
  }

  // --- 4) x 轴名称默认画在轴线末端，grid.right 不够会被容器裁掉（右缘“上拉阻…”） ---
  for (const ax of asArr(opt.xAxis)) {
    if (!ax || !ax.name || ax.nameLocation != null) continue
    const fs = Number(ax.axisLabel && ax.axisLabel.fontSize) || 11
    const needRight = String(ax.name).length * fs + 24
    for (const g of grids) {
      if (!g) continue
      // 兜底基准与第 3 步保持一致，避免两处各用一套默认值而互相打架
      const cur = toPx(g.right, boxW, FB.right)
      if (cur < needRight) g.right = Math.ceil(needRight)
    }
  }
}

/**
 * 全屏层里的 echarts 缩放：改容器真实尺寸再 resize。
 * 这样放大后 canvas 是重新绘制的，保持锐利（与 CSS 拉伸位图不同）。
 */
function makeEchartsZoom(chart: any, body: HTMLElement): ZoomApi {
  let z = 1
  let bw = 0
  let bh = 0
  const apply = () => {
    if (!bw) {
      bw = body.clientWidth
      bh = body.clientHeight
    }
    if (Math.abs(z - 1) < 0.001) {
      body.style.width = ''
      body.style.height = ''
    } else {
      body.style.width = Math.round(bw * z) + 'px'
      body.style.height = Math.round(bh * z) + 'px'
    }
    requestAnimationFrame(() => chart.resize())
  }
  return {
    zoom(f: number) {
      z = Math.min(4, Math.max(0.5, z * f))
      apply()
    },
    reset() {
      z = 1
      apply()
    },
  }
}

/** 取 SVG 的原始尺寸：viewBox 优先，其次 width/height 属性（忽略 style 上的缩放）。 */
function svgNaturalSize(svg: SVGSVGElement): { w: number; h: number } {
  let w = 0
  let h = 0
  const vb = svg.getAttribute('viewBox')
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number)
    if (p.length === 4 && p[2] > 0 && p[3] > 0) {
      w = p[2]
      h = p[3]
    }
  }
  if (!w) w = parseFloat(svg.getAttribute('width') || '') || svg.clientWidth
  if (!h) h = parseFloat(svg.getAttribute('height') || '') || svg.clientHeight
  return { w, h }
}

/* ---------------- 内联矢量图自适应（等比适宽 + 居中 + 不裁剪） ----------------
   内联视图已无任何缩放/拖动交互，所以这里把图**一次算好**：
     · 宽度不超过容器（只缩小、绝不放大）——避免左右溢出；
     · 高度按同一比例跟随、**不设上限**——长流程图必须能完整看完（原 72vh 会把底部切掉）；
     · 水平居中（SVG 设 display:block + margin:auto，不依赖父级 text-align）。
   ⚠️ 只在**容器宽度变化**时重算：否则设置 SVG 高度会反过来触发 ResizeObserver 自激。 */
const lastFitW = new WeakMap<HTMLElement, number>()

function fitInlineSvg(fig: HTMLElement, force = false) {
  const body = fig.querySelector('.chart-body') as HTMLElement | null
  const svg = body?.querySelector('svg') as SVGSVGElement | null
  if (!body || !svg) return
  if (body.closest('.chart-modal')) return          // 弹层里交由 fitToStage 处理
  const avail = body.clientWidth
  if (!avail) return
  if (!force && lastFitW.get(fig) === avail) return
  lastFitW.set(fig, avail)
  const nat = svgNaturalSize(svg)
  if (!nat.w || !nat.h) return
  const s = Math.min(1, avail / nat.w)
  svg.style.maxWidth = 'none'
  svg.style.width = Math.round(nat.w * s) + 'px'
  svg.style.height = Math.round(nat.h * s) + 'px'
  svg.style.display = 'block'
  svg.style.margin = '0 auto'
}

/** 渲染完立即适配一次，并监听容器宽度变化（窗口缩放 / 收放侧栏 / 沉浸模式切换）。 */
function bindInlineFit(fig: HTMLElement, body: HTMLElement) {
  fitInlineSvg(fig, true)
  ;(fig as any).__fit_svg__ = () => fitInlineSvg(fig, true)
  if (fig.dataset.fitBound) return
  fig.dataset.fitBound = '1'
  const ro = new ResizeObserver(() => fitInlineSvg(fig))
  ro.observe(body)
}

/**
 * 矢量图缩放：直接改 SVG 的 width/height，**不用 transform**。
 *
 * 为什么不能用 transform：transform 只改"视觉"，布局尺寸仍是最初的尺寸，
 * 于是舞台的滚动条、居中、自适应全部与看到的画面脱节
 * （现象就是"图放大了，底部滚动条却固定在原位不动"）。
 * 改成设实际尺寸后，布局与视觉始终一致。
 */
function makeSvgSizeZoom(svg: SVGSVGElement): ZoomApi {
  const nat = svgNaturalSize(svg)
  let z = 1
  const clamp = (v: number) => Math.min(12, Math.max(0.05, v))
  const apply = () => {
    if (!nat.w || !nat.h) return
    svg.style.maxWidth = 'none'
    svg.style.width = Math.round(nat.w * z) + 'px'
    svg.style.height = Math.round(nat.h * z) + 'px'
  }
  return {
    zoom(f: number) {
      z = clamp(z * f)
      apply()
    },
    zoomTo(s: number) {
      z = clamp(s)
      apply()
    },
    reset() {
      z = 1
      apply()
    },
  }
}

/* ================= 全屏放大查看 =================
   把已渲染的 .chart-body 整体搬进弹层（不重渲染）：
   mermaid/wavedrom 继续用 svg transform 缩放，echarts 改容器尺寸 + resize 保持锐利。
   关闭时原样搬回原 figure。 */
let modalEl: HTMLElement | null = null
let modalHost: HTMLElement | null = null
let modalRestore: { parent: Node; next: Node | null } | null = null

function onModalKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeModal()
}

function closeModal() {
  if (!modalEl) return
  const body = modalHost?.querySelector('.chart-body') as HTMLElement | null
  if (body && modalRestore?.parent) {
    modalRestore.parent.insertBefore(body, modalRestore.next)
    body.style.width = ''
    body.style.height = ''
    // 矢量图在弹层里被改了实际尺寸，必须还原，否则内联版式会被撑坏
    const svg = body.querySelector('svg') as SVGSVGElement | null
    if (svg) {
      svg.style.width = ''
      svg.style.height = ''
      svg.style.maxWidth = ''
    }
    const back = modalRestore.parent as HTMLElement
    figStates.get(back)?.extra?.resize?.()
    requestAnimationFrame(() => fitInlineSvg(back, true))   // 回到内联后重新自适应
  }
  modalEl.remove()
  modalEl = null
  modalHost = null
  modalRestore = null
  document.documentElement.classList.remove('chart-modal-open')
  document.removeEventListener('keydown', onModalKey)
}

function openChartModal(fig: HTMLElement) {
  if (modalEl) closeModal()
  const body = fig.querySelector('.chart-body') as HTMLElement | null
  if (!body) return
  const st = figStates.get(fig)
  const type = fig.dataset.type || ''

  const overlay = document.createElement('div')
  overlay.className = 'chart-modal'
  overlay.innerHTML =
    '<div class="chart-modal__panel" role="dialog" aria-modal="true" aria-label="图表放大查看">' +
    '<div class="chart-modal__bar"><span class="chart-modal__title">' +
    (TAG_LABEL[type] || '图表') +
    (fig.dataset.lecture ? ' · ' + fig.dataset.lecture + '#' + (fig.dataset.id || '') : '') +
    '</span><span class="chart-modal__ops">' +
    '<button type="button" data-m="in" title="放大" aria-label="放大">&#43;</button>' +
    '<button type="button" data-m="out" title="缩小" aria-label="缩小">&#8722;</button>' +
    '<button type="button" data-m="reset" title="复位" aria-label="复位">&#8634;</button>' +
    '<button type="button" data-m="close" title="关闭（Esc）" aria-label="关闭">&#10005;</button>' +
    '</span></div>' +
    '<div class="chart-modal__stage"><figure class="chart chart--modal" data-type="' +
    type +
    '"></figure></div></div>'

  const host = overlay.querySelector('figure') as HTMLElement
  modalRestore = { parent: body.parentNode as Node, next: body.nextSibling }
  host.appendChild(body)
  body.style.width = ''
  body.style.height = ''

  const stage = overlay.querySelector('.chart-modal__stage') as HTMLElement
  const svg = body.querySelector('svg') as SVGSVGElement | null

  /* 缩放后端按类型选：
     - echarts：改容器尺寸 + resize 重绘（canvas 拉伸会糊）
     - mermaid / wavedrom：改 SVG 实际 width/height，布局与视觉同步
     - 兜底：沿用渲染时建立的 api */
  const api: ZoomApi | null =
    type === 'echarts' && st?.extra?.chart
      ? makeEchartsZoom(st.extra.chart, body)
      : svg
        ? makeSvgSizeZoom(svg)
        : st?.api || null

  /* 打开即自适应：等比缩放到"整幅完整可见"，而不是默认放大到某个局部 */
  const fitToStage = () => {
    if (type === 'echarts') {
      st?.extra?.resize?.()
      return
    }
    if (!svg || !api || !api.zoomTo) return
    const nat = svgNaturalSize(svg)
    if (!nat.w || !nat.h) return
    const pad = 24
    const s = Math.min(
      (stage.clientWidth - pad) / nat.w,
      (stage.clientHeight - pad) / nat.h
    )
    api.zoomTo(s)
  }
  /* 围绕视口中心缩放：先记录中心点在内容中的相对位置，缩放后立即还原。
     必须同步执行 —— 若包在 rAF 里，连续快速点击时第二次的比例会基于上一次
     尚未生效的 scrollWidth 计算，导致放大后视口偏离中心。 */
  const zoomBy = (f: number) => {
    if (!api) return
    const px = stage.scrollWidth ? (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth : 0.5
    const py = stage.scrollHeight ? (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : 0.5
    api.zoom(f)
    stage.scrollLeft = px * stage.scrollWidth - stage.clientWidth / 2
    stage.scrollTop = py * stage.scrollHeight - stage.clientHeight / 2
  }
  overlay.querySelector('.chart-modal__ops')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest?.('[data-m]') as HTMLElement | null
    if (!b) return
    const a = b.getAttribute('data-m')
    if (a === 'close') return closeModal()
    if (a === 'reset') {
      // 复位 = 回到"整幅自适应"的初始视图（而不是 1:1 原尺寸）
      if (type === 'echarts') api?.reset()
      fitToStage()
      stage.scrollTo(0, 0)
      return
    }
    zoomBy(a === 'in' ? 1.3 : 1 / 1.3)
  })
  // 滚轮缩放（只在全屏层生效）
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12)
    },
    { passive: false }
  )

  /* 全屏层解锁「拖动平移」；同时区分单击与拖动 —— 拖动过就不算单击（不关闭）。 */
  let panning = false
  let lastX = 0
  let lastY = 0
  let downX = 0
  let downY = 0
  let moved = false
  overlay.addEventListener('mousedown', (e) => {
    downX = e.clientX
    downY = e.clientY
    moved = false
    if ((e.target as HTMLElement).closest?.('.chart-modal__bar')) return
    if (e.button !== 0) return
    panning = true
    lastX = e.clientX
    lastY = e.clientY
    stage.classList.add('grabbing')
  })
  overlay.addEventListener('mousemove', (e) => {
    if (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6) moved = true
    if (!panning) return
    stage.scrollLeft -= e.clientX - lastX
    stage.scrollTop -= e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
  })
  overlay.addEventListener('mouseup', () => {
    panning = false
    stage.classList.remove('grabbing')
  })
  /* 单击关闭（唯一退出手势）：点顶部工具栏不关、刚拖动过也不关。 */
  overlay.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest?.('.chart-modal__bar')) return
    if (moved) return
    closeModal()
  })

  document.body.appendChild(overlay)
  document.documentElement.classList.add('chart-modal-open')
  modalEl = overlay
  modalHost = host
  document.addEventListener('keydown', onModalKey)
  // 节点搬进弹层后容器尺寸已变：echarts 重排，矢量图按可用区域做自适应
  requestAnimationFrame(() => {
    st?.extra?.resize?.()
    fitToStage()
  })
}

/* 导出与外部打印总线支持 */
if (typeof window !== 'undefined') {
  ;(window as any).__RESIZE_ALL_CHARTS__ = () => {
    document.querySelectorAll<HTMLElement>('figure.chart[data-type="echarts"]').forEach((fig) => {
      const body = fig.querySelector('.chart-body') as HTMLElement | null
      if (body) {
        const chart = (body as any).__echarts_instance__
        if (chart && typeof chart.resize === 'function') {
          try { chart.resize() } catch {}
        }
      }
    })
    document.querySelectorAll<HTMLElement>('figure.chart').forEach((fig) => {
      if (typeof (fig as any).__fit_svg__ === 'function') {
        try { (fig as any).__fit_svg__() } catch {}
      } else {
        fitInlineSvg(fig, true)
      }
    })
  }
}

/* ---------------- 入口（幂等，可被 onUpdated 反复调用） ---------------- */

/**
 * 从 VitePress 渲染出的代码块 DOM 中提取**纯 Mermaid 源码文本**。
 *
 * 为什么不能直接读 block.textContent：VitePress 用 Shiki 生成代码块，
 * 其 DOM 结构是 `div.language-mermaid > pre > code > span.line`，
 * 除了源码本身，还混入了语言标识、复制按钮、行号等装饰元素的文本。
 * 直接取 textContent 会把 "mermaid"、"复制" 之类字样拼进源码里，
 * 交给 mermaid 解析必然报错。
 *
 * 因此优先按 `.line` 逐行取（Shiki 的既有结构，最准确）；
 * 取不到时退化到「克隆节点 + 剔除装饰元素」再取文本。
 */
function extractMermaidCode(block: HTMLElement): string {
  const lines = block.querySelectorAll<HTMLElement>('pre code .line, pre .line')
  if (lines.length > 0) {
    return Array.from(lines)
      .map((l) => l.textContent || '')
      .join('\n')
      .trim()
  }
  const codeEl = (
    block.querySelector('code') || block.querySelector('pre') || block
  ).cloneNode(true) as HTMLElement
  codeEl.querySelectorAll('.copy, .lang').forEach((el) => el.remove())
  return (codeEl.textContent || '').trim()
}

/**
 * 查找正文里需要被接管为图表卡片的 Mermaid 代码块。
 *
 * 三重过滤，缺一不可：
 *   1. **只认配置里声明的选择器**（默认 ` ```mermaid:chart `）——
 *      裸 ` ```mermaid ` 依然作为源码展示，这是「文档演示语法」的正当用法，
 *      全局接管会把引擎自己的文档变成一堆图。
 *   2. **排除已接管过的**（data-mermaid-rendered），因为 onUpdated 会反复调用本函数。
 *   3. **排除图表内部**（.chart-code / figure.chart 内）——
 *      图表源码折叠区里也有一份 mermaid 文本，若被接管会无限套娃。
 */
function findInlineMermaidBlocks(): HTMLElement[] {
  if (!CHART_INLINE_MERMAID.enabled) return []
  const sel = CHART_INLINE_MERMAID.selectors
    .map((s) => `${s}:not([data-mermaid-rendered])`)
    .join(', ')
  if (!sel) return []
  return Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => !el.closest('.chart-code') && !el.closest('figure.chart')
  )
}

export async function initCharts() {
  // SPA 换页时若弹层还开着，先关掉，避免把上一讲的图挂到新页面上
  if (modalEl && (!modalRestore || !document.contains(modalRestore.parent))) closeModal()

  const figs = Array.from(
    document.querySelectorAll<HTMLElement>('figure.chart:not([data-rendered])')
  )
  const inlineBlocks = findInlineMermaidBlocks()

  if (!figs.length && !inlineBlocks.length) {
    if (typeof window !== 'undefined') {
      ;(window as any).__CHARTS_DONE__ = true
    }
    return
  }

  // 这个全局标志表示「当前页面的图表已全部渲染完」。
  // ⚠️ 必须在每次开始时**复位**：它是全局变量，SPA 换页后不会自动清零，
  // 否则外部（审计脚本、自动化测试）会在新页面图表还没渲染完时就读到上一页的 true。
  ;(window as any).__CHARTS_DONE__ = false

  // 主题切换监听：只在确有待渲染图表时挂载，纯文本页不做无谓的 DOM 观察
  watchThemeChanges()

  // 等字体加载完成再渲染，否则 mermaid 按回退字体估算节点高度，中文字体（Noto Sans SC /
  // 微软雅黑）随后加载会让实际文本溢出节点边框被裁切。
  // 用超时竞态兜底：个别环境 document.fonts.ready 可能永不 resolve，绝不能让它卡死整页图表。
  try {
    const ready = (document.fonts as FontFaceSet | undefined)?.ready
    if (ready) {
      await Promise.race([
        ready,
        new Promise((r) => setTimeout(r, 2500)),
      ])
    }
  } catch {
    /* ignore */
  }

  const jobs: Promise<void>[] = []

  /* ---- A) 接管正文中的 Mermaid 代码块（```mermaid:chart） ----
     做法：在原代码块**原地插入**一张 figure，再隐藏原块。
     为什么不用 innerHTML 整体替换：原地插入能最大限度保留
     作者在 markdown 里写的上下文位置，且原块仍在 DOM 中可随时还原。

     ★ 契约安全：这些 figure **不设 data-lecture**。
       data-lecture 的语义是「本图的数据源是 /charts/<data-lecture>.json」，
       而上游闸门（check_figs2.py）会据它校验 figure ↔ JSON 严格 1:1。
       内联图的数据直接来自正文围栏，**没有 sidecar JSON**，
       若随手填一个 lecture 值，就会凭空制造一条「锚点无对应 JSON」的不一致，
       直接把闸门打红。故只设 data-id（供 id/主题重绘登记用）与 data-type。 */
  if (inlineBlocks.length) {
    for (const block of inlineBlocks) {
      block.dataset.mermaidRendered = '1' // 先打标，防止本轮/下轮重复接管
      const code = extractMermaidCode(block)
      // 提取不到源码就**保持原样**：宁可继续显示代码块，也不能变成一张空图
      if (!code) {
        delete block.dataset.mermaidRendered
        continue
      }

      const fig = document.createElement('figure')
      fig.className = 'chart ' + CHART_INLINE_MERMAID.className
      fig.dataset.type = 'mermaid'
      fig.dataset.id = 'inline_' + ++zoomSeq
      fig.dataset.source = 'inline-mermaid' // 标记来源，便于调试与外部脚本区分

      block.parentNode?.insertBefore(fig, block)
      // keepSource 时把原代码块折叠进 figure 的源码区；否则直接隐藏
      if (!CHART_INLINE_MERMAID.keepSource) block.style.display = 'none'

      ensureSkeleton(fig)
      injectSource(fig, code)
      fig.dataset.rendered = '1'
      fig.dataset.chartStatus = 'loading'
      const body = fig.querySelector('.chart-body') as HTMLElement
      if (body && !body.childElementCount) {
        body.innerHTML = '<div class="chart-pending">流程图加载中…</div>'
      }

      jobs.push(
        (async () => {
          try {
            await renderMermaid(fig, code)
            fig.dataset.chartStatus = 'ok'
          } catch (e: any) {
            // 渲染失败**回滚**为原始代码块：正文绝不能因为接管失败而丢失内容
            fig.dataset.chartStatus = 'error'
            console.warn('[chart] 内联 mermaid 渲染失败，回退为代码块:', e)
            fig.remove()
            block.style.display = ''
          }
        })()
      )
    }
  }

  // 按讲次分组，一次拉一个 JSON
  const byLecture = new Map<string, HTMLElement[]>()
  for (const f of figs) {
    const lec = f.dataset.lecture || ''
    if (!byLecture.has(lec)) byLecture.set(lec, [])
    byLecture.get(lec)!.push(f)
  }

  for (const [lecture, list] of byLecture) {
    jobs.push(
      (async () => {
        const data = await loadCharts(lecture)
        for (const fig of list) {
          const key = fig.dataset.id || ''
          // type 以 sidecar JSON 为准；随后运行时生成骨架（body/标签/工具条）
          if (data?.[key]?.type) fig.dataset.type = data[key].type
          ensureSkeleton(fig)
          const body = fig.querySelector('.chart-body') as HTMLElement
          fig.dataset.rendered = '1'
          fig.dataset.chartStatus = 'loading'
          // 加载占位：若长时间停在“加载中”，说明流程被卡住（可据此定位是 fetch 还是渲染）
          if (body && !body.childElementCount) {
            body.innerHTML = '<div class="chart-pending">图表加载中…</div>'
          }

          const def = data?.[key]
          if (!def) {
            fig.dataset.chartStatus = 'missing'
            showError(body, `图表源缺失（${lecture}#${key}）`)
            console.warn('[chart] source missing:', lecture, key,
                         data ? 'key not in json' : 'json fetch failed')
            continue
          }
          injectSource(fig, def.code)
          try {
            if (def.type === 'mermaid') await renderMermaid(fig, def.code)
            else if (def.type === 'echarts') await renderEcharts(fig, def.code)
            else if (def.type === 'wavedrom') await renderWavedrom(fig, def.code)
            else {
              showError(body, '未知图表类型：' + def.type)
              fig.dataset.chartStatus = 'unknown-type'
              continue
            }
            fig.dataset.chartStatus = 'ok'
          } catch (e: any) {
            fig.dataset.chartStatus = 'error'
            showError(body, `${def.type} 渲染失败：${String(e?.message || e).slice(0, 160)}`)
            console.error('[chart] render failed:', lecture, key, def.type, e)
          }
        }
      })()
    )
  }
  await Promise.all(jobs)
  ;(window as any).__CHARTS_DONE__ = true
}

