<script setup lang="ts">
/**
 * GlobalCurriculumMap.vue — 站点首页「全站知识演进脑图」(ADR-032 · simple-mind-map 引擎)
 *
 * 核心设计与契约：
 * 1. 引擎：simple-mind-map（0.14.0-fix.3）经典思维导图布局（layout: 'mindMap'）——根节点居中，
 *    各课程大系按数组均分左右双翼均衡放射展开（前 ceil(N/2) 项左翼 / 其余项右翼，节点 data.dir 锁定），
 *    文字永远正向水平，彻底告别旧图表树状布局的极点墨团与文字倒置事故；
 * 2. 四层数据结构：根（根据 siteMeta.name / BRANDING 动态派生）→ 大系（组 ID · 标题）→ 阶段块（每 3~4 讲一块，
 *    阶段N (Lxx-Lyy)）→ 讲次叶子（Lxx · 标题，携带 link/status 自定义字段，点击跳转 lecturePath）。
 *    注意：课程数据中的阶段标题也包含 Lxx，点击行为必须只认叶子的显式 link，不能从标题猜路由；
 * 3. 数据真源：theme.value.groups（大系讲次目录，唯一来源 groups.mts + 目录扫描）+
 *    public/notion_knowledge_graph.json（节点状态真源，?v= 时间戳防缓存），
 *    本地进度由 ./ai/neonRepository 灌注（getAllProgressSync / initProgressFromNotionGraph），
 *    三态着色：已完成 #22C55E / 学习中 #F59E0B / 未开始 #94A3B8 / 项目实战 #EF4444；
 * 4. 交互契约：Search 插件关键词即时高亮、全展开/全折叠（execCommand EXPAND_ALL / UNEXPAND_ALL）、
 *    view.reset()+view.fit() 视角复位、98vw × 95vh 全屏漫游弹层（弹层内独立实例，关闭即销毁）；
 * 5. 默认智能展开（进度驱动）：大系/阶段任一级只要辖内存在「已完成/学习中」讲次（本地
 *    progress_all_map ∪ Notion 图谱真源复合判定）即默认展开对应分支，完全无进度的分支保持折叠；
 *    进度事件（ai:progress-changed）触发重挂载时按最新进度重建展开态；
 * 6. 视角自适应铁律：每次 node_tree_render_end（初始渲染 / 展开 / 折叠 / 进度重建）统一执行
 *    「getElRectInfo() 重测容器 rect → view.fit()」。库的 elRect 在构造时缓存一次且无
 *    ResizeObserver，fit 的平移公式用「实时 rbox − 缓存 elRect.left/top」做参照；首屏期间
 *    Web 字体与上方内容的布局漂移会让缓存参照失真 → 初始锚点偏离（线上「末端分支悬顶」根因）。
 *    首建实例前还 await document.fonts.ready，保证节点盒测量与初始 fit 都基于真实字体度量；
 * 7. 暗夜主题：该库内置主题注册表仅有 'default'，以构造期 themeConfig 覆写；因 setTheme 不会重算
 *    themeConfig 合并，暗色切换采用「MutationObserver 监听 dark 类 → 销毁旧实例并按对应
 *    themeConfig 重建」路径；
 * 8. 反回归硬契约：零 Emoji / 零 Dingbats 铁律；SSR 守卫（simple-mind-map 一律 await import
 *    动态加载，仅客户端 onMounted 后构造）；addEventListener 与 removeEventListener 严格对账。
 * 9. 导航双通道（DOM 改写免疫）：库 node_click 事件为主通道（实例 link 权威）；另在 Vue 稳定
 *    容器上挂事件委托兜底——svg.js 把 click 绑死在 g.smm-node 元素上，第三方 DOM 改写（Google
 *    翻译克隆子树）会连监听一起丢弃导致导航全废；委托按 text.smm-text-node-wrap 标签文本精确
 *    反查路由（讲次全文零重复），nodeClickHandled 标志防双跳，.smm-expand-btn 点击不导航；
 *    另有拖拽守卫（DRAG_THRESHOLD_PX）：按下与松手位移超阈值的平移手势不触发导航。
 */

import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRouter, useData, withBase } from 'vitepress'
import { BRANDING } from '../../site.config'
import { ICONS } from './ai/icons'
import {
  getAllProgressSync,
  initProgressFromNotionGraph,
  type ProgressStatus
} from './ai/neonRepository'

const router = useRouter()
const { theme } = useData()

/* ---------------------------------------------------------------------------
 * 0. simple-mind-map 实例契约（库无 TS 声明文件，按本组件实际用法收窄类型）
 * ------------------------------------------------------------------------- */
interface MindMapNodeLike {
  nodeData?: { data?: { link?: string } }
  getData?: (key: 'link') => unknown
}

interface MindMapInstance {
  // node_click 实际回调签名是 (node)：库对组、阶段与讲次统一发出，只有讲次带 link
  on(event: 'node_click', handler: (node: MindMapNodeLike | null) => void): void
  on(event: 'node_tree_render_end', handler: () => void): void
  /** Search 插件注册成功才存在（插件降级时为 undefined，调用方必须 ?. 短路） */
  search?: { search(text: string): void; endSearch(): void }
  execCommand(command: 'EXPAND_ALL' | 'UNEXPAND_ALL'): void
  view: {
    reset(): void
    /** getRbox 可选：传入滚动无关的 bbox 供 fit 计算基准（见 fitInstance 注释） */
    fit(getRbox?: () => { x: number; y: number; width: number; height: number } | undefined): void
  }
  resize(): void
  destroy(): void
}

type MindMapConstructor = new (opt: Record<string, unknown>) => MindMapInstance
/**
 * MindMap 类还带静态 `usePlugin`（库源码 index.js：`MindMap.usePlugin = (plugin, opt) => ...`）。
 * 该方法挂在 default 导出的类上，**模块命名空间里并不存在** —— 写 `lib.usePlugin(...)` 会抛
 * TypeError 并被 catch 成「脑图引擎加载失败」（2026-10-13 线上首页白屏根因，已修复）。
 */
type MindMapConstructorWithPlugin = MindMapConstructor & { usePlugin: (plugin: unknown) => void }

interface MindMapTreeNode {
  data: Record<string, unknown>
  children?: MindMapTreeNode[]
}

/* ---------------------------------------------------------------------------
 * 1. 视图状态与实例句柄
 * ------------------------------------------------------------------------- */
const chartContainerRef = ref<HTMLDivElement | null>(null)
const modalChartRef = ref<HTMLDivElement | null>(null)
let chartInstance: MindMapInstance | null = null
let modalChartInstance: MindMapInstance | null = null

const isFullscreen = ref(false)
const progressDict = ref<Record<string, ProgressStatus>>({})
const searchKeyword = ref('')
const isAllExpanded = ref(false)
/** 脑图引擎（simple-mind-map）动态导入失败标志：置位后以纯文字占位替代画布，绝不 console.* */
const mapLoadFailed = ref(false)

/* ---------------------------------------------------------------------------
 * 2. Notion 依赖图谱数据契约（节点状态真源）
 * ------------------------------------------------------------------------- */
interface NotionNode {
  nodeId: string
  title: string
  category: string
  groupId: string
  lectureId: string
  lecturePath: string
  status: string
  prerequisites: string[]
  subsequents: string[]
}

const notionNodes = ref<NotionNode[]>([])
const notionError = ref(false)

function normalizeNodes(raw: unknown): NotionNode[] {
  if (!Array.isArray(raw)) return []
  const out: NotionNode[] = []
  for (const item of raw as Array<Record<string, unknown>>) {
    if (!item || typeof item.nodeId !== 'string' || !item.nodeId) continue
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : []
    out.push({
      nodeId: item.nodeId,
      title: typeof item.title === 'string' && item.title ? item.title : item.nodeId,
      category: typeof item.category === 'string' && item.category ? item.category : '未分类',
      groupId: typeof item.groupId === 'string' ? item.groupId : '',
      lectureId: typeof item.lectureId === 'string' ? item.lectureId : '',
      lecturePath: typeof item.lecturePath === 'string' ? item.lecturePath : '',
      status: typeof item.status === 'string' ? item.status : '未开始',
      prerequisites: strArr(item.prerequisites),
      subsequents: strArr(item.subsequents)
    })
  }
  return out
}

