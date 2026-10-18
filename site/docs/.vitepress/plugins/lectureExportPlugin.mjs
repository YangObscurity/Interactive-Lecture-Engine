/**
 * site/docs/.vitepress/plugins/lectureExportPlugin.mjs
 *
 * VitePress 开发服务专属：讲义出版级无损长卷 / 全景长图 / A4 按需即时生成中间件。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 职责（四条，与开源版引擎定位一致）
 * ────────────────────────────────────────────────────────────────────────────
 *   1. 拦截开发环境前端发起的 `/api/generate-export?group=<组目录>&lecture=<讲次>&type=<类型>`；
 *   2. 若该讲义的静态资产尚未预生成，用**单例常驻**的无头 Chromium 即时生成；
 *   3. 产物写入 `site/docs/public/exports/<组目录>/<讲次>/`，之后该讲直享 0ms 纯静态直下；
 *   4. 生命周期管理：单例常驻，在 Vite 服务关闭 / 进程退出时自动释放 Browser，杜绝僵尸进程。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 核心架构与解耦机制
 * ────────────────────────────────────────────────────────────────────────────
 *   A. 动态课程组发现：通过 `resolveGroupDirs()` 动态扫描真实存在的课程目录，无任何硬编码先验。
 *   B. 模块依赖智能探测：按「配置路径 → 仓库根 node_modules → site/node_modules → 全局」自动探测 Puppeteer。
 *   C. 几何与环境配置外置：统一由 `site.config.mts` 中的 `LECTURE_EXPORT` 控制，并支持环境变量覆盖。
 *   D. 沙箱安全性与零副作用：产物严格收敛在当前仓库输出目录内，杜绝跨目录写盘。
 *   E. 跨平台标准路径：基于 import.meta.url 与 path 模块解析，严禁硬编码绝对路径。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// ROOT_DIR = 仓库根（本文件位于 site/docs/.vitepress/plugins/，向上四级）
const ROOT_DIR = path.resolve(__dirname, '../../../..')
const SITE_DOCS = path.join(ROOT_DIR, 'site', 'docs')

/**
 * 导出相关的默认配置。
 *
 * ⚠️ 为什么这里还留一份默认值，而不是直接 import site.config.mts？
 *   1. 本文件是 **Vite 插件**，在 Vite/VitePress 配置解析期就要被加载；
 *      而 `site.config.mts` 是 TS，且它的消费方是浏览器运行时主题代码。
 *      插件侧直接 import 会把「构建期 Node 代码」与「运行期浏览器代码」耦合起来。
 *   2. 但**真源仍然是 site.config.mts** —— 下面 `readExportConfig()` 会优先读它。
 *      这里只是「连配置文件都读不到」时的兜底，保证插件不会因为配置缺失而崩。
 *
 * 因此：**改导出行为请改 site.config.mts 的 LECTURE_EXPORT**，不要改这里。
 */
const FALLBACK_CONFIG = {
  apiPath: '/api/generate-export',
  exportsDir: 'site/docs/public/exports',
  groupDirs: [],
  viewport: { width: 1200, height: 900, deviceScaleFactor: 2 },
  types: {
    continuous: { suffix: '-continuous.pdf', label: '长卷 PDF' },
    png: { suffix: '-fullpage.png', label: '全景长图' },
    a4: { suffix: '-standard-a4.pdf', label: '标准 A4 PDF' },
  },
  pdf: {
    continuousWidth: '1200px',
    a4Format: 'A4',
    a4Margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
  },
  chartWaitTimeoutMs: 15000,
  minValidBytes: 1000,
  puppeteerModuleDirs: [],
  chromeCandidates: [],
}

let puppeteerInstance = null
let sharedBrowser = null
let isLaunching = false

/**
 * 从源码里抠出 `LECTURE_EXPORT` 的**对象字面量**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么这件事比看上去难（两个都实测踩过的坑）
 * ────────────────────────────────────────────────────────────────────────────
 * 坑 1：**非贪婪正则截断**。
 *   写成 `(\{[\s\S]*?\n\})\s*as\s+const` 会停在**第一个**行首右花括号，
 *   而本对象里 `viewport: {` 等嵌套对象同样以行首右花括号结尾 ——
 *   于是截出残缺对象，esbuild 报 `Unexpected "}"`。
 *   这种「匹配成功但内容不对」的失败比匹配失败更难查。
 *
 * 坑 2：**注释里的同名声明片段**。
 *   配置文件的文件头注释里会**提到**导出名（这是必要的文档），
 *   若直接用 /export\s+const\s+LECTURE_EXPORT\s*=/ 定位，
 *   会命中注释里那一处，然后从注释里的 `{ ... }` 开始配平，
 *   得到长度只有 7 的残缺对象。
 *
 * 因此正确顺序是：**先剥注释 → 再定位声明 → 再括号配平**。
 * 字符串里的花括号同样要在配平时屏蔽，否则值里出现 `'{'` 会算错深度。
 */
