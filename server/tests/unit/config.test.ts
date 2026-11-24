import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatEnvValue, parseEnv, updateEnvText } from '../../src/config/env.js'
import {
  ConfigError,
  formatConfigSummary,
  isLoopbackHost,
  loadConfig,
  redactSecret,
} from '../../src/config/load.js'
import {
  AUTH_HEADER_PRESETS,
  CONFIG_SCHEMA,
  generateEnvExample,
  parseRoleMap,
  validateHost,
  validateHttpUrl,
} from '../../src/config/schema.js'
import { runConfigCli } from '../../scripts/config.js'
import { main as indexMain } from '../../src/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = resolve(__dirname, '../..')

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lecture-api-config-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('CONFIG_SCHEMA invariants', () => {
  it('defines all 51 settings with unique names, Chinese descriptions, and safe secret defaults', () => {
    expect(CONFIG_SCHEMA).toHaveLength(51)

    const names = new Set(CONFIG_SCHEMA.map((s) => s.name))
    const configKeys = new Set(CONFIG_SCHEMA.map((s) => s.configKey))
    expect(names.size).toBe(51)
    expect(configKeys.size).toBe(51)

    for (const spec of CONFIG_SCHEMA) {
      expect(spec.description.length).toBeGreaterThan(0)
      expect(typeof spec.validator).toBe('function')
      if (spec.secret) {
        expect(spec.default).toBeUndefined()
      }
      if (spec.type === 'enum') {
        expect(spec.values).toBeDefined()
        expect(spec.values).toContain(String(spec.default))
      }
    }
  })

  it('defines exact gateway header presets matching API_CONTRACT.md', () => {
    expect(AUTH_HEADER_PRESETS.authelia).toEqual({
      user: 'Remote-User',
      groups: 'Remote-Groups',
      email: 'Remote-Email',
      name: 'Remote-Name',
      groupSeparator: ',',
    })
    expect(AUTH_HEADER_PRESETS.authentik).toEqual({
      user: 'X-authentik-username',
      groups: 'X-authentik-groups',
      email: 'X-authentik-email',
      name: 'X-authentik-name',
      groupSeparator: '|',
    })
    expect(AUTH_HEADER_PRESETS['oauth2-proxy']).toEqual({
      user: 'X-Forwarded-User',
      groups: 'X-Forwarded-Groups',
      email: 'X-Forwarded-Email',
      name: 'X-Forwarded-Preferred-Username',
      groupSeparator: ',',
    })
    expect(AUTH_HEADER_PRESETS.custom).toEqual({
      user: null,
      groups: null,
      email: null,
      name: null,
      groupSeparator: ',',
    })
  })
})

