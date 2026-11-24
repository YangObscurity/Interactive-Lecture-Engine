/**
 * P3 progress (plan_v2_p3_progress_auth.md §3.3, §4 "WP-P2 e2e"): the reader's experience of lecture progress.
 *
 *   1. group page: change one lecture -> survives a reload; the backend got one PATCH with an Idempotency-Key
 *   2. offline: the change shows at once and waits in the outbox (pending 1); the network comes back -> it is sent
 *   3. a refused write (422) rolls back and shows a message
 *   4. batch marking of 5 lectures -> one POST /batch
 *   5. V1 progress in localStorage (one lecture differs from the seed) -> queued and sent on the first load
 *   6. two tabs: tab A changes a status, tab B follows without a reload
 *   7. `legacy-backend`: home and group page render, reading falls back to one request per group
 *   8. lecture page: the progress card writes through the store; no hydration warnings on the pages that use it
 *
 * The backend is an in-spec stateful mock (`ProgressMock`) installed with `context.route`, which takes precedence
 * over the static fixtures of fixtures.ts for the progress endpoints. It keeps the records in memory, honours
 * `Idempotency-Key`, and can be switched to offline / reject / legacy per test. The real backend is never reached.
 *
 * S6: runs on the demo content (`npm run build:e2e`). The group is MEA (6 lectures). The build's progress seed
 * (graph/notion_knowledge_graph.json of the demo) has MEA L01 and L02 completed and L03 in progress, so the tests
 * change MEA L04-L06, which start unread.
 */
import type { BrowserContext, Page, Route } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'
import { demoGroup } from './demo'

// ---------------------------------------------------------------------------------------------------
// the in-spec backend
// ---------------------------------------------------------------------------------------------------

const NOT_STARTED = '未开始'
const IN_PROGRESS = '学习中'
const COMPLETED = '已完成'

type Mode = 'normal' | 'offline' | 'reject' | 'legacy'

interface WireRecord {
  lecture_id: string
  group_id: string
  status: string
  completed_at: string | null
  updated_at: string
  notion_node_id: string | null
  notion_page_id: string | null
}

interface Seen {
  method: string
  path: string
  query: string
  headers: Record<string, string>
  body: unknown
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

class ProgressMock {
  mode: Mode = 'normal'
  readonly records = new Map<string, WireRecord>()
  /** Every request to /api/db/progress** (reads and writes). */
  readonly requests: Seen[] = []
  /** Every request to the Notion sync proxy endpoints. */
  readonly notion: Seen[] = []
  private readonly replays = new Map<string, { status: number; body: string }>()

  seed(lectureId: string, status: string): void {
    this.records.set(lectureId, {
      lecture_id: lectureId,
      group_id: lectureId.slice(0, lectureId.lastIndexOf('-')),
      status,
      completed_at: status === COMPLETED ? '2026-11-01T00:00:00.000Z' : null,
      updated_at: '2026-11-01T00:00:00.000Z',
      notion_node_id: null,
      notion_page_id: null,
    })
  }

  get writes(): Seen[] {
    return this.requests.filter((r) => r.method !== 'GET')
  }
  writesTo(method: string, pathSuffix = ''): Seen[] {
    return this.writes.filter((r) => r.method === method && r.path.endsWith(pathSuffix))
  }
  get reads(): Seen[] {
    return this.requests.filter((r) => r.method === 'GET')
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route(/\/api\/db\/progress(\/|\?|$)/, (route) => this.handleProgress(route))
    await context.route(/\/api\/(progress\/notion-sync|notion\/sync-status)$/, (route) => this.handleNotion(route))
  }

  private record(route: Route): Seen {
    const req = route.request()
    const url = new URL(req.url())
    const raw = req.postData()
    let body: unknown
    try {
      body = raw ? (JSON.parse(raw) as unknown) : undefined
    } catch {
      body = raw
    }
    return { method: req.method(), path: url.pathname, query: url.search, headers: req.headers(), body }
  }

