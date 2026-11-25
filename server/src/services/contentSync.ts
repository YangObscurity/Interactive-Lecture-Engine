import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import type { AppConfig } from '../config/schema.js'
import type { Db } from '../db/types.js'
import { setSetting } from '../repo/siteSettings.js'

export function resolveContentDir(config?: AppConfig): string | null {
  const rawEnv = process.env.CONTENT_DIR ?? process.env.LECTURE_CONTENT_DIR
  if (rawEnv !== undefined) {
    const trimmed = rawEnv.trim()
    if (!trimmed) return null
    return existsSync(trimmed) ? trimmed : null
  }
  if (config?.siteDistDir) {
    const parentContent = resolve(config.siteDistDir, '../content')
    if (existsSync(parentContent)) return parentContent
  }
  // Try <repo>/content
  const cwdContent = resolve(process.cwd(), '../content')
  if (existsSync(cwdContent)) {
    return cwdContent
  }
  const localContent = resolve(process.cwd(), 'content')
  if (existsSync(localContent)) {
    return localContent
  }
  return null
}

export function atomicWriteJsonFile(dir: string, relativePath: string, data: unknown): boolean {
  let tmpPath: string | null = null
  try {
    const baseDir = resolve(dir)
    const targetPath = resolve(baseDir, relativePath)
    if (targetPath !== baseDir && !targetPath.startsWith(baseDir + sep)) {
      throw new Error(`Path escapes target directory: ${relativePath}`)
    }
    mkdirSync(dirname(targetPath), { recursive: true })
    tmpPath = `${targetPath}.tmp.${randomBytes(6).toString('hex')}`
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmpPath, targetPath)
    tmpPath = null
    return true
  } catch (err) {
    if (tmpPath) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // ignore cleanup error
      }
    }
    console.warn(`[contentSync] Failed to write to disk (${relativePath}):`, err)
    return false
  }
}

export interface PersistenceResult {
  mode: 'db+disk' | 'db'
  effect: 'live' | 'rebuild_required'
  rebuildReason?: string
}

export async function saveSiteContentSetting<T>(
  db: Db,
  key: string,
  value: T,
  options: {
    filename?: string
    effect?: 'live' | 'rebuild_required'
    rebuildReason?: string
    updatedBy?: string
    config?: AppConfig
    onSaved?: () => void
  },
): Promise<PersistenceResult> {
  // 1. Save to database (site_settings & site_settings_history)
  await setSetting(db, key, value, options.updatedBy ?? 'admin')

  // 2. Try writing to CONTENT_DIR
  let wroteToDisk = false
  const contentDir = resolveContentDir(options.config)
  if (contentDir && options.filename) {
    wroteToDisk = atomicWriteJsonFile(contentDir, options.filename, value)
  }

  // 3. Trigger callback (e.g. reload prompt store)
  if (options.onSaved) {
    try {
      options.onSaved()
    } catch (e) {
      console.warn('[contentSync] onSaved callback failed:', e)
    }
  }

  const effect = options.effect ?? 'live'
  return {
    mode: wroteToDisk ? 'db+disk' : 'db',
    effect,
    ...(effect === 'rebuild_required' ? { rebuildReason: options.rebuildReason } : {}),
  }
}
