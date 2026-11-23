/**
 * Vite dev-server fallback middleware for example figures (`exampleFiguresDir` from `paths.mts`).
 * Mirrors `exampleChartsDir` handling so `docs/examples/public/figures/**` works in dev even
 * under separated `LECTURE_CONTENT_DIR` mode.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { resolveContent } from '../content/paths.mts'
import { ORIGINAL_FIGURE_EXTS, validateSafeFigureRelPath } from '../figures/pathGuard.ts'

const MIME_BY_EXT: Record<string, string> = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
}

export function figuresDevPlugin(): Plugin {
  const paths = resolveContent()
  const exampleRoot = path.resolve(paths.exampleFiguresDir)
  const primaryRoot = path.resolve(paths.figuresDir)

  return {
    name: 'lecture:figures-dev-fallback',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.method || 'GET').toUpperCase() !== 'GET') return next()
        const rawUrl = req.url || ''
        const pathname = rawUrl.split(/[?#]/, 1)[0] || ''
        if (!pathname.startsWith('/figures/')) return next()

        const rel = decodeURIComponent(pathname.slice('/figures/'.length))
        const guard = validateSafeFigureRelPath(rel, { allowedExts: ORIGINAL_FIGURE_EXTS })
        if (!guard.ok) return next()

        for (const baseRoot of [primaryRoot, exampleRoot]) {
          const candidate = path.resolve(baseRoot, guard.normalized)
          const diff = path.relative(baseRoot, candidate)
          if (!diff || diff.startsWith('..') || path.isAbsolute(diff)) continue
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            const ext = path.extname(candidate).toLowerCase()
            res.statusCode = 200
            res.setHeader('Content-Type', MIME_BY_EXT[ext] ?? 'application/octet-stream')
            res.end(fs.readFileSync(candidate))
            return
          }
        }
        next()
      })
    },
  }
}
