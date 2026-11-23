/**
 * search/budget.ts - Post-build size and artifact gate for WP-F3.
 *
 * Verifies on `dist/`:
 *   1. Zero legacy `@localSearchIndex*.js` chunks remain.
 *   2. Every `search/<locale>/` manifest, title index and declared shard exists on disk cleanly.
 *   3. Actual disk byte sizes for root locale satisfy:
 *        - title index <= TITLE_INDEX_MAX_BYTES (1 MiB)
 *        - total of all shards <= SHARDS_TOTAL_MAX_BYTES (8 MiB)
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { SHARDS_TOTAL_MAX_BYTES, TITLE_INDEX_MAX_BYTES, type SearchManifestFile } from './format.ts'

export interface SearchBudgetOptions {
  maxTitleBytes?: number
  maxShardBytes?: number
  rootLocale?: string
}

export interface LocaleDiskSummary {
  locale: string
  titleBytes: number
  shardBytes: number
  shardCount: number
  rawShardBytes: number
}

export interface SearchBudgetReport {
  ok: boolean
  failures: string[]
  locales: Record<string, LocaleDiskSummary>
  legacyLocalSearchChunks: string[]
}

export function inflateShardJson<T = unknown>(compressed: Buffer): T {
  const raw = zlib.inflateRawSync(compressed)
  return JSON.parse(raw.toString('utf8')) as T
}

export function checkDistSearchBudgets(distDir: string, opts: SearchBudgetOptions = {}): SearchBudgetReport {
  const maxTitleBytes = opts.maxTitleBytes ?? TITLE_INDEX_MAX_BYTES
  const maxShardBytes = opts.maxShardBytes ?? SHARDS_TOTAL_MAX_BYTES
  const rootLocale = opts.rootLocale ?? 'root'
  const failures: string[] = []
  const locales: Record<string, LocaleDiskSummary> = {}

  const chunksDir = path.join(distDir, 'assets', 'chunks')
  const legacyLocalSearchChunks: string[] = []
  if (fs.existsSync(chunksDir)) {
    for (const file of fs.readdirSync(chunksDir)) {
      if (/^@localSearchIndex.*\.js$/.test(file)) {
        legacyLocalSearchChunks.push(file)
        failures.push(`[search-legacy] unexpected legacy chunk assets/chunks/${file}`)
      }
    }
  }

  const searchDir = path.join(distDir, 'search')
  if (!fs.existsSync(searchDir)) {
    failures.push(`[search-missing] dist/search directory does not exist in ${distDir}`)
    return { ok: false, failures, locales, legacyLocalSearchChunks }
  }

  const localeDirs = fs
    .readdirSync(searchDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  if (!localeDirs.includes(rootLocale)) {
    failures.push(`[search-missing] missing root locale folder dist/search/${rootLocale}`)
  }

  for (const loc of localeDirs) {
    const locDir = path.join(searchDir, loc)
    const manifestPath = path.join(locDir, 'manifest.json')
    const titlePath = path.join(locDir, 'titles.json')

    if (!fs.existsSync(manifestPath)) {
      failures.push(`[search-missing] search/${loc}/manifest.json is missing`)
      continue
    }
    if (!fs.existsSync(titlePath)) {
      failures.push(`[search-missing] search/${loc}/titles.json is missing`)
      continue
    }

    let manifest: SearchManifestFile
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SearchManifestFile
    } catch {
      failures.push(`[search-corrupt] search/${loc}/manifest.json is invalid JSON`)
      continue
    }
    try {
      JSON.parse(fs.readFileSync(titlePath, 'utf8'))
    } catch {
      failures.push(`[search-corrupt] search/${loc}/titles.json is invalid JSON`)
      continue
    }

    const titleBytes = fs.statSync(titlePath).size
    let shardBytes = 0
    let rawShardBytes = 0
    const shards = Array.isArray(manifest.shards) ? manifest.shards : []

    for (const shard of shards) {
      const shardPath = path.join(locDir, shard.url)
      if (!fs.existsSync(shardPath)) {
        failures.push(`[search-missing] search/${loc}/${shard.url} is missing`)
        continue
      }
      const statSize = fs.statSync(shardPath).size
      shardBytes += statSize
      rawShardBytes += shard.rawBytes ?? 0
      try {
        inflateShardJson(fs.readFileSync(shardPath))
      } catch {
        failures.push(`[search-corrupt] search/${loc}/${shard.url} cannot be inflated as valid JSON`)
      }
    }

    locales[loc] = {
      locale: loc,
      titleBytes,
      shardBytes,
      shardCount: shards.length,
      rawShardBytes,
    }

    if (loc === rootLocale) {
      if (titleBytes > maxTitleBytes) {
        failures.push(`[search-budget] ${loc} titles.json is ${titleBytes} bytes > max ${maxTitleBytes} bytes`)
      }
      if (shardBytes > maxShardBytes) {
        failures.push(`[search-budget] ${loc} shards total is ${shardBytes} bytes > max ${maxShardBytes} bytes`)
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    locales,
    legacyLocalSearchChunks,
  }
}
