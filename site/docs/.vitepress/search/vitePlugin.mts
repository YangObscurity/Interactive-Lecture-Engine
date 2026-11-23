/**
 * search/vitePlugin.mts - Vite dev-server middleware for `/search/<locale>/...` (WP-F3).
 *
 * Serves manifest, title index and raw-deflated shards directly from memory with accurate Content-Length headers,
 * and invalidates the cached index whenever any markdown file under `docsRoot` changes in dev.
 */
import path from 'node:path'
import type { Connect, Plugin, ResolvedConfig } from 'vite'
import { buildSearchArtifacts, type BuildSearchOptions, type SearchBuildResult } from './indexBuilder.ts'

const searchInvalidators = new Set<() => void>()

export function invalidateSearchViteCache(): void {
  for (const fn of searchInvalidators) fn()
}

export function createSearchVitePlugin(getOptions: () => BuildSearchOptions): Plugin {
  let resolved: ResolvedConfig | null = null
  let cached: SearchBuildResult | null = null

  const getBuilt = (): SearchBuildResult => {
    if (!cached) cached = buildSearchArtifacts(getOptions())
    return cached
  }

  const invalidate = (file?: string): void => {
    if (!file || file.endsWith('.md')) cached = null
  }
  searchInvalidators.add(() => {
    cached = null
  })

  return {
    name: 'lecture:split-search',
    apply: 'serve',
    configResolved(config) {
      resolved = config
    },
    configureServer(server) {
      const opts = getOptions()
      const docsRoot = path.resolve(opts.docsRoot)
      server.watcher.on('add', (f) => {
        if (path.resolve(f).startsWith(docsRoot)) invalidate(f)
      })
      server.watcher.on('change', (f) => {
        if (path.resolve(f).startsWith(docsRoot)) invalidate(f)
      })
      server.watcher.on('unlink', (f) => {
        if (path.resolve(f).startsWith(docsRoot)) invalidate(f)
      })

      const handler: Connect.NextHandleFunction = (req, res, next) => {
        const base = (resolved?.base ?? '/').replace(/\/$/, '')
        const url = (req.url ?? '').split('?')[0] ?? ''
        const prefix = `${base}/search/`
        if (!url.startsWith(prefix)) return next()

        const rel = `search/${url.slice(prefix.length)}`
        const built = getBuilt()
        const payload = built.artifacts.get(rel)
        if (!payload) return next()

        const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
        const ctype = rel.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : 'application/octet-stream'
        res.statusCode = 200
        res.setHeader('Content-Type', ctype)
        res.setHeader('Content-Length', String(buf.byteLength))
        res.setHeader('Cache-Control', 'no-store')
        res.end(buf)
      }

      server.middlewares.use(handler)
    },
  }
}
