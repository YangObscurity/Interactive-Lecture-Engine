/**
 * P4a WP-H3: the group page (group map, lecture map with the relation panel), for both skins.
 *
 * Port of the checks of the prototype (the group-page prototype, v3) to the real page: no overflow with a lecture tracked
 * (every group x 2 skins x 1280 / 375 px), every pin / cell / chip a focusable link with the Tab order of the lecture numbers,
 * the roles of a tracked lecture (MEA L03: 1 / 1 / 2 / 1), the cross-group jump (MEA L4 -> PLN L3), completion
 * (marking L04 read makes L05 ready and pulses it), the 说明 preference, the panel staying in the window,
 * single click opens / double click tracks, batch marking, Esc and a blank click, plus two screenshot baselines.
 * S6: runs on the engine's demo content (templates/demo-content). The real backend is never reached: `/api/**` goes to the
 * fixtures and the progress read to a local mock (seeded: MEA 1-3 read and 4 reading, DAT 1 reading).
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { useTheme, type Mode, type ThemeId } from './theme-helpers'
import { DEMO_GROUP_DIRS, demoGroup, lectureId } from './demo'

/** every group folder of the demo content, in groups.ts order */
const GROUPS = DEMO_GROUP_DIRS
const SKINS: ReadonlyArray<readonly [ThemeId, string]> = [
  ['reader', 'default'],
  ['datasheet', 'datasheet'],
]
const WIRE = { not_started: '未开始', in_progress: '学习中', completed: '已完成' } as const

const lid = (g: string, n: number): string => `${g}-l${String(n).padStart(2, '0')}`
/** The lecture id of a panel link (`/mea/L02` -> `mea-l02`), '' for anything else. */
const idOfHref = (h: string | null): string => {
  const m = /\/([a-z]+)\/L(\d+)$/.exec(h ?? '')
  return m ? lid(m[1] as string, Number(m[2])) : ''
}

/** The seeded progress: MEA 1-3 read and 4 reading, DAT 1 read and nothing reading (every lecture of the two groups has a record). */
const SEED: ReadonlyArray<readonly [string, number, number, boolean]> = [
  ['mea', demoGroup('mea').lectures.length, 3, true],
  ['dat', demoGroup('dat').lectures.length, 1, false],
]
/** The 已读 cell of a seeded group page: `3 / ` for MEA. */
const seededRead = (path: string): string | null => {
  const g = /^\/(?:en\/)?([a-z]+)\//.exec(path)?.[1]
  const s = SEED.find(([id]) => id === g)
  return s ? `${s[2]} / ` : null
}

