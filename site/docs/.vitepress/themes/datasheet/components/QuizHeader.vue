<script setup lang="ts">
/** Datasheet implementation of `QuizHeader` (v1, hardware-manual spec strip, spec board §08). */
import type { QuizHeaderProps } from '../../../theme/slots/registry.ts'

defineProps<QuizHeaderProps>()
</script>

<template>
  <div class="lec-quiz-head lec-quiz-head--ds">
    <b>{{ badge }}</b>
    <span class="lec-quiz-meta">{{ totalLabel }}</span>
  </div>
</template>

<style scoped>
.lec-quiz-head--ds {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--lec-space-3);
  padding: var(--lec-space-2) var(--lec-space-4);
  background: var(--lec-surface);
  border: var(--lec-line-hair) solid var(--lec-border);
  border-top: var(--lec-line-heavy) solid var(--lec-text);
  border-left: 3px solid var(--lec-accent);
  border-bottom: var(--lec-line-hair) solid var(--lec-border);
  font-family: var(--lec-font-mono);
  font-size: 12px;
  /* S6Y F1: spec board 08 .quiz-head padding 8px 16px; line box 20.8px like the reader head (13px x 1.6) */
  line-height: 20.8px;
}
.lec-quiz-head--ds b {
  color: var(--lec-text);
}
.lec-quiz-meta {
  color: var(--lec-text-muted);
}
</style>
