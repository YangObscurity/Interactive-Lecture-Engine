import { createMCPClient, type MCPClient, type MCPTransport } from '@ai-sdk/mcp'
import type { ToolSet } from 'ai'
import type { AppConfig } from '../config/schema.js'
import type { ToolEngine } from './engine.js'
import { AiToolsConfigStore } from './mcpConfig.js'
import type { AiToolsFileConfig, McpServerConfig, ToolChannel } from './types.js'

export type McpConnectionState = 'connected' | 'disabled' | 'error' | 'disconnected'

export interface ManagedMcpServerStatus {
  id: string
  name: string
  host: string
  enabled: boolean
  connectionState: McpConnectionState
  tools: Array<{ name: string; enabled: boolean }>
}

export interface McpClientFactory {
  (server: McpServerConfig, headers: Record<string, string>): Promise<MCPClient>
}

interface ClientEntry {
  signature: string
  client: MCPClient | null
  state: McpConnectionState
  discoveredTools: string[]
  rawTools: ToolSet
  lastError?: string
}

function serverHostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host
  } catch {
    return 'invalid-url'
  }
}

function resolveHeadersFromEnv(
  headerEnv: Record<string, string>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [headerName, envVarName] of Object.entries(headerEnv)) {
    const val = env[envVarName]
    if (typeof val === 'string' && val.length > 0) {
      out[headerName] = val
    }
  }
  return out
}

function configSignature(server: McpServerConfig, headers: Record<string, string>): string {
  return JSON.stringify({
    url: server.url,
    headers,
    timeoutMs: server.timeoutMs ?? null,
    enabled: server.enabled,
  })
}

export async function createDefaultHttpMcpClient(
  server: McpServerConfig,
  headers: Record<string, string>,
): Promise<MCPClient> {
  const transportConfig: { type: 'http'; url: string; headers?: Record<string, string> } = {
    type: 'http',
    url: server.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  }
  return createMCPClient({ transport: transportConfig })
}

export async function createTransportMcpClient(transport: MCPTransport): Promise<MCPClient> {
  return createMCPClient({ transport })
}

export class ExternalMcpManager {
  readonly configStore: AiToolsConfigStore
  private readonly engine: ToolEngine
  private readonly appConfig: Pick<AppConfig, 'aiToolTimeoutMs'>
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly createClient: McpClientFactory
  private readonly now: () => number
  private readonly entries = new Map<string, ClientEntry>()
  private readonly inFlight = new Map<string, Promise<ClientEntry>>()

  constructor(
    config: Pick<AppConfig, 'aiToolsFile' | 'aiToolTimeoutMs'>,
    engine: ToolEngine,
    options?: {
      env?: Readonly<Record<string, string | undefined>>
      createClient?: McpClientFactory
      now?: () => number
      serverRoot?: string
      cwd?: string
    },
  ) {
    this.appConfig = config
    this.engine = engine
    this.env = options?.env ?? process.env
    this.createClient = options?.createClient ?? createDefaultHttpMcpClient
    this.now = options?.now ?? Date.now
    this.configStore = new AiToolsConfigStore(config, {
      serverRoot: options?.serverRoot,
      cwd: options?.cwd,
    })
  }

  async loadConfig(): Promise<AiToolsFileConfig> {
    return this.configStore.load()
  }

  private async closeEntry(entry: ClientEntry | undefined): Promise<void> {
    if (!entry?.client) return
    const client = entry.client
    entry.client = null
    try {
      await client.close()
    } catch {
      // Best-effort close on shutdown or reload
    }
  }

  private async ensureServerEntry(server: McpServerConfig): Promise<ClientEntry> {
    if (!server.enabled) {
      const existing = this.entries.get(server.id)
      if (existing?.client) await this.closeEntry(existing)
      const disabledEntry: ClientEntry = {
        signature: configSignature(server, {}),
        client: null,
        state: 'disabled',
        discoveredTools: existing?.discoveredTools ?? [],
        rawTools: {},
      }
      this.entries.set(server.id, disabledEntry)
      return disabledEntry
    }

    const headers = resolveHeadersFromEnv(server.headerEnv, this.env)
    const sig = configSignature(server, headers)
    const existing = this.entries.get(server.id)

    if (existing && existing.signature === sig && existing.state === 'connected' && existing.client) {
      return existing
    }

    const active = this.inFlight.get(server.id)
    if (active) return active

    const task = (async (): Promise<ClientEntry> => {
      if (existing?.client) {
        await this.closeEntry(existing)
      }
      try {
        const client = await this.createClient(server, headers)
        const rawTools = await client.tools()
        const discoveredTools = Object.keys(rawTools).sort()
        const connected: ClientEntry = {
          signature: sig,
          client,
          state: 'connected',
          discoveredTools,
          rawTools,
        }
        this.entries.set(server.id, connected)
        return connected
      } catch (err) {
        const message = err instanceof Error ? err.message : 'connect_failed'
        console.warn(
          JSON.stringify({
            evt: 'mcp_connect_error',
            ts: new Date(this.now()).toISOString(),
            serverId: server.id,
            host: serverHostOf(server.url),
            error: message,
          }),
        )
        const failed: ClientEntry = {
          signature: sig,
          client: null,
          state: 'error',
          discoveredTools: existing?.discoveredTools ?? [],
          rawTools: {},
          lastError: message,
        }
        this.entries.set(server.id, failed)
        return failed
      } finally {
        this.inFlight.delete(server.id)
      }
    })()

    this.inFlight.set(server.id, task)
    return task
  }

