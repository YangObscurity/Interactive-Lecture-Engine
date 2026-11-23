/**
 * site/docs/.vitepress/plugins/dashboardDevPlugin.mts
 *
 * VitePress dev-server only middleware (`apply: 'serve'`):
 *   - Serves `/__lecture/api/status`, `/__lecture/api/probe`, `/__lecture/api/env`
 *   - Bound strictly to loopback callers (`127.0.0.1` / `::1`)
 *   - Protects write/probe POST endpoints with a per-process random `x-lecture-dev-token`
 *   - NEVER leaks secret values (doctor reports mask/omit all secrets; POST /env writes `.env` and returns status only)
 *   - Never runs or bundles into production `dist/` builds (`apply: 'serve'`).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Plugin, ViteDevServer } from 'vite'
import { SETTINGS } from '../../../config/schema.ts'
import { LANG_CODES, localeKeyOf } from '../i18n/langs.ts'
import { loadLectureConfig } from '../content/config.mts'
import { resolveContent } from '../content/paths.mts'
import { resolveI18n } from '../lecture-config.mts'
import { resolveGroups } from '../groups-source.mts'
import { validateAccessConfig } from '../access/tiers.ts'
import { resolveBuildAccess } from '../access/build.mts'
import { formatAutheliaYaml, resolveAuthPlan } from '../access/authExport.ts'
import { buildFigureAuditAndGallery } from '../figures/gallery.ts'
import { PROMPT_LIMITS, validateCompanionPrompts, type CompanionPromptsFile } from '../prompts/companion.ts'
import { loadAndValidateSitePrompts, writeSitePromptsFile } from '../prompts/load.mts'
import { formatDoctorText, runDoctor } from '../../../scripts/config/doctor.mts'
import { loadSources, resolveAll, updateEnvText } from '../../../scripts/config/env.mts'
import { loadSiteTexts, saveSiteTexts, validateSiteTexts } from '../site-texts.mts'
import { loadAiContract } from '../prompts/loadContract.mts'
import { invalidateSearchViteCache } from '../search/vitePlugin.mts'
import { invalidateLectureThemeServer } from './lectureThemePlugin.mts'
import {
  buildDevHoverPayload,
  buildLectureContextForDraft,
  discardConceptDraft,
  executeConfirmConcept,
  executeDeleteConcept,
  generateOrSaveConceptDraft,
  listAllConceptsDev,
  previewConfirmConcept,
  previewDeleteConcept,
  resolveConceptContentPaths,
} from '../concepts/devWorkflow.mts'
import {
  addMcpServer,
  commitContentFile,
  gitLogDir,
  gitLogFile,
  gitShowFile,
  isOwnRepo,
  lastBuildTime,
  probeLectureApi,
  readContentSnippet,
  readServerLimits,
  readThemeView,
  readToolsView,
  removeMcpServer,
  runContentCheckProcess,
  saveThemeConfig,
  writeToolSwitches,
  CHECK_CATEGORY_IDS,
  checkOnlyFromBody,
  mergeCheckReport,
  type CheckCategoryId,
  type CheckRun,
  type ToolSwitches,
} from './dashboardDevExtras.mts'
import { captureViteLogger, readDevLogs } from './devLogs.mts'
import { contentWatchState } from './contentWatchPlugin.mts'
import { notePromptsSelfWrite } from './companionPromptsPlugin.mts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SITE_DIR = path.resolve(__dirname, '../../..')
const REPO_ROOT = path.resolve(SITE_DIR, '..')
const API_PREFIX = '/__lecture/api'
const MAX_BODY_BYTES = 256 * 1024

function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false
  const addr = remoteAddress.trim().toLowerCase()
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

export function isLoopbackHostName(hostname: string): boolean {
  let h = hostname.trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1)
  }
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1') {
    return true
  }
  const ipv4Match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (ipv4Match) {
    const octets = [Number(ipv4Match[1]), Number(ipv4Match[2]), Number(ipv4Match[3])]
    return octets.every((o) => o >= 0 && o <= 255)
  }
  return false
}

export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const trimmed = hostHeader.trim().toLowerCase()
  let hostname = trimmed
  if (hostname.startsWith('[')) {
    const closeIdx = hostname.indexOf(']')
    if (closeIdx !== -1) {
      hostname = hostname.slice(1, closeIdx)
    }
  } else {
    const colonIdx = hostname.indexOf(':')
    if (colonIdx !== -1) {
      hostname = hostname.slice(0, colonIdx)
    }
  }
  return isLoopbackHostName(hostname)
}

export function isLoopbackOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true
  try {
    const parsed = new URL(originHeader)
    return isLoopbackHostName(parsed.hostname)
  } catch {
    return false
  }
}

/** The optional BYOK block of a draft request: all three fields must be non-empty strings, otherwise it is ignored. */
function readByokBody(raw: unknown): { baseUrl: string; apiKey: string; model: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  return typeof o.baseUrl === 'string' && o.baseUrl && typeof o.apiKey === 'string' && o.apiKey && typeof o.model === 'string' && o.model
    ? { baseUrl: o.baseUrl, apiKey: o.apiKey, model: o.model }
    : null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= MAX_BODY_BYTES) chunks.push(chunk)
    })
    req.on('end', () => {
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        return
      }
      if (bytes === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {})
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

async function buildDevStatus(csrfToken: string, probe: boolean) {
  const report = await runDoctor({ probe, sources: loadSources({ repoRoot: REPO_ROOT }) })
  const metaMap = new Map(SETTINGS.map((s) => [s.key, s]))
  const settings = report.modules.flatMap((mod) =>
    mod.settings.map((s) => {
      const spec = metaMap.get(s.key)
      return {
        key: s.key,
        module: mod.id,
        kind: s.kind as 'site' | 'env' | 'secret',
        type: s.type,
        status: s.status,
        source: s.source,
        // Extra defense-in-depth: never pass a secret plaintext value from the server.
        displayValue: s.kind === 'secret' ? (s.secret?.set ? `set (length ${s.secret.length ?? 0})` : 'unset') : s.displayValue,
        ...(s.secret ? { secretSet: s.secret.set, ...(s.secret.length !== undefined ? { secretLength: s.secret.length } : {}) } : {}),
        descriptionZh: spec?.description.zh ?? '',
        descriptionEn: spec?.description.en ?? '',
        ...(s.probe ? { probe: s.probe } : {}),
        ...(s.error ? { error: s.error } : {}),
        ...(s.warnings ? { warnings: s.warnings } : {}),
      }
    }),
  )

  // Authelia rules need the site's host (`--domain`); here it comes from SITE_URL like the build's. Without it the
  // page explains how to set it (autheliaPreviewNote) instead of showing the exporter's exception (audit-dashboard #9).
  let autheliaPreview = ''
  let autheliaPreviewNote: { code: 'no_domain' | 'error'; detail?: string } | null = null
  const siteUrl = resolveAll(loadSources({ repoRoot: REPO_ROOT }), SETTINGS.filter((s) => s.key === 'SITE_URL'))[0]?.value
  let domain = ''
  try {
    domain = siteUrl ? new URL(String(siteUrl)).hostname : ''
  } catch {
    domain = ''
  }
  if (!domain) autheliaPreviewNote = { code: 'no_domain' }
  else
    try {
      const paths = resolveContent()
      const lectureConfig = loadLectureConfig({ paths })
      const { GROUPS } = await resolveGroups()
      const i18n = resolveI18n(lectureConfig)
      const localeKeys = LANG_CODES.filter((l) => l !== i18n.root && i18n.locales.includes(l)).map(localeKeyOf)
      const plan = resolveAuthPlan(lectureConfig.access, GROUPS)
      autheliaPreview = formatAutheliaYaml({ plan, groups: GROUPS, localeKeys, domain })
    } catch (err) {
      autheliaPreviewNote = { code: 'error', detail: err instanceof Error ? err.message : String(err) }
    }

  // The access block as the Dashboard page "groups and lectures" shows it (local editable or read only).
  let access: {
    default: string
    enforcement: string
    groups: Array<{ id: string; read: 'public' | 'authenticated' | string[]; own: boolean }>
    configFile: string
    accessFile?: {
      path: string
      exists: boolean
      savedAt: string | null
    }
    rawAccess?: Record<string, unknown>
  } | null = null
  try {
    const paths = resolveContent()
    const cfg = loadLectureConfig({ paths })
    const { GROUPS } = await resolveGroups()
    const a = cfg.access ?? {}
    const def = a.default ?? 'public'
    const accessExists = fs.existsSync(paths.accessFile)
    const accessSavedAt = accessExists ? fs.statSync(paths.accessFile).mtime.toISOString() : null
    const accessRel = path.relative(REPO_ROOT, paths.accessFile).replace(/\\/g, '/')
    access = {
      default: def,
      enforcement: a.enforcement ?? 'none',
      configFile: accessExists ? accessRel : path.relative(REPO_ROOT, paths.siteConfig).replace(/\\/g, '/'),
      accessFile: {
        path: accessRel,
        exists: accessExists,
        savedAt: accessSavedAt,
      },
      rawAccess: a as Record<string, unknown>,
      groups: GROUPS.map((g) => {
        const own = a.groups?.[g.id]
        return { id: g.id, read: own ? own.read : def, own: Boolean(own) }
      }),
    }
  } catch {
    access = null
  }

  return {
    mode: 'dev' as const,
    demo: resolveContent().demo === true,
    csrfToken,
    ok: report.ok,
    errors: report.errors,
    warnings: report.warnings,
    inUseModules: report.inUseModules,
    settings,
    themes: report.themes.map((t) => ({
      id: t.id,
      builtin: t.builtin,
      enabled: t.enabled,
      engine: t.engine,
      errors: t.errors,
    })),
    autheliaPreview,
    autheliaPreviewNote,
    access,
    nodeVersion: process.version,
  }
}

/**
 * S6 decision B: Dashboard endpoints that write into the content folder (AI tool switches, companion prompts, site
 * texts, concept drafts / confirm / discard / delete). While the site shows the engine's demo content (`demo: true`,
 * no content folder of its own yet) they answer 409 `demo_read_only`; every read endpoint, the content check, the
 * probe and the machine-local `.env` (repository root, not the content folder) keep working.
 */
export const DEMO_WRITE_ENDPOINTS: readonly string[] = [
  '/theme',
  '/tools',
  '/tools/servers',
  '/prompts',
  '/texts',
  '/access',
  '/concepts/draft',
  '/concepts/confirm',
  '/concepts/discard',
  '/concepts/delete',
]

/** The 409 answer of a write endpoint while the demo content is shown (same advice as new:group / new:lecture). */
export function demoReadOnlyBody(root: string) {
  return {
    ok: false as const,
    error: 'demo_read_only',
    message:
      `No content folder yet: the site shows the engine's demo content (${root}), which is read only. ` +
      'Run `npm run init` first (or set LECTURE_CONTENT_DIR), then edit your own content.',
    messageZh: `还没有自己的内容目录：站点正在显示引擎自带的示例内容（${root}），示例只读。请先运行 \`npm run init\`（或设置 LECTURE_CONTENT_DIR），再编辑自己的内容。`,
  }
}

export function createDashboardDevHandler(opts?: {
  token?: string
  allowNonLoopbackForTests?: boolean
  promptsFilePath?: string
  accessFilePath?: string
  /** Folder holding `site-texts.json` (tests use a temporary one; default: the active content root). */
  siteDir?: string
  docsRoot?: string
  conceptsDir?: string
  /** Treat the active content as the read-only demo (tests); default: `resolveContent().demo`. */
  demo?: boolean
  onFilesChanged?: (files: readonly string[]) => void
}) {
  const siteDir = opts?.siteDir // undefined: the active content root (content/paths.mts) decides
  /**
   * True when a POST to `subpath` would write into the demo content: the endpoint writes into the content folder, the
   * active content is the demo, and the handler was not pointed at a folder of its own for that file (tests).
   */
  const writesIntoDemo = (subpath: string): boolean => {
    const isDemoEndpoint = DEMO_WRITE_ENDPOINTS.some((ep) => subpath === ep || subpath.startsWith(`${ep}/`))
    if (!isDemoEndpoint) return false
    if (opts?.demo !== undefined) return opts.demo
    if (resolveContent().demo !== true) return false
    if (subpath === '/texts') return !siteDir
    if (subpath === '/prompts') return !opts?.promptsFilePath
    if (subpath === '/access') return !opts?.accessFilePath
    if (subpath.startsWith('/concepts/')) return !opts?.docsRoot && !opts?.conceptsDir
    return true
  }
  const conceptPaths = () =>
    resolveConceptContentPaths({
      docsRoot: opts?.docsRoot,
      conceptsDir: opts?.conceptsDir,
    })
  /** The texts file as the Dashboard form needs it; a broken file shows as "no texts" instead of failing the status. */
  const readTexts = () => {
    try {
      return loadSiteTexts({ siteDir })
    } catch {
      return undefined
    }
  }
  const token = opts?.token || crypto.randomBytes(24).toString('hex')
  const editableKeys = new Set(SETTINGS.filter((s) => s.kind !== 'site').map((s) => s.key))

  const loadDevPrompts = () =>
    loadAndValidateSitePrompts(opts?.promptsFilePath ? { configuredPath: opts.promptsFilePath } : undefined)

  /** The last `check:content` + `doctor` run of this process (content checks page); one run at a time. */
  type DashboardCheckRun = CheckRun & {
    doctor?: { ok: boolean; text: string; errors: string[]; warnings: string[] }
    authoringLocal: string | null
    /** The categories the last run reran on top of the full report (`--only`), null for a full run. */
    only: CheckCategoryId[] | null
  }
  let lastCheck: DashboardCheckRun | null = null
  let checkInFlight: Promise<DashboardCheckRun> | null = null
  let checkInFlightKey: string | null = null

  return async function handleDashboardDev(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(API_PREFIX)) {
      next()
      return
    }

    if (!opts?.allowNonLoopbackForTests && !isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: 'loopback_only' })
      return
    }

    if (!opts?.allowNonLoopbackForTests && !isLoopbackHostHeader(req.headers.host)) {
      sendJson(res, 403, { ok: false, error: 'invalid_host' })
      return
    }

    const reqOrigin = req.headers.origin ? String(req.headers.origin) : undefined
    if (!opts?.allowNonLoopbackForTests && reqOrigin && !isLoopbackOrigin(reqOrigin)) {
      sendJson(res, 403, { ok: false, error: 'invalid_origin' })
      return
    }

    const method = (req.method || 'GET').toUpperCase()
    const subpath = url.pathname.slice(API_PREFIX.length)

    if (method === 'GET' && subpath === '/status') {
      const payload = await buildDevStatus(token, false)
      sendJson(res, 200, { ...payload, texts: readTexts() })
      return
    }

    if (method === 'GET' && subpath === '/concepts/author') {
      sendJson(res, 200, { ok: true, mode: 'dev', csrfToken: token })
      return
    }

    if (method === 'GET' && subpath === '/prompts') {
      try {
        const loaded = loadDevPrompts()
        // The engine's default prompts (the example file), for "restore default" on the companion page.
        let defaults: CompanionPromptsFile | null = null
        try {
          defaults = loadAndValidateSitePrompts({ configuredPath: resolveContent().promptsExample }).prompts
        } catch {
          defaults = null
        }
        sendJson(res, 200, {
          ok: true,
          filePath: path.relative(REPO_ROOT, loaded.filePath).replace(/\\/g, '/'),
          source: loaded.source,
          prompts: loaded.prompts,
          limits: PROMPT_LIMITS,
          defaults,
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'GET' && subpath === '/figures') {
      try {
        const paths = resolveContent()
        const config = loadLectureConfig({ paths })
        const i18n = resolveI18n(config)
        const localeKeys = i18n.locales.filter((l) => l !== i18n.root).map(localeKeyOf)
        const { GROUPS } = await resolveGroups()
        const accessPlan = resolveBuildAccess(config.access, GROUPS)
        const audit = buildFigureAuditAndGallery(
          {
            paths,
            groups: GROUPS,
            localeKeys,
            accessPlan,
          },
          { verifyFiles: false, isBuild: false },
        )
        sendJson(res, 200, {
          ok: audit.ok,
          items: audit.gallery,
          warnings: audit.warnings,
          errors: audit.errors,
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'GET' && subpath === '/concepts') {
      try {
        const items = await listAllConceptsDev(conceptPaths())
        sendJson(res, 200, { ok: true, items })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'GET' && subpath === '/concepts/hover') {
      try {
        const payload = await buildDevHoverPayload(conceptPaths())
        sendJson(res, 200, payload)
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'GET' && subpath === '/concepts/contract') {
      try {
        const contract = loadAiContract('concept-draft')
        const loaded = loadDevPrompts()
        sendJson(res, 200, {
          ok: true,
          contract,
          companionSystem: loaded.prompts.system,
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    // ---- S4b read endpoints (no file contents, no secrets) ----
    if (method === 'GET' && subpath === '/check') {
      sendJson(res, 200, { ok: true, run: lastCheck })
      return
    }

    if (method === 'GET' && subpath === '/runtime') {
      const limits = readServerLimits(REPO_ROOT)
      const api = await probeLectureApi(limits.port)
      const paths = resolveContent()
      const addr = req.socket?.localPort ?? null
      sendJson(res, 200, {
        ok: true,
        limits: { file: limits.file, exists: limits.exists, limits: limits.limits },
        processes: {
          devServer: { up: true, port: addr },
          contentWatch: paths.mode === 'in-place' ? 'in-place' : contentWatchState(),
          lastBuild: lastBuildTime(SITE_DIR),
          lectureApi: { up: api.up, port: limits.port, ...(api.status ? { status: api.status } : {}) },
        },
      })
      return
    }

    if (method === 'GET' && subpath === '/prompts/history') {
      try {
        const loaded = loadDevPrompts()
        const paths = resolveContent()
        const commits = await gitLogFile(loaded.filePath, 30)
        sendJson(res, 200, {
          ok: true,
          file: path.relative(REPO_ROOT, loaded.filePath).replace(/\\/g, '/'),
          ownRepo: paths.mode === 'content' && (await isOwnRepo(paths.root)),
          commits,
        })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'GET' && subpath === '/changes') {
      const paths = resolveContent()
      sendJson(res, 200, { ok: true, commits: await gitLogDir(paths.root, 8) })
      return
    }

    if (method === 'GET' && subpath === '/tools') {
      sendJson(res, 200, { ok: true, ...readToolsView(resolveContent()) })
      return
    }

    if (method === 'GET' && subpath === '/theme') {
      const paths = resolveContent()
      const cfg = loadLectureConfig({ paths })
      sendJson(res, 200, { ok: true, theme: readThemeView(paths, cfg.theme === 'datasheet' ? 'datasheet' : 'reader') })
      return
    }

    const reqToken = String(req.headers['x-lecture-dev-token'] || '')
    if (!reqToken || reqToken !== token) {
      sendJson(res, 403, { ok: false, error: 'invalid_dev_token' })
      return
    }

    // S6 decision B: the demo content ships with the engine and is read only, like new:group / new:lecture.
    if ((method === 'POST' || method === 'DELETE') && writesIntoDemo(subpath)) {
      sendJson(res, 409, demoReadOnlyBody(resolveContent().root))
      return
    }

    // ---- S4b token endpoints: file contents, logs and the check run ----
    if (method === 'GET' && subpath === '/file') {
      const rel = url.searchParams.get('path') ?? ''
      const lineRaw = Number(url.searchParams.get('line') ?? '')
      const snip = readContentSnippet(resolveContent(), rel, Number.isInteger(lineRaw) && lineRaw > 0 ? lineRaw : null)
      if ('error' in snip) sendJson(res, snip.status, { ok: false, error: snip.error })
      else sendJson(res, 200, snip)
      return
    }

    if (method === 'GET' && subpath === '/logs') {
      const after = Number(url.searchParams.get('after') ?? '0')
      sendJson(res, 200, { ok: true, ...readDevLogs(Number.isInteger(after) && after > 0 ? after : 0) })
      return
    }

    if (method === 'GET' && subpath === '/prompts/at') {
      const rev = url.searchParams.get('rev') ?? ''
      try {
        const loaded = loadDevPrompts()
        const text = await gitShowFile(loaded.filePath, rev)
        if (text === null) {
          sendJson(res, 404, { ok: false, error: 'missing' })
          return
        }
        let prompts: unknown = null
        try {
          const parsed: unknown = JSON.parse(text)
          const checked = validateCompanionPrompts(parsed)
          prompts = checked.ok ? checked.value : null
        } catch {
          prompts = null
        }
        sendJson(res, 200, { ok: true, text, prompts })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'POST' && subpath === '/check') {
      const body = await readJsonBody(req).catch(() => ({}))
      const asked = checkOnlyFromBody(body)
      if (asked === 'invalid') {
        sendJson(res, 400, { ok: false, error: 'invalid_only', categories: CHECK_CATEGORY_IDS })
        return
      }
      // one category is only rerun on top of a full report; the first run is always full
      const only = asked && lastCheck?.report && !lastCheck.error ? asked : null
      const key = only ? only.join(',') : '*'
      // a full run in flight answers every request; another partial run waits for the one in flight first
      if (checkInFlight && checkInFlightKey !== '*' && checkInFlightKey !== key) await checkInFlight.catch(() => null)
      if (!checkInFlight) {
        checkInFlightKey = key
        checkInFlight = (async () => {
          const paths = resolveContent()
          const prev = lastCheck
          const [run, doctor] = await Promise.all([
            runContentCheckProcess(SITE_DIR, only),
            only ? Promise.resolve(null) : runDoctor({ probe: false, sources: loadSources({ repoRoot: REPO_ROOT }) }).catch(() => null),
          ])
          let authoringLocal: string | null = null
          try {
            authoringLocal = fs.existsSync(paths.authoringLocal) ? fs.readFileSync(paths.authoringLocal, 'utf8').slice(0, 20_000) : null
          } catch {
            authoringLocal = null
          }
          if (only && prev?.report && run.report) {
            lastCheck = { ...run, report: mergeCheckReport(prev.report, run.report, only), ...(prev.doctor ? { doctor: prev.doctor } : {}), authoringLocal, only }
          } else {
            lastCheck = {
              ...run,
              ...(doctor ? { doctor: { ok: doctor.ok, text: formatDoctorText(doctor), errors: doctor.errors, warnings: doctor.warnings } } : {}),
              authoringLocal,
              only: null,
            }
          }
          return lastCheck
        })().finally(() => {
          checkInFlight = null
          checkInFlightKey = null
        })
      }
      const run = await checkInFlight
      sendJson(res, 200, { ok: true, run })
      return
    }

    if (method === 'POST' && subpath === '/theme') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      const paths = resolveContent()
      const r = saveThemeConfig(paths, body)
      if ('error' in r) {
        sendJson(res, 400, { ok: false, error: r.error, ...(r.reason ? { reason: r.reason } : {}) })
        return
      }
      opts?.onFilesChanged?.([paths.themeFile])
      sendJson(res, 200, { ok: true, theme: r.theme })
      return
    }

    if (method === 'POST' && subpath === '/tools/servers') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      const paths = resolveContent()
      const r = addMcpServer(paths, body)
      if ('error' in r) {
        sendJson(res, 400, { ok: false, error: r.error, ...(r.field ? { field: r.field } : {}) })
        return
      }
      opts?.onFilesChanged?.([paths.aiToolsFile])
      sendJson(res, 200, { ok: true, server: r.server, tools: readToolsView(paths) })
      return
    }

    if (method === 'DELETE' && subpath.startsWith('/tools/servers/')) {
      const serverId = decodeURIComponent(subpath.slice('/tools/servers/'.length))
      const paths = resolveContent()
      const r = removeMcpServer(paths, serverId)
      if ('error' in r) {
        sendJson(res, 400, { ok: false, error: r.error })
        return
      }
      opts?.onFilesChanged?.([paths.aiToolsFile])
      sendJson(res, 200, { ok: true, tools: readToolsView(paths) })
      return
    }

    if (method === 'POST' && subpath === '/tools') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      const paths = resolveContent()
      const r = writeToolSwitches(paths, {
        ...(typeof body.engine === 'object' && body.engine !== null ? { engine: body.engine as Record<string, boolean> } : {}),
        ...(body.servers !== undefined ? { servers: body.servers as NonNullable<ToolSwitches['servers']> } : {}),
      })
      if (!r.ok) {
        sendJson(res, 400, r)
        return
      }
      opts?.onFilesChanged?.([paths.aiToolsFile])
      sendJson(res, 200, { ok: true, ...readToolsView(paths) })
      return
    }

    if (method === 'POST' && subpath === '/probe') {
      await readJsonBody(req).catch(() => ({}))
      const payload = await buildDevStatus(token, true)
      sendJson(res, 200, payload)
      return
    }

    if (method === 'POST' && subpath === '/env') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      const key = typeof body.key === 'string' ? body.key.trim() : ''
      const value = typeof body.value === 'string' ? body.value : ''
      if (!editableKeys.has(key)) {
        sendJson(res, 400, { ok: false, error: `Unknown or read-only setting: ${key}` })
        return
      }
      const envPath = path.join(REPO_ROOT, '.env')
      const currentText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
      const nextText = updateEnvText(currentText, { [key]: value })
      fs.writeFileSync(envPath, nextText, { encoding: 'utf8', mode: 0o600 })
      const status = await buildDevStatus(token, false)
      sendJson(res, 200, { ok: true, key, status })
      return
    }

    if (method === 'POST' && subpath === '/prompts') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }

      const rawPrompts =
        typeof body.prompts === 'object' && body.prompts !== null && !Array.isArray(body.prompts)
          ? (body.prompts as Record<string, unknown>)
          : body

      let current: ReturnType<typeof loadDevPrompts>
      try {
        current = loadDevPrompts()
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        return
      }

      const submittedVersion =
        typeof rawPrompts.version === 'number' && Number.isInteger(rawPrompts.version)
          ? rawPrompts.version
          : current.prompts.version
      const nextVersion = Math.max(current.prompts.version + 1, submittedVersion)
      const candidate: unknown = {
        ...rawPrompts,
        version: nextVersion,
      }
      const checked = validateCompanionPrompts(candidate)
      if (!checked.ok) {
        sendJson(res, 400, { ok: false, error: 'validation_failed', errors: checked.errors })
        return
      }

      writeSitePromptsFile(current.filePath, checked.value)
      // the page that saved already has the file: its own write must not trigger the watcher's full reload
      notePromptsSelfWrite(current.filePath, fs.readFileSync(current.filePath, 'utf8'))
      const saved: CompanionPromptsFile = checked.value
      // A save message (version history) commits this one file, only when the content folder is its own repository.
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      const commit = message ? await commitContentFile(resolveContent(), current.filePath, message) : null
      sendJson(res, 200, {
        ok: true,
        filePath: path.relative(REPO_ROOT, current.filePath).replace(/\\/g, '/'),
        prompts: saved,
        limits: PROMPT_LIMITS,
        ...(commit ? { commit } : {}),
      })
      return
    }

    if (method === 'POST' && subpath === '/texts') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      const incoming = (body.texts ?? body) as unknown
      const validated = validateSiteTexts(incoming)
      if (!validated.valid || !validated.texts) {
        sendJson(res, 400, { ok: false, error: 'validation_failed', errors: validated.errors })
        return
      }
      saveSiteTexts(validated.texts, { siteDir })
      sendJson(res, 200, { ok: true, texts: validated.texts })
      return
    }

    if (method === 'POST' && subpath === '/access') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      const incoming = (body.access ?? body) as unknown
      const { GROUPS } = await resolveGroups()
      const groupIds = GROUPS.map((g) => g.id)
      let validated: ReturnType<typeof validateAccessConfig>
      try {
        validated = validateAccessConfig(incoming, groupIds, 'access.json')
      } catch (err) {
        sendJson(res, 400, { ok: false, error: 'validation_failed', message: err instanceof Error ? err.message : String(err) })
        return
      }
      const paths = resolveContent()
      const targetFile = opts?.accessFilePath ?? paths.accessFile
      const tmpFile = `${targetFile}.tmp.${Date.now()}`
      try {
        fs.mkdirSync(path.dirname(targetFile), { recursive: true })
        fs.writeFileSync(tmpFile, JSON.stringify(validated, null, 2) + '\n', 'utf8')
        fs.renameSync(tmpFile, targetFile)
      } catch (err) {
        try {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
        } catch {
          // ignore cleanup failure
        }
        sendJson(res, 500, { ok: false, error: 'write_failed', message: err instanceof Error ? err.message : String(err) })
        return
      }
      opts?.onFilesChanged?.([targetFile])
      const savedAt = fs.statSync(targetFile).mtime.toISOString()
      const status = opts?.accessFilePath ? null : await buildDevStatus(token, false)
      sendJson(res, 200, {
        ok: true,
        access: validated,
        accessFile: {
          path: path.relative(REPO_ROOT, targetFile).replace(/\\/g, '/'),
          exists: true,
          savedAt,
        },
        ...(status ? { status, autheliaPreview: status.autheliaPreview, autheliaPreviewNote: status.autheliaPreviewNote } : {}),
      })
      return
    }

    if (method === 'POST' && subpath === '/access/preview') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      const incoming = (body.access ?? body) as unknown
      const { GROUPS } = await resolveGroups()
      const groupIds = GROUPS.map((g) => g.id)
      let validated: ReturnType<typeof validateAccessConfig>
      try {
        validated = validateAccessConfig(incoming, groupIds, 'access.json')
      } catch (err) {
        sendJson(res, 400, { ok: false, error: 'validation_failed', message: err instanceof Error ? err.message : String(err) })
        return
      }
      const paths = resolveContent()
      let domain = ''
      try {
        const siteUrl = resolveAll(loadSources({ repoRoot: REPO_ROOT }), SETTINGS.filter((s) => s.key === 'SITE_URL'))[0]?.value
        domain = siteUrl ? new URL(String(siteUrl)).hostname : ''
      } catch {
        domain = ''
      }
      let autheliaPreview = ''
      let autheliaPreviewNote: { code: string; detail?: string } | null = null
      if (!domain) {
        autheliaPreviewNote = { code: 'no_domain' }
      } else {
        try {
          const lectureConfig = loadLectureConfig({ paths })
          const i18n = resolveI18n(lectureConfig)
          const localeKeys = LANG_CODES.filter((l) => l !== i18n.root && i18n.locales.includes(l)).map(localeKeyOf)
          const plan = resolveAuthPlan(validated, GROUPS)
          autheliaPreview = formatAutheliaYaml({ plan, groups: GROUPS, localeKeys, domain })
        } catch (err) {
          autheliaPreviewNote = { code: 'error', detail: err instanceof Error ? err.message : String(err) }
        }
      }
      sendJson(res, 200, { ok: true, autheliaPreview, autheliaPreviewNote })
      return
    }

    if (method === 'POST' && subpath === '/concepts/context') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      try {
        const mode = body.mode === 'edit' ? 'edit' : body.mode === 'supplement' ? 'supplement' : 'create'
        const ctxBuilt = await buildLectureContextForDraft(conceptPaths(), {
          mode,
          lecturePath: String(body.lecturePath ?? ''),
          selectedText: String(body.selectedText ?? ''),
          sectionHeading: typeof body.sectionHeading === 'string' ? body.sectionHeading : undefined,
          beforeContext: typeof body.beforeContext === 'string' ? body.beforeContext : undefined,
          afterContext: typeof body.afterContext === 'string' ? body.afterContext : undefined,
          targetSlug: typeof body.targetSlug === 'string' ? body.targetSlug : undefined,
          aliases: Array.isArray(body.aliases) ? body.aliases.map(String) : undefined,
        })
        if (!ctxBuilt.ok) {
          sendJson(res, 409, ctxBuilt)
          return
        }
        const contract = loadAiContract('concept-draft')
        const prompts = loadDevPrompts()
        sendJson(res, 200, {
          ok: true,
          context: ctxBuilt.context,
          contextChars: ctxBuilt.contextChars,
          selectionSource: ctxBuilt.selectionSource,
          contract,
          companionSystem: prompts.prompts.system,
        })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'POST' && subpath === '/concepts/draft') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      try {
        const draftMode = body.mode === 'edit' ? 'edit' : body.mode === 'supplement' ? 'supplement' : 'create'
        const resDraft = await generateOrSaveConceptDraft(conceptPaths(), {
          mode: draftMode,
          lecturePath: typeof body.lecturePath === 'string' ? body.lecturePath : undefined,
          selectedText: String(body.selectedText ?? ''),
          sectionHeading: typeof body.sectionHeading === 'string' ? body.sectionHeading : undefined,
          beforeContext: typeof body.beforeContext === 'string' ? body.beforeContext : undefined,
          afterContext: typeof body.afterContext === 'string' ? body.afterContext : undefined,
          targetSlug: typeof body.targetSlug === 'string' ? body.targetSlug : undefined,
          instruction: typeof body.instruction === 'string' ? body.instruction : undefined,
          lang: body.lang === 'en' ? 'en' : 'zh',
          byok: readByokBody(body.byok),
          draftPayload: body.draftPayload,
          markdownOverride: typeof body.markdownOverride === 'string' ? body.markdownOverride : undefined,
          onFilesChanged: opts?.onFilesChanged,
        })
        const status = resDraft.ok
          ? 200
          : 'errorCode' in resDraft && resDraft.errorCode === 'DUPLICATE'
            ? 409
            : 'errorCode' in resDraft && resDraft.errorCode === 'SCHEMA_INVALID'
              ? 422
              : 400
        sendJson(res, status, resDraft)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'POST' && subpath === '/concepts/preview-confirm') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      try {
        const result = await previewConfirmConcept(conceptPaths(), {
          slug: String(body.slug ?? ''),
          lecturePath: typeof body.lecturePath === 'string' ? body.lecturePath : undefined,
          selectedText: typeof body.selectedText === 'string' ? body.selectedText : undefined,
          selectedOffsets: Array.isArray(body.selectedOffsets)
            ? body.selectedOffsets.filter((n): n is number => typeof n === 'number')
            : undefined,
          allOccurrences: body.allOccurrences === true,
          skipMount: body.skipMount === true,
        })
        sendJson(res, result.ok ? 200 : 404, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'POST' && subpath === '/concepts/confirm') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      try {
        const result = await executeConfirmConcept(conceptPaths(), {
          slug: String(body.slug ?? ''),
          lecturePath: typeof body.lecturePath === 'string' ? body.lecturePath : undefined,
          selectedText: typeof body.selectedText === 'string' ? body.selectedText : undefined,
          selectedOffsets: Array.isArray(body.selectedOffsets)
            ? body.selectedOffsets.filter((n): n is number => typeof n === 'number')
            : undefined,
          allOccurrences: body.allOccurrences === true,
          skipMount: body.skipMount === true,
          expectedPreviewToken: typeof body.expectedPreviewToken === 'string' ? body.expectedPreviewToken : undefined,
          onFilesChanged: opts?.onFilesChanged,
        })
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'POST' && subpath === '/concepts/discard') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      try {
        sendJson(res, 200, discardConceptDraft(conceptPaths(), String(body.slug ?? ''), opts?.onFilesChanged))
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'POST' && subpath === '/concepts/preview-delete') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      try {
        sendJson(res, 200, await previewDeleteConcept(conceptPaths(), String(body.slug ?? '')))
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (method === 'POST' && subpath === '/concepts/delete') {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid_body' })
        return
      }
      try {
        const deleted = await executeDeleteConcept(
          conceptPaths(),
          String(body.slug ?? ''),
          opts?.onFilesChanged,
          typeof body.expectedPreviewToken === 'string' ? body.expectedPreviewToken : undefined,
        )
        sendJson(res, deleted.ok ? 200 : 409, deleted)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: 'not_found' })
  }
}

export function dashboardDevPlugin(): Plugin {
  let viteServer: ViteDevServer | null = null
  const handler = createDashboardDevHandler({
    onFilesChanged: (files) => {
      invalidateSearchViteCache()
      if (!viteServer) return
      for (const rawFile of files) {
        const abs = path.resolve(rawFile).split(path.sep).join('/')
        viteServer.moduleGraph.onFileChange(abs)
        const mods = viteServer.moduleGraph.getModulesByFile(abs)
        if (mods) {
          for (const mod of mods) viteServer.moduleGraph.invalidateModule(mod)
        }
        if (path.basename(abs) === 'theme.json') {
          invalidateLectureThemeServer()
        }
      }
    },
  })
  return {
    name: 'lecture-dashboard-dev',
    apply: 'serve',
    configureServer(server) {
      viteServer = server
      captureViteLogger(server.config.logger)
      server.middlewares.use((req, res, next) => {
        void handler(req, res, next).catch((err) => {
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        })
      })
    },
  }
}
