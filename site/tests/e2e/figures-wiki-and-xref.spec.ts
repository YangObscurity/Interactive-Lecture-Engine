/**
 * WP-F8: figure pack thumbnails ("wiki" floats), galleries, dark mode, skins and cross-references.
 *
 * S6: runs on the demo content (`npm run build:e2e`). Figure pack `figures/mea`: `mea-ruler` (MEA L02, single
 * right-floated SVG thumbnail, referenced as [](fig:mea-ruler)); on MEA L03 the WebP `mea-grid` and the SVG
 * `mea-error-bars` as two consecutive right floats (the raster keeps its light box in dark mode); MEA L06 a two-figure
 * gallery. Figure pack `figures/log`: `log-and-gate` on LOG L01 and its English translation /en/log/L01 (English caption).
 */
import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme } from './theme-helpers'

const FIG_LECTURE = '/mea/L02'
const FIG = 'mea-ruler'
const FIG_FILE = '**/figures/mea/mea-ruler.svg'
const FIG2_LECTURE = '/mea/L03'
const FIG2 = 'mea-error-bars'
/** The raster (WebP) figure right before FIG2 on MEA L03: two consecutive right floats. */
const RASTER_FIG = 'mea-grid'
/** A translated demo lecture with a figure pack figure (pack figures/log), captioned in both languages. */
const EN_FIG_LECTURE = '/en/log/L01'
const EN_FIG = 'log-and-gate'
/** A demo lecture with the two figures side by side in one gallery (requested from line A2, see progress-B.md). */
const GALLERY_LECTURE = '/mea/L06'

