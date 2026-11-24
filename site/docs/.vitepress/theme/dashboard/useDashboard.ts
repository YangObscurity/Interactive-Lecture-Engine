/**
 * theme/dashboard/useDashboard.ts — shared state, role-based access control, rebuild banner state,
 * check runners, unsaved-changes registry, and modal confirmation dialog for the Dashboard.
 */
import { computed, reactive, ref } from 'vue'
import {
  fetchOnlineChecks,
  formatAdminError,
  isAdminError,
  isAdminOk,
  runOnlineChecks,
  type OnlineChecksPayload,
} from '../api/admin'
import type { AuthStatus } from '../api/auth'
import { fetchLastCheck, runCheckNow, type CheckRunPayload } from '../api/devDashboard'

export const DASHBOARD_PAGES = [
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
] as const
export type DashboardPageId = (typeof DASHBOARD_PAGES)[number]

/** Navigation groups (spec board 14.2 + WP-5 RBAC): overview group has no title. */
export const DASHBOARD_NAV: ReadonlyArray<{
  group: '' | 'personal' | 'content' | 'site' | 'system'
  pages: readonly DashboardPageId[]
}> = [
  { group: 'personal', pages: ['my-learning', 'account'] },
  { group: '', pages: ['overview'] },
  { group: 'content', pages: ['checks', 'figures', 'texts', 'companion'] },
  { group: 'site', pages: ['access', 'look'] },
  { group: 'system', pages: ['database', 'users', 'runtime', 'backup'] },
]

export const PAGE_TABS: Partial<Record<DashboardPageId, readonly string[]>> = {
  figures: ['gallery', 'drafts'],
  companion: ['prompt', 'actions', 'history', 'usage', 'tools'],
  look: ['theme', 'modules'],
  runtime: ['logs', 'sync', 'health'],
}

export interface ParsedHash {
  page: DashboardPageId
  tab: string | null
}

