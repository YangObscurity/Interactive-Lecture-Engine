#!/usr/bin/env node
/**
 * scripts/manage_export_dep.mjs — 讲义导出可选依赖管理与状态维护工具
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 核心设计目标
 * ────────────────────────────────────────────────────────────────────────────
 *   1. 选装依赖治理：puppeteer 作为重型可选依赖，按需添加、一键卸载；
 *   2. 环境智能探测：自动检测系统 Chrome / Edge，已有系统浏览器时免下 300MB Chromium；
 *   3. 静态资产清理：一键清空/释放 site/docs/public/exports/ 静态产物目录；
 *   4. 双模支持：支持 CLI 命令行参数自动化执行，亦支持交互式友好终端引导。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import readline from 'node:readline'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// scripts/ lives in <repo>/site/scripts/ -> repo root is two levels up
const ROOT_DIR = path.resolve(__dirname, '..', '..')
const SITE_DIR = path.join(ROOT_DIR, 'site')
const EXPORTS_DIR = path.join(ROOT_DIR, 'site', 'docs', 'public', 'exports')

const OPTIONAL_SPECIFIER = 'puppeteer'

// 颜色输出助手
const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const gray = (s) => `\x1b[90m${s}\x1b[0m`

/** 探测系统已安装的 Chromium 系浏览器路径 */
function findSystemChrome() {
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
    '/usr/bin/microsoft-edge',
  ].filter(Boolean)

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    } catch {}
  }
  return null
}

/** 探测 Puppeteer 模块是否可用及版本 */
async function probePuppeteer() {
  const probeDirs = [
    path.join(ROOT_DIR, 'site'),
    path.join(ROOT_DIR, 'workspaces', 'lecture-enhancer', 'tools', 'visual'),
    ROOT_DIR,
  ]

  const probeCode =
    "try{const{createRequire}=require('module');" +
    "const r=createRequire(process.argv[1]);" +
    "const m=r('puppeteer');" +
    "const v=(m&&(m.version||(m.default&&m.default.version)))||'ok';" +
    "process.stdout.write(JSON.stringify({ok:true,version:v}))}" +
    "catch(e){process.stdout.write(JSON.stringify({ok:false,code:e.code||null}))}"

  for (const dir of probeDirs) {
    const pkg = path.join(dir, 'package.json')
    if (!fs.existsSync(pkg)) continue
    const res = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ['-e', probeCode, pkg],
        { cwd: dir, timeout: 15000, windowsHide: true },
        (err, stdout) => {
          if (err && !stdout) return resolve({ ok: false })
          try {
            const d = JSON.parse(String(stdout).trim())
            return resolve({ ok: !!d.ok, version: d.version, dir })
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

/** 统计 exports 目录下预生成资产体积与数量 */
function getExportAssetStats() {
  if (!fs.existsSync(EXPORTS_DIR)) {
    return { count: 0, totalBytes: 0, lectures: [] }
  }

  let count = 0
  let totalBytes = 0
  const lectures = new Set()

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full)
      } else if (ent.isFile() && (ent.name.endsWith('.pdf') || ent.name.endsWith('.png'))) {
        count++
        const sz = fs.statSync(full).size
        totalBytes += sz
        const rel = path.relative(EXPORTS_DIR, dir).replace(/\\/g, '/')
        lectures.add(rel)
      }
    }
  }

  try {
    walk(EXPORTS_DIR)
  } catch {}

  return {
    count,
    totalBytes,
    totalMB: (totalBytes / (1024 * 1024)).toFixed(2),
    lectureCount: lectures.size,
    lectures: Array.from(lectures),
  }
}

/** 校准 site/package.json 的 optionalDependencies */
function updateOptionalDependencies(present, version = '^23.11.1') {
  try {
    const pkgPath = path.join(SITE_DIR, 'package.json')
    if (!fs.existsSync(pkgPath)) return
    const raw = fs.readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw)
    const cur = pkg.optionalDependencies || {}

    if (present) {
      cur[OPTIONAL_SPECIFIER] = version
      pkg.optionalDependencies = cur
    } else {
      delete cur[OPTIONAL_SPECIFIER]
      if (Object.keys(cur).length === 0) delete pkg.optionalDependencies
      else pkg.optionalDependencies = cur
    }

    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
  } catch (e) {
    console.warn('更新 package.json optionalDependencies 失败:', e.message)
  }
}

/** 打印全景状态报告 */
async function printStatus() {
  console.log(bold('\n================ ⚡ 讲义导出与加速引擎状态报告 ================'))
  
  // 1. 系统浏览器
  const chromePath = findSystemChrome()
  if (chromePath) {
    console.log(`  🖥️  系统浏览器 : ${green('已检测到')} (${chromePath})`)
  } else {
    console.log(`  🖥️  系统浏览器 : ${yellow('未检测到 Chrome/Edge')} (将依赖 Puppeteer 内置 Chromium)`)
  }

  // 2. Puppeteer 依赖状态
  const pStatus = await probePuppeteer()
  if (pStatus.ok) {
    console.log(`  📦  可选引擎依赖 : ${green('已就绪')} (版本: ${pStatus.version}, 位置: ${pStatus.dir})`)
  } else {
    console.log(`  📦  可选引擎依赖 : ${yellow('未安装')} (当前降级为浏览器客户端即时渲染)`)
  }

  // 3. 预生成静态资产
  const stats = getExportAssetStats()
  console.log(`  📁  预生成静态包 : ${stats.count > 0 ? green(`已就绪 (${stats.lectureCount} 篇讲义, 共 ${stats.count} 个文件, ${stats.totalMB} MB)`) : gray('暂无预生成资产')}`)
  if (stats.lectures.length > 0) {
    console.log(`     清单: ${stats.lectures.slice(0, 5).join(', ')}${stats.lectures.length > 5 ? ` 等共 ${stats.lectures.length} 讲` : ''}`)
  }

  console.log('=================================================================\n')
  return { chromePath, pStatus, stats }
}

