/**
 * theme/slots/registry.ts - the typed slot registry (P2e, docs-dev/SLOTS.md).
 *
 * One entry per slot: its name, contract version, the props a theme component receives (`SlotProps`), and the engine
 * default implementation, loaded lazily. Names, versions and default file paths are plain data in contract.ts so
 * the build and `doctor` can read them without Vue; `tests/unit/slots-registry.test.ts` keeps both in step.
 *
 * Props are the contract: the engine owns data, interaction state, keyboard and aria; the theme only draws.
 */
import type { Component } from 'vue'
import type { ProgressStatus } from '../progress/types'
import { SLOT_CONTRACT_VERSION, SLOT_NAMES, SLOT_VERSIONS, type SlotName } from './contract.ts'

export { SLOT_CONTRACT_VERSION, SLOT_NAMES, type SlotName }

/** `SidebarStatus` v1: the reading-status marker in front of a lecture link in the sidebar. */
export interface SidebarStatusProps {
  status: ProgressStatus
  /** The link is the page being read. */
  current: boolean
  /** Status text for screen readers (i18n dictionary: unread / reading / read). The component must expose it as its accessible name. */
  label: string
}

// ---- atlas (P4a WP-H2) ------------------------------------------------------------------------------------------
//
// Atlas slots draw SVG inside the atlas map (docs-dev/SLOTS.md, "Atlas slots"). Coordinates are canvas units (x to the
// right, y down, offset already applied). Every component has ONE root `<g>`; text is `<text>` (the label layer paints
// it from the CSS classes of the component); every label has a transparent `lec-map-hit` rectangle; the parts the engine
// handles carry `data-atlas-part="toggle"` or `"strip"`. The engine owns clicks, hover, focus, search and expansion.

/** Reading status of a lecture as the atlas shows it. */
export type AtlasStatus = 'read' | 'reading' | 'unread'
/** What a node shows while something is hovered: `hover` the hovered node, `pre` / `post` a prerequisite / follow-up, `on` a node of a lit branch. */
export type AtlasHighlight = '' | 'on' | 'hover' | 'pre' | 'post'
export type AtlasSide = -1 | 1

/** Fields of every atlas node slot (category, group, phase, lecture). */
export interface AtlasNodeCommon {
  /** Id of the node (the engine puts it on the root as `data-node`). */
  id: string
  /** -1: the node is left of the centre and everything is mirrored; 1: right. */
  side: AtlasSide
  /** Category colour slot 1-8: colour with `var(--lec-cat-<slot>)`. */
  slot: number
  highlight: AtlasHighlight
  /** The node is a search hit (or holds one while collapsed). */
  match: boolean
  /** Label start towards the centre, its other end, the left edge (min of both), the width, and the centre line of the row. */
  xi: number
  xo: number
  x0: number
  w: number
  y: number
}

/** Status strip of a collapsed group or phase: one mark per lecture, in a column shared by all rows of that depth. */
export interface AtlasStripGeometry {
  /** One character per lecture in reading order: `r` read, `g` reading, `u` unread. */
  ticks: string
  /** x where the link towards the strip starts, x of the first mark's near edge, distance between marks, mark width. */
  stripFrom: number
  stripCol: number
  tick: number
  tickW: number
}

/** `AtlasCenter` v1: the box in the middle (site name and totals). */
export interface AtlasCenterProps {
  id: string
  /** Box top-left and size; the middle of the box is the origin the traces leave from. */
  x: number
  y: number
  w: number
  h: number
  title: string
  subtitle: string
  read: number
  reading: number
  total: number
  /** Datasheet: where each category's trace leaves the chip (y), per side. */
  pads: ReadonlyArray<{ side: AtlasSide; y: number }>
}

/** `AtlasCategory` v1: a category (the first column). */
export interface AtlasCategoryProps extends AtlasNodeCommon {
  /** Category name (not `name`: that prop belongs to `<LecSlot>`). */
  label: string
  labelW: number
  groups: number
  total: number
  read: number
  /** Datasheet zone box: its inner edge (towards the centre), outer edge, top and height; and the caption ("5 groups, 12/66 read") with its width. */
  innerX: number
  outerX: number
  zoneTop: number
  zoneH: number
  caption: string
  captionW: number
  /** Datasheet: the lecture count written where the trunk enters the zone. */
  trunk: string
}

