/**
 * theme/dashboard/useDashboard.ts — the state the Dashboard pages share (S4b, the dashboard prototype v3.x).
 *
 * One module-level store (the Dashboard is one page): mode (local author / online read-only), the dev token, the
 * current page and tab (both in the URL hash: `#companion` or `#companion:history`), and the unsaved-changes registry the
 * navigation marks and the leave dialog read. Pages register a `dirty()` check, a `save()` and a `discard()` per model.
 */
import { computed, reactive, ref } from 'vue'
import { fetchLastCheck, runCheckNow, type CheckRunPayload } from '../api/devDashboard'

export const DASHBOARD_PAGES = ['overview', 'checks', 'figures', 'texts', 'companion', 'access', 'look', 'runtime', 'backup'] as const
export type DashboardPageId = (typeof DASHBOARD_PAGES)[number]

/** Navigation groups (spec board 14.2): first group has no title. */
export const DASHBOARD_NAV: ReadonlyArray<{ group: '' | 'content' | 'site' | 'system'; pages: readonly DashboardPageId[] }> = [
  { group: '', pages: ['overview'] },
  { group: 'content', pages: ['checks', 'figures', 'texts', 'companion'] },
  { group: 'site', pages: ['access', 'look'] },
  { group: 'system', pages: ['runtime', 'backup'] },
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
  // the P6.5 form `#tab=texts` still opens the right page
  const legacy = /^tab=([a-z0-9_-]+)$/i.exec(raw)
  const [p = '', tab = ''] = (legacy ? legacy[1] ?? '' : raw).split(':')
  const alias: Record<string, DashboardPageId> = { gallery: 'figures', concepts: 'figures', prompts: 'companion', health: 'runtime', system: 'access', theme: 'look', modules: 'look' }
  const page = (DASHBOARD_PAGES as readonly string[]).includes(p) ? (p as DashboardPageId) : alias[p] ?? 'overview'
  const tabs = PAGE_TABS[page] ?? []
  const aliasTab: Record<string, string> = { gallery: 'gallery', concepts: 'drafts', modules: 'modules', theme: 'theme', health: 'health' }
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
})

export const isReadOnly = computed(() => dashboardState.mode !== 'dev')

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

/** The last run, or a fresh one when there is none yet (local author mode only). */
export async function ensureCheckRun(): Promise<void> {
  if (dashboardState.mode !== 'dev' || checkState.run || checkState.running) return
  const last = await fetchLastCheck()
  if (last) {
    checkState.run = last
    return
  }
  await runChecks()
}

/** Run every check, or only one category (`chart`) on top of the last report ("rerun this check"). */
export async function runChecks(only?: string): Promise<boolean> {
  if (dashboardState.mode !== 'dev' || !dashboardState.token || checkState.running) return false
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
