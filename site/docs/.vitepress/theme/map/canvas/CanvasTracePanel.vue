<script setup lang="ts">
/**
 * CanvasTracePanel.vue - floating top-left trace panel (bottom on <700 px) inside `MapStage` overlay (P4b).
 *
 * Uses `lec-map-panel` so MapViewport ignores pointer and wheel events inside it (scrolling the panel never zooms
 * the canvas). All colours and fonts come from `--lec-*` tokens only.
 */
import type { AtlasStatus } from '../../slots/registry.ts'

export type CanvasLockTarget =
  | { type: 'node'; id: string }
  | { type: 'pair'; a: string; b: string; edges: ReadonlyArray<readonly [string, string]> }

export interface TraceLectureView {
  id: string
  label: string
  href: string
  status: AtlasStatus
}

defineProps<{
  lock: CanvasLockTarget | null
  lockedLecture: TraceLectureView | null
  preLectures: readonly TraceLectureView[]
  postLectures: readonly TraceLectureView[]
  pairItems: ReadonlyArray<{ traceKey: string; targetId: string; from: TraceLectureView; to: TraceLectureView }>
  labels: {
    ariaLabel: string
    tracing: string
    exit: string
    open: string
    traceBtn: string
    preHeading: (n: number) => string
    postHeading: (n: number) => string
    nonePre: string
    nonePost: string
    nodeHint: string
    pairHeading: (a: string, b: string, n: number) => string
    pairHint: string
  }
}>()

defineEmits<{
  (e: 'exit'): void
  (e: 'open', href: string): void
  (e: 'trace', id: string): void
  (e: 'hover-item', id: string | null): void
}>()
</script>

<template>
  <aside
    v-if="lock"
    id="focusbar"
    class="lec-map-panel cv-trace"
    :aria-label="labels.ariaLabel"
    @pointerleave="$emit('hover-item', null)"
  >
    <template v-if="lock.type === 'node' && lockedLecture">
      <header>
        <span class="k">{{ labels.tracing }}</span>
        <button type="button" class="x" data-act="exit" @click="$emit('exit')">{{ labels.exit }}</button>
      </header>
      <button type="button" class="it main" :data-open="lockedLecture.id" @click="$emit('open', lockedLecture.href)">
        <i class="st" :class="lockedLecture.status" />
        <span>{{ lockedLecture.label }}</span>
        <em>{{ labels.open }}</em>
      </button>

      <h5 class="pre">{{ labels.preHeading(preLectures.length) }}</h5>
      <p v-if="preLectures.length === 0" class="none">{{ labels.nonePre }}</p>
      <ul v-else>
        <li
          v-for="item in preLectures"
          :key="`pre-${item.id}`"
          :data-id="item.id"
          @pointerenter="$emit('hover-item', item.id)"
        >
          <button type="button" class="it" :data-open="item.id" @click="$emit('open', item.href)">
            <i class="st" :class="item.status" />
            <span>{{ item.label }}</span>
          </button>
          <button type="button" class="tr" :data-trace="item.id" @click="$emit('trace', item.id)">{{ labels.traceBtn }}</button>
        </li>
      </ul>

      <h5 class="post">{{ labels.postHeading(postLectures.length) }}</h5>
      <p v-if="postLectures.length === 0" class="none">{{ labels.nonePost }}</p>
      <ul v-else>
        <li
          v-for="item in postLectures"
          :key="`post-${item.id}`"
          :data-id="item.id"
          @pointerenter="$emit('hover-item', item.id)"
        >
          <button type="button" class="it" :data-open="item.id" @click="$emit('open', item.href)">
            <i class="st" :class="item.status" />
            <span>{{ item.label }}</span>
          </button>
          <button type="button" class="tr" :data-trace="item.id" @click="$emit('trace', item.id)">{{ labels.traceBtn }}</button>
        </li>
      </ul>

      <p class="hint">{{ labels.nodeHint }}</p>
    </template>

    <template v-else-if="lock.type === 'pair'">
      <header>
        <span class="k">{{ labels.pairHeading(lock.a, lock.b, lock.edges.length) }}</span>
        <button type="button" class="x" data-act="exit" @click="$emit('exit')">{{ labels.exit }}</button>
      </header>
      <ul>
        <li
          v-for="(item, idx) in pairItems"
          :key="`pair-${idx}`"
          :data-id="item.targetId"
          @pointerenter="$emit('hover-item', item.traceKey)"
        >
          <button type="button" class="it" :data-open="item.from.id" @click="$emit('open', item.from.href)">
            <i class="st" :class="item.from.status" />
            <span>{{ item.from.label }}</span>
          </button>
          <span class="arr" aria-hidden="true">→</span>
          <button type="button" class="it" :data-open="item.to.id" @click="$emit('open', item.to.href)">
            <i class="st" :class="item.to.status" />
            <span>{{ item.to.label }}</span>
          </button>
          <button type="button" class="tr" :data-trace="item.to.id" @click="$emit('trace', item.to.id)">{{ labels.traceBtn }}</button>
        </li>
      </ul>
      <p class="hint">{{ labels.pairHint }}</p>
    </template>
  </aside>
