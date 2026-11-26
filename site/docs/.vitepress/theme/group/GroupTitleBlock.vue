<script setup lang="ts">
/**
 * GroupTitleBlock.vue - the title block of the group page (P4a WP-H3; spec board 06 and the prototype's `header`): category and
 * group id, the title, the one-line positioning and the summary, the spec table (lecture count and read count with "可开始 n 讲",
 * charts and key points, and the two new rows "先修自" / "后续" with the groups this group builds on and leads to), and the
 * continue / start buttons. Same DOM in both themes; `theme.css` draws the table (`.lec-tb-top`, `.lec-tb-spec`).
 */
import { withBase } from 'vitepress'
import { useT } from '../../i18n/useT.ts'
import type { GroupRef } from './model'

export interface TitleBlockCta {
  /** The main button: continue where the reader was, or start / start again. */
  kind: 'continue' | 'start' | 'restart'
  href: string
  label: string
  /** "读到 62%" next to a continue button, '' when unknown. */
  pct: string
  /** The secondary button "从第 N 讲开始" (only with `continue`). */
  startHref: string
  startLabel: string
}

defineProps<{
  id: string
  category: string
  /** Colour slot 1-8 of the category. */
  catSlot: number
  title: string
  tagline: string
  summary: string
  tags: readonly string[]
  lectureCount: number
  stages: number
  chartCount: number
  read: number
  reading: number
  ready: number
  /** "已译 n / 共 m 讲" on a page of another language; '' otherwise. */
  translated: string
  pre: readonly GroupRef[]
  post: readonly GroupRef[]
  /** Prefix of the group page links (`/en` or ''). */
  prefix: string
  cta: TitleBlockCta
  /** Language of the category name when it is not the page's ('' otherwise). */
  notionLang: string
  /** True when the group is a temporary group (`temp: true`). */
  temp?: boolean
}>()

const { t } = useT()
</script>

<template>
  <header class="gp-tb" :style="{ '--c': `var(--lec-cat-${catSlot})` }" data-gp-tb>
    <div class="gp-tb-top lec-tb-top">
      <span class="grp"><i aria-hidden="true" /><span :lang="notionLang || undefined">{{ category }}</span></span>
      <span v-if="temp" class="gp-tb-right">
        <span class="gid-temp" data-temp-badge :title="t('group.tempHint')">{{ t('group.temp') }}</span>
        <span class="gid">{{ id }}</span>
      </span>
      <span v-else class="gid">{{ id }}</span>
    </div>
    <h1>
      <small>{{ t('group.tb.crumb', { id }) }}</small
      >{{ title }}
    </h1>
    <p class="tagline">{{ tagline }}</p>
    <p class="sum">{{ summary }}</p>
    <p v-if="temp" class="gp-temp-note" data-gp-temp-note>{{ t('group.tempHint') }}</p>
    <table class="gp-spec lec-tb-spec">
      <tbody>
        <tr>
          <th scope="row">{{ t('group.spec.lectures') }}</th>
          <td class="num" data-gp-spec="lectures">
            {{ t('group.spec.lectureCount', { n: lectureCount }) }}<template v-if="stages">{{ t('group.spec.stages', { n: stages }) }}</template>
            <span v-if="translated" class="gp-translated">{{ translated }}</span>
          </td>
          <th scope="row">{{ t('group.spec.read') }}</th>
          <td data-gp-spec="read">
            <span class="gp-status-tag">
              <i class="gp-mk" :class="read === lectureCount ? 's-read' : read || reading ? 's-reading' : ''" aria-hidden="true" />
              <span class="num"
                >{{ read }} / {{ lectureCount }}<template v-if="reading">{{ t('group.spec.reading', { n: reading }) }}</template
                ><template v-if="ready">{{ t('group.spec.ready', { n: ready }) }}</template></span
              >
            </span>
          </td>
        </tr>
        <tr>
          <th scope="row">{{ t('group.spec.charts') }}</th>
          <td class="num">{{ chartCount ? t('group.spec.chartCount', { n: chartCount }) : t('group.spec.none') }}</td>
          <th scope="row">{{ t('group.spec.tags') }}</th>
          <td>{{ tags.join(t('card.tagsSeparator')) }}</td>
        </tr>
        <tr>
          <th scope="row">{{ t('group.spec.pre') }}</th>
          <td colspan="3" data-gp-spec="pre">
            <template v-if="pre.length">
              <template v-for="(g, i) in pre" :key="g.id"
                ><span v-if="i" class="sep">{{ t('card.tagsSeparator') }}</span
                ><a class="gref" :href="withBase(`${prefix}/${g.dir}/`)" :title="g.title"><b>{{ g.id }}</b>{{ g.title }}<span class="cnt">{{ t('group.spec.edges', { n: g.count }) }}</span></a></template
              >
            </template>
            <span v-else class="none">{{ t('group.spec.none') }}</span>
          </td>
        </tr>
        <tr>
          <th scope="row">{{ t('group.spec.post') }}</th>
          <td colspan="3" data-gp-spec="post">
            <template v-if="post.length">
              <template v-for="(g, i) in post" :key="g.id"
                ><span v-if="i" class="sep">{{ t('card.tagsSeparator') }}</span
                ><a class="gref" :href="withBase(`${prefix}/${g.dir}/`)" :title="g.title"><b>{{ g.id }}</b>{{ g.title }}<span class="cnt">{{ t('group.spec.edges', { n: g.count }) }}</span></a></template
              >
            </template>
            <span v-else class="none">{{ t('group.spec.none') }}</span>
          </td>
        </tr>
      </tbody>
    </table>
    <div class="gp-cta">
      <a class="gp-btn primary" :href="withBase(cta.href)" :data-gp-cta="cta.kind" :title="cta.label"
        ><span>{{ cta.label }}</span></a
      >
      <span v-if="cta.pct" class="pct">{{ cta.pct }}</span>
      <a v-if="cta.kind === 'continue'" class="gp-btn ghost" :href="withBase(cta.startHref)" data-gp-cta="start" :title="cta.startLabel"
        ><span>{{ cta.startLabel }}</span></a
      >
    </div>
  </header>
</template>
