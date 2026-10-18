import { defineConfig } from 'vitepress'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KCONFIG, MATH, IOS, LD } from './grammars.mts'
import { mathPlugin } from './math.mts'
// 讲义导出插件：dev server 下的「按需导出」中间件（长卷 PDF / 全景长图 / A4 PDF）。
// ⚠️ 它只在 **dev** 生效；生产构建时其 apply='serve' 自会跳过，不影响静态产物。
import { lectureExportPlugin } from './plugins/lectureExportPlugin.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const docsRoot = path.resolve(here, '..')
const chartsRoot = path.join(docsRoot, 'public', 'charts')

/**
 * ──────────────────────────────────────────────────────────────────────────
 * 课程组元信息的优先级解析（多内容源接入策略）
 * ──────────────────────────────────────────────────────────────────────────
 * 设计目标：引擎与业务内容元信息物理彻底解耦，支持通用示例、自定义本地与插拔式挂载三种形态。
 *
 * 候选来源按优先级排序，取第一个存在的来源加载：
 *   1. `content-groups.mts` —— 由 `scripts/mount_content.py` 挂载外部内容源时生成。
 *      优先级最高：显式挂载的内容源优先于本地配置文件。
 *   2. `groups.mts`         —— 本地定制化课程组定义（被 .gitignore 排除，不提交至版本库）。
 *   3. `groups.example.mts` —— 引擎内置的结构示例与通用占位课件，作为开箱即用的默认兜底配置。
 *
 * 为什么用「existsSync + 动态 import()」而不是静态 import：
 *   静态 import 的路径在解析期就写死了，文件不存在 → 模块解析失败 → 构建直接挂。
 *   动态 import 的路径是**运行期表达式**，可以先用 existsSync 探测再决定加载谁。
 *
 * 为什么不用「顶层 await + 静态 import」：
 *   `import()` 是动态的，本来就必须 await；而本文件的 await 只在
 *   `resolveGroups()` 这个 async 函数内部，模块顶层并没有 await，
 *   所以不存在「顶层 await 在 esbuild 打包成临时 .mjs 后语义变化」的风险。
 *
 * ⚠️ 为什么**不能**依赖「静态 import 放在 try/catch 里」做回退：
 *   `import ... from` 是静态声明，**必须**出现在模块顶层，放不进 try 块（语法错误）；
 *   而 `import()` 失败（文件缺失时抛 ERR_MODULE_NOT_FOUND）虽然可以 catch，
 *   但路径仍须是运行期表达式才能探测存在性 —— 于是「existsSync 先探、import() 后取」
 *   是最直白也最可读的形态，且失败路径完全不依赖异常。
 */

/**
 * `defineConfig` 支持三种导出形态：对象、同步函数、**async 函数**。
 *
 * 这里必须用 async 函数，因为 `resolveGroups()` 内部要对候选文件做 `await import()`。
 * 已查证 VitePress **1.6.4** 的实际实现（不是猜的）：
 *   · `vitepress/dist/node/chunk-D3CUZ4fa.js` 的 `resolveUserConfig()` 返回
 *       `[await resolveConfigExtends(userConfig), ...]`；
 *   · `resolveConfigExtends(config)` 第一行即
 *       `const resolved = await (typeof config === "function" ? config() : config)`
 *     —— 默认导出只要是**函数**就会被 await 调用，返回 Promise 完全合法。
 *   · Vite 侧同构：`loadConfigFromFile()` 里
 *       `const config = await (typeof userConfig === "function" ? userConfig(configEnv) : userConfig)`
 *   于是 `export default async () => defineConfig({...})` 是受支持的官方形态，
 *   而不是「碰巧能跑」。`defineConfig()` 本身是恒等函数（签名放行对象与函数），
 *   包一层不改变类型，只是把返回类型放宽为 Promise。
 */
type GroupsModule = {
  GROUPS?: unknown
  GROUP_META?: unknown
  SITE_META?: unknown
  SITE_FEATURES?: unknown
}

/** 引擎兜底文案：即使 `groups.example.mts` 也被删掉，站点仍要立得起来。 */
const FALLBACK_SITE_META = {
  name: '可交互工程讲义',
  text: '可交互工程讲义库',
  tagline: '引擎已就绪 —— 但没有找到任何课程组定义',
} as const

