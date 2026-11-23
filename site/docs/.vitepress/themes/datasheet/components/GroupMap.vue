<script setup lang="ts">
/**
 * datasheet implementation of the `GroupMap` slot (v1), spec board 12: the DIP pinout of the group, without the port brackets
 * (prototype v3: the brackets stood for mechanical stages and meant nothing here). Pins 1..half run down the left side, the
 * rest up the right side, as on a real package. Every pin is a real link and a direct grid item (a link must never get
 * `display: contents`: Chrome cannot focus it); a pad for the padding pin of an odd count is dashed and marked NC. A ready
 * (可开始) pin gets the accent colour. The chip carries the group id, the package name and the read count.
 * The engine handles clicks, double clicks and Space on `[data-lecture]`; the component only draws.
 */
import { computed } from 'vue'

interface Lecture {
  id: string
  n: number
  number: string
  title: string
  href: string
  status: 'read' | 'reading' | 'unread'
  ready: boolean
  label: string
}

const props = defineProps<{
  groupId: string
  pkg: string
  read: number
  total: number
  lectures: readonly Lecture[]
  categories: ReadonlyArray<{ index: number; name: string; read: number; total: number }>
  categoryLang: string
  labels: { categories: string; padding: string; paddingNote: string; lectures: string }
}>()

interface Pin {
  i: number
  left: boolean
  row: number
  lecture: Lecture | null
}

const geo = computed(() => {
  const n = props.lectures.length
  const pins = n + (n % 2)
  const half = pins / 2
  const list: Pin[] = []
  for (let i = 1; i <= pins; i++) {
    const left = i <= half
    list.push({ i, left, row: left ? i : pins - i + 1, lecture: props.lectures[i - 1] ?? null })
  }
  return { n, pins, half, list }
})
</script>

<template>
  <div class="gm-d">
    <div class="dip-grid" :style="{ gridTemplateRows: `repeat(${geo.half}, 28px)` }" role="group" :aria-label="labels.lectures">
      <div class="dip-body" :style="{ gridRow: `1 / ${geo.half + 1}` }" aria-hidden="true">
        <span class="pin1" />
        <span class="chip-id">{{ groupId }}</span>
        <span class="chip-pkg">{{ pkg }}<br />{{ read }}/{{ total }}</span>
      </div>
      <div v-for="p in geo.list" :key="p.i" class="pin" :class="p.left ? 'l' : 'r'">
        <span v-if="!p.lecture" class="nc" :style="{ gridRow: p.row }" aria-hidden="true">
          <template v-if="p.left"><span class="pname">{{ labels.padding }}</span><span class="leg"><em /></span></template>
          <template v-else><span class="leg"><em /></span><span class="pname">{{ labels.padding }}</span></template>
        </span>
        <a
          v-else
          :href="p.lecture.href"
          :data-lecture="p.lecture.id"
          :data-status="p.lecture.status"
          :data-ready="p.lecture.ready ? '' : undefined"
          :style="{ gridRow: p.row }"
          :aria-label="p.lecture.label"
        >
          <template v-if="p.left">
            <span class="pname" :title="p.lecture.title">{{ p.lecture.title }}</span><span class="leg"><em>{{ p.lecture.number }}</em></span>
          </template>
          <template v-else>
            <span class="leg"><em>{{ p.lecture.number }}</em></span><span class="pname" :title="p.lecture.title">{{ p.lecture.title }}</span>
          </template>
        </a>
      </div>
    </div>
    <p v-if="geo.n % 2" class="map-note">{{ labels.paddingNote }}</p>
  </div>
</template>

