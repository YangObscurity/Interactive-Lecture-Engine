<script setup lang="ts">
/** DbDiff.vue — line diff of two texts (jsdiff), changed lines with one line of context, the rest folded. */
import { computed } from 'vue'
import { diffLines } from 'diff'
import { useT } from '../../i18n/useT.ts'

const props = defineProps<{ before: string; after: string; title?: string; file?: string; note?: string }>()
const { t } = useT()

interface Row {
  k: ' ' | '+' | '-' | '…'
  text: string
}

const rows = computed<Row[]>(() => {
  const all: Row[] = []
  for (const part of diffLines(props.before, props.after)) {
    const k = part.added ? '+' : part.removed ? '-' : ' '
    const lines = part.value.replace(/\n$/, '').split('\n')
    for (const l of lines) all.push({ k, text: l })
  }
  const keep = new Set<number>()
  all.forEach((r, i) => {
    if (r.k !== ' ') for (let d = -1; d <= 1; d++) keep.add(i + d)
  })
  const out: Row[] = []
  all.forEach((r, i) => {
    if (keep.has(i)) out.push(r)
    else if (keep.has(i - 1)) out.push({ k: '…', text: '' })
  })
  return out
})
const same = computed(() => !rows.value.some((r) => r.k === '+' || r.k === '-'))
</script>

<template>
  <div class="db-diff" data-dashboard-diff>
    <header v-if="title || file || note">
      <b v-if="title">{{ title }}</b><code v-if="file">{{ file }}</code><span v-if="note">{{ note }}</span>
    </header>
    <pre
      ><span v-if="same" class="ctx">{{ t('dsh.common.noDiff') }}</span
      ><template v-else
        ><span v-for="(r, i) in rows" :key="i" :class="r.k === '+' ? 'add' : r.k === '-' ? 'del' : 'ctx'">{{ r.k === '…' ? '  …' : `${r.k} ${r.text}` }}</span></template
      ></pre>
  </div>
</template>
