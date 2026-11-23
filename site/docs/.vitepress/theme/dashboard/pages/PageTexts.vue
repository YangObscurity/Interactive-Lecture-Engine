<script setup lang="ts">
/**
 * PageTexts.vue — 站点文案: name, short name, top-bar text, tagline and home description in both languages. Facts only.
 * The template ships every field empty; grey hints are placeholders, never values. Under each field name: what happens when
 * it stays empty (the same rules the build applies, site-texts-schema.ts), and a preview shows the result.
 * Online: the built values, read-only.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useData } from 'vitepress'
import { useT } from '../../../i18n/useT.ts'
import type { MessageKey } from '../../../i18n/index.ts'
import { saveDevSiteTexts } from '../../api/admin'
import {
  FIELD_LIMITS,
  REQUIRED_FIELDS,
  SITE_TEXT_FIELDS,
  SITE_TEXT_HINTS,
  emptySiteTexts,
  resolveLocaleTexts,
  validateSiteTexts,
  type SiteTextField,
  type SiteTexts,
  type TextIssue,
  type TextsLocale,
} from '../../../site-texts-schema.ts'
import DbHead from '../DbHead.vue'
import PlaceholderEditor from '../PlaceholderEditor.vue'
import { PLACEHOLDER_SETS } from '../placeholders'
import { dashboardState, isReadOnly, registerModel, say, touchModels } from '../useDashboard'

const props = defineProps<{ texts: SiteTexts | null }>()
const emit = defineEmits<{ saved: [texts: SiteTexts] }>()
const { t } = useT()
const { theme } = useData<{ siteMeta?: { name?: string; shortName?: string; text?: string; tagline?: string; description?: string; i18n?: { en?: Record<string, string> } }; totals?: { lectures?: number } }>()

const LOCALES: readonly TextsLocale[] = ['zh', 'en']
const FIELD_KEYS: Record<SiteTextField, { label: MessageKey; where: MessageKey; rule: MessageKey }> = {
  name: { label: 'dsh.tx.name', where: 'dsh.tx.nameWhere', rule: 'dsh.tx.nameRule' },
  shortName: { label: 'dsh.tx.short', where: 'dsh.tx.shortWhere', rule: 'dsh.tx.shortRule' },
  navText: { label: 'dsh.tx.nav', where: 'dsh.tx.navWhere', rule: 'dsh.tx.navRule' },
  tagline: { label: 'dsh.tx.tagline', where: 'dsh.tx.taglineWhere', rule: 'dsh.tx.taglineRule' },
  description: { label: 'dsh.tx.desc', where: 'dsh.tx.descWhere', rule: 'dsh.tx.descRule' },
}

const clone = (x: SiteTexts): SiteTexts => JSON.parse(JSON.stringify(x)) as SiteTexts
const saved = ref<SiteTexts>(clone(props.texts ?? emptySiteTexts()))
const form = ref<SiteTexts>(clone(saved.value))
const previewLang = ref<TextsLocale>('zh')
const showDiff = ref(false)
const saving = ref(false)
const feedback = ref('')
const feedbackError = ref(false)

/** Online: what the build used (`themeConfig.siteMeta`), mapped back onto the five fields. */
const onlineTexts = computed<SiteTexts>(() => {
  const m = theme.value?.siteMeta ?? {}
  const en = m.i18n?.en ?? {}
  return {
    zh: { name: m.name ?? '', shortName: m.shortName ?? '', navText: m.text ?? '', tagline: m.tagline ?? '', description: m.description ?? '' },
    en: { name: en.name ?? '', shortName: en.shortName ?? '', navText: en.text ?? '', tagline: en.tagline ?? '', description: en.description ?? '' },
  }
})
const shown = computed(() => (isReadOnly.value ? onlineTexts.value : form.value))