/**
 * 讲义源存在性检测与示例互斥隔离 (Dynamic Content Detection & Exclusive Isolation)
 * ──────────────────────────────────────────────────────────────────────────
 * 运行机制：
 *   1. 【未接入自定义讲义时（开箱即用/默认状态）】：
 *      引擎加载 examples/ 演示体系（G01~G06），作为开箱即用的结构样板与功能展示；
 *   2. 【已接入自定义讲义时（通过 mount 挂载或配置 groups.mts）】：
 *      - 引擎自动切换为自定义讲义模式，不加载 examples 演示体系；
 *      - 启用 `srcExclude: ['examples/**']`，使得 examples 目录下的 Markdown
 *        完全不参与编译构建、不生成 HTML 静态页、不注入本地搜索索引；
 *      - 顶栏下拉导航（nav）、左侧大纲侧边栏（sidebar）、全站知识脑图（themeConfig.groups）
 *        100% 呈现用户自定义的课程体系，实现内容完全隔离。
 *
 * 判定依据（满足以下任一条件，即视为自定义讲义已接入）：
 *   · 存在外部挂载课程组定义：`content-groups.mts`（由 mount_content.py 产生）
 *   · 存在本地自定义课程组定义：`groups.mts`
 *   · 存在挂载状态记录文件：`docs/.content-mount.json`
 *   · `docs/` 目录下存在除保留系统目录外、包含实际讲义的课程目录（包含 `L*.md` 或 `index.md`）
 */
