/**
 * curriculum/useCurriculum.ts - Vue composable over the curriculum loader (P4a WP-H1).
 *
 * Server render and hydration show `initial` (pass the build-time data for the numbers that must be in the HTML, e.g.
 * the page's own `import { data } from './curriculum.data.mts'`), or null. After mount the merged curriculum is loaded
 * and replaces it; it is loaded again when the access answer changes (sign-in / sign-out) or the locale changes.
 * `loaded` is true once the first merged answer is in.
 */
import { onBeforeUnmount, onMounted, shallowRef, toValue, watch } from 'vue'
import type { MaybeRefOrGetter, Ref } from 'vue'
import { useData } from 'vitepress'
import type { CurriculumData } from '../../curriculum/data'
import { useAccess } from '../access/useAccess'
import { loadCurriculum } from './loader'

export interface UseCurriculumOptions {
  /** Locale bucket (`root`, `en`); default: the page's `localeIndex`. */
  locale?: MaybeRefOrGetter<string>
  /** What server render and hydration show before the merged data is loaded. */
  initial?: CurriculumData | null
}

export interface UseCurriculum {
  data: Readonly<Ref<CurriculumData | null>>
  loaded: Readonly<Ref<boolean>>
}

export function useCurriculum(options: UseCurriculumOptions = {}): UseCurriculum {
  const { localeIndex } = useData()
  const access = useAccess()
  const data = shallowRef<CurriculumData | null>(options.initial ?? null)
  const loaded = shallowRef(false)
  const currentLocale = (): string => toValue(options.locale) ?? localeIndex.value
  let stop: (() => void) | null = null
  let token = 0
  const load = async (): Promise<void> => {
    const mine = ++token
    const result = await loadCurriculum(currentLocale())
    if (mine !== token) return
    data.value = result
    loaded.value = true
  }
  onMounted(() => {
    stop = watch([currentLocale, access.version], () => void load(), { immediate: true })
  })
  onBeforeUnmount(() => {
    token++
    stop?.()
  })
  return { data, loaded }
}
