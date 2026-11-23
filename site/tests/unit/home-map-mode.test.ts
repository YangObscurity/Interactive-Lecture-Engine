// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { STORAGE_KEYS } from '../../docs/.vitepress/site.config.mts'
import { HOME_MAP_ATTR, homeMapModeHeadScript, parseHomeMapMode, readStoredHomeMapMode } from '../../docs/.vitepress/theme/core/homeMapMode'

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute(HOME_MAP_ATTR)
})

function withThrowingStorage(fn: () => void): void {
  const orig = Storage.prototype.getItem
  Storage.prototype.getItem = () => {
    throw new Error('denied')
  }
  try {
    fn()
  } finally {
    Storage.prototype.getItem = orig
  }
}

describe('stored home map mode', () => {
  it('accepts exactly atlas and graph', () => {
    expect(parseHomeMapMode('atlas')).toBe('atlas')
    expect(parseHomeMapMode('graph')).toBe('graph')
    for (const v of ['', 'Graph', 'canvas', null, undefined, 1]) expect(parseHomeMapMode(v)).toBeNull()
  })

  it('reads the storage under the key of STORAGE_KEYS, and nothing when it is empty or foreign', () => {
    expect(readStoredHomeMapMode()).toBeNull()
    localStorage.setItem(STORAGE_KEYS.homeMapMode, 'graph')
    expect(readStoredHomeMapMode()).toBe('graph')
    localStorage.setItem(STORAGE_KEYS.homeMapMode, 'nonsense')
    expect(readStoredHomeMapMode()).toBeNull()
  })

  it('prefers the attribute the head script set', () => {
    localStorage.setItem(STORAGE_KEYS.homeMapMode, 'atlas')
    document.documentElement.setAttribute(HOME_MAP_ATTR, 'graph')
    expect(readStoredHomeMapMode()).toBe('graph')
  })

  it('uses no mode when the storage throws (private mode)', () => {
    withThrowingStorage(() => expect(readStoredHomeMapMode()).toBeNull())
  })
})

describe('the head script', () => {
  const run = (): void => void new Function(homeMapModeHeadScript())()

  it('sets data-home-map from the stored mode, using the shared key', () => {
    expect(homeMapModeHeadScript()).toContain(JSON.stringify(STORAGE_KEYS.homeMapMode))
    localStorage.setItem(STORAGE_KEYS.homeMapMode, 'graph')
    run()
    expect(document.documentElement.getAttribute(HOME_MAP_ATTR)).toBe('graph')
  })

  it('sets nothing for no value, a foreign value, or a throwing storage', () => {
    run()
    expect(document.documentElement.hasAttribute(HOME_MAP_ATTR)).toBe(false)
    localStorage.setItem(STORAGE_KEYS.homeMapMode, 'x')
    run()
    expect(document.documentElement.hasAttribute(HOME_MAP_ATTR)).toBe(false)
    withThrowingStorage(() => expect(run).not.toThrow())
    expect(document.documentElement.hasAttribute(HOME_MAP_ATTR)).toBe(false)
  })
})
