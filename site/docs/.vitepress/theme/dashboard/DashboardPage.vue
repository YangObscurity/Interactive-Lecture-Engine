<script setup lang="ts">
/**
 * DashboardPage.vue — the Lecture Engine Dashboard (`/dashboard`, `/en/dashboard`), aligned with the confirmed prototype
 * v3 / v3.1 (the dashboard prototype and spec board): nine pages in four groups, the page and tab in the URL hash,
 * unsaved marks in the navigation with a leave prompt, both skins (shapes per theme), and 375 px.
 *
 * Two modes, unchanged boundary (plan_v2_amend_01_generic_engine.md §4.6):
 *   - local author mode (`vitepress dev`): reads and writes through the loopback-only `/__lecture/api/*` middleware; every
 *     write carries the per-process dev token and is same-origin only;
 *   - online (production): read-only for admins (`/api/auth/session` roles), from `/api/admin/overview` and `/api/admin/health`.
 * Features the backend does not offer yet are shown as unavailable with the reason (DbUnavailable), never with sample data.
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
import type { DevAccessSummary } from '../api/devDashboard'
import type { SiteTexts } from '../../site-texts-schema.ts'
import { configureSession, currentSession, getSession, resetSession, type SessionState } from '../auth/session'
import { endBodyHydration } from '../core/bodyHydration'
import './dashboard.css'
import DbDiff from './DbDiff.vue'
import PageAccess from './pages/PageAccess.vue'
import PageBackup from './pages/PageBackup.vue'
import PageChecks from './pages/PageChecks.vue'
import PageCompanion from './pages/PageCompanion.vue'
import PageFigures from './pages/PageFigures.vue'
import PageLook from './pages/PageLook.vue'
import PageOverview from './pages/PageOverview.vue'
import PageRuntime from './pages/PageRuntime.vue'
import PageTexts from './pages/PageTexts.vue'
import {
  DASHBOARD_NAV,
  answerAsk,
  ask,
  askState,
  checkState,
  dashboardHashOf,
  dashboardState,
  dirtyModels,
  discardPage,
  isPageDirty,
  parseDashboardHash,
  savePage,
  type DashboardPageId,
} from './useDashboard'

defineOptions({ name: 'DashboardPage' })

const { t } = useT()
const { theme } = useData<{ lectureModules?: { auth?: { adapter?: string; sessionEndpoint?: string; loginUrl?: string } } }>()

const loading = ref(true)
const ready = ref(false)
const gate = ref<'pending' | 'allowed' | 'denied' | 'signin'>('pending')
const session = ref<SessionState>({ status: 'unknown' })
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

/**
 * Where "sign in" goes. Behind the gateway `/dashboard` itself is admin-only (docs-dev/GATEWAY.md §4), so a full page
 * load of this address sends a signed-out reader to the sign-in portal and back; a site can name its portal with
 * `lectureModules.auth.loginUrl` (`{rd}` = this page, URL-encoded).
 */
const loginHref = ref('')
function computeLoginHref(): string {
  const here = window.location.href
  const custom = theme.value?.lectureModules?.auth?.loginUrl
  return custom ? custom.replace('{rd}', encodeURIComponent(here)) : here
}

const PAGE_LABEL: Record<DashboardPageId, MessageKey> = {
  overview: 'dsh.nav.overview',
  checks: 'dsh.nav.checks',
  figures: 'dsh.nav.figures',
  texts: 'dsh.nav.texts',
  companion: 'dsh.nav.companion',
  access: 'dsh.nav.access',
  look: 'dsh.nav.look',
  runtime: 'dsh.nav.runtime',
  backup: 'dsh.nav.backup',
}
const GROUP_LABEL: Record<'content' | 'site' | 'system', MessageKey> = { content: 'dsh.nav.gContent', site: 'dsh.nav.gSite', system: 'dsh.nav.gSystem' }
const PAGES: Record<DashboardPageId, Component> = {
  overview: PageOverview,
  checks: PageChecks,
  figures: PageFigures,
  texts: PageTexts,
  companion: PageCompanion,
  access: PageAccess,
  look: PageLook,
  runtime: PageRuntime,
  backup: PageBackup,
}

/** Counts on navigation items: failing / warning checks, failing health, an admin API that could not be read. */
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

/**
 * Page changes are history entries (the browser's Back returns to the previous page, like the prototype's `#page`
 * links); a tab change, a refused leave and the first sync only replace the current entry. Entries pushed here carry a
 * null state, which VitePress's popstate handler ignores (it would reload the route otherwise).
 */
function writeHash(push = false): void {
  const next = dashboardHashOf(dashboardState.page, dashboardState.tabs[dashboardState.page] ?? null)
  if (window.location.hash !== next && !(next === '' && window.location.hash === '')) {
    const url = `${window.location.pathname}${window.location.search}${next}`
    if (push) window.history.pushState(null, '', url)
    else window.history.replaceState(window.history.state, '', url)
  }
}

/** Ask before leaving a page with unsaved changes: stay / discard and leave / save and leave. */
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

