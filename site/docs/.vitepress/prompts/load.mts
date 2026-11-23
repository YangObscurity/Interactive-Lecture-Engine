/**
 * load.mts — Node-only resolver, reader, validator, and atomic writer for the site prompt file.
 *
 * The default and example locations come from `content/paths.mts` (`<content>/prompts/companion.json`, or
 * `site/prompts/companion.json` in-place); `AI_PROMPTS_FILE` (environment / repo-root `.env`) overrides them
 * identically across config tools and Vite build.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AI_PROMPTS } from '../site.config.mts'
import { resolveContent, siteFilesIn } from '../content/paths.mts'
import { loadSources, parseEnv } from '../../../scripts/config/env.mts'
import { validateCompanionPrompts, type CompanionPromptsFile } from './companion.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_SITE_ROOT = resolve(HERE, '../../..')
export const DEFAULT_REPO_ROOT = resolve(DEFAULT_SITE_ROOT, '..')

export interface ResolvedPromptPath {
  filePath: string
  configured: boolean
  source: 'env' | 'default' | 'example'
}

export interface LoadedPrompts {
  filePath: string
  configured: boolean
  source: 'env' | 'default' | 'example'
  prompts: CompanionPromptsFile
}

function readConfiguredPromptSetting(options?: {
  repoRoot?: string
  env?: Record<string, string | undefined>
}): string | undefined {
  const envObj = options?.env ?? process.env
  const direct = envObj[AI_PROMPTS.envKey]
  if (typeof direct === 'string' && direct.trim() !== '') {
    return direct.trim()
  }
  const repoRoot = options?.repoRoot ?? DEFAULT_REPO_ROOT
  const dotenvPath = resolve(repoRoot, '.env')
  if (existsSync(dotenvPath)) {
    const parsed = parseEnv(readFileSync(dotenvPath, 'utf8'))
    const fromDotenv = parsed[AI_PROMPTS.envKey]
    if (typeof fromDotenv === 'string' && fromDotenv.trim() !== '') {
      return fromDotenv.trim()
    }
  }
  const sources = loadSources({ repoRoot, env: {} })
  const fromSources = sources.dotenv[AI_PROMPTS.envKey]
  return typeof fromSources === 'string' && fromSources.trim() !== '' ? fromSources.trim() : undefined
}

export function resolveSitePromptsPath(options?: {
  siteRoot?: string
  repoRoot?: string
  env?: Record<string, string | undefined>
  configuredPath?: string
}): ResolvedPromptPath {
  const siteRoot = options?.siteRoot ?? DEFAULT_SITE_ROOT
  const repoRoot = options?.repoRoot ?? resolve(siteRoot, '..')
  const rawConfigured = options?.configuredPath?.trim() || readConfiguredPromptSetting({ repoRoot, env: options?.env })

  if (rawConfigured) {
    if (isAbsolute(rawConfigured)) {
      return { filePath: rawConfigured, configured: true, source: 'env' }
    }
    const fromRepo = resolve(repoRoot, rawConfigured)
    if (existsSync(fromRepo)) {
      return { filePath: fromRepo, configured: true, source: 'env' }
    }
    const fromSite = resolve(siteRoot, rawConfigured)
    if (existsSync(fromSite)) {
      return { filePath: fromSite, configured: true, source: 'env' }
    }
    return { filePath: fromRepo, configured: true, source: 'env' }
  }

  // an explicit siteRoot (tests, tools) names a folder with the in-place layout; otherwise the content root decides
  const files = options?.siteRoot ? siteFilesIn(siteRoot) : resolveContent()
  if (existsSync(files.promptsFile)) {
    return { filePath: files.promptsFile, configured: false, source: 'default' }
  }
  return { filePath: files.promptsExample, configured: false, source: 'example' }
}

export function loadAndValidateSitePrompts(options?: {
  siteRoot?: string
  repoRoot?: string
  env?: Record<string, string | undefined>
  configuredPath?: string
}): LoadedPrompts {
  const resolved = resolveSitePromptsPath(options)
  if (!existsSync(resolved.filePath)) {
    throw new Error(`AI companion prompts file not found: ${resolved.filePath}`)
  }

  const rawText = readFileSync(resolved.filePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText) as unknown
  } catch (err) {
    throw new Error(
      `Failed to parse AI companion prompts JSON (${resolved.filePath}): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const checked = validateCompanionPrompts(parsed)
  if (!checked.ok) {
    throw new Error(
      `Invalid AI companion prompts (${resolved.filePath}):\n  - ${checked.errors.join('\n  - ')}`,
    )
  }

  return {
    filePath: resolved.filePath,
    configured: resolved.configured,
    source: resolved.source,
    prompts: checked.value,
  }
}

export function writeSitePromptsFile(
  filePath: string,
  prompts: CompanionPromptsFile,
): void {
  const checked = validateCompanionPrompts(prompts)
  if (!checked.ok) {
    throw new Error(`Refusing to write invalid prompts:\n  - ${checked.errors.join('\n  - ')}`)
  }
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.companion.tmp.${process.pid}.${Date.now()}.json`)
  writeFileSync(tmpPath, JSON.stringify(checked.value, null, 2) + '\n', 'utf8')
  renameSync(tmpPath, filePath)
}
