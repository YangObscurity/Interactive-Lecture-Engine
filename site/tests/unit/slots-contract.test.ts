/**
 * Component slots, build side (P2e): the `engine` / `components` fields of theme.json, the registry, the virtual module
 * `virtual:lecture-components`, `themePacks` (load, id clash), the example pack and the doctor note.
 * One error case per rule of docs-dev/SLOTS.md
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkComponentsDeclaration,
  engineSatisfies,
  parseEngineRange,
  packPathProblem,
  RESERVED_SLOT_NAMES,
  SLOT_CONTRACT_VERSION,
  SLOT_DEFAULT_FILES,
  SLOT_NAMES,
  SLOT_VERSIONS,
} from '../../docs/.vitepress/theme/slots/contract.ts'
import { SLOTS } from '../../docs/.vitepress/theme/slots/registry.ts'
import { parseThemePack } from '../../docs/.vitepress/theme/tokens/pack'
import { buildThemes, componentsModuleSource, ThemeBuildError } from '../../docs/.vitepress/plugins/lectureThemePlugin.mts'
import { LectureConfigError, validateLectureConfig, type LectureConfig } from '../../docs/.vitepress/lecture-config.mts'
import { checkThemePacks } from '../../scripts/config/doctor.mts'

const SITE = path.resolve(__dirname, '../..')
const THEMES_DIR = path.join(SITE, 'docs/.vitepress/themes')
const EXAMPLE_REL = 'tests/fixtures/theme-packs/minimal-slot'
const EXTENSION = 'org.lecture-engine'

const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
const examplePack = (): Record<string, unknown> => readJson(path.join(SITE, EXAMPLE_REL, 'theme.json'))

/** The example pack's document with edits applied to its extension block. */
function packDoc(edit: (meta: Record<string, unknown>) => void): unknown {
  const doc = structuredClone(examplePack()) as { $extensions: Record<string, Record<string, unknown>> }
  edit(doc.$extensions[EXTENSION] as Record<string, unknown>)
  return doc
}
const messages = (doc: unknown): string[] => parseThemePack(doc, 'minimal-slot').issues.map((i) => i.message)

describe('slot contract data', () => {
  it('names, versions and default files describe the same slots as the registry', () => {
    expect([...SLOT_NAMES]).toEqual(Object.keys(SLOT_VERSIONS))
    expect([...SLOT_NAMES]).toEqual(Object.keys(SLOT_DEFAULT_FILES))
    expect([...SLOT_NAMES]).toEqual(Object.keys(SLOTS))
    for (const n of SLOT_NAMES) expect(SLOTS[n].version).toBe(SLOT_VERSIONS[n])
    expect(SLOT_CONTRACT_VERSION).toBe(1)
  })

  it('all 18 slots including P5 reading slots, WP-F3 SearchPanel and WP-F4 NavCourseMenu are registered and nothing remains reserved', () => {
    expect([...SLOT_NAMES]).toEqual([
      'SidebarStatus',
      'AtlasCenter',
      'AtlasCategory',
      'AtlasGroup',
      'AtlasPhase',
      'AtlasLecture',
      'AtlasLink',
      'GroupCard',
      'GroupMap',
      'CanvasGroup',
      'CanvasNode',
      'CanvasEdge',
      'CanvasBackdrop',
      'LectureTitleBlock',
      'FigureFrame',
      'QuizHeader',
      'SearchPanel',
      'NavCourseMenu',
    ])
    expect([...RESERVED_SLOT_NAMES]).toEqual([])
  })

  it('every default implementation file exists', () => {
    for (const n of SLOT_NAMES) expect(fs.existsSync(path.join(SITE, 'docs/.vitepress/theme/slots', SLOT_DEFAULT_FILES[n])), n).toBe(true)
  })
})

describe('engine range', () => {
  it('accepts only ^<major>', () => {
    expect(parseEngineRange('^1')).toEqual({ ok: true, major: 1 })
    expect(parseEngineRange('^12')).toEqual({ ok: true, major: 12 })
    for (const bad of ['1', '^1.2', '>=1', '~1', '^', '^01', '', ' ', 1, null, undefined, '^1 || ^2']) {
      expect(parseEngineRange(bad).ok, String(bad)).toBe(false)
    }
  })

  it('matches the engine contract version by major', () => {
    expect(engineSatisfies('^1')).toBe(true)
    expect(engineSatisfies('^2')).toBe(false)
    expect(engineSatisfies('^0')).toBe(false)
    expect(engineSatisfies('^2', 2)).toBe(true)
    expect(engineSatisfies('garbage')).toBe(false)
  })
})

