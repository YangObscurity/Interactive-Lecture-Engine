<script setup lang="ts">
/**
 * theme/search/SearchHost.vue - Topbar trigger + keyboard controller + SearchPanel slot host (WP-F3).
 *
 * Replaces VitePress' monolithic local search box while keeping navbar button compatibility selectors
 * (`.VPNavBarSearch`, `#local-search`).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useData, useRouter } from 'vitepress'
import { useT } from '../../i18n/useT.ts'
import { splitLocale } from '../core/route.ts'
import { trapFocus } from '../core/focusTrap.ts'
import { useProgress } from '../progress/useProgress.ts'
import { LecSlot } from '../slots/index.ts'
import type { SearchGroupSectionView, SearchHitView, SearchPanelProps } from '../slots/registry.ts'
import { LectureSearchEngine } from './engine.ts'

const { t } = useT()
const router = useRouter()
const { site, localeIndex, theme } = useData()
const { statusOf } = useProgress()

const triggerRef = ref<HTMLButtonElement | null>(null)
const backdropRef = ref<HTMLElement | null>(null)
const isOpen = ref(false)
const query = ref('')
const scope = ref<'all' | 'group'>('all')
const activeIndex = ref(0)
const revision = ref(0)

let restoreFocusEl: HTMLElement | null = null

const localeKeys = computed(() =>
  Object.keys(site.value.locales ?? {}).filter((k) => k !== 'root'),
)

const activeLocale = computed(() => localeIndex.value || 'root')

const currentGroupId = computed<string | null>(() => {
  const path = router.route.path || '/'
  const clean = splitLocale(path, localeKeys.value).path
  const themeGroups = (theme.value as { groups?: Array<{ id: string; dir: string }> } | undefined)?.groups ?? []
  const sorted = [...themeGroups].sort((a, b) => b.dir.length - a.dir.length)
  for (const g of sorted) {
    if (clean.startsWith(`/${g.dir}/`) || clean === `/${g.dir}`) return g.id
  }
  return null
})

/** Progress events arrive per network chunk; coalesce them to one re-query per frame so typing stays responsive while shards load. */
let revisionFrame = 0
function scheduleRevision(): void {
  if (typeof requestAnimationFrame === 'undefined') {
    revision.value++
    return
  }
  if (revisionFrame) return
  revisionFrame = requestAnimationFrame(() => {
    revisionFrame = 0
    revision.value++
  })
}

const engine = new LectureSearchEngine({
  base: site.value.base || '/',
  localeKeys: Object.keys(site.value.locales ?? {}).filter((k) => k !== 'root'),
  siteData: () => site.value,
  statusOf,
  labels: {
    lectureNo: (n) => t('search.lectureNo', { n }),
    groupCount: (n) => t('search.groupCount', { count: n }),
    groupSite: t('search.groupSite'),
    groupConcepts: t('search.groupConcepts'),
    conceptBadge: t('search.conceptBadge'),
    loadingBar: (loaded, total) => t('search.loadingBar', { loaded, total }),
    loadingIdle: (loaded, total) => t('search.loadingIdle', { loaded, total }),
    loadingTitles: t('search.loadingTitles'),
    loadError: t('search.loadError'),
    statusLabel: (status) => {
      if (status === 'completed') return t('sidebar.status.completed')
      if (status === 'in_progress') return t('sidebar.status.inProgress')
      return t('sidebar.status.notStarted')
    },
  },
  onStateChange: scheduleRevision,
})

const searchResult = computed(() => {
  void revision.value
  return engine.query(activeLocale.value, query.value, scope.value, currentGroupId.value)
})

const flatHits = computed<SearchHitView[]>(() => {
  const out: SearchHitView[] = []
  for (const g of searchResult.value.groups) out.push(...g.items)
  return out
})

watch(flatHits, (list) => {
  if (list.length === 0) activeIndex.value = -1
  else if (activeIndex.value < 0 || activeIndex.value >= list.length) activeIndex.value = 0
})

watch(currentGroupId, (grp) => {
  if (!grp && scope.value === 'group') scope.value = 'all'
})

function openSearch(): void {
  if (typeof document !== 'undefined') {
    restoreFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.value
  }
  // spec board 04.2: on a group or lecture page the default scope is "this group"
  scope.value = currentGroupId.value ? 'group' : 'all'
  isOpen.value = true
  loadIndex(true)
}

function loadIndex(forceRetry = false): void {
  engine.ensureLoaded(activeLocale.value, currentGroupId.value, { forceRetry }).catch(() => {
    // Error status is surfaced cleanly via getLoadState / emptyState='error'; next open/retry will re-fetch
  })
}

function closeSearch(): void {
  isOpen.value = false
  const target = restoreFocusEl ?? triggerRef.value
  restoreFocusEl = null
  if (target && typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => target.focus())
  }
}

function openHit(hit: SearchHitView): void {
  isOpen.value = false
  restoreFocusEl = null
  void router.go(hit.href)
}

function setQuery(next: string): void {
  query.value = next
  activeIndex.value = 0
  if (isOpen.value) loadIndex(false)
}

function setScope(next: 'all' | 'group'): void {
  scope.value = next
  activeIndex.value = 0
  if (next === 'group') engine.prioritizeGroup(activeLocale.value, currentGroupId.value)
  const st = engine.getLoadState(activeLocale.value, query.value.trim().length > 0)
  if (st.phase === 'error' || st.phase === 'partial-error' || st.phase === 'idle') {
    loadIndex(true)
  }
}

