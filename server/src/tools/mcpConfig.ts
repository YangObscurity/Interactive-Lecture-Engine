import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { AppConfig } from '../config/schema.js'
import { ENGINE_TOOL_NAMES, type AiToolsFileConfig } from './types.js'

const TOOLS_DIR = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_SERVER_ROOT = resolve(TOOLS_DIR, '../..')

const headerEnvSchema = z.record(z.string().min(1), z.string().min(1))

const mcpServerConfigSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  url: z.string().url(),
  headerEnv: headerEnvSchema.default({}),
  enabled: z.boolean().default(false),
  tools: z.record(z.string().min(1), z.object({ enabled: z.boolean().default(false) })).default({}),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
})

export const aiToolsFileSchema = z.object({
  version: z.literal(1),
  engineTools: z
    .record(z.string().min(1), z.object({ enabled: z.boolean().default(true) }))
    .default({}),
  mcpServers: z.array(mcpServerConfigSchema).default([]),
})

export function defaultAiToolsConfig(): AiToolsFileConfig {
  const engineTools: AiToolsFileConfig['engineTools'] = {}
  for (const name of ENGINE_TOOL_NAMES) {
    engineTools[name] = { enabled: true }
  }
  return {
    version: 1,
    engineTools,
    mcpServers: [],
  }
}

type ResolveContentFn = (options?: { repoRoot?: string; env?: Readonly<Record<string, string | undefined>> }) => {
  mode: 'content' | 'in-place'
  root: string
  siteRoot: string
  aiToolsFile?: string
}

async function resolveViaContentPaths(serverRoot: string): Promise<string | null> {
  const repoRoot = resolve(serverRoot, '..')
  const pathsMts = resolve(repoRoot, 'site/docs/.vitepress/content/paths.mts')
  if (!existsSync(pathsMts)) return null

  try {
    const mod = (await import(pathToFileURL(pathsMts).href)) as { resolveContent?: ResolveContentFn }
    if (typeof mod.resolveContent !== 'function') return null
    const paths = mod.resolveContent({ repoRoot })
    if (typeof paths.aiToolsFile === 'string' && paths.aiToolsFile.length > 0) {
      return paths.aiToolsFile
    }
    return paths.mode === 'content'
      ? resolve(paths.root, 'ai-tools.json')
      : resolve(paths.siteRoot, 'ai-tools.json')
  } catch {
    return null
  }
}

export async function resolveAiToolsFilePath(
  configuredPath: string | null | undefined,
  options?: { serverRoot?: string; cwd?: string },
): Promise<string | null> {
  const serverRoot = options?.serverRoot ?? DEFAULT_SERVER_ROOT
  const cwd = options?.cwd ?? process.cwd()
  const raw = typeof configuredPath === 'string' ? configuredPath.trim() : ''

  if (raw) {
    if (isAbsolute(raw)) return raw
    const fromCwd = resolve(cwd, raw)
    if (existsSync(fromCwd)) return fromCwd
    const fromServer = resolve(serverRoot, raw)
    if (existsSync(fromServer)) return fromServer
    const fromRepo = resolve(serverRoot, '..', raw)
    if (existsSync(fromRepo)) return fromRepo
    return fromCwd
  }

  const fromContent = await resolveViaContentPaths(serverRoot)
  if (fromContent) return fromContent

  const candidates = [
    resolve(serverRoot, 'ai-tools.json'),
    resolve(serverRoot, '../content/ai-tools.json'),
    resolve(serverRoot, '../site/ai-tools.json'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function normalizeAiToolsConfig(raw: unknown): AiToolsFileConfig {
  const parsed = aiToolsFileSchema.parse(raw)
  const engineTools: AiToolsFileConfig['engineTools'] = {}
  for (const name of ENGINE_TOOL_NAMES) {
    engineTools[name] = { enabled: parsed.engineTools[name]?.enabled ?? true }
  }
  for (const [k, v] of Object.entries(parsed.engineTools)) {
    engineTools[k] = { enabled: v.enabled }
  }
  return {
    version: 1,
    engineTools,
    mcpServers: parsed.mcpServers.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      headerEnv: s.headerEnv,
      enabled: s.enabled,
      tools: s.tools,
      ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
    })),
  }
}

export class AiToolsConfigStore {
  private readonly configuredPath: string | null
  private readonly serverRoot?: string
  private readonly cwd?: string
  private resolvedPathPromise: Promise<string | null> | null = null
  private cachedMtimeMs = -1
  private cachedSize = -1
  private cachedValue: AiToolsFileConfig | null = null

  constructor(
    config: Pick<AppConfig, 'aiToolsFile'>,
    options?: { serverRoot?: string; cwd?: string },
  ) {
    this.configuredPath = config.aiToolsFile
    this.serverRoot = options?.serverRoot
    this.cwd = options?.cwd
  }

  async getPath(): Promise<string | null> {
    if (!this.resolvedPathPromise) {
      this.resolvedPathPromise = resolveAiToolsFilePath(this.configuredPath, {
        serverRoot: this.serverRoot,
        cwd: this.cwd,
      })
    }
    return this.resolvedPathPromise
  }

  async load(): Promise<AiToolsFileConfig> {
    const filePath = await this.getPath()
    if (!filePath || !existsSync(filePath)) {
      this.cachedValue = null
      this.cachedMtimeMs = -1
      this.cachedSize = -1
      return defaultAiToolsConfig()
    }
    const stat = statSync(filePath)
    if (this.cachedValue && this.cachedMtimeMs === stat.mtimeMs && this.cachedSize === stat.size) {
      return this.cachedValue
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    const normalized = normalizeAiToolsConfig(raw)
    this.cachedMtimeMs = stat.mtimeMs
    this.cachedSize = stat.size
    this.cachedValue = normalized
    return normalized
  }
}