describe('components declaration (lexical rules)', () => {
  it('a valid declaration has no issue; token-only packs need neither field', () => {
    expect(checkComponentsDeclaration({ engine: '^1', components: { SidebarStatus: './components/SidebarStatus.vue' } })).toEqual([])
    expect(checkComponentsDeclaration({})).toEqual([])
    expect(checkComponentsDeclaration({ engine: '^1' })).toEqual([])
  })

  it('pack paths must be relative .vue files that stay inside the pack', () => {
    expect(packPathProblem('./a/b.vue')).toBeNull()
    expect(packPathProblem('a/../b.vue')).toBeNull()
    for (const bad of ['../x.vue', 'a/../../x.vue', '/abs/x.vue', 'C:/x.vue', 'C:\\x.vue', 'https://h/x.vue', './x.ts', './x', '', 7]) {
      expect(packPathProblem(bad), String(bad)).not.toBeNull()
    }
  })
})

describe('theme.json: engine and components', () => {
  it('the example pack and the two built-in packs parse without issue', () => {
    expect(parseThemePack(examplePack(), 'minimal-slot').issues).toEqual([])
    expect(parseThemePack(readJson(path.join(THEMES_DIR, 'datasheet/theme.json')), 'datasheet').issues).toEqual([])
    expect(parseThemePack(readJson(path.join(THEMES_DIR, 'reader/theme.json')), 'reader').issues).toEqual([])
    const ok = parseThemePack(examplePack(), 'minimal-slot').value
    expect(ok.engine).toBe('^1')
    expect(ok.components).toEqual({ SidebarStatus: './components/SidebarStatus.vue' })
  })

  it('error: engine range not satisfied (names the theme, the range and the engine version)', () => {
    const msg = messages(packDoc((m) => (m.engine = '^2')))
    expect(msg).toHaveLength(1)
    expect(msg[0]).toContain('minimal-slot')
    expect(msg[0]).toContain('"^2"')
    expect(msg[0]).toContain('slot contract 1')
  })

  it('error: engine is not of the form ^major', () => {
    const msg = messages(packDoc((m) => (m.engine = '>=1')))
    expect(msg.join('\n')).toMatch(/"engine".*\^<major version>/)
  })

  it('error: components without engine', () => {
    const msg = messages(packDoc((m) => delete m.engine))
    expect(msg).toHaveLength(1)
    expect(msg[0]).toMatch(/"components" needs "engine"/)
  })

  it('error: unknown slot name lists every slot', () => {
    const msg = messages(packDoc((m) => (m.components = { Bogus: './a.vue' })))
    expect(msg).toHaveLength(1)
    expect(msg[0]).toContain('unknown slot "Bogus"')
    for (const n of SLOT_NAMES) expect(msg[0]).toContain(n)
  })

  it('P5 reading slots (LectureTitleBlock, FigureFrame, QuizHeader) accept valid pack components', () => {
    const msg = messages(
      packDoc((m) => {
        m.components = {
          LectureTitleBlock: './components/LectureTitleBlock.vue',
          FigureFrame: './components/FigureFrame.vue',
          QuizHeader: './components/QuizHeader.vue',
        }
      }),
    )
    expect(msg).toEqual([])
  })

  it('error: component path escapes the pack folder', () => {
    const msg = messages(packDoc((m) => (m.components = { SidebarStatus: '../../outside.vue' })))
    expect(msg).toHaveLength(1)
    expect(msg[0]).toMatch(/SidebarStatus.*leaves the pack folder/)
  })

  it('error: component path is absolute, not .vue, or not a string', () => {
    expect(messages(packDoc((m) => (m.components = { SidebarStatus: 'C:/x/y.vue' }))).join()).toMatch(/relative path/)
    expect(messages(packDoc((m) => (m.components = { SidebarStatus: './y.ts' }))).join()).toMatch(/\.vue file/)
    expect(messages(packDoc((m) => (m.components = { SidebarStatus: 3 }))).join()).toMatch(/non-empty string/)
  })

  it('error: components is not an object', () => {
    expect(messages(packDoc((m) => (m.components = ['./a.vue']))).join()).toMatch(/"components" must be an object/)
    expect(messages(packDoc((m) => (m.components = 'x'))).join()).toMatch(/"components" must be an object/)
  })

  it('a pack with tokens only (no engine, no components) behaves as before', () => {
    const doc = packDoc((m) => {
      delete m.engine
      delete m.components
    })
    const r = parseThemePack(doc, 'minimal-slot')
    expect(r.issues).toEqual([])
    expect(r.value.engine).toBeNull()
    expect(r.value.components).toEqual({})
  })
})