/** 执行安装 Puppeteer 可选依赖 */
async function installPuppeteer() {
  console.log(cyan('\n⚡ 正在配置可选渲染引擎依赖 (Puppeteer)...'))
  const chromePath = findSystemChrome()

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const args = ['install', '--save-optional', '--no-audit', '--no-fund', OPTIONAL_SPECIFIER]

  // 如果系统已有 Chrome，免去重新下载 300MB Chromium，秒级完成！
  const env = { ...process.env, npm_config_loglevel: 'warn' }
  if (chromePath) {
    console.log(gray(`检测到系统已安装浏览器 (${chromePath})，开启极速轻量安装模式 (免下 300MB Chromium)...`))
    env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true'
  } else {
    console.log(yellow('未检测到本机 Chrome，将自动下载 Chromium 运行环境（约需数分钟，请保持网络通畅）...'))
  }

  const child = spawn(npmCmd, args, {
    cwd: SITE_DIR,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  const code = await new Promise((resolve) => child.on('close', resolve))

  if (code === 0) {
    updateOptionalDependencies(true)
    console.log(green('\n✅ 可选加速引擎安装成功！已在 site/package.json 注册为可选依赖 (optionalDependencies)。'))
    console.log(gray('提示：现在运行 npm run pregen 即可对讲义进行 1200px 黄金超清长图与长卷 PDF 批量预生成。'))
  } else {
    console.error(red(`\n❌ 安装失败 (退出码: ${code})。请检查网络或执行: cd site && npm i -O puppeteer`))
  }
  return code === 0
}

/** 执行卸载 Puppeteer 可选依赖 */
async function uninstallPuppeteer() {
  console.log(yellow('\n🗑️  正在卸载可选依赖 puppeteer 并释放磁盘空间...'))
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const args = ['uninstall', '--no-audit', '--no-fund', OPTIONAL_SPECIFIER]

  const child = spawn(npmCmd, args, {
    cwd: SITE_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  const code = await new Promise((resolve) => child.on('close', resolve))
  updateOptionalDependencies(false)

  if (code === 0) {
    console.log(green('\n✅ 可选依赖已成功卸载，已清理 site/package.json 声明。'))
  } else {
    console.warn(yellow('\n⚠️ npm 卸载退出码非 0，已尝试直接清理 package.json 声明。'))
  }
  return code === 0
}

/** 清理预生成静态导出资产 */
function cleanAssets() {
  console.log(yellow('\n🧹 正在清理 site/docs/public/exports/ 静态资产...'))
  if (!fs.existsSync(EXPORTS_DIR)) {
    console.log(gray('目录已为空，无需清理。'))
    return
  }

  const entries = fs.readdirSync(EXPORTS_DIR)
  let count = 0
  for (const ent of entries) {
    const full = path.join(EXPORTS_DIR, ent)
    try {
      fs.rmSync(full, { recursive: true, force: true })
      count++
    } catch (e) {
      console.warn(`清理失败 ${full}:`, e.message)
    }
  }
  console.log(green(`\n✅ 清理完成！已清除 ${count} 项静态导出资产缓存，释放磁盘空间。`))
}

/** 交互式菜单 */
async function interactiveMenu() {
  await printStatus()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve))

  console.log(bold('请选择操作:'))
  console.log('  1. ➕ 安装 / 启用可选加速引擎依赖 (Puppeteer)')
  console.log('  2. 🗑️  卸载可选依赖 (释放依赖占用空间)')
  console.log('  3. 🧹 清理已生成的导出静态资产 (释放 exports 目录)')
  console.log('  4. ⚡ 运行预生成 (单讲或全量生成)')
  console.log('  5. 🔍 刷新状态')
  console.log('  0. 退出')

  const ans = (await question(cyan('\n输入选项编号 [0-5]: '))).trim()
  rl.close()

  switch (ans) {
    case '1':
      await installPuppeteer()
      break
    case '2':
      await uninstallPuppeteer()
      break
    case '3':
      cleanAssets()
      break
    case '4': {
      const script = path.join(__dirname, 'pregenerate_assets.mjs')
      if (fs.existsSync(script)) {
        const sub = spawn(process.execPath, [script], { stdio: 'inherit' })
        await new Promise((resolve) => sub.on('close', resolve))
      } else {
        console.log(yellow('未找到 scripts/pregenerate_assets.mjs'))
      }
      break
    }
    case '5':
      await printStatus()
      break
    case '0':
    default:
      console.log('退出。')
      break
  }
}

// 主流程分流
const args = process.argv.slice(2)
if (args.includes('--status') || args.includes('-s')) {
  await printStatus()
} else if (args.includes('--install') || args.includes('-i') || args.includes('--setup')) {
  await installPuppeteer()
} else if (args.includes('--uninstall') || args.includes('-u') || args.includes('--remove')) {
  await uninstallPuppeteer()
} else if (args.includes('--clean-assets') || args.includes('--clean') || args.includes('-c')) {
  cleanAssets()
} else {
  await interactiveMenu()
}