/** `fromHistory`: the URL already changed (Back / Forward / an edited address): only replace, never push. */
async function go(page: DashboardPageId, tab?: string, fromHistory = false): Promise<void> {
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
  const parsed = parseDashboardHash(window.location.hash)
  if (parsed.page === dashboardState.page) {
    if (parsed.tab) dashboardState.tabs[parsed.page] = parsed.tab
    return
  }
  await go(parsed.page, parsed.tab ?? undefined, true)
}

/** Back / Forward between two Dashboard entries is ours (hashchange above): keep VitePress from reloading the route. */
let dashPath = ''
function onPopState(e: PopStateEvent): void {
  if (dashPath && window.location.pathname === dashPath) e.stopImmediatePropagation()
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (dirtyModels().length === 0) return
  e.preventDefault()
  e.returnValue = ''
}

async function loadOnline(force = false): Promise<void> {
  if (force) resetSession()
  if (force || currentSession().status === 'unknown') {
    const a = theme.value?.lectureModules?.auth
    configureSession({ adapter: a?.adapter ?? 'none', ...(a?.sessionEndpoint ? { sessionEndpoint: a.sessionEndpoint } : {}) })
  }
  session.value = await getSession()
  const s = session.value
  // signed out, or the gateway answered for an expired sign-in: say so and offer the sign-in (plan p65 §WP-D2)
  if ((s.status === 'anonymous' && s.source === 'server') || (s.status === 'unavailable' && s.reason === 'unauthorized')) {
    loginHref.value = computeLoginHref()
    gate.value = 'signin'
    return
  }
  if (!(s.status === 'authenticated' && s.roles.includes('admin'))) {
    gate.value = 'denied'
    return
  }
  gate.value = 'allowed'
  dashboardState.mode = 'online'
  await loadAdmin()
}

/** `/api/admin/overview` + `/api/admin/health`; a failure is kept as `healthError` (a failure item, a nav mark). */
async function loadAdmin(): Promise<void> {
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
  // capture: runs before VitePress's own popstate listener on window
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
    :data-dashboard-readonly="dashboardState.mode === 'dev' ? '0' : '1'"
  >
    <div v-if="loading && !ready" class="db-loading"><p class="db-muted">{{ t('dsh.common.loading') }}</p></div>

    <div v-else-if="gate === 'denied'" class="db-panel db-gate" data-dashboard-gate="denied" role="region" :aria-label="t('dashboard.gateTitle')">
      <div class="db-pbody">
        <h2>{{ t('dashboard.gateTitle') }}</h2>
        <p>{{ gateMessage }}</p>
        <button type="button" class="db-btn" @click="load(true)">{{ t('dashboard.gateRetry') }}</button>
      </div>
    </div>

    <div v-else-if="gate === 'signin'" class="db-panel db-gate" data-dashboard-gate="signin" role="region" :aria-label="t('dsh.gate.signinTitle')">
      <div class="db-pbody">
        <h2>{{ t('dsh.gate.signinTitle') }}</h2>
        <p>{{ session.status === 'unavailable' ? t('dsh.gate.signinExpired') : t('dsh.gate.signinBody') }}</p>
        <div class="db-btns">
          <a class="db-btn primary" :href="loginHref" target="_self" data-dashboard-login>{{ t('dsh.gate.signin') }}</a>
          <button type="button" class="db-btn" @click="load(true)">{{ t('dashboard.gateRetry') }}</button>
        </div>
      </div>
    </div>

    <div v-else-if="gate === 'allowed'" class="db-shell">
      <aside class="db-side">
        <div class="db-brand">
          <h1 class="db-title">{{ t('dsh.title') }}</h1>
          <span class="db-mode" :data-mode="dashboardState.mode">{{ dashboardState.mode === 'dev' ? t('dsh.modeLocal') : t('dsh.modeOnline') }}</span>
        </div>
        <nav class="db-nav" :aria-label="t('dsh.nav.label')">
          <template v-for="g in DASHBOARD_NAV" :key="g.group || 'top'">
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
      </aside>
      <label class="db-navsel">
        <span class="db-vh">{{ t('dsh.nav.label') }}</span>
        <select :value="dashboardState.page" data-dashboard-navsel @change="go(($event.target as HTMLSelectElement).value as DashboardPageId)">
          <template v-for="g in DASHBOARD_NAV" :key="g.group || 'top'">
            <optgroup v-if="g.group" :label="t(GROUP_LABEL[g.group])">
              <option v-for="p in g.pages" :key="p" :value="p">{{ t(PAGE_LABEL[p]) }}{{ isPageDirty(p) ? ` · ${t('dsh.common.unsaved')}` : '' }}</option>
            </optgroup>
            <template v-else><option v-for="p in g.pages" :key="p" :value="p">{{ t(PAGE_LABEL[p]) }}</option></template>
          </template>
        </select>
      </label>
      <main class="db-main" :data-dashboard-pane="dashboardState.page">
        <component :is="PAGES[dashboardState.page]" :key="dashboardState.page" v-bind="pageProps" @go="go" @tab="setTab" @retry="loadAdmin()" @status="(s: DevDashboardStatus) => (devStatus = s)" />
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
