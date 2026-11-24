import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODULES,
  SETTINGS,
  SITE_MODULES,
  type ModuleId,
  type Setting,
} from '../../config/schema.ts'
import type { ResolvedModules } from '../../docs/.vitepress/lecture-config.mts'

export type SourceType = 'env' | '.env' | 'legacy' | 'default' | 'unset'

export interface ResolvedSetting {
  key: string
  value: string | undefined
  source: SourceType
  nameUsed: string
  isSet: boolean
  warnings?: string[]
}

export interface ConfigSources {
  repoRoot: string
  env: Record<string, string>
  dotenv: Record<string, string>
  legacy: Record<string, string>
}

/**
 * Parses .env file text into key-value pairs.
 * Rules:
 *  - ignore blank lines and # comments
 *  - strip leading BOM and optional 'export '
 *  - split on first '=', trim key and value
 *  - remove one pair of matching surrounding quotes (' or ")
 *  - no backslash escapes (Windows paths stay as written)
 *  - multi-line values starting with double quote and not closed on the line continue until closing quote
 *  - unquoted values: ' #' is treated as an inline comment
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!text) return out

  const cleaned = text.startsWith('\ufeff') ? text.slice(1) : text
  const lines = cleaned.split(/\r?\n/)

  let inMultiLineQuote = false
  let currentKey = ''
  let currentQuoteChar = ''
  let accumulatedValue = ''

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!

    if (inMultiLineQuote) {
      const closeIdx = rawLine.indexOf(currentQuoteChar)
      if (closeIdx !== -1) {
        accumulatedValue += '\n' + rawLine.slice(0, closeIdx)
        out[currentKey] = accumulatedValue
        inMultiLineQuote = false
        currentKey = ''
        currentQuoteChar = ''
        accumulatedValue = ''
      } else {
        accumulatedValue += '\n' + rawLine
      }
      continue
    }

    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    let line = trimmed
    if (line.startsWith('export ')) {
      line = line.slice(7).trimStart()
    }
    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue

    const key = line.slice(0, eqIdx).trim()
    if (!key) continue

    let val = line.slice(eqIdx + 1).trim()

    if (
      (val.startsWith('"') || val.startsWith("'")) &&
      val.length >= 2 &&
      val.endsWith(val[0]!)
    ) {
      out[key] = val.slice(1, -1)
    } else if (val.startsWith('"')) {
      inMultiLineQuote = true
      currentKey = key
      currentQuoteChar = '"'
      accumulatedValue = val.slice(1)
    } else if (val.startsWith("'")) {
      inMultiLineQuote = true
      currentKey = key
      currentQuoteChar = "'"
      accumulatedValue = val.slice(1)
    } else {
      const hashIdx = val.indexOf(' #')
      if (hashIdx !== -1) {
        val = val.slice(0, hashIdx).trimEnd()
      }
      out[key] = val
    }
  }

  return out
}

export function findRepoRoot(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let curr = startDir
  while (true) {
    if (existsSync(resolve(curr, 'site')) && existsSync(resolve(curr, 'scripts'))) {
      return curr
    }
    const parent = dirname(curr)
    if (parent === curr) {
      return process.cwd()
    }
    curr = parent
  }
}

/**
 * Loads configuration sources adhering to precedence:
 * real env (non-empty) > repo-root .env > legacy file > defaults.
 */
export function loadSources(options?: {
  repoRoot?: string
  env?: Record<string, string | undefined>
}): ConfigSources {
  const root = options?.repoRoot ?? findRepoRoot()
  const rawEnv = options?.env ?? process.env

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawEnv)) {
    if (v !== undefined && v !== '') {
      env[k] = v
    }
  }

  let dotenv: Record<string, string> = {}
  const dotenvPath = resolve(root, '.env')
  try {
    if (existsSync(dotenvPath)) {
      dotenv = parseEnv(readFileSync(dotenvPath, 'utf8'))
    }
  } catch {
    dotenv = {}
  }

  let legacy: Record<string, string> = {}
  const legacyEnvPath =
    env.DEPLOY_ENV_FILE ||
    dotenv.DEPLOY_ENV_FILE ||
    resolve(root, 'scripts/deploy.local.env')

  try {
    if (existsSync(legacyEnvPath)) {
      legacy = parseEnv(readFileSync(legacyEnvPath, 'utf8'))
    }
  } catch {
    legacy = {}
  }

  return { repoRoot: root, env, dotenv, legacy }
}

