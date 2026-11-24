<script setup lang="ts">
/**
 * NotFound.vue — the engine's 404 page (S6Y F6, audit-spec #15), shown through DefaultTheme.Layout's `not-found` slot.
 * Layout follows spec board 15 (the permission page): a small icon, a title, one sentence with the path, and two ways on
 * (home of the current language, search). Text comes from i18n only; tokens only (--lec-*); no all-caps eyebrow (17).
 */
import { computed } from 'vue'
import { useData, useRoute, withBase } from 'vitepress'
import { useT } from '../../i18n/useT.ts'

defineOptions({ name: 'LecNotFound' })

const { t } = useT()
const { localeIndex } = useData()
const route = useRoute()

const homeHref = computed(() => (localeIndex.value && localeIndex.value !== 'root' ? `/${localeIndex.value}/` : '/'))
const path = computed(() => route.path)

function openSearch(): void {
  if (typeof document === 'undefined') return
  document.querySelector<HTMLButtonElement>('.lec-search-btn')?.click()
}
</script>

<template>
  <div class="lec-nf" data-lec-not-found>
    <span class="lec-nf-mark" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="8" cy="8" r="5" />
        <line x1="11.8" y1="11.8" x2="15.5" y2="15.5" stroke-linecap="round" />
      </svg>
    </span>
    <h1>{{ t('notFound.title') }}</h1>
    <p>{{ t('notFound.body') }}</p>
    <p class="lec-nf-path"><code>{{ path }}</code></p>
    <div class="lec-nf-row">
      <a class="lec-nf-btn is-primary" :href="withBase(homeHref)">{{ t('notFound.home') }}</a>
      <button type="button" class="lec-nf-btn" data-lec-not-found-search @click="openSearch">{{ t('notFound.search') }}</button>
    </div>
  </div>
</template>

<style scoped>
.lec-nf {
  display: grid;
  gap: var(--lec-space-3);
  justify-items: start;
  max-width: 30em;
  margin: 0 auto;
  padding: 96px var(--lec-space-5) 128px;
  color: var(--lec-text);
  font-family: var(--lec-font-heading);
  font-size: 14px;
  line-height: 1.6;
}
.lec-nf-mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-2);
  background: var(--lec-surface);
  color: var(--lec-text-muted);
}
.lec-nf h1 {
  margin: 0;
  font-size: 22px;
  font-weight: var(--lec-heading-weight);
  line-height: 1.3;
}
.lec-nf p {
  margin: 0;
  color: var(--lec-text-muted);
}
.lec-nf-path code {
  font-family: var(--lec-font-mono);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.lec-nf-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--lec-space-2);
}
.lec-nf-btn {
  display: inline-flex;
  align-items: center;
  font: 500 13px var(--lec-font-heading);
  line-height: normal;
  padding: 5px 14px;
  border: var(--lec-line-hair) solid var(--lec-accent);
  border-radius: var(--lec-radius-1);
  background: transparent;
  color: var(--lec-accent);
  text-decoration: none;
  cursor: pointer;
}
.lec-nf-btn.is-primary {
  background: var(--lec-accent);
  color: var(--lec-on-accent);
}
.lec-nf-btn:focus-visible {
  outline: var(--lec-line-heavy) solid var(--lec-accent);
  outline-offset: 2px;
}
</style>
