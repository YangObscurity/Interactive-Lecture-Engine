<script setup lang="ts">
/* eslint-disable @typescript-eslint/no-unused-expressions -- verbatim VitePress code (`!props.item.link && toggle()`) */
/**
 * Copied from VitePress 1.6.4 (vitepress/dist/client/theme-default/components/VPSidebarItem.vue), MIT License,
 * Copyright (c) 2019-present, Yuxi (Evan) You. Replaces the original through a Vite alias (config.v2.mts,
 * VitePress "overriding internal components"). Pinned to 1.6.4: re-diff against the new source when VitePress is upgraded.
 *
 * Changes (P2e, docs-dev/SLOTS.md), everything else is the original:
 *   - a lecture link renders <LecSlot name="SidebarStatus"> in front of its text (status from the progress store,
 *     `not_started` until the store is ready, which is what SSR renders; `current` = the active link), inside a
 *     `.lec-status-box` one text line high, so a wrapped lecture name keeps the marker on its first line (spec §05);
 *   - imports of the VitePress internals are no longer relative: `useSidebarControl` from its dist path, `VPLink` from the
 *     public `vitepress/theme-without-fonts` export (the file lives elsewhere; same component, no extra bundle weight);
 *   - the script block imports for the status (useProgress, parseLecture, getLocaleKeys, useT).
 * Collapse, active link and aria behaviour are untouched (they come from the same `useSidebarControl`).
 */
import type { DefaultTheme } from 'vitepress/theme'
import { computed } from 'vue'
import { useSidebarControl } from 'vitepress/dist/client/theme-default/composables/sidebar.js'
import { VPLink } from 'vitepress/theme-without-fonts'
import { LecSlot } from './index'
import { parseLecture } from '../core/route'
import { getLocaleKeys } from '../core/locales'
import { useProgress } from '../progress/useProgress'
import type { ProgressStatus } from '../progress/types'
import { useT } from '../../i18n/useT.ts'
import type { MessageKey } from '../../i18n/index.ts'

const props = defineProps<{
  item: DefaultTheme.SidebarItem
  depth: number
}>()

const {
  collapsed,
  collapsible,
  isLink,
  isActiveLink,
  hasActiveLink,
  hasChildren,
  toggle
} = useSidebarControl(computed(() => props.item))

const sectionTag = computed(() => (hasChildren.value ? 'section' : `div`))

const linkTag = computed(() => (isLink.value ? 'a' : 'div'))

const textTag = computed(() => {
  return !hasChildren.value
    ? 'p'
    : props.depth + 2 === 7
      ? 'p'
      : `h${props.depth + 2}`
})

const itemRole = computed(() => (isLink.value ? undefined : 'button'))

const classes = computed(() => [
  [`level-${props.depth}`],
  { collapsible: collapsible.value },
  { collapsed: collapsed.value },
  { 'is-link': isLink.value },
  { 'is-active': isActiveLink.value },
  { 'has-active': hasActiveLink.value }
])

function onItemInteraction(e: MouseEvent | Event) {
  if ('key' in e && e.key !== 'Enter') {
    return
  }
  !props.item.link && toggle()
}

function onCaretClick() {
  props.item.link && toggle()
}

// ---- P2e: lecture status marker -------------------------------------------------------------
const { t } = useT()
const progress = useProgress()
/** Only lecture links (`/<dir>/L<n>`, with or without a locale prefix) have a status; group pages and other links do not. */
const lectureId = computed(() => (props.item.link ? (parseLecture(props.item.link, '/', getLocaleKeys())?.lectureId ?? null) : null))
const status = computed<ProgressStatus>(() => (lectureId.value ? progress.statusOf(lectureId.value) : 'not_started'))
const STATUS_LABEL: Record<ProgressStatus, MessageKey> = {
  not_started: 'sidebar.status.notStarted',
  in_progress: 'sidebar.status.inProgress',
  completed: 'sidebar.status.completed'
}
const statusLabel = computed(() => t(STATUS_LABEL[status.value]))
</script>

<!-- eslint-disable vue/no-v-html, vue/no-v-text-v-html-on-component -- verbatim VitePress template (item.text is trusted sidebar config) -->
<template>
  <component :is="sectionTag" class="VPSidebarItem" :class="classes">
    <div
      v-if="item.text"
      class="item"
      :role="itemRole"
      v-on="
        item.items
          ? { click: onItemInteraction, keydown: onItemInteraction }
          : {}
      "
      :tabindex="item.items && 0"
    >
      <div class="indicator" />

      <VPLink
        v-if="item.link"
        :tag="linkTag"
        class="link"
        :href="item.link"
        :rel="item.rel"
        :target="item.target"
      >
        <span v-if="lectureId" class="lec-status-box">
          <LecSlot
            name="SidebarStatus"
            :status="status"
            :current="isActiveLink"
            :label="statusLabel"
          />
        </span>
        <component :is="textTag" class="text" v-html="item.text" />
      </VPLink>
      <component v-else :is="textTag" class="text" v-html="item.text" />

      <div
        v-if="item.collapsed != null && item.items && item.items.length"
        class="caret"
        role="button"
        aria-label="toggle section"
        @click="onCaretClick"
        @keydown.enter="onCaretClick"
        tabindex="0"
      >
        <span class="vpi-chevron-right caret-icon" />
      </div>
    </div>

    <div v-if="item.items && item.items.length" class="items">
      <template v-if="depth < 5">
        <VPSidebarItem
          v-for="i in item.items"
          :key="i.text"
          :item="i"
          :depth="depth + 1"
        />
      </template>
    </div>
  </component>