async function mockProgress(page: Page, seeded: boolean): Promise<void> {
  const records = seeded
    ? SEED.flatMap(([g, total, read, reading]) =>
        Array.from({ length: total }, (_, i) => {
          const n = i + 1
          const status = n <= read ? 'completed' : n === read + 1 && reading ? 'in_progress' : 'not_started'
          return { lecture_id: lid(g, n), group_id: g, status: WIRE[status], completed_at: status === 'completed' ? '2026-11-01T00:00:00.000Z' : null, updated_at: '2026-11-01T00:00:00.000Z', notion_node_id: null, notion_page_id: null }
        }),
      )
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
  if (opts.seeded) {
    const read = seededRead(path)
    if (read) await expect(page.locator('[data-gp-spec="read"]')).toContainText(read)
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

const chip = (page: Page, id: string) => page.locator(`.gp-lanes [data-lecture="${id}"]`)
const settle = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

for (const [theme, impl] of SKINS) {
  test.describe(`group page: ${theme}`, () => {
    // 1. no horizontal overflow, every group, desktop and phone, with one lecture tracked
    for (const [size, width] of [['desktop', 1280], ['phone', 375]] as const) {
      test(`1. no horizontal overflow in any group at ${width} px (${size}), one lecture tracked`, async ({ page }) => {
        test.setTimeout(60_000 * GROUPS.length)
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
    for (const g of ['mea', 'log'] as const) {
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

    // 3. roles of MEA lecture 3
    test('3. MEA lecture 3 tracked: roles pre 1, indirect pre 1, post 2, indirect post 1, 3 lines', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl)
      await chip(page, 'mea-l03').dblclick()
      const n = (role: string) => page.locator(`.gp-lanes [data-role="${role}"]`).count()
      await expect.poll(() => n('self')).toBe(1)
      expect([await n('pre'), await n('pre2'), await n('post'), await n('post2')]).toEqual([1, 1, 2, 1])
      await expect(page.locator('.gp-edges path.e-pre')).toHaveCount(1)
      await expect(page.locator('.gp-edges path.e-post')).toHaveCount(2)
      // the line style follows the theme: curves for reader, right angles for datasheet
      const d = await page.locator('.gp-edges path.e-pre').first().getAttribute('d')
      expect(d?.includes('C'), `reader draws curves, datasheet right angles: ${d}`).toBe(theme === 'reader')
      await expect(page.locator('[data-gp-panel] .gp-p-tag')).toHaveText('正在追踪')
    })

    // 3b. S6Y: the relation panel's line boxes are the prototype's (the group-page prototype: body `14px/1.6` l.35,
    // `.panel` 13px l.189, `.p-s li` padding 3px l.208, `.trk` font shorthand l.215, `summary` 12.5px + 2px padding l.218;
    // measured with getComputedStyle at 1280 and 390 px): the page body is `.vp-doc`, whose prose rules set 2.2 on li/summary
    for (const width of [1280, 390] as const) {
      test(`3b. ${width}px: relation panel rows and the "earlier" summary have the prototype's sizes; its 追踪 moves the tracking`, async ({ page }) => {
        await openGroup(page, '/mea/', theme, impl, { width, height: width === 390 ? 844 : 900 })
        await chip(page, 'mea-l03').dblclick()
        await expect(page.locator('.gp-lanes [data-role="self"][data-lecture="mea-l03"]')).toHaveCount(1)
        const m = await page.evaluate(() => {
          const p = document.querySelector('[data-gp-panel]')!
          const li = p.querySelector('[data-gp-list="pre"] li')!
          const sum = p.querySelector('details summary')!
          return {
            liLh: parseFloat(getComputedStyle(li).lineHeight),
            liH: li.getBoundingClientRect().height,
            trkH: li.querySelector('.trk')!.getBoundingClientRect().height,
            sumH: sum.getBoundingClientRect().height,
            sumLh: parseFloat(getComputedStyle(sum).lineHeight),
          }
        })
        // prototype: reader li 25.5 / .trk 19, datasheet li 26 / .trk 20 (its heading font); li line 13 x 1.6; summary 12.5 x 1.6 + 4
        const proto = theme === 'reader' ? { liH: 25.5, trkH: 19 } : { liH: 26, trkH: 20 }
        const near = (a: number, e: number, what: string): void => expect(Math.abs(a - e), `${what}: ${a} vs prototype ${e}`).toBeLessThanOrEqual(1)
        near(m.liLh, 20.8, 'row line-height')
        near(m.liH, proto.liH, 'row height')
        near(m.trkH, proto.trkH, '追踪 button height')
        near(m.sumLh, 20, 'summary line-height')
        near(m.sumH, 24, 'summary height')
        // the panel's own 追踪 (a real click) moves the tracking to that prerequisite
        await page.locator('[data-gp-panel] [data-gp-list="pre"] li .trk').first().click()
        await expect(page.locator('.gp-lanes [data-role="self"][data-lecture="mea-l02"]')).toHaveCount(1)
        await expect(page.locator('.gp-lanes.is-tracking')).toHaveCount(1)
      })
    }

    // 3c. S6Y (audit-group #1 #4 #5 #7 #8): the rest of the `.vp-doc` leaks, measured against the group-page prototype
    test('3c. the folds, the node id, the pin names, the hint and the section heads have the prototype sizes', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl)
      const near = (a: number, e: number, what: string): void => expect(Math.abs(a - e), `${what}: ${a} vs prototype ${e}`).toBeLessThanOrEqual(1)
      // prototype `.panel .hint`: one block, padding 16px, lines split by <br> (no gap): the paragraphs + 32px
      const hint = await page.locator('[data-gp-panel] .gp-hint').evaluate((el) => ({
        h: el.getBoundingClientRect().height,
        ps: [...el.querySelectorAll('p')].reduce((s, p) => s + p.getBoundingClientRect().height, 0),
      }))
      near(hint.h, hint.ps + 32, 'hint height = its lines + padding')
      // prototype `.sec-head h2`: 21px, the body's 1.6 = 33.6px
      const h2 = await page.locator('.gp-sec-head h2').first().evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
      near(h2, 33.6, 'section head h2 line-height')
      // prototype datasheet `.pin .pname`: regular weight (the link must not take `.vp-doc a` 500)
      if (theme === 'datasheet') {
        const w = await page.locator('[data-gp-map] .pin a .pname').evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).fontWeight))])
        expect(w, 'pin name font-weight').toEqual(['400'])
      }
      await chip(page, 'mea-l03').dblclick()
      await expect(chip(page, 'mea-l03')).toHaveAttribute('data-role', 'self')
      // prototype `.p-s details summary` (说明 / 更早的先修 / 更远的后续): margin 0, 12.5px x 1.6, padding 2px 0 = 24px
      const sums = await page.locator('[data-gp-panel] details > summary').evaluateAll((els) =>
        els.map((e) => {
          const cs = getComputedStyle(e)
          return { h: e.getBoundingClientRect().height, mt: cs.marginTop, mb: cs.marginBottom, lh: parseFloat(cs.lineHeight) }
        }),
      )
      expect(sums.length, 'MEA lecture 3 has 说明, 更早的先修 and 更远的后续').toBe(3)
      for (const [i, s] of sums.entries()) {
        expect([s.mt, s.mb], `summary ${i} margins`).toEqual(['0px', '0px'])
        near(s.lh, 20, `summary ${i} line-height`)
        near(s.h, 24, `summary ${i} height`)
      }
      // prototype `.p-m code`: 11.5px in the text colour, no frame, no background
      const code = await page.locator('[data-gp-panel] .gp-p-m code').evaluate((el) => {
        const cs = getComputedStyle(el)
        return { fs: cs.fontSize, bw: cs.borderTopWidth, bg: cs.backgroundColor, pl: cs.paddingLeft, color: cs.color, text: getComputedStyle(el.closest('.gp-panel') as Element).color }
      })
      expect(code.fs, 'node id font-size').toBe('11.5px')
      expect([code.bw, code.bg, code.pl], 'node id: no frame, no background, no padding').toEqual(['0px', 'rgba(0, 0, 0, 0)', '0px'])
      expect(code.color, 'node id in the text colour').toBe(code.text)
    })

    // 4. cross-group jump
    test('4. cross-group tracking from MEA lecture 4 lands on the PLN page with lecture 3 locked', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl)
      await chip(page, 'mea-l04').dblclick()
      const item = page.locator('[data-gp-list="xpost"] li', { has: page.locator('a[href$="/pln/L03"]') })
      await expect(item).toHaveCount(1)
      await item.locator('button.trk').click()
      await expect(page).toHaveURL(/\/pln\/#track-pln-l03$/)
      await expect(chip(page, 'pln-l03')).toHaveAttribute('data-role', 'self')
      await expect(page.locator('.gp-lanes.is-tracking')).toHaveCount(1)
    })

    test('4b. #track-<id> locks that lecture on arrival; Esc and a click on the blank map leave tracking', async ({ page }) => {
      await openGroup(page, '/pln/#track-pln-l03', theme, impl)
      await expect(chip(page, 'pln-l03')).toHaveAttribute('data-role', 'self')
      await page.keyboard.press('Escape')
      await expect(page.locator('.gp-lanes.is-tracking')).toHaveCount(0)
      await chip(page, 'pln-l01').dblclick()
      await expect(page.locator('.gp-lanes.is-tracking')).toHaveCount(1)
      await page.locator('.gp-lane').first().locator('.gp-lane-h').click()
      await expect(page.locator('.gp-lanes.is-tracking')).toHaveCount(0)
    })

    // 5. completion
    // demo MEA: L05 needs L03, L06 needs L04 and L05. Seeded (1-3 read, 4 reading) L05 is ready already; marking L05 and then
    // L04 read makes L06 ready
    test('5. marking lecture 4 read (after 5) makes lecture 6 ready, pulses it and names it in the live region', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl, { seeded: true })
      await expect(chip(page, 'mea-l06')).not.toHaveAttribute('data-ready', '')
      await chip(page, 'mea-l05').dblclick()
      await page.locator('[data-gp-act="mark"]').click()
      await expect(chip(page, 'mea-l05')).toHaveAttribute('data-status', 'read')
      await expect(chip(page, 'mea-l06')).not.toHaveAttribute('data-ready', '')
      // a double click on another chip moves the tracking there
      await chip(page, 'mea-l04').dblclick()
      await expect(chip(page, 'mea-l04')).toHaveAttribute('data-role', 'self')
      await page.locator('[data-gp-act="mark"]').click()
      await expect(chip(page, 'mea-l04')).toHaveAttribute('data-status', 'read')
      await expect(chip(page, 'mea-l06')).toHaveAttribute('data-ready', '')
      await expect(chip(page, 'mea-l06')).toHaveClass(/is-pulse/)
      await expect(page.locator('[data-gp-live]')).toContainText('第6讲')
      await expect(page.locator('[data-gp-live]')).toHaveAttribute('aria-live', 'polite')
      // the group map follows the same statuses
      await expect(page.locator('[data-gp-map] [data-lecture="mea-l06"]')).toHaveAttribute('data-ready', '')
      await expect(page.locator('[data-gp-spec="read"]')).toContainText('5 / ')
      // ... and marking it unread again takes the readiness back
      await page.locator('[data-gp-act="mark"]').click()
      await expect(chip(page, 'mea-l06')).not.toHaveAttribute('data-ready', '')
    })

    // 6. the 说明 preference
    test('6. the 说明 default (open / closed) is kept across reloads', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl)
      await chip(page, 'mea-l04').dblclick()
      const details = page.locator('.gp-p-desc details')
      await expect(details).toHaveJSProperty('open', true)
      await page.locator('[data-gp-pref="desc"]').uncheck()
      await expect(details).toHaveJSProperty('open', false)
      expect(await page.evaluate(() => localStorage.getItem('lecture:group-desc'))).toBe('0')
      await page.reload()
      await page.waitForSelector('html[data-hydrated="1"]')
      await page.waitForSelector('.gp-lanes .gp-lc')
      await chip(page, 'mea-l04').dblclick()
      await expect(page.locator('.gp-p-desc details')).toHaveJSProperty('open', false)
      await page.locator('[data-gp-pref="desc"]').check()
      await expect(page.locator('.gp-p-desc details')).toHaveJSProperty('open', true)
      expect(await page.evaluate(() => localStorage.getItem('lecture:group-desc'))).toBe('1')
    })

    // 7. the panel stays in the window while a lecture map taller than the window scrolls past (S6: made tall in the test, see below)
    test('7. the panel stays in the window while MEA scrolls', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl)
      await chip(page, 'mea-l01').dblclick()
      // the owner's long groups drew a lecture map taller than 1100 px; the 6 MEA lectures draw a short one, so the map is made that tall
      // here (the lane map's height comes from the lecture count, not from the lecture texts) and the sticky panel is checked against it
      await page.addStyleTag({ content: '.gp-lanes { min-height: 1400px !important; }' })
      await settle(page)
      const lanes = page.locator('.gp-lanes')
      const h = await lanes.evaluate((e) => e.getBoundingClientRect().height)
      expect(h).toBeGreaterThan(1100)
      const wrapH = await page.locator('.gp-map-wrap').evaluate((e) => e.getBoundingClientRect().height)
      expect(wrapH, 'the map box grows with the lecture map').toBeGreaterThan(1100)
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
      await openGroup(page, '/mea/', theme, impl)
      await chip(page, 'mea-l04').dblclick()
      await expect(chip(page, 'mea-l04')).toHaveAttribute('data-role', 'self')
      await expect(page).toHaveURL(/\/mea\/$/)
      await page.keyboard.press('Escape')
      await chip(page, 'mea-l03').click()
      await expect(page).toHaveURL(/\/mea\/L03$/)
    })

    test('8b. Space on a chip tracks; a double click in the group map tracks that lecture in the lecture map', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl)
      await chip(page, 'mea-l02').focus()
      await page.keyboard.press('Space')
      await expect(chip(page, 'mea-l02')).toHaveAttribute('data-role', 'self')
      await page.keyboard.press('Escape')
      await page.locator('[data-gp-map] [data-lecture="mea-l05"]').dblclick()
      await expect(chip(page, 'mea-l05')).toHaveAttribute('data-role', 'self')
      await expect(page).toHaveURL(/\/mea\/$/)
    })

    // 9. batch marking
    test('9. batch marking: click selects, one batch write, Esc leaves the mode', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl)
      await page.locator('[data-gp-batch-toggle]').click()
      for (const n of [1, 2, 3]) await chip(page, lid('mea', n)).click()
      await expect(page.locator('.gp-lanes [data-sel]')).toHaveCount(3)
      await expect(page).toHaveURL(/\/mea\/$/)
      await page.locator('[data-gp-batch="read"]').click()
      for (const n of [1, 2, 3]) await expect(chip(page, lid('mea', n))).toHaveAttribute('data-status', 'read')
      await expect(page.locator('[data-gp-batchbar]')).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-gp-batchbar]')).toHaveCount(0)
    })

    // ---- S6Y (audit-group package B and the user's decisions of 2026-11-23 21:47) ----

    // 12. every in-group 追踪 of the panel moves the lock (real clicks): the direct lists and the 更早 / 更远 folds
    test('12. the panel 追踪 of a prerequisite, a follow-up and of the 更早 / 更远 folds moves the tracking inside the group', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl)
      const p = page.locator('[data-gp-panel]')
      const foldOf = (word: string) => p.locator('details').filter({ has: page.locator('summary', { hasText: word }) })
      const lists = [
        ['pre', p.locator('[data-gp-list="pre"] li')],
        ['post', p.locator('[data-gp-list="post"] li')],
        ['更早', foldOf('更早').locator('li')],
        ['更远', foldOf('更远').locator('li')],
      ] as const
      for (const [what, items] of lists) {
        await page.keyboard.press('Escape')
        await chip(page, 'mea-l03').dblclick()
        await expect(chip(page, 'mea-l03')).toHaveAttribute('data-role', 'self')
        const item = items.first()
        if (what === '更早' || what === '更远') await foldOf(what).locator('summary').click()
        const target = idOfHref(await item.locator('a').getAttribute('href'))
        expect(target, `${what}: the item links a MEA lecture`).toMatch(/^mea-l\d+$/)
        await item.locator('button.trk').click()
        await expect(chip(page, target), `${what}: 追踪 locks ${target}`).toHaveAttribute('data-role', 'self')
        await expect(chip(page, 'mea-l03')).not.toHaveAttribute('data-role', 'self')
        await expect(page.locator('[data-gp-panel] .gp-p-tag')).toHaveText('正在追踪')
        await expect(page.locator('[data-gp-panel] .gp-p-t')).toContainText(`第${Number(target.slice(-2))}讲`)
        await expect(page).toHaveURL(/\/mea\/$/)
      }
    })

    // 13. audit #2: the prototype shows no text while tracking and a fixed toast after a mark; nothing pushes the lecture map
    test('13. tracking and marking do not move the lecture map: the status line is for screen readers, a mark shows a floating toast', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl, { seeded: true })
      const top = (): Promise<number> => page.locator('.gp-lanes').evaluate((e) => e.getBoundingClientRect().top + window.scrollY)
      const t0 = await top()
      await chip(page, 'mea-l05').dblclick()
      await expect(page.locator('[data-gp-live]')).toContainText('正在追踪')
      expect(await top(), 'lecture map top after tracking').toBeCloseTo(t0, 0)
      const live = await page.locator('[data-gp-live]').evaluate((e) => {
        const r = e.getBoundingClientRect()
        return { w: r.width, h: r.height, pos: getComputedStyle(e).position }
      })
      expect(live.pos, 'the status line is out of the flow').toBe('absolute')
      expect(live.w <= 1 && live.h <= 1, `the status line is visually hidden: ${live.w}x${live.h}`).toBe(true)
      await expect(page.locator('[data-gp-toast]'), 'no visible text while tracking (prototype)').toBeHidden()
      await page.locator('[data-gp-act="mark"]').click()
      await expect(page.locator('[data-gp-live]')).toContainText('已标为')
      expect(await top(), 'lecture map top after marking').toBeCloseTo(t0, 0)
      // prototype `.toast`: position fixed, bottom 24px, centred, gone after 2.6 s
      const toast = page.locator('[data-gp-toast]')
      await expect(toast).toBeVisible()
      await expect(toast).toContainText('已标为')
      const tb = await toast.evaluate((e) => ({ pos: getComputedStyle(e).position, bottom: window.innerHeight - e.getBoundingClientRect().bottom }))
      expect(tb.pos).toBe('fixed')
      expect(Math.abs(tb.bottom - 24), `toast ${tb.bottom}px above the bottom`).toBeLessThanOrEqual(1)
      await expect(toast).toBeHidden({ timeout: 5000 })
      expect(await top(), 'lecture map top after the toast and the status line are gone').toBeCloseTo(t0, 0)
    })

    // 14. audit #3: on a phone the panel sits on top of the map (sticky): a panel 追踪 brings the target below it, and does not
    // scroll when the target is already in sight (prototype `scrollIntoView({ block: 'nearest' })`)
    test('14. phone 390 px: a panel 追踪 leaves the target chip in the window and clear of the sticky panel; no scroll when it is in sight', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl, { width: 390, height: 844 })
      const geo = (id: string): Promise<{ top: number; bottom: number; panelBottom: number; vh: number; y: number }> =>
        page.evaluate((x) => {
          const c = (document.querySelector(`.gp-lanes [data-lecture="${x}"]`) as HTMLElement).getBoundingClientRect()
          const p = (document.querySelector('[data-gp-panel]') as HTMLElement).getBoundingClientRect()
          return { top: c.top, bottom: c.bottom, panelBottom: p.bottom, vh: window.innerHeight, y: window.scrollY }
        }, id)
      const clear = (g: { top: number; bottom: number; panelBottom: number; vh: number }): boolean => g.top >= g.panelBottom - 0.5 && g.bottom <= g.vh + 0.5
      // the lecture at the end of the lanes, tracked with the keyboard, then its prerequisite from the panel
      const ids = await page.locator('.gp-lanes a[data-lecture]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.lecture as string))
      const last = ids[ids.length - 1] as string
      await chip(page, last).focus()
      await page.keyboard.press('Space')
      await expect(chip(page, last)).toHaveAttribute('data-role', 'self')
      const item = page.locator('[data-gp-panel] [data-gp-list="pre"] li').first()
      const target = idOfHref(await item.locator('a').getAttribute('href'))
      // the 6 MEA lectures draw a short page on which the browser cannot centre a chip; the owner's long groups can (test 7 does the same)
      await page.addStyleTag({ content: '.gp-lanes { min-height: 1600px !important; }' })
      await settle(page)
      // put the target out of sight above the panel first, so the 追踪 has to scroll
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await settle(page)
      await item.locator('button.trk').click()
      await expect(chip(page, target)).toHaveAttribute('data-role', 'self')
      await expect.poll(async () => clear(await geo(target)), { message: `${target} below the panel and in the window` }).toBe(true)
      // a lecture already in sight below the panel: its 追踪 does not scroll
      const items = page.locator('[data-gp-panel] [data-gp-list] li')
      let tried = false
      for (let i = 0; i < (await items.count()); i++) {
        const id = idOfHref(await items.nth(i).locator('a').getAttribute('href'))
        if (!/^mea-/.test(id)) continue
        const g = await geo(id)
        if (!clear(g)) continue
        await items.nth(i).locator('button.trk').click()
        await expect(chip(page, id)).toHaveAttribute('data-role', 'self')
        await settle(page)
        const after = await geo(id)
        expect(after.y, `${id} was in sight: no scroll`).toBe(g.y)
        tried = true
        break
      }
      expect(tried, 'one related lecture was in sight below the panel').toBe(true)
    })

    // 15. decision 2: the pointer moving from a chip into the panel keeps the preview, so its buttons can be clicked
    test('15. desktop: the preview stays while the pointer moves from a chip into the panel; its 追踪 locks that lecture', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl)
      // the lecture map at the top of the window, so the whole preview (taller than the hint) is in sight
      await page.evaluate(() => {
        const s = document.querySelector('[data-gp-section="lanes"]') as HTMLElement
        window.scrollTo(0, window.scrollY + s.getBoundingClientRect().top - 72)
      })
      await settle(page)
      const c = await chip(page, 'mea-l03').boundingBox()
      const btn = page.locator('[data-gp-panel] [data-gp-act="track"]')
      expect(c).not.toBeNull()
      await page.mouse.move((c?.x ?? 0) + 10, (c?.y ?? 0) + 10)
      await expect(page.locator('[data-gp-panel] .gp-p-tag')).toHaveText('预览')
      // through the blank gap between the map and the panel, then onto the panel's 追踪 (one move each: no other chip on the way)
      const lanes = await page.locator('.gp-lanes').boundingBox()
      const panel = await page.locator('[data-gp-panel]').boundingBox()
      const gapX = ((lanes?.x ?? 0) + (lanes?.width ?? 0) + (panel?.x ?? 0)) / 2
      await page.mouse.move(gapX, (panel?.y ?? 0) + 20)
      await page.waitForTimeout(60)
      const b = await btn.boundingBox()
      await page.mouse.move((b?.x ?? 0) + 6, (b?.y ?? 0) + 6)
      await expect(page.locator('[data-gp-panel] .gp-p-t')).toContainText('第3讲')
      await page.mouse.down()
      await page.mouse.up()
      await expect(chip(page, 'mea-l03')).toHaveAttribute('data-role', 'self')
      await expect(page.locator('[data-gp-panel] .gp-p-tag')).toHaveText('正在追踪')
      // leaving the panel for the page does not drop a lock; without a lock the preview goes back to the hint
      await page.keyboard.press('Escape')
      await page.mouse.move((c?.x ?? 0) + 10, (c?.y ?? 0) + 10)
      await expect(page.locator('[data-gp-panel] .gp-p-tag')).toHaveText('预览')
      await page.mouse.move((panel?.x ?? 0) + 40, (panel?.y ?? 0) + 40)
      await expect(page.locator('[data-gp-panel] .gp-p-tag')).toHaveText('预览')
      await page.mouse.move(4, 4)
      await expect(page.locator('[data-gp-panel] .gp-hint')).toBeVisible()
    })

    // 16. decision 3: switching the lock scrolls the panel back to its top (the new lecture's title and actions in sight)
    test('16. phone: a 追踪 from the bottom of the panel shows the new lecture from the top of the panel', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl, { width: 390, height: 844 })
      await chip(page, 'mea-l03').focus()
      await page.keyboard.press('Space')
      await expect(chip(page, 'mea-l03')).toHaveAttribute('data-role', 'self')
      const panel = page.locator('[data-gp-panel]')
      const later = page.locator('[data-gp-panel] details:has(> summary:text-matches("更远"))')
      await later.locator('> summary').click()
      const scrolled = await panel.evaluate((el) => {
        el.scrollTop = el.scrollHeight
        return el.scrollTop
      })
      expect(scrolled, 'the panel content is taller than the panel').toBeGreaterThan(0)
      const item = later.locator('li').first()
      const target = idOfHref(await item.locator('a').getAttribute('href'))
      await item.locator('button.trk').click()
      await expect(chip(page, target)).toHaveAttribute('data-role', 'self')
      await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBe(0)
    })

    // 17. audit #10: the 说明 fold follows the 说明默认展开 setting for every lecture shown, not the last hand toggle
    test('17. 说明 opened by hand on one lecture is back to the default (closed) on the next one', async ({ page }) => {
      await openGroup(page, '/mea/', theme, impl)
      await chip(page, 'mea-l04').dblclick()
      await page.locator('[data-gp-pref="desc"]').uncheck()
      const details = page.locator('.gp-p-desc details')
      await expect(details).toHaveJSProperty('open', false)
      await details.locator('summary').click()
      await expect(details).toHaveJSProperty('open', true)
      await chip(page, 'mea-l03').dblclick()
      await expect(chip(page, 'mea-l03')).toHaveAttribute('data-role', 'self')
      await expect(page.locator('.gp-p-desc details')).toHaveJSProperty('open', false)
    })

    // 18. decision 1 + cross-row corridor: a line on one row or between adjacent rows never runs across a non-endpoint chip
    for (const width of [1280, 1440, 390] as const) {
      test(`18. ${width}px: no same-row or adjacent-row line crosses a non-endpoint chip, whichever MEA lecture is tracked`, async ({ page }) => {
        await openGroup(page, '/mea/', theme, impl, { width, height: width === 390 ? 844 : 900 })
        const ids = await page.locator('.gp-lanes a[data-lecture]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.lecture as string))
        for (const id of ids) {
          await page.keyboard.press('Escape')
          await chip(page, id).focus()
          await page.keyboard.press('Space')
          await expect(chip(page, id)).toHaveAttribute('data-role', 'self')
          await settle(page)
          const hits = await page.evaluate(() => {
            const lanes = document.querySelector('.gp-lanes') as HTMLElement
            const base = lanes.getBoundingClientRect()
            const boxes = [...lanes.querySelectorAll<HTMLElement>('a[data-lecture]')].map((a) => {
              const r = a.getBoundingClientRect()
              return { id: a.dataset.lecture as string, x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }
            })
            const near = (b: { x: number; y: number; w: number; h: number }, p: DOMPoint): boolean => p.x >= b.x - 1.5 && p.x <= b.x + b.w + 1.5 && p.y >= b.y - 1.5 && p.y <= b.y + b.h + 1.5
            const out: string[] = []
            for (const path of document.querySelectorAll<SVGPathElement>('.gp-edges path.e-pre, .gp-edges path.e-post')) {
              const len = path.getTotalLength()
              const a = path.getPointAtLength(0)
              const z = path.getPointAtLength(len)
              const ends = boxes.filter((b) => near(b, a) || near(b, z)).map((b) => b.id)
              const eb = boxes.filter((b) => ends.includes(b.id))
              if (eb.length !== 2) continue
              // same row, or adjacent rows (no row of chips strictly between the two endpoints vertically)
              const topY = Math.min(eb[0]!.y, eb[1]!.y)
              const botY = Math.max(eb[0]!.y, eb[1]!.y)
              if (boxes.some((x) => x.y > topY + 2 && x.y < botY - 2)) continue
              for (let s = 0; s <= len; s += 2) {
                const p = path.getPointAtLength(s)
                // inside a chip by more than 2px (the arrow head and the stub touch their own chip only)
                const b = boxes.find((x) => !ends.includes(x.id) && p.x > x.x + 2 && p.x < x.x + x.w - 2 && p.y > x.y + 2 && p.y < x.y + x.h - 2)
                if (b) {
                  out.push(`${ends.join('->')} crosses ${b.id} at ${Math.round(p.x)},${Math.round(p.y)}`)
                  break
                }
              }
            }
            return out
          })
          expect(hits, `${id} tracked`).toEqual([])
        }
      })
    }
  })
}

