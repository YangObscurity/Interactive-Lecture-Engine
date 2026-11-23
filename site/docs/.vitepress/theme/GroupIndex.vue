<script setup lang="ts">
/**
 * GroupIndex.vue - 课程组内页（/g01/ /g02/ …）的入口（P4a WP-H3 重写）。
 *
 * 只做一件事：按路由找到当前组，交给 group/GroupPage.vue（题名区、组页地图、讲次地图与关系面板）。
 * 讲次列表由 themeConfig.groups 自动生成：新增一讲不用手改。组数据按路由前缀匹配，同一个组件被所有组复用；
 * 受限组（P3b）的组页带自己的 `frontmatter.groupMeta`，不依赖 themeConfig.groups，服务端渲染就是完整的。
 *
 * 样式在 group/group.css 与两个主题包的 theme.css，本文件不写样式。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { useData, useRoute } from 'vitepress'
import { endBodyHydration } from './core/bodyHydration'
import { splitLocale } from './core/route'
import { getLocaleKeys } from './core/locales'
import GroupPage from './group/GroupPage.vue'
import type { PageGroup } from './group/types'
import './group/group.css'

interface ThemeConfig {
  groups?: PageGroup[]
}

const { theme, frontmatter } = useData()
const route = useRoute()
const groups = computed<PageGroup[]>(() => (theme.value as unknown as ThemeConfig).groups ?? [])
const group = computed<PageGroup | null>(() => {
  // P3b: a restricted group's index page carries its own meta, so it renders fully in SSR without `themeConfig.groups`
  const meta = frontmatter.value.groupMeta as PageGroup | undefined
  if (meta && Array.isArray(meta.lectures)) return meta
  // an English group page lives at /en/<dir>/: look the group up by its root-language path
  const p = splitLocale(route.path, getLocaleKeys()).path
  return groups.value.find((g) => p.startsWith(`/${g.dir}/`)) ?? null
})

// custom.css widens the page container for group pages through this class
onMounted(() => {
  endBodyHydration()
  document.documentElement.classList.add('is-group-page')
})
onUnmounted(() => document.documentElement.classList.remove('is-group-page'))
</script>

<template>
  <GroupPage v-if="group" :key="group.id" :group="group" />
</template>
