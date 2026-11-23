import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { MODULES, settingsOf, toJSON } from '../../config/schema.ts'
import { loadAndValidateSitePrompts } from '../../docs/.vitepress/prompts/load.mts'
import { loadLectureConfigInfo } from '../../docs/.vitepress/content/config.mts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '../../../')
const schemaJsonPath = resolve(__dirname, '../../config/schema.json')
const envExamplePath = resolve(repoRoot, '.env.example')

export function renderSchemaJson(): string {
  return JSON.stringify(toJSON(), null, 2) + '\n'
}

export function renderEnvExample(): string {
  const lines: string[] = []

  // 1. Header
  lines.push('# ═══════════════════════════════════════════════════════════════════════════════')
  lines.push('#  .env.example — 本仓库统一配置模板（占位符，绝不含真实凭据）')
  lines.push('# ═══════════════════════════════════════════════════════════════════════════════')
  lines.push('#')
  lines.push('#  用法：')
  lines.push('#    1. 在仓库根复制本文件为 `.env`：   cp .env.example .env')
  lines.push('#    2. 把需要项的占位替换成你的真实值')
  lines.push('#    3. 运行交互向导或体检工具（在 site/ 目录下）：')
  lines.push('#       npm run setup   # 交互式向导，按模块配置并校验')
  lines.push('#       npm run doctor  # 检查当前配置状态与可达性')
  lines.push('#')
  lines.push('#  ★ 安全铁律：')
  lines.push('#      `.env` 已在根 `.gitignore` 中忽略（`.env` 与 `.env.*`，放行 `.env.example`），')
  lines.push('#      永远不要把填好真实值的 `.env` 提交进仓库、贴进 issue / 截图 / 日志。')
  lines.push('#')
  lines.push('#  优先级（所有脚本与工具一致）：')
  lines.push('#      真实环境变量（非空） > 仓库根 `.env` > 兼容旧文件 (DEPLOY_ENV_FILE / scripts/deploy.local.env) > 代码内默认值')
  lines.push('#      对于带有别名 (alias) 的配置项，在每一级先尝试标准键名，再尝试别名，然后才进入下一级。')
  lines.push('#')
  lines.push('# ═══════════════════════════════════════════════════════════════════════════════')
  lines.push('')
  lines.push('')

  // 2. Short block for site modules
  lines.push('# ─────────────────────────────────────────────────────────────────────────────')
  lines.push('# 站点模块（progress / companion / graph / contentSync / auth）')
  lines.push('# ─────────────────────────────────────────────────────────────────────────────')
  lines.push('# 站点模块属于构建期前端配置，不在此文件设置，请在 site/lecture.config.ts 的 modules 块配置。')
  lines.push('# 例如：')
  lines.push('#   modules: {')
  lines.push("#     progress: { adapter: 'local' },")
  lines.push("#     companion: { adapter: 'off' },")
  lines.push("#     graph: { source: 'merge' },")
  lines.push("#     contentSync: { adapter: 'none' },")
  lines.push("#     auth: { adapter: 'none' },")
  lines.push('#   }')
  lines.push('# 这里的 .env 仅用于服务连接凭据、远端部署及脚本工具配置。')
  lines.push('')

  // 3. One section per non-site module in MODULES order
  const nonSiteModules = MODULES.filter((m) => !m.site)

  for (let i = 0; i < nonSiteModules.length; i++) {
    const mod = nonSiteModules[i]!
    lines.push('')
    lines.push('# ─────────────────────────────────────────────────────────────────────────────')
    lines.push(`# ${mod.title.zh} — ${mod.summary.zh}`)
    lines.push('# ─────────────────────────────────────────────────────────────────────────────')

    const settings = settingsOf(mod.id).filter((s) => s.kind !== 'site')
    for (let j = 0; j < settings.length; j++) {
      const s = settings[j]!
      lines.push('')
      lines.push(`# ${s.description.zh}`)

      const markers: string[] = []
      if (s.kind === 'secret') markers.push('[秘密]')
      if (s.required) markers.push('[模块启用时必填]')
      if (s.aliases && s.aliases.length > 0) markers.push(`旧名 ${s.aliases.join(', ')} 仍可读取`)
      if (s.neededBy) markers.push(`${s.neededBy.module} = ${s.neededBy.adapters.join(', ')} 时需要`)

      if (markers.length > 0) {
        lines.push(`# ${markers.join(' ')}`)
      }

      let valueStr = ''
      if (s.kind === 'secret') {
        valueStr = ''
      } else if (s.default !== undefined) {
        valueStr = String(s.default)
      } else if (s.example !== undefined) {
        valueStr = s.example
      }

      lines.push(`${s.key}=${valueStr}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

export function runCli(args: string[] = process.argv.slice(2)): number {
  const isCheck = args.includes('--check')
  const jsonContent = renderSchemaJson()
  const envContent = renderEnvExample()

  if (isCheck) {
    let diff = false
    try {
      const currentJson = readFileSync(schemaJsonPath, 'utf8')
      if (currentJson !== jsonContent) {
        console.error(`Diff in: ${schemaJsonPath}`)
        diff = true
      }
    } catch {
      console.error(`Missing or unreadable: ${schemaJsonPath}`)
      diff = true
    }

    try {
      const currentEnv = readFileSync(envExamplePath, 'utf8')
      if (currentEnv !== envContent) {
        console.error(`Diff in: ${envExamplePath}`)
        diff = true
      }
    } catch {
      console.error(`Missing or unreadable: ${envExamplePath}`)
      diff = true
    }

    try {
      const loaded = loadAndValidateSitePrompts()
      console.log(`Companion prompts OK (version ${loaded.prompts.version}, ${loaded.prompts.actions.length} actions): ${loaded.filePath}`)
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err))
      diff = true
    }

    if (diff) {
      return 1
    }
    const configInfo = loadLectureConfigInfo()
    console.log(`Active site config: ${configInfo.file} (${configInfo.source})`)
    console.log('config:check passed: schema.json, .env.example, and companion prompts are up to date.')
    return 0
  }

  writeFileSync(schemaJsonPath, jsonContent, 'utf8')
  writeFileSync(envExamplePath, envContent, 'utf8')
  console.log(`Generated: ${schemaJsonPath}`)
  console.log(`Generated: ${envExamplePath}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const code = runCli()
  if (code !== 0) process.exit(code)
}
