/**
 * plugins/lectureThemePlugin.mts — build-time theme pack compiler.
 *
 *   lecture.config.ts ─┐
 *   themes/<id>/theme.json ─► parse + validate ─► pack → deployer overrides ─► resolve ─► CSS
 *
 * - `buildThemes()` runs when config.mts loads (so the inline <head> script can embed the theme
 *   list) and throws on any error, naming the token: missing required token, unknown token,
 *   illegal / invalid value. Contrast below the floors is a warning, an error when
 *   `LECTURE_THEME_STRICT=1` or `--strict` is on the command line.
 * - The Vite plugin serves three virtual modules:
 *     `virtual:lecture-theme`      JS: imports fonts of enabled themes, their theme.css and the
 *                                  compiled tokens; exports `THEME_RUNTIME`
 *     `virtual:lecture-theme.css`  the compiled `--lec-*` stylesheet
 *     `virtual:lecture-components` JS (P2e): the slot components of every enabled theme; the site default
 *                                  theme's are imported statically (SSR), the others load on demand
 * - P2e: `lecture.config.ts` `themePacks` registers third-party pack folders; a pack's `components` are
 *   validated here (known slot, file exists, stays inside the pack folder) and `engine` is checked against
 *   the slot contract version.
 *   and recompiles on theme.json changes in dev (full reload).
 *
 * The pure logic lives in theme/tokens/* and is reused at runtime (P6 reader imports).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import {
  applyLayer,
  checkContrast,
  formatIssue,
  EXTENSION_KEY,
  parseThemePack,
  resolveTheme,
  type ResolvedTheme,
  type ThemeIssue,
  type ThemeSource,
} from '../theme/tokens/pack'
import { compileThemes } from '../theme/tokens/compile'
import type { ThemeRuntime } from '../theme/tokens/prefs'
import { BUILTIN_THEME_IDS, enabledThemes, type LectureConfig } from '../lecture-config.mts'
import { DEFAULT_LAYOUT_EDGES, SLOT_DEFAULT_FILES, SLOT_NAMES, type LayoutEdgeStyle, type SlotName } from '../theme/slots/contract.ts'

export const VIRTUAL_JS = 'virtual:lecture-theme'
export const VIRTUAL_CSS = 'virtual:lecture-theme.css'
export const VIRTUAL_COMPONENTS = 'virtual:lecture-components'
const RESOLVED_JS = '\0virtual:lecture-theme'
const RESOLVED_COMPONENTS = '\0virtual:lecture-components'
/** Path-like id so Vite's CSS pipeline treats it as a stylesheet (same trick as `virtual:uno.css`). */
const RESOLVED_CSS = '/__lecture-theme.css'

/** Theme every other pack inherits omitted shared tokens from (spec board §00). */
export const BASE_THEME = 'reader'

export interface BuildThemesOptions {
  themesDir: string
  strict?: boolean
  /** Folder `themePacks` entries are relative to (`site/`). Default: three levels above `themesDir`. */
  siteDir?: string
  /** Folder of the slot runtime (engine default components). Default: `../theme/slots` next to `themesDir`. */
  slotsDir?: string
}

/** Where a theme pack lives and what code it brings (doctor and the virtual module read this). */
export interface ThemePackInfo {
  id: string
  dir: string
  builtin: boolean
  engine: string | null
  /** Slot -> absolute component file (only the slots the pack overrides). */
  components: Record<string, string>
  /** `layout.edges` (the engine default when the pack declares none). */
  edges: LayoutEdgeStyle
}

export interface BuildThemesResult {
  css: string
  runtime: ThemeRuntime
  themes: ResolvedTheme[]
  /** theme.css files of enabled themes (absolute paths) */
  themeCss: string[]
  /** font CSS module specifiers of enabled themes */
  fonts: string[]
  warnings: ThemeIssue[]
  /** files the result depends on (for dev watching) */
  files: string[]
  /** Enabled packs, default theme first. */
  packs: ThemePackInfo[]
  /** The site default theme id (its slot components are imported statically). */
  defaultTheme: string
  /** Absolute engine default component per slot. */
  slotDefaults: Record<SlotName, string>
}

