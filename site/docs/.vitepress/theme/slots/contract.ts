/**
 * theme/slots/contract.ts - the slot contract, pure data and checks (P2e, docs-dev/SLOTS.md).
 *
 * No imports on purpose: scripts/config/doctor.mts (plain node, no bundler) and the theme-pack parser both read
 * it. The runtime side (typed props, default implementations, `<LecSlot>`) lives next to it in registry.ts.
 *
 * Contract version rule (docs-dev/SLOTS.md): a change that old theme components cannot cope with (a prop removed,
 * renamed or retyped, a required prop added) raises SLOT_CONTRACT_VERSION. Adding an optional prop does not.
 */

/** Version of the slot contract this engine implements. A theme pack declares `"engine": "^1"`. */
export const SLOT_CONTRACT_VERSION = 1

/** Slots that exist today. P4 / P5 add the reserved names (see RESERVED_SLOT_NAMES) when they implement them. */
export const SLOT_NAMES = [
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
] as const
export type SlotName = (typeof SLOT_NAMES)[number]

/** Slots named in the slot design that are not implemented yet. A pack cannot use them. */
export const RESERVED_SLOT_NAMES = [] as const

/** Per-slot contract version (the props of a slot change independently of the others). */
export const SLOT_VERSIONS: Readonly<Record<SlotName, number>> = {
  SidebarStatus: 1,
  AtlasCenter: 1,
  AtlasCategory: 1,
  AtlasGroup: 1,
  AtlasPhase: 1,
  AtlasLecture: 1,
  AtlasLink: 1,
  GroupCard: 1,
  GroupMap: 1,
  CanvasGroup: 1,
  CanvasNode: 1,
  CanvasEdge: 1,
  CanvasBackdrop: 1,
  LectureTitleBlock: 1,
  FigureFrame: 1,
  QuizHeader: 1,
  SearchPanel: 1,
  NavCourseMenu: 1,
}

/** Engine default implementation of each slot, relative to this folder. */
export const SLOT_DEFAULT_FILES: Readonly<Record<SlotName, string>> = {
  SidebarStatus: './default/SidebarStatus.vue',
  AtlasCenter: './default/AtlasCenter.vue',
  AtlasCategory: './default/AtlasCategory.vue',
  AtlasGroup: './default/AtlasGroup.vue',
  AtlasPhase: './default/AtlasPhase.vue',
  AtlasLecture: './default/AtlasLecture.vue',
  AtlasLink: './default/AtlasLink.vue',
  GroupCard: './default/GroupCard.vue',
  GroupMap: './default/GroupMap.vue',
  CanvasGroup: './default/CanvasGroup.vue',
  CanvasNode: './default/CanvasNode.vue',
  CanvasEdge: './default/CanvasEdge.vue',
  CanvasBackdrop: './default/CanvasBackdrop.vue',
  LectureTitleBlock: './default/LectureTitleBlock.vue',
  FigureFrame: './default/FigureFrame.vue',
  QuizHeader: './default/QuizHeader.vue',
  SearchPanel: './default/SearchPanel.vue',
  NavCourseMenu: './default/NavCourseMenu.vue',
}

export function isSlotName(name: string): name is SlotName {
  return (SLOT_NAMES as readonly string[]).includes(name)
}

export type EngineRangeResult = { ok: true; major: number } | { ok: false; reason: string }

/** Parse a slot-contract range. Only the caret form `^<major>` is accepted. */
export function parseEngineRange(range: unknown): EngineRangeResult {
  if (typeof range !== 'string') return { ok: false, reason: 'must be a string like "^1"' }
  const m = /^\^(0|[1-9]\d*)$/.exec(range.trim())
  if (!m) return { ok: false, reason: `${JSON.stringify(range)} is not of the form "^<major version>" (for example "^1")` }
  return { ok: true, major: Number(m[1]) }
}

/** True when the engine (contract version `version`) satisfies `range`. A malformed range never matches. */
export function engineSatisfies(range: unknown, version: number = SLOT_CONTRACT_VERSION): boolean {
  const r = parseEngineRange(range)
  return r.ok && r.major === Math.floor(version)
}

export interface ComponentsIssue {
  /** Which part of the declaration is wrong. */
  code: 'engine-missing' | 'engine-range' | 'engine-mismatch' | 'components-shape' | 'unknown-slot' | 'bad-path'
  message: string
  slot?: string
}

/**
 * A pack path must be a relative `.vue` path that stays inside the pack folder. The check is lexical
 * (the build also resolves symlinks): no absolute path, no drive letter, no `..` that climbs out.
 */
