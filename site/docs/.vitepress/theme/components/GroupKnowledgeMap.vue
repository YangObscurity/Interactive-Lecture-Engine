<script setup lang="ts">
/**
 * GroupKnowledgeMap.vue — 课程组专属动态知识脉络脑图（Markmap 引擎 · ADR-032 定稿）
 *
 * 核心契约：
 * 1. 组图唯一图形态：脑图（Mind Map）。Root（`DEMO · 现代工程实战` 样式）
 *    → 阶段块（按 3~4 讲/块切分，`阶段N (Lxx-Lyy) · 组短标题`）→ 全量讲次叶子
 *    （`Lxx · 讲次标题`，每组每一讲都在，绝不截断），层级正交展开；
 * 2. 引擎：markmap（markmap-view + markmap-lib，D3 驱动 SVG），负责自动测量每个
 *    文本节点的宽高、贝塞尔连线、末端折叠圆圈与平移缩放动效——文字永远正向水平，
 *    零碰撞零叠字；讲次主表取自 themeConfig.groups 真实目录，Notion 知识图谱仅作
 *    三态状态兜底，失败静默降级绝不阻断渲染；
 * 3. 阶段分支保留 dify 式彩色调色板（STAGE_PALETTE），一阶段一色染透枝干；
 * 4. 打卡三态：已完成 #10b981 / 学习中 #f59e0b / 未开始 #94a3b8，纯 CSS 小圆点
 *    区分，严守零 Emoji / 零 Dingbats 铁律；
 * 5. 暗黑模式：isDark 检测 + MutationObserver 监听 <html>.dark 切换，容器挂
 *    markmap-dark class（markmap-view 内置 globalCSS 翻转 --markmap-text-color）；
 * 6. 讲次跳转：点击叶子节点 g.markmap-node，link 三层读取链
 *    `data-gkm-link` DOM 属性（GT 防剥冗余）→ d3 `__data__.payload.link` → `.gkm-tag`
 *    文本反查内存表，router.go(withBase(lecturePath))；
 * 7. 自适应高度：containerHeightFor(leafCount) = clamp(520, n*26+80, 1000)，
 *    window resize → mm.fit()，监听器在 onUnmounted 严格解绑；
 * 8. 全屏弹层：Teleport to body + 全局 .chart-modal 样式族，Esc / 遮罩 / 退出按钮关闭；
 * 9. SSR 铁律：markmap-view 仅在 onMounted 内 await import()，typeof window 守卫。
 */

import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter, useData, withBase } from 'vitepress'
import { ICONS } from './ai/icons'
import type { ProgressStatus, NotionGraphNode } from './ai/neonRepository'

/* ---------------------------------------------------------------------------
 * 数据契约（与挂载方 GroupIndex.vue 保持一致）
 * ------------------------------------------------------------------------- */

interface Lecture {
  n: number
  text: string
  link: string
}

interface Group {
  id: string
  dir: string
  title: string
  accent: string
  lectures: Lecture[]
}

/** Markmap 节点（IPureNode 等价本地类型：content 为 HTML 字符串，children 必填） */
interface MindNode {
  content: string
  payload?: Record<string, unknown>
  children: MindNode[]
}

/** Markmap 实例最小接口（按结构收窄，拒绝 any） */
interface MindmapInstance {
  setData: (root: MindNode) => Promise<void>
  fit: () => Promise<void>
  destroy: () => void
}

/** Markmap 挂载句柄：实例 + 点击监听解绑闭包（add/remove 严格对账） */
interface MindmapHandle {
  mm: MindmapInstance
  dispose: () => void
}

/** SVG 上 d3 数据绑定的节点结构收窄（g.markmap-node.__data__） */
interface BoundNodeData {
  payload?: { link?: string }
}

/**
 * link 反查表：讲次 tag（`L01`）→ 站内链接。
 *
 * 2026-10-13 生产特异性加固：线上用户实测（Chrome + Google 翻译弹条）点击脑图讲次节点不跳转。
 * 根因链：link 唯一载体是 d3 绑在 g.markmap-node 上的 `__data__` expando（JS 对象属性，
 * 不在 DOM 属性里），GT 翻译会克隆/替换文本子树——克隆体不带 expando，点击读
 * `bound?.payload?.link` 得 undefined 静默 return。对策三层：
 * 1. 渲染后把 link 冗余写进 DOM 属性 `data-gkm-link`（GT 不剥属性，克隆也带属性）；
 * 2. 点击优先读 dataset，回退 `__data__`；
 * 3. 终极兜底：从节点内 `.gkm-tag` 文本反查本表（组件内存树，不依赖任何 DOM 状态）。
 */
let linkByTag: Map<string, string> = new Map()

const props = defineProps<{
  groupId: string
  progressMap: Record<string, ProgressStatus>
}>()

const router = useRouter()
const { theme } = useData()