/** `AtlasGroup` v1: a course group (second column); collapsed, it carries the status strip. */
export interface AtlasGroupProps extends AtlasNodeCommon, AtlasStripGeometry {
  /** `G05`, the (clipped) title, the package name (`DIP-32`) and `read/total`, with the widths of the first three. */
  groupId: string
  title: string
  idW: number
  titleW: number
  pkg: string
  progress: string
  progressW: number
  total: number
  read: number
  reading: number
  open: boolean
}

/** `AtlasPhase` v1: a stage of 3-4 lectures (third column), only in groups of more than 8 lectures (or with authored phases). */
export interface AtlasPhaseProps extends AtlasNodeCommon, AtlasStripGeometry {
  /** Reader: "Lectures 4-7" or the authored name; datasheet: the port label `PA0-3`. */
  label: string
  labelW: number
  total: number
  read: number
  reading: number
  open: boolean
}

/** `AtlasLecture` v1: one lecture (last column). */
export interface AtlasLectureProps extends AtlasNodeCommon {
  /** Two digits. */
  number: string
  /** Name, cut to the column; `title` is the whole title. */
  label: string
  title: string
  /** x where the name starts. */
  labelX: number
  labelW: number
  status: AtlasStatus
}

/** `AtlasLink` v1: the link from a parent to its child (the child's id names it). */
export interface AtlasLinkProps {
  /** Id of the child; the engine sets `data-link="<parent>><child>"`. */
  id: string
  parentId: string
  /** Kind of the child. */
  kind: 'cat' | 'group' | 'stage' | 'lec'
  side: AtlasSide
  slot: number
  /** From the parent's anchor to the child's anchor; `bus` is where a right-angle trace turns (the vertical segment). */
  x1: number
  y1: number
  x2: number
  y2: number
  bus: number
  /** The link lies on a lit branch. */
  on: boolean
}

/** `GroupCard` v1: the card of a course group on the home page. The whole card is one link. */
export interface GroupCardProps {
  id: string
  href: string
  /** Category name and colour slot 1-8. */
  category: string
  slot: number
  title: string
  tagline: string
  summary: string
  tags: readonly string[]
  total: number
  read: number
  reading: number
  /** One character per lecture in reading order: `r` read, `g` reading, `u` unread (the strip, or the pins of the package). */
  ticks: string
  /** Package name (`DIP-32`, `SOIC-6`): the lecture count made even. */
  pkg: string
  /** Where to go on: `reading`, `start`, `done` or `next`, with its heading and the lecture title. */
  next: { kind: 'reading' | 'start' | 'done' | 'next'; heading: string; title: string }
  /** True when the group is a temporary group (`temp: true`, DB/local progress only, no Notion sync). */
  temp?: boolean
  /** Localised temporary badge label (`group.temp`). */
  tempLabel?: string
  /** Texts already in the reader's language. */
  labels: { lectures: string; read: string; readHeading: string; lecturesHeading: string; tagsHeading: string; tagsSeparator: string; enter: string }
}

// ---- group page (P4a WP-H3) -------------------------------------------------------------------------------------

/** One lecture of the group map: a real link (the engine arbitrates single / double click and Space on it). */
export interface GroupMapLecture {
  id: string
  n: number
  /** Two digits. */
  number: string
  title: string
  /** Page to open, site base included: the component puts it in `href`; the engine opens it itself on a plain click (the map is `vp-raw`). */
  href: string
  status: AtlasStatus
  /** Every prerequisite is read and this one is not (可开始). */
  ready: boolean
  /** Accessible name of the link: group, number, title, status and, when it applies, "ready". Already in the reader's language. */
  label: string
}

/** One Notion category of the group: its share of read lectures; the button scrolls to the category's lane. */
export interface GroupMapCategory {
  /** Index of the lane; the button carries `data-lane="<index>"`. */
  index: number
  name: string
  read: number
  total: number
}

/** `GroupMap` v1: the quick-navigation map of the group page (reader: progress grid and category bars; datasheet: the DIP of spec board 12). */
export interface GroupMapProps {
  groupId: string
  /** Package name (`DIP-32`, `SOIC-6`): the lecture count made even. */
  pkg: string
  read: number
  total: number
  lectures: readonly GroupMapLecture[]
  categories: readonly GroupMapCategory[]
  /** `lang` of the category names (Notion titles are Chinese): '' when it is the page's language. */
  categoryLang: string
  /** Texts already in the reader's language. */
  labels: { categories: string; padding: string; paddingNote: string; lectures: string }
}

