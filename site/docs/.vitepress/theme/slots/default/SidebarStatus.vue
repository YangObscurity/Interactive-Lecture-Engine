<script setup lang="ts">
/**
 * Engine default implementation of the `SidebarStatus` slot (v1), spec board section 05:
 * unread = hollow, reading = half filled (from the bottom), read = solid; 9 px, stroke --lec-line-mid
 * (the board's --w-mid), colours --lec-done / --lec-border. The corner radius is the theme's
 * --lec-status-radius: a round dot in reader, a square pad where the theme sets it so.
 */
import type { SidebarStatusProps } from '../registry.ts'

defineProps<SidebarStatusProps>()
</script>

<template>
  <span
    class="lec-status"
    data-slot="SidebarStatus"
    :data-status="status"
    :data-current="current ? 'true' : undefined"
    role="img"
    :aria-label="label"
  />
</template>

<style scoped>
.lec-status {
  flex: none;
  box-sizing: border-box;
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: var(--lec-space-2);
  border: var(--lec-line-mid) solid var(--lec-border);
  border-radius: var(--lec-status-radius);
}
.lec-status[data-status='completed'] {
  background: var(--lec-done);
  border-color: var(--lec-done);
}
.lec-status[data-status='in_progress'] {
  border-color: var(--lec-done);
  background: linear-gradient(to top, var(--lec-done) 50%, transparent 50%);
}
</style>