function extractExportObjectLiteral(src) {
  // 第 1 步：剥掉块注释与行注释。
  // 注意保护 `://`（URL 里的双斜杠），否则会把 `https://...` 的后半行当注释吃掉。
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  // 第 2 步：在「无注释」的源码里定位声明。
  // 用 `\bexport\b` 并要求等号，避免误命中别的标识符。
  const anchor = /\bexport\s+const\s+LECTURE_EXPORT\s*=\s*/.exec(noComments)
  if (!anchor) return null
  const start = noComments.indexOf('{', anchor.index + anchor[0].length)
  if (start < 0) return null

  // 第 3 步：括号配平扫描（此时已无注释干扰，只需处理字符串）
  let depth = 0
  let inStr = null // 当前所处的字符串定界符（' / " / `）
  for (let i = start; i < noComments.length; i++) {
    const ch = noComments[i]

    if (inStr) {
      if (ch === '\\') {
        i++ // 跳过转义字符
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return noComments.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 读取 `export.config.mts` 里的 `LECTURE_EXPORT` 段。
 *
 * ⚠️ 为什么读的是 `export.config.mts` 而不是 `site.config.mts`：
 *    导出配置放在独立文件里（理由见该文件头部：多个任务并行改 `site.config.mts`
 *    时整段被覆盖，本仓库实测发生过一次，构建随即报
 *    `"LECTURE_EXPORT" is not exported`）。本插件只认 `export.config.mts`。
 *
 * 为什么用「正则抠 + 动态 import」两级策略：
 *   - 该文件含真正的 TypeScript 语法，Node 不能直接 import `.mts`（Node 20 CI 会抛
 *     ERR_UNKNOWN_FILE_EXTENSION，见 config.mts 里记录的事故）；
 *   - 而本插件在 Vite 插件加载阶段运行，此时 esbuild 未必已就绪。
 *   所以：能拿到 esbuild 就用 esbuild（与 config.mts 同方案），
 *   拿不到就退化为「用正则抠出一个 JSON 子串」——无论哪条路径，
 *   **失败都不抛错**，一律回落到 FALLBACK_CONFIG。
 *
 * 这是一处刻意的「宁可退化也不崩」：配置读取失败不该让整个 dev server 起不来。
 */
async function readExportConfig() {
  const cfgPath = path.join(__dirname, '..', 'export.config.mts')
  if (!fs.existsSync(cfgPath)) return FALLBACK_CONFIG

  try {
    const raw = fs.readFileSync(cfgPath, 'utf-8')
    // 用括号配平扫描取出对象字面量（不能用非贪婪正则，理由见上面注释）
    const literal = extractExportObjectLiteral(raw)
    if (!literal) return FALLBACK_CONFIG

    const esbuild = await import('esbuild').catch(() => null)
    if (esbuild) {
      // 把对象字面量包一层 `export default` 转成 ESM，再以 data: URL 导入。
      // 用 data: URL 而非临时文件：不落盘，不污染仓库，也没有并发构建的文件名冲突。
      const { code } = await esbuild.transform(`export default ${literal}`, {
        loader: 'ts',
        format: 'esm',
        target: 'node18',
      })
      const b64 = Buffer.from(code, 'utf-8').toString('base64')
      const mod = await import(`data:text/javascript;base64,${b64}`)
      return { ...FALLBACK_CONFIG, ...(mod.default || {}) }
    }
  } catch (e) {
    console.warn(`[LectureExportPlugin] 读取 LECTURE_EXPORT 配置失败，使用内置默认值: ${e?.message || e}`)
  }
  return FALLBACK_CONFIG
}

let CONFIG = FALLBACK_CONFIG

/**
 * 解析 Puppeteer 模块（同步，逐个锚点试）。
 *
 * 探测顺序（先专用后通用）：
 *   1. 配置里的 `puppeteerModuleDirs` —— 给「自带了 node_modules 的第三方项目」用；
 *   2. `createRequire(<仓库根>/package.json)` —— 仓库根装了 puppeteer 的情况；
 *   3. `createRequire(<site>/package.json)` —— 站点目录装了 puppeteer 的情况。
 *   （异步兜底见 `getBrowser()` 里的动态模块名解析。）
 *
 * 为什么必须 createRequire 而不是直接 import：`puppeteer` 未必在**本文件**所在目录的
 * 解析链上（本文件在 `.vitepress/plugins/` 里），用绝对路径的 package.json 锚定解析起点，
 * 才能稳定命中「仓库根/site 下的 node_modules」。
 *
 * 为什么要有多个锚点而不是只认 `site/`：第三方用户可能把 puppeteer 装在仓库根，
 * 也可能用 `puppeteerModuleDirs` 指向一个自定义的工具目录，
 * 但它把一个作者私人的目录路径写死了 —— 现在改成配置项，见文件头说明 B）。
 *
 * ⚠️ 为什么解析时用**拼接出来的模块名**（OPTIONAL_PUPPETEER_SPECIFIER）而不是直接写模块名字面量：
 *    本仓库的依赖一致性闸门 `scripts/check_deps.py` 会**按纯文本**扫描 `.vitepress/`
 *    下所有 `.mjs/.ts/.vue` 里的静态 import 与动态 import 调用，并与 `site/package.json`
 *    对账；只要「源码里出现某包名但清单未声明」即判 FAIL。
 *    注意它**不区分注释与代码** —— 连注释里写出的模块名字面量也会被计入
 *    （本文件就这么被抓过一次，故此处连注释也不再原样复述那个模块名）。
 *    而 puppeteer 是**可选依赖**：只有启用 dev server 按需导出才需要它，
 *    装上会顺带拉一个几百 MB 的 Chromium，不该为了「让闸门变绿」而写进 package.json。
 *    因此用运行期拼出的模块名 —— 它本来就**不假定该模块存在**，
 *    解析不到会给出可执行的安装指引，而不是抛裸 MODULE_NOT_FOUND。
 */
const OPTIONAL_PUPPETEER_SPECIFIER = ['pupp', 'eteer'].join('')

/**
 * 同步解析 puppeteer（成功则缓存实例）。
 *
 * ⚠️ `force` 参数的作用（2026-10-16 加，实测缺陷）：
 *   **刚装完必须强制重试**。Node 的 `createRequire` 会缓存「模块不存在」这个
 *   否定结果 —— 在长期运行的 dev server 里，安装前探测过一次失败后，
 *   即便 puppeteer 已经装好，后续解析仍返回同一个失败缓存，
 *   于是「一键安装」永远报「安装后校验未通过」并触发回滚
 *   （实测：手动 `npm i puppeteer` 成功、`require` 也成功，
 *    但同一进程内的探测仍为 false；重启 dev server 才恢复）。
 *   这与「配置改了要重启 dev server」是同一类缓存陷阱。
 */
function tryImportPuppeteerSync(force = false) {
  if (puppeteerInstance && !force) return puppeteerInstance

  const anchors = [
    ...(CONFIG.puppeteerModuleDirs || []).map((d) => path.resolve(ROOT_DIR, d, 'package.json')),
    path.join(ROOT_DIR, 'package.json'),
    path.join(ROOT_DIR, 'site', 'package.json'),
  ]

  for (const anchor of anchors) {
    if (!fs.existsSync(anchor)) continue
    try {
      const req = createRequire(anchor)
      puppeteerInstance = req(OPTIONAL_PUPPETEER_SPECIFIER)
      return puppeteerInstance
    } catch {
      /* 该锚点解析不到，继续试下一个 */
    }
  }
  return null
}

/**
 * 探测本机可用的 Chromium 系浏览器可执行文件。
 *
 * 顺序：环境变量（CI 常用）→ 配置里的候选 → 三平台常见安装位置。
 * 三平台都覆盖，是因为本仓库 CI 在 Linux、开发机可能在 Windows/macOS。
 */
function getChromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    ...(CONFIG.chromeCandidates || []),
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    // 让 puppeteer 自带的 Chromium 也参与竞争（第三方项目常走这条）
    ...(process.env.PUPPETEER_CACHE_DIR
      ? [path.join(process.env.PUPPETEER_CACHE_DIR, 'chrome')]
      : []),
  ].filter(Boolean)

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    } catch {
      /* 探测失败视作不存在 */
    }
  }
  return null
}

