/**
 * theme/tokens/compile.ts — resolved themes → one stylesheet of `--lec-*` custom properties (pure).
 *
 * Selector scheme (all on <html>; VitePress owns the `.dark` class):
 *
 *   :root                                              engine tokens (typography contract, spacing)
 *   :root:not([data-lec-theme]), [data-lec-theme=D]   default theme D, light (no-JS fallback)
 *   :root[data-lec-theme="X"]                          theme X shared + light
 *   :root.dark[data-lec-theme="X"]                     theme X dark
 *   :root[data-lec-theme="X"][data-lec-tint="T"]:not(.dark)   reader tint preset T
 *   :root[data-lec-theme="X"][data-lec-font="serif|sans"]     body font switch
 *   :root[data-lec-size="N"]                           reader font-size step
 *
 * Attributes are written before first paint by the inline <head> script (prefs.ts), so there is no
 * flash and nothing for Vue to hydrate.
 */
import { DEFAULT_PROSE_SIZE, ENGINE_VALUES, MODE_TOKENS, PROSE_SIZES, SHARED_TOKENS, type ModeToken } from './contract'
import type { ResolvedTheme } from './pack'

function block(selectors: string[], decls: Array<[string, string]>): string {
  if (decls.length === 0) return ''
  return `${selectors.join(',\n')} {\n${decls.map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n`
}

function modeDecls(values: Record<ModeToken, string>, dark: boolean): Array<[string, string]> {
  const out: Array<[string, string]> = MODE_TOKENS.map((t) => [`--lec-${t}`, values[t]])
  out.push(['color-scheme', dark ? 'dark' : 'light'])
  return out
}

export interface CompileOptions {
  /** Theme used when <html> has no data-lec-theme (first paint without JS). */
  defaultTheme: string
  /** Optional banner comment. */
  banner?: string
}

export function compileThemes(themes: ResolvedTheme[], opts: CompileOptions): string {
  const parts: string[] = []
  if (opts.banner) parts.push(`/* ${opts.banner.replace(/\*\//g, '* /')} */\n`)

  // engine tokens
  parts.push(block([':root'], Object.entries(ENGINE_VALUES).map(([k, v]) => [`--lec-${k}`, v])))

  for (const th of themes) {
    const sel = `:root[data-lec-theme="${th.id}"]`
    const isDefault = th.id === opts.defaultTheme
    const light = th.modes.light
    const dark = th.modes.dark
    if (!light || !dark) throw new Error(`compileThemes: theme "${th.id}" is not resolved (light/dark missing)`)
    const sharedDecls: Array<[string, string]> = SHARED_TOKENS.map((t) => [`--lec-${t}`, th.shared[t]])
    parts.push(
      block(isDefault ? [':root:not([data-lec-theme])', sel] : [sel], [...sharedDecls, ...modeDecls(light, false)]),
    )
    parts.push(block(isDefault ? [':root.dark:not([data-lec-theme])', `:root.dark[data-lec-theme="${th.id}"]`] : [`:root.dark[data-lec-theme="${th.id}"]`], modeDecls(dark, true)))
    for (const tint of th.tints) {
      const v = th.modes[tint]
      if (v) parts.push(block([`${sel}[data-lec-tint="${tint}"]:not(.dark)`], modeDecls(v, false)))
    }
    parts.push(block([`${sel}[data-lec-font="serif"]`], [['--lec-font-body', th.shared['font-body-serif']]]))
    parts.push(block([`${sel}[data-lec-font="sans"]`], [['--lec-font-body', th.shared['font-body-sans']]]))
  }

  for (const size of PROSE_SIZES) {
    if (size === DEFAULT_PROSE_SIZE) continue
    parts.push(block([`:root[data-lec-size="${size}"]`], [['--lec-prose-size', `${size}px`]]))
  }
  return parts.filter(Boolean).join('\n')
}
