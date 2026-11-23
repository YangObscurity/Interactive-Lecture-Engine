/**
 * WP-F1: the canvas label layer and the lane map when the web fonts arrive late.
 *
 * (Only the datasheet skin has web fonts; the reader skin runs the same checks, which then reduce to "same picture, fonts ready". Note: in Chrome the canvas draw does start the font loads and incidental repaints (resize, re-measure) follow, so this test does not by itself tell the fixed layer from the old one; the unit tests in map-labels.test.ts pin the layer behaviour.)
 *
 * The bug: map text is drawn on a canvas, the svg text is `display: none`, so nothing ever asked the browser for the CJK and mono
 * font slices (a canvas draw does not start that download), and when slices did arrive nobody repainted. On a machine without a
 * CJK system font the labels stayed tofu. Reproduce: delay every `*.woff2` by 3 s, load, wait 5 s, and compare with the same page
 * loaded without a delay. Both must end on the same pixels (the real fonts), the layer must have loaded font files at all, and it
 * must have painted again after they came in. The counters come from `canvas.lecLabels` (labels.ts `LabelProbe`).
 *
 * The api is the fixtures' (context route), never a real backend: both pages of a test live in the fixture context.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { useTheme, type ThemeId } from './theme-helpers'

const DELAY_MS = 3000
const SKINS: ReadonlyArray<readonly [ThemeId, string]> = [
  ['reader', 'default'],
  ['datasheet', 'datasheet'],
]

interface Probe {
  paints: number
  fontsReady: boolean
}
type Mode = 'atlas' | 'graph'

/** A page of the fixture context with every font file held back by `delay` ms (0 = untouched); counts the font requests. */
async function newPage(page: Page, delay: number, theme: ThemeId): Promise<{ page: Page; fontRequests: () => number; held: () => number; atFirstHold: () => Probe | null }> {
  const p = await page.context().newPage()
  let n = 0
  let held = 0
  let first: Probe | null = null
  // Font files the page's own DOM text asks for (before the map exists) are let through at once, so `document.fonts.ready` is settled
  // by the time the label layer draws. Files asked for once the label canvas exists are the ones the canvas text brought in: those are
  // held back by `delay`. Without the layer's own `loadingdone` / load handling nothing repaints when they arrive.
  await p.route('**/*.woff2', async (route) => {
    n++
    const now = delay ? await probe(p).catch(() => null) : null
    if (now) {
      held++
      if (first === null) first = now
      await new Promise((r) => setTimeout(r, delay))
    }
    await route.continue()
  })
  await p.setViewportSize({ width: 1440, height: 900 })
  await useTheme(p, theme, 'light')
  return { page: p, fontRequests: () => n, held: () => held, atFirstHold: () => first }
}

async function openHome(p: Page, mode: Mode, impl: string): Promise<void> {
  await p.goto('/')
  await p.waitForSelector('html[data-hydrated="1"]')
  if (mode === 'atlas') {
    await p.waitForFunction((i) => document.querySelector('.am-layer [data-node="root"]')?.getAttribute('data-slot-impl') === i, impl)
    await p.waitForFunction(() => document.querySelectorAll('.am-group').length > 0)
  } else {
    await p.locator('[data-map-mode="graph"]').click()
    await p.waitForSelector('.cv-stage[data-canvas-ready="true"]', { state: 'attached' })
    await p.waitForFunction((i) => document.querySelector('.cv-layer [data-slot="CanvasGroup"]')?.getAttribute('data-slot-impl') === i, impl)
    await p.waitForFunction(() => document.querySelectorAll('.cv-node').length > 0)
  }
  await p.locator('.lec-map').first().scrollIntoViewIfNeeded()
}

const probe = (p: Page): Promise<Probe | null> =>
  p.evaluate(() => (document.querySelector('canvas.lec-map-labels') as (HTMLCanvasElement & { lecLabels?: Probe }) | null)?.lecLabels ?? null)

