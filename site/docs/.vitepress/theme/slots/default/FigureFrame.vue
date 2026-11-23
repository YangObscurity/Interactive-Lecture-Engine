<script setup lang="ts">
/**
 * Engine default of `FigureFrame` (v1, reader style, spec board 07): the caption under the figure (number and text, nothing
 * else: no type tag, no source button) and, on hover only, an enlarge icon at the top right. A click on the image opens the same
 * viewer (charts/toolbar.ts).
 */
import { computed } from 'vue'
import type { FigureFrameProps } from '../registry.ts'
import EnlargeIcon from './parts/EnlargeIcon.vue'

const props = defineProps<FigureFrameProps>()
const expandTitle = computed(() => props.buttons.find((b) => b.act === 'expand')?.title ?? '')
</script>

<template>
  <figcaption class="chart-cap lec-ff lec-ff--reader">
    <div class="lec-ff-main">
      <div class="lec-ff-line">
        <b class="lec-ff-no">{{ figureLabel }}</b>
        <span v-if="caption || title" class="lec-ff-caption">{{ caption || title }}</span>
        <span v-if="backlinks?.length" class="lec-ff-backlinks">
          <a
            v-for="bl in backlinks"
            :key="bl.anchorId"
            class="lec-fig-backlink"
            :href="'#' + bl.anchorId"
            :data-backlink-target="bl.anchorId"
          >{{ bl.label }}</a>
        </span>
      </div>
      <div v-if="source" class="lec-ff-source">{{ source }}</div>
    </div>
    <EnlargeIcon :title="expandTitle" />
  </figcaption>
</template>

<style scoped>
.lec-ff--reader {
  order: 3;
  justify-content: flex-start;
  align-items: flex-start;
  border-top: 0;
  margin: 4px 0 2px;
  padding-top: 0;
}
.lec-ff-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lec-ff-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}
.lec-ff-no {
  flex: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--lec-text);
  white-space: nowrap;
}
.lec-ff-caption {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--lec-text-muted);
  text-align: left;
  overflow-wrap: anywhere;
}
.lec-ff-backlinks {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 12px;
}
.lec-ff-source {
  font-size: 12px;
  line-height: 1.45;
  color: var(--lec-text-muted);
  text-align: left;
  overflow-wrap: anywhere;
}
</style>
