/**
 * S6Y DB: Dashboard sizes and skin shapes against the prototype (`Dashboard 原型.html` v3.4, copied
 * to design/prototypes/dashboard) and the spec board 14.2 「验收」 (`V2 设计规格板.html` #dashboard). Every expected number
 * names its source as 「原型 <rule>」 (the prototype's CSS rule) or 「规格板 14.2 第 N 条」. Sizes allow ±1 px.
 *
 * Runs in both projects: prod (online read only, admin session mocked) covers the shell, type, nav, key figures, panels,
 * tables, tabs, compact buttons and status marks; dev (local author mode) adds the inputs, block editor, full-size
 * buttons, the changed-field bar, the phone language labels and the phone save bar. Two skins x desktop 1280 / phone 390.
 */
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { useTheme } from './theme-helpers'

type Skin = 'reader' | 'datasheet'
type CssProp =
  | 'fontSize' | 'lineHeight' | 'fontFamily' | 'fontWeight' | 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft'
  | 'minHeight' | 'borderTopLeftRadius' | 'backgroundColor' | 'color' | 'borderTopWidth' | 'borderTopStyle' | 'borderTopColor'
  | 'borderBottomWidth' | 'borderBottomStyle' | 'borderBottomColor' | 'borderLeftWidth' | 'borderLeftStyle' | 'borderLeftColor'
  | 'boxShadow' | 'display' | 'order'
type Css = Record<CssProp | 'h' | 'w' | 'top' | 'before', string>

/** 1.5 px rules: Chrome snaps border widths to device pixels, so at DPR 1 a 1.5 px border computes to 1 px. */
const HAIRLINE = ['1px', '1.5px']
const VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } } as const

async function open(page: Page, skin: Skin, vp: keyof typeof VIEWPORTS, hash: string): Promise<void> {
  await page.setViewportSize(VIEWPORTS[vp])
  await page.context().route('**/api/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ authenticated: true, user: { id: 'alice', name: 'Alice', email: 'alice@example.com' }, roles: ['reader', 'admin'], groups: ['admins'], logoutUrl: null }),
    }),
  )
  await useTheme(page, skin, 'light')
  await page.goto(`/dashboard#${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
  await expect(page.locator('html')).toHaveAttribute('data-lec-theme', skin)
}

async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => (location.hash = h), hash)
  await page.waitForFunction((h) => location.hash === `#${h}`, hash)
}

/** Computed style of the first visible match (plus its box and ::before). */
async function css(page: Page, sel: string): Promise<Css> {
  const loc = page.locator(sel).locator('visible=true').first()
  await expect(loc, sel).toBeVisible()
  return loc.evaluate((e) => {
    const cs = getComputedStyle(e)
    const r = e.getBoundingClientRect()
    const o: Record<string, string> = { h: String(r.height), w: String(r.width), top: String(r.top) }
    for (const p of ['fontSize', 'lineHeight', 'fontFamily', 'fontWeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'minHeight', 'borderTopLeftRadius', 'backgroundColor', 'color', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor', 'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor', 'boxShadow', 'display', 'order'] as const)
      o[p] = cs[p]
    const b = getComputedStyle(e, '::before')
    o.before = b.content === 'none' || b.content === 'normal' ? '' : `${b.content}|${b.fontSize}`
    return o as Css
  })
}

/** A `--lec-*` token resolved to the computed form the browser uses for colours / fonts / lengths. */
async function token(page: Page, name: string, prop: 'color' | 'fontFamily' | 'borderTopLeftRadius' = 'color'): Promise<string> {
  return page.evaluate(
    ([n, p]) => {
      const probe = document.createElement('i')
      const cssProp = p === 'color' ? 'color' : p === 'fontFamily' ? 'font-family' : 'border-top-left-radius'
      probe.style.setProperty(cssProp, `var(${n})`)
      document.querySelector('.lec-dashboard')!.appendChild(probe)
      const v = getComputedStyle(probe)[p as 'color']
      probe.remove()
      return v
    },
    [name, prop] as const,
  )
}

