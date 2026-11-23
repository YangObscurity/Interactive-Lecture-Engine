<script setup lang="ts">
/** Engine default of `QuizHeader` (v1, reader style, spec board §08). */
import type { QuizHeaderProps } from '../registry.ts'

defineProps<QuizHeaderProps>()
</script>

<template>
  <div class="lec-quiz-head lec-quiz-head--reader">
    <b>{{ badge }}</b>
    <span class="lec-quiz-meta">{{ totalLabel }}</span>
  </div>
</template>

<style scoped>
.lec-quiz-head--reader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--lec-space-3);
  padding: 6px var(--lec-space-4);
  background: var(--lec-surface);
  border: var(--lec-line-hair) solid var(--lec-border);
  border-left: 3px solid var(--lec-accent);
  border-bottom: 0;
  border-radius: var(--lec-radius-2) var(--lec-radius-2) 0 0;
  font-size: 13px;
  line-height: 1.4;
}
.lec-quiz-head--reader b {
  font-family: var(--lec-font-heading);
  color: var(--lec-accent);
}
.lec-quiz-meta {
  color: var(--lec-text-muted);
}
</style>
