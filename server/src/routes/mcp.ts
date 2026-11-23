import { createHash, timingSafeEqual } from 'node:crypto'
import { createMcpHonoApp } from '@modelcontextprotocol/hono'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import type { Context, Hono } from 'hono'
import type { AppConfig } from '../config/schema.js'
import {
  ENGINE_TOOL_NAMES,
  type EngineToolName,
  MCP_TOOL_INPUT_SCHEMAS,
  TOOL_DESCRIPTIONS,
  type ToolEngine,
  verifyToolTicket,
} from '../tools/index.js'

function sha256Digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function bearerMatches(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader) return false
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
  if (!match || !match[1]) return false
  const provided = match[1].trim()
  if (!provided) return false
  return timingSafeEqual(sha256Digest(provided), sha256Digest(expectedToken))
}

/** Whether the owner left an engine tool switched on (content/ai-tools.json, Dashboard). */
export type EngineToolEnabled = (name: EngineToolName) => Promise<boolean>

function buildStatelessMcpServer(
  config: AppConfig,
  toolEngine: ToolEngine,
  now: () => number,
  isEnabled: EngineToolEnabled,
): McpServer {
  const server = new McpServer({
    name: 'lecture-api-mcp',
    version: '1.0.0',
  })

  const runTool = async (name: EngineToolName, args: Record<string, unknown>) => {
    // the same switch as the native and REST channels: a tool turned off in the Dashboard answers no channel
    if (!(await isEnabled(name))) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'tool_disabled' }) }] }
    }
    const rawTicket = typeof args['ticket'] === 'string' ? args['ticket'] : undefined
    const verified = verifyToolTicket(config.aiMcpTicketSecret, rawTicket, now)

    const cleanArgs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k !== 'ticket') cleanArgs[k] = v
    }

    try {
      const result = await toolEngine.execute(name, cleanArgs, {
        readableTiers: verified.tiers,
        channel: 'mcp',
        userHash: verified.uh,
      })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'tool_execution_error'
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
      }
    }
  }

  for (const name of ENGINE_TOOL_NAMES) {
    const annotations = { readOnlyHint: true }
    const description = TOOL_DESCRIPTIONS[name]
    switch (name) {
      case 'search_concepts':
        server.registerTool(
          name,
          { description, inputSchema: MCP_TOOL_INPUT_SCHEMAS.search_concepts, annotations },
          (args) => runTool(name, args),
        )
        break
      case 'get_concept':
        server.registerTool(
          name,
          { description, inputSchema: MCP_TOOL_INPUT_SCHEMAS.get_concept, annotations },
          (args) => runTool(name, args),
        )
        break
      case 'get_concept_graph':
        server.registerTool(
          name,
          { description, inputSchema: MCP_TOOL_INPUT_SCHEMAS.get_concept_graph, annotations },
          (args) => runTool(name, args),
        )
        break
      case 'search_lectures':
        server.registerTool(
          name,
          { description, inputSchema: MCP_TOOL_INPUT_SCHEMAS.search_lectures, annotations },
          (args) => runTool(name, args),
        )
        break
      case 'get_lecture_summary':
        server.registerTool(
          name,
          { description, inputSchema: MCP_TOOL_INPUT_SCHEMAS.get_lecture_summary, annotations },
          (args) => runTool(name, args),
        )
        break
    }
  }

  return server
}

export function createMcpRouter(
  config: AppConfig,
  toolEngine: ToolEngine,
  now: () => number = Date.now,
  isEnabled: EngineToolEnabled = async () => true,
): Hono {
  // Pass non-loopback host identifier because nginx forwards the public site Host header.
  // Access control is enforced strictly via constant-time Bearer token comparison.
  const mcpApp = createMcpHonoApp({
    host: 'proxy',
    maxRequestBodySize: 256 * 1024,
  })

  mcpApp.use('*', async (c, next) => {
    const token = config.aiMcpToken?.trim()
    if (!token) {
      return c.json({ error: 'mcp_not_configured' }, 503)
    }
    if (!bearerMatches(c.req.header('authorization'), token)) {
      c.header('WWW-Authenticate', 'Bearer')
      return c.json({ error: 'unauthorized' }, 401)
    }
    return await next()
  })

  const handler = createMcpHandler(
    () => buildStatelessMcpServer(config, toolEngine, now, isEnabled),
    {
      legacy: 'stateless',
      responseMode: 'auto',
      maxRequestBodySize: 256 * 1024,
    },
  )

  const handleMcpRequest = (c: Context) =>
    handler.fetch(c.req.raw, {
      parsedBody: c.get('parsedBody'),
    })

  mcpApp.all('/', handleMcpRequest)
  mcpApp.all('*', handleMcpRequest)

  return mcpApp
}
