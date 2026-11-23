<script setup lang="ts">
/**
 * ReaderSettingsPanel.vue — Floating settings dialog in the top nav bar (Spec board §02 / §14).
 * Drafts edits with live root preview and commits on Save; disables Save with reason on WCAG fail.
 * Uses `--lec-*` / `--vp-*` tokens only (0 raw color literals, 0 box-shadow) and `useT()` only.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useData, useRoute, withBase } from 'vitepress'
import { THEME_RUNTIME } from 'virtual:lecture-theme'
import { translate, type LangCode } from '../../i18n/index.ts'
import { useT } from '../../i18n/useT.ts'
import { siteLangs, switchTarget } from '../core/langLinks'
import { setReaderLang } from '../core/readerLang'
import { getRaw, setRaw } from '../core/storage'
import { PROSE_SIZES, type ProseSize } from '../tokens/contract'
import {
  applyCustomTintToRoot,
  applyThemeLayerToRoot,
  computeCustomTint,
  readCustomTint,
  readReaderThemeLayer,
  validateThemeImportJson,
  writeCustomTint,
  writeReaderThemeLayer,
} from '../tokens/customTint'
import type { ThemeLayer } from '../tokens/pack'
import {
  GROUP_DESC_ATTR,
  applyPrefs,
  defaultBodyFont,
  prefAttrs,
  readPrefs,
  syncAppearanceSwitch,
  writePrefs,
  type BodyFont,
  type ReaderPrefs,
} from '../tokens/prefs'
import {
  BYOK_STATUS_EVENT,
  buildOpenAiChatUrl,
  clearByokConfig,
  extractEndpointHost,
  getByokVerifyState,
  isValidByokUrl,
  readByokConfig,
  verifyByokConnection,
  writeByokConfig,
  type ByokVerifyStatus,
} from './ai/byokClient'
import { companionCapabilities, normalizeCompanionAdapter } from './ai/companionRuntime'
import { ICONS } from './ai/icons'

defineOptions({ name: 'ReaderSettingsPanel' })

const { t, lang } = useT()
const { isDark, site, theme } = useData()
const route = useRoute()

const isOpen = ref(false)
const triggerRef = ref<HTMLButtonElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const wrapperRef = ref<HTMLElement | null>(null)

const themesList = THEME_RUNTIME.themes
const langs = computed(() => siteLangs(site.value?.locales ?? {}))
const groupDirs = computed(() =>
  ((theme.value as { groups?: Array<{ dir: string }> })?.groups ?? []).map((g) => g.dir)
)

const companionCaps = computed(() => {
  const modules = (theme.value as { lectureModules?: { companion?: { adapter?: unknown } } } | undefined)
    ?.lectureModules
  return companionCapabilities(normalizeCompanionAdapter(modules?.companion?.adapter))
})
const showByokSection = computed(() => companionCaps.value.showByokSection)

// Draft state (previewed live while panel is open, committed only when Save is clicked)
const draftLang = ref<LangCode>(lang.value)
const draftPrefs = ref<ReaderPrefs>({})
const draftDark = ref(false)
const draftCustomHue = ref(42)
const draftCustomLightness = ref(95)
const draftCustomEnabled = ref(false)
const draftGroupDesc = ref(true)
const draftThemeLayer = ref<ThemeLayer | null>(null)

// Theme JSON import feedback
const themeImportMsg = ref('')
const themeImportError = ref(false)
const hasThemeLayer = computed(() => Boolean(draftThemeLayer.value?.modes))

// BYOK draft state
const draftByokEnabled = ref(false)
const draftByokUrl = ref('')
const draftByokKey = ref('')
const draftByokModel = ref('')
const draftByokRemember = ref(false)
const byokTesting = ref(false)
const byokVerifyStatus = ref<ByokVerifyStatus>('unverified')
const byokVerifyError = ref('')

const activeThemeId = computed(() => {
  const attrs = prefAttrs(draftPrefs.value, THEME_RUNTIME)
  return attrs['data-lec-theme']
})

const isDatasheet = computed(() => activeThemeId.value === 'datasheet')

const activeTint = computed(() => {
  if (draftDark.value) return 'dark'
  if (draftCustomEnabled.value && !isDatasheet.value) return 'custom'
  const attrs = prefAttrs(draftPrefs.value, THEME_RUNTIME)
  return attrs['data-lec-tint'] ?? 'light'
})

const activeSize = computed<ProseSize>(() => {
  const attrs = prefAttrs(draftPrefs.value, THEME_RUNTIME)
  const raw = Number(attrs['data-lec-size'])
  return (PROSE_SIZES as readonly number[]).includes(raw) ? (raw as ProseSize) : 17
})

const sizeIndex = computed(() => PROSE_SIZES.indexOf(activeSize.value))

/** The default body font of the active theme, read from the root once no `data-lec-font` is set (see refreshDefaultFont). */
const themeDefaultFont = ref<BodyFont>('serif')

