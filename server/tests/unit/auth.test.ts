import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS_SESSION,
  createAuthAdapter,
  createNoneAuthAdapter,
  createTrustedHeaderAuthAdapter,
  resolveRoles,
  resolveTrustedHeaderAuth,
} from '../../src/auth/index.js'
import type { AppConfig } from '../../src/config/schema.js'

function makeMockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: 'postgres://localhost:5432/test',
    databaseUrlDirect: null,
    host: '127.0.0.1',
    port: 8100,
    authAdapter: 'trusted-header',
    authHeaderPreset: 'authelia',
    authHeaderUser: 'Remote-User',
    authHeaderGroups: 'Remote-Groups',
    authHeaderEmail: 'Remote-Email',
    authHeaderName: 'Remote-Name',
    authGroupSeparator: ',',
    authRoleMap: {
      admins: ['admin'],
      staff: ['author'],
      students: ['reader'],
    },
    logoutUrl: 'https://auth.example.com/logout',
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
    aiUploadMaxBytes: 52428800,
    aiAllowAnonymous: false,
    aiRatePerMinute: 20,
    aiMaxConcurrent: 2,
    aiDailyLimit: 300,
    writeRatePerMinute: 120,
    aiQueryMaxBytes: 8192,
    aiInputsMaxBytes: 32768,
    aiStreamMaxMs: 300000,
    aiAccessLog: false,
    aiPromptsFile: null,
    siteDistDir: null,
    aiToolsFile: null,
    aiToolTimeoutMs: 8000,
    aiToolMaxResultBytes: 24000,
    aiToolMaxSteps: 5,
    aiMcpToken: null,
    aiMcpTicketSecret: null,
    ...overrides,
  }
}

describe('auth/roles', () => {
  it('returns [reader] when groups are empty', () => {
    expect(resolveRoles([], {})).toEqual(['reader'])
  })

  it('returns [reader] when groups do not match role map', () => {
    expect(resolveRoles(['unrelated'], { admins: ['admin'] })).toEqual(['reader'])
  })

  it('maps single group to role preserving reader first', () => {
    expect(resolveRoles(['admins'], { admins: ['admin'] })).toEqual(['reader', 'admin'])
  })

  it('maps multiple groups in encounter order without duplicates', () => {
    const roleMap = {
      lead: ['author', 'admin'] as const,
      writers: ['author'] as const,
      root: ['admin'] as const,
    }
    const roles = resolveRoles(['writers', 'lead', 'root'], roleMap)
    expect(roles).toEqual(['reader', 'author', 'admin'])
  })

  it('does not duplicate reader when explicitly mapped', () => {
    const roles = resolveRoles(['students'], { students: ['reader'] })
    expect(roles).toEqual(['reader'])
  })
})

describe('auth/none', () => {
  it('returns anonymous session with effectiveUserId = anonymous', () => {
    const adapter = createNoneAuthAdapter()
    const result = adapter.authenticate((name) => name)

    expect(result.effectiveUserId).toBe('anonymous')
    expect(result.session).toEqual(ANONYMOUS_SESSION)
    expect(result.session.authenticated).toBe(false)
    expect(result.session.user).toBeNull()
    expect(result.session.roles).toEqual(['reader'])
    expect(result.session.groups).toEqual([])
    expect(result.session.logoutUrl).toBeNull()
  })

  it('createAuthAdapter returns none adapter when authAdapter is none', () => {
    const cfg = makeMockConfig({ authAdapter: 'none' })
    const adapter = createAuthAdapter(cfg)
    const result = adapter.authenticate(() => 'foo')
    expect(result.effectiveUserId).toBe('anonymous')
    expect(result.session.authenticated).toBe(false)
  })
})

