// @vitest-environment happy-dom
/**
 * site/tests/unit/dashboard-rbac-online.test.ts — WP-5 RBAC Online Integration Tests:
 *   a) reader role: shows personal tabs only, 0 /api/admin/* calls, hash block redirects, readonly="0"
 *   b) author role: shows personal + content tabs, system tabs blocked
 *   c) admin role: all 13 tabs, overview/health load, non-blocking rebuild banner, PageBackup full workflow
 *   d) hybrid gateway bypass: Authelia header pass lands directly in dashboard
 *   e) unauthenticated login lifecycle: login -> authenticated -> logout -> login
 */
import { ref } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

enableAutoUnmount(afterEach)

const mockLang = ref('zh-CN')
const mockIsDark = ref(false)
const mockTheme = ref({
  groups: [
    { id: 'G01', dir: 'G01', title: 'Group 1', lectureCount: 2, chartCount: 1 },
  ],
  totals: { lectures: 2, charts: 1 },
  siteMeta: {
    name: 'Site ZH',
    shortName: 'Site',
    text: 'Nav ZH',
    tagline: 'Tag ZH',
    description: 'Desc {lectures}',
    i18n: { en: { name: 'Site EN', shortName: 'Site', text: 'Nav EN', tagline: 'Tag EN', description: 'Desc {lectures}' } },
  },
  lectureModules: {
    auth: {
      adapter: 'hybrid',
      loginUrl: '/auth/login',
    },
  },
})

vi.mock('vitepress', () => ({
  useData: () => ({
    lang: mockLang,
    isDark: mockIsDark,
    theme: mockTheme,
    site: ref({ base: '/' }),
  }),
  withBase: (p: string) => p,
}))

vi.mock('virtual:lecture-theme', () => ({
  THEME_RUNTIME: {
    defaultTheme: 'reader',
    themes: [{ id: 'reader', label: 'Reader', tints: ['paper', 'sepia', 'dark'] }],
  },
}))

