/**
 * lecture.config.ts `i18n` block (P2d WP-I1): defaults, root-first ordering, de-duplication and the
 * validation errors (unknown language, root missing from locales, empty locales).
 */
import { describe, expect, it } from 'vitest'
import { LectureConfigError, defineLectureConfig, resolveI18n, validateLectureConfig, type LectureConfig } from '../../docs/.vitepress/lecture-config.mts'
import type { LangCode } from '../../docs/.vitepress/i18n/index.ts'

const base: LectureConfig = { theme: 'datasheet' }
const withI18n = (i18n: unknown): LectureConfig => ({ ...base, i18n: i18n as LectureConfig['i18n'] })

describe('resolveI18n', () => {
  it('defaults to root zh-CN and locales [zh-CN, en]', () => {
    expect(resolveI18n(base)).toEqual({ root: 'zh-CN', locales: ['zh-CN', 'en'] })
    expect(resolveI18n(withI18n({}))).toEqual({ root: 'zh-CN', locales: ['zh-CN', 'en'] })
  })

  it('puts the root first', () => {
    expect(resolveI18n(withI18n({ root: 'en' }))).toEqual({ root: 'en', locales: ['en', 'zh-CN'] })
    expect(resolveI18n(withI18n({ root: 'en', locales: ['zh-CN', 'en'] }))).toEqual({ root: 'en', locales: ['en', 'zh-CN'] })
  })

  it('removes duplicates', () => {
    const locales = ['en', 'zh-CN', 'en', 'zh-CN'] as LangCode[]
    expect(resolveI18n(withI18n({ locales }))).toEqual({ root: 'zh-CN', locales: ['zh-CN', 'en'] })
  })

  it('supports a root-only site', () => {
    expect(resolveI18n(withI18n({ locales: ['zh-CN'] }))).toEqual({ root: 'zh-CN', locales: ['zh-CN'] })
  })
})

describe('validateLectureConfig i18n', () => {
  it('accepts a valid block and returns the config', () => {
    const cfg = withI18n({ root: 'zh-CN', locales: ['zh-CN', 'en'] })
    expect(validateLectureConfig(cfg)).toBe(cfg)
    expect(defineLectureConfig(base)).toBe(base)
  })

  it('rejects an unknown language and lists the allowed values', () => {
    const run = () => validateLectureConfig(withI18n({ locales: ['zh-CN', 'fr'] }))
    expect(run).toThrow(LectureConfigError)
    expect(run).toThrow(/"fr"/)
    expect(run).toThrow(/allowed: zh-CN, en/)
    expect(() => validateLectureConfig(withI18n({ root: 'de' }))).toThrow(/i18n\.root = "de".*allowed: zh-CN, en/)
  })

  it('rejects a root that is not in locales', () => {
    expect(() => validateLectureConfig(withI18n({ root: 'en', locales: ['zh-CN'] }))).toThrow(/root "en" must be one of i18n\.locales/)
    // the default root zh-CN is checked too
    expect(() => validateLectureConfig(withI18n({ locales: ['en'] }))).toThrow(/root "zh-CN" must be one of i18n\.locales/)
  })

  it('rejects an empty locales list', () => {
    expect(() => validateLectureConfig(withI18n({ locales: [] }))).toThrow(/non-empty/)
  })
})
