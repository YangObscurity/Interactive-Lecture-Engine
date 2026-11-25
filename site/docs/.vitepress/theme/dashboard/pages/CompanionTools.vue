<script setup lang="ts">
/**
 * CompanionTools.vue — Companion > Tools: engine tool switches and external MCP servers.
 * Supports local dev mode (`/__lecture/api/tools`) and online admin mode (`/api/admin/ai-tools`).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import type { MessageKey } from '../../../i18n/index.ts'
import type { OnlineAiToolsPayload } from '../../api/admin'
import type { ToolsPayload } from '../../api/devDashboard'
import { dashboardClient } from '../dashboardClient'
import DbUnavailable from '../DbUnavailable.vue'
import { shortDateTime } from '../dashboardData'
import { canWritePage, dashboardState, registerModel, say, touchModels, type DashboardPageId } from '../useDashboard'

const emit = defineEmits<{ go: [page: DashboardPageId, tab?: string] }>()
const { t } = useT()

const ENGINE: ReadonlyArray<[string, MessageKey, MessageKey]> = [
  ['search_concepts', 'dsh.tl.t.searchConcepts', 'dsh.tl.d.searchConcepts'],
  ['get_concept', 'dsh.tl.t.getConcept', 'dsh.tl.d.getConcept'],
  ['get_concept_graph', 'dsh.tl.t.getConceptGraph', 'dsh.tl.d.getConceptGraph'],
  ['search_lectures', 'dsh.tl.t.searchLectures', 'dsh.tl.d.searchLectures'],
  ['get_lecture_summary', 'dsh.tl.t.getLectureSummary', 'dsh.tl.d.getLectureSummary'],
]

interface ServerDraftItem {
  id: string
  name: string
  url: string
  enabled: boolean
  headers: Array<{ name: string; env: string; set: boolean }>
  tools: Record<string, boolean>
  timeoutMs?: number | null
}

const isDev = computed(() => dashboardState.mode === 'dev')
const canManageOnlineTools = computed(() => dashboardState.mode === 'online' && dashboardState.canAccessAdmin)
const toolsEditable = computed(() => canWritePage('companion') && (isDev.value || canManageOnlineTools.value))

const view = ref<ToolsPayload | null>(null)
const onlineStats = ref<Record<string, { calls: number; errors: number }>>({})
const draft = ref<{ engine: Record<string, boolean> }>({ engine: {} })
const serversDraft = ref<ServerDraftItem[]>([])
const open = ref<Set<string>>(new Set())
const saving = ref(false)
const status = ref('')
const savedNote = ref('')

const showAddServer = ref(false)
const newServerId = ref('')
const newServerName = ref('')
const newServerUrl = ref('')
const newServerHdr = ref('Authorization')
const newServerEnv = ref('')
const addServerError = ref('')

const confirmDeleteId = ref<string | null>(null)

const savedEngine = computed(() => view.value?.engine ?? {})
const savedServers = computed(() => view.value?.servers ?? [])

const dirty = computed(() => {
  if (!view.value) return false
  const engineChanged = JSON.stringify(savedEngine.value) !== JSON.stringify(draft.value.engine)
  const serversChanged = JSON.stringify(savedServers.value) !== JSON.stringify(serversDraft.value)
  return engineChanged || serversChanged
})

const engineOn = computed(() => ENGINE.filter(([id]) => draft.value.engine[id]).length)
const provider = computed(() => view.value?.settings.provider ?? 'off')

function flipEngine(id: string): void {
  if (!toolsEditable.value) return
  draft.value.engine[id] = !draft.value.engine[id]
  touchModels()
}

function flipServer(id: string): void {
  const s = serversDraft.value.find((x) => x.id === id)
  if (!s || !toolsEditable.value) return
  s.enabled = !s.enabled
  touchModels()
}

function flipServerTool(id: string, k: string): void {
  const s = serversDraft.value.find((x) => x.id === id)
  if (!s || !toolsEditable.value) return
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

function resetAddForm(): void {
  newServerId.value = ''
  newServerName.value = ''
  newServerUrl.value = ''
  newServerHdr.value = 'Authorization'
  newServerEnv.value = ''
  addServerError.value = ''
  showAddServer.value = false
}

function submitAddServer(): void {
  addServerError.value = ''
  const name = newServerName.value.trim()
  const url = newServerUrl.value.trim()
  const hdr = newServerHdr.value.trim() || 'Authorization'
  const env = newServerEnv.value.trim()

  const suspectPatterns = [/sk-[a-zA-Z0-9_-]{10,}/, /bearer\s+/i, /ghp_[a-zA-Z0-9]{20,}/, /eyJ[a-zA-Z0-9_-]{15,}/]
  for (const val of [name, url, hdr, env]) {
    for (const pat of suspectPatterns) {
      if (pat.test(val)) {
        addServerError.value = t('dsh.tl.errSecretRejected')
        return
      }
    }
  }

  if (!name) {
    addServerError.value = t('dsh.tl.errNameRequired')
    return
  }
  let parsedUrl: URL | null = null
  try {
    parsedUrl = new URL(url)
  } catch {
    parsedUrl = null
  }
  if (!parsedUrl || parsedUrl.protocol !== 'https:' || !parsedUrl.hostname || /\s/.test(url)) {
    addServerError.value = t('dsh.tl.errUrlInvalid')
    return
  }
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(hdr)) {
    addServerError.value = t('dsh.tl.errHdrInvalid')
    return
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(env)) {
    addServerError.value = t('dsh.tl.errEnvInvalid')
    return
  }

  let id = newServerId.value.trim().toLowerCase()
  if (id) {
    if (!/^[a-z0-9-]+$/.test(id)) {
      addServerError.value = t('dsh.tl.errIdInvalid')
      return
    }
  } else {
    id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('srv-' + Date.now().toString(36).slice(-4))
  }

  if (serversDraft.value.some((s) => s.id === id)) {
    addServerError.value = t('dsh.tl.errIdExists')
    return
  }

  serversDraft.value.push({
    id,
    name,
    url,
    enabled: false,
    headers: [{ name: hdr, env, set: false }],
    tools: {},
    timeoutMs: 8000,
  })
  open.value.add(id)
  resetAddForm()
  touchModels()
  say(t('dsh.tl.srvAddedDraft', { name, env }))
}

function promptDeleteServer(s: { id: string }): void {
  confirmDeleteId.value = s.id
}

function confirmDeleteServer(id: string): void {
  const s = serversDraft.value.find((x) => x.id === id)
  const name = s?.name ?? id
  serversDraft.value = serversDraft.value.filter((x) => x.id !== id)
  open.value.delete(id)
  confirmDeleteId.value = null
  touchModels()
  say(t('dsh.tl.srvDeletedDraft', { name }))
}

async function save(): Promise<boolean> {
  if (!toolsEditable.value) return false
  if (!dirty.value) return true
  saving.value = true
  status.value = ''
  if (isDev.value) {
    const r = await dashboardClient.saveDevTools({
      engine: draft.value.engine,
      servers: serversDraft.value,
    })
    saving.value = false
    if ('error' in r) {
      status.value = t('dsh.tl.saveFailed', { e: r.error })
      return false
    }
    view.value = r.tools
    draft.value.engine = { ...r.tools.engine }
    serversDraft.value = JSON.parse(JSON.stringify(r.tools.servers))
    savedNote.value = t('dsh.common.savedAt', { time: shortDateTime(Date.now()) })
    touchModels()
    say(t('dsh.tl.saved'))
    return true
  }

  const res = await dashboardClient.saveOnlineAiTools({
    engine: draft.value.engine,
    servers: serversDraft.value.map((s) => ({
      id: s.id,
      enabled: s.enabled,
      tools: s.tools,
    })),
  })
  saving.value = false
  if (!res.ok) {
    status.value = t('dsh.tl.saveFailed', { e: res.error || 'unknown' })
    return false
  }
  if (res.data) {
    const nextView = buildOnlineToolsView(res.data)
    view.value = nextView
    draft.value.engine = { ...nextView.engine }
    serversDraft.value = JSON.parse(JSON.stringify(nextView.servers))
  } else if (view.value) {
    view.value = {
      ...view.value,
      engine: { ...draft.value.engine },
      servers: JSON.parse(JSON.stringify(serversDraft.value)),
    }
  }
  savedNote.value = t('dsh.common.savedAt', { time: shortDateTime(Date.now()) })
  touchModels()
  say(t('dsh.tl.onlineSaved'))
  return true
}

function discard(): void {
  if (view.value) {
    draft.value.engine = { ...view.value.engine }
    serversDraft.value = JSON.parse(JSON.stringify(view.value.servers))
  }
  confirmDeleteId.value = null
  resetAddForm()
  status.value = ''
  savedNote.value = ''
  touchModels()
}

function buildOnlineToolsView(aiData: OnlineAiToolsPayload | undefined): ToolsPayload {
  const engine: Record<string, boolean> = {}
  for (const [id] of ENGINE) engine[id] = true
  if (aiData?.engineTools) {
    for (const et of aiData.engineTools) {
      engine[et.name] = et.enabled
    }
  }
  const servers: ToolsPayload['servers'] = (aiData?.mcpServers ?? []).map((srv) => ({
    id: srv.id,
    name: srv.name,
    url: srv.host,
    enabled: srv.enabled,
    headers: [],
    tools: Object.fromEntries(
      srv.tools.map((tl) => [tl.name, srv.configuredTools?.[tl.name] ?? tl.enabled]),
    ),
    timeoutMs: aiData?.settings?.timeoutMs ?? null,
  }))

  const st = aiData?.settings
  return {
    file: 'ai-tools.json',
    exists: true,
    source: 'content',
    engine,
    servers,
    settings: {
      provider: st?.provider ?? 'off',
      maxSteps: st?.maxSteps ?? 5,
      timeoutMs: st?.timeoutMs ?? 8000,
      maxResultBytes: st?.maxResultBytes ?? 24000,
      mcpTokenSet: Boolean(st?.mcpTokenSet ?? aiData?.mcpEndpoint?.enabled),
      ticketSecretSet: Boolean(st?.ticketSecretSet),
      source: st?.source === 'default' ? 'default' : 'server/.env',
    },
  }
}

let unregister: (() => void) | null = null
onMounted(async () => {
  unregister = registerModel('tools', { page: 'companion', dirty: () => dirty.value, save, discard })
  if (dashboardState.mode === 'dev') {
    const v = await dashboardClient.fetchDevTools()
    if (v) {
      view.value = v
      draft.value.engine = { ...v.engine }
      serversDraft.value = JSON.parse(JSON.stringify(v.servers))
      if (v.servers[0]) open.value = new Set([v.servers[0].id])
      touchModels()
    }
  } else if (canManageOnlineTools.value) {
    const aiToolsRes = await dashboardClient.fetchOnlineAiTools().catch(() => ({ ok: false as const }))
    const aiData = 'data' in aiToolsRes ? aiToolsRes.data : undefined
    if (aiData?.toolCallCounts7d) {
      onlineStats.value = aiData.toolCallCounts7d
    }
    const v = buildOnlineToolsView(aiData)
    view.value = v
    draft.value.engine = { ...v.engine }
    serversDraft.value = JSON.parse(JSON.stringify(v.servers))
    if (v.servers[0]) open.value = new Set([v.servers[0].id])
    touchModels()
  }
})
onBeforeUnmount(() => unregister?.())
</script>

<template>
  <div class="db-grid" data-companion-tools>
    <DbUnavailable v-if="!toolsEditable" id="tools-online" :what="t('dsh.cp.tabTools')" :why="dashboardState.mode === 'online' ? t('dsh.tl.onlineAuthorWhy') : t('dsh.ac.editOnlineWhy')" />

    <template v-else-if="view">
      <p v-if="!isDev && canManageOnlineTools" class="db-banner" data-tools-online-note>{{ t('dsh.tl.onlineManageNote') }}</p>
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
              <tr v-for="[id, title, desc] in ENGINE" :key="id" :class="{ dirty: savedEngine[id] !== draft.engine[id] }" :data-tool="id">
                <td :data-l="t('dsh.tl.colTool')"><b>{{ t(title) }}</b> <code class="db-tok">{{ id }}</code></td>
                <td :data-l="t('dsh.tl.colWhat')">{{ t(desc) }}</td>
                <td :data-l="t('dsh.tl.colSwitch')">
                  <button type="button" class="db-sw" role="switch" :aria-checked="!!draft.engine[id]" :aria-label="t('dsh.tl.switchLabel', { name: t(title) })" :data-tool-switch="id" @click="flipEngine(id)"><i></i>{{ draft.engine[id] ? t('dsh.tl.on') : t('dsh.tl.off') }}</button>
                </td>
                <td :data-l="t('dsh.tl.colUses')" class="n db-muted">{{ onlineStats[id] ? onlineStats[id].calls : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="isDev" class="db-pbody db-sep"><DbUnavailable id="tools-stats" :what="t('dsh.tl.statsWhat')" :why="t('dsh.tl.statsWhy')" /></div>
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
        <header><h3>{{ t('dsh.tl.serversTitle') }}</h3><span class="db-hm">{{ t('dsh.tl.serversHint', { n: serversDraft.length }) }}</span></header>
        <div v-if="!serversDraft.length" class="db-empty"><b>{{ t('dsh.tl.serversNone') }}</b><span>{{ t('dsh.tl.serversNoneHint') }}</span></div>
        <div v-for="s in serversDraft" :key="s.id" class="db-srv" :data-tools-server="s.id">
          <div class="db-srv-h">
            <button type="button" class="db-btn sm db-srv-x" :aria-expanded="open.has(s.id)" :data-server-expand="s.id" @click="toggleOpen(s.id)">{{ s.name }}</button>
            <span class="db-mono db-muted db-grow">{{ hostOf(s.url) }}</span>
            <span class="db-stat"><span class="dm" :data-k="s.enabled ? 'half' : 'off'" aria-hidden="true"></span>{{ s.enabled ? t('dsh.tl.srvState') : t('dsh.tl.srvOff') }}</span>
            <span class="db-muted">{{ t('dsh.tl.srvTools', { on: Object.values(s.tools ?? {}).filter(Boolean).length, n: Object.keys(s.tools ?? {}).length }) }}</span>
            <button type="button" class="db-sw" role="switch" :aria-checked="!!s.enabled" :aria-label="t('dsh.tl.srvSwitch', { name: s.name })" :data-server-switch="s.id" @click="flipServer(s.id)"><i></i>{{ s.enabled ? t('dsh.tl.srvOn') : t('dsh.tl.srvOff') }}</button>
          </div>
          <div v-if="open.has(s.id)" class="db-srv-b">
            <dl class="db-kv">
              <dt>{{ t('dsh.tl.address') }}</dt>
              <dd class="db-mono">{{ s.url }}</dd>
              <dt>{{ t('dsh.tl.header') }}</dt>
              <dd>
                <template v-if="s.headers && s.headers.length">
                  <div v-for="h in s.headers" :key="h.name">
                    {{ t('dsh.tl.headerFrom', { h: h.name, env: h.env }) }}
                    <span class="db-stat"><span class="dm" :data-k="h.set ? 'ok' : 'warn'" aria-hidden="true"></span>{{ h.set ? t('dsh.tl.envSet') : t('dsh.tl.envUnset') }}</span>
                  </div>
                </template>
                <span v-else class="db-muted">{{ t('dsh.tl.noHeader') }}</span>
              </dd>
            </dl>
            <table v-if="Object.keys(s.tools ?? {}).length" class="db-t">
              <thead><tr><th>{{ t('dsh.tl.colTool') }}</th><th>{{ t('dsh.tl.colSwitch') }}</th></tr></thead>
              <tbody>
                <tr v-for="k in Object.keys(s.tools)" :key="k">
                  <td :data-l="t('dsh.tl.colTool')"><code class="db-tok">{{ k }}</code></td>
                  <td :data-l="t('dsh.tl.colSwitch')"><button type="button" class="db-sw" role="switch" :aria-checked="!!s.tools[k]" :aria-label="t('dsh.tl.switchLabel', { name: k })" :data-server-tool="`${s.id}/${k}`" @click="flipServerTool(s.id, k)"><i></i>{{ s.tools[k] ? t('dsh.tl.on') : t('dsh.tl.off') }}</button></td>
                </tr>
              </tbody>
            </table>
            <p v-else class="db-muted">{{ t('dsh.tl.srvNoTools') }}</p>

            <div v-if="isDev" class="db-btns" style="margin-top: 8px">
              <button type="button" class="db-btn sm" :data-server-discover="s.id" @click="say(t('dsh.tl.manageWhy'))">{{ t('dsh.tl.srvDiscover') }}</button>
              <button type="button" class="db-btn sm db-btn-danger" :data-server-delete="s.id" @click="promptDeleteServer(s)">{{ t('dsh.tl.srvDelete') }}</button>
            </div>

            <div v-if="confirmDeleteId === s.id" class="db-srv-confirm" :data-server-delete-confirm="s.id">
              <p><b>{{ t('dsh.tl.srvDeleteConfirm', { name: s.name }) }}</b></p>
              <p class="db-muted db-small">{{ t('dsh.tl.srvDeleteConfirmBody') }}</p>
              <div class="db-btns" style="margin-top: 8px">
                <button type="button" class="db-btn sm db-btn-danger" :data-server-delete-yes="s.id" @click="confirmDeleteServer(s.id)">{{ t('dsh.tl.srvDeleteYes') }}</button>
                <button type="button" class="db-btn sm" :data-server-delete-no="s.id" @click="confirmDeleteId = null">{{ t('dsh.tl.srvDeleteNo') }}</button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="isDev && toolsEditable" class="db-pbody db-sep">
          <button v-if="!showAddServer" type="button" class="db-btn sm" data-add-server-btn @click="showAddServer = true">{{ t('dsh.tl.addServer') }}</button>
          <div v-else class="db-addsrv" data-add-server-form>
            <h4 style="margin: 0 0 12px">{{ t('dsh.tl.addServerTitle') }}</h4>
            <div class="db-frow one">
              <label for="as-name" class="db-fl">{{ t('dsh.tl.srvName') }}</label>
              <div class="db-fld"><input id="as-name" v-model="newServerName" class="db-in" :placeholder="t('dsh.tl.srvNamePh')" data-add-server-name /></div>
            </div>
            <div class="db-frow one">
              <label for="as-id" class="db-fl">{{ t('dsh.tl.srvId') }}<small>{{ t('dsh.tl.srvIdHint') }}</small></label>
              <div class="db-fld"><input id="as-id" v-model="newServerId" class="db-in db-mono" :placeholder="t('dsh.tl.srvIdPh')" data-add-server-id /></div>
            </div>
            <div class="db-frow one">
              <label for="as-url" class="db-fl">{{ t('dsh.tl.srvUrl') }}<small>{{ t('dsh.tl.srvUrlHint') }}</small></label>
              <div class="db-fld"><input id="as-url" v-model="newServerUrl" class="db-in db-mono" :placeholder="t('dsh.tl.srvUrlPh')" spellcheck="false" data-add-server-url /></div>
            </div>
            <div class="db-frow one">
              <label for="as-hdr" class="db-fl">{{ t('dsh.tl.srvHdr') }}<small>{{ t('dsh.tl.srvHdrHint') }}</small></label>
              <div class="db-fld"><input id="as-hdr" v-model="newServerHdr" class="db-in db-mono" spellcheck="false" data-add-server-hdr /></div>
            </div>
            <div class="db-frow one">
              <label for="as-env" class="db-fl">{{ t('dsh.tl.srvEnv') }}<small>{{ t('dsh.tl.srvEnvHint') }}</small></label>
              <div class="db-fld"><input id="as-env" v-model="newServerEnv" class="db-in db-mono" :placeholder="t('dsh.tl.srvEnvPh')" spellcheck="false" data-add-server-env /></div>
            </div>
            <div v-if="addServerError" class="db-err db-small" style="padding: 4px 0 8px" data-add-server-error>{{ addServerError }}</div>
            <div class="db-btns" style="margin-top: 8px">
              <button type="button" class="db-btn sm primary" data-add-server-submit @click="submitAddServer">{{ t('dsh.tl.srvAddSave') }}</button>
              <button type="button" class="db-btn sm" data-add-server-cancel @click="resetAddForm">{{ t('dsh.tl.srvCancel') }}</button>
            </div>
          </div>
        </div>

        <div class="db-pbody db-sep"><DbUnavailable id="tools-manage" :what="t('dsh.tl.manageWhat')" :why="t('dsh.tl.manageWhy')" /></div>
      </section>

      <section class="db-panel" data-tools-log>
        <header><h3>{{ t('dsh.tl.logTitle') }}</h3><span class="db-hm">{{ t('dsh.tl.logHint') }}</span></header>
        <div class="db-pbody"><DbUnavailable id="tools-log" :what="t('dsh.tl.logTitle')" :why="t('dsh.tl.logWhy')" /></div>
      </section>

      <div class="db-savebar" data-savebar="tools">
        <span class="db-st" :class="{ 'db-err': !!status }" data-tools-status>{{ status || (dirty ? t('dsh.common.unsavedChanges') : savedNote || t('dsh.common.allSaved')) }}</span>
        <button type="button" class="db-btn" :disabled="!dirty" data-tools-discard @click="discard">{{ t('dsh.common.discard') }}</button>
        <button type="button" class="db-btn primary" :disabled="!dirty || saving" data-tools-save @click="save">{{ saving ? t('dsh.common.saving') : t('dsh.tl.save') }}</button>
      </div>
      <p class="db-muted db-small">{{ view.file }}</p>
    </template>

    <div v-else class="db-empty"><span>{{ t('dsh.common.loading') }}</span></div>
  </div>
</template>
