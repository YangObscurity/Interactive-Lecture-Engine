<script setup lang="ts">
/**
 * PageRuntime.vue — 运行状态: what is running and what went wrong. Process states on top; the terminal log (local: the
 * dev server and the content sync, redacted before they were stored; online: lecture-api only, which needs a log endpoint
 * lecture-api does not have yet) and the health checks. Read-only: nothing runs from here.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import type { AdminHealthResponse } from '../../api/admin'
import { fetchDevLogs, fetchRuntime, type DevLogLine, type RuntimePayload } from '../../api/devDashboard'
import DbHead from '../DbHead.vue'
import DbTabs from '../DbTabs.vue'
import DbUnavailable from '../DbUnavailable.vue'
import { dashboardState, isReadOnly, tabOf } from '../useDashboard'
import { shortDateTime } from '../dashboardData'

defineProps<{ health: AdminHealthResponse | null; healthError: string }>()
const emit = defineEmits<{ tab: [tab: string] }>()
const { t } = useT()

const runtime = ref<RuntimePayload | null>(null)
const lines = ref<DevLogLine[]>([])
const last = ref(0)
const clearedAt = ref(0)
const filter = reactive({ src: 'all' as 'all' | DevLogLine['src'], q: '', lv: { info: true, warn: true, err: true } as Record<DevLogLine['lv'], boolean> })
const follow = ref(true)
const paused = ref(false)
const term = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const SOURCES: ReadonlyArray<DevLogLine['src']> = ['dev', 'sync', 'build', 'api']
const srcLabel = (s: DevLogLine['src']) => (s === 'dev' ? t('dsh.rt.srcDev') : s === 'sync' ? t('dsh.rt.srcSync') : s === 'build' ? t('dsh.rt.srcBuild') : 'lecture-api')
const visible = computed(() =>
  lines.value.filter((l) => l.seq > clearedAt.value && (filter.src === 'all' || l.src === filter.src) && filter.lv[l.lv] && (!filter.q.trim() || l.msg.includes(filter.q.trim()))),
)
/** The newest content-sync line of this dev server (sync tab). */
const lastSync = computed(() => [...lines.value].reverse().find((l) => l.src === 'sync') ?? null)

async function poll(): Promise<void> {
  if (paused.value || dashboardState.mode !== 'dev') return
  const res = await fetchDevLogs(dashboardState.token, last.value)
  if (!res) return
  if (res.lines.length) {
    lines.value = [...lines.value, ...res.lines].slice(-500)
    last.value = res.last
    if (follow.value) {
      await nextTick()
      if (term.value) term.value.scrollTop = term.value.scrollHeight
    }
  } else last.value = res.last
}

watch(follow, async (on) => {
  if (on) {
    await nextTick()
    if (term.value) term.value.scrollTop = term.value.scrollHeight
  }
})

