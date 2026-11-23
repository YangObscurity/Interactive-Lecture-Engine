import fs from 'node:fs'
import net from 'node:net'
import path, { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODULES,
  settingsOf,
  type ModuleId,
  type ProbeId,
  type Setting,
} from '../../config/schema.ts'
import {
  display,
  getInUseModules,
  loadSources,
  resolveAll,
  validate,
  type ConfigSources,
  type ResolvedSetting,
} from './env.mts'
import { BUILTIN_THEME_IDS, enabledThemes, resolveModules, type LectureConfig, type ResolvedModules } from '../../docs/.vitepress/lecture-config.mts'
import { AI_PROMPTS } from '../../docs/.vitepress/site.config.mts'
import { loadAndValidateSitePrompts } from '../../docs/.vitepress/prompts/load.mts'
import { checkComponentsDeclaration, checkLayoutDeclaration, SLOT_CONTRACT_VERSION } from '../../docs/.vitepress/theme/slots/contract.ts'
import { listEmptyFields, loadSiteTexts, siteTextsProblems, type SiteTextField } from '../../docs/.vitepress/site-texts.mts'
import { translate } from '../../docs/.vitepress/i18n/index.ts'
import { loadLectureConfigInfo } from '../../docs/.vitepress/content/config.mts'
import { resolveContent } from '../../docs/.vitepress/content/paths.mts'

const __filename = fileURLToPath(import.meta.url)

export interface ProbeResult {
  reachable: boolean
  status?: number
  error?: string
  target?: string
}

export interface DoctorSettingReport {
  key: string
  kind: string
  type: string
  status: '已设置' | '默认值' | '未设置' | '无效'
  source: string
  nameUsed: string
  displayValue: string
  secret?: {
    set: boolean
    length?: number
  }
  warnings?: string[]
  error?: string
  probe?: ProbeResult
}

export interface DoctorModuleReport {
  id: ModuleId
  title: string
  site: boolean
  inUse: boolean
  settings: DoctorSettingReport[]
}

/** One theme pack (built-in or from `themePacks`): what code it brings and whether its slot declaration holds (P2e). */
export interface DoctorThemeReport {
  id: string
  dir: string
  builtin: boolean
  enabled: boolean
  /** Slot contract range the pack declares, or null. */
  engine: string | null
  /** Slots the pack overrides with a component. */
  components: string[]
  /** True when the pack brings code (any component): the two-level trust. */
  hasCode: boolean
  /** `含代码（n 个组件）` for packs with components, otherwise null. */
  note: string | null
  errors: string[]
}

export interface DoctorReport {
  ok: boolean
  siteConfigFile: string
  inUseModules: ModuleId[]
  modules: DoctorModuleReport[]
  themes: DoctorThemeReport[]
  errors: string[]
  warnings: string[]
}

export type ProbeRunner = (
  probeId: ProbeId,
  setting: Setting,
  resolvedMap: Map<string, ResolvedSetting>
) => Promise<ProbeResult>

