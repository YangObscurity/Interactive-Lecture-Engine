<script setup lang="ts">
/**
 * datasheet implementation of the `GroupCard` slot (v1), spec board 13.1 (the device card): the heavy top rule, category
 * square and ruled spec table of 06, and the DIP of 12 laid flat: text horizontal, notch and pin-1 dot at the left end, pins
 * numbered counter-clockwise from pin 1, one pin per lecture (read solid, reading half, unread hollow), the padding pin
 * dashed and marked NC; the pitch is 8 instead of 10 above 48 pins. The package drawing is hidden from screen readers.
 */
import { computed } from 'vue'

const props = defineProps<{
  id: string
  href: string
  category: string
  slot: number
  title: string
  tagline: string
  summary: string
  tags: readonly string[]
  total: number
  read: number
  reading: number
  ticks: string
  pkg: string
  next: { kind: 'reading' | 'start' | 'done' | 'next'; heading: string; title: string }
  labels: { lectures: string; read: string; readHeading: string; lecturesHeading: string; tagsHeading: string; tagsSeparator: string; enter: string }
}>()

const L = 8
const H = 46
const TOP = 12
const PAD = 18

const geo = computed(() => {
  const n = props.total
  const pins = n + (n % 2)
  const k = Math.max(1, pins / 2)
  const pitch = k > 24 ? 8 : 10
  const w = k > 24 ? 4 : 5
  const bw = Math.max(k * pitch + 28, 96)
  const vw = bw + 2 * PAD
  const vh = H + 2 * L + 2 * TOP
  const x0 = PAD + 0.5
  const y0 = TOP + L + 0.5
  const start = x0 + (bw - (k - 1) * pitch) / 2
  const state = (i: number): 'nc' | 'read' | 'reading' | 'unread' => {
    if (i > n) return 'nc'
    const c = props.ticks[i - 1]
    return c === 'r' ? 'read' : c === 'g' ? 'reading' : 'unread'
  }
  const pinList: Array<{ i: number; x: number; y: number; state: string }> = []
  for (let i = 1; i <= k; i++) {
    const x = start + (i - 1) * pitch
    pinList.push({ i, x, y: y0 + H, state: state(i) })
    pinList.push({ i: 2 * k + 1 - i, x, y: y0 - L, state: state(2 * k + 1 - i) })
  }
  const num = (i: number): string => (i > n ? 'NC' : String(i))
  const xl = start
  const xr = start + (k - 1) * pitch
  const nums = [
    { t: num(1), x: xl, y: y0 + H + L + 9 },
    ...(k > 1 ? [{ t: num(k), x: xr, y: y0 + H + L + 9 }] : []),
    { t: num(k + 1), x: xr, y: y0 - L - 3 },
    ...(k > 1 ? [{ t: num(2 * k), x: xl, y: y0 - L - 3 }] : []),
  ]
  return { vw, vh, bw, x0, y0, cy: y0 + H / 2, w, pinList, nums }
})
</script>

<template>
  <a class="dcard" :href="href" :data-group="id" :style="{ '--c': `var(--lec-cat-${slot})` }">
    <div class="dcard-top">
      <span class="grp"><i />{{ category }}</span>
      <span>{{ id }}</span>
    </div>
    <h3>{{ title }}</h3>
    <p class="tagl">{{ tagline }}</p>
    <svg class="pkg" :viewBox="`0 0 ${geo.vw} ${geo.vh}`" :style="{ width: `${geo.vw}px` }" aria-hidden="true">
      <template v-for="p in geo.pinList" :key="p.i">
        <rect class="p" :class="p.state" :x="p.x - geo.w / 2" :y="p.y" :width="geo.w" :height="L" />
        <rect v-if="p.state === 'reading'" class="p-half" :x="p.x - geo.w / 2" :y="p.y + L / 2" :width="geo.w" :height="L / 2" />
      </template>
      <text v-for="(n, i) in geo.nums" :key="i" class="pn" :x="n.x" :y="n.y" text-anchor="middle">{{ n.t }}</text>
      <rect class="chip" :x="geo.x0" :y="geo.y0" :width="geo.bw" :height="H" rx="3" />
      <path class="notch" :d="`M${geo.x0 - 1} ${geo.cy - 6}H${geo.x0}A6 6 0 0 1 ${geo.x0} ${geo.cy + 6}H${geo.x0 - 1}Z`" />
      <circle class="chip-lbl dot" :cx="geo.x0 + 9" :cy="geo.y0 + H - 9" r="2.5" />
      <text class="chip-lbl chip-id" :x="geo.x0 + geo.bw / 2" :y="geo.y0 + 22" text-anchor="middle">{{ id }}</text>
      <text class="chip-lbl chip-pkg" :x="geo.x0 + geo.bw / 2" :y="geo.y0 + 36" text-anchor="middle">{{ pkg }} {{ read }}/{{ total }}</text>
    </svg>
    <p class="sum">{{ summary }}</p>
    <table class="dcard-spec">
      <colgroup><col style="width: 3.8em"><col><col style="width: 3.8em"><col></colgroup>
      <tbody>
        <tr><th :title="labels.lecturesHeading">{{ labels.lecturesHeading }}</th><td class="num" :title="String(total)">{{ total }}</td><th :title="labels.readHeading">{{ labels.readHeading }}</th><td class="num" :title="`${read} / ${total}`">{{ read }} / {{ total }}</td></tr>
        <tr><th :title="next.heading">{{ next.heading }}</th><td colspan="3" class="t" :title="next.title">{{ next.title }}</td></tr>
        <tr><th :title="labels.tagsHeading">{{ labels.tagsHeading }}</th><td colspan="3" class="t" :title="tags.join(labels.tagsSeparator)">{{ tags.join(labels.tagsSeparator) }}</td></tr>
      </tbody>
    </table>
    <div class="dcard-foot">{{ labels.enter }}</div>
  </a>
