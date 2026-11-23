<script setup lang="ts">
/**
 * MapControls.vue - the + / - / fit buttons at the bottom right of a map (P4a WP-H1). Emits; the map wires the events to
 * its viewport (`MapStage` does this by itself). Style: only `--lec-*` tokens.
 */
import { useT } from '../../i18n/useT.ts'

defineEmits<{ (e: 'zoom-in'): void; (e: 'zoom-out'): void; (e: 'fit'): void }>()
const { t } = useT()
</script>

<template>
  <div class="lec-map-hud lec-map-controls" role="group" :aria-label="t('map.controls')">
    <button type="button" :aria-label="t('map.zoomIn')" @click="$emit('zoom-in')">+</button>
    <button type="button" :aria-label="t('map.zoomOut')" @click="$emit('zoom-out')">&#x2212;</button>
    <button type="button" @click="$emit('fit')">{{ t('map.fit') }}</button>
  </div>
</template>

<style>
.lec-map-controls { right: 12px; bottom: 12px; }
.lec-map-controls button {
  min-width: 30px;
  height: 30px;
  padding: 0 10px;
  /* prototype `button { font: inherit }` (15px of the stage), not the browser's 13.33px control font (AH #13) */
  font: inherit;
  color: var(--lec-text);
  background: var(--lec-bg);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1, 4px);
  cursor: pointer;
}
.lec-map-controls button:hover { color: var(--lec-accent); border-color: var(--lec-accent); }
.lec-map-controls button:focus-visible { outline: 2px solid var(--lec-accent); outline-offset: 1px; }
</style>