export class ThemeBuildError extends Error {
  constructor(public readonly issues: ThemeIssue[]) {
    super(`[lecture-theme] theme validation failed:\n  ${issues.map((i) => formatIssue(i)).join('\n  ')}`)
    this.name = 'ThemeBuildError'
  }
}

export function isStrict(): boolean {
  return process.env.LECTURE_THEME_STRICT === '1' || process.argv.includes('--strict')
}

function emptySource(id: string): ThemeSource {
  return { id, label: id, skin: null, fonts: [], engine: null, components: {}, edges: null, shared: {}, modes: {} }
}

function loadPack(dir: string, id: string, files: string[]): { source: ThemeSource; issues: ThemeIssue[] } {
  const file = path.join(dir, 'theme.json')
  files.push(file)
  if (!fs.existsSync(file)) {
    return {
      source: emptySource(id),
      issues: [{ severity: 'error', code: 'structure', theme: id, message: `theme pack not found: ${file}` }],
    }
  }
  let doc: unknown
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return {
      source: emptySource(id),
      issues: [{ severity: 'error', code: 'structure', theme: id, message: `${file}: invalid JSON (${(e as Error).message})` }],
    }
  }
  const r = parseThemePack(doc, id)
  return { source: r.value, issues: r.issues }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** The `id` a pack folder declares, without validating the rest (the full parse happens in `loadPack`). */
function declaredId(dir: string): { id: string } | { error: string } {
  const file = path.join(dir, 'theme.json')
  if (!fs.existsSync(file)) return { error: `theme pack folder has no theme.json: ${dir}` }
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { $extensions?: Record<string, { id?: unknown } | undefined> }
    const id = doc.$extensions?.[EXTENSION_KEY]?.id
    if (typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id)) return { id }
    return { error: `${file}: $extensions["${EXTENSION_KEY}"].id must be a lowercase identifier` }
  } catch (e) {
    return { error: `${file}: invalid JSON (${(e as Error).message})` }
  }
}

/** `themePacks` -> id -> folder. Pack ids must not repeat a built-in theme or another pack. */
export function locatePacks(config: LectureConfig, siteDir: string, files: string[], errors: ThemeIssue[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const rel of config.themePacks ?? []) {
    const dir = path.resolve(siteDir, rel)
    const d = declaredId(dir)
    if ('error' in d) {
      errors.push({ severity: 'error', code: 'structure', theme: rel, message: `themePacks "${rel}": ${d.error}` })
      continue
    }
    if ((BUILTIN_THEME_IDS as readonly string[]).includes(d.id)) {
      errors.push({ severity: 'error', code: 'structure', theme: d.id, message: `themePacks "${rel}": pack id "${d.id}" is a built-in theme; choose another id` })
      continue
    }
    const known = out.get(d.id)
    if (known !== undefined) {
      errors.push({ severity: 'error', code: 'structure', theme: d.id, message: `themePacks "${rel}": pack id "${d.id}" is already used by ${known}` })
      continue
    }
    out.set(d.id, dir)
    files.push(path.join(dir, 'theme.json'))
  }
  return out
}

/** Resolve a pack's `components` to absolute files; errors name the theme, the slot and the path. */
function resolveComponents(source: ThemeSource, dir: string, files: string[], errors: ThemeIssue[]): Record<string, string> {
  const out: Record<string, string> = {}
  const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : dir
  for (const [slot, rel] of Object.entries(source.components)) {
    const abs = path.resolve(dir, rel)
    const fail = (message: string) =>
      errors.push({ severity: 'error', code: 'slots', theme: source.id, token: slot, message: `theme "${source.id}": components.${slot}: ${message}` })
    if (!isInside(dir, abs)) {
      fail(`${JSON.stringify(rel)} leaves the pack folder`)
      continue
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      fail(`file not found: ${abs}`)
      continue
    }
    if (!isInside(realDir, fs.realpathSync(abs))) {
      fail(`${JSON.stringify(rel)} resolves outside the pack folder (symbolic link)`)
      continue
    }
    out[slot] = abs
    files.push(abs)
  }
  return out
}