// ---- home dependency canvas (P4b) ---------------------------------------------------------------------------------

export interface CanvasZoneBox {
  cat: number
  name: string
  x: number
  y: number
  w: number
  h: number
}

/** `CanvasBackdrop` v1: category zone frames behind datasheet boards (reader leaves this empty). */
export interface CanvasBackdropProps {
  zones: readonly CanvasZoneBox[]
}

export interface CanvasDsPinNc {
  x: number
  y: number
  tipX: number
  side: -1 | 1
}

export interface CanvasDsUnitView {
  uid: string
  part: string
  of: number
  pkg: string
  x: number
  y: number
  w: number
  h: number
  showCatTag: boolean
  ports: ReadonlyArray<{ x: number; y: number; out: boolean }>
  ncPins: readonly CanvasDsPinNc[]
}

/** `CanvasGroup` v1: one course group block (reader) or its DIP/SOIC chip unit(s) (datasheet). */
export interface CanvasGroupProps {
  id: string
  cat: number
  catName: string
  title: string
  progress: string
  active: boolean
  x: number
  y: number
  w: number
  h: number
  units: readonly CanvasDsUnitView[]
  unitBuses: ReadonlyArray<{ d: string; weight: number }>
}

/** `CanvasNode` v1: one lecture node block (reader) or IC pin + label row (datasheet). */
export interface CanvasNodeProps {
  id: string
  number: string
  pinNumber: number
  label: string
  status: AtlasStatus
  hover: boolean
  locked: boolean
  active: boolean
  match: boolean
  traceRole?: 'locked' | 'pre' | 'post' | 'pair' | null
  x: number
  y: number
  w: number
  h: number
  pinX: number
  pinY: number
  tipX: number
  pinSide: -1 | 1
  legLen: number
  nameX: number
  hitX: number
  hitW: number
}

export interface CanvasBundleSegment {
  d: string
  weight: number
  tags: ReadonlyArray<{ text: string; x: number; y: number }>
}

/** `CanvasEdge` v1: an intra-group route, an inter-group bundle / bus, or a highlighted trace link. */
export interface CanvasEdgeProps {
  kind: 'intra' | 'bundle' | 'trace-pre' | 'trace-post'
  d: string
  tx: number
  ty: number
  weight: number
  pairKey: string
  active: boolean
  hot: boolean
  segments: readonly CanvasBundleSegment[]
}

// ---- lecture reading page (P5 WP-R1) ---------------------------------------------------------------------------

export interface LectureTitleLink {
  label: string
  href: string
}

/** `LectureTitleBlock` v1: lecture page header card + spec table above `.vp-doc` (spec board §06). */
export interface LectureTitleBlockProps {
  /** Code badge e.g. `G05-L19`. */
  code: string
  groupId: string
  groupTitle: string
  category: string
  catSlot: number
  eyebrow: string
  title: string
  nodeId: string
  difficulty: number
  maxStars: number
  estimated: string
  status: ProgressStatus
  statusLabel: string
  prev: LectureTitleLink | null
  next: LectureTitleLink | null
  /** Language code when category / group title is in root language on a translated page, else `''`. */
  notionLang: string
  labels: {
    node: string
    difficulty: string
    estimated: string
    status: string
    prev: string
    next: string
    none: string
    starsAria: string
  }
}

export interface FigureFrameButton {
  act: string
  title: string
  label: string
}

export interface FigureFrameBacklink {
  anchorId: string
  label: string
}

/** `FigureFrame` v1: figure chrome (tag badge, tool buttons, optional numbered caption) around `.chart-body` (spec board §07). */
export interface FigureFrameProps {
  type: string
  tagLabel: string
  figureLabel: string
  title: string
  caption: string
  buttons: readonly FigureFrameButton[]
  /** Optional muted second-line citation source (e.g. paper, figure/table number, page). */
  source?: string
  /** Optional back-links rendered at the end of the caption pointing back to prose references. */
  backlinks?: readonly FigureFrameBacklink[]
}

