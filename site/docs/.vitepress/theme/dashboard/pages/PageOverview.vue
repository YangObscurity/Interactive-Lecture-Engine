<script setup lang="ts">
/**
 * PageOverview.vue — Overview: key figures, to-do list, build and deployment (or online runtime),
 * course groups expandable to per-lecture checks, and recent content changes (local dev only).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useData } from 'vitepress'
import { useT } from '../../../i18n/useT.ts'
import type { AdminHealthResponse, AdminOverviewResponse, OnlineRuntimePayload } from '../../api/admin'
import { fetchRuntime, fetchChanges, type ChangeCommit, type DevAccessSummary, type RuntimePayload } from '../../api/devDashboard'
import { dashboardClient } from '../dashboardClient'
import DbHead from '../DbHead.vue'
import DbUnavailable from '../DbUnavailable.vue'
import OverviewGroupDetail from './OverviewGroupDetail.vue'
import { canAccessPage, checkState, dashboardState, ensureCheckRun, runChecks, type DashboardPageId } from '../useDashboard'
import { groupIssueCounts, shortDateTime, todoFromChecks, type DashGroup } from '../dashboardData'

const props = defineProps<{ overview: AdminOverviewResponse | null; health: AdminHealthResponse | null; access?: DevAccessSummary | null; healthError?: string }>()
const emit = defineEmits<{ go: [page: DashboardPageId, tab?: string]; retry: [] }>()
const { t } = useT()
const { theme } = useData<{ groups?: DashGroup[]; totals?: { lectures?: number; charts?: number } }>()

const groups = computed<DashGroup[]>(() => (Array.isArray(theme.value?.groups) ? theme.value.groups : []))
const lectures = computed(() => theme.value?.totals?.lectures ?? groups.value.reduce((s, g) => s + (g.lectureCount ?? 0), 0))
const charts = computed(() => theme.value?.totals?.charts ?? groups.value.reduce((s, g) => s + (g.chartCount ?? 0), 0))
const open = ref<string | null>(null)
const runtime = ref<RuntimePayload | null>(null)
const onlineRuntime = ref<OnlineRuntimePayload | null>(null)
const changes = ref<ChangeCommit[] | null>(null)
const openChange = ref<string | null>(null)

const skin = ref('')
let skinObserver: MutationObserver | null = null
const asTable = computed(() => skin.value === 'datasheet')

const isDev = computed(() => dashboardState.mode === 'dev')
const canCheckOnline = computed(() => dashboardState.mode === 'online' && canAccessPage('checks'))
const canRerunChecks = computed(() => isDev.value || canCheckOnline.value)

const report = computed(() => checkState.run?.report ?? null)
const lastBuild = computed(() => runtime.value?.processes.lastBuild ?? null)
const latestChange = computed(() => changes.value?.[0] ?? null)
const sinceBuild = computed<string | null>(() => {
  if (!changes.value || !lastBuild.value) return null
  const built = Date.parse(lastBuild.value)
  const n = changes.value.filter((c) => Date.parse(c.date) > built).length
  return n === 0 ? '' : n === changes.value.length ? `${n}+` : String(n)
})

const todo = computed(() => {
  const items = todoFromChecks(report.value, t)
  if (props.health) {
    const c = props.health.checks
    if (c.db.status !== 'ok') items.push({ k: 'bad', title: t('dsh.ov.todoDb', { s: c.db.status }), detail: '', go: ['runtime', 'health'] })
    if (c.notion.configured && c.notion.status !== 'ok') items.push({ k: 'warn', title: t('dsh.ov.todoNotion', { s: c.notion.status }), detail: '', go: ['runtime', 'health'] })
  }
  if (sinceBuild.value) items.push({ k: 'half', title: t('dsh.ov.todoStale'), detail: t('dsh.ov.todoStaleDetail', { n: sinceBuild.value }), go: ['runtime', 'logs'] })
  return items
})
const adminFailed = computed(() => !isDev.value && !!props.healthError)
const todoCount = computed(() => todo.value.length + (adminFailed.value ? 1 : 0))
const checksPending = computed(() => canRerunChecks.value && !report.value)

function progressOf(g: DashGroup): number | null {
  const row = props.overview?.byGroup.find((r) => r.group_id === g.id)
  if (!row || row.total_rows === 0) return null
  return Math.round((row.completed / row.total_rows) * 100)
}

function badgeOf(g: DashGroup): { k: 'bad' | 'warn' | 'ok' | 'off'; text: string } {
  if (!report.value) return { k: 'off', text: !canRerunChecks.value ? t('dsh.ov.checkOnlyLocal') : t('dsh.ov.checkNotRun') }
  const c = groupIssueCounts(report.value, g.dir)
  if (c.fail) return { k: 'bad', text: t('dsh.ov.badgeFail', { n: c.fail }) }
  if (c.warn) return { k: 'warn', text: t('dsh.ov.badgeWarn', { n: c.warn }) }
  return { k: 'ok', text: t('dsh.ov.badgeOk') }
}

function tierOf(g: DashGroup): string | null {
  const row = props.access?.groups.find((x) => x.id === g.id)
  if (!row) return null
  return row.read === 'public' ? t('dsh.ac.public') : row.read === 'authenticated' ? t('dsh.ac.login') : t('dsh.ac.acl')
}
const shortTime = (iso: string): string => shortDateTime(iso)
function whereOf(files: readonly string[]): string {
  if (!files.length) return '—'
  if (files.length === 1) return files[0] as string
  const parts = files.map((f) => f.split('/'))
  const common: string[] = []
  for (let i = 0; ; i++) {
    const seg = parts[0]?.[i]
    if (seg === undefined || i >= (parts[0]?.length ?? 0) - 1 || !parts.every((p) => p[i] === seg && i < p.length - 1)) break
    common.push(seg)
  }
  return common.length ? `${common.join('/')}/` : t('dsh.ov.nFiles', { n: files.length })
}
const toggle = (id: string) => {
  open.value = open.value === id ? null : id
}

onMounted(async () => {
  const root = document.documentElement
  const readSkin = () => {
    skin.value = root.getAttribute('data-lec-theme') ?? ''
  }
  readSkin()
  skinObserver = new MutationObserver(readSkin)
  skinObserver.observe(root, { attributes: true, attributeFilter: ['data-lec-theme'] })
  if (dashboardState.mode === 'dev') {
    void ensureCheckRun()
    runtime.value = await fetchRuntime()
    changes.value = await fetchChanges()
  } else if (dashboardState.mode === 'online') {
    if (canAccessPage('checks')) void ensureCheckRun()
    if (dashboardState.canAccessAdmin) {
      const rt = await dashboardClient.fetchRuntime()
      if (rt.ok && rt.onlineRuntime) onlineRuntime.value = rt.onlineRuntime
    }
  }
})
onBeforeUnmount(() => skinObserver?.disconnect())
</script>

<template>
  <div class="db-page" data-page="overview">
    <DbHead :title="t('dsh.nav.overview')" :lead="t('dsh.ov.lead')" />

    <div class="db-figs">
      <div><b>{{ lectures }}</b><span>{{ t('dsh.ov.figLectures') }}</span><small>{{ t('dsh.ov.figGroups', { n: groups.length }) }}</small></div>
      <div><b>{{ charts }}</b><span>{{ t('dsh.ov.figCharts') }}</span></div>
      <div v-if="overview" data-admin-overview><b data-admin-metric="users">{{ overview.totals.users }}</b><span>{{ t('dsh.ov.figReaders') }}</span><small>{{ t('dsh.ov.figActive', { n: overview.recentActivity.progressUpdatedLast24h }) }}</small></div>
      <div v-else><b>—</b><span>{{ t('dsh.ov.figReaders') }}</span><small>{{ t('dsh.ov.figReadersLocal') }}</small></div>
      <div data-overview-figtodo><b>{{ todoCount }}</b><span>{{ t('dsh.ov.figTodo') }}</span><small>{{ checkState.running ? t('dsh.chk.running') : '' }}</small></div>
    </div>

    <div class="db-cols">
      <section class="db-panel" data-overview-todo>
        <header><h3>{{ t('dsh.ov.todoTitle') }}</h3><span class="db-hm">{{ checksPending && !todoCount ? t('dsh.chk.running') : t('dsh.common.nItems', { n: todoCount }) }}</span></header>
        <div v-if="todoCount" class="db-wl">
          <div v-if="adminFailed" class="db-wi" data-todo="admin-error">
            <span class="dm" data-k="bad" aria-hidden="true"></span>
            <div>
              <div class="db-wt">{{ t('dsh.ov.todoAdminError') }}</div>
              <div class="db-wd">{{ healthError }} {{ t('dsh.ov.todoAdminErrorDetail') }}</div>
            </div>
            <div class="db-btns">
              <button type="button" class="db-btn sm" data-todo-retry @click="emit('retry')">{{ t('dsh.common.retry') }}</button>
              <button type="button" class="db-btn sm" @click="emit('go', 'runtime', 'health')">{{ t('dsh.common.goThere') }}</button>
            </div>
          </div>
          <div v-for="(item, i) in todo" :key="i" class="db-wi">
            <span class="dm" :data-k="item.k" aria-hidden="true"></span>
            <div>
              <div class="db-wt">{{ item.title }}</div>
              <div v-if="item.detail" class="db-wd">{{ item.detail }}</div>
              <div v-if="item.file" class="db-wf">{{ item.file }}</div>
            </div>
            <div class="db-btns">
              <button type="button" class="db-btn sm" @click="emit('go', item.go[0], item.go[1])">{{ t('dsh.common.goThere') }}</button>
            </div>
          </div>
        </div>
        <div v-if="checksPending && !adminFailed" class="db-empty" :data-overview-todo-running="checkState.running ? '1' : undefined" data-overview-todo-pending>
          <span><span class="dm" data-k="off" aria-hidden="true"></span>{{ checkState.running ? t('dsh.ov.todoRunning') : checkState.error ? t('dsh.chk.runFailed') : t('dsh.chk.notRun') }}</span>
        </div>
        <div v-else-if="!todoCount" class="db-empty">
          <b>{{ t('dsh.ov.todoNone') }}</b>
          <span>{{ !isDev ? t('dsh.ov.todoNoneOnline') : t('dsh.ov.todoNoneLocal') }}</span>
        </div>
        <div v-if="canRerunChecks" class="db-pbody db-sep">
          <button type="button" class="db-btn sm" :disabled="checkState.running" data-overview-rerun @click="runChecks()">{{ t('dsh.chk.rerunAll') }}</button>
        </div>
      </section>

      <section class="db-panel" data-overview-build>
        <header><h3>{{ t('dsh.ov.buildTitle') }}</h3></header>
        <div class="db-pbody">
          <dl class="db-kv">
            <dt>{{ t('dsh.ov.lastBuild') }}</dt>
            <dd data-overview-build-row="build">{{ lastBuild ? shortTime(lastBuild) : !isDev ? t('dsh.ov.onlyLocal') : t('dsh.ov.noBuild') }}</dd>
            <dt>{{ t('dsh.ov.contentCommit') }}</dt>
            <dd data-overview-build-row="commit">
              <template v-if="latestChange">
                <code>{{ latestChange.short }}</code>{{ t('dsh.ov.commitAt', { time: shortTime(latestChange.date) }) }}<span v-if="sinceBuild" class="db-stat"><span class="dm" data-k="half" aria-hidden="true"></span>{{ t('dsh.ov.commitBehind', { n: sinceBuild }) }}</span><template v-else-if="sinceBuild === ''">{{ t('dsh.ov.commitInBuild') }}</template>
              </template>
              <template v-else>{{ !isDev ? t('dsh.ov.onlyLocal') : changes === null ? t('dsh.common.loading') : t('dsh.ov.noCommit') }}</template>
            </dd>
            <dt>{{ t('dsh.ov.deploy') }}</dt>
            <dd data-overview-build-row="deploy">
              <span v-if="onlineRuntime" class="db-stat">
                <span class="dm" data-k="ok" aria-hidden="true"></span>
                Node {{ onlineRuntime.nodeVersion }} · {{ onlineRuntime.authAdapter }} · {{ t('dsh.rt.uptime', { h: Math.floor(onlineRuntime.uptimeSeconds / 3600) }) }}
              </span>
              <span v-else class="db-stat"><span class="dm" data-k="off" aria-hidden="true"></span>{{ t('dsh.ov.deployUnknown') }}</span>
            </dd>
          </dl>
        </div>
        <div class="db-pbody db-sep">
          <div class="db-btns">
            <button type="button" class="db-btn sm" data-overview-buildlog @click="emit('go', 'runtime', 'logs')">{{ t('dsh.ov.buildLog') }}</button>
          </div>
          <p v-if="isDev" class="db-muted">{{ t('dsh.ov.rebuildHint') }} <code>npm run build</code></p>
          <DbUnavailable v-if="!onlineRuntime" id="deploy" :what="t('dsh.ov.deployWhat')" :why="t('dsh.ov.deployWhy')" />
        </div>
      </section>
    </div>

    <section class="db-panel" data-overview-groups :data-overview-layout="asTable ? 'table' : 'tiles'">
      <header><h3>{{ t('dsh.ov.groupsTitle') }}</h3><span class="db-hm">{{ t('dsh.ov.groupsHint') }}</span></header>
      <div v-if="asTable" class="db-tw">
        <table class="db-t" data-overview-gtable>
          <thead>
            <tr><th>{{ t('dsh.ov.colGroup') }}</th><th class="n">{{ t('dsh.ov.colLectures') }}</th><th>{{ t('dsh.ov.colCheck') }}</th><th>{{ t('dsh.ov.colTier') }}</th><th>{{ t('dsh.ov.colProgress') }}</th><th></th></tr>
          </thead>
          <tbody>
            <template v-for="(g, i) in groups" :key="g.id">
              <tr :class="{ cur: open === g.id }" :style="{ '--c': `var(--lec-cat-${(i % 8) + 1})` }" :data-overview-group="g.id">
                <td :data-l="t('dsh.ov.colGroup')">
                  <b>{{ g.id }}</b>
                  <span v-if="g.temp" class="db-temp" data-temp-badge>{{ t('dsh.common.temp') }}</span>
                  {{ g.title }}
                </td>
                <td :data-l="t('dsh.ov.colLectures')" class="n">{{ g.lectureCount ?? 0 }}</td>
                <td :data-l="t('dsh.ov.colCheck')"><span class="db-stat"><span class="dm" :data-k="badgeOf(g).k" aria-hidden="true"></span>{{ badgeOf(g).text }}</span></td>
                <td :data-l="t('dsh.ov.colTier')"><span v-if="tierOf(g)" class="db-tag" data-overview-tier>{{ tierOf(g) }}</span><span v-else class="db-muted">—</span></td>
                <td :data-l="t('dsh.ov.colProgress')">
                  <span v-if="progressOf(g) !== null" class="db-stat"><span class="db-pbar" aria-hidden="true"><i :style="{ width: `${progressOf(g)}%` }"></i></span>{{ progressOf(g) }}%</span>
                  <span v-else class="db-muted">—</span>
                </td>
                <td class="n"><button type="button" class="db-btn sm" :aria-expanded="open === g.id" @click="toggle(g.id)">{{ open === g.id ? t('dsh.common.collapse') : t('dsh.ov.expand') }}</button></td>
              </tr>
              <tr v-if="open === g.id" class="sub"><td colspan="6"><OverviewGroupDetail :group="g" :report="report" @go="(p, tab) => emit('go', p, tab)" /></td></tr>
            </template>
          </tbody>
        </table>
      </div>
      <ul v-else class="db-groups">
        <li v-for="(g, i) in groups" :key="g.id" :style="{ '--c': `var(--lec-cat-${(i % 8) + 1})` }" :data-overview-group="g.id">
          <button type="button" class="db-gt" :aria-expanded="open === g.id" @click="toggle(g.id)">
            <span class="db-gh">
              <b>{{ g.id }}</b>
              <span v-if="g.temp" class="db-temp" data-temp-badge>{{ t('dsh.common.temp') }}</span>
              <span class="db-gn">{{ g.title }}</span>
            </span>
            <span class="db-gm">
              <span>{{ t('dsh.ov.nLectures', { n: g.lectureCount ?? 0 }) }}</span>
              <span class="db-stat"><span class="dm" :data-k="badgeOf(g).k" aria-hidden="true"></span>{{ badgeOf(g).text }}</span>
              <span v-if="tierOf(g)" class="db-tag" data-overview-tier>{{ tierOf(g) }}</span>
              <span v-if="progressOf(g) !== null" class="db-stat"><span class="db-pbar" aria-hidden="true"><i :style="{ width: `${progressOf(g)}%` }"></i></span>{{ t('dsh.ov.progress', { n: progressOf(g) ?? 0 }) }}</span>
            </span>
          </button>
          <OverviewGroupDetail v-if="open === g.id" :group="g" :report="report" @go="(p, tab) => emit('go', p, tab)" />
        </li>
      </ul>
      <div v-if="!isDev && !report" class="db-pbody db-sep">
        <DbUnavailable id="group-check" :what="t('dsh.ov.groupCheckWhat')" :why="t('dsh.ov.groupCheckWhy')" />
      </div>
    </section>

    <section class="db-panel" data-overview-changes>
      <header><h3>{{ t('dsh.ov.changesTitle') }}</h3><span class="db-hm">{{ t('dsh.ov.changesHint') }}</span></header>
      <DbUnavailable v-if="!isDev" id="changes" :what="t('dsh.ov.changesTitle')" :why="t('dsh.ov.changesOnlineWhy')" />
      <div v-else-if="changes && changes.length" class="db-tw">
        <table class="db-t">
          <thead><tr><th>{{ t('dsh.common.time') }}</th><th>{{ t('dsh.ov.changeWhat') }}</th><th>{{ t('dsh.ov.changeWhere') }}</th><th></th></tr></thead>
          <tbody>
            <template v-for="c in changes.slice(0, 6)" :key="c.hash">
              <tr>
                <td :data-l="t('dsh.common.time')" class="db-mono db-nw">{{ shortTime(c.date) }}</td>
                <td :data-l="t('dsh.ov.changeWhat')" class="db-clip" :title="c.subject">{{ c.subject }}</td>
                <td :data-l="t('dsh.ov.changeWhere')" class="db-mono db-nw">{{ whereOf(c.files) }}</td>
                <td class="n"><button type="button" class="db-btn sm" :aria-expanded="openChange === c.hash" @click="openChange = openChange === c.hash ? null : c.hash">{{ openChange === c.hash ? t('dsh.common.collapse') : t('dsh.ov.showFiles') }}</button></td>
              </tr>
              <tr v-if="openChange === c.hash" class="sub"><td colspan="4"><pre class="db-codeb">{{ c.files.join('\n') }}</pre></td></tr>
            </template>
          </tbody>
        </table>
      </div>
      <div v-else class="db-empty"><span>{{ changes === null ? t('dsh.common.loading') : t('dsh.ov.changesNone') }}</span></div>
    </section>
  </div>
</template>
