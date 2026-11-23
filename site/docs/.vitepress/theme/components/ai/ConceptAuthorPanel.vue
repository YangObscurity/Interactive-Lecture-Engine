<script setup lang="ts">
/**
 * ConceptAuthorPanel.vue - Local Author Mode workspace inside AiSidebar for creating,
 * attaching, editing, supplementing, and deleting stand-alone concept pages from a text selection.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { withBase } from 'vitepress'
import { useT } from '../../../i18n/useT.ts'
import { normalizePromptLang } from '../../../prompts/companion.ts'
import type { PendingConceptAction } from './aiState'
import {
  confirmConceptInDev,
  deleteConceptInDev,
  discardDraftInDev,
  generateConceptDraftInDev,
  parseUnifiedDiffLines,
  previewConfirmInDev,
  previewDeleteInDev,
  probeLocalAuthorSession,
  type ConceptListItem,
  type DeleteImpactResponse,
  type DuplicateConceptMatch,
  type PreviewConfirmResponse,
} from './conceptAuthorClient'

const props = defineProps<{
  task: PendingConceptAction
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t, lang } = useT()
const csrfToken = ref('')
const busy = ref(false)
const instruction = ref('')
const errorMessage = ref('')
const statusMessage = ref('')

const activeModeOverride = ref<PendingConceptAction['mode'] | null>(null)
const activeTargetSlugOverride = ref('')
const effectiveMode = computed(() => activeModeOverride.value ?? props.task.mode)
const effectiveTargetSlug = computed(() => activeTargetSlugOverride.value || props.task.targetSlug || '')

const duplicateMatches = ref<DuplicateConceptMatch[]>([])
const selectedDuplicateSlug = ref('')
const chosenDuplicateMatch = computed(
  () => duplicateMatches.value.find((m) => m.slug === selectedDuplicateSlug.value) ?? null,
)
const draftWarnings = ref<string[]>([])

const draftItem = ref<ConceptListItem | null>(null)
const confirmPreview = ref<PreviewConfirmResponse | null>(null)
const deleteImpact = ref<DeleteImpactResponse | null>(null)
const selectedIndices = ref<number[]>([])
const replaceAll = ref(false)

const modeLabel = computed(() => {
  if (effectiveMode.value === 'edit') return t('ai.conceptModeEdit')
  if (effectiveMode.value === 'supplement') return t('ai.conceptModeSupplement')
  if (effectiveMode.value === 'attach') return t('ai.conceptModeAttach')
  if (effectiveMode.value === 'delete') return t('ai.conceptModeDelete')
  return t('ai.conceptModeCreate')
})

async function initTask(): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  activeModeOverride.value = null
  activeTargetSlugOverride.value = ''
  duplicateMatches.value = []
  selectedDuplicateSlug.value = ''
  draftWarnings.value = []
  draftItem.value = null
  confirmPreview.value = null
  deleteImpact.value = null
  selectedIndices.value = []
  replaceAll.value = false

  const session = await probeLocalAuthorSession()
  csrfToken.value = session.csrfToken
  if (!session.isLocalAuthor || !session.csrfToken) return

  if (props.task.mode === 'attach' && props.task.targetSlug) {
    busy.value = true
    try {
      const res = await previewConfirmInDev(csrfToken.value, {
        slug: props.task.targetSlug,
        lecturePath: props.task.lecturePath,
        selectedText: props.task.selectedText,
      })
      confirmPreview.value = res
      if (res.recommendedIndex !== null && res.recommendedIndex !== undefined) {
        selectedIndices.value = [res.recommendedIndex]
      }
      if (!res.ok) errorMessage.value = res.error || 'Failed to preview link'
    } finally {
      busy.value = false
    }
  } else if (props.task.mode === 'delete' && props.task.targetSlug) {
    busy.value = true
    try {
      const res = await previewDeleteInDev(csrfToken.value, props.task.targetSlug)
      deleteImpact.value = res
      if (!res.ok) errorMessage.value = res.error || 'Failed to compute delete impact'
    } finally {
      busy.value = false
    }
  }
}

onMounted(() => {
  void initTask()
})

watch(
  () => props.task,
  () => {
    void initTask()
  },
  { deep: true },
)

async function handleGenerateDraft(): Promise<void> {
  if (!csrfToken.value) return
  busy.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  confirmPreview.value = null
  duplicateMatches.value = []
  selectedDuplicateSlug.value = ''
  draftWarnings.value = []
  try {
    const mode =
      effectiveMode.value === 'edit'
        ? 'edit'
        : effectiveMode.value === 'supplement'
          ? 'supplement'
          : 'create'
    const res = await generateConceptDraftInDev({
      csrfToken: csrfToken.value,
      mode,
      lecturePath: props.task.lecturePath,
      selectedText: props.task.selectedText,
      sectionHeading: props.task.sectionHeading,
      beforeContext: props.task.beforeContext,
      afterContext: props.task.afterContext,
      targetSlug: effectiveTargetSlug.value || undefined,
      instruction: instruction.value.trim() || undefined,
      lang: normalizePromptLang(lang.value),
    })
    if (!res.ok && res.errorCode === 'DUPLICATE') {
      const list = res.matches && res.matches.length > 0 ? res.matches : res.existing ? [res.existing] : []
      duplicateMatches.value = list
      if (list.length === 1 && list[0]) {
        selectedDuplicateSlug.value = list[0].slug
      }
      return
    }
    if (!res.ok || !res.item) {
      const detail = res.errors?.length ? ` (${res.errors[0]})` : ''
      errorMessage.value = `${res.message || t('ai.conceptSchemaInvalid')}${detail}`
      return
    }
    draftItem.value = res.item
    draftWarnings.value = Array.isArray(res.warnings) ? res.warnings : []
  } finally {
    busy.value = false
  }
}

async function startSupplementForSlug(slug: string): Promise<void> {
  if (!slug) return
  activeModeOverride.value = 'supplement'
  activeTargetSlugOverride.value = slug
  duplicateMatches.value = []
  selectedDuplicateSlug.value = ''
  await handleGenerateDraft()
}

async function handlePreviewConfirm(): Promise<void> {
  const slug = draftItem.value?.slug || effectiveTargetSlug.value
  if (!csrfToken.value || !slug) return
  busy.value = true
  errorMessage.value = ''
  try {
    const res = await previewConfirmInDev(csrfToken.value, {
      slug,
      lecturePath: props.task.lecturePath,
      selectedText: props.task.selectedText,
      selectedOffsets: selectedIndices.value.length > 0 ? selectedIndices.value : undefined,
      allOccurrences: replaceAll.value,
    })
    confirmPreview.value = res
    if (selectedIndices.value.length === 0 && res.recommendedIndex !== null && res.recommendedIndex !== undefined) {
      selectedIndices.value = [res.recommendedIndex]
    }
    if (!res.ok) errorMessage.value = res.error || 'Preview failed'
  } finally {
    busy.value = false
  }
}

async function handleRefreshChoiceDiff(): Promise<void> {
  const slug = draftItem.value?.slug || effectiveTargetSlug.value
  if (!csrfToken.value || !slug) return
  busy.value = true
  try {
    confirmPreview.value = await previewConfirmInDev(csrfToken.value, {
      slug,
      lecturePath: props.task.lecturePath,
      selectedText: props.task.selectedText,
      selectedOffsets: selectedIndices.value,
      allOccurrences: replaceAll.value,
    })
  } finally {
    busy.value = false
  }
}

async function handleExecuteConfirm(): Promise<void> {
  const slug = draftItem.value?.slug || effectiveTargetSlug.value
  if (!csrfToken.value || !slug) return
  busy.value = true
  errorMessage.value = ''
  try {
    const res = await confirmConceptInDev(csrfToken.value, {
      slug,
      lecturePath: props.task.lecturePath,
      selectedText: props.task.selectedText,
      selectedOffsets: selectedIndices.value,
      allOccurrences: replaceAll.value,
      expectedPreviewToken: confirmPreview.value?.previewToken,
    })
    if (res.ok) {
      statusMessage.value = t('concepts.publishSuccess')
      confirmPreview.value = null
      if (draftItem.value) draftItem.value = { ...draftItem.value, status: 'published' }
    } else {
      errorMessage.value = res.error || 'Confirm failed'
    }
  } finally {
    busy.value = false
  }
}

async function handleDiscardDraft(): Promise<void> {
  if (!csrfToken.value || !draftItem.value) return
  busy.value = true
  try {
    await discardDraftInDev(csrfToken.value, draftItem.value.slug)
    draftItem.value = null
    confirmPreview.value = null
    statusMessage.value = t('concepts.discardSuccess')
  } finally {
    busy.value = false
  }
}

async function handleExecuteDelete(): Promise<void> {
  if (!csrfToken.value || !props.task.targetSlug) return
  busy.value = true
  errorMessage.value = ''
  try {
    const res = await deleteConceptInDev(csrfToken.value, props.task.targetSlug, deleteImpact.value?.previewToken)
    if (res.ok) {
      statusMessage.value = t('concepts.deleteSuccess')
      deleteImpact.value = null
    } else {
      errorMessage.value = res.error || 'Delete failed'
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="lec-ca-panel" data-concept-author-panel>
    <header class="lec-ca-head">
      <div>
        <span class="lec-ca-badge">{{ modeLabel }}</span>
        <h3 class="lec-ca-title">{{ t('ai.conceptPanelTitle') }}</h3>
      </div>
      <button type="button" class="lec-cbtn" data-concept-author-back @click="emit('close')">
        {{ t('ai.conceptPanelBackChat') }}
      </button>
    </header>

    <div class="lec-ca-body">
      <div class="lec-ca-quote" data-concept-author-selection>
        <strong>{{ task.selectedText }}</strong>
        <span v-if="task.sectionHeading" class="lec-ca-meta">{{ task.sectionHeading }}</span>
      </div>

      <!-- Create / Edit / Supplement Draft Form -->
      <div
        v-if="(effectiveMode === 'create' || effectiveMode === 'edit' || effectiveMode === 'supplement') && !draftItem && duplicateMatches.length === 0"
        class="lec-ca-form"
      >
        <label class="lec-ca-label" for="lec-ca-instruction">{{ t('ai.conceptInstructionLabel') }}</label>
        <textarea
          id="lec-ca-instruction"
          v-model="instruction"
          class="lec-ca-input"
          rows="2"
          :placeholder="t('ai.conceptInstructionPlaceholder')"
        />
        <div class="lec-draft-actions">
          <button
            type="button"
            class="lec-cbtn lec-cbtn-primary"
            data-concept-generate-btn
            :disabled="busy"
            @click="handleGenerateDraft"
          >
            {{ busy ? t('ai.conceptGenerating') : t('ai.conceptGenerateBtn') }}
          </button>
        </div>
      </div>

      <!-- Duplicate Match Prompt (no model call on create hit) -->
      <div v-if="duplicateMatches.length > 0 && !draftItem" class="lec-ca-card" data-concept-duplicate>
        <p class="lec-ca-sub">{{ t('ai.conceptDuplicateTitle') }}</p>
        <template v-if="duplicateMatches.length === 1 && duplicateMatches[0]">
          <p class="lec-ca-meta">
            {{
              t('ai.conceptDuplicateDesc', {
                term: duplicateMatches[0].term,
                slug: duplicateMatches[0].slug,
                status:
                  duplicateMatches[0].status === 'published'
                    ? t('concepts.statusPublished')
                    : t('concepts.statusDraft'),
              })
            }}
          </p>
          <div class="lec-draft-actions">
            <a :href="withBase(duplicateMatches[0].url)" class="lec-cbtn" data-concept-duplicate-open>
              {{ t('ai.conceptOpenExistingBtn') }}
            </a>
            <button
              type="button"
              class="lec-cbtn lec-cbtn-primary"
              data-concept-duplicate-supplement
              :disabled="busy"
              @click="startSupplementForSlug(duplicateMatches[0].slug)"
            >
              {{ t('ai.conceptSupplementBtn') }}
            </button>
          </div>
        </template>
        <template v-else>
          <p class="lec-ca-meta">{{ t('ai.conceptDuplicateMultiple', { n: duplicateMatches.length }) }}</p>
          <label
            v-for="m in duplicateMatches"
            :key="m.slug"
            class="lec-ca-choice"
          >
            <input
              v-model="selectedDuplicateSlug"
              type="radio"
              name="lec-dup-pick"
              :value="m.slug"
              :data-concept-duplicate-choice="m.slug"
            />
            <span>
              <strong>{{ m.term }}</strong>
              <code>{{ m.slug }}</code>
              ({{ m.status === 'published' ? t('concepts.statusPublished') : t('concepts.statusDraft') }})
            </span>
          </label>
          <div class="lec-draft-actions">
            <a
              v-if="chosenDuplicateMatch"
              :href="withBase(chosenDuplicateMatch.url)"
              class="lec-cbtn"
              data-concept-duplicate-open
            >
              {{ t('ai.conceptOpenExistingBtn') }}
            </a>
            <button
              v-else
              type="button"
              class="lec-cbtn"
              data-concept-duplicate-open
              disabled
            >
              {{ t('ai.conceptOpenExistingBtn') }}
            </button>
            <button
              type="button"
              class="lec-cbtn lec-cbtn-primary"
              data-concept-duplicate-supplement
              :disabled="busy || !selectedDuplicateSlug"
              @click="startSupplementForSlug(selectedDuplicateSlug)"
            >
              {{ t('ai.conceptSupplementBtn') }}
            </button>
          </div>
        </template>
      </div>

      <!-- Draft Card (dcard2) -->
      <div v-if="draftItem" class="lec-ca-card" data-concept-draft-card>
        <div class="lec-draft-banner-top">
          <strong>{{ draftItem.term }}</strong>
          <span class="lec-concept-status">
            <span
              class="lec-concept-mark"
              :data-status="draftItem.hasUnverified ? 'unverified' : draftItem.isRevision ? 'revision' : draftItem.status"
              aria-hidden="true"
            ></span>
            <span>{{
              draftItem.hasUnverified
                ? t('concepts.statusUnverified')
                : draftItem.status === 'draft' && draftItem.isRevision
                  ? t('concepts.statusPendingRevision')
                  : draftItem.status === 'draft'
                    ? t('concepts.statusDraft')
                    : t('concepts.statusPublished')
            }}</span>
          </span>
        </div>
        <p class="lec-ca-meta">{{ draftItem.english }} · {{ draftItem.field }} · {{ draftItem.groups.join(', ') }}</p>
        <p class="lec-ca-summary">{{ draftItem.summary }}</p>
        <p v-if="draftItem.hasUnverified" class="lec-draft-unverified">
          {{ t('concepts.unverifiedBlocked', { n: draftItem.unverifiedLines.length || 1 }) }}
        </p>
        <div v-if="draftWarnings.length > 0" class="lec-ca-warn" data-concept-draft-warnings>
          <p class="lec-ca-sub">{{ t('ai.conceptWarningsTitle') }}</p>
          <ul class="lec-ca-warn-list">
            <li v-for="(w, wi) in draftWarnings" :key="`cw-${wi}`">{{ w }}</li>
          </ul>
        </div>

        <div class="lec-draft-actions">
          <a
            :href="withBase(draftItem.previewUrl)"
            class="lec-cbtn"
            data-concept-open-preview
          >
            {{ t('concepts.actionOpenPreview') }}
          </a>
          <button
            v-if="draftItem.status === 'draft'"
            type="button"
            class="lec-cbtn lec-cbtn-primary"
            data-concept-sidebar-confirm
            :disabled="busy || draftItem.hasUnverified"
            @click="handlePreviewConfirm"
          >
            {{ t('concepts.actionConfirm') }}
          </button>
          <button
            v-if="draftItem.status === 'draft'"
            type="button"
            class="lec-cbtn lec-cbtn-danger"
            data-concept-sidebar-discard
            :disabled="busy"
            @click="handleDiscardDraft"
          >
            {{ t('concepts.actionDiscard') }}
          </button>
        </div>
      </div>

      <!-- Occurrence choice + Diff Preview before writing -->
      <div v-if="confirmPreview?.ok" class="lec-diff-panel" data-concept-author-diff>
        <div v-if="confirmPreview.mountStatus === 'needs_choice' || (confirmPreview.candidates && confirmPreview.candidates.length > 1)">
          <p class="lec-ca-sub">{{ t('concepts.multipleHitsTitle', { n: confirmPreview.candidates?.length ?? 0 }) }}</p>
          <label
            v-for="cand in confirmPreview.candidates"
            :key="cand.startOffset"
            class="lec-ca-choice"
          >
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
          <label class="lec-ca-choice">
            <input v-model="replaceAll" type="checkbox" data-concept-all-hits @change="handleRefreshChoiceDiff" />
            <span>{{ t('concepts.allOccurrencesLabel', { n: confirmPreview.candidates?.length ?? 0 }) }}</span>
          </label>
        </div>

        <p v-else-if="confirmPreview.mountStatus === 'not_found'" class="lec-ca-meta">
          {{ t('concepts.zeroHitsHint', { syntax: confirmPreview.manualSyntax ?? '' }) }}
        </p>

        <div v-if="confirmPreview.lecturePatch">
          <p class="lec-ca-sub">{{ t('concepts.diffTitle') }}</p>
          <pre class="lec-diff-pre" data-concept-lecture-diff><template v-for="(ln, i) in parseUnifiedDiffLines(confirmPreview.lecturePatch)" :key="`sd-${i}`"><span :class="ln.type === 'add' ? 'lec-diff-line-add' : ln.type === 'del' ? 'lec-diff-line-del' : ''">{{ ln.text }}
</span></template></pre>
        </div>

        <div v-if="confirmPreview.conceptPatch">
          <p class="lec-ca-sub">{{ t('ai.conceptPageDiffTitle') }}</p>
          <pre class="lec-diff-pre" data-concept-page-diff><template v-for="(ln, i) in parseUnifiedDiffLines(confirmPreview.conceptPatch)" :key="`cp-${i}`"><span :class="ln.type === 'add' ? 'lec-diff-line-add' : ln.type === 'del' ? 'lec-diff-line-del' : ''">{{ ln.text }}
</span></template></pre>
        </div>

        <div class="lec-draft-actions">
          <button
            type="button"
            class="lec-cbtn lec-cbtn-primary"
            data-concept-confirm-write
            :disabled="busy || !confirmPreview.canConfirm"
            @click="handleExecuteConfirm"
          >
            {{ t('concepts.confirmWriteBtn') }}
          </button>
        </div>
      </div>

      <!-- Delete impact preview + diff -->
      <div v-if="deleteImpact?.ok" class="lec-diff-panel" data-concept-delete-impact>
        <p class="lec-ca-sub">{{ t('concepts.deleteImpactTitle') }}</p>
        <p v-if="(deleteImpact.totalOccurrences ?? 0) === 0" class="lec-ca-meta">
          {{ t('concepts.deleteNoImpact') }}
        </p>
        <template v-else>
          <p class="lec-ca-meta">
            {{
              t('concepts.deleteImpactDesc', {
                lectures: deleteImpact.totalLectures ?? 0,
                count: deleteImpact.totalOccurrences ?? 0,
              })
            }}
          </p>
          <div v-for="imp in deleteImpact.impact" :key="imp.relDocsPath" style="margin-top:0.4rem;">
            <p class="lec-ca-meta">{{ imp.code }} · {{ imp.title }} ({{ imp.count }})</p>
            <pre class="lec-diff-pre"><template v-for="(ln, i) in parseUnifiedDiffLines(imp.patch)" :key="`di-${imp.code}-${i}`"><span :class="ln.type === 'add' ? 'lec-diff-line-add' : ln.type === 'del' ? 'lec-diff-line-del' : ''">{{ ln.text }}
</span></template></pre>
          </div>
        </template>
        <div class="lec-draft-actions" style="margin-top:0.5rem;">
          <button
            type="button"
            class="lec-cbtn lec-cbtn-danger"
            data-concept-confirm-delete
            :disabled="busy"
            @click="handleExecuteDelete"
          >
            {{ t('concepts.confirmDeleteBtn') }}
          </button>
        </div>
      </div>

      <p v-if="errorMessage" class="lec-draft-unverified" data-concept-author-error>{{ errorMessage }}</p>
      <p v-if="statusMessage" class="lec-ca-ok" data-concept-author-status>{{ statusMessage }}</p>
    </div>
  </section>
</template>

<style scoped>
.lec-ca-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--lec-bg);
  color: var(--lec-text);
  font-family: var(--lec-font-body);
}

.lec-ca-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lec-space-2);
  padding: var(--lec-space-3) var(--lec-space-4);
  border-bottom: var(--lec-line-hair) solid var(--lec-border);
  background: var(--lec-surface);
}

.lec-ca-badge {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--lec-accent);
  font-family: var(--lec-font-mono);
}

.lec-ca-title {
  margin: 0;
  font-size: 0.95rem;
  font-family: var(--lec-font-heading);
}

.lec-ca-body {
  padding: var(--lec-space-3) var(--lec-space-4);
  overflow-y: auto;
  display: grid;
  gap: var(--lec-space-3);
}

.lec-ca-quote {
  display: grid;
  gap: 0.2rem;
  padding: var(--lec-space-2) var(--lec-space-3);
  border-left: var(--lec-line-heavy) solid var(--lec-accent);
  background: var(--lec-surface);
  font-size: 0.85rem;
}

.lec-ca-label {
  display: block;
  margin-bottom: var(--lec-space-1);
  font-size: 0.78rem;
  font-weight: 600;
}

.lec-ca-input {
  width: 100%;
  padding: var(--lec-space-2);
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-bg);
  color: var(--lec-text);
  font-size: 0.82rem;
  margin-bottom: var(--lec-space-2);
}

.lec-ca-card {
  padding: var(--lec-space-3);
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-2);
  background: var(--lec-surface);
  display: grid;
  gap: var(--lec-space-2);
}

.lec-ca-meta {
  margin: 0;
  font-size: 0.78rem;
  color: var(--lec-text-muted);
}

.lec-ca-summary {
  margin: 0;
  font-size: 0.84rem;
}

.lec-ca-sub {
  margin: 0 0 0.35rem;
  font-size: 0.8rem;
  font-weight: 600;
}

.lec-ca-choice {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  font-size: 0.78rem;
  margin-bottom: 0.3rem;
}

.lec-ca-ok {
  margin: 0;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--lec-done-text);
}

.lec-ca-warn {
  padding: var(--lec-space-2) var(--lec-space-3);
  border: var(--lec-line-hair) solid var(--lec-warning);
  border-left: var(--lec-line-heavy) solid var(--lec-warning);
  border-radius: var(--lec-radius-1);
  background: var(--lec-warning-tint);
  font-size: 0.76rem;
}

.lec-ca-warn-list {
  margin: 0;
  padding-left: 1.1rem;
  display: grid;
  gap: 0.2rem;
}
</style>
