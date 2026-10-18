/**
 * cites.ts — 正文引用标记（.cite）的交互
 *
 * 背景：正文里**不允许出现链接**（蓝色带下划线会打断阅读）。
 * 行内链接与裸 URL 都被转成 `<span class="cite" data-cite="url">短名</span>`：
 * 平时是浅灰小胶囊，悬停显示 URL，**点击直接在新标签打开该来源**。
 *
 * 2026-10-05 改：原先点击是滚到本讲「## 参考来源」段；该段已全站删除，
 * 改为直接 window.open(data-cite) —— 少一次跳转，读起来更快。
 */
export function initCites() {
  if (document.body.dataset.citesBound === '1') return
  document.body.dataset.citesBound = '1'

  document.body.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest?.('.cite') as HTMLElement | null
    if (!el) return
    const url = (el.dataset.cite || el.getAttribute('title') || '').trim()
    if (!url) return
    e.preventDefault()
    window.open(url, '_blank', 'noopener,noreferrer')
  })
}
