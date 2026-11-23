// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  API_LOG_LIMIT,
  DEBUG_STORAGE_KEY,
  SCENARIO_HEADER,
  __setDevForTests,
  exposeDebug,
  registerDebugPanel,
  teardownDebug,
  type LectureDebugApi,
} from '../../docs/.vitepress/theme/debug/registry'
import {
  FLAGS_CHANGED_EVENT,
  FLAGS_STORAGE_KEY,
  __setFlagEnvForTests,
  envKeysFor,
  isEnabled,
  listFlags,
  onFlagsChange,
} from '../../docs/.vitepress/theme/debug/flags'

/**
 * Node >= 25 ships an experimental global `localStorage` that is `undefined` without
 * --localstorage-file and shadows happy-dom's Storage (window === globalThis here).
 * Install a spec-shaped in-memory Storage so the tests are runtime-independent.
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  [name: string]: unknown
}
if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage === null) {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true })
}

function setSearch(search: string): void {
  window.history.replaceState(null, '', `/g01/L01${search}`)
}

function must(api: LectureDebugApi | null): LectureDebugApi {
  if (!api) throw new Error('debug api not installed')
  return api
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  teardownDebug()
  localStorage.clear()
  document.cookie = 'lecture-scenario=; path=/; Max-Age=0'
  setSearch('')
  __setDevForTests(false)
  __setFlagEnvForTests({})
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/api/boom')) throw new TypeError('Failed to fetch')
    return new Response('{"ok":true}', { status: url.includes('/api/missing') ? 404 : 200 })
  })
  window.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  teardownDebug()
  __setDevForTests(null)
  __setFlagEnvForTests(null)
})

describe('enable rules', () => {
  it('is disabled in production by default', () => {
    expect(exposeDebug()).toBeNull()
    expect(window.__LECTURE_DEBUG__).toBeUndefined()
  })

  it('is enabled in DEV', () => {
    __setDevForTests(true)
    expect(must(exposeDebug()).enabledBy).toBe('dev')
  })

  it('?debug=1 opts in and persists; ?debug=0 opts out (even in DEV)', () => {
    setSearch('?debug=1')
    expect(must(exposeDebug()).enabledBy).toBe('query')
    expect(localStorage.getItem(DEBUG_STORAGE_KEY)).toBe('1')
    teardownDebug()

    setSearch('')
    expect(must(exposeDebug()).enabledBy).toBe('localStorage')

    setSearch('?debug=0')
    __setDevForTests(true)
    expect(exposeDebug()).toBeNull()
    expect(window.__LECTURE_DEBUG__).toBeUndefined()
    expect(localStorage.getItem(DEBUG_STORAGE_KEY)).toBeNull()
  })

  it('does not wrap fetch when disabled', () => {
    exposeDebug()
    expect(window.fetch).toBe(fetchMock)
  })
})

describe('panels', () => {
  it('registers, describes, runs actions, and unregisters', () => {
    __setDevForTests(true)
    let counter = 0
    const off = registerDebugPanel('counter', {
      describe: () => ({ counter }),
      actions: { add: (n: unknown) => (counter += typeof n === 'number' ? n : 1) },
    })
    registerDebugPanel('broken', {
      describe: () => {
        throw new Error('kaput')
      },
    })
    const dbg = must(exposeDebug())
    expect(dbg.panels()).toEqual(expect.arrayContaining(['counter', 'broken', 'debug']))
    expect(dbg.run('counter', 'add', 5)).toBe(5)
    expect(dbg.panel('counter')).toEqual({ counter: 5 })
    expect(dbg.state().broken).toEqual({ __error: 'kaput' })
    expect(() => dbg.run('counter', 'nope')).toThrow(/no action "nope"/)
    expect(() => dbg.panel('ghost')).toThrow(/unknown panel/)

    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const table = vi.spyOn(console, 'table').mockImplementation(() => {})
    const rows = dbg.help()
    expect(rows.find((r) => r.panel === 'counter')?.actions).toBe('add')
    expect(table).toHaveBeenCalled()
    info.mockRestore()
    table.mockRestore()

    off()
    expect(dbg.panels()).not.toContain('counter')
  })
})

describe('api log + scenario', () => {
  it('logs only same-origin /api/** calls, with status and ms, without bodies', async () => {
    __setDevForTests(true)
    const dbg = must(exposeDebug())
    await fetch('/api/db/progress?group_id=g01')
    await fetch('/api/missing', { method: 'patch', body: '{"secret":1}' })
    await expect(fetch('/api/boom')).rejects.toThrow('Failed to fetch')
    await fetch('/assets/app.js')
    await fetch('https://elsewhere.example/api/x')

    const log = dbg.api.log
    expect(log.map((e) => `${e.method} ${e.url} ${e.status}`)).toEqual([
      'GET /api/db/progress?group_id=g01 200',
      'PATCH /api/missing 404',
      'GET /api/boom null',
    ])
    expect(log[2]?.error).toMatch(/Failed to fetch/)
    expect(JSON.stringify(log)).not.toContain('secret')
    expect(typeof log[0]?.ms).toBe('number')

    dbg.api.clear()
    expect(dbg.api.log).toHaveLength(0)
  })

  it('ring buffer keeps the last 200 entries', async () => {
    __setDevForTests(true)
    const dbg = must(exposeDebug())
    for (let i = 0; i < API_LOG_LIMIT + 15; i++) await fetch(`/api/n/${i}`)
    expect(dbg.api.log).toHaveLength(API_LOG_LIMIT)
    expect(dbg.api.log[0]?.url).toBe('/api/n/15')
  })

  it('scenario adds the header to /api calls and sets a cookie for XHR', async () => {
    __setDevForTests(true)
    const dbg = must(exposeDebug())
    expect(dbg.api.scenario()).toBeNull()
    dbg.api.scenario('offline')
    expect(document.cookie).toContain('lecture-scenario=offline')
    await fetch('/api/health', { headers: { accept: 'application/json' } })
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get(SCENARIO_HEADER)).toBe('offline')
    expect(headers.get('accept')).toBe('application/json')
    expect(dbg.api.log.at(-1)?.scenario).toBe('offline')

    await fetch('/not-api')
    const plainInit = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined
    expect(plainInit).toBeUndefined()

    expect(dbg.api.scenario(null)).toBeNull()
    expect(document.cookie).not.toContain('lecture-scenario=offline')
  })

  it('teardown restores the original fetch', () => {
    __setDevForTests(true)
    exposeDebug()
    expect(window.fetch).not.toBe(fetchMock)
    teardownDebug()
    expect(window.fetch).toBe(fetchMock)
  })
})

describe('storage export / import', () => {
  it('dumps, exports and re-imports only lecture keys', () => {
    __setDevForTests(true)
    const dbg = must(exposeDebug())
    localStorage.setItem('tut_neon_progress_all_map', JSON.stringify({ 'g01-l01': { status: '已完成' } }))
    localStorage.setItem('lecture-reading-mode', '1')
    localStorage.setItem('tut:v2:progress', '{"schema":1}')
    localStorage.setItem('dify_chat_user_id', 'user_x')
    localStorage.setItem('tutorial_ai_width', '420')
    localStorage.setItem('unrelated', 'keep-me-out')

    expect(dbg.storage.keys()).not.toContain('unrelated')
    expect(dbg.storage.dump('tut_neon_')).toEqual({
      tut_neon_progress_all_map: { 'g01-l01': { status: '已完成' } },
    })

    const snap = dbg.storage.export()
    expect(snap.schema).toBe('lecture-debug-storage/1')
    expect(Object.keys(snap.entries)).toEqual(
      expect.arrayContaining(['tut_neon_progress_all_map', 'lecture-reading-mode', 'tut:v2:progress', 'dify_chat_user_id', 'tutorial_ai_width']),
    )
    expect(snap.entries.unrelated).toBeUndefined()

    localStorage.setItem('lecture-reading-mode', '0')
    localStorage.setItem('lecture-extra', 'x')
    const written = dbg.storage.import(JSON.stringify(snap), { replace: true })
    expect(written).toBe(Object.keys(snap.entries).length)
    expect(localStorage.getItem('lecture-reading-mode')).toBe('1')
    expect(localStorage.getItem('lecture-extra')).toBeNull()
    expect(localStorage.getItem('unrelated')).toBe('keep-me-out')

    // foreign keys in an import are ignored
    expect(dbg.storage.import({ evil: 'x', 'lecture-ok': 'y' })).toBe(1)
    expect(localStorage.getItem('evil')).toBeNull()
    expect(() => dbg.storage.import('[1,2]')).toThrow(TypeError)
  })
})

describe('flags', () => {
  it('defaults false, env VITE_FLAG_*, override via console, events', () => {
    expect(isEnabled('aiScope')).toBe(false)
    expect(envKeysFor('aiScope')).toEqual(['VITE_FLAG_AI_SCOPE', 'VITE_FLAG_AISCOPE'])

    __setFlagEnvForTests({ VITE_FLAG_AI_SCOPE: '1', VITE_FLAG_NEWBOARD: 'true', VITE_FLAG_EXTRA_THING: '1' })
    expect(isEnabled('aiScope')).toBe(true)
    expect(isEnabled('newBoard')).toBe(true)
    expect(listFlags().find((f) => f.name === 'extraThing')).toEqual({ name: 'extraThing', enabled: true, source: 'env' })

    __setDevForTests(true)
    const dbg = must(exposeDebug())
    const seen: string[] = []
    const off = onFlagsChange(() => seen.push('changed'))
    const custom = vi.fn()
    window.addEventListener(FLAGS_CHANGED_EVENT, custom)

    expect(dbg.flags.set('aiScope', false)).toEqual({ name: 'aiScope', enabled: false, source: 'override' })
    expect(isEnabled('aiScope')).toBe(false)
    expect(JSON.parse(localStorage.getItem(FLAGS_STORAGE_KEY) ?? '{}')).toEqual({ aiScope: false })
    dbg.flags.set('aiUpload', true)
    expect(dbg.flags.get('aiUpload')).toBe(true)
    dbg.flags.set('aiScope', null)
    expect(isEnabled('aiScope')).toBe(true) // back to env
    dbg.flags.reset()
    expect(localStorage.getItem(FLAGS_STORAGE_KEY)).toBeNull()
    expect(seen.length).toBe(4)
    expect(custom).toHaveBeenCalledTimes(4)

    off()
    window.removeEventListener(FLAGS_CHANGED_EVENT, custom)
  })

  it('tolerates corrupt override JSON', () => {
    localStorage.setItem(FLAGS_STORAGE_KEY, '{not json')
    expect(isEnabled('aiScope')).toBe(false)
    localStorage.setItem(FLAGS_STORAGE_KEY, '{"aiScope":"yes"}')
    expect(isEnabled('aiScope')).toBe(false)
  })
})
