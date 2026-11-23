<script setup lang="ts">
/** Datasheet implementation of `FigureFrame` (v1, top ruled header strip with the figure number and caption only, spec board §07; the enlarge icon shows on hover). */
import { computed } from 'vue'
import type { FigureFrameProps } from '../../../theme/slots/registry.ts'
import EnlargeIcon from '../../../theme/slots/default/parts/EnlargeIcon.vue'

const props = defineProps<FigureFrameProps>()
const expandTitle = computed(() => props.buttons.find((b) => b.act === 'expand')?.title ?? '')
</script>

<template>
  <figcaption class="chart-cap lec-ff lec-ff--ds">
    <div class="lec-ff-main">
      <div class="lec-ff-left">
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
.lec-ff--ds {
  order: 3;
  justify-content: flex-start;
  align-items: flex-start;
  margin: var(--lec-space-2) 0 0;
  padding: var(--lec-space-2) 0 0;
  border-top: var(--lec-line-hair) solid var(--lec-border);
}
.lec-ff-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lec-ff-left {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--lec-space-2);
  min-width: 0;
  flex: 1 1 auto;
  text-align: left;
}
.lec-ff-no {
  font-family: var(--lec-font-mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--lec-text);
  white-space: nowrap;
}
.lec-ff-caption {
  font-size: 12.5px;
  color: var(--lec-text-muted);
  min-width: 0;
  overflow-wrap: anywhere;
}
.lec-ff-backlinks {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  font-family: var(--lec-font-mono);
  font-size: 11px;
}
.lec-ff-source {
  font-family: var(--lec-font-mono);
  font-size: 11px;
  line-height: 1.4;
  color: var(--lec-text-muted);
  text-align: left;
  overflow-wrap: anywhere;
}
</style>