const diffs = computed(() => {
  const out: Array<{ key: string; from: string; to: string }> = []
  for (const loc of LOCALES) for (const f of SITE_TEXT_FIELDS) if (saved.value[loc][f] !== form.value[loc][f]) out.push({ key: `${loc}.${f}`, from: saved.value[loc][f], to: form.value[loc][f] })
  return out
})
const dirty = computed(() => diffs.value.length > 0)

function issueText(issue: TextIssue): string {
  const field = issue.field ? t(FIELD_KEYS[issue.field].label) : ''
  const where = issue.locale ? `${issue.locale === 'zh' ? t('dsh.common.zh') : 'English'} · ${field}` : field
  if (issue.code === 'required') return t('dsh.tx.errRequired', { field: where })
  if (issue.code === 'too_long') return t('dsh.tx.errTooLong', { field: where, max: String(issue.detail ?? '') })
  if (issue.code === 'unknown_token') return t('dsh.tx.errToken', { field: where, token: String(issue.detail ?? '') })
  return t('dsh.tx.errShape', { field: where })
}
const errors = computed(() => validateSiteTexts(form.value).issues.map(issueText))

function setField(loc: TextsLocale, f: SiteTextField, v: string): void {
  form.value[loc][f] = v
  feedback.value = ''
  touchModels()
}

async function save(): Promise<boolean> {
  if (!dirty.value || errors.value.length || !dashboardState.token) return false
  saving.value = true
  try {
    const res = await saveDevSiteTexts(dashboardState.token, form.value)
    if (res.ok && res.texts) {
      saved.value = clone(res.texts)
      form.value = clone(res.texts)
      feedback.value = t('dsh.tx.saved')
      feedbackError.value = false
      say(t('dsh.tx.saved'))
      emit('saved', res.texts)
      touchModels()
      return true
    }
    feedback.value = t('dsh.tx.saveErr', { error: res.errors?.join(', ') || res.error || 'unknown' })
    feedbackError.value = true
    return false
  } finally {
    saving.value = false
  }
}
function discard(): void {
  form.value = clone(saved.value)
  showDiff.value = false
  touchModels()
}

let unregister: (() => void) | null = null
onMounted(() => {
  unregister = registerModel('texts', { page: 'texts', dirty: () => dirty.value, save, discard })
})
onBeforeUnmount(() => unregister?.())

const lectures = computed(() => theme.value?.totals?.lectures ?? 0)
const pv = computed(() => {
  const r = resolveLocaleTexts(shown.value[previewLang.value])
  return { ...r, description: r.description.replace(/\{lectures\}/g, String(lectures.value)), rawShort: shown.value[previewLang.value].shortName.trim() }
})
const rules = computed(() => {
  const b = shown.value[previewLang.value]
  const has = (f: SiteTextField) => b[f].trim() !== ''
  return [
    { k: has('name') ? 'ok' : 'bad', text: has('name') ? t('dsh.tx.pvNameOk') : t('dsh.tx.nameRule') },
    { k: has('shortName') ? 'ok' : 'off', text: has('shortName') ? t('dsh.tx.pvShortOk') : t('dsh.tx.shortRule') },
    { k: has('navText') ? 'ok' : 'off', text: has('navText') ? t('dsh.tx.pvNavOk') : t('dsh.tx.navRule') },
    { k: has('tagline') ? 'ok' : 'off', text: has('tagline') ? t('dsh.tx.pvTaglineOk') : t('dsh.tx.taglineRule') },
    { k: has('description') ? 'ok' : 'off', text: has('description') ? t('dsh.tx.pvDescOk') : has('tagline') ? t('dsh.tx.descRule') : t('dsh.tx.pvDescNone') },
  ]
})
</script>

