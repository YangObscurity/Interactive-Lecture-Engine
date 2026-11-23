#!/usr/bin/env node
/**
 * scripts/pregenerate_assets.mjs — 讲义全景高清长图与无损长卷 PDF 预生成工具
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 核心架构原则（方案 A · 构建期无头 Chromium 原生预生成）
 * ────────────────────────────────────────────────────────────────────────────
 *   1. 彻底规避浏览器前端 Canvas 绘制的 MAX_TEXTURE_SIZE (16384px) 硬件截断限制；
 *   2. 锁定 1200px 黄金阅读出版宽度，保持两侧呼吸感留白，杜绝 770px 压迫感；
 *   3. CDP 协议直出：Page.captureScreenshot 截取超长高清长图，Page.printToPDF 导出单页长卷；
 *   4. 产物落盘到 site/docs/public/exports/<group>/<lecture>/，前端点击即 0ms 秒下。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// scripts/ lives in <repo>/site/scripts/ -> repo root is two levels up
const ROOT_DIR = path.resolve(__dirname, '..', '..')
const SITE_DOCS = path.join(ROOT_DIR, 'site', 'docs')
const EXPORTS_DIR = path.join(SITE_DOCS, 'public', 'exports')
const MANIFEST_FILE = path.join(EXPORTS_DIR, 'manifest.json')

// 彩色输出工具
const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const gray = (s) => `\x1b[90m${s}\x1b[0m`

/** 探测 Puppeteer 模块实例 */
function resolvePuppeteer() {
  const anchors = [
    path.join(ROOT_DIR, 'workspaces', 'lecture-enhancer', 'tools', 'visual', 'package.json'),
    path.join(ROOT_DIR, 'site', 'package.json'),
    path.join(ROOT_DIR, 'package.json'),
  ]

  for (const anchor of anchors) {
    if (!fs.existsSync(anchor)) continue
    try {
      const r = createRequire(anchor)
      return r('puppeteer')
    } catch {}
  }
  return null
}

/** 探测 Chrome / Chromium 可执行文件路径 */
function resolveChromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    } catch {}
  }
  return null
}

/** 自动探测可用的本地 VitePress 开发或预览服务端口 */
async function detectServerPort(preferredPort = 5173) {
  const portsToTest = [preferredPort, 5174, 4173]
  for (const port of portsToTest) {
    try {
      const res = await fetch(`http://localhost:${port}/`, { method: 'HEAD', signal: AbortSignal.timeout(1200) })
      if (res.ok || res.status < 500) return port
    } catch {}
  }
  return null
}

/** 扫描全部讲义文件 */
function scanAllLectures() {
  const list = []
  const groupDirs = fs.readdirSync(SITE_DOCS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (/^g\d{2}$/i.test(d.name) || /^dt$/i.test(d.name)))
    .map((d) => d.name)

  for (const group of groupDirs) {
    const fullGroupDir = path.join(SITE_DOCS, group)
    const files = fs.readdirSync(fullGroupDir)
      .filter((f) => /^L\d+\.md$/i.test(f))
      .sort((a, b) => {
        const na = parseInt(a.replace(/\D/g, ''), 10) || 0
        const nb = parseInt(b.replace(/\D/g, ''), 10) || 0
        return na - nb
      })

    for (const f of files) {
      const lecture = f.replace(/\.md$/i, '').toUpperCase()
      list.push({ group: group.toLowerCase(), lecture })
    }
  }
  return list
}

/** 解析单个讲义参数（例如 G01-L01, g01/L01, L01） */
function parseLectureArg(arg) {
  if (!arg) return null
  const m1 = arg.match(/^(g\d{2}|dt)[-/](L\d+)$/i)
  if (m1) return { group: m1[1].toLowerCase(), lecture: m1[2].toUpperCase() }

  const m2 = arg.match(/^(L\d+)$/i)
  if (m2) return { group: 'g01', lecture: m2[1].toUpperCase() }

  return null
}

