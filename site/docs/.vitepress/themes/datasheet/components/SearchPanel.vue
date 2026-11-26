<script setup lang="ts">
/**
 * Datasheet implementation of the `SearchPanel` slot (v1, spec board §04.2 datasheet specimen).
 *
 * Visual differences from `reader` expressed cleanly via this slot:
 *   - crisp 2 px top rule and squared corners (`--lec-radius-1`)
 *   - square solder-pad status marks (`--lec-status-radius` = 1 px)
 *   - monospace lecture code (`G05-L19`) column
 *   - selected hit accented by a 3 px left bar; match highlights marked by thick underline without background tint
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { SearchGroupSectionView, SearchHitView, SearchPanelProps } from '../../../theme/slots/registry.ts'

const props = defineProps<SearchPanelProps>()

const inputRef = ref<HTMLInputElement | null>(null)
const optionRefs = ref<Map<number, HTMLElement>>(new Map())

const isIndexError = computed(
  () => props.loadState.phase === 'error' || props.loadState.phase === 'partial-error' || Boolean(props.loadState.error),
)
const showErrorEmpty = computed(() => props.groups.length === 0 && isIndexError.value)
const showLoadingEmpty = computed(
  () => !showErrorEmpty.value && props.groups.length === 0 && props.loadState.loading && props.query.trim().length > 0,
)

function handleRetry(): void {
  props.onRetry?.()
  void nextTick(() => {
    inputRef.value?.focus()
  })
}

function setOptionRef(index: number, el: unknown): void {
  if (el instanceof HTMLElement) optionRefs.value.set(index, el)
  else optionRefs.value.delete(index)
}

function flatIndex(groups: readonly SearchGroupSectionView[], gi: number, ii: number): number {
  let offset = 0
  for (let i = 0; i < gi; i++) offset += groups[i]?.items.length ?? 0
  return offset + ii
}

function optionId(index: number): string {
  return `lec-sp-opt-${index}`
}

function handleInput(ev: Event): void {
  props.onQuery((ev.target as HTMLInputElement).value)
}

function handleOpen(hit: SearchHitView, ev: MouseEvent): void {
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return
  ev.preventDefault()
  props.onOpen(hit)
}

onMounted(() => {
  void nextTick(() => {
    inputRef.value?.focus()
  })
})

watch(
  () => props.activeIndex,
  (idx) => {
    if (idx < 0) return
    const el = optionRefs.value.get(idx)
    el?.scrollIntoView({ block: 'nearest' })
  },
)
</script>

<template>
  <div
    class="sp sp--ds"
    role="dialog"
    aria-modal="true"
    :aria-label="labels.dialogLabel"
    @keydown="onKeyDown"
  >
    <div class="sp-in">
      <svg class="sp-icon" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" stroke-width="2" />
      </svg>
      <input
        ref="inputRef"
        id="lec-search-input"
        type="text"
        class="sp-input"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="groups.length > 0"
        :aria-controls="groups.length > 0 ? 'lec-search-listbox' : undefined"
        :aria-activedescendant="activeIndex >= 0 ? optionId(activeIndex) : undefined"
        :aria-label="labels.placeholder"
        :placeholder="labels.placeholder"
        :value="query"
        @input="handleInput"
      />
      <button
        v-if="query.length > 0"
        type="button"
        class="sp-clear"
        :aria-label="labels.clearQuery"
        @click="onQuery(''); inputRef?.focus()"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
          <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" />
          <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" />
        </svg>
      </button>
      <button type="button" class="sp-kbd-btn" :aria-label="labels.footerClose" @click="onClose">
        <kbd>{{ labels.escKey }}</kbd>
      </button>
    </div>

    <div
      v-if="loadState.loading"
      class="sp-load"
      role="status"
      aria-live="polite"
    >
      <div class="sp-load-text">{{ loadState.label }}</div>
      <div class="bar" aria-hidden="true">
        <i :style="{ width: `${loadState.percent}%` }" />
      </div>
    </div>
    <div
      v-else-if="loadState.error && !showErrorEmpty"
      class="sp-load sp-load--error"
      role="status"
      aria-live="polite"
    >
      <span class="sp-load-text">{{ loadState.label }}</span>
      <button v-if="onRetry && labels.retry" type="button" class="sp-retry-btn" @click="handleRetry">
        {{ labels.retry }}
      </button>
    </div>

    <div class="sp-scope">
      <span class="sp-scope-lbl">{{ labels.scopeLabel }}</span>
      <button
        type="button"
        class="sp-scope-btn"
        :class="{ on: scope === 'all' }"
        :aria-pressed="scope === 'all'"
        @click="onScope('all')"
      >
        {{ labels.scopeAll }}
      </button>
      <button
        v-if="currentGroupId"
        type="button"
        class="sp-scope-btn"
        :class="{ on: scope === 'group' }"
        :aria-pressed="scope === 'group'"
        @click="onScope('group')"
      >
        {{ currentGroupLabel }}
      </button>
      <span v-if="metaText" class="meta" role="status" aria-live="polite">{{ metaText }}</span>
    </div>

    <div class="sp-res">
      <div v-if="showErrorEmpty" class="sp-empty sp-empty--error" role="status" aria-live="polite">
        <p class="sp-empty-msg">{{ labels.loadError || loadState.label }}</p>
        <button v-if="onRetry && labels.retry" type="button" class="sp-retry-btn" @click="handleRetry">
          {{ labels.retry }}
        </button>
      </div>
      <div v-else-if="showLoadingEmpty" class="sp-empty sp-empty--loading" role="status" aria-live="polite">
        {{ loadState.phase === 'loading-shards' ? (loadState.label || labels.loadingTitles) : (labels.loadingTitles || loadState.label) }}
      </div>
      <div v-else-if="groups.length === 0 && emptyState === 'no-results'" class="sp-empty">
        {{ labels.noResults }}
      </div>
      <div v-else-if="groups.length === 0 && emptyState === 'idle'" class="sp-empty sp-empty--idle">
        {{ labels.idleHint }}
      </div>

      <div v-if="groups.length > 0" id="lec-search-listbox" role="listbox" :aria-label="labels.resultsAria">
        <section v-for="(grp, gi) in groups" :key="grp.groupId" class="sp-grp" role="group" :aria-labelledby="`lec-sp-grp-${gi}`">
        <h4 :id="`lec-sp-grp-${gi}`" role="presentation">
          <span>{{ grp.groupId === 'CONCEPTS' || grp.groupId === 'SITE' ? grp.groupTitle : `${grp.groupId} ${grp.groupTitle}` }}</span>
          <em>{{ grp.countLabel }}</em>
        </h4>
        <a
          v-for="(hit, ii) in grp.items"
          :id="optionId(flatIndex(groups, gi, ii))"
          :key="hit.id"
          :ref="(el) => setOptionRef(flatIndex(groups, gi, ii), el)"
          :href="hit.href"
          class="sp-hit"
          role="option"
          :aria-selected="activeIndex === flatIndex(groups, gi, ii)"
          @mouseenter="onHighlight(flatIndex(groups, gi, ii))"
          @click="handleOpen(hit, $event)"
        >
          <span class="mk" :data-status="hit.status" role="img" :aria-label="hit.statusLabel">
            <i class="mk-fill" />
          </span>
          <span class="no">{{ hit.code || hit.noLabel }}</span>
          <span class="t">
            <template v-for="(part, pi) in hit.titleParts" :key="pi">
              <mark v-if="part.hit">{{ part.text }}</mark>
              <template v-else>{{ part.text }}</template>
            </template>
          </span>
          <span v-if="hit.crumbParts.length > 0" class="crumb">
            <template v-for="(part, pi) in hit.crumbParts" :key="pi">
              <mark v-if="part.hit">{{ part.text }}</mark>
              <template v-else>{{ part.text }}</template>
            </template>
          </span>
          <span v-if="hit.snippetParts.length > 0" class="snip">
            <template v-for="(part, pi) in hit.snippetParts" :key="pi">
              <mark v-if="part.hit">{{ part.text }}</mark>
              <template v-else>{{ part.text }}</template>
            </template>
          </span>
        </a>
        </section>
      </div>
    </div>

    <div class="sp-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> {{ labels.footerSelect }}</span>
      <span><kbd>Enter</kbd> {{ labels.footerOpen }}</span>
      <span><kbd>Esc</kbd> {{ labels.footerClose }}</span>
    </div>
  </div>
</template>

<style scoped>
.sp--ds {
  width: min(720px, calc(100vw - 24px));
  max-height: min(82vh, 660px);
  display: flex;
  flex-direction: column;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-top: var(--lec-line-heavy) solid var(--lec-text);
  border-radius: 0 0 var(--lec-radius-1) var(--lec-radius-1);
  background: var(--lec-surface);
  color: var(--lec-text);
  font-family: var(--lec-font-body);
  /* S6Y F1: own line height instead of VitePress' 24px (spec board controls: 1.6) */
  line-height: 1.6;
  overflow: hidden;
}

