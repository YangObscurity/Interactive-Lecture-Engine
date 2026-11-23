/**
 * core/locales.ts - the site's non-root locale keys, for client code that has no `useData()`
 * (page features, storage keys). Set once at app setup from VitePress site data (theme/index.ts);
 * until then the list is empty and every path counts as root-language, which is the single-language
 * behaviour. Pure and SSR-safe.
 */
let keys: readonly string[] = []

/** Replace the list (VitePress `site.locales` keys without `root`). */
export function setLocaleKeys(next: readonly string[]): void {
  keys = [...next]
}

/** Non-root locale keys of this site, e.g. `['en']`. */
export function getLocaleKeys(): readonly string[] {
  return keys
}

/** `site.locales` -> the non-root keys. */
export function localeKeysOf(locales: Record<string, unknown> | undefined): string[] {
  return Object.keys(locales ?? {}).filter((k) => k !== 'root')
}