export const defaultProbeRunner: ProbeRunner = async (
  probeId: ProbeId,
  setting: Setting,
  resolvedMap: Map<string, ResolvedSetting>
): Promise<ProbeResult> => {
  switch (probeId) {
    case 'notion-users-me': {
      const token = resolvedMap.get('NOTION_TOKEN')?.value
      const version = resolvedMap.get('NOTION_API_VERSION')?.value || '2022-06-28'
      if (!token) {
        return { reachable: false, error: 'NOTION_TOKEN 未配置' }
      }
      try {
        const res = await fetch('https://api.notion.com/v1/users/me', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': version,
          },
          signal: AbortSignal.timeout(5000),
        })
        return {
          reachable: res.ok,
          status: res.status,
          target: 'https://api.notion.com/v1/users/me',
        }
      } catch (err: unknown) {
        const errorName = err instanceof Error ? err.name : String(err)
        return {
          reachable: false,
          error: errorName,
          target: 'https://api.notion.com/v1/users/me',
        }
      }
    }
    case 'tcp': {
      const host = resolvedMap.get('DEPLOY_HOST')?.value || '127.0.0.1'
      const portRaw = resolvedMap.get('DEPLOY_PORT')?.value || '22'
      const port = parseInt(portRaw, 10)
      const target = `${host}:${port}`

      return new Promise<ProbeResult>((resolvePromise) => {
        const socket = new net.Socket()
        let resolved = false

        socket.setTimeout(5000)

        socket.once('connect', () => {
          if (!resolved) {
            resolved = true
            socket.destroy()
            resolvePromise({ reachable: true, target })
          }
        })

        socket.once('timeout', () => {
          if (!resolved) {
            resolved = true
            socket.destroy()
            resolvePromise({ reachable: false, error: 'TimeoutError', target })
          }
        })

        socket.once('error', (err: NodeJS.ErrnoException) => {
          if (!resolved) {
            resolved = true
            socket.destroy()
            resolvePromise({ reachable: false, error: err.code || err.name, target })
          }
        })

        try {
          socket.connect(port, host)
        } catch (err: unknown) {
          if (!resolved) {
            resolved = true
            const errorMsg = err instanceof Error ? err.name : String(err)
            resolvePromise({ reachable: false, error: errorMsg, target })
          }
        }
      })
    }
    case 'https-head': {
      const domain = resolvedMap.get(setting.key)?.value
      if (!domain) {
        return { reachable: false, error: '未配置域名' }
      }
      const target = `https://${domain}/`
      try {
        const res = await fetch(target, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        })
        return {
          reachable: res.status < 500,
          status: res.status,
          target,
        }
      } catch (err: unknown) {
        const errorName = err instanceof Error ? err.name : String(err)
        return {
          reachable: false,
          error: errorName,
          target,
        }
      }
    }
    case 'http-get': {
      const host = resolvedMap.get('LECTURE_TOOLS_HOST')?.value || '127.0.0.1'
      const port = resolvedMap.get('LECTURE_TOOLS_PORT')?.value || '8099'
      const target = `http://${host}:${port}/`
      try {
        const res = await fetch(target, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        })
        return {
          reachable: res.status < 500,
          status: res.status,
          target,
        }
      } catch (err: unknown) {
        const errorName = err instanceof Error ? err.name : String(err)
        return {
          reachable: false,
          error: errorName,
          target,
        }
      }
    }
    default:
      return { reachable: false, error: `未知 probe: ${probeId}` }
  }
}

const SITE_DIR = resolve(path.dirname(__filename), '..', '..')

function readPackJson(dir: string): { meta: Record<string, unknown>; error?: undefined } | { meta?: undefined; error: string } {
  const file = path.join(dir, 'theme.json')
  if (!fs.existsSync(file)) return { error: `找不到 ${file}` }
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { $extensions?: Record<string, unknown> }
    const meta = doc.$extensions?.['org.lecture-engine']
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { error: `${file}: 缺少 $extensions["org.lecture-engine"]` }
    return { meta: meta as Record<string, unknown> }
  } catch (e) {
    return { error: `${file}: JSON 无效 (${e instanceof Error ? e.message : String(e)})` }
  }
}

/**
 * Theme packs (P2e): the built-in ones that are enabled plus every `themePacks` entry. Checks the `engine` range against
 * the slot contract version, the `components` declaration and the component files, and marks packs that bring code.
 */
