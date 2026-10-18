# 前端引擎（VitePress 主题）

> **语言 / Language**: 中文 ｜ [English](./README.en.md)

> TL;DR：讲义站 = VitePress 1.6.4 + 三库懒加载图表。主题只有 5 个文件、职责严格分离，
> 任何改动都应落在**唯一**的文件里 —— 对照第 2 节矩阵即可定位。

## 1. 文件与职责

| 文件 | 职责 |
|---|---|
| `site/docs/.vitepress/config.mts` | 站点元信息、nav、**侧边栏自动扫描** `docs/<group>/L*.md` 的 frontmatter title、本地搜索 |
| `theme/index.ts` | 挂载入口：`onMounted` 启动 reading-mode + charts，`onUpdated` 补渲染 SPA 换页后的新图表 |
| `theme/charts.ts` | **图表运行时全部逻辑**：骨架生成、三类渲染、缩放、全屏弹层、布局归一 |
| `theme/custom.css` | 图表样式、弹层样式、沉浸阅读布局、防遮挡/防截断 |
| `theme/reading-mode.ts` | 沉浸阅读按钮与 localStorage 状态 |
| `theme/reading-progress.ts` | **阅读进度记忆**：每讲记录滚动位置与百分比，进入时自动回到上次读到的位置；首页「继续阅读」列表的数据源 |
| `theme/cites.ts` | **正文引用标记**：`.cite` 点击 `window.open(data-cite)` **直接新标签打开外链**（参考来源段已全站删除；正文不允许出现链接，见 `content/add-lecture.md` §8） |

## 1b. ⚠️ SPA 换页后要跑的逻辑，必须挂 `router.onAfterRouteChange`

VitePress 的 router 每次换页后会 `await router.onAfterRouteChange?.(href)`
（`vitepress/dist/client/app/router.js`）—— **这个钩子是留给主题的，核心自己不会设置**。

```ts
enhanceApp({ app, router }) {
  const afterRoute = () => {
    if (typeof window === 'undefined') return   // 构建期 SSR 也会走 router.go，必须挡掉
    initCharts()
    initReadingProgress()
  }
  ;(router as any).onAfterRouteChange = afterRoute    // 新名优先
  ;(router as any).onAfterRouteChanged = afterRoute   // 旧名兜底
}
```

**踩过的坑**：一开始只用 `setup()` 里的 `onMounted` / `onUpdated`。
`onMounted` 只在整页加载时触发；`onUpdated` 只在**当前组件自身重新渲染**时触发，
而 SPA 换页时重新渲染的是子树、根组件不一定更新 —— 于是钩子根本没跑。
表现：从首页点「继续阅读」，页面跳到目标讲却**停在顶部**。

## 1c. 代码块语法高亮（Shiki）★

VitePress 用 **Shiki** 做高亮，`shiki` 包内**自带 316 种语言**，且 VitePress 会
**按需动态加载**任何 Shiki 认识的语言：

```js
// vitepress/dist/node/chunk-*.js
function loadLanguage(name) {
  if (!isSpecialLang(lang) && !highlighter.getLoadedLanguages().includes(lang)) {
    const resolvedLang = resolveLangSync(lang)
    if (resolvedLang.length) highlighter.loadLanguageSync(resolvedLang)  // ← 动态加载
    else return false
  }
}
```

**所以：只要围栏标签写对，就立刻有高亮，不需要在 config 里登记。**

| 概念 | 说明 |
|---|---|
| `markdown.languages` | 只是**预加载**列表（默认空数组），**不是白名单**；不会覆盖默认行为，追加是纯增量 |
| **特殊语言** | `text` / `plain` / `txt` / `plaintext` —— `isSpecialLang()` 判定，**设计上就不高亮**（页面上是一片灰） |
| 空语言围栏 | 走 `defaultHighlightLang: 'txt'` → 同上，灰 |
| `languageAlias` | 可选，把 `sh`→`bash` 之类做映射 |

### 本例的坑：内容源把非 C 的块一律标成 `plain text`

```plain text   ← 注意是「plain」+「text」两个词，不是单个 text
$ gcc -std=c99 -### hello.c
...
```

实测 288 个这样的块：**201 个其实是 shell 会话**，另有公式 34、键值 19、kconfig 2、汇编 1。

修法 = **按内容重标注围栏标签**（`scripts/retag_fences.py`，幂等）：