function px(v: string): number {
  return Number.parseFloat(v)
}
function near(actual: string | number, expected: number, what: string): void {
  const n = typeof actual === 'number' ? actual : px(actual)
  expect(Math.abs(n - expected), `${what}: ${n} vs ${expected}`).toBeLessThanOrEqual(1)
}

for (const skin of ['reader', 'datasheet'] as const) {
  for (const vp of ['desktop', 'phone'] as const) {
    test.describe(`Dashboard sizes · ${skin} · ${vp}`, () => {
      test('shell, type, nav, key figures, panels, tables, tabs, compact buttons, status marks', async ({ page, pageErrors }) => {
        await open(page, skin, vp, 'overview')
        const ds = skin === 'datasheet'
        const text = await token(page, '--lec-text')

        // 原型 body{font:14px/1.6 var(--lec-font-heading)}: 14 px / 22.4 px in the heading (sans) face, never the
        // datasheet body serif (审计 #10 #11)
        const root = await css(page, '.lec-dashboard')
        near(root.fontSize, 14, 'root font-size')
        near(root.lineHeight, 22.4, 'root line-height')
        expect(root.fontFamily).toBe(await token(page, '--lec-font-heading', 'fontFamily'))
        expect(root.fontFamily).not.toMatch(/serif SC|Songti|SimSun/i)

        // 原型 .ph h2{font-size:26px;line-height:1.2}; narrow .ph h2{font-size:22px}
        const h2 = await css(page, '.db-ph h2')
        near(h2.fontSize, vp === 'phone' ? 22 : 26, 'page title')
        near(h2.lineHeight, (vp === 'phone' ? 22 : 26) * 1.2, 'page title line-height')

        // key figures: 原型 .figs b{font:700 30px/1.15}, .th-datasheet .figs b{font:600 28px/1.2 mono}, narrow .figs b 24px;
        // .figs>div{padding:12px 16px}; datasheet: columns between a 2px top rule and a 1px bottom rule, name above the
        // number (规格板 14.2 第 3 条)
        const figB = await css(page, '.db-figs > div b')
        near(figB.fontSize, vp === 'phone' ? 24 : ds ? 28 : 30, 'figure number')
        expect(figB.fontWeight).toBe(ds ? '600' : '700')
        const figBox = await css(page, '.db-figs > div')
        const figName = await css(page, '.db-figs > div span')
        if (ds) {
          expect(px(figName.top)).toBeLessThan(px(figB.top))
          expect(figB.fontFamily).toBe(await token(page, '--lec-font-mono', 'fontFamily'))
          expect(figBox.borderTopWidth).toBe('0px')
          expect(figBox.backgroundColor).toBe('rgba(0, 0, 0, 0)')
          const figs = await css(page, '.db-figs')
          expect([figs.borderTopWidth, figs.borderTopColor, figs.borderBottomWidth]).toEqual(['2px', text, '1px'])
        } else {
          expect(px(figName.top)).toBeGreaterThan(px(figB.top))
          near(figBox.paddingTop, 12, 'figure card padding-top')
          near(figBox.paddingLeft, 16, 'figure card padding-left')
        }

        // panels: 原型 .panel>header{padding:11px 16px;background:surface}, h3 15px/700 (datasheet 900);
        // .panel{background:var(--lec-bg)}; datasheet .panel{border-top:2px solid text}, header bottom 1px solid text
        const head = await css(page, '.db-panel > header')
        near(head.paddingTop, 11, 'panel header padding-top')
        near(head.paddingLeft, 16, 'panel header padding-left')
        const h3 = await css(page, '.db-panel > header h3')
        near(h3.fontSize, 15, 'panel title')
        expect(h3.fontWeight).toBe(ds ? '900' : '700')
        const panel = await css(page, '.db-panel')
        expect(panel.backgroundColor).toBe(await token(page, '--lec-bg'))
        if (ds) {
          expect([panel.borderTopWidth, panel.borderTopColor]).toEqual(['2px', text])
          expect([head.borderBottomStyle, head.borderBottomColor, head.backgroundColor]).toEqual(['solid', text, 'rgba(0, 0, 0, 0)'])
        } else {
          expect(head.backgroundColor).toBe(await token(page, '--lec-surface'))
        }

        if (vp === 'desktop') {
          // nav: 原型 .shell 216px; .nav a{padding:6px 10px;min-height:36px} (datasheet 6px 16px, dashed rows), current
          // item 700; reader current = accent tint + accent; datasheet current = inset 4px text bar on surface; datasheet
          // group titles mono 11.5px/600 with a 1px text rule above
          near((await css(page, '.db-side')).w, 216, 'nav width')
          const navi = await css(page, '.db-navi:not([aria-current])')
          near(navi.fontSize, 14, 'nav item font-size')
          near(navi.h, 36, 'nav item height')
          near(navi.paddingTop, 6, 'nav item padding-top')
          near(navi.paddingLeft, ds ? 16 : 10, 'nav item padding-left')
          const cur = await css(page, '.db-navi[aria-current="page"]')
          expect(cur.fontWeight).toBe('700')
          if (ds) {
            expect(cur.boxShadow).toContain('inset')
            expect(cur.boxShadow).toContain('4px 0px 0px 0px')
            expect(cur.backgroundColor).toBe(await token(page, '--lec-surface'))
            expect(navi.borderBottomStyle).toBe('dashed')
            const g = await css(page, '.db-nav h2')
            near(g.fontSize, 11.5, 'nav group title')
            expect(g.fontFamily).toBe(await token(page, '--lec-font-mono', 'fontFamily'))
            expect([g.borderTopWidth, g.borderTopColor]).toEqual(['1px', text])
          } else {
            expect(cur.color).toBe(await token(page, '--lec-accent'))
            expect(cur.backgroundColor).toBe(await token(page, '--lec-accent-tint'))
          }
          await expect(page.locator('.db-navsel')).toBeHidden()
        } else {
          // 原型 select.in{font-size:16px;min-height:38px}: the phone page picker never triggers iOS zoom (规格板 14.2 第 8 条)
          await expect(page.locator('.db-side')).toBeHidden()
          const sel = await css(page, '.db-navsel select')
          near(sel.fontSize, 16, 'phone nav select font-size')
          expect(px(sel.h)).toBeGreaterThanOrEqual(38)
        }

        // tables: 原型 table.t{font-size:13px}; .t th,.t td{padding:8px 14px;border-bottom:1px}; thead th 12px/600 on surface
        // (规格板 14.2 第 5 条); datasheet three-line table: mono header with a 1.5px text rule, column rules, dashed rows
        await go(page, 'access')
        const td = await css(page, '.db-t td')
        near(td.fontSize, 13, 'table cell font-size')
        if (vp === 'desktop') {
          near(td.paddingTop, 8, 'table cell padding-top')
          near(td.paddingLeft, 14, 'table cell padding-left')
          const th = await css(page, '.db-t th')
          near(th.fontSize, 12, 'table header font-size')
          expect(th.fontWeight).toBe('600')
          if (ds) {
            expect(HAIRLINE).toContain(th.borderBottomWidth)
            expect(th.borderBottomColor).toBe(text)
            expect(th.fontFamily).toBe(await token(page, '--lec-font-mono', 'fontFamily'))
            expect(td.borderBottomStyle).toBe('dashed')
            const td2 = await css(page, '.db-t td + td')
            expect([td2.borderLeftWidth, td2.borderLeftStyle]).toEqual(['1px', 'solid'])
          } else {
            expect(th.backgroundColor).toBe(await token(page, '--lec-surface'))
            expect([td.borderBottomWidth, td.borderTopWidth]).toEqual(['1px', '0px'])
          }
        }

        // tabs: 原型 .tabs button{padding:7px 14px;min-height:36px}, 14 px; selected = text colour, 700, accent underline;
        // datasheet: mono 12.5px, selected block in --lec-chip (规格板 14.2 第 9 条)
        await go(page, 'companion:prompt')
        const tab = await css(page, '.db-tabs:not(.in) [role="tab"][aria-selected="false"]')
        near(tab.fontSize, ds ? 12.5 : 14, 'tab font-size')
        near(tab.paddingTop, 7, 'tab padding-top')
        near(tab.paddingLeft, 14, 'tab padding-left')
        near(tab.h, ds ? 36 : 38.4, 'tab height (line 1.6 + 7px padding x2 + 2px underline, at least 36)')
        const tabSel = await css(page, '.db-tabs:not(.in) [role="tab"][aria-selected="true"]')
        if (ds) {
          expect(tabSel.backgroundColor).toBe(await token(page, '--lec-chip'))
          expect(tabSel.color).toBe(await token(page, '--lec-chip-text'))
        } else {
          expect(tabSel.color).toBe(text)
          expect(tabSel.fontWeight).toBe('700')
          expect([tabSel.borderBottomWidth, tabSel.borderBottomColor]).toEqual(['2px', await token(page, '--lec-accent')])
        }

        // compact buttons: 原型 .btn{font:600 13px;border-radius:var(--lec-radius-2)}, .btn.sm{min-height:28px;padding:2px 10px;
        // font-size:12.5px} (规格板 14.2 第 7 条: 34 / 28 px, radius-2); datasheet: 1.5px text border, mono, radius-1
        await go(page, 'look:theme')
        const sm = await css(page, '.db-btn.sm')
        near(sm.fontSize, 12.5, 'compact button font-size')
        expect(sm.fontWeight).toBe('600')
        near(sm.h, 28, 'compact button height')
        near(sm.paddingLeft, 10, 'compact button padding-left')
        expect(sm.borderTopLeftRadius).toBe(await token(page, ds ? '--lec-radius-1' : '--lec-radius-2', 'borderTopLeftRadius'))
        if (ds) {
          expect(HAIRLINE).toContain(sm.borderTopWidth)
          expect(sm.borderTopColor).toBe(text)
          expect(sm.fontFamily).toBe(await token(page, '--lec-font-mono', 'fontFamily'))
        }

        // status marks: 原型 .mk.ok{--mc:var(--lec-done)} (规格板 14.2 第 6 条: 正常 = --lec-done, 待处理 = --lec-accent)
        const ok = await css(page, '.dm[data-k="ok"]')
        expect(ok.backgroundColor).toBe(await token(page, '--lec-done'))
        expect(pageErrors).toEqual([])
      })

      test('inputs, block editor, buttons, changed-field bar, phone language labels and save bar (local author mode)', async ({ page, pageErrors }) => {
        test.skip(test.info().project.name !== 'dev', 'Editable fields and the save bar exist only in the local author mode (dev server)')
        await open(page, skin, vp, 'texts')
        const ds = skin === 'datasheet'
        const text = await token(page, '--lec-text')
        const accent = await token(page, '--lec-accent')

        // 原型 .fld input{font-size:16px;min-height:38px;border-radius:radius-2;background:surface;font-family:body};
        // focus: page bg + 1px inset accent ring (规格板 14.2 第 8 条); datasheet only an underline (1.5px text)
        const input = page.locator('input.db-in').first()
        const inp = await css(page, 'input.db-in')
        near(inp.fontSize, 16, 'input font-size')
        expect(px(inp.h)).toBeGreaterThanOrEqual(37.5)
        expect(inp.fontFamily).toBe(await token(page, '--lec-font-body', 'fontFamily'))
        if (ds) {
          expect([inp.borderTopWidth, inp.borderBottomColor]).toEqual(['0px', text])
          expect(HAIRLINE).toContain(inp.borderBottomWidth)
        } else {
          expect(inp.borderTopLeftRadius).toBe(await token(page, '--lec-radius-2', 'borderTopLeftRadius'))
          expect(inp.backgroundColor).toBe(await token(page, '--lec-surface'))
          await input.focus()
          const f = await css(page, 'input.db-in:focus')
          expect(f.backgroundColor).toBe(await token(page, '--lec-bg'))
          expect(f.boxShadow).toContain('inset')
          expect(f.boxShadow).toContain(accent)
        }
        // 原型 .pe-box{font-size:16px;line-height:1.85}
        const pe = await css(page, '.pe-box')
        near(pe.fontSize, 16, 'block editor font-size')
        near(pe.lineHeight, 29.6, 'block editor line-height')

        // buttons: 原型 .btn{font:600 13px;padding:5px 14px;min-height:34px;border-radius:radius-2} (规格板 14.2 第 7 条)
        const btn = await css(page, '[data-savebar] .db-btn')
        near(btn.fontSize, ds ? 12.5 : 13, 'button font-size')
        expect(btn.fontWeight).toBe('600')
        near(btn.h, 34, 'button height')
        near(btn.paddingLeft, 14, 'button padding-left')
        expect(btn.borderTopLeftRadius).toBe(await token(page, ds ? '--lec-radius-1' : '--lec-radius-2', 'borderTopLeftRadius'))

        // changed field: 原型 .fld.dirty input{border-left:3px solid accent}, datasheet 4px text (规格板 14.2 第 8 条)
        const before = await input.inputValue()
        await input.fill(`${before} e2e`)
        const dirty = await css(page, '.db-fld.dirty input.db-in')
        expect([dirty.borderLeftWidth, dirty.borderLeftColor]).toEqual(ds ? ['4px', text] : ['3px', accent])
        // the old bar drawn 7 px outside the field (::before, --lec-warning) is gone
        if (vp === 'desktop') expect((await css(page, '.db-fld.dirty')).before).toBe('')

        if (vp === 'phone') {
          // 原型 narrow .fld::before{content:attr(data-lang);font-size:11.5px}: each stacked field says its language
          const zh = await css(page, '.db-fld[data-lang]')
          expect(zh.before).toMatch(/^"(中文|English)"\|11\.5px$/)
          const en = await page.locator('.db-fld[data-lang="English"]').first().evaluate((e) => getComputedStyle(e, '::before').content)
          expect(en).toBe('"English"')
          // 原型 .savebar: one row (status + discard + preview + save), about 55 px high on a 375 px phone
          const bar = await css(page, '[data-savebar]')
          near(bar.h, 55, 'phone save bar height')
        }
        if (ds) {
          // 原型 .th-datasheet .savebar{border-top:2px solid text;background:bg}
          const bar = await css(page, '[data-savebar]')
          expect([bar.borderTopWidth, bar.borderTopColor]).toEqual(['2px', text])
        }
        await page.locator('[data-texts-discard]').click()
        await expect(input).toHaveValue(before)
        expect(pageErrors).toEqual([])
      })
    })
  }
}