import { fetchAdminHealth, fetchAdminOverview, setApiOrigin } from '../../docs/.vitepress/theme/api/admin'
import type { AuthMethodInfo, AuthStatus } from '../../docs/.vitepress/theme/api/auth'
import { currentSession, resetSession, subscribeSession } from '../../docs/.vitepress/theme/auth/session'
import DashboardLogin from '../../docs/.vitepress/theme/dashboard/DashboardLogin.vue'
import DashboardPage from '../../docs/.vitepress/theme/dashboard/DashboardPage.vue'
import CompanionTools from '../../docs/.vitepress/theme/dashboard/pages/CompanionTools.vue'
import PageAccess from '../../docs/.vitepress/theme/dashboard/pages/PageAccess.vue'
import PageBackup from '../../docs/.vitepress/theme/dashboard/pages/PageBackup.vue'
import PageLook from '../../docs/.vitepress/theme/dashboard/pages/PageLook.vue'
import PageTexts from '../../docs/.vitepress/theme/dashboard/pages/PageTexts.vue'
import {
  clearRebuildRequired,
  dashboardState,
  resetAuthState,
} from '../../docs/.vitepress/theme/dashboard/useDashboard'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('WP-5 RBAC Online Dashboard Suite', () => {
  const fetchCalls: Array<{ url: string; method: string; body?: unknown }> = []
  let currentAuthStatus: AuthStatus
  let currentAuthMethods: AuthMethodInfo[]

  beforeAll(() => {
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function () {
        this.open = true
      }
    }
    if (!HTMLDialogElement.prototype.close) {
      HTMLDialogElement.prototype.close = function () {
        this.open = false
      }
    }
    if (!window.scrollTo) {
      window.scrollTo = vi.fn()
    }
  })

  beforeEach(() => {
    fetchCalls.length = 0
    mockLang.value = 'zh-CN'
    window.location.hash = ''
    setApiOrigin('')
    resetSession()
    resetAuthState()
    clearRebuildRequired()
    dashboardState.mode = 'loading'
    dashboardState.page = 'overview'
    dashboardState.toast = ''

    currentAuthStatus = {
      authAdapter: 'hybrid',
      authenticated: true,
      needsBootstrap: false,
      authSource: 'session',
      authMethod: 'password',
      rememberMe: true,
      user: { id: 'u-admin', name: 'Site Admin', email: 'admin@example.com' },
      roles: ['admin'],
      groups: ['staff'],
      canAccessAdmin: true,
      canAccessAuthor: true,
      visibleSections: [],
    }

    currentAuthMethods = [
      { id: 'password', name: 'Password', description: 'Local password', enabled: true, implemented: true, extensible: false },
      { id: 'passkey', name: 'Passkey', description: 'WebAuthn passkey', enabled: true, implemented: true, extensible: false },
    ]

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method?.toUpperCase() ?? 'GET'
        let body: unknown
        if (init?.body && typeof init.body === 'string') {
          try {
            body = JSON.parse(init.body)
          } catch {
            body = init.body
          }
        }
        fetchCalls.push({ url, method, body })

        // Dev loopback status check -> return 404 so DashboardPage treats environment as online
        if (url.includes('/__lecture/api/status')) {
          return new Response(null, { status: 404 })
        }

        // Auth status & methods
        if (url.endsWith('/api/auth/status')) {
          return jsonResponse(currentAuthStatus)
        }
        if (url.endsWith('/api/auth/methods')) {
          return jsonResponse({ ok: true, methods: currentAuthMethods })
        }
        if (url.endsWith('/api/auth/logout')) {
          currentAuthStatus = {
            authAdapter: 'hybrid',
            authenticated: false,
            needsBootstrap: false,
            authSource: 'none',
            authMethod: 'none',
            rememberMe: false,
            user: null,
            roles: [],
            groups: [],
            canAccessAdmin: false,
            canAccessAuthor: false,
            visibleSections: [],
          }
          return jsonResponse({ ok: true, logoutUrl: null })
        }

        // Me endpoints
        if (url.includes('/api/me/overview')) {
          return jsonResponse({
            ok: true,
            user: {
              id: currentAuthStatus.user?.id || 'u-1',
              username: currentAuthStatus.user?.name || 'user',
              displayName: currentAuthStatus.user?.name || 'User',
              email: currentAuthStatus.user?.email || null,
            },
            progress: {
              total: 10,
              completed: 3,
              in_progress: 2,
            },
            recentSessions: [],
            checklists: {
              total: 5,
              completed: 2,
            },
            passkeyCount: 0,
            currentSessionId: 'sess-1',
            authMethod: currentAuthStatus.authMethod,
            rememberMe: currentAuthStatus.rememberMe,
          })
        }
        if (url.includes('/api/me/sessions')) {
          return jsonResponse([])
        }
        if (url.includes('/api/me/credentials')) {
          return jsonResponse([])
        }

        // Admin endpoints
        if (url.includes('/api/admin/overview')) {
          return jsonResponse({
            generatedAt: new Date().toISOString(),
            totals: {
              users: 4,
              progressRows: 12,
              completedLectures: 5,
              sessions: 3,
              messages: 10,
              checklistItems: 6,
              completedChecklistItems: 2,
            },
            byStatus: { 未开始: 3, 学习中: 4, 已完成: 5 },
            byGroup: [{ group_id: 'G01', total_rows: 2, completed: 1, in_progress: 1, not_started: 0 }],
            recentActivity: {
              progressUpdatedLast24h: 2,
              sessionsCreatedLast24h: 1,
              messagesLast24h: 4,
            },
          })
        }
        if (url.includes('/api/admin/health')) {
          return jsonResponse({
            ok: true,
            service: 'lecture-api',
            version: '2026.11.21',
            time: new Date().toISOString(),
            uptimeSeconds: 3600,
            runtime: {
              nodeVersion: 'v22.0.0',
              authAdapter: 'hybrid',
              headerPreset: 'authelia',
              dbKind: 'pglite',
            },
            checks: {
              db: { status: 'ok', latencyMs: 1, migrations: { appliedCount: 3, pendingCount: 0, latestApplied: '0003' } },
              ai: { provider: 'openai', configured: true, status: 'ok' },
              notion: { configured: false, status: 'off' },
            },
          })
        }
        if (url.includes('/api/admin/ai-tools')) {
          if (method === 'PUT') {
            return jsonResponse({
              ok: true,
              persistence: { mode: 'db+disk', effect: 'live' },
              mcpEndpoint: { enabled: false, path: '/api/mcp' },
              engineTools: [
                { name: 'search_concepts', enabled: false, calls7d: 3, errors7d: 0 },
                { name: 'get_concept', enabled: true, calls7d: 1, errors7d: 0 },
              ],
              mcpServers: [],
              settings: {
                provider: 'openai',
                maxSteps: 4,
                timeoutMs: 9000,
                maxResultBytes: 18000,
                mcpTokenSet: true,
                ticketSecretSet: true,
                source: 'server/.env',
              },
              statsSource: 'memory',
              toolCallCounts7d: { search_concepts: { calls: 3, errors: 0 } },
            })
          }
          return jsonResponse({
            mcpEndpoint: { enabled: false, path: '/api/mcp' },
            engineTools: [
              { name: 'search_concepts', enabled: true, calls7d: 3, errors7d: 0 },
              { name: 'get_concept', enabled: true, calls7d: 1, errors7d: 0 },
            ],
            mcpServers: [
              {
                id: 'docs',
                name: 'Docs MCP',
                host: 'mcp.example.com',
                enabled: true,
                connectionState: 'connected',
                tools: [{ name: 'lookup', enabled: true, calls7d: 2, errors7d: 0 }],
              },
            ],
            settings: {
              provider: 'openai',
              maxSteps: 4,
              timeoutMs: 9000,
              maxResultBytes: 18000,
              mcpTokenSet: true,
              ticketSecretSet: true,
              source: 'server/.env',
            },
            statsSource: 'memory',
            toolCallCounts7d: { search_concepts: { calls: 3, errors: 0 } },
          })
        }
        if (url.includes('/api/admin/texts')) {
          if (method === 'PUT') {
            return jsonResponse({
              ok: true,
              texts: (body as { texts?: unknown })?.texts ?? {},
              persistence: {
                mode: 'db+disk',
                effect: 'rebuild_required',
                rebuildReason: 'Site text changes require a site rebuild to take effect in static pages',
              },
            })
          }
          return jsonResponse({
            ok: true,
            texts: {
              zh: { name: 'Site ZH', shortName: 'Site', navText: 'Nav ZH', tagline: 'Tag ZH', description: 'Desc {lectures}' },
              en: { name: 'Site EN', shortName: 'Site', navText: 'Nav EN', tagline: 'Tag EN', description: 'Desc {lectures}' },
            },
          })
        }
        if (url.includes('/api/admin/access')) {
          if (method === 'PUT') {
            return jsonResponse({
              ok: true,
              access: (body as { access?: unknown })?.access ?? {},
              persistence: {
                mode: 'db+disk',
                effect: 'rebuild_required',
                rebuildReason: 'Changes to access tiers require a site rebuild to take effect in static pages',
              },
            })
          }
          return jsonResponse({
            ok: true,
            access: { default: 'public', enforcement: 'gateway', groups: { G01: { read: 'authenticated' } } },
          })
        }
        if (url.includes('/api/admin/db/config')) {
          return jsonResponse({
            ok: true,
            kind: 'pglite',
            databaseUrl: 'pglite:./data/pglite',
            databaseUrlDirect: null,
            migrations: { applied: 3, total: 3, pending: 0 },
          })
        }
        if (url.includes('/api/admin/db/tables') && url.includes('/rows')) {
          return jsonResponse({
            ok: true,
            table: 'site_settings',
            rows: [],
            total: 0,
            limit: 25,
            offset: 0,
            sort: 'key',
            order: 'asc',
          })
        }
        if (url.includes('/api/admin/db/tables')) {
          return jsonResponse({ ok: true, tables: [] })
        }
        if (url.includes('/api/admin/look')) {
          if (method === 'PUT') {
            return jsonResponse({
              ok: true,
              look: (body as { look?: unknown })?.look ?? { skin: 'datasheet', base: 'sepia', custom: '#EAF2E3' },
              persistence: {
                mode: 'db+disk',
                effect: 'rebuild_required',
                rebuildReason: 'Theme and style changes require a site rebuild to take effect in static pages',
              },
            })
          }
          return jsonResponse({
            ok: true,
            look: { skin: 'reader', base: 'paper', custom: '#EAF2E3' },
          })
        }
        if (url.includes('/api/admin/backups/restore')) {
          const reqBody = (body as { filename?: string; dryRun?: boolean }) || {}
          return jsonResponse({
            ok: true,
            dryRun: reqBody.dryRun !== false,
            filename: reqBody.filename || 'mock-backup.json.gz',
            verifiedChecksum: true,
            tableCounts: {
              site_settings: 5,
              progress: 12,
              auth_users_public: 3,
            },
            message: 'Backup archive verified successfully',
          })
        }
        if (url.includes('/api/admin/backups')) {
          if (method === 'POST') {
            return jsonResponse(
              {
                ok: true,
                snapshot: {
                  filename: 'lecture-api-backup-20261124-new123.json.gz',
                  checksumFilename: 'lecture-api-backup-20261124-new123.json.gz.sha256',
                  sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
                  sizeBytes: 4096,
                  tableCounts: { site_settings: 5, progress: 12 },
                  createdAt: new Date().toISOString(),
                },
              },
              201,
            )
          }
          return jsonResponse({
            ok: true,
            backupDir: '/var/data/backups',
            backups: [
              {
                filename: 'lecture-api-backup-20261124-0001.json.gz',
                sizeBytes: 2048,
                sha256: '9876543210abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                createdAt: new Date(Date.now() - 3600000).toISOString(),
              },
            ],
          })
        }

        return jsonResponse({ ok: true })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // ── a) reader role ──────────────────────────────────────────────────────────
  it('a) reader role: shows personal tabs only, 0 /api/admin/* calls, hash block redirects, readonly="0"', async () => {
    currentAuthStatus = {
      authAdapter: 'hybrid',
      authenticated: true,
      needsBootstrap: false,
      authSource: 'session',
      authMethod: 'password',
      rememberMe: false,
      user: { id: 'reader-1', name: 'Reader Alice', email: 'alice@example.com' },
      roles: ['reader'],
      groups: [],
      canAccessAdmin: false,
      canAccessAuthor: false,
      visibleSections: [],
    }

    const wrapper = mount(DashboardPage)
    await flushPromises()

    // 1. Visible tabs: ONLY 'my-learning' and 'account'
    const navTabs = wrapper.findAll('[data-dashboard-tab]').map((w) => w.attributes('data-dashboard-tab'))
    expect(navTabs).toEqual(['my-learning', 'account'])
    expect(dashboardState.page).toBe('my-learning')

    // 2. Makes 0 calls to /api/admin/*
    const adminCalls = fetchCalls.filter((c) => c.url.includes('/api/admin/'))
    expect(adminCalls).toHaveLength(0)

    // 3. data-dashboard-readonly="0" on personal pages
    const root = wrapper.find('.lec-dashboard')
    expect(root.attributes('data-dashboard-readonly')).toBe('0')

    // 4. Direct hash #database / #users / #access / #overview redirects back to my-learning with forbidden toast
    const forbiddenHashes = ['#database', '#users', '#access', '#overview']
    for (const h of forbiddenHashes) {
      window.location.hash = h
      window.dispatchEvent(new Event('hashchange'))
      await flushPromises()

      expect(dashboardState.page).toBe('my-learning')
      expect(dashboardState.toast).toBeTruthy()
      expect(wrapper.find('[data-dashboard-toast]').text()).toBeTruthy()
    }
  })

  // ── b) author role ──────────────────────────────────────────────────────────
  it('b) author role: shows personal + content tabs, system tabs blocked', async () => {
    currentAuthStatus = {
      authAdapter: 'hybrid',
      authenticated: true,
      needsBootstrap: false,
      authSource: 'session',
      authMethod: 'password',
      rememberMe: false,
      user: { id: 'author-1', name: 'Author Bob', email: 'bob@example.com' },
      roles: ['reader', 'author'],
      groups: ['authors'],
      canAccessAdmin: false,
      canAccessAuthor: true,
      visibleSections: [],
    }

    const wrapper = mount(DashboardPage)
    await flushPromises()

    // Shows my-learning, account, overview, checks, figures, texts, companion
    const navTabs = wrapper.findAll('[data-dashboard-tab]').map((w) => w.attributes('data-dashboard-tab'))
    expect(navTabs).toEqual(['my-learning', 'account', 'overview', 'checks', 'figures', 'texts', 'companion'])
    expect(fetchCalls.some((c) => c.url.includes('/api/admin/overview'))).toBe(true)
    expect(fetchCalls.some((c) => c.url.includes('/api/admin/health'))).toBe(false)

    // #database, #users, #access, #look, #backup blocked
    for (const blocked of ['#database', '#users', '#access', '#look', '#backup']) {
      window.location.hash = blocked
      window.dispatchEvent(new Event('hashchange'))
      await flushPromises()

      expect(dashboardState.page).toBe('my-learning')
      expect(dashboardState.toast).toBeTruthy()
    }

    // Per-page write guard: mounting PageTexts while global dashboardState.page is still 'my-learning'
    // still allows online author editing & triggers PUT /api/admin/texts -> rebuild_required notice
    const textsWrapper = mount(PageTexts, { props: { texts: null } })
    await flushPromises()
    const zhNameInput = textsWrapper.find<HTMLInputElement>('[data-texts-input="zh.name"]')
    expect(zhNameInput.exists()).toBe(true)
    await zhNameInput.setValue('Author Updated ZH')
    await textsWrapper.find('[data-texts-save-btn]').trigger('click')
    await flushPromises()
    expect(fetchCalls.some((c) => c.url.endsWith('/api/admin/texts') && c.method === 'PUT')).toBe(true)
    expect(dashboardState.rebuildRequired).toBe(true)

    // Mounting PageLook & PageBackup as online author stays strictly read-only without admin API fetches
    const lookWrapper = mount(PageLook, { props: { status: null } })
    await flushPromises()
    expect(lookWrapper.find('[data-savebar="look"]').exists()).toBe(false)

    const beforeBackupCalls = fetchCalls.length
    const bkAuthorWrapper = mount(PageBackup)
    await flushPromises()
    expect(bkAuthorWrapper.find('[data-backup-create]').exists()).toBe(false)
    expect(fetchCalls.slice(beforeBackupCalls).some((c) => c.url.includes('/api/admin/backups'))).toBe(false)
  })

  // ── c) admin role online ────────────────────────────────────────────────────
  it('c) admin role online: data-dashboard-readonly="0", 13 tabs, rebuild badge non-blocking & dismiss, PageBackup verify', async () => {
    currentAuthStatus = {
      authAdapter: 'hybrid',
      authenticated: true,
      needsBootstrap: false,
      authSource: 'session',
      authMethod: 'password',
      rememberMe: true,
      user: { id: 'admin-1', name: 'Admin Carol', email: 'carol@example.com' },
      roles: ['admin'],
      groups: ['superusers'],
      canAccessAdmin: true,
      canAccessAuthor: true,
      visibleSections: [],
    }

    const wrapper = mount(DashboardPage)
    await flushPromises()

    // 1. data-dashboard-readonly="0"
    expect(wrapper.find('.lec-dashboard').attributes('data-dashboard-readonly')).toBe('0')

    // 2. All 13 tabs visible
    const navTabs = wrapper.findAll('[data-dashboard-tab]').map((w) => w.attributes('data-dashboard-tab'))
    expect(navTabs).toHaveLength(13)
    expect(navTabs).toEqual([
      'my-learning',
      'account',
      'overview',
      'checks',
      'figures',
      'texts',
      'companion',
      'access',
      'look',
      'database',
      'users',
      'runtime',
      'backup',
    ])

    // 3. Loads overview and health with valid response shapes
    const ovCall = fetchCalls.find((c) => c.url.includes('/api/admin/overview'))
    const hlCall = fetchCalls.find((c) => c.url.includes('/api/admin/health'))
    expect(ovCall).toBeDefined()
    expect(hlCall).toBeDefined()
    expect(wrapper.find('[data-admin-overview]').exists()).toBe(true)
    expect(wrapper.find('[data-todo="admin-error"]').exists()).toBe(false)

    // 4. Persistence rebuild badge triggered end-to-end by PageLook PUT /api/admin/look
    expect(wrapper.find('[data-dashboard-rebuild-badge]').exists()).toBe(false)
    const lookAdminWrapper = mount(PageLook, { props: { status: null } })
    await flushPromises()
    await lookAdminWrapper.find('[data-skin="datasheet"]').trigger('click')
    await lookAdminWrapper.find('[data-base="sepia"]').trigger('click')
    await lookAdminWrapper.find('[data-look-save]').trigger('click')
    await flushPromises()
    expect(
      fetchCalls.some(
        (c) =>
          c.url.endsWith('/api/admin/look') &&
          c.method === 'PUT' &&
          (c.body as { look?: { skin?: string; base?: string } })?.look?.skin === 'datasheet',
      ),
    ).toBe(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-dashboard-rebuild-badge]').exists()).toBe(true)

    // Non-blocking dismiss works
    const dismissBtn = wrapper.find('[data-dashboard-rebuild-dismiss]')
    expect(dismissBtn.exists()).toBe(true)
    await dismissBtn.trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-dashboard-rebuild-badge]').exists()).toBe(false)

    // 4b. CompanionTools uses live /api/admin/ai-tools settings & PUT toggle (no add/delete/fake URLs)
    const toolsWrapper = mount(CompanionTools)
    await flushPromises()
    expect(toolsWrapper.find('[data-tools-online-note]').exists()).toBe(true)
    expect(toolsWrapper.find('[data-add-server-btn]').exists()).toBe(false)
    expect(toolsWrapper.find('[data-server-delete]').exists()).toBe(false)
    expect(toolsWrapper.text()).toContain('mcp.example.com')
    expect(toolsWrapper.text()).not.toContain('https://mcp.example.com')
    await toolsWrapper.find('[data-tool-switch="search_concepts"]').trigger('click')
    await toolsWrapper.find('[data-tools-save]').trigger('click')
    await flushPromises()
    expect(fetchCalls.some((c) => c.url.endsWith('/api/admin/ai-tools') && c.method === 'PUT')).toBe(true)

    // 4c. PageAccess saves access config and triggers rebuild_required badge
    const accessWrapper = mount(PageAccess, { props: { access: null, autheliaPreview: '' } })
    await flushPromises()
    await accessWrapper.find('[data-tpopen="G01"]').trigger('click')
    await accessWrapper.find('[data-tpv="public"]').trigger('click')
    await accessWrapper.find('[data-access-save-btn]').trigger('click')
    await flushPromises()
    expect(fetchCalls.some((c) => c.url.endsWith('/api/admin/access') && c.method === 'PUT')).toBe(true)
    expect(dashboardState.rebuildRequired).toBe(true)

    // 5. PageBackup component workflow
    const backupWrapper = mount(PageBackup)
    await flushPromises()

    // Auto-loaded backup archives
    expect(backupWrapper.find('[data-backup-facts]').exists()).toBe(true)
    expect(backupWrapper.find('[data-backup-row="lecture-api-backup-20261124-0001.json.gz"]').exists()).toBe(true)

    // Create backup
    const createBtn = backupWrapper.find('[data-backup-create]')
    expect(createBtn.exists()).toBe(true)
    await createBtn.trigger('click')
    await flushPromises()

    const postBackup = fetchCalls.find((c) => c.url.endsWith('/api/admin/backups') && c.method === 'POST')
    expect(postBackup).toBeDefined()
    expect(backupWrapper.find('[data-backup-status]').exists()).toBe(true)

    // Dry-run verify
    const dryRunBtn = backupWrapper.find('[data-backup-dryrun="lecture-api-backup-20261124-0001.json.gz"]')
    expect(dryRunBtn.exists()).toBe(true)
    await dryRunBtn.trigger('click')
    await flushPromises()

    const dryRunResult = backupWrapper.find('[data-backup-result]')
    expect(dryRunResult.exists()).toBe(true)
    expect(dryRunResult.text()).toContain('lecture-api-backup-20261124-0001.json.gz')
    expect(dryRunResult.text()).toContain('site_settings: 5')

    // 2-step confirm restore
    const restoreBtn = backupWrapper.find('[data-backup-restore="lecture-api-backup-20261124-0001.json.gz"]')
    expect(restoreBtn.exists()).toBe(true)
    await restoreBtn.trigger('click')
    await flushPromises()

    const confirmContainer = backupWrapper.find('[data-backup-restore-confirm]')
    expect(confirmContainer.exists()).toBe(true)

    const confirmBtn = backupWrapper.find('[data-backup-confirm-restore="lecture-api-backup-20261124-0001.json.gz"]')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')
    await flushPromises()

    const liveRestoreCall = fetchCalls.find(
      (c) =>
        c.url.endsWith('/api/admin/backups/restore') &&
        c.method === 'POST' &&
        (c.body as { dryRun?: boolean })?.dryRun === false,
    )
    expect(liveRestoreCall).toBeDefined()
  })

  // ── d) AUTH_ADAPTER=hybrid Authelia header bypass ───────────────────────────
  it('d) AUTH_ADAPTER=hybrid gateway bypass lands directly in Dashboard without DashboardLogin', async () => {
    currentAuthStatus = {
      authAdapter: 'hybrid',
      authenticated: true,
      needsBootstrap: false,
      authSource: 'gateway',
      authMethod: 'gateway',
      rememberMe: false,
      user: { id: 'authelia-user', name: 'Authelia User', email: 'authelia@example.com' },
      roles: ['author', 'reader'],
      groups: ['engineers'],
      canAccessAdmin: false,
      canAccessAuthor: true,
      visibleSections: [],
    }

    const wrapper = mount(DashboardPage)
    await flushPromises()

    expect(wrapper.findComponent(DashboardLogin).exists()).toBe(false)
    expect(wrapper.find('.db-shell').exists()).toBe(true)
    expect(wrapper.find('.db-brand').exists()).toBe(true)
  })

  // ── e) Unauthenticated login and logout lifecycle ───────────────────────────
  it('e) unauthenticated renders DashboardLogin, @authenticated transitions, logout returns', async () => {
    currentAuthStatus = {
      authAdapter: 'hybrid',
      authenticated: false,
      needsBootstrap: true,
      authSource: 'none',
      authMethod: 'none',
      rememberMe: false,
      user: null,
      roles: [],
      groups: [],
      canAccessAdmin: false,
      canAccessAuthor: false,
      visibleSections: [],
    }

    const wrapper = mount(DashboardPage)
    await flushPromises()

    // 1. Renders DashboardLogin
    expect(wrapper.findComponent(DashboardLogin).exists()).toBe(true)
    expect(wrapper.find('.db-shell').exists()).toBe(false)

    // 2. Submitting @authenticated transitions to allowed Dashboard
    currentAuthStatus = {
      authAdapter: 'hybrid',
      authenticated: true,
      needsBootstrap: false,
      authSource: 'local',
      authMethod: 'password',
      rememberMe: true,
      user: { id: 'logged-in-admin', name: 'Logged Admin', email: 'admin@local' },
      roles: ['admin'],
      groups: [],
      canAccessAdmin: true,
      canAccessAuthor: true,
      visibleSections: [],
    }

    const loginCmp = wrapper.findComponent(DashboardLogin)
    loginCmp.vm.$emit('authenticated')
    await flushPromises()

    expect(wrapper.find('.db-shell').exists()).toBe(true)
    expect(wrapper.findComponent(DashboardLogin).exists()).toBe(false)

    // Navigate admin to #database, then click [data-dashboard-logout] -> hash is cleared and DashboardLogin renders
    window.location.hash = '#database'
    window.dispatchEvent(new Event('hashchange'))
    await flushPromises()
    expect(dashboardState.page).toBe('database')

    const logoutBtn = wrapper.find('[data-dashboard-logout]')
    expect(logoutBtn.exists()).toBe(true)
    await logoutBtn.trigger('click')
    await flushPromises()

    expect(wrapper.findComponent(DashboardLogin).exists()).toBe(true)
    expect(wrapper.find('.db-shell').exists()).toBe(false)
    expect(window.location.hash).toBe('')
  })

  // ── f) Blind-audit regressions: session sync, hybrid gateway logout, split-origin overview/health ──
  it('f) syncs session.ts listeners on login/logout, keeps hybrid gateway user signed in, and honors setApiOrigin on overview/health', async () => {
    const seenStatuses: string[] = []
    const unsub = subscribeSession((s) => {
      seenStatuses.push(s.status === 'authenticated' ? `auth:${s.user.id}` : s.status)
    })
    try {
      currentAuthStatus = {
        authAdapter: 'hybrid',
        authenticated: false,
        needsBootstrap: false,
        authSource: 'none',
        authMethod: 'none',
        rememberMe: false,
        user: null,
        roles: [],
        groups: [],
        canAccessAdmin: false,
        canAccessAuthor: false,
        visibleSections: [],
      }

      const wrapper = mount(DashboardPage)
      await flushPromises()
      expect(seenStatuses).toContain('anonymous')
      expect(currentSession().status).toBe('anonymous')

      currentAuthStatus = {
        authAdapter: 'hybrid',
        authenticated: true,
        needsBootstrap: false,
        authSource: 'gateway',
        authMethod: 'gateway',
        rememberMe: false,
        user: { id: 'gw-admin', name: 'Gateway Admin', email: 'gw@example.com' },
        roles: ['reader', 'admin'],
        groups: ['admins'],
        canAccessAdmin: true,
        canAccessAuthor: true,
        visibleSections: ['my-learning', 'account', 'overview'],
      }
      wrapper.findComponent(DashboardLogin).vm.$emit('authenticated')
      await flushPromises()
      expect(currentSession()).toMatchObject({ status: 'authenticated', user: { id: 'gw-admin' } })
      expect(seenStatuses).toContain('auth:gw-admin')

      // Gateway user clicking logout when Remote-User headers remain active stays in Dashboard (not trapped in signin)
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input.toString()
          if (url.endsWith('/api/auth/logout')) return jsonResponse({ ok: true, logoutUrl: null })
          if (url.endsWith('/api/auth/status')) return jsonResponse(currentAuthStatus)
          if (url.includes('/api/admin/overview')) {
            return jsonResponse({
              generatedAt: '2026-11-24T00:00:00.000Z',
              totals: { users: 1, progressRows: 0, completedLectures: 0, sessions: 0, messages: 0, checklistItems: 0, completedChecklistItems: 0 },
              byStatus: {},
              byGroup: [],
              recentActivity: {},
            })
          }
          if (url.includes('/api/admin/health')) {
            return jsonResponse({
              ok: true,
              service: 'lecture-api',
              checks: { db: { status: 'ok' }, ai: { status: 'off', provider: 'off' }, notion: { configured: false, status: 'off' } },
              runtime: { dbKind: 'pglite' },
            })
          }
          return jsonResponse({ ok: true })
        }),
      )
      await wrapper.find('[data-dashboard-logout]').trigger('click')
      await flushPromises()
      expect(wrapper.findComponent(DashboardLogin).exists()).toBe(false)
      expect(wrapper.find('.db-shell').exists()).toBe(true)

      // Split-origin setApiOrigin applied to fetchAdminOverview and fetchAdminHealth with credentials: 'include'
      const seenReq: Array<{ url: string; credentials?: RequestCredentials }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString()
          seenReq.push({ url, credentials: init?.credentials })
          if (url.includes('/api/admin/overview')) {
            return jsonResponse({
              generatedAt: '2026-11-24T00:00:00.000Z',
              totals: { users: 1, progressRows: 0, completedLectures: 0, sessions: 0, messages: 0, checklistItems: 0, completedChecklistItems: 0 },
              byStatus: {},
              byGroup: [],
              recentActivity: {},
            })
          }
          return jsonResponse({
            ok: true,
            service: 'lecture-api',
            checks: { db: { status: 'ok' }, ai: { status: 'off', provider: 'off' }, notion: { configured: false, status: 'off' } },
            runtime: { dbKind: 'pglite' },
          })
        }),
      )
      setApiOrigin('https://api.example.com')
      const ovRes = await fetchAdminOverview()
      const hlRes = await fetchAdminHealth()
      expect(ovRes.ok).toBe(true)
      expect(hlRes.ok).toBe(true)
      expect(seenReq).toEqual([
        { url: 'https://api.example.com/api/admin/overview', credentials: 'include' },
        { url: 'https://api.example.com/api/admin/health', credentials: 'include' },
      ])
    } finally {
      setApiOrigin('')
      unsub()
    }
  })

  it('d) visibleSections from authStatus drives navigation tabs directly', async () => {
    const currentAuthStatus = {
      authAdapter: 'hybrid',
      authenticated: true,
      needsBootstrap: false,
      authSource: 'session',
      authMethod: 'password',
      rememberMe: false,
      user: { id: 'custom-user', name: 'Custom Section User', email: 'custom@example.com' },
      roles: ['reader', 'author', 'admin'],
      groups: [],
      canAccessAdmin: true,
      canAccessAuthor: true,
      visibleSections: ['my-learning', 'overview', 'figures'],
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/auth/status')) return jsonResponse(currentAuthStatus)
        if (url.includes('/api/admin/overview')) {
          return jsonResponse({
            generatedAt: '2026-11-24T00:00:00.000Z',
            totals: { users: 1, progressRows: 0, completedLectures: 0, sessions: 0, messages: 0, checklistItems: 0, completedChecklistItems: 0 },
            byStatus: {},
            byGroup: [],
            recentActivity: {},
          })
        }
        return jsonResponse({ ok: true })
      }),
    )

    const wrapper = mount(DashboardPage)
    await flushPromises()

    const navTabs = wrapper.findAll('[data-dashboard-tab]').map((w) => w.attributes('data-dashboard-tab'))
    expect(navTabs).toEqual(['my-learning', 'overview', 'figures'])
  })

  it('e) PageAccess refuses downgrade when server returns uninitialized_restricted and access is null', async () => {
    dashboardState.mode = 'online'
    dashboardState.canAccessAdmin = true
    dashboardState.roles = ['admin']

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/admin/access')) {
          return jsonResponse({
            ok: true,
            source: 'uninitialized_restricted',
            access: null,
          })
        }
        return jsonResponse({ ok: true })
      }),
    )

    const wrapper = mount(PageAccess, { props: { access: null, autheliaPreview: '' } })
    await flushPromises()

    expect(wrapper.find('[data-access-load-error]').exists()).toBe(true)
    expect(wrapper.find('[data-access-save-btn]').exists()).toBe(false)
  })

  it('f) DashboardLogin toggles bootstrap mode and submits setupToken when bootstrapTokenRequired is true', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/auth/bootstrap')) {
        return jsonResponse({
          ok: true,
          authenticated: true,
          user: { id: 'admin-1', username: 'tokenadmin', name: 'Token Admin', email: null },
          roles: ['reader', 'author', 'admin'],
          groups: [],
          canAccessAdmin: true,
          canAccessAuthor: true,
        }, 201)
      }
      return jsonResponse({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mount(DashboardLogin, {
      props: {
        authStatus: {
          authAdapter: 'local',
          authenticated: false,
          needsBootstrap: false,
          bootstrapTokenRequired: true,
          authSource: 'none',
          authMethod: 'anonymous',
          rememberMe: false,
          user: null,
          roles: ['reader'],
          groups: [],
          canAccessAdmin: false,
          canAccessAuthor: false,
          visibleSections: ['my-learning', 'account'],
        },
        methods: [
          {
            id: 'password',
            name: 'Password',
            description: 'Password login',
            enabled: true,
            implemented: true,
            extensible: false,
          },
        ],
      },
    })

    const toggleBtn = wrapper.find('[data-login-bootstrap-token-toggle]')
    expect(toggleBtn.exists()).toBe(true)
    expect(wrapper.find('[data-login-setup-token]').exists()).toBe(false)

    await toggleBtn.trigger('click')
    expect(wrapper.find('[data-login-setup-token]').exists()).toBe(true)

    await wrapper.find('[data-login-setup-token]').setValue('my-setup-secret')
    await wrapper.find('[data-login-username]').setValue('tokenadmin')
    await wrapper.find('[data-login-password]').setValue('Password123!')
    await wrapper.find('[data-login-confirm]').setValue('Password123!')
    await wrapper.find('[data-login-form]').trigger('submit')
    await flushPromises()

    const bootCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/auth/bootstrap'))
    expect(bootCall).toBeTruthy()
    const sentBody = JSON.parse(String(bootCall![1]?.body))
    expect(sentBody.setupToken).toBe('my-setup-secret')
    expect(sentBody.username).toBe('tokenadmin')
    expect(wrapper.emitted('authenticated')).toBeTruthy()
  })
})