describe('parseEnv, formatEnvValue, and updateEnvText', () => {
  it('handles BOM, CRLF/LF, export prefix, Windows paths, and unquoted/quoted # comments', () => {
    const raw = [
      '\ufeff# comment',
      '',
      'export HOST=127.0.0.1',
      'PLAIN_COMMENT=bar # inline comment',
      'QUOTED_HASH="val #notcomment"',
      'QUOTED_WITH_TRAILING="a" # trailing comment',
      "SINGLE_WITH_TRAILING='b' # \"quoted\" comment",
      'EMPTY_QUOTED="" # comment',
      'WIN_PATH=C:\\Users\\me\\data',
      'EMPTY=',
    ].join('\r\n')

    const parsed = parseEnv(raw)
    expect(parsed).toEqual({
      HOST: '127.0.0.1',
      PLAIN_COMMENT: 'bar',
      QUOTED_HASH: 'val #notcomment',
      QUOTED_WITH_TRAILING: 'a',
      SINGLE_WITH_TRAILING: 'b',
      EMPTY_QUOTED: '',
      WIN_PATH: 'C:\\Users\\me\\data',
      EMPTY: '',
    })
  })

  it('parses multiline quoted values including trailing comment on closing line', () => {
    const raw = 'PEM="line1\nline2" # done\nNEXT=ok\n'
    const parsed = parseEnv(raw)
    expect(parsed.PEM).toBe('line1\nline2')
    expect(parsed.NEXT).toBe('ok')
  })

  it('throws ConfigError naming key without leaking secret value on unclosed quote at EOF', () => {
    const secret = 'SENTINEL_UNCLOSED_SECRET_42'
    const raw = `HOST=127.0.0.1\nDATABASE_URL="postgres://u:${secret}@host/db\n`

    let caught: unknown
    try {
      parseEnv(raw)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ConfigError)
    const err = caught as ConfigError
    expect(err.message).toContain('DATABASE_URL')
    expect(err.message).not.toContain(secret)
    expect(err.invalidKeys).toContain('DATABASE_URL')
  })

  it('rejects unexpected trailing characters after a closing quote without leaking value', () => {
    expect(() => parseEnv('DATABASE_URL="abc" extra')).toThrow(ConfigError)
    expect(() => parseEnv('DATABASE_URL="abc" extra')).toThrow(/DATABASE_URL/)
  })

  it('preserves CRLF vs LF, comments, and round-trips tricky values in updateEnvText', () => {
    const before = '# 注释\r\nHOST=127.0.0.1\r\nKEEP=stay # note\r\n'
    const after = updateEnvText(before, { HOST: 'localhost' })
    expect(after).toBe('# 注释\r\nHOST=localhost\r\nKEEP=stay # note\r\n')

    const trickyValues = [
      'abc',
      String.raw`C:\Users\me\data\pg`,
      String.raw`C:\My #1\key`,
      '  padded  ',
      '"quoted',
      "'quoted",
      'say "hi" #x',
      `it's "both"`,
      'line1\nline2',
    ]

    for (const val of trickyValues) {
      const updated = updateEnvText('# head\n', { TEST_KEY: val })
      expect(parseEnv(updated).TEST_KEY).toBe(val)
    }

    expect(() => formatEnvValue(`"it's" #x`)).toThrow(ConfigError)
  })

  it('parses empty unquoted values followed by inline # comments while preserving leading # literals', () => {
    const parsed = parseEnv(
      [
        'FOO= #comment',
        'BAR=  # note',
        'BAZ=\t# tab note',
        'QUX=bar # note',
        'LIT=#literal',
        'MID=a#b',
      ].join('\n'),
    )
    expect(parsed).toEqual({
      FOO: '',
      BAR: '',
      BAZ: '',
      QUX: 'bar',
      LIT: '#literal',
      MID: 'a#b',
    })

    const dir = makeTempDir()
    const envPath = join(dir, '.env')
    writeFileSync(
      envPath,
      'DATABASE_URL=pglite:memory\nPORT= # use default\nLOGOUT_URL= # optional\n',
      'utf8',
    )
    const cfg = loadConfig({ env: {}, envFile: envPath })
    expect(cfg.port).toBe(8100)
    expect(cfg.logoutUrl).toBeNull()
  })

  it('preserves untouched multiline quoted values containing KEY=val lines in updateEnvText', () => {
    const original = 'NOTE="first line\nHOST=fake\nlast line"\nPORT=8100\n'
    const updated = updateEnvText(original, { HOST: '127.0.0.1' })
    expect(updated).toBe(
      'NOTE="first line\nHOST=fake\nlast line"\nPORT=8100\n\nHOST=127.0.0.1\n',
    )
    expect(parseEnv(updated)).toEqual({
      NOTE: 'first line\nHOST=fake\nlast line',
      PORT: '8100',
      HOST: '127.0.0.1',
    })

    const singleQuoted = "CERT='line1\nPORT=9999\nline3'\nHOST=127.0.0.1\n"
    const updatedSingle = updateEnvText(singleQuoted, { PORT: '8100' })
    expect(parseEnv(updatedSingle)).toEqual({
      CERT: 'line1\nPORT=9999\nline3',
      HOST: '127.0.0.1',
      PORT: '8100',
    })
  })

  it('rejects carriage return (\\r) in formatEnvValue with ConfigError without leaking secrets', () => {
    const secret = 'SENTINEL_CR_SECRET_77'
    for (const bad of [`line1\r\n${secret}`, `pre\r${secret}`]) {
      let caught: unknown
      try {
        formatEnvValue(bad)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(ConfigError)
      const err = caught as ConfigError
      expect(err.message).not.toContain(secret)
      expect(err.stack).not.toContain(secret)
    }
  })
})

describe('loadConfig defaults, precedence, and validation', () => {
  it('1. resolves minimal defaults when only DATABASE_URL=pglite:memory is set', () => {
    const cfg = loadConfig({ DATABASE_URL: 'pglite:memory' })
    expect(cfg).toEqual({
      databaseUrl: 'pglite:memory',
      databaseUrlDirect: null,
      host: '127.0.0.1',
      port: 8100,
      authAdapter: 'none',
      authHeaderPreset: 'authelia',
      authHeaderUser: 'Remote-User',
      authHeaderGroups: 'Remote-Groups',
      authHeaderEmail: 'Remote-Email',
      authHeaderName: 'Remote-Name',
      authGroupSeparator: ',',
      authRoleMap: {},
      logoutUrl: null,
      authCookieName: 'lec_session',
      authCookieSecure: 'auto',
      sessionTtlHours: 12,
      rememberMeDays: 30,
      authMethodsEnabled: 'password,passkey,gateway',
      webauthnRpId: '',
      webauthnRpName: 'Interactive Lecture Engine',
      webauthnOrigin: '',
      authBootstrapToken: null,
      dbAutoMigrate: false,
      notionHealthUrl: null,
      allowNonLoopback: false,
      logLevel: 'info',
      aiProvider: 'off',
      difyApiBase: 'https://api.dify.ai/v1',
      difyApiKey: null,
      openaiApiBase: 'https://api.openai.com/v1',
      openaiApiKey: null,
      openaiModel: 'gpt-4o-mini',
      aiUpstreamTimeoutMs: 60000,
      aiUploadMaxBytes: 20971520,
      aiAllowAnonymous: false,
      aiRatePerMinute: 20,
      aiMaxConcurrent: 2,
      aiDailyLimit: 300,
      writeRatePerMinute: 120,
      aiQueryMaxBytes: 8192,
      aiInputsMaxBytes: 32768,
      aiStreamMaxMs: 300000,
      aiAccessLog: true,
      aiPromptsFile: null,
      siteDistDir: null,
      aiToolsFile: null,
      aiToolTimeoutMs: 8000,
      aiToolMaxResultBytes: 24000,
      aiToolMaxSteps: 5,
      aiMcpToken: null,
      aiMcpTicketSecret: null,
    })
  })

  it('2. throws ConfigError naming DATABASE_URL when missing, empty, or whitespace', () => {
    for (const env of [{}, { DATABASE_URL: '' }, { DATABASE_URL: '   ' }]) {
      expect(() => loadConfig(env)).toThrow(ConfigError)
      expect(() => loadConfig(env)).toThrow(/DATABASE_URL/)
    }
  })

  it('3-4. redacts DATABASE_URL and DATABASE_URL_DIRECT in ConfigError and formatConfigSummary', () => {
    const sentinel = 'SENTINEL_SECRET_99'
    const badPrimary = `mysql://user:${sentinel}@host/db`

    let errPrimary: ConfigError | undefined
    try {
      loadConfig({ DATABASE_URL: badPrimary })
    } catch (e) {
      errPrimary = e as ConfigError
    }
    expect(errPrimary).toBeInstanceOf(ConfigError)
    expect(errPrimary?.message).toContain('DATABASE_URL')
    expect(errPrimary?.message).toContain(`set (length ${badPrimary.length})`)
    expect(errPrimary?.message).not.toContain(sentinel)
    expect(errPrimary?.stack).not.toContain(sentinel)

    const directSentinel = 'SENTINEL_DIRECT_88'
    const badDirect = `bad://${directSentinel}`
    let errDirect: ConfigError | undefined
    try {
      loadConfig({ DATABASE_URL: 'pglite:memory', DATABASE_URL_DIRECT: badDirect })
    } catch (e) {
      errDirect = e as ConfigError
    }
    expect(errDirect).toBeInstanceOf(ConfigError)
    expect(errDirect?.message).toContain('DATABASE_URL_DIRECT')
    expect(errDirect?.message).toContain(`set (length ${badDirect.length})`)
    expect(errDirect?.message).not.toContain(directSentinel)

    const validUrl = `postgresql://user:${sentinel}@ep-pooler.neon.tech/db?sslmode=require`
    const validDirect = `postgresql://user:${directSentinel}@ep-direct.neon.tech/db?sslmode=require`
    const cfg = loadConfig({ DATABASE_URL: validUrl, DATABASE_URL_DIRECT: validDirect })
    const summary = formatConfigSummary(cfg)
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain(sentinel)
    expect(serialized).not.toContain(directSentinel)
    expect(summary.DATABASE_URL).toBe(`set (length ${validUrl.length})`)
    expect(summary.DATABASE_URL_DIRECT).toBe(`set (length ${validDirect.length})`)

    const cfgNoDirect = loadConfig({ DATABASE_URL: 'pglite:memory' })
    expect(formatConfigSummary(cfgNoDirect).DATABASE_URL_DIRECT).toBe('unset')
    expect(redactSecret(null)).toBe('unset')
    expect(redactSecret('')).toBe('unset')
    expect(redactSecret('abc')).toBe('set (length 3)')
  })

  it('5. accepts valid DATABASE_URL schemes and rejects empty pglite: paths', () => {
    for (const valid of [
      'pglite:memory',
      'pglite:./tmp/pg',
      'pglite:C:\\temp\\pg',
      'postgres://u:p@h/db',
      'postgresql://u:p@ep-pooler.neon.tech/db?sslmode=require',
    ]) {
      expect(loadConfig({ DATABASE_URL: valid }).databaseUrl).toBe(valid)
    }

    for (const invalid of ['pglite:', 'pglite:   ', 'postgres:///db']) {
      expect(() => loadConfig({ DATABASE_URL: invalid })).toThrow(/DATABASE_URL/)
    }
  })

  it('6. enforces PORT integer boundaries 1..65535', () => {
    expect(loadConfig({ DATABASE_URL: 'pglite:memory', PORT: '1' }).port).toBe(1)
    expect(loadConfig({ DATABASE_URL: 'pglite:memory', PORT: '65535' }).port).toBe(65535)

    for (const badPort of ['0', '-1', '65536', '8100.5', '8100abc', 'abc']) {
      expect(() => loadConfig({ DATABASE_URL: 'pglite:memory', PORT: badPort })).toThrow(/PORT/)
    }
  })

  it('7-10. enforces non-loopback HOST guard under trusted-header only unless ALLOW_NON_LOOPBACK=true', () => {
    // AUTH_ADAPTER=none permits 0.0.0.0
    expect(
      loadConfig({
        DATABASE_URL: 'pglite:memory',
        AUTH_ADAPTER: 'none',
        HOST: '0.0.0.0',
        ALLOW_NON_LOOPBACK: 'false',
      }).host,
    ).toBe('0.0.0.0')

    // Loopback hosts permitted under trusted-header
    for (const h of [
      '127.0.0.1',
      '127.0.0.2',
      '127.255.0.1',
      'localhost',
      'LOCALHOST',
      '::1',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
    ]) {
      const cfg = loadConfig({
        DATABASE_URL: 'pglite:memory',
        AUTH_ADAPTER: 'trusted-header',
        HOST: h,
      })
      expect(isLoopbackHost(cfg.host)).toBe(true)
    }
    expect(
      loadConfig({
        DATABASE_URL: 'pglite:memory',
        AUTH_ADAPTER: 'trusted-header',
        HOST: '[::1]',
      }).host,
    ).toBe('::1')

    // Non-loopback hosts blocked under trusted-header without ALLOW_NON_LOOPBACK=true
    for (const h of [
      '0.0.0.0',
      '::',
      '[::]',
      '192.168.1.50',
      '10.0.0.1',
      '128.0.0.1',
      '127.0.0.999',
      'api.example.com',
      'localhost.localdomain',
      '::ffff:192.168.1.1',
    ]) {
      expect(isLoopbackHost(h)).toBe(false)
      expect(() =>
        loadConfig({
          DATABASE_URL: 'pglite:memory',
          AUTH_ADAPTER: 'trusted-header',
          HOST: h,
          ALLOW_NON_LOOPBACK: 'false',
        }),
      ).toThrow(/HOST.*ALLOW_NON_LOOPBACK|ALLOW_NON_LOOPBACK/s)
    }

    // Allowed when ALLOW_NON_LOOPBACK=true
    const allowed = loadConfig({
      DATABASE_URL: 'pglite:memory',
      AUTH_ADAPTER: 'trusted-header',
      HOST: '0.0.0.0',
      ALLOW_NON_LOOPBACK: 'true',
    })
    expect(allowed.host).toBe('0.0.0.0')
    expect(allowed.allowNonLoopback).toBe(true)
  })

  it('11-15. resolves auth presets, partial overrides, custom preset guard, and header validation', () => {
    const authentik = loadConfig({
      DATABASE_URL: 'pglite:memory',
      AUTH_HEADER_PRESET: 'authentik',
    })
    expect(authentik.authHeaderUser).toBe('X-authentik-username')
    expect(authentik.authHeaderGroups).toBe('X-authentik-groups')
    expect(authentik.authHeaderEmail).toBe('X-authentik-email')
    expect(authentik.authHeaderName).toBe('X-authentik-name')
    expect(authentik.authGroupSeparator).toBe('|')

    const oauth2 = loadConfig({
      DATABASE_URL: 'pglite:memory',
      AUTH_HEADER_PRESET: 'oauth2-proxy',
    })
    expect(oauth2.authHeaderName).toBe('X-Forwarded-Preferred-Username')
    expect(oauth2.authGroupSeparator).toBe(',')

    const partial = loadConfig({
      DATABASE_URL: 'pglite:memory',
      AUTH_HEADER_PRESET: 'authentik',
      AUTH_GROUP_SEPARATOR: ',',
      AUTH_HEADER_EMAIL: 'X-Mail',
    })
    expect(partial.authHeaderUser).toBe('X-authentik-username')
    expect(partial.authHeaderEmail).toBe('X-Mail')
    expect(partial.authGroupSeparator).toBe(',')

    // custom without AUTH_HEADER_USER under trusted-header fails
    expect(() =>
      loadConfig({
        DATABASE_URL: 'pglite:memory',
        AUTH_ADAPTER: 'trusted-header',
        AUTH_HEADER_PRESET: 'custom',
      }),
    ).toThrow(/AUTH_HEADER_USER/)

    // custom minimal valid
    const customMin = loadConfig({
      DATABASE_URL: 'pglite:memory',
      AUTH_ADAPTER: 'trusted-header',
      AUTH_HEADER_PRESET: 'custom',
      AUTH_HEADER_USER: 'X-User',
    })
    expect(customMin.authHeaderUser).toBe('X-User')
    expect(customMin.authHeaderGroups).toBeNull()
    expect(customMin.authHeaderEmail).toBeNull()
    expect(customMin.authHeaderName).toBeNull()
    expect(customMin.authGroupSeparator).toBe(',')

    // space group separator is preserved
    const spaceSep = loadConfig({
      DATABASE_URL: 'pglite:memory',
      AUTH_GROUP_SEPARATOR: ' ',
    })
    expect(spaceSep.authGroupSeparator).toBe(' ')

    // invalid header names
    for (const badHeader of ['Bad Header', 'Remote:User', 'X\nUser']) {
      expect(() =>
        loadConfig({
          DATABASE_URL: 'pglite:memory',
          AUTH_HEADER_USER: badHeader,
        }),
      ).toThrow(/AUTH_HEADER_USER/)
    }
  })

  it('16. parses AUTH_ROLE_MAP and rejects malformed mappings', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'pglite:memory',
      AUTH_ROLE_MAP: ' admins:admin , authors:author , admins:author , admins:admin ',
    })
    expect(cfg.authRoleMap).toEqual({
      admins: ['admin', 'author'],
      authors: ['author'],
    })
    expect(formatConfigSummary(cfg).AUTH_ROLE_MAP).toBe('admins:admin,admins:author,authors:author')

    for (const badMap of [
      'admins',
      ':admin',
      'admins:',
      'admins:superadmin',
      'a:admin,,b:author',
      'a:b:admin',
    ]) {
      expect(() =>
        loadConfig({ DATABASE_URL: 'pglite:memory', AUTH_ROLE_MAP: badMap }),
      ).toThrow(/AUTH_ROLE_MAP/)
    }
  })

  it('17-18. validates booleans, LOG_LEVEL, and HTTP/HTTPS URLs', () => {
    for (const truthy of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(
        loadConfig({ DATABASE_URL: 'pglite:memory', DB_AUTO_MIGRATE: truthy }).dbAutoMigrate,
      ).toBe(true)
    }
    for (const falsy of ['false', 'FALSE', '0', 'no', 'off']) {
      expect(
        loadConfig({ DATABASE_URL: 'pglite:memory', ALLOW_NON_LOOPBACK: falsy }).allowNonLoopback,
      ).toBe(false)
    }
    for (const badBool of ['maybe', '2']) {
      expect(() =>
        loadConfig({ DATABASE_URL: 'pglite:memory', DB_AUTO_MIGRATE: badBool }),
      ).toThrow(/DB_AUTO_MIGRATE/)
      expect(() =>
        loadConfig({ DATABASE_URL: 'pglite:memory', ALLOW_NON_LOOPBACK: badBool }),
      ).toThrow(/ALLOW_NON_LOOPBACK/)
    }

    expect(loadConfig({ DATABASE_URL: 'pglite:memory', LOG_LEVEL: 'DEBUG' }).logLevel).toBe('debug')
    expect(() =>
      loadConfig({ DATABASE_URL: 'pglite:memory', LOG_LEVEL: 'verbose' }),
    ).toThrow(/LOG_LEVEL/)

    const withUrls = loadConfig({
      DATABASE_URL: 'pglite:memory',
      LOGOUT_URL: 'https://auth.example.com/logout',
      NOTION_HEALTH_URL: 'http://127.0.0.1:8099/health',
    })
    expect(withUrls.logoutUrl).toBe('https://auth.example.com/logout')
    expect(withUrls.notionHealthUrl).toBe('http://127.0.0.1:8099/health')

    for (const badUrl of ['not-a-url', 'ftp://x', 'javascript:alert(1)']) {
      expect(() => loadConfig({ DATABASE_URL: 'pglite:memory', LOGOUT_URL: badUrl })).toThrow(
        /LOGOUT_URL/,
      )
      expect(() =>
        loadConfig({ DATABASE_URL: 'pglite:memory', NOTION_HEALTH_URL: badUrl }),
      ).toThrow(/NOTION_HEALTH_URL/)
    }
  })

  it('18.b validates AI proxy settings and cross-checks required API keys for providers', () => {
    // Valid dify
    const difyCfg = loadConfig({
      DATABASE_URL: 'pglite:memory',
      AI_PROVIDER: 'dify',
      DIFY_API_KEY: 'app-secret-123',
    })
    expect(difyCfg.aiProvider).toBe('dify')
    expect(difyCfg.difyApiKey).toBe('app-secret-123')
    expect(difyCfg.difyApiBase).toBe('https://api.dify.ai/v1')

    // Dify missing API key -> throws ConfigError
    expect(() =>
      loadConfig({
        DATABASE_URL: 'pglite:memory',
        AI_PROVIDER: 'dify',
      }),
    ).toThrow(/DIFY_API_KEY/)

    // Valid openai
    const openaiCfg = loadConfig({
      DATABASE_URL: 'pglite:memory',
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-secret-456',
      OPENAI_MODEL: 'gpt-4o',
      AI_UPSTREAM_TIMEOUT_MS: '45000',
      AI_UPLOAD_MAX_BYTES: '10485760',
    })
    expect(openaiCfg.aiProvider).toBe('openai')
    expect(openaiCfg.openaiApiKey).toBe('sk-secret-456')
    expect(openaiCfg.openaiModel).toBe('gpt-4o')
    expect(openaiCfg.aiUpstreamTimeoutMs).toBe(45000)
    expect(openaiCfg.aiUploadMaxBytes).toBe(10485760)

    // OpenAI missing API key -> throws ConfigError
    expect(() =>
      loadConfig({
        DATABASE_URL: 'pglite:memory',
        AI_PROVIDER: 'openai',
      }),
    ).toThrow(/OPENAI_API_KEY/)

    // Boundaries for AI_UPSTREAM_TIMEOUT_MS (1000..300000)
    expect(() =>
      loadConfig({
        DATABASE_URL: 'pglite:memory',
        AI_UPSTREAM_TIMEOUT_MS: '999',
      }),
    ).toThrow(/AI_UPSTREAM_TIMEOUT_MS/)

    expect(() =>
      loadConfig({
        DATABASE_URL: 'pglite:memory',
        AI_UPSTREAM_TIMEOUT_MS: '300001',
      }),
    ).toThrow(/AI_UPSTREAM_TIMEOUT_MS/)

    // Boundaries for AI_UPLOAD_MAX_BYTES (1024..104857600)
    expect(() =>
      loadConfig({
        DATABASE_URL: 'pglite:memory',
        AI_UPLOAD_MAX_BYTES: '1023',
      }),
    ).toThrow(/AI_UPLOAD_MAX_BYTES/)

    expect(() =>
      loadConfig({
        DATABASE_URL: 'pglite:memory',
        AI_UPLOAD_MAX_BYTES: '104857601',
      }),
    ).toThrow(/AI_UPLOAD_MAX_BYTES/)
  })

  it('19. applies env > .env > default precedence including empty-string override', () => {
    const dir = makeTempDir()
    const envPath = join(dir, '.env')
    writeFileSync(
      envPath,
      'DATABASE_URL=pglite:memory\r\nPORT=9000\r\nLOGOUT_URL="https://from-dotenv.example.com/out" # note\r\n',
      'utf8',
    )

    // .env overrides defaults
    const fromFile = loadConfig({ env: {}, envFile: envPath })
    expect(fromFile.port).toBe(9000)
    expect(fromFile.logoutUrl).toBe('https://from-dotenv.example.com/out')

    // process.env overrides .env
    const fromEnv = loadConfig({
      env: { PORT: '9100' },
      envFile: envPath,
    })
    expect(fromEnv.port).toBe(9100)

    // env[key] === "" overrides .env (does NOT fall back to .env!)
    const emptyOverride = loadConfig({
      env: { PORT: '', LOGOUT_URL: '' },
      envFile: envPath,
    })
    expect(emptyOverride.port).toBe(8100)
    expect(emptyOverride.logoutUrl).toBeNull()

    // env[key] === "" on required DATABASE_URL overrides .env and fails
    expect(() =>
      loadConfig({
        env: { DATABASE_URL: '' },
        envFile: envPath,
      }),
    ).toThrow(/DATABASE_URL/)

    // missing .env file is ignored when env supplies DATABASE_URL
    const missingFile = loadConfig({
      env: { DATABASE_URL: 'pglite:memory' },
      envFile: join(dir, 'nonexistent.env'),
    })
    expect(missingFile.databaseUrl).toBe('pglite:memory')
  })

  it('20. safely handles Object.prototype keys in parseRoleMap and formatConfigSummary', () => {
    for (const key of ['toString', 'constructor', '__proto__']) {
      const parsed = parseRoleMap(`${key}:admin,${key}:author`)
      expect(parsed.error).toBeNull()
      expect(Object.getPrototypeOf(parsed.map)).toBeNull()
      expect(Object.hasOwn(parsed.map, key)).toBe(true)
      expect(parsed.map[key]).toEqual(['admin', 'author'])

      const cfg = loadConfig({
        DATABASE_URL: 'pglite:memory',
        AUTH_ROLE_MAP: `${key}:admin`,
      })
      expect(Object.hasOwn(cfg.authRoleMap, key)).toBe(true)
      expect(cfg.authRoleMap[key]).toEqual(['admin'])
      expect(formatConfigSummary(cfg).AUTH_ROLE_MAP).toBe(`${key}:admin`)
    }
  })

  it('21. rejects host:port strings in validateHost while allowing valid IPv6 literals', () => {
    for (const badHost of ['127.0.0.1:8100', 'localhost:8100', '[::1]:8100', '[not:ipv6]', 'foo[::1]']) {
      expect(validateHost(badHost)).not.toBeNull()
      expect(() =>
        loadConfig({
          DATABASE_URL: 'pglite:memory',
          AUTH_ADAPTER: 'none',
          HOST: badHost,
        }),
      ).toThrow(/HOST/)
    }

    for (const okHost of ['::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
      expect(validateHost(okHost)).toBeNull()
    }
  })

  it('22. rejects ASCII control characters in validateHttpUrl', () => {
    for (const badUrl of [
      'https://auth.example.com/out\nInjected:1',
      'http://127.0.0.1:8099/health\rInjected:1',
      'https://auth.example.com/out\tpath',
      'https://auth.example.com/out\x00',
    ]) {
      expect(validateHttpUrl(badUrl)).not.toBeNull()
      expect(() =>
        loadConfig({ DATABASE_URL: 'pglite:memory', LOGOUT_URL: badUrl }),
      ).toThrow(/LOGOUT_URL/)
      expect(() =>
        loadConfig({ DATABASE_URL: 'pglite:memory', NOTION_HEALTH_URL: badUrl }),
      ).toThrow(/NOTION_HEALTH_URL/)
    }

    expect(validateHttpUrl('http://127.0.0.1:8099/health\r')).not.toBeNull()
    expect(validateHttpUrl('https://auth.example.com/out\t')).not.toBeNull()
  })

  it('23. does not misclassify plain env maps containing env/envFile keys as LoadConfigOptions', () => {
    const withEnvFileKey = loadConfig({
      DATABASE_URL: 'pglite:memory',
      envFile: '/tmp/unrelated-var',
    })
    expect(withEnvFileKey.databaseUrl).toBe('pglite:memory')

    const withUndefinedEnvKey = loadConfig({
      DATABASE_URL: 'pglite:memory',
      env: undefined,
    })
    expect(withUndefinedEnvKey.databaseUrl).toBe('pglite:memory')

    const withStringEnvKey = loadConfig({
      DATABASE_URL: 'pglite:memory',
      env: 'production',
    })
    expect(withStringEnvKey.databaseUrl).toBe('pglite:memory')

    expect(() => loadConfig({})).toThrow(/DATABASE_URL/)

    const explicitOptions = loadConfig({
      env: { DATABASE_URL: 'pglite:memory' },
      envFile: false,
    })
    expect(explicitOptions.databaseUrl).toBe('pglite:memory')
  })
})

