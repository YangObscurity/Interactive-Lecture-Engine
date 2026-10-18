/**
 * site.config.mts — 前端可配置项集中地（「配置外置」唯一落点）
 *
 * 设计与定位：
 *   集中定义全站前端可配置项：包括后端反向代理路径、本地持久化存储键名、
 *   图表字体栈、数据文件名及核心业务常量，供全站各模块统一引用。
 *   实现站点部署细节与通用渲染引擎的物理隔离与单一真源管理。
 *
 * 三条铁律（改动前务必先读）：
 *   1. **默认值必须与本次重构前的现状逐字节一致**。这是纯「提取常量」重构，
 *      不允许顺手改行为、改路由、改 key 名。
 *   2. **localStorage 键必须向后兼容**。老用户的阅读进度、沉浸阅读开关、
 *      AI 侧栏宽度、AI 会话历史都存在浏览器里，改 key = 用户丢设置。
 *      因此凡涉及键名的地方一律走「新键优先、旧键回退」读取，
 *      写入时同时写两份（双写），保证任何时刻降级旧版本都不丢数据。
 *   3. 本文件**不得引入任何第三方依赖**，也不得引入 theme/ 下的任何模块
 *      （否则会形成 .vitepress 顶层配置 → theme 运行时 → 配置 的循环引用）。
 *
 * 命名约定：`STORAGE_KEYS` 是「当前写入键」，`STORAGE_KEYS_LEGACY` 是
 * 「历史版本键」，二者键名一一对应；读取一律走 storageKeysFor() 返回的有序候选表。
 */

// =============================================================================
// 1. 站点品牌文案
// =============================================================================

/**
 * 应用标识：用于 localStorage 键前缀的语义命名、诊断日志与外部集成时识别「这是哪个站」。
 *
 * 注意：**它不参与任何现存 localStorage 键的拼装** —— 现存键（`lecture-reading-mode`、
 * `tut_neon_*` 等）都有各自独立且必须冻结的历史前缀，不能被这个新值改写。
 * 它只服务于「将来新增的键」以及需要在页面/日志里标明站点身份的场合。
 */
export const SITE_APP_ID = 'lecture-site'

/**
 * 站点身份信息。
 *
 * ⚠️ 与 `groups.mts` 的 `SITE_META` 的分工：
 *   - `groups.mts` 的 `SITE_META` 是**站点文案真源**（name / text / tagline），
 *     会被 config.mts 注入 themeConfig 并渲染到页面上，改动会影响可见文案；
 *   - 这里的 `BRANDING` 只收拢**运行时代码里散落的品牌字符串**（例如演示数据
 *     的署名、诊断信息里的站点名），不参与页面主文案渲染。
 *   之所以不把 SITE_META 搬过来，是为了避免页面可见文案出现「两个真源」——
 *   那正是本次重构想消除的问题，不能反过来制造一个。
 */
export const BRANDING = {
  /** 品牌全称 */
  name: '可交互工程讲义引擎',
  /** 品牌短名（用于窄容器与日志） */
  shortName: '讲义引擎',
  /** 讲义全站知识库的展示名（AI 上下文缺省值） */
  /**
   * 知识演进脑图的**根标题**。
   * 为什么可配置：这是使用者的课程体系名（属私人命名），引擎不应硬编码 ——
   * 默认给中性占位，用的人改成自己的体系名即可。
   */
  knowledgeMapRootTitle: '知识体系总览',
  knowledgeBaseName: '全站讲义知识库',
  /** 未指定课程组时的展示名 */
  allGroupsName: '全部课程组',
  /** 未指定讲义时的展示名 */
  unknownLectureName: '当前讲义',
  /** 未指定小节时的展示名 */
  wholeOutlineName: '全篇',
  /** 无划选内容时的占位值 */
  noSelectionName: '无',
  /** 课程组缺省名 */
  genericGroupName: '通用',
  /** 全站范围的讲义名（AI 上下文里代表「不属于任何一讲」） */
  siteWideLectureName: '全站',
} as const

// =============================================================================
// 2. 后端反代接口路径（同源，全部以 / 开头）
// =============================================================================

/**
 * 后端接口路径表。
 *
 * 设计背景：本站前端**从不直连**任何第三方云（不内嵌 Notion / Neon / Dify 令牌），
 * 全部经由同源反向代理转发。因此这些路径是「部署时可整体替换」的配置项：
 * 换一个反代实现（比如自建 NestJS 网关），只要改这里即可，无需碰 theme 代码。
 *
 * 每一项后面的「适配协议」注释说明它当前期望的后端协议形态 ——
 * 外置之后仍然保留协议耦合（改协议要同时改调用方），但至少路径不再散落各处。
 */
