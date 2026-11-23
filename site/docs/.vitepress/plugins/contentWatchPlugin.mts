/**
 * plugins/contentWatchPlugin.mts — `npm run dev` keeps `site/docs/` in step with the content folder (S4a).
 *
 * In content mode the dev server starts the one-way `content:watch` (scripts/content/watch.mts: content/ ->
 * site/docs/, manifest-checked like `content:sync`), so a separate terminal is no longer needed. Nothing happens in
 * in-place mode, in a build, or with LECTURE_CONTENT_WATCH=0. VitePress restarts its Vite server when the config
 * changes, and the config module is evaluated again: the watcher is kept on globalThis so a restart replaces the
 * old one instead of adding a second.
 */
import type { Plugin } from 'vite'
import { resolveContent } from '../content/paths.mts'
import { startContentWatch, type ContentWatcher } from '../../../scripts/content/watch.mts'
import { pushDevLog } from './devLogs.mts'

const KEY = Symbol.for('lecture.contentWatch')

interface WatchSlot {
  root: string
  handle: ContentWatcher | null
}

type Registry = { [KEY]?: WatchSlot }

function slot(): WatchSlot | undefined {
  return (globalThis as Registry)[KEY]
}

export function stopContentWatch(): void {
  const s = slot()
  s?.handle?.close()
  delete (globalThis as Registry)[KEY]
}

/** For the Dashboard runtime page: is the watcher of this process running? */
export function contentWatchState(): 'watching' | 'off' {
  return slot()?.handle ? 'watching' : 'off'
}

export interface ContentWatchPluginOptions {
  env?: Readonly<Record<string, string | undefined>>
  /** Tests: replace the watcher. */
  start?: typeof startContentWatch
}

export function contentWatchPlugin(options: ContentWatchPluginOptions = {}): Plugin {
  return {
    name: 'lecture-content-watch',
    apply: 'serve',
    async configureServer(server) {
      const env = options.env ?? process.env
      if ((env.LECTURE_CONTENT_WATCH ?? '').trim() === '0') return
      const paths = resolveContent({ env })
      if (paths.mode !== 'content') return
      stopContentWatch()
      const entry: WatchSlot = { root: paths.root, handle: null }
      ;(globalThis as Registry)[KEY] = entry
      const logger = server.config.logger
      const start = options.start ?? startContentWatch
      const report = (err: unknown) => logger.error(`[content:watch] ${err instanceof Error ? err.message : String(err)}`, { timestamp: true })
      try {
        entry.handle = await start({ contentPaths: paths, onError: report, onSync: () => pushDevLog('sync', 'info', '[content:watch] content/ -> site/docs/ synced') })
      } catch (err) {
        // a refused sync (a copy in site/docs edited by hand) must not stop the dev server; the message says what to do
        report(err)
      }
      server.httpServer?.once('close', () => {
        if (slot() === entry) stopContentWatch()
      })
    },
  }
}
