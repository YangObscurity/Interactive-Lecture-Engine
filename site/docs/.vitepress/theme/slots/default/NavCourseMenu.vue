<script setup lang="ts">
/**
 * theme/slots/default/NavCourseMenu.vue - Engine default implementation of NavCourseMenu (reader skin).
 *
 * Spec board §04.1 (Rev E):
 *   - Desktop: two-column flyout with group preview on hover/focus, status marks from §05.
 *   - Mobile: collapsible accordion list in the phone drawer.
 *   - Category-colour left edge and dot on groups; no card shadows (per §17).
 */
import { nextTick, ref, watch } from 'vue'
import type { NavCourseMenuProps } from '../registry.ts'

const props = defineProps<NavCourseMenuProps>()

const dialogRef = ref<HTMLElement | null>(null)
const groupRefs = ref<Map<string, HTMLElement>>(new Map())
const lectureRefs = ref<Map<number, HTMLElement>>(new Map())

function setGroupRef(id: string, el: unknown): void {
  if (el instanceof HTMLElement) groupRefs.value.set(id, el)
  else groupRefs.value.delete(id)
}

function setLectureRef(index: number, el: unknown): void {
  if (el instanceof HTMLElement) lectureRefs.value.set(index, el)
  else lectureRefs.value.delete(index)
}

function adjustPosition(): void {
  const panel = dialogRef.value
  if (!panel) return
  const rect = panel.getBoundingClientRect()
  if (rect.left < 16) {
    panel.style.transform = `translateX(${16 - rect.left}px)`
  } else {
    panel.style.transform = ''
  }
}

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      void nextTick(() => {
        adjustPosition()
        const target =
          groupRefs.value.get(props.activeGroupId) ??
          groupRefs.value.get(props.groups[0]?.id ?? '')
        target?.focus()
      })
    }
  },
)

watch(
  () => [props.activeColumn, props.activeLectureIndex, props.activeGroupId],
  ([col, idx]) => {
    if (!props.isOpen) return
    void nextTick(() => {
      if (col === 'lectures' && typeof idx === 'number' && idx >= 0) {
        const el = lectureRefs.value.get(idx)
        el?.focus()
        el?.scrollIntoView({ block: 'nearest' })
      } else if (col === 'groups') {
        const el = groupRefs.value.get(props.activeGroupId)
        el?.focus()
        el?.scrollIntoView({ block: 'nearest' })
      }
    })
  },
)
</script>

<template>
  <div class="cm-wrap cm-wrap--reader" :class="{ 'is-open': isOpen, 'is-mobile': isMobile }">
    <!-- Desktop topbar trigger and panel -->
    <template v-if="!isMobile">
      <button
        type="button"
        class="cm-trigger"
        aria-haspopup="dialog"
        :aria-expanded="isOpen"
        :aria-label="labels.groups"
        @click="onToggle"
      >
        <span>{{ labels.groups }}</span>
        <svg class="cm-trigger-icon" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>

      <div
        v-if="isOpen"
        ref="dialogRef"
        class="cm"
        role="dialog"
        aria-modal="true"
        :aria-label="labels.dialogLabel"
        @keydown="onKeyDown"
      >
        <ul class="cm-groups" :aria-label="labels.groups">
          <li v-for="g in groups" :key="g.id">
            <a
              :ref="(el) => setGroupRef(g.id, el)"
              :href="g.href"
              :style="'--c:var(--lec-cat-' + g.catSlot + ')'"
              :aria-current="g.isCurrent ? 'true' : undefined"
              :title="g.title"
              :class="{ 'is-active': g.id === activeGroupId }"
              @mouseenter="onSelectGroup(g.id)"
              @focus="onSelectGroup(g.id)"
              @click="onOpenGroup(g, $event)"
            >
              <b>{{ g.id }}</b>
              <span>{{ g.title }}</span>
              <em>{{ g.read }}/{{ g.total }}</em>
            </a>
          </li>
        </ul>

        <div v-if="activeGroup" class="cm-lec">
          <header>
            <b>{{ activeGroup.id }} {{ activeGroup.title }}</b>
            <em>{{ activeGroup.read }} / {{ activeGroup.total }} {{ labels.readSuffix }}</em>
            <a :href="activeGroup.href" @click="onOpenGroup(activeGroup, $event)">
              {{ labels.enterGroup }} →
            </a>
          </header>
          <ol :aria-label="activeGroup.title">
            <li v-for="(l, idx) in activeGroup.lectures" :key="l.id">
              <a
                :ref="(el) => setLectureRef(idx, el)"
                :href="l.href"
                :aria-current="l.isCurrent ? 'page' : undefined"
                :aria-label="l.ariaLabel"
                :class="{ 'is-active': activeColumn === 'lectures' && activeLectureIndex === idx }"
                @click="onOpenLecture(l, $event)"
              >
                <i
                  class="mk"
                  :class="l.status === 'unread' ? '' : l.status"
                  :data-status="l.status"
                  aria-hidden="true"
                />
                <span class="no">{{ l.no }}</span>
                <span class="t">{{ l.title }}</span>
              </a>
            </li>
          </ol>
        </div>

        <div class="cm-hint">
          <kbd>↑</kbd><kbd>↓</kbd> {{ labels.hintSelectGroup }}
          <kbd>→</kbd> {{ labels.hintEnterLectures }}
          <kbd>Enter</kbd> {{ labels.hintOpen }}
          <kbd>Esc</kbd> {{ labels.hintClose }}
        </div>
      </div>
    </template>

    <!-- Mobile collapsible drawer list -->
    <template v-else>
      <div class="cm-mobile-list" role="navigation" :aria-label="labels.groups">
        <div
          v-for="g in groups"
          :key="g.id"
          class="cm-mob-group"
          :class="{ 'is-open': expandedGroupIds.includes(g.id) }"
        >
          <div class="cm-mob-row">
            <button
              type="button"
              class="cm-mob-btn"
              :aria-expanded="expandedGroupIds.includes(g.id)"
              @click="onToggleGroupExpand(g.id)"
            >
              <span class="cm-mob-left">
                <b class="cm-mob-id" :style="'--c:var(--lec-cat-' + g.catSlot + ')'">{{ g.id }}</b>
                <span class="cm-mob-title" :title="g.title">{{ g.title }}</span>
              </span>
              <span class="cm-mob-right">
                <em class="cm-mob-count">{{ g.read }}/{{ g.total }}</em>
                <svg class="cm-mob-arrow" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
                </svg>
              </span>
            </button>
          </div>

          <div v-if="expandedGroupIds.includes(g.id)" class="cm-mob-body">
            <div class="cm-mob-group-entry">
              <a :href="g.href" class="cm-mob-group-link" @click="onOpenGroup(g, $event)">
                {{ labels.enterGroup }} →
              </a>
            </div>
            <ol class="cm-mob-lectures" :aria-label="g.title">
              <li v-for="l in g.lectures" :key="l.id">
                <a
                  :href="l.href"
                  :aria-current="l.isCurrent ? 'page' : undefined"
                  :aria-label="l.ariaLabel"
                  @click="onOpenLecture(l, $event)"
                >
                  <i
                    class="mk"
                    :class="l.status === 'unread' ? '' : l.status"
                    :data-status="l.status"
                    aria-hidden="true"
                  />
                  <span class="no">{{ l.no }}</span>
                  <span class="t">{{ l.title }}</span>
                </a>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cm-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.cm-wrap.is-mobile {
  display: block;
  width: 100%;
}