function inspectContentState() {
  const hasContentGroups = fs.existsSync(path.join(here, 'content-groups.mts'))
  const hasLocalGroups = fs.existsSync(path.join(here, 'groups.mts'))
  const hasMountJson = fs.existsSync(path.join(docsRoot, '.content-mount.json'))

  // 扫描 docsRoot 下除保留系统目录外的业务课程子目录
  const reservedDirs = new Set(['examples', 'public', '.vitepress', 'node_modules', 'dist', 'cache', '.temp'])
  const detectedDirs: string[] = []

  if (fs.existsSync(docsRoot)) {
    for (const ent of fs.readdirSync(docsRoot, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue
      if (reservedDirs.has(ent.name)) continue
      const subDir = path.join(docsRoot, ent.name)
      try {
        const stat = fs.statSync(subDir)
        if (!stat.isDirectory()) continue
        const files = fs.readdirSync(subDir)
        if (files.some((f) => /^L\d+\.md$/.test(f) || f === 'index.md')) {
          detectedDirs.push(ent.name)
        }
      } catch {
        // 忽略异常目录
      }
    }
  }

  const hasCustomLectures = hasContentGroups || hasLocalGroups || hasMountJson || detectedDirs.length > 0
  return {
    hasCustomLectures,
    hasContentGroups,
    hasLocalGroups,
    hasMountJson,
    detectedDirs,
  }
}

async function resolveGroups() {
  const state = inspectContentState()
  const tried: string[] = []

  // 场景 A: 检测到自定义讲义已存在，进入「自定义讲义独占模式」（examples 绝不加载）
  if (state.hasCustomLectures) {
    const personalCandidates = [
      { file: 'content-groups.mts', desc: '挂载的内容源（scripts/mount_content.py 产生）' },
      { file: 'groups.mts', desc: '本地自定义课程组定义' },
    ] as const

    for (const cand of personalCandidates) {
      const abs = path.join(here, cand.file)
      if (!fs.existsSync(abs)) {
        tried.push(`${cand.file}（不存在）`)
        continue
      }
      const mod = (await loadTsModule(abs)) as GroupsModule
      const groups = (mod.GROUPS ?? mod.GROUP_META) as GroupMetaLike[] | undefined
      if (!Array.isArray(groups)) {
        tried.push(`${cand.file}（存在但未导出 GROUPS / GROUP_META 数组）`)
        continue
      }
      console.log(`[groups] 🎯 检测到自定义讲义已载入：来源 = ${cand.file} —— ${cand.desc}（${groups.length} 组）。内置示例（examples）已自动禁用。`)
      return {
        hasCustomLectures: true,
        GROUPS: groups,
        SITE_META: (mod.SITE_META as typeof FALLBACK_SITE_META) ?? FALLBACK_SITE_META,
        SITE_FEATURES: (mod.SITE_FEATURES as { title: string; details: string }[]) ?? [],
      }
    }

    // 若存在课程目录但尚未编写 groups.mts / content-groups.mts：自动由目录推导，杜绝回退到 examples
    if (state.detectedDirs.length > 0) {
      console.log(`[groups] 🎯 检测到未配置元信息的自定义讲义目录（${state.detectedDirs.join(', ')}），正在自动生成课程组定义... 内置示例（examples）已自动禁用。`)
      const autoGroups: GroupMetaLike[] = state.detectedDirs.map((dir, idx) => {
        const id = dir.toUpperCase()
        const indexPath = path.join(docsRoot, dir, 'index.md')
        let title = dir
        if (fs.existsSync(indexPath)) {
          const t = readTitle(fs.readFileSync(indexPath, 'utf-8'))
          if (t) title = t
        }
        return {
          id,
          dir,
          title,
          tagline: `课程体系 · ${title}`,
          summary: `该组包含 ${dir} 系列课程讲义。`,
          accent: ['#6366F1', '#EC4899', '#10B981', '#F59E0B', '#3B82F6', '#8B5CF6'][idx % 6],
          tags: [id, '课程体系'],
        }
      })
      return {
        hasCustomLectures: true,
        GROUPS: autoGroups,
        SITE_META: FALLBACK_SITE_META,
        SITE_FEATURES: [],
      }
    }

    console.warn(
      `[groups] ⚠️ 检测到自定义讲义标记，但未找到有效课程组定义，尝试过：\n  - ${tried.join('\n  - ')}`
    )
    return { hasCustomLectures: true, GROUPS: [] as GroupMetaLike[], SITE_META: FALLBACK_SITE_META, SITE_FEATURES: [] }
  }

  // 场景 B: 未检测到外部自定义讲义，加载引擎内置通用演示示例（examples/g01~g06）
  const exampleFile = 'groups.example.mts'
  const exampleAbs = path.join(here, exampleFile)
  if (fs.existsSync(exampleAbs)) {
    const mod = (await loadTsModule(exampleAbs)) as GroupsModule
    const groups = (mod.GROUPS ?? mod.GROUP_META) as GroupMetaLike[] | undefined
    if (Array.isArray(groups)) {
      console.log(`[groups] 💡 当前未检测到外部自定义讲义，加载引擎内置通用示例（${exampleFile}，${groups.length} 组）作为结构样板`)
      return {
        hasCustomLectures: false,
        GROUPS: groups,
        SITE_META: (mod.SITE_META as typeof FALLBACK_SITE_META) ?? FALLBACK_SITE_META,
        SITE_FEATURES: (mod.SITE_FEATURES as { title: string; details: string }[]) ?? [],
      }
    }
  }

  // 兜底状态：三者全无
  console.warn(`[groups] ⚠️ 未找到任何课程组来源，回退为空站点（无课程组）`)
  return { hasCustomLectures: false, GROUPS: [] as GroupMetaLike[], SITE_META: FALLBACK_SITE_META, SITE_FEATURES: [] }
}

/**
 * 加载一个 TypeScript 模块（`.mts`）并返回其导出，**跨 Node 版本可用**。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 为什么不能直接 `import()` 一个 `.mts` 文件（2026-10-15 CI 事故的真实教训）
 * ──────────────────────────────────────────────────────────────────────────
 * 早期实现是 `await import(pathToFileURL(abs).href)`。但在部分跨平台环境下，
 * 但在 **Node 20 的 CI 上构建直接失败**：
 *
 *     TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".mts"
 *       for /home/runner/work/.../site/docs/.vitepress/groups.example.mts
 *
 * 根因：**Node 是否认识 `.mts` 扩展名取决于版本** ——
 *   · 高版本 Node：原生支持直接 import `.mts`
 *   · Node 20（CI）：不认识 `.mts` → 抛 ERR_UNKNOWN_FILE_EXTENSION
 * 于是形成最坏的一类「假绿」：本地怎么测都没事，推上去 CI 必红。
 *
 * （这与 AGENTS.md §6.4 记载的 `pathToFileURL` 事故是**同一模式**：
 *   用「本机恰好支持」的路径加载方式，把版本/平台差异留到了 CI 才暴露。）
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 修法：先用 esbuild 把 TS 转成 JS，再以 `data:` URL 导入
 * ──────────────────────────────────────────────────────────────────────────
 *  · `esbuild` 是 Vite 的既有依赖（`site/node_modules/esbuild` 必然存在），
 *    **不引入任何新依赖**；
 *  · 转成 JS 后就是普通 ESM，Node 20/22/24/26 都能 import；
 *  · 用 `data:text/javascript;base64,...` 而非临时文件：**不落盘**，
 *    因此不存在「写盘根/写系统临时目录」的污染风险，也没有并发构建时的文件名冲突
 *    （本仓库有两类真实事故：污染 G:\ 盘根、并发构建互踩临时文件）。
 *
 * 为什么不用「把 .mts 改名为 .mjs」这条更省事的路：
 *   这些文件里有**真正的 TypeScript 语法**（`export type GroupMeta = {...}`、
 *   `as const`），改名后 Node 会在解析 `export type` 时直接语法报错。
 *   要改名就必须同时删掉类型 —— 那会削弱内容源契约的表达力，且让已按
 *   旧契约写 `groups.mts` 的第三方失效。故不改扩展名，改加载方式。
 */
async function loadTsModule(abs: string): Promise<GroupsModule> {
  const raw = fs.readFileSync(abs, 'utf-8')
  // 动态 import esbuild：它是 Vite 的传递依赖，但不保证被提升到顶层 node_modules，
  // 故用容错方式解析路径；真的取不到时给出可执行的修复指引，而不是裸 MODULE_NOT_FOUND。
  let esbuild: typeof import('esbuild')
  try {
    esbuild = (await import('esbuild')) as typeof import('esbuild')
  } catch {
    throw new Error(
      `[groups] 需要 esbuild 来加载 TypeScript 配置（${path.basename(abs)}），但无法解析它。\n` +
        '  esbuild 是 Vite 的依赖，正常随 npm ci 一起安装。\n' +
        '  修复：cd site && npm ci'
    )
  }
  const { code } = await esbuild.transform(raw, {
    loader: 'ts',
    format: 'esm',
    target: 'node18', // 覆盖最低 CI 版本（Node 20）也绰绰有余
    sourcefile: abs,
  })
  const b64 = Buffer.from(code, 'utf-8').toString('base64')
  return (await import(`data:text/javascript;base64,${b64}`)) as GroupsModule
}

/**
 * 解析结果里 GROUPS 元素的最小形状。
 *
 * 这里刻意**不做运行期字段校验**：契约的权威定义在 `groups.example.mts`
 * 与 `content/CONTENT_SOURCE.md`，config.mts 只负责「取到数组」这一件事。
 * 三个候选来源（示例 / 本地 / 挂载）因此具有完全一致的消费口径。
 */
type GroupMetaLike = {
  id: string
  dir: string
  title: string
  tagline: string
  summary: string
  accent: string
  tags: string[]
  temp?: boolean
}

/**
 * 解析结果只做一次模块级解构，后续所有代码的写法与改造前
 * （原本从 './groups.mts' 静态 import）**逐字一致** —— 这样这次改造
 * 对下面 200 行配置逻辑是零侵入的，降低了回归面。
 */
const { hasCustomLectures, GROUPS, SITE_META, SITE_FEATURES } = await resolveGroups()

/** frontmatter 的 title 值可能带引号，统一剥掉（否则侧边栏会显示双引号） */
function readTitle(src: string): string | null {
  const m = src.match(/^title:\s*(.+)$/m)
  if (!m) return null
  return m[1].trim().replace(/^"([\s\S]*)"$/, '$1').replace(/\\"/g, '"')
}

/** 扫描某组目录 → 按讲号**数值**排序（两位数排序对 L100 之类会错，这里统一按数值） */
function scanLectures(dir: string) {
  const d = path.join(docsRoot, dir)
  if (!fs.existsSync(d)) return [] as { n: number; text: string; link: string }[]
  return fs
    .readdirSync(d)
    .filter((f) => /^L\d+\.md$/.test(f))
    .map((f) => {
      const n = Number(f.slice(1, -3))
      const title = readTitle(fs.readFileSync(path.join(d, f), 'utf-8'))
      return { n, text: title || `第 ${n} 讲`, link: `/${dir}/${f.slice(0, -3)}` }
    })
    .sort((a, b) => a.n - b.n)
}

/**
 * ──────────────────────────────────────────────────────────────────────────
 * 图表统计的口径（2026-10-15 修「首页显示 0 张可交互图表」）
 * ──────────────────────────────────────────────────────────────────────────
 * 统计视图的**唯一职责**是回答「这个组的讲义页面上实际渲染出多少张图」。
 * 因此判据必须与**运行时**（theme/charts.ts 的 loadCharts）保持同源，
 * 而不是自己发明一套命名约定。
 *
 * 运行时的事实（见 theme/charts.ts:79、site.config.mts 的 DATA_FILES.chartsDir）：
 *
 *     fetch(`${DATA_FILES.chartsDir}/${lecture}.json`)   // = /charts/<data-lecture>.json
 *
 * 即：**sidecar 的文件名就是 `data-lecture` 的值**，与「组 id」没有任何必然关系。
 * `data-lecture` 是 figure 锚点上的真实字段，而 sidecar ↔ figure 的 1:1 对应
 * 是 AGENTS.md §4.1 的硬契约（由 scripts/check_figs2.py 把关）。
 *
 * 于是本函数的口径改为：
 *
 *     读 `docs/<dir>/L*.md` → 抽出正文里出现的 `data-lecture` 值 → 找 `<该值>.json`
 *
 * 为什么不能继续用「按组 id 前缀」：
 *   组 id 是**展示用编号**（首页徽章、导航、侧边栏标题都取它），
 *   而 sidecar 前缀由 `data-lecture` 决定。两者在开源版示例里**unavoidably 不同**：
 *   遵循数据与正文 1:1 双向契约，图表统计改由「正文实际引用的 data-lecture」
 *   反查对应的 sidecar JSON 文件，杜绝组 id 与图表文件名前缀脱节导致的漏统或误统。
 *
 * 为什么按「正文实际出现的 data-lecture」而不是「遍历 chartsRoot 认前缀」：
 *   后者需要猜测前缀（组 id？dir 名？），且在两组共享前缀时会重复计数。
 *   前者直接来自正文，天然 1:1，且**只统计真正被页面引用的图**——
 *   若某组有孤儿 sidecar（无对应 figure），它不会被计入本组统计，
 *   这正是统计视图该有的语义。
 */

/** 某组的图表统计结果（按类型分布） */
type ChartStats = { total: number; mermaid: number; echarts: number; wavedrom: number }

/** 从一个 md 正文里抽出所有 `data-lecture="..."` 的值（去重） */
function readLectureIds(src: string): Set<string> {
  const out = new Set<string>()
  // 只认 figure 锚点上的 data-lecture（与 check_figs2.py 的判据一致），
  // 不扫描散文里偶然出现的同名字符串。
  const re = /<figure\b[^>]*\bdata-lecture="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.add(m[1])
  return out
}

/** 累加一个 sidecar JSON 的类型分布到统计结果上 */
function countChartTypes(fullPath: string, out: ChartStats) {
  try {
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as Record<
      string,
      { type?: string }
    >
    for (const k of Object.keys(data)) {
      out.total++
      const t = data[k]?.type
      if (t === 'mermaid' || t === 'echarts' || t === 'wavedrom') out[t]++
    }
  } catch {
    /* 单个 JSON 异常不阻断构建（与改造前一致） */
  }
}

/**
 * 统计某组图表数量与类型分布。
 *
 * 参数是**组目录**（`dir`，如 `examples/g01`）而非组 id —— 因为判据来自
 * 该目录下讲义正文里的 `data-lecture`，不再依赖组 id 的命名约定。
 * 读 sidecar JSON 而非手写数字，避免「写死的数字与实际不同步」。
 */
function scanCharts(dir: string) {
  const out: ChartStats = { total: 0, mermaid: 0, echarts: 0, wavedrom: 0 }
  const d = path.join(docsRoot, dir)
  if (!fs.existsSync(d)) return out // 目录不存在（引擎裸奔形态）→ 0，不报错

  const exampleChartsRoot = path.join(docsRoot, 'examples', 'public', 'charts')

  for (const f of fs.readdirSync(d)) {
    if (!/^L\d+\.md$/.test(f)) continue
    let src: string
    try {
      src = fs.readFileSync(path.join(d, f), 'utf-8')
    } catch {
      continue
    }
    for (const lecture of readLectureIds(src)) {
      const sidecar = `${lecture}.json`
      const p1 = path.join(chartsRoot, sidecar)
      const p2 = path.join(exampleChartsRoot, sidecar)
      if (fs.existsSync(p1)) {
        countChartTypes(p1, out)
      } else if (!hasCustomLectures && fs.existsSync(p2)) {
        countChartTypes(p2, out)
      }
    }
  }
  return out
}

/** 首页 / 组内页 / 侧边栏共用的课程组数据（唯一来源是解析出的课程组定义 + 目录扫描） */
const groups = GROUPS.map((g) => {
  const lectures = scanLectures(g.dir)
  // 传 `dir` 而非 `id`：统计判据已改为「组目录下讲义正文里的 data-lecture」，
  // 与组 id 的命名约定解耦（理由见 scanCharts 上方注释）。
  const chartTypes = scanCharts(g.dir)
  return { ...g, lectures, lectureCount: lectures.length, chartCount: chartTypes.total, chartTypes }
}).sort((a, b) => Number(!!a.temp) - Number(!!b.temp)) // 临时挂载的课程组**永远排最后**（sort 稳定，组内保持声明顺序）

const totals = groups.reduce(
  (a, g) => ({ lectures: a.lectures + g.lectureCount, charts: a.charts + g.chartCount }),
  { lectures: 0, charts: 0 }
)

export default async () =>
  defineConfig({
    lang: 'zh-CN',
    title: SITE_META.name,
    description: SITE_META.tagline,
    cleanUrls: true,
    lastUpdated: true,
    // 当检测到自定义讲义已载入时，物理排除 examples/ 下的所有讲义页面，保证 100% 独占呈现
    srcExclude: hasCustomLectures ? ['examples/**'] : [],
    head: [
      // 站点图标（菱形标记）：SVG 为主，PNG/ICO 兜底；
      // 显式声明后浏览器不再盲请求 /favicon.ico（那正是之前 404 的来源）
      ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
      ['link', { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/icon-192.png' }],
      ['link', { rel: 'alternate icon', sizes: '16x16 32x32 48x48 64x64', href: '/favicon.ico' }],
      ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' }],
      ['link', { rel: 'mask-icon', href: '/favicon.svg', color: '#3D1755' }],
      ['meta', { name: 'theme-color', content: '#3D1755' }],
      ['meta', { name: 'robots', content: 'noindex, nofollow, noarchive, nosnippet, noimageindex' }],
      ['meta', { name: 'referrer', content: 'no-referrer' }],
    ],
    /**
     * 语法高亮：VitePress 用 Shiki，**内置 316 种语言且按需动态加载**
     * （loadLanguage -> loadLanguageSync），所以除下面两个之外的标签**无需在这里登记**。
     * 这里只补 Shiki 没有的 kconfig / math 两个自定义语法。
     */
    markdown: {
      languages: [KCONFIG, MATH, IOS, LD],
      languageAlias: {
        'mermaid:chart': 'mermaid',
      },
      /** 第 13 步：构建期 KaTeX。只认 \(…\) / \[…\] / $$…$$，**不接管裸 $…$ 与 ```math 围栏** */
      config: (md) => {
        md.use(mathPlugin)
      },
    },
    themeConfig: {
      outline: { level: [2, 3], label: '本讲大纲' },
      sidebarMenuLabel: '讲次',
      returnToTopLabel: '回到顶部',
      darkModeSwitchLabel: '主题',
      lightModeSwitchTitle: '浅色',
      darkModeSwitchTitle: '深色',
      docFooter: { prev: '上一讲', next: '下一讲' },
      lastUpdatedText: '更新于',
      search: {
        provider: 'local',
        options: {
          translations: {
            button: { buttonText: '搜索讲义', buttonAriaLabel: '搜索讲义' },
            modal: {
              noResultsText: '未找到相关内容',
              resetButtonTitle: '清除查询',
              footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
            },
          },
        },
      },
      /**
       * 顶栏导航：课程组多起来之后平铺会挤成一行，改成**下拉栏**。
       * 临时挂载的组在文字后加「（临时）」标记，且（见上面的 sort）永远排最后。
       */
      nav: [
        { text: '总览', link: '/' },
        {
          text: '课程组',
          items: groups.map((g) => ({
            text: `${g.id} · ${g.title}${g.temp ? '（临时）' : ''}`,
            link: `/${g.dir}/`,
          })),
        },
      ],
      sidebar: Object.fromEntries(
        groups.map((g) => [
          `/${g.dir}/`,
          [
            {
              text: `${g.id} · ${g.title}`,
              collapsed: false,
              items: g.lectures.map((l) => ({ text: l.text, link: l.link })),
            },
          ],
        ])
      ),
      // 供 HomeBody.vue / GroupIndex.vue 读取（客户端可从 useData().theme 拿到）
      groups,
      totals,
      siteMeta: SITE_META,
      siteFeatures: SITE_FEATURES,
      socialLinks: [],
    },
    vite: {
      // 讲义导出插件（按需导出中间件）。
      // 之前漏了这一步，导致「点导出按钮 → 即时生成」这条路 404，
      // 只剩预生成产物可用 —— 现补上，与新组件形成闭环。
      plugins: [lectureExportPlugin()],
      server: {
        watch: {
          ignored: ['**/.*/**', '**/*.tmp/**', '**/*.tmpdir/**'],
        },
      },
    },
  })