| 内容特征 | 判定语言 |
|---|---|
| 有 `$ ` / `# ` 提示符 + 输出行 | `shellsession` |
| 单独一条命令（idf.py / git / gcc / cmake …） | `shellsession` |
| `menuconfig`/`config` + `bool`/`depends on` … | `kconfig`（自定义） |
| `.section`/`.globl`/`.text` 开头 | `asm` |
| `key = value` 且无代码结构 | `ini` |
| 含 `= ≈ ≤ ≥ · √` 且无代码结构 | `math`（自定义，**历史遗留**） |
| 其余（正文/引文/目录树） | 保持原样 |

重标注后的产物分布：`plain` 236→**24**、`text` 52→**7**，
新增 `shellsession` **201**、`math` **34**、`ini` **19**、`kconfig` **2**、`asm` **1**。

### 自定义语法（Shiki 没有的语言）

`docs/.vitepress/grammars.mts` 定义了两个 TextMate 语法，在 `config.mts` 里登记：

```ts
markdown: { languages: [KCONFIG, MATH] }   // 追加预加载，不覆盖默认
```

- **kconfig**：Shiki 316 种语言里**没有** kconfig（只有 kql/kotlin/kusto）
- **math**：**历史遗留**——早期讲义公式是 ASCII 版式（`v(t) = V0 · sin(ωt)`），用 `latex` 语法高亮不出东西，
  故自造了 math 语法。**2026-10-07 起站点启用构建期 KaTeX**（`docs/.vitepress/math.mts`），
  新公式一律写 LaTeX（`\(…\)` / `$$…$$`，见根 `AGENTS.md` §4.9），`math` 围栏只服务那 67 处老内容（逐讲迁移中）。

视觉审计（2026-10-05 截图）：Kconfig 与 VS Code 装 Kconfig 扩展的效果一致；
shellsession 命令行与输出颜色分明；math 的量纲/函数名/运算符分层清晰。

## 2. 「改哪里生效什么」矩阵

| 想做的事 | 只改这个 |
|---|---|
| **新增一整组课程** | `docs/.vitepress/groups.mts`（加一条）+ 内容目录（见 `content/add-lecture.md` §7） |
| 改课程组标题/简介/配色/标签 | `groups.mts` 对应那一条 |
| 改首页结构（统计条/能力卡/阅读提示） | `theme/HomeBody.vue` |
| 改组内页（徽章/统计/讲次表） | `theme/GroupIndex.vue` |
| 改顶栏 nav / 侧边栏分组逻辑 | `config.mts`（扫描逻辑，通常不用动） |
| 加/删工具条按钮、改按钮文案与图标 | `charts.ts` → `TOOL_DEFS` + `TOOLS_BY_TYPE` |
| 改图表标签文案（"数据图表"等） | `charts.ts` → `TAG_LABEL` |
| 某类图要不要显示某个按钮 | `charts.ts` → `TOOLS_BY_TYPE` |
| 修 title/legend/grid 重叠、轴名被裁 | `charts.ts` → `normalizeEchartsLayout` |
| 全屏弹层外观 / 快捷键 | `custom.css` 弹层段 + `charts.ts` → `openChartModal` |
| 图表卡片边框、配色、默认高度 | `custom.css` |
| 换站点图标 | `docs/public/favicon.svg` + `favicon.ico` + `icon-192.png` + `apple-touch-icon.png`，并在 `config.mts` 的 `head` 声明（见 `ops/README.md` §5） |
| 首页/组内页样式 | `custom.css` 的「首页」「课程组内页」两段 |
| 沉浸阅读版心、字号、顶栏 | `custom.css` → `html.reading-mode` 段 |
| 阅读位置恢复策略 / 提示条 | `theme/reading-progress.ts`（+ `custom.css` 的 `#lecture-resume-hint`） |
| 提示条出现/消失时长 | `reading-progress.ts` 的 `HINT_HOLD` **必须与** `custom.css` 里 `transition` 时长一起改（现为淡入 0.24s + 停留 1.1s + 淡出 0.24s，全程 < 2s；鼠标悬停会暂停自动消失） |
| 新增一讲（侧边栏出现条目） | **不改代码**：新增 `docs/<dir>/LNN.md` 即自动出现 |
| 新增/修改一张图表源 | 该讲的 `docs/public/charts/<ID>-LNN.json`（见 `content/`） |

**判断标准**：与"图怎么渲染、有哪些按钮"有关 → `charts.ts`；与"长什么样"有关 → `custom.css`；
与"有哪些课程组、导航怎么生成"有关 → `groups.mts` + `config.mts`；与"某一讲内容/图表数据"有关 → `content/`。

