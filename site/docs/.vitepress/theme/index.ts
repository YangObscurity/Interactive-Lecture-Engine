import { h, onMounted } from 'vue'
import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import 'katex/dist/katex.min.css'
import './custom.css'
import { initCharts } from './charts'
import { initReadingMode } from './reading-mode'
import { initReadingProgress } from './reading-progress'
import { initCites } from './cites'
import { initMathCopy } from './math-copy'
import HomeBody from './HomeBody.vue'
import GroupIndex from './GroupIndex.vue'
import ReadingModeToggle from './components/ReadingModeToggle.vue'
// 讲义多维导出（长卷 PDF / 全景长图 / 出版级 A4）—— 配置见 site.config.mts 的 LECTURE_EXPORT
import LectureExportButton from './components/LectureExportButton.vue'
import AiSidebar from './components/ai/AiSidebar.vue'
import SelectionToolbar from './components/ai/SelectionToolbar.vue'
import LectureProgressCard from './components/ai/LectureProgressCard.vue'
import { checkOptionalDeps } from './components/depInstallPrompt'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      // 导出按钮排在阅读模式开关之前：导出是「对整篇讲义的动作」，
      // 阅读模式是「当前视图的显示偏好」，动作在前、偏好在后更符合使用顺序。
      'nav-bar-content-after': () => [h(LectureExportButton), h(ReadingModeToggle)],
      'layout-bottom': () => [h(AiSidebar), h(SelectionToolbar)],
      'doc-after': () => h(LectureProgressCard)
    })
  },
  // 首页与组内页都用组件渲染，数据来自 themeConfig.groups（groups.mts 单一来源）
  enhanceApp({ app, router }) {
    app.component('HomeBody', HomeBody)
    app.component('GroupIndex', GroupIndex)
    app.component('ReadingModeToggle', ReadingModeToggle)
    app.component('LectureExportButton', LectureExportButton)
    app.component('AiSidebar', AiSidebar)
    app.component('SelectionToolbar', SelectionToolbar)
    app.component('LectureProgressCard', LectureProgressCard)

    /**
     * SPA 换页后的补渲染 / 恢复，必须挂在这个钩子上。
     *
     * ⚠️ 踩过的坑：原先只依赖 setup() 里的 onMounted / onUpdated。
     * onMounted 只在整页加载时触发；onUpdated 只有在**当前组件自身重新渲染**时才触发——
     * SPA 换页时重新渲染的是子树，根组件不一定更新，于是钩子根本没跑：
     * 表现就是「从首页点继续阅读，页面跳到目标讲但停在顶部」。
     *
     * VitePress 的 router 在每次路由切换后会 `await router.onAfterRouteChange?.(href)`
     * （见 vitepress/dist/client/app/router.js），这个钩子是留给主题的，核心自己不会设置。
     * 两个名字都写：新名优先，旧名兜底。
     */
    const afterRoute = () => {
      // 构建期 SSR 也会触发 router.go，必须挡掉服务端（document 不存在）
      if (typeof window === 'undefined') return
      initCharts()          // 幂等：只处理 :not([data-rendered])
      initReadingProgress() // 幂等：读 localStorage 恢复该讲的阅读位置
    }
    ;(router as any).onAfterRouteChange = afterRoute
    ;(router as any).onAfterRouteChanged = afterRoute
  },
  setup() {
    onMounted(() => {
      initReadingMode()
      initCites()
      initMathCopy()
      initCharts()
      initReadingProgress()
      // 选装依赖检查（仅本地 dev 有意义）：缺 puppeteer 时在右下角给出
      // 「一键安装」引导 + 进度条。已装或非 dev 时静默返回，不打扰。
      // 只在首次挂载检查一次 —— 它不是随路由变化的状态。
      checkOptionalDeps()
    })
  },
} satisfies Theme
