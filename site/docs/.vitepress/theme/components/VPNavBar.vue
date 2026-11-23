<script lang="ts" setup>
/**
 * Overridden from VitePress 1.6.4 (vitepress/dist/client/theme-default/components/VPNavBar.vue), MIT License.
 * P5 (WP-R3): compute structural classes (`has-sidebar`, `home`) synchronously instead of inside `watchPostEffect`
 * so SSR HTML includes `.VPNavBar.has-sidebar` on lecture pages and eliminates the ~650 ms 32 px navbar CLS.
 * Client-only state (`top`, `screen-open` transition) activates after mount with zero hydration mismatch.
 */
import { useWindowScroll } from '@vueuse/core'
import { computed, onMounted, ref } from 'vue'
import { useData } from 'vitepress'
import { useSidebar } from 'vitepress/theme-without-fonts'
import SearchHost from '../search/SearchHost.vue'
import VPNavBarAppearance from 'vitepress/dist/client/theme-default/components/VPNavBarAppearance.vue'
import VPNavBarExtra from 'vitepress/dist/client/theme-default/components/VPNavBarExtra.vue'
import VPNavBarHamburger from 'vitepress/dist/client/theme-default/components/VPNavBarHamburger.vue'
import VPNavBarMenu from 'vitepress/dist/client/theme-default/components/VPNavBarMenu.vue'
import VPNavBarSocialLinks from 'vitepress/dist/client/theme-default/components/VPNavBarSocialLinks.vue'
import VPNavBarTitle from 'vitepress/dist/client/theme-default/components/VPNavBarTitle.vue'
import VPNavBarTranslations from 'vitepress/dist/client/theme-default/components/VPNavBarTranslations.vue'

const props = defineProps<{
  isScreenOpen: boolean
}>()

defineEmits<{
  (e: 'toggle-screen'): void
}>()

const { y } = useWindowScroll()
const { hasSidebar } = useSidebar()
const { frontmatter } = useData()

const mounted = ref(false)
onMounted(() => {
  mounted.value = true
})

const classes = computed<Record<string, boolean>>(() => ({
  'has-sidebar': hasSidebar.value,
  home: frontmatter.value.layout === 'home',
  top: mounted.value ? y.value === 0 : true,
  'screen-open': props.isScreenOpen,
}))
</script>

<template>
  <div class="VPNavBar" :class="classes">
    <div class="wrapper">
      <div class="container">
        <div class="title">
          <VPNavBarTitle>
            <template #nav-bar-title-before><slot name="nav-bar-title-before" /></template>
            <template #nav-bar-title-after><slot name="nav-bar-title-after" /></template>
          </VPNavBarTitle>
        </div>

        <div class="content">
          <div class="content-body">
            <slot name="nav-bar-content-before" />
            <SearchHost class="search" />
            <VPNavBarMenu class="menu" />
            <VPNavBarTranslations class="translations" />
            <VPNavBarAppearance class="appearance" />
            <VPNavBarSocialLinks class="social-links" />
            <VPNavBarExtra class="extra" />
            <slot name="nav-bar-content-after" />
            <VPNavBarHamburger class="hamburger" :active="isScreenOpen" @click="$emit('toggle-screen')" />
          </div>
        </div>
      </div>
    </div>

    <div class="divider">
      <div class="divider-line" />
    </div>
  </div>
</template>

<style scoped>
.VPNavBar {
  position: relative;
  height: var(--vp-nav-height);
  pointer-events: none;
  white-space: nowrap;
  transition: background-color 0.25s;
}

.VPNavBar.screen-open {
  transition: none;
  background-color: var(--vp-nav-bg-color);
  border-bottom: 1px solid var(--vp-c-divider);
}

.VPNavBar:not(.home) {
  background-color: var(--vp-nav-bg-color);
}

@media (min-width: 960px) {
  .VPNavBar:not(.home) {
    background-color: transparent;
  }

  .VPNavBar:not(.has-sidebar):not(.home.top) {
    background-color: var(--vp-nav-bg-color);
  }
}

.wrapper {
  padding: 0 8px 0 24px;
}

@media (min-width: 768px) {
  .wrapper {
    padding: 0 32px;
  }
}

@media (min-width: 960px) {
  .VPNavBar.has-sidebar .wrapper {
    padding: 0;
  }
}