/**
 * Resolves each setting according to the 4-tier precedence:
 * real env (non-empty) > repo-root .env > legacy file > default.
 * For settings with aliases, tries canonical key first, then aliases at each level.
 */
export function resolveAll(
  sources: ConfigSources,
  settings: readonly Setting[] = SETTINGS
): ResolvedSetting[] {
  const results: ResolvedSetting[] = []

  for (const s of settings) {
    if (s.kind === 'site') {
      // Site settings are managed by lecture.config.ts, resolved separately if needed
      continue
    }

    const names = [s.key, ...(s.aliases ?? [])]
    let resolvedValue: string | undefined = undefined
    let resolvedSource: SourceType = 'unset'
    let resolvedNameUsed = s.key
    const warnings: string[] = []

    // 1. Check real environment
    for (const name of names) {
      const val = sources.env[name]
      if (val !== undefined && val !== '') {
        resolvedValue = val
        resolvedSource = 'env'
        resolvedNameUsed = name
        break
      }
    }

    // 2. Check repo-root .env
    if (resolvedValue === undefined) {
      for (const name of names) {
        const val = sources.dotenv[name]
        if (val !== undefined && val !== '') {
          resolvedValue = val
          resolvedSource = '.env'
          resolvedNameUsed = name
          break
        }
      }
    }

    // 3. Check legacy file
    if (resolvedValue === undefined) {
      for (const name of names) {
        const val = sources.legacy[name]
        if (val !== undefined && val !== '') {
          resolvedValue = val
          resolvedSource = 'legacy'
          resolvedNameUsed = name
          break
        }
      }
    }

    // 4. Default
    if (resolvedValue === undefined && s.default !== undefined) {
      resolvedValue = String(s.default)
      resolvedSource = 'default'
      resolvedNameUsed = s.key
    }

    // Check alias warnings
    if (resolvedSource !== 'default' && resolvedSource !== 'unset') {
      if (resolvedNameUsed !== s.key) {
        warnings.push(`使用旧名 "${resolvedNameUsed}" 提供配置，建议修改为标准键名 "${s.key}"`)
      }
    }

    // Check conflict between canonical and alias
    if (s.aliases && s.aliases.length > 0) {
      const allDicts = [
        { name: '环境变量', dict: sources.env },
        { name: '.env', dict: sources.dotenv },
        { name: '旧版配置文件', dict: sources.legacy },
      ]

      for (const { name: srcName, dict } of allDicts) {
        const canVal = dict[s.key]
        for (const alias of s.aliases) {
          const aliasVal = dict[alias]
          if (
            canVal !== undefined &&
            canVal !== '' &&
            aliasVal !== undefined &&
            aliasVal !== '' &&
            canVal !== aliasVal
          ) {
            warnings.push(
              `在 ${srcName} 中，标准键 "${s.key}" 与别名 "${alias}" 同时设置且值不一致：doctor 与 config.py 取 "${s.key}"，deploy_config.py 仍按旧规则取旧名，请只保留 "${s.key}"`
            )
          }
        }
      }
    }

    const isSet = resolvedSource === 'env' || resolvedSource === '.env' || resolvedSource === 'legacy'

    results.push({
      key: s.key,
      value: resolvedValue,
      source: resolvedSource,
      nameUsed: resolvedNameUsed,
      isSet,
      warnings: warnings.length > 0 ? warnings : undefined,
    })
  }

  return results
}

/**
 * Validates a value against its setting type.
 */
