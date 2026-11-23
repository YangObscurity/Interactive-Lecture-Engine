/**
 * Theme tokens (P2b): DTCG pack parsing, validator (missing / illegal / low contrast), three-layer
 * override precedence, compile output, and the contrast numbers of the two shipped themes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast, parseColor, toComponents } from '../../docs/.vitepress/theme/tokens/color'
import {
  CONTRACT_NAMES,
  REQUIRED_MODE_TOKENS,
  SHARED_TOKENS,
} from '../../docs/.vitepress/theme/tokens/contract'
import {
  applyLayer,
  checkContrast,
  contrastReport,
  findIllegal,
  parseThemePack,
  resolveTheme,
  type ThemeSource,
} from '../../docs/.vitepress/theme/tokens/pack'
import { compileThemes } from '../../docs/.vitepress/theme/tokens/compile'
import { buildThemes, ThemeBuildError, virtualModuleSource } from '../../docs/.vitepress/plugins/lectureThemePlugin.mts'

const THEMES_DIR = path.resolve(__dirname, '../../docs/.vitepress/themes')
const readPack = (id: string): unknown => JSON.parse(fs.readFileSync(path.join(THEMES_DIR, id, 'theme.json'), 'utf8'))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function pack(id: string): ThemeSource {
  const r = parseThemePack(readPack(id), id)
  expect(r.issues).toEqual([])
  return r.value
}
const reader = () => pack('reader')
const datasheet = () => pack('datasheet')

/** Values copied from the spec board THEMES (the approved spec). */
const SPEC = {
  reader: {
    light: { bg: '#FFFFFF', surface: '#F6F7F9', text: '#1F2328', 'text-muted': '#57606A', border: '#D5DBE1', accent: '#2155C4', 'on-accent': '#FFFFFF', done: '#1F8A4C', 'done-text': '#17703D', danger: '#C4302B', warning: '#9A6200' },
    dark: { bg: '#17191E', surface: '#1F232A', text: '#E2E5E9', 'text-muted': '#9AA3AE', border: '#2F353E', accent: '#7EA8FF', 'on-accent': '#17191E', done: '#4CC27A', 'done-text': '#5FD08B', danger: '#FF7B72', warning: '#E3B341' },
    sepia: { bg: '#F5ECD9', surface: '#EDE2CB', text: '#3A2F22', 'text-muted': '#665641', border: '#D9C9A8', accent: '#1E4FB0', 'on-accent': '#FFFFFF', done: '#1E7A43', 'done-text': '#17663A', danger: '#B12A25', warning: '#875600' },
    green: { bg: '#CCE8CF', surface: '#BFDFC3', text: '#1C2A1F', 'text-muted': '#3B4F3F', border: '#A3C7A8', accent: '#1A44A0', 'on-accent': '#FFFFFF', done: '#155F34', 'done-text': '#124F2B', danger: '#A3221E', warning: '#6E4600' },
  },
  datasheet: {
    light: { bg: '#F5F6F3', surface: '#FFFFFF', text: '#1C2B3A', 'text-muted': '#52606D', border: '#CBD2CC', accent: '#0F5B3E', 'on-accent': '#FFFFFF', done: '#A3822A', 'done-text': '#7A5F12', danger: '#B3261E', warning: '#7A5F12', chip: '#1C2B3A', 'chip-text': '#F5F6F3', 'chip-edge': '#1C2B3A' },
    dark: { bg: '#0F1D17', surface: '#15281F', text: '#E6ECE7', 'text-muted': '#9DB0A4', border: '#24392F', accent: '#4FB386', 'on-accent': '#0F1D17', done: '#D4B04E', 'done-text': '#D4B04E', danger: '#F07068', warning: '#D4B04E', chip: '#0A120E', 'chip-text': '#E6ECE7', 'chip-edge': '#24392F' },
  },
  catLight: ['#A04A1E', '#2856A8', '#0B6E8A', '#6A3FA0', '#A3305E', '#4A5560'],
  catDark: ['#E8915C', '#7FA6EC', '#5CC3DE', '#B497E8', '#EC8AB0', '#AEB8C2'],
} as const