const activeFont = computed<BodyFont>(() => {
  const attrs = prefAttrs(draftPrefs.value, THEME_RUNTIME)
  const f = attrs['data-lec-font']
  if (f === 'sans' || f === 'serif') return f
  // S6Y F6 (audit-spec #12): no font saved -> the theme's own default, i.e. the font the text is set in now
  return themeDefaultFont.value
})

function refreshDefaultFont(): void {
  if (typeof document === 'undefined') return
  if (document.documentElement.hasAttribute('data-lec-font')) return
  themeDefaultFont.value = defaultBodyFont(getComputedStyle(document.documentElement))
}

/** Theme names are UI text: the two engine themes have i18n names, a third-party pack keeps its theme.json label. */
const THEME_NAME_KEYS: Record<string, 'settings.themeNameReader' | 'settings.themeNameDatasheet'> = {
  reader: 'settings.themeNameReader',
  datasheet: 'settings.themeNameDatasheet',
}
function themeLabel(th: { id: string; label: string }): string {
  const key = THEME_NAME_KEYS[th.id]
  return key ? t(key) : th.label
}

const availableTints = computed(() => {
  const readerPack = themesList.find((th) => th.id === 'reader')
  return readerPack?.tints ?? []
})

const customTintPreview = computed(() =>
  computeCustomTint(draftCustomHue.value, draftCustomLightness.value)
)

const customTintFailReason = computed(() => {
  const prev = customTintPreview.value
  if (prev.pass) return ''
  const first = prev.failReasons[0]
  if (first === 'text') return t('settings.contrastTextFail', { ratio: prev.textRatio.toFixed(1) })
  if (first === 'muted') return t('settings.contrastMutedFail', { ratio: prev.mutedRatio.toFixed(1) })
  if (first === 'accent') return t('settings.contrastAccentFail', { ratio: prev.accentRatio.toFixed(1) })
  return t('settings.contrastFail')
})

const byokUrlEntered = computed(() => draftByokUrl.value.trim().length > 0)
const byokHttpsInvalid = computed(() => byokUrlEntered.value && !isValidByokUrl(draftByokUrl.value))
const byokEndpointPreview = computed(() =>
  byokUrlEntered.value ? buildOpenAiChatUrl(draftByokUrl.value) : ''
)
const byokValid = computed(() => {
  return (
    isValidByokUrl(draftByokUrl.value) &&
    draftByokKey.value.trim().length > 0 &&
    draftByokModel.value.trim().length > 0
  )
})
const byokHost = computed(() => extractEndpointHost(draftByokUrl.value))

const byokStatusGlyph = computed(() => {
  if (byokVerifyStatus.value === 'ok') return ICONS.statusOk
  if (byokVerifyStatus.value === 'failed') return ICONS.statusUnavailable
  return ICONS.statusUnverified
})

const byokStatusText = computed(() => {
  if (byokVerifyStatus.value === 'ok') return t('settings.byokVerifyOk')
  if (byokVerifyStatus.value === 'failed') {
    return t('settings.byokVerifyFailed', { detail: byokVerifyError.value || t('ai.networkError') })
  }
  return t('settings.byokVerifyUnverified')
})

const customTintBlocked = computed(
  () => !isDatasheet.value && draftCustomEnabled.value && !customTintPreview.value.pass
)
const byokBlocked = computed(
  () => showByokSection.value && draftByokEnabled.value && !byokValid.value
)
const saveDisabled = computed(() => customTintBlocked.value || byokBlocked.value)
const saveDisabledReason = computed(() => {
  if (customTintBlocked.value) return customTintFailReason.value
  if (byokBlocked.value) {
    return byokHttpsInvalid.value ? t('settings.byokHttpsRequired') : t('settings.byokStatusInvalid')
  }
  return ''
})

function applyRootAppearance(
  targetPrefs: ReaderPrefs,
  dark: boolean,
  layer: ThemeLayer | null,
  customCfg: { hue: number; lightness: number } | null
): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const applied = applyPrefs(root, targetPrefs, THEME_RUNTIME)
  const themeId = applied['data-lec-theme']
  applyThemeLayerToRoot(root, layer, dark, applied['data-lec-tint'])
  if (customCfg && !dark && themeId === 'reader') {
    applyCustomTintToRoot(root, customCfg)
  } else {
    applyCustomTintToRoot(root, null)
  }
}

function syncCommittedToRoot(): void {
  if (typeof document === 'undefined') return
  const current = readPrefs()
  const layer = readReaderThemeLayer()
  const ct = readCustomTint()
  applyRootAppearance(current, isDark.value, layer, ct)
  const descOpen = getRaw('groupDesc') !== '0'
  document.documentElement.setAttribute(GROUP_DESC_ATTR, descOpen ? 'open' : 'closed')
}