export function validate(
  setting: Setting,
  value: string | undefined
): { valid: boolean; error?: string } {
  if (value === undefined || value === '') {
    if (setting.required) {
      return { valid: false, error: `缺少必填项 ${setting.key}` }
    }
    return { valid: true }
  }

  const v = value.trim()

  const isSecret = setting.kind === 'secret'
  const valHint = isSecret ? '' : `，当前值: ${value}`

  switch (setting.type) {
    case 'int': {
      if (!/^-?\d+$/.test(v)) {
        return { valid: false, error: `必须为整数${valHint}` }
      }
      return { valid: true }
    }
    case 'bool': {
      const lower = v.toLowerCase()
      if (!['1', '0', 'true', 'false', 'yes', 'no', 'y', 'n', 'on', 'off'].includes(lower)) {
        return { valid: false, error: `必须为布尔值 (true/false/1/0/yes/no)${valHint}` }
      }
      return { valid: true }
    }
    case 'url': {
      if (setting.kind === 'site' && /^\/(?!\/)\S*$/.test(v)) {
        return { valid: true }
      }
      if (/\s/.test(v)) {
        return { valid: false, error: `URL 不应包含空格${valHint}` }
      }
      try {
        const u = new URL(v)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return { valid: false, error: `URL 协议必须为 http: 或 https:${valHint}` }
        }
        return { valid: true }
      } catch {
        return { valid: false, error: `URL 格式无效${valHint}` }
      }
    }
    case 'domain': {
      if (v.includes('://') || v.includes('/') || v.includes(':')) {
        return { valid: false, error: `域名不应包含协议、端口或路径${valHint}` }
      }
      if (!/^[a-zA-Z0-9.-]+$/.test(v)) {
        return { valid: false, error: `域名格式无效${valHint}` }
      }
      return { valid: true }
    }
    case 'host': {
      if (v.includes('://') || v.includes('/')) {
        return { valid: false, error: `主机地址不应包含协议或路径${valHint}` }
      }
      if (v.length === 0) {
        return { valid: false, error: `主机地址不能为空` }
      }
      return { valid: true }
    }
    case 'id': {
      const cleanId = v.replace(/-/g, '')
      if (!/^[0-9a-fA-F]{32}$/.test(cleanId)) {
        return { valid: false, error: `必须是 32 位十六进制 ID（带或不带连字符）${valHint}` }
      }
      return { valid: true }
    }
    case 'path': {
      if (v.length === 0) {
        return { valid: false, error: `路径不能为空` }
      }
      return { valid: true }
    }
    case 'pem': {
      const hasBegin = /-----BEGIN [A-Z0-9 _-]+-----/.test(v)
      const hasEnd = /-----END [A-Z0-9 _-]+-----/.test(v)
      if (!hasBegin || !hasEnd) {
        return { valid: false, error: `私钥 PEM 必须包含 -----BEGIN ...----- 和 -----END ...----- 行` }
      }
      return { valid: true }
    }
    case 'enum': {
      if (setting.values && !setting.values.includes(v)) {
        return { valid: false, error: `必须是 [${setting.values.join(', ')}] 之一${valHint}` }
      }
      return { valid: true }
    }
    case 'list':
    case 'string':
    default:
      return { valid: true }
  }
}

/**
 * Port of mask() from deploy_config.py:
 * Only used for non-secret masked fields (like IP, hostname, path).
 */
export function mask(value: string | undefined): string {
  const text = String(value || '')
  if (!text) return '<empty>'
  const parts = text.split('.')
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    return `${parts[0]}.***.***.${parts[3]}`
  }
  if (text.length <= 6) {
    return text.slice(0, 2) + '***'
  }
  return text.slice(0, 6) + '****'
}

/**
 * Formats a value for display:
 * secrets -> 已设置（长度 N） / 未设置
 * masked  -> masked format
 * others  -> raw value or 未设置
 */
export function display(setting: Setting, value: string | undefined): string {
  if (setting.kind === 'secret') {
    if (value !== undefined && value !== '') {
      return `已设置（长度 ${value.length}）`
    }
    return '未设置'
  }

  if (value === undefined || value === '') {
    return '未设置'
  }

  if (setting.masked) {
    return mask(value)
  }

  return value
}

/**
 * Computes which modules are currently considered "in use":
 * - every site module (from resolveModules)
 * - tool modules listed in LECTURE_MODULES, or if empty, any tool module with at least one key set
 * - tool modules required through neededBy (e.g. contentSync = notion puts notion in use)
 */
export function getInUseModules(
  resolvedSettings: ResolvedSetting[],
  siteModules: ResolvedModules
): Set<ModuleId> {
  const inUse = new Set<ModuleId>()

  // 1. All site modules are in use
  for (const m of MODULES) {
    if (m.site) inUse.add(m.id)
  }

  // 2. Check neededBy on all settings
  for (const s of SETTINGS) {
    if (!s.neededBy) continue
    const targetSiteMod = siteModules[s.neededBy.module]
    if (targetSiteMod) {
      // the adapter choice, not an option such as progress.notionSync
      const adapter = (targetSiteMod as Record<string, unknown>)[SITE_MODULES[s.neededBy.module].field]
      if (typeof adapter === 'string' && s.neededBy.adapters.includes(adapter)) {
        inUse.add(s.module)
      }
    }
  }

  // 3. Tool modules
  const resolvedMap = new Map(resolvedSettings.map((r) => [r.key, r]))
  const lectureModulesVal = resolvedMap.get('LECTURE_MODULES')?.value

  if (lectureModulesVal && lectureModulesVal.trim() !== '') {
    const mods = lectureModulesVal
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean) as ModuleId[]
    for (const mod of mods) {
      inUse.add(mod)
    }
  } else {
    // Infer: any tool module with at least one key set
    for (const s of SETTINGS) {
      if (s.kind === 'site') continue
      const res = resolvedMap.get(s.key)
      if (res && res.isSet) {
        inUse.add(s.module)
      }
    }
  }

  return inUse
}

