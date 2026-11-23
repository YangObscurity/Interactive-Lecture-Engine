/**
 * i18n/useT.ts - Vue composable for components: `const { t, lang } = useT()`.
 * `lang` follows VitePress `useData().lang`, so templates re-render when the locale changes.
 */
import { computed, type ComputedRef } from 'vue'
import { useData } from 'vitepress'
import { normalizeLang, translate, getRootLang, type LangCode, type MessageKey, type MessageParams } from './index.ts'

export function useT(): { t: (key: MessageKey, params?: MessageParams) => string; lang: ComputedRef<LangCode> } {
  const { lang: siteLang } = useData()
  const lang = computed<LangCode>(() => normalizeLang(siteLang.value) ?? getRootLang())
  const t = (key: MessageKey, params?: MessageParams): string => translate(lang.value, key, params)
  return { t, lang }
}
