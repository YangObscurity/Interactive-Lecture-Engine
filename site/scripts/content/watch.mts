/**
 * scripts/content/watch.mts — one-way debounced watcher from `content/` to `site/docs/` (`npm run content:watch`).
 * Uses Node's built-in recursive `fs.watch` (no extra dependency) and delegates copying/manifesting to `sync.mts`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContent, type ContentPaths } from '../../docs/.vitepress/content/paths.mts'
import { ContentSyncError, syncContent } from './sync.mts'

export interface WatchOptions {
  debounceMs?: number
  force?: boolean
  contentPaths?: ContentPaths
  onSync?: () => void
  onError?: (err: unknown) => void
}

export interface ContentWatcher {
  close: () => void
}

const DEFAULT_DEBOUNCE_MS = 120

/** Start watching `paths.root` recursively and sync changes to `site/docs/`. Returns null in in-place mode. */
export async function startContentWatch(options: WatchOptions = {}): Promise<ContentWatcher | null> {
  const paths = options.contentPaths ?? resolveContent()
  if (paths.mode === 'in-place') {
    process.stdout.write('[content:watch] in-place mode: nothing to watch\n')
    return null
  }

  await syncContent({ contentPaths: paths, force: options.force, drafts: true })
  options.onSync?.()

  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let syncing = false
  let rerun = false
  let closed = false

  const runSync = async (): Promise<void> => {
    if (closed) return
    if (syncing) {
      rerun = true
      return
    }
    syncing = true
    try {
      await syncContent({ contentPaths: paths, force: options.force, drafts: true })
      options.onSync?.()
    } catch (err) {
      if (options.onError) {
        options.onError(err)
      } else if (err instanceof ContentSyncError) {
        console.error(err.message)
      } else {
        console.error(`[content:watch] sync error: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      syncing = false
      if (rerun && !closed) {
        rerun = false
        void runSync()
      }
    }
  }

  const schedule = (filename?: string | Buffer | null): void => {
    if (closed) return
    if (filename) {
      const rel = String(filename).replace(/\\/g, '/')
      if (rel === '.git' || rel.startsWith('.git/')) return
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void runSync()
    }, debounceMs)
  }

  // Windows: a path in 8.3 short form (C:\Users\NAME~1\...) makes libuv's recursive watcher abort the process
  // (assertion in fs-event.c); the long, real path does not.
  const watchRoot = fs.realpathSync.native(paths.root)
  const watcher = fs.watch(watchRoot, { recursive: true }, (_event, filename) => {
    schedule(filename)
  })
  watcher.on('error', (err) => {
    if (options.onError) options.onError(err)
    else console.error(`[content:watch] watcher error: ${err.message}`)
  })

  process.stdout.write(`[content:watch] watching ${paths.root} -> ${paths.docsRoot}\n`)

  return {
    close() {
      closed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      watcher.close()
    },
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  const handle = await startContentWatch({ force })
  if (!handle) return
  const stop = () => {
    handle.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    if (err instanceof ContentSyncError) {
      console.error(err.message)
      process.exit(err.exitCode)
    }
    console.error(`[content:watch] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
