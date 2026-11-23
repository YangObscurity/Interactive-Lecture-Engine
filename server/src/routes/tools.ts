import { Hono } from 'hono'
import { ZodError, z } from 'zod'
import type { AppEnv } from '../app.js'
import { rateLimited } from '../http/errors.js'
import {
  ENGINE_TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  TOOL_INPUT_SCHEMAS,
  ToolTimeoutError,
  type EngineToolName,
  summarizeZodIssues,
} from '../tools/index.js'
import { type AiRuntime, getRequestUserId, isDailyLimitExempt } from './ai/runtime.js'

const TOOL_NAME_SET = new Set<string>(ENGINE_TOOL_NAMES)

export function createToolsRouter(rt: AiRuntime): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', async (c) => {
    c.header('Date', new Date().toUTCString())
    c.header('Cache-Control', 'no-store')

    const userId = getRequestUserId(c)
    if (!userId) {
      return c.json({ error: 'unauthenticated' }, 401)
    }

    const decision = rt.toolsLimiter.check(userId, { exemptDaily: isDailyLimitExempt(c) })
    if (!decision.ok) {
      throw rateLimited(decision.kind ?? 'rate', decision.retryAfterSec)
    }

    const aiToolsCfg = await rt.mcpManager.loadConfig()
    const tools = ENGINE_TOOL_NAMES.filter((name) => aiToolsCfg.engineTools[name]?.enabled !== false).map(
      (name) => ({
        name,
        description: TOOL_DESCRIPTIONS[name],
        parameters: z.toJSONSchema(TOOL_INPUT_SCHEMAS[name]),
      }),
    )

    return c.json(
      {
        maxSteps: rt.aiToolMaxSteps,
        tools,
      },
      200,
    )
  })

  router.post('/:name', async (c) => {
    c.header('Date', new Date().toUTCString())
    c.header('Cache-Control', 'no-store')

    const userId = getRequestUserId(c)
    if (!userId) {
      return c.json({ error: 'unauthenticated' }, 401)
    }

    const name = c.req.param('name')
    if (!TOOL_NAME_SET.has(name)) {
      return c.json({ error: 'not_found' }, 404)
    }
    const toolName = name as EngineToolName

    const decision = rt.toolsLimiter.check(userId, { exemptDaily: isDailyLimitExempt(c) })
    if (!decision.ok) {
      throw rateLimited(decision.kind ?? 'rate', decision.retryAfterSec)
    }

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_input', issues: [{ path: '(body)', message: 'Request body must be valid JSON' }] }, 400)
    }

    const parsed = TOOL_INPUT_SCHEMAS[toolName].safeParse(rawBody)
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_input',
          issues: summarizeZodIssues(parsed.error),
        },
        400,
      )
    }

    const aiToolsCfg = await rt.mcpManager.loadConfig()
    if (aiToolsCfg.engineTools[toolName]?.enabled === false) {
      return c.json({ error: 'tool_disabled' }, 403)
    }

    const readableTiers = rt.toolEngine.resolveTiersForCaller(c.get('session'))

    try {
      const result = await rt.toolEngine.execute(toolName, parsed.data, {
        readableTiers,
        channel: 'rest',
        userId,
      })
      return c.json(result, 200)
    } catch (err) {
      if (err instanceof ZodError) {
        return c.json({ error: 'invalid_input', issues: summarizeZodIssues(err) }, 400)
      }
      if (err instanceof ToolTimeoutError) {
        return c.json({ error: 'tool_timeout' }, 504)
      }
      return c.json({ error: 'tool_execution_error' }, 500)
    }
  })

  router.all('*', (c) => {
    return c.json({ error: 'not_found' }, 404)
  })

  return router
}