/** The layer has painted with every font it asked for in (and every label styled). */
async function untilFontsReady(p: Page): Promise<Probe> {
  await expect
    .poll(async () => (await probe(p))?.fontsReady, { timeout: 30_000, message: 'the label layer never reported its fonts ready' })
    .toBe(true)
  return (await probe(p)) as Probe
}

const pixels = (p: Page): Promise<string> => p.evaluate(() => (document.querySelector('canvas.lec-map-labels') as HTMLCanvasElement).toDataURL())

for (const mode of ['atlas', 'graph'] as const) {
  for (const [theme, impl] of SKINS) {
    test(`${mode} ${theme}: labels are painted with the real fonts when the font files arrive 3 s late`, async ({ page }) => {
      test.setTimeout(120_000)
      // the slow load
      const slow = await newPage(page, DELAY_MS, theme)
      const t0 = Date.now()
      await openHome(slow.page, mode, impl)
      // "wait 5 s" after the load started, then ask the layer instead of trusting the clock
      await slow.page.waitForTimeout(Math.max(0, 5000 - (Date.now() - t0)))
      const late = await untilFontsReady(slow.page)
      // the reader skin is system fonts only ("zero webfont downloads", theme.json): nothing to fetch or repaint for there. The datasheet
      // skin uses the Noto / JetBrains Mono slices: some are first needed by canvas text, and those were held back for 3 s
      if (theme === 'datasheet') {
        expect(slow.held(), 'font files were asked for by the label canvas (else this test checks nothing)').toBeGreaterThan(0)
        const before = slow.atFirstHold() as Probe
        expect(before.paints, 'painted with the fallback font before the files came').toBeGreaterThan(0)
        expect(late.paints, 'repainted after the fonts came in').toBeGreaterThan(before.paints)
      }
      const loaded = await slow.page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length)
      if (theme === 'datasheet') expect(loaded, 'font faces are loaded').toBeGreaterThan(0)
      await slow.page.evaluate(() => document.fonts.ready.then(() => undefined))
      const slowPixels = await pixels(slow.page)
      await slow.page.close()

      // the same page with the fonts at once: the final picture must be the same
      const fast = await newPage(page, 0, theme)
      await openHome(fast.page, mode, impl)
      await fast.page.waitForTimeout(1500)
      await untilFontsReady(fast.page)
      await fast.page.evaluate(() => document.fonts.ready.then(() => undefined))
      const fastPixels = await pixels(fast.page)
      await fast.page.close()
      expect(slowPixels === fastPixels, 'canvas after the late fonts equals the canvas of the page whose fonts came at once').toBe(true)
    })
  }
}

test('group page G05: lane map lines follow the chips after the font files arrive 3 s late', async ({ page }) => {
  test.setTimeout(120_000)
  const lines = async (delay: number): Promise<{ d: string[]; widths: number[] }> => {
    const { page: p } = await newPage(page, delay, 'reader')
    await p.goto('/g05/')
    await p.waitForSelector('html[data-hydrated="1"]')
    await p.waitForSelector('.gp-lanes .gp-lc')
    // track a lecture at once, while the late fonts are still out
    await p.locator('.gp-lanes [data-lecture="g05-l05"]').dblclick()
    await expect(p.locator('.gp-lanes.is-tracking')).toHaveCount(1)
    await p.waitForTimeout(delay ? 5500 : 1500)
    await p.evaluate(() => document.fonts.ready.then(() => undefined))
    await p.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const out = await p.evaluate(() => ({
      d: [...document.querySelectorAll('.gp-edges path.e-pre, .gp-edges path.e-post')].map((e) => e.getAttribute('d') ?? ''),
      widths: [...document.querySelectorAll('.gp-lanes [data-lecture]')].map((e) => Math.round(e.getBoundingClientRect().width * 10) / 10),
    }))
    await p.close()
    return out
  }
  const slow = await lines(DELAY_MS)
  const fast = await lines(0)
  expect(fast.d.length, 'the tracked lecture has lines').toBeGreaterThan(0)
  expect(slow.widths, 'the chips end up the same size').toEqual(fast.widths)
  expect(slow.d, 'the lines end on the chips as they are now').toEqual(fast.d)
})
