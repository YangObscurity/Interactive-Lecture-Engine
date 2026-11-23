import type { Context } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import { ENGINE_TOOL_NAMES } from '../../tools/index.js'
import type { AiRuntime } from '../ai/runtime.js'

export function createAdminAiToolsHandler(config: AppConfig, rt: AiRuntime) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    c.header('Cache-Control', 'no-store')
    c.header('Date', new Date().toUTCString())

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

    return c.json(
      {
        mcpEndpoint: {
          enabled: Boolean(config.aiMcpToken && config.aiMcpToken.trim() !== ''),
          path: '/api/mcp',
        },
        engineTools,
        mcpServers,
        statsSource: 'memory',
        toolCallCounts7d: stats7d,
      },
      200,
    )
  }
}
