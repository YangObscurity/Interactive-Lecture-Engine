/**
 * i18n dictionaries (P2d WP-I1): zh-CN and en have the same keys and the same placeholders per key,
 * keys follow the naming rule, values are non-empty; translate() falls back requested -> root -> zh-CN
 * and interpolates `{name}`; pickLocalized() falls back to the root-language field; localeKeyOf().
 */
import { describe, expect, it } from 'vitest'
import {
  DICTIONARIES,
  LANG_CODES,
  MESSAGE_KEY_RE,
  localeKeyOf,
  normalizeLang,
  pickLocalized,
  translate,
  type LangCode,
  type MessageKey,
} from '../../docs/.vitepress/i18n/index.ts'
import { en } from '../../docs/.vitepress/i18n/en.ts'
import { zhCN } from '../../docs/.vitepress/i18n/zh-CN.ts'

type Dict = Record<string, string>
const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1] as string))].sort()
const zhKeys = Object.keys(zhCN).sort()

describe('dictionary parity', () => {
  it('registers every language code', () => {
    expect([...LANG_CODES]).toEqual(['zh-CN', 'en'])
    for (const l of LANG_CODES) expect(DICTIONARIES[l]).toBeDefined()
  })

  it('zh-CN and en have identical key sets', () => {
    expect(Object.keys(en).sort()).toEqual(zhKeys)
  })

  it('every key is flat, dotted, lower camelCase', () => {
    expect(zhKeys.filter((k) => !MESSAGE_KEY_RE.test(k))).toEqual([])
  })

  it('reserves the theme. prefix (no theme.* keys yet)', () => {
    expect(zhKeys.filter((k) => k.startsWith('theme.'))).toEqual([])
  })

  it('placeholder sets are identical per key', () => {
    const diff = zhKeys.filter((k) => placeholders((zhCN as Dict)[k] as string).join() !== placeholders((en as Dict)[k] as string).join())
    expect(diff).toEqual([])
  })

  it('no empty values', () => {
    for (const l of LANG_CODES) {
      const empty = Object.entries(DICTIONARIES[l]).filter(([, v]) => v.trim() === '')
      expect(empty, l).toEqual([])
    }
  })
})

describe('translate', () => {
  it('returns the requested language', () => {
    expect(translate('zh-CN', 'nav.home')).toBe('总览')
    expect(translate('en', 'nav.home')).toBe('Overview')
  })

  it('interpolates {name} and leaves a missing param as is', () => {
    expect(translate('zh-CN', 'home.startFrom', { id: 'G01', title: '示例课程' })).toBe('开始学习 G01 示例课程')
    expect(translate('en', 'group.cta.continue', { title: 'Lecture 1' })).toBe('Continue: Lecture 1')
    expect(translate('zh-CN', 'home.startFrom', { id: 'G01' })).toBe('开始学习 G01 {title}')
    expect(translate('zh-CN', 'lecture.fallbackTitle', { n: 3 })).toBe('第 3 讲')
  })

  it('falls back requested -> root -> zh-CN', () => {
    const key = 'nav.home' as MessageKey
    const enDict = DICTIONARIES.en as Dict
    const zhDict = DICTIONARIES['zh-CN'] as Dict
    const enOriginal = enDict[key] as string
    const zhOriginal = zhDict[key] as string
    try {
      delete enDict[key]
      // requested en and root en both lack the key -> zh-CN
      expect(translate('en', key, undefined, 'en')).toBe('总览')
      // requested en lacks it, root zh-CN has it
      zhDict[key] = 'ROOT'
      expect(translate('en', key, undefined, 'zh-CN')).toBe('ROOT')
    } finally {
      enDict[key] = enOriginal
      zhDict[key] = zhOriginal
    }
    expect(translate('en', key)).toBe('Overview')
  })

  it('returns the key itself for an unknown key', () => {
    expect(translate('en', 'no.such.key' as MessageKey)).toBe('no.such.key')
  })
})

describe('pickLocalized', () => {
  it('uses the localized field when non-empty', () => {
    expect(pickLocalized({ title: '示例课程', i18n: { en: { title: 'Example course' } } }, 'en', 'title')).toBe('Example course')
  })

  it('falls back to the root field when the language, field or value is missing/empty', () => {
    const group = { title: '示例课程', summary: '摘要', tagline: '一句话', i18n: { en: { title: 'T', tagline: '' } } }
    expect(pickLocalized(group, 'zh-CN', 'title')).toBe('示例课程')
    expect(pickLocalized(group, 'en', 'summary')).toBe('摘要')
    expect(pickLocalized(group, 'en', 'tagline')).toBe('一句话')
    expect(pickLocalized({ title: 'only root' }, 'en', 'title')).toBe('only root')
  })

  it('tolerates a missing object or field', () => {
    expect(pickLocalized(undefined, 'en', 'title')).toBe('')
    expect(pickLocalized({}, 'en', 'title')).toBe('')
  })
})

describe('language helpers', () => {
  it('localeKeyOf maps en->en and zh-CN->zh', () => {
    const cases: Array<[LangCode, string]> = [
      ['en', 'en'],
      ['zh-CN', 'zh'],
    ]
    for (const [lang, key] of cases) expect(localeKeyOf(lang)).toBe(key)
  })

  it('normalizeLang accepts exact codes and regional variants', () => {
    expect(normalizeLang('en')).toBe('en')
    expect(normalizeLang('en-US')).toBe('en')
    expect(normalizeLang('zh')).toBe('zh-CN')
    expect(normalizeLang('zh-CN')).toBe('zh-CN')
    expect(normalizeLang('fr')).toBeNull()
    expect(normalizeLang('')).toBeNull()
  })
})