  /**
   * Resolve enabled external MCP tools for AI SDK `streamText`.
   * Failing servers are skipped and logged so chat keeps working; disabled servers/tools are omitted.
   */
  async getEnabledSdkTools(
    userId: string | null,
    channel: ToolChannel = 'native',
    reservedNames: ReadonlySet<string> = new Set(),
  ): Promise<ToolSet> {
    const cfg = await this.loadConfig()
    const out: ToolSet = {}

    for (const server of cfg.mcpServers) {
      if (!server.enabled) continue
      const entry = await this.ensureServerEntry(server)
      if (entry.state !== 'connected') continue

      const serverTimeout = server.timeoutMs ?? this.appConfig.aiToolTimeoutMs

      for (const [toolName, rawTool] of Object.entries(entry.rawTools)) {
        // Default closed per §8.4: tool must be explicitly enabled.
        if (server.tools[toolName]?.enabled !== true) continue
        if (!rawTool || typeof rawTool !== 'object') continue

        const targetName = reservedNames.has(toolName) || toolName in out ? `${server.id}__${toolName}` : toolName
        const baseTool = rawTool as ToolSet[string]
        const baseExecute = baseTool.execute

        if (typeof baseExecute !== 'function') {
          out[targetName] = baseTool
          continue
        }

        out[targetName] = {
          ...baseTool,
          execute: async (input, options) => {
            const started = this.now()
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              const res = await Promise.race([
                baseExecute(input, options),
                new Promise<never>((_res, rej) => {
                  timer = setTimeout(() => rej(new Error(`MCP tool "${toolName}" timed out after ${serverTimeout}ms`)), serverTimeout)
                }),
              ])
              const bytes = Buffer.byteLength(JSON.stringify(res ?? null), 'utf8')
              this.engine.logToolCall({
                tool: `${server.id}:${toolName}`,
                channel,
                ms: this.now() - started,
                ok: true,
                bytes,
                userId,
              })
              return res
            } catch (err) {
              this.engine.logToolCall({
                tool: `${server.id}:${toolName}`,
                channel,
                ms: this.now() - started,
                ok: false,
                bytes: 0,
                userId,
              })
              throw err
            } finally {
              if (timer !== undefined) clearTimeout(timer)
            }
          },
        } as ToolSet[string]
      }
    }

    return out
  }

  /**
   * Read-only status summary for `GET /api/admin/ai-tools`. Never exposes secret values or env values,
   * and strips URL path/query/credentials down to host only.
   */
  async getAdminStatus(): Promise<{ servers: ManagedMcpServerStatus[] }> {
    const cfg = await this.loadConfig()
    const servers: ManagedMcpServerStatus[] = []

    for (const server of cfg.mcpServers) {
      let entry = this.entries.get(server.id)
      if (!server.enabled) {
        if (entry?.client) await this.closeEntry(entry)
        entry = {
          signature: configSignature(server, {}),
          client: null,
          state: 'disabled',
          discoveredTools: entry?.discoveredTools ?? [],
          rawTools: {},
        }
        this.entries.set(server.id, entry)
      }

      const discoveredSet = new Set<string>(entry?.discoveredTools ?? [])
      for (const configuredTool of Object.keys(server.tools)) {
        discoveredSet.add(configuredTool)
      }

      servers.push({
        id: server.id,
        name: server.name,
        host: serverHostOf(server.url),
        enabled: server.enabled,
        connectionState: !server.enabled ? 'disabled' : (entry?.state ?? 'disconnected'),
        tools: [...discoveredSet].sort().map((toolName) => ({
          name: toolName,
          enabled: server.enabled && server.tools[toolName]?.enabled === true,
        })),
      })
    }

    return { servers }
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map((e) => this.closeEntry(e)))
  }
}