<style scoped>
.dip-grid {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr) 30px 96px 30px minmax(0, 1fr) 12px;
  grid-auto-rows: 28px;
  align-items: center;
  font-size: 13px;
}
.dip-body {
  grid-column: 4;
  align-self: stretch;
  background: var(--lec-chip);
  color: var(--lec-chip-text);
  border: var(--lec-line-hair) solid var(--lec-chip-edge);
  border-radius: 3px;
  position: relative;
  margin: -8px 0;
}
.dip-body::before {
  content: '';
  position: absolute;
  top: -1px;
  left: 50%;
  width: 26px;
  height: 13px;
  transform: translateX(-50%);
  border-radius: 0 0 13px 13px;
  background: var(--lec-bg);
}
.pin1 {
  position: absolute;
  top: 20px;
  left: 10px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.7;
}
.chip-id {
  position: absolute;
  top: 30px;
  left: 0;
  right: 0;
  text-align: center;
  font: 900 20px var(--lec-font-heading);
  letter-spacing: 0.04em;
}
.chip-pkg {
  position: absolute;
  bottom: 12px;
  left: 0;
  right: 0;
  text-align: center;
  font: 400 10px/1.4 var(--lec-font-mono);
  opacity: 0.7;
}
.pin {
  display: contents;
}
.pin > a,
.pin > .nc {
  display: grid;
  align-items: center;
  height: 28px;
  min-width: 0;
  color: inherit !important;
  /* the prototype's pin names are regular; without this the link takes `.vp-doc a { font-weight: 500 }` (S6Y audit-group #5) */
  font-weight: 400;
  text-decoration: none !important;
}
.pin.l > a,
.pin.l > .nc {
  grid-column: 2 / 4;
  grid-template-columns: minmax(0, 1fr) 30px;
}
.pin.r > a,
.pin.r > .nc {
  grid-column: 5 / 7;
  grid-template-columns: 30px minmax(0, 1fr);
}
.pname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--lec-text-muted);
  padding: 0 var(--lec-space-2);
}
.pin.l .pname {
  text-align: right;
}
.leg {
  height: 10px;
  border: var(--lec-line-mid) solid var(--lec-border);
  background: var(--lec-surface);
  position: relative;
}
.pin.l .leg {
  border-right: 0;
}
.pin.r .leg {
  border-left: 0;
}
.leg em {
  font: 400 10px var(--lec-font-mono);
  font-style: normal;
  color: var(--lec-text-muted);
  position: absolute;
  top: -14px;
}
.pin.l .leg em {
  right: 2px;
}
.pin.r .leg em {
  left: 2px;
}
.pin a[data-status='read'] .leg {
  background: var(--lec-done);
  border-color: var(--lec-done);
}
.pin a[data-status='reading'] .leg {
  border-color: var(--lec-done);
  background: linear-gradient(to right, var(--lec-done) 50%, var(--lec-surface) 50%);
}
.pin a[data-ready] .leg {
  border-color: var(--lec-accent);
}
.pin a[data-ready] .pname {
  color: var(--lec-accent);
}
.pin .nc .pname {
  font: 400 11px var(--lec-font-mono);
  opacity: 0.7;
}
.pin .nc .leg {
  border-style: dashed;
  background: transparent;
}
.pin a:hover .pname,
.pin a:focus-visible .pname {
  color: var(--lec-text);
  text-decoration: underline;
}
.pin a:focus-visible {
  outline: var(--lec-line-heavy) solid var(--lec-accent);
  outline-offset: 0;
}
.map-note {
  margin: var(--lec-space-2) 0 0;
  font-size: 12px;
  color: var(--lec-text-muted);
}
@container (max-width: 480px) {
  .dip-grid {
    display: block;
  }
  .dip-body {
    display: none;
  }
  .pin.l > a,
  .pin.r > a {
    height: auto;
    grid-template-columns: 56px minmax(0, 1fr);
    padding: 6px 0;
    border-bottom: var(--lec-line-hair) solid var(--lec-border);
  }
  .pin .leg {
    order: 0;
    height: auto;
    border: 0 !important;
    padding-left: var(--lec-space-2);
    background: none !important;
    white-space: nowrap;
  }
  .pin .pname {
    order: 1;
    color: var(--lec-text);
    white-space: normal;
    text-align: left !important;
  }
  .pin .leg em {
    position: static;
    font-size: 12px;
    color: var(--lec-text);
  }
  .pin .leg::after {
    content: '';
    display: inline-block;
    width: 9px;
    height: 9px;
    margin-left: 8px;
    border: var(--lec-line-mid) solid var(--lec-border);
    border-radius: var(--lec-status-radius);
    vertical-align: -1px;
  }
  .pin a[data-status='read'] .leg::after {
    background: var(--lec-done);
    border-color: var(--lec-done);
  }
  .pin a[data-status='reading'] .leg::after {
    border-color: var(--lec-done);
    background: linear-gradient(to top, var(--lec-done) 50%, transparent 50%);
  }
  .pin .nc {
    display: none;
  }
}
</style>
