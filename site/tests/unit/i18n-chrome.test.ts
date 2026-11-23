/**
 * VitePress chrome strings (P2d WP-I1): for zh-CN the helpers in config.v2.mts must return exactly the
 * literals that config.mts used to hard-code (copied here from the pre-i18n commit), so the Chinese
 * site is unchanged; the en variant is complete and differs.
 */
import { describe, expect, it } from 'vitest'
import { v2ChromeStrings, v2Lang, v2LectureFallback, v2NavLabels, v2SearchTranslations } from '../../docs/.vitepress/config.v2.mts'

describe('v2 chrome strings (zh-CN = old config.mts literals)', () => {
  it('site language is the root of lecture.config.ts (zh-CN by default)', () => {
    expect(v2Lang).toBe('zh-CN')
  })

  it('themeConfig labels', () => {
    expect(v2ChromeStrings('zh-CN')).toEqual({
      outline: { level: [2, 3], label: '本讲大纲' },
      sidebarMenuLabel: '讲次',
      returnToTopLabel: '回到顶部',
      darkModeSwitchLabel: '主题',
      lightModeSwitchTitle: '浅色',
      darkModeSwitchTitle: '深色',
      docFooter: { prev: '上一讲', next: '下一讲' },
      lastUpdatedText: '更新于',
    })
  })

  it('local search translations', () => {
    expect(v2SearchTranslations('zh-CN')).toEqual({
      button: { buttonText: '搜索讲义', buttonAriaLabel: '搜索讲义' },
      modal: {
        noResultsText: '未找到相关内容',
        resetButtonTitle: '清除查询',
        footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
      },
    })
  })

  it('nav labels and the untitled-lecture fallback', () => {
    expect(v2NavLabels('zh-CN')).toEqual({ home: '总览', groups: '课程组', temp: '（临时）' })
    expect(v2LectureFallback('zh-CN', 7)).toBe('第 7 讲')
  })

  it('en variant is complete and different', () => {
    const zh = JSON.stringify([v2ChromeStrings('zh-CN'), v2SearchTranslations('zh-CN'), v2NavLabels('zh-CN')])
    const en = JSON.stringify([v2ChromeStrings('en'), v2SearchTranslations('en'), v2NavLabels('en')])
    expect(en).not.toBe(zh)
    expect(en).not.toMatch(/[㐀-鿿]/)
    expect(v2LectureFallback('en', 7)).toBe('Lecture 7')
  })
})
