const KEY = 'lecture-reading-mode'
const BTN_ID = 'lecture-reading-btn'

/** 
 * 初始化 HTML 根节点沉浸状态（外观与交互已由顶栏原生组件 ReadingModeToggle.vue 接管）
 */
export function initReadingMode() {
  if (typeof document === 'undefined') return

  // 彻底清除历史上可能遗留的浮动按键
  const oldBtn = document.getElementById(BTN_ID)
  if (oldBtn) {
    oldBtn.remove()
  }

  // 首页永不开启沉浸模式
  const path = (window.location.pathname || '').replace(/index(?:\.html)?$/, '').replace(/\.html$/, '')
  const isHome = path === '' || path === '/'
  if (isHome) {
    document.documentElement.classList.remove('reading-mode')
    return
  }

  try {
    document.documentElement.classList.toggle('reading-mode', localStorage.getItem(KEY) === '1')
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
}