function loadDraftFromCommitted(): void {
  draftLang.value = lang.value
  draftPrefs.value = readPrefs()
  draftDark.value = isDark.value
  draftThemeLayer.value = readReaderThemeLayer()
  draftGroupDesc.value = getRaw('groupDesc') !== '0'

  const ct = readCustomTint()
  if (ct) {
    draftCustomHue.value = ct.hue
    draftCustomLightness.value = ct.lightness
    draftCustomEnabled.value = !draftDark.value && activeThemeId.value === 'reader'
  } else {
    draftCustomEnabled.value = false
  }

  const byokCfg = readByokConfig()
  draftByokEnabled.value = byokCfg.enabled
  draftByokUrl.value = byokCfg.baseUrl
  draftByokKey.value = byokCfg.apiKey
  draftByokModel.value = byokCfg.model
  draftByokRemember.value = byokCfg.remember

  const vState = getByokVerifyState()
  byokVerifyStatus.value = vState.status
  byokVerifyError.value = vState.error
  refreshDefaultFont()
}

function previewDraft(): void {
  if (typeof document === 'undefined') return
  const ct =
    draftCustomEnabled.value && !isDatasheet.value && customTintPreview.value.pass
      ? { hue: customTintPreview.value.hue, lightness: customTintPreview.value.lightness }
      : null
  applyRootAppearance(draftPrefs.value, draftDark.value, draftThemeLayer.value, ct)
  document.documentElement.setAttribute(GROUP_DESC_ATTR, draftGroupDesc.value ? 'open' : 'closed')
  refreshDefaultFont()
}

function selectLanguage(code: LangCode): void {
  draftLang.value = code
}

function selectTheme(id: string): void {
  draftPrefs.value = { ...draftPrefs.value, theme: id }
  if (id !== 'reader') {
    draftCustomEnabled.value = false
    draftPrefs.value = { ...draftPrefs.value, tint: undefined }
  }
  previewDraft()
}

function selectAppearance(mode: string): void {
  if (mode === 'dark') {
    draftDark.value = true
    isDark.value = true
    draftCustomEnabled.value = false
    previewDraft()
    return
  }
  draftDark.value = false
  isDark.value = false
  if (mode === 'custom') {
    if (isDatasheet.value) return
    draftCustomEnabled.value = true
    draftPrefs.value = { ...draftPrefs.value, theme: 'reader', tint: undefined }
  } else if (mode === 'light') {
    draftCustomEnabled.value = false
    draftPrefs.value = { ...draftPrefs.value, tint: 'light' }
  } else {
    if (isDatasheet.value) return
    draftCustomEnabled.value = false
    draftPrefs.value = { ...draftPrefs.value, theme: 'reader', tint: mode }
  }
  previewDraft()
}

function onCustomTintInput(): void {
  if (isDatasheet.value) return
  draftDark.value = false
  isDark.value = false
  draftCustomEnabled.value = true
  draftPrefs.value = { ...draftPrefs.value, theme: 'reader', tint: undefined }
  if (customTintPreview.value.pass) {
    previewDraft()
  }
}

function resetCustomTint(): void {
  draftCustomEnabled.value = false
  previewDraft()
}

function stepSize(delta: -1 | 1): void {
  const nextIdx = sizeIndex.value + delta
  const target = PROSE_SIZES[nextIdx]
  if (target !== undefined) {
    draftPrefs.value = { ...draftPrefs.value, fontSize: target }
    previewDraft()
  }
}

function selectFont(font: BodyFont): void {
  draftPrefs.value = { ...draftPrefs.value, bodyFont: font }
  previewDraft()
}

function onByokInputChange(): void {
  byokVerifyStatus.value = 'unverified'
  byokVerifyError.value = ''
}

async function handleTestByok(): Promise<void> {
  if (byokTesting.value) return
  byokTesting.value = true
  try {
    const res = await verifyByokConnection({
      enabled: draftByokEnabled.value,
      baseUrl: draftByokUrl.value,
      apiKey: draftByokKey.value,
      model: draftByokModel.value,
      remember: draftByokRemember.value,
    })
    byokVerifyStatus.value = res.status
    byokVerifyError.value = res.message || ''
  } finally {
    byokTesting.value = false
  }
}

function handleClearByok(): void {
  const cleared = clearByokConfig()
  draftByokEnabled.value = cleared.enabled
  draftByokUrl.value = cleared.baseUrl
  draftByokKey.value = cleared.apiKey
  draftByokModel.value = cleared.model
  draftByokRemember.value = cleared.remember
  byokVerifyStatus.value = 'unverified'
  byokVerifyError.value = ''
}