</template>

<style scoped>
.dcard {
  display: flex;
  flex-direction: column;
  gap: var(--lec-space-2);
  min-width: 0;
  padding: var(--lec-space-2) var(--lec-space-4) var(--lec-space-3);
  border: var(--lec-line-hair) solid var(--lec-border);
  border-top: var(--lec-line-heavy) solid var(--lec-text);
  border-radius: 0 0 var(--lec-radius-1) var(--lec-radius-1);
  background: var(--lec-surface);
  color: var(--lec-text);
  text-decoration: none;
}
.dcard:hover { border-color: var(--lec-accent); border-top-color: var(--lec-text); }
.dcard p { margin: 0; }
.dcard-top { display: flex; justify-content: space-between; gap: var(--lec-space-3); font-size: 12.5px; color: var(--lec-text-muted); }
.grp { display: inline-flex; align-items: center; gap: var(--lec-space-2); color: var(--lec-text); font-weight: 500; }
.grp i { width: 10px; height: 10px; background: var(--c); border-radius: 2px; }
.dcard-top span:last-child { font-family: var(--lec-font-mono); }
.dcard h3 { margin: 0; padding: 0; border: 0; font-size: 19px; font-weight: var(--lec-heading-weight); line-height: 1.35; }
.tagl { margin-top: -6px; font-size: 13px; color: var(--lec-text-muted); }
.pkg { max-width: 100%; height: auto; margin: var(--lec-space-1) 0; display: block; }
.pkg text { font-family: var(--lec-font-mono); }
.chip { fill: var(--lec-chip); stroke: var(--lec-chip-edge); }
.chip-lbl { fill: var(--lec-chip-text); font-family: var(--lec-font-heading); }
.dot { opacity: 0.7; }
.chip-id { font-size: 17px; font-weight: 900; }
.chip-pkg { font-size: 8.5px; opacity: 0.7; font-family: var(--lec-font-mono); }
.notch { fill: var(--lec-surface); }
.p { fill: var(--lec-bg); stroke: var(--lec-border); stroke-width: 1; }
.p.read { fill: var(--lec-done); stroke: var(--lec-done); }
.p.reading { stroke: var(--lec-done); }
.p.nc { fill: none; stroke-dasharray: 2 2; }
.p-half { fill: var(--lec-done); stroke: none; }
.pn { fill: var(--lec-text-muted); font-size: 8px; }
.sum {
  font-family: var(--lec-font-body);
  font-size: 13.5px;
  line-height: 1.8;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dcard-spec { display: table; width: 100%; max-width: 100%; overflow: visible; table-layout: fixed; border-collapse: collapse; font-size: 12.5px; border-top: var(--lec-line-hair) solid var(--lec-text); border-bottom: var(--lec-line-hair) solid var(--lec-text); margin: 0; }
.dcard-spec th, .dcard-spec td { padding: 4px var(--lec-space-2); text-align: left; vertical-align: top; border: 0; border-right: var(--lec-line-hair) solid var(--lec-border); background: none; }
.dcard-spec td:last-child { border-right: 0; }
.dcard-spec tr + tr th, .dcard-spec tr + tr td { border-top: var(--lec-line-hair) solid var(--lec-border); }
.dcard-spec th { color: var(--lec-text-muted); font-weight: 400; white-space: nowrap; background: var(--lec-bg); }
.dcard-spec td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcard-foot { margin-top: auto; padding-top: var(--lec-space-1); font-size: 13px; font-weight: 600; color: var(--lec-accent); }
</style>
