/**
 * content/config.mts - loader for the active site config: `content/site.config.ts` when a content root has one,
 * else `site/lecture.config.ts` (whole file, no merging). Node only; never imported by client code.
 */
import fs from 'node:fs'
import { LectureConfigError, validateLectureConfig } from '../lecture-config.mts'
import type { LectureConfig } from '../lecture-config.mts'
import { resolveContent, type ContentPaths, type ResolveContentOptions } from './paths.mts'
import { loadTsModuleSync } from './ts-loader.mts'

export interface LoadedLectureConfig {
  config: LectureConfig
  file: string
  source: 'content' | 'default'
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
  return { config: validateLectureConfig(exported as LectureConfig), file, source }
}

/** Load and validate the active site config (see `loadLectureConfigInfo`). */
export function loadLectureConfig(options: ResolveContentOptions & { paths?: ContentPaths } = {}): LectureConfig {
  return loadLectureConfigInfo(options).config
}