export function checkThemePacks(config: LectureConfig, siteDir: string = SITE_DIR): DoctorThemeReport[] {
  const themesDir = path.join(siteDir, 'docs', '.vitepress', 'themes')
  const enabled = new Set(enabledThemes(config))
  const entries: Array<{ id: string; dir: string; builtin: boolean; pre: string[] }> = []
  for (const id of enabled) {
    if ((BUILTIN_THEME_IDS as readonly string[]).includes(id)) entries.push({ id, dir: path.join(themesDir, id), builtin: true, pre: [] })
  }
  const seen = new Set(entries.map((e) => e.id))
  for (const rel of config.themePacks ?? []) {
    const dir = path.resolve(siteDir, rel)
    const read = readPackJson(dir)
    const id = read.meta && typeof read.meta.id === 'string' ? read.meta.id : rel
    const pre: string[] = []
    if (read.error) pre.push(read.error)
    if ((BUILTIN_THEME_IDS as readonly string[]).includes(id)) pre.push(`包 id "${id}" 与内置主题重复`)
    else if (seen.has(id)) pre.push(`包 id "${id}" 重复`)
    seen.add(id)
    entries.push({ id, dir, builtin: false, pre })
  }
  const reports: DoctorThemeReport[] = entries.map((e) => {
    const errors = [...e.pre]
    const read = readPackJson(e.dir)
    let engine: string | null = null
    let components: string[] = []
    if (read.meta) {
      const meta = read.meta
      engine = typeof meta.engine === 'string' ? meta.engine : null
      for (const issue of checkComponentsDeclaration(meta)) {
        errors.push(issue.code === 'engine-mismatch' ? `${issue.message}（引擎槽位契约版本 ${SLOT_CONTRACT_VERSION}）` : issue.message)
      }
      for (const issue of checkLayoutDeclaration(meta)) errors.push(issue.message)
      if (meta.components && typeof meta.components === 'object' && !Array.isArray(meta.components)) {
        components = Object.keys(meta.components)
        for (const [slot, rel] of Object.entries(meta.components)) {
          if (typeof rel !== 'string') continue
          const abs = path.resolve(e.dir, rel)
          const inside = path.relative(e.dir, abs)
          if (inside.startsWith('..') || path.isAbsolute(inside)) continue // reported by checkComponentsDeclaration (lexical) or later by the build
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) errors.push(`components.${slot}: 文件不存在 ${abs}`)
        }
      }
    } else if (!e.pre.length && read.error) errors.push(read.error)
    return {
      id: e.id,
      dir: e.dir,
      builtin: e.builtin,
      enabled: enabled.has(e.id),
      engine,
      components,
      hasCode: components.length > 0,
      // the trust note is for third-party packs; built-in packs ship with the engine
      note: components.length > 0 && !e.builtin ? `含代码（${components.length} 个组件）` : null,
      errors,
    }
  })
  for (const id of enabled) {
    if (!reports.some((r) => r.id === id)) {
      reports.push({ id, dir: path.join(themesDir, id), builtin: false, enabled: true, engine: null, components: [], hasCode: false, note: null, errors: [`主题 "${id}" 未找到：不是内置主题，也不在 themePacks 里`] })
    }
  }
  return reports
}

/** Chinese empty-value rule of each optional site text field (the same words as the Dashboard page). */
const EMPTY_RULE_TEXT: Record<SiteTextField, string> = {
  name: translate('zh-CN', 'dashboard.textsRuleName'),
  shortName: translate('zh-CN', 'dashboard.textsRuleShortName'),
  navText: translate('zh-CN', 'dashboard.textsRuleNavText'),
  tagline: translate('zh-CN', 'dashboard.textsRuleTagline'),
  description: translate('zh-CN', 'dashboard.textsRuleDesc'),
}

