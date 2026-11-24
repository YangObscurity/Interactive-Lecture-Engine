import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import type { Db } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import { getSetting, setSetting } from '../../repo/siteSettings.js'
import { resolveContentDir } from '../../services/contentSync.js'

interface CheckIssue {
  level: 'fail' | 'warn' | 'info'
  code: string
  message: string
  file?: string
}

export interface ContentCheckReport {
  ok: boolean
  mode: 'online'
  root: string
  counts: {
    groups: number
    lectures: number
    translations: number
    charts: number
    concepts: number
    figures: number
  }
  totals: {
    fail: number
    warn: number
    info: number
  }
  issues: CheckIssue[]
}

function countFilesRecursive(dirPath: string): number {
  if (!existsSync(dirPath)) return 0
  let count = 0
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFilesRecursive(join(dirPath, entry.name))
    } else if (entry.isFile()) {
      count++
    }
  }
  return count
}

function scanContentChecks(contentDir: string | null): ContentCheckReport {
  const issues: CheckIssue[] = []
  if (!contentDir || !existsSync(contentDir)) {
    issues.push({
      level: 'info',
      code: 'no_content_dir',
      message: 'No writable local CONTENT_DIR attached to server; running in DB-backed settings mode',
    })
    return {
      ok: true,
      mode: 'online',
      root: 'db',
      counts: { groups: 0, lectures: 0, translations: 0, charts: 0, concepts: 0, figures: 0 },
      totals: { fail: 0, warn: 0, info: issues.length },
      issues,
    }
  }

  let groupsCount = 0
  const groupsFile = join(contentDir, 'groups.ts')
  if (existsSync(groupsFile)) {
    const raw = readFileSync(groupsFile, 'utf8')
    const matches = raw.match(/id\s*:\s*['"][^'"]+['"]/g)
    groupsCount = matches ? matches.length : 0
  } else {
    issues.push({
      level: 'warn',
      code: 'missing_groups',
      message: 'groups.ts not found in content directory',
      file: 'groups.ts',
    })
  }

  const lecturesDir = join(contentDir, 'lectures')
  let lecturesCount = 0
  let translationsCount = 0
  if (existsSync(lecturesDir)) {
    for (const entry of readdirSync(lecturesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const subFiles = readdirSync(join(lecturesDir, entry.name))
        for (const f of subFiles) {
          if (f.endsWith('.md')) {
            if (f.includes('.en.')) translationsCount++
            else lecturesCount++
          }
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        lecturesCount++
      }
    }
  }

  const chartsCount = countFilesRecursive(join(contentDir, 'charts'))
  const conceptsCount = countFilesRecursive(join(contentDir, 'concepts'))
  const figuresCount = countFilesRecursive(join(contentDir, 'figures'))

  if (!existsSync(join(contentDir, 'prompts', 'companion.json'))) {
    issues.push({
      level: 'info',
      code: 'companion_prompts_default',
      message: 'prompts/companion.json not found on disk; DB or built-in defaults apply',
      file: 'prompts/companion.json',
    })
  }

  const totals = {
    fail: issues.filter((i) => i.level === 'fail').length,
    warn: issues.filter((i) => i.level === 'warn').length,
    info: issues.filter((i) => i.level === 'info').length,
  }

  return {
    ok: totals.fail === 0,
    mode: 'online',
    root: contentDir,
    counts: {
      groups: groupsCount,
      lectures: lecturesCount,
      translations: translationsCount,
      charts: chartsCount,
      concepts: conceptsCount,
      figures: figuresCount,
    },
    totals,
    issues,
  }
}

export function createAdminChecksRouter(config: AppConfig, db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const saved = await getSetting<{
      at: string
      ms?: number
      exitCode?: number
      only?: string[]
      report: ContentCheckReport
    }>(db, 'last_check_report')
    if (saved?.report) {
      return c.json(
        {
          ok: saved.report.ok,
          report: saved.report,
          at: saved.at,
          ms: saved.ms ?? 0,
          exitCode: saved.exitCode ?? (saved.report.ok ? 0 : 1),
          ...(saved.only ? { only: saved.only } : {}),
        },
        200,
      )
    }

    const started = Date.now()
    const report = scanContentChecks(resolveContentDir(config))
    const ms = Date.now() - started
    return c.json({ ok: report.ok, report, at: new Date().toISOString(), ms, exitCode: report.ok ? 0 : 1 }, 200)
  })

  router.post('/run', async (c) => {
    c.header('Cache-Control', 'no-store')
    let only: string[] | undefined
    try {
      const body = (await c.req.json()) as { only?: unknown }
      if (Array.isArray(body?.only)) {
        const clean = body.only.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        if (clean.length > 0) only = clean
      } else if (typeof body?.only === 'string' && body.only.trim() !== '') {
        only = [body.only.trim()]
      }
    } catch {
      // empty/non-JSON body means run all checks
    }

    const started = Date.now()
    const report = scanContentChecks(resolveContentDir(config))
    const at = new Date().toISOString()
    const ms = Math.max(1, Date.now() - started)
    const exitCode = report.ok ? 0 : 1

    await setSetting(
      db,
      'last_check_report',
      { at, ms, exitCode, ...(only ? { only } : {}), report },
      c.get('userId') ?? 'admin',
    )

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `Content checks executed (${report.counts.lectures} lectures, ${report.totals.fail} fail)`,
    })

    return c.json(
      {
        ok: report.ok,
        at,
        ms,
        exitCode,
        ...(only ? { only } : {}),
        report,
      },
      200,
    )
  })

  return router
}
