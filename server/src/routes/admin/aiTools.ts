import type { Context } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import type { Db } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import { saveSiteContentSetting } from '../../services/contentSync.js'
import { ENGINE_TOOL_NAMES, normalizeAiToolsConfig, type AiToolsFileConfig } from '../../tools/index.js'
import type { AiRuntime } from '../ai/runtime.js'

async function buildAiToolsPayload(config: AppConfig, rt: AiRuntime) {
  const toolsConfig = await rt.mcpManager.loadConfig()
  const mcpStatus = await rt.mcpManager.getAdminStatus()
  const stats7d = rt.toolEngine.stats.snapshot()

  const engineTools = ENGINE_TOOL_NAMES.map((name) => {
    const stat = stats7d[name]
    return {
      name,
      enabled: toolsConfig.engineTools[name]?.enabled ?? true,
      calls7d: stat?.calls ?? 0,
      errors7d: stat?.errors ?? 0,
    }
  })

  const mcpServers = mcpStatus.servers.map((srv) => ({
    id: srv.id,
    name: srv.name,
    host: srv.host,
    enabled: srv.enabled,
    connectionState: srv.connectionState,
    tools: srv.tools.map((t) => {
      const key = `${srv.id}:${t.name}`
      const stat = stats7d[key]
      return {
        name: t.name,
        enabled: t.enabled,
        calls7d: stat?.calls ?? 0,
        errors7d: stat?.errors ?? 0,
      }
    }),
  }))

  return {
    mcpEndpoint: {
      enabled: Boolean(config.aiMcpToken && config.aiMcpToken.trim() !== ''),
      path: '/api/mcp',
    },
    engineTools,
    mcpServers,
    settings: {
      provider: config.aiProvider,
      maxSteps: config.aiToolMaxSteps,
      timeoutMs: config.aiToolTimeoutMs,
      maxResultBytes: config.aiToolMaxResultBytes,
      mcpTokenSet: Boolean(config.aiMcpToken && config.aiMcpToken.trim() !== ''),
      ticketSecretSet: Boolean(config.aiMcpTicketSecret && config.aiMcpTicketSecret.trim() !== ''),
      source: 'server/.env',
    },
    statsSource: 'memory',
    toolCallCounts7d: stats7d,
  }
}

export function createAdminAiToolsHandler(config: AppConfig, rt: AiRuntime) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    c.header('Cache-Control', 'no-store')
    c.header('Date', new Date().toUTCString())
    return c.json(await buildAiToolsPayload(config, rt), 200)
  }
}

export function createAdminAiToolsSaveHandler(config: AppConfig, db: Db, rt: AiRuntime) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    c.header('Cache-Control', 'no-store')
    let body: {
      engine?: unknown
      servers?: unknown
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'invalid_request', message: 'Invalid JSON body' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ ok: false, error: 'invalid_request', message: 'Expected JSON object' }, 400)
    }

    const current = await rt.mcpManager.loadConfig()
    const nextEngine: AiToolsFileConfig['engineTools'] = { ...current.engineTools }
    const allowedEngine = new Set<string>(ENGINE_TOOL_NAMES)

    if (body.engine !== undefined) {
      if (!body.engine || typeof body.engine !== 'object' || Array.isArray(body.engine)) {
        return c.json({ ok: false, error: 'validation_failed', message: 'engine must be a map of tool switches' }, 400)
      }
      for (const [k, v] of Object.entries(body.engine as Record<string, unknown>)) {
        if (!allowedEngine.has(k) || typeof v !== 'boolean') {
          return c.json({ ok: false, error: 'validation_failed', message: `Invalid engine tool switch "${k}"` }, 400)
        }
        nextEngine[k] = { enabled: v }
      }
    }

    const nextServers = current.mcpServers.map((s) => ({
      ...s,
      headerEnv: { ...s.headerEnv },
      tools: Object.fromEntries(Object.entries(s.tools).map(([k, v]) => [k, { enabled: v.enabled }])),
    }))

    if (body.servers !== undefined) {
      if (!Array.isArray(body.servers)) {
        return c.json({ ok: false, error: 'validation_failed', message: 'servers must be an array' }, 400)
      }
      for (const item of body.servers) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return c.json({ ok: false, error: 'validation_failed', message: 'Each server entry must be an object' }, 400)
        }
        const rec = item as { id?: unknown; enabled?: unknown; tools?: unknown }
        if (typeof rec.id !== 'string' || !rec.id.trim()) {
          return c.json({ ok: false, error: 'validation_failed', message: 'Server entry missing id' }, 400)
        }
        const target = nextServers.find((s) => s.id === rec.id)
        if (!target) {
          return c.json(
            {
              ok: false,
              error: 'validation_failed',
              message: `Unknown MCP server "${rec.id}"; add servers via ai-tools.json + server/.env`,
            },
            400,
          )
        }
        if (rec.enabled !== undefined) {
          if (typeof rec.enabled !== 'boolean') {
            return c.json({ ok: false, error: 'validation_failed', message: `Server "${rec.id}" enabled must be boolean` }, 400)
          }
          target.enabled = rec.enabled
        }
        if (rec.tools !== undefined) {
          if (!rec.tools || typeof rec.tools !== 'object' || Array.isArray(rec.tools)) {
            return c.json({ ok: false, error: 'validation_failed', message: `Server "${rec.id}" tools must be a map` }, 400)
          }
          for (const [toolName, toolVal] of Object.entries(rec.tools as Record<string, unknown>)) {
            if (typeof toolVal !== 'boolean') {
              return c.json({ ok: false, error: 'validation_failed', message: `Tool "${toolName}" switch must be boolean` }, 400)
            }
            target.tools[toolName] = { enabled: toolVal }
          }
        }
      }
    }

    const nextConfig = normalizeAiToolsConfig({
      version: 1,
      engineTools: nextEngine,
      mcpServers: nextServers,
    })

    const userId = c.get('userId') ?? 'admin'
    const persistence = await saveSiteContentSetting(db, 'ai_tools', nextConfig, {
      filename: 'ai-tools.json',
      effect: 'live',
      updatedBy: userId,
      config,
    })
    await rt.mcpManager.applyConfigOverride(nextConfig)

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `AI tool configuration updated by ${userId} (${persistence.mode})`,
    })

    const payload = await buildAiToolsPayload(config, rt)
    return c.json({ ok: true, persistence, ...payload }, 200)
  }
}