export const API_ENDPOINTS = {
  /** AI 伴读对话（SSE 流式）。适配协议：Dify Cloud Agent Beta 的 event: message / agent_thought / message_end 事件流 */
  aiChat: '/api/ai/chat',
  /** 课件（pptx/pdf）上传解析。适配协议：返回 { id, name, size, extension, mime_type } 的 JSON */
  aiUpload: '/api/ai/upload',
  /** 学习进度回写主端点（POST）。适配协议：服务端保存 Notion 令牌并代为 PATCH Notion 页面 */
  notionSyncPrimary: '/api/progress/notion-sync',
  /** 学习进度回写降级端点（PATCH）。主端点返回 404 时平滑切换到这里 */
  notionSyncFallback: '/api/notion/sync-status',
  /** 数据仓储 base（会话 / 消息 / 进度 / 清单的 CRUD 前缀）。适配协议：RESTful，见 neonRepository.ts */
  db: '/api/db',
} as const

/**
 * 数据仓储的子路径（拼在 API_ENDPOINTS.db 之后）。
 *
 * 单独抽出来是因为 neonRepository 里每个 CRUD 方法都写了一遍字面量，
 * 出现拼写不一致时只会在运行时 404，编译器帮不上忙。
 */
export const DB_ROUTES = {
  sessions: '/sessions',
  messages: '/messages',
  progress: '/progress',
  progressBatch: '/progress/batch',
  reviewChecklists: '/review-checklists',
} as const

/**
 * 仓储网络层默认参数。
 * requestTimeoutMs 是单次 fetch 的 AbortController 超时；maxRetries 是失败后的重试次数。
 */
export const DB_CLIENT_DEFAULTS = {
  requestTimeoutMs: 5000,
  maxRetries: 1,
} as const

// =============================================================================
// 3. 第三方 API 基址（仅供服务端运行时直连使用）
// =============================================================================

/**
 * Notion 官方 API 基址。
 *
 * ⚠️ 安全边界：这个基址**只在服务端 Worker 适配器里**被使用
 * （`executeDirectNotionStatusPatch`，由环境变量注入令牌后调用）。
 * 浏览器侧一律走 API_ENDPOINTS.notionSyncPrimary 的同源反代，
 * **绝对不允许**在前端代码里出现 Authorization 头或令牌字面量。
 */
export const NOTION_API = {
  baseUrl: 'https://api.notion.com/v1',
  /** Notion-Version 请求头默认值（Notion 要求显式声明 API 版本） */
  version: '2022-06-28',
} as const

// =============================================================================
// 4. 静态数据文件
// =============================================================================

/**
 * 随站点发布的静态数据文件（位于 docs/public/ 下，构建后原样拷贝到站点根）。
 *
 * `graphVersion` 是 Notion 知识图谱的**数据版本号**：
 * 前端把它写进 localStorage，下次加载时若版本号变了就整体重铺进度缓存
 * （否则上游改了知识图谱的节点状态，用户本地永远看不到）。
 * 因此**上游数据一变就必须同步 bump 这个常量**，否则用户侧不会刷新。
 */
export const DATA_FILES = {
  /** Notion 知识图谱快照（节点状态真源；节点数由数据文件决定） */
  notionKnowledgeGraph: {
    /** 站点根下的访问路径（不带 withBase 前缀，调用方按需拼接） */
    publicPath: '/notion_knowledge_graph.json',
    /** docs/public 下的相对位置（供需要在构建期读取的脚本引用） */
    docsRelativePath: 'public/notion_knowledge_graph.json',
    /** 数据版本号：图谱内容变更时必须 bump，用于触发客户端进度缓存整体重铺 */
    graphVersion: '20261014_align_v3',
  },
  /** 讲义图表 sidecar（每讲一个，懒加载） */
  chartsDir: '/charts',
} as const

// =============================================================================
// 5. AI 伴读 · 离线 Mock 降级引擎文案
// =============================================================================