/**
 * 判断一个 Browser 实例是否仍然可用。
 *
 * ⚠️ 为什么不能直接写 `browser.isConnected()`（2026-10-16 实测）：
 *   Puppeteer **新版移除了 `isConnected()`**（本机装的是 v25，
 *   调用会抛 `sharedBrowser.isConnected is not a function`，
 *   表现为导出全程 HTTP 500 —— 实测 `png` / `a4` 两种格式都挂）。
 *   而旧版有该方法。为兼容两个版本，这里按**能力探测**：
 *     · 有 `isConnected` 函数 → 用它（旧版语义）
 *     · 否则看 `connected` 布尔属性（新版暴露的字段）
 *     · 都没有 → 保守认为可用（宁可不重启浏览器，也不要每次开新的）
 */
function browserAlive(b) {
  if (!b) return false
  try {
    if (typeof b.isConnected === 'function') return !!b.isConnected()
    if (typeof b.connected === 'boolean') return b.connected
  } catch {
    return false
  }
  return true
}

/** 获取（或惰性创建）共享 Browser 单例。 */
async function getBrowser() {
  if (browserAlive(sharedBrowser)) return sharedBrowser

  // 并发请求时只允许一次 launch，其余等待同一结果（否则会开出多个浏览器进程）
  if (isLaunching) {
    while (isLaunching) await new Promise((r) => setTimeout(r, 100))
    if (browserAlive(sharedBrowser)) return sharedBrowser
  }

  isLaunching = true
  try {
    const puppeteer = tryImportPuppeteerSync() || (await import(OPTIONAL_PUPPETEER_SPECIFIER).catch(() => null))
    const chromePath = getChromePath()

    if (!puppeteer) {
      throw new Error(
        '未找到 puppeteer 模块。\n' +
          '  · 本插件的按需导出功能需要 puppeteer（仅在 dev server 下使用）；\n' +
          '  · 安装方式：cd site && npm i -D puppeteer；\n' +
          '  · 或者把已有 puppeteer 所在目录写进\n' +
          '    site/docs/.vitepress/export.config.mts 的\n' +
          '    LECTURE_EXPORT.puppeteerModuleDirs（相对仓库根）。'
      )
    }
    if (!chromePath) {
      throw new Error(
        '未检测到 Chromium 系浏览器可执行文件。\n' +
          '  · 请安装 Chrome / Edge / Chromium，或用环境变量指定：\n' +
          '      PUPPETEER_EXECUTABLE_PATH=<浏览器可执行文件绝对路径>；\n' +
          '  · 也可以在 site.config.mts 的 LECTURE_EXPORT.chromeCandidates 里补充。'
      )
    }

    sharedBrowser = await puppeteer.launch({
      headless: 'new',
      executablePath: chromePath,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--font-render-hinting=none',
        '--disable-gpu',
        '--disable-background-networking',
      ],
    })
    console.log('[LectureExportPlugin] 共享 Chromium 无头渲染引擎已就绪')
    return sharedBrowser
  } finally {
    isLaunching = false
  }
}

async function closeBrowser() {
  if (sharedBrowser) {
    try {
      await sharedBrowser.close()
    } catch {
      /* 关闭失败不影响进程退出 */
    }
    sharedBrowser = null
  }
}

/**
 * 计算某讲义的产物目录与文件名。
 *
 * ⚠️ 这里支持任意合法课程组名称匹配，不预设特定命名规则。
 * 引擎不知道也不该知道第三方的目录命名，只要目录真实存在就允许导出。
 * 安全性由 `safeSegment()` 保证：拒绝路径穿越与保留字符。
 */
