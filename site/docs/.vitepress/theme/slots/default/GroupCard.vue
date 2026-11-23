<script setup lang="ts">
/**
 * Engine default of the `GroupCard` slot (v1), spec board 13.1 (reader card): the fields of the group, category colour on
 * the left edge only, a status strip with one tick per lecture in three heights (read tall, reading middle, unread short),
 * one line of where to go on. Hover changes only the border colour. The strip is hidden from screen readers; the read
 * count and the "next" line are visible text. The whole card is one link.
 */
import { computed } from 'vue'
import type { GroupCardProps } from '../registry.ts'

const props = defineProps<GroupCardProps>()
const marks = computed(() => Array.from(props.ticks).map((c) => (c === 'r' ? 'read' : c === 'g' ? 'reading' : 'unread')))
</script>

<template>
  <a class="gcard" :href="href" :data-group="id" :style="{ '--c': `var(--lec-cat-${slot})` }">
    <div class="gcard-top">
      <b>{{ id }}</b>
      <span>{{ category }}</span>
      <span class="cnt">{{ labels.lectures }}</span>
    </div>
    <h3>{{ title }}</h3>
    <p class="tagl">{{ tagline }}</p>
    <p class="sum">{{ summary }}</p>
    <div class="tags">
      <span v-for="t in tags" :key="t">{{ t }}</span>
    </div>
    <div class="ticks-row">
      <span class="ticks" aria-hidden="true"><i v-for="(m, i) in marks" :key="i" :class="m" /></span>
      <span class="pc">{{ labels.read }}</span>
    </div>
    <div class="gcard-foot">
      <b>{{ labels.enter }}</b>
      <span>{{ next.heading }} {{ next.title }}</span>
    </div>
  </a>
</template>

<style scoped>
.gcard {
  display: flex;
  flex-direction: column;
  gap: var(--lec-space-2);
  min-width: 0;
  padding: var(--lec-space-4);
  border: var(--lec-line-hair) solid var(--lec-border);
  border-left: 4px solid var(--c);
  border-radius: var(--lec-radius-2);
  background: var(--lec-surface);
  color: var(--lec-text);
  text-decoration: none;
}
.gcard:hover { border-color: var(--lec-accent); border-left-color: var(--c); }
.gcard p { margin: 0; }
.gcard-top { display: flex; align-items: baseline; gap: var(--lec-space-2); font-size: 12.5px; color: var(--lec-text-muted); }
.gcard-top b { font: 700 13px var(--lec-font-heading); color: var(--lec-text); }
.gcard-top .cnt { margin-left: auto; font: 400 12px var(--lec-font-mono); }
.gcard h3 { margin: 0; padding: 0; border: 0; font-size: 18px; font-weight: var(--lec-heading-weight); line-height: 1.4; }
.tagl { margin-top: -6px; font-size: 13px; font-weight: 500; color: var(--lec-text-muted); }
.sum {
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--lec-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tags span { font-size: 12px; color: var(--lec-text-muted); border: var(--lec-line-hair) solid var(--lec-border); border-radius: var(--lec-radius-1); background: var(--lec-bg); padding: 0 7px; }
.ticks-row { display: flex; align-items: flex-end; gap: var(--lec-space-3); margin-top: var(--lec-space-1); }
.ticks { flex: 1; min-width: 0; height: 11px; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 3px); column-gap: 2px; align-items: end; }
.ticks i { display: block; height: 4px; background: var(--lec-text-muted); opacity: 0.5; }
.ticks i.read { height: 11px; background: var(--lec-done); opacity: 1; }
.ticks i.reading { height: 7px; background: var(--lec-accent); opacity: 1; }
.pc { font: 400 12px var(--lec-font-mono); color: var(--lec-text-muted); white-space: nowrap; }
.gcard-foot { display: flex; align-items: baseline; gap: var(--lec-space-3); margin-top: auto; padding-top: var(--lec-space-2); border-top: var(--lec-line-hair) dashed var(--lec-border); font-size: 13px; }
.gcard-foot b { color: var(--lec-accent); font-weight: 600; white-space: nowrap; }
.gcard-foot span { margin-left: auto; min-width: 0; color: var(--lec-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