/**
 * 离线 Mock 降级引擎的全部可见文案。
 *
 * 规范设计原则：
 *   1. 引擎保持学科与领域中立：演示文本不内置任何具体学科内容，保持通用说明。
 *   2. 单一真源：演示文案集中于配置层管理，方便使用者定制。
 *   3. 渲染能力展示：演示文本仅作为 Markdown、KaTeX 公式与代码高亮能力的无侵入验证。
 *
 * ⚠️ 修改 `demoAnswer` 时请守住两条底线：
 *   - **保持领域无关**：不得出现任何具体学科知识（电路 / 数据库 / 网络 /
 *     化学 / 法律……一律不要）。它的唯一职责是向读者说明「当前处于离线
 *     演示模式」，并顺带展示 Markdown、数学公式与代码块的渲染能力。
 *   - 数学公式用的是 KaTeX 支持的通用 LaTeX，**不是**任何学科的具体结论。
 *     这里选 $a^2+b^2=c^2$ 这类数学恒等式，任何课程背景下都不会显得突兀。
 */
export const AI_MOCK = {
  /**
   * 是否启用 Mock 降级。
   *
   * 默认 `true`，与历史行为逐字节一致：网络不可达或后端反代返回
   * 404/401/403/502/503 时，平滑降级为本地演示回复，而不是白屏报错。
   * 接入真实后端并希望「宁可见错误也不见演示答案」的部署，可改为 false。
   * （注意：`useDifyChat` 的 `fallbackToMock` 选项优先级更高，仍可逐调用覆盖。）
   */
  enabled: true,

  /**
   * 回复模板。支持四个占位符，由 useDifyChat.ts 的 `renderTemplate()` 做字面量替换：
   *   `{lecture}`   → 当前讲次名（缺省取 BRANDING.unknownLectureName）
   *   `{section}`   → 当前小节提示句（由 AI_MOCK.sectionHint 系列拼出）
   *   `{selection}` → 划选引证块，无选区时为空串
   *   `{demo}`      → demoAnswer 正文
   *
   * 稳健性约定：**未知占位符原样保留**，绝不抛错 —— 第三方用户往模板里
   * 写 `{foo}` 或正文里本就含花括号时，最坏结果只是显示字面量。
   */
  replyTemplate: '在 [{lecture}] 中，{section}，针对你的疑问分析如下：\n{selection}{demo}',

  /** 有当前小节时的提示句（`{section}` 占位符的填充内容） */
  sectionHintWithOutline: '结合小节 [{outline}]',

  /** 无当前小节时的提示句（`{section}` 占位符的填充内容） */
  sectionHintWithoutOutline: '根据讲义核心推导',

  /** 有划选内容时的引证块模板（`{selection}` 占位符的填充内容，`{text}` 为选区原文） */
  selectionQuoteTemplate: '\n> 选区引证: "{text}"\n',

  /**
   * 离线演示正文（`{demo}` 占位符的填充内容）。
   *
   * 内容是刻意设计的「能力展示」而非「知识回答」：
   *   一段正文 + 一个行间公式 + 一段代码块，覆盖 MarkdownRenderer 的
   *   三条主要渲染路径（散文 / KaTeX / 代码高亮），让第三方用户在没接
   *   后端时也能一眼看清这个组件能渲染什么。
   *
   * 注：代码块里的 `{lecture}` 会被渲染函数一并替换成真实讲次名 ——
   * 这不是笔误，是刻意让读者看到「演示内容确实吃到了页面上下文」。
   */
  demoAnswer: [
    '**当前处于离线演示模式** —— 未检测到可用的 AI 后端服务',
    '（网络不可达，或反向代理返回了 404 / 401 / 403 / 502 / 503）。',
    '因此这条回复由站点内置的本地引擎生成，**不包含任何真实模型推理**。\n\n',
    '接入真实后端后，这里将显示模型结合当前讲义上下文给出的回答。',
    '作为渲染能力的演示，下面给出一个数学公式：\n\n',
    '$$a^2 + b^2 = c^2$$\n\n',
    '以及一段代码：\n\n',
    '```ts\n',
    '// 演示代码块的高亮与一键复制能力\n',
    'const message = `当前讲义: {lecture}`\n',
    'console.log(message)\n',
    '```\n\n',
    '要点回顾：\n',
    '1. 本回复仅用于离线演示，不代表任何课程结论；\n',
    '2. 若要获得真实回答，请配置 `API_ENDPOINTS.aiChat` 指向可用的后端；\n',
    '3. 如果不需要离线演示，可把 `AI_MOCK.enabled` 设为 false 并关闭 `fallbackToMock`。'
  ].join(''),

  /**
   * Mock 的「思考步骤」文案（模拟 agent_thought 事件流）。
   *
   * 这些步骤只用于演示「智能体正在推理」的 UI 形态，因此**全部是通用描述**：
   * 不带任何私有工具名，也不带任何学科术语。
   * `{lecture}` / `{group}` / `{query}` / `{selection}` 占位符由渲染函数替换，
   * 未知占位符同样原样保留。
   */
  thinkingSteps: [
    {
      thought: '正在解析读者问题与上下文：讲次={lecture}，课程组={group}',
      tool: 'search_context',
      toolInput: '{"scope":"{lecture}","query":"{query}"}',
      obs: '已定位到提问所在讲义与章节范围'
    },
    {
      thought: '正在组织回答结构与表达方式...'
    }
  ],
} as const

