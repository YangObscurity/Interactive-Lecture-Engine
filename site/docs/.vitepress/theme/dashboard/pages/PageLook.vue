<script setup lang="ts">
/**
 * PageLook.vue — Look & modules: default theme (skin & reading tints with live WCAG contrast check),
 * live device preview, configured site modules, env/secret settings (dev), and non-secret online
 * settings (online admin). Online look saves trigger a non-blocking `rebuild_required` banner.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useData } from 'vitepress'
import { THEME_RUNTIME } from 'virtual:lecture-theme'
import { useT } from '../../../i18n/useT.ts'
import type { MessageKey } from '../../../i18n/index.ts'
import { runDevDashboardProbe, saveDevEnvSetting, type DevDashboardStatus, type DevSettingSummary } from '../../api/admin'
import type { ThemeView } from '../../api/devDashboard'
import { dashboardClient } from '../dashboardClient'
import { contrast } from '../../tokens/color'
import {
  DEFAULT_CUSTOM_HEX,
  isDarkColor,
  READING_BASES,
  SKIN_PALETTES,
  validateThemeImportJson,
} from '../../tokens/customTint'
import { applyPrefs, prefAttrs, readPrefs, writePrefs, type ReaderPrefs } from '../../tokens/prefs'
import DbHead from '../DbHead.vue'
import DbTabs from '../DbTabs.vue'
import { shortDateTime } from '../dashboardData'
import { canAccessPage, canWritePage, dashboardState, registerModel, say, tabOf, touchModels, type DashboardPageId } from '../useDashboard'

const props = defineProps<{ status: DevDashboardStatus | null }>()
const emit = defineEmits<{ tab: [tab: string]; status: [s: DevDashboardStatus]; go: [page: DashboardPageId, tab?: string] }>()
const { t, lang } = useT()
const { theme, isDark } = useData<{ lectureModules?: Record<string, Record<string, unknown>> }>()

const isDev = computed(() => dashboardState.mode === 'dev')
const canWrite = computed(() => canWritePage('look'))
const ro = computed(() => !canWrite.value)

// ---- Device-level preview (ReaderPrefs in localStorage) ----
const prefs = ref<ReaderPrefs>({})
const themeList = THEME_RUNTIME.themes
const activeTheme = computed(() => prefAttrs(prefs.value, THEME_RUNTIME)['data-lec-theme'] ?? THEME_RUNTIME.defaultTheme)
const tints = computed(() => themeList.find((th: { id: string; tints: string[] }) => th.id === 'reader')?.tints ?? [])
const TINT_NAME: Record<string, MessageKey> = { light: 'settings.tintLight', sepia: 'settings.tintSepia', green: 'settings.tintGreen', dark: 'settings.tintDark' }
const tintName = (id: string): string => (TINT_NAME[id] ? t(TINT_NAME[id] as MessageKey) : id)
const activeTint = computed(() => (isDark.value ? 'dark' : prefAttrs(prefs.value, THEME_RUNTIME)['data-lec-tint'] ?? 'light'))

function selectTheme(id: string): void {
  prefs.value = writePrefs({ theme: id })
  applyPrefs(document.documentElement, prefs.value, THEME_RUNTIME)
}
function selectTint(tint: string): void {
  if (isDark.value) isDark.value = false
  prefs.value = writePrefs({ theme: 'reader', tint })
  applyPrefs(document.documentElement, prefs.value, THEME_RUNTIME)
}

// ---- JSON import validation ----
const jsonInput = ref('')
const jsonMsg = ref('')
const jsonErr = ref(false)

function validateJson(): void {
  const res = validateThemeImportJson(jsonInput.value)
  jsonErr.value = !res.ok
  jsonMsg.value = res.ok ? t('dsh.lk.jsonOk', { n: res.tokenCount }) : 'message' in res ? res.message : 'invalid'
}

// ---- Site-level theme.json / online look persistence ----
const themeConfig = ref<ThemeView | null>(null)
const draftSkin = ref<'reader' | 'datasheet'>('reader')
const draftBase = ref<'paper' | 'sepia' | 'green' | 'dark' | 'custom'>('paper')
const draftCustomHex = ref(DEFAULT_CUSTOM_HEX)
const savingTheme = ref(false)
const themeSaveStatus = ref('')
const themeSavedNote = ref('')

const validHexRe = /^#[0-9a-fA-F]{6}$/
const isValidHex = computed(() => validHexRe.test(draftCustomHex.value.trim()))

const FALLBACK_BASE = READING_BASES[0]!
const DARK_BASE = READING_BASES[3] ?? FALLBACK_BASE

const currentBgHex = computed(() => {
  if (draftBase.value === 'custom') {
    return isValidHex.value ? draftCustomHex.value.trim().toUpperCase() : ''
  }
  return READING_BASES.find((b) => b.id === draftBase.value)?.hex ?? FALLBACK_BASE.hex
})

const currentSurfaceHex = computed(() => {
  if (draftBase.value === 'custom') {
    return currentBgHex.value
  }
  return READING_BASES.find((b) => b.id === draftBase.value)?.surface ?? FALLBACK_BASE.surface
})

const isDarkBase = computed(() => {
  const bg = currentBgHex.value
  if (!bg) return false
  if (draftBase.value === 'dark') return true
  if (draftBase.value === 'custom') {
    return isDarkColor(bg)
  }
  return false
})

const activeSkinPalette = computed(() => {
  const skin = draftSkin.value === 'datasheet' ? 'datasheet' : 'reader'
  const mode = isDarkBase.value ? 'dark' : 'light'
  return SKIN_PALETTES[skin]?.[mode] ?? SKIN_PALETTES.reader[mode]
})

interface ContrastRow {
  key: string
  name: string
  color: string
  minRatio: number
  ratio: number
  pass: boolean
}

const contrastRows = computed<ContrastRow[] | null>(() => {
  const bg = currentBgHex.value
  if (!bg) return null
  const p = activeSkinPalette.value
  const checks: Array<{ key: string; nameKey: MessageKey; color: string; min: number }> = [
    { key: 'text', nameKey: 'dsh.lk.rowText', color: p.text, min: 4.5 },
    { key: 'text-muted', nameKey: 'dsh.lk.rowMuted', color: p['text-muted'], min: 4.5 },
    { key: 'accent', nameKey: 'dsh.lk.rowAccent', color: p.accent, min: 4.5 },
    { key: 'danger', nameKey: 'dsh.lk.rowDanger', color: p.danger, min: 3.0 },
  ]
  return checks.map((c) => {
    const ratio = contrast(bg, c.color)
    return {
      key: c.key,
      name: t(c.nameKey),
      color: c.color,
      minRatio: c.min,
      ratio,
      pass: ratio >= c.min,
    }
  })
})

const contrastOk = computed(() => {
  if (draftBase.value === 'custom' && !isValidHex.value) return false
  const rows = contrastRows.value
  return !!rows && rows.every((r) => r.pass)
})

const firstContrastFailure = computed(() => {
  if (draftBase.value === 'custom' && !isValidHex.value) {
    return t('dsh.lk.invalidHex')
  }
  const failed = contrastRows.value?.find((r) => !r.pass)
  if (failed) {
    return t('dsh.lk.contrastFailReason', { item: failed.name, ratio: failed.ratio.toFixed(1), req: failed.minRatio })
  }
  return ''
})

const savedThemeModel = computed(() => {
  if (!themeConfig.value) return null
  return {
    skin: themeConfig.value.skin,
    base: themeConfig.value.base,
    custom: (themeConfig.value.custom ?? DEFAULT_CUSTOM_HEX).toUpperCase(),
  }
})

const themeDirty = computed(() => {
  if (!savedThemeModel.value) return false
  return (
    draftSkin.value !== savedThemeModel.value.skin ||
    draftBase.value !== savedThemeModel.value.base ||
    (draftBase.value === 'custom' && draftCustomHex.value.trim().toUpperCase() !== savedThemeModel.value.custom)
  )
})

const currentBorderHex = computed(() => {
  if (draftBase.value === 'custom') {
    return isDarkBase.value ? DARK_BASE.border : FALLBACK_BASE.border
  }
  return READING_BASES.find((b) => b.id === draftBase.value)?.border ?? FALLBACK_BASE.border
})

const miniPreviewStyle = computed(() => {
  const bg = currentBgHex.value || FALLBACK_BASE.hex
  const surface = currentSurfaceHex.value || FALLBACK_BASE.surface
  const p = SKIN_PALETTES.reader[isDarkBase.value ? 'dark' : 'light']
  return {
    '--lec-bg': bg,
    '--lec-surface': surface,
    '--lec-text': p.text,
    '--lec-text-muted': p['text-muted'],
    '--lec-accent': p.accent,
    '--lec-danger': p.danger,
    '--lec-border': currentBorderHex.value,
  }
})

function skinCardStyle(skin: string): Record<string, string> {
  if (skin !== 'datasheet') return miniPreviewStyle.value
  const p = SKIN_PALETTES.datasheet[isDarkBase.value ? 'dark' : 'light']
  return {
    '--lec-bg': p.bg,
    '--lec-surface': p.surface,
    '--lec-text': p.text,
    '--lec-text-muted': p['text-muted'],
    '--lec-accent': p.accent,
    '--lec-danger': p.danger,
    '--lec-border': p.border,
  }
}

async function saveTheme(): Promise<boolean> {
  if (!canWrite.value) return false
  if (!themeDirty.value) return true
  if (!contrastOk.value) return false
  savingTheme.value = true
  themeSaveStatus.value = ''
  const customHex = draftBase.value === 'custom' ? draftCustomHex.value.trim().toUpperCase() : DEFAULT_CUSTOM_HEX
  const res = await dashboardClient.saveLook({
    skin: draftSkin.value,
    base: draftBase.value,
    custom: customHex,
  })
  savingTheme.value = false
  if (!res.ok) {
    themeSaveStatus.value = res.error ?? 'save_failed'
    return false
  }
  if (res.theme) {
    themeConfig.value = res.theme
    draftSkin.value = res.theme.skin
    draftBase.value = res.theme.base
    if (res.theme.custom) draftCustomHex.value = res.theme.custom.toUpperCase()
  } else {
    themeConfig.value = {
      file: 'site_settings:look',
      exists: true,
      skin: draftSkin.value,
      base: draftBase.value,
      custom: customHex,
    }
  }
  themeSavedNote.value = t('dsh.common.savedAt', { time: shortDateTime(Date.now()) })
  touchModels()
  say(isDev.value ? t('dsh.lk.savedTheme') : t('dsh.lk.savedThemeOnline'))
  return true
}

function discardTheme(): void {
  if (savedThemeModel.value) {
    draftSkin.value = savedThemeModel.value.skin
    draftBase.value = savedThemeModel.value.base
    draftCustomHex.value = savedThemeModel.value.custom
  }
  themeSaveStatus.value = ''
  touchModels()
}

// ---- Modules & secrets ----
const modules = computed(() => {
  const m = theme.value?.lectureModules ?? {}
  return Object.entries(m).map(([id, v]) => ({ id, adapter: String((v as { adapter?: unknown; source?: unknown }).adapter ?? (v as { source?: unknown }).source ?? '—') }))
})
const groups = computed(() => {
  const by = new Map<string, DevSettingSummary[]>()
  for (const s of props.status?.settings ?? []) {
    if (s.kind === 'site') continue
    by.set(s.module, [...(by.get(s.module) ?? []), s])
  }
  return [...by].map(([module, settings]) => ({ module, settings, inUse: props.status?.inUseModules.includes(module) ?? false }))
})
const edits = reactive<Record<string, string>>({})
const openMods = reactive(new Set<string>())
const savingMod = ref<string | null>(null)
const probing = ref(false)

const dirtyKeys = (module: string) => groups.value.find((g) => g.module === module)?.settings.filter((s) => (edits[s.key] ?? '') !== '').map((s) => s.key) ?? []
const anyDirty = () => groups.value.some((g) => dirtyKeys(g.module).length > 0)

function setEdit(key: string, v: string): void {
  edits[key] = v
  touchModels()
}

async function saveModule(module: string): Promise<boolean> {
  const keys = dirtyKeys(module)
  if (!keys.length || !dashboardState.token) return false
  savingMod.value = module
  let last: DevDashboardStatus | undefined
  try {
    for (const key of keys) {
      const res = await saveDevEnvSetting(dashboardState.token, key, edits[key] ?? '')
      if (!res.ok) {
        say(t('dsh.lk.saveErr', { key, error: res.error ?? 'unknown' }))
        return false
      }
      delete edits[key]
      if (res.status) last = res.status
    }
    if (last) emit('status', last)
    say(t('dsh.lk.saved', { module, n: keys.length }))
    return true
  } finally {
    savingMod.value = null
    touchModels()
  }
}
async function saveAll(): Promise<boolean> {
  let ok = true
  for (const g of groups.value) if (dirtyKeys(g.module).length) ok = (await saveModule(g.module)) && ok
  return ok
}
function discardAll(): void {
  for (const k of Object.keys(edits)) delete edits[k]
  touchModels()
}
async function probe(): Promise<void> {
  if (!dashboardState.token) return
  probing.value = true
  try {
    const s = await runDevDashboardProbe(dashboardState.token)
    if (s) emit('status', s)
  } finally {
    probing.value = false
  }
}

// ---- Online non-secret settings (/api/admin/settings/:key) ----
const RESERVED_SETTING_KEYS = new Set(['access', 'texts', 'look', 'ai_tools', 'companion_prompts', 'last_check_report'])
const onlineSettingKey = ref('site_notice')
const onlineSettingValue = ref('')
const onlineSettingMsg = ref('')
const onlineSettingErr = ref(false)
const onlineSettingBusy = ref(false)

async function loadOnlineSetting(): Promise<void> {
  if (!canWrite.value) return
  const key = onlineSettingKey.value.trim()
  if (!key) return
  onlineSettingBusy.value = true
  onlineSettingErr.value = false
  onlineSettingMsg.value = ''
  const res = await dashboardClient.fetchSetting(key)
  onlineSettingBusy.value = false
  if (!res.ok) {
    onlineSettingErr.value = true
    onlineSettingMsg.value = res.error ?? 'load_failed'
    return
  }
  onlineSettingValue.value = res.value === null || res.value === undefined ? 'null' : JSON.stringify(res.value, null, 2)
}

async function saveOnlineSettingKey(): Promise<void> {
  if (!canWrite.value) return
  const key = onlineSettingKey.value.trim()
  if (!key) return
  if (RESERVED_SETTING_KEYS.has(key)) {
    onlineSettingErr.value = true
    onlineSettingMsg.value = t('dsh.lk.onlineSettingReservedErr')
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(onlineSettingValue.value || 'null')
  } catch {
    onlineSettingErr.value = true
    onlineSettingMsg.value = t('dsh.lk.onlineSettingJsonErr')
    return
  }
  onlineSettingBusy.value = true
  onlineSettingErr.value = false
  onlineSettingMsg.value = ''
  const res = await dashboardClient.saveSetting(key, parsed)
  onlineSettingBusy.value = false
  if (!res.ok) {
    onlineSettingErr.value = true
    onlineSettingMsg.value = res.error === 'reserved_setting_key' ? t('dsh.lk.onlineSettingReservedErr') : (res.error ?? 'save_failed')
    return
  }
  onlineSettingMsg.value = t('dsh.lk.onlineSettingSaved', { key })
  say(onlineSettingMsg.value)
}

const ST_SET = '\u5df2\u8bbe\u7f6e'
const ST_DEFAULT = '\u9ed8\u8ba4\u503c'
const ST_INVALID = '\u65e0\u6548'
const statusMark = (s: DevSettingSummary) => (s.error || s.status === ST_INVALID ? 'bad' : s.status === ST_SET ? 'ok' : s.status === ST_DEFAULT ? 'half' : 'off')
const statusText = (s: DevSettingSummary) =>
  s.kind === 'secret' ? (s.secretSet ? t('dsh.lk.secretSet', { n: s.secretLength ?? 0 }) : t('dsh.lk.secretUnset')) : s.status

const lookDirtyTabs = computed(() => [
  ...(themeDirty.value ? ['theme'] : []),
  ...(anyDirty() ? ['modules'] : []),
])

let unregisterEnv: (() => void) | null = null
let unregisterTheme: (() => void) | null = null

const VALID_BASES = new Set(['paper', 'sepia', 'green', 'dark', 'custom'])

function seedRuntimeThemeDefaults(): void {
  const rtSkin = THEME_RUNTIME.defaultTheme === 'datasheet' ? 'datasheet' : 'reader'
  const rtBase = THEME_RUNTIME.defaultBase ?? THEME_RUNTIME.defaultTint ?? 'paper'
  const cleanBase = VALID_BASES.has(rtBase)
    ? (rtBase as 'paper' | 'sepia' | 'green' | 'dark' | 'custom')
    : 'paper'
  const rtCustom = THEME_RUNTIME.customTint?.toUpperCase() ?? DEFAULT_CUSTOM_HEX
  themeConfig.value = { file: 'theme.json', exists: false, skin: rtSkin, base: cleanBase, custom: rtCustom }
  draftSkin.value = rtSkin
  draftBase.value = cleanBase
  draftCustomHex.value = rtCustom
}

onMounted(async () => {
  prefs.value = readPrefs()
  unregisterEnv = registerModel('look-env', { page: 'look', dirty: anyDirty, save: saveAll, discard: discardAll })
  unregisterTheme = registerModel('look-theme', { page: 'look', dirty: () => themeDirty.value, save: saveTheme, discard: discardTheme })

  if (dashboardState.mode === 'dev') {
    const res = await dashboardClient.fetchLook()
    if (res.theme) {
      themeConfig.value = res.theme
      draftSkin.value = res.theme.skin
      draftBase.value = res.theme.base
      if (res.theme.custom) draftCustomHex.value = res.theme.custom.toUpperCase()
      touchModels()
    }
  } else {
    seedRuntimeThemeDefaults()
    if (canAccessPage('look')) {
      const res = await dashboardClient.fetchLook()
      if (res.ok && res.look) {
        const l = res.look
        const skin = l.skin === 'datasheet' ? 'datasheet' : l.skin === 'reader' ? 'reader' : draftSkin.value
        const base = typeof l.base === 'string' && VALID_BASES.has(l.base)
          ? (l.base as 'paper' | 'sepia' | 'green' | 'dark' | 'custom')
          : draftBase.value
        const custom = typeof l.custom === 'string' && validHexRe.test(l.custom.trim())
          ? l.custom.trim().toUpperCase()
          : draftCustomHex.value
        themeConfig.value = { file: 'site_settings:look', exists: true, skin, base, custom }
        draftSkin.value = skin
        draftBase.value = base
        draftCustomHex.value = custom
        touchModels()
      }
    }
  }
})

onBeforeUnmount(() => {
  unregisterEnv?.()
  unregisterTheme?.()
})
</script>

<template>
  <div class="db-page" data-page="look">
    <DbHead :title="t('dsh.nav.look')" :lead="t('dsh.lk.lead')" :read-only="ro" />
    <DbTabs
      page="look"
      :label="t('dsh.nav.look')"
      :items="[
        ['theme', t('dsh.lk.tabTheme')],
        ['modules', t('dsh.lk.tabModules')],
      ]"
      :dirty-tabs="lookDirtyTabs"
      @select="emit('tab', $event)"
    />

    <template v-if="tabOf('look') === 'theme'">
      <section class="db-panel" data-look-default>
        <header>
          <h3>{{ t('dsh.lk.defaultTitle') }}</h3>
          <span class="db-hm">{{ t('dsh.lk.defaultHint') }}</span>
        </header>
        <div class="db-skins" role="radiogroup" :aria-label="t('dsh.lk.defaultTitle')">
          <button
            v-for="s in (['reader', 'datasheet'] as const)"
            :key="s"
            type="button"
            class="db-skinopt"
            role="radio"
            :aria-checked="draftSkin === s"
            :disabled="ro"
            :data-skin="s"
            @click="!ro && (draftSkin = s, touchModels())"
          >
            <span class="db-sn">
              <span class="dm" :data-k="draftSkin === s ? 'ok' : 'off'" aria-hidden="true"></span>
              {{ s }} · {{ s === 'reader' ? t('dsh.lk.readerShape') : t('dsh.lk.datasheetShape') }}
            </span>
            <span class="db-pv-mini" :class="`th-${s} m-${isDarkBase ? 'dark' : 'light'}`" :style="skinCardStyle(s)">
              <span class="pv-bar"><b>{{ t('dsh.lk.pvSiteTitle') }}</b><span>{{ t('dsh.lk.pvSiteSub') }}</span></span>
              <span class="pv-bd">
                <span class="pv-h4">{{ t('dsh.lk.pvLectureTitle') }}</span>
                <span class="pv-tag">{{ t('dsh.lk.pvGroupTag') }}</span>
                <span class="pv-card"><b>{{ t('dsh.lk.pvCardTitle') }}</b><span class="pv-muted">{{ t('dsh.lk.pvCardDesc') }}</span></span>
                <span class="pv-link">{{ t('dsh.lk.pvNextLink') }}</span>
              </span>
            </span>
          </button>
        </div>
      </section>

      <section class="db-panel" data-look-bases>
        <header>
          <h3>{{ t('dsh.lk.basesTitle') }}</h3>
          <span class="db-hm">{{ t('dsh.lk.basesHint') }}</span>
        </header>
        <div class="db-swatches" role="radiogroup" :aria-label="t('dsh.lk.basesTitle')">
          <button
            v-for="b in [...READING_BASES, { id: 'custom' as const, nameKey: 'dsh.lk.baseCustom', hex: draftCustomHex, surface: draftCustomHex, border: FALLBACK_BASE.border }]"
            :key="b.id"
            type="button"
            class="db-swatch"
            role="radio"
            :aria-checked="draftBase === b.id"
            :disabled="ro"
            :data-base="b.id"
            @click="!ro && (draftBase = b.id, touchModels())"
          >
            <span
              class="db-sq"
              :style="{
                background: b.id === 'custom' && !isValidHex ? FALLBACK_BASE.hex : b.hex,
                color: (b.id === 'dark' || (b.id === 'custom' && isDarkBase)) ? SKIN_PALETTES.reader.dark.text : SKIN_PALETTES.reader.light.text,
              }"
            >Aa</span>
            <b>{{ t(b.nameKey as MessageKey) }}</b>
            <small class="db-mono">{{ b.id === 'custom' ? draftCustomHex : b.hex }}</small>
          </button>
        </div>

        <div v-if="draftBase === 'custom'" class="db-frow one db-sep">
          <label for="db-custom-hex" class="db-fl">
            {{ t('dsh.lk.customHex') }}
            <small>{{ t('dsh.lk.customHexHint') }}</small>
          </label>
          <div class="db-fld db-color-field">
            <input
              id="db-custom-hex"
              v-model="draftCustomHex"
              class="db-in db-mono"
              style="max-width: 12em"
              maxlength="7"
              spellcheck="false"
              :disabled="ro"
              data-custom-hex-input
              @input="touchModels()"
            />
            <input
              type="color"
              class="db-color-picker"
              :value="isValidHex ? draftCustomHex : DEFAULT_CUSTOM_HEX"
              :aria-label="t('dsh.lk.pickColor')"
              :disabled="ro"
              @input="draftCustomHex = ($event.target as HTMLInputElement).value.toUpperCase(); touchModels()"
            />
            <span v-if="!isValidHex" class="db-err db-small">{{ t('dsh.lk.invalidHex') }}</span>
          </div>
        </div>

        <div class="db-tw db-sep" data-look-contrast-table>
          <table v-if="contrastRows" class="db-t">
            <thead>
              <tr>
                <th>{{ t('dsh.lk.colItem') }}</th>
                <th>{{ t('dsh.lk.colColor') }}</th>
                <th class="n">{{ t('dsh.lk.colContrast') }}</th>
                <th class="n">{{ t('dsh.lk.colReq') }}</th>
                <th>{{ t('dsh.lk.colResult') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in contrastRows" :key="r.key" :data-contrast-row="r.key">
                <td :data-l="t('dsh.lk.colItem')">{{ r.name }}</td>
                <td :data-l="t('dsh.lk.colColor')">
                  <span class="db-mono">
                    <span class="db-color-swatch-sm" :style="{ background: r.color }" aria-hidden="true"></span>
                    {{ r.color }}
                  </span>
                </td>
                <td :data-l="t('dsh.lk.colContrast')" class="n db-mono">{{ r.ratio.toFixed(1) }}:1</td>
                <td :data-l="t('dsh.lk.colReq')" class="n db-mono">≥ {{ r.minRatio }}:1</td>
                <td :data-l="t('dsh.lk.colResult')">
                  <span class="db-stat">
                    <span class="dm" :data-k="r.pass ? 'ok' : 'bad'" aria-hidden="true"></span>
                    <span :class="r.pass ? 'db-ok' : 'db-err'">{{ r.pass ? t('dsh.lk.pass') : t('dsh.lk.fail') }}</span>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="db-empty">
            <b>{{ t('dsh.lk.invalidHex') }}</b>
          </div>
        </div>

        <div class="db-pbody db-sep" data-look-mini-preview>
          <div class="db-muted db-small" style="margin-bottom: 8px">{{ t('dsh.lk.pvHeading') }}</div>
          <div class="db-pv-mini th-reader" :class="isDarkBase ? 'm-dark' : 'm-light'" :style="miniPreviewStyle">
            <div class="pv-bar">
              <b>{{ t('dsh.lk.pvSiteTitle') }}</b>
              <span>{{ t('dsh.lk.pvSiteSub') }}</span>
            </div>
            <div class="pv-bd">
              <h4 class="pv-h4">{{ t('dsh.lk.pvLectureTitle') }}</h4>
              <div class="pv-meta">
                <span class="pv-tag">{{ t('dsh.lk.pvGroupTag') }}</span>
                <span class="pv-danger-pill">{{ t('dsh.lk.pvDanger') }}</span>
              </div>
              <div class="pv-card">
                <b>{{ t('dsh.lk.pvCardTitle') }}</b>
                <span class="pv-muted">{{ t('dsh.lk.pvCardDesc') }}</span>
              </div>
              <a href="javascript:void(0)" class="pv-link" @click.prevent>{{ t('dsh.lk.pvNextLink') }}</a>
            </div>
          </div>
        </div>
      </section>

      <section class="db-panel" data-look-preview>
        <header><h3>{{ t('dsh.lk.previewTitle') }}</h3><span class="db-hm">{{ t('dsh.lk.previewHint') }}</span></header>
        <div class="db-pbody db-grid">
          <div class="db-skins" role="radiogroup" :aria-label="t('dsh.lk.skin')">
            <button v-for="th in themeList" :key="th.id" type="button" class="db-skinopt" role="radio" :aria-checked="activeTheme === th.id" :data-dashboard-theme-btn="th.id" @click="selectTheme(th.id)">
              <span class="db-stat"><span class="dm" :data-k="activeTheme === th.id ? 'ok' : 'off'" aria-hidden="true"></span>{{ th.id }}</span>
              <small>{{ th.id === 'reader' ? t('dsh.lk.readerShape') : th.id === 'datasheet' ? t('dsh.lk.datasheetShape') : th.label }}</small>
            </button>
          </div>
          <div class="db-btns" role="group" :aria-label="t('dsh.lk.mode')">
            <button type="button" class="db-btn sm" :aria-pressed="!isDark" @click="isDark = false">{{ t('dsh.lk.light') }}</button>
            <button type="button" class="db-btn sm" :aria-pressed="isDark" @click="isDark = true">{{ t('dsh.lk.dark') }}</button>
          </div>
          <div v-if="tints.length" class="db-btns" role="group" :aria-label="t('dsh.lk.tint')">
            <button
              v-for="tint in ['light', ...tints]"
              :key="tint"
              type="button"
              class="db-btn sm"
              :aria-pressed="activeTint === tint"
              :data-look-tint="tint"
              @click="selectTint(tint)"
            >{{ tintName(tint) }}</button>
          </div>
        </div>
      </section>

      <section class="db-panel" data-look-json>
        <header><h3>{{ t('dsh.lk.jsonTitle') }}</h3><span class="db-hm">{{ t('dsh.lk.jsonHint') }}</span></header>
        <div class="db-pbody db-grid">
          <textarea v-model="jsonInput" class="db-in" rows="4" :disabled="ro" :aria-label="t('dsh.lk.jsonTitle')" :placeholder="t('dsh.lk.jsonPlaceholder')"></textarea>
          <div class="db-btns">
            <button type="button" class="db-btn sm" :disabled="ro" @click="validateJson">{{ t('dsh.lk.jsonCheck') }}</button>
            <span v-if="jsonMsg" :class="jsonErr ? 'db-err' : 'db-ok'">{{ jsonMsg }}</span>
          </div>
        </div>
      </section>

      <div v-if="!ro" class="db-savebar" data-savebar="look">
        <span class="db-st" :class="{ 'db-err': !contrastOk || !!themeSaveStatus }" data-look-status>
          {{ !contrastOk ? firstContrastFailure : (themeSaveStatus || (themeDirty ? t('dsh.common.unsavedChanges') : themeSavedNote || t('dsh.common.allSaved'))) }}
        </span>
        <button type="button" class="db-btn" :disabled="!themeDirty" data-look-discard @click="discardTheme">{{ t('dsh.common.discard') }}</button>
        <button type="button" class="db-btn primary" :disabled="!themeDirty || !contrastOk || savingTheme" data-look-save @click="saveTheme">
          {{ savingTheme ? t('dsh.common.saving') : t('dsh.lk.saveTheme') }}
        </button>
      </div>
    </template>

    <template v-else>
      <section class="db-panel" data-look-modules>
        <header><h3>{{ t('dsh.lk.modulesTitle') }}</h3><span class="db-hm">{{ t('dsh.lk.modulesHint') }}</span></header>
        <div class="db-figs db-figs-in">
          <div v-for="m in modules" :key="m.id"><b><code>{{ m.adapter }}</code></b><span>{{ m.id }}</span></div>
        </div>
      </section>
      <section v-if="ro" class="db-panel">
        <div class="db-pbody db-muted">{{ t('dsh.lk.modulesOnline') }}</div>
      </section>
      <section v-else-if="!isDev" class="db-panel" data-look-online-settings>
        <header><h3>{{ t('dsh.lk.onlineSettingsTitle') }}</h3><span class="db-hm">{{ t('dsh.lk.onlineSettingsReservedHint') }}</span></header>
        <div class="db-grid">
          <div class="db-frow one">
            <label class="db-fl" for="lk-online-key">{{ t('dsh.lk.onlineSettingKey') }}</label>
            <div class="db-fld db-btns">
              <input id="lk-online-key" v-model="onlineSettingKey" class="db-in db-mono db-grow" type="text" data-look-setting-key />
              <button type="button" class="db-btn sm" :disabled="onlineSettingBusy" data-look-setting-load @click="loadOnlineSetting">{{ t('dsh.lk.onlineSettingLoad') }}</button>
            </div>
          </div>
          <div class="db-frow one">
            <label class="db-fl" for="lk-online-val">{{ t('dsh.lk.onlineSettingVal') }}</label>
            <div class="db-fld">
              <textarea id="lk-online-val" v-model="onlineSettingValue" class="db-in db-mono" rows="4" data-look-setting-val></textarea>
            </div>
          </div>
          <div class="db-pbody db-sep db-btns">
            <button type="button" class="db-btn primary sm" :disabled="onlineSettingBusy" data-look-setting-save @click="saveOnlineSettingKey">{{ t('dsh.lk.onlineSettingSave') }}</button>
            <span v-if="onlineSettingMsg" :class="onlineSettingErr ? 'db-err' : 'db-ok'" data-look-setting-msg>{{ onlineSettingMsg }}</span>
          </div>
        </div>
      </section>
      <section v-else class="db-panel" data-look-env>
        <header>
          <h3>{{ t('dsh.lk.envTitle') }}</h3>
          <span class="db-hm">
            {{ status?.ok ? t('dsh.lk.doctorOk', { n: status.warnings.length }) : t('dsh.lk.doctorFail', { n: status?.errors.length ?? 0 }) }}
            <button type="button" class="db-btn sm" :disabled="probing" @click="probe">{{ t('dsh.lk.probe') }}</button>
          </span>
        </header>
        <div v-if="status?.errors.length" class="db-errbox" role="alert"><div v-for="e in status.errors" :key="e">{{ e }}</div></div>
        <details v-for="g in groups" :key="g.module" class="db-mod" :data-mod="g.module" :open="openMods.has(g.module)" @toggle="($event.target as HTMLDetailsElement).open ? openMods.add(g.module) : openMods.delete(g.module)">
          <summary>
            <span class="db-mn">{{ g.module }}<span v-if="dirtyKeys(g.module).length" class="db-unsaved">{{ t('dsh.common.unsaved') }}</span></span>
            <span class="db-stat"><span class="dm" :data-k="g.inUse ? 'ok' : 'off'" aria-hidden="true"></span>{{ g.inUse ? t('dsh.lk.inUse') : t('dsh.lk.notInUse') }}</span>
            <span class="db-muted">{{ t('dsh.common.nItems', { n: g.settings.length }) }}</span>
          </summary>
          <div class="db-mb">
            <div v-for="s in g.settings" :key="s.key" class="db-vrow" :class="{ dirty: (edits[s.key] ?? '') !== '' }">
              <code>{{ s.key }}</code>
              <span class="db-stat"><span class="dm" :data-k="statusMark(s)" aria-hidden="true"></span>{{ statusText(s) }}</span>
              <input
                class="db-in"
                :type="s.kind === 'secret' ? 'password' : 'text'"
                autocomplete="new-password"
                :value="edits[s.key] ?? ''"
                :placeholder="s.kind === 'secret' ? t('dsh.lk.secretPlaceholder') : s.displayValue || s.key"
                :aria-label="t('dsh.lk.newValue', { key: s.key })"
                :data-env-input="s.key"
                @input="setEdit(s.key, ($event.target as HTMLInputElement).value)"
              />
              <small class="db-vdesc">{{ lang === 'en' ? s.descriptionEn : s.descriptionZh }}<span v-if="s.error" class="db-err"> · {{ s.error }}</span></small>
            </div>
            <div v-if="g.module === 'companion'" class="db-vrow">
              <span class="db-muted">{{ t('dsh.lk.limitsElsewhere') }}</span>
              <button type="button" class="db-btn sm" @click="emit('go', 'companion', 'usage')">{{ t('dsh.lk.toLimits') }}</button>
            </div>
            <div class="db-mfoot">
              <span class="db-st">{{ dirtyKeys(g.module).length ? t('dsh.lk.groupDirty') : t('dsh.lk.groupHint') }}</span>
              <button type="button" class="db-btn sm primary" :disabled="!dirtyKeys(g.module).length || savingMod === g.module" :data-env-save="g.module" @click="saveModule(g.module)">{{ t('dsh.lk.saveGroup') }}</button>
            </div>
          </div>
        </details>
      </section>
    </template>
  </div>
</template>
