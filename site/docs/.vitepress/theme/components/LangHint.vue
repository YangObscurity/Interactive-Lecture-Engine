<script setup lang="ts">
/**
 * LangHint.vue - note above a root-language lecture, for readers whose stored language is another one
 * (plan_v2_p2d_i18n.md 3.6 / WP-I3). Mounted in the `doc-before` slot.
 *
 * Shown only when ALL hold: the page is a root-language lecture, the reader-language preference is an enabled
 * non-root language L, and the component has mounted. Text comes from L's dictionary (the reader's language).
 *   - translation exists in L: "available in L" + link to it;
 *   - not translated: says so, links back to L's course page of the group, and offers "Continue in <root>"
 *     which stores the root language as the preference (the note disappears and stays gone).
 *
 * Hydration: `mounted` is false during SSR and the first client render and the preference ref starts null, so
 * server markup and the first client render are the same (nothing). The note appears after mount.
 * Style: only `--lec-*` tokens.
 */
import { computed, onMounted, ref } from 'vue'
import { useData, useRoute, withBase } from 'vitepress'
import { translate, langLabel, type MessageKey } from '../../i18n/index.ts'
import { parseLecture } from '../core/route'
import { hasTranslation, siteLangs } from '../core/langLinks'
import { loadReaderLang, readerLang, setReaderLang } from '../core/readerLang'

const { site } = useData()
const route = useRoute()
const mounted = ref(false)

onMounted(() => {
  loadReaderLang()
  mounted.value = true
})

const langs = computed(() => siteLangs(site.value.locales))

const view = computed(() => {
  if (!mounted.value || langs.value.length < 2) return null
  const root = langs.value.find((l) => l.isRoot)
  const target = langs.value.find((l) => !l.isRoot && l.lang === readerLang.value)
  if (!root || !target) return null
  const keys = langs.value.filter((l) => !l.isRoot).map((l) => l.key)
  const lec = parseLecture(route.path, site.value.base, keys)
  if (!lec || lec.locale) return null
  const L = target.lang
  const tr = (key: MessageKey, params?: Record<string, string>) => translate(L, key, params)
  if (hasTranslation(site.value.locales, target.key, lec.path)) {
    return {
      kind: 'available' as const,
      lang: L,
      text: tr('langHint.available'),
      linkText: tr('langHint.read'),
      href: withBase(`/${target.key}${lec.path}`),
    }
  }
  const rootName = langLabel(L, root.lang)
  return {
    kind: 'untranslated' as const,
    lang: L,
    text: tr('langHint.untranslated', { lang: langLabel(L, L), root: rootName }),
    linkText: tr('langHint.back', { lang: langLabel(L, L) }),
    href: withBase(`/${target.key}/${lec.dir}/`),
    continueText: tr('langHint.continue', { root: rootName }),
    rootLang: root.lang,
  }
})

function continueInRoot(): void {
  const v = view.value
  if (v?.kind === 'untranslated') setReaderLang(v.rootLang)
}
</script>

<template>
  <aside v-if="view" class="lang-hint" role="note" :lang="view.lang" :data-lang-hint="view.kind">
    <span class="lang-hint-text">{{ view.text }}</span>
    <a class="lang-hint-link" :href="view.href">{{ view.linkText }}</a>
    <button v-if="view.kind === 'untranslated'" type="button" class="lang-hint-btn" @click="continueInRoot">{{ view.continueText }}</button>
  </aside>
</template>

<style scoped>
.lang-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px;
  margin: 0 0 16px;
  padding: 8px 12px;
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-2);
  background: var(--lec-surface);
  color: var(--lec-text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.lang-hint-link {
  color: var(--lec-accent);
  font-weight: 500;
  text-decoration: none;
}

.lang-hint-link:hover {
  text-decoration: underline;
}

.lang-hint-btn {
  padding: 2px 10px;
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: transparent;
  color: var(--lec-text);
  font-size: 12px;
  cursor: pointer;
}

.lang-hint-btn:hover {
  border-color: var(--lec-accent);
}
</style>
