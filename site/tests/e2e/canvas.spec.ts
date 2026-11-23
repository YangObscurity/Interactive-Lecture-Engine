/**
 * E2E verification of the global dependency canvas (`graph` mode, P4b — docs-dev/MAP.md).
 *
 * Covers the home map mode toggle, both `reader` (default) and `datasheet` skins, the 24 prototype interaction
 * checks ported from the home-canvas prototype, datasheet compact/zones layout switching,
 * bundle expand (`ann-tag` isolation), LOD zoom labels, search & Enter lock, trace-panel wheel isolation,
 * runtime skin swap, sharp canvas rendering during pan, zero `/_access/` requests, and `@visual-v2` baselines.
 */
import { test, expect, waitForLabelPaint } from './fixtures'
import { expectThemeActive, useTheme, type Mode, type ThemeId } from './theme-helpers'
import type { Page } from '@playwright/test'

const SAMPLE_PROGRESS = [
  ...Array.from({ length: 18 }, (_, i) => ({
    lecture_id: `g05-l${String(i + 1).padStart(2, '0')}`,
    group_id: 'G05',
    status: 'completed',
    completed_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    notion_node_id: null,
    notion_page_id: null,
  })),
  {
    lecture_id: 'g05-l19',
    group_id: 'G05',
    status: 'in_progress',
    completed_at: null,
    updated_at: '2026-11-01T00:00:00.000Z',
    notion_node_id: null,
    notion_page_id: null,
  },
  {
    lecture_id: 'g03-l07',
    group_id: 'G03',
    status: 'in_progress',
    completed_at: null,
    updated_at: '2026-11-01T00:00:00.000Z',
    notion_node_id: null,
    notion_page_id: null,
  },
]

async function mockProgress(page: Page): Promise<void> {
  await page.context().route(/\/api\/db\/progress(\/|\?|$)/, (route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(SAMPLE_PROGRESS),
    })
  })
}

