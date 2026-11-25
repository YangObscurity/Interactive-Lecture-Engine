/**
 * theme/dashboard/dashboardClient.ts — Unified Dashboard client routing dev (`/__lecture/api/*`)
 * vs online (`/api/admin/*` via `api/admin.ts`), using `isAdminOk`/`isAdminError` narrowing
 * and triggering non-blocking rebuild notices whenever `persistence.effect === 'rebuild_required'`.
 */
import type { CompanionPromptsFile } from '../../prompts/companion.ts'
import type { SiteTexts } from '../../site-texts-schema.ts'
import {
  createOnlineBackup,
  fetchOnlineAccess,
  fetchOnlineAiTools,
  fetchOnlineBackups,
  fetchOnlineCompanion,
  fetchOnlineCompanionHistory,
  fetchOnlineFigures,
  fetchOnlineLogs,
  fetchOnlineLook,
  fetchOnlineRuntime,
  fetchOnlineSetting,
  fetchOnlineTexts,
  formatAdminError,
  isAdminError,
  isAdminOk,
  reloadOnlineRuntime,
  restoreOnlineBackup,
  saveDevCompanionPrompts,
  saveDevSiteTexts,
  saveOnlineAccess,
  saveOnlineAiTools,
  saveOnlineCompanion,
  saveOnlineLook,
  saveOnlineSetting,
  saveOnlineTexts,
  type DevDashboardStatus,
  type OnlineAiToolsPayload,
  type OnlineBackupEntry,
  type OnlineBackupRestoreResult,
  type OnlineBackupSnapshot,
  type OnlineCompanionHistoryItem,
  type OnlineFiguresPayload,
  type OnlineLogEntry,
  type OnlinePersistenceInfo,
  type OnlineRuntimePayload,
} from '../api/admin'
import {
  fetchDevLogs,
  fetchPromptsHistory,
  fetchRuntime,
  fetchThemeConfig,
  fetchTools,
  previewDevAccess,
  saveDevAccess,
  savePromptsWithMessage,
  saveThemeConfig,
  saveToolSwitches,
  type DevLogLine,
  type HistoryPayload,
  type PreviewAccessResult,
  type RuntimePayload,
  type SaveAccessResult,
  type ThemeView,
  type ToolsPayload,
} from '../api/devDashboard'
import { dashboardState, markRebuildRequired } from './useDashboard'

function handlePersistence(persistence?: OnlinePersistenceInfo | null): void {
  if (persistence?.effect === 'rebuild_required') {
    markRebuildRequired(persistence.rebuildReason || '')
  }
}

