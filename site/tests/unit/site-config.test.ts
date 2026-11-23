import { describe, expect, it } from 'vitest'
import { STORAGE_KEYS } from '../../docs/.vitepress/site.config.mts'

// Freezes the V1 localStorage key contract (plan §2.7): renaming any of these
// keys silently drops users' reading mode / progress / cached data.
describe('site.config STORAGE_KEYS (V1 contract)', () => {
  it('keeps V1 key literals unchanged', () => {
    expect(STORAGE_KEYS.readingMode).toBe('lecture-reading-mode')
    expect(STORAGE_KEYS.readingProgress).toBe('lecture-read-pos')
    expect(STORAGE_KEYS.neonPrefix).toBe('tut_neon_')
  })
})
