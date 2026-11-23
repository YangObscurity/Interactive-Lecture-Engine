/**
 * P4a WP-H3: the group page (group map, lecture map with the relation panel), for both skins.
 *
 * Port of the checks of the prototype (the group-page prototype, v3) to the real page: no overflow with a lecture tracked
 * (17 groups x 2 skins x 1280 / 375 px), every pin / cell / chip a focusable link with the Tab order of the lecture numbers,
 * the roles of a tracked lecture (G05 L19: 6 / 8 / 3 / 3 and 9 lines), the cross-group jump (G05 L5 -> G06 L3), completion
 * (marking L19 read makes L20 ready and pulses it), the 说明 preference, the panel staying in the window on the longest group
 * (G03), single click opens / double click tracks, batch marking, Esc and a blank click, plus two screenshot baselines.
 * The real backend is never reached: `/api/**` goes to the fixtures and the progress read to a local mock (G05 1-18 read, 19 reading).
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { useTheme, type Mode, type ThemeId } from './theme-helpers'

const GROUPS = ['g01', 'g02', 'g03', 'g04', 'g05', 'g06', 'g07', 'g08', 'g09', 'g10', 'g11', 'g12', 'g13', 'lr', 'spi', 'sdm', 'gc'] as const
const SKINS: ReadonlyArray<readonly [ThemeId, string]> = [
  ['reader', 'default'],
  ['datasheet', 'datasheet'],
]
const WIRE = { not_started: '未开始', in_progress: '学习中', completed: '已完成' } as const

const lid = (g: string, n: number): string => `${g}-l${String(n).padStart(2, '0')}`

async function mockProgress(page: Page, seeded: boolean): Promise<void> {
  const records = seeded
    ? Array.from({ length: 31 }, (_, i) => {
        const n = i + 1
        const status = n <= 18 ? 'completed' : n === 19 ? 'in_progress' : 'not_started'
        return { lecture_id: lid('g05', n), group_id: 'g05', status: WIRE[status], completed_at: status === 'completed' ? '2026-11-01T00:00:00.000Z' : null, updated_at: '2026-11-01T00:00:00.000Z', notion_node_id: null, notion_page_id: null }
      })
    : []
  await page.context().route(/\/api\/db\/progress(\/|\?|$)/, (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(records) })
  })
}

/** Open a group page in a skin; wait for that skin's group map and (when seeded) the progress. */
async function openGroup(page: Page, path: string, theme: ThemeId, impl: string, opts: { mode?: Mode; width?: number; height?: number; seeded?: boolean } = {}): Promise<void> {
  await page.setViewportSize({ width: opts.width ?? 1280, height: opts.height ?? 900 })
  await mockProgress(page, opts.seeded ?? false)
  await useTheme(page, theme, opts.mode ?? 'light')
  await page.goto(path)
  await page.waitForSelector('html[data-hydrated="1"]')
  await expect(page.locator(`[data-gp-map] [data-slot="GroupMap"]`)).toHaveAttribute('data-slot-impl', impl)
  await page.waitForSelector('.gp-lanes .gp-lc')
  if (opts.seeded) await expect(page.locator('[data-gp-spec="read"]')).toContainText('18 / ')
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

const chip = (page: Page, id: string) => page.locator(`.gp-lanes [data-lecture="${id}"]`)
const settle = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

for (const [theme, impl] of SKINS) {
  test.describe(`group page: ${theme}`, () => {
    // 1. no horizontal overflow, every group, desktop and phone, with one lecture tracked
    for (const [size, width] of [['desktop', 1280], ['phone', 375]] as const) {
      test(`1. no horizontal overflow in any group at ${width} px (${size}), one lecture tracked`, async ({ page }) => {
        test.setTimeout(240_000)
        for (const g of GROUPS) {
          await openGroup(page, `/${g}/`, theme, impl, { width })
          await page.locator('.gp-lanes [data-lecture]').first().dblclick()
          await expect(page.locator('.gp-lanes.is-tracking')).toHaveCount(1)
          await settle(page)
          const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
          expect(o.sw, `${g} at ${width}px: scrollWidth ${o.sw} > clientWidth ${o.cw}`).toBeLessThanOrEqual(o.cw)
          const gp = await page.evaluate(() => {
            const el = document.querySelector('.gp') as HTMLElement
            return el.scrollWidth - el.clientWidth
          })
          expect(gp, `${g}: .gp overflows by ${gp}px`).toBeLessThanOrEqual(0)
        }
      })
    }

    // 2. every pin / cell / chip is a focusable link, Tab order = lecture order
    for (const g of ['g05', 'g01'] as const) {
      test(`2. ${g}: every cell / pin and chip is a focusable link, and Tab goes through the group map in lecture order`, async ({ page }) => {
        await openGroup(page, `/${g}/`, theme, impl)
        const ids = await page.locator('.gp-lanes a[data-lecture]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.lecture as string).sort())
        const mapIds = await page.locator('[data-gp-map] a[data-lecture]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.lecture as string))
        expect(mapIds).toEqual([...mapIds].sort())
        expect(mapIds.length).toBe(ids.length)
        expect([...mapIds].sort()).toEqual(ids)
        // links, not display:contents boxes: they have a box and take focus
        for (const sel of ['[data-gp-map] a[data-lecture]', '.gp-lanes a[data-lecture]']) {
          const bad = await page.locator(sel).evaluateAll((els) =>
            els.filter((e) => {
              const a = e as HTMLAnchorElement
              const r = a.getBoundingClientRect()
              a.focus()
              return !a.getAttribute('href') || r.width === 0 || r.height === 0 || getComputedStyle(a).display === 'contents' || document.activeElement !== a
            }).length,
          )
          expect(bad, `${sel}`).toBe(0)
        }
        // Tab order of the group map
        await page.locator('[data-gp-map] a[data-lecture]').first().focus()
        const seen: string[] = [await page.evaluate(() => (document.activeElement as HTMLElement).dataset.lecture as string)]
        for (let i = 1; i < mapIds.length; i++) {
          await page.keyboard.press('Tab')
          seen.push(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.lecture ?? ''))
        }
        expect(seen).toEqual(mapIds)
      })
    }

    // 3. roles of G05 lecture 19
    test('3. G05 lecture 19 tracked: roles pre 6, indirect pre 8, post 3, indirect post 3, 9 lines', async ({ page }) => {
      await openGroup(page, '/g05/', theme, impl)
      await chip(page, 'g05-l19').dblclick()
      const n = (role: string) => page.locator(`.gp-lanes [data-role="${role}"]`).count()
      await expect.poll(() => n('self')).toBe(1)
      expect([await n('pre'), await n('pre2'), await n('post'), await n('post2')]).toEqual([6, 8, 3, 3])
      await expect(page.locator('.gp-edges path.e-pre')).toHaveCount(6)
      await expect(page.locator('.gp-edges path.e-post')).toHaveCount(3)
      // the line style follows the theme: curves for reader, right angles for datasheet
      const d = await page.locator('.gp-edges path.e-pre').first().getAttribute('d')
      expect(d?.includes('C'), `reader draws curves, datasheet right angles: ${d}`).toBe(theme === 'reader')
      await expect(page.locator('[data-gp-panel] .gp-p-tag')).toHaveText('正在追踪')
    })

    // 4. cross-group jump
    test('4. cross-group tracking from G05 lecture 5 lands on the G06 page with lecture 3 locked', async ({ page }) => {
      await openGroup(page, '/g05/', theme, impl)
      await chip(page, 'g05-l05').dblclick()
      const item = page.locator('[data-gp-list="xpost"] li', { has: page.locator('a[href$="/g06/L03"]') })
      await expect(item).toHaveCount(1)
      await item.locator('button.trk').click()
      await expect(page).toHaveURL(/\/g06\/#track-g06-l03$/)
      await expect(chip(page, 'g06-l03')).toHaveAttribute('data-role', 'self')
      await expect(page.locator('.gp-lanes.is-tracking')).toHaveCount(1)
    })

    test('4b. #track-<id> locks that lecture on arrival; Esc and a click on the blank map leave tracking', async ({ page }) => {
      await openGroup(page, '/g06/#track-g06-l03', theme, impl)
      await expect(chip(page, 'g06-l03')).toHaveAttribute('data-role', 'self')
      await page.keyboard.press('Escape')
      await expect(page.locator('.gp-lanes.is-tracking')).toHaveCount(0)
      await chip(page, 'g06-l01').dblclick()
      await expect(page.locator('.gp-lanes.is-tracking')).toHaveCount(1)
      await page.locator('.gp-lane').first().locator('.gp-lane-h').click()
      await expect(page.locator('.gp-lanes.is-tracking')).toHaveCount(0)
    })

    // 5. completion
    test('5. marking lecture 19 read makes lecture 20 ready, pulses it and names it in the live region', async ({ page }) => {
      await openGroup(page, '/g05/', theme, impl, { seeded: true })
      await expect(chip(page, 'g05-l20')).not.toHaveAttribute('data-ready', '')
      await chip(page, 'g05-l19').dblclick()
      await page.locator('[data-gp-act="mark"]').click()
      await expect(chip(page, 'g05-l19')).toHaveAttribute('data-status', 'read')
      await expect(chip(page, 'g05-l20')).toHaveAttribute('data-ready', '')
      await expect(chip(page, 'g05-l20')).toHaveClass(/is-pulse/)
      await expect(page.locator('[data-gp-live]')).toContainText('第20讲')
      await expect(page.locator('[data-gp-live]')).toHaveAttribute('aria-live', 'polite')
      // the group map follows the same statuses
      await expect(page.locator('[data-gp-map] [data-lecture="g05-l20"]')).toHaveAttribute('data-ready', '')
      await expect(page.locator('[data-gp-spec="read"]')).toContainText('19 / ')
      // ... and marking it unread again takes the readiness back
      await page.locator('[data-gp-act="mark"]').click()
      await expect(chip(page, 'g05-l20')).not.toHaveAttribute('data-ready', '')
    })

    // 6. the 说明 preference
    test('6. the 说明 default (open / closed) is kept across reloads', async ({ page }) => {
      await openGroup(page, '/g05/', theme, impl)
      await chip(page, 'g05-l19').dblclick()
      const details = page.locator('.gp-p-desc details')
      await expect(details).toHaveJSProperty('open', true)
      await page.locator('[data-gp-pref="desc"]').uncheck()
      await expect(details).toHaveJSProperty('open', false)
      expect(await page.evaluate(() => localStorage.getItem('lecture:group-desc'))).toBe('0')
      await page.reload()
      await page.waitForSelector('html[data-hydrated="1"]')
      await page.waitForSelector('.gp-lanes .gp-lc')
      await chip(page, 'g05-l19').dblclick()
      await expect(page.locator('.gp-p-desc details')).toHaveJSProperty('open', false)
      await page.locator('[data-gp-pref="desc"]').check()
      await expect(page.locator('.gp-p-desc details')).toHaveJSProperty('open', true)
      expect(await page.evaluate(() => localStorage.getItem('lecture:group-desc'))).toBe('1')
    })

    // 7. the panel stays in the window on the longest group
    test('7. the panel stays in the window while G03 scrolls', async ({ page }) => {
      await openGroup(page, '/g03/', theme, impl)
      await chip(page, 'g03-l01').dblclick()
      const lanes = page.locator('.gp-lanes')
      const h = await lanes.evaluate((e) => e.getBoundingClientRect().height)
      expect(h).toBeGreaterThan(1100)
      // the panel is sticky inside the map's box, so it stays in the window for as long as that box fills it: three offsets inside that range
      for (const frac of [0.1, 0.5, 0.9]) {
        await page.evaluate(([f]) => {
          const wrap = (document.querySelector('.gp-map-wrap') as HTMLElement).getBoundingClientRect()
          const panel = (document.querySelector('[data-gp-panel]') as HTMLElement).getBoundingClientRect()
          const range = Math.max(0, wrap.height - panel.height - 120)
          window.scrollTo(0, window.scrollY + wrap.top - 60 + range * (f as number))
        }, [frac])
        await settle(page)
        const box = await page.locator('[data-gp-panel]').boundingBox()
        const vh = page.viewportSize()?.height ?? 900
        expect(box, 'panel box').not.toBeNull()
        expect((box?.y ?? -1) >= 0 && (box?.y ?? 9999) + (box?.height ?? 0) <= vh, `panel ${box?.y}..${(box?.y ?? 0) + (box?.height ?? 0)} of ${vh} at ${frac}`).toBe(true)
      }
    })

    // 8. click rules
    test('8. a single click opens the lecture, a double click tracks and does not', async ({ page }) => {
      await openGroup(page, '/g05/', theme, impl)
      await chip(page, 'g05-l19').dblclick()
      await expect(chip(page, 'g05-l19')).toHaveAttribute('data-role', 'self')
      await expect(page).toHaveURL(/\/g05\/$/)
      await page.keyboard.press('Escape')
      await chip(page, 'g05-l03').click()
      await expect(page).toHaveURL(/\/g05\/L03$/)
    })

    test('8b. Space on a chip tracks; a double click in the group map tracks that lecture in the lecture map', async ({ page }) => {
      await openGroup(page, '/g05/', theme, impl)
      await chip(page, 'g05-l07').focus()
      await page.keyboard.press('Space')
      await expect(chip(page, 'g05-l07')).toHaveAttribute('data-role', 'self')
      await page.keyboard.press('Escape')
      await page.locator('[data-gp-map] [data-lecture="g05-l12"]').dblclick()
      await expect(chip(page, 'g05-l12')).toHaveAttribute('data-role', 'self')
      await expect(page).toHaveURL(/\/g05\/$/)
    })

    // 9. batch marking
    test('9. batch marking: click selects, one batch write, Esc leaves the mode', async ({ page }) => {
      await openGroup(page, '/g05/', theme, impl)
      await page.locator('[data-gp-batch-toggle]').click()
      for (const n of [1, 2, 3]) await chip(page, lid('g05', n)).click()
      await expect(page.locator('.gp-lanes [data-sel]')).toHaveCount(3)
      await expect(page).toHaveURL(/\/g05\/$/)
      await page.locator('[data-gp-batch="read"]').click()
      for (const n of [1, 2, 3]) await expect(chip(page, lid('g05', n))).toHaveAttribute('data-status', 'read')
      await expect(page.locator('[data-gp-batchbar]')).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-gp-batchbar]')).toHaveCount(0)
    })
  })
}

test.describe('group page: content', () => {
  test('the group map and the lecture map list the same lectures; a group without relation data lists them in order', async ({ page }) => {
    await openGroup(page, '/lr/', 'reader', 'default')
    await expect(page.locator('.gp-lane')).toHaveCount(1)
    await expect(page.locator('.gp-lane-h')).toContainText('全部讲次')
    await expect(page.locator('[data-gp-panel]')).toContainText('没有先修数据')
    await chip(page, 'lr-l01').hover()
    await expect(page.locator('[data-gp-panel] .gp-p-tag')).toHaveText('预览')
    await expect(page.locator('[data-gp-list]')).toHaveCount(0)
  })

  test('title block: the spec rows 先修自 / 后续 link to the group pages, 可开始 n 讲 sits in the 已读 cell', async ({ page }) => {
    await openGroup(page, '/g05/', 'reader', 'default', { seeded: true })
    await expect(page.locator('[data-gp-spec="read"]')).toContainText(/可开始 \d+ 讲/)
    const pre = page.locator('[data-gp-spec="pre"] a.gref')
    expect(await pre.count()).toBeGreaterThan(0)
    for (const h of await pre.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) expect(h).toMatch(/^\/[a-z0-9]+\/$/)
    await expect(page.locator('[data-gp-spec="post"] a.gref').first()).toBeVisible()
    await expect(page.locator('[data-gp-cta="continue"]')).toContainText('第19讲')
  })

  test('English page: the Notion texts keep their language (lang="zh-CN")', async ({ page }) => {
    await openGroup(page, '/en/g05/', 'reader', 'default')
    await chip(page, 'g05-l19').dblclick()
    await expect(page.locator('[data-gp-desc]')).toHaveAttribute('lang', 'zh-CN')
    await expect(page.locator('.gp-lane-h span[lang="zh-CN"]').first()).toBeVisible()
  })

  test('no console errors or hydration warnings on a group page', async ({ page, consoleErrors, pageErrors }) => {
    const warnings: string[] = []
    page.on('console', (m) => {
      if (/hydrat/i.test(m.text())) warnings.push(m.text())
    })
    await openGroup(page, '/g05/', 'datasheet', 'datasheet', { seeded: true })
    await chip(page, 'g05-l19').dblclick()
    expect(warnings).toEqual([])
    expect(consoleErrors.filter((t) => /hydrat/i.test(t))).toEqual([])
    expect(pageErrors).toEqual([])
  })
})

// 10. screenshot baselines (light, desktop): the group page in both skins
for (const [theme, impl] of SKINS) {
  test(`10. screenshot baseline: the group page G05 (${theme}, light, desktop) @visual`, async ({ page }) => {
    await openGroup(page, '/g05/', theme, impl, { width: 1440, height: 900, seeded: true })
    await chip(page, 'g05-l19').dblclick()
    await page.mouse.move(2, 2)
    // a full-page capture of a scrolled page would show the sticky bar in the middle of it
    await page.evaluate(() => window.scrollTo(0, 0))
    await settle(page)
    await expect(page).toHaveScreenshot(`group-page-${theme}-light-desktop.png`, { fullPage: true, mask: [page.locator('.VPLastUpdated')] })
  })
}