/** Compile every enabled theme. Throws `ThemeBuildError` on errors (and on warnings when strict). */
export function buildThemes(config: LectureConfig, opts: BuildThemesOptions): BuildThemesResult {
  const strict = opts.strict ?? isStrict()
  const files: string[] = []
  const errors: ThemeIssue[] = []
  const warnings: ThemeIssue[] = []
  const ids = enabledThemes(config)
  const siteDir = opts.siteDir ?? path.resolve(opts.themesDir, '..', '..', '..')
  const slotsDir = opts.slotsDir ?? path.resolve(opts.themesDir, '..', 'theme', 'slots')
  const packDirs = locatePacks(config, siteDir, files, errors)
  const dirOf = (id: string): string => packDirs.get(id) ?? path.join(opts.themesDir, id)

  const base = loadPack(dirOf(BASE_THEME), BASE_THEME, files)
  errors.push(...base.issues.filter((i) => i.severity === 'error'))

  const themes: ResolvedTheme[] = []
  const packs: ThemePackInfo[] = []
  for (const id of ids) {
    const pack = id === BASE_THEME ? base : loadPack(dirOf(id), id, files)
    if (id !== BASE_THEME) errors.push(...pack.issues.filter((i) => i.severity === 'error'))
    packs.push({
      id,
      dir: dirOf(id),
      builtin: !packDirs.has(id),
      engine: pack.source.engine,
      components: resolveComponents(pack.source, dirOf(id), files, errors),
      edges: pack.source.edges ?? DEFAULT_LAYOUT_EDGES,
    })
    const layered = applyLayer(pack.source, config.themeOverrides?.[id], 'deployer')
    errors.push(...layered.issues)
    const resolved = resolveTheme(layered.value, id === BASE_THEME ? undefined : base.source)
    errors.push(...resolved.issues.filter((i) => i.severity === 'error'))
    if (!resolved.value) continue
    const low = checkContrast(resolved.value, strict ? 'error' : 'warning')
    if (strict) errors.push(...low)
    else warnings.push(...low)
    themes.push(resolved.value)
  }
  if (errors.length) throw new ThemeBuildError(errors)

  const css = compileThemes(themes, {
    defaultTheme: config.theme,
    banner: `generated by plugins/lectureThemePlugin.mts from themes/{${ids.join(',')}}/theme.json — do not edit`,
  })
  const themeCss: string[] = []
  for (const id of ids) {
    const f = path.join(dirOf(id), 'theme.css')
    if (fs.existsSync(f)) themeCss.push(f)
  }
  const slotDefaults = Object.fromEntries(SLOT_NAMES.map((n) => [n, path.resolve(slotsDir, SLOT_DEFAULT_FILES[n])])) as Record<SlotName, string>
  return {
    css,
    runtime: {
      defaultTheme: config.theme,
      themes: themes.map((t) => ({ id: t.id, label: t.label, tints: t.tints })),
    },
    themes,
    themeCss,
    fonts: [...new Set(themes.flatMap((t) => t.fonts))],
    warnings,
    files,
    packs,
    defaultTheme: config.theme,
    slotDefaults,
  }
}

function toImportPath(file: string): string {
  return file.replace(/\\/g, '/')
}

export function virtualModuleSource(result: BuildThemesResult): string {
  return [
    ...result.fonts.map((f) => `import ${JSON.stringify(f)}`),
    `import ${JSON.stringify(VIRTUAL_CSS)}`,
    ...result.themeCss.map((f) => `import ${JSON.stringify(toImportPath(f))}`),
    `export const THEME_RUNTIME = ${JSON.stringify(result.runtime)}`,
  ].join('\n')
}

/**
 * `virtual:lecture-components` (P2e): `{ [themeId]: { [slot]: { impl, load } } }` plus the site default theme id.
 * Components of the default theme are imported statically so SSR renders them; every other target loads on
 * demand, except a file that is already static (reused through `Promise.resolve`, so it is never in two chunks).
 * A theme that does not cover a slot maps it to the engine default implementation (`impl: "default"`).
 */