/** 出版级导出纯净样式 */
const EXPORT_CSS = `
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
  html, body {
    background: #ffffff !important;
    color: #1e293b !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  .VPContent,
  .VPContent.has-sidebar {
    padding-left: 0 !important;
    padding-right: 0 !important;
    padding-top: 24px !important;
    margin: 0 auto !important;
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
  }
  .VPDoc,
  .VPDoc.has-sidebar,
  .VPDoc.has-aside {
    padding: 0 40px !important;
    max-width: 1200px !important;
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
    max-width: 1080px !important;
    margin: 0 auto !important;
    padding: 0 !important;
    width: 100% !important;
  }
  figure.chart {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
    max-height: 240mm !important;
    box-sizing: border-box !important;
    width: 100% !important;
    max-width: 100% !important;
    margin: 20px auto !important;
    background: #f8fafc !important;
    border: 1px solid #e2e8f0 !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  figure.chart .chart-body {
    max-height: 230mm !important;
    overflow: visible !important;
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
  }
  figure.chart .chart-body svg {
    max-width: 100% !important;
    max-height: 220mm !important;
    height: auto !important;
    display: block !important;
    margin: 0 auto !important;
  }
  figure.chart .chart-body canvas {
    max-height: 220mm !important;
    max-width: 100% !important;
    object-fit: contain !important;
  }
  /* ECharts 打印与导出尺寸防溢出与等比锁定 */
  figure.chart[data-type='echarts'] .chart-body {
    height: 440px !important;
    max-height: 440px !important;
    overflow: hidden !important;
  }
  figure.chart[data-type='echarts'] .chart-body > div {
    height: 100% !important;
    max-height: 100% !important;
    width: 100% !important;
  }
  figure.chart[data-type='echarts'] .chart-body svg {
    width: 100% !important;
    max-width: 100% !important;
    height: 100% !important;
    max-height: 100% !important;
    display: block !important;
  }

  table, tr, .wave-compare-grid, .scope-viewer {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  /* 自测与折叠框优雅排版与防断页 */
  details.details,
  details.custom-block {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
    margin: 16px 0 !important;
    padding: 12px 16px !important;
    background-color: #f8fafc !important;
    border: 1px solid #e2e8f0 !important;
    border-radius: 6px !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  details.details summary,
  details.custom-block summary {
    font-weight: 600 !important;
    color: #0f172a !important;
    margin-bottom: 8px !important;
    cursor: default !important;
  }
  .vp-doc div[class*="language-"],
  div[class*="language-"],
  pre,
  .vp-code-block {
    overflow: visible !important;
    overflow-x: visible !important;
    overflow-y: visible !important;
    box-sizing: border-box !important;
    max-width: 100% !important;
    white-space: pre-wrap !important;
    word-break: break-all !important;
    word-wrap: break-word !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  .vp-doc div[class*="language-"],
  div[class*="language-"] {
    background-color: #f8fafc !important;
    border: 1px solid #e2e8f0 !important;
    border-radius: 6px !important;
    margin: 16px 0 !important;
    padding: 12px 16px !important;
    page-break-inside: auto !important;
    break-inside: auto !important;
    position: relative !important;
  }
  .vp-doc div[class*="language-"] pre,
  div[class*="language-"] pre {
    background: transparent !important;
    margin: 0 !important;
    padding: 0 !important;
    border: none !important;
  }
  .vp-doc div[class*="language-"] button.copy,
  div[class*="language-"] button.copy {
    display: none !important;
  }
  .vp-doc div[class*="language-"] span.lang,
  div[class*="language-"] span.lang {
    position: absolute !important;
    top: 6px !important;
    right: 12px !important;
    font-size: 11px !important;
    color: #94a3b8 !important;
  }
`

/** 读取或初始化 Manifest */
function loadManifest() {
  if (fs.existsSync(MANIFEST_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf-8'))
    } catch {}
  }
  return { generatedAt: new Date().toISOString(), items: {} }
}

/** 保存 Manifest */
function saveManifest(manifest) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true })
  manifest.updatedAt = new Date().toISOString()
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8')
}