test('narrow breakpoint is 720 px: nav column at 760, page picker at 700 (规格板 14.2 第 2 条)', async ({ page }) => {
  await open(page, 'reader', 'desktop', 'overview')
  await page.setViewportSize({ width: 760, height: 900 })
  await expect(page.locator('.db-side')).toBeVisible()
  await expect(page.locator('.db-navsel')).toBeHidden()
  await page.setViewportSize({ width: 700, height: 900 })
  await expect(page.locator('.db-side')).toBeHidden()
  await expect(page.locator('.db-navsel')).toBeVisible()
})

/**
 * Styles for markup that lives on the DA line (s6y-fda d757e062) and is not on this branch yet: the snippets below are
 * that branch's markup, injected into the page, so the rules are checked now; once merged the same selectors are on
 * the real pages (the pending block and the sign-in link are only used here when the page does not have them already).
 */
for (const skin of ['reader', 'datasheet'] as const) {
  test(`DA markup · ${skin}: over-limit input, link button, pending mark, save-bar clearance`, async ({ page, pageErrors }) => {
    await open(page, skin, 'desktop', 'overview')
    const ds = skin === 'datasheet'
    const danger = await token(page, '--lec-danger')

    // 2) 登录门「去登录」 = <a class="db-btn primary"> (DashboardPage.vue on DA): no underline, a 34 px button like the others
    if (!(await page.locator('a.db-btn').count())) {
      await page.evaluate(() => {
        const host = document.querySelector('.lec-dashboard .db-ph')!
        host.insertAdjacentHTML('beforeend', '<div class="db-btns" data-e2e-da><a class="db-btn primary" href="#overview" data-dashboard-login>去登录</a><button type="button" class="db-btn">重试</button></div>')
      })
    }
    const a = await css(page, 'a.db-btn')
    // inside the .db-btns flex row an inline-flex item is blockified to `flex`; either way it is a flex box
    expect(['inline-flex', 'flex']).toContain(a.display)
    expect(await page.locator('a.db-btn').first().evaluate((e) => getComputedStyle(e).alignItems)).toBe('center')
    expect(await page.locator('a.db-btn').first().evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('none')
    near(a.h, 34, 'link button height')
    await page.locator('a.db-btn').first().hover()
    expect(await page.locator('a.db-btn').first().evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('none')

    // 3) 概览「正在运行检查…」: [data-overview-todo-pending] reuses .db-empty with a .dm mark; mark and text share a centre line
    if (!(await page.locator('[data-overview-todo-pending]').count())) {
      await page.evaluate(() => {
        const host = document.querySelector('.lec-dashboard [data-overview-todo]')!
        host.insertAdjacentHTML('beforeend', '<div class="db-empty" data-overview-todo-pending data-e2e-da><span><span class="dm" data-k="off" aria-hidden="true"></span>正在运行检查…</span></div>')
      })
    }
    const box = await page.locator('[data-overview-todo-pending] > span').first().evaluate((s) => {
      const dm = s.querySelector('.dm')!.getBoundingClientRect()
      const r = s.getBoundingClientRect()
      return { dm: dm.top + dm.height / 2, line: r.top + r.height / 2, dmLeft: dm.left, spanLeft: r.left, w: r.width }
    })
    expect(Math.abs(box.dm - box.line), 'pending mark centred on the text line').toBeLessThanOrEqual(1.5)

    // 1) 超长: aria-invalid="true" on the field (PageTexts.vue on DA) → danger edge (reader all round, datasheet the underline)
    await page.evaluate(() => {
      const host = document.querySelector('.lec-dashboard .db-ph')!
      host.insertAdjacentHTML('beforeend', '<div class="db-fld" data-e2e-da><input class="db-in" aria-invalid="true" value="x"></div>')
    })
    const bad = await css(page, '[data-e2e-da] input.db-in[aria-invalid="true"]')
    expect(bad.borderBottomColor).toBe(danger)
    if (!ds) expect(bad.borderTopColor).toBe(danger)
    await page.locator('[data-e2e-da] input.db-in[aria-invalid="true"]').focus()
    expect((await css(page, '[data-e2e-da] input.db-in[aria-invalid="true"]')).borderBottomColor).toBe(danger)

    // 4) a page with a sticky save bar keeps scrolled-to content above it (scroll-padding-bottom ≥ the bar's ~57 px)
    await page.evaluate(() => {
      const host = document.querySelector('.lec-dashboard .db-page')!
      host.insertAdjacentHTML('beforeend', '<div class="db-savebar" data-e2e-da><span class="db-st">x</span></div>')
    })
    const pad = await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBottom)
    expect(px(pad)).toBeGreaterThanOrEqual(60)
    // the bar is sticky (its box follows the viewport), so check the block before it: 8 px margin on top of the 16 px page gap
    const airAbove = await page.locator('.db-page > .db-savebar[data-e2e-da]').evaluate((bar) => getComputedStyle(bar.previousElementSibling!).marginBottom)
    expect(airAbove, 'air between the last block and the save bar').toBe('8px')
    if (test.info().project.name === 'dev') {
      // the real one: companion › tools, where the bar follows the panels in .db-grid[data-companion-tools]
      await go(page, 'companion:tools')
      const real = await page.locator('[data-savebar="tools"]').evaluate((bar) => getComputedStyle(bar.previousElementSibling!).marginBottom)
      expect(real).toBe('8px')
    }
    expect(pageErrors).toEqual([])
  })
}
