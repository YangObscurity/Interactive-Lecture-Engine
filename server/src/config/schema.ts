import { isIP } from 'node:net'
import { formatEnvValue } from './env.js'

export type AuthAdapter = 'none' | 'trusted-header'
export type AuthHeaderPreset = 'authelia' | 'authentik' | 'oauth2-proxy' | 'custom'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type Role = 'reader' | 'author' | 'admin'
export type AiProvider = 'off' | 'dify' | 'openai'
export type SettingGroup = 'database' | 'server' | 'auth' | 'ai' | 'ops'
export type SettingType = 'string' | 'int' | 'boolean' | 'enum' | 'url' | 'host'

export interface AuthHeaderPresetConfig {
  user: string | null
  groups: string | null
  email: string | null
  name: string | null
  groupSeparator: string
}

export const AUTH_HEADER_PRESETS: Record<AuthHeaderPreset, AuthHeaderPresetConfig> = {
  authelia: {
    user: 'Remote-User',
    groups: 'Remote-Groups',
    email: 'Remote-Email',
    name: 'Remote-Name',
    groupSeparator: ',',
  },
  authentik: {
    user: 'X-authentik-username',
    groups: 'X-authentik-groups',
    email: 'X-authentik-email',
    name: 'X-authentik-name',
    groupSeparator: '|',
  },
  'oauth2-proxy': {
    user: 'X-Forwarded-User',
    groups: 'X-Forwarded-Groups',
    email: 'X-Forwarded-Email',
    name: 'X-Forwarded-Preferred-Username',
    groupSeparator: ',',
  },
  custom: {
    user: null,
    groups: null,
    email: null,
    name: null,
    groupSeparator: ',',
  },
}

export const VALID_ROLES: readonly Role[] = ['reader', 'author', 'admin']
const VALID_ROLE_SET = new Set<string>(VALID_ROLES)

export interface AppConfig {
  databaseUrl: string
  databaseUrlDirect: string | null
  host: string
  port: number
  authAdapter: AuthAdapter
  authHeaderPreset: AuthHeaderPreset
  authHeaderUser: string | null
  authHeaderGroups: string | null
  authHeaderEmail: string | null
  authHeaderName: string | null
  authGroupSeparator: string
  authRoleMap: Record<string, Role[]>
  logoutUrl: string | null
  dbAutoMigrate: boolean
  notionHealthUrl: string | null
  allowNonLoopback: boolean
  logLevel: LogLevel
  aiProvider: AiProvider
  difyApiBase: string
  difyApiKey: string | null
  openaiApiBase: string
  openaiApiKey: string | null
  openaiModel: string
  aiUpstreamTimeoutMs: number
  aiUploadMaxBytes: number
  aiAllowAnonymous: boolean
  aiRatePerMinute: number
  aiMaxConcurrent: number
  aiDailyLimit: number
  writeRatePerMinute: number
  aiQueryMaxBytes: number
  aiInputsMaxBytes: number
  aiStreamMaxMs: number
  aiAccessLog: boolean
  aiPromptsFile: string | null
  siteDistDir: string | null
  aiToolsFile: string | null
  aiToolTimeoutMs: number
  aiToolMaxResultBytes: number
  aiToolMaxSteps: number
  aiMcpToken: string | null
  aiMcpTicketSecret: string | null
}

export interface SettingSpec {
  name: string
  configKey: keyof AppConfig
  group: SettingGroup
  type: SettingType
  values?: readonly string[]
  default?: string | number | boolean
  required: boolean
  secret: boolean
  preserveWhitespace?: boolean
  description: string
  example?: string
  validator: (value: string) => string | null
}

const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/