// =============================================================================
// 6. 图表运行时配置
// =============================================================================

/**
 * 图表字体栈。
 *
 * 说明：ECharts / Mermaid 渲染到 Canvas 或 SVG 时**不继承页面 CSS 字体**，
 * 必须显式传入字体家族。这个栈的用意是「中文优先、三大平台全覆盖」：
 *   Noto Sans SC（Linux/CI）→ PingFang SC（macOS）→ Microsoft YaHei（Windows）
 * 末尾 sans-serif 兜底，保证任何环境都不会退化成衬线体。
 */
export const CHART_FONT = "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif"

/** 图表类型标签（图表下方 figcaption 里显示的中文说明） */
export const CHART_TAG_LABELS: Record<string, string> = {
  mermaid: '流程图 / 关系图',
  echarts: '数据图表',
  wavedrom: '时序 / 波形图',
}

/**
 * 各图表类型可用的工具按钮（键名对应 CHART_TOOL_DEFS）。
 *
 * 内联视图**不提供缩放/拖动**（滚轮或拖动会打断阅读、且极易误触）；
 * 缩放能力全部收进全屏层，所以这里每个类型都只有「全屏」与「看源码」两个按钮。
 */
export const CHART_TOOLS_BY_TYPE: Record<string, string[]> = {
  mermaid: ['expand', 'src'],
  wavedrom: ['expand', 'src'],
  echarts: ['expand', 'src'],
}

/** 工具按钮定义：[动作名, 悬停提示/无障碍标签, 按钮内显示的字符] */
export const CHART_TOOL_DEFS: Record<string, [string, string, string]> = {
  expand: ['expand', '全屏放大查看', '&#8599;'],
  src: ['src', '查看图表源码', '{ }'],
}

/**
 * Mermaid 主题令牌：浅色 / 深色两套。
 *
 * 为什么必须外置：mermaid 渲染到 SVG **完全不继承页面 CSS 变量**，
 * 深色模式下的节点底色、文字色、连线色只能通过 initialize() 的
 * themeVariables 显式注入。这些是纯粹的「配色外观」，
 * 不同部署方大概率想换成自己的品牌色，因此不该埋在渲染逻辑里。
 */
export const CHART_MERMAID_THEMES = {
  /** 浅色下的主题名。'base' 是可被 themeVariables 完全接管的中性基底 */
  light: 'base',
  /** 深色下的主题名。用 mermaid 内置 'dark' 打底，再用下面的 darkVars 精修 */
  dark: 'dark',
  /**
   * 深色下的精细配色。
   *
   * 为什么浅色不需要这些变量：浅色直接用 'base' 的默认值即可，
   * 而 'dark' 内置配色偏「蓝紫」，与本站中性灰的阅读底色不搭，
   * 故用 Zinc 色阶（tailwind 命名习惯）覆盖一版。
   */
  darkVars: {
    darkMode: true,
    background: '#1b1b1f',
    primaryColor: '#27272a',
    primaryTextColor: '#f4f4f5',
    primaryBorderColor: '#52525b',
    lineColor: '#a1a1aa',
    secondaryColor: '#3f3f46',
    tertiaryColor: '#27272a',
    mainBkg: '#27272a',
    nodeBorder: '#52525b',
    textColor: '#f4f4f5',
    edgeLabelBackground: '#1e1e20',
    clusterBkg: '#18181b',
    clusterBorder: '#3f3f46',
  },
} as const

/**
 * ECharts 的 grid 兜底参数。
 *
 * `containLabel` 是这里最重要的一项：它为「坐标轴刻度文字 / 轴名称」预留空间，
 * **默认关闭**，于是长刻度（如 "1000.00"）或中文轴名会被 Canvas 直接裁掉。
 * 本站强制开启，宁可绘图区小一点，也不允许文字被切掉。
 *
 * 为什么做成开关而不是写死：极少数作者会手工精调 grid 追求「像素级铺满」，
 * 此时 containLabel 的自动留白反而是干扰。留一个显式关闭的口子。
 */
