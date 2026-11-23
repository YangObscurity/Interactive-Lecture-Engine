<script setup lang="ts">
/**
 * ConceptRelatedFooter.vue - the three panels at the end of a concept page:
 *   相关概念 (grouped by relation role, both directions), 被这些概念引用 (backlinks), 出现在这些讲 (lectures, with count).
 *
 * Everything is in the page data (`frontmatter.conceptPanels`, written at build time by `config.mts` from the concept
 * graph). The build already bounded it by the page's own tier, so a page only ever lists what a reader of that page
 * may read; nothing is fetched here. A panel without entries is not rendered, nor is the section when all are empty.
 */
import { computed } from 'vue'
import { useData, useRoute, withBase } from 'vitepress'
import { useT } from '../../i18n/useT.ts'
import type { MessageKey } from '../../i18n/index.ts'
import type { ConceptPanels } from '../../concepts/graph'
import type { RelationRole } from '../../concepts/related'

const { t } = useT()
const { frontmatter } = useData()
const route = useRoute()

const ROLE_KEYS: Record<RelationRole, MessageKey> = {
  prerequisite: 'concepts.rel.prerequisite',
  'required-by': 'concepts.rel.requiredBy',
  'part-of': 'concepts.rel.partOf',
  'has-part': 'concepts.rel.hasPart',
  contrast: 'concepts.rel.contrast',
  generalization: 'concepts.rel.generalization',
  specialization: 'concepts.rel.specialization',
  'applied-in': 'concepts.rel.appliedIn',
  applies: 'concepts.rel.applies',
}

const isConceptPage = computed(() => {
  const fmSlug = frontmatter.value?.conceptSlug
  if (typeof fmSlug === 'string' && fmSlug.length > 0) return true
  return /(?:^|\/)concepts\/./.test(route.path)
})

const panels = computed<ConceptPanels>(() => {
  const raw = frontmatter.value?.conceptPanels as Partial<ConceptPanels> | undefined
  return {
    related: Array.isArray(raw?.related) ? raw.related : [],
    backlinks: Array.isArray(raw?.backlinks) ? raw.backlinks : [],
    lectures: Array.isArray(raw?.lectures) ? raw.lectures : [],
  }
})

const hasAny = computed(
  () => panels.value.related.length > 0 || panels.value.backlinks.length > 0 || panels.value.lectures.length > 0,
)
</script>

<template>
  <section v-if="isConceptPage && hasAny" class="lec-concept-related" data-concept-related>
    <section v-if="panels.related.length > 0" class="lec-cpanel" data-concept-panel="related">
      <h2 class="lec-cpanel-title">{{ t('concepts.panelRelated') }}</h2>
      <div v-for="group in panels.related" :key="group.role" class="lec-cpanel-group" :data-rel-role="group.role">
        <h3 class="lec-cpanel-role">{{ t(ROLE_KEYS[group.role]) }}</h3>
        <ul class="lec-cpanel-list">
          <li v-for="item in group.items" :key="item.slug">
            <a :href="withBase(item.url)" class="lec-cpanel-card" :data-concept-link="item.slug">
              <span class="lec-cpanel-term">{{ item.term }}</span>
              <span v-if="item.summary" class="lec-cpanel-summary">{{ item.summary }}</span>
            </a>
          </li>
        </ul>
      </div>
    </section>

    <section v-if="panels.backlinks.length > 0" class="lec-cpanel" data-concept-panel="backlinks">
      <h2 class="lec-cpanel-title">{{ t('concepts.panelBacklinks') }}</h2>
      <ul class="lec-cpanel-list">
        <li v-for="item in panels.backlinks" :key="item.slug">
          <a :href="withBase(item.url)" class="lec-cpanel-card" :data-concept-link="item.slug">
            <span class="lec-cpanel-term">{{ item.term }}</span>
            <span v-if="item.summary" class="lec-cpanel-summary">{{ item.summary }}</span>
          </a>
        </li>
      </ul>
    </section>

    <section v-if="panels.lectures.length > 0" class="lec-cpanel" data-concept-panel="lectures">
      <h2 class="lec-cpanel-title">{{ t('concepts.panelLectures') }}</h2>
      <ul class="lec-concept-related-list">
        <li v-for="item in panels.lectures" :key="item.route">
          <a :href="withBase(item.route)" class="lec-concept-related-link" :data-lecture-link="item.id">
            <span>
              <span class="lec-concept-related-code">{{ item.id }}</span>
              · {{ item.title }}
            </span>
            <span class="lec-concept-related-code">{{ t('concepts.occurrenceTimes', { n: item.count }) }}</span>
          </a>
        </li>
      </ul>
    </section>
  </section>
</template>