<template>
  <div class="db-page" data-page="texts" data-dashboard-pane-texts>
    <DbHead :title="t('dsh.nav.texts')" :lead="t('dsh.tx.lead')" :meta="isReadOnly ? [] : [[t('dsh.common.file'), 'site-texts.json']]" />
    <div class="db-banner"><span class="db-info" aria-hidden="true"></span><span>{{ isReadOnly ? t('dsh.tx.bannerOnline') : t('dsh.tx.banner') }}</span></div>

    <section class="db-panel" data-texts-panel>
      <header><h3>{{ t('dsh.tx.panel') }}</h3></header>
      <div class="db-fhead"><span></span><span>{{ t('dsh.common.zh') }}</span><span>English</span></div>
      <div v-for="f in SITE_TEXT_FIELDS" :key="f" class="db-frow" :data-texts-row="f">
        <div class="db-fl">
          {{ t(FIELD_KEYS[f].label) }}<span v-if="REQUIRED_FIELDS.includes(f)" class="db-req"> *</span>
          <small>{{ t(FIELD_KEYS[f].where) }}</small>
          <small>{{ t(FIELD_KEYS[f].rule) }}</small>
        </div>
        <div v-for="loc in LOCALES" :key="loc" class="db-fld" :class="{ dirty: !isReadOnly && saved[loc][f] !== form[loc][f] }" :data-lang="loc === 'zh' ? t('dsh.common.zh') : 'English'">
          <PlaceholderEditor
            v-if="f === 'description'"
            :id="`db-texts-${loc}-${f}`"
            :model-value="shown[loc][f]"
            :names="PLACEHOLDER_SETS.texts"
            :label="`${t(FIELD_KEYS[f].label)} (${loc})`"
            :max="FIELD_LIMITS[f]"
            :hint="SITE_TEXT_HINTS[loc][f]"
            :readonly="isReadOnly"
            :empty-text="t('dsh.tx.descRule')"
            small
            :data-texts-input="`${loc}.${f}`"
            @update:model-value="setField(loc, f, $event)"
          />
          <div v-else-if="isReadOnly" class="pe-ro" :class="{ empty: !shown[loc][f].trim() }" :data-texts-value="`${loc}.${f}`">
            <span class="db-lock" aria-hidden="true"></span><span>{{ shown[loc][f].trim() || t('dsh.common.notFilled') }}</span>
          </div>
          <template v-else>
            <input
              :id="`db-texts-${loc}-${f}`"
              class="db-in"
              type="text"
              :value="form[loc][f]"
              :placeholder="SITE_TEXT_HINTS[loc][f]"
              :aria-label="`${t(FIELD_KEYS[f].label)} (${loc})`"
              :data-texts-input="`${loc}.${f}`"
              :aria-invalid="form[loc][f].length > FIELD_LIMITS[f] ? 'true' : undefined"
              @input="setField(loc, f, ($event.target as HTMLInputElement).value)"
            />
            <span class="db-meta" :data-texts-rule="`${loc}.${f}`">
              <span v-if="!form[loc][f].trim() && REQUIRED_FIELDS.includes(f)" class="db-err"><span class="dm" data-k="bad" aria-hidden="true"></span>{{ t('dsh.common.requiredEmpty') }}</span>
              <span v-else-if="!form[loc][f].trim()" class="db-muted"><span class="dm" data-k="off" aria-hidden="true"></span>{{ t('dsh.common.notFilled') }} · {{ t(FIELD_KEYS[f].rule) }}</span>
              <span v-if="form[loc][f].length > FIELD_LIMITS[f]" class="db-err" data-texts-over><span class="dm" data-k="bad" aria-hidden="true"></span>{{ t('dsh.common.overLimit') }}</span>
              <span class="pe-count" :class="{ 'db-err': form[loc][f].length > FIELD_LIMITS[f] }">{{ form[loc][f].length }} / {{ FIELD_LIMITS[f] }}</span>
            </span>
          </template>
        </div>
      </div>
      <div v-if="!isReadOnly && errors.length" class="db-pbody db-err" data-texts-errors>
        <p>{{ t('dsh.tx.errTitle') }}</p>
        <ul><li v-for="e in errors" :key="e">{{ e }}</li></ul>
      </div>
      <div v-if="!isReadOnly && showDiff" class="db-pbody db-sep" data-texts-diff-panel>
        <p v-if="!diffs.length" class="db-muted" data-texts-diff-none>{{ t('dsh.common.noChanges') }}</p>
        <div v-else class="db-tw">
          <table class="db-t" data-texts-diff-table>
            <thead><tr><th>{{ t('dsh.tx.field') }}</th><th>{{ t('dsh.common.before') }}</th><th>{{ t('dsh.common.after') }}</th></tr></thead>
            <tbody>
              <tr v-for="d in diffs" :key="d.key"><td><code>{{ d.key }}</code></td><td><del>{{ d.from }}</del></td><td><ins>{{ d.to }}</ins></td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div v-if="!isReadOnly" class="db-savebar" data-savebar="texts">
        <span class="db-st" :class="{ 'db-err': feedbackError }" data-texts-feedback>{{ feedback || (dirty ? t('dsh.common.nChanged', { n: diffs.length }) : t('dsh.common.allSaved')) }}</span>
        <button type="button" class="db-btn" :disabled="!dirty" data-texts-discard @click="discard">{{ t('dsh.common.discard') }}</button>
        <button type="button" class="db-btn" :aria-pressed="showDiff" data-texts-preview @click="showDiff = !showDiff">{{ t('dsh.common.previewChanges') }}</button>
        <button type="button" class="db-btn primary" :disabled="!dirty || errors.length > 0 || saving" data-texts-save-btn @click="save">{{ saving ? t('dsh.common.saving') : t('dsh.tx.save') }}</button>
      </div>
    </section>

    <section class="db-panel" data-texts-preview-panel>
      <header><h3>{{ t('dsh.tx.pvTitle') }}</h3><span class="db-hm">{{ t('dsh.tx.pvHint') }}</span></header>
      <div class="db-pbody">
        <div class="db-tabs in" role="tablist" :aria-label="t('dsh.tx.pvLang')">
          <button v-for="loc in LOCALES" :key="loc" type="button" role="tab" :aria-selected="previewLang === loc" :data-texts-locale="loc" @click="previewLang = loc">{{ loc === 'zh' ? t('dsh.common.zh') : 'English' }}</button>
        </div>
      </div>
      <div class="db-pvset">
        <div>
          <div class="db-muted db-small">{{ t('dsh.tx.pvDesktop') }}</div>
          <div class="db-pv" data-texts-pv="desktop">
            <div class="db-pv-bar"><b>{{ pv.name || t('dsh.tx.pvNoName') }}</b><span v-if="pv.navText">{{ pv.navText }}</span></div>
            <div class="db-pv-bd">
              <h4>{{ pv.name || t('dsh.tx.pvNoName') }}</h4>
              <div v-if="pv.tagline" class="db-pv-tag">{{ pv.tagline }}</div>
              <div v-if="pv.description" class="db-pv-d">{{ pv.description }}</div>
            </div>
          </div>
        </div>
        <div>
          <div class="db-muted db-small">{{ t('dsh.tx.pvPhone') }}</div>
          <div class="db-pv db-pv-phone" data-texts-pv="phone">
            <div class="db-pv-bar"><b>{{ pv.rawShort || pv.name || t('dsh.tx.pvNoName') }}</b></div>
            <div class="db-pv-bd"><div class="db-pv-d">{{ pv.description ? pv.description.slice(0, 40) + (pv.description.length > 40 ? '…' : '') : t('dsh.tx.pvNoDesc') }}</div></div>
          </div>
        </div>
      </div>
      <div class="db-rules">
        <span v-for="(r, i) in rules" :key="i" class="db-stat"><span class="dm" :data-k="r.k" aria-hidden="true"></span>{{ r.text }}</span>
      </div>
    </section>
  </div>
</template>