export function validateDatabaseUrl(raw: string): string | null {
  const v = raw.trim()
  if (!v) return '数据库连接串不能为空'
  if (CONTROL_CHAR_RE.test(v)) return '数据库连接串不能包含控制字符'

  if (v === 'pglite:memory') return null
  if (v.startsWith('pglite:')) {
    const dir = v.slice('pglite:'.length).trim()
    if (!dir) return 'pglite: 后必须指定 memory 或非空目录路径'
    return null
  }

  if (v.startsWith('postgres://') || v.startsWith('postgresql://')) {
    try {
      const u = new URL(v)
      if (!u.hostname) {
        return 'PostgreSQL 连接串缺少主机名'
      }
      return null
    } catch {
      return 'PostgreSQL 连接串 URL 格式无效'
    }
  }

  return '必须为 postgres://、postgresql://、pglite:memory 或 pglite:<目录>'
}

export function validateHost(raw: string): string | null {
  const v = raw.trim()
  if (!v) return '主机地址不能为空'
  if (CONTROL_CHAR_RE.test(v) || /\s/.test(v)) {
    return '主机地址不能包含空白或控制字符'
  }
  if (v.includes('://') || v.includes('/')) {
    return '主机地址不应包含协议或路径'
  }
  if (v.includes('[') || v.includes(']')) {
    if (!/^\[[^\]]+\]$/.test(v)) {
      return 'IPv6 方括号格式无效'
    }
    const inner = v.slice(1, -1)
    if (isIP(inner) !== 6) {
      return '方括号内必须为有效的 IPv6 地址'
    }
    return null
  }
  if (v.includes(':') && isIP(v) !== 6) {
    return '主机地址格式无效（请勿包含端口，请使用 PORT 配置；若为 IPv6 请提供合法地址）'
  }
  return null
}

export function validatePort(raw: string): string | null {
  const v = raw.trim()
  if (!/^\d+$/.test(v)) {
    return '端口必须为 1–65535 之间的整数'
  }
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return '端口必须在 1–65535 之间'
  }
  return null
}

export function validateHeaderName(raw: string): string | null {
  const v = raw.trim()
  if (!v) return 'HTTP 请求头名称不能为空'
  if (!HTTP_HEADER_NAME_RE.test(v)) {
    return 'HTTP 请求头名称只能包含合法 token 字符（不可含空白、冒号或控制字符）'
  }
  return null
}

export function validateGroupSeparator(raw: string): string | null {
  if (raw.length === 0) return '用户组分隔符不能为空'
  if (CONTROL_CHAR_RE.test(raw)) return '用户组分隔符不能包含控制字符'
  return null
}

export function parseBooleanValue(raw: string): boolean | null {
  const lower = raw.trim().toLowerCase()
  if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false
  return null
}

export function validateBoolean(raw: string): string | null {
  if (parseBooleanValue(raw) === null) {
    return '必须为布尔值（true/false/1/0/yes/no/on/off）'
  }
  return null
}

export function validateHttpUrl(raw: string): string | null {
  if (CONTROL_CHAR_RE.test(raw)) {
    return 'URL 不能包含控制字符'
  }
  const v = raw.trim()
  if (!v) return 'URL 不能为空'
  try {
    const u = new URL(v)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return 'URL 协议必须为 http: 或 https:'
    }
    if (!u.hostname) {
      return 'URL 缺少主机名'
    }
    return null
  } catch {
    return 'URL 格式无效'
  }
}

export function validateTimeoutMs(raw: string): string | null {
  const v = raw.trim()
  if (!/^\d+$/.test(v)) {
    return '超时毫秒数必须为 1000–300000 之间的整数'
  }
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1000 || n > 300000) {
    return '超时毫秒数必须在 1000–300000 之间'
  }
  return null
}

export function validateUploadMaxBytes(raw: string): string | null {
  const v = raw.trim()
  if (!/^\d+$/.test(v)) {
    return '最大上传字节数必须为 1024–104857600 之间的整数'
  }
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1024 || n > 104857600) {
    return '最大上传字节数必须在 1024–104857600 之间'
  }
  return null
}