async function settle(page: Page, ms = 120): Promise<void> {
  await page.waitForTimeout(ms)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function openCanvas(
  page: Page,
  theme: ThemeId,
  impl: string,
  mode: Mode = 'light',
  size = { width: 1440, height: 900 },
): Promise<void> {
  await page.setViewportSize(size)
  await mockProgress(page)
  await useTheme(page, theme, mode)
  await page.goto('/')
  await page.waitForSelector('html[data-hydrated="1"]')
  await page.locator('[data-map-mode="graph"]').click()
  await page.waitForSelector('.cv-stage[data-canvas-ready="true"]', { state: 'attached' })
  await page.waitForFunction(
    (expectedImpl) => {
      const g = document.querySelector('.cv-layer [data-slot="CanvasGroup"]')
      return g?.getAttribute('data-slot-impl') === expectedImpl
    },
    impl,
  )
  await page.waitForFunction(() => document.querySelectorAll('.cv-node').length > 0)
  await page.locator('.cv-stage').first().scrollIntoViewIfNeeded()
  await waitForLabelPaint(page)
  await settle(page, 200)
}

async function zoomGroupG05(page: Page, theme: ThemeId): Promise<void> {
  const hit = page.locator('[data-g="G05"] .lec-map-hit').first()
  if (theme === 'reader') await hit.dblclick({ position: { x: 80, y: 20 } })
  else await hit.dblclick()
  await settle(page, 460)
}

for (const [theme, impl] of [
  ['reader', 'default'],
  ['datasheet', 'datasheet'],
] as const) {
  test.describe(`canvas (${theme})`, () => {
    test('1. default overview renders all mapped groups (13) and excludes LR/SPI with notice in #edgeinfo', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      await expect(page.locator('#atlas [data-slot="CanvasGroup"]')).toHaveCount(13)
      await expect(page.locator('#atlas [data-g="LR"]')).toHaveCount(0)
      await expect(page.locator('#atlas [data-g="SPI"]')).toHaveCount(0)
      expect(await page.locator('#atlas .cv-node').count()).toBeGreaterThan(250)
      await expect(page.locator('#edgeinfo')).toContainText('LR')
      await expect(page.locator('#edgeinfo')).toContainText('SPI')
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('2. dblclick group G03 zooms all nodes inside stage without trace panel or text selection', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      const hit = page.locator('[data-g="G03"] .lec-map-hit').first()
      if (theme === 'reader') await hit.dblclick({ position: { x: 80, y: 20 } })
      else await hit.dblclick()
      await settle(page, 460)

      await expect(page.locator('#focusbar')).toHaveCount(0)
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
      expect(await page.locator('body').innerText()).not.toContain('进入这一组')

      const out = await page.evaluate(() => {
        const sr = document.querySelector('.cv-stage')!.getBoundingClientRect()
        const nodes = [...document.querySelectorAll('.cv-node[data-id^="g03-"]')]
        if (nodes.length === 0) return -1
        let outside = 0
        for (const n of nodes) {
          const r = n.getBoundingClientRect()
          if (r.right < sr.left || r.left > sr.right || r.bottom < sr.top || r.top > sr.bottom) outside++
        }
        return outside
      })
      expect(out, 'no G03 lecture missing outside stage').toBe(0)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('3. single click group G03 navigates to /g03/', async ({ page, consoleErrors, pageErrors }) => {
      await openCanvas(page, theme, impl)
      const hit = page.locator('[data-g="G03"] .lec-map-hit').first()
      await Promise.all([
        page.waitForURL(/\/g03\/$/),
        theme === 'reader' ? hit.click({ position: { x: 80, y: 20 } }) : hit.click(),
      ])
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('4. single click lecture g05-l19 opens /g05/L19 after click window without entering lock', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      await zoomGroupG05(page, theme)
      const nodeHit = page.locator('.cv-node[data-id="g05-l19"] .lec-map-hit').first()
      await Promise.all([page.waitForURL(/\/g05\/L19(?:\.html)?$/), nodeHit.click()])
      await expect(page.locator('#focusbar')).toHaveCount(0)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('5. dblclick lecture g05-l19 enters trace mode and keeps endpoints right of 380px trace panel', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      await zoomGroupG05(page, theme)

      const nodeHit = page.locator('.cv-node[data-id="g05-l19"] .lec-map-hit').first()
      await nodeHit.dblclick()
      await settle(page, 500)

      await expect(page.locator('#focusbar')).toBeVisible()
      await expect(page.locator('#focusbar [data-open="g05-l19"]')).toBeVisible()
      await expect(page.locator('.cv-layer')).toHaveClass(/cv-dim/)
      await expect(page.locator('.cv-node[data-id="g05-l19"]')).toHaveClass(/\blocked\b/)

      const bounds = await page.evaluate(() => {
        const sr = document.querySelector('.cv-stage')!.getBoundingClientRect()
        const pr = document.querySelector('#focusbar')!.getBoundingClientRect()
        const actives = [...document.querySelectorAll('.cv-node.on')]
        let minLeft = Infinity
        let maxRight = -Infinity
        for (const el of actives) {
          const r = el.getBoundingClientRect()
          if (r.width === 0) continue
          minLeft = Math.min(minLeft, r.left)
          maxRight = Math.max(maxRight, r.right)
        }
        return { srLeft: sr.left, srRight: sr.right, prRight: pr.right, minLeft, maxRight, count: actives.length }
      })
      expect(bounds.count).toBeGreaterThanOrEqual(2)
      expect(bounds.prRight).toBeLessThanOrEqual(bounds.srLeft + 396)
      expect(bounds.minLeft).toBeGreaterThanOrEqual(bounds.srLeft + 380)
      expect(bounds.maxRight).toBeLessThanOrEqual(bounds.srRight + 4)

      // 6. wheel inside #focusbar scrolls panel without moving viewport transform or #zoomlabel
      const before = await page.evaluate(() => ({
        tf: (document.querySelector('.lec-map-svg') as HTMLElement).style.transform,
        zl: document.querySelector('#zoomlabel')?.textContent ?? '',
      }))
      const panelBox = await page.locator('#focusbar').boundingBox()
      expect(panelBox).not.toBeNull()
      await page.mouse.move(panelBox!.x + panelBox!.width / 2, panelBox!.y + panelBox!.height / 2)
      await page.mouse.wheel(0, 260)
      await settle(page, 220)
      const after = await page.evaluate(() => ({
        tf: (document.querySelector('.lec-map-svg') as HTMLElement).style.transform,
        zl: document.querySelector('#zoomlabel')?.textContent ?? '',
      }))
      expect(after.tf).toBe(before.tf)
      expect(after.zl).toBe(before.zl)

      // 7. clicking a trace link moves trace lock along the chain; Escape exits trace mode cleanly
      const traceCountBefore = await page.locator('.lk').count()
      expect(traceCountBefore).toBeGreaterThan(0)
      await page.locator('.lk .hitline').first().dispatchEvent('click', { bubbles: true })
      await settle(page, 460)
      const newMainId = await page.locator('#focusbar .it.main').getAttribute('data-open')
      expect(newMainId).toBeTruthy()
      expect(newMainId).not.toBe('g05-l19')

      await page.keyboard.press('Escape')
      await settle(page, 180)
      await expect(page.locator('#focusbar')).toHaveCount(0)
      await expect(page.locator('.cv-layer')).not.toHaveClass(/cv-dim/)

      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('8. search highlights matches and Enter enters trace mode on first hit', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      const search = page.locator('.cv-search')
      await search.fill('GPIO')
      await settle(page, 120)
      await expect(page.locator('.cv-layer')).toHaveClass(/cv-searching/)
      const matchCount = await page.locator('.cv-node.match').count()
      expect(matchCount).toBeGreaterThanOrEqual(1)

      await search.press('Enter')
      await settle(page, 480)
      await expect(page.locator('#focusbar')).toBeVisible()
      await expect(page.locator('.cv-node.locked')).toHaveCount(1)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('9. drag pans smoothly, keeps SVG text hidden and sharp canvas sizing consistent', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      const hiddenTextCheck = await page.evaluate(() => {
        const texts = [...document.querySelectorAll('.lec-map-svg text')]
        return texts.length > 0 && texts.every((t) => getComputedStyle(t).display === 'none')
      })
      expect(hiddenTextCheck).toBe(true)

      const stage = page.locator('.cv-stage')
      const box = (await stage.boundingBox())!
      const startX = box.x + box.width * 0.65
      const startY = box.y + box.height * 0.6

      // Record frame gaps during pan drag
      await page.evaluate(() => {
        const w = window as unknown as { __panGaps?: number[]; __panRun?: boolean }
        w.__panGaps = []
        w.__panRun = true
        let last = performance.now()
        function tick(now: number): void {
          w.__panGaps!.push(now - last)
          last = now
          if (w.__panRun) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(startX - i * 16, startY - i * 8)
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
      await settle(page, 180)
      const stats = await page.evaluate(() => {
        const w = window as unknown as { __panGaps?: number[]; __panRun?: boolean }
        w.__panRun = false
        const gaps = (w.__panGaps ?? []).slice(1)
        const maxGap = gaps.length ? Math.max(...gaps) : 0
        const cv = document.querySelector('.lec-map-labels') as HTMLCanvasElement
        const sr = document.querySelector('.cv-stage')!.getBoundingClientRect()
        return {
          maxGap,
          cw: cv.width,
          ch: cv.height,
          minW: Math.floor(sr.width),
          minH: Math.floor(sr.height),
          fontsLoaded: document.fonts.status,
        }
      })
      expect(stats.cw).toBeGreaterThanOrEqual(stats.minW)
      expect(stats.ch).toBeGreaterThanOrEqual(stats.minH)
      expect(stats.fontsLoaded).toBe('loaded')
      expect(stats.maxGap).toBeLessThan(80)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    if (theme === 'datasheet') {
      test('10. datasheet bundle G03|G12 click shows .ann-tag only inside .bundle-g.on; compact <-> zones switches zones', async ({
        page,
        consoleErrors,
        pageErrors,
      }) => {
        await openCanvas(page, theme, impl)
        await expect(page.locator('#dslayout')).toBeVisible()
        await expect(page.locator('#dslayout button[data-l="compact"]')).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('.zone-box')).toHaveCount(0)

        // Zero active bundles before click
        await expect(page.locator('.bundle-g.on')).toHaveCount(0)

        const targetBundle = page.locator('.bundle-g[data-pair="G03|G12"]')
        await expect(targetBundle).toHaveCount(1)
        await targetBundle.locator('.hitline').first().dispatchEvent('click', { bubbles: true })
        await settle(page, 480)

        await expect(page.locator('.bundle-g.on')).toHaveCount(1)
        await expect(targetBundle).toHaveClass(/\bon\b/)
        await expect(page.locator('#focusbar')).toBeVisible()
        const annState = await page.evaluate(() => {
          const all = [...document.querySelectorAll('.ann-tag')]
          const onAnns = all.filter((el) => el.closest('.bundle-g.on'))
          const offAnns = all.filter((el) => !el.closest('.bundle-g.on'))
          return {
            onVisible: onAnns.length > 0 && onAnns.every((el) => Number(getComputedStyle(el).opacity) >= 0.99),
            offDimmed: offAnns.length > 0 && offAnns.every((el) => Number(getComputedStyle(el).opacity) < 0.2),
          }
        })
        expect(annState.onVisible).toBe(true)
        expect(annState.offDimmed).toBe(true)

        await page.keyboard.press('Escape')
        await settle(page, 180)
        await expect(page.locator('.bundle-g.on')).toHaveCount(0)

        // Switch compact -> zones -> compact
        await page.locator('#dslayout button[data-l="zones"]').click()
        await settle(page, 240)
        await expect(page.locator('#dslayout button[data-l="zones"]')).toHaveAttribute('aria-pressed', 'true')
        expect(await page.locator('.zone-box').count()).toBeGreaterThan(0)

        await page.locator('#dslayout button[data-l="compact"]').click()
        await settle(page, 240)
        await expect(page.locator('.zone-box')).toHaveCount(0)

        expect(consoleErrors).toEqual([])
        expect(pageErrors).toEqual([])
      })
    }

    test('11. LOD zoom label tracks zoom level (group -> numbers -> titles)', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      const zl = page.locator('#zoomlabel')
      await page.locator('.cv-stage').focus()
      for (let i = 0; i < 4; i++) {
        if ((await zl.textContent()) === '组视图') break
        await page.keyboard.press('-')
        await settle(page, 180)
      }
      await expect(zl).toHaveText('组视图')

      await zoomGroupG05(page, theme)
      for (let i = 0; i < 3; i++) {
        if ((await zl.textContent()) === '讲名视图') break
        await page.keyboard.press('=')
        await settle(page, 180)
      }
      await expect(zl).toHaveText('讲名视图')
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    for (const mode of ['light', 'dark'] as const) {
      test(`12. @visual-v2 canvas ${theme}-${mode} desktop`, async ({ page, consoleErrors, pageErrors }, testInfo) => {
        test.skip(testInfo.project.name !== 'prod', 'baselines are recorded for the prod project only')
        await openCanvas(page, theme, impl, mode, { width: 1440, height: 900 })
        await expectThemeActive(page, theme, mode)
        await expect(page.locator('.cv-stage').first()).toHaveScreenshot(`v2-canvas-${theme}-${mode}-desktop.png`)
        expect(consoleErrors).toEqual([])
        expect(pageErrors).toEqual([])
      })
    }
  })
}

test('runtime skin swap reader <-> datasheet updates canvas slots and zero /_access/ requests', async ({
  page,
  consoleErrors,
  pageErrors,
}) => {
  const accessRequests: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/_access/')) accessRequests.push(req.url())
  })

  await openCanvas(page, 'reader', 'default')
  await page.evaluate(() => document.documentElement.setAttribute('data-lec-theme', 'datasheet'))
  await page.waitForFunction(
    () => document.querySelector('.cv-layer [data-slot="CanvasGroup"]')?.getAttribute('data-slot-impl') === 'datasheet',
  )
  await settle(page, 220)
  await expect(page.locator('#dslayout')).toBeVisible()

  await page.evaluate(() => document.documentElement.setAttribute('data-lec-theme', 'reader'))
  await page.waitForFunction(
    () => document.querySelector('.cv-layer [data-slot="CanvasGroup"]')?.getAttribute('data-slot-impl') === 'default',
  )
  await settle(page, 220)
  await expect(page.locator('#dslayout')).toHaveCount(0)
  expect(accessRequests).toEqual([])
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

test('mode switcher toggles between atlas and graph cleanly', async ({ page, consoleErrors, pageErrors }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockProgress(page)
  await useTheme(page, 'reader', 'light')
  await page.goto('/')
  await page.waitForSelector('html[data-hydrated="1"]')

  await expect(page.locator('[data-map-mode="atlas"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.am-layer')).toBeVisible()

  await page.locator('[data-map-mode="graph"]').click()
  await page.waitForSelector('.cv-stage[data-canvas-ready="true"]', { state: 'attached' })
  await expect(page.locator('[data-map-mode="graph"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.am-layer')).toHaveCount(0)

  // Reload persists dependency canvas choice
  await page.reload()
  await page.waitForSelector('html[data-hydrated="1"]')
  await page.waitForSelector('.cv-stage[data-canvas-ready="true"]', { state: 'attached' })
  await expect(page.locator('[data-map-mode="graph"]')).toHaveAttribute('aria-pressed', 'true')

  await page.locator('[data-map-mode="atlas"]').click()
  await expect(page.locator('[data-map-mode="atlas"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.am-layer')).toBeVisible()

  // Reload persists overview atlas choice
  await page.reload()
  await page.waitForSelector('html[data-hydrated="1"]')
  await expect(page.locator('[data-map-mode="atlas"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.am-layer')).toBeVisible()

  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

test('datasheet compact <-> zones layout choice persists across reload', async ({ page, consoleErrors, pageErrors }) => {
  await openCanvas(page, 'datasheet', 'datasheet')
  await page.locator('#dslayout button[data-l="zones"]').click()
  await expect(page.locator('#dslayout button[data-l="zones"]')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.locator('.zone-box').count()).toBeGreaterThan(0)

  await page.reload()
  await page.waitForSelector('html[data-hydrated="1"]')
  await page.waitForSelector('.cv-stage[data-canvas-ready="true"]', { state: 'attached' })
  await expect(page.locator('#dslayout button[data-l="zones"]')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.locator('.zone-box').count()).toBeGreaterThan(0)

  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

for (const [theme, impl] of [
  ['reader', 'default'],
  ['datasheet', 'datasheet'],
] as const) {
  test(`canvas keyboard navigation (${theme}): Tab reaches node with role/aria-label/focus ring, Arrows move, Enter opens`, async ({
    page,
    consoleErrors,
    pageErrors,
  }) => {
    await openCanvas(page, theme, impl)
    const nodes = page.locator('.cv-node')
    await expect.poll(() => nodes.count()).toBeGreaterThan(250)

    const activeFirst = page.locator('.cv-node[tabindex="0"]')
    await expect(activeFirst).toHaveCount(1)
    await expect(activeFirst).toHaveAttribute('role', 'button')
    const aria = await activeFirst.getAttribute('aria-label')
    expect(aria && aria.length > 5).toBe(true)

    // Focus the canvas stage, then Tab into the active node
    await page.locator('.cv-stage').focus()
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      const onNode = await page.evaluate(() => Boolean(document.activeElement?.classList.contains('cv-node')))
      if (onNode) break
    }
    const startId = await page.evaluate(() => {
      const el = document.activeElement
      return el?.classList.contains('cv-node') ? el.getAttribute('data-id') : null
    })
    expect(startId).toBeTruthy()

    const focusStyle = await page.evaluate(() => {
      const el = document.activeElement as Element
      const cs = getComputedStyle(el)
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) }
    })
    expect(focusStyle.style).not.toBe('none')
    expect(focusStyle.width).toBeGreaterThan(0)

    // Move right / down with arrow keys to reach another lecture node without panning off focus
    let movedId: string | null = null
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      await page.keyboard.press(key)
      const id = await page.evaluate(() => {
        const el = document.activeElement
        return el?.classList.contains('cv-node') ? el.getAttribute('data-id') : null
      })
      if (id && id !== startId) {
        movedId = id
        break
      }
    }
    expect(movedId, 'arrow key moves focus to another node').toBeTruthy()
    expect(movedId).not.toBe(startId)

    // Enter opens the currently focused lecture (same as single click)
    const expectedSlug = movedId!.replace('-l', '/L')
    await Promise.all([
      page.waitForURL(new RegExp(`${expectedSlug}(?:\\.html)?$`, 'i')),
      page.keyboard.press('Enter'),
    ])

    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })
}