describe('20. config:gen, config:check, and index entrypoint stub', () => {
  it('generates LF .env.example with empty secrets and optional fields, and verifies parity', () => {
    const rendered = generateEnvExample()
    expect(rendered.includes('\r\n')).toBe(false)
    expect(rendered.endsWith('\n')).toBe(true)

    const parsed = parseEnv(rendered)
    for (const spec of CONFIG_SCHEMA) {
      expect(Object.prototype.hasOwnProperty.call(parsed, spec.name)).toBe(true)
      if (spec.secret || spec.default === undefined || spec.default === '') {
        expect(parsed[spec.name]).toBe('')
      }
    }

    // Committed server/.env.example matches schema.ts byte-for-byte
    const committedPath = resolve(SERVER_ROOT, '.env.example')
    expect(readFileSync(committedPath, 'utf8')).toBe(rendered)
    expect(runConfigCli(['--check'], { targetPath: committedPath, log: vi.fn(), error: vi.fn() })).toBe(0)

    // Temp dir parity & failure cases
    const dir = makeTempDir()
    const tempExample = join(dir, '.env.example')
    const logs: string[] = []
    const errs: string[] = []

    expect(
      runConfigCli(['--check'], {
        targetPath: tempExample,
        log: (m) => logs.push(m),
        error: (m) => errs.push(m),
      }),
    ).toBe(1)

    expect(
      runConfigCli([], {
        targetPath: tempExample,
        log: (m) => logs.push(m),
        error: (m) => errs.push(m),
      }),
    ).toBe(0)

    expect(
      runConfigCli(['--check'], {
        targetPath: tempExample,
        log: (m) => logs.push(m),
        error: (m) => errs.push(m),
      }),
    ).toBe(0)

    // CRLF drift fails config:check
    writeFileSync(tempExample, rendered.replace(/\n/g, '\r\n'), 'utf8')
    const crlfErrs: string[] = []
    expect(
      runConfigCli(['--check'], {
        targetPath: tempExample,
        log: vi.fn(),
        error: (m) => crlfErrs.push(m),
      }),
    ).toBe(1)
    expect(crlfErrs.join('\n')).toContain('CRLF')

    // Tampered content fails config:check
    writeFileSync(tempExample, rendered.replace('PORT=8100', 'PORT=9999'), 'utf8')
    expect(
      runConfigCli(['--check'], {
        targetPath: tempExample,
        log: vi.fn(),
        error: vi.fn(),
      }),
    ).toBe(1)
  })

  it('indexMain logs redacted summary and exits 0 on valid env, or logs ConfigError and exits 1', () => {
    const prevDb = process.env.DATABASE_URL
    try {
      process.env.DATABASE_URL = 'pglite:memory'
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
      expect(indexMain()).toBe(0)
      expect(infoSpy).toHaveBeenCalledTimes(1)
      const printed = String(infoSpy.mock.calls[0]?.[1] ?? '')
      expect(printed).toContain('set (length 13)')
      expect(printed).not.toContain('pglite:memory')

      delete process.env.DATABASE_URL
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(indexMain()).toBe(1)
      expect(errSpy).toHaveBeenCalledTimes(1)
      expect(String(errSpy.mock.calls[0]?.[0] ?? '')).toContain('DATABASE_URL')
    } finally {
      if (prevDb === undefined) {
        delete process.env.DATABASE_URL
      } else {
        process.env.DATABASE_URL = prevDb
      }
    }
  })
})