async function loadNotionGraph(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const res = await fetch(`${withBase('/notion_knowledge_graph.json')}?v=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) {
      notionError.value = true
      return
    }
    const parsed = normalizeNodes(await res.json())
    notionNodes.value = parsed
    notionError.value = parsed.length === 0
  } catch {
    notionNodes.value = []
    notionError.value = true
  }
}

/* ---------------------------------------------------------------------------
 * 3. 三态着色与调色板
 * ------------------------------------------------------------------------- */
const STROKE_DONE = '#22C55E'
const STROKE_DOING = '#F59E0B'
const STROKE_NONE = '#94A3B8'
const STROKE_PROJECT = '#EF4444'

/** 现代高对比度默认调色板（无显式 accent 时按 index 取模轮换） */
const DEFAULT_PALETTE = [
  '#3B82F6', '#10B981', '#F59E0B', '#06B6D4', '#8B5CF6',
  '#EC4899', '#14B8A6', '#F97316', '#6366F1', '#84CC16',
  '#EF4444', '#A855F7', '#64748B'
]

/**
 * 动态获取课程组色标：
 * 优先读取课程组元信息中的 group.accent；若未指定，则根据 index 从默认调色板取模派生。
 */
function getGroupAccent(g: GroupMeta, index: number): string {
  if (g.accent && typeof g.accent === 'string' && g.accent.trim().length > 0) {
    return g.accent
  }
  const safeIdx = Math.max(0, index)
  return DEFAULT_PALETTE[safeIdx % DEFAULT_PALETTE.length]
}

function isProjectNode(n: NotionNode): boolean {
  return n.category.includes('项目实战') || n.groupId === '项目实战' || n.nodeId.startsWith('project_')
}

function liveStatus(n: NotionNode): ProgressStatus {
  const key = n.lectureId.toLowerCase()
  const fromMap = key ? progressDict.value[key] : undefined
  if (fromMap === '已完成' || fromMap === '学习中' || fromMap === '未开始') return fromMap
  if (n.status === '已完成' || n.status === '学习中') return n.status
  return '未开始'
}

function statusStroke(status: ProgressStatus): string {
  if (status === '已完成') return STROKE_DONE
  if (status === '学习中') return STROKE_DOING
  return STROKE_NONE
}

function statusFill(status: ProgressStatus, isDark: boolean): string {
  if (isDark) {
    if (status === '已完成') return 'rgba(34,197,94,0.16)'
    if (status === '学习中') return 'rgba(245,158,11,0.18)'
    return 'rgba(148,163,184,0.14)'
  }
  if (status === '已完成') return '#F0FDF4'
  if (status === '学习中') return '#FFFBEB'
  return '#F8FAFC'
}

/* ---------------------------------------------------------------------------
 * 4. 统计指标
 * ------------------------------------------------------------------------- */
const stats = computed(() => {
  const list = notionNodes.value
  let done = 0
  for (const n of list) {
    if (liveStatus(n) === '已完成') done += 1
  }
  const total = list.length
  const categoryCount = new Set(list.map((n) => n.category)).size
  return {
    total,
    done,
    categoryCount,
    percent: total > 0 ? Math.round((done / total) * 100) : 0
  }
})

const badgeText = computed(() => {
  if (stats.value.total > 0) {
    return `${stats.value.categoryCount} 类 · ${stats.value.total} 节点 · 全景知识体系`
  }
  const gList = themeGroups.value
  if (gList.length > 0) {
    const lTotal = gList.reduce((acc, g) => acc + (g.lectures?.length || 0), 0)
    return `${gList.length} 体系 · ${lTotal} 核心讲次 · 演进拓扑`
  }
  return '全景知识体系 · 演进拓扑'
})

/* ---------------------------------------------------------------------------
 * 5. 课程大系数据源（themeConfig.groups）与阶段分块
 * ------------------------------------------------------------------------- */
interface GroupLecture {
  n: number
  text: string
  link: string
}

interface GroupMeta {
  id: string
  dir: string
  title: string
  accent?: string
  lectures: GroupLecture[]
}

const themeGroups = computed<GroupMeta[]>(() => {
  const cfg = theme.value as { groups?: GroupMeta[] } | null
  return Array.isArray(cfg?.groups) ? cfg.groups : []
})

const notionNodeByLid = computed(() => {
  const map = new Map<string, NotionNode>()
  for (const n of notionNodes.value) {
    if (n.lectureId) {
      map.set(n.lectureId.toLowerCase(), n)
    }
  }
  return map
})

const CN_STAGE_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六']

/**
 * 把全量讲次切成「每组 3~4 讲」的阶段块：
 * 正常区间每块 3~4 讲；极小课程组（n <= 5）无法切出合规块，退化为单块。
 */
function chunkGroupLectures(lectures: GroupLecture[]): GroupLecture[][] {
  const n = lectures.length
  if (n === 0) return []
  if (n <= 5) return [lectures]
  const target = Math.ceil(n / 4)
  const base = Math.floor(n / target)
  const extra = n % target

  const out: GroupLecture[][] = []
  let cursor = 0
  for (let i = 0; i < target; i += 1) {
    const size = base + (i < extra ? 1 : 0)
    out.push(lectures.slice(cursor, cursor + size))
    cursor += size
  }
  return out.filter((c) => c.length > 0)
}

/* ---------------------------------------------------------------------------
 * 6. 双主题 themeConfig（库内置主题注册表仅有 'default'，须以 themeConfig 覆写）
 * ------------------------------------------------------------------------- */
const LIGHT_THEME_CONFIG = {
  backgroundColor: '#ffffff',
  lineColor: '#cbd5e1',
  lineWidth: 1.6,
  lineStyle: 'curve',
  node: { marginX: 44, marginY: 12 },
  expandBtnStyle: {
    color: '#64748b',
    fill: '#ffffff',
    strokeColor: '#94a3b8',
    fontColor: '#334155'
  }
}

const DARK_THEME_CONFIG = {
  backgroundColor: '#1b1b1f',
  lineColor: '#475569',
  lineWidth: 1.6,
  lineStyle: 'curve',
  node: { marginX: 44, marginY: 12 },
  expandBtnStyle: {
    color: '#94a3b8',
    fill: '#1e293b',
    strokeColor: '#475569',
    fontColor: '#e2e8f0'
  }
}

/* ---------------------------------------------------------------------------
 * 7. 脑图数据构筑（根 → 各大系 → 阶段块 → 讲次叶子）
 * ------------------------------------------------------------------------- */

function isDarkNow(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

/* ---------------------------------------------------------------------------
 * 7.5 默认智能展开（进度驱动）
 * ------------------------------------------------------------------------- */
/** 用户是否手动点过「展开/折叠」：置位后重挂载不再自动按进度改写展开态（尊重用户意图） */
let userToggledExpand = false
/** 各大系是否有进度（已完成/学习中任一讲次），构建数据树前计算 */
const groupsWithProgress = new Set<string>()

/**
 * 进度感知重算：以 progressDict（本地 progress_all_map ∪ Notion 真源复合结果，
 * 与 liveStatus 同源）为真源，标记「辖内任一讲次已完成/学习中」的大系。
 */
function computeProgressGroups(): void {
  groupsWithProgress.clear()
  const lids = new Set<string>()
  for (const g of themeGroups.value) {
    for (const l of g.lectures) {
      lids.add(`${g.id}-L${String(l.n).padStart(2, '0')}`.toLowerCase())
    }
  }
  for (const n of notionNodes.value) {
    if (!n.lectureId || !lids.has(n.lectureId.toLowerCase())) continue
    const st = liveStatus(n)
    if ((st === '已完成' || st === '学习中') && n.groupId) {
      groupsWithProgress.add(n.groupId.toUpperCase())
    }
  }
  // 兜底：progressDict 里可能存在 Notion 图谱之外的本地进度（如手工打卡）
  for (const [lid, st] of Object.entries(progressDict.value)) {
    if ((st === '已完成' || st === '学习中') && lids.has(lid.toLowerCase())) {
      groupsWithProgress.add(lid.split('-')[0].toUpperCase())
    }
  }
}

/** 该大系下第一个「含已完成/学习中讲次」的阶段块序号（无进度返回 -1） */
function firstActiveStageIndex(g: GroupMeta): number {
  const chunks = chunkGroupLectures(g.lectures)
  for (let i = 0; i < chunks.length; i += 1) {
    for (const l of chunks[i]) {
      const lecTag = `L${String(l.n).padStart(2, '0')}`
      const matched = notionNodeByLid.value.get(`${g.id}-${lecTag}`.toLowerCase())
      if (matched) {
        const st = liveStatus(matched)
        if (st === '已完成' || st === '学习中') return i
      }
      const local = progressDict.value[`${g.id}-${lecTag}`.toLowerCase()]
      if (local === '已完成' || local === '学习中') return i
    }
  }
  return -1
}

function buildMindMapData(): MindMapTreeNode {
  const dark = isDarkNow()
  const rootColor = dark ? '#1d4ed8' : '#2563eb'
  const rootTitle = (theme.value as any).siteMeta?.name || (theme.value as any).site?.title || BRANDING?.knowledgeMapRootTitle || '知识体系总览'
  const groups = themeGroups.value
  const leftWingCount = Math.ceil(groups.length / 2)
  return {
    data: {
      text: rootTitle,
      expand: true,
      fillColor: rootColor,
      color: '#ffffff',
      fontSize: 20,
      fontWeight: 'bold',
      borderRadius: 9,
      paddingX: 20,
      paddingY: 10,
      lineColor: rootColor,
      lineWidth: 2.2
    },
    children: groups.map((g, idx) => buildGroupNode(g, idx, idx < leftWingCount, dark))
  }
}

function buildGroupNode(g: GroupMeta, idx: number, isLeft: boolean, dark: boolean): MindMapTreeNode {
  const branchColor = getGroupAccent(g, idx)
  // 用户手动点过「展开/折叠」后，数据侧不再写死进度展开态：全开意图由 applyViewState
  // （EXPAND_ALL）恢复，折叠意图由 expand:false 保障——进度智能展开只服务首次进入。
  const hasProgress = !userToggledExpand && groupsWithProgress.has(g.id.toUpperCase())
  const activeStage = hasProgress ? firstActiveStageIndex(g) : -1
  const groupLink = `/${g.dir}/`
  return {
    data: {
      text: `${g.id} · ${g.title}`,
      link: groupLink,
      expand: hasProgress,
      dir: isLeft ? 'left' : 'right',
      fillColor: dark ? '#1e293b' : '#ffffff',
      color: dark ? '#e2e8f0' : '#1e293b',
      borderColor: dark ? '#475569' : '#cbd5e1',
      borderWidth: 1.8,
      borderRadius: 7,
      paddingX: 16,
      paddingY: 8,
      fontSize: 16.5,
      fontWeight: 'bold',
      lineColor: branchColor,
      lineWidth: 2
    },
    children: chunkGroupLectures(g.lectures).map((chunk, stageIdx) =>
      buildStageNode(g, chunk, stageIdx, stageIdx === activeStage, branchColor, dark)
    )
  }
}

function buildStageNode(
  g: GroupMeta,
  chunk: GroupLecture[],
  idx: number,
  expanded: boolean,
  branchColor: string,
  dark: boolean
): MindMapTreeNode {
  const startTag = `L${String(chunk[0].n).padStart(2, '0')}`
  const endTag = `L${String(chunk[chunk.length - 1].n).padStart(2, '0')}`
  const stageCn = CN_STAGE_NUM[idx] || String(idx + 1)
  return {
    data: {
      text: `阶段${stageCn} (${startTag}-${endTag})`,
      expand: expanded,
      fillColor: dark ? 'rgba(30, 41, 59, 0.85)' : '#f8fafc',
      color: dark ? '#94a3b8' : '#475569',
      borderColor: branchColor,
      borderWidth: 1.4,
      borderRadius: 6,
      paddingX: 13,
      paddingY: 6,
      fontSize: 14,
      fontWeight: 'bold',
      lineColor: branchColor,
      lineWidth: 1.5
    },
    children: chunk.map((l) => buildLectureNode(g, l, branchColor, dark))
  }
}

function buildLectureNode(
  g: GroupMeta,
  l: GroupLecture,
  branchColor: string,
  dark: boolean
): MindMapTreeNode {
  const lecturePath = l.link
  const lecTag = `L${String(l.n).padStart(2, '0')}`
  const lid = `${g.id}-${lecTag}`
  const matched = notionNodeByLid.value.get(lid.toLowerCase())
  const status: ProgressStatus = matched ? liveStatus(matched) : '未开始'
  const isProject = matched ? isProjectNode(matched) : false
  const tone = isProject ? STROKE_PROJECT : statusStroke(status)
  return {
    data: {
      text: `${lecTag} · ${l.text}`,
      link: lecturePath,
      fillColor: statusFill(status, dark),
      color: dark ? '#cbd5e1' : '#334155',
      borderColor: tone,
      borderWidth: 1.2,
      borderRadius: 5,
      paddingX: 12,
      paddingY: 6,
      fontSize: 13,
      lineColor: branchColor,
      lineWidth: 1.3
    }
  }
}

/* ---------------------------------------------------------------------------
 * 8. simple-mind-map 动态加载与实例生命周期（SSR 安全：仅客户端构造）
 * ------------------------------------------------------------------------- */
let mindMapCtor: MindMapConstructor | null = null
let unmounted = false

/** 引擎（simple-mind-map + Search 插件）动态导入；失败返回 null 由 UI 纯文字占位兜底 */
async function ensureMindMapLib(): Promise<MindMapConstructor | null> {
  if (typeof window === 'undefined') return null
  if (mindMapCtor) return mindMapCtor
  try {
    const lib = (await import('simple-mind-map')) as { default: MindMapConstructorWithPlugin }
    const searchPlugin = (await import('simple-mind-map/src/plugins/Search.js')) as {
      default: unknown
    }
    // usePlugin 是 MindMap 类的静态方法，必须取 lib.default.usePlugin；
    //    写成 lib.usePlugin（模块命名空间上没有该导出）会抛 TypeError 被 catch 成
    //    「脑图引擎加载失败」—— 2026-10-13 线上首页白屏根因。
    //    插件注册单独兜底：即便检索插件异常也只降级「无关键词高亮」，绝不拖垮整幅脑图。
    try {
      lib.default.usePlugin(searchPlugin.default)
    } catch {
      /* 检索插件降级：画布照常渲染，检索入口自然失效 */
    }
    mindMapCtor = lib.default
    return mindMapCtor
  } catch {
    mapLoadFailed.value = true
    return null
  }
}

/** 视口自适应骨架高度约束：展开越多向下延伸越长，展开少动态收缩，保证展开时完全展示 */
const MIN_VIEWPORT_HEIGHT = 620
const MAX_VIEWPORT_HEIGHT = 16000
const viewportHeight = ref<number>(880)

function createOptions(kind: 'inline' | 'modal' = 'inline'): Record<string, unknown> {
  const isModal = kind === 'modal'
  const dark = isDarkNow()
  return {
    layout: 'mindMap',
    theme: 'default',
    themeConfig: dark ? DARK_THEME_CONFIG : LIGHT_THEME_CONFIG,
    readonly: true,
    textAutoWrapWidth: 420,
    alwaysShowExpandBtn: true,
    expandBtnSize: 22,
    expandBtnStyle: {
      color: dark ? '#94a3b8' : '#64748b',
      fill: dark ? '#1e293b' : '#ffffff',
      strokeColor: dark ? '#475569' : '#cbd5e1'
    },
    // 点击全屏放大后滚轮交互生效（开启鼠标滚轮缩放漫游）；内联模式禁用滚轮缩放，放行页面正常原生滚动
    disableMouseWheelZoom: !isModal,
    mousewheelAction: isModal ? 'zoom' : null
  }
}

/** 本次点击是否已由库实例事件（node_click）完成导航：防止委托兜底重复跳转 */
let nodeClickHandled = false
/**
 * 拖拽守卫：库的平移是「内容跟手」（内容点始终跟随指针），从讲次节点按下、拖动后
 * mouseup 仍会命中同一节点 → 浏览器合成 click → 会被误判为点击而跳转（交互审计 X4 实测）。
 * 以 mousedown 原点与 click 坐标的距离 > DRAG_THRESHOLD_PX 判定为拖拽并抑制本次导航。
 * 标志在容器 click-capture 阶段对每个点击强制重算，不存在跨点击残留。
 */
const DRAG_THRESHOLD_PX = 8
let dragOrigin: { x: number; y: number } | null = null
let suppressNavThisClick = false

function handleNodeClick(node: MindMapNodeLike | null): void {
  if (suppressNavThisClick) return
  // simple-mind-map 对组、阶段与讲次都发出 node_click；只有讲次显式携带 link。
  // 严格读取 link 字段，不能从 Lxx 文本猜路由（阶段标题也包含 Lxx，会误跳）。
  const value = node?.nodeData?.data?.link ?? node?.getData?.('link')
  const link = typeof value === 'string' ? value : ''
  if (!link) return
  nodeClickHandled = true
  if (isFullscreen.value) closeFullscreen()
  router.go(withBase(link))
}

/** 节点完整标签文本 → link 反查表（讲次 + 课程组双源索引，满足点击组名跳转组页面的诉求） */
const navLinkByText = computed<Map<string, string>>(() => {
  const idx = new Map<string, string>()
  for (const g of themeGroups.value) {
    // 课程组节点文本映射至组主页
    idx.set(`${g.id} · ${g.title}`, `/${g.dir}/`)
    for (const l of g.lectures) {
      const lecTag = `L${String(l.n).padStart(2, '0')}`
      idx.set(`${lecTag} · ${l.text}`, l.link)
    }
  }
  return idx
})

/**
 * 事件委托兜底（DOM 改写免疫）：
 * simple-mind-map 用 svg.js 把 click 监听直接绑在每个 g.smm-node 元素上；第三方 DOM 改写
 * （如 Google 翻译克隆替换子树）会连监听一起丢掉 → 库事件静默死亡、导航全废（2026-10-13
 * 实测：克隆后点击完全无响应）。因此把导航改挂到 Vue 自有的稳定容器上做事件委托：
 * 克隆只换内部 <g>，容器与其中的 text.smm-text-node-wrap 标签元素全部幸存，
 * 点击冒泡到容器后按标签文本精确反查路由（讲次全文零重复，实测无歧义）。
 * 库事件正常时走 handleNodeClick（实例 link，权威）；nodeClickHandled 标志防止双跳。
 *
 * 注意：标签可能被换行——库对超过 textAutoWrapWidth（默认 500px）的标签按字符切行、
 *    渲染成多个 <text>（nodeCreateContents.js L250-303，行间不插字符）——
 *    必须按文档序拼接全部行的 textContent 才能无损还原完整标签，
 *    只取首行会让超宽标签讲次（实测 292 条中 ≥12 条 >650px）在克隆场景静默失效。
 * 注意：依赖库内部 DOM 契约（g.smm-node / text.smm-text-node-wrap / .smm-expand-btn），
 *    升级 simple-mind-map 后需回归本兜底（verify_gcm.mjs 有对应契约断言可扩展）。
 */
const navListeners = new WeakMap<HTMLElement, {
  down: (e: MouseEvent) => void
  capture: (e: MouseEvent) => void
  bubble: (e: MouseEvent) => void
}>()

function attachDelegatedNav(el: HTMLElement): void {
  if (typeof window === 'undefined') return
  detachDelegatedNav(el)
  const down = (event: MouseEvent): void => {
    dragOrigin = { x: event.clientX, y: event.clientY }
  }
  const capture = (event: MouseEvent): void => {
    // 每个点击先强制重算拖拽判定（无 mousedown 前置时 dragOrigin 为 null → 不抑制）
    suppressNavThisClick = Boolean(
      dragOrigin && Math.hypot(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y) > DRAG_THRESHOLD_PX
    )
    dragOrigin = null
    nodeClickHandled = false
  }
  const bubble = (event: MouseEvent): void => {
    if (suppressNavThisClick) return
    if (nodeClickHandled) return
    const target = event.target as Element | null
    if (!target || typeof target.closest !== 'function') return
    // 展开/收起按钮在 g.smm-node 内部，点按钮只折叠不导航
    if (target.closest('.smm-expand-btn')) return
    const group = target.closest('g.smm-node')
    if (!group) return
    // 超宽标签被换行成多个 <text>，按文档序拼接还原完整标签（见上方注释）
    const label = [...group.querySelectorAll('text.smm-text-node-wrap')]
      .map((t) => t.textContent ?? '')
      .join('')
      .trim()
    const link = navLinkByText.value.get(label)
    if (!link) return
    if (isFullscreen.value) closeFullscreen()
    router.go(withBase(link))
  }
  el.addEventListener('mousedown', down, true)
  el.addEventListener('click', capture, true)
  el.addEventListener('click', bubble)
  navListeners.set(el, { down, capture, bubble })
}

function detachDelegatedNav(el: HTMLElement): void {
  const entry = navListeners.get(el)
  if (!entry) return
  el.removeEventListener('mousedown', entry.down, true)
  el.removeEventListener('click', entry.capture, true)
  el.removeEventListener('click', entry.bubble)
  navListeners.delete(el)
}

/** 滚轮抑制（对账存储）：阻止 simple-mind-map 捕获 wheel 并 preventDefault，放行整页原生顺畅滚动 */
const wheelListeners = new WeakMap<HTMLElement, (e: WheelEvent) => void>()

function attachWheelSuppression(el: HTMLElement): void {
  if (wheelListeners.has(el)) return
  const onWheelCapture = (e: WheelEvent): void => {
    // 阻止 simple-mind-map 捕获到 wheel 事件，保留拖拽、点击展开等，放行页面正常原生滚动
    e.stopImmediatePropagation()
  }
  el.addEventListener('wheel', onWheelCapture, { capture: true, passive: true })
  wheelListeners.set(el, onWheelCapture)
}

function detachWheelSuppression(el: HTMLElement): void {
  const listener = wheelListeners.get(el)
  if (!listener) return
  el.removeEventListener('wheel', listener, { capture: true })
  wheelListeners.delete(el)
}

/** simple-mind-map 节点实例（渲染树遍历所需最小面） */
/** 新建实例后恢复用户的展开态与检索词 */
function applyViewState(instance: MindMapInstance): void {
  if (isAllExpanded.value) instance.execCommand('EXPAND_ALL')
  const keyword = searchKeyword.value.trim()
  if (keyword) instance.search?.search(keyword)
}

/**
 * 统一挂载入口：内联图与全屏弹层仅挂载容器与实例变量不同，其余逻辑逐字一致。
 * kind='inline' 挂载主画布；kind='modal' 挂载全屏弹层画布。
 */
let isUpdatingHeight = false
let calibrateRaf: number | null = null

/**
 * 防切顶与呼吸留白物理常数：
 * 1. 顶部呼吸留白必须严格维持在 48px ~ 64px 舒适区间；
 * 2. 测量全部节点包围盒时，断言最顶端节点 minT 与视口顶部绝对距离不得小于 MIN_SAFE_TOP (48px)；
 * 3. 无论默认展开多少大系，整幅脑图的垂直中心与水平中心始终自适应黄金居中。
 */
const SAFE_TOP_MARGIN = 56
const SAFE_BOTTOM_MARGIN = 56
const MIN_SAFE_TOP = 48
let isCalibrating = false

let initialFitPhase = 0
let needsRecenterOnNextRender = false

/**
 * 首次自适应布局与视口测量（闭合几何映射定理）：
 * 绝不使用 view.fit() 将脑图暴力缩小！
 * 守住字号不变契约（根 22px、大系 18px、阶段 15.5px、叶子 14.5px）：
 * 1. scale 保持黄金比例 1.0（仅当视口宽度受限时按宽度轻微自适应，底线 >= 0.85，高度绝不压缩 scale）；
 * 2. 测量节点树真实未缩放物理渲染高度，上下保留 SAFE_TOP_MARGIN (56px) 与 SAFE_BOTTOM_MARGIN (56px) 呼吸留白；
 * 3. 动态赋予容器对应的 viewportHeight，展开越多向下延展越长，展开少自适应收缩；
 * 4. 确保顶部最顶端节点 minT 严格锁定在 56px 安全呼吸距离，左右绝对对称居中。
 */
function performInitialFit(instance: MindMapInstance): void {
  if (isFullscreen.value) {
    fitInstance(instance)
    return
  }

  try {
    const el = chartContainerRef.value
    if (!el) return

    const mm = instance as unknown as {
      view: {
        scale: number
        x: number
        y: number
        transform: () => void
        emitEvent?: (type: string) => void
      }
      resize: () => void
      getElRectInfo?: () => void
    }

    const currScale = mm.view.scale || 1
    const currX = mm.view.x || 0
    const currY = mm.view.y || 0

    const nodes = [...el.querySelectorAll('g.smm-node')]
    if (nodes.length === 0) return

    const vpRect = el.getBoundingClientRect()

    let minT = Infinity
    let maxB = -Infinity
    let minL = Infinity
    let maxR = -Infinity

    for (const n of nodes) {
      const r = n.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        if (r.top < minT) minT = r.top
        if (r.bottom > maxB) maxB = r.bottom
        if (r.left < minL) minL = r.left
        if (r.right > maxR) maxR = r.right
      }
    }

    if (!isFinite(minT) || !isFinite(maxB) || !isFinite(minL) || !isFinite(maxR)) return

    // 转换至 SVG 绝对未缩放坐标系（脱离当前视图的平移与缩放）
    const minL_svg = (minL - vpRect.left - currX) / currScale
    const minT_svg = (minT - vpRect.top - currY) / currScale
    const maxR_svg = (maxR - vpRect.left - currX) / currScale
    const maxB_svg = (maxB - vpRect.top - currY) / currScale

    const unscaledWidth = maxR_svg - minL_svg
    const unscaledHeight = maxB_svg - minT_svg

    // 左右各预留 32px 留白
    const availableWidth = vpRect.width - 64

    // 宽度受限时精准自适应缩放，彻底消除横向溢出与裁切，保证脑图展开时 100% 完整展示！
    let targetScale = 1.0
    if (availableWidth > 0 && unscaledWidth > availableWidth) {
      targetScale = Math.min(1.0, availableWidth / unscaledWidth)
    }

    // 容器高度动态自适应：真实渲染高度 + 上下安全呼吸留白 (56px + 56px)
    const targetRenderedHeight = Math.round(unscaledHeight * targetScale)
    const targetRenderedWidth = Math.round(unscaledWidth * targetScale)
    const targetHeight = Math.round(targetRenderedHeight + SAFE_TOP_MARGIN + SAFE_BOTTOM_MARGIN)
    const clampedHeight = Math.min(
      MAX_VIEWPORT_HEIGHT,
      Math.max(MIN_VIEWPORT_HEIGHT, targetHeight)
    )

    // 1. 水平黄金对称居中
    const idealLeft = Math.round((vpRect.width - targetRenderedWidth) / 2)
    const newX = Math.round(idealLeft - targetScale * minL_svg)

    // 2. 顶部严格锁定在 SAFE_TOP_MARGIN (56px) 呼吸留白
    const idealTop = SAFE_TOP_MARGIN
    const newY = Math.round(idealTop - targetScale * minT_svg)

    mm.view.scale = targetScale
    mm.view.x = newX
    mm.view.y = newY
    mm.view.transform()
    mm.view.emitEvent?.('scale')
    mm.view.emitEvent?.('translate')

    const heightChanged = Math.abs(clampedHeight - viewportHeight.value) > 16
    viewportHeight.value = clampedHeight

    if (heightChanged) {
      setTimeout(() => {
        try {
          needsRecenterOnNextRender = true
          mm.resize?.()
          mm.getElRectInfo?.()
        } catch {}
      }, 380)
    }
  } catch {}
}

interface CalibrateOptions {
  reCenterHorizontal?: boolean
  smooth?: boolean
}

let activeTranslateRaf: number | null = null

/**
 * 平滑平移视图（easeOutCubic 缓动曲线，杜绝瞬移突变与视觉抖动）
 */
function smoothTranslate(
  instance: MindMapInstance,
  dx: number,
  dy: number,
  duration = 260
): void {
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
  if (activeTranslateRaf) cancelAnimationFrame(activeTranslateRaf)

  const mm = instance as unknown as {
    view?: {
      translateXY?: (x: number, y: number) => void
    }
  }
  if (!mm.view?.translateXY) return

  const startTime = performance.now()
  let prevProgress = 0

  function step(now: number) {
    const elapsed = now - startTime
    const progress = Math.min(1, elapsed / duration)
    // easeOutCubic: 1 - (1 - t)^3
    const ease = 1 - Math.pow(1 - progress, 3)
    const delta = ease - prevProgress
    prevProgress = ease

    mm.view?.translateXY?.(dx * delta, dy * delta)

    if (progress < 1) {
      activeTranslateRaf = requestAnimationFrame(step)
    } else {
      activeTranslateRaf = null
    }
  }

  activeTranslateRaf = requestAnimationFrame(step)
}

/**
 * 视口骨架高度与内容对称对齐自动校准（防抖动与零横向漂移核心引擎）：
 * 1. 基于真实 DOM 节点盒精确物理测量，展开越多向下延展越长（最大 3600px），展开少自适应收缩变短（最小 620px）；
 * 2. 测量全部节点包围盒时，断言最顶端节点 minT 必须与视口顶部保持至少 48px~64px 舒适的呼吸安全距离（绝对防切顶）；
 * 3. 局部讲义展开时坚决不横向重置（driftX = 0），保证用户点击的节点稳如泰山、不脱离光标；
 * 4. 配合 CSS 视口高度 0.38s 平滑过渡，彻底消灭展开讲义细节时的布局剧烈晃动。
 */
function autoCalibrateLayout(instance: MindMapInstance, opt?: CalibrateOptions): void {
  if (isFullscreen.value) return
  if (typeof window === 'undefined') return
  if (isCalibrating) return

  if (calibrateRaf) cancelAnimationFrame(calibrateRaf)
  calibrateRaf = requestAnimationFrame(() => {
    try {
      const el = chartContainerRef.value
      if (!el) return
      const nodes = [...el.querySelectorAll('g.smm-node')]
      if (nodes.length === 0) return

      let minT = Infinity
      let maxB = -Infinity
      let minL = Infinity
      let maxR = -Infinity

      for (const n of nodes) {
        const r = n.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          if (r.top < minT) minT = r.top
          if (r.bottom > maxB) maxB = r.bottom
          if (r.left < minL) minL = r.left
          if (r.right > maxR) maxR = r.right
        }
      }

      if (!isFinite(minT) || !isFinite(maxB) || !isFinite(minL) || !isFinite(maxR)) return

      const vpRect = el.getBoundingClientRect()
      const renderedHeight = maxB - minT
      const renderedWidth = maxR - minL
      const targetHeight = Math.round(renderedHeight + SAFE_TOP_MARGIN + SAFE_BOTTOM_MARGIN)
      const clampedHeight = Math.min(
        MAX_VIEWPORT_HEIGHT,
        Math.max(MIN_VIEWPORT_HEIGHT, targetHeight)
      )

      const availableWidth = vpRect.width - 64
      let scaleAdjusted = false
      const mm = instance as unknown as {
        view: { scale: number; transform: () => void }
        resize: () => void
      }
      const currScale = mm.view?.scale || 1
      const unscaledW = renderedWidth / currScale
      let targetScale = 1.0
      if (availableWidth > 0 && unscaledW > availableWidth) {
        targetScale = Math.min(1.0, Math.max(0.82, availableWidth / unscaledW))
      }
      // 双向自适应：收回时恢复至 1.0，展开受限时微调缩放
      if (Math.abs(targetScale - currScale) > 0.015) {
        mm.view.scale = targetScale
        mm.view.transform()
        scaleAdjusted = true
      }

      const deltaH = clampedHeight - viewportHeight.value

      if (Math.abs(deltaH) > 16) {
        isCalibrating = true
        viewportHeight.value = clampedHeight
        // 视口容器高度具有 0.38s 平滑 CSS 动效，等待过渡趋近稳定时触发 resize 与微调
        setTimeout(() => {
          try {
            mm.resize?.()
          } finally {
            isCalibrating = false
            calibratePosition(instance, { reCenterHorizontal: opt?.reCenterHorizontal !== false, smooth: true })
          }
        }, 360)
      } else {
        calibratePosition(instance, { reCenterHorizontal: opt?.reCenterHorizontal !== false, smooth: true })
      }
    } catch {}
  })
}

/**
 * 黄金中心对齐与防切顶硬性断言：
 * 1. 当 reCenterHorizontal 为 true 时（默认）：整幅脑图水平黄金居中，顶部锁定 56px 呼吸留白；
 * 2. 局部讲义展开/收起时（用户点击）：平滑自适应位移，收回时自动上浮归位，展开时防切顶与居中；
 * 3. 彻底根除“折叠收回后画布陷在下方回不来”与“多分支展开偏置横溢”的病灶。
 */
function calibratePosition(instance: MindMapInstance, opt?: CalibrateOptions): void {
  try {
    const el = chartContainerRef.value
    if (!el) return
    const nodes = [...el.querySelectorAll('g.smm-node')]
    if (nodes.length === 0) return

    const vpRect = el.getBoundingClientRect()
    let minT = Infinity
    let maxB = -Infinity
    let minL = Infinity
    let maxR = -Infinity

    for (const n of nodes) {
      const r = n.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        if (r.top < minT) minT = r.top
        if (r.bottom > maxB) maxB = r.bottom
        if (r.left < minL) minL = r.left
        if (r.right > maxR) maxR = r.right
      }
    }

    if (!isFinite(minT) || !isFinite(maxB) || !isFinite(minL) || !isFinite(maxR)) return

    const renderedHeight = maxB - minT
    const renderedWidth = maxR - minL
    const currentTop = minT - vpRect.top
    const currentLeft = minL - vpRect.left

    let driftX = 0
    let driftY = 0

    if (opt?.reCenterHorizontal !== false) {
      // 全量与局部自适应居中：整体包围盒始终水平居中，展开/收回均平滑微调
      const idealLeft = Math.round((vpRect.width - renderedWidth) / 2)
      driftX = idealLeft - currentLeft

      // 顶部始终锁定在 SAFE_TOP_MARGIN (56px) 呼吸留白处，折叠收回自动上浮归位，绝不下沉偏置
      const idealTop = SAFE_TOP_MARGIN
      driftY = idealTop - currentTop
    } else {
      // 边界微调保底
      if (minL < vpRect.left + 24) {
        driftX = Math.round(vpRect.left + 24 - minL)
      } else if (maxR > vpRect.right - 24) {
        driftX = Math.round(vpRect.right - 24 - maxR)
      } else {
        driftX = 0
      }

      if (currentTop < MIN_SAFE_TOP) {
        driftY = SAFE_TOP_MARGIN - currentTop
      } else {
        driftY = 0
      }
    }

    if (Math.abs(driftX) > 1 || Math.abs(driftY) > 1) {
      if (opt?.smooth !== false) {
        smoothTranslate(instance, driftX, driftY, 260)
      } else {
        const mm = instance as unknown as {
          view?: { translateXY?: (x: number, y: number) => void }
        }
        mm.view?.translateXY?.(driftX, driftY)
      }
    }
  } catch {}
}

async function mountMap(kind: 'inline' | 'modal'): Promise<void> {
  if (typeof window === 'undefined') return
  const MindMap = await ensureMindMapLib()
  const el = kind === 'modal' ? modalChartRef.value : chartContainerRef.value
  if (!MindMap || !el) return
  // await 期间组件可能卸载或弹层已关：超时挂载会留下孤儿实例，此处复检并放弃
  if (unmounted) return
  const prev = kind === 'modal' ? modalChartInstance : chartInstance
  if (prev) {
    prev.destroy()
    if (kind === 'modal') modalChartInstance = null
    else chartInstance = null
  }
  const instance = new MindMap({ el, data: buildMindMapData(), ...createOptions(kind) })
  instance.on('node_click', handleNodeClick)

  // 手风琴互斥收回与自适应对齐（Accordion Mutual Exclusion）：
  // 当展开某一大系或阶段分支时，自动收回同级兄弟分支，杜绝屏幕无限膨胀失焦；
  // 节点展开/折叠后触发自适应居中与高度调整
  instance.on('expand_btn_click', (node: any) => {
    try {
      if (isAllExpanded.value) {
        isAllExpanded.value = false
      }
      const isExpanded = node?.getData?.('expand') !== false
      if (isExpanded && node?.parent?.children) {
        // 大系节点（layerIndex === 1）或 阶段节点（layerIndex === 2）：互斥手风琴收回
        if (node.layerIndex === 1 || node.layerIndex === 2) {
          let hasCollapsed = false
          for (const sibling of node.parent.children) {
            if (sibling !== node && sibling.getData?.('expand') !== false) {
              if (sibling.nodeData?.data) {
                sibling.nodeData.data.expand = false
                hasCollapsed = true
              }
            }
          }
          if (hasCollapsed) {
            instance.render()
          }
        }
      }
      needsRecenterOnNextRender = true
    } catch {}
  })

  // 导航委托兜底：挂在 Vue 稳定容器上，DOM 改写（GT 克隆）后仍可跳转
  attachDelegatedNav(el)

  // 关键：仅在内联普通视图下挂载滚轮抑制，放行页面原生上下滚动；全屏下绝不抑制滚轮，让滚轮缩放生效！
  if (kind === 'inline') {
    attachWheelSuppression(el)
  }

  let initialFitDone = false
  let renderSettleTimer: ReturnType<typeof setTimeout> | null = null

  // 视角与骨架高度自适应：
  // 首次渲染执行 performInitialFit 闭合几何映射，锁定水平居中与 56px 呼吸留白；
  // 用户局部展开/折叠，自动手风琴收回兄弟分支，并自适应调整位置与高度；
  // 用户全量展开/折叠/复位，经防抖等全量节点排版稳定后执行 performInitialFit 重新铺满与居中
  instance.on('node_tree_render_end', () => {
    if (kind === 'modal') {
      fitInstance(instance)
      return
    }

    if (!initialFitDone) {
      initialFitDone = true
      performInitialFit(instance)
      return
    }

    if (renderSettleTimer) clearTimeout(renderSettleTimer)
    renderSettleTimer = setTimeout(() => {
      if (needsRecenterOnNextRender) {
        needsRecenterOnNextRender = false
        performInitialFit(instance)
      } else {
        autoCalibrateLayout(instance, { reCenterHorizontal: true, smooth: true })
      }
    }, 120)
  })
  if (kind === 'modal') modalChartInstance = instance
  else chartInstance = instance
  mapLoadFailed.value = false
  applyViewState(instance)
}

/**
 * 单实例视角自适应：先 getElRectInfo() 刷新缓存 rect（fit 的参照系），再 view.fit()。
 * getElRectInfo 在容器宽高为 0 时抛错（隐藏容器场景），catch 兜底跳过即可。
 *
 * 滚动偏移铁律（初始锚点错误根因 #1）：@svgdotjs/svg.js 的 rbox() 末尾 addOffset() 会把
 * window.pageXOffset/pageYOffset 加进内容 bbox，而 fit() 的平移公式用「rbox − elRect」，
 * elRect（getBoundingClientRect）不含滚动偏移——两者相减把 scrollY 直接灌进画布平移量。
 * 首页脑图在折叠线以下，用户点「展开」时页面已滚动数百 px，内容随即被平移出视口；
 * 折叠双翼最底端分支恰好悬到画布顶部（线上截图病灶）。
 * 因此给 fit() 传自定义 getRbox：取 draw.rbox() 后减掉窗口滚动偏移，统一到 elRect 同一
 * 视口坐标系。
 */
function fitInstance(instance: MindMapInstance): void {
  try {
    const mm = instance as unknown as {
      getElRectInfo?: () => void
      draw?: { rbox?: () => ({ x: number; y: number; width: number; height: number }) }
      view?: {
        fit: (getRbox?: () => { x: number; y: number; width: number; height: number }, enlarge?: boolean, fitPadding?: number) => void
      }
    }
    mm.getElRectInfo?.()
    if (!mm.draw?.rbox) throw new Error('draw.rbox unavailable')
    // 注意：fit() 内部会调用 getRbox() 两次（setScale 前后各一次，第二次用于计算平移），
    // 闭包每次被调用都必须实时重测，绝不能缓存单次测量值——否则第二次拿到缩放前的
    // 陈旧 bbox，平移量被污染且随展开/折叠逐次累积。
    instance.view.fit(() => {
      const r = mm.draw!.rbox!()
      const sx = typeof window !== 'undefined' ? window.pageXOffset : 0
      const sy = typeof window !== 'undefined' ? window.pageYOffset : 0
      return { x: r.x - sx, y: r.y - sy, width: r.width, height: r.height }
    }, false, 60)
  } catch {
    /* 容器不可见（宽高 0）或 rbox 获取失败：跳过重测，仅尝试默认 fit */
    try {
      instance.view.fit()
    } catch {
      /* fit 失败仅影响视角，不影响数据 */
    }
  }
}

function destroyModalMap(): void {
  if (modalChartInstance) {
    modalChartInstance.destroy()
    modalChartInstance = null
  }
  if (modalChartRef.value) {
    detachDelegatedNav(modalChartRef.value)
    detachWheelSuppression(modalChartRef.value)
  }
}

function toggleExpandAll(): void {
  isAllExpanded.value = !isAllExpanded.value
  userToggledExpand = true
  needsRecenterOnNextRender = true
  const command = isAllExpanded.value ? 'EXPAND_ALL' : 'UNEXPAND_ALL'
  for (const instance of [chartInstance, modalChartInstance]) {
    if (!instance) continue
    instance.execCommand(command)
  }
}

function resetView(): void {
  needsRecenterOnNextRender = true
  for (const instance of [chartInstance, modalChartInstance]) {
    if (!instance) continue
    instance.view.reset()
    // reset 只归零变换（scale=1/原点），不等于 fit：复位后重新适配铺满视口
    if (instance === chartInstance) {
      performInitialFit(instance)
    } else {
      fitInstance(instance)
    }
  }
}

/** 检索防抖定时器：避免每次击键都触发 Search 插件全文扫描 */
let searchTimer: ReturnType<typeof setTimeout> | null = null
/** 进度同步防抖定时器：多事件洪峰合并为一次重挂载 */
let progressTimer: ReturnType<typeof setTimeout> | null = null

watch(searchKeyword, (keyword) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    const text = keyword.trim()
    for (const instance of [chartInstance, modalChartInstance]) {
      if (!instance) continue
      if (text) instance.search?.search(text)
      else instance.search?.endSearch()
    }
  }, 180)
})

function openFullscreen(): void {
  isFullscreen.value = true
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('chart-modal-open')
  }
  nextTick(() => {
    void mountMap('modal')
  })
}

function closeFullscreen(): void {
  isFullscreen.value = false
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('chart-modal-open')
  }
  destroyModalMap()
}

/** resize 经 rAF 节流：同一帧内多次触发只重排一次，防抖动能雪崩 */
let resizeRaf = 0
function handleResize(): void {
  cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    chartInstance?.resize()
    modalChartInstance?.resize()
  })
}

function handleEscKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && isFullscreen.value) closeFullscreen()
}

/** 进度事件防抖：洪峰合并后按 awaited 串行重挂（先内联后弹层），避免实例竞争 */
function handleProgressSync(): void {
  progressDict.value = getAllProgressSync()
  if (progressTimer) clearTimeout(progressTimer)
  progressTimer = setTimeout(() => {
    void (async () => {
      // 进度变了 → 智能展开的数据源变了：用户没手动操作过展开/折叠时按最新进度重建分支
      if (!userToggledExpand) computeProgressGroups()
      await mountMap('inline')
      if (isFullscreen.value) await mountMap('modal')
    })()
  }, 150)
}

/* ---------------------------------------------------------------------------
 * 9. 暗夜主题：MutationObserver 监听 dark 类，销毁旧实例并按新 themeConfig 重建
 * ------------------------------------------------------------------------- */
let darkObserver: MutationObserver | null = null
let lastDarkState = false

function observeDarkMode(): void {
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return
  lastDarkState = isDarkNow()
  darkObserver = new MutationObserver(() => {
    if (isDarkNow() === lastDarkState) return
    lastDarkState = isDarkNow()
    void (async () => {
      await mountMap('inline')
      if (isFullscreen.value) await mountMap('modal')
    })()
  })
  darkObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class']
  })
}

/* ---------------------------------------------------------------------------
 * 10. 组件生命周期
 * ------------------------------------------------------------------------- */
async function initComponent(): Promise<void> {
  await loadNotionGraph()
  if (notionNodes.value.length > 0) {
    await initProgressFromNotionGraph()
    progressDict.value = getAllProgressSync()
  }
  // 智能展开数据源就绪：构建数据树前先算好「哪些大系有进度」
  computeProgressGroups()
  // 初始锚点修复：库的 elRect/节点盒测量都依赖当前布局与字体度量。
  // await document.fonts.ready 保证 Web 字体加载完成后再建实例，初始 fit 不再被
  // 回退字体度量与首屏布局漂移带偏（fonts.ready 不支持时静默跳过，不阻塞降级路径）。
  try {
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      await document.fonts.ready
    }
  } catch {
    /* 字体 API 不可用：照常挂载 */
  }
  if (unmounted) return
  await mountMap('inline')
}

onMounted(() => {
  if (typeof window === 'undefined') return
  window.addEventListener('resize', handleResize)
  window.addEventListener('keydown', handleEscKey)
  window.addEventListener('ai:progress-changed', handleProgressSync)

  progressDict.value = getAllProgressSync()
  void initComponent()
  observeDarkMode()
})

onUnmounted(() => {
  unmounted = true
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  if (progressTimer) {
    clearTimeout(progressTimer)
    progressTimer = null
  }
  cancelAnimationFrame(resizeRaf)
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', handleResize)
    window.removeEventListener('keydown', handleEscKey)
    window.removeEventListener('ai:progress-changed', handleProgressSync)
    document.documentElement.classList.remove('chart-modal-open')
  }
  if (darkObserver) {
    darkObserver.disconnect()
    darkObserver = null
  }
  if (chartInstance) {
    chartInstance.destroy()
    chartInstance = null
  }
  if (chartContainerRef.value) {
    detachDelegatedNav(chartContainerRef.value)
    detachWheelSuppression(chartContainerRef.value)
  }
  destroyModalMap()
})
</script>

<template>
  <section class="global-curriculum-map-card">
    <div class="gc-header">
      <div class="gc-left">
        <span class="gc-icon" v-html="ICONS.network"></span>
        <h2 class="gc-title">全站知识演进脑图</h2>
        <span class="gc-badge">{{ badgeText }}</span>
      </div>

      <div class="gc-right">
        <!-- 实时检索框：Search 插件即时高亮匹配节点 -->
        <div class="gc-search-box">
          <input
            v-model="searchKeyword"
            type="text"
            class="gc-search-input"
            placeholder="搜索讲义或知识点..."
          />
        </div>

        <!-- 一键全展开/全折叠 -->
        <button type="button" class="gc-action-btn" @click="toggleExpandAll">
          {{ isAllExpanded ? '折叠' : '展开' }}
        </button>

        <!-- 三态色标图例 -->
        <div class="gc-legend">
          <span class="legend-item"><span class="dot done"></span>已完成</span>
          <span class="legend-item"><span class="dot doing"></span>学习中</span>
          <span class="legend-item"><span class="dot none"></span>未开始</span>
          <span class="legend-item"><span class="dot project"></span>项目实战</span>
        </div>

        <div v-if="stats.total > 0" class="gc-progress-pill">
          <strong class="pill-highlight">{{ stats.done }}</strong>/ {{ stats.total }} 节点完成
          <span class="pill-percent">({{ stats.percent }}%)</span>
        </div>

        <button type="button" class="gc-icon-btn" title="复位缩放与视角" @click="resetView">
          <span v-html="ICONS.reset"></span>
        </button>

        <button type="button" class="gc-icon-btn" title="全屏查看图谱" @click="openFullscreen">
          <span v-html="ICONS.fullscreen"></span>
        </button>
      </div>
    </div>

    <!-- 脑图物理视口（simple-mind-map 画布挂载点，高度自适应骨架动态延展） -->
    <div class="gc-viewport" :style="{ height: viewportHeight + 'px' }">
      <div v-if="mapLoadFailed" class="gc-map-error-mask">
        脑图引擎加载失败，请刷新页面重试
      </div>
      <div ref="chartContainerRef" class="gc-chart-body"></div>
    </div>

    <!-- 全屏模态弹层：98vw × 95vh 沉浸式漫游，弹层内独立实例 -->
    <Teleport to="body">
      <div v-if="isFullscreen" class="map-modal-mask" @click.self="closeFullscreen">
        <div class="map-modal-container">
          <div class="map-modal-header">
            <div class="modal-title-wrap">
              <span class="gc-icon" v-html="ICONS.network"></span>
              <span class="modal-title">全景工程知识体系演进脑图</span>
              <span class="gc-badge">{{ badgeText }}</span>
            </div>
            <div class="modal-actions">
              <button type="button" class="modal-close-btn" title="关闭全屏" @click="closeFullscreen">
                <span v-html="ICONS.close"></span>
              </button>
            </div>
          </div>
          <div class="map-modal-body">
            <div ref="modalChartRef" class="map-modal-canvas"></div>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.global-curriculum-map-card {
  position: relative;
  margin: 16px 0 36px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-border);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 4px 24px -4px rgba(0, 0, 0, 0.07);
}

.gc-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  background: var(--vp-c-bg);
  border-bottom: 1px solid var(--vp-c-border);
}

.gc-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.gc-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-brand-1);
}

.gc-icon :deep(svg) {
  width: 20px;
  height: 20px;
}

.gc-title {
  margin: 0;
  padding: 0;
  border: none;
  font-size: 17px;
  font-weight: 700;
  color: var(--vp-c-text-1);
  letter-spacing: -0.01em;
}

.gc-badge {
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  padding: 3px 10px;
  border-radius: 999px;
  white-space: nowrap;
}

.gc-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.gc-search-box {
  position: relative;
}

.gc-search-input {
  width: 170px;
  height: 32px;
  padding: 0 12px;
  font-size: 13.5px;
  background: var(--vp-c-bg-mute, var(--vp-c-bg-alt));
  border: 1px solid var(--vp-c-border);
  border-radius: 8px;
  color: var(--vp-c-text-1);
  outline: none;
  transition: all 0.25s cubic-bezier(0.25, 1, 0.5, 1);
}

.gc-search-input:focus {
  width: 220px;
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
  box-shadow: 0 0 0 3px var(--vp-c-brand-soft), 0 2px 8px rgba(0, 0, 0, 0.05);
}

.gc-action-btn {
  padding: 5px 14px;
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-mute, var(--vp-c-bg-alt));
  border: 1px solid var(--vp-c-border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.25, 1, 0.5, 1);
  user-select: none;
}

.gc-action-btn:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.06);
}

.gc-action-btn:active {
  transform: translateY(0) scale(0.96);
  transition-duration: 0.08s;
}

.gc-legend {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--vp-c-text-2);
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: opacity 0.2s ease, transform 0.2s ease;
  cursor: default;
}

.legend-item:hover {
  transform: translateY(-1px);
}

.legend-item:hover .dot {
  transform: scale(1.3);
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.dot.done {
  background: #22c55e;
}

.dot.doing {
  background: #f59e0b;
}

.dot.none {
  background: #94a3b8;
}

.dot.project {
  background: #ef4444;
}

.gc-progress-pill {
  font-size: 13px;
  font-weight: 500;
  padding: 4px 14px;
  background: var(--vp-c-bg-mute, var(--vp-c-bg-alt));
  border: 1px solid var(--vp-c-border);
  border-radius: 999px;
  color: var(--vp-c-text-2);
  transition: all 0.2s ease;
}

.gc-progress-pill:hover {
  border-color: rgba(34, 197, 94, 0.4);
  background: rgba(34, 197, 94, 0.08);
}

.pill-highlight {
  color: #22c55e;
  font-weight: 700;
}

.pill-percent {
  font-size: 11px;
  color: var(--vp-c-text-3);
  margin-left: 2px;
}

.gc-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--vp-c-border);
  border-radius: 8px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.25, 1, 0.5, 1);
}

.gc-icon-btn:hover {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  transform: translateY(-1px) scale(1.06);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.06);
}

.gc-icon-btn:active {
  transform: translateY(0) scale(0.92);
  transition-duration: 0.08s;
}

.gc-icon-btn :deep(svg) {
  width: 14px;
  height: 14px;
}

/* ---------------------------------------------------------------------------
 * 脑图交互动效体系 (ADR-033 · 动态微交互与平滑流转契约 · SVG 命中测试安全规范)
 * ------------------------------------------------------------------------- */
:deep(g.smm-node) {
  cursor: pointer;
  transition: filter 0.18s cubic-bezier(0.25, 1, 0.5, 1);
}

:deep(g.smm-node:hover) {
  filter: brightness(1.06) drop-shadow(0 3px 12px rgba(37, 99, 235, 0.22));
}

.dark :deep(g.smm-node:hover) {
  filter: brightness(1.15) drop-shadow(0 3px 14px rgba(59, 130, 246, 0.38));
}

/* 展开收起按钮微交互：杜绝 CSS transform 与 transform-box 破坏 SVG 命中测试，采用稳妥的滤镜微动效 */
:deep(.smm-expand-btn) {
  cursor: pointer;
  pointer-events: all;
  transition: filter 0.18s ease;
}

:deep(.smm-expand-btn circle) {
  pointer-events: all;
  transition: stroke 0.18s ease, fill 0.18s ease;
}

:deep(.smm-expand-btn:hover) {
  filter: brightness(1.12) drop-shadow(0 0 6px rgba(37, 99, 235, 0.45));
}

:deep(.smm-expand-btn:active) {
  filter: brightness(0.92);
}

.dark :deep(.smm-expand-btn:hover) {
  filter: brightness(1.2) drop-shadow(0 0 8px rgba(59, 130, 246, 0.6));
}

/* 脑图画布视口高度（动态自适应骨架，向下延展与收缩，0.38s 平滑过渡无抖动） */
.gc-viewport {
  position: relative;
  width: 100%;
  min-height: 560px;
  background: var(--vp-c-bg);
  transition: height 0.38s cubic-bezier(0.25, 1, 0.5, 1);
  will-change: height;
}

.gc-chart-body {
  width: 100%;
  height: 100%;
}

.gc-map-error-mask {
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

.map-modal-canvas {
  width: 100%;
  height: 100%;
}

/* 全屏模态：98vw × 95vh */
.map-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.map-modal-container {
  width: 98vw;
  height: 95vh;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-border);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.25);
}

.map-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-border);
}

.modal-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.modal-title {
  font-size: 15.5px;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.modal-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.modal-close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--vp-c-border);
  border-radius: 7px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.16s ease;
}

.modal-close-btn:hover {
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-mute, var(--vp-c-bg-alt));
}

.modal-close-btn :deep(svg) {
  width: 16px;
  height: 16px;
}

.map-modal-body {
  flex: 1;
  position: relative;
  width: 100%;
  height: 100%;
}
</style>