const chartContainerRef = ref<HTMLDivElement | null>(null)
const modalChartRef = ref<HTMLDivElement | null>(null)
const inlineSvgRef = ref<SVGSVGElement | null>(null)
const modalSvgRef = ref<SVGSVGElement | null>(null)
let chartHandle: MindmapHandle | null = null
let modalHandle: MindmapHandle | null = null
let modalBusy = false
let darkObserver: MutationObserver | null = null
let containerObserver: ResizeObserver | null = null
let unmounted = false
let resizeRaf = 0

/* ---------------------------------------------------------------------------
 * 单飞渲染链（2026-10-13 修复「整幅重影」事故）
 *
 * markmap 的 `Markmap.create(svg)` 是纯追加式挂载：每次 create 都往同一个 svg 里追加一组
 * `<style>` + 根 `<g>`。onMounted 与 deep watch（groupId / progressMap / notionIndex 任一变化）
 * 会并发触发 renderMindmap，而 handle 要等 create 完成才赋值 —— 于是多个并发调用同时看到
 * `handle === null`、同时 create，叠出 N 层实例（实测高并发场景下可达多层叠加、数百个 g.markmap-node，
 * 导致节点整体重影）。
 *
 * 对策：同一 svg 元素上的渲染严格串行成一条链，且排队期间洪峰合并 —— 后到的请求取消中间轮
 * 执行，只保留最后一轮（数据永远最新）。dark class 同步切换，不受合并影响。
 * ------------------------------------------------------------------------- */
/** key=svg 元素，value=该 svg 上渲染链的 Promise 尾（保证串行） */
const renderQueues = new WeakMap<SVGSVGElement, Promise<void>>()
/** key=svg 元素，value=该 svg 上最新一次渲染请求的序号（洪峰合并判据） */
const renderSeq = new WeakMap<SVGSVGElement, number>()

const isFullscreen = ref(false)
const isLoading = ref(true)
const isDark = ref(false)
/** 脑图引擎（markmap-view）动态导入失败标志：置位后以纯文字占位替代画布，绝不 console.* */
const mapLoadFailed = ref(false)

/** Notion 知识图谱节点索引：lectureId(小写) → 节点（仅作状态兜底，不作讲次主表来源） */
const notionIndex = ref<Map<string, NotionGraphNode>>(new Map())

const ROOT_COLOR = '#3b82f6'

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']

/* 视口骨架高度约束：展开越多向下延伸越长（最大 3200px），展开少动态收缩（最小 420px），守住字号不变契约 */
const MIN_VIEWPORT_HEIGHT = 420
const MAX_VIEWPORT_HEIGHT = 3200
const viewportHeight = ref<number>(560)

function estimateInitialHeight(count: number): number {
  const n = Math.max(1, count)
  return Math.min(MAX_VIEWPORT_HEIGHT, Math.max(MIN_VIEWPORT_HEIGHT, n * 34 + 100))
}

/** markmap 实例调参：禁用自动每次调用 fit（防折叠时缩放暴涨/跳跃），开启大间距与优雅动效 */
const MARKMAP_OPTIONS = {
  autoFit: false, // 视口变化时由 autoCalibrateLayout 精确平移控制，绝不在点击折叠时重置缩放！
  duration: 280, // 展开/折叠动效时长（ms）
  initialExpandLevel: -1, // -1 = 全部展开（含叶子讲次）
  spacingVertical: 18, // 兄弟节点纵向间距（px），扩大行距，杜绝叠字
  spacingHorizontal: 22, // 层级横向间距（px）
  paddingX: 16, // 左右内边距（px）
  maxWidth: 420, // 单节点文本最大宽度（px），超出自动换行
  color: nodeColor, // 节点取色器：payload.color 优先，缺省回退 currentColor
  lineWidth: () => 1.8 // 贝塞尔连线宽度（px）
}

/* ---------------------------------------------------------------------------
 * 纯函数工具层
 * ------------------------------------------------------------------------- */

/** markmap 节点 content 以 HTML 直注入 foreignObject，& < > 必须转义 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function truncate(text: string, max: number): string {
  const t = (text || '').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function lectureTag(n: number): string {
  return `L${String(n).padStart(2, '0')}`
}

function lectureIdOf(d: string, n: number): string {
  return `${d.toLowerCase()}-l${String(n).padStart(2, '0')}`
}

/** 打卡状态仅用 CSS 类名区分（零符号字符），颜色由 scoped :deep 样式施加 */
function statusDotClass(status: ProgressStatus): string {
  if (status === '已完成') return 'gkm-dot--done'
  if (status === '学习中') return 'gkm-dot--doing'
  return 'gkm-dot--none'
}

/* ---------------------------------------------------------------------------
 * 响应式数据层
 * ------------------------------------------------------------------------- */

const themeGroups = computed<Group[]>(() => {
  const raw = (theme.value as { groups?: unknown } | null)?.groups
  return Array.isArray(raw) ? (raw as Group[]) : []
})

