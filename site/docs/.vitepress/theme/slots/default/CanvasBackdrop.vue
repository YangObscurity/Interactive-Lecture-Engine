<script setup lang="ts">
/** Engine default of the `CanvasBackdrop` slot (v1): reader leaves the backdrop empty. */
import type { CanvasBackdropProps } from '../registry.ts'

defineProps<CanvasBackdropProps>()
</script>

<template>
  <g class="cv-backdrop" data-slot="CanvasBackdrop" />
</template>
