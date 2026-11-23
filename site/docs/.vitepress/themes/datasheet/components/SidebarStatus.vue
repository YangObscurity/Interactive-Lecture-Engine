<script setup lang="ts">
/**
 * datasheet implementation of the `SidebarStatus` slot (v1): a square solder pad, spec board section 05
 * (datasheet specimen). Unread = bare pad outline, reading = pad filled from the bottom half, read = filled pad.
 * Corner radius is the theme's --lec-status-radius (1 px); colours --lec-done / --lec-border, stroke --lec-line-mid.
 * The engine owns data and interaction; this component only draws the props it is given.
 */
defineProps<{
  status: 'not_started' | 'in_progress' | 'completed'
  current: boolean
  label: string
}>()
</script>

<template>
  <span
    class="pad"
    data-slot="SidebarStatus"
    :data-status="status"
    :data-current="current ? 'true' : undefined"
    role="img"
    :aria-label="label"
  >
    <i class="fill" />
  </span>
</template>

<style scoped>
.pad {
  flex: none;
  box-sizing: border-box;
  position: relative;
  display: inline-block;
  overflow: hidden;
  width: 9px;
  height: 9px;
  margin-right: var(--lec-space-2);
  border: var(--lec-line-mid) solid var(--lec-border);
  border-radius: var(--lec-status-radius);
}
.fill {
  position: absolute;
  inset: auto 0 0 0;
  height: 0;
  background: var(--lec-done);
}
.pad[data-status='in_progress'] {
  border-color: var(--lec-done);
}
.pad[data-status='in_progress'] .fill {
  height: 50%;
}
.pad[data-status='completed'] {
  border-color: var(--lec-done);
}
.pad[data-status='completed'] .fill {
  height: 100%;
}
</style>