async function onThemeFilePicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const raw = await file.text()
    const res = validateThemeImportJson(raw)
    if (!res.ok) {
      themeImportError.value = true
      themeImportMsg.value = t('settings.themeJsonError', {
        message: 'message' in res ? res.message : 'Invalid',
      })
      return
    }
    draftThemeLayer.value = res.layer
    themeImportError.value = false
    themeImportMsg.value = t('settings.themeJsonApplied', { count: res.tokenCount })
    previewDraft()
  } catch (err: unknown) {
    themeImportError.value = true
    themeImportMsg.value = t('settings.themeJsonError', {
      message: err instanceof Error ? err.message : 'Read error',
    })
  } finally {
    input.value = ''
  }
}

function resetThemeLayer(): void {
  draftThemeLayer.value = null
  themeImportMsg.value = ''
  themeImportError.value = false
  previewDraft()
}

function saveSettings(): void {
  if (saveDisabled.value) return

  writePrefs({
    theme: draftPrefs.value.theme ?? null,
    tint: draftPrefs.value.tint ?? null,
    fontSize: draftPrefs.value.fontSize ?? null,
    bodyFont: draftPrefs.value.bodyFont ?? null,
  })
  isDark.value = draftDark.value

  if (draftCustomEnabled.value && !isDatasheet.value && customTintPreview.value.pass) {
    writeCustomTint({
      hue: customTintPreview.value.hue,
      lightness: customTintPreview.value.lightness,
    })
  } else {
    writeCustomTint(null)
  }

  writeReaderThemeLayer(draftThemeLayer.value)

  setRaw('groupDesc', draftGroupDesc.value ? '1' : '0')
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('lecture:group-desc-changed', { detail: { open: draftGroupDesc.value } })
    )
  }

  if (showByokSection.value) {
    writeByokConfig({
      enabled: draftByokEnabled.value,
      baseUrl: draftByokUrl.value,
      apiKey: draftByokKey.value,
      model: draftByokModel.value,
      remember: draftByokRemember.value,
    })
  }

  syncCommittedToRoot()

  if (draftLang.value !== lang.value && typeof window !== 'undefined') {
    const targetEntry = langs.value.find((l) => l.lang === draftLang.value)
    if (targetEntry) {
      setReaderLang(targetEntry.lang)
      const href = withBase(
        switchTarget(route.path, targetEntry, {
          locales: site.value.locales,
          groupDirs: groupDirs.value,
          base: site.value.base,
        })
      )
      isOpen.value = false
      window.location.assign(href)
      return
    }
  }

  isOpen.value = false
  void nextTick(() => triggerRef.value?.focus())
}

function restoreDefaults(): void {
  writePrefs({ theme: null, tint: null, fontSize: null, bodyFont: null })
  const defDark = THEME_RUNTIME.defaultBase === 'dark'
  draftDark.value = defDark
  isDark.value = defDark
  writeCustomTint(null)
  writeReaderThemeLayer(null)
  themeImportMsg.value = ''
  themeImportError.value = false
  setRaw('groupDesc', '1')
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lecture:group-desc-changed', { detail: { open: true } }))
  }
  if (showByokSection.value) {
    handleClearByok()
  }
  loadDraftFromCommitted()
  syncCommittedToRoot()
}

function togglePanel(): void {
  if (!isOpen.value) {
    loadDraftFromCommitted()
    isOpen.value = true
    void nextTick(() => {
      const firstBtn = panelRef.value?.querySelector<HTMLElement>('button, input')
      firstBtn?.focus()
    })
  } else {
    closePanel(true)
  }
}

function closePanel(restoreFocus = true): void {
  if (!isOpen.value) return
  const ap =
    typeof window !== 'undefined' && typeof localStorage !== 'undefined'
      ? localStorage.getItem('vitepress-theme-appearance')
      : null
  const committedDark = ap === 'dark' || (!ap && THEME_RUNTIME.defaultBase === 'dark')
  isDark.value = committedDark
  syncCommittedToRoot()
  isOpen.value = false
  if (restoreFocus) {
    void nextTick(() => triggerRef.value?.focus())
  }
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isOpen.value) {
    e.preventDefault()
    closePanel(true)
  }
}

function onDocPointerDown(e: PointerEvent): void {
  if (!isOpen.value || !wrapperRef.value) return
  const target = e.target as Node | null
  if (target && !wrapperRef.value.contains(target)) {
    closePanel(false)
  }
}

function onByokStatusEvent(): void {
  const st = getByokVerifyState()
  byokVerifyStatus.value = st.status
  byokVerifyError.value = st.error
}

watch(isDark, (dark) => {
  if (!isOpen.value) {
    syncCommittedToRoot()
  }
  // S6Y F6 (audit-spec #22): keep VitePress' appearance switch in step (aria-checked) after the patch of this change
  void nextTick(() => syncAppearanceSwitch(dark))
})