describe('auth/trustedHeader', () => {
  it('returns anonymous when user header is missing or empty', () => {
    const cfg = makeMockConfig()
    const getHeader = () => undefined
    const res = resolveTrustedHeaderAuth(getHeader, cfg)

    expect(res.effectiveUserId).toBeNull()
    expect(res.session.authenticated).toBe(false)
    expect(res.session.user).toBeNull()
    expect(res.session.logoutUrl).toBeNull()
  })

  it('returns anonymous when user header is only whitespace', () => {
    const cfg = makeMockConfig()
    const headers: Record<string, string> = { 'remote-user': '   ' }
    const res = resolveTrustedHeaderAuth((n) => headers[n.toLowerCase()], cfg)

    expect(res.effectiveUserId).toBeNull()
    expect(res.session.authenticated).toBe(false)
  })

  it('returns anonymous when authHeaderUser is not configured', () => {
    const cfg = makeMockConfig({ authHeaderUser: undefined })
    const headers: Record<string, string> = { 'remote-user': 'alice' }
    const res = resolveTrustedHeaderAuth((n) => headers[n.toLowerCase()], cfg)

    expect(res.effectiveUserId).toBeNull()
  })

  it('authenticates valid user with trimmed values and roles', () => {
    const cfg = makeMockConfig()
    const headers: Record<string, string> = {
      'remote-user': '  alice  ',
      'remote-groups': 'admins, students, admins',
      'remote-email': '  alice@example.com ',
      'remote-name': '  Alice Smith ',
    }
    const res = resolveTrustedHeaderAuth((n) => headers[n.toLowerCase()], cfg)

    expect(res.effectiveUserId).toBe('alice')
    expect(res.session.authenticated).toBe(true)
    expect(res.session.user).toEqual({
      id: 'alice',
      name: 'Alice Smith',
      email: 'alice@example.com',
    })
    expect(res.session.groups).toEqual(['admins', 'students'])
    expect(res.session.roles).toEqual(['reader', 'admin'])
    expect(res.session.logoutUrl).toBe('https://auth.example.com/logout')
  })

  it('supports non-ASCII / Unicode username and name', () => {
    const cfg = makeMockConfig()
    const headers: Record<string, string> = {
      'remote-user': '张三',
      'remote-name': '张三 (测试)',
    }
    const res = resolveTrustedHeaderAuth((n) => headers[n.toLowerCase()], cfg)

    expect(res.effectiveUserId).toBe('张三')
    expect(res.session.authenticated).toBe(true)
    expect(res.session.user?.id).toBe('张三')
    expect(res.session.user?.name).toBe('张三 (测试)')
    expect(res.session.user?.email).toBeNull()
  })

  it('sets name and email to null when empty after trim', () => {
    const cfg = makeMockConfig()
    const headers: Record<string, string> = {
      'remote-user': 'bob',
      'remote-email': '   ',
      'remote-name': '',
    }
    const res = resolveTrustedHeaderAuth((n) => headers[n.toLowerCase()], cfg)

    expect(res.effectiveUserId).toBe('bob')
    expect(res.session.user?.name).toBeNull()
    expect(res.session.user?.email).toBeNull()
  })

  describe('sanitization: control characters & max length', () => {
    it.each([
      ['null byte in user', { 'remote-user': 'alice\x00' }],
      ['control char in user', { 'remote-user': 'alice\x1F' }],
      ['DEL char in user', { 'remote-user': 'alice\x7F' }],
      ['control char in groups', { 'remote-user': 'alice', 'remote-groups': 'admin\x00' }],
      ['control char in email', { 'remote-user': 'alice', 'remote-email': 'alice@\x0Aexample.com' }],
      ['control char in name', { 'remote-user': 'alice', 'remote-name': 'Alice\rSmith' }],
    ])('rejects identity to anonymous on %s', (_desc, headers) => {
      const cfg = makeMockConfig()
      const res = resolveTrustedHeaderAuth((n) => headers[n.toLowerCase() as keyof typeof headers], cfg)
      expect(res.effectiveUserId).toBeNull()
      expect(res.session.authenticated).toBe(false)
    })

    it('rejects identity if any header length exceeds 256 characters', () => {
      const cfg = makeMockConfig()
      const longString = 'a'.repeat(257)

      // user too long
      let res = resolveTrustedHeaderAuth(() => longString, cfg)
      expect(res.effectiveUserId).toBeNull()
      expect(res.session.authenticated).toBe(false)

      // email too long
      const headers: Record<string, string> = {
        'remote-user': 'alice',
        'remote-email': longString,
      }
      res = resolveTrustedHeaderAuth((n) => headers[n.toLowerCase()], cfg)
      expect(res.effectiveUserId).toBeNull()
      expect(res.session.authenticated).toBe(false)
    })

    it('accepts headers exactly 256 characters long', () => {
      const cfg = makeMockConfig()
      const exact256 = 'u'.repeat(256)
      const headers: Record<string, string> = {
        'remote-user': exact256,
      }
      const res = resolveTrustedHeaderAuth((n) => headers[n.toLowerCase()], cfg)
      expect(res.effectiveUserId).toBe(exact256)
      expect(res.session.authenticated).toBe(true)
    })
  })

  describe('presets & custom separator', () => {
    it('supports authentik pipe separator', () => {
      const cfg = makeMockConfig({
        authHeaderPreset: 'authentik',
        authHeaderUser: 'X-authentik-username',
        authHeaderGroups: 'X-authentik-groups',
        authGroupSeparator: '|',
      })
      const headers: Record<string, string> = {
        'x-authentik-username': 'carol',
        'x-authentik-groups': 'admins|staff|students',
      }
      const res = resolveTrustedHeaderAuth((n) => headers[n.toLowerCase()], cfg)
      expect(res.effectiveUserId).toBe('carol')
      expect(res.session.groups).toEqual(['admins', 'staff', 'students'])
      expect(res.session.roles).toEqual(['reader', 'admin', 'author'])
    })

    it('createTrustedHeaderAuthAdapter works via interface', () => {
      const cfg = makeMockConfig()
      const adapter = createTrustedHeaderAuthAdapter(cfg)
      const res = adapter.authenticate((n) => (n.toLowerCase() === 'remote-user' ? 'dave' : undefined))
      expect(res.effectiveUserId).toBe('dave')
      expect(res.session.authenticated).toBe(true)
    })
  })
})
