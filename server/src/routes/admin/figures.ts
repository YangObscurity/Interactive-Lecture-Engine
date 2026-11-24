import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import { resolveContentDir } from '../../services/contentSync.js'

interface FigureManifestItem {
  id: string
  kind: 'figure' | 'chart' | 'concept'
  path: string
  sizeBytes: number
  updatedAt: string
}

function collectFiles(
  rootDir: string,
  subDir: string,
  kind: FigureManifestItem['kind'],
  out: FigureManifestItem[],
): void {
  const start = join(rootDir, subDir)
  if (!existsSync(start)) return

  const walk = (dir: string, relPrefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(fullPath, relPath)
      } else if (entry.isFile()) {
        const st = statSync(fullPath)
        out.push({
          id: `${kind}:${relPath}`,
          kind,
          path: `${subDir}/${relPath}`,
          sizeBytes: st.size,
          updatedAt: st.mtime.toISOString(),
        })
      }
    }
  }

  walk(start, '')
}

export function createAdminFiguresRouter(config: AppConfig): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', (c) => {
    c.header('Cache-Control', 'no-store')
    const contentDir = resolveContentDir(config)
    const items: FigureManifestItem[] = []
    const warnings: string[] = []

    if (!contentDir || !existsSync(contentDir)) {
      warnings.push('No local CONTENT_DIR mounted; returning empty visual asset manifest')
      return c.json({ ok: true, items, warnings, errors: [] }, 200)
    }

    collectFiles(contentDir, 'figures', 'figure', items)
    collectFiles(contentDir, 'charts', 'chart', items)
    collectFiles(contentDir, 'concepts', 'concept', items)

    return c.json(
      {
        ok: true,
        items,
        warnings,
        errors: [],
      },
      200,
    )
  })

  return router
}