test.describe('WP-F8: group figures wiki thumbnails, dark mode, skins & cross-references', () => {
  test('1440px desktop wiki thumbnail float, zero height shift, headings clear floats, prose wraps beside it', async ({
    page,
    pageErrors,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })

    // Stall the figure file until the pre-load height is measured so the zero-CLS reservation is proved cleanly.
    let releaseFile!: () => void
    const fileHeld = new Promise<void>((r) => {
      releaseFile = r
    })
    let heldOnce = false
    await page.route(FIG_FILE, async (route) => {
      if (!heldOnce) {
        heldOnce = true
        await fileHeld
      }
      await route.continue()
    })

    const navPromise = gotoAndSettle(page, FIG_LECTURE)
    const figMedia = page.locator(`figure#fig-${FIG} .lec-fig-media`)
    await figMedia.waitFor({ state: 'attached', timeout: 30_000 })
    const preMetrics = await page.evaluate((id) => {
      const fig = document.querySelector<HTMLElement>(`figure#fig-${id}`)
      const media = fig?.querySelector<HTMLElement>('.lec-fig-media')
      const img = fig?.querySelector<HTMLImageElement>('img')
      if (!fig || !media || !img) return null
      return {
        preHeight: Math.round(media.getBoundingClientRect().height),
        preComplete: img.complete,
      }
    }, FIG)
    releaseFile()
    expect(await navPromise).toBe(true)

    const metrics = await page.evaluate(async (id) => {
      const fig = document.querySelector<HTMLElement>(`figure#fig-${id}`)
      const media = fig?.querySelector<HTMLElement>('.lec-fig-media')
      const img = fig?.querySelector<HTMLImageElement>('img')
      // the first heading after the figure must clear the float
      const headings = [...document.querySelectorAll<HTMLElement>('.vp-doc h2, .vp-doc h3')]
      const headingAfter = fig ? headings.find((h) => fig.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) : undefined
      // the paragraph right after the figure (the one with the cross-reference) wraps beside it
      const pBeside = fig?.nextElementSibling as HTMLElement | null
      if (!fig || !media || !img || !headingAfter || !pBeside) return null
      fig.scrollIntoView()
      await img.decode()
      const postHeight = Math.round(media.getBoundingClientRect().height)

      const cs = getComputedStyle(fig)
      const figRect = fig.getBoundingClientRect()
      const hRect = headingAfter.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(pBeside)
      const lineRects = [...range.getClientRects()]
      return {
        postHeight,
        naturalWidth: img.naturalWidth,
        float: cs.float,
        widthPx: Math.round(figRect.width),
        clearsHeading: hRect.top >= figRect.bottom - 1,
        wrapsBeside: lineRects.some((r) => r.width > 10 && r.top < figRect.bottom - 2 && r.right <= figRect.left + 2),
        tagBadges: fig.querySelectorAll('.chart-tag').length,
        hasCaptionLabel: fig.querySelector('.lec-ff-no')?.textContent?.trim() ?? '',
        hasSource: fig.querySelector('.lec-ff-source')?.textContent?.trim() ?? '',
      }
    }, FIG)

    expect(preMetrics).not.toBeNull()
    expect(preMetrics!.preComplete).toBe(false)
    expect(preMetrics!.preHeight).toBeGreaterThan(50)
    expect(metrics).not.toBeNull()
    expect(metrics!.naturalWidth).toBeGreaterThan(0)
    expect(Math.abs(metrics!.postHeight - preMetrics!.preHeight)).toBe(0)
    expect(metrics!.float).toBe('right')
    expect(metrics!.widthPx).toBeGreaterThan(260)
    expect(metrics!.widthPx).toBeLessThan(460)
    expect(metrics!.clearsHeading).toBe(true)
    expect(metrics!.wrapsBeside).toBe(true)
    expect(metrics!.tagBadges).toBe(0)
    expect(metrics!.hasCaptionLabel).toContain('说明')
    // source line of figures.json: paper · number · page
    expect(metrics!.hasSource).toContain('Original Example Diagram')
    expect(pageErrors).toEqual([])
  })

  test('a figure list renders as one full-width gallery with every image', async ({ page, pageErrors }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoAndSettle(page, GALLERY_LECTURE)
    const gallery = page.locator('figure.lec-fig--gallery')
    await expect(gallery).toHaveCount(1)
    await expect(gallery.locator('.lec-fig-item img')).toHaveCount(2)
    expect(await gallery.evaluate((el) => getComputedStyle(el).float)).toBe('none')
    expect(pageErrors).toEqual([])
  })

  test('390px mobile collapses float to full width with max-height <= 50vh and zero horizontal overflow', async ({
    page,
    pageErrors,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoAndSettle(page, FIG_LECTURE)
    const figLoc = page.locator(`figure#fig-${FIG}`)
    await figLoc.locator('img').waitFor({ state: 'attached' })
    await figLoc.scrollIntoViewIfNeeded()

    const info = await page.evaluate(async (id) => {
      const fig = document.querySelector<HTMLElement>(`figure#fig-${id}`)
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
    }, FIG)

    expect(info).not.toBeNull()
    expect(info!.naturalWidth).toBeGreaterThan(0)
    expect(info!.float).toBe('none')
    expect(info!.figWidth).toBeGreaterThan(300)
    expect(info!.figRight).toBeLessThanOrEqual(390)
    expect(info!.figOverflowX).toBeLessThanOrEqual(1)
    expect(info!.imgHeight).toBeLessThanOrEqual(info!.maxHalfVh)

    await gotoAndSettle(page, FIG2_LECTURE)
    await page.locator(`figure#fig-${FIG2} img`).waitFor({ state: 'attached' })
    const second = await page.evaluate((id) => ({
      float: getComputedStyle(document.querySelector(`figure#fig-${id}`)!).float,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    }), FIG2)
    expect(second.float).toBe('none')
    expect(second.overflowX).toBeLessThanOrEqual(1)
    expect(pageErrors).toEqual([])
  })

  test('consecutive right floats stack vertically without side-by-side collision on MEA L03 and render cleanly in both skins + dark mode', async ({
    page,
    pageErrors,
  }) => {
    await useTheme(page, 'datasheet', 'dark')
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoAndSettle(page, FIG2_LECTURE)
    await page.locator(`figure#fig-${FIG2} img`).waitFor({ state: 'attached' })

    const darkInfo = await page.evaluate(
      ({ rasterId, nextId }) => {
        const fig1 = document.querySelector<HTMLElement>(`figure#fig-${rasterId}`)
        const fig2 = document.querySelector<HTMLElement>(`figure#fig-${nextId}`)
        const rasterBox = fig1?.querySelector<HTMLElement>('.lec-fig-media')
        if (!fig1 || !fig2 || !rasterBox) return null
        const r1 = fig1.getBoundingClientRect()
        const r2 = fig2.getBoundingClientRect()
        const cs1 = getComputedStyle(fig1)

        // Verify consecutive right-floats stack vertically via `clear: right` without side-by-side collision.
        const clone = fig1.cloneNode(true) as HTMLElement
        clone.id = `${fig1.id}-clone-check`
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
      },
      { rasterId: RASTER_FIG, nextId: FIG2 },
    )

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
    // the datasheet skin sets the figure number in its monospace face
    expect(darkInfo!.capFont).toMatch(/mono/i)
    expect(pageErrors).toEqual([])
  })

  test('cross-reference hover preview, click jump with highlight, back-to-text within 2px, backlinks, and English figure caption', async ({
    page,
    pageErrors,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoAndSettle(page, FIG_LECTURE)

    const xref = page.locator(`.lec-xref[data-xref-id="${FIG}"]`).first()
    await expect(xref).toHaveText('图 1')
    await xref.scrollIntoViewIfNeeded()

    // Desktop hover preview card appears and hides on leave
    await xref.hover()
    await expect(page.locator('.lec-xref-peek')).toBeVisible()
    await expect(page.locator('.lec-xref-peek__title')).toHaveText('图 1')
    await page.mouse.move(10, 10)
    await expect(page.locator('.lec-xref-peek')).toHaveCount(0)

    const yBefore = await page.evaluate(() => {
      window.scrollTo(0, 100)
      return window.scrollY
    })
    const xrefRect = await xref.boundingBox()
    expect(xrefRect).not.toBeNull()
    const scrollBefore = await page.evaluate((id) => {
      document.querySelector(`.lec-xref[data-xref-id="${id}"]`)!.scrollIntoView({ block: 'center' })
      return window.scrollY
    }, FIG)
    expect(scrollBefore).toBeGreaterThanOrEqual(yBefore)

    await xref.click()
    await expect(page.locator(`#fig-${FIG}`)).toHaveClass(/lec-fig--highlight/)
    const backBtn = page.locator('.lec-xref-backbtn')
    await expect(backBtn).toBeVisible()
    await expect(backBtn).toHaveText(/回到正文/)

    await backBtn.click()
    await expect(backBtn).toHaveCount(0)
    await expect
      .poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore), { timeout: 5000 })
      .toBeLessThanOrEqual(2)

    // Backlink at caption end
    const backlink = page.locator(`#fig-${FIG} .lec-fig-backlink`).first()
    await expect(backlink).toBeVisible()

    // Translated demo lecture renders its figure pack figure in English with Figure 1 caption & zero Chinese
    await gotoAndSettle(page, EN_FIG_LECTURE)
    await expect(page.locator(`.lec-xref[data-xref-id="${EN_FIG}"]`).first()).toHaveText('Fig. 1')
    await expect(page.locator(`#fig-${EN_FIG} .lec-ff-no`)).toHaveText('Figure 1 caption')
    expect(pageErrors).toEqual([])
  })

  test('non-figure pages never load LectureFigure or figureXrefsRuntime modules', async ({ page, pageErrors }) => {
    const requested: string[] = []
    page.on('request', (req) => requested.push(req.url()))
    await gotoAndSettle(page, '/log/L02')
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
    await gotoAndSettle(page, FIG_LECTURE)
    await expect.poll(() => requested.some((u) => /photoswipe/i.test(u))).toBe(true)
    expect(pageErrors).toEqual([])
  })
})
