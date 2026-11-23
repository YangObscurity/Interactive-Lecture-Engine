/**
 * lecture.config.ts `home` block (P4a WP-H2 / P4b): default home map mode and expansion choice of the overview map,
 * validation errors, schema entries, and storage key of the reader's choice.
 */
import { describe, expect, it } from 'vitest'
import { SITE_BLOCKS, toJSON } from '../../config/schema'
import { LectureConfigError, resolveHome, validateLectureConfig, type LectureConfig } from '../../docs/.vitepress/lecture-config.mts'
import { STORAGE_KEYS } from '../../docs/.vitepress/site.config.mts'
import { ATLAS_PRESETS } from '../../docs/.vitepress/theme/map/atlas/model'

const base: LectureConfig = { theme: 'datasheet' }
const withHome = (home: unknown): LectureConfig => ({ ...base, home: home as LectureConfig['home'] })

describe('home config (map and atlasExpand)', () => {
  it('defaults to map = atlas and atlasExpand = reading', () => {
    expect(resolveHome(base)).toEqual({ map: 'atlas', atlasExpand: 'reading' })
    expect(resolveHome(withHome({}))).toEqual({ map: 'atlas', atlasExpand: 'reading' })
  })

  it('accepts atlas and graph for home.map, and the four presets for home.atlasExpand', () => {
    expect([...SITE_BLOCKS.home.fields.map.values]).toEqual(['atlas', 'graph'])
    expect([...SITE_BLOCKS.home.fields.atlasExpand.values]).toEqual([...ATLAS_PRESETS])
    for (const map of ['atlas', 'graph'] as const) {
      expect(() => validateLectureConfig(withHome({ map }))).not.toThrow()
      expect(resolveHome(withHome({ map }))).toEqual({ map, atlasExpand: 'reading' })
    }
    for (const p of ATLAS_PRESETS) {
      expect(() => validateLectureConfig(withHome({ atlasExpand: p }))).not.toThrow()
      expect(resolveHome(withHome({ atlasExpand: p }))).toEqual({ map: 'atlas', atlasExpand: p })
    }
  })

  it('rejects bad values, unknown keys and non-objects', () => {
    expect(() => validateLectureConfig(withHome({ map: 'mindmap' }))).toThrow(LectureConfigError)
    expect(() => validateLectureConfig(withHome({ map: 'mindmap' }))).toThrow(/home\.map = "mindmap" is not one of atlas \| graph/)
    expect(() => validateLectureConfig(withHome({ atlasExpand: 'open' }))).toThrow(LectureConfigError)
    expect(() => validateLectureConfig(withHome({ atlasExpand: 'open' }))).toThrow(/home\.atlasExpand = "open" is not one of reading \| progress \| all \| none/)
    expect(() => validateLectureConfig(withHome({ columns: 3 }))).toThrow(/home\.columns is not a setting/)
    expect(() => validateLectureConfig(withHome('all'))).toThrow(/home must be an object/)
  })

  it('is in the generated schema with descriptions in both languages', () => {
    for (const key of ['map', 'atlasExpand'] as const) {
      const f = SITE_BLOCKS.home.fields[key]
      expect(f.description.zh.length).toBeGreaterThan(0)
      expect(f.description.en.length).toBeGreaterThan(0)
    }
    expect(SITE_BLOCKS.home.fields.map.default).toBe('atlas')
    expect(SITE_BLOCKS.home.fields.atlasExpand.default).toBe('reading')
    expect(toJSON().blocks.home.fields.map.values).toEqual(['atlas', 'graph'])
    expect(toJSON().blocks.home.fields.atlasExpand.values).toContain('none')
  })

  it('the reader expand choice has its own storage key', () => {
    expect(STORAGE_KEYS.atlasExpand).toBe('lecture:atlas-expand')
  })
})