onMounted(() => {
  loadDraftFromCommitted()
  syncCommittedToRoot()
  // hydration kept the server's aria-checked="false"; write the real state once the page is live
  void nextTick(() => syncAppearanceSwitch(isDark.value))
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', onDocKeydown)
    document.addEventListener('pointerdown', onDocPointerDown)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener(BYOK_STATUS_EVENT, onByokStatusEvent)
  }
})

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('keydown', onDocKeydown)
    document.removeEventListener('pointerdown', onDocPointerDown)
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener(BYOK_STATUS_EVENT, onByokStatusEvent)
  }
})
</script>

<template>
  <div ref="wrapperRef" class="rs-root">
    <button
      ref="triggerRef"
      type="button"
      class="rs-nav-btn"
      data-lec-settings-btn
      :aria-expanded="isOpen"
      aria-haspopup="dialog"
      :title="t('settings.btnTitle')"
      :aria-label="t('settings.btnLabel')"
      @click="togglePanel"
    >
      <svg class="rs-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.79 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      <span class="rs-btn-text">{{ t('settings.btnLabel') }}</span>
    </button>

    <div
      v-if="isOpen"
      ref="panelRef"
      class="rs-panel"
      data-lec-settings-panel
      role="dialog"
      aria-modal="false"
      :aria-label="t('settings.panelTitle')"
    >
      <header class="rs-head">
        <span class="rs-title">{{ t('settings.panelTitle') }}</span>
        <button
          type="button"
          class="rs-close"
          :aria-label="t('settings.close')"
          @click="closePanel(true)"
        >
          &times;
        </button>
      </header>

      <div class="rs-body">
        <!-- Language selector (Spec §02) -->
        <section v-if="langs.length > 0" class="rs-group" data-lec-setting="language">
          <div class="rs-label">{{ t('settings.language') }}</div>
          <div class="rs-seg">
            <button
              v-for="l in langs"
              :key="l.lang"
              type="button"
              class="rs-pill"
              :class="{ 'is-active': draftLang === l.lang }"
              :aria-pressed="draftLang === l.lang"
              :data-lec-lang-opt="l.lang"
              @click="selectLanguage(l.lang)"
            >
              {{ translate(l.lang, 'lang.name') }}
            </button>
          </div>
        </section>

        <!-- Theme Pack & Import -->
        <section class="rs-group" data-lec-setting="theme">
          <div class="rs-label">{{ t('settings.theme') }}</div>
          <div class="rs-pills">
            <button
              v-for="th in themesList"
              :key="th.id"
              type="button"
              class="rs-pill"
              :class="{ 'is-active': activeThemeId === th.id }"
              :aria-pressed="activeThemeId === th.id"
              :data-lec-theme-opt="th.id"
              @click="selectTheme(th.id)"
            >
              {{ themeLabel(th) }}
            </button>
            <label class="rs-pill rs-file-btn">
              {{ t('settings.themeJsonPick') }}
              <input
                type="file"
                accept=".json,application/json"
                class="rs-hidden-input"
                data-lec-theme-file
                @change="onThemeFilePicked"
              />
            </label>
            <button
              v-if="hasThemeLayer"
              type="button"
              class="rs-pill"
              data-lec-theme-reset
              @click="resetThemeLayer"
            >
              {{ t('settings.themeJsonReset') }}
            </button>
          </div>
          <p v-if="themeImportMsg" class="rs-msg" :class="{ 'is-error': themeImportError }" data-lec-theme-msg>
            {{ themeImportMsg }}
          </p>
        </section>

        <!-- Appearance & Tint -->
        <section class="rs-group" data-lec-setting="tint">
          <div class="rs-label-row">
            <span class="rs-label">{{ t('settings.appearance') }}</span>
            <span v-if="isDatasheet" class="rs-note" data-lec-tint-disabled-note>
              {{ t('settings.tintDatasheetNote') }}
            </span>
          </div>
          <div class="rs-pills">
            <button
              type="button"
              class="rs-pill"
              :class="{ 'is-active': activeTint === 'light' }"
              :aria-pressed="activeTint === 'light'"
              data-lec-tint-opt="light"
              @click="selectAppearance('light')"
            >
              {{ t('settings.tintLight') }}
            </button>
            <button
              v-for="tint in availableTints"
              :key="tint"
              type="button"
              class="rs-pill"
              :class="{ 'is-active': activeTint === tint }"
              :aria-pressed="activeTint === tint"
              :disabled="isDatasheet"
              :data-lec-tint-opt="tint"
              @click="selectAppearance(tint)"
            >
              {{ tint === 'sepia' ? t('settings.tintSepia') : tint === 'green' ? t('settings.tintGreen') : tint }}
            </button>
            <!-- S6Y decision (2): spec board 02 order 纸白 / 米黄 / 豆沙绿 / 深色 / 自定义 -->
            <button
              type="button"
              class="rs-pill"
              :class="{ 'is-active': activeTint === 'dark' }"
              :aria-pressed="activeTint === 'dark'"
              data-lec-tint-opt="dark"
              @click="selectAppearance('dark')"
            >
              {{ t('settings.tintDark') }}
            </button>
            <button
              type="button"
              class="rs-pill"
              :class="{ 'is-active': activeTint === 'custom' }"
              :aria-pressed="activeTint === 'custom'"
              :disabled="isDatasheet"
              data-lec-tint-opt="custom"
              @click="selectAppearance('custom')"
            >
              {{ t('settings.tintCustom') }}
            </button>
          </div>
        </section>

        <!-- Custom Tint with WCAG contrast gate (visible when custom selected in reader) -->
        <section
          v-if="!isDatasheet && draftCustomEnabled"
          class="rs-group"
          data-lec-setting="custom-tint"
        >
          <div class="rs-label-row">
            <span class="rs-label">{{ t('settings.customTint') }}</span>
            <span
              class="rs-contrast-badge"
              :class="customTintPreview.pass ? 'is-pass' : 'is-fail'"
              :data-lec-contrast-ratio="customTintPreview.minRatio.toFixed(2)"
              :data-lec-contrast-pass="customTintPreview.pass ? 'true' : 'false'"
            >
              <span class="rs-swatch" :style="{ backgroundColor: customTintPreview.bgHex }" />
              <span>{{ t('settings.contrastLabel', { ratio: customTintPreview.minRatio.toFixed(1) }) }}</span>
              <span>{{ customTintPreview.pass ? t('settings.contrastPass') : t('settings.contrastFail') }}</span>
            </span>
          </div>
          <label class="rs-slider-row">
            <span>{{ t('settings.hue') }} ({{ draftCustomHue }})</span>
            <input
              v-model.number="draftCustomHue"
              type="range"
              min="0"
              max="360"
              data-lec-tint-hue
              @input="onCustomTintInput"
            />
          </label>
          <label class="rs-slider-row">
            <span>{{ t('settings.lightness') }} ({{ draftCustomLightness }}%)</span>
            <input
              v-model.number="draftCustomLightness"
              type="range"
              min="8"
              max="97"
              data-lec-tint-lightness
              @input="onCustomTintInput"
            />
          </label>
          <p v-if="!customTintPreview.pass" class="rs-msg is-error" data-lec-contrast-reason>
            {{ customTintFailReason }}
          </p>
          <button
            type="button"
            class="rs-link-btn"
            data-lec-custom-tint-reset
            @click="resetCustomTint"
          >
            {{ t('settings.customTintReset') }}
          </button>
        </section>

        <!-- Font size stepper (Spec §02) -->
        <section class="rs-group" data-lec-setting="size">
          <div class="rs-label-row">
            <span class="rs-label">{{ t('settings.fontSize') }}</span>
            <span class="rs-stepper">
              <button
                type="button"
                class="rs-step-btn"
                data-lec-size-dec
                :aria-label="t('settings.sizeDecAria')"
                :disabled="sizeIndex <= 0"
                @click="stepSize(-1)"
              >&minus;</button>
              <span class="rs-step-val" data-lec-size-value>{{ activeSize }}px</span>
              <button
                type="button"
                class="rs-step-btn"
                data-lec-size-inc
                :aria-label="t('settings.sizeIncAria')"
                :disabled="sizeIndex >= PROSE_SIZES.length - 1"
                @click="stepSize(1)"
              >+</button>
            </span>
          </div>
        </section>

        <!-- Body font -->
        <section class="rs-group" data-lec-setting="font">
          <div class="rs-label">{{ t('settings.bodyFont') }}</div>
          <div class="rs-seg">
            <button
              type="button"
              class="rs-pill"
              :class="{ 'is-active': activeFont === 'sans' }"
              :aria-pressed="activeFont === 'sans'"
              data-lec-font-opt="sans"
              @click="selectFont('sans')"
            >
              {{ t('settings.fontSans') }}
            </button>
            <button
              type="button"
              class="rs-pill"
              :class="{ 'is-active': activeFont === 'serif' }"
              :aria-pressed="activeFont === 'serif'"
              data-lec-font-opt="serif"
              @click="selectFont('serif')"
            >
              {{ t('settings.fontSerif') }}
            </button>
          </div>
        </section>

        <!-- Group description default -->
        <section class="rs-group" data-lec-setting="group-desc">
          <label class="rs-check-row">
            <input
              v-model="draftGroupDesc"
              type="checkbox"
              data-lec-group-desc
              @change="previewDraft"
            />
            <span>{{ t('settings.groupDesc') }}</span>
          </label>
        </section>

        <!-- BYOK Companion Model (hidden when companion.adapter === 'off') -->
        <fieldset v-if="showByokSection" class="rs-byok-fieldset" data-lec-setting="byok">
          <legend>{{ t('settings.byokLegend') }}</legend>
          <details :open="draftByokEnabled">
            <summary>{{ t('settings.byokSummary') }}</summary>
            <div class="rs-byok-fields">
              <label class="rs-check-row">
                <input
                  v-model="draftByokEnabled"
                  type="checkbox"
                  data-lec-byok-enable
                />
                <span>{{ t('settings.byokEnable') }}</span>
              </label>

              <label class="rs-field">
                <span>{{ t('settings.byokUrl') }}</span>
                <input
                  v-model="draftByokUrl"
                  type="url"
                  :placeholder="t('settings.byokUrlPlaceholder')"
                  data-lec-byok-url
                  @input="onByokInputChange"
                />
              </label>

              <p v-if="byokHttpsInvalid" class="rs-msg is-error" data-lec-byok-https-err>
                {{ t('settings.byokHttpsRequired') }}
              </p>
              <p v-else-if="byokEndpointPreview" class="rs-endpoint-preview" data-lec-byok-endpoint>
                {{ t('settings.byokEndpointPreview', { endpoint: byokEndpointPreview }) }}
              </p>

              <label class="rs-field">
                <span>{{ t('settings.byokKey') }}</span>
                <input
                  v-model="draftByokKey"
                  type="password"
                  autocomplete="off"
                  :placeholder="t('settings.byokKeyPlaceholder')"
                  data-lec-byok-key
                  @input="onByokInputChange"
                />
              </label>

              <label class="rs-field">
                <span>{{ t('settings.byokModel') }}</span>
                <input
                  v-model="draftByokModel"
                  type="text"
                  :placeholder="t('settings.byokModelPlaceholder')"
                  data-lec-byok-model
                  @input="onByokInputChange"
                />
              </label>

              <!-- Spec §02: remember toggle right above the risk notice -->
              <label class="rs-check-row">
                <input
                  v-model="draftByokRemember"
                  type="checkbox"
                  data-lec-byok-remember
                />
                <span>{{ t('settings.byokRemember') }}</span>
              </label>

              <p class="rs-hint">{{ t('settings.byokPrivacyHint') }}</p>

              <div class="rs-byok-actions">
                <div class="rs-byok-verify-group">
                  <button
                    type="button"
                    class="rs-pill"
                    data-lec-byok-test
                    :disabled="byokTesting || !byokValid"
                    @click="handleTestByok"
                  >
                    {{ byokTesting ? t('settings.byokTesting') : t('settings.byokTest') }}
                  </button>
                  <span
                    class="rs-byok-status"
                    :class="`is-${byokVerifyStatus}`"
                    :data-lec-byok-verify="byokVerifyStatus"
                    data-lec-byok-status
                  >
                    <span class="rs-status-glyph" aria-hidden="true" v-html="byokStatusGlyph"></span>
                    <span>
                      {{ byokStatusText }}
                      <template v-if="draftByokEnabled && byokValid && byokHost">
                        ({{ byokHost }})
                      </template>
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  class="rs-link-btn"
                  data-lec-byok-clear
                  @click="handleClearByok"
                >
                  {{ t('settings.byokClear') }}
                </button>
              </div>
            </div>
          </details>
        </fieldset>
      </div>

      <footer class="rs-foot">
        <span v-if="saveDisabledReason" class="rs-save-reason" data-lec-save-reason>
          {{ saveDisabledReason }}
        </span>
        <div class="rs-foot-actions">
          <button
            type="button"
            class="rs-pill"
            data-lec-settings-restore
            @click="restoreDefaults"
          >
            {{ t('settings.restoreDefaults') }}
          </button>
          <button
            type="button"
            class="rs-pill rs-save-btn"
            data-lec-settings-save
            :disabled="saveDisabled"
            :title="saveDisabledReason"
            @click="saveSettings"
          >
            {{ t('settings.save') }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.rs-root {
  position: relative;
  display: inline-flex;
  align-items: center;
  margin-left: 8px;
}

.rs-nav-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  color: var(--lec-text-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}

.rs-nav-btn:hover,
.rs-nav-btn[aria-expanded='true'] {
  border-color: var(--lec-accent);
  color: var(--lec-accent);
}

.rs-panel {
  position: fixed;
  top: calc(var(--vp-nav-height, 64px) + 8px);
  right: 16px;
  /* S6Y F1: spec board 02 .set-wrap column 360px */
  width: min(360px, calc(100vw - 24px));
  max-height: calc(100vh - var(--vp-nav-height, 64px) - 24px);
  display: flex;
  flex-direction: column;
  background: var(--lec-bg);
  color: var(--lec-text);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-2);
  z-index: 220;
  font-size: 13px;
  /* S6Y F1: own line height (spec board controls: 1.6) instead of VitePress' 24px; buttons use `normal` like the board */
  line-height: 1.6;
}

