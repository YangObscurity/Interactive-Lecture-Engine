/**
 * Concept links, the hover card and the concept page header (spec board 11.1; S6Y audit-spec #4 #5 #6).
 *
 *   - `a.lec-term` in a lecture: reader = accent dotted underline, datasheet = accent dashed underline (spec board
 *     `.term { text-decoration: underline dotted var(--lec-accent) var(--w-mid) }`, `.th-datasheet .term { dashed }`); the
 *     global `.vp-doc a { text-decoration: none !important }` (custom.css) used to remove it in both skins.
 *   - the card on hover / focus: term, English, summary and an "打开概念页 →" link (spec board `.tcard`: width 21em at 13 px =
 *     273 px, font-size 13 px); the pointer can move onto the card and use the link.
 *   - the concept page header is the 06 title block spec table: 英文 / 别名 / 领域 / 所属组 / 状态 / 来源.
 * Runs on the demo content (`npm run build:e2e`): /mea/L02 links "有效数字" to /concepts/significant-figures.
 */
import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme, lecVar } from './theme-helpers'

const LECTURE = '/mea/L02'
const SLUG = 'significant-figures'
const TERM = `.vp-doc a.lec-term[data-concept="${SLUG}"]`

function rgbOf(page: import('@playwright/test').Page, cssColor: string): Promise<string> {
  return page.evaluate((c) => {
    const el = document.createElement('span')
    el.style.color = c
    document.body.appendChild(el)
    const v = getComputedStyle(el).color
    el.remove()
    return v
  }, cssColor)
}

for (const [skin, style] of [
  ['reader', 'dotted'],
  ['datasheet', 'dashed'],
] as const) {
  test(`${skin}: concept links have the accent ${style} underline (spec board 11.1)`, async ({ page, pageErrors }) => {
    await useTheme(page, skin, 'light')
    await page.setViewportSize({ width: 1280, height: 900 })
    await gotoAndSettle(page, LECTURE)
    const term = page.locator(TERM).first()
    await expect(term).toHaveCount(1)
    const cs = await term.evaluate((el) => {
      const s = getComputedStyle(el)
      const p = getComputedStyle(el.parentElement!)
      return {
        line: s.textDecorationLine,
        style: s.textDecorationStyle,
        decoColor: s.textDecorationColor,
        thickness: s.textDecorationThickness,
        color: s.color,
        parentColor: p.color,
        borderBottomWidth: s.borderBottomWidth,
        borderBottomColor: s.borderBottomColor,
      }
    })
    const accent = await rgbOf(page, await lecVar(page, '--lec-accent'))
    expect(cs.line).toBe('underline')
    expect(cs.style).toBe(style)
    expect(cs.decoColor).toBe(accent)
    expect(cs.thickness).toBe('1.5px')
    // the word itself keeps the text colour (spec board `.term { color: inherit }`); no second underline from a border
    expect(cs.color).toBe(cs.parentColor)
    expect(cs.borderBottomWidth === '0px' || cs.borderBottomColor === 'rgba(0, 0, 0, 0)').toBe(true)
    expect(pageErrors).toEqual([])
  })
}

test('the hover card: 273 px, 13 px, term + English + summary + "打开概念页 →"; the pointer can use the link', async ({
  page,
  pageErrors,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoAndSettle(page, LECTURE)
  const term = page.locator(TERM).first()
  await term.scrollIntoViewIfNeeded()
  await term.hover()
  const card = page.locator('.lec-tcard')
  await expect(card).toBeVisible()
  const box = await card.evaluate((el) => {
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return { width: r.width, fontSize: s.fontSize }
  })
  // spec board `.tcard { width: 21em; font-size: 13px }` = 273 px
  expect(Math.abs(box.width - 273)).toBeLessThanOrEqual(1)
  expect(box.fontSize).toBe('13px')
  const open = card.locator('a.lec-tcard-open')
  await expect(open).toHaveText('打开概念页 →')
  const href = await term.getAttribute('href')
  expect(await open.getAttribute('href')).toBe(href)
  // move onto the card (the card stays) and follow the link
  const ob = (await open.boundingBox())!
  await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2, { steps: 6 })
  await expect(card).toBeVisible()
  await open.click()
  await expect(page).toHaveURL(new RegExp(`/concepts/${SLUG}`))
  await expect(page.locator('.lec-concept-title')).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('keyboard focus on a concept link shows the card; Esc hides it', async ({ page, pageErrors }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoAndSettle(page, LECTURE)
  await page.locator(TERM).first().focus()
  await expect(page.locator('.lec-tcard')).toBeVisible()
  await expect(page.locator('.lec-tcard a.lec-tcard-open')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.lec-tcard')).toBeHidden()
  expect(pageErrors).toEqual([])
})

for (const skin of ['reader', 'datasheet'] as const) {
  test(`${skin}: the concept page header is the 06 spec table with 英文 / 别名 / 领域 / 所属组 / 状态 / 来源`, async ({
    page,
    pageErrors,
  }) => {
    await useTheme(page, skin, 'light')
    await page.setViewportSize({ width: 1280, height: 900 })
    await gotoAndSettle(page, `/concepts/${SLUG}`)
    const table = page.locator('.lec-concept-header table.lec-tb-spec')
    await expect(table).toHaveCount(1)
    const heads = await table.locator('th').allTextContents()
    expect(heads.map((h) => h.trim())).toEqual(['英文', '别名', '领域', '所属组', '状态', '来源'])
    const cells = await table.locator('td').allTextContents()
    expect(cells).toHaveLength(6)
    for (const c of cells) expect(c.trim().length, 'no empty cell (none is "—")').toBeGreaterThan(0)
    // the one-line meta row is gone
    await expect(page.locator('.lec-concept-header .lec-concept-meta-item')).toHaveCount(0)
    if (skin === 'datasheet') {
      const top = await table.evaluate((el) => getComputedStyle(el).borderTopStyle)
      expect(top).toBe('solid')
    }
    expect(pageErrors).toEqual([])
  })
}
