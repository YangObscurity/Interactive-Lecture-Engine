import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import type { Db } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import { getSetting } from '../../repo/siteSettings.js'
import { resolveContentDir, saveSiteContentSetting } from '../../services/contentSync.js'

type SkinId = 'reader' | 'datasheet'
type BaseId = 'paper' | 'sepia' | 'green' | 'dark' | 'custom'

export interface LookView {
  skin: SkinId
  base: BaseId
  custom: string
}

const VALID_SKINS = new Set<SkinId>(['reader', 'datasheet'])
const VALID_BASES = new Set<BaseId>(['paper', 'sepia', 'green', 'dark', 'custom'])
const HEX_RE = /^#[0-9a-fA-F]{6}$/
const DEFAULT_CUSTOM_HEX = '#EAF2E3'

const BASE_COLORS: Record<Exclude<BaseId, 'custom'>, { bg: string; surface: string }> = {
  paper: { bg: '#FFFFFF', surface: '#F6F7F9' },
  sepia: { bg: '#F7F1E1', surface: '#EFE8D4' },
  green: { bg: '#D5EBD7', surface: '#C9E3CC' },
  dark: { bg: '#17191E', surface: '#1F232A' },
}

const SKIN_PALETTES: Record<SkinId, { light: Record<string, string>; dark: Record<string, string> }> = {
  reader: {
    light: { text: '#1f2328', 'text-muted': '#57606a', accent: '#2155c4', danger: '#c4302b' },
    dark: { text: '#e2e5e9', 'text-muted': '#9aa3ae', accent: '#7ea8ff', danger: '#ff7b72' },
  },
  datasheet: {
    light: { text: '#1c2b3a', 'text-muted': '#52606d', accent: '#0f5b3e', danger: '#b3261e' },
    dark: { text: '#e6ece7', 'text-muted': '#9db0a4', accent: '#4fb386', danger: '#f07068' },
  },
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.slice(1)
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ]
}

function luminance(hex: string): number {
  const [r, g, b] = parseHexRgb(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function isDarkHex(hex: string): boolean {
  return contrastRatio(hex, '#000000') < contrastRatio(hex, '#FFFFFF')
}

function extractLookView(raw: unknown): LookView {
  const fallback: LookView = { skin: 'reader', base: 'paper', custom: DEFAULT_CUSTOM_HEX }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  const rec = raw as Record<string, unknown>
  const extRoot = rec.$extensions && typeof rec.$extensions === 'object' ? (rec.$extensions as Record<string, unknown>) : null
  const ext = extRoot && typeof extRoot['org.lecture-engine'] === 'object' ? (extRoot['org.lecture-engine'] as Record<string, unknown>) : null
  const rawSkin = rec.skin ?? ext?.defaultSkin ?? ext?.skin ?? rec.theme
  const rawBase = rec.base ?? ext?.defaultBase ?? ext?.base
  const rawCustom = rec.custom ?? ext?.customTint ?? ext?.custom
  const skin: SkinId = rawSkin === 'datasheet' ? 'datasheet' : 'reader'
  const base: BaseId = typeof rawBase === 'string' && VALID_BASES.has(rawBase as BaseId) ? (rawBase as BaseId) : 'paper'
  const custom = typeof rawCustom === 'string' && HEX_RE.test(rawCustom.trim()) ? rawCustom.trim().toUpperCase() : DEFAULT_CUSTOM_HEX
  return { skin, base, custom }
}

function readDiskTheme(config: AppConfig): unknown | null {
  const contentDir = resolveContentDir(config)
  if (!contentDir) return null
  const themeFile = join(contentDir, 'theme.json')
  if (!existsSync(themeFile)) return null
  try {
    return JSON.parse(readFileSync(themeFile, 'utf8').replace(/^\uFEFF/, '')) as unknown
  } catch {
    return null
  }
}

export function createAdminLookRouter(config: AppConfig, db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const saved = (await getSetting(db, 'look')) ?? readDiskTheme(config)
    return c.json({ ok: true, look: extractLookView(saved) }, 200)
  })

  router.put('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: { look?: unknown; skin?: unknown; base?: unknown; custom?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400)
    }

    const candidate =
      body?.look && typeof body.look === 'object' && !Array.isArray(body.look)
        ? (body.look as Record<string, unknown>)
        : body && typeof body === 'object' && !Array.isArray(body) && ('skin' in body || 'base' in body)
          ? (body as Record<string, unknown>)
          : null
    if (!candidate) {
      return c.json({ error: 'invalid_request', message: 'Missing look object { skin, base, custom }' }, 400)
    }

    if (typeof candidate.skin !== 'string' || !VALID_SKINS.has(candidate.skin as SkinId)) {
      return c.json({ ok: false, error: 'validation_failed', message: 'skin must be "reader" or "datasheet"' }, 400)
    }
    if (typeof candidate.base !== 'string' || !VALID_BASES.has(candidate.base as BaseId)) {
      return c.json({ ok: false, error: 'validation_failed', message: 'base must be one of paper, sepia, green, dark, custom' }, 400)
    }
    const skin = candidate.skin as SkinId
    const base = candidate.base as BaseId
    const rawCustom = typeof candidate.custom === 'string' ? candidate.custom.trim().toUpperCase() : ''
    if (base === 'custom' && !HEX_RE.test(rawCustom)) {
      return c.json({ ok: false, error: 'invalid_hex', message: 'custom base requires a 6-digit hex color (#RRGGBB)' }, 400)
    }
    const custom = HEX_RE.test(rawCustom) ? rawCustom : DEFAULT_CUSTOM_HEX

    const bg = base === 'custom' ? custom : BASE_COLORS[base].bg
    const surface = base === 'custom' ? custom : BASE_COLORS[base].surface
    const isDark = base === 'dark' || (base === 'custom' && isDarkHex(bg))
    const palette = SKIN_PALETTES[skin][isDark ? 'dark' : 'light']
    const checks: Array<[string, string, number]> = [
      ['text', palette.text!, 4.5],
      ['text-muted', palette['text-muted']!, 4.5],
      ['accent', palette.accent!, 4.5],
      ['danger', palette.danger!, 3.0],
    ]
    for (const [name, color, min] of checks) {
      const ratio = contrastRatio(bg, color)
      if (ratio < min) {
        return c.json(
          {
            ok: false,
            error: 'contrast_check_failed',
            message: `${name} ${ratio.toFixed(1)}:1 < ${min}:1`,
          },
          400,
        )
      }
    }

    const dtcgDoc: Record<string, unknown> = {
      $extensions: {
        'org.lecture-engine': {
          id: skin,
          contract: 1,
          skin,
          base,
          custom,
          defaultSkin: skin,
          defaultBase: base,
          customTint: custom,
        },
      },
      skin,
      base,
      custom,
    }
    if (base === 'custom') {
      const modeKey = isDark ? 'dark' : 'custom'
      dtcgDoc.modes = {
        [modeKey]: {
          bg: { $type: 'color', $value: bg },
          surface: { $type: 'color', $value: surface },
        },
      }
    }

    const userId = c.get('userId') ?? 'admin'
    const persistence = await saveSiteContentSetting(db, 'look', dtcgDoc, {
      filename: 'theme.json',
      effect: 'rebuild_required',
      rebuildReason: 'Theme and style changes require a site rebuild to take effect in static pages',
      updatedBy: userId,
      config,
    })

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `Theme look updated by ${userId} (${persistence.mode}, ${persistence.effect})`,
    })

    const look: LookView = { skin, base, custom }
    return c.json({ ok: true, look, persistence }, 200)
  })

  return router
}