/** Build a validator for a plain integer within [min, max]. */
export function makeIntRangeValidator(label: string, min: number, max: number): (raw: string) => string | null {
  return (raw: string) => {
    const v = raw.trim()
    if (!/^\d+$/.test(v)) {
      return `${label}必须为 ${min}–${max} 之间的整数`
    }
    const n = Number(v)
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      return `${label}必须在 ${min}–${max} 之间`
    }
    return null
  }
}

export function validateNoControlChars(raw: string): string | null {
  if (CONTROL_CHAR_RE.test(raw)) {
    return '配置值不能包含控制字符'
  }
  return null
}

export function validateNonEmptyString(raw: string): string | null {
  if (CONTROL_CHAR_RE.test(raw)) {
    return '配置值不能包含控制字符'
  }
  if (!raw.trim()) {
    return '配置值不能为空'
  }
  return null
}

export function parseRoleMap(raw: string): { map: Record<string, Role[]>; error: string | null } {
  const v = raw.trim()
  const map = Object.create(null) as Record<string, Role[]>
  if (!v) return { map, error: null }

  const entries = v.split(',')

  for (const rawEntry of entries) {
    const entry = rawEntry.trim()
    if (!entry) {
      return { map: Object.create(null) as Record<string, Role[]>, error: '角色映射不能包含空项（请检查多余逗号）' }
    }
    const parts = entry.split(':')
    if (parts.length !== 2) {
      return {
        map: Object.create(null) as Record<string, Role[]>,
        error: `角色映射项 "${entry}" 格式无效，必须为 <组名>:<角色>`,
      }
    }
    const group = parts[0]!.trim()
    const role = parts[1]!.trim()
    if (!group || !role) {
      return {
        map: Object.create(null) as Record<string, Role[]>,
        error: `角色映射项 "${entry}" 中组名或角色不能为空`,
      }
    }
    if (!VALID_ROLE_SET.has(role)) {
      return {
        map: Object.create(null) as Record<string, Role[]>,
        error: `角色 "${role}" 无效，允许值为: ${VALID_ROLES.join(', ')}`,
      }
    }
    const typedRole = role as Role
    const existing = Object.hasOwn(map, group) ? map[group] : undefined
    if (existing) {
      if (!existing.includes(typedRole)) existing.push(typedRole)
    } else {
      map[group] = [typedRole]
    }
  }

  return { map, error: null }
}

export function validateRoleMap(raw: string): string | null {
  return parseRoleMap(raw).error
}

function makeEnumValidator(values: readonly string[], caseInsensitive = false): (raw: string) => string | null {
  return (raw: string) => {
    const v = caseInsensitive ? raw.trim().toLowerCase() : raw.trim()
    if (!values.includes(v)) {
      return `必须为 [${values.join(', ')}] 之一`
    }
    return null
  }
}