const currentGroup = computed<Group | null>(() => {
  const target = (props.groupId || '').toLowerCase()
  return themeGroups.value.find((g) => (g?.dir || '').toLowerCase() === target) || null
})

const dir = computed(() => currentGroup.value?.dir || props.groupId)

/** 组短标题：取真实课程名截断 14 字（绝不跨学科写死阶段名） */
const shortTitle = computed(() => truncate(currentGroup.value?.title || props.groupId.toUpperCase(), 14))

/** 全量讲次主表（该组每一讲，按讲号升序，绝不切片截断） */
const groupLectures = computed<Lecture[]>(() => {
  const g = currentGroup.value
  if (!g || !Array.isArray(g.lectures) || g.lectures.length === 0) return []
  return [...g.lectures].sort((a, b) => a.n - b.n)
})

/** 讲次实时三态（响应式 progressMap 优先，Notion 节点状态兜底） */
function lectureStatus(n: number): ProgressStatus {
  const lid = lectureIdOf(dir.value, n)
  const fromMap = props.progressMap[lid]
  if (fromMap) return fromMap
  const node = notionIndex.value.get(lid)
  if (node && (node.status === '已完成' || node.status === '学习中' || node.status === '未开始')) {
    return node.status
  }
  return '未开始'
}

const nodeStats = computed(() => {
  let completed = 0
  let inProgress = 0
  for (const l of groupLectures.value) {
    const s = lectureStatus(l.n)
    if (s === '已完成') completed += 1
    else if (s === '学习中') inProgress += 1
  }
  const total = groupLectures.value.length
  return { completed, inProgress, total, percent: total > 0 ? Math.round((completed / total) * 100) : 0 }
})

/** 视口骨架高度自适应：展开越多向下延伸越长，展开少动态收缩，守住字号不变契约 */
const viewportHeightCss = computed(() => viewportHeight.value)

