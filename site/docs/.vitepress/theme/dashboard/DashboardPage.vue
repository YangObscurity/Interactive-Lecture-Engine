<script setup lang="ts">
/**
 * DashboardPage.vue — Lecture Engine Dashboard (`/dashboard`, `/en/dashboard`).
 *
 * Two modes:
 *   - local author mode (`vitepress dev`): reads and writes through loopback `/__lecture/api/*`;
 *   - online (production): role-based RBAC (`reader`, `author`, `admin`) backed by `/api/auth/status`,
 *     `/api/me/*`, and `/api/admin/*`, with inline `DashboardLogin` when unauthenticated and hybrid
 *     gateway bypass support (`AUTH_ADAPTER=hybrid`).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import { useData } from 'vitepress'
import { useT } from '../../i18n/useT.ts'
import type { MessageKey } from '../../i18n/index.ts'
import {
  fetchAdminHealth,
  fetchAdminOverview,
  fetchDevDashboardStatus,
  type AdminHealthResponse,
  type AdminOverviewResponse,
  type DevDashboardStatus,
} from '../api/admin'
import {
  fetchAuthMethods,
  fetchAuthStatus,
  logoutSession,
  type AuthMethodInfo,
  type AuthStatus,
} from '../api/auth'
import type { DevAccessSummary } from '../api/devDashboard'
import type { SiteTexts } from '../../site-texts-schema.ts'
import { configureSession, currentSession, getSession, publishSession, resetSession, type SessionState } from '../auth/session'
import { endBodyHydration } from '../core/bodyHydration'
import './dashboard.css'
import DashboardLogin from './DashboardLogin.vue'
import DbDiff from './DbDiff.vue'
import PageAccess from './pages/PageAccess.vue'
import PageAccount from './pages/PageAccount.vue'
import PageBackup from './pages/PageBackup.vue'
import PageChecks from './pages/PageChecks.vue'
import PageCompanion from './pages/PageCompanion.vue'
import PageDatabase from './pages/PageDatabase.vue'
import PageFigures from './pages/PageFigures.vue'
import PageLook from './pages/PageLook.vue'
import PageMyLearning from './pages/PageMyLearning.vue'
import PageOverview from './pages/PageOverview.vue'
import PageRuntime from './pages/PageRuntime.vue'
import PageTexts from './pages/PageTexts.vue'
import PageUsers from './pages/PageUsers.vue'
import {
  answerAsk,
  applyAuthStatus,
  ask,
  askState,
  canAccessPage,
  checkState,
  clearRebuildRequired,
  dashboardHashOf,
  dashboardState,
  defaultLandingPage,
  dirtyModels,
  discardPage,
  isPageDirty,
  isReadOnly,
  parseDashboardHash,
  resetAuthState,
  savePage,
  say,
  visibleNavGroups,
  type DashboardPageId,
} from './useDashboard'

defineOptions({ name: 'DashboardPage' })

const { t } = useT()
const { theme } = useData<{ lectureModules?: { auth?: { adapter?: string; sessionEndpoint?: string; loginUrl?: string } } }>()

const loading = ref(true)
const ready = ref(false)
const gate = ref<'pending' | 'allowed' | 'denied' | 'signin'>('pending')
const session = ref<SessionState>({ status: 'unknown' })
const authStatus = ref<AuthStatus | null>(null)
const authMethods = ref<AuthMethodInfo[]>([])
const devStatus = ref<DevDashboardStatus | null>(null)
const overview = ref<AdminOverviewResponse | null>(null)
const health = ref<AdminHealthResponse | null>(null)
const healthError = ref('')
const dialog = ref<HTMLDialogElement | null>(null)

const authAdapter = computed(() => theme.value?.lectureModules?.auth?.adapter ?? 'none')
const devAccess = computed(() => (devStatus.value as (DevDashboardStatus & { access?: DevAccessSummary }) | null)?.access ?? null)
const devTexts = computed<SiteTexts | null>(() => devStatus.value?.texts ?? null)
const devRulesNote = computed(
  () => (devStatus.value as (DevDashboardStatus & { autheliaPreviewNote?: { code: string; detail?: string } | null }) | null)?.autheliaPreviewNote ?? null,
)

const loginHref = ref('')
function computeLoginHref(): string {
  const here = window.location.href
  const custom = theme.value?.lectureModules?.auth?.loginUrl
  return custom ? custom.replace('{rd}', encodeURIComponent(here)) : here
}

const PAGE_LABEL: Record<DashboardPageId, MessageKey> = {
  'my-learning': 'dsh.nav.myLearning',
  account: 'dsh.nav.account',
  overview: 'dsh.nav.overview',
  checks: 'dsh.nav.checks',
  figures: 'dsh.nav.figures',
  texts: 'dsh.nav.texts',
  companion: 'dsh.nav.companion',
  access: 'dsh.nav.access',
  look: 'dsh.nav.look',
  database: 'dsh.nav.database',
  users: 'dsh.nav.users',
  runtime: 'dsh.nav.runtime',
  backup: 'dsh.nav.backup',
}
const GROUP_LABEL: Record<'personal' | 'content' | 'site' | 'system', MessageKey> = {
  personal: 'dsh.nav.gPersonal',
  content: 'dsh.nav.gContent',
  site: 'dsh.nav.gSite',
  system: 'dsh.nav.gSystem',
}
const PAGES: Record<DashboardPageId, Component> = {
  'my-learning': PageMyLearning,
  account: PageAccount,
  overview: PageOverview,
  checks: PageChecks,
  figures: PageFigures,
  texts: PageTexts,
  companion: PageCompanion,
  access: PageAccess,
  look: PageLook,
  database: PageDatabase,
  users: PageUsers,
  runtime: PageRuntime,
  backup: PageBackup,
}

function navCount(p: DashboardPageId): { k: 'bad' | 'warn'; n: number; label: string } | null {
  if (p === 'checks') {
    const tot = checkState.run?.report?.totals
    if (tot?.fail) return { k: 'bad', n: tot.fail, label: t('dsh.nav.nFail', { n: tot.fail }) }
    if (tot?.warn) return { k: 'warn', n: tot.warn, label: t('dsh.nav.nWarn', { n: tot.warn }) }
  }
  if (p === 'runtime' && healthError.value) return { k: 'bad', n: 1, label: t('dsh.nav.adminError') }
  if (p === 'runtime' && health.value && !health.value.ok) return { k: 'bad', n: 1, label: t('dsh.nav.healthBad') }
  return null
}

function writeHash(push = false): void {
  const next = dashboardHashOf(dashboardState.page, dashboardState.tabs[dashboardState.page] ?? null)
  if (window.location.hash !== next && !(next === '' && window.location.hash === '')) {
    const url = `${window.location.pathname}${window.location.search}${next}`
    if (push) window.history.pushState(null, '', url)
    else window.history.replaceState(window.history.state, '', url)
  }
}

async function confirmLeave(from: DashboardPageId): Promise<boolean> {
  if (!isPageDirty(from)) return true
  const r = await ask({
    title: t('dsh.leave.title'),
    intro: t('dsh.leave.body', { page: t(PAGE_LABEL[from]) }),
    buttons: [
      { value: 'stay', label: t('dsh.leave.stay') },
      { value: 'drop', label: t('dsh.leave.drop'), kind: 'danger' },
      { value: 'save', label: t('dsh.leave.save'), kind: 'primary' },
    ],
  })
  if (r === 'drop') {
    discardPage(from)
    return true
  }
  if (r === 'save') return savePage(from)
  return false
}

async function go(page: DashboardPageId, tab?: string, fromHistory = false): Promise<void> {
  if (!canAccessPage(page)) {
    say(t('dsh.nav.forbiddenPage'))
    writeHash(false)
    return
  }
  if (page !== dashboardState.page && !(await confirmLeave(dashboardState.page))) {
    writeHash()
    return
  }
  const changed = page !== dashboardState.page
  dashboardState.page = page
  if (tab) dashboardState.tabs[page] = tab
  writeHash(changed && !fromHistory)
  await nextTick()
  document.querySelector<HTMLElement>('.db-main h2')?.focus?.()
  window.scrollTo({ top: 0 })
}

function setTab(tab: string): void {
  dashboardState.tabs[dashboardState.page] = tab
  writeHash()
}

async function onHashChange(): Promise<void> {
  if (gate.value !== 'allowed') return
  const parsed = parseDashboardHash(window.location.hash)
  if (!canAccessPage(parsed.page)) {
    say(t('dsh.nav.forbiddenPage'))
    dashboardState.page = canAccessPage(dashboardState.page) ? dashboardState.page : defaultLandingPage()
    writeHash(false)
    return
  }
  if (parsed.page === dashboardState.page) {
    if (parsed.tab) dashboardState.tabs[parsed.page] = parsed.tab
    return
  }
  await go(parsed.page, parsed.tab ?? undefined, true)
}

let dashPath = ''
function onPopState(e: PopStateEvent): void {
  if (dashPath && window.location.pathname === dashPath) e.stopImmediatePropagation()
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (dirtyModels().length === 0) return
  e.preventDefault()
  e.returnValue = ''
}

function applyInitialHashForRole(): void {
  const rawHash = window.location.hash
  const parsed = parseDashboardHash(rawHash)
  if (!rawHash) {
    const landing = defaultLandingPage()
    dashboardState.page = landing
    writeHash(false)
    return
  }
  if (!canAccessPage(parsed.page)) {
    const landing = defaultLandingPage()
    dashboardState.page = landing
    writeHash(false)
    say(t('dsh.nav.forbiddenPage'))
    return
  }
  dashboardState.page = parsed.page
  if (parsed.tab) dashboardState.tabs[parsed.page] = parsed.tab
}

function syncSessionFromAuthStatus(st: AuthStatus): void {
  if (st.authenticated && st.user) {
    session.value = {
      status: 'authenticated',
      user: { id: st.user.id, name: st.user.name ?? st.user.username ?? null, email: st.user.email },
      roles: [...st.roles],
      groups: [...st.groups],
      logoutUrl: null,
    }
  } else {
    session.value = { status: 'anonymous', source: 'server' }
  }
}

async function loadOnline(force = false): Promise<void> {
  if (force) {
    resetSession()
    resetAuthState()
  }
  if (force || currentSession().status === 'unknown') {
    const a = theme.value?.lectureModules?.auth
    configureSession({ adapter: a?.adapter ?? 'none', ...(a?.sessionEndpoint ? { sessionEndpoint: a.sessionEndpoint } : {}) })
  }
  loginHref.value = computeLoginHref()

  try {
    const st = await fetchAuthStatus()
    authStatus.value = st
    syncSessionFromAuthStatus(st)
    publishSession(session.value)

    if (!st.authenticated) {
      resetAuthState()
      authMethods.value = await fetchAuthMethods().catch(() => [])
      gate.value = 'signin'
      return
    }

    gate.value = 'allowed'
    dashboardState.mode = 'online'
    applyAuthStatus(st)
    applyInitialHashForRole()

    if (dashboardState.canAccessAdmin || dashboardState.canAccessAuthor) {
      await loadAdmin()
    } else {
      overview.value = null
      health.value = null
      healthError.value = ''
    }
    return
  } catch {
    // Fall back to /api/auth/session if /api/auth/status is unavailable (404 / network / legacy proxy)
  }

  authStatus.value = null
  session.value = await getSession()
  const s = session.value
  if ((s.status === 'anonymous' && s.source === 'server') || (s.status === 'unavailable' && s.reason === 'unauthorized')) {
    resetAuthState()
    authMethods.value = await fetchAuthMethods().catch(() => [])
    gate.value = 'signin'
    return
  }
  if (s.status !== 'authenticated') {
    resetAuthState()
    gate.value = 'denied'
    return
  }

  const synthStatus: AuthStatus = {
    authAdapter: authAdapter.value,
    authenticated: true,
    needsBootstrap: false,
    authSource: 'gateway',
    authMethod: 'gateway',
    rememberMe: false,
    user: { id: s.user.id, name: s.user.name, email: s.user.email },
    roles: [...s.roles],
    groups: [...s.groups],
    canAccessAdmin: s.roles.includes('admin'),
    canAccessAuthor: s.roles.includes('admin') || s.roles.includes('author'),
    visibleSections: [],
  }
  authStatus.value = synthStatus
  gate.value = 'allowed'
  dashboardState.mode = 'online'
  applyAuthStatus(synthStatus)
  applyInitialHashForRole()

  if (dashboardState.canAccessAdmin || dashboardState.canAccessAuthor) {
    await loadAdmin()
  } else {
    overview.value = null
    health.value = null
    healthError.value = ''
  }
}

async function loadAdmin(): Promise<void> {
  if (dashboardState.mode === 'online' && !dashboardState.canAccessAdmin && !dashboardState.canAccessAuthor) return
  if (dashboardState.mode === 'online' && !dashboardState.canAccessAdmin) {
    const ov = await fetchAdminOverview()
    overview.value = ov.ok ? ov.data : null
    health.value = null
    const why = (r: object): string => ('status' in r && r.status ? `HTTP ${String(r.status)}` : 'kind' in r ? String(r.kind) : '')
    healthError.value = !ov.ok ? t('dsh.rt.healthError', { reason: `overview ${why(ov)}` }) : ''
    return
  }
  const [ov, hl] = await Promise.all([fetchAdminOverview(), fetchAdminHealth()])
  overview.value = ov.ok ? ov.data : null
  health.value = hl.ok ? hl.data : null
  const errs: string[] = []
  const why = (r: object): string => ('status' in r && r.status ? `HTTP ${String(r.status)}` : 'kind' in r ? String(r.kind) : '')
  if (!ov.ok) errs.push(`overview ${why(ov)}`)
  if (!hl.ok) errs.push(`health ${why(hl)}`)
  healthError.value = errs.length ? t('dsh.rt.healthError', { reason: errs.join('; ') }) : ''
}

async function load(force = false): Promise<void> {
  loading.value = true
  try {
    if (import.meta.env.DEV) {
      const dev = await fetchDevDashboardStatus()
      if (dev) {
        devStatus.value = dev
        dashboardState.token = dev.csrfToken
        dashboardState.mode = 'dev'
        dashboardState.roles = ['reader', 'author', 'admin']
        dashboardState.canAccessAdmin = true
        dashboardState.canAccessAuthor = true
        gate.value = 'allowed'
        return
      }
    }
    await loadOnline(force)
  } finally {
    loading.value = false
    ready.value = true
  }
}

async function onAuthenticated(): Promise<void> {
  await load(true)
}

function isSafeRedirectUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  return /^\/(?!\/)/.test(trimmed) || /^https?:\/\//i.test(trimmed)
}

async function handleLoggedOut(logoutUrl?: string | null): Promise<void> {
  const prevAuthSource = authStatus.value?.authSource
  resetAuthState()
  if (prevAuthSource === 'gateway') {
    resetSession()
  } else {
    publishSession({ status: 'anonymous', source: 'server' })
  }
  overview.value = null
  health.value = null
  healthError.value = ''
  checkState.run = null
  checkState.scope = ''
  checkState.error = ''
  session.value = { status: 'anonymous', source: 'server' }

  if (logoutUrl && isSafeRedirectUrl(logoutUrl) && typeof window !== 'undefined') {
    window.location.assign(logoutUrl)
    return
  }
  if (typeof window !== 'undefined' && window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }

  const nextStatus = await fetchAuthStatus().catch(() => null)
  authStatus.value = nextStatus
  if (nextStatus?.authenticated) {
    syncSessionFromAuthStatus(nextStatus)
    publishSession(session.value)
    gate.value = 'allowed'
    dashboardState.mode = 'online'
    applyAuthStatus(nextStatus)
    applyInitialHashForRole()
    if (dashboardState.canAccessAdmin || dashboardState.canAccessAuthor) {
      await loadAdmin()
    }
    return
  }
  publishSession({ status: 'anonymous', source: 'server' })
  authMethods.value = await fetchAuthMethods().catch(() => [])
  loginHref.value = computeLoginHref()
  gate.value = 'signin'
}

async function onLogout(): Promise<void> {
  if (authStatus.value?.authSource && authStatus.value.authSource !== 'gateway') {
    publishSession({ status: 'anonymous', source: 'server' })
  }
  let logoutUrl: string | null = null
  try {
    const res = await logoutSession()
    logoutUrl = res.logoutUrl
  } catch {
    // still clear local state and show login
  }
  await handleLoggedOut(logoutUrl)
}

const gateMessage = computed(() => {
  const s = session.value
  if (s.status === 'authenticated') return t('dashboard.gateForbidden', { user: s.user.name || s.user.email || s.user.id })
  if (s.status === 'anonymous' || s.status === 'unknown') return t('dashboard.gateSignedOut', { adapter: authAdapter.value })
  return t('dashboard.gateUnavailable', { reason: s.reason })
})

watch(
  () => askState.open,
  async (open) => {
    await nextTick()
    const d = dialog.value
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      d.querySelector<HTMLElement>('footer button:last-child')?.focus()
    } else if (!open && d.open) d.close()
  },
)

onMounted(() => {
  endBodyHydration()
  const parsed = parseDashboardHash(window.location.hash)
  dashboardState.page = parsed.page
  if (parsed.tab) dashboardState.tabs[parsed.page] = parsed.tab
  window.addEventListener('hashchange', onHashChange)
  window.addEventListener('beforeunload', onBeforeUnload)
  dashPath = window.location.pathname
  window.addEventListener('popstate', onPopState, { capture: true })
  void load()
})
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('popstate', onPopState, { capture: true })
})

const pageProps = computed<Record<string, unknown>>(() => {
  switch (dashboardState.page) {
    case 'overview':
      return { overview: overview.value, health: health.value, access: devAccess.value, healthError: healthError.value }
    case 'texts':
      return { texts: devTexts.value }
    case 'access':
      return { access: devAccess.value, autheliaPreview: devStatus.value?.autheliaPreview ?? '', rulesNote: devRulesNote.value, demo: Boolean(devStatus.value?.demo) }
    case 'look':
      return { status: devStatus.value }
    case 'runtime':
      return { health: health.value, healthError: healthError.value }
    default:
      return {}
  }
})
</script>

<template>
  <section
    class="lec-dashboard"
    :data-dashboard-ready="ready ? '1' : '0'"
    :data-dashboard-mode="dashboardState.mode === 'dev' ? 'dev' : 'online'"
    :data-dashboard-readonly="isReadOnly ? '1' : '0'"
  >
    <div v-if="loading && !ready" class="db-loading"><p class="db-muted">{{ t('dsh.common.loading') }}</p></div>

    <div v-else-if="gate === 'denied'" class="db-panel db-gate" data-dashboard-gate="denied" role="region" :aria-label="t('dashboard.gateTitle')">
      <div class="db-pbody">
        <h2>{{ t('dashboard.gateTitle') }}</h2>
        <p>{{ gateMessage }}</p>
        <button type="button" class="db-btn" @click="load(true)">{{ t('dashboard.gateRetry') }}</button>
      </div>
    </div>

    <template v-else-if="gate === 'signin'">
      <DashboardLogin
        v-if="authStatus !== null || authMethods.length > 0"
        :auth-status="authStatus"
        :methods="authMethods"
        :gateway-login-url="loginHref"
        @authenticated="onAuthenticated"
      />
      <div v-else class="db-panel db-gate" data-dashboard-gate="signin" role="region" :aria-label="t('dsh.gate.signinTitle')">
        <div class="db-pbody">
          <h2>{{ t('dsh.gate.signinTitle') }}</h2>
          <p>{{ session.status === 'unavailable' ? t('dsh.gate.signinExpired') : t('dsh.gate.signinBody') }}</p>
          <div class="db-btns">
            <a class="db-btn primary" :href="loginHref" target="_self" data-dashboard-login>{{ t('dsh.gate.signin') }}</a>
            <button type="button" class="db-btn" @click="load(true)">{{ t('dashboard.gateRetry') }}</button>
          </div>
        </div>
      </div>
    </template>

    <div v-else-if="gate === 'allowed'" class="db-shell">
      <aside class="db-side">
        <div class="db-brand">
          <h1 class="db-title">{{ t('dsh.title') }}</h1>
          <span class="db-mode" :data-mode="dashboardState.mode">{{ dashboardState.mode === 'dev' ? t('dsh.modeLocal') : t('dsh.modeOnline') }}</span>
        </div>
        <nav class="db-nav" :aria-label="t('dsh.nav.label')">
          <template v-for="g in visibleNavGroups" :key="g.group || 'top'">
            <h2 v-if="g.group">{{ t(GROUP_LABEL[g.group]) }}</h2>
            <button
              v-for="p in g.pages"
              :key="p"
              type="button"
              class="db-navi"
              :aria-current="dashboardState.page === p ? 'page' : undefined"
              :data-dashboard-tab="p"
              @click="go(p)"
            >
              <span class="db-navl">{{ t(PAGE_LABEL[p]) }}</span>
              <span v-if="isPageDirty(p)" class="db-unsaved" data-nav-unsaved>{{ t('dsh.common.unsaved') }}</span>
              <span v-else-if="navCount(p)" class="db-navc" :title="navCount(p)!.label"><span class="dm" :data-k="navCount(p)!.k" aria-hidden="true"></span>{{ navCount(p)!.n }}<span class="db-vh">{{ navCount(p)!.label }}</span></span>
            </button>
          </template>
        </nav>
        <div v-if="dashboardState.mode === 'online'" class="db-side-foot">
          <button type="button" class="db-btn sm" data-dashboard-logout @click="onLogout">{{ t('dsh.nav.logout') }}</button>
        </div>
      </aside>
      <div class="db-navsel-row">
        <label class="db-navsel">
          <span class="db-vh">{{ t('dsh.nav.label') }}</span>
          <select :value="dashboardState.page" data-dashboard-navsel @change="go(($event.target as HTMLSelectElement).value as DashboardPageId)">
            <template v-for="g in visibleNavGroups" :key="g.group || 'top'">
              <optgroup v-if="g.group" :label="t(GROUP_LABEL[g.group])">
                <option v-for="p in g.pages" :key="p" :value="p">{{ t(PAGE_LABEL[p]) }}{{ isPageDirty(p) ? ` · ${t('dsh.common.unsaved')}` : '' }}</option>
              </optgroup>
              <template v-else><option v-for="p in g.pages" :key="p" :value="p">{{ t(PAGE_LABEL[p]) }}</option></template>
            </template>
          </select>
        </label>
        <button v-if="dashboardState.mode === 'online'" type="button" class="db-btn sm" data-dashboard-logout-mobile @click="onLogout">{{ t('dsh.nav.logout') }}</button>
      </div>
      <main class="db-main" :data-dashboard-pane="dashboardState.page">
        <div v-if="dashboardState.rebuildRequired" class="db-banner db-rebuild-banner" role="status" data-dashboard-rebuild-badge>
          <span class="db-info" aria-hidden="true"></span>
          <span class="db-grow">
            {{ t('dsh.rebuild.banner') }}
            <template v-if="dashboardState.rebuildReasons.length">
              ({{ dashboardState.rebuildReasons.join('; ') }})
            </template>
          </span>
          <button type="button" class="db-btn sm" data-dashboard-rebuild-dismiss @click="clearRebuildRequired()">
            {{ t('dsh.rebuild.dismiss') }}
          </button>
        </div>
        <component
          :is="PAGES[dashboardState.page]"
          :key="dashboardState.page"
          v-bind="pageProps"
          @go="go"
          @tab="setTab"
          @retry="loadAdmin()"
          @status="(s: DevDashboardStatus) => (devStatus = s)"
          @logged-out="handleLoggedOut()"
        />
      </main>
    </div>

    <dialog ref="dialog" class="db-dlg" aria-labelledby="db-dlg-title" @close="askState.open && answerAsk(null)" @cancel.prevent="answerAsk(null)">
      <template v-if="askState.options">
        <header><h3 id="db-dlg-title">{{ askState.options.title }}</h3></header>
        <div class="db-dbody">
          <p v-if="askState.options.intro">{{ askState.options.intro }}</p>
          <DbDiff v-if="askState.options.diff" :before="askState.options.diff.before" :after="askState.options.diff.after" :file="askState.options.diff.file" :note="askState.options.diff.note" />
          <dl v-if="askState.options.facts" class="db-kv"><template v-for="[k, v] in askState.options.facts" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template></dl>
          <p v-if="askState.options.warning" class="db-warn"><span class="dm" data-k="warn" aria-hidden="true"></span>{{ askState.options.warning }}</p>
        </div>
        <footer>
          <button v-for="b in askState.options.buttons" :key="b.value" type="button" class="db-btn" :class="b.kind" :data-dlg-btn="b.value" @click="answerAsk(b.value)">{{ b.label }}</button>
        </footer>
      </template>
    </dialog>
    <div class="db-toast" :class="{ on: !!dashboardState.toast }" role="status" aria-live="polite" data-dashboard-toast>{{ dashboardState.toast }}</div>
  </section>
</template>
