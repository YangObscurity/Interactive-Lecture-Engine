<script setup lang="ts">
/**
 * Engine default of the `GroupMap` slot (v1), prototype v3 (the group-page prototype) "进度格": one small square per lecture,
 * ten to a row, so "row 3, square 7" is lecture 27; read solid, reading half filled, ready (可开始) with the accent colour and a
 * dot. Beside it the progress per Notion category as bars; a bar is a button that scrolls to the category's lane (the engine
 * handles it: `data-lane`). Every square is a real link (`data-lecture`); the engine turns a single click into "open" after the
 * double-click window, a double click into "track in the lane map". The component only draws.
 */
import type { GroupMapProps } from '../registry.ts'

defineProps<GroupMapProps>()
</script>

<template>
  <div class="gm-r">
    <ul class="gm-grid" :aria-label="labels.lectures">
      <li v-for="l in lectures" :key="l.id">
        <a
          class="gm-cell"
          :href="l.href"
          :data-lecture="l.id"
          :data-status="l.status"
          :data-ready="l.ready ? '' : undefined"
          :title="l.label"
          :aria-label="l.label"
          >{{ l.n }}</a
        >
      </li>
    </ul>
    <ul class="gm-cats" :aria-label="labels.categories">
      <li v-for="c in categories" :key="c.index">
        <button type="button" :data-lane="c.index">
          <span class="nm" :lang="categoryLang || undefined">{{ c.name }}</span>
          <span class="bar" aria-hidden="true"><i :style="{ width: `${c.total ? Math.round((100 * c.read) / c.total) : 0}%` }" /></span>
          <span class="cnt">{{ c.read }} / {{ c.total }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.gm-r {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--lec-space-4) var(--lec-space-7);
  align-items: start;
}
.gm-grid,
.gm-cats {
  list-style: none;
  margin: 0;
  padding: 0;
}
.gm-grid {
  display: grid;
  grid-template-columns: repeat(10, 30px);
  gap: 4px;
}
.gm-grid li {
  margin: 0;
  padding: 0;
}
.gm-cell {
  position: relative;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: var(--lec-line-mid) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-bg);
  color: var(--lec-text-muted) !important;
  text-decoration: none !important;
  font: 400 11px var(--lec-font-mono);
}
.gm-cell[data-status='read'] {
  background: var(--lec-done);
  border-color: var(--lec-done);
  color: var(--lec-bg) !important;
}
.gm-cell[data-status='reading'] {
  border-color: var(--lec-done);
  background: linear-gradient(to top, var(--lec-done) 7px, var(--lec-bg) 7px);
  color: var(--lec-text) !important;
  padding-bottom: 5px;
}
.gm-cell[data-ready] {
  border-color: var(--lec-accent);
  color: var(--lec-accent) !important;
}
.gm-cell[data-ready]::after {
  content: '';
  position: absolute;
  top: 3px;
  right: 3px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--lec-accent);
}
.gm-cell:hover,
.gm-cell:focus-visible {
  outline: var(--lec-line-heavy) solid var(--lec-accent);
  outline-offset: 1px;
}
.gm-cats {
  display: grid;
  gap: 4px;
  align-content: start;
  min-width: 0;
}
.gm-cats li {
  margin: 0;
  padding: 0;
}
.gm-cats button {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(60px, 140px) 4.2em;
  gap: var(--lec-space-3);
  align-items: center;
  background: none;
  border: 0;
  padding: 3px 0;
  font: 13px var(--lec-font-heading);
  color: var(--lec-text);
  cursor: pointer;
  text-align: left;
}
.nm {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--lec-surface);
  border: var(--lec-line-hair) solid var(--lec-border);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--lec-done);
}
.cnt {
  font: 12px var(--lec-font-mono);
  color: var(--lec-text-muted);
  text-align: right;
}
.gm-cats button:hover .nm,
.gm-cats button:focus-visible .nm {
  color: var(--lec-accent);
  text-decoration: underline;
}
@container (max-width: 640px) {
  .gm-r {
    grid-template-columns: minmax(0, 1fr);
  }
  .gm-grid {
    grid-template-columns: repeat(auto-fill, 30px);
  }
}
</style>
