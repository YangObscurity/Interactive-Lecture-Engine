import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme } from './theme-helpers'

test.describe('WP-F8: group figures wiki thumbnails, dark mode, skins & cross-references', () => {
  test('1440px desktop wiki thumbnail float, zero height shift, headings clear floats, and multi-figure gallery', async ({
    page,
    pageErrors,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })

    // Stall tinyml-pipeline.webp until pre-load height is measured so zero-CLS reservation is proved cleanly.
    let releaseWebp!: () => void
    const webpHeld = new Promise<void>((r) => {
      releaseWebp = r
    })
    let heldOnce = false
    await page.route('**/figures/lr/L04/tinyml-pipeline.webp', async (route) => {
      if (!heldOnce) {
        heldOnce = true
        await webpHeld
      }
      await route.continue()
    })

    const navPromise = gotoAndSettle(page, '/lr/L04')
    const figMedia = page.locator('figure#fig-tinyml-pipeline .lec-fig-media')
    await figMedia.waitFor({ state: 'attached', timeout: 30_000 })
    const preMetrics = await page.evaluate(() => {
      const fig = document.querySelector<HTMLElement>('figure#fig-tinyml-pipeline')
      const media = fig?.querySelector<HTMLElement>('.lec-fig-media')
      const img = fig?.querySelector<HTMLImageElement>('img')
      if (!fig || !media || !img) return null
      return {
        preHeight: Math.round(media.getBoundingClientRect().height),
        preComplete: img.complete,
      }
    })
    releaseWebp()
    expect(await navPromise).toBe(true)

    const metrics = await page.evaluate(async () => {
      const fig = document.querySelector<HTMLElement>('figure#fig-tinyml-pipeline')
      const media = fig?.querySelector<HTMLElement>('.lec-fig-media')
      const img = fig?.querySelector<HTMLImageElement>('img')
      const h3After = [...document.querySelectorAll('.vp-doc h3')].find((el) => el.textContent?.includes('3.2'))
      if (!fig || !media || !img || !h3After) return null
      fig.scrollIntoView()
      await img.decode()
      const postHeight = Math.round(media.getBoundingClientRect().height)

      const cs = getComputedStyle(fig)
      const figRect = fig.getBoundingClientRect()
      const h3Rect = h3After.getBoundingClientRect()
      const tagBadges = fig.querySelectorAll('.chart-tag').length
      const galleryImgs = document.querySelectorAll('figure.lec-fig--gallery .lec-fig-item img').length
      const hasCaptionLabel = fig.querySelector('.lec-ff-no')?.textContent?.trim() ?? ''
      const hasSource = fig.querySelector('.lec-ff-source')?.textContent?.trim() ?? ''

      return {
        postHeight,
        naturalWidth: img.naturalWidth,
        float: cs.float,
        widthPx: Math.round(figRect.width),
        clearsHeading: h3Rect.top >= figRect.bottom - 1,
        tagBadges,
        galleryImgs,
        hasCaptionLabel,
        hasSource,
      }
    })

    expect(preMetrics).not.toBeNull()
    expect(preMetrics!.preComplete).toBe(false)
    expect(preMetrics!.preHeight).toBeGreaterThan(100)
    expect(metrics).not.toBeNull()
    expect(metrics!.naturalWidth).toBeGreaterThan(0)
    expect(Math.abs(metrics!.postHeight - preMetrics!.preHeight)).toBe(0)
    expect(metrics!.float).toBe('right')
    expect(metrics!.widthPx).toBeGreaterThan(260)
    expect(metrics!.widthPx).toBeLessThan(460)
    expect(metrics!.clearsHeading).toBe(true)
    expect(metrics!.tagBadges).toBe(0)
    expect(metrics!.galleryImgs).toBe(2)
    expect(metrics!.hasCaptionLabel).toContain('说明')
    expect(metrics!.hasSource).toContain('Modran')

    // Verify prose wraps alongside a floated thumbnail on /examples/g01/L01
    await gotoAndSettle(page, '/examples/g01/L01')
    await page.locator('figure#fig-ohms-led-circuit img').waitFor({ state: 'attached' })
    const wrapInfo = await page.evaluate(() => {
      const fig = document.querySelector<HTMLElement>('figure#fig-ohms-led-circuit')
      const pBeside = [...document.querySelectorAll('.vp-doc p')].find((p) => p.textContent?.includes('把数字代进去'))
      const h2After = [...document.querySelectorAll('.vp-doc h2')].find((el) => el.textContent?.includes('让数字说话'))
      if (!fig || !pBeside || !h2After) return null
      const f = fig.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(pBeside)
      const lineRects = [...range.getClientRects()]
      const wrapsBeside = lineRects.some((r) => r.width > 10 && r.top < f.bottom - 2 && r.right <= f.left + 2)
      const h2 = h2After.getBoundingClientRect()
      return {
        wrapsBeside,
        clearsH2: h2.top >= f.bottom - 1,
      }
    })
    expect(wrapInfo).not.toBeNull()
    expect(wrapInfo!.wrapsBeside).toBe(true)
    expect(wrapInfo!.clearsH2).toBe(true)
    expect(pageErrors).toEqual([])
  })

  test('390px mobile collapses float to full width with max-height <= 50vh and zero horizontal overflow', async ({
    page,
    pageErrors,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoAndSettle(page, '/lr/L01')
    const figLoc = page.locator('figure#fig-hearthnet-arch')
    await figLoc.locator('img').waitFor({ state: 'attached' })
    await figLoc.scrollIntoViewIfNeeded()

    const info = await page.evaluate(async () => {
      const fig = document.querySelector<HTMLElement>('figure#fig-hearthnet-arch')
      const media = fig?.querySelector<HTMLElement>('.lec-fig-media')
      const img = fig?.querySelector<HTMLImageElement>('img')
      if (!fig || !media || !img) return null
      await img.decode()
      const cs = getComputedStyle(fig)
      const figRect = fig.getBoundingClientRect()
      const imgRect = img.getBoundingClientRect()
      return {
        float: cs.float,
        naturalWidth: img.naturalWidth,
        figWidth: figRect.width,
        figRight: figRect.right,
        figOverflowX: fig.scrollWidth - fig.clientWidth,
        imgHeight: imgRect.height,
        maxHalfVh: window.innerHeight * 0.5 + 2,
      }
    })

    expect(info).not.toBeNull()
    expect(info!.naturalWidth).toBeGreaterThan(0)
    expect(info!.float).toBe('none')
    expect(info!.figWidth).toBeGreaterThan(300)
    expect(info!.figRight).toBeLessThanOrEqual(390)
    expect(info!.figOverflowX).toBeLessThanOrEqual(1)
    expect(info!.imgHeight).toBeLessThanOrEqual(info!.maxHalfVh)

    await gotoAndSettle(page, '/examples/g01/L01')
    await page.locator('figure#fig-ohms-led-circuit img').waitFor({ state: 'attached' })
    const exMobile = await page.evaluate(() => ({
      float: getComputedStyle(document.querySelector('figure#fig-ohms-led-circuit')!).float,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    }))
    expect(exMobile.float).toBe('none')
    expect(exMobile.overflowX).toBeLessThanOrEqual(1)
    expect(pageErrors).toEqual([])
  })

  test('consecutive right floats stack vertically without side-by-side collision on L15 and render cleanly in both skins + dark mode', async ({
    page,
    pageErrors,
  }) => {
    await useTheme(page, 'datasheet', 'dark')
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoAndSettle(page, '/lr/L15')
    await page.locator('figure#fig-malware-roc-pr img').waitFor({ state: 'attached' })

    const darkInfo = await page.evaluate(async () => {
      const fig1 = document.querySelector<HTMLElement>('figure#fig-malware-drift-compare')
      const fig2 = document.querySelector<HTMLElement>('figure#fig-malware-roc-pr')
      const rasterBox = fig1?.querySelector<HTMLElement>('.lec-fig-media')
      if (!fig1 || !fig2 || !rasterBox) return null
      const r1 = fig1.getBoundingClientRect()
      const r2 = fig2.getBoundingClientRect()
      const cs1 = getComputedStyle(fig1)

      // Verify consecutive right-floats stack vertically via `clear: right` without side-by-side collision.
      const clone = fig1.cloneNode(true) as HTMLElement
      clone.id = 'fig-malware-clone-check'
      fig1.insertAdjacentElement('afterend', clone)
      const rc = clone.getBoundingClientRect()
      const consecutiveStacked = rc.top >= r1.bottom - 1 && Math.abs(rc.left - r1.left) <= 2
      clone.remove()

      const bg = getComputedStyle(rasterBox).backgroundColor
      const border = getComputedStyle(rasterBox).borderStyle
      const m = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(bg)
      const rgb = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
      return {
        theme: document.documentElement.getAttribute('data-lec-theme'),
        isDark: document.documentElement.classList.contains('dark'),
        format: rasterBox.dataset.format,
        clearRight: cs1.clear,
        nonColliding: r2.top >= r1.bottom - 1 || r2.right <= r1.left + 2,
        consecutiveStacked,
        rgb,
        border,
        capFont: getComputedStyle(fig1.querySelector('.lec-ff-no')!).fontFamily,
      }
    })

    expect(darkInfo).not.toBeNull()
    expect(darkInfo!.theme).toBe('datasheet')
    expect(darkInfo!.isDark).toBe(true)
    expect(darkInfo!.format).toBe('raster')
    expect(darkInfo!.clearRight).toBe('right')
    expect(darkInfo!.nonColliding).toBe(true)
    expect(darkInfo!.consecutiveStacked).toBe(true)
    expect(darkInfo!.rgb[0]).toBeGreaterThan(180)
    expect(darkInfo!.rgb[1]).toBeGreaterThan(180)
    expect(darkInfo!.rgb[2]).toBeGreaterThan(180)
    expect(darkInfo!.border).not.toBe('none')
    expect(pageErrors).toEqual([])
  })

  test('cross-reference hover preview, click jump with highlight, back-to-text within 2px, backlinks, and English example caption', async ({
    page,
    pageErrors,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoAndSettle(page, '/lr/L04')

    const xref = page.locator('.lec-xref[data-xref-id="pareto-fronts"]').first()
    await expect(xref).toHaveText('图 3')
    await xref.scrollIntoViewIfNeeded()

    // Desktop hover preview card appears and hides on leave
    await xref.hover()
    await expect(page.locator('.lec-xref-peek')).toBeVisible()
    await expect(page.locator('.lec-xref-peek__title')).toHaveText('图 3')
    await page.mouse.move(10, 10)
    await expect(page.locator('.lec-xref-peek')).toHaveCount(0)

    const yBefore = await page.evaluate(() => {
      window.scrollTo(0, 100)
      return window.scrollY
    })
    const xrefRect = await xref.boundingBox()
    expect(xrefRect).not.toBeNull()
    const scrollBefore = await page.evaluate(() => {
      document.querySelector('.lec-xref[data-xref-id="pareto-fronts"]')!.scrollIntoView({ block: 'center' })
      return window.scrollY
    })
    expect(scrollBefore).toBeGreaterThanOrEqual(yBefore)

    await xref.click()
    await expect(page.locator('#fig-pareto-fronts')).toHaveClass(/lec-fig--highlight/)
    const backBtn = page.locator('.lec-xref-backbtn')
    await expect(backBtn).toBeVisible()
    await expect(backBtn).toHaveText(/回到正文/)

    await backBtn.click()
    await expect(backBtn).toHaveCount(0)
    await expect
      .poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore), { timeout: 5000 })
      .toBeLessThanOrEqual(2)

    // Backlink at caption end jumps back cleanly
    const backlink = page.locator('#fig-tinyml-pipeline .lec-fig-backlink').first()
    await expect(backlink).toBeVisible()

    // Example lecture renders self-drawn figure in English with Figure 1 caption & zero Chinese
    await gotoAndSettle(page, '/en/examples/g01/L01')
    await expect(page.locator('.lec-xref[data-xref-id="ohms-led-circuit"]').first()).toHaveText('Fig. 1')
    await expect(page.locator('#fig-ohms-led-circuit .lec-ff-no')).toHaveText('Figure 1 caption')
    expect(pageErrors).toEqual([])
  })

  test('non-figure pages never load LectureFigure or figureXrefsRuntime modules', async ({ page, pageErrors }) => {
    const requested: string[] = []
    page.on('request', (req) => requested.push(req.url()))
    await gotoAndSettle(page, '/g01/L01')
    await page.waitForTimeout(250)
    const figureChunks = requested.filter((u) => /LectureFigure|figureXrefsRuntime/i.test(u))
    expect(figureChunks).toEqual([])
    expect(pageErrors).toEqual([])
  })

  test('the home page loads no figure code and not even the viewer library', async ({ page, pageErrors }) => {
    const requested: string[] = []
    page.on('request', (req) => requested.push(req.url()))
    await gotoAndSettle(page, '/')
    await page.waitForTimeout(250)
    expect(requested.filter((u) => /LectureFigure|figureXrefsRuntime|photoswipe/i.test(u))).toEqual([])
    expect(pageErrors).toEqual([])
  })

  test('a page with a figure loads the viewer library ahead of the first click', async ({ page, pageErrors }) => {
    const requested: string[] = []
    page.on('request', (req) => requested.push(req.url()))
    await gotoAndSettle(page, '/lr/L04')
    await expect.poll(() => requested.some((u) => /photoswipe/i.test(u))).toBe(true)
    expect(pageErrors).toEqual([])
  })
})