.cm-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: var(--vp-nav-height);
  padding: 0 12px;
  border: 0;
  border-bottom: var(--lec-line-heavy) solid transparent;
  background: transparent;
  color: var(--lec-text);
  font-family: var(--lec-font-heading);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.25s, border-color 0.25s;
}

.cm-trigger:hover,
.cm-trigger:focus-visible,
.cm-trigger[aria-expanded='true'] {
  color: var(--lec-accent);
  border-bottom-color: var(--lec-accent);
}

.cm-trigger-icon {
  flex: none;
  transition: transform 0.2s;
}

.cm-trigger[aria-expanded='true'] .cm-trigger-icon {
  transform: rotate(180deg);
}

/* 04.1 course menu desktop panel */
.cm {
  position: absolute;
  top: calc(var(--vp-nav-height) - 4px);
  right: 0;
  z-index: 200;
  width: 880px;
  max-width: calc(100vw - 32px);
  display: grid;
  grid-template-columns: minmax(0, 23em) minmax(0, 1fr);
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-2);
  background: var(--lec-surface);
  color: var(--lec-text);
  font-family: var(--lec-font-body);
  font-size: 13.5px;
  min-height: 0;
  box-shadow: none;
}

.cm-groups {
  list-style: none;
  margin: 0;
  padding: var(--lec-space-1) 0;
  border-right: var(--lec-line-hair) solid var(--lec-border);
  max-height: 360px;
  overflow-y: auto;
}

.cm-groups li {
  margin: 0;
  padding: 0;
}

.cm-groups a {
  display: grid;
  grid-template-columns: 3.2em minmax(0, 1fr) auto;
  gap: var(--lec-space-2);
  align-items: baseline;
  padding: 5px var(--lec-space-3) 5px var(--lec-space-2);
  color: var(--lec-text);
  text-decoration: none;
  border-left: 3px solid var(--c);
}

.cm-groups a b {
  font-family: var(--lec-font-mono);
  font-weight: 700;
  font-size: 12.5px;
}

.cm-groups a span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cm-groups a em {
  font-family: var(--lec-font-mono);
  font-weight: 400;
  font-size: 11.5px;
  font-style: normal;
  color: var(--lec-text-muted);
}

.cm-groups a[aria-current='true'],
.cm-groups a.is-active,
.cm-groups a:hover,
.cm-groups a:focus-visible {
  background: var(--lec-accent-tint);
}

.cm-lec {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
}

.cm-lec header {
  display: flex;
  align-items: baseline;
  gap: var(--lec-space-3);
  padding: var(--lec-space-2) var(--lec-space-3);
  border-bottom: var(--lec-line-hair) solid var(--lec-border);
}

.cm-lec header b {
  font-weight: 700;
}