</template>

<style scoped>
.VPSidebarItem.level-0 {
  padding-bottom: 24px;
}

.VPSidebarItem.collapsed.level-0 {
  padding-bottom: 10px;
}

.item {
  position: relative;
  display: flex;
  width: 100%;
}

.VPSidebarItem.collapsible > .item {
  cursor: pointer;
}

.indicator {
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: -17px;
  width: 2px;
  border-radius: 2px;
  transition: background-color 0.25s;
}

.VPSidebarItem.level-2.is-active > .item > .indicator,
.VPSidebarItem.level-3.is-active > .item > .indicator,
.VPSidebarItem.level-4.is-active > .item > .indicator,
.VPSidebarItem.level-5.is-active > .item > .indicator {
  background-color: var(--vp-c-brand-1);
}

.link {
  display: flex;
  align-items: center;
  flex-grow: 1;
}

/* engine (not theme): spec board section 05 puts the status marker on the FIRST line of a wrapped lecture name
   (`grid-row: 1`), so the marker sits in a box exactly one text line high (same padding-top and line-height
   as `.text` below) and the link aligns to the top instead of centring the marker on the whole block. */
.link:has(> .lec-status-box) {
  align-items: flex-start;
}

.lec-status-box {
  display: flex;
  flex: none;
  align-items: center;
  height: 24px;
  margin-top: 4px;
}

.text {
  flex-grow: 1;
  padding: 4px 0;
  line-height: 24px;
  font-size: 14px;
  transition: color 0.25s;
}

.VPSidebarItem.level-0 .text {
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.VPSidebarItem.level-1 .text,
.VPSidebarItem.level-2 .text,
.VPSidebarItem.level-3 .text,
.VPSidebarItem.level-4 .text,
.VPSidebarItem.level-5 .text {
  font-weight: 500;
  color: var(--vp-c-text-2);
}

.VPSidebarItem.level-0.is-link > .item > .link:hover .text,
.VPSidebarItem.level-1.is-link > .item > .link:hover .text,
.VPSidebarItem.level-2.is-link > .item > .link:hover .text,
.VPSidebarItem.level-3.is-link > .item > .link:hover .text,
.VPSidebarItem.level-4.is-link > .item > .link:hover .text,
.VPSidebarItem.level-5.is-link > .item > .link:hover .text {
  color: var(--vp-c-brand-1);
}

.VPSidebarItem.level-0.has-active > .item > .text,
.VPSidebarItem.level-1.has-active > .item > .text,
.VPSidebarItem.level-2.has-active > .item > .text,
.VPSidebarItem.level-3.has-active > .item > .text,
.VPSidebarItem.level-4.has-active > .item > .text,
.VPSidebarItem.level-5.has-active > .item > .text,
.VPSidebarItem.level-0.has-active > .item > .link > .text,
.VPSidebarItem.level-1.has-active > .item > .link > .text,
.VPSidebarItem.level-2.has-active > .item > .link > .text,
.VPSidebarItem.level-3.has-active > .item > .link > .text,
.VPSidebarItem.level-4.has-active > .item > .link > .text,
.VPSidebarItem.level-5.has-active > .item > .link > .text {
  color: var(--vp-c-text-1);
}

.VPSidebarItem.level-0.is-active > .item .link > .text,
.VPSidebarItem.level-1.is-active > .item .link > .text,
.VPSidebarItem.level-2.is-active > .item .link > .text,
.VPSidebarItem.level-3.is-active > .item .link > .text,
.VPSidebarItem.level-4.is-active > .item .link > .text,
.VPSidebarItem.level-5.is-active > .item .link > .text {
  color: var(--vp-c-brand-1);
}

.caret {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-right: -7px;
  width: 32px;
  height: 32px;
  color: var(--vp-c-text-3);
  cursor: pointer;
  transition: color 0.25s;
  flex-shrink: 0;
}

.item:hover .caret {
  color: var(--vp-c-text-2);
}

.item:hover .caret:hover {
  color: var(--vp-c-text-1);
}

.caret-icon {
  font-size: 18px;
  /*rtl:ignore*/
  transform: rotate(90deg);
  transition: transform 0.25s;
}

.VPSidebarItem.collapsed .caret-icon {
  transform: rotate(0)/*rtl:rotate(180deg)*/;
}

.VPSidebarItem.level-1 .items,
.VPSidebarItem.level-2 .items,
.VPSidebarItem.level-3 .items,
.VPSidebarItem.level-4 .items,
.VPSidebarItem.level-5 .items {
  border-left: 1px solid var(--vp-c-divider);
  padding-left: 16px;
}

.VPSidebarItem.collapsed .items {
  display: none;
}
</style>