export const CHART_ECHARTS_GRID = {
  /** 是否强制为所有直角坐标系开启 containLabel（防坐标轴文字被裁剪） */
  containLabel: true,
  /** 未声明 grid 时使用的边距兜底（数字为像素） */
  fallback: { left: 16, right: 20, bottom: 12 },
} as const

/**
 * Markdown 代码块接管（把散文里的 ```mermaid 围栏升级为交互式图表卡片）。
 *
 * 为什么默认 **false**：这是一项「改写作者排版意图」的强能力 ——
 * 开启后，正文里原本作为**源码展示**的 mermaid 代码块会变成一张图。
 * 对于「引擎文档里要演示 mermaid 语法」这类场景，那恰恰是反效果。
 * 因此默认关闭，由部署方按自己的讲义风格显式打开。
 *
 * 为什么要有 `className` 而不是匹配所有 ```mermaid：VitePress 把围栏渲染为
 * `div.language-mermaid`，无法区分「作者想展示源码」与「作者想看图」。
 * 约定：只想看图就用 ` ```mermaid:chart `（语言标签带 `:chart` 后缀），
 * 想要源码就写普通 ` ```mermaid `。这样两种意图可以并存于同一篇讲义。
 *
 * ⚠️ 本站当前取 `true`：仓库自带的示例讲义（docs/examples/g01/L01.md）
 * 需要在开箱状态下就能演示这项能力。改回 `false` 只会让示例退回
 * 「显示源码」，不会报错 —— 这是刻意保留的降级路径。
 */
export const CHART_INLINE_MERMAID = {
  /** 总开关：关闭时下面的选择器一律不生效 */
  enabled: true,
  /**
   * 需要接管的选择器（CSS 选择器数组）。
   *
   * ⚠️ 默认只认显式的 `:chart` 后缀标记，**不碰裸 ```mermaid** ——
   * 这是为了不破坏「文档里展示 mermaid 源码」这一正当用法。
   */
  selectors: ['div[class*="language-mermaid:chart"]'],
  /** 接管后生成的卡片上附加的类名（供 CSS 与外部脚本识别） */
  className: 'inline-mermaid',
  /** 是否把被接管的原始代码块折叠为「查看源码」（false 则直接隐藏） */
  keepSource: true,
} as const

// =============================================================================
// 7. localStorage 键（⚠️ 改动会直接导致老用户丢设置，务必读完注释）
// =============================================================================

/**
 * 当前写入键。
 *
 * ⚠️ **不要重命名这些值**。它们已经存在于用户的浏览器里，
 * 改名 = 老用户的沉浸阅读开关、阅读进度、AI 侧栏宽度、历史会话全部归零。
 * 如果确实需要换一套命名（例如开源时想把 `tut_neon_` 前缀去掉品牌耦合），
 * 正确做法是：
 *   1. 在 STORAGE_KEYS_LEGACY 里保留旧值；
 *   2. 把新值写进本表；
 *   3. 读取走 storageKeysFor()（新键优先、旧键回退），写入走双写。
 * 三步缺一不可 —— 只做前两步会让老用户读不到旧数据，
 * 只做第一步会让新用户写不进数据。
 */
export const STORAGE_KEYS = {
  /**
   * 沉浸式阅读开关（值 '1' = 开启）。
   * 消费方：reading-mode.ts（首屏初始化 class）、components/ReadingModeToggle.vue（顶栏按钮读写）。
   */
  readingMode: 'lecture-reading-mode',

  /**
   * 阅读进度存储（JSON：{ '/g01/L01': { y, pct, title, group, ts } }）。
   * 消费方：reading-progress.ts。
   */
  readingProgress: 'lecture-read-pos',

  /**
   * AI 侧栏自定义宽度（像素字符串）。
   * 消费方：components/ai/AiSidebarShell.vue。
   */
  aiSidebarWidth: 'lecture-ai-sidebar-custom-width',

  /**
   * AI 对话匿名用户标识（用于 Dify 侧会话归属统计）。
   * 消费方：components/ai/useDifyChat.ts。
   */
  aiChatUserId: 'dify_chat_user_id',

  /**
   * 本地数据仓储键前缀（LocalStorageAdapter 与 NeonRepository 共用）。
   * 实际键形如 `tut_neon_sessions_g01-l01`、`tut_neon_progress_all_map`。
   * 消费方：components/ai/neonRepository.ts。
   */
  neonPrefix: 'tut_neon_',
} as const

