<script setup lang="ts">
/**
 * MapInfoPanel.vue - the info panel at the top right of a map (P4a WP-H1): it does not follow
 * the pointer, does not take clicks, fades out when closed and is not shown when the window is narrower than 700 px.
 * Feed it with `useInfoPanel()` (`:content`, `:open`) or put your own markup in the default slot.
 * Style: only `--lec-*` tokens.
 */
import type { MapInfoContent } from './useInfoPanel'

defineProps<{ content: MapInfoContent | null; open: boolean }>()
</script>

<template>
  <aside class="lec-map-panel lec-map-info" :class="{ 'lec-map-info-on': open }" aria-live="polite">
    <slot>
      <template v-if="content">
        <b v-if="content.title">{{ content.title }}</b>
        <span v-for="(line, i) in content.lines ?? []" :key="`l${i}`">{{ line }}</span>
        <template v-for="(s, i) in content.sections ?? []" :key="`s${i}`">
          <b v-if="s.heading" :class="s.tone ? `lec-map-info-${s.tone}` : undefined">{{ s.heading }}</b>
          <ul v-if="s.items && s.items.length">
            <li v-for="(item, j) in s.items" :key="j">{{ item }}</li>
          </ul>
          <span v-if="s.text">{{ s.text }}</span>
        </template>
      </template>
    </slot>
  </aside>
</template>

<style>
.lec-map-info {
  position: absolute;
  z-index: 3;
  top: 52px;
  right: 12px;
  width: min(330px, calc(100% - 24px));
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--lec-text);
  background: var(--lec-bg);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-2, 8px);
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.15s, visibility 0.15s;
}
.lec-map-info.lec-map-info-on { opacity: 1; visibility: visible; }
.lec-map-info b { display: block; margin-bottom: 2px; }
.lec-map-info span { display: block; font-size: 12.5px; color: var(--lec-text-muted); }
.lec-map-info ul { margin: 4px 0; padding-left: 16px; font-size: 12.5px; }
.lec-map-info .lec-map-info-pre { color: var(--lec-accent); }
.lec-map-info .lec-map-info-post { color: var(--lec-done-text); }
@media (max-width: 700px) {
  .lec-map-info { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .lec-map-info { transition: none; }
}
</style>