/** 加载 Notion 知识图谱（仅作状态兜底，失败静默降级，绝不阻断主渲染）；带时间戳防缓存 */
async function loadNotionIndex(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const res = await fetch(`${withBase('/notion_knowledge_graph.json')}?v=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return
    const nodes = (await res.json()) as NotionGraphNode[]
    if (!Array.isArray(nodes)) return
    const idx = new Map<string, NotionGraphNode>()
    for (const n of nodes) {
      if (n && typeof n.lectureId === 'string' && n.lectureId) {
        idx.set(n.lectureId.toLowerCase(), n)
      }
    }
    notionIndex.value = idx
  } catch {
    notionIndex.value = new Map()
  }
}

/* ---------------------------------------------------------------------------
 * Markmap 树构建（Root → 阶段块 → 全量讲次叶子）
 * ------------------------------------------------------------------------- */

/** dify 式彩色分支调色板：每个学习阶段一种色相，枝干同色染透 */
const STAGE_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16']

/**
 * 把全量讲次切成「每组 3~4 讲」的阶段块：
 * 正常区间每块 3~4 讲；极小课程组（n <= 5）无法切出合规块，退化为单块。
 */
function chunkLectures(lectures: Lecture[]): Lecture[][] {
  const n = lectures.length
  if (n === 0) return []
  if (n <= 5) return [lectures]
  const target = Math.ceil(n / 4)
  const base = Math.floor(n / target)
  const extra = n % target

  const out: Lecture[][] = []
  let cursor = 0
  for (let i = 0; i < target; i += 1) {
    const size = base + (i < extra ? 1 : 0)
    out.push(lectures.slice(cursor, cursor + size))
    cursor += size
  }
  return out.filter((c) => c.length > 0)
}

/** 讲次叶子节点：CSS 圆点表三态 + 讲号 + 标题 + 悬停跳转线索 ↗，payload 携带跳转链接与标题 */
function buildLeafNode(l: Lecture): MindNode {
  const status = lectureStatus(l.n)
  return {
    content: [
      `<i class="gkm-dot ${statusDotClass(status)}"></i>`,
      `<span class="gkm-tag">${escapeHtml(lectureTag(l.n))}</span>`,
      `<span class="gkm-lec">${escapeHtml(l.text)}</span>`,
      `<span class="gkm-jump-cue" title="点击阅读讲义">↗</span>`
    ].join(''),
    payload: {
      link: l.link,
      lectureTitle: l.text
    },
    children: []
  }
}

/** 阶段块节点：阶段色 chip + 覆盖讲次区间 + 组短标题 */
function buildStageNode(chunk: Lecture[], idx: number): MindNode {
  const startTag = lectureTag(chunk[0].n)
  const endTag = lectureTag(chunk[chunk.length - 1].n)
  const cn = CN_NUM[idx] || String(idx + 1)
  const stageColor = STAGE_PALETTE[idx % STAGE_PALETTE.length]
  const stageTitle = `阶段${cn} (${startTag}-${endTag}) · ${shortTitle.value}`
  return {
    content: `<span class="gkm-stage">${escapeHtml(stageTitle)}</span>`,
    payload: {
      color: stageColor
    },
    children: chunk.map((l) => buildLeafNode(l))
  }
}

/** 组装整棵 Markmap 树：Root = `${groupId.toUpperCase()} · ${groupTitle}` */
function buildMindTree(): MindNode {
  const groupLabel = currentGroup.value?.title || props.groupId.toUpperCase()
  const rootTitle = `${props.groupId.toUpperCase()} · ${groupLabel}`
  return {
    content: `<span class="gkm-root">${escapeHtml(rootTitle)}</span>`,
    payload: {
      color: ROOT_COLOR
    },
    children: chunkLectures(groupLectures.value).map((chunk, idx) => buildStageNode(chunk, idx))
  }
}

/* ---------------------------------------------------------------------------
 * Markmap 渲染引擎（markmap-view 动态导入，SSR 安全）
 * ------------------------------------------------------------------------- */

/** 节点取色：payload.color 优先，缺省回退 currentColor（随 markmap-dark 翻转） */
function nodeColor(node: { payload?: { color?: unknown } }): string {
  const c = node.payload?.color
  return typeof c === 'string' ? c : 'currentColor'
}

/**
 * 把讲次叶子的 link 冗余写进 DOM：`g.markmap-node[data-gkm-link]`，并注入原生 title 悬停提示。
 * dataset 属性 Google 翻译不会剥（它只重写文本子树），克隆后属性也随节点走。
 * markmap 的 update 会复用/新建 g 节点，故每次渲染（setData 之后）都全量补写一遍。
 */
function stampLinks(svgEl: SVGSVGElement): void {
  svgEl.querySelectorAll('g.markmap-node').forEach((g) => {
    const tagEl = g.querySelector('foreignObject .gkm-tag')
    if (!tagEl) return
    const tag = (tagEl.textContent || '').trim()
    const link = tag ? linkByTag.get(tag) : undefined
    if (link) {
      g.setAttribute('data-gkm-link', link)
      const lecEl = g.querySelector('foreignObject .gkm-lec')
      const lecTitle = lecEl ? (lecEl.textContent || '').trim() : ''
      g.setAttribute('title', `点击阅读讲义: ${tag}${lecTitle ? ' · ' + lecTitle : ''}`)
    }
  })
}

/** 由当前组讲次主表重建 tag→link 反查表（与 buildMindTree 同源数据，绝不失同步） */
function rebuildLinkIndex(): void {
  const idx = new Map<string, string>()
  for (const l of groupLectures.value) idx.set(lectureTag(l.n), l.link)
  linkByTag = idx
}

/**
 * 点击叶子节点跳转讲义。link 三层读取链（按可靠性排序）：
 * 1. `g[data-gkm-link]` DOM 属性 —— GT 克隆不剥属性，最可靠；
 * 2. `g.__data__.payload.link` —— d3 expando，无 GT 时原生可用；
 * 3. 节点内 `.gkm-tag` 文本反查 linkByTag —— 纯组件内存态，任何 DOM 劫持都不影响。
 */
function attachNodeClick(svgEl: SVGSVGElement): () => void {
  const onClick = (e: MouseEvent): void => {
    const target = e.target as Element | null
    if (!target || typeof target.closest !== 'function') return
    // 折叠/展开圆圈点击放行给 Markmap 自身的 toggle 处理，绝不误触导航
    if (target.tagName.toLowerCase() === 'circle') return
    const g = target.closest('g.markmap-node')
    if (!g) return
    const bound = (g as unknown as { __data__?: BoundNodeData }).__data__
    const tagEl = g.querySelector('foreignObject .gkm-tag')
    const tag = tagEl ? (tagEl.textContent || '').trim() : ''
    const link =
      g.getAttribute('data-gkm-link') ||
      (typeof bound?.payload?.link === 'string' ? bound.payload.link : '') ||
      (tag ? linkByTag.get(tag) || '' : '')
    if (!link) return
    if (isFullscreen.value) closeFullscreen()
    router.go(withBase(link))
  }
  svgEl.addEventListener('click', onClick)
  return () => {
    svgEl.removeEventListener('click', onClick)
  }
}

/** 滚轮抑制：阻止 D3 zoom 与 markmap 捕获 wheel 并 preventDefault，放行整页原生顺畅滚动 */
function attachWheelSuppression(svgEl: SVGElement): () => void {
  const onWheelCapture = (e: WheelEvent): void => {
    // 阻止 D3 zoom 与 markmap 捕获 wheel 事件，保留拖拽、点击展开等，放行页面正常原生滚动
    e.stopImmediatePropagation()
  }
  svgEl.addEventListener('wheel', onWheelCapture, { capture: true, passive: true })
  return () => {
    svgEl.removeEventListener('wheel', onWheelCapture, { capture: true })
  }
}

let calibrateRaf: number | null = null

/**
 * 视口骨架高度与内容对称对齐自动校准：
 * 基于真实 DOM 节点盒精确物理测量，展开越多向下延展越长（最大 3200px），展开少自适应收缩变短（最小 420px）；
 * 彻底消除累积垂直留白与顶部悬空，并杜绝折叠时视角与字号重置跳跃。
 */
function autoCalibrateLayout(svgEl: SVGSVGElement, mm?: MindmapInstance | null, isInitial = false): void {
  if (isFullscreen.value) return
  if (typeof window === 'undefined') return
  if (!svgEl.isConnected) return

  if (calibrateRaf) cancelAnimationFrame(calibrateRaf)
  calibrateRaf = requestAnimationFrame(() => {
    try {
      const gEl = svgEl.querySelector('g')
      if (!gEl) return
      const b = gEl.getBBox()
      if (!b || b.width <= 0 || b.height <= 0) return

      // 防抖前置：若本组总讲数较多（> 5 讲），但测得 b.height 极小（< 100px），说明 Markmap DOM 仍在异步展开中，保留预估高度并排队重试
      if (groupLectures.value.length > 5 && b.height < 100) {
        setTimeout(() => autoCalibrateLayout(svgEl, mm, isInitial), 80)
        return
      }

      const containerWidth =
        svgEl.getBoundingClientRect().width ||
        (typeof window !== 'undefined' ? Math.min(1102, window.innerWidth - 32) : 1102)
      const availWidth = Math.max(320, containerWidth - 48)
      // 计算自适应缩放（上限 1.0，根据可用宽度适配，保底 0.72 确保字号绝对清晰可读）
      const targetScale = Math.min(1.0, Math.max(0.72, availWidth / b.width))

      const physicalHeight = b.height * targetScale
      const targetHeight = Math.round(physicalHeight + 80)
      const clampedHeight = Math.min(
        MAX_VIEWPORT_HEIGHT,
        Math.max(MIN_VIEWPORT_HEIGHT, targetHeight)
      )

      viewportHeight.value = clampedHeight

      // 如果高度小于最小视口高度（全折叠收拢态），垂直居中对齐；展开伸长时距顶 40px
      const idealTop = clampedHeight > targetHeight
        ? Math.round((clampedHeight - physicalHeight) / 2)
        : 40
      const translateY = idealTop - b.y * targetScale
      const translateX = 24 - b.x * targetScale

      // 施加定位至主 <g> 元素并同步 d3 __zoom，彻底消除裁剪与跳跃
      const transformStr = `translate(${translateX},${translateY}) scale(${targetScale})`
      gEl.setAttribute('transform', transformStr)

      const curZoom = (svgEl as unknown as { __zoom?: { k: number; x: number; y: number } }).__zoom
      if (curZoom) {
        curZoom.k = targetScale
        curZoom.x = translateX
        curZoom.y = translateY
      }
    } catch {}
  })
}

/** 监听折叠圆圈点击：节点折叠/展开带 280ms 动效，在动画开始和完成时触发骨架测量校准 */
function attachCircleClickListener(svgEl: SVGSVGElement, mm: MindmapInstance): () => void {
  const onSvgClick = (e: MouseEvent): void => {
    const target = e.target as Element | null
    if (!target) return
    if (target.tagName.toLowerCase() === 'circle') {
      requestAnimationFrame(() => {
        autoCalibrateLayout(svgEl, mm)
        stampLinks(svgEl)
      })
      setTimeout(() => {
        autoCalibrateLayout(svgEl, mm)
        stampLinks(svgEl)
      }, 150)
      setTimeout(() => {
        autoCalibrateLayout(svgEl, mm)
        stampLinks(svgEl)
      }, 320)
      setTimeout(() => {
        autoCalibrateLayout(svgEl, mm)
        stampLinks(svgEl)
      }, 500)
    }
  }
  svgEl.addEventListener('click', onSvgClick)
  return () => {
    svgEl.removeEventListener('click', onSvgClick)
  }
}

/** 监听 DOM 树变化（子树增删）：自动校准骨架高度与链接印章 */
function attachSvgObserver(svgEl: SVGSVGElement, mm: MindmapInstance): () => void {
  const obs = new MutationObserver(() => {
    autoCalibrateLayout(svgEl, mm)
    stampLinks(svgEl)
  })
  obs.observe(svgEl, { childList: true, subtree: true })
  return () => {
    obs.disconnect()
  }
}

/** 创建 Markmap 实例并灌入全量树（create → setData → fit）；引擎导入失败返回 null 由 UI 兜底 */
async function mountMindmap(svgEl: SVGSVGElement, isModal = false): Promise<MindmapHandle | null> {
  let Markmap: typeof import('markmap-view').Markmap
  try {
    const mod = await import('markmap-view')
    Markmap = mod.Markmap
  } catch {
    return null
  }
  // import 期间组件可能已卸载 / 弹层已关闭：svgEl 脱离文档则放弃挂载
  if (!svgEl.isConnected) return null
  rebuildLinkIndex()
  const mm = Markmap.create(svgEl, MARKMAP_OPTIONS)
  const detachClick = attachNodeClick(svgEl)
  // 关键：仅在内联普通视图下挂载滚轮抑制，放行页面正常滚动；全屏模式下绝不抑制滚轮，滚轮交互生效！
  const detachWheel = !isModal ? attachWheelSuppression(svgEl) : () => {}
  const detachCircleClick = !isModal ? attachCircleClickListener(svgEl, mm) : () => {}
  const detachObserver = !isModal ? attachSvgObserver(svgEl, mm) : () => {}
  await mm.setData(buildMindTree())
  if (isModal) {
    await mm.fit()
  } else {
    autoCalibrateLayout(svgEl, mm, true)
    setTimeout(() => autoCalibrateLayout(svgEl, mm), 120)
    setTimeout(() => autoCalibrateLayout(svgEl, mm), 320)
    setTimeout(() => autoCalibrateLayout(svgEl, mm), 600)
  }
  stampLinks(svgEl)
  return {
    mm,
    dispose: () => {
      detachWheel()
      detachClick()
      detachCircleClick()
      detachObserver()
      mm.destroy()
    }
  }
}

/**
 * 渲染入口：内联图与全屏弹层共用。
 *
 * 并发触发源：onMounted（loadNotionIndex → renderMindmap）+ deep watch([groupId, progressMap,
 * notionIndex]) → rerenderAll()。若不加单飞，这些调用会同时在 handle 赋值前进入 create。
 * 这里把真正的渲染动作排进该 svg 的串行链，并做洪峰合并（详见文件上方 renderQueues 注释）。
 */
function renderMindmap(modal: boolean): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  const container = modal ? modalChartRef.value : chartContainerRef.value
  const svgEl = modal ? modalSvgRef.value : inlineSvgRef.value
  if (!container || !svgEl) return Promise.resolve()
  // 暗黑样式同步切换（幂等），不等待渲染链
  container.classList.toggle('markmap-dark', isDark.value)
  const seq = (renderSeq.get(svgEl) ?? 0) + 1
  renderSeq.set(svgEl, seq)
  const prev = renderQueues.get(svgEl) ?? Promise.resolve()
  const run = prev.then(() => renderMindmapStep(modal, svgEl, seq))
  renderQueues.set(
    svgEl,
    run.then(
      () => {},
      () => {}
    )
  )
  return run.then(
    () => {},
    () => {}
  )
}

/** 单飞执行步：被更新请求取代的中间轮直接让位，否则真正渲染 */
async function renderMindmapStep(modal: boolean, svgEl: SVGSVGElement, seq: number): Promise<void> {
  // 排队期间又排入了更新的渲染请求（进度/暗黑/展开态变化）：本轮数据会被下一轮覆盖，让位
  if (renderSeq.get(svgEl) !== seq) return
  const handle = modal ? modalHandle : chartHandle
  if (handle) {
    await handle.mm.setData(buildMindTree())
    if (modal) {
      await handle.mm.fit()
    } else {
      autoCalibrateLayout(svgEl, handle.mm)
      setTimeout(() => autoCalibrateLayout(svgEl, handle.mm), 120)
      setTimeout(() => autoCalibrateLayout(svgEl, handle.mm), 320)
    }
    stampLinks(svgEl)
    return
  }
  mapLoadFailed.value = false
  const created = await mountMindmap(svgEl, modal)
  if (!created) {
    if (modal) closeFullscreen()
    else mapLoadFailed.value = true
    return
  }
  // await 期间组件可能卸载或弹层已关：ref 变更 / 卸载则销毁实例，绝不赋值 handle
  const stillCurrent = (modal ? modalSvgRef.value : inlineSvgRef.value) === svgEl
  if (unmounted || !stillCurrent) {
    created.dispose()
    return
  }
  if (modal) modalHandle = created
  else chartHandle = created
}

function rerenderAll(): void {
  void renderMindmap(false)
  if (isFullscreen.value) void renderMindmap(true)
}

function handleResetView(): void {
  const handle = isFullscreen.value ? modalHandle : chartHandle
  if (handle) {
    if (isFullscreen.value) {
      void handle.mm.fit()
    } else if (inlineSvgRef.value) {
      autoCalibrateLayout(inlineSvgRef.value, handle.mm, true)
    }
  }
}

/* ---------------------------------------------------------------------------
 * 全屏弹层 / 事件 / 暗黑模式
 * ------------------------------------------------------------------------- */

async function openFullscreen(): Promise<void> {
  if (modalBusy) return
  modalBusy = true
  try {
    isFullscreen.value = true
    if (typeof document !== 'undefined') {
      document.documentElement.classList.add('chart-modal-open')
    }
    await nextTick()
    await renderMindmap(true)
  } finally {
    modalBusy = false
  }
}

function closeFullscreen(): void {
  if (!isFullscreen.value) return
  isFullscreen.value = false
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('chart-modal-open')
  }
  const handle = modalHandle
  modalHandle = null
  handle?.dispose()
}

function toggleFullscreen(): void {
  if (isFullscreen.value) closeFullscreen()
  else void openFullscreen()
}

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isFullscreen.value) closeFullscreen()
}

/** resize 经 rAF 节流：同一帧内多次触发只重排一次，防抖动能雪崩 */
function handleResize(): void {
  cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    if (isFullscreen.value) {
      void modalHandle?.mm.fit()
    } else if (inlineSvgRef.value && chartHandle) {
      autoCalibrateLayout(inlineSvgRef.value, chartHandle.mm)
    }
  })
}

/** 暗黑模式：检测 <html>.dark 并同步容器 markmap-dark 类（内置 globalCSS 翻转变量） */
function syncDarkClass(): void {
  isDark.value = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  chartContainerRef.value?.classList.toggle('markmap-dark', isDark.value)
  modalChartRef.value?.classList.toggle('markmap-dark', isDark.value)
}

function startDarkObserver(): void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
  darkObserver = new MutationObserver(() => syncDarkClass())
  darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
}

watch(
  () => [props.groupId, props.progressMap, notionIndex.value] as const,
  () => {
    rerenderAll()
  },
  { deep: true }
)

onMounted(async () => {
  if (typeof window === 'undefined') return
  viewportHeight.value = estimateInitialHeight(groupLectures.value.length)
  syncDarkClass()
  startDarkObserver()
  // 监听注册必须早于首个 await：否则加载期卸载会 remove 先于 add，导致监听器永久泄漏
  window.addEventListener('resize', handleResize)
  window.addEventListener('keydown', handleKeydown)
  await loadNotionIndex()
  isLoading.value = false
  await nextTick()
  await renderMindmap(false)

  if (typeof ResizeObserver !== 'undefined' && chartContainerRef.value) {
    containerObserver = new ResizeObserver(() => {
      handleResize()
    })
    containerObserver.observe(chartContainerRef.value)
  }
})

onUnmounted(() => {
  unmounted = true
  cancelAnimationFrame(resizeRaf)
  if (calibrateRaf) cancelAnimationFrame(calibrateRaf)
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', handleResize)
    window.removeEventListener('keydown', handleKeydown)
    document.documentElement.classList.remove('chart-modal-open')
  }
  containerObserver?.disconnect()
  containerObserver = null
  darkObserver?.disconnect()
  darkObserver = null
  chartHandle?.dispose()
  modalHandle?.dispose()
  chartHandle = null
  modalHandle = null
})

</script>

<template>
  <div class="group-knowledge-map-card">
    <div class="map-card-header">
      <div class="header-left">
        <span class="map-icon" v-html="ICONS.network"></span>
        <h3 class="header-title">{{ groupId.toUpperCase() }} 知识脉络脑图</h3>
        <span class="sync-tag" title="讲次主表取自本组真实目录，状态与 Notion 学习节点知识图谱三态对齐">
          全量讲次 · Notion 三态对齐
        </span>
      </div>

      <div class="header-right">
        <div class="map-legend">
          <span class="lg-item"><i class="lg-dot dot-done"></i>已完成</span>
          <span class="lg-item"><i class="lg-dot dot-doing"></i>学习中</span>
          <span class="lg-item"><i class="lg-dot dot-none"></i>未开始</span>
        </div>

        <div class="progress-pill">
          <span class="p-done">{{ nodeStats.completed }} 已完成</span>
          <span class="p-div">/</span>
          <span class="p-total">{{ nodeStats.total }} 讲 ({{ nodeStats.percent }}%)</span>
        </div>

        <button type="button" class="map-tool-btn" title="居中复位视图" @click="handleResetView">
          <span v-html="ICONS.reset"></span>
        </button>

        <button
          type="button"
          class="map-tool-btn primary"
          title="全屏放大脑图（缩放 / 平移 / Esc 退出）"
          @click="toggleFullscreen"
        >
          <span v-html="ICONS.fullscreen"></span>
        </button>
      </div>
    </div>

    <!-- 视口高度按讲次数自适应（每讲约 26px 行距），markmap 在盒内自动 fit 整幅 -->
    <div class="map-viewport-wrapper" :style="{ height: `${viewportHeightCss}px` }">
      <div v-if="isLoading" class="map-loading-mask">
        <span class="loading-text">正在构筑知识全景脑图...</span>
      </div>
      <div v-else-if="mapLoadFailed" class="map-error-mask">
        脑图引擎加载失败，请刷新页面重试
      </div>
      <div ref="chartContainerRef" class="map-svg-host">
        <svg ref="inlineSvgRef" class="gkm-svg"></svg>
      </div>
    </div>

    <teleport to="body">
      <div v-if="isFullscreen" class="chart-modal map-modal" @click.self="closeFullscreen">
        <div class="chart-modal__panel" role="dialog" aria-modal="true" aria-label="全屏知识脉络脑图">
          <div class="chart-modal__bar">
            <span class="chart-modal__title">{{ groupId.toUpperCase() }} 知识脉络脑图 · 全量 {{ nodeStats.total }} 讲</span>
            <div class="chart-modal__ops">
              <button type="button" title="居中复位视图" @click="handleResetView">
                <span v-html="ICONS.reset"></span>
              </button>
              <button type="button" title="退出全屏（Esc）" @click="closeFullscreen">
                <span v-html="ICONS.minimize"></span>
              </button>
            </div>
          </div>
          <div class="chart-modal__stage">
            <div ref="modalChartRef" class="map-modal-canvas">
              <svg ref="modalSvgRef" class="gkm-svg"></svg>
            </div>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>
<style scoped>
.group-knowledge-map-card {
  margin: 20px 0 28px;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04);
}

.map-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  background: var(--vp-c-bg-elv);
  border-bottom: 1px solid var(--vp-c-divider);
  flex-wrap: wrap;
  gap: 12px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.map-icon {
  display: flex;
  color: var(--vp-c-brand-1);
}

.header-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.sync-tag {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-weight: 500;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.map-legend {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--vp-c-text-2);
}

.lg-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.lg-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.dot-done { background: #10b981; }
.dot-doing { background: #f59e0b; }
.dot-none { background: #94a3b8; }

.progress-pill {
  font-size: 12.5px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  font-family: var(--vp-font-family-mono, monospace);
  color: var(--vp-c-text-2);
}
.progress-pill .p-done {
  color: #10b981;
  font-weight: 600;
}
.progress-pill .p-div {
  margin: 0 3px;
  opacity: 0.5;
}

.map-tool-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.15s ease;
}
.map-tool-btn:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}
.map-tool-btn.primary {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  border-color: transparent;
}
.map-tool-btn.primary:hover {
  background: var(--vp-c-brand-1);
  color: #ffffff;
}

.map-viewport-wrapper {
  position: relative;
  width: 100%;
  min-height: 420px;
  background: var(--vp-c-bg);
  transition: height 0.22s ease;
}

/* markmap 宿主：暗色容器类（markmap-view 内置 globalCSS 依此类翻转文字/圆圈变量） */
.map-svg-host,
.map-modal-canvas {
  width: 100%;
  height: 100%;
  --gkm-tag-opacity: 0.78;
}
.map-svg-host.markmap-dark,
.map-modal-canvas.markmap-dark {
  --gkm-tag-opacity: 0.66;
}

/* Markmap 动态生成的 SVG/DOM 无 scoped 属性，须用 :deep 穿透 */
.gkm-svg {
  display: block;
  width: 100%;
  height: 100%;
}

:deep(.gkm-root) {
  font-size: 16px;
  font-weight: 700;
  color: #3b82f6;
  line-height: 1.4;
}

:deep(.gkm-stage) {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}

:deep(.gkm-dot) {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}
:deep(.gkm-dot--done) { background: #10b981; }
:deep(.gkm-dot--doing) { background: #f59e0b; }
:deep(.gkm-dot--none) { background: #94a3b8; }

:deep(.gkm-tag) {
  font-family: var(--vp-font-family-mono, monospace);
  font-size: 12.5px;
  font-weight: 600;
  opacity: var(--gkm-tag-opacity, 0.78);
  margin-right: 6px;
  vertical-align: middle;
  transition: color 0.16s ease, opacity 0.16s ease;
}

:deep(.gkm-lec) {
  font-size: 13.5px;
  font-weight: 500;
  vertical-align: middle;
  transition: color 0.16s ease, text-decoration 0.16s ease;
}

:deep(.gkm-jump-cue) {
  display: inline-block;
  margin-left: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--vp-c-brand-1, #3b82f6);
  opacity: 0.55;
  transition: transform 0.16s ease, opacity 0.16s ease;
  vertical-align: middle;
}

:deep(g.markmap-node[data-gkm-link]) {
  cursor: pointer;
}

:deep(g.markmap-node[data-gkm-link]:hover .gkm-lec) {
  color: var(--vp-c-brand-1, #3b82f6);
  text-decoration: underline;
  text-underline-offset: 3px;
}

:deep(g.markmap-node[data-gkm-link]:hover .gkm-tag) {
  color: var(--vp-c-brand-1, #3b82f6);
  opacity: 1;
}

:deep(g.markmap-node[data-gkm-link]:hover .gkm-jump-cue) {
  opacity: 1;
  transform: translate(2px, -2px);
}

:deep(circle) {
  cursor: pointer;
  transition: stroke-width 0.15s ease, r 0.15s ease;
}

:deep(circle:hover) {
  stroke-width: 2.4px;
}

.map-loading-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.6);
  z-index: 10;
  font-size: 12px;
  color: var(--vp-c-text-2);
}
:root.dark .map-loading-mask {
  background: rgba(24, 24, 27, 0.6);
}

.map-error-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: 12px;
  z-index: 10;
}
</style>
