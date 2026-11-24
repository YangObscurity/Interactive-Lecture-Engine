import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import type { Db } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import {
  PROMPT_LIMITS,
  validateCompanionPrompts,
  type CompanionPromptsFile,
} from '../../prompts/companion.js'
import { getSetting, getSettingHistory } from '../../repo/siteSettings.js'
import type { AiRuntime } from '../ai/runtime.js'
import { saveSiteContentSetting } from '../../services/contentSync.js'

const DEFAULT_PROMPTS: CompanionPromptsFile = {
  version: 1,
  system: {
    zh: '你是一位严谨、专注且极具启发性的学术与专业讲义助教。',
    en: 'You are a rigorous, focused, and insightful academic and professional lecture teaching assistant.',
  },
  actions: [
    {
      id: 'explain',
      label: { zh: '详细解释', en: 'Explain' },
      template: {
        zh: '请详细解释讲义中关于“{selection}”的核心概念、原理及应用场景。',
        en: 'Please explain the core concepts, principles, and applications of "{selection}".',
      },
      needsSelection: true,
      surfaces: ['panel', 'menu'],
      enabled: true,
    },
  ],
}

export function createAdminCompanionRouter(
  config: AppConfig,
  db: Db,
  aiRuntime?: AiRuntime,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    let prompts = await getSetting<CompanionPromptsFile>(db, 'companion_prompts')
    let source = 'db'

    if (!prompts && aiRuntime?.prompts) {
      try {
        prompts = await aiRuntime.prompts.load()
        if (prompts) source = 'disk'
      } catch {
        // fallback
      }
    }

    if (!prompts) {
      prompts = DEFAULT_PROMPTS
      source = 'default'
    }

    return c.json(
      {
        ok: true,
        filePath: aiRuntime?.prompts?.filePath() ?? null,
        source,
        prompts,
        limits: PROMPT_LIMITS,
      },
      200,
    )
  })

  router.put('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: { prompts?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400)
    }

    const validation = validateCompanionPrompts(body.prompts)
    if (!validation.ok) {
      return c.json({ ok: false, error: 'validation_failed', errors: validation.errors }, 400)
    }

    const validPrompts = validation.value
    const userId = c.get('userId') ?? 'admin'

    const persistence = await saveSiteContentSetting(db, 'companion_prompts', validPrompts, {
      filename: 'prompts/companion.json',
      effect: 'live',
      updatedBy: userId,
      config,
      onSaved: () => {
        aiRuntime?.prompts?.reload(validPrompts)
      },
    })

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `Companion prompts updated by ${userId} (${persistence.mode})`,
    })

    return c.json({ ok: true, prompts: validPrompts, persistence }, 200)
  })

  router.put('/prompts/:name', async (c) => {
    c.header('Cache-Control', 'no-store')
    const actionName = c.req.param('name')
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(actionName)) {
      return c.json({ error: 'invalid_request', message: 'Invalid prompt action id' }, 400)
    }

    let body: { action?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400)
    }

    if (body && typeof body.action === 'object' && body.action !== null && !Array.isArray(body.action)) {
      const actionObj = body.action as Record<string, unknown>
      if (actionObj.id !== undefined && actionObj.id !== actionName) {
        return c.json({ error: 'invalid_request', message: 'Action id mismatch with route parameter' }, 400)
      }
    }

    let prompts = await getSetting<CompanionPromptsFile>(db, 'companion_prompts')
    if (!prompts && aiRuntime?.prompts) {
      try {
        prompts = aiRuntime.prompts.get()
      } catch {
        prompts = null
      }
    }
    if (!prompts) {
      prompts = DEFAULT_PROMPTS
    }

    const updatedActions = prompts.actions.filter((a) => a.id !== actionName)
    if (body.action && typeof body.action === 'object' && !Array.isArray(body.action)) {
      const normalized = { ...(body.action as Record<string, unknown>), id: actionName }
      updatedActions.push(normalized as unknown as (typeof prompts.actions)[0])
    }
    prompts = { ...prompts, actions: updatedActions }

    const validation = validateCompanionPrompts(prompts)
    if (!validation.ok) {
      return c.json({ ok: false, error: 'validation_failed', errors: validation.errors }, 400)
    }

    const userId = c.get('userId') ?? 'admin'
    const persistence = await saveSiteContentSetting(db, 'companion_prompts', validation.value, {
      filename: 'prompts/companion.json',
      effect: 'live',
      updatedBy: userId,
      config,
      onSaved: () => {
        aiRuntime?.prompts?.reload(validation.value)
      },
    })

    return c.json({ ok: true, action: body.action, persistence }, 200)
  })

  router.get('/history', async (c) => {
    c.header('Cache-Control', 'no-store')
    const history = await getSettingHistory(db, 'companion_prompts')
    return c.json({ ok: true, history }, 200)
  })

  return router
}