export const dashboardClient = {
  // ── Figures ─────────────────────────────────────────────────────────────────
  async fetchOnlineFigures(): Promise<{ ok: boolean; data?: OnlineFiguresPayload; error?: string }> {
    const res = await fetchOnlineFigures()
    if (isAdminOk(res)) {
      return { ok: true, data: res.data }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  // ── Texts ───────────────────────────────────────────────────────────────────
  async fetchTexts(): Promise<{ ok: boolean; texts?: Record<string, unknown>; error?: string }> {
    const res = await fetchOnlineTexts()
    if (isAdminOk(res)) {
      return { ok: true, texts: res.data.texts }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  async saveTexts(texts: SiteTexts): Promise<{
    ok: boolean
    texts?: SiteTexts
    persistence?: OnlinePersistenceInfo
    error?: string
    errors?: string[]
  }> {
    if (dashboardState.mode === 'dev') {
      return saveDevSiteTexts(dashboardState.token, texts)
    }
    const res = await saveOnlineTexts(texts as unknown as Record<string, unknown>)
    if (isAdminOk(res)) {
      handlePersistence(res.data.persistence)
      return {
        ok: true,
        texts: (res.data.texts as unknown as SiteTexts) ?? texts,
        persistence: res.data.persistence,
      }
    }
    const details =
      isAdminError(res) && Array.isArray(res.error.details)
        ? res.error.details.filter((x): x is string => typeof x === 'string')
        : undefined
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
      ...(details ? { errors: details } : {}),
    }
  },

  // ── Companion & Prompts ─────────────────────────────────────────────────────
  async fetchCompanion(): Promise<{
    ok: boolean
    prompts?: CompanionPromptsFile
    filePath?: string | null
    source?: string
    error?: string
  }> {
    const res = await fetchOnlineCompanion()
    if (isAdminOk(res)) {
      return {
        ok: true,
        prompts: res.data.prompts,
        filePath: res.data.filePath,
        source: res.data.source,
      }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  async saveCompanion(
    prompts: CompanionPromptsFile,
    message?: string,
  ): Promise<{
    ok: boolean
    prompts?: CompanionPromptsFile
    persistence?: OnlinePersistenceInfo
    commit?: { committed: boolean; hash?: string; reason?: string }
    error?: string
    errors?: string[]
  }> {
    if (dashboardState.mode === 'dev') {
      if (message !== undefined) {
        return savePromptsWithMessage(dashboardState.token, prompts, message)
      }
      return saveDevCompanionPrompts(dashboardState.token, prompts)
    }
    const res = await saveOnlineCompanion(prompts)
    if (isAdminOk(res)) {
      handlePersistence(res.data.persistence)
      return {
        ok: true,
        prompts: res.data.prompts,
        persistence: res.data.persistence,
      }
    }
    const details = isAdminError(res) && Array.isArray(res.error.details)
      ? res.error.details.filter((x): x is string => typeof x === 'string')
      : undefined
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
      ...(details ? { errors: details } : {}),
    }
  },

  async fetchCompanionHistory(): Promise<{
    ok: boolean
    devHistory?: HistoryPayload | null
    onlineHistory?: OnlineCompanionHistoryItem[]
    error?: string
  }> {
    if (dashboardState.mode === 'dev') {
      const devHistory = await fetchPromptsHistory()
      return { ok: true, devHistory }
    }
    const res = await fetchOnlineCompanionHistory()
    if (isAdminOk(res)) {
      return { ok: true, onlineHistory: res.data.history }
    }
    return {
      ok: false,
      onlineHistory: [],
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  // ── AI Tools & Settings ─────────────────────────────────────────────────────
  async fetchDevTools(): Promise<ToolsPayload | null> {
    return fetchTools()
  },

  async saveDevTools(
    sw: Parameters<typeof saveToolSwitches>[1],
  ): Promise<{ ok: true; tools: ToolsPayload } | { ok: false; error: string }> {
    return saveToolSwitches(dashboardState.token, sw)
  },

  async fetchOnlineAiTools(): Promise<{ ok: boolean; data?: OnlineAiToolsPayload; error?: string }> {
    const res = await fetchOnlineAiTools()
    if (isAdminOk(res)) {
      return { ok: true, data: res.data }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  async saveOnlineAiTools(payload: {
    engine?: Record<string, boolean>
    servers?: Array<{ id: string; enabled?: boolean; tools?: Record<string, boolean> }>
  }): Promise<{
    ok: boolean
    data?: OnlineAiToolsPayload
    persistence?: OnlinePersistenceInfo
    error?: string
  }> {
    const res = await saveOnlineAiTools(payload)
    if (isAdminOk(res)) {
      handlePersistence(res.data.persistence)
      return { ok: true, data: res.data, persistence: res.data.persistence }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  async fetchSetting<T = unknown>(key: string): Promise<{ ok: boolean; value?: T; code?: string; error?: string }> {
    const res = await fetchOnlineSetting<T>(key)
    if (isAdminOk(res)) {
      return { ok: true, value: res.data.value }
    }
    return {
      ok: false,
      code: isAdminError(res) ? res.error.code : undefined,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  async saveSetting<T = unknown>(key: string, value: T): Promise<{ ok: boolean; value?: T; code?: string; error?: string }> {
    const res = await saveOnlineSetting<T>(key, value)
    if (isAdminOk(res)) {
      return { ok: true, value: res.data.value }
    }
    return {
      ok: false,
      code: isAdminError(res) ? res.error.code : undefined,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  // ── Access ──────────────────────────────────────────────────────────────────
  async fetchAccess(): Promise<{ ok: boolean; access?: Record<string, unknown> | null; source?: string; error?: string }> {
    const res = await fetchOnlineAccess()
    if (isAdminOk(res)) {
      return { ok: true, access: res.data.access, source: res.data.source }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  async previewAccess(access: unknown): Promise<PreviewAccessResult> {
    if (dashboardState.mode === 'dev') {
      return previewDevAccess(dashboardState.token, access)
    }
    return { ok: false, error: 'dev_only' }
  },

  async saveAccess(
    access: Record<string, unknown>,
  ): Promise<SaveAccessResult & { persistence?: OnlinePersistenceInfo; status?: DevDashboardStatus }> {
    if (dashboardState.mode === 'dev') {
      return saveDevAccess(dashboardState.token, access)
    }
    const res = await saveOnlineAccess(access)
    if (isAdminOk(res)) {
      handlePersistence(res.data.persistence)
      return {
        ok: true,
        access: res.data.access,
        persistence: res.data.persistence,
      }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  // ── Look / Theme ────────────────────────────────────────────────────────────
  async fetchLook(): Promise<{
    ok: boolean
    theme?: ThemeView | null
    look?: Record<string, unknown>
    error?: string
  }> {
    if (dashboardState.mode === 'dev') {
      const theme = await fetchThemeConfig()
      return { ok: Boolean(theme), theme }
    }
    const res = await fetchOnlineLook()
    if (isAdminOk(res)) {
      return { ok: true, look: res.data.look }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  async saveLook(payload: {
    skin: 'reader' | 'datasheet'
    base: 'paper' | 'sepia' | 'green' | 'dark' | 'custom'
    custom: string
  }): Promise<{
    ok: boolean
    theme?: ThemeView
    look?: Record<string, unknown>
    persistence?: OnlinePersistenceInfo
    error?: string
  }> {
    if (dashboardState.mode === 'dev') {
      const res = await saveThemeConfig(dashboardState.token, payload)
      if (!res.ok) {
        return { ok: false, error: 'error' in res ? res.error : 'save_failed' }
      }
      return { ok: true, theme: res.theme }
    }
    const res = await saveOnlineLook(payload as unknown as Record<string, unknown>)
    if (isAdminOk(res)) {
      handlePersistence(res.data.persistence)
      return {
        ok: true,
        look: res.data.look,
        persistence: res.data.persistence,
      }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  // ── Runtime & Logs ──────────────────────────────────────────────────────────
  async fetchRuntime(): Promise<{
    ok: boolean
    devRuntime?: RuntimePayload | null
    onlineRuntime?: OnlineRuntimePayload | null
    error?: string
  }> {
    if (dashboardState.mode === 'dev') {
      const devRuntime = await fetchRuntime()
      return { ok: Boolean(devRuntime), devRuntime }
    }
    const res = await fetchOnlineRuntime()
    if (isAdminOk(res)) {
      return { ok: true, onlineRuntime: res.data }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  async reloadRuntime(): Promise<{ ok: boolean; reloadedAt?: string; error?: string }> {
    const res = await reloadOnlineRuntime()
    if (isAdminOk(res)) {
      return { ok: true, reloadedAt: res.data.reloadedAt }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  async fetchDevLogs(after: number): Promise<{ lines: DevLogLine[]; last: number } | null> {
    return fetchDevLogs(dashboardState.token, after)
  },

  async fetchOnlineLogs(params?: {
    limit?: number
    level?: string
    category?: string
  }): Promise<{ ok: boolean; logs: OnlineLogEntry[]; total: number; error?: string }> {
    const res = await fetchOnlineLogs(params)
    if (isAdminOk(res)) {
      return { ok: true, logs: res.data.logs, total: res.data.total }
    }
    return {
      ok: false,
      logs: [],
      total: 0,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  // ── Backups ─────────────────────────────────────────────────────────────────
  async fetchBackups(): Promise<{
    ok: boolean
    backupDir?: string
    backups: OnlineBackupEntry[]
    error?: string
  }> {
    const res = await fetchOnlineBackups()
    if (isAdminOk(res)) {
      return { ok: true, backupDir: res.data.backupDir, backups: res.data.backups }
    }
    return {
      ok: false,
      backups: [],
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  async createBackup(): Promise<{
    ok: boolean
    snapshot?: OnlineBackupSnapshot
    error?: string
  }> {
    const res = await createOnlineBackup()
    if (isAdminOk(res)) {
      return { ok: true, snapshot: res.data.snapshot }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },

  async restoreBackup(payload: {
    filename?: string
    archivePath?: string
    dryRun?: boolean
  }): Promise<{
    ok: boolean
    result?: OnlineBackupRestoreResult
    error?: string
  }> {
    const res = await restoreOnlineBackup(payload)
    if (isAdminOk(res)) {
      return { ok: true, result: res.data }
    }
    return {
      ok: false,
      error: isAdminError(res) ? formatAdminError(res.error) : 'request_failed',
    }
  },
}
