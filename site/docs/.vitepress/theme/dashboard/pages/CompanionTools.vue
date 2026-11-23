<script setup lang="ts">
/**
 * CompanionTools.vue — 伴读 › 工具 (prototype v3.4, K4): how tools are called (self-hosted loop or Dify), the engine
 * tool switches and the external MCP servers of content/ai-tools.json (on/off switches only, saved on the local dev
 * server with the dev token), and the recent tool calls. Call statistics, trial runs, tool discovery and the call log
 * need lecture-api endpoints that do not exist yet: they are shown as unavailable, never with sample numbers.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import type { MessageKey } from '../../../i18n/index.ts'
import { fetchTools, saveToolSwitches, type ToolsPayload } from '../../api/devDashboard'
import DbUnavailable from '../DbUnavailable.vue'
import { dashboardState, isReadOnly, registerModel, say, touchModels, type DashboardPageId } from '../useDashboard'

const emit = defineEmits<{ go: [page: DashboardPageId, tab?: string] }>()
const { t } = useT()

const ENGINE: ReadonlyArray<[string, MessageKey, MessageKey]> = [
  ['search_concepts', 'dsh.tl.t.searchConcepts', 'dsh.tl.d.searchConcepts'],
  ['get_concept', 'dsh.tl.t.getConcept', 'dsh.tl.d.getConcept'],
  ['get_concept_graph', 'dsh.tl.t.getConceptGraph', 'dsh.tl.d.getConceptGraph'],
  ['search_lectures', 'dsh.tl.t.searchLectures', 'dsh.tl.d.searchLectures'],
  ['get_lecture_summary', 'dsh.tl.t.getLectureSummary', 'dsh.tl.d.getLectureSummary'],
]

type Switches = { engine: Record<string, boolean>; servers: Record<string, { enabled: boolean; tools: Record<string, boolean> }> }

const view = ref<ToolsPayload | null>(null)
const draft = ref<Switches>({ engine: {}, servers: {} })
const open = ref<Set<string>>(new Set())
const saving = ref(false)
const status = ref('')

function switchesOf(v: ToolsPayload): Switches {
  return {
    engine: { ...v.engine },
    servers: Object.fromEntries(v.servers.map((s) => [s.id, { enabled: s.enabled, tools: { ...s.tools } }])),
  }
}
const saved = computed<Switches | null>(() => (view.value ? switchesOf(view.value) : null))
const dirty = computed(() => !!saved.value && JSON.stringify(saved.value) !== JSON.stringify(draft.value))
const engineOn = computed(() => ENGINE.filter(([id]) => draft.value.engine[id]).length)
const provider = computed(() => view.value?.settings.provider ?? 'off')

function flipEngine(id: string): void {
  if (isReadOnly.value) return
  draft.value.engine[id] = !draft.value.engine[id]
  touchModels()
}
function flipServer(id: string): void {
  const s = draft.value.servers[id]
  if (!s || isReadOnly.value) return
  s.enabled = !s.enabled
  touchModels()
}
function flipServerTool(id: string, k: string): void {
  const s = draft.value.servers[id]
  if (!s || isReadOnly.value) return
  s.tools[k] = !s.tools[k]
  touchModels()
}
function toggleOpen(id: string): void {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}
const hostOf = (u: string) => {
  try {
    return new URL(u).host
  } catch {
    return u
  }
}

async function save(): Promise<boolean> {
  if (!dirty.value || isReadOnly.value) return true
  saving.value = true
  status.value = ''
  const r = await saveToolSwitches(dashboardState.token, draft.value)
  saving.value = false
  if ('error' in r) {
    status.value = t('dsh.tl.saveFailed', { e: r.error })
    return false
  }
  view.value = r.tools
  draft.value = switchesOf(r.tools)
  touchModels()
  say(t('dsh.tl.saved'))
  return true
}
function discard(): void {
  if (saved.value) draft.value = JSON.parse(JSON.stringify(saved.value)) as Switches
  status.value = ''
  touchModels()
}

let unregister: (() => void) | null = null
onMounted(async () => {
  unregister = registerModel('tools', { page: 'companion', dirty: () => dirty.value, save, discard })
  if (dashboardState.mode !== 'dev') return
  const v = await fetchTools()
  if (v) {
    view.value = v
    draft.value = switchesOf(v)
    if (v.servers[0]) open.value = new Set([v.servers[0].id])
    touchModels()
  }
})
onBeforeUnmount(() => unregister?.())
</script>

<template>
  <div class="db-grid" data-companion-tools>
    <DbUnavailable v-if="isReadOnly" id="tools-online" :what="t('dsh.cp.tabTools')" :why="t('dsh.ac.editOnlineWhy')" />

    <template v-else-if="view">
      <p v-if="view.source !== 'content'" class="db-banner" data-tools-example>{{ t('dsh.tl.fromExample') }}</p>

      <section class="db-panel" data-tools-how>
        <header>
          <h3>{{ t('dsh.tl.howTitle') }}</h3>
          <span class="db-hm">{{ provider === 'dify' ? t('dsh.tl.howDify') : provider === 'off' ? t('dsh.tl.howOff') : t('dsh.tl.howSelf') }}</span>
        </header>
        <div class="db-pbody">
          <dl class="db-kv">
            <dt>{{ t('dsh.tl.mode') }}</dt>
            <dd>{{ provider === 'dify' ? t('dsh.tl.modeDify') : provider === 'off' ? t('dsh.tl.modeOff') : t('dsh.tl.modeSelf', { p: provider }) }}</dd>
            <template v-if="provider === 'dify'">
              <dt>{{ t('dsh.tl.difyTools') }}</dt>
              <dd>{{ t('dsh.tl.difyToolsText') }}</dd>
            </template>
            <template v-else>
              <dt>{{ t('dsh.tl.loop') }}</dt>
              <dd>
                {{ t('dsh.tl.loopText', { steps: view.settings.maxSteps, sec: view.settings.timeoutMs / 1000, kb: Math.round(view.settings.maxResultBytes / 1000) }) }}
                <span class="db-muted"> · {{ t('dsh.tl.loopSource', { src: view.settings.source }) }}</span>
              </dd>
              <dt>{{ t('dsh.tl.byok') }}</dt>
              <dd>{{ t('dsh.tl.byokText') }}</dd>
            </template>
          </dl>
        </div>
        <div class="db-pbody db-sep"><button type="button" class="db-btn sm" @click="emit('go', 'look', 'modules')">{{ t('dsh.tl.toLimits') }}</button></div>
      </section>

      <section class="db-panel" data-tools-engine>
        <header><h3>{{ t('dsh.tl.engineTitle') }}</h3><span class="db-hm">{{ t('dsh.tl.engineHint', { on: engineOn, n: ENGINE.length }) }}</span></header>
        <div class="db-tw">
          <table class="db-t">
            <thead><tr><th>{{ t('dsh.tl.colTool') }}</th><th>{{ t('dsh.tl.colWhat') }}</th><th>{{ t('dsh.tl.colSwitch') }}</th><th class="n">{{ t('dsh.tl.colUses') }}</th></tr></thead>
            <tbody>
              <tr v-for="[id, title, desc] in ENGINE" :key="id" :class="{ dirty: saved && saved.engine[id] !== draft.engine[id] }" :data-tool="id">
                <td :data-l="t('dsh.tl.colTool')"><b>{{ t(title) }}</b> <code class="db-tok">{{ id }}</code></td>
                <td :data-l="t('dsh.tl.colWhat')">{{ t(desc) }}</td>
                <td :data-l="t('dsh.tl.colSwitch')">
                  <button type="button" class="db-sw" role="switch" :aria-checked="!!draft.engine[id]" :aria-label="t('dsh.tl.switchLabel', { name: t(title) })" :data-tool-switch="id" @click="flipEngine(id)"><i></i>{{ draft.engine[id] ? t('dsh.tl.on') : t('dsh.tl.off') }}</button>
                </td>
                <td :data-l="t('dsh.tl.colUses')" class="n db-muted">—</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="db-pbody db-sep"><DbUnavailable id="tools-stats" :what="t('dsh.tl.statsWhat')" :why="t('dsh.tl.statsWhy')" /></div>
      </section>

      <section v-if="provider === 'dify'" class="db-panel" data-tools-dify>
        <header><h3>{{ t('dsh.tl.difyMcpTitle') }}</h3></header>
        <div class="db-pbody"><p>{{ t('dsh.tl.difyMcpText') }}</p></div>
        <div class="db-pbody db-sep">
          <dl class="db-kv">
            <dt>{{ t('dsh.tl.mcpToken') }}</dt>
            <dd><span class="db-stat"><span class="dm" :data-k="view.settings.mcpTokenSet ? 'ok' : 'warn'" aria-hidden="true"></span>{{ view.settings.mcpTokenSet ? t('dsh.tl.envSet') : t('dsh.tl.envUnset') }}</span></dd>
            <dt>{{ t('dsh.tl.ticketSecret') }}</dt>
            <dd><span class="db-stat"><span class="dm" :data-k="view.settings.ticketSecretSet ? 'ok' : 'warn'" aria-hidden="true"></span>{{ view.settings.ticketSecretSet ? t('dsh.tl.envSet') : t('dsh.tl.envUnset') }}</span></dd>
          </dl>
        </div>
      </section>

      <section v-else class="db-panel" data-tools-servers>
        <header><h3>{{ t('dsh.tl.serversTitle') }}</h3><span class="db-hm">{{ t('dsh.tl.serversHint', { n: view.servers.length }) }}</span></header>
        <div v-if="!view.servers.length" class="db-empty"><b>{{ t('dsh.tl.serversNone') }}</b><span>{{ t('dsh.tl.serversNoneHint') }}</span></div>
        <div v-for="s in view.servers" :key="s.id" class="db-srv" :data-tools-server="s.id">
          <div class="db-srv-h">
            <button type="button" class="db-btn sm db-srv-x" :aria-expanded="open.has(s.id)" @click="toggleOpen(s.id)">{{ s.name }}</button>
            <span class="db-mono db-muted db-grow">{{ hostOf(s.url) }}</span>
            <span class="db-stat"><span class="dm" :data-k="draft.servers[s.id]?.enabled ? 'half' : 'off'" aria-hidden="true"></span>{{ draft.servers[s.id]?.enabled ? t('dsh.tl.srvState') : t('dsh.tl.srvOff') }}</span>
            <span class="db-muted">{{ t('dsh.tl.srvTools', { on: Object.values(draft.servers[s.id]?.tools ?? {}).filter(Boolean).length, n: Object.keys(s.tools).length }) }}</span>
            <button type="button" class="db-sw" role="switch" :aria-checked="!!draft.servers[s.id]?.enabled" :aria-label="t('dsh.tl.srvSwitch', { name: s.name })" :data-server-switch="s.id" @click="flipServer(s.id)"><i></i>{{ draft.servers[s.id]?.enabled ? t('dsh.tl.srvOn') : t('dsh.tl.srvOff') }}</button>
          </div>
          <div v-if="open.has(s.id)" class="db-srv-b">
            <dl class="db-kv">
              <dt>{{ t('dsh.tl.address') }}</dt>
              <dd class="db-mono">{{ s.url }}</dd>
              <dt>{{ t('dsh.tl.header') }}</dt>
              <dd>
                <template v-if="s.headers.length">
                  <div v-for="h in s.headers" :key="h.name">
                    {{ t('dsh.tl.headerFrom', { h: h.name, env: h.env }) }}
                    <span class="db-stat"><span class="dm" :data-k="h.set ? 'ok' : 'warn'" aria-hidden="true"></span>{{ h.set ? t('dsh.tl.envSet') : t('dsh.tl.envUnset') }}</span>
                  </div>
                </template>
                <span v-else class="db-muted">{{ t('dsh.tl.noHeader') }}</span>
              </dd>
            </dl>
            <table v-if="Object.keys(s.tools).length" class="db-t">
              <thead><tr><th>{{ t('dsh.tl.colTool') }}</th><th>{{ t('dsh.tl.colSwitch') }}</th></tr></thead>
              <tbody>
                <tr v-for="k in Object.keys(s.tools)" :key="k">
                  <td :data-l="t('dsh.tl.colTool')"><code class="db-tok">{{ k }}</code></td>
                  <td :data-l="t('dsh.tl.colSwitch')"><button type="button" class="db-sw" role="switch" :aria-checked="!!draft.servers[s.id]?.tools[k]" :aria-label="t('dsh.tl.switchLabel', { name: k })" :data-server-tool="`${s.id}/${k}`" @click="flipServerTool(s.id, k)"><i></i>{{ draft.servers[s.id]?.tools[k] ? t('dsh.tl.on') : t('dsh.tl.off') }}</button></td>
                </tr>
              </tbody>
            </table>
            <p v-else class="db-muted">{{ t('dsh.tl.srvNoTools') }}</p>
          </div>
        </div>
        <div class="db-pbody db-sep"><DbUnavailable id="tools-manage" :what="t('dsh.tl.manageWhat')" :why="t('dsh.tl.manageWhy')" /></div>
      </section>

      <section class="db-panel" data-tools-log>
        <header><h3>{{ t('dsh.tl.logTitle') }}</h3><span class="db-hm">{{ t('dsh.tl.logHint') }}</span></header>
        <div class="db-pbody"><DbUnavailable id="tools-log" :what="t('dsh.tl.logTitle')" :why="t('dsh.tl.logWhy')" /></div>
      </section>

      <div class="db-savebar" data-savebar="tools">
        <span class="db-st" :class="{ 'db-err': !!status }" data-tools-status>{{ status || (dirty ? t('dsh.common.unsavedChanges') : t('dsh.common.allSaved')) }}</span>
        <button type="button" class="db-btn" :disabled="!dirty" data-tools-discard @click="discard">{{ t('dsh.common.discard') }}</button>
        <button type="button" class="db-btn primary" :disabled="!dirty || saving" data-tools-save @click="save">{{ saving ? t('dsh.common.saving') : t('dsh.tl.save') }}</button>
      </div>
      <p class="db-muted db-small">{{ view.file }}</p>
    </template>

    <div v-else class="db-empty"><span>{{ t('dsh.common.loading') }}</span></div>
  </div>
</template>