describe('color', () => {
  it('parses hex and DTCG srgb objects; rejects alpha, junk and mismatched hex fallback', () => {
    expect(parseColor('#abc')).toMatchObject({ ok: true, hex: '#AABBCC' })
    expect(parseColor({ colorSpace: 'srgb', components: toComponents('#0F5B3E'), hex: '#0f5b3e' })).toMatchObject({ ok: true, hex: '#0F5B3E' })
    expect(parseColor({ colorSpace: 'oklch', components: [0.5, 0.1, 120], hex: '#336699' })).toMatchObject({ ok: true, hex: '#336699' })
    expect(parseColor({ colorSpace: 'srgb', components: [1, 0, 0], alpha: 0.5 }).ok).toBe(false)
    expect(parseColor({ colorSpace: 'srgb', components: [1, 0, 0], hex: '#00ff00' }).ok).toBe(false)
    expect(parseColor({ colorSpace: 'srgb', components: [2, 0, 0] }).ok).toBe(false)
    expect(parseColor('red').ok).toBe(false)
    expect(parseColor('#12345678').ok).toBe(false)
  })
  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5)
    // plan 变更记录: light --gold #A3822A on paper #F5F6F3 = 3.35
    expect(contrast('#A3822A', '#F5F6F3')).toBeCloseTo(3.35, 2)
  })
})

describe('shipped theme packs', () => {
  it('match the approved spec board values exactly', () => {
    for (const [id, modes] of [['reader', SPEC.reader], ['datasheet', SPEC.datasheet]] as const) {
      const src = pack(id)
      for (const [mode, values] of Object.entries(modes)) {
        for (const [token, hex] of Object.entries(values)) {
          expect(src.modes[mode]?.[token as keyof (typeof src.modes)[string]], `${id}.${mode}.${token}`).toBe(hex)
        }
      }
      for (const [mode, cats] of [['light', SPEC.catLight], ['dark', SPEC.catDark]] as const) {
        cats.forEach((hex, i) => expect(src.modes[mode]?.[`cat-${i + 1}` as 'cat-1']).toBe(hex))
      }
    }
    expect(reader().shared['status-radius']).toBe('50%')
    expect(datasheet().shared['status-radius']).toBe('1px')
    expect(datasheet().shared['heading-weight']).toBe('900')
    expect(datasheet().shared['radius-1']).toBe('2px')
  })

  it('tint presets inherit the light categories', () => {
    const r = resolveTheme(reader())
    expect(r.issues).toEqual([])
    expect(r.value?.tints).toEqual(['sepia', 'green'])
    expect(r.value?.modes.sepia?.['cat-4']).toBe(SPEC.catLight[3])
    expect(r.value?.modes.green?.bg).toBe('#CCE8CF')
  })

  it('every mode of both themes passes every contrast rule (text ≥ 4.5, marks ≥ 3)', () => {
    const rb = resolveTheme(reader())
    const rd = resolveTheme(datasheet(), reader())
    for (const t of [rb.value, rd.value]) {
      expect(t).not.toBeNull()
      const failures = contrastReport(t!).filter((r) => !r.pass)
      expect(failures, JSON.stringify(failures)).toEqual([])
    }
  })

  it('contrast numbers of the contract table (spec board §00) are stable', () => {
    const rd = resolveTheme(datasheet(), reader()).value!
    const rr = resolveTheme(reader()).value!
    const ratio = (t: typeof rr, mode: string, fg: string) =>
      contrastReport(t).find((r) => r.mode === mode && r.fg === fg && r.bg === 'bg')!.ratio
    // a few anchors (2 decimals, as printed on the board)
    expect(ratio(rd, 'light', 'done').toFixed(2)).toBe('3.35')
    expect(ratio(rd, 'light', 'cat-1').toFixed(2)).toBe('5.54')
    expect(ratio(rd, 'dark', 'cat-6').toFixed(2)).toBe('8.64')
    expect(ratio(rr, 'light', 'text').toFixed(1)).toBe('15.8')
    expect(ratio(rr, 'dark', 'accent')).toBeGreaterThan(4.5)
    expect(ratio(rr, 'green', 'text-muted')).toBeGreaterThan(4.5)
  })

  it('datasheet inherits nothing it defines itself, but inherits omitted shared tokens from reader', () => {
    const src = datasheet()
    delete src.shared['font-mono']
    const r = resolveTheme(src, reader())
    expect(r.value?.shared['font-mono']).toBe(reader().shared['font-mono'])
    expect(r.value?.shared['font-body']).toContain('Noto Serif SC Variable')
  })
})

