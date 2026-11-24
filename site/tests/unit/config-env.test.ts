import { describe, expect, it } from 'vitest'
import { SETTINGS, type Setting } from '../../config/schema.ts'
import {
  display,
  getInUseModules,
  parseEnv,
  resolveAll,
  updateEnvText,
  validate,
  type ConfigSources,
} from '../../scripts/config/env.mts'
import {
  formatDoctorJson,
  formatDoctorText,
  runDoctor,
  type DoctorReport,
  type ProbeRunner,
} from '../../scripts/config/doctor.mts'
import type { ResolvedModules } from '../../docs/.vitepress/lecture-config.mts'

describe('parseEnv parser invariants', () => {
  it('handles comments, blank lines, export prefix, and inline comments', () => {
    const raw = `
# Comment line
  # Indented comment

export FOO=bar
BAR=baz # inline comment
QUOTED_HASH="hello # world"
EMPTY=
SPACED = trimmed 
`
    const parsed = parseEnv(raw)
    expect(parsed.FOO).toBe('bar')
    expect(parsed.BAR).toBe('baz')
    expect(parsed.QUOTED_HASH).toBe('hello # world')
    expect(parsed.EMPTY).toBe('')
    expect(parsed.SPACED).toBe('trimmed')
  })

  it('handles quotes, BOM, and preserves Windows paths without escaping', () => {
    const raw = `\ufeffWIN_PATH=C:\\Users\\Admin\\AppData\\Local\\Temp
SINGLE_QUOTED='single "inner" quote'
DOUBLE_QUOTED="double 'inner' quote"
`
    const parsed = parseEnv(raw)
    expect(parsed.WIN_PATH).toBe('C:\\Users\\Admin\\AppData\\Local\\Temp')
    expect(parsed.SINGLE_QUOTED).toBe('single "inner" quote')
    expect(parsed.DOUBLE_QUOTED).toBe("double 'inner' quote")
  })

  it('handles multi-line values like PEM certificates', () => {
    const pem = `-----BEGIN TEST FIXTURE KEY-----
MIIEowIBAAKCAQEA0Y3y...
test line 2
-----END TEST FIXTURE KEY-----`

    const raw = `BEFORE=1
DEPLOY_SSH_KEY_PEM="${pem}"
AFTER=2
`
    const parsed = parseEnv(raw)
    expect(parsed.BEFORE).toBe('1')
    expect(parsed.DEPLOY_SSH_KEY_PEM).toBe(pem)
    expect(parsed.AFTER).toBe('2')
  })
})

