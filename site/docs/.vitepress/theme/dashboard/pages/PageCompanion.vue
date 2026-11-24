<script setup lang="ts">
/**
 * PageCompanion.vue — 伴读: system prompt, quick actions, version history and usage / limits (prototype v3.1, AI plan §7.1).
 *
 * Two layers: what the owner edits here (prompts/companion.json) and the locked feature contracts (site/ai-contracts/*.json,
 * read-only in every mode). Restoring a default or an earlier version shows the diff first and is written as a new version
 * (a commit when the content folder is its own git repository). Online everything is read-only.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import type { MessageKey } from '../../../i18n/index.ts'
import {
  PROMPT_LIMITS,
  validateCompanionPrompts,
  type CompanionPromptsFile,
  type QuickActionSpec,
} from '../../../prompts/companion.ts'
import type { AiFeatureContract } from '../../../prompts/contracts.ts'
import { companionPromptsRef } from '../../../prompts/store.ts'
import { fetchDevCompanionPrompts } from '../../api/admin'
import {
  fetchPromptsAt,
  fetchPromptsHistory,
  fetchRuntime,
  savePromptsWithMessage,
  type HistoryPayload,
  type RuntimePayload,
} from '../../api/devDashboard'
import DbDiff from '../DbDiff.vue'
import DbHead from '../DbHead.vue'
import DbTabs from '../DbTabs.vue'
import DbUnavailable from '../DbUnavailable.vue'
import PlaceholderEditor from '../PlaceholderEditor.vue'
import CompanionTools from './CompanionTools.vue'
import { PLACEHOLDER_SETS, fillTemplate, moveItem, usedTokens } from '../placeholders'
import { READER_LIMIT_DEFAULTS, shortDateTime } from '../dashboardData'
import { ask, dashboardState, isReadOnly, registerModel, say, tabOf, touchModels, type DashboardPageId } from '../useDashboard'

const emit = defineEmits<{ tab: [tab: string]; go: [page: DashboardPageId, tab?: string] }>()
const { t } = useT()

type Lang = 'zh' | 'en'
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const pretty = (p: CompanionPromptsFile | QuickActionSpec | null): string => (p ? JSON.stringify(p, null, 2) : '')
const noVersion = (p: CompanionPromptsFile) => ({ system: p.system, actions: p.actions })

const saved = ref<CompanionPromptsFile>(clone(companionPromptsRef.value))
const draft = ref<CompanionPromptsFile>(clone(companionPromptsRef.value))
const defaults = ref<CompanionPromptsFile | null>(null)
const filePath = ref('')
const sysLang = ref<Lang>('zh')
const openActions = reactive(new Set<string>())
const actionLang = reactive<Record<string, Lang>>({})
const previewOn = reactive(new Set<string>())
const confirmDelete = ref<string | null>(null)
const saving = ref(false)
const status = ref('')
const statusError = ref(false)
const history = ref<HistoryPayload | null>(null)
const historyOpen = ref<string | null>(null)
const historyDiff = ref<{ before: string; after: string } | null>(null)
const runtime = ref<RuntimePayload | null>(null)
const showDiff = ref(false)

const shown = computed(() => (isReadOnly.value ? companionPromptsRef.value : draft.value))
const dirty = computed(() => JSON.stringify(noVersion(draft.value)) !== JSON.stringify(noVersion(saved.value)))
const validation = computed(() => validateCompanionPrompts(draft.value))
const errors = computed(() => (validation.value.ok ? [] : validation.value.errors))

// ── contracts: engine files, bundled read-only ──
const contractModules = import.meta.glob<{ default: AiFeatureContract }>('../../../../../ai-contracts/*.json', { eager: true })
const contracts = computed(() => Object.values(contractModules).map((m) => m.default).filter((c) => c && typeof c.id === 'string'))
const contractOpen = ref<string | null>(null)
const contractTab = ref<'zh' | 'en' | 'schema'>('zh')

const SAMPLES = computed<Record<string, string>>(() => ({
  lecture: t('dsh.cp.sampleLecture'),
  group: t('dsh.cp.sampleGroup'),
  outline: t('dsh.cp.sampleOutline'),
  selection: t('dsh.cp.sampleSelection'),
}))

function touch(): void {
  status.value = ''
  touchModels()
}

function setSystem(lang: Lang, v: string): void {
  draft.value.system[lang] = v
  touch()
}

const defaultAction = (a: QuickActionSpec) => defaults.value?.actions.find((x) => x.id === a.id) ?? null
function actionState(a: QuickActionSpec): 'diff' | 'same' | 'none' {
  const d = defaultAction(a)
  if (!d) return 'none'
  return JSON.stringify(d) === JSON.stringify(a) ? 'same' : 'diff'
}

function selectionWarnings(a: QuickActionSpec, lang: Lang): string[] {
  const uses = usedTokens(a.template[lang], PLACEHOLDER_SETS.prompts).includes('selection')
  if (uses && !a.needsSelection) return [t('dsh.cp.warnUsesSelection')]
  if (!uses && a.needsSelection) return [t('dsh.cp.warnNeedsSelection')]
  return []
}

function shortTemplate(a: QuickActionSpec): string {
  return a.template.zh.replace(/\{([a-z]+)\}/g, (m, n: string) => (n in SAMPLES.value ? `[${n}]` : m)).replace(/\n/g, ' ').slice(0, 80)
}

const LIMIT_LABELS: Record<string, MessageKey> = {
  AI_DAILY_LIMIT: 'dsh.cp.limitDaily',
  AI_RATE_PER_MINUTE: 'dsh.cp.limitRate',
  AI_MAX_CONCURRENT: 'dsh.cp.limitConcurrent',
}
const limitLabel = (key: string): string => (LIMIT_LABELS[key] ? t(LIMIT_LABELS[key] as MessageKey) : key)

function move(i: number, d: -1 | 1): void {
  const to = i + d
  if (to < 0 || to >= draft.value.actions.length) return
  draft.value.actions = moveItem(draft.value.actions, i, to)
  touch()
  say(t('dsh.cp.moved', { name: draft.value.actions[to]?.label.zh ?? '', n: to + 1 }))
}

function onHandleKey(e: KeyboardEvent, i: number): void {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault()
    move(i, e.key === 'ArrowUp' ? -1 : 1)
    const target = e.key === 'ArrowUp' ? i - 1 : i + 1
    setTimeout(() => document.querySelector<HTMLElement>(`[data-qa-handle="${target}"]`)?.focus(), 0)
  }
}

let dragFrom = -1
function onDragStart(e: DragEvent, i: number): void {
  dragFrom = i
  e.dataTransfer?.setData('text/plain', String(i))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onDrop(e: DragEvent, i: number): void {
  e.preventDefault()
  const from = dragFrom >= 0 ? dragFrom : Number(e.dataTransfer?.getData('text/plain') ?? -1)
  dragFrom = -1
  if (from < 0 || from === i) return
  draft.value.actions = moveItem(draft.value.actions, from, i)
  touch()
}

function toggleSurface(a: QuickActionSpec, s: 'panel' | 'menu', on: boolean): void {
  a.surfaces = on ? [...new Set([...a.surfaces, s])].sort() as QuickActionSpec['surfaces'] : a.surfaces.filter((x) => x !== s)
  touch()
}

function newActionId(): string {
  let n = draft.value.actions.length + 1
  while (draft.value.actions.some((a) => a.id === `action-${n}`)) n++
  return `action-${n}`
}
function addAction(): void {
  if (draft.value.actions.length >= PROMPT_LIMITS.maxActions) return
  const id = newActionId()
  draft.value.actions.push({ id, label: { zh: '', en: '' }, template: { zh: '{lecture}', en: '{lecture}' }, needsSelection: false, surfaces: ['panel'], enabled: false })
  openActions.add(id)
  touch()
  // the prototype puts the focus into the new action's name (audit #30)
  const at = draft.value.actions.length - 1
  void nextTick(() => document.querySelector<HTMLElement>(`[data-qa-label="${at}.zh"]`)?.focus())
}
function duplicate(i: number): void {
  if (draft.value.actions.length >= PROMPT_LIMITS.maxActions) return
  const copy = clone(draft.value.actions[i] as QuickActionSpec)
  copy.id = newActionId()
  draft.value.actions.splice(i + 1, 0, copy)
  openActions.add(copy.id)
  touch()
}
function remove(i: number): void {
  draft.value.actions.splice(i, 1)
  confirmDelete.value = null
  touch()
}

async function writeVersion(next: CompanionPromptsFile, message: string): Promise<boolean> {
  if (!dashboardState.token) return false
  const checked = validateCompanionPrompts(next)
  if (!checked.ok) {
    status.value = checked.errors.join('; ')
    statusError.value = true
    return false
  }
  saving.value = true
  try {
    const res = await savePromptsWithMessage(dashboardState.token, next, message)
    if (!res.ok || !res.prompts) {
      status.value = t('dsh.cp.saveErr', { error: res.errors?.join('; ') || res.error || 'unknown' })
      statusError.value = true
      return false
    }
    saved.value = clone(res.prompts)
    companionPromptsRef.value = clone(res.prompts)
    const commitText = res.commit?.committed
      ? t('dsh.cp.committed', { hash: res.commit.hash ?? '' })
      : res.commit?.reason === 'not_own_repo'
        ? t('dsh.cp.notCommittedNotOwn')
        : t('dsh.cp.notCommitted', { reason: res.commit?.reason ?? '' })
    status.value = `${t('dsh.cp.savedVersion', { v: res.prompts.version })} ${commitText}`
    statusError.value = false
    say(status.value)
    void loadHistory()
    touchModels()
    return true
  } finally {
    saving.value = false
  }
}

async function save(): Promise<boolean> {
  if (!dirty.value || errors.value.length) return false
  const ok = await writeVersion(clone(draft.value), t('dsh.cp.msgSave'))
  if (ok) draft.value = clone(saved.value)
  return ok
}
function discard(): void {
  draft.value = clone(saved.value)
  showDiff.value = false
  touch()
}

async function restoreSystem(lang: Lang): Promise<void> {
  const def = defaults.value
  if (!def) return
  const r = await ask({
    title: t('dsh.cp.restoreSysTitle', { lang: lang === 'zh' ? t('dsh.common.zh') : 'English' }),
    intro: t('dsh.cp.restoreSysIntro'),
    diff: { before: saved.value.system[lang], after: def.system[lang], file: `system.${lang}`, note: t('dsh.cp.afterVersion', { v: saved.value.version + 1 }) },
    facts: [[t('dsh.cp.writeAs'), t('dsh.cp.writeAsValue')]],
    ...(dirty.value ? { warning: t('dsh.cp.otherDraftsKept') } : {}),
    buttons: [{ value: 'no', label: t('dsh.common.cancel') }, { value: 'ok', label: t('dsh.cp.restoreConfirm'), kind: 'primary' }],
  })
  if (r !== 'ok') return
  const next = clone(saved.value)
  next.system[lang] = def.system[lang]
  if (await writeVersion(next, t('dsh.cp.msgRestoreSys', { lang }))) draft.value.system[lang] = def.system[lang]
}

async function restoreAction(i: number): Promise<void> {
  const cur = draft.value.actions[i]
  const def = cur ? defaultAction(cur) : null
  if (!cur || !def) return
  const savedCur = saved.value.actions.find((a) => a.id === cur.id) ?? cur
  const r = await ask({
    title: t('dsh.cp.restoreActTitle', { name: cur.label.zh || cur.id }),
    intro: t('dsh.cp.restoreActIntro'),
    diff: { before: pretty(savedCur), after: pretty(def), file: `actions[${cur.id}]` },
    buttons: [{ value: 'no', label: t('dsh.common.cancel') }, { value: 'ok', label: t('dsh.cp.restoreConfirm'), kind: 'primary' }],
  })
  if (r !== 'ok') return
  const next = clone(saved.value)
  const at = next.actions.findIndex((a) => a.id === cur.id)
  if (at >= 0) next.actions[at] = clone(def)
  else next.actions.push(clone(def))
  if (await writeVersion(next, t('dsh.cp.msgRestoreAct', { id: cur.id }))) draft.value.actions[i] = clone(def)
}

async function restoreFile(kind: 'default' | 'previous'): Promise<void> {
  let target: CompanionPromptsFile | null = null
  let label = ''
  if (kind === 'default') {
    target = defaults.value
    label = t('dsh.cp.toDefault')
  } else {
    const prev = history.value?.commits[1]
    if (!prev) return
    const at = await fetchPromptsAt(dashboardState.token, prev.hash)
    target = at && at !== 'missing' ? at.prompts : null
    label = t('dsh.cp.toPrevious', { hash: prev.short })
  }
  if (!target) return
  const r = await ask({
    title: kind === 'default' ? t('dsh.cp.restoreFileTitle') : t('dsh.cp.restorePrevTitle', { hash: history.value?.commits[1]?.short ?? '' }),
    intro: kind === 'default' ? t('dsh.cp.restoreFileIntro') : t('dsh.cp.restorePrevIntro'),
    diff: { before: JSON.stringify(noVersion(saved.value), null, 2), after: JSON.stringify(noVersion(target), null, 2), file: filePath.value, note: t('dsh.cp.afterVersion', { v: saved.value.version + 1 }) },
    ...(dirty.value ? { warning: t('dsh.cp.draftDropped') } : {}),
    buttons: [{ value: 'no', label: t('dsh.common.cancel') }, { value: 'ok', label: t('dsh.cp.restoreConfirm'), kind: 'primary' }],
  })
  if (r !== 'ok') return
  const next = { ...clone(target), version: saved.value.version }
  if (await writeVersion(next, t('dsh.cp.msgRestoreFile', { what: label }))) draft.value = clone(saved.value)
}

async function loadHistory(): Promise<void> {
  if (dashboardState.mode !== 'dev') return
  history.value = await fetchPromptsHistory()
}

async function toggleHistory(hash: string): Promise<void> {
  if (historyOpen.value === hash) {
    historyOpen.value = null
    historyDiff.value = null
    return
  }
  historyOpen.value = hash
  historyDiff.value = null
  const [cur, parent] = await Promise.all([fetchPromptsAt(dashboardState.token, hash), fetchPromptsAt(dashboardState.token, `${hash}^`)])
  historyDiff.value = {
    before: parent && parent !== 'missing' ? parent.text : '',
    after: cur && cur !== 'missing' ? cur.text : '',
  }
}

async function loadAsDraft(hash: string, short: string): Promise<void> {
  const at = await fetchPromptsAt(dashboardState.token, hash)
  if (!at || at === 'missing' || !at.prompts) return
  draft.value = { ...clone(at.prompts), version: saved.value.version }
  touch()
  emit('tab', 'prompt')
  say(t('dsh.cp.loadedDraft', { hash: short }))
}

let unregister: (() => void) | null = null
onMounted(async () => {
  unregister = registerModel('prompts', { page: 'companion', dirty: () => dirty.value, save, discard })
  if (dashboardState.mode !== 'dev') return
  const loaded = await fetchDevCompanionPrompts()
  if (loaded) {
    saved.value = clone(loaded.prompts)
    draft.value = clone(loaded.prompts)
    filePath.value = loaded.filePath
    defaults.value = (loaded as unknown as { defaults?: CompanionPromptsFile }).defaults ?? null
    touchModels()
  }
  void loadHistory()
  runtime.value = await fetchRuntime()
})
onBeforeUnmount(() => unregister?.())
watch(
  () => tabOf('companion'),
  (tab) => {
    if (tab === 'history' && !history.value) void loadHistory()
  },
)

const sysSame = (lang: Lang) => !!defaults.value && defaults.value.system[lang] === saved.value.system[lang]
const fileIsDefault = computed(() => !!defaults.value && JSON.stringify(noVersion(defaults.value)) === JSON.stringify(noVersion(saved.value)))
const meta = computed<Array<[string, string]>>(() => [
  [t('dsh.common.file'), filePath.value || 'prompts/companion.json'],
  [t('dsh.common.version'), `v${shown.value.version}`],
])
</script>

<template>
  <div class="db-page" data-page="companion">
    <DbHead :title="t('dsh.nav.companion')" :lead="t('dsh.cp.lead')" :meta="meta" />
    <DbTabs
      page="companion"
      :label="t('dsh.nav.companion')"
      :items="[
        ['prompt', t('dsh.cp.tabPrompt')],
        ['actions', t('dsh.cp.tabActions')],
        ['history', t('dsh.cp.tabHistory')],
        ['usage', t('dsh.cp.tabUsage')],
        ['tools', t('dsh.cp.tabTools')],
      ]"
      :dirty-tabs="['prompt', 'actions']"
      @select="emit('tab', $event)"
    />

    <CompanionTools v-show="tabOf('companion') === 'tools'" @go="(p, tab) => emit('go', p, tab)" />

    <!-- system prompt + contracts + restore -->
    <template v-if="tabOf('companion') === 'prompt'">
      <section class="db-panel" data-companion-system>
        <header><h3>{{ t('dsh.cp.systemTitle') }}</h3><span class="db-hm">{{ t('dsh.cp.systemHint') }}</span></header>
        <div class="db-pbody db-grid">
          <div class="db-tabs in" role="tablist" :aria-label="t('dsh.cp.systemLang')">
            <button v-for="l in (['zh', 'en'] as const)" :key="l" type="button" role="tab" :aria-selected="sysLang === l" :data-companion-syslang="l" @click="sysLang = l">{{ l === 'zh' ? t('dsh.common.zh') : 'English' }}</button>
          </div>
          <div class="db-fld" :class="{ dirty: !isReadOnly && draft.system[sysLang] !== saved.system[sysLang] }">
            <PlaceholderEditor
              :id="`db-sys-${sysLang}`"
              :key="sysLang"
              :model-value="shown.system[sysLang]"
              :names="PLACEHOLDER_SETS.prompts"
              :label="t('dsh.cp.systemLabel', { lang: sysLang })"
              :max="PROMPT_LIMITS.maxSystemChars"
              :readonly="isReadOnly"
              required
              @update:model-value="setSystem(sysLang, $event)"
            />
          </div>
          <div v-if="!isReadOnly" class="db-bar-r">
            <button type="button" class="db-btn sm" :disabled="!defaults || sysSame(sysLang)" data-companion-restore-sys @click="restoreSystem(sysLang)">
              {{ !defaults ? t('dsh.cp.noDefault') : sysSame(sysLang) ? t('dsh.cp.isDefault') : t('dsh.cp.restoreSys') }}
            </button>
            <span class="db-muted">{{ sysSame(sysLang) ? t('dsh.cp.sameAsDefault') : t('dsh.cp.diffFromDefault') }}</span>
          </div>
        </div>
      </section>

      <section class="db-panel" data-companion-contracts>
        <header><h3>{{ t('dsh.cp.contractsTitle') }}</h3><span class="db-hm">{{ t('dsh.cp.contractsHint') }}</span></header>
        <div class="db-pbody"><p>{{ t('dsh.cp.contractsLead') }}</p></div>
        <div v-for="c in contracts" :key="c.id" class="db-ct" :data-companion-contract="c.id">
          <span class="db-lock" aria-hidden="true"></span>
          <div>
            <div class="db-cn">{{ c.purpose.zh }} <code class="db-tok">{{ c.id }}</code> <code class="db-tok">v{{ c.version }}</code></div>
            <div class="db-cd">{{ t('dsh.cp.contractLine', { n: c.instructions.zh.length }) }}</div>
          </div>
          <button type="button" class="db-btn sm" :aria-expanded="contractOpen === c.id" @click="contractOpen = contractOpen === c.id ? null : c.id">{{ contractOpen === c.id ? t('dsh.common.collapse') : t('dsh.cp.viewContract') }}</button>
          <div v-if="contractOpen === c.id" class="db-cv">
            <div class="db-lockline" role="note"><span class="db-lock" aria-hidden="true"></span><span>{{ t('dsh.cp.contractReadOnly') }}</span></div>
            <div class="db-tabs in" role="tablist" :aria-label="c.id">
              <button type="button" role="tab" :aria-selected="contractTab === 'zh'" @click="contractTab = 'zh'">{{ t('dsh.cp.fixedZh') }}</button>
              <button type="button" role="tab" :aria-selected="contractTab === 'en'" @click="contractTab = 'en'">{{ t('dsh.cp.fixedEn') }}</button>
              <button type="button" role="tab" :aria-selected="contractTab === 'schema'" @click="contractTab = 'schema'">{{ t('dsh.cp.outputFormat') }}</button>
            </div>
            <pre class="db-codeb db-wrap" tabindex="0">{{ contractTab === 'schema' ? JSON.stringify(c.schema, null, 2) : c.instructions[contractTab].map((l, i) => `${i + 1}. ${l}`).join('\n') }}</pre>
          </div>
        </div>
        <div v-if="!contracts.length" class="db-empty"><span>{{ t('dsh.cp.noContracts') }}</span></div>
      </section>

      <section v-if="!isReadOnly" class="db-panel" data-companion-restore>
        <header><h3>{{ t('dsh.cp.restoreTitle') }}</h3><span class="db-hm">{{ t('dsh.cp.restoreHint') }}</span></header>
        <div class="db-pbody db-grid">
          <p>{{ t('dsh.cp.restoreLead') }}</p>
          <div class="db-btns">
            <button type="button" class="db-btn" :disabled="!defaults || fileIsDefault" data-companion-restore-file @click="restoreFile('default')">{{ t('dsh.cp.restoreFile') }}</button>
            <button type="button" class="db-btn" :disabled="!history || history.commits.length < 2" data-companion-restore-prev @click="restoreFile('previous')">
              {{ history && history.commits[1] ? t('dsh.cp.restorePrevWith', { hash: history.commits[1].short }) : t('dsh.cp.restorePrev') }}
            </button>
            <span v-if="fileIsDefault" class="db-muted">{{ t('dsh.cp.fileIsDefault') }}</span>
          </div>
        </div>
      </section>
    </template>

    <!-- quick actions -->
    <section v-else-if="tabOf('companion') === 'actions'" class="db-panel" data-companion-actions>
      <header><h3>{{ t('dsh.cp.actionsTitle') }}</h3><span class="db-hm">{{ t('dsh.cp.actionsHint', { n: shown.actions.length, max: PROMPT_LIMITS.maxActions }) }}</span></header>
      <div class="db-qa-list">
        <div v-for="(a, i) in shown.actions" :key="a.id" class="db-qa" :class="{ off: !a.enabled }" :data-qa="a.id" @dragover.prevent @drop="onDrop($event, i)">
          <div class="db-qa-sum">
            <button
              v-if="!isReadOnly"
              type="button"
              class="db-icon db-handle"
              draggable="true"
              :data-qa-handle="i"
              :aria-label="t('dsh.cp.handle', { name: a.label.zh || a.id, n: i + 1 })"
              @dragstart="onDragStart($event, i)"
              @keydown="onHandleKey($event, i)"
            ><span class="db-grip" aria-hidden="true"></span></button>
            <div class="db-qa-name">
              <span><span class="db-no">{{ i + 1 }}</span><b>{{ a.label.zh || t('dsh.cp.unnamed') }}</b></span>
              <small>{{ a.label.en || '—' }}: {{ shortTemplate(a) }}</small>
            </div>
            <div class="db-qa-tags">
              <span v-if="a.surfaces.includes('panel')" class="db-tag">{{ t('dsh.cp.surfacePanel') }}</span>
              <span v-if="a.surfaces.includes('menu')" class="db-tag">{{ t('dsh.cp.surfaceMenu') }}</span>
              <span v-if="!a.surfaces.length" class="db-warn"><span class="dm" data-k="warn" aria-hidden="true"></span>{{ t('dsh.cp.nowhere') }}</span>
              <span v-if="a.needsSelection" class="db-tag">{{ t('dsh.cp.needsSelection') }}</span>
            </div>
            <span class="db-qa-uses" :title="t('dsh.cp.usesUnavailable')">{{ t('dsh.cp.uses7d') }}</span>
            <span class="db-qa-more">
              <span v-if="isReadOnly" class="db-rov"><span class="db-lock" aria-hidden="true"></span>{{ a.enabled ? t('dsh.common.enabled') : t('dsh.common.disabled') }}</span>
              <template v-else>
                <button type="button" class="db-sw" role="switch" :aria-checked="a.enabled" :aria-label="t('dsh.cp.enableLabel', { name: a.label.zh || a.id })" :data-qa-enable="i" @click="a.enabled = !a.enabled; touch()"><i></i>{{ a.enabled ? t('dsh.common.enabled') : t('dsh.common.disabled') }}</button>
                <button type="button" class="db-icon" :aria-expanded="openActions.has(a.id)" :aria-label="t('dsh.cp.editLabel', { name: a.label.zh || a.id })" :data-qa-open="i" @click="openActions.has(a.id) ? openActions.delete(a.id) : openActions.add(a.id)"><span class="db-chev" aria-hidden="true"></span></button>
              </template>
            </span>
          </div>
          <div v-if="!isReadOnly && openActions.has(a.id)" class="db-qa-ed">
            <div class="db-frow">
              <div class="db-fl">{{ t('dsh.cp.name') }}<small>{{ t('dsh.cp.nameHint', { max: PROMPT_LIMITS.maxActionLabelChars }) }}</small></div>
              <div class="db-two">
                <input class="db-in" :value="a.label.zh" :maxlength="PROMPT_LIMITS.maxActionLabelChars" :aria-label="t('dsh.cp.nameZh')" :placeholder="t('dsh.cp.nameExample')" :data-qa-label="`${i}.zh`" @input="a.label.zh = ($event.target as HTMLInputElement).value; touch()" />
                <input class="db-in" :value="a.label.en" :maxlength="PROMPT_LIMITS.maxActionLabelChars" aria-label="Name, English" placeholder="e.g. Explain this passage" :data-qa-label="`${i}.en`" @input="a.label.en = ($event.target as HTMLInputElement).value; touch()" />
              </div>
            </div>
            <div class="db-frow">
              <div class="db-fl">{{ t('dsh.cp.template') }}<small>{{ t('dsh.cp.templateHint') }}</small></div>
              <div>
                <div class="db-tabs in" role="tablist" :aria-label="t('dsh.cp.templateLang')">
                  <button v-for="l in (['zh', 'en'] as const)" :key="l" type="button" role="tab" :aria-selected="(actionLang[a.id] ?? 'zh') === l" @click="actionLang[a.id] = l">{{ l === 'zh' ? t('dsh.common.zh') : 'English' }}</button>
                </div>
                <PlaceholderEditor
                  :id="`db-qa-${a.id}-${actionLang[a.id] ?? 'zh'}`"
                  :key="`${a.id}-${actionLang[a.id] ?? 'zh'}`"
                  :model-value="a.template[actionLang[a.id] ?? 'zh']"
                  :names="PLACEHOLDER_SETS.prompts"
                  :label="t('dsh.cp.template')"
                  :max="PROMPT_LIMITS.maxActionTemplateChars"
                  :warnings="selectionWarnings(a, actionLang[a.id] ?? 'zh')"
                  required
                  small
                  @update:model-value="a.template[actionLang[a.id] ?? 'zh'] = $event; touch()"
                />
              </div>
            </div>
            <div class="db-frow">
              <div class="db-fl">{{ t('dsh.cp.surfaces') }}<small>{{ t('dsh.cp.surfacesHint') }}</small></div>
              <div class="db-opts" role="group" :aria-label="t('dsh.cp.surfaces')">
                <label class="db-ck"><input type="checkbox" :checked="a.surfaces.includes('panel')" @change="toggleSurface(a, 'panel', ($event.target as HTMLInputElement).checked)" />{{ t('dsh.cp.surfacePanel') }}</label>
                <label class="db-ck"><input type="checkbox" :checked="a.surfaces.includes('menu')" @change="toggleSurface(a, 'menu', ($event.target as HTMLInputElement).checked)" />{{ t('dsh.cp.surfaceMenu') }}</label>
              </div>
            </div>
            <div class="db-frow">
              <div class="db-fl">{{ t('dsh.cp.needsSelection') }}<small>{{ a.needsSelection ? t('dsh.cp.needsSelOn') : t('dsh.cp.needsSelOff') }}</small></div>
              <div><button type="button" class="db-sw" role="switch" :aria-checked="a.needsSelection" @click="a.needsSelection = !a.needsSelection; touch()"><i></i>{{ a.needsSelection ? t('dsh.cp.needed') : t('dsh.cp.notNeeded') }}</button></div>
            </div>
            <div v-if="previewOn.has(a.id)" class="db-frow">
              <div class="db-fl">{{ t('dsh.cp.assemble') }}<small>{{ t('dsh.cp.assembleHint') }}</small></div>
              <pre class="db-asm" :data-qa-assembled="a.id"><span class="h">── system ──</span>
{{ fillTemplate(draft.system[actionLang[a.id] ?? 'zh'], SAMPLES) }}

<span class="h">── user ──</span>
{{ fillTemplate(a.template[actionLang[a.id] ?? 'zh'], SAMPLES) }}</pre>
            </div>
            <div class="db-qa-foot">
              <span class="db-sp"><button type="button" class="db-btn sm" :aria-pressed="previewOn.has(a.id)" :data-qa-preview="i" @click="previewOn.has(a.id) ? previewOn.delete(a.id) : previewOn.add(a.id)">{{ previewOn.has(a.id) ? t('dsh.cp.assembleHide') : t('dsh.cp.assembleShow') }}</button></span>
              <button type="button" class="db-btn sm" :disabled="draft.actions.length >= PROMPT_LIMITS.maxActions" @click="duplicate(i)">{{ t('dsh.cp.duplicate') }}</button>
              <button type="button" class="db-btn sm" :disabled="actionState(a) !== 'diff'" @click="restoreAction(i)">{{ actionState(a) === 'diff' ? t('dsh.cp.restoreDefault') : actionState(a) === 'same' ? t('dsh.cp.isDefault') : t('dsh.cp.noDefault') }}</button>
              <template v-if="confirmDelete === a.id">
                <span class="db-muted db-small">{{ t('dsh.cp.deleteConfirm') }}</span>
                <button type="button" class="db-btn sm danger" :data-qa-delete-ok="i" @click="remove(i)">{{ t('dsh.common.delete') }}</button>
                <button type="button" class="db-btn sm" @click="confirmDelete = null">{{ t('dsh.common.cancel') }}</button>
              </template>
              <button v-else type="button" class="db-btn sm danger" :disabled="draft.actions.length <= PROMPT_LIMITS.minActions" :data-qa-delete="i" @click="confirmDelete = a.id">{{ t('dsh.common.delete') }}</button>
            </div>
          </div>
        </div>
      </div>
      <div v-if="!isReadOnly" class="db-pbody db-sep db-btns">
        <button type="button" class="db-btn" :disabled="draft.actions.length >= PROMPT_LIMITS.maxActions" data-qa-add @click="addAction">{{ t('dsh.cp.addAction') }}</button>
        <span class="db-muted db-small">{{ draft.actions.length >= PROMPT_LIMITS.maxActions ? t('dsh.cp.maxReached', { max: PROMPT_LIMITS.maxActions }) : t('dsh.cp.newDisabled') }}</span>
      </div>
      <div class="db-pbody db-sep"><DbUnavailable id="action-uses" :what="t('dsh.cp.uses7dWhat')" :why="t('dsh.cp.usesWhy')" /></div>
    </section>

    <!-- history -->
    <section v-else-if="tabOf('companion') === 'history'" class="db-panel" data-companion-history>
      <header><h3>{{ t('dsh.cp.historyTitle') }}</h3><span class="db-hm">{{ isReadOnly ? '' : t('dsh.cp.historyHint', { n: history?.commits.length ?? 0 }) }}</span></header>
      <DbUnavailable v-if="isReadOnly" id="history" :what="t('dsh.cp.historyTitle')" :why="t('dsh.cp.historyOnlineWhy')" />
      <template v-else>
        <div v-if="history && !history.ownRepo" class="db-pbody db-muted" data-companion-history-mixed>{{ t('dsh.cp.historyMixed') }}</div>
        <div v-if="history && history.commits.length" class="db-tw">
          <table class="db-t">
            <thead><tr><th>{{ t('dsh.common.time') }}</th><th>{{ t('dsh.cp.commit') }}</th><th>{{ t('dsh.cp.author') }}</th><th>{{ t('dsh.cp.message') }}</th><th></th></tr></thead>
            <tbody>
              <template v-for="(c, i) in history.commits" :key="c.hash">
                <tr :class="{ cur: i === 0 }" :data-companion-commit="c.short">
                  <td :data-l="t('dsh.common.time')" class="db-mono">{{ shortDateTime(c.date) }}</td>
                  <td :data-l="t('dsh.cp.commit')"><code>{{ c.short }}</code> <span v-if="i === 0" class="db-tag">{{ t('dsh.cp.current') }}</span></td>
                  <td :data-l="t('dsh.cp.author')">{{ c.author }}</td>
                  <td :data-l="t('dsh.cp.message')">{{ c.subject }}</td>
                  <td class="n">
                    <button type="button" class="db-btn sm" :aria-expanded="historyOpen === c.hash" data-companion-history-diff @click="toggleHistory(c.hash)">{{ historyOpen === c.hash ? t('dsh.cp.hideDiff') : t('dsh.cp.showDiff') }}</button>
                    <button v-if="i > 0" type="button" class="db-btn sm" data-companion-history-load @click="loadAsDraft(c.hash, c.short)">{{ t('dsh.cp.loadDraft') }}</button>
                  </td>
                </tr>
                <tr v-if="historyOpen === c.hash" class="sub">
                  <td colspan="5">
                    <span v-if="!historyDiff" class="db-muted">{{ t('dsh.common.loading') }}</span>
                    <DbDiff v-else :before="historyDiff.before" :after="historyDiff.after" :title="t('dsh.cp.commitDiff', { hash: c.short })" :file="filePath" :note="historyDiff.before ? '' : t('dsh.cp.firstCommit')" />
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <div v-else class="db-empty"><span>{{ history ? t('dsh.cp.historyNone') : t('dsh.common.loading') }}</span></div>
      </template>
    </section>

    <!-- usage and limits -->
    <template v-else-if="tabOf('companion') === 'usage'">
      <DbUnavailable id="usage" :what="t('dsh.cp.usageWhat')" :why="t('dsh.cp.usageWhy')" />
      <section class="db-panel" data-companion-cost>
        <header><h3>{{ t('dsh.cp.costTitle') }}</h3><span class="db-hm">{{ t('dsh.cp.costHint') }}</span></header>
        <div class="db-pbody"><p>{{ t('dsh.cp.costLead') }}</p></div>
      </section>
      <section class="db-panel" data-companion-limits>
        <header><h3>{{ t('dsh.cp.limitsTitle') }}</h3><span class="db-hm">{{ t('dsh.cp.limitsHint') }}</span></header>
        <DbUnavailable v-if="isReadOnly" id="limits" :what="t('dsh.cp.limitsTitle')" :why="t('dsh.cp.limitsOnlineWhy')" />
        <template v-else>
          <div v-for="l in runtime?.limits.limits ?? []" :key="l.key" class="db-frow one" :data-companion-limit="l.key">
            <div class="db-fl">{{ limitLabel(l.key) }}<small><code>{{ l.key }}</code> · {{ l.min }}–{{ l.max }}</small></div>
            <div class="db-rov"><span class="db-lock" aria-hidden="true"></span><span>{{ l.value }} · {{ l.source === 'default' ? t('dsh.cp.limitDefault') : 'server/.env' }}</span></div>
          </div>
          <div class="db-pbody db-sep db-muted">{{ t('dsh.cp.limitsReadOnly') }}</div>
        </template>
        <div v-if="isReadOnly || !(runtime?.limits.limits.length)" class="db-pbody db-sep" data-companion-limits-source>
          <p>{{ t('dsh.cp.limitsSourceLead') }}</p>
          <dl class="db-kv">
            <template v-for="l in READER_LIMIT_DEFAULTS" :key="l.key">
              <dt>{{ limitLabel(l.key) }}</dt>
              <dd><code>{{ l.key }}</code> · {{ t('dsh.cp.limitsSourceLine', { def: l.def, min: l.min, max: l.max }) }}</dd>
            </template>
          </dl>
          <p class="db-muted">{{ t('dsh.cp.limitsHowTo') }}</p>
        </div>
      </section>
    </template>

    <div v-if="!isReadOnly && tabOf('companion') !== 'tools' && (tabOf('companion') === 'prompt' || tabOf('companion') === 'actions' || dirty)" class="db-panel">
      <div v-if="showDiff" class="db-pbody"><DbDiff :before="pretty(saved)" :after="pretty(draft)" :title="t('dsh.common.previewChanges')" :file="filePath" /></div>
      <div v-if="errors.length" class="db-pbody db-err" data-companion-errors><ul><li v-for="e in errors" :key="e">{{ e }}</li></ul></div>
      <div class="db-savebar" data-savebar="prompts">
        <span class="db-st" :class="{ 'db-err': statusError }" data-companion-status>{{ status || (dirty ? t('dsh.common.unsavedChanges') : t('dsh.common.allSaved')) }}</span>
        <button type="button" class="db-btn" :disabled="!dirty" data-companion-discard @click="discard">{{ t('dsh.common.discard') }}</button>
        <button type="button" class="db-btn" :disabled="!dirty" :aria-pressed="showDiff" @click="showDiff = !showDiff">{{ t('dsh.common.previewChanges') }}</button>
        <button type="button" class="db-btn primary" :disabled="!dirty || errors.length > 0 || saving" data-companion-save @click="save">{{ saving ? t('dsh.common.saving') : t('dsh.cp.save') }}</button>
      </div>
    </div>
  </div>
</template>