export function componentsModuleSource(result: BuildThemesResult): string {
  const target = (themeId: string, slot: SlotName): { impl: string; file: string } => {
    const own = result.packs.find((p) => p.id === themeId)?.components[slot]
    return own ? { impl: themeId, file: own } : { impl: 'default', file: result.slotDefaults[slot] }
  }
  const staticFiles = new Map<string, string>()
  for (const slot of SLOT_NAMES) {
    const { file } = target(result.defaultTheme, slot)
    if (!staticFiles.has(file)) staticFiles.set(file, `__static${staticFiles.size}`)
  }
  const lines: string[] = []
  for (const [file, name] of staticFiles) lines.push(`import ${name} from ${JSON.stringify(toImportPath(file))}`)
  lines.push(`export const SLOT_DEFAULT_THEME = ${JSON.stringify(result.defaultTheme)}`)
  lines.push('export const SLOT_STATIC = {')
  for (const slot of SLOT_NAMES) {
    const { impl, file } = target(result.defaultTheme, slot)
    lines.push(`  ${JSON.stringify(slot)}: { impl: ${JSON.stringify(impl)}, component: ${staticFiles.get(file)} },`)
  }
  lines.push('}')
  lines.push(`export const THEME_LAYOUT = ${JSON.stringify(Object.fromEntries(result.packs.map((p) => [p.id, { edges: p.edges }])))}`)
  lines.push('export const SLOT_COMPONENTS = {')
  for (const pack of result.packs) {
    lines.push(`  ${JSON.stringify(pack.id)}: {`)
    for (const slot of SLOT_NAMES) {
      const { impl, file } = target(pack.id, slot)
      const bound = staticFiles.get(file)
      const load = bound ? `() => Promise.resolve(${bound})` : `() => import(${JSON.stringify(toImportPath(file))}).then((m) => m.default)`
      lines.push(`    ${JSON.stringify(slot)}: { impl: ${JSON.stringify(impl)}, load: ${load} },`)
    }
    lines.push('  },')
  }
  lines.push('}')
  return lines.join('\n')
}

export interface LectureThemePluginOptions extends BuildThemesOptions {
  config: LectureConfig
  /** Result computed at config load (avoids compiling twice). */
  initial?: BuildThemesResult
}

export function lectureThemePlugin(options: LectureThemePluginOptions): Plugin {
  let result = options.initial ?? buildThemes(options.config, options)
  let warned = false
  return {
    name: 'lecture-theme',
    enforce: 'pre',
    buildStart() {
      if (warned) return
      warned = true
      for (const w of result.warnings) this.warn(formatIssue(w))
    },
    resolveId(id) {
      if (id === VIRTUAL_JS) return RESOLVED_JS
      if (id === VIRTUAL_COMPONENTS) return RESOLVED_COMPONENTS
      if (id === VIRTUAL_CSS || id === RESOLVED_CSS) return RESOLVED_CSS
      return null
    },
    load(id) {
      if (id === RESOLVED_JS) return virtualModuleSource(result)
      if (id === RESOLVED_COMPONENTS) return componentsModuleSource(result)
      if (id === RESOLVED_CSS) return result.css
      return null
    },
    configureServer(server) {
      for (const f of result.files) server.watcher.add(f)
      server.watcher.on('change', (file) => {
        const norm = path.resolve(file)
        if (!result.files.some((f) => path.resolve(f) === norm)) return
        try {
          result = buildThemes(options.config, options)
          for (const w of result.warnings) server.config.logger.warn(formatIssue(w))
        } catch (e) {
          server.config.logger.error(e instanceof Error ? e.message : String(e))
          return
        }
        for (const id of [RESOLVED_CSS, RESOLVED_JS, RESOLVED_COMPONENTS]) {
          const mod = server.moduleGraph.getModuleById(id)
          if (mod) server.moduleGraph.invalidateModule(mod)
        }
        server.ws.send({ type: 'full-reload' })
      })
    },
  }
}
