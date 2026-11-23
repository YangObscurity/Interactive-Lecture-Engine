/**
 * core/homeMapMode.ts - the reader's remembered home map (`atlas` overview or `graph` dependency canvas).
 *
 * One source for three readers of the same stored value: the inline first-paint script in `<head>` (sets `data-home-map` on
 * `<html>` before the first paint, so the toggle and the map region are right in the first frame), the home component, and the
 * tests. The storage key comes from `STORAGE_KEYS.homeMapMode` through `core/storage` (no second spelling of it). Storage that is
 * unavailable (private mode) or holds anything else means "no choice": the site default is used.
 */
import { keysOf, getRaw } from './storage'

export type HomeMapMode = 'atlas' | 'graph'
export const HOME_MAP_MODES: readonly HomeMapMode[] = ['atlas', 'graph']
/** Attribute of `<html>` the head script sets; CSS keys on it (HomeBody.vue). */
export const HOME_MAP_ATTR = 'data-home-map'

export function parseHomeMapMode(value: unknown): HomeMapMode | null {
  return value === 'atlas' || value === 'graph' ? value : null
}

/** The remembered mode: the attribute the head script set, else the storage; null when there is none (or storage is unavailable). */
export function readStoredHomeMapMode(root: { getAttribute(name: string): string | null } | null = typeof document === 'undefined' ? null : document.documentElement): HomeMapMode | null {
  const fromAttr = parseHomeMapMode(root?.getAttribute(HOME_MAP_ATTR))
  if (fromAttr) return fromAttr
  return parseHomeMapMode(getRaw('homeMapMode'))
}

/** The inline `<head>` script body (same key list and read order as `getRaw`). */
export function homeMapModeHeadScript(): string {
  const keys = JSON.stringify(keysOf('homeMapMode'))
  return (
    `try{var k=${keys},v=null;for(var i=0;i<k.length&&v===null;i++)v=localStorage.getItem(k[i]);` +
    `if(v==='atlas'||v==='graph')document.documentElement.setAttribute('${HOME_MAP_ATTR}',v)}catch(e){}`
  )
}
