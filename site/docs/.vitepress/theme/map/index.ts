/**
 * theme/map - the map engine shared by the home atlas (P4a) and the dependency canvas (P4b). API: docs-dev/MAP.md.
 */
export * from './geometry'
export { CLICK_DELAY_MS, createClickRule } from './clickRule'
export type { ClickRule, ClickRuleOptions } from './clickRule'
export { useClickRule } from './useClickRule'
export { LabelLayer, LABEL_CANVAS_CLASS, MOVING_CLASS, THEME_ATTRIBUTES, labelHitBox, labelOnScreen, labelPixelSize, labelVisibleAt, readLabelGeometry, readLabelStyle } from './labels'
export type { Label, LabelDrawStats, LabelHalo, LabelLayerOptions, LabelProbe, LabelView } from './labels'
export { MapViewport, STAGE_ACTIVE_CLASS, STAGE_DRAGGING_CLASS, STAGE_MOVED_CLASS } from './viewport'
export type { MapViewportEvent, MapViewportOptions } from './viewport'
export { useMapViewport } from './useMapViewport'
export type { UseMapViewport, UseMapViewportOptions } from './useMapViewport'
export { useLabelLayer } from './useLabelLayer'
export type { UseLabelLayer, UseLabelLayerOptions } from './useLabelLayer'
export { INFO_HIDE_DELAY_MS, useInfoPanel } from './useInfoPanel'
export type { MapInfoContent, MapInfoSection, UseInfoPanel } from './useInfoPanel'
export { mapAriaLabel, mapSvgLabel } from './aria'
export type { MapAriaInput } from './aria'
