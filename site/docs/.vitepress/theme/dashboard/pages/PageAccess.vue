<script setup lang="ts">
/**
 * PageAccess.vue — 课程组与讲义: every course group, its lectures and who can read it (the `access` block of site.config.ts),
 * and the gateway rules `npm run auth:export` writes. Changing a tier is an edit of site.config.ts (recipes §6): the
 * Dashboard shows the result but does not rewrite a TypeScript file.
 */
import { computed, ref } from 'vue'
import { useData } from 'vitepress'
import { useT } from '../../../i18n/useT.ts'
import type { DevAccessSummary } from '../../api/devDashboard'
import DbHead from '../DbHead.vue'
import DbUnavailable from '../DbUnavailable.vue'
import { isReadOnly, say } from '../useDashboard'
import type { DashGroup } from '../dashboardData'

const props = defineProps<{ access: DevAccessSummary | null; autheliaPreview: string }>()
const { t } = useT()
const { theme } = useData<{ groups?: DashGroup[] }>()
const groups = computed<DashGroup[]>(() => (Array.isArray(theme.value?.groups) ? theme.value.groups : []))

function readOf(id: string): DevAccessSummary['groups'][number] | null {
  return props.access?.groups.find((g) => g.id === id) ?? null
}
function tierText(read: 'public' | 'authenticated' | string[]): string {
  if (read === 'public') return t('dsh.ac.public')
  if (read === 'authenticated') return t('dsh.ac.login')
  return t('dsh.ac.groupsTier', { names: read.join(', ') })
}
function tierKind(read: 'public' | 'authenticated' | string[]): 'public' | 'login' | 'acl' {
  return read === 'public' ? 'public' : read === 'authenticated' ? 'login' : 'acl'
}
const counts = computed(() => {
  const c = { public: 0, login: 0, acl: 0 }
  for (const g of groups.value) {
    const r = readOf(g.id)
    if (r) c[tierKind(r.read)]++
  }
  return c
})
const copied = ref(false)
async function copyRules(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.autheliaPreview)
    copied.value = true
    say(t('dsh.ac.copied'))
    setTimeout(() => (copied.value = false), 1800)
  } catch {
    say(t('dsh.common.copyFailed'))
  }
}
</script>

<template>
  <div class="db-page" data-page="access">
    <DbHead :title="t('dsh.nav.access')" :lead="t('dsh.ac.lead')" :meta="access ? [[t('dsh.common.file'), access.configFile]] : []" />

    <div v-if="access" class="db-figs">
      <div><b>{{ counts.public }}</b><span>{{ t('dsh.ac.public') }}</span><small>{{ t('dsh.ac.publicHint') }}</small></div>
      <div><b>{{ counts.login }}</b><span>{{ t('dsh.ac.login') }}</span></div>
      <div><b>{{ counts.acl }}</b><span>{{ t('dsh.ac.acl') }}</span></div>
      <div><b>{{ access.enforcement === 'gateway' ? t('dsh.ac.gatewayYes') : t('dsh.ac.gatewayNo') }}</b><span>{{ t('dsh.ac.enforcement') }}</span><small>{{ t('dsh.ac.defaultIs', { tier: tierText(access.default) }) }}</small></div>
    </div>

    <section class="db-panel" data-access-groups>
      <header><h3>{{ t('dsh.ac.groupsTitle') }}</h3><span class="db-hm">{{ t('dsh.ac.groupsHint', { n: groups.length }) }}</span></header>
      <div class="db-tw">
        <table class="db-t">
          <thead><tr><th>{{ t('dsh.ac.colGroup') }}</th><th>{{ t('dsh.ac.colLectures') }}</th><th>{{ t('dsh.ac.colCharts') }}</th><th>{{ t('dsh.ac.colTier') }}</th></tr></thead>
          <tbody>
            <tr v-for="g in groups" :key="g.id" :data-access-group="g.id">
              <td :data-l="t('dsh.ac.colGroup')" class="nl"><span class="db-id">{{ g.id }}</span> {{ g.title }}</td>
              <td :data-l="t('dsh.ac.colLectures')" class="n">{{ g.lectureCount ?? 0 }}</td>
              <td :data-l="t('dsh.ac.colCharts')" class="n">{{ g.chartCount ?? 0 }}</td>
              <td :data-l="t('dsh.ac.colTier')">
                <span v-if="readOf(g.id)" class="db-rov"><span class="db-lock" aria-hidden="true"></span>{{ tierText(readOf(g.id)!.read) }}<span v-if="!readOf(g.id)!.own" class="db-muted"> · {{ t('dsh.ac.byDefault') }}</span></span>
                <span v-else class="db-muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="db-pbody db-sep">
        <DbUnavailable id="access-edit" :what="t('dsh.ac.editWhat')" :why="isReadOnly ? t('dsh.ac.editOnlineWhy') : t('dsh.ac.editWhy')" />
      </div>
    </section>

    <section class="db-panel" data-access-rules>
      <header>
        <h3>{{ t('dsh.ac.rulesTitle') }}</h3>
        <span class="db-hm"><code>npm run auth:export</code> <button v-if="autheliaPreview" type="button" class="db-btn sm" @click="copyRules">{{ copied ? t('dsh.ac.copied') : t('dsh.ac.copy') }}</button></span>
      </header>
      <div v-if="autheliaPreview" class="db-pbody"><pre class="db-codeb" data-access-preview>{{ autheliaPreview }}</pre></div>
      <DbUnavailable v-else id="access-rules" :what="t('dsh.ac.rulesTitle')" :why="t('dsh.ac.rulesOnlineWhy')" />
    </section>
  </div>
</template>
