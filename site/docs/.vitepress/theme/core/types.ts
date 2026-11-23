/**
 * Page lifecycle contract shared by every V2 feature module.
 *
 * A feature is mounted once per page visit (initial load after hydration, and
 * after every SPA route change once the DOM has been patched). Everything it
 * starts — listeners, observers, timers, chart instances, in-flight fetches —
 * must be tied to `ctx.signal` or registered with `ctx.defer`, so leaving the
 * page releases it. Nothing may survive into the next page by accident.
 */

export interface PageContext {
  /** Route path of the page being entered, e.g. `/g05/L19.html` → normalised `/g05/L19`. */
  readonly path: string
  /** Aborted when the page is left (or re-entered). Check `signal.aborted` after every `await`. */
  readonly signal: AbortSignal
  /** Register a disposer; run in LIFO order when the page is left. Errors are isolated per disposer. */
  defer(dispose: () => void): void
}

export interface PageFeature {
  /** Stable id, used for logging and the debug console. */
  readonly id: string
  /** Optional route filter; the feature is skipped for paths where this returns false. */
  when?(path: string): boolean
  /** Mount for the current page. May be async; a rejected promise is logged, never thrown into the app. */
  mount(ctx: PageContext): void | Promise<void>
}

/** App-scope features are installed once per app lifetime (client only), e.g. delegated click handlers. */
export interface AppFeature {
  readonly id: string
  install(signal: AbortSignal): void
}