/* S6Y F1: spec board 04.2 .sp-in (8px 12px) with a framed 15px input (6px 8px) -> 51px */
.sp-in {
  display: flex;
  align-items: center;
  gap: var(--lec-space-2);
  padding: var(--lec-space-2) var(--lec-space-3);
  border-bottom: var(--lec-line-hair) solid var(--lec-border);
}

.sp-icon {
  flex: none;
  color: var(--lec-text-muted);
}

.sp-input {
  flex: 1;
  min-width: 0;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  outline: none;
  background: var(--lec-bg);
  color: var(--lec-text);
  font: inherit;
  font-size: 15px;
  line-height: 20px;
  min-height: 34px;
  box-sizing: border-box;
  padding: 6px 8px;
}

.sp-input:focus-visible {
  outline: var(--lec-line-heavy) solid var(--lec-accent);
  outline-offset: 0;
}

.sp-input::placeholder {
  color: var(--lec-text-muted);
}

.sp-clear {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: transparent;
  color: var(--lec-text-muted);
  cursor: pointer;
}

.sp-clear:hover {
  color: var(--lec-text);
  border-color: var(--lec-text);
}

.sp-kbd-btn {
  flex: none;
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
}

.sp-in kbd,
.sp-foot kbd {
  display: inline-block;
  font-family: var(--lec-font-mono);
  font-size: 11px;
  line-height: 1.4;
  padding: 2px 6px;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-bg);
  color: var(--lec-text-muted);
}