  private async handleNotion(route: Route): Promise<void> {
    this.notion.push(this.record(route))
    await route.fulfill({ status: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true, synced: true }) })
  }

  private async handleProgress(route: Route): Promise<void> {
    const seen = this.record(route)
    this.requests.push(seen)
    if (this.mode === 'offline') return route.abort('internetdisconnected')
    const url = new URL(route.request().url())
    const sub = url.pathname.replace(/^.*\/api\/db\/progress/, '')
    const json = (status: number, payload: unknown, extra: Record<string, string> = {}) =>
      route.fulfill({ status, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(payload) })

    if (seen.method === 'GET') {
      const group = url.searchParams.get('group_id')
      if (this.mode === 'legacy' && !group && !url.searchParams.get('lecture_id')) return json(400, { error: 'group_id or lecture_id required' })
      const all = [...this.records.values()]
      return json(200, group ? all.filter((r) => r.group_id === group.toLowerCase()) : all)
    }

    if (this.mode === 'reject') return json(422, { error: 'status_not_allowed' })

    const key = this.mode === 'legacy' ? undefined : seen.headers['idempotency-key']
    if (key) {
      const replay = this.replays.get(key)
      if (replay) return route.fulfill({ status: replay.status, headers: { ...JSON_HEADERS, 'idempotency-replayed': 'true' }, body: replay.body })
    }

    let status = 200
    let payload: unknown
    if (seen.method === 'PATCH' && sub.startsWith('/')) {
      payload = this.apply(decodeURIComponent(sub.slice(1)), seen.body)
    } else if (seen.method === 'POST' && sub === '/batch') {
      const items = (seen.body as { items?: unknown[] } | undefined)?.items ?? []
      payload = items.map((item) => this.apply(String((item as { lecture_id?: unknown }).lecture_id ?? ''), item))
    } else {
      status = 404
      payload = { error: 'not_found' }
    }
    const body = JSON.stringify(payload)
    if (key && status < 300) this.replays.set(key, { status, body })
    return route.fulfill({ status, headers: JSON_HEADERS, body })
  }

  private apply(lectureId: string, body: unknown): WireRecord {
    const b = (body ?? {}) as { status?: string; group_id?: string }
    const status = b.status ?? NOT_STARTED
    const now = new Date().toISOString()
    const prev = this.records.get(lectureId)
    const next: WireRecord = {
      lecture_id: lectureId,
      group_id: b.group_id ?? prev?.group_id ?? lectureId.slice(0, lectureId.lastIndexOf('-')),
      status,
      completed_at: status === COMPLETED ? (prev?.completed_at ?? now) : null,
      updated_at: now,
      notion_node_id: prev?.notion_node_id ?? null,
      notion_page_id: prev?.notion_page_id ?? null,
    }
    this.records.set(lectureId, next)
    return next
  }
}

// ---------------------------------------------------------------------------------------------------
// page helpers
// ---------------------------------------------------------------------------------------------------

interface ProgressPanel {
  ready: boolean
  owner: string | null
  counts: { server: number; seed: number; outbox: number }
  unfilteredGet: boolean | null
  syncState: string
}

/** The store's debug panel, read from the page (the debug console is switched on by `useDebug`). */
async function panel(page: Page): Promise<ProgressPanel | null> {
  return page.evaluate(() => {
    const w = window as unknown as { __LECTURE_DEBUG__?: { panel(id: string): unknown } }
    return (w.__LECTURE_DEBUG__?.panel('progress') as ProgressPanel | undefined) ?? null
  })
}

/** Wait until the store finished loading; `fetched` also waits for the first read of the backend to succeed. */
async function storeReady(page: Page, fetched = true): Promise<void> {
  await expect
    .poll(async () => {
      const p = await panel(page)
      return Boolean(p?.ready && (!fetched || p.unfilteredGet !== null))
    }, { message: 'progress store ready' })
    .toBe(true)
}

const outbox = async (page: Page): Promise<number> => (await panel(page))?.counts.outbox ?? -1

/** Open a page with the debug console on, the mock installed and the store loaded. */
async function open(page: Page, mock: ProgressMock, urlPath: string, fetched = true): Promise<void> {
  await mock.install(page.context())
  await page.context().addInitScript(() => localStorage.setItem('lecture:debug', '1'))
  await gotoAndSettle(page, urlPath)
  await storeReady(page, fetched)
}

const GROUP = '/mea/'
/** Row indexes of the MEA lectures the seed leaves unread (L04, L05, L06). */
const L04 = 3
const L05 = 4
const L06 = 5
// P4a WP-H3: the group page is two maps now; the lecture map's chips carry `data-status` (unread / reading / read) and a lecture is
// marked through the relation panel (track it with a double click, then "标为已读") or through batch marking
const row = (page: Page, i: number) => page.locator(`.gp-lanes [data-lecture="mea-l${String(i + 1).padStart(2, '0')}"]`)
const rowStatus = row
const markRead = async (page: Page, i: number) => {
  await row(page, i).dblclick()
  await page.locator('[data-gp-act="mark"]').click()
}

// ---------------------------------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------------------------------

