<script setup lang="ts">
/**
 * ConceptHeaderBar.vue - Stand-alone Concept Page header + Draft review banner (§5.2.5 / §14.1).
 *
 * Order on screen (§5.2.5):
 *   1. (If draft) Draft warning banner ("草稿 · AI 生成 · 待确认") with dev confirm/edit/discard tools
 *   2. Breadcrumb back-to-lecture bar
 *   3. Eyebrow ("概念" / "Concept") + single semantic `<h1>` term title
 *   4. Compact one-line spec metadata bar
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useData, useRoute, useRouter, withBase } from 'vitepress'
import { useT } from '../../i18n/useT.ts'
import { getActiveConceptReturn, returnToSourceLecture } from '../reading/concepts'
import {
  confirmConceptInDev,
  discardDraftInDev,
  fetchDevConceptsList,
  parseUnifiedDiffLines,
  previewConfirmInDev,
  probeLocalAuthorSession,
  saveDraftMarkdownInDev,
  type PreviewConfirmResponse,
} from './ai/conceptAuthorClient'

interface ConceptFrontmatterMeta {
  slug?: string
  term?: string
  english?: string
  aliases?: string[]
  field?: string
  groups?: string[]
  summary?: string
  status?: 'draft' | 'published'
  generatedBy?: string
  reviewedAt?: string
  selectionSource?: string
  sourcesCount?: number
  hasUnverified?: boolean
}

interface BacklinkEntry {
  lecturePath: string
  code: string
  title: string
  count: number
}

const { t } = useT()
const { frontmatter } = useData()
const route = useRoute()
const router = useRouter()

const isConceptPage = computed(() => {
  const fmSlug = frontmatter.value?.conceptSlug
  if (typeof fmSlug === 'string' && fmSlug.length > 0) return true
  return /(?:^|\/)concepts\/./.test(route.path)
})

const meta = computed<ConceptFrontmatterMeta>(() => {
  const cm = frontmatter.value?.conceptMeta as ConceptFrontmatterMeta | undefined
  if (cm && typeof cm === 'object') return cm
  return {
    slug: String(frontmatter.value?.conceptSlug ?? ''),
    term: String(frontmatter.value?.term ?? frontmatter.value?.title ?? ''),
    english: String(frontmatter.value?.english ?? ''),
    aliases: Array.isArray(frontmatter.value?.aliases) ? frontmatter.value.aliases : [],
    field: String(frontmatter.value?.field ?? ''),
    groups: Array.isArray(frontmatter.value?.groups) ? frontmatter.value.groups : [],
    status: frontmatter.value?.status === 'published' ? 'published' : 'draft',
    sourcesCount: 0,
    hasUnverified: false,
  }
})

const isDraft = computed(() => Boolean(frontmatter.value?.conceptIsDraft || meta.value.status === 'draft'))
const slug = computed(() => meta.value.slug || String(frontmatter.value?.conceptSlug ?? ''))
const termTitle = computed(() => meta.value.term || String(frontmatter.value?.title ?? slug.value))

const backlinks = computed<BacklinkEntry[]>(() =>
  Array.isArray(frontmatter.value?.conceptBacklinks) ? (frontmatter.value.conceptBacklinks as BacklinkEntry[]) : [],
)

const activeReturn = ref<ReturnType<typeof getActiveConceptReturn>>(null)
const refreshActiveReturn = () => {
  if (typeof window === 'undefined') {
    activeReturn.value = null
    return
  }
  activeReturn.value = getActiveConceptReturn(route.path)
}

const backLabel = computed(() => {
  if (activeReturn.value?.fromTitle) {
    return t('concepts.backToLecture', { title: activeReturn.value.fromTitle })
  }
  if (backlinks.value[0]?.title) {
    return t('concepts.backToLecture', { title: backlinks.value[0].title })
  }
  return t('concepts.backFallback')
})

const localUnverifiedOverride = ref<boolean | null>(null)
const effectiveHasUnverified = computed(() =>
  localUnverifiedOverride.value !== null ? localUnverifiedOverride.value : Boolean(meta.value.hasUnverified),
)

const statusState = computed<'published' | 'draft' | 'unverified'>(() => {
  if (effectiveHasUnverified.value) return 'unverified'
  return isDraft.value ? 'draft' : 'published'
})

const statusLabel = computed(() => {
  if (statusState.value === 'unverified') return t('concepts.statusUnverified')
  if (statusState.value === 'draft') return t('concepts.statusDraft')
  return t('concepts.statusPublished')
})

const handleBack = () => {
  const fallback = backlinks.value[0]?.lecturePath || '/'
  returnToSourceLecture((href) => router.go(withBase(href)), fallback)
}

// Local Author Mode draft preview controls
const csrfToken = ref('')
const canEditDraft = computed(() => Boolean(import.meta.env.DEV && isDraft.value && csrfToken.value))
const busy = ref(false)
const feedback = ref('')
const feedbackIsError = ref(false)
const editingMarkdown = ref(false)
const draftRawText = ref('')
const previewDiff = ref<PreviewConfirmResponse | null>(null)
const selectedIndices = ref<number[]>([])
const replaceAll = ref(false)

async function loadAuthorSession(): Promise<void> {
  if (!import.meta.env.DEV || !isConceptPage.value) return
  const dev = await probeLocalAuthorSession()
  csrfToken.value = dev.isLocalAuthor ? dev.csrfToken : ''
}

onMounted(() => {
  refreshActiveReturn()
  void loadAuthorSession()
})

watch(() => route.path, () => {
  refreshActiveReturn()
  localUnverifiedOverride.value = null
  previewDiff.value = null
  editingMarkdown.value = false
  feedback.value = ''
  if (import.meta.env.DEV && isConceptPage.value && !csrfToken.value) {
    void loadAuthorSession()
  }
})

watch(() => meta.value.hasUnverified, () => {
  localUnverifiedOverride.value = null
})

async function handleOpenEditor(): Promise<void> {
  if (!canEditDraft.value) return
  busy.value = true
  try {
    const items = await fetchDevConceptsList()
    const match = items.find((i) => i.slug === slug.value && i.status === 'draft')
    draftRawText.value = match?.raw ?? ''
    editingMarkdown.value = !editingMarkdown.value
    previewDiff.value = null
  } finally {
    busy.value = false
  }
}

async function handleSaveDraft(): Promise<void> {
  if (!canEditDraft.value || !draftRawText.value.trim()) return
  busy.value = true
  feedback.value = ''
  try {
    const res = await saveDraftMarkdownInDev(csrfToken.value, slug.value, draftRawText.value)
    if (res.ok) {
      localUnverifiedOverride.value = Boolean(res.item?.hasUnverified ?? res.hasUnverified)
      editingMarkdown.value = false
      feedback.value = t('concepts.draftSavedSuccess')
      feedbackIsError.value = false
    } else {
      feedback.value = res.message || 'Save failed'
      feedbackIsError.value = true
    }
  } finally {
    busy.value = false
  }
}

async function handleStartConfirm(): Promise<void> {
  if (!canEditDraft.value) return
  busy.value = true
  feedback.value = ''
  try {
    const res = await previewConfirmInDev(csrfToken.value, { slug: slug.value })
    previewDiff.value = res
    selectedIndices.value = res.recommendedIndex !== null && res.recommendedIndex !== undefined ? [res.recommendedIndex] : []
    replaceAll.value = false
    if (!res.ok) {
      feedback.value = res.error || 'Preview failed'
      feedbackIsError.value = true
    }
  } finally {
    busy.value = false
  }
}

async function refreshDiffAfterChoice(): Promise<void> {
  if (!canEditDraft.value) return
  busy.value = true
  try {
    const res = await previewConfirmInDev(csrfToken.value, {
      slug: slug.value,
      selectedOffsets: selectedIndices.value,
      allOccurrences: replaceAll.value,
    })
    previewDiff.value = res
  } finally {
    busy.value = false
  }
}

async function handleExecuteConfirm(): Promise<void> {
  if (!canEditDraft.value) return
  busy.value = true
  feedback.value = ''
  try {
    const res = await confirmConceptInDev(csrfToken.value, {
      slug: slug.value,
      selectedOffsets: selectedIndices.value,
      allOccurrences: replaceAll.value,
      expectedPreviewToken: previewDiff.value?.previewToken,
    })
    if (res.ok && res.url) {
      previewDiff.value = null
      feedback.value = t('concepts.publishSuccess')
      feedbackIsError.value = false
      await router.go(withBase(res.url))
    } else {
      feedback.value = res.error || 'Confirm failed'
      feedbackIsError.value = true
    }
  } finally {
    busy.value = false
  }
}

async function handleDiscard(): Promise<void> {
  if (!canEditDraft.value) return
  busy.value = true
  try {
    await discardDraftInDev(csrfToken.value, slug.value)
    handleBack()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <header v-if="isConceptPage" class="lec-concept-header" :data-concept-slug="slug">
    <!-- Draft Preview Bar (§14.1) -->
    <div v-if="isDraft" class="lec-draft-banner" data-concept-draft-banner>
      <div class="lec-draft-banner-top">
        <span class="lec-draft-label">{{ t('concepts.draftBanner') }}</span>
        <div v-if="canEditDraft" class="lec-draft-actions">
          <button type="button" class="lec-cbtn" data-concept-draft-edit :disabled="busy" @click="handleOpenEditor">
            {{ editingMarkdown ? t('concepts.actionCancelEdit') : t('concepts.actionEdit') }}
          </button>
          <button
            type="button"
            class="lec-cbtn lec-cbtn-primary"
            data-concept-draft-confirm
            :disabled="busy || effectiveHasUnverified"
            @click="handleStartConfirm"
          >
            {{ t('concepts.actionConfirm') }}
          </button>
          <button type="button" class="lec-cbtn lec-cbtn-danger" data-concept-draft-discard :disabled="busy" @click="handleDiscard">
            {{ t('concepts.actionDiscard') }}
          </button>
        </div>
      </div>

      <p v-if="effectiveHasUnverified" class="lec-draft-unverified" data-concept-unverified-warn>
        {{ t('concepts.unverifiedBlocked', { n: 1 }) }}
      </p>

      <div v-if="editingMarkdown" class="lec-diff-panel" data-concept-draft-editor>
        <textarea v-model="draftRawText" rows="12" style="width:100%;font-family:var(--lec-font-mono);font-size:0.8rem;" />
        <div class="lec-draft-actions" style="margin-top:0.5rem;">
          <button type="button" class="lec-cbtn lec-cbtn-primary" data-concept-draft-save :disabled="busy" @click="handleSaveDraft">
            {{ t('concepts.actionSaveDraft') }}
          </button>
        </div>
      </div>

      <div v-if="previewDiff?.ok" class="lec-diff-panel" data-concept-confirm-panel>
        <div v-if="previewDiff.mountStatus === 'needs_choice' || (previewDiff.candidates && previewDiff.candidates.length > 1)">
          <p style="margin:0 0 0.4rem;font-weight:600;">
            {{ t('concepts.multipleHitsTitle', { n: previewDiff.candidates?.length ?? 0 }) }}
          </p>
          <label
            v-for="cand in previewDiff.candidates"
            :key="cand.startOffset"
            style="display:block;font-size:0.82rem;margin-bottom:0.25rem;"
          >
            <input
              v-model="selectedIndices"
              type="checkbox"
              :value="cand.index"
              :disabled="replaceAll"
              :data-concept-hit-choice="cand.index"
              @change="refreshDiffAfterChoice"
            />
            Line {{ cand.line }}<template v-if="cand.heading"> ({{ cand.heading }})</template>: <code>{{ cand.snippet }}</code>
          </label>
          <label style="display:block;font-size:0.82rem;margin-top:0.4rem;">
            <input v-model="replaceAll" type="checkbox" data-concept-all-hits @change="refreshDiffAfterChoice" />
            {{ t('concepts.allOccurrencesLabel', { n: previewDiff.candidates?.length ?? 0 }) }}
          </label>
        </div>

        <p v-else-if="previewDiff.mountStatus === 'not_found'" class="db-muted">
          {{ t('concepts.zeroHitsHint', { syntax: previewDiff.manualSyntax ?? '' }) }}
        </p>

        <div v-if="previewDiff.lecturePatch || previewDiff.conceptPatch">
          <p style="margin:0.5rem 0 0.25rem;font-weight:600;font-size:0.82rem;">{{ t('concepts.diffTitle') }}</p>
          <pre v-if="previewDiff.lecturePatch" class="lec-diff-pre" data-concept-lecture-diff><template v-for="(ln, i) in parseUnifiedDiffLines(previewDiff.lecturePatch)" :key="`lp-${i}`"><span :class="ln.type === 'add' ? 'lec-diff-line-add' : ln.type === 'del' ? 'lec-diff-line-del' : ''">{{ ln.text }}
</span></template></pre>
          <pre v-if="previewDiff.conceptPatch" class="lec-diff-pre" data-concept-page-diff><template v-for="(ln, i) in parseUnifiedDiffLines(previewDiff.conceptPatch)" :key="`cp-${i}`"><span :class="ln.type === 'add' ? 'lec-diff-line-add' : ln.type === 'del' ? 'lec-diff-line-del' : ''">{{ ln.text }}
</span></template></pre>
        </div>

        <div class="lec-draft-actions" style="margin-top:0.5rem;">
          <button
            type="button"
            class="lec-cbtn lec-cbtn-primary"
            data-concept-confirm-write
            :disabled="busy || !previewDiff.canConfirm"
            @click="handleExecuteConfirm"
          >
            {{ t('concepts.confirmWriteBtn') }}
          </button>
          <button type="button" class="lec-cbtn" @click="previewDiff = null">{{ t('concepts.actionCancelEdit') }}</button>
        </div>
      </div>

      <p v-if="feedback" :style="{ margin: '0.4rem 0 0', fontSize: '0.82rem', color: feedbackIsError ? 'var(--lec-danger)' : 'var(--lec-done-text)' }">
        {{ feedback }}
      </p>
    </div>

    <!-- Breadcrumb back-to-lecture -->
    <nav class="lec-concept-crumb" :aria-label="backLabel">
      <button type="button" class="lec-concept-back" data-concept-back @click="handleBack">
        <span aria-hidden="true">&larr;</span>
        <span>{{ backLabel }}</span>
      </button>
    </nav>

    <!-- Single canonical H1 first (§5.2.5) -->
    <span class="lec-concept-eyebrow">{{ t('concepts.eyebrow') }}</span>
    <h1 class="lec-concept-title">{{ termTitle }}</h1>

    <!-- One compact meta line -->
    <div class="lec-concept-meta-line" data-concept-meta-line>
      <span v-if="meta.english" class="lec-concept-meta-item">
        {{ t('concepts.metaEnglish') }}: <strong>{{ meta.english }}</strong>
      </span>
      <span v-if="meta.aliases && meta.aliases.length > 0" class="lec-concept-meta-item">
        {{ t('concepts.metaAliases') }}: <strong>{{ meta.aliases.join(' / ') }}</strong>
      </span>
      <span v-if="meta.field" class="lec-concept-meta-item">
        {{ t('concepts.metaField') }}: <strong>{{ meta.field }}</strong>
      </span>
      <span v-if="meta.groups && meta.groups.length > 0" class="lec-concept-meta-item">
        {{ t('concepts.metaGroups') }}: <strong>{{ meta.groups.join(', ') }}</strong>
      </span>
      <span class="lec-concept-status">
        <span class="lec-concept-mark" :data-status="statusState" aria-hidden="true"></span>
        <span>{{ statusLabel }}</span>
      </span>
      <span v-if="(meta.sourcesCount ?? 0) > 0" class="lec-concept-meta-item">
        {{ t('concepts.metaSources') }}: <strong>{{ t('concepts.sourcesCount', { n: meta.sourcesCount ?? 0 }) }}</strong>
      </span>
    </div>
  </header>
</template>