describe('validator', () => {
  it('missing required token → error naming the token', () => {
    const doc = clone(readPack('datasheet')) as { modes: { dark: Record<string, unknown> } }
    delete doc.modes.dark['done-text']
    const parsed = parseThemePack(doc, 'datasheet')
    expect(parsed.issues).toEqual([])
    const r = resolveTheme(parsed.value, reader())
    expect(r.value).toBeNull()
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toMatchObject({ severity: 'error', code: 'missing-token', mode: 'dark', token: 'done-text' })
    expect(r.issues[0]!.message).toContain('--lec-done-text')
  })

  it('missing base mode and missing shared tokens without a base are errors', () => {
    const doc = clone(readPack('reader')) as { modes: Record<string, unknown>; shared: Record<string, unknown> }
    delete doc.modes.dark
    expect(parseThemePack(doc, 'reader').issues.some((i) => i.code === 'structure' && i.mode === 'dark')).toBe(true)
    const doc2 = clone(readPack('reader')) as { shared: Record<string, unknown> }
    delete doc2.shared['radius-2']
    const r = resolveTheme(parseThemePack(doc2, 'reader').value)
    expect(r.issues.map((i) => i.token)).toEqual(['radius-2'])
  })

  it('unknown tokens are rejected (contract is closed)', () => {
    const doc = clone(readPack('reader')) as { modes: { light: Record<string, unknown> } }
    doc.modes.light['paper'] = { $value: '#FFFFFF' }
    const issues = parseThemePack(doc, 'reader').issues
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ code: 'unknown-token', token: 'paper' })
  })

  it.each([
    ['url()', 'url(https://evil.example/x.png)'],
    ['expression()', 'expression(alert(1))'],
    ['var() nesting', 'var(--lec-accent)'],
    ['declaration break', '#fff; background: red'],
    ['block break', '#fff} body{display:none'],
  ])('illegal colour value: %s', (_label, value) => {
    const doc = clone(readPack('reader')) as { modes: { light: Record<string, unknown> } }
    doc.modes.light.accent = { $value: value }
    const issues = parseThemePack(doc, 'reader').issues
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'error', code: 'illegal-value', token: 'accent' })
  })

  it('illegal values in font stacks and DTCG objects are found deep', () => {
    expect(findIllegal(['Noto Sans', 'x) url(evil'])).not.toBeNull()
    expect(findIllegal({ colorSpace: 'srgb', hex: 'var(--x)' })).not.toBeNull()
    expect(findIllegal({ $description: 'a; b', $value: '#fff' })).toBeNull()
    const doc = clone(readPack('reader')) as { shared: Record<string, unknown> }
    doc.shared['font-body'] = { $type: 'fontFamily', $value: ['Inter', 'x;y'] }
    expect(parseThemePack(doc, 'reader').issues[0]).toMatchObject({ code: 'illegal-value', token: 'font-body' })
  })

  it('invalid (non-illegal) values are rejected with invalid-value', () => {
    const doc = clone(readPack('reader')) as { shared: Record<string, unknown>; modes: { light: Record<string, unknown> } }
    doc.shared['radius-1'] = { $type: 'dimension', $value: { value: 4, unit: 'em' } }
    doc.modes.light.text = { $value: 'black' }
    const codes = parseThemePack(doc, 'reader').issues.map((i) => `${i.code}:${i.token}`)
    expect(codes).toEqual(['invalid-value:radius-1', 'invalid-value:text'])
  })

  it('low contrast → warning, error when strict', () => {
    const src = reader()
    src.modes.light = { ...src.modes.light, 'text-muted': '#B0B0B0' }
    const t = resolveTheme(src).value!
    const warn = checkContrast(t)
    expect(warn.length).toBeGreaterThan(0)
    expect(warn.every((i) => i.severity === 'warning' && i.code === 'low-contrast')).toBe(true)
    expect(warn.some((i) => i.mode === 'light' && i.token === 'text-muted' && i.need === 4.5)).toBe(true)
    expect(checkContrast(t, 'error').every((i) => i.severity === 'error')).toBe(true)
  })
})