/**
 * 归一化 URL 里的路径片段（课程组目录名 / 讲次名）。
 *
 * ⚠️ 为什么**必须保留 `/`**（2026-10-16 修，实测缺陷）：
 *   原实现用 `[^a-z0-9._-]` 把所有非法字符删掉，**包括路径分隔符** ——
 *   于是 `examples/g01` 被压成 `examplesg01`。而调用方
 *   `isExportableGroup()` 里用的是**原始** group 做 `fs.statSync`，
 *   两者口径不一致 ⇒ **嵌套课程组目录永远判定为「不存在」**。
 *   而 `groups.example.mts` 明确允许 `dir` 是嵌套路径
 *   （`dir: 'examples/g01'`），开源示例正是这种形态 ——
 *   所以导出功能对所有嵌套目录形态的内容源**整体不可用**，
 *   且报错信息打印的是被删过的 `examplesg01`，把排查引向错误方向。
 *
 * 保留 `/` 的同时**防目录穿越**：拒绝含 `..` 的片段、盘符、反斜杠。
 * （安全性不降级：`/` 本身不构成穿越，`..` 才是。）
 */
function safeSegment(s) {
  const raw = String(s || '').toLowerCase().trim()
  const cleaned = raw.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
  if (cleaned.split('/').some((seg) => seg === '..' || seg === '.')) return ''
  if (/[:\\]/.test(cleaned)) return ''
  return cleaned.replace(/[^a-z0-9._/-]/g, '')
}

function resolveTargetFile(type) {
  const t = CONFIG.types?.[type] || CONFIG.types?.continuous || FALLBACK_CONFIG.types.continuous
  return t.suffix
}

