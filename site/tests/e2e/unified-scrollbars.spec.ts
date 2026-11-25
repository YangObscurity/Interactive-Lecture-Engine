import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme } from './theme-helpers'

for (const theme of ['reader', 'datasheet'] as const) {
  test(`unified theme scrollbars style inner containers in ${theme} skin`, async ({ page, pageErrors }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await useTheme(page, theme, 'light')
    await gotoAndSettle(page, '/pln/L02')

    await page.locator('.cm-trigger').click()
    const cmGroups = page.locator('.cm-groups')
    await expect(cmGroups).toBeVisible()

    const sb = await cmGroups.evaluate((el) => {
      const host = getComputedStyle(el)
      const bar = getComputedStyle(el, '::-webkit-scrollbar')
      const thumb = getComputedStyle(el, '::-webkit-scrollbar-thumb')
      const btn = getComputedStyle(el, '::-webkit-scrollbar-button')
      return {
        scrollbarWidth: host.scrollbarWidth,
        scrollbarColor: host.scrollbarColor,
        width: bar.width,
        radius: thumb.borderTopLeftRadius,
        thumbBg: thumb.backgroundColor,
        btnDisplay: btn.display,
      }
    })

    expect(sb.scrollbarWidth).toBe('auto')
    expect(sb.scrollbarColor).toBe('auto')
    expect(sb.width).toBe('6px')
    expect(sb.btnDisplay).toBe('none')
    expect(sb.thumbBg).not.toBe('rgba(0, 0, 0, 0)')
    expect(sb.radius).toBe(theme === 'datasheet' ? '1px' : '999px')
    expect(pageErrors.map(String)).toEqual([])
  })
}
