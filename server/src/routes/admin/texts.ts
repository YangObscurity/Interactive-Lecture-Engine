import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import type { Db } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import { getSetting } from '../../repo/siteSettings.js'
import { resolveContentDir, saveSiteContentSetting } from '../../services/contentSync.js'

const LOCALES = ['zh', 'en'] as const
const FIELDS = ['name', 'shortName', 'navText', 'tagline', 'description'] as const
const REQUIRED_FIELDS = new Set<string>(['name'])
const FIELD_LIMITS: Record<(typeof FIELDS)[number], number> = {
  name: 60,
  shortName: 30,
  navText: 50,
  tagline: 120,
  description: 300,
}
const FIELD_TOKENS: Record<(typeof FIELDS)[number], readonly string[]> = {
  name: [],
  shortName: [],
  navText: [],
  tagline: [],
  description: ['lectures'],
}

type SiteTextsBlock = Record<(typeof FIELDS)[number], string>
type SiteTexts = Record<(typeof LOCALES)[number], SiteTextsBlock>

function emptyTexts(): SiteTexts {
  const block = (): SiteTextsBlock => ({ name: '', shortName: '', navText: '', tagline: '', description: '' })
  return { zh: block(), en: block() }
}

function isSiteTextsShape(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const rec = v as Record<string, unknown>
  return (
    typeof rec.zh === 'object' &&
    rec.zh !== null &&
    !Array.isArray(rec.zh) &&
    typeof rec.en === 'object' &&
    rec.en !== null &&
    !Array.isArray(rec.en)
  )
}

function validateSiteTexts(input: unknown): { ok: true; texts: SiteTexts } | { ok: false; errors: string[] } {
  if (!isSiteTextsShape(input)) {
    return { ok: false, errors: ['site texts: expected an object with "zh" and "en" blocks'] }
  }
  const record = input as Record<string, unknown>
  const errors: string[] = []
  const texts = emptyTexts()

  for (const loc of LOCALES) {
    const block = record[loc] as Record<string, unknown>
    for (const field of FIELDS) {
      const raw = block[field]
      if (typeof raw !== 'string') {
        errors.push(`${loc}.${field}: must be a string`)
        continue
      }
      const value = raw.trim()
      texts[loc][field] = value
      if (value === '') {
        if (REQUIRED_FIELDS.has(field)) {
          errors.push(`${loc}.${field}: required, must not be empty`)
        }
        continue
      }
      if (value.length > FIELD_LIMITS[field]) {
        errors.push(`${loc}.${field}: longer than ${FIELD_LIMITS[field]} characters`)
        continue
      }
      for (const match of value.matchAll(/\{([^{}]*)\}/g)) {
        const token = match[1] ?? ''
        if (!FIELD_TOKENS[field].includes(token)) {
          errors.push(
            `${loc}.${field}: unknown token ${match[0]} (allowed: ${FIELD_TOKENS[field].map((t) => `{${t}}`).join(', ') || 'none'})`,
          )
        }
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, texts }
}

function readDiskTexts(config: AppConfig): SiteTexts | null {
  const contentDir = resolveContentDir(config)
  if (!contentDir) return null
  const filePath = join(contentDir, 'site-texts.json')
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as unknown
    if (!isSiteTextsShape(raw)) return null
    const rec = raw as Record<string, Record<string, unknown>>
    const out = emptyTexts()
    for (const loc of LOCALES) {
      for (const field of FIELDS) {
        const val = rec[loc]?.[field]
        if (typeof val === 'string') out[loc][field] = val
      }
    }
    return out
  } catch {
    return null
  }
}

export function createAdminTextsRouter(config: AppConfig, db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const fromDb = await getSetting<unknown>(db, 'texts')
    const texts = isSiteTextsShape(fromDb) ? fromDb : readDiskTexts(config)
    return c.json({ ok: true, texts: texts ?? null }, 200)
  })

  router.put('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: { texts?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400)
    }

    const validated = validateSiteTexts(body?.texts)
    if (!validated.ok) {
      return c.json({ ok: false, error: 'validation_failed', details: validated.errors, message: validated.errors[0] }, 400)
    }

    const userId = c.get('userId') ?? 'admin'
    const persistence = await saveSiteContentSetting(db, 'texts', validated.texts, {
      filename: 'site-texts.json',
      effect: 'rebuild_required',
      rebuildReason: 'Site text changes require a site rebuild to take effect in static pages',
      updatedBy: userId,
      config,
    })

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `Site texts updated by ${userId} (${persistence.mode}, ${persistence.effect})`,
    })

    return c.json({ ok: true, texts: validated.texts, persistence }, 200)
  })

  return router
}