.rs-panel button {
  line-height: normal;
}

.rs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--lec-border);
  background: var(--lec-surface);
}

.rs-title {
  font-weight: 600;
  color: var(--lec-text);
}

.rs-close {
  border: none;
  background: transparent;
  color: var(--lec-text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
}

.rs-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px 14px;
  overflow-y: auto;
}

.rs-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rs-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--lec-text-muted);
}

.rs-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.rs-note {
  font-size: 11px;
  color: var(--lec-text-muted);
}

.rs-pills,
.rs-seg {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.rs-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* S6Y F1: spec board 02 .seg button (13px, line normal; board 27 / 29px). The board's buttons have no border of their own
     (the segment draws it), ours do, so 1px less padding keeps the same height */
  padding: 4px var(--lec-space-3);
  border-radius: var(--lec-radius-1);
  border: 1px solid var(--lec-border);
  background: var(--lec-surface);
  color: var(--lec-text);
  font-size: 13px;
  line-height: normal;
  cursor: pointer;
}

.rs-pill:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.rs-pill.is-active {
  border-color: var(--lec-accent);
  background: var(--lec-accent-tint);
  color: var(--lec-accent);
  font-weight: 600;
}

.rs-stepper {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.rs-step-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  color: var(--lec-text);
  font-size: 14px;
  cursor: pointer;
}