**判断标准**：与"图怎么渲染、有哪些按钮"有关 → `charts.ts`；与"长什么样"有关 → `custom.css`；
与"导航、标题、搜索"有关 → `config.mts`；与"某一讲内容/图表数据"有关 → `content/` 对应文件。

## 3. 运行时数据流

```
docs/<group>/EX-L01.md
  └ <figure class="chart" data-lecture="EX-L01" data-id="c1" data-type="mermaid"></figure>
        │  （讲义里只写这一行，其余全部运行时生成）
        ▼
fetch /charts/EX-L01.json   →   { "c1": { "type": "...", "code": "..." } }
        │
        ▼
charts.ts  initCharts()                       ← 幂等，可被 onUpdated 反复调用
  ├ ensureSkeleton(fig)      生成 .chart-body + 标签 + 工具条 + 源码折叠
  ├ injectSource(fig, code)  填充 details.chart-code
  ├ normalizeEchartsLayout() 仅 echarts，修标题/图例/绘图区/轴名位置
  ├ renderMermaid / renderEcharts / renderWavedrom
  └ fig.dataset.chartStatus = ok | loading | missing | error | unknown-type
```

**诊断**：浏览器里直接看 `<figure data-chart-status>`；停在 `loading` 说明 fetch 或渲染卡住，
停在 `missing` 说明 md 里的 `data-id` 在 JSON 中不存在。

## 4. 构建

```bash
cd site && npm run build        # → docs/.vitepress/dist
```

**构建后必须重启预览服务**：`vitepress preview` 不感知 dist 变化，继续返回旧 HTML →
引用已被新构建覆盖的 chunk → `404` → **Vue 不挂载**。
症状很迷惑：`figure` 元素齐全（SSR 输出），但 `__CHARTS_DONE__` 永远 `undefined`、
`lecture-reading-btn` 不存在。排查方法见 `ops/README.md`。

## 5. 已确立的约束（都是踩过的坑）

- **figure 与正文之间留空行**：markdown-it 才会把它当独立 html_block；紧凑写法是老渲染器的要求，现已统一为标准空行。
- **mermaid `foreignObject`** 默认 `overflow:hidden` 且高度恰好等于行数×行高，中文行末会被裁 → CSS 强制 `overflow:visible!important`。
- **echarts 内联高度**由 `figure.chart[data-type='echarts'] .chart-body{height:430px}` 决定；弹层要用**同等优先级、不带 `!important`** 的规则覆盖，否则 JS 写入的内联 `width/height`（缩放）会被压住。
- **沉浸阅读必须三件套一起改**：`--vp-nav-height`、`.VPContent{padding-top}`、顶栏背景；只隐藏侧栏会导致顶栏"穿透"。
- **SPA 幂等**：`initCharts` 靠 `[data-rendered]` 守卫，工具条靠 `data-tools-bound` 守卫，事件委托绑在 `figure` 上（工具条会被重建，绑按钮会失效）。
- **字体竞态**：mermaid 必须等 `document.fonts.ready` 再渲染，否则按回退字体估高、中文字体到位后溢出；但必须加超时兜底（2.5s），否则个别环境会卡死整页。
- **`h2` 自带横线把标题推低**：VitePress 的 `.vp-doc h2` 带 `border-top:1px` + `padding-top:24px`，
  优先级 `(0,1,1)`；组件里只写 `.gi-title { border-top:0 }`（`(0,1,0)`）**会被覆盖** →
  组内页标题下方多一条突兀的横线、且被推低 24px、看着与徽章不齐。
  **覆盖它必须提升选择器优先级**：`.vp-doc h2.gi-title { border-top:0; padding-top:0; margin:0 }`。
- **flex 的换行判定发生在收缩之前**：`flex: 1 1 auto` 会按**内容宽度**判断能否放下，
  长标题（~430px）+ 左边按钮（290px）> 容器（688px）→ 直接被挤到下一行、还占满整行。
  要「同行且占满剩余宽度」必须用 **`flex: 1 1 0`**（basis 0，换行只看 `min-width`）。
- **行内元素里的换行空白**：`<a>` 标签内换行缩进会渲染出一个空格，按钮文字看着不居中 →
  文字用 `<span>` 包裹、样式走 `inline-flex + align-items:center`。
- **`header-anchor` 的零宽空格**：VitePress 在标题里插 `<a class="header-anchor">​</a>`，
  取 `h1.textContent` 会带上 `\u200b` → 存进 localStorage 的标题会多个不可见字符，需 `.replace(/\u200b/g,'')`。