/** `QuizHeader` v1: self-test question strip above `.vp-doc details.details` (spec board §08). */
export interface QuizHeaderProps {
  index: number
  total: number
  lectureNo: number
  badge: string
  heading: string
  totalLabel: string
}

export interface SearchHighlightPart {
  text: string
  hit: boolean
}

export interface SearchHitView {
  id: string
  href: string
  groupId: string
  code: string
  noLabel: string
  titleParts: readonly SearchHighlightPart[]
  crumbParts: readonly SearchHighlightPart[]
  snippetParts: readonly SearchHighlightPart[]
  status: 'not_started' | 'in_progress' | 'completed'
  statusLabel: string
}

export interface SearchGroupSectionView {
  groupId: string
  groupTitle: string
  countLabel: string
  items: readonly SearchHitView[]
}

export interface SearchLoadState {
  loading: boolean
  loadedBytes: number
  totalBytes: number
  percent: number
  label: string
}

export interface SearchPanelProps {
  query: string
  scope: 'all' | 'group'
  currentGroupId: string | null
  currentGroupLabel: string
  groups: readonly SearchGroupSectionView[]
  activeIndex: number
  metaText: string
  loadState: SearchLoadState
  emptyState: 'idle' | 'no-results' | null
  labels: {
    dialogLabel: string
    placeholder: string
    clearQuery: string
    escKey: string
    scopeLabel: string
    scopeAll: string
    scopeGroup: string
    noResults: string
    idleHint: string
    footerSelect: string
    footerOpen: string
    footerClose: string
    resultsAria: string
  }
  onQuery: (value: string) => void
  onScope: (scope: 'all' | 'group') => void
  onHighlight: (index: number) => void
  onOpen: (hit: SearchHitView) => void
  onClose: () => void
  onKeyDown: (ev: KeyboardEvent) => void
}

export interface CourseMenuLectureView {
  id: string
  no: string
  title: string
  href: string
  status: 'read' | 'reading' | 'unread'
  isCurrent: boolean
  ariaLabel: string
}

export interface CourseMenuGroupView {
  id: string
  title: string
  href: string
  catSlot: number
  category: string
  read: number
  total: number
  isCurrent: boolean
  temp?: boolean
  lectures: readonly CourseMenuLectureView[]
}

export interface CourseMenuLabels {
  groups: string
  dialogLabel: string
  enterGroup: string
  readCount: string
  readSuffix: string
  hintSelectGroup: string
  hintEnterLectures: string
  hintOpen: string
  hintClose: string
  expandGroup: string
  collapseGroup: string
  temp?: string
}

/** `NavCourseMenu` v1: topbar course menu (desktop flyout & mobile screen menu, spec board §04.1). */
export interface NavCourseMenuProps {
  isOpen: boolean
  isMobile: boolean
  groups: readonly CourseMenuGroupView[]
  activeGroupId: string
  activeGroup: CourseMenuGroupView | null
  activeLectureIndex: number
  activeColumn: 'groups' | 'lectures'
  expandedGroupIds: readonly string[]
  labels: CourseMenuLabels
  onToggle: () => void
  onClose: () => void
  onSelectGroup: (groupId: string) => void
  onToggleGroupExpand: (groupId: string) => void
  onOpenGroup: (group: CourseMenuGroupView, ev?: MouseEvent) => void
  onOpenLecture: (lecture: CourseMenuLectureView, ev?: MouseEvent) => void
  onKeyDown: (ev: KeyboardEvent) => void
}

/** Props of every slot, by name. `<LecSlot name="X" v-bind="props">` is typed from this map. */
export interface SlotProps {
  SidebarStatus: SidebarStatusProps
  AtlasCenter: AtlasCenterProps
  AtlasCategory: AtlasCategoryProps
  AtlasGroup: AtlasGroupProps
  AtlasPhase: AtlasPhaseProps
  AtlasLecture: AtlasLectureProps
  AtlasLink: AtlasLinkProps
  GroupCard: GroupCardProps
  GroupMap: GroupMapProps
  CanvasGroup: CanvasGroupProps
  CanvasNode: CanvasNodeProps
  CanvasEdge: CanvasEdgeProps
  CanvasBackdrop: CanvasBackdropProps
  LectureTitleBlock: LectureTitleBlockProps
  FigureFrame: FigureFrameProps
  QuizHeader: QuizHeaderProps
  SearchPanel: SearchPanelProps
  NavCourseMenu: NavCourseMenuProps
}