describe('precedence and aliases', () => {
  const dummySetting: Setting = {
    key: 'TEST_KEY',
    module: 'deploy',
    kind: 'env',
    type: 'string',
    aliases: ['TEST_KEY_LEGACY', 'TEST_KEY_OLD'],
    default: 'default_val',
    description: { zh: '测试项', en: 'Test item' },
  }

  it('precedence: env > .env > legacy > default', () => {
    // 1. env wins over all
    const src1: ConfigSources = {
      repoRoot: '/fake',
      env: { TEST_KEY: 'from_env' },
      dotenv: { TEST_KEY: 'from_dotenv' },
      legacy: { TEST_KEY: 'from_legacy' },
    }
    const res1 = resolveAll(src1, [dummySetting])
    expect(res1[0]?.value).toBe('from_env')
    expect(res1[0]?.source).toBe('env')

    // 2. .env wins over legacy and default
    const src2: ConfigSources = {
      repoRoot: '/fake',
      env: {},
      dotenv: { TEST_KEY: 'from_dotenv' },
      legacy: { TEST_KEY: 'from_legacy' },
    }
    const res2 = resolveAll(src2, [dummySetting])
    expect(res2[0]?.value).toBe('from_dotenv')
    expect(res2[0]?.source).toBe('.env')

    // 3. legacy wins over default
    const src3: ConfigSources = {
      repoRoot: '/fake',
      env: {},
      dotenv: {},
      legacy: { TEST_KEY: 'from_legacy' },
    }
    const res3 = resolveAll(src3, [dummySetting])
    expect(res3[0]?.value).toBe('from_legacy')
    expect(res3[0]?.source).toBe('legacy')

    // 4. default when none set
    const src4: ConfigSources = {
      repoRoot: '/fake',
      env: {},
      dotenv: {},
      legacy: {},
    }
    const res4 = resolveAll(src4, [dummySetting])
    expect(res4[0]?.value).toBe('default_val')
    expect(res4[0]?.source).toBe('default')
  })

  it('canonical key wins over alias at the same precedence level', () => {
    const src: ConfigSources = {
      repoRoot: '/fake',
      env: {},
      dotenv: {
        TEST_KEY: 'canonical_val',
        TEST_KEY_LEGACY: 'legacy_val',
      },
      legacy: {},
    }
    const res = resolveAll(src, [dummySetting])
    expect(res[0]?.value).toBe('canonical_val')
    expect(res[0]?.nameUsed).toBe('TEST_KEY')
  })

  it('alias at higher precedence level wins over canonical at lower precedence level', () => {
    const src: ConfigSources = {
      repoRoot: '/fake',
      env: { TEST_KEY_LEGACY: 'env_alias_val' },
      dotenv: { TEST_KEY: 'dotenv_canonical_val' },
      legacy: {},
    }
    const res = resolveAll(src, [dummySetting])
    expect(res[0]?.value).toBe('env_alias_val')
    expect(res[0]?.source).toBe('env')
    expect(res[0]?.nameUsed).toBe('TEST_KEY_LEGACY')
  })

  it('adds warning when an alias is used and when canonical & alias differ', () => {
    const src: ConfigSources = {
      repoRoot: '/fake',
      env: {},
      dotenv: {
        TEST_KEY: 'canonical_val',
        TEST_KEY_LEGACY: 'different_val',
      },
      legacy: {},
    }
    const res = resolveAll(src, [dummySetting])
    expect(res[0]?.warnings).toBeDefined()
    expect(res[0]?.warnings?.some((w) => w.includes('不一致'))).toBe(true)
  })
})

describe('validation of every type', () => {
  it('validates int', () => {
    const s: Setting = { key: 'K', module: 'deploy', kind: 'env', type: 'int', description: { zh: '', en: '' } }
    expect(validate(s, '123').valid).toBe(true)
    expect(validate(s, '-5').valid).toBe(true)
    expect(validate(s, 'abc').valid).toBe(false)
    expect(validate(s, '12.3').valid).toBe(false)
  })

  it('validates bool', () => {
    const s: Setting = { key: 'K', module: 'deploy', kind: 'env', type: 'bool', description: { zh: '', en: '' } }
    expect(validate(s, 'true').valid).toBe(true)
    expect(validate(s, 'False').valid).toBe(true)
    expect(validate(s, '1').valid).toBe(true)
    expect(validate(s, '0').valid).toBe(true)
    expect(validate(s, 'yes').valid).toBe(true)
    expect(validate(s, 'no').valid).toBe(true)
    expect(validate(s, 'invalid').valid).toBe(false)
  })

  it('validates url', () => {
    const s: Setting = { key: 'K', module: 'deploy', kind: 'env', type: 'url', description: { zh: '', en: '' } }
    expect(validate(s, 'https://example.com/api').valid).toBe(true)
    expect(validate(s, 'http://127.0.0.1:8080').valid).toBe(true)
    expect(validate(s, 'ftp://example.com').valid).toBe(false)
    expect(validate(s, 'not-a-url').valid).toBe(false)
  })

  it('validates domain', () => {
    const s: Setting = { key: 'K', module: 'deploy', kind: 'env', type: 'domain', description: { zh: '', en: '' } }
    expect(validate(s, 'example.com').valid).toBe(true)
    expect(validate(s, 'sub.domain.example.com').valid).toBe(true)
    expect(validate(s, 'https://example.com').valid).toBe(false)
    expect(validate(s, 'example.com/path').valid).toBe(false)
    expect(validate(s, 'example.com:8080').valid).toBe(false)
  })

  it('validates host', () => {
    const s: Setting = { key: 'K', module: 'deploy', kind: 'env', type: 'host', description: { zh: '', en: '' } }
    expect(validate(s, '127.0.0.1').valid).toBe(true)
    expect(validate(s, 'docs.example.com').valid).toBe(true)
    expect(validate(s, 'localhost').valid).toBe(true)
    expect(validate(s, 'https://127.0.0.1').valid).toBe(false)
  })

  it('validates id (32 hex digits with or without dashes)', () => {
    const s: Setting = { key: 'K', module: 'notion', kind: 'secret', type: 'id', description: { zh: '', en: '' } }
    expect(validate(s, '1234567890abcdef1234567890abcdef').valid).toBe(true) // privacy-scan: allow
    expect(validate(s, '12345678-90ab-cdef-1234-567890abcdef').valid).toBe(true) // privacy-scan: allow
    expect(validate(s, 'short-id').valid).toBe(false)
    expect(validate(s, '1234567890abcdef1234567890abcdeg').valid).toBe(false) // 'g' is invalid hex
  })

  it('validates path', () => {
    const s: Setting = { key: 'K', module: 'deploy', kind: 'env', type: 'path', description: { zh: '', en: '' } }
    expect(validate(s, '/var/www').valid).toBe(true)
    expect(validate(s, 'C:\\Users\\name').valid).toBe(true)
    expect(validate(s, '  ').valid).toBe(false)
  })

  it('validates pem', () => {
    const s: Setting = { key: 'K', module: 'deploy', kind: 'secret', type: 'pem', description: { zh: '', en: '' } }
    const validPem = `-----BEGIN TEST FIXTURE KEY-----
MIIEowIBAAKCAQEA0Y3y...
-----END TEST FIXTURE KEY-----`
    expect(validate(s, validPem).valid).toBe(true)
    expect(validate(s, 'plain text without headers').valid).toBe(false)
  })

  it('validates enum', () => {
    const s: Setting = { key: 'K', module: 'deploy', kind: 'env', type: 'enum', values: ['a', 'b', 'c'], description: { zh: '', en: '' } }
    expect(validate(s, 'a').valid).toBe(true)
    expect(validate(s, 'b').valid).toBe(true)
    expect(validate(s, 'd').valid).toBe(false)
  })
})