.container {
  display: flex;
  justify-content: space-between;
  margin: 0 auto;
  max-width: calc(var(--vp-layout-max-width) - 64px);
  height: var(--vp-nav-height);
  pointer-events: none;
}

.container > .title,
.container > .content {
  pointer-events: none;
}

.container :deep(*) {
  pointer-events: auto;
}

@media (min-width: 960px) {
  .VPNavBar.has-sidebar .container {
    max-width: 100%;
  }
}

.title {
  flex-shrink: 0;
  height: calc(var(--vp-nav-height) - 1px);
  transition: background-color 0.5s;
}

@media (min-width: 960px) {
  .VPNavBar.has-sidebar .title {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 2;
    padding: 0 32px;
    width: var(--vp-sidebar-width);
    height: var(--vp-nav-height);
    background-color: transparent;
  }
}

@media (min-width: 1440px) {
  .VPNavBar.has-sidebar .title {
    padding-left: max(32px, calc((100% - (var(--vp-layout-max-width) - 64px)) / 2));
    width: calc((100% - (var(--vp-layout-max-width) - 64px)) / 2 + var(--vp-sidebar-width) - 32px);
  }
}

.content {
  flex-grow: 1;
}

.title :deep(.site-title-short) {
  display: none;
}

/*
 * Phone: the bar holds the site title, search, export, reading mode, reader settings and the hamburger. They add up to more than
 * 390 px next to a long site title (the zh title), so the page scrolled sideways. The buttons keep their size (touch targets);
 * the title switches to the short title (if configured) or gives way with an ellipsis.
 */
@media (max-width: 767px) {
  .title :deep(.site-title-full) {
    display: none !important;
  }
  .title :deep(.site-title-short) {
    display: inline !important;
  }
  .container > .title {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
  }
  .container > .content {
    flex-shrink: 0;
  }
  .title :deep(.VPNavBarTitle .title) {
    min-width: 0;
  }
  .title :deep(.VPNavBarTitle .title > span) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

@media (min-width: 960px) {
  .VPNavBar.has-sidebar .content {
    position: relative;
    z-index: 1;
    padding-right: 32px;
    padding-left: var(--vp-sidebar-width);
  }
}

@media (min-width: 1440px) {
  .VPNavBar.has-sidebar .content {
    padding-right: calc((100vw - var(--vp-layout-max-width)) / 2 + 32px);
    padding-left: calc((100vw - var(--vp-layout-max-width)) / 2 + var(--vp-sidebar-width));
  }
}

.content-body {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  height: var(--vp-nav-height);
  transition: background-color 0.5s;
}

@media (min-width: 960px) {
  .VPNavBar:not(.home.top) .content-body {
    position: relative;
    background-color: var(--vp-nav-bg-color);
  }

  .VPNavBar:not(.has-sidebar):not(.home.top) .content-body {
    background-color: transparent;
  }
}

@media (max-width: 767px) {
  .content-body {
    column-gap: 0.5rem;
  }
}

.menu + .translations::before,
.menu + .appearance::before,
.menu + .social-links::before,
.translations + .appearance::before,
.appearance + .social-links::before {
  margin-right: 8px;
  margin-left: 8px;
  width: 1px;
  height: 24px;
  background-color: var(--vp-c-divider);
  content: "";
}

.menu + .appearance::before,
.translations + .appearance::before {
  margin-right: 16px;
}

.appearance + .social-links::before {
  margin-left: 16px;
}

.social-links {
  margin-right: -8px;
}

.divider {
  width: 100%;
  height: 1px;
}

@media (min-width: 960px) {
  .VPNavBar.has-sidebar .divider {
    padding-left: var(--vp-sidebar-width);
  }
}

@media (min-width: 1440px) {
  .VPNavBar.has-sidebar .divider {
    padding-left: calc((100vw - var(--vp-layout-max-width)) / 2 + var(--vp-sidebar-width));
  }
}

.divider-line {
  width: 100%;
  height: 1px;
  transition: background-color 0.5s;
}

.VPNavBar:not(.home) .divider-line {
  background-color: var(--vp-c-gutter);
}

@media (min-width: 960px) {
  .VPNavBar:not(.home.top) .divider-line {
    background-color: var(--vp-c-gutter);
  }

  .VPNavBar:not(.has-sidebar):not(.home.top) .divider {
    background-color: var(--vp-c-gutter);
  }
}
</style>