/**
 * 历史版本键（**只读回退用**，新代码绝不往这些键写）。
 *
 * `tutorialAiSessionsPrefix` 与 `tutorialAiMessagesPrefix` 是上一代 AI 会话的存储前缀，
 * neonRepository 至今仍在扫描它们（见 getAllSessions / purgeEmptySessions / hasValidMessages），
 * 目的是让升级到新版本的用户仍能看见旧会话；一旦停用扫描，旧会话会在 UI 上凭空消失。
 */
export const STORAGE_KEYS_LEGACY = {
  /** 上一代 AI 会话列表前缀：`tutorial_ai_sessions_<lectureId>` */
  tutorialAiSessionsPrefix: 'tutorial_ai_sessions_',
  /** 上一代 AI 消息明细前缀：`tutorial_ai_messages_<sessionId>` */
  tutorialAiMessagesPrefix: 'tutorial_ai_messages_',
} as const

/**
 * 数据仓储内部的逻辑键（拼在 STORAGE_KEYS.neonPrefix 之后）。
 *
 * 这些键改名同样会导致用户丢数据，且必须与 neonRepository 里
 * `prefix + key` 的拼接结果逐字节一致。
 */
export const STORAGE_SUBKEYS = {
  /** 全站进度字典（一条记录含所有讲次状态，避免逐讲读取） */
  progressAllMap: 'progress_all_map',
  /** 单讲进度记录前缀：`progress_<lectureId>` */
  progressPrefix: 'progress_',
  /** 知识图谱数据版本号（版本不符则整体重铺进度） */
  graphVersion: 'tut_graph_ver',
  /** 某讲会话列表前缀：`sessions_<lectureId>` */
  sessionsPrefix: 'sessions_',
  /** 会话 → 讲义 反查前缀：`session_lec_<sessionId>` */
  sessionLecturePrefix: 'session_lec_',
  /** 会话消息列表前缀：`messages_<sessionId>` */
  messagesPrefix: 'messages_',
} as const

// =============================================================================
// 8. 向后兼容读取助手
// =============================================================================

/**
 * 把「当前键 + 历史键」按**新键优先**的顺序展开成候选表。
 *
 * 为什么返回数组而不是单个值：本地存储的迁移必须**无损且无窗口**。
 * 若直接改键名，已写过旧键的用户在升级瞬间会读到 null（丢设置）；
 * 若只在读时迁移而不保留旧键，回滚到旧版本的用户又会丢设置。
 * 因此读取端统一遍历候选表，第一个非 null 即返回。
 *
 * @param key 当前键字面量（取自 STORAGE_KEYS）
 * @param legacyKeys 该键在历史版本中的曾用名，按「越新越靠前」排列
 */
export function storageKeysFor(key: string, legacyKeys: readonly string[] = []): string[] {
  return [key, ...legacyKeys].filter((k): k is string => typeof k === 'string' && k.length > 0)
}

/**
 * 从多个候选键里读取第一个存在的原始字符串值（SSR 安全）。
 *
 * 任何异常（隐私模式禁用 localStorage、JSON 无关的读写异常）一律静默返回 null，
 * 与全站既有风格一致：存储不可用时功能降级，绝不抛错白屏。
 */
export function readRawWithFallback(keys: readonly string[]): string | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null
  for (const k of keys) {
    try {
      const v = window.localStorage.getItem(k)
      if (v !== null && v !== undefined) return v
    } catch {
      return null
    }
  }
  return null
}

/**
 * 写入：当前键必写；若提供了历史键，则**同时写一份**（双写）。
 *
 * 双写的代价是每个键多占几百字节，收益是「任何时刻回滚旧版本都不丢数据」。
 * 对阅读进度这种累计型数据，这个代价值得。
 */
export function writeRawWithDualWrite(keys: readonly string[], value: string): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
  for (const k of keys) {
    try {
      window.localStorage.setItem(k, value)
    } catch {
      /* 隐私模式或配额超限：静默降级，内存兜底由调用方负责 */
    }
  }
}

/** 移除：候选表里的键全部清掉（避免旧键残留导致「清空后又被读回来」的幽灵数据） */
export function removeRawWithFallback(keys: readonly string[]): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
  for (const k of keys) {
    try {
      window.localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  }
}