.rs-step-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.rs-step-val {
  min-width: 42px;
  text-align: center;
  font-size: 12px;
  font-family: var(--lec-font-mono);
  color: var(--lec-text);
}

.rs-contrast-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: var(--lec-radius-1);
  border: 1px solid var(--lec-border);
}

.rs-contrast-badge.is-pass {
  color: var(--lec-done-text);
  border-color: var(--lec-done);
}

.rs-contrast-badge.is-fail {
  color: var(--lec-danger);
  border-color: var(--lec-danger);
  background: var(--lec-danger-tint);
}

.rs-swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid var(--lec-border);
}

.rs-slider-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--lec-text-muted);
}

.rs-slider-row input[type='range'] {
  flex: 1;
}

.rs-check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--lec-text);
  cursor: pointer;
}

.rs-hidden-input {
  display: none;
}

.rs-msg {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--lec-done-text);
}

.rs-msg.is-error {
  color: var(--lec-danger);
}

.rs-byok-fieldset {
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  padding: 8px 10px;
  margin: 0;
}

.rs-byok-fieldset legend {
  font-size: 12px;
  font-weight: 600;
  color: var(--lec-text-muted);
  padding: 0 4px;
}

.rs-byok-fieldset summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--lec-text);
}

.rs-byok-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.rs-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11.5px;
  color: var(--lec-text-muted);
}

