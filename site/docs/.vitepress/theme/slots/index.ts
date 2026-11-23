/**
 * theme/slots/index.ts - the site's slot runtime and `<LecSlot>`, wired to `virtual:lecture-components`.
 *
 *   import { LecSlot } from '../slots'
 */
import { SLOT_COMPONENTS, SLOT_DEFAULT_THEME, SLOT_STATIC } from 'virtual:lecture-components'
import { createLecSlot } from './LecSlot.ts'
import { createSlotRuntime } from './runtime.ts'

export const slotRuntime = createSlotRuntime({ defaultTheme: SLOT_DEFAULT_THEME, table: SLOT_COMPONENTS, staticImpls: SLOT_STATIC })
export const LecSlot = createLecSlot(slotRuntime)
export { SLOT_NAMES, SLOT_CONTRACT_VERSION } from './registry.ts'
export type {
  SlotName,
  SlotProps,
  SidebarStatusProps,
  AtlasCenterProps,
  AtlasCategoryProps,
  AtlasGroupProps,
  AtlasPhaseProps,
  AtlasLectureProps,
  AtlasLinkProps,
  GroupCardProps,
  GroupMapProps,
  GroupMapLecture,
  GroupMapCategory,
  CanvasBackdropProps,
  CanvasGroupProps,
  CanvasNodeProps,
  CanvasEdgeProps,
  CanvasDsUnitView,
  CanvasDsPinNc,
  CanvasBundleSegment,
  CanvasZoneBox,
  LectureTitleBlockProps,
  LectureTitleLink,
  FigureFrameProps,
  FigureFrameButton,
  QuizHeaderProps,
  SearchPanelProps,
  NavCourseMenuProps,
  CourseMenuGroupView,
  CourseMenuLectureView,
  CourseMenuLabels,
} from './registry.ts'
