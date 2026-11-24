/**
 * theme/tokens/prefs.ts — reader-level theme preferences (third override layer, plumbing only).
 *
 * Stored in localStorage `lecture:reader-prefs` as JSON `{ theme?, tint?, fontSize?, bodyFont? }`.
 * They are applied as attributes on <html> (see compile.ts for the selectors):
 *
 *   data-lec-theme  enabled theme id (falls back to the deployer default)
 *   data-lec-tint   reader tint preset other than light/dark (only themes that ship it)
 *   data-lec-size   16 / 18 / 20 (17 = contract default, no attribute)
 *   data-lec-font   serif / sans
 *
 * Two implementations of the same rules, kept equivalent by tests/unit/theme-prefs.test.ts:
 *   - `headScript(runtime)`: tiny inline <head> script → correct first frame, nothing to hydrate;
 *   - `applyPrefs(root, prefs, runtime)`: used after hydration (debug panel now, settings panel P6).
 *
 * The `dark` tint is VitePress' own appearance (html.dark, key `vitepress-theme-appearance`); the
 * `light` tint is "no tint". Neither is written as data-lec-tint.
 */
import { STORAGE_KEYS } from '../../site.config.mts'
import { DEFAULT_PROSE_SIZE, PROSE_SIZES, READER_OVERRIDABLE, type ProseSize } from './contract'

export const PREFS_STORAGE_KEY: string = STORAGE_KEYS.readerPrefs
export const GROUP_DESC_ATTR = 'data-lec-desc'

export type BodyFont = 'serif' | 'sans'

export interface ReaderPrefs {
  theme?: string
  tint?: string
  fontSize?: ProseSize
  bodyFont?: BodyFont
}