/**
 * Pure function to update .env text keeping all existing lines, comments and ordering.
 * Replaces lines of changed keys, appends new keys under appropriate comments.
 */
/**
 * Write a value so that parseEnv reads back exactly the same string: plain when that is safe, otherwise in
 * double quotes (or single quotes when the value contains a double quote). There are no escapes, so a value
 * holding both quote kinds, or a double quote across lines, cannot be written and is rejected.
 */
export function formatEnvValue(value: string): string {
  const needsQuotes = /\s#/.test(value) || /^\s|\s$/.test(value) || /^["']/.test(value) || value.includes('\n')
  if (value === '' || !needsQuotes) return value
  if (!value.includes('"')) return `"${value}"`
  if (!value.includes("'") && !value.includes('\n')) return `'${value}'`
  throw new Error('该值同时含有单引号与双引号（或多行里含双引号），.env 无法无歧义地保存，请改用环境变量注入')
}

export function updateEnvText(
  existingText: string,
  updates: Record<string, string>,
  newModuleComments?: Record<string, string>
): string {
  // keep the file's own line ending so unrelated lines stay byte-for-byte the same
  const eol = existingText.includes('\r\n') ? '\r\n' : '\n'
  const lines = existingText ? existingText.split(/\r?\n/) : []
  const remainingKeys = new Set(Object.keys(updates))
  const newLines: string[] = []

  let inMultiLine = false
  let currentQuote = ''

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!

    if (inMultiLine) {
      if (rawLine.includes(currentQuote)) {
        inMultiLine = false
        currentQuote = ''
      }
      // Skip the old multiline body
      continue
    }

    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      newLines.push(rawLine)
      continue
    }

    let checkLine = trimmed
    const isExport = checkLine.startsWith('export ')
    if (isExport) {
      checkLine = checkLine.slice(7).trimStart()
    }

    const eqIdx = checkLine.indexOf('=')
    if (eqIdx === -1) {
      newLines.push(rawLine)
      continue
    }

    const key = checkLine.slice(0, eqIdx).trim()
    if (key && Object.prototype.hasOwnProperty.call(updates, key)) {
      remainingKeys.delete(key)
      const newVal = updates[key]!

      // Check if old line was multiline
      const afterEq = checkLine.slice(eqIdx + 1).trim()
      if (
        (afterEq.startsWith('"') || afterEq.startsWith("'")) &&
        (!afterEq.endsWith(afterEq[0]!) || afterEq.length === 1)
      ) {
        inMultiLine = true
        currentQuote = afterEq[0]!
      }

      // Format new line
      const prefix = isExport ? 'export ' : ''
      newLines.push(`${prefix}${key}=${formatEnvValue(newVal)}`)
    } else {
      newLines.push(rawLine)
    }
  }

  // Append remaining keys
  if (remainingKeys.size > 0) {
    if (newLines.length > 0 && newLines[newLines.length - 1] !== '') {
      newLines.push('')
    }

    // Group remaining keys by module
    const grouped = new Map<ModuleId, string[]>()
    for (const key of remainingKeys) {
      const setting = SETTINGS.find((s) => s.key === key)
      const mod = setting ? setting.module : ('meta' as ModuleId)
      if (!grouped.has(mod)) grouped.set(mod, [])
      grouped.get(mod)!.push(key)
    }

    for (const [mod, keys] of grouped) {
      if (newModuleComments && newModuleComments[mod]) {
        newLines.push('')
        newLines.push(newModuleComments[mod]!)
      }
      for (const k of keys) {
        newLines.push(`${k}=${formatEnvValue(updates[k]!)}`)
      }
    }
  }

  return newLines.join(eol)
}
