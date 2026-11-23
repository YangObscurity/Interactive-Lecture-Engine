/**
 * renderers/wavedrom.ts — WaveJSON → SVG (lazy `import('wavedrom')`).
 * Supports dark mode by dynamically switching between default and dark skins (FE-030).
 */
import { currentLang, translate } from '../../../i18n/index.ts'
import { bindInlineFit, chartBody, showError } from '../dom'
import { nextSeq } from '../state'
import type { Disposer } from '../state'
import { isDarkTheme } from './mermaid'
import type { RenderEnv } from './types'

interface WaveDromLike {
  renderWaveForm(index: number, source: unknown, prefix: string): void
  waveSkin?: unknown
}

let wavedromPromise: Promise<WaveDromLike> | null = null
let originalDefaultSkin: unknown = null

function loadWaveDrom(): Promise<WaveDromLike> {
  if (!wavedromPromise) {
    wavedromPromise = import('wavedrom')
      .then((mod: unknown) => {
        const m = mod as WaveDromLike & { default?: WaveDromLike }
        const inst = m.default && typeof m.default.renderWaveForm === 'function' ? m.default : m
        if (!originalDefaultSkin && inst.waveSkin) {
          const ws = inst.waveSkin as { default?: unknown }
          originalDefaultSkin = ws.default ?? ws
        }
        return inst
      })
      .catch((err: unknown) => {
        wavedromPromise = null
        throw err
      })
  }
  return wavedromPromise
}

let darkSkinPromise: Promise<unknown> | null = null
function loadDarkSkin(): Promise<unknown> {
  if (!darkSkinPromise) {
    darkSkinPromise = import('wavedrom/skins/dark.js')
      .then((mod: unknown) => {
        const raw = (mod as { default?: unknown }).default ?? mod
        const dark = (raw as { dark?: unknown })?.dark ?? (raw as { default?: unknown })?.default ?? raw
        return dark ?? null
      })
      .catch((err: unknown) => {
        darkSkinPromise = null
        throw err
      })
  }
  return darkSkinPromise
}

export async function renderWavedrom(fig: HTMLElement, code: string, env: RenderEnv): Promise<Disposer | null> {
  const body = chartBody(fig)
  if (!body) throw new Error('chart-body missing')
  const WD = await loadWaveDrom()
  if (env.signal.aborted) return null

  const isDark = isDarkTheme()
  const darkSkin = isDark ? await loadDarkSkin() : null
  if (env.signal.aborted) return null

  const defaultSkin = originalDefaultSkin ?? (WD.waveSkin as { default?: unknown })?.default ?? WD.waveSkin
  const win = window as unknown as { WaveSkin?: { default?: unknown; dark?: unknown } }
  const activeSkin = isDark && darkSkin ? darkSkin : defaultSkin
  win.WaveSkin = {
    default: activeSkin,
    dark: darkSkin ?? defaultSkin,
  }
  if (WD && typeof WD === 'object') {
    (WD as { waveSkin?: unknown }).waveSkin = win.WaveSkin
  }

  if (!win.WaveSkin.default) {
    showError(body, translate(currentLang(), 'chart.wavedrom.skinMissing'))
    return null
  }
  let src: unknown
  try {
    src = JSON.parse(code)
  } catch {
    showError(body, translate(currentLang(), 'chart.wavedrom.sourceFailed'))
    return null
  }
  const prefix = 'wd_' + nextSeq() + '_'
  body.innerHTML = ''
  const holder = document.createElement('div')
  holder.id = prefix + '0'
  body.appendChild(holder)
  try {
    WD.renderWaveForm(0, src, prefix)
  } catch (e) {
    const msg = (e instanceof Error && e.message) || String(e)
    showError(body, translate(currentLang(), 'chart.wavedrom.renderFailed', { message: String(msg).slice(0, 160) }))
    return null
  }

  // WaveDrom insertSVGTemplate hardcodes a white background rect (style="stroke:none;fill:white").
  // Set it to transparent so the container background (--lec-bg / --vp-c-bg-soft) shines through.
  const bgRect = holder.querySelector<SVGRectElement>('rect[style*="fill:white"], rect[style*="fill: white"]')
  if (bgRect) {
    bgRect.style.fill = 'transparent'
  }

  return bindInlineFit(fig, body)
}