.sp-load {
  padding: 7px 14px;
  border-bottom: var(--lec-line-hair) solid var(--lec-border);
  background: var(--lec-bg);
  font-family: var(--lec-font-mono);
  font-size: 11.5px;
  color: var(--lec-text-muted);
}

.sp-load .bar {
  height: 4px;
  border: var(--lec-line-hair) solid var(--lec-border);
  background: var(--lec-surface);
  overflow: hidden;
  margin-top: 5px;
}

.sp-load .bar > i {
  display: block;
  height: 100%;
  background: var(--lec-text);
  transition: width 0.15s linear;
}

.sp-scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--lec-space-2);
  padding: 8px 14px;
  border-bottom: var(--lec-line-hair) solid var(--lec-border);
  font-size: 12px;
  color: var(--lec-text-muted);
}

.sp-scope-btn {
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: transparent;
  color: var(--lec-text-muted);
  padding: 2px 9px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sp-scope-btn.on {
  background: var(--lec-bg);
  border-color: var(--lec-text);
  color: var(--lec-text);
  font-weight: 600;
}

.sp-scope .meta {
  margin-left: auto;
  font-family: var(--lec-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.sp-res {
  flex: 1;
  min-height: 120px;
  max-height: 420px;
  overflow-y: auto;
  padding: 4px 6px 6px;
}

.sp-empty {
  padding: 32px 14px;
  text-align: center;
  font-family: var(--lec-font-mono);
  font-size: 12.5px;
  color: var(--lec-text-muted);
}

.sp-load--error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lec-space-2);
}

.sp-empty-msg {
  margin: 0 0 var(--lec-space-2);
}

.sp-retry-btn {
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  color: var(--lec-text);
  font-family: var(--lec-font-mono);
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
}

.sp-retry-btn:hover,
.sp-retry-btn:focus-visible {
  border-color: var(--lec-text);
}

.sp-grp h4 {
  display: flex;
  align-items: center;
  gap: var(--lec-space-2);
  margin: 4px 0 0;
  padding: 6px 10px 4px;
  border-top: var(--lec-line-hair) solid var(--lec-text);
  /* spec board 04.2 `.sp-res h4`: 12.5 px bold, no all-caps eyebrow (S6Y audit-spec #18) */
  font-family: var(--lec-font-heading);
  font-size: 12.5px;
  font-weight: 700;
  color: var(--lec-text);
}

.sp-grp:first-child h4 {
  border-top-color: var(--lec-border);
}

.sp-grp h4 em {
  margin-left: auto;
  font-family: var(--lec-font-mono);
  font-size: 11.5px;
  font-weight: 400;
  font-style: normal;
  color: var(--lec-text-muted);
}

.sp-hit {
  display: grid;
  grid-template-columns: 22px 5.6em minmax(0, 1fr);
  column-gap: 10px;
  row-gap: 2px;
  align-items: baseline;
  /* S6Y F1: spec board 04.2 .sp-hit 6px 12px */
  padding: 6px var(--lec-space-3);
  border-left: 3px solid transparent;
  cursor: pointer;
  text-decoration: none;
  color: inherit;
}

.sp-hit + .sp-hit {
  border-top: var(--lec-line-hair) dashed var(--lec-border);
}

.sp-hit:hover,
.sp-hit[aria-selected='true'] {
  border-left-color: var(--lec-text);
  background: var(--lec-bg);
}

.mk {
  position: relative;
  align-self: center;
  width: 22px;
  height: 9px;
  box-sizing: border-box;
  border: var(--lec-line-mid) solid var(--lec-border);
  border-radius: 0;
  overflow: hidden;
}

.mk-fill {
  position: absolute;
  inset: auto 0 0 0;
  height: 0;
  background: var(--lec-done);
}

.mk[data-status='in_progress'],
.mk[data-status='completed'] {
  border-color: var(--lec-done);
}

.mk[data-status='in_progress'] .mk-fill {
  height: 50%;
}

.mk[data-status='completed'] .mk-fill {
  height: 100%;
}

.sp-hit .no {
  font-family: var(--lec-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--lec-text-muted);
  white-space: nowrap;
}

.sp-hit .t {
  font-family: var(--lec-font-heading);
  font-size: 14px;
  font-weight: 600;
  color: var(--lec-text);
  overflow-wrap: anywhere;
}

.sp-hit .crumb {
  grid-column: 3;
  font-family: var(--lec-font-mono);
  font-size: 11px;
  color: var(--lec-text-muted);
  overflow-wrap: anywhere;
}

.sp-hit .snip {
  grid-column: 3;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--lec-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.sp-hit mark {
  background: transparent;
  color: var(--lec-text);
  text-decoration: underline;
  text-decoration-color: var(--lec-accent);
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
  padding: 0 1px;
}

.sp-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 8px 14px;
  border-top: var(--lec-line-hair) solid var(--lec-border);
  font-family: var(--lec-font-mono);
  font-size: 11px;
  color: var(--lec-text-muted);
}

.sp-foot kbd + kbd {
  margin-left: 2px;
}

@media (max-width: 767px) {
  .sp--ds {
    width: 100vw;
    height: 100dvh;
    max-height: 100dvh;
    border-left: 0;
    border-right: 0;
    border-bottom: 0;
    border-radius: 0;
  }

  .sp-res {
    max-height: none;
  }

  /* phones keep 16px in the input (spec board 04.2; smaller makes iOS zoom in) */
  .sp-input {
    font-size: 16px;
  }

  .sp-scope-btn {
    min-height: 36px;
    padding: 4px 12px;
  }

  .sp-hit {
    grid-template-columns: 22px 5em minmax(0, 1fr);
    padding: 11px 10px;
  }
}
</style>
