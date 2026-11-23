import { defineAsyncComponent, h, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { installAutoScrollbar } from './core/scrollbar.ts'
import type { Theme } from 'vitepress'
import { useData, useRoute, withBase } from 'vitepress'
// without-fonts: the theme packs decide the fonts (reader = system stacks, zero webfonts)
import DefaultTheme from 'vitepress/theme-without-fonts'
import 'katex/dist/katex.min.css'
import './styles/vp-bridge.css'
import './custom.css'
import './styles/base.css'
import './styles/print.css'
import './styles/concepts.css'
// compiled --lec-* tokens + fonts and theme.css of the enabled theme packs (plugins/lectureThemePlugin.mts)
import { THEME_RUNTIME } from 'virtual:lecture-theme'
import { COMPANION_PROMPTS } from 'virtual:lecture-prompts'
import { configureCompanionPrompts } from '../prompts/store.ts'
import { chartsFeature, chartsAppFeature } from './charts/index'
import { createLifecycle } from './core/lifecycle'
import { beginBodyHydration, endBodyHydration, waitForBodyHydration } from './core/bodyHydration'
import { readingModeFeature, readingProgressFeature, citesFeature, mathCopyFeature, figureXrefsFeature, conceptsFeature } from './reading'
import { configureConceptsRuntime } from './reading/concepts'
import { quizFeature } from './reading/quiz'
import { slotRuntime } from './slots'
let initialHydrationPassed = false
const HomeBody = defineAsyncComponent(() => {
  if (typeof window !== 'undefined' && !initialHydrationPassed) beginBodyHydration()
  return import('./HomeBody.vue').catch((e) => {
    endBodyHydration()
    throw e
  })
})
const DashboardPage = defineAsyncComponent(() => {
  if (typeof window !== 'undefined' && !initialHydrationPassed) beginBodyHydration()
  return import('./dashboard/DashboardPage.vue').catch((e) => {
    endBodyHydration()
    throw e
  })
})
// counts in the body-hydration gate like the other async page parts: `data-hydrated` must mean the figures can be clicked
const LectureFigure = defineAsyncComponent(() => {
  if (typeof window !== 'undefined' && !initialHydrationPassed) beginBodyHydration()
  return import('./figures/LectureFigure.vue').catch((e) => {
    endBodyHydration()
    throw e
  })
})
const GroupIndex = defineAsyncComponent(() => {
  if (typeof window !== 'undefined' && !initialHydrationPassed) beginBodyHydration()
  return import('./GroupIndex.vue').catch((e) => {
    endBodyHydration()
    throw e
  })
})
import ReadingModeToggle from './components/ReadingModeToggle.vue'
import ReaderSettingsPanel from './components/ReaderSettingsPanel.vue'
import LectureExportButton from './components/LectureExportButton.vue'
import LangSwitch from './components/LangSwitch.vue'
import DashboardLink from './components/DashboardLink.vue'
import LangHint from './components/LangHint.vue'
import LectureTitleHost from './components/LectureTitleHost.vue'
import NavCourseMenuHost from './components/NavCourseMenuHost.vue'
import AiSidebar from './components/ai/AiSidebar.vue'
import SelectionToolbar from './components/ai/SelectionToolbar.vue'
import LectureProgressCard from './components/ai/LectureProgressCard.vue'
import ConceptHeaderBar from './components/ConceptHeaderBar.vue'
import ConceptRelatedFooter from './components/ConceptRelatedFooter.vue'
import { companionRuntime, configureCompanion } from './components/ai/companionRuntime'
import { currentSession, getSession, subscribeSession } from './auth/session'
import { exposeDebug, registerDebugPanel } from './debug/registry'
import { registerThemeDebugPanel } from './tokens/debugPanel'
import { setLocaleKeys, localeKeysOf } from './core/locales'
import { setReaderLang } from './core/readerLang'
import { getRootLang, normalizeLang, setRootLang } from '../i18n/index.ts'
import { configureProgress, progressRuntime, progressStore, registerProgressDebugPanel } from './progress/progressStore'
import { startNotionBridge } from './progress/notionBridge'
import { buildSeed } from './progress/seed'
import { setPageTier } from './access/paths'
import { configureAccess, startAccess } from './access/store'

/** Progress starts once per page load (SPA navigation keeps the same store); never during SSR. */
let progressStarted = false

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => [
        h(LangSwitch),
        h(LectureExportButton),
        h(ReadingModeToggle),
        h(DashboardLink),
        h(ReaderSettingsPanel),
      ],
      'nav-screen-content-after': () => [h(LangSwitch, { screen: true }), h(DashboardLink, { screen: true })],
      'doc-before': () => [h(LangHint), h(LectureTitleHost), h(ConceptHeaderBar)],
      'layout-bottom': () => (companionRuntime().enabled ? [h(AiSidebar), h(SelectionToolbar)] : null),
      'doc-after': () => [h(LectureProgressCard), h(ConceptRelatedFooter)]
    })
  },
  // 首页与组内页都用组件渲染，数据来自 themeConfig.groups（groups.mts 单一来源）
  enhanceApp({ app, siteData }) {
    // P2d: tell client code which locales exist (storage keys ignore the prefix) and which language `/` is in
    // (translate() falls back to it). Runs on the server render as well, before any component.
    setLocaleKeys(localeKeysOf(siteData.value.locales))
    const rootLang = normalizeLang(siteData.value.locales?.root?.lang ?? siteData.value.lang)
    if (rootLang) setRootLang(rootLang)
    // P3b: the access store learns the inline site data; nothing is requested or merged before the theme mounts
    configureAccess({ siteData, withBase })
    configureConceptsRuntime({ base: siteData.value.base || '/', siteData: () => siteData.value })
    configureCompanion(siteData.value.themeConfig)
    configureCompanionPrompts(COMPANION_PROMPTS)
    app.component('HomeBody', HomeBody)
    app.component('GroupIndex', GroupIndex)
    app.component('DashboardPage', DashboardPage)
    app.component('LectureFigure', LectureFigure)
    app.component('ReadingModeToggle', ReadingModeToggle)
    app.component('ReaderSettingsPanel', ReaderSettingsPanel)
    app.component('LectureExportButton', LectureExportButton)
    app.component('LangSwitch', LangSwitch)
    app.component('DashboardLink', DashboardLink)
    app.component('LangHint', LangHint)
    app.component('LectureTitleHost', LectureTitleHost)
    app.component('NavCourseMenuHost', NavCourseMenuHost)
    app.component('AiSidebar', AiSidebar)
    app.component('SelectionToolbar', SelectionToolbar)
    app.component('LectureProgressCard', LectureProgressCard)
  },
  /**
   * 页面生命周期唯一入口（core/lifecycle.ts）。
   *
   * - 首屏：onMounted 之后 enter —— 此时 hydration 已完成，feature 改 DOM 不会造成 mismatch。
   * - SPA 换页：watch(route.path, { flush: 'post' }) —— 新页 DOM 已 patch 完再 enter。
   * - dev：同一 watcher 也看 route.data，md 热更新后重新 enter（换页时二者同 tick 变化，只触发一次）。
   *
   * ⚠️ 不再使用 router.onAfterRouteChange：首次加载时它在 app.mount（hydration）之前执行，
   * 会在 hydration 前改写 SSR DOM（FE-028），且与 onMounted 在首屏各跑一遍（FE-029）。
   */
  setup() {
    const route = useRoute()
    const { isDark, lang: pageLang, theme, frontmatter } = useData()
    // P3b: charts and exports of a restricted lecture live under /_access/<tier>/ (access/paths.ts)
    if (typeof window !== 'undefined') watch(() => frontmatter.value.accessTier, setPageTier, { immediate: true, flush: 'sync' })
    let stopAccess: (() => void) | null = null
    let unmounted = false
    // reader-language preference (plan 3.6): remember the language of every non-root-language page that is shown
    const rememberPageLang = () => {
      const l = normalizeLang(pageLang.value)
      if (l && l !== getRootLang()) setReaderLang(l)
    }
    const lc = createLifecycle(
      [readingModeFeature, readingProgressFeature, chartsFeature, quizFeature, figureXrefsFeature, conceptsFeature],
      [citesFeature, mathCopyFeature, chartsAppFeature]
    )
    const unregister = registerDebugPanel('lifecycle', {
      describe: () => lc.state(),
      actions: { reenter: () => lc.enter(route.path) },
    })
    const unregisterTheme = registerThemeDebugPanel(THEME_RUNTIME, (dark) => {
      isDark.value = dark
    })
    let stopScrollbar: (() => void) | null = null
    let stopNotionBridge: (() => void) | null = null
    let stopNotionSession: (() => void) | null = null
    onMounted(async () => {
      stopScrollbar = installAutoScrollbar()
      await waitForBodyHydration()
      initialHydrationPassed = true
      if (unmounted) return
      // 调试控制台：dev 默认开启；生产需 ?debug=1 或 localStorage 'lecture:debug'='1'
      exposeDebug()
      // P3: the order matters, `configureProgress` must run before anything touches the store
      if (!progressStarted) {
        progressStarted = true
        configureProgress(theme.value)
        registerProgressDebugPanel()
        if (progressRuntime().notionSync) {
          const syncBridgeForSession = () => {
            const s = currentSession()
            const isAdmin = s.status === 'authenticated' && s.roles.includes('admin')
            if (isAdmin && !stopNotionBridge) {
              stopNotionBridge = startNotionBridge()
            } else if (!isAdmin && stopNotionBridge) {
              stopNotionBridge()
              stopNotionBridge = null
            }
          }
          syncBridgeForSession()
          stopNotionSession = subscribeSession(() => syncBridgeForSession())
        }
        // the session is asked for once the auth adapter is configured: the notion bridge and the top-bar Dashboard entry (admins) follow it
        void getSession()
        void progressStore.load()
      }
      rememberPageLang()
      // P3b: ask the gateway which restricted tiers are readable, merge their site data (after hydration, never before)
      // and give the progress store the seed records of their lectures
      stopAccess = startAccess({
        onTierNodes: (nodes) => {
          const seed = buildSeed(nodes)
          if (seed.records.length > 0) progressStore.extendSeed(seed)
        },
      })
      void lc.enter(route.path)
      await nextTick()
      await slotRuntime.whenSettled()
      await nextTick()
      await slotRuntime.whenSettled()
      if (unmounted) return
      document.documentElement.setAttribute('data-hydrated', '1')
    })
    watch(pageLang, rememberPageLang)
    watch(
      () => (import.meta.env.DEV ? [route.path, route.data] : route.path),
      () => void lc.enter(route.path),
      { flush: 'post' }
    )
    onBeforeUnmount(() => {
      unmounted = true
      if (typeof document !== 'undefined') document.documentElement.removeAttribute('data-hydrated')
      stopScrollbar?.()
      stopAccess?.()
      stopNotionBridge?.()
      stopNotionSession?.()
      lc.destroy()
      unregister()
      unregisterTheme()
    })
  },
} satisfies Theme