/** `#companion:history` -> { page: 'companion', tab: 'history' }; unknown values fall back to the overview / first tab. */
export function parseDashboardHash(hash: string): ParsedHash {
  const raw = hash.replace(/^#/, '')
  const legacy = /^tab=([a-z0-9_-]+)$/i.exec(raw)
  const [p = '', tab = ''] = (legacy ? legacy[1] ?? '' : raw).split(':')
  const alias: Record<string, DashboardPageId> = {
    gallery: 'figures',
    concepts: 'figures',
    prompts: 'companion',
    health: 'runtime',
    system: 'access',
    theme: 'look',
    modules: 'look',
    me: 'my-learning',
    learning: 'my-learning',
    security: 'account',
    db: 'database',
    user: 'users',
  }
  const page = (DASHBOARD_PAGES as readonly string[]).includes(p) ? (p as DashboardPageId) : alias[p] ?? 'overview'
  const tabs = PAGE_TABS[page] ?? []
  const aliasTab: Record<string, string> = {
    gallery: 'gallery',
    concepts: 'drafts',
    modules: 'modules',
    theme: 'theme',
    health: 'health',
  }
  const wanted = tabs.includes(tab) ? tab : tabs.includes(aliasTab[p] ?? '') ? (aliasTab[p] as string) : null
  return { page, tab: wanted }
}

export function dashboardHashOf(page: DashboardPageId, tab: string | null): string {
  if (page === 'overview' && !tab) return ''
  return `#${page}${tab ? `:${tab}` : ''}`
}

export interface DirtyModel {
  page: DashboardPageId
  dirty: () => boolean
  save?: () => Promise<boolean>
  discard?: () => void
}

const models = new Map<string, DirtyModel>()
const version = ref(0)

export const dashboardState = reactive({
  mode: 'loading' as 'loading' | 'dev' | 'online',
  token: '',
  page: 'overview' as DashboardPageId,
  tabs: {} as Partial<Record<DashboardPageId, string>>,
  toast: '',
  roles: [] as string[],
  visibleSections: [] as DashboardPageId[],
  authSource: 'none' as string,
  authMethod: 'anonymous' as string,
  canAccessAdmin: false,
  canAccessAuthor: false,
  rebuildRequired: false,
  rebuildReasons: [] as string[],
})

const READER_PAGES: ReadonlySet<DashboardPageId> = new Set(['my-learning', 'account'])
const AUTHOR_PAGES: ReadonlySet<DashboardPageId> = new Set([
  'my-learning',
  'account',
  'overview',
  'checks',
  'figures',
  'texts',
  'companion',
])

export function canAccessPage(page: DashboardPageId): boolean {
  if (dashboardState.mode === 'dev') return true
  if (dashboardState.mode !== 'online') return false
  if (dashboardState.visibleSections.length > 0) {
    return dashboardState.visibleSections.includes(page)
  }
  if (dashboardState.canAccessAdmin || dashboardState.roles.includes('admin')) return true
  if (dashboardState.canAccessAuthor || dashboardState.roles.includes('author')) {
    return AUTHOR_PAGES.has(page)
  }
  return READER_PAGES.has(page)
}

export function canWritePage(page: DashboardPageId): boolean {
  if (dashboardState.mode === 'dev') return true
  if (dashboardState.mode !== 'online') return false
  return canAccessPage(page)
}

export const isReadOnly = computed(() => (dashboardState.mode === 'loading' ? true : !canWritePage(dashboardState.page)))

export const visibleNavGroups = computed(() =>
  DASHBOARD_NAV.map((g) => ({
    group: g.group,
    pages: g.pages.filter((p) => canAccessPage(p)),
  })).filter((g) => g.pages.length > 0),
)

export function defaultLandingPage(): DashboardPageId {
  if (dashboardState.mode === 'dev') return 'overview'
  if (dashboardState.visibleSections.length > 0) {
    if (dashboardState.visibleSections.includes('overview')) return 'overview'
    return dashboardState.visibleSections[0] ?? 'overview'
  }
  if (dashboardState.canAccessAdmin || dashboardState.roles.includes('admin')) return 'overview'
  return 'my-learning'
}

export function markRebuildRequired(reason?: string): void {
  dashboardState.rebuildRequired = true
  const trimmed = reason?.trim()
  if (trimmed && !dashboardState.rebuildReasons.includes(trimmed)) {
    dashboardState.rebuildReasons.push(trimmed)
  }
}

export function clearRebuildRequired(): void {
  dashboardState.rebuildRequired = false
  dashboardState.rebuildReasons = []
}

export function applyAuthStatus(st: AuthStatus): void {
  const roles = Array.isArray(st.roles) && st.roles.length ? [...st.roles] : ['reader']
  dashboardState.roles = roles
  dashboardState.authSource = st.authSource || 'none'
  dashboardState.authMethod = st.authMethod || 'anonymous'
  dashboardState.canAccessAdmin = Boolean(st.canAccessAdmin || roles.includes('admin'))
  dashboardState.canAccessAuthor = Boolean(st.canAccessAuthor || dashboardState.canAccessAdmin || roles.includes('author'))

  const validSet = new Set<DashboardPageId>(DASHBOARD_PAGES)
  if (Array.isArray(st.visibleSections) && st.visibleSections.length > 0) {
    dashboardState.visibleSections = st.visibleSections.filter((s): s is DashboardPageId =>
      validSet.has(s as DashboardPageId),
    )
  } else {
    dashboardState.visibleSections = []
  }
}

export function resetAuthState(): void {
  dashboardState.page = 'overview'
  dashboardState.tabs = {}
  dashboardState.roles = []
  dashboardState.visibleSections = []
  dashboardState.authSource = 'none'
  dashboardState.authMethod = 'anonymous'
  dashboardState.canAccessAdmin = false
  dashboardState.canAccessAuthor = false
  dashboardState.rebuildRequired = false
  dashboardState.rebuildReasons = []
}

/** Register (or replace) one editable model; returns the unregister function. */
export function registerModel(key: string, model: DirtyModel): () => void {
  models.set(key, model)
  version.value++
  return () => {
    if (models.get(key) === model) models.delete(key)
    version.value++
  }
}

/** Call after any edit so computed marks re-read the dirty checks. */
export function touchModels(): void {
  version.value++
}

export function dirtyModels(page?: DashboardPageId): DirtyModel[] {
  void version.value
  return [...models.values()].filter((m) => (!page || m.page === page) && m.dirty())
}

export function isPageDirty(page: DashboardPageId): boolean {
  return dirtyModels(page).length > 0
}

export async function savePage(page: DashboardPageId): Promise<boolean> {
  let ok = true
  for (const m of dirtyModels(page)) {
    if (m.save) ok = (await m.save()) && ok
    else ok = false
  }
  touchModels()
  return ok
}

export function discardPage(page: DashboardPageId): void {
  for (const m of dirtyModels(page)) m.discard?.()
  touchModels()
}

export function tabOf(page: DashboardPageId): string {
  return dashboardState.tabs[page] ?? PAGE_TABS[page]?.[0] ?? ''
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
/** A short status message (also read by screen readers through the live region). */
export function say(text: string): void {
  dashboardState.toast = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    dashboardState.toast = ''
  }, 3200)
}

