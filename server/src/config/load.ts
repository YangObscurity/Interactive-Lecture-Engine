import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError, parseEnv } from './env.js'
import {
  AUTH_HEADER_PRESETS,
  CONFIG_SCHEMA,
  parseBooleanValue,
  parseRoleMap,
  type AiProvider,
  type AppConfig,
  type AuthAdapter,
  type AuthCookieSecure,
  type AuthHeaderPreset,
  type LogLevel,
} from './schema.js'

export { ConfigError }

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>
  envFile?: string | false
}

const DEFAULT_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env')

export function redactSecret(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return 'unset'
  }
  return `set (length ${value.length})`
}

function expandIpv6(raw: string): number[] | null {
  let addr = raw.toLowerCase()
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':')
    if (lastColon === -1) return null
    const ipv4Part = addr.slice(lastColon + 1)
    const ipv4Segs = ipv4Part.split('.')
    if (ipv4Segs.length !== 4) return null
    const octets: number[] = []
    for (const seg of ipv4Segs) {
      if (!/^\d{1,3}$/.test(seg)) return null
      const n = Number(seg)
      if (n < 0 || n > 255) return null
      octets.push(n)
    }
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16)
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16)
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`
  }

  const doubleColonParts = addr.split('::')
  if (doubleColonParts.length > 2) return null

  const parseSide = (side: string): number[] | null => {
    if (!side) return []
    const groups = side.split(':')
    const out: number[] = []
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(Number.parseInt(g, 16))
    }
    return out
  }

  const left = parseSide(doubleColonParts[0]!)
  if (!left) return null

  if (doubleColonParts.length === 1) {
    return left.length === 8 ? left : null
  }

  const right = parseSide(doubleColonParts[1]!)
  if (!right) return null

  const missing = 8 - (left.length + right.length)
  if (missing < 1) return null

  return [...left, ...new Array<number>(missing).fill(0), ...right]
}

export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1)
  }

  if (h === 'localhost') return true

  const ipv4Match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (ipv4Match) {
    const octets = [Number(ipv4Match[1]), Number(ipv4Match[2]), Number(ipv4Match[3])]
    return octets.every((o) => o >= 0 && o <= 255)
  }

  if (h.includes(':')) {
    const hextets = expandIpv6(h)
    if (!hextets) return false
    // ::1
    const isIpv6Loopback =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0 &&
      hextets[6] === 0 &&
      hextets[7] === 1
    if (isIpv6Loopback) return true

    // ::ffff:127.0.0.0/8 (mapped IPv4 loopback)
    const isIpv4Mapped =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0xffff
    if (isIpv4Mapped && (hextets[6]! >> 8) === 127) {
      return true
    }
  }

  return false
}

function isLoadConfigOptions(
  input: LoadConfigOptions | Record<string, string | undefined>,
): input is LoadConfigOptions {
  const keys = Object.keys(input)
  if (keys.length === 0 || !keys.every((k) => k === 'env' || k === 'envFile')) {
    return false
  }
  if (
    Object.hasOwn(input, 'env') &&
    input.env !== undefined &&
    (typeof input.env !== 'object' || input.env === null)
  ) {
    return false
  }
  if (
    Object.hasOwn(input, 'envFile') &&
    input.envFile !== undefined &&
    input.envFile !== false &&
    typeof input.envFile !== 'string'
  ) {
    return false
  }
  return true
}

export function loadConfig(
  optionsOrEnv?: LoadConfigOptions | Record<string, string | undefined>,
): AppConfig {
  let env: Record<string, string | undefined>
  let envFile: string | false

  if (optionsOrEnv === undefined) {
    env = process.env
    envFile = DEFAULT_ENV_FILE
  } else if (isLoadConfigOptions(optionsOrEnv)) {
    env = optionsOrEnv.env ?? process.env
    envFile = optionsOrEnv.envFile === undefined ? DEFAULT_ENV_FILE : optionsOrEnv.envFile
  } else {
    env = optionsOrEnv
    envFile = false
  }

  let dotenv: Record<string, string> = {}
  if (envFile !== false && existsSync(envFile)) {
    const content = readFileSync(envFile, 'utf8')
    dotenv = parseEnv(content)
  }

  const errors: string[] = []
  const invalidKeys: string[] = []
  const resolved = new Map<string, string | number | boolean | null>()

  for (const spec of CONFIG_SCHEMA) {
    let raw: string | undefined
    if (Object.hasOwn(env, spec.name) && env[spec.name] !== undefined) {
      raw = env[spec.name]
    } else if (Object.hasOwn(dotenv, spec.name)) {
      raw = dotenv[spec.name]
    } else {
      raw = undefined
    }

    const candidate = spec.preserveWhitespace ? raw : raw?.trim()
    const isEmpty = candidate === undefined || candidate === ''

    if (isEmpty) {
      if (spec.required) {
        errors.push(`${spec.name}: 缺少必填配置项`)
        invalidKeys.push(spec.name)
      } else {
        resolved.set(spec.name, spec.default !== undefined ? spec.default : null)
      }
      continue
    }

    const reason = spec.validator(candidate)
    if (reason !== null) {
      if (spec.secret) {
        errors.push(`${spec.name} (${redactSecret(candidate)}): ${reason}`)
      } else {
        errors.push(`${spec.name}: ${reason}`)
      }
      invalidKeys.push(spec.name)
      continue
    }

    if (spec.type === 'int') {
      resolved.set(spec.name, Number(candidate))
    } else if (spec.type === 'boolean') {
      resolved.set(spec.name, parseBooleanValue(candidate)!)
    } else if (spec.name === 'LOG_LEVEL') {
      resolved.set(spec.name, candidate.toLowerCase())
    } else if (spec.name === 'HOST' && candidate.startsWith('[') && candidate.endsWith(']')) {
      resolved.set(spec.name, candidate.slice(1, -1))
    } else {
      resolved.set(spec.name, candidate)
    }
  }

  const authAdapter = (resolved.get('AUTH_ADAPTER') as AuthAdapter | undefined) ?? 'none'
  const authHeaderPreset =
    (resolved.get('AUTH_HEADER_PRESET') as AuthHeaderPreset | undefined) ?? 'authelia'
  const preset = AUTH_HEADER_PRESETS[authHeaderPreset]

  const explicitUser = resolved.get('AUTH_HEADER_USER') as string | null | undefined
  const explicitGroups = resolved.get('AUTH_HEADER_GROUPS') as string | null | undefined
  const explicitEmail = resolved.get('AUTH_HEADER_EMAIL') as string | null | undefined
  const explicitName = resolved.get('AUTH_HEADER_NAME') as string | null | undefined
  const explicitSep = resolved.get('AUTH_GROUP_SEPARATOR') as string | null | undefined

  const authHeaderUser = explicitUser ?? preset.user
  const authHeaderGroups = explicitGroups ?? preset.groups
  const authHeaderEmail = explicitEmail ?? preset.email
  const authHeaderName = explicitName ?? preset.name
  const authGroupSeparator = explicitSep ?? preset.groupSeparator

  const isHeaderBackedAdapter = authAdapter === 'trusted-header' || authAdapter === 'hybrid'

  if (
    isHeaderBackedAdapter &&
    authHeaderPreset === 'custom' &&
    !authHeaderUser &&
    !invalidKeys.includes('AUTH_HEADER_USER')
  ) {
    errors.push(
      `AUTH_HEADER_USER: 当 AUTH_ADAPTER=${authAdapter} 且 AUTH_HEADER_PRESET=custom 时必须配置 AUTH_HEADER_USER`,
    )
    invalidKeys.push('AUTH_HEADER_USER', 'AUTH_HEADER_PRESET')
  }

  const host = (resolved.get('HOST') as string | undefined) ?? '127.0.0.1'
  const allowNonLoopback = Boolean(resolved.get('ALLOW_NON_LOOPBACK'))

  if (
    !invalidKeys.includes('HOST') &&
    !invalidKeys.includes('AUTH_ADAPTER') &&
    !invalidKeys.includes('ALLOW_NON_LOOPBACK') &&
    isHeaderBackedAdapter &&
    !isLoopbackHost(host) &&
    !allowNonLoopback
  ) {
    errors.push(
      `HOST (${host}): AUTH_ADAPTER=${authAdapter} 模式下禁止绑定非回环地址；请改用回环地址（如 127.0.0.1）或在确保上游网关覆盖身份头后显式设置 ALLOW_NON_LOOPBACK=true`,
    )
    invalidKeys.push('HOST', 'AUTH_ADAPTER', 'ALLOW_NON_LOOPBACK')
  }

  const aiProvider = (resolved.get('AI_PROVIDER') as AiProvider | undefined) ?? 'off'
  const difyApiKey = resolved.get('DIFY_API_KEY') as string | null | undefined
  const openaiApiKey = resolved.get('OPENAI_API_KEY') as string | null | undefined

  if (aiProvider === 'dify' && (!difyApiKey || difyApiKey.trim() === '')) {
    errors.push('DIFY_API_KEY: 当 AI_PROVIDER=dify 时必须配置 DIFY_API_KEY')
    invalidKeys.push('DIFY_API_KEY', 'AI_PROVIDER')
  }

  if (aiProvider === 'openai' && (!openaiApiKey || openaiApiKey.trim() === '')) {
    errors.push('OPENAI_API_KEY: 当 AI_PROVIDER=openai 时必须配置 OPENAI_API_KEY')
    invalidKeys.push('OPENAI_API_KEY', 'AI_PROVIDER')
  }

  if (errors.length > 0) {
    throw new ConfigError(
      `配置校验失败:\n- ${errors.join('\n- ')}`,
      [...new Set(invalidKeys)],
    )
  }

  const rawRoleMap = (resolved.get('AUTH_ROLE_MAP') as string | undefined) ?? ''
  const { map: authRoleMap } = parseRoleMap(rawRoleMap)

  return {
    databaseUrl: resolved.get('DATABASE_URL') as string,
    databaseUrlDirect: (resolved.get('DATABASE_URL_DIRECT') as string | null) ?? null,
    host,
    port: resolved.get('PORT') as number,
    authAdapter,
    authHeaderPreset,
    authHeaderUser,
    authHeaderGroups,
    authHeaderEmail,
    authHeaderName,
    authGroupSeparator,
    authRoleMap,
    logoutUrl: (resolved.get('LOGOUT_URL') as string | null) ?? null,
    authCookieName: (resolved.get('AUTH_COOKIE_NAME') as string | undefined) ?? 'lec_session',
    authCookieSecure: (resolved.get('AUTH_COOKIE_SECURE') as AuthCookieSecure | undefined) ?? 'auto',
    sessionTtlHours: (resolved.get('SESSION_TTL_HOURS') as number | undefined) ?? 12,
    rememberMeDays: (resolved.get('REMEMBER_ME_DAYS') as number | undefined) ?? 30,
    authMethodsEnabled:
      (resolved.get('AUTH_METHODS_ENABLED') as string | undefined) ?? 'password,passkey,gateway',
    webauthnRpId: (resolved.get('WEBAUTHN_RP_ID') as string | undefined) ?? '',
    webauthnRpName:
      (resolved.get('WEBAUTHN_RP_NAME') as string | undefined) ?? 'Interactive Lecture Engine',
    webauthnOrigin: (resolved.get('WEBAUTHN_ORIGIN') as string | undefined) ?? '',
    authBootstrapToken: (resolved.get('AUTH_BOOTSTRAP_TOKEN') as string | null) ?? null,
    dbAutoMigrate: Boolean(resolved.get('DB_AUTO_MIGRATE')),
    notionHealthUrl: (resolved.get('NOTION_HEALTH_URL') as string | null) ?? null,
    allowNonLoopback,
    logLevel: resolved.get('LOG_LEVEL') as LogLevel,
    aiProvider,
    difyApiBase: (resolved.get('DIFY_API_BASE') as string | undefined) ?? 'https://api.dify.ai/v1',
    difyApiKey: (resolved.get('DIFY_API_KEY') as string | null) ?? null,
    openaiApiBase: (resolved.get('OPENAI_API_BASE') as string | undefined) ?? 'https://api.openai.com/v1',
    openaiApiKey: (resolved.get('OPENAI_API_KEY') as string | null) ?? null,
    openaiModel: (resolved.get('OPENAI_MODEL') as string | undefined) ?? 'gpt-4o-mini',
    aiUpstreamTimeoutMs: (resolved.get('AI_UPSTREAM_TIMEOUT_MS') as number | undefined) ?? 60000,
    aiUploadMaxBytes: (resolved.get('AI_UPLOAD_MAX_BYTES') as number | undefined) ?? 20971520,
    aiAllowAnonymous: Boolean(resolved.get('AI_ALLOW_ANONYMOUS')),
    aiRatePerMinute: (resolved.get('AI_RATE_PER_MINUTE') as number | undefined) ?? 20,
    aiMaxConcurrent: (resolved.get('AI_MAX_CONCURRENT') as number | undefined) ?? 2,
    aiDailyLimit: (resolved.get('AI_DAILY_LIMIT') as number | undefined) ?? 300,
    writeRatePerMinute: (resolved.get('WRITE_RATE_PER_MINUTE') as number | undefined) ?? 120,
    aiQueryMaxBytes: (resolved.get('AI_QUERY_MAX_BYTES') as number | undefined) ?? 8192,
    aiInputsMaxBytes: (resolved.get('AI_INPUTS_MAX_BYTES') as number | undefined) ?? 32768,
    aiStreamMaxMs: (resolved.get('AI_STREAM_MAX_MS') as number | undefined) ?? 300000,
    aiAccessLog: resolved.get('AI_ACCESS_LOG') === undefined ? true : Boolean(resolved.get('AI_ACCESS_LOG')),
    aiPromptsFile: (resolved.get('AI_PROMPTS_FILE') as string | null) ?? null,
    siteDistDir: (resolved.get('SITE_DIST_DIR') as string | null) ?? null,
    aiToolsFile: (resolved.get('AI_TOOLS_FILE') as string | null) ?? null,
    aiToolTimeoutMs: (resolved.get('AI_TOOL_TIMEOUT_MS') as number | undefined) ?? 8000,
    aiToolMaxResultBytes: (resolved.get('AI_TOOL_MAX_RESULT_BYTES') as number | undefined) ?? 24000,
    aiToolMaxSteps: (resolved.get('AI_TOOL_MAX_STEPS') as number | undefined) ?? 5,
    aiMcpToken: (resolved.get('AI_MCP_TOKEN') as string | null) ?? null,
    aiMcpTicketSecret: (resolved.get('AI_MCP_TICKET_SECRET') as string | null) ?? null,
  }
}

export function formatConfigSummary(cfg: AppConfig): Record<string, string> {
  const summary: Record<string, string> = {}

  for (const spec of CONFIG_SCHEMA) {
    const val = cfg[spec.configKey]
    if (spec.secret) {
      summary[spec.name] = redactSecret(typeof val === 'string' ? val : null)
      continue
    }

    if (spec.configKey === 'authRoleMap') {
      const pairs: string[] = []
      for (const [group, roles] of Object.entries(cfg.authRoleMap)) {
        for (const role of roles) {
          pairs.push(`${group}:${role}`)
        }
      }
      summary[spec.name] = pairs.length > 0 ? pairs.join(',') : 'unset'
      continue
    }

    if (val === null || val === undefined || val === '') {
      summary[spec.name] = 'unset'
    } else {
      summary[spec.name] = String(val)
    }
  }

  return summary
}