describe('three-layer overrides (pack → deployer → reader)', () => {
  it('later layers win, per token', () => {
    const base = datasheet()
    const deployer = applyLayer(base, { modes: { light: { accent: '#0B4F35', danger: '#9E2019' } } }, 'deployer')
    expect(deployer.issues).toEqual([])
    const readerLayer = applyLayer(deployer.value, { modes: { light: { accent: { $value: '#0A4530' } } } }, 'reader')
    expect(readerLayer.issues).toEqual([])
    const light = readerLayer.value.modes.light!
    expect(light.accent).toBe('#0A4530') // reader beats deployer
    expect(light.danger).toBe('#9E2019') // deployer beats pack
    expect(light.text).toBe(SPEC.datasheet.light.text) // pack value kept
    expect(base.modes.light!.accent).toBe(SPEC.datasheet.light.accent) // inputs not mutated
  })

  it('deployer may override shared tokens and add modes; reader may not', () => {
    const d = applyLayer(reader(), { shared: { 'radius-2': { value: 6, unit: 'px' } }, modes: { night: { bg: '#000000' } } }, 'deployer')
    expect(d.issues).toEqual([])
    expect(d.value.shared['radius-2']).toBe('6px')
    expect(d.value.modes.night).toEqual({ bg: '#000000' })

    const r = applyLayer(reader(), { shared: { 'font-body': ['Comic Sans MS'] }, modes: { night: { bg: '#000000' }, light: { 'accent-tint': '#EEEEEE' } } }, 'reader')
    expect(r.issues.map((i) => i.code).sort()).toEqual(['not-overridable', 'not-overridable', 'structure'])
    expect(r.value.shared['font-body']).toBe(reader().shared['font-body'])
    expect(r.value.modes.night).toBeUndefined()
  })

  it('reader values are parsed one by one; illegal ones are dropped, legal ones kept', () => {
    const r = applyLayer(reader(), { modes: { light: { bg: 'url(x)', surface: '#FAFAFA', text: 'var(--a)' } } }, 'reader')
    expect(r.issues.map((i) => `${i.code}:${i.token}`)).toEqual(['illegal-value:bg', 'illegal-value:text'])
    expect(r.value.modes.light!.surface).toBe('#FAFAFA')
    expect(r.value.modes.light!.bg).toBe(SPEC.reader.light.bg)
  })
})

