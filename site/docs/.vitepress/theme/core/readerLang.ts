/**
 * core/readerLang.ts - the reader-language preference (plan_v2_p2d_i18n.md 3.6).
 *
 * A LangCode in localStorage (`STORAGE_KEYS.readerLang`). Written when the reader uses the language switcher and
 * whenever a non-root-language page is shown. It only decides whether a root-language lecture page shows the
 * "translated / not translated" note (LangHint); there is never an automatic redirect.
 *
 * `readerLang` is a shared ref: it stays null on the server and during hydration and is filled by `loadReaderLang()`
 * after mount, so SSR and the first client render are identical.
 */
import { ref } from 'vue'
import { isLangCode, type LangCode } from '../../i18n/langs.ts'
import { getRaw, setRaw } from './storage'

export const readerLang = ref<LangCode | null>(null)

/** The stored preference, or null (nothing stored, junk, or no storage). Never throws. */
export function getReaderLang(): LangCode | null {
  const raw = getRaw('readerLang')
  return isLangCode(raw) ? raw : null
}

/** Read the stored preference into `readerLang` (client only, call after mount). */
export function loadReaderLang(): void {
  readerLang.value = getReaderLang()
}

/** Remember the reader's language (storage failures are swallowed by core/storage). */
export function setReaderLang(lang: LangCode): void {
  setRaw('readerLang', lang)
  readerLang.value = lang
}