test.describe('progress (stateful mock backend)', () => {
  test('1. a change on the group page survives a reload; one PATCH with an Idempotency-Key reaches the backend', async ({ page }) => {
    await page.route('**/api/auth/session', (route) =>
      route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          authenticated: true,
          user: { id: 'admin-1', name: 'Admin', email: 'admin@example.com' },
          roles: ['admin'],
          groups: ['admin'],
          logoutUrl: null,
        }),
      }),
    )
    const mock = new ProgressMock()
    await open(page, mock, GROUP)
    await expect(rowStatus(page, 0)).toHaveAttribute('data-status', 'read') // seeded
    await expect(rowStatus(page, L04)).toHaveAttribute('data-status', 'unread')

    await markRead(page, L04)
    await expect(rowStatus(page, L04)).toHaveAttribute('data-status', 'read')
    await expect.poll(() => mock.writesTo('PATCH').length).toBe(1)
    await expect.poll(() => outbox(page)).toBe(0)

    const [patch] = mock.writesTo('PATCH')
    expect(patch?.path).toMatch(/\/api\/db\/progress\/mea-l04$/)
    expect(patch?.headers['idempotency-key']).toBeTruthy()
    expect((patch?.body as { status?: string }).status).toBe(COMPLETED)
    expect(mock.writes).toHaveLength(1)
    // the Notion bridge forwards the reader's change once
    await expect.poll(() => mock.notion.length).toBe(1)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await storeReady(page)
    await expect(rowStatus(page, L04)).toHaveAttribute('data-status', 'read')
    expect((await panel(page))?.counts.server).toBeGreaterThan(0)
    expect(mock.writes).toHaveLength(1) // a reload alone writes nothing
  })

  test('2. offline: the change shows at once and waits (pending 1); back online it is sent', async ({ page }) => {
    const mock = new ProgressMock()
    await open(page, mock, GROUP)

    mock.mode = 'offline'
    await markRead(page, L05)
    await expect(rowStatus(page, L05)).toHaveAttribute('data-status', 'read') // immediate
    await expect.poll(() => outbox(page)).toBe(1)
    await expect.poll(async () => (await panel(page))?.syncState).toBe('offline')
    expect(mock.records.size).toBe(0)

    mock.mode = 'normal'
    await expect.poll(() => outbox(page), { message: 'the outbox drains by itself', timeout: 30_000 }).toBe(0)
    await expect(rowStatus(page, L05)).toHaveAttribute('data-status', 'read')
    expect(mock.records.get('mea-l05')?.status).toBe(COMPLETED)
    // every attempt carried the same Idempotency-Key (one operation, retried)
    const keys = mock.writesTo('PATCH').map((r) => r.headers['idempotency-key'])
    expect(keys.length).toBeGreaterThanOrEqual(2)
    expect(new Set(keys).size).toBe(1)
  })

  test('3. a refused write (422) rolls back and shows a message', async ({ page }) => {
    const mock = new ProgressMock()
    await open(page, mock, GROUP)

    mock.mode = 'reject'
    await markRead(page, L06)
    await expect(page.locator('.ai-toast-item', { hasText: '未能保存' })).toBeVisible()
    await expect(rowStatus(page, L06)).toHaveAttribute('data-status', 'unread')
    await expect.poll(() => outbox(page)).toBe(0)
    expect(mock.writesTo('PATCH')).toHaveLength(1) // refused writes are not retried
    expect(mock.records.size).toBe(0)
  })

  test('4. marking 4 lectures in batch sends one POST /batch', async ({ page }) => {
    const mock = new ProgressMock()
    await open(page, mock, GROUP)
    const total = await page.locator('.gp-lanes [data-lecture]').count()
    expect(total).toBe(demoGroup('MEA').lectures.length)
    // MEA L01-L02 are read in the seed; L03 (reading) and L04-L06 (unread) are marked together
    await expect(page.locator('[data-gp-spec="read"]')).toContainText(`2 / ${total}`)

    await page.locator('[data-gp-batch-toggle]').click()
    for (let i = 2; i < 6; i++) await row(page, i).click()
    await page.locator('[data-gp-batch="read"]').click()

    for (let i = 0; i < 6; i++) await expect(rowStatus(page, i)).toHaveAttribute('data-status', 'read')
    await expect(page.locator('[data-gp-spec="read"]')).toContainText(`6 / ${total}`)
    await expect.poll(() => mock.writesTo('POST', '/batch').length).toBe(1)
    await expect.poll(() => outbox(page)).toBe(0)
    expect(mock.writes).toHaveLength(1) // no PATCH next to it
    const [batch] = mock.writes
    expect(batch?.headers['idempotency-key']).toMatch(/^batch-/)
    const items = (batch?.body as { items: Array<{ lecture_id: string; status: string }> }).items
    expect(items.map((i) => i.lecture_id).sort()).toEqual(['mea-l03', 'mea-l04', 'mea-l05', 'mea-l06'])
    expect(new Set(items.map((i) => i.status))).toEqual(new Set([COMPLETED]))
  })

  test('5. V1 local progress that differs from the seed is queued and sent on the first load (V1 keys stay)', async ({ page }) => {
    const mock = new ProgressMock()
    // V1 wrote its own records; MEA L04 is "not started" in the seed, so this one differs
    const v1 = { lecture_id: 'mea-l04', group_id: 'mea', status: COMPLETED, completed_at: '2026-10-20T10:00:00.000Z', updated_at: '2026-10-20T10:00:00.000Z', notion_node_id: null, notion_page_id: null }
    await page.addInitScript((rec) => {
      localStorage.setItem('tut_neon_progress_mea-l04', JSON.stringify(rec))
      localStorage.setItem('tut_neon_progress_all_map', JSON.stringify({ 'mea-l04': rec }))
    }, v1)
    await open(page, mock, GROUP)

    await expect.poll(() => mock.writesTo('PATCH').length).toBe(1)
    await expect.poll(() => outbox(page)).toBe(0)
    const [patch] = mock.writesTo('PATCH')
    expect(patch?.path).toMatch(/\/api\/db\/progress\/mea-l04$/)
    const body = patch?.body as { status: string; updated_at: string }
    expect(body.status).toBe(COMPLETED)
    expect(body.updated_at).toBe(v1.updated_at) // stamped with the time V1 recorded
    await expect(rowStatus(page, L04)).toHaveAttribute('data-status', 'read')
    // V1 keys are only read, never removed
    const left = await page.evaluate(() => [localStorage.getItem('tut_neon_progress_mea-l04'), localStorage.getItem('tut_neon_progress_all_map')])
    expect(left[0]).not.toBeNull()
    expect(left[1]).not.toBeNull()
  })

  test('6. two tabs: a change in tab A shows up in tab B without a reload', async ({ page, context }) => {
    const mock = new ProgressMock()
    await open(page, mock, GROUP)
    const b = await context.newPage()
    await gotoAndSettle(b, GROUP)
    await storeReady(b)
    await expect(rowStatus(b, L04)).toHaveAttribute('data-status', 'unread')

    await markRead(page, L04)
    await expect(rowStatus(page, L04)).toHaveAttribute('data-status', 'read')
    await expect(rowStatus(b, L04)).toHaveAttribute('data-status', 'read')
    await expect.poll(() => mock.writesTo('PATCH').length).toBe(1) // only the tab that changed it sends
    await b.close()
  })

  test('7. legacy backend: home and group page render and reading falls back to one request per group', async ({ page, pageErrors }) => {
    const mock = new ProgressMock()
    mock.mode = 'legacy'
    mock.seed('mea-l04', IN_PROGRESS)
    await open(page, mock, '/')
    await expect(page.locator('#groups a[data-slot="GroupCard"]').first()).toBeVisible()
    expect((await panel(page))?.unfilteredGet).toBe(false)
    const unfiltered = mock.reads.filter((r) => !r.query)
    const perGroup = mock.reads.filter((r) => r.query.startsWith('?group_id='))
    expect(unfiltered.length).toBeGreaterThanOrEqual(1)
    expect(perGroup.length).toBeGreaterThan(1)
    expect(perGroup.some((r) => r.query === '?group_id=mea')).toBe(true)

    await page.goto(GROUP, { waitUntil: 'domcontentloaded' })
    await storeReady(page)
    await expect(page.locator('.gp-lanes [data-lecture]').first()).toBeVisible()
    await expect(rowStatus(page, L04)).toHaveAttribute('data-status', 'reading') // came from the per-group read
    expect(pageErrors).toEqual([])
  })

  test('8. the lecture progress card writes through the store; no hydration warnings on group and lecture pages', async ({ page, consoleErrors, pageErrors }) => {
    const mock = new ProgressMock()
    const warnings: string[] = []
    page.on('console', (m) => {
      if (/hydrat/i.test(m.text())) warnings.push(m.text())
    })
    await open(page, mock, GROUP)
    await expect(page.locator('.gp-lanes [data-lecture]').first()).toBeVisible()

    await gotoAndSettle(page, '/mea/L04')
    await storeReady(page)
    const card = page.locator('.lec-progress-card')
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-status', NOT_STARTED)
    await page.locator('.lpc-primary-btn').click()
    await expect(card).toHaveAttribute('data-status', COMPLETED)
    await expect(card.locator('.lpc-time-tag')).toContainText('打卡时间')
    await expect.poll(() => mock.writesTo('PATCH').length).toBe(1)
    expect((mock.writesTo('PATCH')[0]?.body as { status?: string }).status).toBe(COMPLETED)

    expect(warnings).toEqual([])
    expect(consoleErrors.filter((t) => /hydrat/i.test(t))).toEqual([])
    expect(pageErrors).toEqual([])
  })
})