/** 单讲预生成核心执行器 */
async function pregenerateLecture(browser, { group, lecture, port, types }) {
  const startTime = Date.now()
  const targetDir = path.join(EXPORTS_DIR, group, lecture)
  fs.mkdirSync(targetDir, { recursive: true })

  const targetUrl = `http://localhost:${port}/${group}/${lecture}.html`
  process.stdout.write(cyan(`\n⚡ 正在处理 [${group.toUpperCase()}-${lecture}] : `) + gray(targetUrl) + '\n')

  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 })

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 })
  } catch (e) {
    console.warn(yellow(`  ⚠️ 导航超时或警告: ${e.message}，尝试继续测量...`))
  }

  // 1. 等待图表就绪
  await page.waitForFunction(() => window.__CHARTS_DONE__ === true, { timeout: 15000 }).catch(() => {
    console.warn(gray('  ⌛ 等待 __CHARTS_DONE__ 超时，按当前渲染状态继续...'))
  })
  await page.evaluate(() => document.fonts?.ready).catch(() => {})

  // 1.5 展开所有自测折叠框，确保打印及长图中所有解析与答案可见
  await page.evaluate(() => {
    document.querySelectorAll('details:not(.chart-code)').forEach((d) => {
      d.setAttribute('open', '')
    })
  })

  // 2. 注入出版级优雅导出样式并重排图表（长卷/长图使用 1080px 宽度）
  await page.addStyleTag({ content: EXPORT_CSS })
  await page.evaluate(() => {
    if (typeof window.__RESIZE_ALL_CHARTS__ === 'function') {
      const cont = document.querySelector('.VPDoc .content-container') || document.querySelector('.vp-doc');
      const usableW = cont ? Math.min(cont.clientWidth - 24, 1040) : 1040;
      try { window.__RESIZE_ALL_CHARTS__(usableW) } catch {}
    }
    window.dispatchEvent(new Event('resize'))
  })
  await new Promise((r) => setTimeout(r, 450))

  // 3. 测量真实内容高度
  const dim = await page.evaluate(() => {
    const vp = document.querySelector('.VPDoc') || document.body
    const rect = vp.getBoundingClientRect()
    return {
      top: Math.max(0, rect.top + window.scrollY),
      height: Math.ceil(rect.height + 48), // 底部优雅留白
      width: Math.ceil(rect.width),
    }
  })

  const results = {}

  // 4. 导出长卷 PDF (continuous)
  if (types.includes('continuous')) {
    const pdfFile = `${lecture}-continuous.pdf`
    const pdfPath = path.join(targetDir, pdfFile)
    await page.pdf({
      path: pdfPath,
      width: '1200px',
      height: `${dim.height}px`,
      printBackground: true,
      pageRanges: '1',
      margin: { top: '0px', bottom: '0px', left: '0px', right: '0px' },
    })
    const sz = fs.statSync(pdfPath).size
    results.continuous = { file: pdfFile, size: sz, mb: (sz / 1024 / 1024).toFixed(2) }
    console.log(green(`  ✓ 长卷 PDF : `) + `${pdfFile} (${results.continuous.mb} MB) [1200px 零切分长卷]`)
  }

  // 5. 导出全景超清长图 (png)
  if (types.includes('png')) {
    const pngFile = `${lecture}-fullpage.png`
    const pngPath = path.join(targetDir, pngFile)
    const client = await page.target().createCDPSession()
    const { data } = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: {
        x: 0,
        y: 0,
        width: 1200,
        height: dim.height,
        scale: 1,
      },
    })
    fs.writeFileSync(pngPath, Buffer.from(data, 'base64'))
    const sz = fs.statSync(pngPath).size
    results.png = { file: pngFile, size: sz, mb: (sz / 1024 / 1024).toFixed(2) }
    console.log(green(`  ✓ 全景长图 : `) + `${pngFile} (${results.png.mb} MB) [1200px 视网膜高清，全文到底]`)
  }

  // 6. 导出标准 A4 多页 PDF (a4)
  if (types.includes('a4')) {
    await page.evaluate(() => {
      if (typeof window.__RESIZE_ALL_CHARTS__ === 'function') {
        try { window.__RESIZE_ALL_CHARTS__(660) } catch {}
      }
      window.dispatchEvent(new Event('resize'))
    })
    await new Promise((r) => setTimeout(r, 300))
    const a4File = `${lecture}-standard-a4.pdf`
    const a4Path = path.join(targetDir, a4File)
    await page.pdf({
      path: a4Path,
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    })
    const sz = fs.statSync(a4Path).size
    results.a4 = { file: a4File, size: sz, mb: (sz / 1024 / 1024).toFixed(2) }
    console.log(green(`  ✓ 标准 A4  : `) + `${a4File} (${results.a4.mb} MB) [A4 多页装订带页码]`)
  }

  await page.close()
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(gray(`  ⏱️ 耗时: ${duration}s`))
  return results
}