export interface SlotDefinition<N extends SlotName = SlotName> {
  name: N
  version: number
  /** Engine default implementation, loaded on demand (the build imports it statically when the site default theme uses it). */
  loadDefault: () => Promise<Component>
}

export const SLOTS: { [N in SlotName]: SlotDefinition<N> } = {
  SidebarStatus: {
    name: 'SidebarStatus',
    version: SLOT_VERSIONS.SidebarStatus,
    loadDefault: () => import('./default/SidebarStatus.vue').then((m) => m.default),
  },
  AtlasCenter: { name: 'AtlasCenter', version: SLOT_VERSIONS.AtlasCenter, loadDefault: () => import('./default/AtlasCenter.vue').then((m) => m.default) },
  AtlasCategory: { name: 'AtlasCategory', version: SLOT_VERSIONS.AtlasCategory, loadDefault: () => import('./default/AtlasCategory.vue').then((m) => m.default) },
  AtlasGroup: { name: 'AtlasGroup', version: SLOT_VERSIONS.AtlasGroup, loadDefault: () => import('./default/AtlasGroup.vue').then((m) => m.default) },
  AtlasPhase: { name: 'AtlasPhase', version: SLOT_VERSIONS.AtlasPhase, loadDefault: () => import('./default/AtlasPhase.vue').then((m) => m.default) },
  AtlasLecture: { name: 'AtlasLecture', version: SLOT_VERSIONS.AtlasLecture, loadDefault: () => import('./default/AtlasLecture.vue').then((m) => m.default) },
  AtlasLink: { name: 'AtlasLink', version: SLOT_VERSIONS.AtlasLink, loadDefault: () => import('./default/AtlasLink.vue').then((m) => m.default) },
  GroupCard: { name: 'GroupCard', version: SLOT_VERSIONS.GroupCard, loadDefault: () => import('./default/GroupCard.vue').then((m) => m.default) },
  GroupMap: { name: 'GroupMap', version: SLOT_VERSIONS.GroupMap, loadDefault: () => import('./default/GroupMap.vue').then((m) => m.default) },
  CanvasGroup: { name: 'CanvasGroup', version: SLOT_VERSIONS.CanvasGroup, loadDefault: () => import('./default/CanvasGroup.vue').then((m) => m.default) },
  CanvasNode: { name: 'CanvasNode', version: SLOT_VERSIONS.CanvasNode, loadDefault: () => import('./default/CanvasNode.vue').then((m) => m.default) },
  CanvasEdge: { name: 'CanvasEdge', version: SLOT_VERSIONS.CanvasEdge, loadDefault: () => import('./default/CanvasEdge.vue').then((m) => m.default) },
  CanvasBackdrop: { name: 'CanvasBackdrop', version: SLOT_VERSIONS.CanvasBackdrop, loadDefault: () => import('./default/CanvasBackdrop.vue').then((m) => m.default) },
  LectureTitleBlock: { name: 'LectureTitleBlock', version: SLOT_VERSIONS.LectureTitleBlock, loadDefault: () => import('./default/LectureTitleBlock.vue').then((m) => m.default) },
  FigureFrame: { name: 'FigureFrame', version: SLOT_VERSIONS.FigureFrame, loadDefault: () => import('./default/FigureFrame.vue').then((m) => m.default) },
  QuizHeader: { name: 'QuizHeader', version: SLOT_VERSIONS.QuizHeader, loadDefault: () => import('./default/QuizHeader.vue').then((m) => m.default) },
  SearchPanel: { name: 'SearchPanel', version: SLOT_VERSIONS.SearchPanel, loadDefault: () => import('./default/SearchPanel.vue').then((m) => m.default) },
  NavCourseMenu: { name: 'NavCourseMenu', version: SLOT_VERSIONS.NavCourseMenu, loadDefault: () => import('./default/NavCourseMenu.vue').then((m) => m.default) },
}

export function slotVersion(name: SlotName): number {
  return SLOTS[name].version
}

/** The engine's slot-contract version (what `engine: "^1"` is matched against). */
export const ENGINE_SLOT_CONTRACT: number = SLOT_CONTRACT_VERSION