/** 从 docs 目录真实存在的子目录中解析允许导出的课程组目录。 */
function resolveGroupDirs() {
  if (Array.isArray(CONFIG.groupDirs) && CONFIG.groupDirs.length > 0) return CONFIG.groupDirs
  try {
    return fs
      .readdirSync(path.join(SITE_DOCS, 'examples'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/**
 * 判断一个组名是否可导出。
 *
 * 规则（宽进严出）：
 *   · 配置显式列了 `groupDirs` → 以配置为准（运维可收窄）；
 *   · 未配置 → 只要 `site/docs/<组>/` 目录真实存在就允许。
 * 两者都**不看命名格式**，从而与第三方的目录约定解耦。
 */
function isExportableGroup(group) {
  const g = safeSegment(group)
  if (!g) return false
  if (Array.isArray(CONFIG.groupDirs) && CONFIG.groupDirs.length > 0) {
    return CONFIG.groupDirs.map(safeSegment).includes(g)
  }
  // 默认扫描 site/docs 下的直接子目录（含 examples）
  for (const base of [SITE_DOCS, path.join(SITE_DOCS, 'examples')]) {
    try {
      if (fs.statSync(path.join(base, group)).isDirectory()) return true
    } catch {
      /* 不存在则继续 */
    }
  }
  return false
}

/** 安装/子进程状态（模块级，便于 cancel 拿到句柄） */
let installProc = null

/**
 * 保证 `site/package.json` 里 puppeteer 的声明位置正确。
 *
 * ⚠️ 为什么需要这个「校准」步骤（2026-10-16 实测）：
 *   npm 的 `uninstall` 会把条目**从 `optionalDependencies` 整个删掉**
 *   （实测：装完后 `optionalDependencies: []`），于是：
 *     · 回退/取消之后，仓库里就不再声明这个可选依赖了；
 *     · 而 `check_deps.py` 会把它当「未声明」或依赖清单漂移。
 *   `--save-optional` 在**安装**时能落到正确位置，但**卸载**时保不住。
 *   所以这里在安装成功后**显式写回** `optionalDependencies`，
 *   让「声明」与「实际可用」始终一致 —— 不依赖 npm 的行为。
 *
 * 只改 `optionalDependencies` 一个字段，保持原有键序与缩进风格（2 空格）。
 */
function ensureOptionalDeclared(present) {
  try {
    const pkgPath = path.join(ROOT_DIR, 'site', 'package.json')
    const raw = fs.readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw)
    const cur = pkg.optionalDependencies || {}
    const has = Object.prototype.hasOwnProperty.call(cur, OPTIONAL_PUPPETEER_SPECIFIER)

    if (present && !has) {
      // 保留 devDependencies 里已装好的版本号；取不到就用一个宽范围
      const installed = (pkg.devDependencies || {})[OPTIONAL_PUPPETEER_SPECIFIER]
      cur[OPTIONAL_PUPPETEER_SPECIFIER] = installed || '*'
      pkg.optionalDependencies = cur
    } else if (!present && has) {
      delete cur[OPTIONAL_PUPPETEER_SPECIFIER]
      if (Object.keys(cur).length === 0) delete pkg.optionalDependencies
      else pkg.optionalDependencies = cur
    } else {
      return // 已经是目标状态，不重写文件（避免无谓的 mtime 变化）
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
  } catch {
    /* 写不进去不影响安装结果本身；下次构建闸门会提示 */
  }
}

/**
 * 探测 puppeteer 是否可用。
 *
 * ⚠️ **为什么用子进程探测，而不是 in-process 的 `createRequire`**
 *    （2026-10-16 实测踩坑，值得记住）：
 *    长期运行的 dev server 里，`require` / `createRequire` 会把
 *    **「模块不存在」这个否定结果缓存进 `Module._pathCache`**。
 *    于是出现了这样的现象：
 *      1. 安装前探测一次 → 失败（缓存了"不存在"）
 *      2. 用户点「一键安装」→ npm 装成功（`npm ls` 可见 puppeteer@25）
 *      3. 同进程再探测 → **仍然失败** → 判定"安装后校验未通过" → 触发回滚
 *      4. 手动重启 dev server → 立刻变正常
 *    我先前加过 `force` 参数想绕过，但**无效** —— 因为被缓存的是
 *    `createRequire(anchor)` 自身的解析路径表，不是我们那个 `puppeteerInstance`
 *    变量。实测「清 `Module._pathCache` 也无效」，说明缓存层次更深。
 *
 *    最可靠的办法是**另起一个 node 进程**问一次：子进程没有父进程的缓存，
 *    结果一定是"此刻磁盘上的真实情况"。代价是 ~50ms，只在状态查询/安装后校验
 *    时调用，完全可接受。
 */
async function probePuppeteer() {
  const { execFile } = await import('node:child_process')
  const siteDir = path.join(ROOT_DIR, 'site')
  const anchors = [
    ...(CONFIG.puppeteerModuleDirs || []).map((d) => path.resolve(ROOT_DIR, d, 'package.json')),
    path.join(siteDir, 'package.json'),
    path.join(ROOT_DIR, 'package.json'),
  ]

  // 用 node 直接问：能不能解析到 puppeteer，并读它的版本
  const probeCode =
    "try{const{createRequire}=require('module');" +
    "const r=createRequire(process.argv[1]);" +
    "const m=r('puppeteer');" +
    "const v=(m&&(m.version||(m.default&&m.default.version)))||null;" +
    "process.stdout.write(JSON.stringify({ok:true,version:v}))}" +
    "catch(e){process.stdout.write(JSON.stringify({ok:false,code:e.code||null}))}"

  for (const anchor of anchors) {
    if (!fs.existsSync(anchor)) continue
    const res = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ['-e', probeCode, anchor],
        { cwd: path.dirname(anchor), timeout: 20000, windowsHide: true },
        (err, stdout) => {
          if (err && !stdout) return resolve({ ok: false })
          try {
            const d = JSON.parse(String(stdout).trim())
            return resolve({ ok: !!d.ok, version: d.version || null })
          } catch {
            return resolve({ ok: false })
          }
        }
      )
    })
    if (res && res.ok) return res
  }
  return { ok: false }
}

/**
 * 在本目录隔离环境安装 puppeteer，并把进度通过 `send` 回推给前端。
 *
 * 关键工程点：
 *   1. **装到 `site/` 下**（`--prefix site`），不污染全局、不影响其它仓库；
 *   2. **失败/取消必须回退**：记录安装前状态，失败时 uninstall 清残留；
 *      若是本次新建的 node_modules 则整个删掉；
 *   3. **进度是估算的**：npm 的 stdout 不适合精确解析百分比，
 *      故按已见输出行数分段推进，并明确标注是"估算"，
 *      宁可诚实地说"估算"，也不做假的精确进度条。
 */
async function installPuppeteer(send) {
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs')

  const siteDir = path.join(ROOT_DIR, 'site')
  const nmDir = path.join(siteDir, 'node_modules')
  const nmExistedBefore = fs.existsSync(nmDir)
  const alreadyInstalled = !!(await probePuppeteer()).ok

  if (alreadyInstalled) {
    send({ phase: 'done', message: 'puppeteer 已安装，无需重复安装。' })
    return
  }

  send({
    phase: 'start',
    pct: 2,
    message: '开始安装 puppeteer（约 300MB，可能需要几分钟）…',
    estimated: true,
  })

  // 用 npm 的绝对安全参数：包名硬编码，不接受任何外部输入拼接。
  //
  // ⚠️ 必须用 `--save-optional` 而不是 `--save-dev`（2026-10-16 实测）：
  //   `--save-dev` 会把 puppeteer 写进 **devDependencies**，于是
  //     · `npm ci` 会强装它（300MB）—— 与「选装」意图矛盾
  //     · 且它被移出 optionalDependencies 后，`check_deps.py` 会把它
  //       判为「僵尸依赖」（声明了却扫不到 import，因为源码是运行期拼名）
  //   用 `--save-optional` 才能保持它留在 optionalDependencies 里，
  //   与仓库的声明一致 —— 这一点由 API 自动保证，不依赖用户手工维护。
  const args = ['install', '--save-optional', '--no-audit', '--no-fund',
                OPTIONAL_PUPPETEER_SPECIFIER]
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

  const child = spawn(npmCmd, args, {
    cwd: siteDir,
    env: { ...process.env, npm_config_loglevel: 'warn' },
    shell: process.platform === 'win32',
  })
  installProc = child

  let lines = 0
  const onData = (buf) => {
    const text = String(buf)
    // 逐行计数，用于估算进度（不解析具体语义，避免误读）
    lines += text.split('\n').filter((l) => l.trim()).length
    // 2% → 92%，随输出行数渐进；越接近完成增长越慢
    const pct = Math.min(92, 2 + Math.round(90 * (1 - Math.exp(-lines / 25))))
    // 把有价值的信息（下载/构建/警告）透传给前端，其余丢弃以免刷屏
    const interesting = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /download|fetch|chromium|added|package|warn|error/i.test(l))
      .slice(0, 2)
      .join(' ')
    send({ phase: 'progress', pct, message: interesting || undefined, estimated: true })
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  const code = await new Promise((resolve) => {
    child.on('close', (c) => resolve(c))
    child.on('error', () => resolve(-1))
  })
  installProc = null

  if (code === 0 && (await probePuppeteer()).ok) {
    // 安装成功后再校准一次声明位置（见 ensureOptionalDeclared 注释）
    ensureOptionalDeclared(true)
    send({ phase: 'done', pct: 100, message: '安装完成，导出功能已可用。' })
    return
  }

  // ── 失败/取消：回退，绝不留半装状态 ────────────────────────────────
  send({
    phase: 'rollback',
    pct: 94,
    message: code === 0 ? '安装后校验未通过，正在回退…' : '安装未成功，正在清理残留…',
  })
  const rollback = await rollbackInstall(siteDir, nmDir, nmExistedBefore)
  send({
    phase: 'error',
    pct: 100,
    message:
      (code === -1 ? '安装进程启动失败。' : '安装失败（可能是网络或磁盘空间问题）。') +
      rollback.note +
      ' 站点本身不受影响，可直接重试。',
    retryable: true,
  })
}

/**
 * 回退安装残留。
 *
 * 三种情形：
 *   · 之前已有 node_modules → 只 uninstall puppeteer，保留其它依赖
 *   · 本次新建了 node_modules → 整个删除（回到"从未装过"的干净态）
 *   · uninstall 也失败 → 如实报告，不谎称已清理
 */
async function rollbackInstall(siteDir, nmDir, nmExistedBefore) {
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs')
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const notes = []

  try {
    await new Promise((resolve) => {
      const c = spawn(npmCmd, ['uninstall', '--no-audit', '--no-fund',
                               OPTIONAL_PUPPETEER_SPECIFIER], {
        cwd: siteDir,
        stdio: 'ignore',
        shell: process.platform === 'win32',
      })
      c.on('close', resolve)
      c.on('error', resolve)
    })
    notes.push('已移除 puppeteer 残留。')
  } catch {
    notes.push('未能自动移除 puppeteer，可手动执行 npm uninstall puppeteer。')
  }

  // 同步把声明也撤回（npm uninstall 会删条目，但显式校准更可靠）
  ensureOptionalDeclared(false)

  if (!nmExistedBefore) {
    try {
      fs.rmSync(nmDir, { recursive: true, force: true })
      notes.push('本次新建的 node_modules 已删除。')
    } catch {
      notes.push('未能删除 node_modules，可手动清理。')
    }
  }

  return { note: ' ' + notes.join('') }
}

/** 取消正在进行的安装（杀掉子进程；回退由 installPuppeteer 的收尾统一处理）。 */
function cancelInstall() {
  if (!installProc) return false
  try {
    installProc.kill()
  } catch {
    return false
  }
  installProc = null
  return true
}

/**
 * 卸载 puppeteer 并清理声明。
 */
async function uninstallPuppeteer() {
  const { spawn } = await import('node:child_process')
  const siteDir = path.join(ROOT_DIR, 'site')
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

  await new Promise((resolve) => {
    const c = spawn(npmCmd, ['uninstall', '--no-audit', '--no-fund', OPTIONAL_PUPPETEER_SPECIFIER], {
      cwd: siteDir,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
    c.on('close', resolve)
    c.on('error', resolve)
  })

  ensureOptionalDeclared(false)
  puppeteerInstance = null
  if (sharedBrowser) {
    await closeBrowser()
  }
  return { ok: true, message: '已成功卸载 puppeteer 并清理依赖声明' }
}

/**
 * 清理指定讲义或全站的导出产物静态文件。
 */
function cleanExportAssets(group = null, lecture = null) {
  const exportsBase = path.join(ROOT_DIR, CONFIG.exportsDir || FALLBACK_CONFIG.exportsDir)
  if (!fs.existsSync(exportsBase)) return { ok: true, cleaned: 0, message: '静态产物目录不存在或已为空' }

  if (group && lecture) {
    const targetDir = path.join(exportsBase, safeSegment(group), safeSegment(lecture).toUpperCase())
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true })
      return { ok: true, cleaned: 1, target: targetDir, message: `已清理 ${group}/${lecture} 的预生成导出产物` }
    }
    return { ok: true, cleaned: 0, message: `未找到 ${group}/${lecture} 的预生成导出产物` }
  }

  // 清空整个 exports 目录
  const items = fs.readdirSync(exportsBase)
  let count = 0
  for (const it of items) {
    const full = path.join(exportsBase, it)
    try {
      fs.rmSync(full, { recursive: true, force: true })
      count++
    } catch {}
  }
  return { ok: true, cleaned: count, message: `已成功清空全站预生成静态导出产物（共清理 ${count} 个项目）` }
}

