/**
 * content/config.mts - loader for the active site config: `content/site.config.ts` when a content root has one,
 * else `site/lecture.config.ts` (whole file, no merging). Node only; never imported by client code.
 */
import fs from 'node:fs'
import { LectureConfigError, validateLectureConfig } from '../lecture-config.mts'
import type { LectureConfig } from '../lecture-config.mts'
import { AccessConfigError, validateAccessConfig } from '../access/tiers.ts'
import { resolveContent, type ContentPaths, type ResolveContentOptions } from './paths.mts'
import { loadTsModuleSync } from './ts-loader.mts'

export interface LoadedLectureConfig {
  config: LectureConfig
  file: string
  source: 'content' | 'default'
  accessFile?: string
}

/**
 * Strips UTF-8 BOM and single-line/multi-line comments from JSON string while preserving strings.
 */
export function stripJsonCommentsAndBom(raw: string): string {
  const noBom = raw.replace(/^\uFEFF/, '').replace(/\uFEFF/g, '')
  return noBom.replace(
    /("(?:[^"\\]|\\.)*")|(\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)/g,
    (match, strGroup) => (strGroup !== undefined ? strGroup : '')
  )
}

export function resolveSiteConfigFile(paths: ContentPaths = resolveContent()): { file: string; source: 'content' | 'default' } {
  if (paths.mode === 'content' && fs.existsSync(paths.siteConfig)) {
    return { file: paths.siteConfig, source: 'content' }
  }
  return { file: paths.defaultSiteConfig, source: 'default' }
}

/**
 * A config file may call `defineLectureConfig` from its own copy of lecture-config.mts (jiti loads the file
 * separately from the engine), so its errors are not instances of the engine's class: re-raise them as the
 * engine's `LectureConfigError` (same message, original as `cause`).
 */
function asEngineError(err: unknown): unknown {
  if (err instanceof Error && err.name === 'LectureConfigError' && !(err instanceof LectureConfigError)) {
    return new LectureConfigError(err.message, { cause: err })
  }
  return err
}

/**
 * Load and validate the active site config along with metadata about which file was loaded.
 * Errors from the file itself (syntax, runtime) point to the real file and line.
 */
export function loadLectureConfigInfo(options: ResolveContentOptions & { paths?: ContentPaths } = {}): LoadedLectureConfig {
  const paths = options.paths ?? resolveContent(options)
  const { file, source } = resolveSiteConfigFile(paths)
  let exported: unknown
  try {
    exported = loadTsModuleSync<{ default?: unknown }>(file).default
  } catch (err) {
    throw asEngineError(err)
  }
  if (!exported || typeof exported !== 'object' || Array.isArray(exported)) {
    throw new LectureConfigError(`lecture.config.ts: ${file} must default-export a configuration object`)
  }
  let config = validateLectureConfig(exported as LectureConfig)

  let loadedAccessFile: string | undefined
  if (paths.accessFile && fs.existsSync(paths.accessFile)) {
    loadedAccessFile = paths.accessFile
    let raw: string
    try {
      raw = fs.readFileSync(paths.accessFile, 'utf8')
    } catch (err) {
      throw new LectureConfigError(`access.json: unable to read ${paths.accessFile}: ${(err as Error).message}`, { cause: err })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(stripJsonCommentsAndBom(raw))
    } catch (err) {
      throw new LectureConfigError(`access.json: ${paths.accessFile} is not valid JSON: ${(err as Error).message}`, { cause: err })
    }
    try {
      const access = validateAccessConfig(parsed, undefined, paths.accessFile)
      config = { ...config, access }
    } catch (err) {
      if (err instanceof AccessConfigError) {
        throw new LectureConfigError(err.message, { cause: err })
      }
      throw err
    }
  }

  return { config, file, source, ...(loadedAccessFile ? { accessFile: loadedAccessFile } : {}) }
}

/** Load and validate the active site config (see `loadLectureConfigInfo`). */
export function loadLectureConfig(options: ResolveContentOptions & { paths?: ContentPaths } = {}): LectureConfig {
  return loadLectureConfigInfo(options).config
}