const time = (iso: string) => {
  const d = new Date(iso)
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

const procs = computed(() => {
  const p = runtime.value?.processes
  if (!p) return []
  return [
    { name: t('dsh.rt.srcDev'), k: 'ok', st: t('dsh.rt.running'), d: typeof location !== 'undefined' ? location.host : '' },
    { name: t('dsh.rt.srcSync'), k: p.contentWatch === 'watching' ? 'ok' : 'off', st: p.contentWatch === 'watching' ? t('dsh.rt.watching') : p.contentWatch === 'in-place' ? t('dsh.rt.inPlace') : t('dsh.rt.watchOff'), d: '' },
    { name: t('dsh.rt.lastBuild'), k: p.lastBuild ? 'ok' : 'off', st: p.lastBuild ? shortDateTime(p.lastBuild) : t('dsh.rt.never'), d: 'npm run build' },
    { name: 'lecture-api', k: p.lectureApi.up ? 'ok' : 'off', st: p.lectureApi.up ? t('dsh.rt.running') : t('dsh.rt.notRunning'), d: `127.0.0.1:${p.lectureApi.port}` },
  ]
})

onMounted(async () => {
  if (dashboardState.mode !== 'dev') return
  runtime.value = await fetchRuntime()
  await poll()
  timer = setInterval(() => void poll(), 1500)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
const statusText = (s: string) => (s === 'ok' ? t('dsh.rt.ok') : s === 'off' || s === 'disabled' ? t('dsh.rt.off') : s === 'degraded' ? t('dsh.rt.degraded') : t('dsh.rt.down'))
const statusMark = (s: string) => (s === 'ok' ? 'ok' : s === 'off' || s === 'disabled' ? 'off' : s === 'degraded' ? 'warn' : 'bad')
</script>

<template>
  <div class="db-page" data-page="runtime">
    <DbHead :title="t('dsh.nav.runtime')" :lead="t('dsh.rt.lead')" :meta="[[t('dsh.rt.env'), isReadOnly ? t('dsh.rt.online') : t('dsh.rt.local')]]" />

    <div v-if="!isReadOnly" class="db-procs" data-runtime-procs>
      <div v-for="p in procs" :key="p.name"><b>{{ p.name }}</b><span class="db-stat"><span class="dm" :data-k="p.k" aria-hidden="true"></span>{{ p.st }}</span><span class="db-mono">{{ p.d }}</span></div>
    </div>
    <div v-else-if="health" class="db-procs" data-runtime-procs>
      <div><b>lecture-api</b><span class="db-stat"><span class="dm" :data-k="health.ok ? 'ok' : 'bad'" aria-hidden="true"></span>{{ health.ok ? t('dsh.rt.running') : t('dsh.rt.down') }}</span><span class="db-mono">{{ t('dsh.rt.uptime', { h: Math.floor(health.uptimeSeconds / 3600) }) }}</span></div>
      <div><b>{{ t('dsh.rt.db') }}</b><span class="db-stat"><span class="dm" :data-k="statusMark(health.checks.db.status)" aria-hidden="true"></span>{{ statusText(health.checks.db.status) }}</span><span class="db-mono">{{ health.runtime.dbKind }}</span></div>
      <div><b>{{ t('dsh.rt.ai') }}</b><span class="db-stat"><span class="dm" :data-k="statusMark(health.checks.ai.status)" aria-hidden="true"></span>{{ statusText(health.checks.ai.status) }}</span><span class="db-mono">{{ health.checks.ai.provider }}</span></div>
      <div><b>Notion</b><span class="db-stat"><span class="dm" :data-k="health.checks.notion.configured ? statusMark(health.checks.notion.status) : 'off'" aria-hidden="true"></span>{{ health.checks.notion.configured ? statusText(health.checks.notion.status) : t('dsh.rt.off') }}</span><span></span></div>
    </div>

    <DbTabs
      page="runtime"
      :label="t('dsh.nav.runtime')"
      :items="[
        ['logs', t('dsh.rt.tabLogs')],
        ['sync', t('dsh.rt.tabSync')],
        ['health', t('dsh.rt.tabHealth')],
      ]"
      @select="emit('tab', $event)"
    />

    <template v-if="tabOf('runtime') === 'sync'">
      <section class="db-panel" data-runtime-sync>
        <header><h3>{{ t('dsh.rt.syncTitle') }}</h3><span class="db-hm">{{ t('dsh.rt.syncHint') }}</span></header>
        <DbUnavailable v-if="isReadOnly" id="sync-online" :what="t('dsh.rt.syncTitle')" :why="t('dsh.rt.logsOnlineWhy')" />
        <div v-else class="db-pbody">
          <dl class="db-kv">
            <dt>{{ t('dsh.rt.syncMode') }}</dt>
            <dd>{{ runtime?.processes.contentWatch === 'in-place' ? t('dsh.rt.inPlace') : 'content/ → site/docs/' }}</dd>
            <dt>{{ t('dsh.rt.syncWatch') }}</dt>
            <dd><span class="db-stat"><span class="dm" :data-k="runtime?.processes.contentWatch === 'watching' ? 'ok' : 'off'" aria-hidden="true"></span>{{ runtime?.processes.contentWatch === 'watching' ? t('dsh.rt.watching') : runtime?.processes.contentWatch === 'in-place' ? t('dsh.rt.inPlace') : t('dsh.rt.watchOff') }}</span></dd>
            <dt>{{ t('dsh.rt.syncLast') }}</dt>
            <dd data-runtime-sync-last>{{ lastSync ? `${time(lastSync.t)} · ${lastSync.msg}` : t('dsh.rt.syncNone') }}</dd>
            <dt>{{ t('dsh.rt.syncCmd') }}</dt>
            <dd><code>npm run content:sync</code></dd>
          </dl>
        </div>
      </section>
      <section class="db-panel" data-runtime-index>
        <header><h3>{{ t('dsh.rt.indexTitle') }}</h3></header>
        <div class="db-pbody"><DbUnavailable id="index" :what="t('dsh.rt.indexWhat')" :why="t('dsh.rt.indexWhy')" /></div>
      </section>
    </template>

    <section v-else-if="tabOf('runtime') === 'logs'" class="db-panel" data-runtime-logs>
      <DbUnavailable v-if="isReadOnly" id="logs" :what="t('dsh.rt.logsOnlineWhat')" :why="t('dsh.rt.logsOnlineWhy')" />
      <template v-else>
        <div class="db-logbar">
          <div class="db-tabs" role="tablist" :aria-label="t('dsh.rt.logSource')">
            <button type="button" role="tab" :aria-selected="filter.src === 'all'" data-log-src="all" @click="filter.src = 'all'">{{ t('dsh.rt.all') }}</button>
            <button v-for="s in SOURCES" :key="s" type="button" role="tab" :aria-selected="filter.src === s" :data-log-src="s" @click="filter.src = s">{{ srcLabel(s) }}</button>
          </div>
          <div class="db-btns" role="group" :aria-label="t('dsh.rt.levels')">
            <label class="db-ck"><input v-model="filter.lv.info" type="checkbox" data-log-lv="info" />{{ t('dsh.rt.lvInfo') }}</label>
            <label class="db-ck"><input v-model="filter.lv.warn" type="checkbox" data-log-lv="warn" />{{ t('dsh.rt.lvWarn') }}</label>
            <label class="db-ck"><input v-model="filter.lv.err" type="checkbox" data-log-lv="err" />{{ t('dsh.rt.lvErr') }}</label>
          </div>
          <input v-model="filter.q" class="db-in db-in-sm" type="search" :placeholder="t('dsh.rt.filter')" :aria-label="t('dsh.rt.filter')" data-log-filter />
          <span class="db-sp">
            <button type="button" class="db-btn sm" :aria-pressed="follow" data-log-follow @click="follow = !follow">{{ t('dsh.rt.follow') }}</button>
            <button type="button" class="db-btn sm" :aria-pressed="paused" data-log-pause @click="paused = !paused">{{ paused ? t('dsh.rt.resume') : t('dsh.rt.pause') }}</button>
            <button type="button" class="db-btn sm" data-log-clear @click="clearedAt = last">{{ t('dsh.rt.clear') }}</button>
          </span>
        </div>
        <div ref="term" class="db-term" role="log" :aria-label="t('dsh.rt.logOutput')" tabindex="0" data-log-term>
          <div v-for="l in visible" :key="l.seq" class="db-ln" :class="l.lv" :data-log-line="l.src">
            <span class="t">{{ time(l.t) }}</span><span class="s">{{ srcLabel(l.src) }}</span
            ><span class="l"><template v-if="l.lv === 'warn'"><span class="dm" data-k="warn" aria-hidden="true"></span>{{ t('dsh.rt.lvWarn') }}</template><template v-else-if="l.lv === 'err'"><span class="dm" data-k="bad" aria-hidden="true"></span>{{ t('dsh.rt.lvErr') }}</template></span
            ><span class="m">{{ l.msg }}</span>
          </div>
          <div v-if="!visible.length" class="db-empty"><b>{{ t('dsh.rt.noLines') }}</b><span>{{ t('dsh.rt.noLinesHint') }}</span></div>
        </div>
        <div class="db-termfoot"><span>{{ t('dsh.rt.count', { n: visible.length, total: lines.filter((l) => l.seq > clearedAt).length }) }}</span><span>{{ t('dsh.rt.localNote') }}</span></div>
        <div class="db-pbody db-sep"><DbUnavailable id="logs-build-api" :what="t('dsh.rt.buildApiWhat')" :why="t('dsh.rt.buildApiWhy')" /></div>
      </template>
    </section>

    <section v-else class="db-panel" data-runtime-health>
      <header><h3>{{ t('dsh.rt.healthTitle') }}</h3><span class="db-hm">{{ t('dsh.rt.healthHint') }}</span></header>
      <div v-if="health" class="db-tw" data-admin-health>
        <table class="db-t">
          <thead><tr><th>{{ t('dsh.rt.item') }}</th><th>{{ t('dsh.rt.state') }}</th><th>{{ t('dsh.rt.detail') }}</th></tr></thead>
          <tbody>
            <tr><td :data-l="t('dsh.rt.item')">{{ t('dsh.rt.db') }} ({{ health.runtime.dbKind }})</td><td :data-l="t('dsh.rt.state')"><span class="db-stat"><span class="dm" :data-k="statusMark(health.checks.db.status)" aria-hidden="true"></span>{{ statusText(health.checks.db.status) }}</span></td><td :data-l="t('dsh.rt.detail')">{{ t('dsh.rt.dbDetail', { ms: health.checks.db.latencyMs, applied: health.checks.db.migrations.appliedCount, pending: health.checks.db.migrations.pendingCount, latest: health.checks.db.migrations.latestApplied ?? '-' }) }}</td></tr>
            <tr><td :data-l="t('dsh.rt.item')">{{ t('dsh.rt.ai') }}</td><td :data-l="t('dsh.rt.state')"><span class="db-stat"><span class="dm" :data-k="statusMark(health.checks.ai.status)" aria-hidden="true"></span>{{ statusText(health.checks.ai.status) }}</span></td><td :data-l="t('dsh.rt.detail')">{{ health.checks.ai.provider }}</td></tr>
            <tr><td :data-l="t('dsh.rt.item')">Notion</td><td :data-l="t('dsh.rt.state')"><span class="db-stat"><span class="dm" :data-k="health.checks.notion.configured ? statusMark(health.checks.notion.status) : 'off'" aria-hidden="true"></span>{{ health.checks.notion.configured ? statusText(health.checks.notion.status) : t('dsh.rt.off') }}</span></td><td :data-l="t('dsh.rt.detail')">{{ health.checks.notion.status }}</td></tr>
            <tr><td :data-l="t('dsh.rt.item')">{{ t('dsh.rt.runtimeRow') }}</td><td :data-l="t('dsh.rt.state')">{{ health.version }}</td><td :data-l="t('dsh.rt.detail')">Node {{ health.runtime.nodeVersion }} · {{ health.runtime.authAdapter }} · {{ health.runtime.headerPreset }}</td></tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="isReadOnly" class="db-pbody db-muted">{{ healthError || t('dsh.common.loading') }}</div>
      <div v-else class="db-pbody">
        <DbUnavailable id="health-local" :what="t('dsh.rt.healthTitle')" :why="runtime?.processes.lectureApi.up ? t('dsh.rt.healthLocalUp') : t('dsh.rt.healthLocalDown')" />
      </div>
    </section>
  </div>
</template>