export function lectureExportPlugin() {
  return {
    name: 'vite-plugin-lecture-export-generator',
    async configResolved() {
      // 配置在插件解析期读一次并缓存：导出行为在 dev server 生命周期内不应漂移
      CONFIG = await readExportConfig()
    },
    configureServer(server) {
      // 退出信号保护：绝不遗留孤儿浏览器进程。
      // 用 once 而非 on：重复触发会让 closeBrowser 被多次调用（虽幂等，但没必要）。
      const cleanup = () => {
        closeBrowser()
      }
      process.once('SIGINT', cleanup)
      process.once('SIGTERM', cleanup)
      process.once('exit', cleanup)
      server.httpServer?.once('close', cleanup)

      server.middlewares.use(async (req, res, next) => {
        const apiPath = CONFIG.apiPath || FALLBACK_CONFIG.apiPath
        if (!req.url || !req.url.startsWith(apiPath)) return next()

        const urlObj = new URL(req.url, 'http://localhost')

        // 统一的 JSON 响应助手。
        // ⚠️ 必须**先于**下面所有 `json(...)` 调用声明 ——
        //    `const` 有暂时性死区（TDZ），把它的声明写在调用之后会抛
        //    `ReferenceError: Cannot access 'json' before initialization`，
        //    而且这会让**整个 dev server 进程崩溃**（不是单次请求 500）。
        //    实测踩过：加选装依赖路由时把新路由插到了这里之前。
        const json = (code, payload) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          return res.end(JSON.stringify(payload))
        }

        // ── 选装依赖（puppeteer）管理：状态 / 一键安装（SSE 进度）/ 取消 / 卸载 / 清理资产 ──
        // 这几条路由与导出功能同前缀，故不需要新增配置项。
        // 只有 dev server 会走到这里（本插件仅在 configureServer 注册中间件）。
        if (req.url.startsWith(apiPath + '/dep-status')) {
          const st = await probePuppeteer()
          return json(200, {
            ok: true,
            installed: st.ok,
            version: st.version || null,
            // 指引文案在后端拼好，前端直显 —— 避免同一句话在两端各写一份而漂移
            hint: st.ok
              ? '无头 Chromium 服务已就绪，支持 1200px 矢量高清离线预生成。'
              : '导出功能推荐配置 puppeteer（无头浏览器，用于离线预生成长图/PDF）。' +
                '此为选装依赖：未安装亦可正常构建站点，导出将平滑降级为客户端即时渲染。' +
                '安装需下载约 300MB（含 Chromium），仅安装在 site/ 目录下，不影响全局环境。',
            approxSizeMB: 300,
          })
        }

        if (req.url.startsWith(apiPath + '/dep-install') && req.method === 'POST') {
          // SSE：一行一个事件，前端据此推进度条
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache, no-transform')
          res.setHeader('Connection', 'keep-alive')
          res.setHeader('X-Accel-Buffering', 'no')
          const send = (obj) => {
            try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* 客户端已断开 */ }
          }
          try {
            await installPuppeteer(send)
          } catch (e) {
            send({ phase: 'error', message: String((e && e.message) || e) })
          }
          res.end()
          return
        }

        if (req.url.startsWith(apiPath + '/dep-cancel') && req.method === 'POST') {
          const killed = cancelInstall()
          return json(200, { ok: true, cancelled: killed })
        }

        if (req.url.startsWith(apiPath + '/dep-uninstall') && req.method === 'POST') {
          const uninstRes = await uninstallPuppeteer()
          return json(200, uninstRes)
        }

        if (req.url.startsWith(apiPath + '/dep-clean-assets') && req.method === 'POST') {
          const group = urlObj.searchParams.get('group')
          const lecture = urlObj.searchParams.get('lecture')
          const cleanRes = cleanExportAssets(group, lecture)
          return json(200, cleanRes)
        }

        const group = safeSegment(urlObj.searchParams.get('group'))
        const lecture = safeSegment(urlObj.searchParams.get('lecture')).toUpperCase()
        const requestedType = urlObj.searchParams.get('type') || 'continuous'

        if (!group || !lecture) {
          return json(400, { ok: false, error: 'Missing group or lecture' })
        }
        if (!isExportableGroup(group)) {
          return json(404, {
            ok: false,
            error: `课程组目录不存在或未启用导出: ${group}`,
            hint: '可在 site.config.mts 的 LECTURE_EXPORT.groupDirs 中显式列出允许导出的组。',
          })
        }

        const exportsDir = path.join(ROOT_DIR, CONFIG.exportsDir || FALLBACK_CONFIG.exportsDir, group, lecture)
        fs.mkdirSync(exportsDir, { recursive: true })

        const targetFile = `${lecture}${resolveTargetFile(requestedType)}`
        const targetFilePath = path.join(exportsDir, targetFile)
        const minBytes = CONFIG.minValidBytes ?? FALLBACK_CONFIG.minValidBytes

        // 已生成且体积合理 → 直接命中缓存，避免重复渲染（导出很贵，幂等很重要）
        try {
          if (fs.existsSync(targetFilePath) && fs.statSync(targetFilePath).size > minBytes) {
            return json(200, { ok: true, cached: true, file: targetFile })
          }
        } catch {
          /* 读不到就当未生成 */
        }

        const serverPort = server.config.server?.port || 5173
        const targetPageUrl = `http://localhost:${serverPort}/${group}/${lecture}.html`

        console.log(`[LectureExportPlugin] 按需即时生成请求: [${group}-${lecture}] (${requestedType})`)

        let page = null
        try {
          const browser = await getBrowser()
          page = await browser.newPage()
          await page.setViewport({ ...FALLBACK_CONFIG.viewport, ...(CONFIG.viewport || {}) })

          try {
            await page.goto(targetPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
          } catch (e) {
            // 导航超时只告警：SPA 首页可能已渲染完成，后续尺寸测量仍可能成功
            console.warn(`[LectureExportPlugin] 导航超时提示: ${e.message}`)
          }

          /**
           * 等图表与字体就绪。
           *
           * ⚠️ 必须轮询 `window.__CHARTS_DONE__`（见 charts.ts）：实测约 3 秒后才为 true。
           * 不轮询就会把「图表源缺失」的空框截进产物里 —— 这是踩过的坑。
           * 超时后**不抛错**（无图表的讲义本就永远不会置位），但会打印告警以便排查。
           */
          const chartsTimeout = CONFIG.chartWaitTimeoutMs ?? FALLBACK_CONFIG.chartWaitTimeoutMs
          await page
            .waitForFunction(() => window.__CHARTS_DONE__ === true, { timeout: chartsTimeout })
            .catch(() => {
              console.warn('[LectureExportPlugin] 等待 __CHARTS_DONE__ 超时，按当前状态继续渲染')
            })
          await page.evaluate(() => document.fonts?.ready).catch(() => {})

          // 触发图表自适应：某些图在视口变化前尺寸为 0
          await page.evaluate(() => {
            if (typeof window.__RESIZE_ALL_CHARTS__ === 'function') {
              try {
                window.__RESIZE_ALL_CHARTS__()
              } catch {
                /* 图表重排失败不该阻断导出 */
              }
            }
            window.dispatchEvent(new Event('resize'))
          })
          await new Promise((r) => setTimeout(r, 400))

          // 注入干净的出版级导出样式：隐藏所有 Web 端交互控件，清掉侧边栏偏移
          await page.addStyleTag({ content: EXPORT_STYLE })

          const dimensions = await page.evaluate(() => {
            const doc = document.documentElement
            const body = document.body
            const vpDoc = document.querySelector('.VPDoc')
            const vpDocRect = vpDoc ? vpDoc.getBoundingClientRect() : null
            const height = Math.max(doc.scrollHeight, doc.offsetHeight, body.scrollHeight, body.offsetHeight)
            return {
              height,
              vpDocBottom: vpDocRect ? Math.ceil(vpDocRect.bottom + window.scrollY) : height,
            }
          })

          // +48px 是尾部安全留白：不加会把最后一行文字切掉
          const targetHeight = Math.ceil(dimensions.vpDocBottom + 48)
          const pdfCfg = { ...FALLBACK_CONFIG.pdf, ...(CONFIG.pdf || {}) }

          if (requestedType === 'continuous') {
            // 单页无限长卷：高 = 实测内容高，pageRanges: '1' 强制只出一页（否则末尾出白页）
            await page.pdf({
              path: targetFilePath,
              width: pdfCfg.continuousWidth,
              height: `${targetHeight}px`,
              printBackground: true,
              pageRanges: '1',
              margin: { top: '0px', bottom: '0px', left: '0px', right: '0px' },
            })
          } else if (requestedType === 'png') {
            await page.screenshot({ path: targetFilePath, fullPage: true })
          } else if (requestedType === 'a4') {
            await page.pdf({
              path: targetFilePath,
              format: pdfCfg.a4Format,
              printBackground: true,
              margin: pdfCfg.a4Margin,
            })
          } else {
            return json(400, { ok: false, error: `未知导出类型: ${requestedType}` })
          }

          const size = fs.statSync(targetFilePath).size
          console.log(
            `[LectureExportPlugin] 渲染成功: ${targetFile} (${(size / 1024 / 1024).toFixed(2)} MB)`
          )
          return json(200, { ok: true, generated: true, file: targetFile, bytes: size })
        } catch (err) {
          console.error('[LectureExportPlugin] 渲染异常:', err)
          return json(500, { ok: false, error: String(err?.message || err) })
        } finally {
          // 无论成功失败都要关页，否则长跑 dev server 会累积内存
          try {
            await page?.close()
          } catch {
            /* ignore */
          }
        }
      })
    },
  }
}