test.describe('group page: content', () => {
  test('a group without relation data lists its lectures in order under 全部讲次 and says 没有先修数据', async ({ page }) => {
    // every demo group has relation data (the unit tests pin that), so DAT's is taken out of the built curriculum on the way to the
    // browser, as for a group that is not in the dependency graph: every edge with a DAT lecture at either end is dropped and the DAT
    // lectures lose their graph category. The page is reached by a client-side navigation from /log/ (whose own edges are untouched),
    // so the server-rendered HTML of /dat/ never meets the changed data.
    test.skip(test.info().project.name === 'dev', 'built site only: the check rewrites the curriculum in the build chunk assets/chunks/model.*.js, which the dev server does not have (it serves source modules)')
    let dropped = 0
    await page.route('**/assets/chunks/model.*.js', async (route) => {
      const res = await route.fetch()
      const body = (await res.text())
        .replace(/"edges":(\[\[[^\]]*\](?:,\[[^\]]*\])*\])/g, (_m, arr: string) => {
          const edges = JSON.parse(arr) as [string, string][]
          const kept = edges.filter(([a, b]) => !a.startsWith('dat-') && !b.startsWith('dat-'))
          dropped += edges.length - kept.length
          return `"edges":${JSON.stringify(kept)}`
        })
        .replace(/(\{"id":"dat-l\d+"[^{}]*?"category":")[^"]*(")/g, '$1$2')
      await route.fulfill({ response: res, body })
    })
    await openGroup(page, '/log/', 'reader', 'default')
    expect(dropped, 'the curriculum chunk carried DAT edges that were dropped').toBeGreaterThan(0)
    await page.evaluate(() => {
      const a = document.createElement('a')
      a.href = `${location.pathname.replace(/log\/?$/, '')}dat/`
      a.textContent = 'DAT'
      a.id = 'a2-go-dat'
      document.querySelector('.vp-doc, main')?.prepend(a)
    })
    await page.locator('#a2-go-dat').click()
    await expect(page).toHaveURL(/\/dat\/$/)
    await page.waitForSelector('.gp-lanes .gp-lc')
    await expect(page.locator('.gp-lane')).toHaveCount(1)
    await expect(page.locator('.gp-lane-h')).toContainText('全部讲次')
    await expect(page.locator('[data-gp-panel]')).toContainText('没有先修数据')
    const lanes = await page.locator('.gp-lanes a[data-lecture]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.lecture))
    expect(lanes).toEqual(demoGroup('dat').lectures.map((n) => lectureId('dat', n)))
    await chip(page, 'dat-l01').hover()
    await expect(page.locator('[data-gp-panel] .gp-p-tag')).toHaveText('预览')
    await expect(page.locator('[data-gp-list]')).toHaveCount(0)
  })

  test('the group map and the lecture map list the same lectures in order; hovering a chip previews it', async ({ page }) => {
    await openGroup(page, '/dat/', 'reader', 'default')
    await expect(page.locator('.gp-lane')).toHaveCount(1)
    const lanes = await page.locator('.gp-lanes a[data-lecture]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.lecture))
    const map = await page.locator('[data-gp-map] a[data-lecture]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.lecture))
    expect(lanes).toEqual(demoGroup('dat').lectures.map((n) => lectureId('dat', n)))
    expect(map).toEqual(lanes)
    await chip(page, 'dat-l01').hover()
    await expect(page.locator('[data-gp-panel] .gp-p-tag')).toHaveText('预览')
  })

  test('title block: the spec rows 先修自 / 后续 link to the group pages, 可开始 n 讲 sits in the 已读 cell', async ({ page }) => {
    await openGroup(page, '/dat/', 'reader', 'default', { seeded: true })
    await expect(page.locator('[data-gp-spec="read"]')).toContainText(/可开始 \d+ 讲/)
    const pre = page.locator('[data-gp-spec="pre"] a.gref')
    expect(await pre.count()).toBeGreaterThan(0)
    for (const h of await pre.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) expect(h).toMatch(/^\/[a-z0-9]+\/$/)
    await expect(page.locator('[data-gp-spec="post"] a.gref').first()).toBeVisible()
    // seeded DAT: lecture 1 read, nothing being read: the continue line names the next ready lecture
    await expect(page.locator('[data-gp-cta="continue"]')).toContainText('第2讲')
  })

  test('English page: the Notion texts keep their language (lang="zh-CN")', async ({ page }) => {
    await openGroup(page, '/en/log/', 'reader', 'default')
    await chip(page, 'log-l02').dblclick()
    await expect(page.locator('[data-gp-desc]')).toHaveAttribute('lang', 'zh-CN')
    await expect(page.locator('.gp-lane-h span[lang="zh-CN"]').first()).toBeVisible()
  })

  test('no console errors or hydration warnings on a group page', async ({ page, consoleErrors, pageErrors }) => {
    const warnings: string[] = []
    page.on('console', (m) => {
      if (/hydrat/i.test(m.text())) warnings.push(m.text())
    })
    await openGroup(page, '/mea/', 'datasheet', 'datasheet', { seeded: true })
    await chip(page, 'mea-l04').dblclick()
    expect(warnings).toEqual([])
    expect(consoleErrors.filter((t) => /hydrat/i.test(t))).toEqual([])
    expect(pageErrors).toEqual([])
  })
})

// 10. screenshot baselines (light, desktop): the group page in both skins
for (const [theme, impl] of SKINS) {
  test(`10. screenshot baseline: the group page MEA (${theme}, light, desktop) @visual`, async ({ page }) => {
    test.skip(test.info().project.name !== 'prod', 'baselines are recorded for the prod project only')
    await openGroup(page, '/mea/', theme, impl, { width: 1440, height: 900, seeded: true })
    await chip(page, 'mea-l04').dblclick()
    await page.mouse.move(2, 2)
    // a full-page capture of a scrolled page would show the sticky bar in the middle of it
    await page.evaluate(() => window.scrollTo(0, 0))
    await settle(page)
    await expect(page).toHaveScreenshot(`group-page-${theme}-light-desktop.png`, { fullPage: true, mask: [page.locator('.VPLastUpdated')] })
  })
}