// ---------------------------------------------------------------------------- build (files on disk)

const tmpRoots: string[] = []
afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true })
})

/** A throw-away `site/` with one pack folder; `edit` changes the pack's extension block before it is written. */
function sitePack(opts: { folder?: string; edit?: (meta: Record<string, unknown>) => void; files?: Record<string, string> } = {}): { siteDir: string; rel: string } {
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-slots-'))
  tmpRoots.push(siteDir)
  const rel = opts.folder ?? 'packs/mine'
  const dir = path.join(siteDir, rel)
  fs.mkdirSync(path.join(dir, 'components'), { recursive: true })
  const doc = structuredClone(examplePack()) as { $extensions: Record<string, Record<string, unknown>> }
  const meta = doc.$extensions[EXTENSION] as Record<string, unknown>
  meta.id = 'mine'
  opts.edit?.(meta)
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(doc))
  const files = opts.files ?? { 'components/SidebarStatus.vue': '<template><span /></template>' }
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), body)
  }
  return { siteDir, rel }
}

function build(config: LectureConfig, siteDir = SITE) {
  return buildThemes(config, { themesDir: THEMES_DIR, siteDir, strict: false })
}
const buildError = (config: LectureConfig, siteDir?: string): string => {
  try {
    build(config, siteDir)
  } catch (e) {
    expect(e).toBeInstanceOf(ThemeBuildError)
    return (e as Error).message
  }
  throw new Error('expected the build to fail')
}