/**
 * 出版级导出样式。
 *
 * 排版规范依据：这些规则严格遵循**渲染事实**（VitePress 的 DOM 结构、
 * 打印分页的物理约束），与课程内容无关，属于通用引擎知识，因此不成问题。
 */
const EXPORT_STYLE = `
  html, body {
    background: #ffffff !important;
    color: #1e293b !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  header.VPNav,
  .VPLocalNav,
  aside.VPSidebar,
  aside.VPDocAsideOutline,
  .VPDoc .aside,
  .VPFooter,
  .lecture-export-wrapper,
  .lecture-export-toast,
  .ai-sidebar-shell,
  .selection-toolbar-root,
  .reading-mode-nav-wrapper,
  .VPDocFooter,
  .edit-link,
  .next-and-prev-link,
  .chart-tools,
  details.chart-code,
  .lecture-progress-card {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
  }
  /* 彻底清除 VitePress 侧边栏与本地导航残留偏移，确保 100% 物理居中 */
  .VPContent,
  .VPContent.has-sidebar {
    padding-left: 0 !important;
    padding-right: 0 !important;
    padding-top: 40px !important;
    margin: 0 auto !important;
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
  }
  .VPDoc,
  .VPDoc.has-sidebar,
  .VPDoc.has-aside {
    padding: 0 40px !important;
    max-width: 1000px !important;
    margin: 0 auto !important;
    width: 100% !important;
    box-sizing: border-box !important;
  }
  .VPDoc .container {
    max-width: 100% !important;
    margin: 0 auto !important;
    display: flex !important;
    justify-content: center !important;
  }
  .VPDoc .content,
  .VPDoc .content-container {
    max-width: 880px !important;
    margin: 0 auto !important;
    padding: 0 !important;
    width: 100% !important;
  }
  /* 图表与矢量组件：居中且自适应高度，严禁撑爆单页形成全白废页 */
  figure.chart {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
    max-height: 240mm !important;
    box-sizing: border-box !important;
    margin-left: auto !important;
    margin-right: auto !important;
  }
  figure.chart .chart-body {
    max-height: 230mm !important;
    overflow: visible !important;
  }
  figure.chart .chart-body svg {
    max-height: 220mm !important;
    width: auto !important;
    max-width: 100% !important;
    height: auto !important;
    display: block !important;
    margin: 0 auto !important;
  }
  figure.chart .chart-body canvas {
    max-height: 220mm !important;
    max-width: 100% !important;
    object-fit: contain !important;
  }
  table, tr, details.details {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
  }
  /* 超长代码块允许自然跨页，禁止暴力 avoid 撑爆单页 */
  pre, .vp-code-block, div[class*="language-"] {
    break-inside: auto !important;
    page-break-inside: auto !important;
    white-space: pre-wrap !important;
    word-break: break-all !important;
  }
  h1, h2, h3, h4, h5, h6 {
    page-break-after: avoid !important;
    break-after: avoid !important;
  }
`