describe('compile', () => {
  const themes = () => [resolveTheme(datasheet(), reader()).value!, resolveTheme(reader()).value!]

  it('emits every contract colour per mode and the default-theme fallback selectors', () => {
    const css = compileThemes(themes(), { defaultTheme: 'datasheet' })
    expect(css).toContain(':root:not([data-lec-theme]),\n:root[data-lec-theme="datasheet"] {')
    expect(css).toContain(':root.dark:not([data-lec-theme]),\n:root.dark[data-lec-theme="datasheet"] {')
    expect(css).toContain(':root[data-lec-theme="reader"][data-lec-tint="sepia"]:not(.dark) {')
    expect(css).toContain(':root[data-lec-size="20"] {\n  --lec-prose-size: 20px;')
    expect(css).toContain('--lec-prose-line-height: 2.212;')
    expect(css).toContain('--lec-math-inline-size: .81em;')
    expect(css).toContain('--lec-accent-tint: rgba(15, 91, 62, 0.08);')
    expect(css).toContain('--lec-accent-tint: rgba(79, 179, 134, 0.12);')
    expect(css).toContain('--lec-font-body: "Noto Serif SC Variable", "Noto Serif SC", "Songti SC", SimSun, serif;')
    for (const t of [...REQUIRED_MODE_TOKENS, ...SHARED_TOKENS]) expect(css).toContain(`--lec-${t}:`)
    // only contract names are emitted
    const names = new Set(css.match(/--lec-[a-z0-9-]+/g))
    for (const n of names) expect(CONTRACT_NAMES.has(n), n).toBe(true)
    // datasheet has no tints, so no datasheet tint selector
    expect(css).not.toMatch(/data-lec-theme="datasheet"\]\[data-lec-tint/)
  })

  it('is deterministic', () => {
    expect(compileThemes(themes(), { defaultTheme: 'datasheet' })).toBe(compileThemes(themes(), { defaultTheme: 'datasheet' }))
  })
})

describe('buildThemes (plugin entry)', () => {
  it('builds this site config: datasheet default + reader', () => {
    const r = buildThemes({ theme: 'datasheet', themes: ['reader'] }, { themesDir: THEMES_DIR, strict: true })
    expect(r.warnings).toEqual([])
    expect(r.runtime).toEqual({
      defaultTheme: 'datasheet',
      themes: [
        { id: 'datasheet', label: '器件手册', tints: [] },
        { id: 'reader', label: '阅读', tints: ['sepia', 'green'] },
      ],
    })
    expect(r.fonts).toEqual([
      '@fontsource-variable/noto-serif-sc/wght.css',
      '@fontsource-variable/noto-sans-sc/wght.css',
      '@fontsource/jetbrains-mono/400.css',
    ])
    expect(virtualModuleSource(r)).toContain('import "virtual:lecture-theme.css"')
  })

  it('a reader-only site ships no webfonts', () => {
    const r = buildThemes({ theme: 'reader' }, { themesDir: THEMES_DIR })
    expect(r.fonts).toEqual([])
    expect(virtualModuleSource(r)).not.toContain('@fontsource')
  })

  it('invalid deployer override fails the build, naming the token', () => {
    expect(() =>
      buildThemes({ theme: 'datasheet', themeOverrides: { datasheet: { modes: { light: { accent: 'url(x)' } } } } }, { themesDir: THEMES_DIR }),
    ).toThrowError(/--lec-accent/)
    try {
      buildThemes({ theme: 'datasheet', themeOverrides: { datasheet: { modes: { light: { accent: 'url(x)' } } } } }, { themesDir: THEMES_DIR })
    } catch (e) {
      expect(e).toBeInstanceOf(ThemeBuildError)
    }
  })

  it('low-contrast deployer override: warning normally, error under strict', () => {
    const cfg = { theme: 'datasheet' as const, themeOverrides: { datasheet: { modes: { light: { 'text-muted': '#AAB0A8' } } } } }
    const r = buildThemes(cfg, { themesDir: THEMES_DIR, strict: false })
    expect(r.warnings.some((w) => w.token === 'text-muted')).toBe(true)
    expect(() => buildThemes(cfg, { themesDir: THEMES_DIR, strict: true })).toThrowError(/text-muted/)
  })
})
