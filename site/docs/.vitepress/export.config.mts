/**
 * site/docs/.vitepress/export.config.mts — 讲义导出套件的专属配置
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么单独一个文件，而不是并进 site.config.mts？
 * ────────────────────────────────────────────────────────────────────────────
 * 功能上二者等价（`site.config.mts` 的头部就写明它是「配置外置唯一落点」）。
 * 但本仓库当前**有多个任务并行改动 `site.config.mts`**，实测已发生一次
 * 「整段被覆盖」：导出配置段写进去后被另一任务的写入抹掉，构建随即报
 * `"LECTURE_EXPORT" is not exported`。
 *
 * 覆盖的根因不是谁的疏忽，而是这类大文件的**编辑模型本身**：
 * 并行 Agent 各自 read → edit，后写者的基线已过期，整段替换就会吞掉对方的改动。
 * 因此把导出配置**物理隔离到独立文件**，使两个任务不再争同一段文本 ——
 * 这是「用文件边界替代协作纪律」，比依赖时序更可靠。
 *
 * 它与 `site.config.mts` 的关系：同目录、同风格、同约定（纯数据字面量、
 * 不得 import 任何 theme/ 下模块以免循环引用），只是**归属清晰**：
 * 本文件由导出套件独占，`site.config.mts` 继续由站点通用配置独占。
 *
 * ⚠️ 消费方有两处，**都只读不写**，改这里一处即同时生效：
 *   1. `theme/components/LectureExportButton.vue`（浏览器侧，静态 import）；
 *   2. `plugins/lectureExportPlugin.mjs` 与 `scripts/generate_lecture_exports.mjs`
 *      （Node 侧，用 esbuild 转译后读取本文件的 `LECTURE_EXPORT` 段）。
 *
 * ⚠️ 本文件必须是**纯数据字面量**：Node 侧是从源码里抠出 LECTURE_EXPORT
 *    这个对象字面量再转译的（理由见插件 `readExportConfig()` 注释），因此：
 *      · 不要在这个对象里写 import、函数调用或变量引用；
 *      · 不要改 LECTURE_EXPORT 这个导出名与 `as const` 的写法。
 *
 * ⚠️ 另外注意：本说明里刻意**不再原样复述那句声明式写法**。
 *    因为读取方是「先定位声明、再做括号配平」的解析器，
 *    注释里若出现一模一样的声明片段（哪怕包在反引号里），
 *    会让定位器错误地命中注释里的那份，解析出 `{ ... }` 这种残缺对象。
 *    这是实测踩到的：正则匹配成功、esbuild 却报 Unexpected "}"。
 */

/**
 * 讲义多维导出配置（长卷 PDF / 全景长图 / 出版级 A4 分页）。
 *
 * 统一集中管理导出视口、缩放比率、输出规范、缓存路径与无头浏览器调用参数，
 * 遵循配置集中管理与环境自适应原则。
 */
