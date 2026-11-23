<script setup lang="ts">
/**
 * DashboardConceptsPanel.vue - Dashboard "概念草稿" page (the dashboard prototype).
 *
 * Local Author Mode (`isDevMode === true`):
 *   - Split master-detail list of drafts and published concepts with shape + text status marks,
 *     selectionSource, and occurrence counts.
 *   - Preview link, inline Markdown verify/edit, confirm-with-diff & occurrence choice, discard draft,
 *     and delete with multi-lecture impact preview.
 * Online Production Mode (`isDevMode === false`):
 *   - Strictly read-only (lists public `/concepts-hover.json` concepts if present, no write controls).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { withBase } from 'vitepress'
import { useT } from '../../i18n/useT.ts'
import type { ConceptHoverPayload } from '../../concepts/frontmatter'
import {
  confirmConceptInDev,
  deleteConceptInDev,
  discardDraftInDev,
  fetchDevConceptsList,
  parseUnifiedDiffLines,
  previewConfirmInDev,
  previewDeleteInDev,
  saveDraftMarkdownInDev,
  type ConceptListItem,
  type DeleteImpactResponse,
  type PreviewConfirmResponse,
} from '../components/ai/conceptAuthorClient'

const props = defineProps<{
  isDevMode: boolean
  csrfToken: string
}>()

const { t } = useT()

const items = ref<ConceptListItem[]>([])
const loading = ref(false)
const busy = ref(false)
const selectedKey = ref('')
const feedback = ref('')
const feedbackIsError = ref(false)

const editing = ref(false)
const draftRaw = ref('')
const confirmPreview = ref<PreviewConfirmResponse | null>(null)
const deleteImpact = ref<DeleteImpactResponse | null>(null)
const selectedIndices = ref<number[]>([])
const replaceAll = ref(false)

function itemKeyOf(item: Pick<ConceptListItem, 'slug' | 'status'>): string {
  return `${item.status}:${item.slug}`
}

const activeItem = computed(
  () => items.value.find((i) => itemKeyOf(i) === selectedKey.value) ?? items.value[0] ?? null,
)
const draftsCount = computed(() => items.value.filter((i) => i.status === 'draft').length)
const publishedCount = computed(() => items.value.filter((i) => i.status === 'published').length)

function statusKindOf(item: ConceptListItem): 'published' | 'draft' | 'revision' | 'unverified' {
  if (item.hasUnverified) return 'unverified'
  if (item.status === 'draft' && item.isRevision) return 'revision'
  return item.status
}

function statusTextOf(item: ConceptListItem): string {
  const kind = statusKindOf(item)
  if (kind === 'unverified') return t('concepts.statusUnverified')
  if (kind === 'revision') return t('concepts.statusPendingRevision')
  if (kind === 'draft') return t('concepts.statusDraft')
  if (item.hasDraftRevision) return `${t('concepts.statusPublished')} · ${t('concepts.statusPendingRevision')}`
  return t('concepts.statusPublished')
}

async function refreshList(): Promise<void> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return
  loading.value = true
  try {
    if (props.isDevMode) {
      items.value = await fetchDevConceptsList()
    } else {
      const res = await fetch(withBase('/concepts-hover.json'), { credentials: 'omit' }).catch(() => null)
      if (res?.ok) {
        const json = (await res.json()) as Partial<ConceptHoverPayload>
        const entries = Object.values(json.items ?? {})
        items.value = entries.map((e) => ({
          slug: e.slug,
          term: e.term,
          english: e.english,
          aliases: e.aliases,
          field: e.field,
          groups: e.groups,
          summary: e.summary,
          status: e.status,
          generatedBy: '',
          reviewedAt: '',
          previewUrl: e.url,
          occurrenceCount: 0,
          lectures: [],
          hasUnverified: false,
          unverifiedLines: [],
          sourcesCount: 0,
          body: '',
          raw: '',
          hasSelectionContext: false,
        }))
      } else {
        items.value = []
      }
    }
    if (items.value.length > 0 && !items.value.some((i) => itemKeyOf(i) === selectedKey.value)) {
      selectedKey.value = itemKeyOf(items.value[0]!)
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void refreshList()
})

watch(() => props.isDevMode, () => {
  void refreshList()
})

function selectItem(slug: string, status: ConceptListItem['status']): void {
  selectedKey.value = `${status}:${slug}`
  editing.value = false
  confirmPreview.value = null
  deleteImpact.value = null
  feedback.value = ''
}

function startEdit(): void {
  if (!props.isDevMode || !activeItem.value) return
  draftRaw.value = activeItem.value.raw
  editing.value = !editing.value
  confirmPreview.value = null
  deleteImpact.value = null
}

async function handleSaveDraft(): Promise<void> {
  if (!props.isDevMode || !props.csrfToken || !activeItem.value) return
  busy.value = true
  feedback.value = ''
  try {
    const res = await saveDraftMarkdownInDev(props.csrfToken, activeItem.value.slug, draftRaw.value)
    if (res.ok) {
      editing.value = false
      feedback.value = t('concepts.draftSavedSuccess')
      feedbackIsError.value = false
      await refreshList()
    } else {
      feedback.value = res.message || 'Save failed'
      feedbackIsError.value = true
    }
  } finally {
    busy.value = false
  }
}

async function handlePreviewConfirm(): Promise<void> {
  if (!props.isDevMode || !props.csrfToken || !activeItem.value) return
  busy.value = true
  feedback.value = ''
  deleteImpact.value = null
  editing.value = false
  try {
    const res = await previewConfirmInDev(props.csrfToken, { slug: activeItem.value.slug })
    confirmPreview.value = res
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

async function handleRefreshChoiceDiff(): Promise<void> {
  if (!props.isDevMode || !props.csrfToken || !activeItem.value) return
  busy.value = true
  try {
    confirmPreview.value = await previewConfirmInDev(props.csrfToken, {
      slug: activeItem.value.slug,
      selectedOffsets: selectedIndices.value,
      allOccurrences: replaceAll.value,
    })
  } finally {
    busy.value = false
  }
}

async function handleExecuteConfirm(): Promise<void> {
  if (!props.isDevMode || !props.csrfToken || !activeItem.value) return
  busy.value = true
  feedback.value = ''
  try {
    const res = await confirmConceptInDev(props.csrfToken, {
      slug: activeItem.value.slug,
      selectedOffsets: selectedIndices.value,
      allOccurrences: replaceAll.value,
      expectedPreviewToken: confirmPreview.value?.previewToken,
    })
    if (res.ok) {
      confirmPreview.value = null
      feedback.value = t('concepts.publishSuccess')
      feedbackIsError.value = false
      await refreshList()
    } else {
      feedback.value = res.error || 'Confirm failed'
      feedbackIsError.value = true
    }
  } finally {
    busy.value = false
  }
}

async function handleDiscard(): Promise<void> {
  if (!props.isDevMode || !props.csrfToken || !activeItem.value) return
  busy.value = true
  feedback.value = ''
  try {
    await discardDraftInDev(props.csrfToken, activeItem.value.slug)
    confirmPreview.value = null
    deleteImpact.value = null
    feedback.value = t('concepts.discardSuccess')
    feedbackIsError.value = false
    await refreshList()
  } finally {
    busy.value = false
  }
}

async function handlePreviewDelete(): Promise<void> {
  if (!props.isDevMode || !props.csrfToken || !activeItem.value) return
  busy.value = true
  feedback.value = ''
  confirmPreview.value = null
  editing.value = false
  try {
    deleteImpact.value = await previewDeleteInDev(props.csrfToken, activeItem.value.slug)
  } finally {
    busy.value = false
  }
}

async function handleExecuteDelete(): Promise<void> {
  if (!props.isDevMode || !props.csrfToken || !activeItem.value) return
  busy.value = true
  feedback.value = ''
  try {
    const res = await deleteConceptInDev(props.csrfToken, activeItem.value.slug, deleteImpact.value?.previewToken)
    if (res.ok) {
      deleteImpact.value = null
      feedback.value = t('concepts.deleteSuccess')
      feedbackIsError.value = false
      await refreshList()
    } else {
      feedback.value = res.error || 'Delete failed'
      feedbackIsError.value = true
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="db-panel" data-concepts-panel>
    <div class="db-row-between">
      <div>
        <h2 class="db-section-title">{{ t('dashboard.conceptsTitle') }}</h2>
        <p class="db-muted">{{ t('dashboard.conceptsDesc') }}</p>
      </div>
      <div class="dc-counts">
        <span class="db-chip">{{ t('dashboard.conceptsCountDrafts', { n: draftsCount }) }}</span>
        <span class="db-chip">{{ t('dashboard.conceptsCountPublished', { n: publishedCount }) }}</span>
      </div>
    </div>

    <p v-if="!isDevMode" class="db-muted" data-concepts-readonly-notice>
      {{ t('dashboard.conceptsDevOnlyHint') }}
    </p>

    <p v-if="loading && items.length === 0" class="db-muted">{{ t('dashboard.loading') }}</p>
    <p v-else-if="items.length === 0" class="db-muted" data-concepts-empty>{{ t('dashboard.conceptsEmpty') }}</p>

    <div v-else class="dc-split">
      <!-- Left list -->
      <div class="dc-list" role="listbox" :aria-label="t('dashboard.conceptsTitle')">
        <button
          v-for="item in items"
          :key="`${item.status}:${item.slug}`"
          type="button"
          class="dc-row"
          :class="{ 'is-active': activeItem?.slug === item.slug && activeItem?.status === item.status }"
          :data-concept-row="item.slug"
          :data-concept-row-status="item.status"
          :data-concept-row-revision="item.isRevision ? 'true' : undefined"
          @click="selectItem(item.slug, item.status)"
        >
          <span class="dc-row-top">
            <strong>{{ item.term }}</strong>
            <span class="lec-concept-status">
              <span class="lec-concept-mark" :data-status="statusKindOf(item)" aria-hidden="true"></span>
              <span>{{ statusTextOf(item) }}</span>
            </span>
          </span>
          <span class="dc-row-meta">
            <span>{{ item.selectionSource || t('dashboard.conceptsNoneSource') }}</span>
            <span>{{ t('dashboard.conceptsOccurrences') }}: {{ item.occurrenceCount }}</span>
          </span>
        </button>
      </div>

      <!-- Right detail -->
      <div v-if="activeItem" class="dc-view" data-concept-detail>
        <div class="db-row-between">
          <div>
            <h3 class="dc-detail-title">{{ activeItem.term }}</h3>
            <p class="db-muted">
              <code>{{ activeItem.slug }}</code> · {{ activeItem.english }} · {{ activeItem.field }}
            </p>
          </div>
          <span class="lec-concept-status">
            <span class="lec-concept-mark" :data-status="statusKindOf(activeItem)" aria-hidden="true"></span>
            <span>{{ statusTextOf(activeItem) }}</span>
          </span>
        </div>

        <p class="dc-summary">{{ activeItem.summary }}</p>

        <div class="lec-concept-meta-line" style="margin-bottom:0.75rem;">
          <span class="lec-concept-meta-item">
            {{ t('dashboard.conceptsSelectionSource') }}:
            <strong>{{ activeItem.selectionSource || t('dashboard.conceptsNoneSource') }}</strong>
          </span>
          <span class="lec-concept-meta-item">
            {{ t('dashboard.conceptsOccurrences') }}:
            <strong>{{ activeItem.occurrenceCount }}</strong>
          </span>
          <span class="lec-concept-meta-item">
            {{ t('concepts.metaGroups') }}:
            <strong>{{ activeItem.groups.join(', ') }}</strong>
          </span>
        </div>

        <p v-if="activeItem.hasUnverified" class="lec-draft-unverified" style="margin-bottom:0.65rem;">
          {{ t('concepts.unverifiedBlocked', { n: activeItem.unverifiedLines.length || 1 }) }}
        </p>

        <div class="lec-draft-actions">
          <a
            :href="withBase(activeItem.previewUrl)"
            class="lec-cbtn"
            data-dc-open-preview
          >
            {{ t('concepts.actionOpenPreview') }}
          </a>
          <template v-if="isDevMode">
            <button
              v-if="activeItem.status === 'draft'"
              type="button"
              class="lec-cbtn"
              data-dc-edit
              :disabled="busy"
              @click="startEdit"
            >
              {{ editing ? t('concepts.actionCancelEdit') : t('concepts.actionEdit') }}
            </button>
            <button
              v-if="activeItem.status === 'draft'"
              type="button"
              class="lec-cbtn lec-cbtn-primary"
              data-dc-confirm
              :disabled="busy || activeItem.hasUnverified"
              @click="handlePreviewConfirm"
            >
              {{ t('concepts.actionConfirm') }}
            </button>
            <button
              v-if="activeItem.status === 'draft'"
              type="button"
              class="lec-cbtn"
              data-dc-discard
              :disabled="busy"
              @click="handleDiscard"
            >
              {{ t('concepts.actionDiscard') }}
            </button>
            <button
              type="button"
              class="lec-cbtn lec-cbtn-danger"
              data-dc-delete
              :disabled="busy"
              @click="handlePreviewDelete"
            >
              {{ t('concepts.actionDelete') }}
            </button>
          </template>
        </div>

        <div v-if="editing" class="lec-diff-panel" data-dc-editor>
          <textarea v-model="draftRaw" rows="10" style="width:100%;font-family:var(--lec-font-mono);font-size:0.78rem;" />
          <div class="lec-draft-actions" style="margin-top:0.5rem;">
            <button type="button" class="lec-cbtn lec-cbtn-primary" data-dc-save-draft :disabled="busy" @click="handleSaveDraft">
              {{ t('concepts.actionSaveDraft') }}
            </button>
          </div>
        </div>

        <div v-if="confirmPreview?.ok" class="lec-diff-panel" data-dc-confirm-panel>
          <div v-if="confirmPreview.mountStatus === 'needs_choice' || (confirmPreview.candidates && confirmPreview.candidates.length > 1)">
            <p class="dc-sub">{{ t('concepts.multipleHitsTitle', { n: confirmPreview.candidates?.length ?? 0 }) }}</p>
            <label v-for="cand in confirmPreview.candidates" :key="cand.startOffset" class="dc-choice">
              <input
                v-model="selectedIndices"
                type="checkbox"
                :value="cand.index"
                :disabled="replaceAll"
                :data-concept-hit-choice="cand.index"
                @change="handleRefreshChoiceDiff"
              />
              <span>L{{ cand.line }}<template v-if="cand.heading"> ({{ cand.heading }})</template>: <code>{{ cand.snippet }}</code></span>
            </label>
            <label class="dc-choice">
              <input v-model="replaceAll" type="checkbox" data-concept-all-hits @change="handleRefreshChoiceDiff" />
              <span>{{ t('concepts.allOccurrencesLabel', { n: confirmPreview.candidates?.length ?? 0 }) }}</span>
            </label>
          </div>

          <p v-else-if="confirmPreview.mountStatus === 'not_found'" class="db-muted">
            {{ t('concepts.zeroHitsHint', { syntax: confirmPreview.manualSyntax ?? '' }) }}
          </p>

          <pre v-if="confirmPreview.lecturePatch" class="lec-diff-pre" data-dc-lecture-diff><template v-for="(ln, i) in parseUnifiedDiffLines(confirmPreview.lecturePatch)" :key="`dcl-${i}`"><span :class="ln.type === 'add' ? 'lec-diff-line-add' : ln.type === 'del' ? 'lec-diff-line-del' : ''">{{ ln.text }}
</span></template></pre>

          <pre v-if="confirmPreview.conceptPatch" class="lec-diff-pre" data-dc-page-diff><template v-for="(ln, i) in parseUnifiedDiffLines(confirmPreview.conceptPatch)" :key="`dcp-${i}`"><span :class="ln.type === 'add' ? 'lec-diff-line-add' : ln.type === 'del' ? 'lec-diff-line-del' : ''">{{ ln.text }}
</span></template></pre>

          <div class="lec-draft-actions" style="margin-top:0.5rem;">
            <button
              type="button"
              class="lec-cbtn lec-cbtn-primary"
              data-dc-confirm-write
              :disabled="busy || !confirmPreview.canConfirm"
              @click="handleExecuteConfirm"
            >
              {{ t('concepts.confirmWriteBtn') }}
            </button>
          </div>
        </div>

        <div v-if="deleteImpact?.ok" class="lec-diff-panel" data-dc-delete-impact>
          <p class="dc-sub">{{ t('concepts.deleteImpactTitle') }}</p>
          <p v-if="(deleteImpact.totalOccurrences ?? 0) === 0" class="db-muted">{{ t('concepts.deleteNoImpact') }}</p>
          <template v-else>
            <p class="db-muted">
              {{
                t('concepts.deleteImpactDesc', {
                  lectures: deleteImpact.totalLectures ?? 0,
                  count: deleteImpact.totalOccurrences ?? 0,
                })
              }}
            </p>
            <div v-for="imp in deleteImpact.impact" :key="imp.relDocsPath" style="margin-top:0.4rem;">
              <p class="db-muted">{{ imp.code }} · {{ imp.title }} ({{ imp.count }})</p>
              <pre class="lec-diff-pre"><template v-for="(ln, i) in parseUnifiedDiffLines(imp.patch)" :key="`dcd-${imp.code}-${i}`"><span :class="ln.type === 'add' ? 'lec-diff-line-add' : ln.type === 'del' ? 'lec-diff-line-del' : ''">{{ ln.text }}
</span></template></pre>
            </div>
          </template>
          <div class="lec-draft-actions" style="margin-top:0.5rem;">
            <button
              type="button"
              class="lec-cbtn lec-cbtn-danger"
              data-dc-confirm-delete
              :disabled="busy"
              @click="handleExecuteDelete"
            >
              {{ t('concepts.confirmDeleteBtn') }}
            </button>
          </div>
        </div>

        <p v-if="feedback" :style="{ margin: '0.6rem 0 0', fontSize: '0.82rem', color: feedbackIsError ? 'var(--lec-danger)' : 'var(--lec-done-text)' }">
          {{ feedback }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dc-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.dc-split {
  display: grid;
  grid-template-columns: minmax(15rem, 22rem) 1fr;
  gap: 1rem;
  margin-top: 0.85rem;
}

@media (max-width: 780px) {
  .dc-split {
    grid-template-columns: 1fr;
  }
}

.dc-list {
  display: grid;
  gap: 0.5rem;
  align-content: start;
}

.dc-row {
  text-align: left;
  padding: 0.65rem 0.75rem;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-bg);
  color: var(--lec-text);
  cursor: pointer;
  display: grid;
  gap: 0.3rem;
}

.dc-row.is-active {
  border-color: var(--lec-accent);
  background: var(--lec-accent-tint);
}

.dc-row-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.88rem;
}

.dc-row-meta {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--lec-text-muted);
}

.dc-view {
  padding: 0.9rem 1rem;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-2);
  background: var(--lec-bg);
}

.dc-detail-title {
  margin: 0 0 0.25rem;
  font-family: var(--lec-font-heading);
  font-size: 1.08rem;
}

.dc-summary {
  margin: 0.55rem 0 0.75rem;
  font-size: 0.88rem;
}

.dc-sub {
  margin: 0 0 0.35rem;
  font-size: 0.82rem;
  font-weight: 600;
}

.dc-choice {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  font-size: 0.8rem;
  margin-bottom: 0.3rem;
}
</style>