describe('display and secret protection', () => {
  it('display never contains a secret value', () => {
    const secretSetting: Setting = {
      key: 'SECRET_KEY',
      module: 'notion',
      kind: 'secret',
      type: 'string',
      description: { zh: '', en: '' },
    }
    const secretValue = 'SECRET_TOKEN_xyz_12345'
    const disp = display(secretSetting, secretValue)
    expect(disp).not.toContain(secretValue)
    expect(disp).toBe(`已设置（长度 ${secretValue.length}）`)

    expect(display(secretSetting, '')).toBe('未设置')
    expect(display(secretSetting, undefined)).toBe('未设置')
  })

  it('masks sensitive non-secret settings using mask()', () => {
    const maskedSetting: Setting = {
      key: 'DEPLOY_HOST',
      module: 'deploy',
      kind: 'env',
      type: 'host',
      masked: true,
      description: { zh: '', en: '' },
    }
    expect(display(maskedSetting, '192.168.1.50')).toBe('192.***.***.50')
    expect(display(maskedSetting, 'docs.example.com')).toBe('docs.e****')
    expect(display(maskedSetting, 'abc')).toBe('ab***')
  })

  it('doctor JSON output and text output contain no secret value (sentinel test)', async () => {
    const SENTINEL = 'SENTINEL_SECRET_93f1'
    const fakeEnv: Record<string, string> = {}

    // Inject SENTINEL into every secret
    for (const s of SETTINGS.filter((x) => x.kind === 'secret')) {
      fakeEnv[s.key] = `${SENTINEL}_${s.key}`
    }

    const sources: ConfigSources = {
      repoRoot: '/fake',
      env: fakeEnv,
      dotenv: {},
      legacy: {},
    }

    const mockProbeRunner: ProbeRunner = async () => ({ reachable: true })

    const report = await runDoctor({
      sources,
      probe: false,
      probeRunner: mockProbeRunner,
    })

    const textOutput = formatDoctorText(report)
    const jsonOutput = formatDoctorJson(report)

    expect(textOutput).not.toContain(SENTINEL)
    expect(jsonOutput).not.toContain(SENTINEL)

    // Verify secret shape in json
    const parsed = JSON.parse(jsonOutput) as DoctorReport
    for (const mod of parsed.modules) {
      for (const s of mod.settings) {
        if (s.kind === 'secret') {
          expect(s.secret).toBeDefined()
          expect(s.secret?.set).toBe(true)
          expect(s.secret?.length).toBeGreaterThan(0)
          // Ensure no raw value key exists
          expect((s as unknown as Record<string, unknown>).value).toBeUndefined()
        }
      }
    }
  })
})

