<script setup lang="ts">
/**
 * PageAccess.vue — Course groups and access tiers.
 * Supports local author mode (`/__lecture/api/access`) and online admin mode (`/api/admin/access`).
 * Online saves trigger a non-blocking `rebuild_required` banner via `dashboardClient`.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useData } from 'vitepress'
import { useT } from '../../../i18n/useT.ts'
import type { DevDashboardStatus } from '../../api/admin'
import type { DevAccessSummary } from '../../api/devDashboard'
import { dashboardClient } from '../dashboardClient'
import DbDiff from '../DbDiff.vue'
import DbHead from '../DbHead.vue'
import DbUnavailable from '../DbUnavailable.vue'
import { canAccessPage, canWritePage, dashboardState, registerModel, say, touchModels } from '../useDashboard'
import type { DashGroup } from '../dashboardData'
import type { AccessConfig } from '../../../access/tiers.ts'

type TierChoice = 'public' | 'login' | 'groups' | 'admin'
type ReadRule = 'public' | 'authenticated' | string[]

const props = withDefaults(
  defineProps<{
    access: DevAccessSummary | null
    autheliaPreview: string
    rulesNote?: { code: string; detail?: string } | null
    demo?: boolean
  }>(),
  {
    rulesNote: null,
    demo: false,
  },
)

const emit = defineEmits<{ saved: [access: AccessConfig]; status: [status: DevDashboardStatus] }>()
const { t } = useT()
const { theme } = useData<{ groups?: DashGroup[] }>()

const groups = computed<DashGroup[]>(() => (Array.isArray(theme.value?.groups) ? theme.value.groups : []))
const onlineAccess = ref<DevAccessSummary | null>(null)
const onlineLoadError = ref('')
const effectiveAccess = computed<DevAccessSummary | null>(() => onlineAccess.value ?? props.access)
const writable = computed(() => canWritePage('access') && !props.demo && !onlineLoadError.value)
const selectAllEl = ref<HTMLInputElement | null>(null)

const TIER_CHOICES: readonly TierChoice[] = ['public', 'login', 'groups', 'admin']

function tierChoiceOf(read: ReadRule | undefined): TierChoice {
  if (read === 'public' || !read) return 'public'
  if (read === 'authenticated') return 'login'
  if (Array.isArray(read)) {
    if (read.length === 1 && (read[0] === 'admin' || read[0] === 'admins')) return 'admin'
    return 'groups'
  }
  return 'public'
}

function readOfChoice(choice: TierChoice, userGroups?: string[]): ReadRule {
  if (choice === 'public') return 'public'
  if (choice === 'login') return 'authenticated'
  if (choice === 'admin') return ['admin']
  const cleaned = (userGroups ?? []).map((s) => s.trim()).filter(Boolean)
  return cleaned.length > 0 ? cleaned : ['staff']
}

function tierLabel(choice: TierChoice): string {
  switch (choice) {
    case 'public':
      return t('dsh.ac.public')
    case 'login':
      return t('dsh.ac.login')
    case 'groups':
      return t('dsh.ac.acl')
    case 'admin':
      return t('dsh.ac.admin')
  }
}

function tierDesc(choice: TierChoice): string {
  switch (choice) {
    case 'public':
      return t('dsh.ac.publicHint')
    case 'login':
      return t('dsh.ac.loginHint')
    case 'groups':
      return t('dsh.ac.aclHint')
    case 'admin':
      return t('dsh.ac.adminHint')
  }
}

function tierText(read: ReadRule | undefined): string {
  if (read === 'public' || !read) return t('dsh.ac.public')
  if (read === 'authenticated') return t('dsh.ac.login')
  if (Array.isArray(read)) {
    if (read.length === 1 && (read[0] === 'admin' || read[0] === 'admins')) return t('dsh.ac.admin')
    return t('dsh.ac.groupsTier', { names: read.join(', ') })
  }
  return t('dsh.ac.public')
}

function tierKind(read: ReadRule | undefined): 'public' | 'login' | 'acl' {
  if (read === 'authenticated') return 'login'
  if (Array.isArray(read)) return 'acl'
  return 'public'
}

const saved = ref<Record<string, ReadRule>>({})
const draft = ref<Record<string, ReadRule>>({})
const savedAutheliaRules = ref<string>(props.autheliaPreview)
const draftAutheliaRules = ref<string>(props.autheliaPreview)
const draftRulesNote = ref<{ code: string; detail?: string } | null>(props.rulesNote ?? null)

function initFromAccess(acc: DevAccessSummary | null): void {
  const map: Record<string, ReadRule> = {}
  for (const g of groups.value) {
    const existing = acc?.groups.find((item) => item.id === g.id)
    map[g.id] = existing ? existing.read : (acc?.default ?? 'public')
  }
  saved.value = JSON.parse(JSON.stringify(map)) as Record<string, ReadRule>
  draft.value = JSON.parse(JSON.stringify(map)) as Record<string, ReadRule>
  savedAutheliaRules.value = props.autheliaPreview
  draftAutheliaRules.value = props.autheliaPreview
  draftRulesNote.value = props.rulesNote ?? null
}

function normalizeOnlineAccess(raw: Record<string, unknown>): DevAccessSummary {
  const def = raw.default === 'authenticated' ? 'authenticated' : 'public'
  const enf = raw.enforcement === 'gateway' ? 'gateway' : 'none'
  const rawGroups = raw.groups && typeof raw.groups === 'object' && !Array.isArray(raw.groups)
    ? (raw.groups as Record<string, { read?: ReadRule }>)
    : {}
  const list = groups.value.map((g) => {
    const entry = rawGroups[g.id]
    const read = entry?.read ?? def
    return { id: g.id, read, own: Boolean(entry) }
  })
  return {
    default: def,
    enforcement: enf,
    groups: list,
    configFile: 'site_settings:access',
    accessFile: { path: 'access.json', exists: true, savedAt: null },
    rawAccess: raw,
  }
}

watch(
  () => [effectiveAccess.value, groups.value],
  () => {
    if (Object.keys(saved.value).length === 0) {
      initFromAccess(effectiveAccess.value)
    }
  },
  { immediate: true },
)

watch(
  () => props.autheliaPreview,
  (v) => {
    if (!savedAutheliaRules.value) savedAutheliaRules.value = v
    if (!draftAutheliaRules.value) draftAutheliaRules.value = v
  },
)

const hasRestricted = computed(() => {
  return Object.values(draft.value).some((r) => r !== 'public')
})

function buildConfigFrom(source: Record<string, ReadRule>): AccessConfig {
  const def = effectiveAccess.value?.default ?? 'public'
  const restricted = Object.values(source).some((r) => r !== 'public')
  const enf = restricted ? 'gateway' : (effectiveAccess.value?.enforcement ?? 'none')
  const groupRules: Record<string, { read: ReadRule }> = {}
  for (const g of groups.value) {
    const r = source[g.id]
    if (r !== undefined) {
      groupRules[g.id] = { read: r }
    }
  }
  return {
    default: def,
    enforcement: enf,
    groups: groupRules,
  }
}

const savedJson = computed(() => JSON.stringify(buildConfigFrom(saved.value), null, 2))
const draftJson = computed(() => JSON.stringify(buildConfigFrom(draft.value), null, 2))
const dirty = computed(() => savedJson.value !== draftJson.value)

function isRowDirty(id: string): boolean {
  return JSON.stringify(draft.value[id]) !== JSON.stringify(saved.value[id])
}

const changedGroups = computed(() => {
  return groups.value.filter((g) => isRowDirty(g.id))
})

const changedLecturesCount = computed(() => {
  return changedGroups.value.reduce((sum, g) => sum + (g.lectureCount ?? 0), 0)
})

const counts = computed(() => {
  const c = { public: 0, login: 0, acl: 0 }
  for (const g of groups.value) {
    const r = writable.value ? draft.value[g.id] : effectiveAccess.value?.groups.find((x) => x.id === g.id)?.read
    c[tierKind(r)]++
  }
  return c
})

const selectedGroups = ref<Set<string>>(new Set())
const selectedCount = computed(() => selectedGroups.value.size)
const bulkTier = ref<TierChoice>('public')
const bulkUserGroups = ref<string>('staff')

function toggleSelectGroup(id: string): void {
  if (selectedGroups.value.has(id)) {
    selectedGroups.value.delete(id)
  } else {
    selectedGroups.value.add(id)
  }
  syncSelectAllBox()
}

function toggleSelectAll(): void {
  if (selectedGroups.value.size === groups.value.length) {
    selectedGroups.value.clear()
  } else {
    selectedGroups.value = new Set(groups.value.map((g) => g.id))
  }
  syncSelectAllBox()
}

function clearSelection(): void {
  selectedGroups.value.clear()
  syncSelectAllBox()
}

function syncSelectAllBox(): void {
  nextTick(() => {
    if (selectAllEl.value) {
      const n = selectedGroups.value.size
      const total = groups.value.length
      selectAllEl.value.indeterminate = n > 0 && n < total
      selectAllEl.value.checked = n === total && total > 0
    }
  })
}

watch(selectedCount, () => syncSelectAllBox())

const tpOpen = ref<string | null>(null)
const tpMenuStyle = ref<{ top?: string; bottom?: string; left: string }>({ top: '0px', left: '0px' })

function placeTpMenu(trigger: HTMLElement | null): void {
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 268))
  const estimatedHeight = 230
  if (rect.bottom + 4 + estimatedHeight > window.innerHeight - 8 && rect.top - 4 - estimatedHeight > 8) {
    tpMenuStyle.value = { bottom: `${Math.round(window.innerHeight - rect.top + 4)}px`, left: `${Math.round(left)}px` }
  } else {
    tpMenuStyle.value = { top: `${Math.round(rect.bottom + 4)}px`, left: `${Math.round(left)}px` }
  }
}

function toggleTp(id: string, ev?: MouseEvent): void {
  if (tpOpen.value === id) {
    tpOpen.value = null
    return
  }
  placeTpMenu((ev?.currentTarget as HTMLElement | null) ?? null)
  tpOpen.value = id
}

function selectGroupTier(id: string, choice: TierChoice): void {
  const existing = draft.value[id]
  const userGroups = Array.isArray(existing) ? existing : ['staff']
  draft.value[id] = readOfChoice(choice, userGroups)
  tpOpen.value = null
  touch()
}

function selectBulkTier(choice: TierChoice): void {
  bulkTier.value = choice
  tpOpen.value = null
}

function applyBulkTier(): void {
  if (selectedGroups.value.size === 0) return
  const groupsList = bulkUserGroups.value.split(',').map((s) => s.trim()).filter(Boolean)
  const targetRead = readOfChoice(bulkTier.value, groupsList)
  for (const id of selectedGroups.value) {
    draft.value[id] = targetRead
  }
  say(t('dsh.ac.applyBulk', { n: selectedGroups.value.size }))
  touch()
}

function userGroupsString(id: string): string {
  const cur = draft.value[id]
  return Array.isArray(cur) ? cur.join(', ') : 'staff'
}

function updateUserGroups(id: string, raw: string): void {
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean)
  draft.value[id] = names.length > 0 ? names : ['staff']
  touch()
}

let previewDebounce: ReturnType<typeof setTimeout> | null = null
let previewSeq = 0
function cancelPendingPreview(): void {
  if (previewDebounce) {
    clearTimeout(previewDebounce)
    previewDebounce = null
  }
  previewSeq++
}

function updateRulesPreview(): void {
  if (!writable.value || dashboardState.mode !== 'dev' || !dashboardState.token) return
  cancelPendingPreview()
  const seq = previewSeq
  previewDebounce = setTimeout(async () => {
    const res = await dashboardClient.previewAccess(buildConfigFrom(draft.value))
    if (seq !== previewSeq || !dirty.value) return
    if (res.ok) {
      if (res.autheliaPreview !== undefined) draftAutheliaRules.value = res.autheliaPreview
      if (res.autheliaPreviewNote !== undefined) draftRulesNote.value = res.autheliaPreviewNote
    }
  }, 250)
}

function touch(): void {
  feedback.value = ''
  touchModels()
  updateRulesPreview()
}

const saving = ref(false)
const feedback = ref('')
const feedbackError = ref(false)
const showDiff = ref(false)

async function save(): Promise<boolean> {
  if (!dirty.value || !writable.value) return false
  if (dashboardState.mode === 'dev' && !dashboardState.token) return false
  saving.value = true
  cancelPendingPreview()
  try {
    const payload = buildConfigFrom(draft.value)
    const res = await dashboardClient.saveAccess(payload as unknown as Record<string, unknown>)
    if (res.ok) {
      const n = changedGroups.value.length
      saved.value = JSON.parse(JSON.stringify(draft.value)) as Record<string, ReadRule>
      if (res.autheliaPreview !== undefined) {
        draftAutheliaRules.value = res.autheliaPreview
        savedAutheliaRules.value = res.autheliaPreview
      } else {
        savedAutheliaRules.value = draftAutheliaRules.value
      }
      if (res.autheliaPreviewNote !== undefined) {
        draftRulesNote.value = res.autheliaPreviewNote
      }
      if (dashboardState.mode === 'online') {
        onlineAccess.value = normalizeOnlineAccess(payload as unknown as Record<string, unknown>)
      }
      const msg = dashboardState.mode === 'online' ? t('dsh.ac.savedOnline', { n }) : t('dsh.ac.savedFeedback', { n })
      feedback.value = msg
      feedbackError.value = false
      showDiff.value = false
      say(msg)
      if (res.status) emit('status', res.status)
      emit('saved', payload)
      touchModels()
      return true
    }
    feedback.value = res.error || t('dsh.ac.saveFailed')
    feedbackError.value = true
    return false
  } finally {
    saving.value = false
  }
}

function discard(): void {
  cancelPendingPreview()
  draft.value = JSON.parse(JSON.stringify(saved.value)) as Record<string, ReadRule>
  draftAutheliaRules.value = savedAutheliaRules.value
  draftRulesNote.value = props.rulesNote ?? null
  selectedGroups.value.clear()
  showDiff.value = false
  tpOpen.value = null
  feedback.value = ''
  touchModels()
}

let unregister: (() => void) | null = null
onMounted(async () => {
  unregister = registerModel('access', { page: 'access', dirty: () => dirty.value, save, discard })

  const onDocClick = (e: MouseEvent) => {
    if (tpOpen.value && !(e.target as HTMLElement)?.closest('.db-tp')) {
      tpOpen.value = null
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && tpOpen.value) {
      tpOpen.value = null
    }
  }
  const onViewportChange = () => {
    if (tpOpen.value) tpOpen.value = null
  }
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
  onBeforeUnmount(() => {
    cancelPendingPreview()
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('scroll', onViewportChange, true)
    window.removeEventListener('resize', onViewportChange)
    unregister?.()
  })

  if (dashboardState.mode === 'online' && canAccessPage('access')) {
    onlineLoadError.value = ''
    const res = await dashboardClient.fetchAccess()
    if (res.ok && res.access) {
      const normalized = normalizeOnlineAccess(res.access)
      onlineAccess.value = normalized
      initFromAccess(normalized)
      touchModels()
    } else if (res.ok && !res.access) {
      const la = (theme.value as { lectureAccess?: { default?: string; enforcement?: string; tiers?: unknown[]; inlineTier?: string } } | undefined)?.lectureAccess
      const isRestrictedInTheme = Boolean(
        la && (
          (la.default && la.default !== 'public') ||
          (la.enforcement && la.enforcement !== 'none') ||
          (Array.isArray(la.tiers) && la.tiers.length > 0) ||
          (la.inlineTier && la.inlineTier !== 'public')
        )
      )
      if (res.source === 'uninitialized_restricted' || isRestrictedInTheme) {
        onlineLoadError.value = t('dsh.ac.uninitializedRestrictedErr')
        feedback.value = onlineLoadError.value
        feedbackError.value = true
      } else {
        const cleanDefaults = { default: 'public', enforcement: 'none', groups: {} }
        const normalized = normalizeOnlineAccess(cleanDefaults)
        onlineAccess.value = normalized
        initFromAccess(normalized)
        touchModels()
      }
    } else {
      onlineLoadError.value = res.error || t('dsh.ac.loadOnlineErr')
      feedback.value = t('dsh.ac.loadOnlineErr')
      feedbackError.value = true
    }
  }
})

const copied = ref(false)
const currentAutheliaPreview = computed(() => (writable.value ? draftAutheliaRules.value : props.autheliaPreview))
const currentRulesNote = computed(() => (writable.value ? draftRulesNote.value : props.rulesNote))
const rulesDiffDirty = computed(() => {
  return (
    savedAutheliaRules.value.trim() !== '' &&
    draftAutheliaRules.value.trim() !== '' &&
    savedAutheliaRules.value !== draftAutheliaRules.value
  )
})

async function copyRules(): Promise<void> {
  try {
    await navigator.clipboard.writeText(currentAutheliaPreview.value)
    copied.value = true
    say(t('dsh.ac.copied'))
    setTimeout(() => (copied.value = false), 1800)
  } catch {
    say(t('dsh.common.copyFailed'))
  }
}

const accessFileRelPath = computed(() => effectiveAccess.value?.accessFile?.path ?? effectiveAccess.value?.configFile ?? 'content/access.json')
</script>

<template>
  <div class="db-page" data-page="access">
    <DbHead
      :title="t('dsh.nav.access')"
      :lead="t('dsh.ac.lead')"
      :meta="effectiveAccess ? [[t('dsh.common.file'), effectiveAccess.accessFile?.exists ? effectiveAccess.accessFile.path : effectiveAccess.configFile]] : []"
      :read-only="!writable"
    />

    <div v-if="onlineLoadError" class="db-errbox" role="alert" data-access-load-error>
      {{ onlineLoadError }}
    </div>
    <div v-if="!canWritePage('access') && dashboardState.mode === 'online'" class="db-banner" data-access-ro-banner>
      <span class="db-info" aria-hidden="true"></span>
      <span>{{ t('dsh.ac.roBanner') }}</span>
    </div>
    <div v-else-if="props.demo" class="db-banner" data-access-demo-banner>
      <span class="db-info" aria-hidden="true"></span>
      <span>{{ t('dsh.ac.demoBanner') }}</span>
    </div>
    <div v-else-if="dashboardState.mode === 'online'" class="db-banner" data-access-online-banner>
      <span class="db-info" aria-hidden="true"></span>
      <span>{{ t('dsh.ac.onlineWritableBanner') }}</span>
    </div>

    <div v-if="effectiveAccess" class="db-figs">
      <div><b>{{ counts.public }}</b><span>{{ t('dsh.ac.public') }}</span><small>{{ t('dsh.ac.publicHint') }}</small></div>
      <div><b>{{ counts.login }}</b><span>{{ t('dsh.ac.login') }}</span></div>
      <div><b>{{ counts.acl }}</b><span>{{ t('dsh.ac.acl') }}</span></div>
      <div>
        <b>{{ hasRestricted || effectiveAccess.enforcement === 'gateway' ? t('dsh.ac.gatewayYes') : t('dsh.ac.gatewayNo') }}</b>
        <span>{{ t('dsh.ac.enforcement') }}</span>
        <small>{{ t('dsh.ac.defaultIs', { tier: tierText(effectiveAccess.default) }) }}</small>
      </div>
    </div>

    <section class="db-panel" data-access-groups>
      <header>
        <h3>{{ t('dsh.ac.groupsTitle') }}</h3>
        <span class="db-hm">
          {{ changedGroups.length ? t('dsh.ac.pendingChanges', { n: changedGroups.length }) : t('dsh.ac.groupsHint', { n: groups.length }) }}
        </span>
      </header>

      <div
        v-if="writable"
        class="db-bulk"
        :class="{ on: selectedCount > 0 }"
        role="group"
        :aria-label="t('dsh.ac.bulkBarHint')"
        data-bulk-bar
      >
        <div class="db-bulk-l">
          <label class="db-ck">
            <input
              ref="selectAllEl"
              type="checkbox"
              data-bselall
              :checked="selectedCount === groups.length && groups.length > 0"
              :aria-label="t('dsh.ac.selectAll')"
              @change="toggleSelectAll"
            />
            <span v-if="selectedCount > 0" class="db-cnt">{{ t('dsh.ac.selectedCount', { n: selectedCount }) }}</span>
            <span v-else>{{ t('dsh.ac.selectAll') }}</span>
          </label>
          <button v-if="selectedCount > 0" type="button" class="db-btn sm" data-do="bulkclear" @click="clearSelection">
            {{ t('dsh.ac.clearSelection') }}
          </button>
          <span v-else class="db-bh">{{ t('dsh.ac.bulkBarHint') }}</span>
        </div>
        <div v-if="selectedCount > 0" class="db-bulk-r">
          <span class="db-bl" id="bl-to">{{ t('dsh.ac.setTo') }}</span>
          <div class="db-tp">
            <button
              type="button"
              class="db-tp-btn"
              data-tpopen="bulk"
              aria-haspopup="listbox"
              :aria-expanded="tpOpen === 'bulk'"
              :aria-label="`${t('dsh.ac.setTo')}: ${tierLabel(bulkTier)}`"
              @click.stop="toggleTp('bulk', $event)"
            >
              <svg v-if="bulkTier === 'public'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2.2 2.2 2.2 9.8 0 12M8 2c-2.2 2.2-2.2 9.8 0 12" /></svg>
              <svg v-else-if="bulkTier === 'login'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="5.5" r="2.6" /><path d="M3 14c.6-3 2.6-4.6 5-4.6s4.4 1.6 5 4.6" /></svg>
              <svg v-else-if="bulkTier === 'groups'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="2.2" /><circle cx="11.3" cy="6.7" r="1.8" /><path d="M1.8 14c.5-2.7 2.1-4.1 4.2-4.1s3.7 1.4 4.2 4.1M10.8 10.2c1.8.1 2.9 1.3 3.4 3.6" /></svg>
              <svg v-else class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
              <span class="tn">{{ tierLabel(bulkTier) }}</span>
              <i class="chev" aria-hidden="true"></i>
            </button>
            <ul
              v-if="tpOpen === 'bulk'"
              class="db-tp-list"
              :style="tpMenuStyle"
              role="listbox"
              :aria-label="t('dsh.ac.setTo')"
            >
              <li
                v-for="k in TIER_CHOICES"
                :key="k"
                role="option"
                :data-tpv="k"
                :aria-selected="bulkTier === k"
                :class="{ act: bulkTier === k }"
                @click.stop="selectBulkTier(k)"
              >
                <svg v-if="k === 'public'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2.2 2.2 2.2 9.8 0 12M8 2c-2.2 2.2-2.2 9.8 0 12" /></svg>
                <svg v-else-if="k === 'login'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="5.5" r="2.6" /><path d="M3 14c.6-3 2.6-4.6 5-4.6s4.4 1.6 5 4.6" /></svg>
                <svg v-else-if="k === 'groups'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="2.2" /><circle cx="11.3" cy="6.7" r="1.8" /><path d="M1.8 14c.5-2.7 2.1-4.1 4.2-4.1s3.7 1.4 4.2 4.1M10.8 10.2c1.8.1 2.9 1.3 3.4 3.6" /></svg>
                <svg v-else class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
                <b>{{ tierLabel(k) }}</b>
                <svg v-if="bulkTier === k" class="tick" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" /></svg>
                <span v-else></span>
                <small>{{ tierDesc(k) }}</small>
              </li>
            </ul>
          </div>
          <button type="button" class="db-btn sm primary" data-do="bulktier" @click="applyBulkTier">
            {{ t('dsh.ac.applyBulk', { n: selectedCount }) }}
          </button>
        </div>
      </div>

      <div class="db-tw">
        <table class="db-t">
          <thead>
            <tr>
              <th v-if="writable" class="sel"><span class="db-vh">{{ t('dsh.ac.selectAll') }}</span></th>
              <th>{{ t('dsh.ac.colGroup') }}</th>
              <th>{{ t('dsh.ac.colLectures') }}</th>
              <th>{{ t('dsh.ac.colCharts') }}</th>
              <th>{{ t('dsh.ac.colTier') }}</th>
              <th v-if="writable">{{ t('dsh.ac.colStatus') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="g in groups"
              :key="g.id"
              :data-access-group="g.id"
              :class="{ dirty: isRowDirty(g.id) }"
            >
              <td v-if="writable" class="sel" :data-l="t('dsh.ac.selectAll')">
                <label class="db-ck">
                  <input
                    type="checkbox"
                    :data-bsel="g.id"
                    :checked="selectedGroups.has(g.id)"
                    :aria-label="`${g.id} ${g.title}`"
                    @change="toggleSelectGroup(g.id)"
                  />
                </label>
              </td>
              <td :data-l="t('dsh.ac.colGroup')" class="nl"><span class="db-id">{{ g.id }}</span> {{ g.title }}</td>
              <td :data-l="t('dsh.ac.colLectures')" class="n">{{ g.lectureCount ?? 0 }}</td>
              <td :data-l="t('dsh.ac.colCharts')" class="n">{{ g.chartCount ?? 0 }}</td>
              <td :data-l="t('dsh.ac.colTier')">
                <span v-if="!effectiveAccess" class="db-muted">—</span>
                <span v-else-if="!writable" class="db-rov">
                  <span class="db-lock" aria-hidden="true"></span>
                  {{ tierText(draft[g.id]) }}
                  <span v-if="!effectiveAccess.groups.find((x) => x.id === g.id)?.own" class="db-muted"> · {{ t('dsh.ac.byDefault') }}</span>
                </span>
                <div v-else class="db-tp" :data-tier-picker="g.id">
                  <button
                    type="button"
                    class="db-tp-btn"
                    :class="{ dirty: isRowDirty(g.id) }"
                    :data-tpopen="g.id"
                    aria-haspopup="listbox"
                    :aria-expanded="tpOpen === g.id"
                    :aria-label="`${g.id} ${t('dsh.ac.colTier')}: ${tierText(draft[g.id])}`"
                    @click.stop="toggleTp(g.id, $event)"
                  >
                    <svg v-if="tierChoiceOf(draft[g.id]) === 'public'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2.2 2.2 2.2 9.8 0 12M8 2c-2.2 2.2-2.2 9.8 0 12" /></svg>
                    <svg v-else-if="tierChoiceOf(draft[g.id]) === 'login'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="5.5" r="2.6" /><path d="M3 14c.6-3 2.6-4.6 5-4.6s4.4 1.6 5 4.6" /></svg>
                    <svg v-else-if="tierChoiceOf(draft[g.id]) === 'groups'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="2.2" /><circle cx="11.3" cy="6.7" r="1.8" /><path d="M1.8 14c.5-2.7 2.1-4.1 4.2-4.1s3.7 1.4 4.2 4.1M10.8 10.2c1.8.1 2.9 1.3 3.4 3.6" /></svg>
                    <svg v-else class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
                    <span class="tn">{{ tierLabel(tierChoiceOf(draft[g.id])) }}</span>
                    <i class="chev" aria-hidden="true"></i>
                  </button>
                  <ul
                    v-if="tpOpen === g.id"
                    class="db-tp-list"
                    :style="tpMenuStyle"
                    role="listbox"
                    :aria-label="`${g.id} ${t('dsh.ac.colTier')}`"
                  >
                    <li
                      v-for="k in TIER_CHOICES"
                      :key="k"
                      role="option"
                      :data-tpv="k"
                      :aria-selected="tierChoiceOf(draft[g.id]) === k"
                      :class="{ act: tierChoiceOf(draft[g.id]) === k }"
                      @click.stop="selectGroupTier(g.id, k)"
                    >
                      <svg v-if="k === 'public'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2.2 2.2 2.2 9.8 0 12M8 2c-2.2 2.2-2.2 9.8 0 12" /></svg>
                      <svg v-else-if="k === 'login'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="5.5" r="2.6" /><path d="M3 14c.6-3 2.6-4.6 5-4.6s4.4 1.6 5 4.6" /></svg>
                      <svg v-else-if="k === 'groups'" class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="2.2" /><circle cx="11.3" cy="6.7" r="1.8" /><path d="M1.8 14c.5-2.7 2.1-4.1 4.2-4.1s3.7 1.4 4.2 4.1M10.8 10.2c1.8.1 2.9 1.3 3.4 3.6" /></svg>
                      <svg v-else class="db-ti" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
                      <b>{{ tierLabel(k) }}</b>
                      <svg v-if="tierChoiceOf(draft[g.id]) === k" class="tick" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" /></svg>
                      <span v-else></span>
                      <small>{{ tierDesc(k) }}</small>
                    </li>
                  </ul>
                  <div v-if="tierChoiceOf(draft[g.id]) === 'groups'" class="db-ug-edit" data-ug-edit>
                    <input
                      type="text"
                      class="db-ug-in"
                      :value="userGroupsString(g.id)"
                      :placeholder="t('dsh.ac.userGroupsPrompt')"
                      :aria-label="`${g.id} ${t('dsh.ac.userGroupsEdit')}`"
                      @change="updateUserGroups(g.id, ($event.target as HTMLInputElement).value)"
                    />
                  </div>
                </div>
              </td>
              <td v-if="writable" :data-l="t('dsh.ac.colStatus')">
                <span v-if="isRowDirty(g.id)" class="db-warn"><span class="dm" data-k="half" aria-hidden="true"></span>{{ t('dsh.ac.statusPending') }}</span>
                <span v-else class="db-muted">{{ t('dsh.ac.statusNoChange') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="!writable" class="db-pbody db-sep">
        <DbUnavailable id="access-edit" :what="t('dsh.ac.editWhat')" :why="dashboardState.mode === 'online' ? t('dsh.ac.editOnlineWhy') : t('dsh.ac.editWhy')" />
      </div>

      <div v-if="writable && showDiff" class="db-pbody db-sep" data-access-diff-panel>
        <DbDiff
          :before="savedJson"
          :after="draftJson"
          :title="t('dsh.ac.jsonDiffTitle')"
          :file="accessFileRelPath"
        />
      </div>

      <div v-if="writable" class="db-savebar" data-savebar="access">
        <span class="db-st" :class="{ 'db-err': feedbackError }" data-access-feedback>
          {{ feedback || (dirty ? t('dsh.ac.pendingChanges', { n: changedGroups.length }) : t('dsh.common.allSaved')) }}
        </span>
        <button type="button" class="db-btn" :disabled="!dirty" data-access-discard @click="discard">
          {{ t('dsh.common.discard') }}
        </button>
        <button type="button" class="db-btn" :aria-pressed="showDiff" data-access-preview-diff @click="showDiff = !showDiff">
          {{ t('dsh.common.previewChanges') }}
        </button>
        <button type="button" class="db-btn primary" :disabled="!dirty || saving" data-access-save-btn @click="save">
          {{ saving ? t('dsh.common.saving') : t('dsh.ac.applyTiers') }}
        </button>
      </div>
    </section>

    <section v-if="writable" class="db-panel" data-access-impact>
      <header>
        <h3>{{ t('dsh.ac.impactTitle') }}</h3>
        <span class="db-hm">
          {{ changedGroups.length ? t('dsh.ac.pendingChanges', { n: changedGroups.length }) : t('dsh.ac.noPendingChanges') }}
        </span>
      </header>
      <div v-if="changedGroups.length > 0" class="db-pbody">
        <p class="db-warn" data-impact-summary style="margin-bottom: 12px; font-weight: 600;">
          {{ t('dsh.ac.impactSummary', { groups: changedGroups.length, lectures: changedLecturesCount }) }}
        </p>
        <div v-for="g in changedGroups" :key="g.id" class="db-impact" :data-impact-group="g.id">
          <h4>{{ t('dsh.ac.impactGroupRow', { id: g.id, title: g.title, from: tierText(saved[g.id]), to: tierText(draft[g.id]), n: g.lectureCount ?? 0 }) }}</h4>
          <ul>
            <li>{{ t('dsh.ac.impactSummary', { groups: 1, lectures: g.lectureCount ?? 0 }) }}</li>
          </ul>
        </div>
      </div>
      <div v-else class="db-pbody db-muted" data-impact-none>
        {{ t('dsh.ac.impactNoChanges') }}
      </div>
    </section>

    <section class="db-panel" data-access-rules>
      <header>
        <h3>{{ t('dsh.ac.rulesTitle') }}</h3>
        <span class="db-hm">
          <code>npm run auth:export</code>
          <button v-if="currentAutheliaPreview" type="button" class="db-btn sm" @click="copyRules">
            {{ copied ? t('dsh.ac.copied') : t('dsh.ac.copy') }}
          </button>
        </span>
      </header>
      <div v-if="currentAutheliaPreview" class="db-pbody">
        <div v-if="writable && rulesDiffDirty" class="db-pbody" style="padding: 0 0 14px 0;" data-access-rules-diff>
          <DbDiff
            :before="savedAutheliaRules"
            :after="draftAutheliaRules"
            :title="t('dsh.ac.rulesDiffTitle')"
            file="authelia/access_control.yml"
          />
        </div>
        <pre class="db-codeb" data-access-preview>{{ currentAutheliaPreview }}</pre>
      </div>
      <div v-else-if="currentRulesNote" class="db-pbody" data-access-rules-note :data-note="currentRulesNote.code">
        <p v-if="currentRulesNote.code === 'no_domain'">{{ t('dsh.ac.rulesNoDomain') }}</p>
        <template v-else>
          <p>{{ t('dsh.ac.rulesError') }}</p>
          <pre class="db-codeb db-wrap">{{ currentRulesNote.detail }}</pre>
        </template>
        <p class="db-muted"><code>SITE_URL=https://docs.example.org</code> · <code>npm run auth:export authelia -- --domain docs.example.org</code></p>
      </div>
      <DbUnavailable v-else id="access-rules" :what="t('dsh.ac.rulesTitle')" :why="t('dsh.ac.rulesOnlineWhy')" />
    </section>
  </div>
</template>