describe('themePacks and build-time component checks', () => {
  it('registers a pack: its id can be the default or an enabled theme, and it compiles like a built-in', () => {
    const r = build({ theme: 'reader', themes: ['minimal-slot'], themePacks: [EXAMPLE_REL] })
    expect(r.themes.map((t) => t.id)).toEqual(['reader', 'minimal-slot'])
    expect(r.runtime.themes.map((t) => t.id)).toEqual(['reader', 'minimal-slot'])
    // inherits the shared tokens of reader and gets its own selector block
    expect(r.css).toContain(':root[data-lec-theme="minimal-slot"]')
    expect(r.themes[1]?.shared['status-radius']).toBe(r.themes[0]?.shared['status-radius'])
    const pack = r.packs.find((p) => p.id === 'minimal-slot')
    expect(pack?.builtin).toBe(false)
    expect(pack?.components.SidebarStatus).toBe(path.join(SITE, EXAMPLE_REL, 'components', 'SidebarStatus.vue'))
    const asDefault = build({ theme: 'minimal-slot', themePacks: [EXAMPLE_REL] })
    expect(asDefault.runtime.defaultTheme).toBe('minimal-slot')
    expect(asDefault.css).toContain(':root:not([data-lec-theme])')
  })

  it('an unregistered pack id fails (pack not found)', () => {
    expect(buildError({ theme: 'reader', themes: ['minimal-slot'] })).toMatch(/theme pack not found/)
  })

  it('error: pack id equals a built-in theme', () => {
    const { siteDir, rel } = sitePack({ edit: (m) => (m.id = 'datasheet') })
    expect(buildError({ theme: 'reader', themePacks: [rel] }, siteDir)).toMatch(/pack id "datasheet" is a built-in theme/)
  })

  it('error: two packs with the same id', () => {
    const a = sitePack()
    const second = path.join(a.siteDir, 'packs/other')
    fs.cpSync(path.join(a.siteDir, a.rel), second, { recursive: true })
    expect(buildError({ theme: 'reader', themePacks: [a.rel, 'packs/other'] }, a.siteDir)).toMatch(/pack id "mine" is already used/)
  })

  it('error: pack folder without theme.json', () => {
    const { siteDir } = sitePack()
    expect(buildError({ theme: 'reader', themePacks: ['packs/missing'] }, siteDir)).toMatch(/no theme\.json/)
  })

  it('error: component file does not exist', () => {
    const { siteDir, rel } = sitePack({ files: {} })
    const msg = buildError({ theme: 'mine', themePacks: [rel] }, siteDir)
    expect(msg).toMatch(/theme "mine": components\.SidebarStatus: file not found/)
  })

  it('error: component path leaves the pack folder (lexically)', () => {
    const { siteDir, rel } = sitePack({ edit: (m) => (m.components = { SidebarStatus: '../escape.vue' }) })
    fs.writeFileSync(path.join(siteDir, 'packs', 'escape.vue'), '<template><i /></template>')
    expect(buildError({ theme: 'mine', themePacks: [rel] }, siteDir)).toMatch(/leaves the pack folder/)
  })

  it('error: engine range not met fails the build with theme, range and engine version', () => {
    const { siteDir, rel } = sitePack({ edit: (m) => (m.engine = '^2') })
    const msg = buildError({ theme: 'mine', themePacks: [rel] }, siteDir)
    expect(msg).toContain('theme "mine"')
    expect(msg).toContain('"^2"')
    expect(msg).toMatch(/slot contract 1/)
  })

  it('error: unknown slot name fails the build and lists the slots', () => {
    const { siteDir, rel } = sitePack({ edit: (m) => (m.components = { Nope: './components/SidebarStatus.vue' }) })
    const msg = buildError({ theme: 'mine', themePacks: [rel] }, siteDir)
    expect(msg).toContain('unknown slot "Nope"')
    expect(msg).toContain('SidebarStatus')
  })

  it('error: components without engine fails the build', () => {
    const { siteDir, rel } = sitePack({ edit: (m) => delete m.engine })
    expect(buildError({ theme: 'mine', themePacks: [rel] }, siteDir)).toMatch(/"components" needs "engine"/)
  })

  it('config validation: themePacks must be an array of relative, distinct folders', () => {
    const bad = (themePacks: unknown): void => {
      expect(() => validateLectureConfig({ theme: 'reader', themePacks } as LectureConfig)).toThrowError(LectureConfigError)
    }
    bad('docs/x')
    bad([1])
    bad([''])
    bad(['C:/x'])
    bad(['/abs'])
    bad(['a/b', 'a/b/'])
    expect(() => validateLectureConfig({ theme: 'reader', themePacks: ['a/b', 'c'] })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------- virtual module

describe('virtual:lecture-components', () => {
  const datasheetFile = path.join(THEMES_DIR, 'datasheet/components/SidebarStatus.vue').replace(/\\/g, '/')
  const defaultFile = path.join(SITE, 'docs/.vitepress/theme/slots/default/SidebarStatus.vue').replace(/\\/g, '/')
  const packFile = path.join(SITE, EXAMPLE_REL, 'components/SidebarStatus.vue').replace(/\\/g, '/')
  /** The file of the lazy SidebarStatus entry for `impl` in the generated module, read back from it (not rebuilt as code). */
  const lazyFileOf = (src: string, impl: string): string | null => {
    const head = `"SidebarStatus": { impl: "${impl}", load: () => import(`
    const tail = ').then((m) => m.default) }'
    const at = src.indexOf(head)
    if (at < 0) return null
    const end = src.indexOf(tail, at + head.length)
    return end < 0 ? null : (JSON.parse(src.slice(at + head.length, end)) as string)
  }

  it('default theme with components: statically imported; the fallback of the other theme is the lazy engine default', () => {
    const src = componentsModuleSource(build({ theme: 'datasheet', themes: ['reader'] }))
    expect(src).toContain(`import __static0 from ${JSON.stringify(datasheetFile)}`)
    expect(src).toContain('export const SLOT_DEFAULT_THEME = "datasheet"')
    expect(src).toMatch(/export const SLOT_STATIC = \{\s*"SidebarStatus": \{ impl: "datasheet", component: __static0 \}/)
    // datasheet reuses the static binding, never a second dynamic import of the same file
    expect(src).toContain('"SidebarStatus": { impl: "datasheet", load: () => Promise.resolve(__static0) }')
    // reader declares no components: engine default, loaded on demand
    expect(lazyFileOf(src, 'default')).toBe(defaultFile)
    // one static import per slot of the datasheet pack: SidebarStatus, six atlas slots, GroupCard, GroupMap
    expect(src.match(/import __static/g)).toHaveLength(SLOT_NAMES.length)
  })

  it('default theme without components: the engine default is the static one; a pack with components loads lazily', () => {
    const src = componentsModuleSource(build({ theme: 'reader', themes: ['datasheet'] }))
    expect(src).toContain(`import __static0 from ${JSON.stringify(defaultFile)}`)
    expect(src).toContain('"SidebarStatus": { impl: "default", load: () => Promise.resolve(__static0) }')
    expect(lazyFileOf(src, 'datasheet')).toBe(datasheetFile)
  })

  it('a theme that covers no slot maps every slot to the engine default', () => {
    const src = componentsModuleSource(build({ theme: 'reader' }))
    expect(src).toMatch(/"reader": \{\s*"SidebarStatus": \{ impl: "default"/)
    expect(src).not.toContain('import(')
  })

  it('the example pack is a lazy implementation next to a default theme without components', () => {
    const src = componentsModuleSource(build({ theme: 'reader', themes: ['minimal-slot'], themePacks: [EXAMPLE_REL] }))
    expect(lazyFileOf(src, 'minimal-slot')).toBe(packFile)
  })

  it('has an entry for every slot of every enabled theme', () => {
    const src = componentsModuleSource(build({ theme: 'datasheet', themes: ['reader', 'minimal-slot'], themePacks: [EXAMPLE_REL] }))
    for (const theme of ['datasheet', 'reader', 'minimal-slot']) {
      const block = new RegExp(`"${theme}": \\{\\s*"SidebarStatus":`)
      expect(src, theme).toMatch(block)
    }
  })
})

// ---------------------------------------------------------------------------- doctor

describe('doctor: theme packs', () => {
  it('flags a pack with components as code and reports the component count', () => {
    const r = checkThemePacks({ theme: 'reader', themes: ['minimal-slot'], themePacks: [EXAMPLE_REL] }, SITE)
    const pack = r.find((t) => t.id === 'minimal-slot')
    expect(pack).toMatchObject({ builtin: false, enabled: true, engine: '^1', hasCode: true, note: '含代码（1 个组件）', errors: [] })
    const reader = r.find((t) => t.id === 'reader')
    expect(reader).toMatchObject({ builtin: true, hasCode: false, note: null, errors: [] })
  })

  it('the built-in datasheet theme brings one component', () => {
    const r = checkThemePacks({ theme: 'datasheet', themes: ['reader'] }, SITE)
    // built-in packs are part of the engine: components listed, but no third-party trust note
    expect(r.find((t) => t.id === 'datasheet')).toMatchObject({ hasCode: true, note: null, errors: [] })
  })

  it('gives the same verdict as the build for an engine range that is not met and for a missing file', () => {
    const a = sitePack({ edit: (m) => (m.engine = '^2') })
    const t1 = checkThemePacks({ theme: 'reader', themePacks: [a.rel] }, a.siteDir).find((t) => t.id === 'mine')
    expect(t1?.errors.join()).toMatch(/"\^2".*slot contract 1/)
    const b = sitePack({ files: {} })
    const t2 = checkThemePacks({ theme: 'reader', themePacks: [b.rel] }, b.siteDir).find((t) => t.id === 'mine')
    expect(t2?.errors.join()).toMatch(/文件不存在/)
    const c = sitePack({ edit: (m) => (m.components = { Bogus: './components/SidebarStatus.vue' }) })
    expect(checkThemePacks({ theme: 'reader', themePacks: [c.rel] }, c.siteDir).find((t) => t.id === 'mine')?.errors.join()).toMatch(/unknown slot "Bogus"/)
    const d = sitePack({ edit: (m) => delete m.engine })
    expect(checkThemePacks({ theme: 'reader', themePacks: [d.rel] }, d.siteDir).find((t) => t.id === 'mine')?.errors.join()).toMatch(/needs "engine"/)
  })

  it('reports a pack id that repeats a built-in theme and an enabled theme nobody provides', () => {
    const a = sitePack({ edit: (m) => (m.id = 'reader') })
    expect(checkThemePacks({ theme: 'reader', themePacks: [a.rel] }, a.siteDir).some((t) => t.errors.some((e) => e.includes('与内置主题重复')))).toBe(true)
    const ghost = checkThemePacks({ theme: 'reader', themes: ['ghost'] }, SITE).find((t) => t.id === 'ghost')
    expect(ghost?.errors[0]).toMatch(/未找到/)
  })
})
