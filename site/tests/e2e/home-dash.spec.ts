/**
 * HOME-DASH (2026-11-22): the home map from the first paint, its loading mask, the labels that wait for their fonts, and the
 * Dashboard entry in the top bar.
 *
 * Prod project only (the preview of the built site): the first-paint script and the font behaviour are properties of the build.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { useTheme } from './theme-helpers'

test.beforeEach(({ browserName }, info) => {
  void browserName
  test.skip(info.project.name !== 'prod', 'first paint, fonts and the gateway session are checked on the built site')
})

const MODE_KEY = 'lecture:home-map-mode'

interface Probe {
  paints: number
  fontsReady: boolean
  waiting: number
  gaveUp: boolean
  drawn: number
  ready: boolean
}
const labelProbe = (p: Page): Promise<Probe | null> =>
  p.evaluate(() => (document.querySelector('canvas.lec-map-labels') as (HTMLCanvasElement & { lecLabels?: Probe }) | null)?.lecLabels ?? null)

async function storeMode(page: Page, mode: 'atlas' | 'graph'): Promise<void> {
  await page.addInitScript(([k, m]) => {
    try {
      localStorage.setItem(k, m)
    } catch {
      /* ignore */
    }
  }, [MODE_KEY, mode] as const)
}

test.describe('(a) the remembered mode is right from the first paint', () => {
  test('graph stored: no frame shows the atlas toggle state or the atlas map', async ({ page }) => {
    await useTheme(page, 'datasheet', 'light')
    await storeMode(page, 'graph')
    // sample every frame from the start of the document: which toggle button looks pressed, and whether an atlas is on screen
    await page.addInitScript(() => {
      const w = window as unknown as { __frames: Array<{ pressed: string | null; atlasVisible: boolean; mask: boolean }> }
      w.__frames = []
      const looksPressed = (b: Element): boolean => {
        const cs = getComputedStyle(b)
        const text = getComputedStyle(document.documentElement).getPropertyValue('--lec-text').trim()
        return text !== '' && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.borderColor === cs.backgroundColor && cs.color !== cs.backgroundColor
      }
      const tick = (): void => {
        const btns = [...document.querySelectorAll('.hb-mode-btn')]
        if (btns.length) {
          const pressed = btns.filter(looksPressed).map((b) => b.getAttribute('data-map-mode'))
          const stage = document.querySelector('.am-map')
          w.__frames.push({
            pressed: pressed.length === 1 ? (pressed[0] as string) : pressed.join('+') || null,
            atlasVisible: !!stage && getComputedStyle(stage).visibility === 'visible',
            mask: !!document.querySelector('[data-map-mask]'),
          })
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    // hold the scripts back so the server-rendered page is on screen for a while (the window of the old flash)
    await page.route('**/assets/**/*.js', async (route) => {
      await new Promise((r) => setTimeout(r, 700))
      await route.continue()
    })
    await page.goto('/')
    await page.waitForSelector('html[data-hydrated="1"]')
    await expect(page.locator('[data-map-mode="graph"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('section.cv-stage')).toBeVisible({ timeout: 30_000 })
    const frames = await page.evaluate(() => (window as unknown as { __frames: unknown[] }).__frames as Array<{ pressed: string | null; atlasVisible: boolean; mask: boolean }>)
    expect(frames.length, 'frames were sampled before the page settled').toBeGreaterThan(5)
    expect(frames.filter((f) => f.pressed === 'atlas' || f.pressed === 'atlas+graph').length, 'frames with the atlas toggle pressed').toBe(0)
    expect(frames.filter((f) => f.atlasVisible).length, 'frames with the atlas map visible').toBe(0)
    expect(frames.some((f) => f.pressed === 'graph'), 'the graph toggle looked pressed while the page was still loading').toBe(true)
  })

  test('atlas stored or nothing stored: atlas; a value that is not a mode is ignored', async ({ page }) => {
    await page.addInitScript(([k]) => localStorage.setItem(k, 'nonsense'), [MODE_KEY] as const)
    await page.goto('/')
    await page.waitForSelector('html[data-hydrated="1"]')
    await expect(page.locator('[data-map-mode="atlas"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).not.toHaveAttribute('data-home-map', /.+/)
  })

  test('storage that throws: the default mode is used and the page works', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('denied', 'SecurityError')
        },
      })
    })
    await page.goto('/')
    await page.waitForSelector('html[data-hydrated="1"]')
    await expect(page.locator('[data-map-mode="atlas"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('section.am-map')).toBeVisible()
  })

  test('the toggle keeps the choice for the next visit', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('html[data-hydrated="1"]')
    await page.locator('[data-map-mode="graph"]').click()
    await expect(page.locator('[data-map-mode="graph"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-home-map', 'graph')
    await page.reload()
    await page.waitForSelector('html[data-hydrated="1"]')
    await expect(page.locator('[data-map-mode="graph"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.cv-stage')).toBeVisible()
  })
})

test.describe('(b) the mask while the fonts are late', () => {
  test('a mask with a spinner covers the map region (same height) until the map is ready, then it is gone', async ({ page }) => {
    test.setTimeout(60_000)
    await useTheme(page, 'datasheet', 'light')
    await page.route('**/*.woff2', async (route) => {
      await new Promise((r) => setTimeout(r, 1800))
      await route.continue()
    })
    await page.goto('/', { waitUntil: 'commit' })
    const region = page.locator('.hb-map-region')
    await expect(region).toHaveAttribute('aria-busy', 'true')
    const mask = page.locator('[data-map-mask]')
    await expect(mask).toBeVisible()
    await expect(mask).toHaveAttribute('role', 'status')
    await expect(mask.locator('.hb-map-spinner')).toBeVisible()
    await expect(mask).toContainText('正在加载地图')
    const h0 = (await region.boundingBox())?.height ?? 0
    expect(h0).toBeGreaterThanOrEqual(420)
    // the map is not painted into view while masked
    await expect(page.locator('.hb-map-body')).toHaveCSS('visibility', 'hidden')
    await expect(mask).toHaveCount(0, { timeout: 20_000 })
    await expect(region).toHaveAttribute('aria-busy', 'false')
    await expect(region).toHaveAttribute('data-map-state', 'ready')
    await expect(page.locator('.hb-map-body')).toHaveCSS('visibility', 'visible')
    expect(Math.round((await region.boundingBox())?.height ?? 0), 'the region keeps its height').toBe(Math.round(h0))
  })

  test('switching the mode shows the mask again until the other map is ready', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-map-mask]')).toHaveCount(0, { timeout: 20_000 })
    await page.locator('[data-map-mode="graph"]').click()
    await expect(page.locator('.hb-map-region')).toHaveAttribute('data-map-state', 'ready', { timeout: 20_000 })
    await expect(page.locator('[data-map-mask]')).toHaveCount(0)
    await expect(page.locator('.cv-stage')).toBeVisible()
  })

  test('English home: the mask text is in English', async ({ page }) => {
    await useTheme(page, 'datasheet', 'light')
    await page.route('**/*.woff2', async (route) => {
      await new Promise((r) => setTimeout(r, 1500))
      await route.continue()
    })
    await page.goto('/en/', { waitUntil: 'commit' })
    await expect(page.locator('[data-map-mask]').first()).toContainText('Loading the map')
  })
})

test.describe('(c) no label is painted before its fonts arrive or the wait is given up', () => {
  test('datasheet skin, font files 4.5 s late: nothing drawn until the 3 s give-up, then the labels appear', async ({ page }) => {
    test.setTimeout(90_000)
    await useTheme(page, 'datasheet', 'light')
    await page.route('**/*.woff2', async (route) => {
      await new Promise((r) => setTimeout(r, 4500))
      await route.continue()
    })
    await page.goto('/', { waitUntil: 'commit' })
    await page.waitForSelector('canvas.lec-map-labels', { state: 'attached' })
    const samples: Array<{ t: number; p: Probe }> = []
    const t0 = Date.now()
    while (Date.now() - t0 < 9000) {
      const p = await labelProbe(page)
      if (p) samples.push({ t: Date.now() - t0, p })
      await page.waitForTimeout(60)
    }
    expect(samples.length).toBeGreaterThan(20)
    const early = samples.filter((s) => !s.p.gaveUp && s.p.fontsReady === false)
    expect(early.length, 'samples taken while the layer was waiting').toBeGreaterThan(3)
    for (const s of early) expect(s.p.drawn, `drawn at ${s.t} ms, before the fonts or the give-up`).toBe(0)
    expect(samples.some((s) => s.p.waiting > 0 && !s.p.gaveUp), 'labels were held back').toBe(true)
    const last = samples[samples.length - 1]!.p
    expect(last.ready).toBe(true)
    expect(last.drawn, 'labels are drawn at the end').toBeGreaterThan(0)
  })
})

test.describe('(d) the Dashboard entry in the top bar', () => {
  const session = (body: unknown) => async (page: Page): Promise<void> => {
    await page.context().route('**/api/auth/session', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) }),
    )
  }
  const anonymous = session({ authenticated: false, user: null, roles: [], groups: [], logoutUrl: null })
  const reader = session({ authenticated: true, user: { id: 'bob', name: 'Bob', email: 'b@example.com' }, roles: ['reader'], groups: ['students-2026'], logoutUrl: null })
  const admin = session({ authenticated: true, user: { id: 'amy', name: 'Amy', email: 'a@example.com' }, roles: ['admin', 'reader'], groups: ['admins'], logoutUrl: null })
  const link = (p: Page) => p.locator('.VPNavBar [data-lec-dashboard-link]')

  async function open(page: Page, path: string): Promise<void> {
    const asked = page.waitForRequest('**/api/auth/session')
    await page.goto(path)
    await page.waitForSelector('html[data-hydrated="1"]')
    await asked
    await page.waitForTimeout(400)
  }

  test('anonymous: no entry on the home page or in the mobile menu', async ({ page }) => {
    await anonymous(page)
    await open(page, '/')
    await expect(page.locator('[data-lec-dashboard-link]')).toHaveCount(0)
    await page.setViewportSize({ width: 375, height: 800 })
    await page.locator('.VPNavBarHamburger').click()
    await expect(page.locator('.VPNavScreen')).toBeVisible()
    await expect(page.locator('[data-lec-dashboard-link]')).toHaveCount(0)
  })

  test('reader: Dashboard entry opens /dashboard for personal learning & account', async ({ page }) => {
    await reader(page)
    await open(page, '/')
    await expect(link(page)).toHaveCount(1)
    await expect(link(page)).toHaveText('控制台')
    await expect(link(page)).toHaveAttribute('href', '/dashboard')
    await page.setViewportSize({ width: 375, height: 800 })
    await page.locator('.VPNavBarHamburger').click()
    await expect(page.locator('.VPNavScreen')).toBeVisible()
    await expect(page.locator('.VPNavScreen [data-lec-dashboard-link]')).toHaveCount(1)
  })

  test('admin: the entry sits before the settings button and opens /dashboard (zh) and /en/dashboard (en)', async ({ page }) => {
    await admin(page)
    await open(page, '/')
    await expect(link(page)).toHaveCount(1)
    await expect(link(page)).toHaveText('控制台')
    await expect(link(page)).toHaveAttribute('href', '/dashboard')
    const before = await link(page).evaluate((a) => !!(a.compareDocumentPosition(document.querySelector('[data-lec-settings-btn]') as Element) & Node.DOCUMENT_POSITION_FOLLOWING))
    expect(before, 'the entry comes before 设置 in the bar').toBe(true)
    await open(page, '/en/')
    await expect(link(page)).toHaveText('Dashboard')
    await expect(link(page)).toHaveAttribute('href', '/en/dashboard')
  })

  test('admin: appearing moves the items before it by at most its own width, and nothing after it', async ({ page }) => {
    await admin(page)
    await page.goto('/')
    await page.waitForSelector('html[data-hydrated="1"]')
    await expect(link(page)).toHaveCount(1)
    const box = async (sel: string): Promise<{ x: number; width: number }> => (await page.locator(sel).first().boundingBox()) as { x: number; width: number }
    const entry = await box('.VPNavBar [data-lec-dashboard-link]')
    const settings = await box('.VPNavBar [data-lec-settings-btn]')
    const lang = await box('.VPNavBar .lang-switch')
    await link(page).evaluate((a) => ((a as HTMLElement).style.display = 'none'))
    const settings0 = await box('.VPNavBar [data-lec-settings-btn]')
    const lang0 = await box('.VPNavBar .lang-switch')
    expect(settings.x, 'the settings button (after the entry) does not move').toBe(settings0.x)
    const shift = lang0.x - lang.x
    expect(shift, 'items before the entry move left').toBeGreaterThan(0)
    expect(shift, 'by at most its own width plus its margin').toBeLessThanOrEqual(entry.width + 9)
  })

  test('admin on a narrow screen: the entry is in the mobile menu, not in the bar, and links to the locale dashboard', async ({ page }) => {
    await admin(page)
    await page.setViewportSize({ width: 375, height: 800 })
    await open(page, '/en/')
    await expect(link(page)).toBeHidden()
    await page.locator('.VPNavBarHamburger').click()
    const inMenu = page.locator('.VPNavScreen [data-lec-dashboard-link]')
    await expect(inMenu).toBeVisible()
    await expect(inMenu).toHaveAttribute('href', '/en/dashboard')
  })

  test('both skins draw the entry with tokens (visible text, border)', async ({ page }) => {
    await admin(page)
    for (const skin of ['reader', 'datasheet'] as const) {
      const p = await page.context().newPage()
      await useTheme(p, skin, 'light')
      await p.goto('/')
      await p.waitForSelector('html[data-hydrated="1"]')
      await expect(p.locator('.VPNavBar [data-lec-dashboard-link]')).toBeVisible()
      await p.close()
    }
  })
})
