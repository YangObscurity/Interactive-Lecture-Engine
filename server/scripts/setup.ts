import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as readline from 'node:readline/promises'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { parseEnv, updateEnvText } from '../src/config/env.js'
import { isLoopbackHost } from '../src/config/load.js'
import {
  AUTH_HEADER_PRESETS,
  type AuthHeaderPreset,
  generateEnvExample,
  validateDatabaseUrl,
  validateGroupSeparator,
  validateHeaderName,
  validateHost,
  validateHttpUrl,
  validatePort,
  validateRoleMap,
} from '../src/config/schema.js'
import { createDb, redactUrlSecrets, type Db } from '../src/db/index.js'
import { getMigrationStatus, runMigrations } from '../src/db/migrate.js'

export const DEFAULT_ENV_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../.env',
)

export interface SetupCliOptions {
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  envFile?: string
  migrationsDir?: string
  env?: Record<string, string | undefined>
  log?: (msg: string) => void
  error?: (msg: string) => void
  now?: () => Date
}

export interface ServerVersionInfo {
  kind: 'PostgreSQL' | 'PGlite' | string
  version: string
  display: string
  isPooled: boolean
}

function makeEnumValidator(
  values: readonly string[],
  caseInsensitive = false,
): (raw: string) => string | null {
  const allowed = caseInsensitive ? values.map((v) => v.toLowerCase()) : values
  return (raw: string): string | null => {
    const candidate = caseInsensitive ? raw.trim().toLowerCase() : raw.trim()
    if (!allowed.includes(candidate)) {
      return `必须为以下值之一: ${values.join(', ')}`
    }
    return null
  }
}

/**
 * Parses raw SELECT version() output and detects whether the connection is pooled.
 * Emits strictly server kind, version, and pooled note, NEVER host, port, or credentials.
 */
export function parseServerVersion(rawVersion: string, databaseUrl: string): ServerVersionInfo {
  const isPooled = databaseUrl.includes('-pooler') || databaseUrl.includes(':6543')

  const pgliteMatch = /PGlite\s+([\d.]+)/i.exec(rawVersion)
  if (pgliteMatch) {
    return {
      kind: 'PGlite',
      version: pgliteMatch[1]!,
      display: `PGlite ${pgliteMatch[1]}`,
      isPooled: false,
    }
  }

  const pgMatch = /PostgreSQL\s+([\d.]+)/i.exec(rawVersion)
  if (pgMatch) {
    const pooledSuffix = isPooled ? ' (连接池模式 / pooled)' : ' (直连模式 / direct)'
    return {
      kind: 'PostgreSQL',
      version: pgMatch[1]!,
      display: `PostgreSQL ${pgMatch[1]}${pooledSuffix}`,
      isPooled,
    }
  }

  const fallbackMatch = /^([A-Za-z]+)\s+([\d.]+)/.exec(rawVersion)
  const kind = fallbackMatch?.[1] || 'PostgreSQL'
  const version = fallbackMatch?.[2] || 'unknown'
  return {
    kind,
    version,
    display: `${kind} ${version}${isPooled ? ' (连接池模式 / pooled)' : ''}`,
    isPooled,
  }
}

/**
 * Writable stream proxy that drops output chunks when muted = true.
 * Ensures secret inputs typed into readline are never echoed to terminal output.
 */
export class MutableOutput extends Writable {
  muted = false

  constructor(
    private readonly target: NodeJS.WritableStream & {
      isTTY?: boolean
      columns?: number
      rows?: number
    },
  ) {
    super()
  }

  override _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) {
      if (typeof chunk === 'string') {
        this.target.write(chunk, encoding)
      } else if (chunk instanceof Uint8Array) {
        this.target.write(chunk)
      } else {
        this.target.write(String(chunk))
      }
    }
    callback()
  }

  get isTTY(): boolean {
    return Boolean(this.target.isTTY)
  }

  get columns(): number | undefined {
    return this.target.columns
  }

  get rows(): number | undefined {
    return this.target.rows
  }
}

/**
 * Creates a timestamped backup of the target .env file if it exists.
 * Format: .env.bak-<timestamp>
 */
export function backupEnvFile(envPath: string, now: Date = new Date()): string | null {
  if (!existsSync(envPath)) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const backupPath = `${envPath}.bak-${ts}`
  copyFileSync(envPath, backupPath)
  return backupPath
}

