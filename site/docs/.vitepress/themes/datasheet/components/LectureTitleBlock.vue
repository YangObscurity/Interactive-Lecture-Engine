<script setup lang="ts">
/** Datasheet implementation of `LectureTitleBlock` (v1, device-manual spec header, spec board §06). */
import type { LectureTitleBlockProps } from '../../../theme/slots/registry.ts'

defineProps<LectureTitleBlockProps>()
</script>

<template>
  <header class="lec-tb lec-tb--ds" :style="{ '--c': `var(--lec-cat-${catSlot})` }">
    <div class="lec-tb-top">
      <span class="lec-tb-grp"><i aria-hidden="true" /><span :lang="notionLang || undefined">{{ groupId }} · {{ groupTitle }}</span></span>
      <span class="lec-tb-code">DOC // {{ code }}</span>
    </div>
    <h1 class="lec-tb-h1">
      <small v-if="eyebrow">{{ eyebrow }}</small
      >{{ title }}
    </h1>
    <table class="lec-tb-spec">
      <tbody>
        <tr v-if="nodeId || difficulty > 0">
          <th scope="row">{{ labels.node }}</th>
          <td><code v-if="nodeId">{{ nodeId }}</code><span v-else class="lec-tb-none">{{ labels.none }}</span></td>
          <th scope="row">{{ labels.difficulty }}</th>
          <td>
            <span v-if="difficulty > 0" class="lec-tb-stars" :aria-label="labels.starsAria">
              {{ '★'.repeat(difficulty) }}<span class="lec-tb-stars-off" aria-hidden="true">{{ '☆'.repeat(Math.max(0, maxStars - difficulty)) }}</span>
            </span>
            <span v-else class="lec-tb-none">{{ labels.none }}</span>
          </td>
        </tr>
        <tr>
          <th scope="row">{{ labels.estimated }}</th>
          <td class="num">{{ estimated || labels.none }}</td>
          <th scope="row">{{ labels.status }}</th>
          <td>
            <span class="lec-tb-status" :data-status="status"><i aria-hidden="true" />{{ statusLabel }}</span>
          </td>
        </tr>
        <tr v-if="prev || next">
          <th scope="row">{{ labels.prev }}</th>
          <td><a v-if="prev" :href="prev.href">{{ prev.label }}</a><span v-else class="lec-tb-none">{{ labels.none }}</span></td>
          <th scope="row">{{ labels.next }}</th>
          <td><a v-if="next" :href="next.href">{{ next.label }}</a><span v-else class="lec-tb-none">{{ labels.none }}</span></td>
        </tr>
      </tbody>
    </table>
  </header>
</template>

<style scoped>
.lec-tb--ds {
  display: grid;
  gap: var(--lec-space-3);
  margin: 0 0 var(--lec-space-5);
}
.lec-tb-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--lec-space-4);
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--lec-text-muted);
}
.lec-tb-grp {
  display: inline-flex;
  align-items: center;
  gap: var(--lec-space-2);
  color: var(--lec-text);
  font-family: var(--lec-font-heading);
  font-weight: 700;
}
.lec-tb-grp i {
  width: 10px;
  height: 10px;
  background: var(--c, var(--lec-accent));
  flex: none;
}
.lec-tb-code {
  font-family: var(--lec-font-mono);
  font-size: 11.5px;
  padding: 1px 7px;
  border: var(--lec-line-hair) solid var(--lec-border);
  background: var(--lec-surface);
  color: var(--lec-text);
}
.lec-tb-h1 {
  margin: 0;
  font-family: var(--lec-font-heading);
  font-size: 34px;
  font-weight: var(--lec-heading-weight);
  line-height: 1.2;
  color: var(--lec-text);
}
.lec-tb-h1 small {
  display: block;
  font-family: var(--lec-font-mono);
  font-size: 13.5px;
  font-weight: 700;
  color: var(--lec-accent);
  margin-bottom: var(--lec-space-1);
}
.lec-tb-spec {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin: 0;
  display: table;
}
.lec-tb-spec th,
.lec-tb-spec td {
  padding: 6px var(--lec-space-3);
  text-align: left;
  vertical-align: top;
}
.lec-tb-spec th {
  font-family: var(--lec-font-heading);
  color: var(--lec-text-muted);
  font-weight: 600;
  width: 1%;
  white-space: nowrap;
}
.lec-tb-spec td {
  color: var(--lec-text);
}
.lec-tb-spec td.num {
  font-family: var(--lec-font-mono);
  font-variant-numeric: tabular-nums;
}
.lec-tb-spec code {
  font-family: var(--lec-font-mono);
  font-size: 12.5px;
  /* a long node id breaks instead of widening the table past a narrow phone screen */
  overflow-wrap: anywhere;
}
.lec-tb-spec a {
  color: var(--lec-accent);
  text-decoration: none;
}
.lec-tb-spec a:hover {
  text-decoration: underline;
}
.lec-tb-none {
  color: var(--lec-text-muted);
}
.lec-tb-stars {
  color: var(--lec-warning);
  letter-spacing: 1px;
}
.lec-tb-stars-off {
  color: var(--lec-border);
}
.lec-tb-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--lec-font-heading);
  font-weight: 600;
}
.lec-tb-status i {
  width: 9px;
  height: 9px;
  border: var(--lec-line-mid) solid var(--lec-border);
  border-radius: var(--lec-status-radius);
}
.lec-tb-status[data-status='in_progress'] i {
  border-color: var(--lec-done);
  background: linear-gradient(to top, var(--lec-done) 50%, transparent 50%);
}
.lec-tb-status[data-status='completed'] i {
  border-color: var(--lec-done);
  background: var(--lec-done);
}
@media (max-width: 560px) {
  .lec-tb-h1 {
    font-size: 27px;
  }
}
</style>