function handleDialogKeyDown(ev: KeyboardEvent): void {
  const count = flatHits.value.length
  if (ev.key === 'Escape') {
    ev.preventDefault()
    ev.stopPropagation()
    closeSearch()
    return
  }
  if (ev.key === 'Tab') {
    if (trapFocus(backdropRef.value, ev)) {
      return
    }
  }
  if (ev.key === 'ArrowDown' && count > 0) {
    ev.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % count
    return
  }
  if (ev.key === 'ArrowUp' && count > 0) {
    ev.preventDefault()
    activeIndex.value = activeIndex.value <= 0 ? count - 1 : activeIndex.value - 1
    return
  }
  // Enter while an IME composes (Chinese input) commits the text; on a button it must press that button
  if (ev.key === 'Enter' && count > 0 && !ev.isComposing && !(ev.target instanceof HTMLButtonElement)) {
    const selected = flatHits.value[activeIndex.value] ?? flatHits.value[0]
    if (selected) {
      ev.preventDefault()
      openHit(selected)
    }
  }
}

function handleGlobalKeyDown(ev: KeyboardEvent): void {
  if (isOpen.value && ev.key === 'Tab') {
    if (trapFocus(backdropRef.value, ev)) {
      return
    }
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
    ev.preventDefault()
    if (isOpen.value) closeSearch()
    else openSearch()
    return
  }
  if (ev.key === 'Escape' && isOpen.value) {
    ev.preventDefault()
    closeSearch()
    return
  }
  if (
    ev.key === '/' &&
    !isOpen.value &&
    !ev.ctrlKey &&
    !ev.metaKey &&
    !ev.altKey
  ) {
    const target = ev.target
    if (
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return
    }
    ev.preventDefault()
    openSearch()
  }
}

const panelProps = computed<SearchPanelProps>(() => {
  void revision.value
  const hasQuery = query.value.trim().length > 0
  const loadState = engine.getLoadState(activeLocale.value, hasQuery)
  const groups: readonly SearchGroupSectionView[] = searchResult.value.groups
  const indexUnavailable = loadState.phase === 'loading-titles' || loadState.phase === 'error'
  const metaText =
    hasQuery && !indexUnavailable
      ? t('search.metaCountTime', { count: searchResult.value.totalHits, ms: searchResult.value.elapsedMs })
      : ''
  const emptyState: SearchPanelProps['emptyState'] = groups.length > 0
    ? null
    : loadState.phase === 'error'
      ? 'error'
      : loadState.phase === 'loading-titles' && hasQuery
        ? 'loading'
        : hasQuery
          ? 'no-results'
          : 'idle'

  return {
    query: query.value,
    scope: scope.value,
    currentGroupId: currentGroupId.value,
    currentGroupLabel: currentGroupId.value ? t('search.scopeGroup', { id: currentGroupId.value }) : '',
    groups,
    activeIndex: activeIndex.value,
    metaText,
    loadState,
    emptyState,
    labels: {
      dialogLabel: t('search.dialogLabel'),
      placeholder: t('search.placeholder'),
      clearQuery: t('search.resetButton'),
      escKey: 'Esc',
      scopeLabel: t('search.scopeLabel'),
      scopeAll: t('search.scopeAll'),
      scopeGroup: t('search.scopeGroup', { id: currentGroupId.value ?? '' }),
      noResults: t('search.noResults'),
      idleHint: t('search.idleHint'),
      loadingTitles: t('search.loadingTitles'),
      loadError: t('search.loadError'),
      retry: t('search.retry'),
      footerSelect: t('search.footerSelect'),
      footerOpen: t('search.footerOpen'),
      footerClose: t('search.footerClose'),
      resultsAria: t('search.resultsAria'),
    },
    onQuery: setQuery,
    onScope: setScope,
    onHighlight: (idx: number) => {
      activeIndex.value = idx
    },
    onOpen: openHit,
    onClose: closeSearch,
    onRetry: () => loadIndex(true),
    onKeyDown: handleDialogKeyDown,
  }
})

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeyDown)
  if (revisionFrame && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(revisionFrame)
})
</script>

<template>
  <div id="local-search" class="VPNavBarSearch lec-search-host">
    <button
      ref="triggerRef"
      type="button"
      class="lec-search-btn"
      :aria-label="t('search.button')"
      :title="t('search.triggerHint')"
      @click="openSearch"
    >
      <svg class="lec-search-ico" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <span class="lec-search-lbl">{{ t('search.button') }}</span>
      <kbd class="lec-search-keys" aria-hidden="true">Ctrl K</kbd>
    </button>

    <Teleport to="body">
      <div v-if="isOpen" ref="backdropRef" class="lec-search-backdrop" @mousedown.self="closeSearch">
        <LecSlot name="SearchPanel" v-bind="panelProps" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.lec-search-host {
  display: flex;
  align-items: center;
}

.lec-search-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 10px;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  color: var(--lec-text-muted);
  font-family: var(--lec-font-heading);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.lec-search-btn:hover,
.lec-search-btn:focus-visible {
  border-color: var(--lec-accent);
  color: var(--lec-text);
}

.lec-search-ico {
  flex: none;
}

.lec-search-keys {
  font-family: var(--lec-font-mono);
  font-size: 11px;
  padding: 1px 5px;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-bg);
  color: var(--lec-text-muted);
}

@media (max-width: 959px) {
  .lec-search-keys {
    display: none;
  }
}

@media (max-width: 767px) {
  .lec-search-btn {
    width: 34px;
    height: 34px;
    padding: 0;
    justify-content: center;
    border-color: transparent;
    background: transparent;
  }

  .lec-search-lbl {
    display: none;
  }
}

.lec-search-backdrop {
  position: fixed;
  inset: 0;
  z-index: 250;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 56px 16px 24px;
}

.lec-search-backdrop::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  background: var(--lec-bg);
  opacity: 0.78;
}

@media (max-width: 767px) {
  .lec-search-backdrop {
    padding: 0;
    align-items: stretch;
  }
}
</style>
