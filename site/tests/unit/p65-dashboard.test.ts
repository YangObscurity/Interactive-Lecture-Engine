import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  buildAutheliaRules,
  extractServerSection,
  formatAutheliaYaml,
  formatNginxAuthSnippet,
  parseAuthExportArgs,
  resolveAuthPlan,
} from '../../docs/.vitepress/access/authExport.ts'
import { resolveAccess } from '../../docs/.vitepress/access/tiers.ts'
import { createDashboardDevHandler } from '../../docs/.vitepress/plugins/dashboardDevPlugin.mts'
import { v2DashboardExcludes } from '../../docs/.vitepress/config.v2.mts'
import {
  computeTranslationSummary,
  isAdminHealth,
  isAdminOverview,
} from '../../docs/.vitepress/theme/api/admin'
import { SETTINGS } from '../../config/schema.ts'

const GROUPS = [
  { id: 'G01', dir: 'g01' },
  { id: 'G09', dir: 'g09' },
  { id: 'G12', dir: 'g12' },
]

describe('P6.5 WP-D1 auth:export', () => {
  it('generates Authelia rules covering admin, restricted grp/auth tiers, user APIs, and public default', () => {
    const plan = resolveAccess({
      access: {
        default: 'public',
        enforcement: 'gateway',
        groups: {
          G09: { read: 'authenticated' },
          G12: { read: ['staff', 'mentors'] },
        },
      },
      groupIds: ['G01', 'G09', 'G12'],
    })

    const rules = buildAutheliaRules({
      plan,
      groups: GROUPS,
      localeKeys: ['en'],
      domain: 'lectures.example.com',
    })

    // Rule 0: bypass for the paths that must never be gated
    expect(rules[0]?.policy).toBe('bypass')
    expect(rules[0]?.resources).toEqual(['^/api/auth/session/?$', '^/api/health/?$', '^/api/tool(?:/.*)?$', '^/api/mcp$'])

    // Rule 1: admin-only /dashboard, /api/admin/**, and the legacy Notion service paths
    expect(rules[1]?.resources).toContain('^/dashboard(?:/.*)?$')
    expect(rules[1]?.resources).toContain('^/en/dashboard(?:/.*)?$')
    expect(rules[1]?.resources).toContain('^/api/admin(?:/.*)?$')
    expect(rules[1]?.resources).toContain('^/api/(?:progress|notion)(?:/.*)?$')
    expect(rules[1]?.subject).toEqual(['group:admins', 'group:admin'])
    expect(rules[1]?.policy).toBe('two_factor')
    // Authelia skips a rule whose subject does not match, so the same resources must be denied right after
    expect(rules[2]?.policy).toBe('deny')
    expect(rules[2]?.resources).toEqual(rules[1]?.resources)
    expect(rules[2]?.subject).toBeUndefined()

    // every rule carries the domain
    expect(rules.every((r) => r.domain === 'lectures.example.com')).toBe(true)
    // /api/progress and /api/notion are no longer in the any-logged-in-user rule
    const userRule = rules.find((r) => r.resources.includes('^/api/(?:db|ai)(?:/.*)?$'))
    expect(userRule).toBeDefined()
    expect(userRule?.resources).toContain('^/api/tools(?:/.*)?$')
    expect(userRule?.resources.join()).not.toContain('progress')

    // Restricted group tier comes before generic authenticated tier
    const grpIdx = rules.findIndex((r) => r.resources.some((x) => x.includes('/g12')))
    const authIdx = rules.findIndex((r) => r.resources.some((x) => x.includes('/g09')))
    expect(grpIdx).toBeGreaterThan(0)
    expect(authIdx).toBeGreaterThan(grpIdx)
    expect(rules[grpIdx]?.subject).toEqual(['group:mentors', 'group:staff'])
    expect(rules[grpIdx]?.resources).toContain('^/assets/g12_.*$')
    expect(rules[grpIdx]?.resources).toContain('^/assets/en_g12_.*$')
    expect(rules[grpIdx + 1]?.policy).toBe('deny')
    expect(rules[grpIdx + 1]?.resources).toEqual(rules[grpIdx]?.resources)
    // every subject-restricted rule is followed by a deny for the same resources
    rules.forEach((r, i) => {
      if (r.subject) expect(rules[i + 1]).toMatchObject({ policy: 'deny', resources: r.resources })
    })
    // no rule except bypass / deny drops below the chosen factor
    expect(rules.filter((r) => r.policy === 'one_factor')).toEqual([])

    // Catch-all matches public default
    const last = rules[rules.length - 1]
    expect(last?.resources).toEqual(['^/.*$'])
    expect(last?.policy).toBe('bypass')

    const yaml = formatAutheliaYaml({
      plan,
      groups: GROUPS,
      localeKeys: ['en'],
      domain: 'lectures.example.com',
    })
    expect(yaml).toContain('access_control:')
    expect(yaml).toContain('default_policy: deny')
    expect(yaml).toContain('"lectures.example.com"')
    // One subject per line: Authelia treats an inner list as AND and the outer list as OR.
    expect(yaml).toContain('        - - "group:mentors"\n        - - "group:staff"')
    expect(yaml).toContain('        - - "group:admins"\n        - - "group:admin"')
    expect(yaml).not.toMatch(/- \[\s*"group:/)
  })

  it('requires --domain for the Authelia format', () => {
    const plan = resolveAccess({ access: { default: 'authenticated', enforcement: 'gateway' }, groupIds: ['G01'] })
    expect(() => buildAutheliaRules({ plan, groups: GROUPS, localeKeys: ['en'] })).toThrow(/--domain/)
    expect(() => formatAutheliaYaml({ plan, groups: GROUPS, localeKeys: ['en'], domain: '  ' })).toThrow(/--domain/)
  })

  it('adds explicit public bypass rule when defaultTier is authenticated', () => {
    const plan = resolveAuthPlan(
      {
        default: 'authenticated',
        enforcement: 'gateway',
        groups: { G01: { read: 'public' } },
      },
      GROUPS,
      {},
    )
    const rules = buildAutheliaRules({ plan, groups: GROUPS, localeKeys: ['en'], domain: 'lectures.example.com' })
    const g01Bypass = rules.find((r) => r.policy === 'bypass' && r.resources.includes('^/g01(?:/.*)?$'))
    expect(g01Bypass).toBeDefined()
    expect(rules[rules.length - 1]?.policy).toBe('two_factor')
    // public content exists, so anonymous visitors must be able to read their session
    expect(rules[0]?.resources).toContain('^/api/auth/session/?$')

    const oneFactor = buildAutheliaRules({ plan, groups: GROUPS, localeKeys: ['en'], domain: 'lectures.example.com', factor: 'one_factor' })
    expect(oneFactor[oneFactor.length - 1]?.policy).toBe('one_factor')
    expect(oneFactor.some((r) => r.policy === 'two_factor')).toBe(false)
  })

  it('keeps /api/auth/session behind login on a login-only site', () => {
    const plan = resolveAuthPlan({ default: 'authenticated', enforcement: 'gateway' }, GROUPS, {})
    const rules = buildAutheliaRules({ plan, groups: GROUPS, localeKeys: ['en'], domain: 'lectures.example.com' })
    expect(rules[0]?.policy).toBe('bypass')
    expect(rules[0]?.resources).toEqual(['^/api/health/?$', '^/api/tool(?:/.*)?$', '^/api/mcp$'])
    expect(rules.some((r) => r.policy === 'bypass' && r.resources.includes('^/api/auth/session/?$'))).toBe(false)
    expect(parseAuthExportArgs(['authelia', '--factor', 'one_factor']).factor).toBe('one_factor')
    expect(parseAuthExportArgs(['authelia']).factor).toBeUndefined()
    expect(() => parseAuthExportArgs(['authelia', '--factor', 'three'])).toThrow(/factor/)
  })

  it('generates nginx auth_request snippet and parses CLI flags', () => {
    const plan = resolveAccess({
      access: { default: 'authenticated', enforcement: 'gateway' },
      groupIds: ['G01'],
    })
    const template = fs.readFileSync(path.resolve(__dirname, '../../../server/deploy/nginx-locations.conf'), 'utf8')
    const nginx = formatNginxAuthSnippet({ plan, groups: GROUPS, localeKeys: ['en'] }, template)
    // The API locations are the template's server-level section, byte for byte (no drift).
    const serverSection = extractServerSection(template)
    expect(serverSection).toBeTruthy()
    expect(nginx).toContain(serverSection)
    expect(nginx).toContain('location /api/admin/')
    expect(nginx).toContain('proxy_set_header Remote-Groups $auth_groups;')
    expect(nginx).toContain('upstream lecture_api_backend')
    // Without the template it only points to it instead of inventing locations.
    const pointer = formatNginxAuthSnippet({ plan, groups: GROUPS, localeKeys: ['en'] })
    expect(pointer).toContain('server/deploy/nginx-locations.conf')
    expect(pointer).not.toContain('proxy_pass')

    // A public default drops auth from the catch-all `location /` only.
    const publicPlan = resolveAccess({ access: { default: 'public', enforcement: 'gateway' }, groupIds: ['G01'] })
    const pub = formatNginxAuthSnippet({ plan: publicPlan, groups: GROUPS, localeKeys: ['en'] }, template)
    const catchAll = pub.slice(pub.indexOf('location / {'))
    expect(catchAll.slice(0, catchAll.indexOf('}'))).not.toContain('auth_request')
    expect(pub).toContain('auth_request /internal/authelia/authz;')

    const parsed = parseAuthExportArgs(['authelia', '--domain=docs.example.com', '--admin-groups=owners,admins'])
    expect(parsed).toMatchObject({
      format: 'authelia',
      domain: 'docs.example.com',
      adminGroups: ['owners', 'admins'],
    })
    expect(() => parseAuthExportArgs(['--format=bogus'])).toThrow(/Unsupported format/)
  })
})

describe('P6.5 WP-D2 dashboard client, exclusions & dev middleware', () => {
  it('validates admin overview & health payloads and computes translation coverage', () => {
    expect(
      isAdminOverview({
        generatedAt: '2026-11-19T00:00:00Z',
        totals: {
          users: 5,
          progressRows: 20,
          completedLectures: 12,
          sessions: 3,
          messages: 9,
          checklistItems: 6,
          completedChecklistItems: 4,
        },
        byStatus: { completed: 12 },
        byGroup: [],
        recentActivity: {
          progressUpdatedLast24h: 2,
          sessionsCreatedLast24h: 1,
          messagesCreatedLast24h: 3,
        },
      }),
    ).toBe(true)
    expect(isAdminOverview({ totals: {} })).toBe(false)

    expect(
      isAdminHealth({
        ok: true,
        service: 'tutorial-backend',
        version: '2.0.0',
        time: '2026-11-19T00:00:00Z',
        uptimeSeconds: 100,
        checks: {
          db: { status: 'ok', latencyMs: 1.5, migrations: { appliedCount: 4, pendingCount: 0, latestApplied: '004' } },
          ai: { provider: 'dify', configured: true, status: 'ok' },
          notion: { configured: true, status: 'ok' },
        },
        runtime: { nodeVersion: 'v22.23.3', authAdapter: 'trusted-header', headerPreset: 'authelia', dbKind: 'postgres' },
      }),
    ).toBe(true)
    expect(isAdminHealth({ ok: true })).toBe(false)

    const summary = computeTranslationSummary(
      [{ id: 'G01', dir: 'g01', title: 'Foundation', i18n: { en: { title: 'Foundations EN' } } }],
      { '/g01/L01': { title: 'L01' }, '/g01/index': { title: 'Index' }, '/g02/L01': { title: 'Other' } },
      new Map([['G01', 10]]),
    )
    expect(summary).toEqual([
      { groupId: 'G01', dir: 'g01', title: 'Foundation', enTitle: 'Foundations EN', total: 10, translated: 1 },
    ])
  })

  it('excludes dashboard pages during production build only when auth adapter is none', () => {
    const noneMod = {
      progress: { adapter: 'local', endpoint: '/api/db', notionSync: false },
      companion: { adapter: 'off' },
      graph: { source: 'merge' },
      contentSync: { adapter: 'none' },
      auth: { adapter: 'none', sessionEndpoint: '/api/auth/session', loginUrl: '' },
    } as const
    const trustedMod = {
      ...noneMod,
      auth: { adapter: 'trusted-header', sessionEndpoint: '/api/auth/session', loginUrl: '' },
    } as const

    expect(v2DashboardExcludes(noneMod, true, {}, ['en'])).toEqual(['dashboard.md', 'en/dashboard.md'])
    expect(v2DashboardExcludes(noneMod, false, {}, ['en'])).toEqual([])
    expect(v2DashboardExcludes(noneMod, true, { LECTURE_DASHBOARD_BUILD: '1' }, ['en'])).toEqual([])
    expect(v2DashboardExcludes(trustedMod, true, {}, ['en'])).toEqual([])
  })

  it('enforces loopback + CSRF token and never returns secret plaintext from dashboardDevPlugin', async () => {
    const handler = createDashboardDevHandler({ token: 'test-dev-token' })

    const invoke = (opts: {
      method: string
      url: string
      remoteAddress?: string
      headers?: Record<string, string>
      body?: string
    }) =>
      new Promise<{ status: number; body: string; passedThrough: boolean }>((resolve) => {
        const req = new EventEmitter() as IncomingMessage
        req.method = opts.method
        req.url = opts.url
        req.headers = { host: '127.0.0.1', ...(opts.headers ?? {}) }
        req.socket = { remoteAddress: opts.remoteAddress ?? '127.0.0.1' } as IncomingMessage['socket']

        let status = 200
        let raw = ''
        const res = {
          writeHead(code: number) {
            status = code
            return this
          },
          end(chunk?: string) {
            if (chunk) raw += String(chunk)
            resolve({ status, body: raw, passedThrough: false })
          },
        } as unknown as ServerResponse

        void handler(req, res, () => resolve({ status: 0, body: '', passedThrough: true }))
        process.nextTick(() => {
          if (opts.body) req.emit('data', Buffer.from(opts.body, 'utf8'))
          req.emit('end')
        })
      })

    // Non-loopback blocked
    const nonLocal = await invoke({ method: 'GET', url: '/__lecture/api/status', remoteAddress: '10.0.0.5' })
    expect(nonLocal.status).toBe(403)

    // Non-loopback Host blocked
    const badHost = await invoke({
      method: 'GET',
      url: '/__lecture/api/status',
      headers: { host: 'evil.com' },
    })
    expect(badHost.status).toBe(403)
    expect(JSON.parse(badHost.body)).toEqual({ ok: false, error: 'invalid_host' })

    // Non-loopback Origin blocked
    const badOrigin = await invoke({
      method: 'GET',
      url: '/__lecture/api/status',
      headers: { host: 'localhost:5173', origin: 'http://evil.com' },
    })
    expect(badOrigin.status).toBe(403)
    expect(JSON.parse(badOrigin.body)).toEqual({ ok: false, error: 'invalid_origin' })

    // Valid loopback Host & Origin allowed
    const okOrigin = await invoke({
      method: 'GET',
      url: '/__lecture/api/status',
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
    })
    expect(okOrigin.status).toBe(200)

    const okIpv6 = await invoke({
      method: 'GET',
      url: '/__lecture/api/status',
      headers: { host: '[::1]:5173', origin: 'http://[::1]:5173' },
    })
    expect(okIpv6.status).toBe(200)

    // Loopback status returns sanitized settings (no secret plaintext) and CSRF token
    const okStatus = await invoke({ method: 'GET', url: '/__lecture/api/status', remoteAddress: '127.0.0.1' })
    expect(okStatus.status).toBe(200)
    const parsed = JSON.parse(okStatus.body) as { mode: string; csrfToken: string; settings: Array<{ key: string; kind: string }> }
    expect(parsed.mode).toBe('dev')
    expect(parsed.csrfToken).toBe('test-dev-token')
    expect(parsed.settings.some((s) => s.kind === 'secret')).toBe(true)

    // Missing CSRF token on POST blocked
    const noToken = await invoke({
      method: 'POST',
      url: '/__lecture/api/env',
      body: JSON.stringify({ key: 'DEPLOY_PORT', value: '22' }),
    })
    expect(noToken.status).toBe(403)

    // Built dist checks (if dist exists, verify zero /__lecture/api or secret key leakage)
    const distDir = path.resolve(__dirname, '../../docs/.vitepress/dist')
    if (fs.existsSync(path.join(distDir, 'dashboard.html'))) {
      const secretKeys = SETTINGS.filter((s) => s.kind === 'secret').map((s) => s.key)
      const assetsDir = path.join(distDir, 'assets')
      const files = fs.existsSync(assetsDir)
        ? fs
            .readdirSync(assetsDir, { recursive: true, withFileTypes: true })
            .filter((d) => d.isFile() && /\.(?:js|css|html)$/.test(d.name))
            .map((d) => path.join(d.parentPath || assetsDir, d.name))
        : []
      files.push(path.join(distDir, 'dashboard.html'))
      for (const file of files) {
        const txt = fs.readFileSync(file, 'utf8')
        expect(txt, file).not.toContain('/__lecture/api')
        for (const sk of secretKeys) {
          expect(txt, `${file} contains ${sk}`).not.toContain(sk)
        }
      }
    }
  }, 30_000) // spins up the dev middleware and real config files: ~0.5 s alone, much slower when the suite runs in parallel
})