/** 主程序入口 */
async function main() {
  const args = process.argv.slice(2)
  console.log(bold('\n================ ⚡ 讲义导出静态资产预生成引擎 ================'))

  // 1. 检查可选依赖
  const puppeteer = resolvePuppeteer()
  if (!puppeteer) {
    console.error(red('❌ 未检测到 puppeteer 依赖。'))
    console.log(yellow('提示：请先运行 npm run pregen:setup 进行可选加速依赖配置。'))
    process.exit(1)
  }

  // 2. 检查系统浏览器
  const chromePath = resolveChromePath()
  if (!chromePath) {
    console.error(red('❌ 未检测到 Chrome / Chromium 可执行文件。'))
    console.log(yellow('提示：请安装 Chrome 浏览器或设置环境变量 PUPPETEER_EXECUTABLE_PATH。'))
    process.exit(1)
  }
  console.log(gray(`  Chromium 引擎 : ${chromePath}`))

  // 3. 检查 Dev Server 端口
  const portArgIdx = args.indexOf('--port')
  const customPort = portArgIdx >= 0 ? parseInt(args[portArgIdx + 1], 10) : 5173
  const activePort = await detectServerPort(customPort)
  if (!activePort) {
    console.error(red(`❌ 未在端口 5173 / 5174 / 4173 检测到运行中的讲义服务。`))
    console.log(yellow('提示：请先在终端启动讲义服务 (例如 npm run dev) 后再执行预生成。'))
    process.exit(1)
  }
  console.log(gray(`  讲义服务端口 : http://localhost:${activePort}`))

  // 4. 解析目标讲义
  let targetLectures = []
  const allIdx = args.indexOf('--all')
  const lectureArgIdx = args.indexOf('--lecture')
  const groupArgIdx = args.indexOf('--group')

  if (allIdx >= 0) {
    targetLectures = scanAllLectures()
    console.log(cyan(`  预生成目标   : 全站讲义 (共 ${targetLectures.length} 讲)`))
  } else if (lectureArgIdx >= 0 && args[lectureArgIdx + 1]) {
    const parsed = parseLectureArg(args[lectureArgIdx + 1])
    if (!parsed) {
      console.error(red(`无法识别的讲义格式: ${args[lectureArgIdx + 1]} (请使用形如 G01-L01 或 g01/L01)`))
      process.exit(1)
    }
    targetLectures = [parsed]
    console.log(cyan(`  预生成目标   : [${parsed.group.toUpperCase()}-${parsed.lecture}]`))
  } else if (groupArgIdx >= 0 && args[groupArgIdx + 1]) {
    const g = args[groupArgIdx + 1].toLowerCase()
    targetLectures = scanAllLectures().filter((item) => item.group === g)
    console.log(cyan(`  预生成目标   : ${g.toUpperCase()} 课程组 (共 ${targetLectures.length} 讲)`))
  } else {
    // 默认演示：处理 G01/L01
    targetLectures = [{ group: 'g01', lecture: 'L01' }]
    console.log(cyan('  预生成目标   : 默认第 1 讲 [G01-L01] (可用 --all 预生成全量)'))
  }

  // 5. 解析生成类型
  const typesIdx = args.indexOf('--types')
  const requestedTypes = typesIdx >= 0 ? args[typesIdx + 1].split(',') : ['continuous', 'png', 'a4']
  console.log(gray(`  导出类型     : ${requestedTypes.join(', ')}`))
  console.log('=================================================================\n')

  // 6. 启动共享 Browser 实例
  const browser = await puppeteer.launch({
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

  const manifest = loadManifest()

  try {
    for (const item of targetLectures) {
      try {
        const res = await pregenerateLecture(browser, {
          group: item.group,
          lecture: item.lecture,
          port: activePort,
          types: requestedTypes,
        })
        const key = `${item.group}/${item.lecture}`
        manifest.items[key] = {
          updatedAt: new Date().toISOString(),
          ...res,
        }
      } catch (err) {
        console.error(red(`\n❌ [${item.group}-${item.lecture}] 预生成异常:`), err.message)
      }
    }
    saveManifest(manifest)
  } finally {
    await browser.close()
  }

  console.log(bold(green('\n🎉 预生成流水线执行完毕！静态资产已写入 site/docs/public/exports/。')))
  console.log(gray('前端讲义页面现在点击「导出长图 / 卷轴 PDF」将直接享用毫秒级纯静态秒下。'))
}

main().catch((err) => {
  console.error(red('\n预生成进程未捕获异常:'), err)
  process.exit(1)
})