// ── content check runs (shared by Overview, Content checks and Groups) ─────────────────────────────────────────────

export const checkState = reactive({
  run: null as CheckRunPayload | null,
  running: false,
  /** What is running: '' (nothing), '*' (everything) or one category (`chart`). */
  scope: '',
  error: '',
})

function normalizeOnlineChecks(payload: OnlineChecksPayload): CheckRunPayload {
  return {
    at: payload.at,
    ms: payload.ms ?? 0,
    exitCode: payload.exitCode ?? (payload.ok ? 0 : 1),
    ...(payload.only ? { only: payload.only } : {}),
    report: payload.report,
  }
}

/** The last run, or a fresh one when there is none yet (dev or online author/admin). */
export async function ensureCheckRun(): Promise<void> {
  if (checkState.run || checkState.running) return
  if (dashboardState.mode === 'dev') {
    const last = await fetchLastCheck()
    if (last) {
      checkState.run = last
      return
    }
    await runChecks()
    return
  }
  if (dashboardState.mode === 'online' && canAccessPage('checks')) {
    checkState.running = true
    checkState.error = ''
    try {
      const res = await fetchOnlineChecks()
      if (isAdminOk(res)) {
        checkState.run = normalizeOnlineChecks(res.data)
      } else if (isAdminError(res)) {
        checkState.error = formatAdminError(res.error)
      }
    } finally {
      checkState.running = false
    }
  }
}

/** Run every check, or only one category (`chart`) on top of the last report ("rerun this check"). */
export async function runChecks(only?: string): Promise<boolean> {
  if (checkState.running) return false
  if (dashboardState.mode === 'dev') {
    if (!dashboardState.token) return false
    checkState.running = true
    checkState.scope = only ?? '*'
    checkState.error = ''
    try {
      const r = await runCheckNow(dashboardState.token, only ? [only] : undefined)
      if (r) checkState.run = r
      else checkState.error = 'request_failed'
      return !!r
    } finally {
      checkState.running = false
      checkState.scope = ''
    }
  }
  if (dashboardState.mode === 'online' && canAccessPage('checks')) {
    checkState.running = true
    checkState.scope = only ?? '*'
    checkState.error = ''
    try {
      const res = await runOnlineChecks(only ? [only] : undefined)
      if (isAdminOk(res)) {
        checkState.run = normalizeOnlineChecks(res.data)
        return true
      }
      checkState.error = isAdminError(res) ? formatAdminError(res.error) : 'request_failed'
      return false
    } finally {
      checkState.running = false
      checkState.scope = ''
    }
  }
  return false
}

// ── one modal dialog for the whole Dashboard (leave prompt, restore confirmations) ─────────────────────────────────

export interface AskButton {
  value: string
  label: string
  kind?: 'primary' | 'danger'
}

export interface AskOptions {
  title: string
  intro?: string
  diff?: { before: string; after: string; file?: string; note?: string }
  facts?: ReadonlyArray<readonly [string, string]>
  warning?: string
  buttons: readonly AskButton[]
}

export const askState = reactive({
  open: false,
  options: null as AskOptions | null,
})
let askResolve: ((v: string | null) => void) | null = null

/** Open the dialog; resolves with the chosen button value, or null when it was closed (Esc). */
export function ask(options: AskOptions): Promise<string | null> {
  if (askResolve) askResolve(null)
  askState.options = options
  askState.open = true
  return new Promise((resolve) => {
    askResolve = resolve
  })
}

export function answerAsk(value: string | null): void {
  askState.open = false
  const r = askResolve
  askResolve = null
  r?.(value)
}