.cm-lec header em {
  font-family: var(--lec-font-mono);
  font-weight: 400;
  font-size: 12px;
  font-style: normal;
  color: var(--lec-text-muted);
}

.cm-lec header a {
  margin-left: auto;
  font-size: 12.5px;
  text-decoration: none;
  white-space: nowrap;
  color: var(--lec-accent);
}

.cm-lec header a:hover,
.cm-lec header a:focus-visible {
  text-decoration: underline;
}

.cm-lec ol {
  list-style: none;
  margin: 0;
  padding: var(--lec-space-1) 0;
  max-height: 318px;
  overflow-y: auto;
}

.cm-lec li {
  margin: 0;
  padding: 0;
}

.cm-lec li a {
  display: grid;
  grid-template-columns: 9px 2.2em minmax(0, 1fr);
  gap: var(--lec-space-2);
  align-items: center;
  padding: 4px var(--lec-space-3);
  color: var(--lec-text-muted);
  text-decoration: none;
  line-height: 1.45;
}

.cm-lec li a .no {
  font-family: var(--lec-font-mono);
  font-weight: 400;
  font-size: 11.5px;
  text-align: right;
}

.cm-lec li a .t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cm-lec li a:hover,
.cm-lec li a:focus-visible,
.cm-lec li a.is-active {
  color: var(--lec-text);
  background: var(--lec-accent-tint);
}

.cm-lec li a[aria-current='page'] {
  color: var(--lec-accent);
  font-weight: 600;
}

.cm-groups a:focus-visible,
.cm-lec li a:focus-visible,
.cm-lec header a:focus-visible {
  outline: var(--lec-line-heavy) solid var(--lec-accent);
  outline-offset: -2px;
}

.cm-hint {
  font-size: 12px;
  color: var(--lec-text-muted);
  padding: var(--lec-space-2) var(--lec-space-3);
  border-top: var(--lec-line-hair) solid var(--lec-border);
  grid-column: 1 / -1;
}

.cm-hint kbd {
  font-family: var(--lec-font-mono);
  font-weight: 400;
  font-size: 11px;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  padding: 0 4px;
  margin: 0 2px;
  background: var(--lec-bg);
}

/* §05 status marks */
.mk {
  display: inline-block;
  width: 9px;
  height: 9px;
  flex: none;
  border: var(--lec-line-mid) solid var(--lec-border);
  border-radius: var(--lec-status-radius);
  background: transparent;
  box-sizing: border-box;
}

.mk.read {
  background: var(--lec-done);
  border-color: var(--lec-done);
}

.mk.reading {
  border-color: var(--lec-done);
  background: linear-gradient(to top, var(--lec-done) 50%, transparent 50%);
}

@media (max-width: 640px) {
  .cm {
    grid-template-columns: minmax(0, 1fr);
  }
  .cm-groups {
    border-right: 0;
    border-bottom: var(--lec-line-hair) solid var(--lec-border);
    max-height: 200px;
  }
}

/* Mobile drawer accordion list */
.cm-mobile-list {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.cm-mob-group {
  border-bottom: var(--lec-line-hair) solid var(--lec-border);
}

.cm-mob-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 11px 0;
  background: transparent;
  border: 0;
  color: var(--lec-text);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  text-align: left;
}

.cm-mob-left {
  display: flex;
  align-items: center;
  gap: var(--lec-space-2);
  min-width: 0;
  flex: 1;
}

.cm-mob-id {
  font-family: var(--lec-font-mono);
  font-weight: 700;
  font-size: 13px;
  border-left: 3px solid var(--c);
  padding-left: 6px;
  flex: none;
}

.cm-mob-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.cm-mob-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  color: var(--lec-text-muted);
}

.cm-mob-count {
  font-family: var(--lec-font-mono);
  font-size: 11.5px;
  font-style: normal;
}

.cm-mob-arrow {
  flex: none;
  transition: transform 0.2s;
}

.cm-mob-group.is-open .cm-mob-arrow {
  transform: rotate(180deg);
}

.cm-mob-body {
  padding: 0 0 12px 8px;
}

.cm-mob-group-entry {
  padding: 4px 0 8px;
}

.cm-mob-group-link {
  font-size: 12.5px;
  color: var(--lec-accent);
  text-decoration: none;
  font-weight: 500;
}

.cm-mob-lectures {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow-y: auto;
}

.cm-mob-lectures li a {
  display: grid;
  grid-template-columns: 9px 2.2em minmax(0, 1fr);
  gap: var(--lec-space-2);
  align-items: center;
  padding: 5px 0;
  color: var(--lec-text-muted);
  text-decoration: none;
  font-size: 13px;
  line-height: 1.4;
}

.cm-mob-lectures li a .no {
  font-family: var(--lec-font-mono);
  font-size: 11.5px;
  text-align: right;
}

.cm-mob-lectures li a .t {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cm-mob-lectures li a:hover,
.cm-mob-lectures li a:focus-visible {
  color: var(--lec-text);
}

.cm-mob-lectures li a[aria-current='page'] {
  color: var(--lec-accent);
  font-weight: 600;
}
</style>