describe('updateEnvText purity and preservation', () => {
  it('keeps unrelated lines and comments byte-for-byte and updates targeted keys', () => {
    const existing = `# Header comment
# Do not touch this line

DEPLOY_PORT=22
# Next is webroot
DEPLOY_WEBROOT=/old/path
UNCHANGED=keep_me

DEPLOY_SSH_KEY_PEM="-----BEGIN TEST FIXTURE KEY-----
old line 1
-----END TEST FIXTURE KEY-----"

# Footer
`
    const updates = {
      DEPLOY_PORT: '2222',
      DEPLOY_WEBROOT: '/new/path',
      NEW_KEY: 'new_value',
    }

    const updated = updateEnvText(existing, updates)

    expect(updated).toContain('# Header comment\n# Do not touch this line\n')
    expect(updated).toContain('DEPLOY_PORT=2222')
    expect(updated).toContain('# Next is webroot\nDEPLOY_WEBROOT=/new/path')
    expect(updated).toContain('UNCHANGED=keep_me')
    expect(updated).toContain('# Footer')
    expect(updated).toContain('NEW_KEY=new_value')
    // Multi-line unchanged
    expect(updated).toContain('old line 1')
  })
})

describe('in-use module detection', () => {
  const baseSiteModules: ResolvedModules = {
    progress: { adapter: 'local', endpoint: '/api/db', notionSync: false },
    companion: { adapter: 'off' },
    graph: { source: 'merge' },
    contentSync: { adapter: 'none' },
    auth: { adapter: 'none', sessionEndpoint: '/api/auth/session', loginUrl: '' },
  }

  it('detects site modules always in use', () => {
    const inUse = getInUseModules([], baseSiteModules)
    expect(inUse.has('progress')).toBe(true)
    expect(inUse.has('companion')).toBe(true)
    expect(inUse.has('graph')).toBe(true)
    expect(inUse.has('contentSync')).toBe(true)
    expect(inUse.has('auth')).toBe(true)
  })

  it('activates notion module through neededBy when contentSync = notion', () => {
    const notionSiteModules: ResolvedModules = {
      ...baseSiteModules,
      contentSync: { adapter: 'notion' },
    }
    const inUse = getInUseModules([], notionSiteModules)
    expect(inUse.has('notion')).toBe(true)
  })

  it('activates tool modules specified in LECTURE_MODULES', () => {
    const resolved = [
      {
        key: 'LECTURE_MODULES',
        value: 'deploy,mirror',
        source: '.env' as const,
        nameUsed: 'LECTURE_MODULES',
        isSet: true,
      },
    ]
    const inUse = getInUseModules(resolved, baseSiteModules)
    expect(inUse.has('deploy')).toBe(true)
    expect(inUse.has('mirror')).toBe(true)
    expect(inUse.has('notion')).toBe(false)
  })

  it('infers tool modules with at least one set key when LECTURE_MODULES is empty', () => {
    const resolved = [
      {
        key: 'DEPLOY_WEBROOT',
        value: '/var/www',
        source: '.env' as const,
        nameUsed: 'DEPLOY_WEBROOT',
        isSet: true,
      },
    ]
    const inUse = getInUseModules(resolved, baseSiteModules)
    expect(inUse.has('deploy')).toBe(true)
    expect(inUse.has('mirror')).toBe(false)
  })
})

describe('auth.loginUrl doctor validation', () => {
  it('accepts site-relative paths and https URLs while rejecting protocol-relative URLs', () => {
    const loginUrlSetting = SETTINGS.find((s) => s.key === 'auth.loginUrl')
    expect(loginUrlSetting).toBeDefined()
    expect(validate(loginUrlSetting!, '/login?rd={rd}')).toEqual({ valid: true })
    expect(validate(loginUrlSetting!, 'https://auth.example.com/?rd={rd}')).toEqual({ valid: true })
    expect(validate(loginUrlSetting!, '//evil.com/login').valid).toBe(false)
    expect(validate(loginUrlSetting!, '/login with spaces').valid).toBe(false)
  })
})