.rs-field input {
  padding: 5px 8px;
  border-radius: var(--lec-radius-1);
  border: 1px solid var(--lec-border);
  background: var(--lec-surface);
  color: var(--lec-text);
  font-size: 12px;
}

.rs-endpoint-preview {
  margin: 0;
  font-size: 11px;
  font-family: var(--lec-font-mono);
  color: var(--lec-text-muted);
  word-break: break-all;
}

.rs-byok-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.rs-byok-verify-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.rs-byok-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--lec-text-muted);
}

.rs-byok-status.is-ok {
  color: var(--lec-done-text);
}

.rs-byok-status.is-failed {
  color: var(--lec-danger);
}

.rs-status-glyph {
  display: inline-flex;
  align-items: center;
}

.rs-link-btn {
  align-self: flex-start;
  border: none;
  background: transparent;
  padding: 0;
  font-size: 11.5px;
  color: var(--lec-accent);
  cursor: pointer;
  text-decoration: underline;
}

.rs-hint {
  margin: 0;
  font-size: 11px;
  color: var(--lec-text-muted);
  line-height: 1.4;
}

.rs-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  border-top: 1px solid var(--lec-border);
  background: var(--lec-surface);
}

.rs-save-reason {
  font-size: 11px;
  color: var(--lec-danger);
}

.rs-foot-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.rs-save-btn {
  border-color: var(--lec-accent);
  background: var(--lec-accent);
  color: var(--lec-on-accent);
  font-weight: 600;
}

.rs-save-btn:disabled {
  background: var(--lec-surface);
  color: var(--lec-text-muted);
  border-color: var(--lec-border);
}

@media (max-width: 640px) {
  .rs-btn-text {
    display: none;
  }
}

/* 641-1023 px: the top bar has no room for button labels (it overflowed by ~55 px at 768). Icon only, same height;
   phones (<=640) keep the rule above. */
@media (min-width: 641px) and (max-width: 1023px) {
  .rs-btn-text {
    display: none;
  }
  .rs-nav-btn {
    gap: 0;
    padding: 0 8px;
  }
}

/* S6Y F6 (audit-spec #27, decision 1): on phones the settings and export buttons are the same 36x36 icon buttons */
@media (max-width: 767px) {
  .rs-btn-text {
    display: none;
  }
  .rs-nav-btn {
    width: 36px;
    height: 36px;
    padding: 0;
    gap: 0;
    justify-content: center;
  }
}
</style>
