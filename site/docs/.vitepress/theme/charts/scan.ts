/**
 * charts/scan.ts — find chart placeholders and claim them SYNCHRONOUSLY (before the first await).
 *
 * V1 d48d0cc4: a placeholder is marked (`data-rendered` / `data-mermaid-rendered`) in the same tick
 * it is found, so a concurrent or repeated scan can never pick it up twice (mermaid double render).
 *
 * Re-entry on the same DOM: an element claimed by a generation that has since been disposed is
 * "stale" and is claimed again (its instances were disposed, so it must be redrawn). Elements marked
 * by anybody else (no owner) are left alone.
 */
import { CHART_INLINE_MERMAID } from '../../site.config.mts'

export interface InlineMermaidConfig {
  readonly enabled: boolean
  readonly selectors: readonly string[]
  readonly className: string
  readonly keepSource: boolean
}

export interface ClaimHooks {
  /** true when `el` was claimed by a generation that is no longer live. */
  isStale(el: Element): boolean
  /** record the claim for the current generation. */
  own(el: Element): void
}

export const INLINE_SOURCE = 'inline-mermaid'

export function isInlineFigure(el: Element): boolean {
  return (el as HTMLElement).dataset?.source === INLINE_SOURCE
}

const noStale: ClaimHooks = { isStale: () => false, own: () => {} }

/** Sidecar placeholders: `figure.chart` not yet rendered (or stale). Never the modal's own figure. */
export function claimSidecarFigures(root: ParentNode, hooks: ClaimHooks = noStale): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const fig of Array.from(root.querySelectorAll<HTMLElement>('figure.chart'))) {
    if (isInlineFigure(fig)) continue
    if (fig.classList.contains('chart--modal') || fig.closest('.chart-modal')) continue
    if (fig.dataset.rendered !== undefined && !hooks.isStale(fig)) continue
    fig.dataset.rendered = '1'
    hooks.own(fig)
    out.push(fig)
  }
  return out
}

/** Remove generated inline-mermaid figures left behind by a disposed generation (re-entry). */
export function removeStaleInlineFigures(root: ParentNode, hooks: ClaimHooks): number {
  let n = 0
  for (const fig of Array.from(root.querySelectorAll<HTMLElement>('figure.chart'))) {
    if (!isInlineFigure(fig) || !hooks.isStale(fig)) continue
    fig.remove()
    n++
  }
  return n
}

/**
 * Fenced ```mermaid blocks to upgrade into figures (selectors from `CHART_INLINE_MERMAID`).
 * Claimed blocks get `data-mermaid-rendered="1"`. A block whose previous sibling already is an
 * inline-mermaid card was taken over before: it is marked and hidden, not converted again.
 */
export function claimInlineMermaidBlocks(
  root: ParentNode,
  cfg: InlineMermaidConfig = CHART_INLINE_MERMAID,
  hooks: ClaimHooks = noStale,
): HTMLElement[] {
  if (!cfg.enabled || !cfg.selectors.length) return []
  const seen = new Set<HTMLElement>()
  const out: HTMLElement[] = []
  for (const block of Array.from(root.querySelectorAll<HTMLElement>(cfg.selectors.join(', ')))) {
    if (seen.has(block)) continue
    seen.add(block)
    if (block.dataset.mermaidRendered !== undefined && !hooks.isStale(block)) continue
    if (block.closest('.chart-code') || block.closest('figure.chart')) continue
    const prev = block.previousElementSibling
    if (prev && prev.classList.contains(cfg.className) && !hooks.isStale(prev)) {
      block.dataset.mermaidRendered = '1'
      block.style.display = 'none'
      continue
    }
    block.dataset.mermaidRendered = '1'
    hooks.own(block)
    out.push(block)
  }
  return out
}