export const LECTURE_EXPORT = {
  /** 按需即时生成的 API 路径（同源，dev server 中间件挂载点） */
  apiPath: '/api/generate-export',

  /** 静态产物在网页上的访问前缀（对应 site/docs/public/exports/） */
  exportsPublicPath: '/exports',

  /**
   * 产物落盘目录（**相对仓库根**）。
   * 用相对路径而非绝对路径：CI 在 Linux、开发机可能在 Windows，
   * 硬编码盘符会让脚本在另一平台直接不可用（AGENTS.md §6.3）。
   *
   * ⚠️⚠️ 维护者注意：`.gitignore` 目前**没有**排除本目录。
   *   导出产物是**派生的二进制**（PDF/PNG，每讲约 5 MB 量级），
   *   按仓库既有惯例（`dist/`、`ops/visual_audit_*.png`、`charts/` 均被排除）
   *   不应进版本库，否则公开仓库会被二进制迅速撑大、且每次内容更新都产生
   *   一个无法 diff 的大对象。
   *
   *   建议在 `.gitignore` 中补上（与既有风格一致，保留一条说明性注释）：
   *
   *       # 讲义导出产物：派生的二进制，不入库；由脚本/插件按需生成
   *       site/docs/public/exports/
   *
   *   本文件的作者（导出套件移植任务）**没有修改 `.gitignore`** ——
   *   它不在该任务的授权写入范围内，故在此显式标注，交由维护者处理。
   */
  exportsDir: 'site/docs/public/exports',

  /**
   * 允许导出的课程组目录白名单。
   *
   * **留空（默认）= 自动推断**：只要 `site/docs/<组>/` 或
   * `site/docs/examples/<组>/` 目录真实存在就允许导出 —— 引擎不知道、
   * 也不该知道第三方的目录命名。
   * 若部署希望**收窄**范围（例如只让正式课程可导出），在此显式列出目录名
   * （相对 site/docs 的路径，如 'guide' 或 'examples/g01'）。
   */
  groupDirs: [] as string[],

  /** 无头渲染视口。deviceScaleFactor=2 即「2x 视网膜」，决定 PNG 长图清晰度 */
  viewport: { width: 1200, height: 900, deviceScaleFactor: 2 },

  /**
   * 三种产物的文件名后缀与展示名。
   *
   * ⚠️ 后缀同时被**组件**（拼静态资产 URL）与**插件/脚本**（决定落盘文件名）使用，
   *    两边必须一致；改这里一处即同步。
   * ⚠️ 若你改了后缀，请把 `site/docs/public/exports/` 下的旧产物一并清理，
   *    否则插件会命中旧文件而误判「已生成」（缓存判据 = 文件存在 + 体积达标）。
   */
  types: {
    continuous: { suffix: '-continuous.pdf', label: '长卷 PDF' },
    png: { suffix: '-fullpage.png', label: '全景长图' },
    a4: { suffix: '-standard-a4.pdf', label: '标准 A4 PDF' },
  },

  /**
   * 下载文件名模板。
   *   `{title}`   → 讲义标题（取自 frontmatter.title，已清洗 Windows 保留字符）
   *   `{lecture}` → 讲次号（如 L01）
   */
  fileNameTemplate: {
    continuous: '{title}_长卷.pdf',
    png: '{title}_长图.png',
    a4: '{title}_A4.pdf',
  },

  /** 取不到讲义标题时的通用兜底（中性表述，不含任何课程名） */
  fallbackTitle: '讲义',

  /** PDF 几何参数 */
  pdf: {
    /** 单页长卷的页宽（高度由实测内容高动态决定） */
    continuousWidth: '1200px',
    /** 标准 A4 纸张规格（传给 Chromium 的 page.pdf） */
    a4Format: 'A4',
    /** A4 页边距：上下 16mm、左右 14mm */
    a4Margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
  },

  /**
   * 等待 `window.__CHARTS_DONE__` 的超时（毫秒）。
   * ⚠️ 不要调得太小：图表渲染实测约 3 秒就绪，超时过早会截到
   *    「图表源缺失」的空框（这是踩过的坑）。无图表的讲义会走到超时，
   *    此处只告警不报错。
   */
  chartWaitTimeoutMs: 15000,

  /** 判定「产物已生成」的最小体积（字节）。低于此值视为半成品，需重新渲染 */
  minValidBytes: 1000,

  /**
   * 额外的 Puppeteer 模块搜索目录（相对仓库根）。
   *
   * 用途：若项目把 puppeteer 装在一个自带 node_modules 的独立工具目录里，
   * 在此列出即可（插件会以该目录的 package.json 为锚点解析）。
   * 默认空数组 —— 此时按「仓库根 → site/」的常规顺序探测。
   *
   * ⚠️ 请填**你自己**的路径。不要填任何来自他人机器的绝对路径。
   */
  puppeteerModuleDirs: [] as string[],

  /**
   * 额外的浏览器可执行文件候选路径（绝对路径）。
   *
   * 默认空数组：插件与脚本已内置三平台（Windows / macOS / Linux）的常见安装位置。
   * 环境变量 `PUPPETEER_EXECUTABLE_PATH` 优先级高于本项，CI 里优先用它。
   */
  chromeCandidates: [] as string[],
} as const