export function packPathProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'must be a non-empty string'
  if (/^[a-zA-Z]:|^[\\/]|^\w+:\/\//.test(value)) return `${JSON.stringify(value)} must be a relative path inside the pack folder`
  if (value.includes('\0')) return 'contains a NUL character'
  if (!/\.vue$/.test(value)) return `${JSON.stringify(value)} must point to a .vue file`
  let depth = 0
  for (const part of value.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') depth--
    else depth++
    if (depth < 0) return `${JSON.stringify(value)} leaves the pack folder`
  }
  return null
}

/**
 * Check the `engine` and `components` fields of a theme.json extension block. Pure: file existence is the
 * build's business. Returns every problem found, in a stable order.
 */
export function checkComponentsDeclaration(meta: { engine?: unknown; components?: unknown }): ComponentsIssue[] {
  const issues: ComponentsIssue[] = []
  const hasEngine = meta.engine !== undefined
  const hasComponents = meta.components !== undefined
  if (hasEngine) {
    const r = parseEngineRange(meta.engine)
    if (!r.ok) issues.push({ code: 'engine-range', message: `"engine" ${r.reason}` })
    else if (r.major !== SLOT_CONTRACT_VERSION) {
      issues.push({
        code: 'engine-mismatch',
        message: `requires slot contract ${JSON.stringify(meta.engine)} but this engine implements slot contract ${SLOT_CONTRACT_VERSION}`,
      })
    }
  }
  if (hasComponents) {
    const c = meta.components
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      issues.push({ code: 'components-shape', message: '"components" must be an object { "<SlotName>": "./path/Component.vue" }' })
    } else {
      if (!hasEngine) {
        issues.push({ code: 'engine-missing', message: '"components" needs "engine": "^1" (the slot contract version the components were written for)' })
      }
      for (const [slot, file] of Object.entries(c)) {
        if (!isSlotName(slot)) {
          const reserved = (RESERVED_SLOT_NAMES as readonly string[]).includes(slot)
          issues.push({
            code: 'unknown-slot',
            slot,
            message: `unknown slot "${slot}"${reserved ? ' (reserved, not implemented yet)' : ''}; slots are: ${SLOT_NAMES.join(', ')}`,
          })
          continue
        }
        const problem = packPathProblem(file)
        if (problem) issues.push({ code: 'bad-path', slot, message: `components.${slot}: ${problem}` })
      }
    }
  }
  return issues
}

// ---- layout (P4a WP-H3) --------------------------------------------------------------------------------------------

/**
 * `layout` of a theme.json extension block: how the engine lays out what it draws, as opposed to what the components look
 * like. `edges` is the line style of the group page's lecture map: `curve` (default) or `orthogonal` (right angles).
 */
export const LAYOUT_EDGE_STYLES = ['curve', 'orthogonal'] as const
export type LayoutEdgeStyle = (typeof LAYOUT_EDGE_STYLES)[number]
export const DEFAULT_LAYOUT_EDGES: LayoutEdgeStyle = 'curve'
export const LAYOUT_FIELDS = ['edges'] as const

export function isLayoutEdgeStyle(v: unknown): v is LayoutEdgeStyle {
  return typeof v === 'string' && (LAYOUT_EDGE_STYLES as readonly string[]).includes(v)
}

export interface LayoutIssue {
  code: 'layout-shape' | 'layout-unknown-field' | 'layout-edges'
  message: string
}

/** Check the `layout` field of a theme.json extension block (absent is fine). Pure. */
export function checkLayoutDeclaration(meta: { layout?: unknown }): LayoutIssue[] {
  if (meta.layout === undefined) return []
  const l = meta.layout
  if (!l || typeof l !== 'object' || Array.isArray(l)) return [{ code: 'layout-shape', message: '"layout" must be an object like { "edges": "orthogonal" }' }]
  const issues: LayoutIssue[] = []
  for (const [k, v] of Object.entries(l)) {
    if (!(LAYOUT_FIELDS as readonly string[]).includes(k)) {
      issues.push({ code: 'layout-unknown-field', message: `layout.${k} is not a layout field; fields are: ${LAYOUT_FIELDS.join(', ')}` })
    } else if (k === 'edges' && !isLayoutEdgeStyle(v)) {
      issues.push({ code: 'layout-edges', message: `layout.edges ${JSON.stringify(v)} is not one of ${LAYOUT_EDGE_STYLES.join(' | ')}` })
    }
  }
  return issues
}
