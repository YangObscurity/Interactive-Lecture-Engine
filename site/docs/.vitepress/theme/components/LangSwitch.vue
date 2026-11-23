<script setup lang="ts">
/**
 * LangSwitch.vue - language switcher (nav bar + mobile nav screen), plan_v2_p2d_i18n.md 3.6 / WP-I3.
 *
 * Shows the OTHER language(s) by endonym. Two languages give one plain link; more give a small `<details>` menu.
 * Every entry is a real `<a href>` (works without JS, middle-click opens a tab). The target is decided by
 * `switchTarget` (core/langLinks.ts): lecture -> the translation if it exists, else that language's page of the
 * same group; group -> same group; anything else -> that language's home. Clicking also stores the reader-language
 * preference before the navigation. Renders nothing on a single-language site.
 *
 * SSR: everything derives from the route and site data, so server and client render the same markup.
 * Style: only `--lec-*` tokens.
 */
import { computed } from 'vue'
import { useData, useRoute, withBase } from 'vitepress'
import { translate, type LangCode } from '../../i18n/index.ts'
import { useT } from '../../i18n/useT.ts'
import { siteLangs, switchTarget } from '../core/langLinks'
import { setReaderLang } from '../core/readerLang'

defineProps<{ screen?: boolean }>()

const { site, theme } = useData()
const route = useRoute()
const { t, lang } = useT()

const langs = computed(() => siteLangs(site.value.locales))
const groupDirs = computed(() => ((theme.value as { groups?: Array<{ dir: string }> }).groups ?? []).map((g) => g.dir))

const entries = computed(() => {
  if (langs.value.length < 2) return []
  return langs.value
    .filter((l) => l.lang !== lang.value)
    .map((l) => ({
      lang: l.lang,
      name: translate(l.lang, 'lang.name'),
      href: withBase(switchTarget(route.path, l, { locales: site.value.locales, groupDirs: groupDirs.value, base: site.value.base })),
    }))
})

function remember(target: LangCode): void {
  setReaderLang(target)
}
</script>

<template>
  <nav v-if="entries.length" class="lang-switch" :class="{ 'is-screen': screen, 'is-menu': entries.length > 1 }" :aria-label="t('lang.switch.aria')">
    <a
      v-if="entries.length === 1"
      class="lang-switch-link"
      :href="entries[0].href"
      :lang="entries[0].lang"
      :title="t('lang.switch.title', { name: entries[0].name })"
      @click="remember(entries[0].lang)"
    >{{ entries[0].name }}</a>
    <details v-else class="lang-switch-menu">
      <summary class="lang-switch-link">{{ translate(lang, 'lang.name') }}</summary>
      <ul class="lang-switch-list">
        <li v-for="e in entries" :key="e.lang">
          <a
            class="lang-switch-link"
            :href="e.href"
            :lang="e.lang"
            :title="t('lang.switch.title', { name: e.name })"
            @click="remember(e.lang)"
          >{{ e.name }}</a>
        </li>
      </ul>
    </details>
  </nav>
</template>

<style scoped>
.lang-switch {
  display: flex;
  align-items: center;
  margin-left: 8px;
  position: relative;
}

.lang-switch-link {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  color: var(--lec-text-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
  user-select: none;
  transition: border-color 0.2s ease, color 0.2s ease;
}

.lang-switch-link:hover {
  border-color: var(--lec-accent);
  color: var(--lec-text);
}

.lang-switch-menu summary {
  list-style: none;
}

.lang-switch-menu summary::-webkit-details-marker {
  display: none;
}

.lang-switch-list {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 2;
  margin: 0;
  padding: 4px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-2);
  background: var(--lec-bg);
}

.lang-switch.is-screen {
  margin: 12px 0 0;
}

/* same 8px gap as the export / reading-mode buttons that follow (the export button only has margin-left: 1px) */
.lang-switch:not(.is-screen) {
  margin-right: 7px;
}

/* below VitePress's hamburger breakpoint the switcher lives in the nav screen only: on a 390px bar it pushed the
   reading-mode button off-screen (P2d audit) */
@media (max-width: 767px) {
  .lang-switch:not(.is-screen) {
    display: none;
  }
}
</style>
