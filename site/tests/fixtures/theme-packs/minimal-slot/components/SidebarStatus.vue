<script setup lang="ts">
/**
 * Example theme component for the `SidebarStatus` slot (contract v1), see docs-dev/SLOTS.md.
 * It receives { status, current, label } from the engine and only draws: a square pad that is hollow, half
 * filled or solid. `label` must stay the accessible name. Colours come from --lec-* variables only.
 */
defineProps<{
  status: 'not_started' | 'in_progress' | 'completed'
  current: boolean
  label: string
}>()
</script>

<template>
  <span
    class="minimal-pad"
    data-slot="SidebarStatus"
    :data-status="status"
    :data-current="current ? 'true' : undefined"
    role="img"
    :aria-label="label"
  />
</template>

<style scoped>
.minimal-pad {
  flex: none;
  box-sizing: border-box;
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: var(--lec-space-2);
  border: var(--lec-line-mid) solid var(--lec-border);
}
.minimal-pad[data-status='in_progress'] {
  border-color: var(--lec-done);
  background: linear-gradient(to top, var(--lec-done) 50%, transparent 50%);
}
.minimal-pad[data-status='completed'] {
  border-color: var(--lec-done);
  background: var(--lec-done);
}
</style>
