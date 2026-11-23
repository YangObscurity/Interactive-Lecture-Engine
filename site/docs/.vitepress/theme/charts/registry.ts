/**
 * charts/registry.ts — per-page ownership of everything a chart run creates.
 *
 * Every renderer returns a disposer (ECharts `instance.dispose()` + ResizeObserver disconnect,
 * mermaid / wavedrom fit-observer disconnect, …). The page's registry runs them LIFO when the page
 * is left (`ctx.defer`). Errors are isolated per disposer. A disposer registered after the registry
 * was closed (a render that finished after the user navigated away) runs immediately, so a late
 * instance can never leak into the next page.
 *
 * `liveCounts()` is the global tally of not-yet-disposed handles by kind — the debug panel and the
 * lifecycle e2e use it to prove the ECharts instance count stays flat across SPA navigation.
 */
import type { Disposer } from './state'

interface Entry {
  kind: string
  dispose: Disposer
  done: boolean
}

const live = new Map<string, number>()

function bump(kind: string, delta: number): void {
  const n = (live.get(kind) ?? 0) + delta
  if (n <= 0) live.delete(kind)
  else live.set(kind, n)
}

/** Snapshot of live (registered, not yet disposed) handles by kind. */
export function liveCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of [...live.entries()].sort(([a], [b]) => a.localeCompare(b))) out[k] = v
  return out
}

/** Test seam. */
export function __resetLiveCountsForTests(): void {
  live.clear()
}

function runEntry(entry: Entry, errors: unknown[]): void {
  if (entry.done) return
  entry.done = true
  try {
    entry.dispose()
  } catch (err) {
    errors.push(err)
  }
}

export class ChartRegistry {
  private entries: Entry[] = []
  private closedFlag = false

  /** Number of live handles owned by this registry. */
  get size(): number {
    return this.entries.length
  }

  get closed(): boolean {
    return this.closedFlag
  }

  /** Live handles owned by this registry, by kind. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const e of this.entries) out[e.kind] = (out[e.kind] ?? 0) + 1
    return out
  }

  /**
   * Register a disposer. Returns `release()`, which disposes this one handle early (e.g. a mermaid
   * figure re-rendered on theme change). If the registry is already closed the disposer runs now.
   */
  add(kind: string, dispose: Disposer): Disposer {
    const entry: Entry = { kind, dispose, done: false }
    if (this.closedFlag) {
      const errors: unknown[] = []
      runEntry(entry, errors)
      for (const err of errors) console.error('[chart] late dispose failed:', kind, err)
      return () => {}
    }
    this.entries.push(entry)
    bump(kind, 1)
    return () => {
      const i = this.entries.indexOf(entry)
      if (i < 0) return
      this.entries.splice(i, 1)
      bump(kind, -1)
      const errors: unknown[] = []
      runEntry(entry, errors)
      for (const err of errors) console.error('[chart] dispose failed:', kind, err)
    }
  }

  /** Dispose everything (LIFO), keep the registry usable. Returns the errors that were swallowed. */
  disposeAll(): unknown[] {
    const errors: unknown[] = []
    while (this.entries.length) {
      const entry = this.entries.pop() as Entry
      bump(entry.kind, -1)
      runEntry(entry, errors)
    }
    for (const err of errors) console.error('[chart] dispose failed:', err)
    return errors
  }

  /** Dispose everything and refuse further registrations (they are disposed immediately). */
  close(): unknown[] {
    this.closedFlag = true
    return this.disposeAll()
  }
}
