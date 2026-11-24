<script setup lang="ts">
/**
 * PageDatabase.vue — Database engine selector & hot-swap (Neon <-> PGlite),
 * cross-engine data transfer, and whitelisted 6-table browser & CRUD editor.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import {
  createDbTableRow,
  deleteDbTableRow,
  fetchDbConfig,
  fetchDbTableRows,
  fetchDbTables,
  formatAdminError,
  initDb,
  isAdminError,
  isAdminOk,
  isDbSwitchDryRun,
  isDbTransferDryRun,
  migrateDb,
  switchDb,
  testDbConnection,
  transferDb,
  updateDbTableRow,
  type AdminApiError,
  type DbConfigResponse,
  type DbCrudTableName,
  type DbTableMeta,
  type DbTestResponse,
  type DbTransferResponse,
} from '../../api/admin'

const { t } = useT()

const NEON_PRESET_URL = 'postgresql://user:password@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require'
const PGLITE_PRESET_URL = 'pglite:./data/pglite'

const BOOLEAN_COLS = new Set(['disabled', 'is_archived', 'is_completed'])
const INT_COLS = new Set(['priority', 'prompt_tokens', 'completion_tokens'])
const JSONB_COLS = new Set(['roles', 'value'])
const NULLABLE_COLS = new Set([
  'email',
  'completed_at',
  'notion_node_id',
  'notion_page_id',
  'selected_context',
  'section_anchor',
  'pptx_source',
  'last_login_at',
])

const config = ref<DbConfigResponse | null>(null)
const tablesMeta = ref<DbTableMeta[]>([])
const errorMessage = ref('')
const statusMessage = ref('')

// Engine config & switch state
const enginePreset = ref<'neon' | 'pglite'>('pglite')
const targetUrl = ref(PGLITE_PRESET_URL)
const targetDirectUrl = ref('')
const engineBusy = ref(false)
const testResult = ref<DbTestResponse | null>(null)
const dryRunSql = ref('')
const pendingSwitchConfirm = ref(false)

// Transfer state
const transferForm = reactive({
  direction: 'push' as 'push' | 'pull',
  targetUrl: '',
  targetDirectUrl: '',
  conflictStrategy: 'upsert' as 'upsert' | 'skip',
})
const transferBusy = ref(false)
const transferResult = ref<DbTransferResponse | null>(null)
const pendingTransferConfirm = ref(false)

const targetUrlPlaceholder = computed(() =>
  enginePreset.value === 'neon' ? NEON_PRESET_URL : PGLITE_PRESET_URL,
)
const isTargetPostgres = computed(() =>
  targetUrl.value.trim().toLowerCase().startsWith('postgres'),
)
const isTransferPostgres = computed(() =>
  transferForm.targetUrl.trim().toLowerCase().startsWith('postgres') ||
  transferForm.targetDirectUrl.trim() !== '',
)
const transferIsDryRun = computed(() =>
  Boolean(transferResult.value && isDbTransferDryRun(transferResult.value)),
)
const transferDisplayRows = computed<Array<{
  table: string
  sourceCount: number | null
  transferredCount?: number
  targetCount: number | null
}>>(() => {
  const res = transferResult.value
  if (!res) return []
  return isDbTransferDryRun(res) ? res.tables : res.results
})

// CRUD Browser state
const activeTable = ref<DbCrudTableName>('progress')
const rows = ref<Array<Record<string, unknown>>>([])
const totalRows = ref(0)
const limit = ref(25)
const offset = ref(0)
const searchQ = ref('')
const sortCol = ref('updated_at')
const sortOrder = ref<'asc' | 'desc'>('desc')
const rowsLoading = ref(false)

// Row editor state
const editorMode = ref<'closed' | 'create' | 'edit'>('closed')
const editingPk = ref<string | Record<string, string> | null>(null)
const editorFields = ref<Record<string, string | boolean>>({})
const editorBusy = ref(false)
const pendingDeleteRow = ref<Record<string, unknown> | null>(null)

const currentTableMeta = computed<DbTableMeta | undefined>(() =>
  tablesMeta.value.find((tbl) => tbl.name === activeTable.value),
)

const visibleColumns = computed<string[]>(() => {
  const metaCols = currentTableMeta.value?.columns
  if (metaCols && metaCols.length > 0) {
    return metaCols.filter((c) => c !== 'password_hash')
  }
  const first = rows.value[0]
  return first ? Object.keys(first).filter((c) => c !== 'password_hash') : []
})

const editableFormColumns = computed<string[]>(() => {
  const meta = currentTableMeta.value
  if (!meta) return []
  if (editorMode.value === 'create') {
    const base = [...meta.columns.filter((c) => c !== 'password_hash')]
    if (meta.name === 'auth_users' && !base.includes('password')) {
      base.push('password')
    }
    return base
  }
  return [...meta.editableColumns]
})

function mapDbError(err: AdminApiError): string {
  if (err.code === 'cannot_remove_last_admin') return t('dsh.usr.errLastAdmin')
  return formatAdminError(err)
}

function selectPreset(preset: 'neon' | 'pglite'): void {
  enginePreset.value = preset
  pendingSwitchConfirm.value = false
  if (preset === 'neon') {
    if (!targetUrl.value.trim().toLowerCase().startsWith('postgres')) {
      targetUrl.value = ''
    }
  } else {
    targetUrl.value = PGLITE_PRESET_URL
    targetDirectUrl.value = ''
  }
}

async function refreshTablesMeta(): Promise<void> {
  const tblRes = await fetchDbTables()
  if (isAdminOk(tblRes)) {
    tablesMeta.value = tblRes.data.tables
  }
}

async function loadInitial(): Promise<void> {
  errorMessage.value = ''
  const [cfgRes, tblRes] = await Promise.all([fetchDbConfig(), fetchDbTables()])
  if (isAdminOk(cfgRes)) {
    config.value = cfgRes.data
    if (cfgRes.data.kind === 'pg') {
      enginePreset.value = 'neon'
      if (targetUrl.value === PGLITE_PRESET_URL) {
        targetUrl.value = ''
      }
    } else {
      enginePreset.value = 'pglite'
    }
  } else if (isAdminError(cfgRes)) {
    errorMessage.value = mapDbError(cfgRes.error)
  }

  if (isAdminOk(tblRes)) {
    tablesMeta.value = tblRes.data.tables
    const current = tablesMeta.value.find((tbl) => tbl.name === activeTable.value) ?? tablesMeta.value[0]
    if (current) {
      activeTable.value = current.name
      sortCol.value = current.defaultSort
    }
    await loadRows()
  } else if (isAdminError(tblRes) && !errorMessage.value) {
    errorMessage.value = mapDbError(tblRes.error)
  }
}

async function loadRows(allowRetry = true): Promise<void> {
  errorMessage.value = ''
  rowsLoading.value = true
  const res = await fetchDbTableRows(activeTable.value, {
    limit: limit.value,
    offset: offset.value,
    sort: sortCol.value,
    order: sortOrder.value,
    ...(searchQ.value.trim() ? { q: searchQ.value.trim() } : {}),
  })
  rowsLoading.value = false
  if (isAdminOk(res)) {
    if (allowRetry && res.data.rows.length === 0 && res.data.total > 0 && offset.value > 0) {
      offset.value = Math.max(0, Math.floor((res.data.total - 1) / limit.value) * limit.value)
      await loadRows(false)
      return
    }
    rows.value = res.data.rows
    totalRows.value = res.data.total
    sortCol.value = res.data.sort
    sortOrder.value = res.data.order
  } else if (isAdminError(res)) {
    errorMessage.value = mapDbError(res.error)
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    void loadInitial()
  }
})

async function onTestConnection(): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  const trimmedUrl = targetUrl.value.trim()
  if (!trimmedUrl) {
    errorMessage.value = t('dsh.db.errTargetUrlRequired')
    return
  }
  engineBusy.value = true
  const res = await testDbConnection({
    targetUrl: trimmedUrl,
    ...(targetDirectUrl.value.trim() ? { targetDirectUrl: targetDirectUrl.value.trim() } : {}),
  })
  engineBusy.value = false
  if (!isAdminOk(res)) {
    errorMessage.value = isAdminError(res) ? mapDbError(res.error) : 'unknown_error'
    return
  }
  testResult.value = res.data
  if (res.data.ok) {
    statusMessage.value = t('dsh.db.testOk', {
      kind: res.data.kind ?? '',
      ms: res.data.latencyMs,
      applied: res.data.migrationsApplied ?? 0,
      pending: res.data.migrationsPending ?? 0,
    })
  } else {
    errorMessage.value = t('dsh.db.testFail', {
      ms: res.data.latencyMs,
      error: res.data.error ?? 'error',
    })
  }
}

async function onDryRunSql(): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  pendingSwitchConfirm.value = false
  engineBusy.value = true
  const res = await migrateDb({
    targetUrl: targetUrl.value.trim() || null,
    ...(targetDirectUrl.value.trim() ? { targetDirectUrl: targetDirectUrl.value.trim() } : {}),
    dryRun: true,
  })
  engineBusy.value = false
  if (!isAdminOk(res)) {
    errorMessage.value = isAdminError(res) ? mapDbError(res.error) : 'unknown_error'
    return
  }
  dryRunSql.value = res.data.dryRunSql
}

async function onInitMigrate(): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  pendingSwitchConfirm.value = false
  engineBusy.value = true
  const res = await initDb({
    targetUrl: targetUrl.value.trim() || null,
    ...(targetDirectUrl.value.trim() ? { targetDirectUrl: targetDirectUrl.value.trim() } : {}),
    dryRun: false,
  })
  engineBusy.value = false
  if (!isAdminOk(res)) {
    errorMessage.value = isAdminError(res) ? mapDbError(res.error) : 'unknown_error'
    return
  }
  statusMessage.value = t('dsh.db.migrateOk', { n: res.data.applied.length })
  await loadInitial()
}

function requestSwitchLive(): void {
  errorMessage.value = ''
  statusMessage.value = ''
  if (!targetUrl.value.trim()) {
    errorMessage.value = t('dsh.db.errTargetUrlRequired')
    return
  }
  pendingSwitchConfirm.value = true
}

async function onSwitchCheck(dryRun: boolean): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  const trimmedUrl = targetUrl.value.trim()
  if (!trimmedUrl) {
    pendingSwitchConfirm.value = false
    errorMessage.value = t('dsh.db.errTargetUrlRequired')
    return
  }
  if (dryRun) {
    pendingSwitchConfirm.value = false
  }
  engineBusy.value = true
  const res = await switchDb({
    targetUrl: trimmedUrl,
    ...(targetDirectUrl.value.trim() ? { targetDirectUrl: targetDirectUrl.value.trim() } : {}),
    dryRun,
    autoMigrate: true,
    updateEnv: true,
  })
  engineBusy.value = false
  pendingSwitchConfirm.value = false
  if (!isAdminOk(res)) {
    errorMessage.value = isAdminError(res) ? mapDbError(res.error) : 'unknown_error'
    return
  }
  const sw = res.data
  if (isDbSwitchDryRun(sw)) {
    dryRunSql.value = sw.dryRunSql
    statusMessage.value = t('dsh.db.switchDryRunOk', {
      from: sw.previousKind,
      to: sw.targetKind,
      n: sw.migrationsPending.length,
    })
  } else {
    statusMessage.value = t('dsh.db.switchOk', {
      kind: sw.currentKind,
      from: sw.previousKind,
      backup: sw.backupPath ?? t('dsh.db.noBackupPath'),
    })
    await loadInitial()
  }
}

function requestTransferLive(): void {
  errorMessage.value = ''
  statusMessage.value = ''
  if (!transferForm.targetUrl.trim()) {
    errorMessage.value = t('dsh.db.errTargetUrlRequired')
    return
  }
  pendingTransferConfirm.value = true
}

async function onTransfer(dryRun: boolean): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  const trimmedUrl = transferForm.targetUrl.trim()
  if (!trimmedUrl) {
    pendingTransferConfirm.value = false
    errorMessage.value = t('dsh.db.errTargetUrlRequired')
    return
  }
  if (dryRun) {
    pendingTransferConfirm.value = false
  }
  transferBusy.value = true
  const res = await transferDb({
    targetUrl: trimmedUrl,
    ...(transferForm.targetDirectUrl.trim()
      ? { targetDirectUrl: transferForm.targetDirectUrl.trim() }
      : {}),
    direction: transferForm.direction,
    conflictStrategy: transferForm.conflictStrategy,
    dryRun,
    migrateTarget: true,
  })
  transferBusy.value = false
  pendingTransferConfirm.value = false
  if (!isAdminOk(res)) {
    errorMessage.value = isAdminError(res) ? mapDbError(res.error) : 'unknown_error'
    return
  }
  transferResult.value = res.data
  if (!isDbTransferDryRun(res.data)) {
    await loadInitial()
  }
}

function selectTable(name: DbCrudTableName): void {
  activeTable.value = name
  const meta = tablesMeta.value.find((m) => m.name === name)
  sortCol.value = meta?.defaultSort ?? 'updated_at'
  sortOrder.value = 'desc'
  offset.value = 0
  searchQ.value = ''
  editorMode.value = 'closed'
  pendingDeleteRow.value = null
  void loadRows()
}

function formatCell(val: unknown): string {
  if (val === null || val === undefined) return '—'
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

function pkOfRow(row: Record<string, unknown>): string | Record<string, string> {
  const pks = currentTableMeta.value?.pkColumns ?? ['id']
  if (pks.length === 1) {
    return String(row[pks[0]!] ?? '')
  }
  const out: Record<string, string> = {}
  for (const col of pks) {
    out[col] = String(row[col] ?? '')
  }
  return out
}

function rowKey(row: Record<string, unknown>, idx: number): string {
  const pk = pkOfRow(row)
  if (typeof pk === 'string') return pk || String(idx)
  return JSON.stringify(pk)
}

function openCreateRow(): void {
  errorMessage.value = ''
  editorMode.value = 'create'
  editingPk.value = null
  const fields: Record<string, string | boolean> = {}
  for (const col of editableFormColumns.value) {
    if (BOOLEAN_COLS.has(col)) fields[col] = false
    else if (col === 'roles') fields[col] = '["reader"]'
    else if (col === 'value') fields[col] = '{}'
    else fields[col] = ''
  }
  editorFields.value = fields
}

function openEditRow(row: Record<string, unknown>): void {
  errorMessage.value = ''
  editorMode.value = 'edit'
  editingPk.value = pkOfRow(row)
  const fields: Record<string, string | boolean> = {}
  for (const col of editableFormColumns.value) {
    const raw = row[col]
    if (BOOLEAN_COLS.has(col)) fields[col] = Boolean(raw)
    else if (JSONB_COLS.has(col)) fields[col] = raw !== undefined ? JSON.stringify(raw) : '{}'
    else if (col === 'password') fields[col] = ''
    else fields[col] = raw === null || raw === undefined ? '' : String(raw)
  }
  editorFields.value = fields
}

async function onSaveRow(): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  const payload: Record<string, unknown> = {}

  for (const col of editableFormColumns.value) {
    const raw = editorFields.value[col]
    if (BOOLEAN_COLS.has(col)) {
      payload[col] = Boolean(raw)
      continue
    }
    const strVal = typeof raw === 'string' ? raw : ''
    if (col === 'password') {
      if (strVal !== '') payload[col] = strVal
      continue
    }
    if (JSONB_COLS.has(col)) {
      if (strVal.trim() === '') {
        errorMessage.value = t('dsh.db.errInvalidJson', { col })
        return
      }
      try {
        payload[col] = JSON.parse(strVal)
      } catch {
        errorMessage.value = t('dsh.db.errInvalidJson', { col })
        return
      }
      continue
    }
    if (INT_COLS.has(col)) {
      const trimmed = strVal.trim()
      if (trimmed === '') {
        if (editorMode.value === 'create') {
          continue
        }
        errorMessage.value = t('dsh.db.errInvalidInt', { col })
        return
      }
      const num = Number(trimmed)
      if (!/^-?\d+$/.test(trimmed) || !Number.isSafeInteger(num)) {
        errorMessage.value = t('dsh.db.errInvalidInt', { col })
        return
      }
      payload[col] = num
      continue
    }
    if (editorMode.value === 'create' && strVal.trim() === '') {
      // Omit empty optional strings on insert (e.g. auto-UUID id or defaults)
      continue
    }
    payload[col] = strVal.trim() === '' ? (NULLABLE_COLS.has(col) ? null : '') : strVal
  }

  const savedMode = editorMode.value
  editorBusy.value = true
  const res =
    savedMode === 'create'
      ? await createDbTableRow(activeTable.value, payload)
      : await updateDbTableRow(activeTable.value, editingPk.value!, payload)
  editorBusy.value = false

  if (!isAdminOk(res)) {
    errorMessage.value = isAdminError(res) ? mapDbError(res.error) : 'unknown_error'
    return
  }

  editorMode.value = 'closed'
  statusMessage.value = t('dsh.db.rowSaved')
  await Promise.all([loadRows(), savedMode === 'create' ? refreshTablesMeta() : Promise.resolve()])
}

async function onDeleteRow(row: Record<string, unknown>): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  editorBusy.value = true
  const res = await deleteDbTableRow(activeTable.value, pkOfRow(row))
  editorBusy.value = false
  if (!isAdminOk(res)) {
    errorMessage.value = isAdminError(res) ? mapDbError(res.error) : 'unknown_error'
    return
  }
  pendingDeleteRow.value = null
  statusMessage.value = t('dsh.db.rowDeleted')
  await Promise.all([loadRows(), refreshTablesMeta()])
}
</script>

<template>
  <div class="db-page" data-page="database">
    <header class="db-ph">
      <h2>{{ t('dsh.db.title') }}</h2>
      <p>{{ t('dsh.db.lead') }}</p>
    </header>

    <div v-if="errorMessage" class="db-errbox" role="alert" data-db-error>
      {{ errorMessage }}
    </div>

    <div v-if="statusMessage" class="db-banner" role="status" data-db-status>
      <span class="db-info" aria-hidden="true"></span>
      <span>{{ statusMessage }}</span>
    </div>

    <section v-if="config" class="db-panel" data-db-status-panel>
      <header>
        <h3>{{ t('dsh.db.statusTitle') }}</h3>
        <span class="db-tag db-mono" data-db-active-kind>{{ config.kind }}</span>
      </header>
      <div class="db-pbody">
        <dl class="db-kv">
          <dt>{{ t('dsh.db.kind') }}</dt>
          <dd class="db-mono">{{ config.kind }}</dd>
          <dt>{{ t('dsh.db.url') }}</dt>
          <dd class="db-mono">{{ config.databaseUrl || '—' }}</dd>
          <dt>{{ t('dsh.db.directUrl') }}</dt>
          <dd class="db-mono">{{ config.databaseUrlDirect || '—' }}</dd>
          <dt>{{ t('dsh.db.migrations') }}</dt>
          <dd>
            {{
              t('dsh.db.migrationsVal', {
                applied: config.migrations.applied,
                total: config.migrations.total,
                pending: config.migrations.pending,
              })
            }}
          </dd>
          <dt>{{ t('dsh.db.envFile') }}</dt>
          <dd>
            {{ config.envWritable ? t('dsh.db.envWritableYes') : t('dsh.db.envWritableNo') }}
            <span v-if="config.envFilePath" class="db-mono db-muted"> ({{ config.envFilePath }})</span>
          </dd>
        </dl>
      </div>
    </section>

    <section class="db-panel" data-db-switch-panel>
      <header>
        <h3>{{ t('dsh.db.switchTitle') }}</h3>
      </header>
      <div class="db-pbody db-grid">
        <div class="db-btns" role="radiogroup" :aria-label="t('dsh.db.switchTitle')">
          <button
            type="button"
            class="db-skinopt"
            role="radio"
            :aria-checked="enginePreset === 'neon'"
            data-db-preset-neon
            @click="selectPreset('neon')"
          >
            <strong>{{ t('dsh.db.presetNeon') }}</strong>
            <small>{{ t('dsh.db.presetNeonHint') }}</small>
          </button>
          <button
            type="button"
            class="db-skinopt"
            role="radio"
            :aria-checked="enginePreset === 'pglite'"
            data-db-preset-pglite
            @click="selectPreset('pglite')"
          >
            <strong>{{ t('dsh.db.presetPglite') }}</strong>
            <small>{{ t('dsh.db.presetPgliteHint') }}</small>
          </button>
        </div>

        <div class="db-frow one">
          <label class="db-fl" for="db-target-url">{{ t('dsh.db.targetUrl') }}</label>
          <div class="db-fld">
            <input
              id="db-target-url"
              v-model="targetUrl"
              class="db-in db-mono"
              type="text"
              :placeholder="targetUrlPlaceholder"
              data-db-target-url
            />
          </div>
        </div>

        <div v-if="enginePreset === 'neon' || isTargetPostgres" class="db-frow one">
          <label class="db-fl" for="db-target-direct">{{ t('dsh.db.targetDirectUrl') }}</label>
          <div class="db-fld">
            <input id="db-target-direct" v-model="targetDirectUrl" class="db-in db-mono" type="text" data-db-target-direct />
          </div>
        </div>

        <div class="db-btns">
          <button type="button" class="db-btn" :disabled="engineBusy" data-db-test-btn @click="onTestConnection">
            {{ t('dsh.db.testBtn') }}
          </button>
          <button type="button" class="db-btn" :disabled="engineBusy" data-db-dryrun-sql-btn @click="onDryRunSql">
            {{ t('dsh.db.dryRunSqlBtn') }}
          </button>
          <button type="button" class="db-btn" :disabled="engineBusy" data-db-init-btn @click="onInitMigrate">
            {{ t('dsh.db.initMigrateBtn') }}
          </button>
          <button type="button" class="db-btn" :disabled="engineBusy" data-db-dryrun-switch-btn @click="onSwitchCheck(true)">
            {{ t('dsh.db.dryRunSwitchBtn') }}
          </button>
          <button type="button" class="db-btn primary" :disabled="engineBusy" data-db-switch-btn @click="requestSwitchLive">
            {{ t('dsh.db.switchBtn') }}
          </button>
        </div>

        <div v-if="pendingSwitchConfirm" class="db-errbox" role="alert" data-db-switch-confirm>
          <div class="db-grid">
            <strong>{{ t('dsh.db.confirmSwitchLive', { target: targetUrl.trim() }) }}</strong>
            <div class="db-btns">
              <button
                type="button"
                class="db-btn sm primary"
                :disabled="engineBusy"
                data-db-confirm-switch
                @click="onSwitchCheck(false)"
              >
                {{ t('dsh.db.confirmSwitchBtn') }}
              </button>
              <button
                type="button"
                class="db-btn sm"
                data-db-cancel-switch
                @click="pendingSwitchConfirm = false"
              >
                {{ t('dsh.common.cancel') }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="testResult && testResult.ok" class="db-small db-muted" data-db-test-meta>
          {{ testResult.serverVersion }}
        </div>

        <pre v-if="dryRunSql" class="db-codeb" data-db-dryrun-sql>{{ dryRunSql }}</pre>
      </div>
    </section>

    <section class="db-panel" data-db-transfer-panel>
      <header>
        <h3>{{ t('dsh.db.transferTitle') }}</h3>
      </header>
      <div class="db-pbody db-grid">
        <div class="db-two">
          <div class="db-fld">
            <label class="db-fl" for="db-xfer-dir">{{ t('dsh.db.transferDirection') }}</label>
            <select id="db-xfer-dir" v-model="transferForm.direction" class="db-in" data-db-transfer-direction>
              <option value="push">{{ t('dsh.db.dirPush') }}</option>
              <option value="pull">{{ t('dsh.db.dirPull') }}</option>
            </select>
          </div>
          <div class="db-fld">
            <label class="db-fl" for="db-xfer-strat">{{ t('dsh.db.conflictStrategy') }}</label>
            <select id="db-xfer-strat" v-model="transferForm.conflictStrategy" class="db-in" data-db-transfer-strategy>
              <option value="upsert">{{ t('dsh.db.stratUpsert') }}</option>
              <option value="skip">{{ t('dsh.db.stratSkip') }}</option>
            </select>
          </div>
        </div>

        <div class="db-frow one">
          <label class="db-fl" for="db-xfer-url">{{ t('dsh.db.targetUrl') }}</label>
          <div class="db-fld">
            <input
              id="db-xfer-url"
              v-model="transferForm.targetUrl"
              class="db-in db-mono"
              type="text"
              :placeholder="NEON_PRESET_URL"
              data-db-transfer-url
            />
          </div>
        </div>

        <div v-if="isTransferPostgres" class="db-frow one">
          <label class="db-fl" for="db-xfer-direct">{{ t('dsh.db.targetDirectUrl') }}</label>
          <div class="db-fld">
            <input
              id="db-xfer-direct"
              v-model="transferForm.targetDirectUrl"
              class="db-in db-mono"
              type="text"
              data-db-transfer-direct
            />
          </div>
        </div>

        <div class="db-btns">
          <button type="button" class="db-btn" :disabled="transferBusy" data-db-transfer-dryrun @click="onTransfer(true)">
            {{ t('dsh.db.transferDryRunBtn') }}
          </button>
          <button type="button" class="db-btn primary" :disabled="transferBusy" data-db-transfer-run @click="requestTransferLive">
            {{ t('dsh.db.transferRunBtn') }}
          </button>
        </div>

        <div v-if="pendingTransferConfirm" class="db-errbox" role="alert" data-db-transfer-confirm>
          <div class="db-grid">
            <strong>
              {{
                t('dsh.db.confirmTransferLive', {
                  direction: transferForm.direction,
                  strategy: transferForm.conflictStrategy,
                })
              }}
            </strong>
            <div class="db-btns">
              <button
                type="button"
                class="db-btn sm primary"
                :disabled="transferBusy"
                data-db-confirm-transfer
                @click="onTransfer(false)"
              >
                {{ t('dsh.db.confirmTransferBtn') }}
              </button>
              <button
                type="button"
                class="db-btn sm"
                data-db-cancel-transfer
                @click="pendingTransferConfirm = false"
              >
                {{ t('dsh.common.cancel') }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="transferResult" class="db-tw" data-db-transfer-result>
          <table class="db-t">
            <thead>
              <tr>
                <th>{{ t('dsh.db.colTable') }}</th>
                <th class="n">{{ t('dsh.db.colSourceCount') }}</th>
                <th v-if="!transferIsDryRun" class="n">{{ t('dsh.db.colTransferredCount') }}</th>
                <th class="n">{{ t('dsh.db.colTargetCount') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in transferDisplayRows" :key="item.table">
                <td :data-l="t('dsh.db.colTable')" class="db-mono">{{ item.table }}</td>
                <td :data-l="t('dsh.db.colSourceCount')" class="n">{{ item.sourceCount ?? '—' }}</td>
                <td v-if="!transferIsDryRun" :data-l="t('dsh.db.colTransferredCount')" class="n">
                  {{ item.transferredCount ?? '—' }}
                </td>
                <td :data-l="t('dsh.db.colTargetCount')" class="n">{{ item.targetCount ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="db-panel" data-db-crud-panel>
      <header>
        <h3>{{ t('dsh.db.crudTitle') }}</h3>
        <span class="db-hm">{{ t('dsh.db.crudHint') }}</span>
      </header>

      <div class="db-pbody db-grid">
        <div class="db-tabs" role="tablist" :aria-label="t('dsh.db.crudTitle')">
          <button
            v-for="tbl in tablesMeta"
            :key="tbl.name"
            type="button"
            role="tab"
            :aria-selected="activeTable === tbl.name"
            :data-db-table-tab="tbl.name"
            @click="selectTable(tbl.name)"
          >
            <span class="db-mono">{{ tbl.name }}</span>
            <span v-if="tbl.rowCount !== null" class="db-tag">{{ tbl.rowCount }}</span>
          </button>
        </div>

        <div class="db-btns">
          <input
            v-model="searchQ"
            class="db-in db-in-sm db-grow"
            type="search"
            :aria-label="t('dsh.db.searchPh')"
            :placeholder="t('dsh.db.searchPh')"
            data-db-search-input
            @keydown.enter="offset = 0; loadRows()"
          />
          <button type="button" class="db-btn sm" data-db-search-btn @click="offset = 0; loadRows()">
            {{ t('dsh.db.searchBtn') }}
          </button>
          <select v-model="sortCol" class="db-in db-in-sm" :aria-label="t('dsh.db.sortCol')" data-db-sort-col @change="offset = 0; loadRows()">
            <option v-for="col in visibleColumns" :key="col" :value="col">{{ col }}</option>
          </select>
          <select v-model="sortOrder" class="db-in db-in-sm" :aria-label="t('dsh.db.sortOrder')" data-db-sort-order @change="offset = 0; loadRows()">
            <option value="desc">DESC</option>
            <option value="asc">ASC</option>
          </select>
          <button type="button" class="db-btn sm primary" data-db-add-row @click="openCreateRow">
            + {{ t('dsh.db.addRowBtn') }}
          </button>
        </div>

        <section v-if="editorMode !== 'closed'" class="db-panel" data-db-row-editor>
          <header>
            <h3>
              {{
                editorMode === 'create'
                  ? t('dsh.db.createRowTitle', { table: activeTable })
                  : t('dsh.db.editRowTitle', { table: activeTable })
              }}
            </h3>
            <button type="button" class="db-btn sm" @click="editorMode = 'closed'">
              {{ t('dsh.common.cancel') }}
            </button>
          </header>
          <form class="db-grid" @submit.prevent="onSaveRow">
            <div v-for="col in editableFormColumns" :key="col" class="db-frow one">
              <label class="db-fl" :for="`crud-col-${col}`">
                <code>{{ col }}</code>
                <small v-if="col === 'password'">{{ t('dsh.db.passwordOptionalHint') }}</small>
              </label>
              <div class="db-fld">
                <label v-if="BOOLEAN_COLS.has(col)" class="db-ck">
                  <input
                    :id="`crud-col-${col}`"
                    v-model="editorFields[col]"
                    type="checkbox"
                    :data-db-field="col"
                  />
                  <span>{{ col }}</span>
                </label>
                <textarea
                  v-else-if="JSONB_COLS.has(col)"
                  :id="`crud-col-${col}`"
                  v-model="editorFields[col] as string"
                  class="db-in db-mono"
                  :data-db-field="col"
                ></textarea>
                <input
                  v-else
                  :id="`crud-col-${col}`"
                  v-model="editorFields[col] as string"
                  class="db-in"
                  :type="col === 'password' ? 'password' : 'text'"
                  :data-db-field="col"
                />
              </div>
            </div>
            <div class="db-pbody db-sep db-btns">
              <button type="submit" class="db-btn primary" :disabled="editorBusy" data-db-save-row>
                {{ t('dsh.db.saveRowBtn') }}
              </button>
              <button type="button" class="db-btn" @click="editorMode = 'closed'">
                {{ t('dsh.common.cancel') }}
              </button>
            </div>
          </form>
        </section>

        <div v-if="pendingDeleteRow" class="db-errbox" role="alert" data-db-delete-confirm>
          <div class="db-grid">
            <strong>{{ t('dsh.db.deleteRowConfirm', { table: activeTable }) }}</strong>
            <span v-if="activeTable === 'ai_sessions'" class="db-warn" data-db-cascade-warn>
              {{ t('dsh.db.cascadeWarnSessions') }}
            </span>
            <div class="db-btns">
              <button
                type="button"
                class="db-btn sm danger"
                :disabled="editorBusy"
                data-db-confirm-delete-row
                @click="onDeleteRow(pendingDeleteRow)"
              >
                {{ t('dsh.me.confirmYes') }}
              </button>
              <button type="button" class="db-btn sm" @click="pendingDeleteRow = null">
                {{ t('dsh.common.cancel') }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="rowsLoading" class="db-muted">{{ t('dsh.common.loading') }}</div>
        <div v-else-if="rows.length === 0" class="db-empty">
          <b>{{ t('dsh.db.noRows') }}</b>
        </div>
        <div v-else class="db-tw">
          <table class="db-t">
            <thead>
              <tr>
                <th v-for="col in visibleColumns" :key="col">{{ col }}</th>
                <th>{{ t('dsh.me.colActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in rows" :key="rowKey(row, idx)" :data-db-row="idx">
                <td v-for="col in visibleColumns" :key="col" :data-l="col" class="db-small db-mono">
                  {{ formatCell(row[col]) }}
                </td>
                <td :data-l="t('dsh.me.colActions')">
                  <div class="db-btns">
                    <button
                      type="button"
                      class="db-btn sm"
                      :data-db-edit-row="idx"
                      @click="openEditRow(row)"
                    >
                      {{ t('dsh.db.editRowBtn') }}
                    </button>
                    <button
                      type="button"
                      class="db-btn sm danger"
                      :data-db-delete-row="idx"
                      @click="pendingDeleteRow = row"
                    >
                      {{ t('dsh.db.deleteRowBtn') }}
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="db-btns">
          <span class="db-small db-muted">
            {{
              t('dsh.db.pagination', {
                from: totalRows === 0 ? 0 : offset + 1,
                to: Math.min(offset + limit, totalRows),
                total: totalRows,
              })
            }}
          </span>
          <button
            type="button"
            class="db-btn sm"
            :disabled="offset === 0 || rowsLoading"
            data-db-prev-page
            @click="offset = Math.max(0, offset - limit); loadRows()"
          >
            {{ t('dsh.db.prevPage') }}
          </button>
          <button
            type="button"
            class="db-btn sm"
            :disabled="offset + limit >= totalRows || rowsLoading"
            data-db-next-page
            @click="offset = offset + limit; loadRows()"
          >
            {{ t('dsh.db.nextPage') }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