export const CONFIG_SCHEMA: readonly SettingSpec[] = [
  {
    name: 'DATABASE_URL',
    configKey: 'databaseUrl',
    group: 'database',
    type: 'string',
    required: true,
    secret: true,
    description: '数据库连接串（运行时使用；支持 postgres:// / postgresql:// / pglite:memory / pglite:<目录>）',
    example: 'postgresql://user:password@ep-pooler.ap-southeast-1.aws.neon.tech/lecture?sslmode=require',
    validator: validateDatabaseUrl,
  },
  {
    name: 'DATABASE_URL_DIRECT',
    configKey: 'databaseUrlDirect',
    group: 'database',
    type: 'string',
    required: false,
    secret: true,
    description: '数据库直连地址（可选，用于迁移；Neon 建议填非池化地址，未设置时回落到 DATABASE_URL）',
    example: 'postgresql://user:password@ep-direct.ap-southeast-1.aws.neon.tech/lecture?sslmode=require',
    validator: validateDatabaseUrl,
  },
  {
    name: 'HOST',
    configKey: 'host',
    group: 'server',
    type: 'host',
    default: '127.0.0.1',
    required: false,
    secret: false,
    description: 'HTTP 服务监听地址（启用 trusted-header 时须为回环地址，除非显式开启 ALLOW_NON_LOOPBACK）',
    example: '127.0.0.1',
    validator: validateHost,
  },
  {
    name: 'PORT',
    configKey: 'port',
    group: 'server',
    type: 'int',
    default: 8100,
    required: false,
    secret: false,
    description: 'HTTP 服务监听端口（1–65535）',
    example: '8100',
    validator: validatePort,
  },
  {
    name: 'AUTH_ADAPTER',
    configKey: 'authAdapter',
    group: 'auth',
    type: 'enum',
    values: ['none', 'trusted-header'],
    default: 'none',
    required: false,
    secret: false,
    description: '身份认证适配器（none：全部请求视为 anonymous；trusted-header：从前置认证网关头读取）',
    example: 'none',
    validator: makeEnumValidator(['none', 'trusted-header']),
  },
  {
    name: 'AUTH_HEADER_PRESET',
    configKey: 'authHeaderPreset',
    group: 'auth',
    type: 'enum',
    values: ['authelia', 'authentik', 'oauth2-proxy', 'custom'],
    default: 'authelia',
    required: false,
    secret: false,
    description: '认证网关请求头预设（authelia / authentik / oauth2-proxy / custom）',
    example: 'authelia',
    validator: makeEnumValidator(['authelia', 'authentik', 'oauth2-proxy', 'custom']),
  },
  {
    name: 'AUTH_HEADER_USER',
    configKey: 'authHeaderUser',
    group: 'auth',
    type: 'string',
    required: false,
    secret: false,
    description: '用户 ID 请求头名（可覆盖预设；AUTH_HEADER_PRESET=custom 且启用 trusted-header 时必填）',
    example: 'Remote-User',
    validator: validateHeaderName,
  },
  {
    name: 'AUTH_HEADER_GROUPS',
    configKey: 'authHeaderGroups',
    group: 'auth',
    type: 'string',
    required: false,
    secret: false,
    description: '用户组请求头名（可选，覆盖预设默认值）',
    example: 'Remote-Groups',
    validator: validateHeaderName,
  },
  {
    name: 'AUTH_HEADER_EMAIL',
    configKey: 'authHeaderEmail',
    group: 'auth',
    type: 'string',
    required: false,
    secret: false,
    description: '用户邮箱请求头名（可选，覆盖预设默认值）',
    example: 'Remote-Email',
    validator: validateHeaderName,
  },
  {
    name: 'AUTH_HEADER_NAME',
    configKey: 'authHeaderName',
    group: 'auth',
    type: 'string',
    required: false,
    secret: false,
    description: '用户显示名请求头名（可选，覆盖预设默认值）',
    example: 'Remote-Name',
    validator: validateHeaderName,
  },
  {
    name: 'AUTH_GROUP_SEPARATOR',
    configKey: 'authGroupSeparator',
    group: 'auth',
    type: 'string',
    required: false,
    secret: false,
    preserveWhitespace: true,
    description: '用户组请求头分隔符（可选，覆盖预设默认值；authelia/oauth2-proxy/custom 默认为 ","，authentik 默认为 "|"）',
    example: ',',
    validator: validateGroupSeparator,
  },
  {
    name: 'AUTH_ROLE_MAP',
    configKey: 'authRoleMap',
    group: 'auth',
    type: 'string',
    default: '',
    required: false,
    secret: false,
    description: '网关用户组到系统角色的映射（逗号分隔 <组名>:<reader|author|admin>，reader 角色始终自动保留）',
    example: 'admins:admin,authors:author',
    validator: validateRoleMap,
  },
  {
    name: 'LOGOUT_URL',
    configKey: 'logoutUrl',
    group: 'auth',
    type: 'url',
    required: false,
    secret: false,
    description: '认证网关登出跳转地址（可选，http:// 或 https://）',
    example: 'https://auth.example.com/logout',
    validator: validateHttpUrl,
  },
  {
    name: 'DB_AUTO_MIGRATE',
    configKey: 'dbAutoMigrate',
    group: 'ops',
    type: 'boolean',
    default: false,
    required: false,
    secret: false,
    description: '服务启动时发现未执行迁移是否自动执行（默认 false；为 false 时如有待迁移表结构将拒绝启动）',
    example: 'false',
    validator: validateBoolean,
  },
  {
    name: 'NOTION_HEALTH_URL',
    configKey: 'notionHealthUrl',
    group: 'ops',
    type: 'url',
    required: false,
    secret: false,
    description: 'Notion 同步伴随服务的健康检查探测地址（可选，留空时 /api/health 返回 checks.notion = "off"）',
    example: 'http://127.0.0.1:8099/health',
    validator: validateHttpUrl,
  },
  {
    name: 'ALLOW_NON_LOOPBACK',
    configKey: 'allowNonLoopback',
    group: 'ops',
    type: 'boolean',
    default: false,
    required: false,
    secret: false,
    description: '是否允许在 AUTH_ADAPTER=trusted-header 下绑定非回环 HOST（仅在确认上游反代已覆盖身份头时设为 true）',
    example: 'false',
    validator: validateBoolean,
  },
  {
    name: 'LOG_LEVEL',
    configKey: 'logLevel',
    group: 'ops',
    type: 'enum',
    values: ['debug', 'info', 'warn', 'error'],
    default: 'info',
    required: false,
    secret: false,
    description: '服务日志输出级别（debug / info / warn / error）',
    example: 'info',
    validator: makeEnumValidator(['debug', 'info', 'warn', 'error'], true),
  },
  {
    name: 'AI_PROVIDER',
    configKey: 'aiProvider',
    group: 'ai',
    type: 'enum',
    values: ['off', 'dify', 'openai'],
    default: 'off',
    required: false,
    secret: false,
    description: 'AI 伴读服务提供商（off：关闭伴读代理；dify：Dify 服务；openai：OpenAI 兼容服务）',
    example: 'off',
    validator: makeEnumValidator(['off', 'dify', 'openai']),
  },
  {
    name: 'DIFY_API_BASE',
    configKey: 'difyApiBase',
    group: 'ai',
    type: 'url',
    default: 'https://api.dify.ai/v1',
    required: false,
    secret: false,
    description: 'Dify 服务 API 根路径',
    example: 'https://api.dify.ai/v1',
    validator: validateHttpUrl,
  },
  {
    name: 'DIFY_API_KEY',
    configKey: 'difyApiKey',
    group: 'ai',
    type: 'string',
    required: false,
    secret: true,
    description: 'Dify 应用 API Key（AI_PROVIDER=dify 时必填）',
    example: 'app-xxxxxxxxxxxxxxxxxxxxxxxx',
    validator: validateNonEmptyString,
  },
  {
    name: 'OPENAI_API_BASE',
    configKey: 'openaiApiBase',
    group: 'ai',
    type: 'url',
    default: 'https://api.openai.com/v1',
    required: false,
    secret: false,
    description: 'OpenAI 兼容服务 /v1 根路径',
    example: 'https://api.openai.com/v1',
    validator: validateHttpUrl,
  },
  {
    name: 'OPENAI_API_KEY',
    configKey: 'openaiApiKey',
    group: 'ai',
    type: 'string',
    required: false,
    secret: true,
    description: 'OpenAI API Key（AI_PROVIDER=openai 时必填）',
    example: 'sk-xxxxxxxxxxxxxxxxxxxxxxxx',
    validator: validateNonEmptyString,
  },
  {
    name: 'OPENAI_MODEL',
    configKey: 'openaiModel',
    group: 'ai',
    type: 'string',
    default: 'gpt-4o-mini',
    required: false,
    secret: false,
    description: 'OpenAI 模型 ID',
    example: 'gpt-4o-mini',
    validator: validateNonEmptyString,
  },
  {
    name: 'AI_UPSTREAM_TIMEOUT_MS',
    configKey: 'aiUpstreamTimeoutMs',
    group: 'ai',
    type: 'int',
    default: 60000,
    required: false,
    secret: false,
    description: 'AI 上游连接与首包超时毫秒数（1000–300000）',
    example: '60000',
    validator: validateTimeoutMs,
  },
  {
    name: 'AI_UPLOAD_MAX_BYTES',
    configKey: 'aiUploadMaxBytes',
    group: 'ai',
    type: 'int',
    default: 20971520,
    required: false,
    secret: false,
    description: '课件上传允许的最大字节数（1024–104857600，默认 20MB）',
    example: '20971520',
    validator: validateUploadMaxBytes,
  },
  {
    name: 'AI_ALLOW_ANONYMOUS',
    configKey: 'aiAllowAnonymous',
    group: 'ai',
    type: 'boolean',
    default: false,
    required: false,
    secret: false,
    description: 'AUTH_ADAPTER=none 时是否仍开放 /api/ai/*（默认 false：none 模式下 AI 路由返回 403，避免所有访客共用匿名身份消耗上游额度）',
    example: 'false',
    validator: validateBoolean,
  },
  {
    name: 'AI_RATE_PER_MINUTE',
    configKey: 'aiRatePerMinute',
    group: 'ai',
    type: 'int',
    default: 20,
    required: false,
    secret: false,
    description: '每用户每分钟允许的 /api/ai/* 请求数（令牌桶，进程内计数；1–600）',
    example: '20',
    validator: makeIntRangeValidator('每分钟请求数', 1, 600),
  },
  {
    name: 'AI_MAX_CONCURRENT',
    configKey: 'aiMaxConcurrent',
    group: 'ai',
    type: 'int',
    default: 2,
    required: false,
    secret: false,
    description: '每用户同时进行的 /api/ai/chat 流式会话上限（1–20）；上传另有每用户 1 个并发的固定上限',
    example: '2',
    validator: makeIntRangeValidator('并发流上限', 1, 20),
  },
  {
    name: 'AI_DAILY_LIMIT',
    configKey: 'aiDailyLimit',
    group: 'ai',
    type: 'int',
    default: 300,
    required: false,
    secret: false,
    description: '每个读者每个 UTC 自然日允许的 /api/ai/* 请求数（1–100000）；作者与管理员（AUTH_ROLE_MAP）不计',
    example: '300',
    validator: makeIntRangeValidator('每日请求数', 1, 100000),
  },
  {
    name: 'AI_QUERY_MAX_BYTES',
    configKey: 'aiQueryMaxBytes',
    group: 'ai',
    type: 'int',
    default: 8192,
    required: false,
    secret: false,
    description: '/api/ai/chat 中 query 的最大字节数（UTF-8，256–65536），超限返回 413',
    example: '8192',
    validator: makeIntRangeValidator('query 最大字节数', 256, 65536),
  },
  {
    name: 'AI_INPUTS_MAX_BYTES',
    configKey: 'aiInputsMaxBytes',
    group: 'ai',
    type: 'int',
    default: 32768,
    required: false,
    secret: false,
    description: '/api/ai/chat 中 inputs 各字段值合计的最大字节数（UTF-8，1024–131072），超限返回 413',
    example: '32768',
    validator: makeIntRangeValidator('inputs 最大字节数', 1024, 131072),
  },
  {
    name: 'AI_STREAM_MAX_MS',
    configKey: 'aiStreamMaxMs',
    group: 'ai',
    type: 'int',
    default: 300000,
    required: false,
    secret: false,
    description: '单次 /api/ai/chat 流式响应的总时长上限毫秒数（10000–1800000）；超时以 event: error 帧结束流',
    example: '300000',
    validator: makeIntRangeValidator('流总时长上限', 10000, 1800000),
  },
  {
    name: 'AI_ACCESS_LOG',
    configKey: 'aiAccessLog',
    group: 'ai',
    type: 'boolean',
    default: true,
    required: false,
    secret: false,
    description: '是否对每次 /api/ai/* 调用输出一行结构化访问日志（哈希用户 ID、路由、字节数、状态、耗时、限流命中；从不记录提示词、回答与密钥）',
    example: 'true',
    validator: validateBoolean,
  },
  {
    name: 'AI_PROMPTS_FILE',
    configKey: 'aiPromptsFile',
    group: 'ai',
    type: 'string',
    required: false,
    secret: false,
    description: 'AI 伴读系统提示词与快捷动作 JSON 文件路径；留空时依次尝试 ./prompts/companion.json、../site/prompts/companion.json 与站点构建产物',
    example: 'prompts/companion.json',
    validator: validateNoControlChars,
  },
  {
    name: 'SITE_DIST_DIR',
    configKey: 'siteDistDir',
    group: 'ai',
    type: 'string',
    required: false,
    secret: false,
    description: '站点构建产物目录路径（用于加载 tools/tiers.json、concepts.json、lectures.json）；留空时默认使用 ../site/docs/.vitepress/dist',
    example: '../site/docs/.vitepress/dist',
    validator: validateNoControlChars,
  },
  {
    name: 'AI_TOOLS_FILE',
    configKey: 'aiToolsFile',
    group: 'ai',
    type: 'string',
    required: false,
    secret: false,
    description: 'AI 工具与外部 MCP 服务器配置文件路径（ai-tools.json）；留空时优先通过站点 content 路径模块解析',
    example: '../site/ai-tools.json',
    validator: validateNoControlChars,
  },
  {
    name: 'AI_TOOL_TIMEOUT_MS',
    configKey: 'aiToolTimeoutMs',
    group: 'ai',
    type: 'int',
    default: 8000,
    required: false,
    secret: false,
    description: '单次 AI 工具调用（含外部 MCP 工具）超时毫秒数（100–120000）',
    example: '8000',
    validator: makeIntRangeValidator('单次工具调用超时毫秒数', 100, 120000),
  },
  {
    name: 'AI_TOOL_MAX_RESULT_BYTES',
    configKey: 'aiToolMaxResultBytes',
    group: 'ai',
    type: 'int',
    default: 24000,
    required: false,
    secret: false,
    description: '单次 AI 工具返回结果的最大 UTF-8 字节数（256–1048576）',
    example: '24000',
    validator: makeIntRangeValidator('单次工具返回最大字节数', 256, 1048576),
  },
  {
    name: 'AI_TOOL_MAX_STEPS',
    configKey: 'aiToolMaxSteps',
    group: 'ai',
    type: 'int',
    default: 5,
    required: false,
    secret: false,
    description: 'AI_PROVIDER=openai 原生对话每轮允许的最大工具调用步数（1–20）',
    example: '5',
    validator: makeIntRangeValidator('每轮工具调用步数上限', 1, 20),
  },
  {
    name: 'AI_MCP_TOKEN',
    configKey: 'aiMcpToken',
    group: 'ai',
    type: 'string',
    required: false,
    secret: true,
    description: 'Dify 访问 /api/mcp 端点所需的 Bearer 鉴权令牌；留空时 /api/mcp 端点禁用',
    example: 'replace-with-random-mcp-bearer-token',
    validator: validateNoControlChars,
  },
  {
    name: 'AI_MCP_TICKET_SECRET',
    configKey: 'aiMcpTicketSecret',
    group: 'ai',
    type: 'string',
    required: false,
    secret: true,
    description: '签发与校验 Dify tool_ticket 短期访问档票据的 HMAC-SHA256 密钥；未配置或校验失败时按 public 档处理（全站需登录的站点没有 public 档，此时什么也读不到）',
    example: 'replace-with-random-hmac-ticket-secret',
    validator: validateNoControlChars,
  },
  {
    name: 'WRITE_RATE_PER_MINUTE',
    configKey: 'writeRatePerMinute',
    group: 'ops',
    type: 'int',
    default: 120,
    required: false,
    secret: false,
    description: '每用户每分钟允许的写请求数（/api/db/* 与 /api/progress/* 的 POST/PATCH/PUT/DELETE；令牌桶，进程内计数；1–6000）',
    example: '120',
    validator: makeIntRangeValidator('每分钟写请求数', 1, 6000),
  },
] as const

