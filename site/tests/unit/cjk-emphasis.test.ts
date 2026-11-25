import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'
import { cjkEmphasisPlugin } from '../../docs/.vitepress/plugins/cjkEmphasisPlugin.ts'

describe('cjkEmphasisPlugin', () => {
  it('renders strong emphasis across CJK punctuation boundaries while preserving ASCII/code semantics', () => {
    const md = new MarkdownIt({ html: true })
    md.use(cjkEmphasisPlugin)

    const cases = [
      [
        'Rupert 是全系统中**唯一有权签署并签发物理执行租约（Actuation Lease）**的实体。',
        '<p>Rupert 是全系统中<strong>唯一有权签署并签发物理执行租约（Actuation Lease）</strong>的实体。</p>',
      ],
      [
        '由**“物理世界”**决定采样边界，再以**二氧化碳当量（CO2e）**表示。',
        '<p>由<strong>“物理世界”</strong>决定采样边界，再以<strong>二氧化碳当量（CO2e）</strong>表示。</p>',
      ],
      [
        'Plain ASCII 2*3*4 and foo_bar_baz and `**literal_in_code**` stay intact.',
        '<p>Plain ASCII 2<em>3</em>4 and foo_bar_baz and <code>**literal_in_code**</code> stay intact.</p>',
      ],
      [
        'Ogham\u1680**加粗**\u1680分隔与扩展汉字\u{20000}**强调**\u{20000}边界。',
        '<p>Ogham\u1680<strong>加粗</strong>\u1680分隔与扩展汉字\u{20000}<strong>强调</strong>\u{20000}边界。</p>',
      ],
    ] as const

    for (const [src, expected] of cases) {
      expect(md.render(src).trim()).toBe(expected)
    }
  })
})
