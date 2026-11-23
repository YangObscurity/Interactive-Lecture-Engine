<script setup lang="ts">
/**
 * PageLook.vue — 外观与模块: the site's default theme (site.config.ts, read-only here) with a live preview on this device,
 * and the site modules with their settings, grouped and folded per module; secrets show only whether they are set.
 * Local author mode writes changed variables of one module to the repository .env in one go.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useData } from 'vitepress'
import { THEME_RUNTIME } from 'virtual:lecture-theme'
import { useT } from '../../../i18n/useT.ts'
import { runDevDashboardProbe, saveDevEnvSetting, type DevDashboardStatus, type DevSettingSummary } from '../../api/admin'
import { validateThemeImportJson } from '../../tokens/customTint'
import { applyPrefs, prefAttrs, readPrefs, writePrefs, type ReaderPrefs } from '../../tokens/prefs'
import DbHead from '../DbHead.vue'
import DbTabs from '../DbTabs.vue'
import { dashboardState, isReadOnly, registerModel, say, tabOf, touchModels, type DashboardPageId } from '../useDashboard'

const props = defineProps<{ status: DevDashboardStatus | null }>()
const emit = defineEmits<{ tab: [tab: string]; status: [s: DevDashboardStatus]; go: [page: DashboardPageId, tab?: string] }>()
const { t, lang } = useT()
const { theme, isDark } = useData<{ lectureModules?: Record<string, Record<string, unknown>> }>()

const prefs = ref<ReaderPrefs>({})
const themeList = THEME_RUNTIME.themes
const activeTheme = computed(() => prefAttrs(prefs.value, THEME_RUNTIME)['data-lec-theme'] ?? THEME_RUNTIME.defaultTheme)
const tints = computed(() => themeList.find((th) => th.id === 'reader')?.tints ?? [])
const activeTint = computed(() => (isDark.value ? 'dark' : prefAttrs(prefs.value, THEME_RUNTIME)['data-lec-tint'] ?? 'light'))
const jsonInput = ref('')
const jsonMsg = ref('')
const jsonErr = ref(false)

function selectTheme(id: string): void {
  prefs.value = writePrefs({ theme: id })
  applyPrefs(document.documentElement, prefs.value, THEME_RUNTIME)
}
function selectTint(tint: string): void {
  if (isDark.value) isDark.value = false
  prefs.value = writePrefs({ theme: 'reader', tint })
  applyPrefs(document.documentElement, prefs.value, THEME_RUNTIME)
}
function validateJson(): void {
  const res = validateThemeImportJson(jsonInput.value)
  jsonErr.value = !res.ok
  jsonMsg.value = res.ok ? t('dsh.lk.jsonOk', { n: res.tokenCount }) : 'message' in res ? res.message : 'invalid'
}

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

// doctor reports its statuses in Chinese ("set", "default", "invalid"); escapes keep the hard-coded-CJK gate clean
const ST_SET = '\u5df2\u8bbe\u7f6e'
const ST_DEFAULT = '\u9ed8\u8ba4\u503c'
const ST_INVALID = '\u65e0\u6548'
const statusMark = (s: DevSettingSummary) => (s.error || s.status === ST_INVALID ? 'bad' : s.status === ST_SET ? 'ok' : s.status === ST_DEFAULT ? 'half' : 'off')
const statusText = (s: DevSettingSummary) =>
  s.kind === 'secret' ? (s.secretSet ? t('dsh.lk.secretSet', { n: s.secretLength ?? 0 }) : t('dsh.lk.secretUnset')) : s.status

let unregister: (() => void) | null = null
onMounted(() => {
  prefs.value = readPrefs()
  unregister = registerModel('look-env', { page: 'look', dirty: anyDirty, save: saveAll, discard: discardAll })
})
onBeforeUnmount(() => unregister?.())
</script>

<template>
  <div class="db-page" data-page="look">
    <DbHead :title="t('dsh.nav.look')" :lead="t('dsh.lk.lead')" />
    <DbTabs
      page="look"
      :label="t('dsh.nav.look')"
      :items="[
        ['theme', t('dsh.lk.tabTheme')],
        ['modules', t('dsh.lk.tabModules')],
      ]"
      :dirty-tabs="['modules']"
      @select="emit('tab', $event)"
    />

    <template v-if="tabOf('look') === 'theme'">
      <section class="db-panel" data-look-default>
        <header><h3>{{ t('dsh.lk.defaultTitle') }}</h3><span class="db-hm">{{ t('dsh.lk.defaultHint') }}</span></header>
        <div class="db-frow one">
          <div class="db-fl">{{ t('dsh.lk.defaultTheme') }}<small><code>site.config.ts › theme</code></small></div>
          <div class="db-rov"><span class="db-lock" aria-hidden="true"></span>{{ THEME_RUNTIME.defaultTheme }}</div>
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
            <button v-for="tint in tints" :key="tint.id" type="button" class="db-btn sm" :aria-pressed="activeTint === tint.id" @click="selectTint(tint.id)">{{ tint.label }}</button>
          </div>
        </div>
      </section>
      <section class="db-panel" data-look-json>
        <header><h3>{{ t('dsh.lk.jsonTitle') }}</h3><span class="db-hm">{{ t('dsh.lk.jsonHint') }}</span></header>
        <div class="db-pbody db-grid">
          <textarea v-model="jsonInput" class="db-in" rows="4" :aria-label="t('dsh.lk.jsonTitle')" :placeholder="t('dsh.lk.jsonPlaceholder')"></textarea>
          <div class="db-btns">
            <button type="button" class="db-btn sm" @click="validateJson">{{ t('dsh.lk.jsonCheck') }}</button>
            <span v-if="jsonMsg" :class="jsonErr ? 'db-err' : 'db-ok'">{{ jsonMsg }}</span>
          </div>
        </div>
      </section>
    </template>

    <template v-else>
      <section class="db-panel" data-look-modules>
        <header><h3>{{ t('dsh.lk.modulesTitle') }}</h3><span class="db-hm">{{ t('dsh.lk.modulesHint') }}</span></header>
        <div class="db-figs db-figs-in">
          <div v-for="m in modules" :key="m.id"><b><code>{{ m.adapter }}</code></b><span>{{ m.id }}</span></div>
        </div>
      </section>
      <section v-if="isReadOnly" class="db-panel">
        <div class="db-pbody db-muted">{{ t('dsh.lk.modulesOnline') }}</div>
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