const GROUP_TITLES: Record<SettingGroup, { title: string; summary: string }> = {
  database: {
    title: '数据库配置（Database）',
    summary: 'PostgreSQL / Neon 连接串或本地 PGlite 存储配置',
  },
  server: {
    title: '网络与监听配置（Server）',
    summary: 'HTTP 服务绑定主机地址与监听端口',
  },
  auth: {
    title: '身份与权限配置（Auth）',
    summary: '认证适配器、网关请求头预设、组分隔符与角色映射',
  },
  ai: {
    title: '大模型伴读与代理配置（AI Companion & Proxy）',
    summary: 'AI 提供商选择、API 根路径、API Key、超时、上传尺寸、每用户限流与输入上限',
  },
  ops: {
    title: '运维与安全配置（Ops & Security）',
    summary: '自动迁移门禁、健康检查探测、非回环安全护栏、写请求限流与日志级别',
  },
}

const GROUP_ORDER: readonly SettingGroup[] = ['database', 'server', 'auth', 'ai', 'ops']

export function generateEnvExample(): string {
  const lines: string[] = []

  lines.push('# ═══════════════════════════════════════════════════════════════════════════════')
  lines.push('#  server/.env.example — lecture-api 后端配置模板（由 src/config/schema.ts 生成）')
  lines.push('# ═══════════════════════════════════════════════════════════════════════════════')
  lines.push('#')
  lines.push('#  用法：')
  lines.push('#    1. 复制本文件为 server/.env：   cp .env.example .env')
  lines.push('#    2. 或在 server/ 目录运行配置向导：npm run setup')
  lines.push('#    3. 本文件由 npm run config:gen 生成，可用 npm run config:check 校验一致性')
  lines.push('#')
  lines.push('#  优先级：process.env 环境变量 > server/.env > 网关预设 / 默认值')
  lines.push('#  安全红线：server/.env 已被 .gitignore 忽略，严禁将含真实凭据的 .env 提交到仓库。')
  lines.push('#')
  lines.push('# ═══════════════════════════════════════════════════════════════════════════════')

  for (const group of GROUP_ORDER) {
    const meta = GROUP_TITLES[group]
    lines.push('')
    lines.push('# ─────────────────────────────────────────────────────────────────────────────')
    lines.push(`# ${meta.title} — ${meta.summary}`)
    lines.push('# ─────────────────────────────────────────────────────────────────────────────')

    const specs = CONFIG_SCHEMA.filter((s) => s.group === group)
    for (const s of specs) {
      lines.push('')
      lines.push(`# ${s.description}`)

      const tags: string[] = []
      if (s.secret) tags.push('[秘密]')
      tags.push(s.required ? '[必填]' : '[可选]')
      if (s.values) tags.push(`可选值: ${s.values.join(' | ')}`)
      if (s.default !== undefined && s.default !== '') tags.push(`默认: ${String(s.default)}`)
      lines.push(`# ${tags.join(' ')}`)

      if (s.example !== undefined && (s.secret || s.default === undefined || s.default === '')) {
        lines.push(`# 示例: ${s.example}`)
      }

      let valueStr = ''
      if (!s.secret && s.default !== undefined) {
        valueStr = formatEnvValue(String(s.default))
      }
      lines.push(`${s.name}=${valueStr}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}