async function askQuestion(
  rl: readline.Interface,
  mutableOutput: MutableOutput,
  targetOutput: NodeJS.WritableStream,
  promptText: string,
  isSecret: boolean,
): Promise<string> {
  if (isSecret) {
    targetOutput.write(promptText)
    mutableOutput.muted = true
    const answer = await rl.question('')
    mutableOutput.muted = false
    targetOutput.write('\n')
    return answer
  }
  return await rl.question(promptText)
}

/**
 * Main setup runner function. Exported for testability.
 */
export async function runSetupCli(
  args: string[] = process.argv.slice(2),
  options: SetupCliOptions = {},
): Promise<number> {
  const targetInput = options.stdin ?? process.stdin
  const targetOutput = options.stdout ?? process.stdout
  const targetError = options.stderr ?? process.stderr

  const log = options.log ?? ((msg: string) => targetOutput.write(`${msg}\n`))
  const error = options.error ?? ((msg: string) => targetError.write(`${msg}\n`))

  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args,
      options: {
        yes: { type: 'boolean', short: 'y', default: false },
        'init-db': { type: 'boolean', default: false },
        'no-init-db': { type: 'boolean', default: false },
        env: { type: 'string' },
        'env-file': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    error(`命令行参数解析错误: ${msg}`)
    return 1
  }

  const values = parsed.values as {
    yes?: boolean
    'init-db'?: boolean
    'no-init-db'?: boolean
    env?: string
    'env-file'?: string
    help?: boolean
  }

  if (values.help) {
    log('用法: npm run setup [-- [选项]]')
    log('')
    log('选项:')
    log('  -y, --yes          非交互式运行，使用默认值或环境变量')
    log('  --init-db          非交互式自动初始化数据库表')
    log('  --no-init-db       非交互式跳过数据库表初始化')
    log('  --env <path>       指定 .env 文件路径')
    log('  --env-file <path>  指定 .env 文件路径 (同 --env)')
    log('  -h, --help         显示帮助信息')
    return 0
  }

  if (values['init-db'] && values['no-init-db']) {
    error('不能同时指定 --init-db 与 --no-init-db')
    return 1
  }

  const envFile = resolve(
    options.envFile ?? values.env ?? values['env-file'] ?? DEFAULT_ENV_FILE,
  )
  const isNonInteractive = Boolean(values.yes)

  let existingText = ''
  let existingEnv: Record<string, string> = {}
  if (existsSync(envFile)) {
    existingText = readFileSync(envFile, 'utf8')
    existingEnv = parseEnv(existingText)
  }

  const getEnvVal = (key: string): string | undefined => {
    if (options.env && Object.hasOwn(options.env, key) && options.env[key] !== undefined) {
      return options.env[key]
    }
    if (Object.hasOwn(existingEnv, key) && existingEnv[key] !== undefined) {
      return existingEnv[key]
    }
    if (process.env[key] !== undefined) {
      return process.env[key]
    }
    return undefined
  }

  const updates: Record<string, string> = {}
  const mutableOutput = new MutableOutput(targetOutput)
  const rl = readline.createInterface({
    input: targetInput,
    output: mutableOutput,
    terminal: true,
  })

  try {
    log('=== lecture-api 配置与初始化向导 ===')
    log(`配置文件目标: ${envFile}`)
    if (isNonInteractive) {
      log('运行模式: 非交互模式 (--yes)')
    }
    log('')

    // 1. DATABASE_URL
    let databaseUrl = ''
    if (isNonInteractive) {
      const candidate = getEnvVal('DATABASE_URL')
      if (!candidate) {
        error('DATABASE_URL 为必填项，未在环境变量或已有 .env 中提供')
        return 1
      }
      const valErr = validateDatabaseUrl(candidate)
      if (valErr) {
        error(`DATABASE_URL 配置无效: ${valErr}`)
        return 1
      }
      databaseUrl = candidate.trim()
    } else {
      const current = getEnvVal('DATABASE_URL')
      const prompt = current
        ? '数据库连接串 (DATABASE_URL) [已设置 (回车保持原值)]: '
        : '数据库连接串 (DATABASE_URL，必填): '
      while (true) {
        const raw = await askQuestion(rl, mutableOutput, targetOutput, prompt, true)
        const trimmed = raw.trim()
        const candidate = trimmed || current || ''
        const valErr = validateDatabaseUrl(candidate)
        if (!valErr) {
          databaseUrl = candidate
          break
        }
        error(`输入错误: ${valErr}`)
      }
    }
    updates.DATABASE_URL = databaseUrl

    // 2. DATABASE_URL_DIRECT
    let databaseUrlDirect = ''
    if (isNonInteractive) {
      const candidate = getEnvVal('DATABASE_URL_DIRECT')
      if (candidate && candidate.trim()) {
        const valErr = validateDatabaseUrl(candidate)
        if (valErr) {
          error(`DATABASE_URL_DIRECT 配置无效: ${valErr}`)
          return 1
        }
        databaseUrlDirect = candidate.trim()
      }
    } else {
      const current = getEnvVal('DATABASE_URL_DIRECT')
      const prompt = current
        ? '数据库直连地址 (DATABASE_URL_DIRECT，用于迁移，可选) [已设置 (回车保持原值)]: '
        : '数据库直连地址 (DATABASE_URL_DIRECT，用于迁移，可选，回车留空): '
      while (true) {
        const raw = await askQuestion(rl, mutableOutput, targetOutput, prompt, true)
        const trimmed = raw.trim()
        if (!trimmed) {
          databaseUrlDirect = current || ''
          break
        }
        const valErr = validateDatabaseUrl(trimmed)
        if (!valErr) {
          databaseUrlDirect = trimmed
          break
        }
        error(`输入错误: ${valErr}`)
      }
    }
    if (databaseUrlDirect) {
      updates.DATABASE_URL_DIRECT = databaseUrlDirect
    }

    // 3. HOST
    let host = '127.0.0.1'
    if (isNonInteractive) {
      host = getEnvVal('HOST') ?? '127.0.0.1'
      const valErr = validateHost(host)
      if (valErr) {
        error(`HOST 配置无效: ${valErr}`)
        return 1
      }
    } else {
      const current = getEnvVal('HOST') ?? '127.0.0.1'
      while (true) {
        const raw = await askQuestion(
          rl,
          mutableOutput,
          targetOutput,
          `HTTP 服务监听地址 (HOST) [${current}]: `,
          false,
        )
        const candidate = raw.trim() || current
        const valErr = validateHost(candidate)
        if (!valErr) {
          host = candidate
          break
        }
        error(`输入错误: ${valErr}`)
      }
    }
    updates.HOST = host

    // 4. PORT
    let port = '8100'
    if (isNonInteractive) {
      port = getEnvVal('PORT') ?? '8100'
      const valErr = validatePort(port)
      if (valErr) {
        error(`PORT 配置无效: ${valErr}`)
        return 1
      }
    } else {
      const current = getEnvVal('PORT') ?? '8100'
      while (true) {
        const raw = await askQuestion(
          rl,
          mutableOutput,
          targetOutput,
          `HTTP 服务监听端口 (PORT) [${current}]: `,
          false,
        )
        const candidate = raw.trim() || current
        const valErr = validatePort(candidate)
        if (!valErr) {
          port = candidate
          break
        }
        error(`输入错误: ${valErr}`)
      }
    }
    updates.PORT = port

    // 5. AUTH_ADAPTER
    let authAdapter = 'none'
    const validateAuthAdapter = makeEnumValidator(['none', 'trusted-header'])
    if (isNonInteractive) {
      authAdapter = getEnvVal('AUTH_ADAPTER') ?? 'none'
      const valErr = validateAuthAdapter(authAdapter)
      if (valErr) {
        error(`AUTH_ADAPTER 配置无效: ${valErr}`)
        return 1
      }
    } else {
      const current = getEnvVal('AUTH_ADAPTER') ?? 'none'
      while (true) {
        const raw = await askQuestion(
          rl,
          mutableOutput,
          targetOutput,
          `身份认证适配器 (AUTH_ADAPTER: none / trusted-header) [${current}]: `,
          false,
        )
        const candidate = raw.trim() || current
        const valErr = validateAuthAdapter(candidate)
        if (!valErr) {
          authAdapter = candidate
          break
        }
        error(`输入错误: ${valErr}`)
      }
    }
    updates.AUTH_ADAPTER = authAdapter

    // 6. Trusted-header options
    let allowNonLoopback = getEnvVal('ALLOW_NON_LOOPBACK') ?? 'false'
    if (authAdapter === 'trusted-header') {
      let preset = 'authelia'
      const validatePreset = makeEnumValidator(['authelia', 'authentik', 'oauth2-proxy', 'custom'])
      if (isNonInteractive) {
        preset = getEnvVal('AUTH_HEADER_PRESET') ?? 'authelia'
        const valErr = validatePreset(preset)
        if (valErr) {
          error(`AUTH_HEADER_PRESET 配置无效: ${valErr}`)
          return 1
        }
      } else {
        const current = getEnvVal('AUTH_HEADER_PRESET') ?? 'authelia'
        while (true) {
          const raw = await askQuestion(
            rl,
            mutableOutput,
            targetOutput,
            `认证网关请求头预设 (AUTH_HEADER_PRESET: authelia / authentik / oauth2-proxy / custom) [${current}]: `,
            false,
          )
          const candidate = raw.trim() || current
          const valErr = validatePreset(candidate)
          if (!valErr) {
            preset = candidate
            break
          }
          error(`输入错误: ${valErr}`)
        }
      }
      updates.AUTH_HEADER_PRESET = preset

      const presetConfig = AUTH_HEADER_PRESETS[preset as AuthHeaderPreset]
      let customizeHeaders = preset === 'custom'
      if (!isNonInteractive && preset !== 'custom') {
        const askCustom = await askQuestion(
          rl,
          mutableOutput,
          targetOutput,
          `是否自定义网关请求头名称？[y/N] (默认: N): `,
          false,
        )
        customizeHeaders = askCustom.trim().toLowerCase() === 'y'
      }

      if (customizeHeaders) {
        // AUTH_HEADER_USER
        const defaultUser = getEnvVal('AUTH_HEADER_USER') ?? presetConfig?.user ?? 'Remote-User'
        while (true) {
          const raw = await askQuestion(
            rl,
            mutableOutput,
            targetOutput,
            `用户 ID 请求头名 (AUTH_HEADER_USER) [${defaultUser}]: `,
            false,
          )
          const candidate = raw.trim() || defaultUser
          const valErr = validateHeaderName(candidate)
          if (!valErr) {
            updates.AUTH_HEADER_USER = candidate
            break
          }
          error(`输入错误: ${valErr}`)
        }

        // AUTH_HEADER_GROUPS
        const defaultGroups = getEnvVal('AUTH_HEADER_GROUPS') ?? presetConfig?.groups ?? 'Remote-Groups'
        while (true) {
          const raw = await askQuestion(
            rl,
            mutableOutput,
            targetOutput,
            `用户组请求头名 (AUTH_HEADER_GROUPS) [${defaultGroups}]: `,
            false,
          )
          const candidate = raw.trim() || defaultGroups
          const valErr = validateHeaderName(candidate)
          if (!valErr) {
            updates.AUTH_HEADER_GROUPS = candidate
            break
          }
          error(`输入错误: ${valErr}`)
        }

        // AUTH_HEADER_EMAIL
        const defaultEmail = getEnvVal('AUTH_HEADER_EMAIL') ?? presetConfig?.email ?? 'Remote-Email'
        while (true) {
          const raw = await askQuestion(
            rl,
            mutableOutput,
            targetOutput,
            `用户邮箱请求头名 (AUTH_HEADER_EMAIL) [${defaultEmail}]: `,
            false,
          )
          const candidate = raw.trim() || defaultEmail
          const valErr = validateHeaderName(candidate)
          if (!valErr) {
            updates.AUTH_HEADER_EMAIL = candidate
            break
          }
          error(`输入错误: ${valErr}`)
        }

        // AUTH_HEADER_NAME
        const defaultName = getEnvVal('AUTH_HEADER_NAME') ?? presetConfig?.name ?? 'Remote-Name'
        while (true) {
          const raw = await askQuestion(
            rl,
            mutableOutput,
            targetOutput,
            `用户显示名请求头名 (AUTH_HEADER_NAME) [${defaultName}]: `,
            false,
          )
          const candidate = raw.trim() || defaultName
          const valErr = validateHeaderName(candidate)
          if (!valErr) {
            updates.AUTH_HEADER_NAME = candidate
            break
          }
          error(`输入错误: ${valErr}`)
        }

        // AUTH_GROUP_SEPARATOR
        const defaultSep = getEnvVal('AUTH_GROUP_SEPARATOR') ?? presetConfig?.groupSeparator ?? ','
        while (true) {
          const raw = await askQuestion(
            rl,
            mutableOutput,
            targetOutput,
            `用户组分隔符 (AUTH_GROUP_SEPARATOR) [${defaultSep}]: `,
            false,
          )
          const candidate = raw !== '' ? raw : defaultSep
          const valErr = validateGroupSeparator(candidate)
          if (!valErr) {
            updates.AUTH_GROUP_SEPARATOR = candidate
            break
          }
          error(`输入错误: ${valErr}`)
        }
      }

      // LOGOUT_URL
      let logoutUrl = getEnvVal('LOGOUT_URL') ?? ''
      if (!isNonInteractive) {
        while (true) {
          const raw = await askQuestion(
            rl,
            mutableOutput,
            targetOutput,
            `认证网关登出跳转地址 (LOGOUT_URL，可选) [${logoutUrl}]: `,
            false,
          )
          const candidate = raw.trim() || logoutUrl
          if (!candidate) {
            logoutUrl = ''
            break
          }
          const valErr = validateHttpUrl(candidate)
          if (!valErr) {
            logoutUrl = candidate
            break
          }
          error(`输入错误: ${valErr}`)
        }
      }
      if (logoutUrl) {
        updates.LOGOUT_URL = logoutUrl
      }

      // Loopback check
      if (!isLoopbackHost(host)) {
        log(`警告: 检测到配置了非回环 HOST (${host}) 且启用了 trusted-header 认证。`)
        log('依据安全规范，只有在确保上游反向代理覆盖了身份头时才应开启 ALLOW_NON_LOOPBACK。')
        if (isNonInteractive) {
          allowNonLoopback = getEnvVal('ALLOW_NON_LOOPBACK') ?? 'false'
        } else {
          const ans = await askQuestion(
            rl,
            mutableOutput,
            targetOutput,
            `是否允许绑定非回环地址 (ALLOW_NON_LOOPBACK)？[y/N] (默认: N): `,
            false,
          )
          allowNonLoopback = ans.trim().toLowerCase() === 'y' ? 'true' : 'false'
        }
      }
    }
    updates.ALLOW_NON_LOOPBACK = allowNonLoopback

    // AUTH_ROLE_MAP (prompt if trusted-header, or preserve if provided)
    let roleMap = getEnvVal('AUTH_ROLE_MAP') ?? ''
    if (authAdapter === 'trusted-header' && !isNonInteractive) {
      while (true) {
        const raw = await askQuestion(
          rl,
          mutableOutput,
          targetOutput,
          `用户组到角色映射 (AUTH_ROLE_MAP，如 admins:admin,authors:author，可选) [${roleMap}]: `,
          false,
        )
        const candidate = raw.trim() || roleMap
        const valErr = validateRoleMap(candidate)
        if (!valErr) {
          roleMap = candidate
          break
        }
        error(`输入错误: ${valErr}`)
      }
    }
    if (roleMap) {
      updates.AUTH_ROLE_MAP = roleMap
    }

    // 7. NOTION_HEALTH_URL
    let notionHealthUrl = getEnvVal('NOTION_HEALTH_URL') ?? ''
    if (!isNonInteractive) {
      while (true) {
        const raw = await askQuestion(
          rl,
          mutableOutput,
          targetOutput,
          `Notion 伴随服务健康检查地址 (NOTION_HEALTH_URL，可选) [${notionHealthUrl}]: `,
          false,
        )
        const candidate = raw.trim() || notionHealthUrl
        if (!candidate) {
          notionHealthUrl = ''
          break
        }
        const valErr = validateHttpUrl(candidate)
        if (!valErr) {
          notionHealthUrl = candidate
          break
        }
        error(`输入错误: ${valErr}`)
      }
    }
    if (notionHealthUrl) {
      updates.NOTION_HEALTH_URL = notionHealthUrl
    }

    // 8. LOG_LEVEL
    let logLevel = 'info'
    const validateLogLevel = makeEnumValidator(['debug', 'info', 'warn', 'error'], true)
    if (isNonInteractive) {
      logLevel = getEnvVal('LOG_LEVEL') ?? 'info'
      const valErr = validateLogLevel(logLevel)
      if (valErr) {
        error(`LOG_LEVEL 配置无效: ${valErr}`)
        return 1
      }
    } else {
      const current = getEnvVal('LOG_LEVEL') ?? 'info'
      while (true) {
        const raw = await askQuestion(
          rl,
          mutableOutput,
          targetOutput,
          `服务日志级别 (LOG_LEVEL: debug / info / warn / error) [${current}]: `,
          false,
        )
        const candidate = raw.trim() || current
        const valErr = validateLogLevel(candidate)
        if (!valErr) {
          logLevel = candidate
          break
        }
        error(`输入错误: ${valErr}`)
      }
    }
    updates.LOG_LEVEL = logLevel

    // 9. Test database connection
    log('')
    log('正在测试数据库连接...')
    let testDb: Db | null = null
    try {
      testDb = createDb(databaseUrl)
      const res = await testDb.query<{ version: string }>('SELECT version();')
      const rawVersion = res.rows[0]?.version || ''
      const versionInfo = parseServerVersion(rawVersion, databaseUrl)
      log(`数据库连接成功: ${versionInfo.display}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      error(`数据库连接失败: ${redactUrlSecrets(msg, databaseUrl)}`)
      if (testDb) {
        await testDb.close().catch(() => {})
      }
      return 1
    }

    // 10. Check pending migrations & prompt table initialization
    let migrationDb = testDb
    let directDbCreated = false
    if (databaseUrlDirect && databaseUrlDirect !== databaseUrl) {
      try {
        migrationDb = createDb(databaseUrlDirect)
        directDbCreated = true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        error(`直连数据库连接失败: ${redactUrlSecrets(msg, databaseUrlDirect)}`)
        await testDb.close().catch(() => {})
        return 1
      }
    }

    try {
      const status = await getMigrationStatus(migrationDb, {
        migrationsDir: options.migrationsDir,
      })

      if (status.pending.length === 0) {
        log('数据库表结构已是最新状态，无待执行迁移。')
      } else {
        log(`发现 ${status.pending.length} 个待执行迁移:`)
        for (const m of status.pending) {
          log(`  - v${m.version}: ${m.filename}`)
        }

        let shouldInit = false
        if (values['init-db']) {
          shouldInit = true
        } else if (values['no-init-db'] || isNonInteractive) {
          shouldInit = false
        } else {
          const ans = await askQuestion(
            rl,
            mutableOutput,
            targetOutput,
            '现在初始化数据库表吗？[y/N]: ',
            false,
          )
          shouldInit = ans.trim().toLowerCase() === 'y'
        }

        if (shouldInit) {
          await runMigrations(migrationDb, {
            migrationsDir: options.migrationsDir,
            log: (m) => log(`  ${m}`),
          })
          log('已成功初始化数据库表。')
        } else {
          log('跳过数据库初始化。您可以稍后运行以下命令初始化数据库:\n  npm run db:migrate')
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      let scrubbed = msg
      for (const s of [databaseUrl, databaseUrlDirect].filter(Boolean)) {
        scrubbed = redactUrlSecrets(scrubbed, s)
      }
      error(`数据库迁移检查/执行失败: ${scrubbed}`)
      return 1
    } finally {
      if (directDbCreated && migrationDb) {
        await migrationDb.close().catch(() => {})
      }
      if (testDb) {
        await testDb.close().catch(() => {})
      }
    }

    // 11. DB_AUTO_MIGRATE prompt
    let dbAutoMigrateVal = 'false'
    if (isNonInteractive) {
      dbAutoMigrateVal = getEnvVal('DB_AUTO_MIGRATE') ?? 'false'
    } else {
      const current = getEnvVal('DB_AUTO_MIGRATE') ?? 'false'
      const ans = await askQuestion(
        rl,
        mutableOutput,
        targetOutput,
        `服务启动时是否自动执行待处理迁移 (DB_AUTO_MIGRATE)？[y/N] (默认: ${current === 'true' ? 'Y' : 'N'}): `,
        false,
      )
      const trimmed = ans.trim().toLowerCase()
      if (trimmed === 'y') {
        dbAutoMigrateVal = 'true'
      } else if (trimmed === 'n') {
        dbAutoMigrateVal = 'false'
      } else {
        dbAutoMigrateVal = current
      }
    }
    updates.DB_AUTO_MIGRATE = dbAutoMigrateVal

    // 12. Write .env & create backup if existing
    const now = options.now ? options.now() : new Date()
    if (existsSync(envFile)) {
      const backupPath = backupEnvFile(envFile, now)
      if (backupPath) {
        log(`已备份现有配置至: ${backupPath}`)
      }
      const newText = updateEnvText(existingText, updates)
      writeFileSync(envFile, newText, 'utf8')
    } else {
      const template = generateEnvExample()
      const newText = updateEnvText(template, updates)
      writeFileSync(envFile, newText, 'utf8')
    }

    log('')
    log(`配置已成功保存至: ${envFile}`)
    log('环境配置向导已完成。您可运行 npm run dev 或 npm start 启动服务。')
    return 0
  } finally {
    rl.close()
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  void runSetupCli().then((code) => {
    if (code !== 0) {
      process.exit(code)
    }
  })
}