export async function runDoctor(options?: {
  sources?: ConfigSources
  probe?: boolean
  probeRunner?: ProbeRunner
  siteModules?: ResolvedModules
  /** Site config to check the theme packs of (default: content/site.config.ts or lecture.config.ts). */
  siteConfig?: LectureConfig
  siteConfigFile?: string
  siteDir?: string
}): Promise<DoctorReport> {
  const loadedConfig = options?.siteConfig ? null : loadLectureConfigInfo()
  const activeSiteConfig = options?.siteConfig ?? loadedConfig!.config
  const activeSiteConfigFile = options?.siteConfigFile ?? loadedConfig?.file ?? 'lecture.config.ts'
  const activeSiteConfigSource = path.basename(activeSiteConfigFile)
  const sources = options?.sources ?? loadSources()
  const siteMods = options?.siteModules ?? resolveModules(activeSiteConfig)
  const resolved = resolveAll(sources)
  const resolvedMap = new Map(resolved.map((r) => [r.key, r]))

  const inUseSet = getInUseModules(resolved, siteMods)
  const errors: string[] = []
  const warnings: string[] = []
  const ignoredContentDir = resolveContent().ignoredContentDir
  if (ignoredContentDir) {
    warnings.push(`内容目录 ${ignoredContentDir} 存在，但既没有 site.config.ts 也没有 groups.ts，不算内容根，已忽略（原位模式）。`)
  }

  const moduleReports: DoctorModuleReport[] = []
  const probeRunner = options?.probeRunner ?? defaultProbeRunner

  for (const mod of MODULES) {
    const isInUse = inUseSet.has(mod.id)
    const settings = settingsOf(mod.id)
    const settingReports: DoctorSettingReport[] = []

    for (const s of settings) {
      if (s.kind === 'site') {
        const specField = s.key.split('.')[1]!
        const modObj = siteMods[s.module as keyof ResolvedModules] as Record<string, string> | undefined
        const val = modObj?.[specField]
        const valStr = val !== undefined ? String(val) : undefined
        const vCheck = validate(s, valStr)

        settingReports.push({
          key: s.key,
          kind: s.kind,
          type: s.type,
          status: !vCheck.valid ? '无效' : valStr !== undefined ? '默认值' : '未设置',
          source: activeSiteConfigSource,
          nameUsed: s.key,
          displayValue: valStr ?? '未设置',
          error: vCheck.error,
        })
        if (!vCheck.valid) {
          errors.push(`站点模块配置 ${s.key} 无效: ${vCheck.error}`)
        }
        continue
      }

      const res = resolvedMap.get(s.key)
      const val = res?.value
      const isSet = res?.isSet ?? false
      const source = res?.source ?? 'unset'
      const nameUsed = res?.nameUsed ?? s.key
      const sWarnings = res?.warnings ? [...res.warnings] : []

      const vCheck = validate(s, val)

      let status: '已设置' | '默认值' | '未设置' | '无效'
      let itemError: string | undefined = undefined

      if (val !== undefined && val !== '' && !vCheck.valid) {
        status = '无效'
        itemError = vCheck.error
        errors.push(`配置项 ${s.key} 无效: ${vCheck.error}`)
      } else if (isInUse && s.required && (val === undefined || val === '')) {
        status = '无效'
        itemError = `模块 "${mod.title.zh}" 已启用，但缺少必填项 ${s.key}`
        errors.push(itemError)
      } else if (isSet) {
        status = '已设置'
      } else if (source === 'default') {
        status = '默认值'
      } else {
        status = '未设置'
      }

      for (const w of sWarnings) {
        warnings.push(`${s.key}: ${w}`)
      }

      const dispVal = display(s, val)

      const reportItem: DoctorSettingReport = {
        key: s.key,
        kind: s.kind,
        type: s.type,
        status,
        source,
        nameUsed,
        displayValue: dispVal,
        warnings: sWarnings.length > 0 ? sWarnings : undefined,
        error: itemError,
      }

      if (s.kind === 'secret') {
        reportItem.secret = {
          set: isSet && val !== undefined && val !== '',
          ...(isSet && val ? { length: val.length } : {}),
        }
      }

      // Probe check if requested
      if (options?.probe && s.probe && isSet && val !== undefined && val !== '') {
        try {
          reportItem.probe = await probeRunner(s.probe, s, resolvedMap)
          if (!reportItem.probe.reachable) {
            warnings.push(
              `网络探针 ${s.probe} 连接失败: ${reportItem.probe.error || '无法访问'}`
            )
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err)
          reportItem.probe = { reachable: false, error: errMsg }
          warnings.push(`网络探针 ${s.probe} 执行异常: ${errMsg}`)
        }
      }

      settingReports.push(reportItem)
    }

    moduleReports.push({
      id: mod.id,
      title: mod.title.zh,
      site: mod.site,
      inUse: isInUse,
      settings: settingReports,
    })
  }

  const themes = checkThemePacks(activeSiteConfig, options?.siteDir)
  for (const th of themes) for (const e of th.errors) errors.push(`主题 ${th.id}: ${e}`)

  if (options?.sources?.repoRoot !== '/fake') {
    const configuredPromptPath = resolvedMap.get(AI_PROMPTS.envKey)?.value
    try {
      loadAndValidateSitePrompts({
        siteRoot: options?.siteDir,
        repoRoot: options?.sources?.repoRoot,
        configuredPath: typeof configuredPromptPath === 'string' && configuredPromptPath.trim() !== '' ? configuredPromptPath : undefined,
      })
    } catch (err: unknown) {
      errors.push(`AI 伴读提示词 (${AI_PROMPTS.envKey}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Site texts: problems that stop the build are errors (name required, limits, tokens); every other empty field is a warning
  try {
    const siteTexts = loadSiteTexts({ siteDir: options?.siteDir })
    for (const problem of siteTextsProblems(siteTexts)) errors.push(`站点文案 (${problem})`)
    for (const e of listEmptyFields(siteTexts)) {
      if (e.required) continue
      warnings.push(`站点文案 (${e.locale}.${e.field}): 未填写，${EMPTY_RULE_TEXT[e.field]}`)
    }
  } catch (err: unknown) {
    errors.push(`站点文案: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    ok: errors.length === 0,
    siteConfigFile: activeSiteConfigFile,
    inUseModules: Array.from(inUseSet),
    modules: moduleReports,
    themes,
    errors,
    warnings,
  }
}

export function formatDoctorText(report: DoctorReport): string {
  const lines: string[] = []
  lines.push('═══════════════════════════════════════════════════════════════════════════════')
  lines.push('  Tutorial V2 讲义引擎配置体检 (doctor)')
  lines.push('═══════════════════════════════════════════════════════════════════════════════')
  lines.push(`站点配置: ${report.siteConfigFile}`)
  lines.push('')

  for (const mod of report.modules) {
    const mark = mod.inUse ? '● 启用中' : '○ 未启用'
    lines.push(`【${mod.title}】 (${mod.id}) — ${mark}`)

    for (const s of mod.settings) {
      const statusIcon =
        s.status === '已设置'
          ? '✓ 已设置'
          : s.status === '默认值'
          ? '· 默认值'
          : s.status === '无效'
          ? '✗ 无效'
          : '- 未设置'

      let probeStr = ''
      if (s.probe) {
        probeStr = s.probe.reachable
          ? ` [probe 可达${s.probe.status ? ` HTTP ${s.probe.status}` : ''}]`
          : ` [probe 失败: ${s.probe.error || '不可达'}]`
      }

      const line = `  ${s.key.padEnd(26)} ${statusIcon.padEnd(10)} 来源: ${s.source.padEnd(12)} 值: ${s.displayValue}${probeStr}`
      lines.push(line)

      if (s.warnings) {
        for (const w of s.warnings) {
          lines.push(`    ⚠ 警告: ${w}`)
        }
      }
      if (s.error) {
        lines.push(`    ✗ 错误: ${s.error}`)
      }
    }
    lines.push('')
  }

  lines.push('【主题包】 (theme packs)')
  for (const th of report.themes) {
    const tags = [th.builtin ? '内置' : '第三方包', th.enabled ? '启用' : '未启用']
    const code = th.note ? `  ⚠ ${th.note}：等同安装一个 npm 依赖，只在构建期安装` : th.hasCode ? `  引擎内置组件 ${th.components.length} 个` : ''
    lines.push(`  ${th.id.padEnd(16)} ${tags.join(' / ')}  engine: ${th.engine ?? '-'}${code}`)
    for (const e of th.errors) lines.push(`    ✗ 错误: ${e}`)
  }
  lines.push('')

  lines.push('─────────────────────────────────────────────────────────────────────────────')
  if (report.ok) {
    lines.push(`体检通过: 0 项错误，${report.warnings.length} 项警告。`)
  } else {
    lines.push(`体检发现 ${report.errors.length} 项错误，${report.warnings.length} 项警告：`)
    for (const e of report.errors) {
      lines.push(`  ✗ ${e}`)
    }
  }
  lines.push('─────────────────────────────────────────────────────────────────────────────')

  return lines.join('\n')
}

export function formatDoctorJson(report: DoctorReport): string {
  // Ensure that no secret values ever leak into JSON
  return JSON.stringify(report, null, 2)
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<number> {
  const isJson = args.includes('--json')
  const isProbe = args.includes('--probe')

  const report = await runDoctor({ probe: isProbe })

  if (isJson) {
    console.log(formatDoctorJson(report))
  } else {
    console.log(formatDoctorText(report))
  }

  return report.ok ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const code = await runCli()
  if (code !== 0) process.exit(code)
}