</template>

<style scoped>
.cv-trace {
  position: absolute;
  z-index: 3;
  top: 52px;
  left: 12px;
  width: min(380px, calc(100% - 24px));
  max-height: calc(100% - 112px);
  overflow: auto;
  overflow-x: hidden;
  background: var(--lec-bg);
  border: 1px solid var(--lec-accent);
  border-radius: var(--lec-radius-2, 8px);
  padding: 8px 10px 10px;
  font-size: 13px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
  align-content: start;
  color: var(--lec-text);
}
.cv-trace > *, .cv-trace li { min-width: 0; }
.cv-trace header { display: flex; justify-content: space-between; align-items: center; }
.cv-trace .k { font-size: 12px; color: var(--lec-text-muted); }
.cv-trace .x {
  border: 0;
  background: transparent;
  color: var(--lec-text-muted);
  cursor: pointer;
  height: 26px;
  padding: 0 6px;
  border-radius: var(--lec-radius-1, 4px);
  font-size: 12px;
}
.cv-trace .x:hover { color: var(--lec-accent); background: var(--lec-accent-tint); }
.cv-trace .it {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  text-align: left;
  border: 0;
  background: transparent;
  color: var(--lec-text);
  padding: 5px 6px;
  border-radius: var(--lec-radius-1, 4px);
  cursor: pointer;
  font: inherit;
}
.cv-trace .it:hover, .cv-trace li:hover .it { background: var(--lec-accent-tint); color: var(--lec-accent); }
.cv-trace .it span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-trace .it.main { font-weight: 700; border: 1px solid var(--lec-border); padding: 7px 8px; }
.cv-trace .it em { font-style: normal; font-size: 12px; color: var(--lec-accent); font-weight: 400; }
.cv-trace h5 { margin: 6px 0 0; font-size: 12px; font-weight: 600; }
.cv-trace h5.pre { color: var(--lec-accent); }
.cv-trace h5.post { color: var(--lec-done-text); }
.cv-trace ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 1px; }
.cv-trace li { display: flex; align-items: center; gap: 4px; }
.cv-trace .tr {
  border: 1px solid var(--lec-border);
  background: var(--lec-bg);
  color: var(--lec-text-muted);
  font-size: 11.5px;
  border-radius: var(--lec-radius-1, 4px);
  padding: 2px 7px;
  cursor: pointer;
  flex: none;
}
.cv-trace .tr:hover { color: var(--lec-accent); border-color: var(--lec-accent); }
.cv-trace .st {
  width: 8px;
  height: 8px;
  border-radius: var(--lec-status-radius, 50%);
  border: 1.5px solid var(--lec-border);
  flex: none;
}
.cv-trace .st.read { background: var(--lec-done); border-color: var(--lec-done); }
.cv-trace .st.reading { border-color: var(--lec-accent); background: linear-gradient(to top, var(--lec-accent) 50%, transparent 50%); }
.cv-trace .arr { color: var(--lec-text-muted); flex: none; }
.cv-trace .hint, .cv-trace .none { margin: 2px 0 0; font-size: 12px; color: var(--lec-text-muted); }
@media (max-width: 700px) {
  .cv-trace { top: auto; bottom: 52px; max-height: 46%; }
}
</style>
