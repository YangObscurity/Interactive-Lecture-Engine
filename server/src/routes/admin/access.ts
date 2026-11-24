import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import type { Db } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import { getSetting } from '../../repo/siteSettings.js'
import { resolveContentDir, saveSiteContentSetting } from '../../services/contentSync.js'

const VALID_DEFAULTS = new Set(['public', 'authenticated'])
const VALID_ENFORCEMENTS = new Set(['none', 'gateway'])
const ALLOWED_TOP_KEYS = new Set(['default', 'enforcement', 'groups'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidAccessConfig(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, message: 'access must be an object { default, enforcement, groups }' }
  }
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_TOP_KEYS.has(k)) {
      return { ok: false, message: `Unknown access key "${k}" (expected default, enforcement, groups)` }
    }
  }
  if (raw.default !== undefined && (typeof raw.default !== 'string' || !VALID_DEFAULTS.has(raw.default))) {
    return { ok: false, message: 'access.default must be "public" or "authenticated"' }
  }
  if (raw.enforcement !== undefined && (typeof raw.enforcement !== 'string' || !VALID_ENFORCEMENTS.has(raw.enforcement))) {
    return { ok: false, message: 'access.enforcement must be "none" or "gateway"' }
  }
  if (raw.groups !== undefined) {
    if (!isPlainObject(raw.groups)) {
      return { ok: false, message: 'access.groups must be an object mapping group ids to { read }' }
    }
    for (const [id, rule] of Object.entries(raw.groups)) {
      if (!isPlainObject(rule) || !('read' in rule)) {
        return { ok: false, message: `access.groups.${id} must be an object containing read` }
      }
      for (const rk of Object.keys(rule)) {
        if (rk !== 'read') {
          return { ok: false, message: `access.groups.${id}.${rk} is invalid (expected only read)` }
        }
      }
      const r = rule.read
      const validRead =
        r === 'public' ||
        r === 'authenticated' ||
        (Array.isArray(r) && r.length > 0 && r.every((g) => typeof g === 'string' && g.trim() !== ''))
      if (!validRead) {
        return { ok: false, message: `access.groups.${id}.read must be "public", "authenticated", or a non-empty string array` }
      }
    }
  }
  return {
    ok: true,
    value: {
      default: raw.default ?? 'public',
      enforcement: raw.enforcement ?? 'none',
      groups: raw.groups ?? {},
    },
  }
}

function readDiskAccess(config: AppConfig): Record<string, unknown> | null {
  const contentDir = resolveContentDir(config)
  if (!contentDir) return null
  const filePath = join(contentDir, 'access.json')
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as unknown
    const parsed = isValidAccessConfig(raw)
    return parsed.ok ? parsed.value : null
  } catch {
    return null
  }
}

function detectManifestRestrictions(config: AppConfig): boolean {
  const candidatePaths: string[] = []
  if (config.siteDistDir) {
    candidatePaths.push(
      resolve(config.siteDistDir, '../../../.lecture-build/access-manifest.json'),
      resolve(config.siteDistDir, '../../.lecture-build/access-manifest.json'),
      resolve(config.siteDistDir, '../.lecture-build/access-manifest.json'),
      resolve(config.siteDistDir, '.lecture-build/access-manifest.json'),
      resolve(config.siteDistDir, 'access-manifest.json'),
    )
  }
  candidatePaths.push(
    resolve(process.cwd(), '../site/.lecture-build/access-manifest.json'),
    resolve(process.cwd(), 'site/.lecture-build/access-manifest.json'),
    resolve(process.cwd(), '.lecture-build/access-manifest.json'),
  )
  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as {
          defaultTier?: unknown
          enforcement?: unknown
          tiers?: unknown
        }
        const hasNonPublicDefault = typeof raw.defaultTier === 'string' && raw.defaultTier !== 'public'
        const hasEnforcement = typeof raw.enforcement === 'string' && raw.enforcement !== 'none'
        const hasTiers = Array.isArray(raw.tiers) && raw.tiers.length > 0
        const hasGroups =
          (raw as { groups?: unknown }).groups &&
          typeof (raw as { groups?: unknown }).groups === 'object' &&
          Object.keys((raw as { groups: Record<string, unknown> }).groups).length > 0
        if (hasNonPublicDefault || hasEnforcement || hasTiers || hasGroups) {
          return true
        }
      } catch {
        // ignore parse error
      }
    }
  }
  return false
}

export function createAdminAccessRouter(config: AppConfig, db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const saved = await getSetting<unknown>(db, 'access')
    const validSaved = isValidAccessConfig(saved)
    if (validSaved.ok) {
      return c.json({ ok: true, source: 'db', access: validSaved.value }, 200)
    }

    const diskAccess = readDiskAccess(config)
    if (diskAccess) {
      return c.json({ ok: true, source: 'disk', access: diskAccess }, 200)
    }

    const restricted = detectManifestRestrictions(config)
    return c.json(
      {
        ok: true,
        source: restricted ? 'uninitialized_restricted' : 'none',
        access: null,
      },
      200,
    )
  })

  router.put('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: { access?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400)
    }

    const validated = isValidAccessConfig(body?.access)
    if (!validated.ok) {
      return c.json({ ok: false, error: 'validation_failed', message: validated.message }, 400)
    }

    const existingSaved = await getSetting<unknown>(db, 'access')
    if (
      !isValidAccessConfig(existingSaved).ok &&
      !readDiskAccess(config) &&
      detectManifestRestrictions(config)
    ) {
      return c.json(
        {
          ok: false,
          error: 'uninitialized_restricted_access',
          message:
            'Existing site restrictions detected in build manifest. Initialize content/access.json or export restrictions before editing online.',
        },
        409,
      )
    }

    const userId = c.get('userId') ?? 'admin'
    const persistence = await saveSiteContentSetting(db, 'access', validated.value, {
      filename: 'access.json',
      effect: 'rebuild_required',
      rebuildReason: 'Changes to access tiers require a site rebuild to take effect in static pages',
      updatedBy: userId,
      config,
    })

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `Access configuration updated by ${userId} (${persistence.mode}, ${persistence.effect})`,
    })

    return c.json({ ok: true, access: validated.value, persistence }, 200)
  })

  return router
}