/** Build-time facts the client needs (emitted by the theme plugin as `virtual:lecture-theme`). */
export interface ThemeRuntime {
  defaultTheme: string
  defaultTint?: string | null
  defaultBase?: string | null
  customTint?: string | null
  /** Enabled themes, default first. */
  themes: Array<{ id: string; label: string; tints: string[] }>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Keep only well-formed fields (unknown / malformed fields are dropped, never thrown on). */
export function sanitizePrefs(raw: unknown): ReaderPrefs {
  if (!isRecord(raw)) return {}
  const out: ReaderPrefs = {}
  if (typeof raw.theme === 'string' && /^[a-z][a-z0-9-]*$/.test(raw.theme)) out.theme = raw.theme
  if (typeof raw.tint === 'string' && /^[a-z][a-z0-9-]*$/.test(raw.tint)) out.tint = raw.tint
  if (typeof raw.fontSize === 'number' && (PROSE_SIZES as readonly number[]).includes(raw.fontSize)) {
    out.fontSize = raw.fontSize as ProseSize
  }
  if (raw.bodyFont === 'serif' || raw.bodyFont === 'sans') out.bodyFont = raw.bodyFont
  return out
}

export interface PrefAttrs {
  'data-lec-theme': string
  'data-lec-tint': string | null
  'data-lec-size': string | null
  'data-lec-font': string | null
}

/** Pure: which attributes the prefs produce under a runtime (whitelists applied). */
export function prefAttrs(prefs: ReaderPrefs, rt: ThemeRuntime): PrefAttrs {
  const theme = rt.themes.find((t) => t.id === prefs.theme) ?? rt.themes.find((t) => t.id === rt.defaultTheme)
  const id = theme?.id ?? rt.defaultTheme
  const defaultTint = rt.defaultTint && theme?.tints.includes(rt.defaultTint) ? rt.defaultTint : null
  const tint = (prefs.tint && theme?.tints.includes(prefs.tint) ? prefs.tint : null) ?? (prefs.tint === undefined ? defaultTint : null)
  const size = prefs.fontSize && prefs.fontSize !== DEFAULT_PROSE_SIZE ? String(prefs.fontSize) : null
  return { 'data-lec-theme': id, 'data-lec-tint': tint, 'data-lec-size': size, 'data-lec-font': prefs.bodyFont ?? null }
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

export function readPrefs(): ReaderPrefs {
  try {
    const raw = storage()?.getItem(PREFS_STORAGE_KEY)
    return raw ? sanitizePrefs(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

/** Persist (merged with the stored prefs). `undefined` fields remove the setting. */
export function writePrefs(patch: Partial<Record<keyof ReaderPrefs, unknown>>): ReaderPrefs {
  const next: Record<string, unknown> = { ...readPrefs() }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete next[k]
    else next[k] = v
  }
  const clean = sanitizePrefs(next)
  try {
    const s = storage()
    if (s) {
      if (Object.keys(clean).length === 0) s.removeItem(PREFS_STORAGE_KEY)
      else s.setItem(PREFS_STORAGE_KEY, JSON.stringify(clean))
    }
  } catch {
    // quota / private mode: the attributes still apply for this page
  }
  return clean
}

export function applyPrefs(root: HTMLElement, prefs: ReaderPrefs, rt: ThemeRuntime): PrefAttrs {
  const attrs = prefAttrs(prefs, rt)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null) root.removeAttribute(name)
    else root.setAttribute(name, value)
  }
  return attrs
}

/**
 * S6Y F6 (audit-spec #12): which body font a theme uses when the reader chose none. Every theme compiles
 * `--lec-font-body` (its default) next to `--lec-font-body-serif` / `--lec-font-body-sans` (compile.ts), so the default
 * is whichever of the two the body font equals; a theme whose default is neither counts as sans unless it ends in `serif`.
 */
export function defaultBodyFont(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): BodyFont {
  const norm = (n: string) => style.getPropertyValue(n).trim().replace(/\s*,\s*/g, ',')
  const body = norm('--lec-font-body')
  if (body && body === norm('--lec-font-body-sans')) return 'sans'
  if (body && body === norm('--lec-font-body-serif')) return 'serif'
  return /(^|,)\s*serif$/.test(body) ? 'serif' : 'sans'
}

/**
 * S6Y F6 (audit-spec #22): VitePress renders its appearance switch on the server with `aria-checked="false"`; after a reload
 * in dark mode hydration keeps that stale attribute (Vue does not patch attribute mismatches in production), so the switch
 * reads "off" to a screen reader while the page is dark. Write the real state onto the switches after hydration and on
 * every change of `isDark`.
 */
export function syncAppearanceSwitch(dark: boolean, doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (!doc) return
  for (const el of doc.querySelectorAll('.VPSwitchAppearance')) el.setAttribute('aria-checked', dark ? 'true' : 'false')
}

/**
 * Inline <head> script source. All allowed values are baked in as literals, so the script never
 * writes anything that did not pass the same whitelist as `prefAttrs`, `customTint`, `themeLayer`,
 * and `groupDesc`. Applies all before first paint to prevent FOUC / hydration mismatch.
 */
export function headScript(rt: ThemeRuntime): string {
  const tints: Record<string, string[]> = {}
  for (const t of rt.themes) tints[t.id] = t.tints
  const sizes = PROSE_SIZES.filter((s) => s !== DEFAULT_PROSE_SIZE)
  const overridable = [...READER_OVERRIDABLE]
  return (
    `(function(){var d=document.documentElement,D=${JSON.stringify(rt.defaultTheme)},` +
    `T=${JSON.stringify(tints)},S=${JSON.stringify(sizes)},O=${JSON.stringify(overridable)},p={},s=null;` +
    `try{s=window.localStorage}catch(e){s=null}` +
    `try{if(s)p=JSON.parse(s.getItem(${JSON.stringify(PREFS_STORAGE_KEY)})||'{}')||{}}catch(e){}` +
    `var t=Object.prototype.hasOwnProperty.call(T,p.theme)?p.theme:D;d.setAttribute('data-lec-theme',t);` +
    `var defT=${JSON.stringify(rt.defaultTint ?? null)};` +
    `var dtn=(defT&&T[t].indexOf(defT)>=0)?defT:null;` +
    `var tn=p.tint!==undefined?(T[t].indexOf(p.tint)>=0?p.tint:null):dtn;` +
    `try{if(tn)d.setAttribute('data-lec-tint',tn);` +
    `if(${JSON.stringify(rt.defaultBase === 'dark')}&&(!s||!s.getItem('vitepress-theme-appearance')))d.classList.add('dark');` +
    `if(S.indexOf(p.fontSize)>=0)d.setAttribute('data-lec-size',String(p.fontSize));` +
    `if(p.bodyFont==='serif'||p.bodyFont==='sans')d.setAttribute('data-lec-font',p.bodyFont)}catch(e){}` +
    `try{if(s&&s.getItem(${JSON.stringify(STORAGE_KEYS.groupDesc)})==='0')d.setAttribute('data-lec-desc','closed');` +
    `else if(s)d.setAttribute('data-lec-desc','open')}catch(e){}` +
    `try{if(s){var lr=s.getItem(${JSON.stringify(STORAGE_KEYS.readerThemeLayer)});if(lr){var lo=JSON.parse(lr);` +
    `if(lo&&typeof lo==='object'&&lo.modes&&typeof lo.modes==='object'){` +
    `var ap=s.getItem('vitepress-theme-appearance'),dk=d.classList.contains('dark')||ap==='dark'||((!ap||ap==='auto')&&((${JSON.stringify(rt.defaultBase === 'dark')})||(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)));` +
    `var mk=dk?'dark':(tn&&lo.modes[tn]?tn:'light'),mv=lo.modes[mk]||lo.modes.light;` +
    `if(mv&&typeof mv==='object'){for(var i=0;i<O.length;i++){var k=O[i],v=mv[k];if(typeof v==='string'&&/^#[0-9a-fA-F]{3,8}$/.test(v))d.style.setProperty('--lec-'+k,v)}}}}}}catch(e){}` +
    `try{if(s&&t==='reader'){var cr=s.getItem(${JSON.stringify(STORAGE_KEYS.readerCustomTint)});if(cr){var co=JSON.parse(cr);` +
    `if(co&&typeof co.hue==='number'&&typeof co.lightness==='number'&&isFinite(co.hue)&&isFinite(co.lightness)){` +
    `var h=((Math.round(co.hue)%360)+360)%360,l=Math.max(8,Math.min(97,Math.round(co.lightness))),cdk=l<50;` +
    `function cl(v,a,b){return Math.max(a,Math.min(b,v))}` +
    `function rgb(H,S,L){H=((H%360)+360)%360;S/=100;L/=100;var C=(1-Math.abs(2*L-1))*S,X=C*(1-Math.abs((H/60)%2-1)),M=L-C/2,r=0,g=0,b=0;` +
    `if(H<60){r=C;g=X}else if(H<120){r=X;g=C}else if(H<180){g=C;b=X}else if(H<240){g=X;b=C}else if(H<300){r=X;b=C}else{r=C;b=X}` +
    `return[Math.round(cl((r+M)*255,0,255)),Math.round(cl((g+M)*255,0,255)),Math.round(cl((b+M)*255,0,255))]}` +
    `function hx(a){return'#'+((1<<24)+(a[0]<<16)+(a[1]<<8)+a[2]).toString(16).slice(1).toUpperCase()}` +
    `function lum(a){function c(v){v/=255;return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)}return 0.2126*c(a[0])+0.7152*c(a[1])+0.0722*c(a[2])}` +
    `function cr2(a,b){var l1=lum(a),l2=lum(b);return(Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)}` +
    `function sr(f,to,st,H,S,bg,m){for(var x=f;st>0?x<=to:x>=to;x+=st){var q=rgb(H,S,x);if(cr2(q,bg)>=m)return q}return null}` +
    `var bg=rgb(h,35,l),sf=rgb(h,32,cl(cdk?l+4:l-4,2,98)),bd=rgb(h,22,cl(cdk?l+12:l-14,2,98));` +
    `var tx=cdk?sr(80,98,2,h,18,bg,7):sr(30,4,-2,h,18,bg,7),mu=cdk?sr(56,96,2,h,12,bg,4.5):sr(44,4,-2,h,12,bg,4.5),ac=cdk?sr(62,92,2,220,75,bg,4.5):sr(44,10,-2,220,70,bg,4.5);` +
    `if(tx&&mu&&ac){var w=cdk?0.18:0.12,at=[Math.round(ac[0]*w+bg[0]*(1-w)),Math.round(ac[1]*w+bg[1]*(1-w)),Math.round(ac[2]*w+bg[2]*(1-w))],oa=cr2([255,255,255],ac)>=cr2([17,24,39],ac)?'#FFFFFF':'#111827';` +
    `d.style.setProperty('--lec-bg',hx(bg));d.style.setProperty('--lec-surface',hx(sf));d.style.setProperty('--lec-border',hx(bd));` +
    `d.style.setProperty('--lec-text',hx(tx));d.style.setProperty('--lec-text-muted',hx(mu));d.style.setProperty('--lec-accent',hx(ac));` +
    `d.style.setProperty('--lec-accent-tint',hx(at));d.style.setProperty('--lec-on-accent',oa);d.style.colorScheme=cdk?'dark':'light'}}}}}catch(e){}})()`
  )
}
