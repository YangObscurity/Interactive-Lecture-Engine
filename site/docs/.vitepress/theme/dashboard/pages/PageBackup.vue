<script setup lang="ts">
/**
 * PageBackup.vue — 备份: what the deployment backs up and how to rehearse a restore.
 * In dev mode, displays reference facts & unavailable stubs.
 * In online mode (admin only), provides backup archive listing, logical snapshot creation,
 * dry-run restore validation, and confirmed restore integrity checks against lecture-api.
 */
import { computed, onMounted, ref } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import type { OnlineBackupEntry, OnlineBackupRestoreResult, OnlineBackupSnapshot } from '../../api/admin'
import { dashboardClient } from '../dashboardClient'
import { shortDateTime } from '../dashboardData'
import DbHead from '../DbHead.vue'
import DbUnavailable from '../DbUnavailable.vue'
import { canAccessPage, canWritePage, dashboardState } from '../useDashboard'

const { t } = useT()

const isOnline = computed(() => dashboardState.mode === 'online' && canAccessPage('backup'))
const ro = computed(() => !canWritePage('backup'))

const loading = ref(false)
const creating = ref(false)
const verifying = ref(false)
const backupDir = ref('')
const backups = ref<OnlineBackupEntry[]>([])
const errorMessage = ref('')
const statusMessage = ref('')
const lastSnapshot = ref<OnlineBackupSnapshot | null>(null)
const restoreResult = ref<OnlineBackupRestoreResult | null>(null)
const confirmingFilename = ref<string | null>(null)

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`
}

async function loadBackups(): Promise<void> {
  if (!isOnline.value) return
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await dashboardClient.fetchBackups()
    if (res.ok) {
      backupDir.value = res.backupDir ?? ''
      backups.value = res.backups
    } else {
      errorMessage.value = res.error || 'request_failed'
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function onCreateBackup(): Promise<void> {
  if (creating.value) return
  creating.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const res = await dashboardClient.createBackup()
    if (res.ok && res.snapshot) {
      lastSnapshot.value = res.snapshot
      statusMessage.value = t('dsh.bk.createOk', {
        file: res.snapshot.filename,
        sha: res.snapshot.sha256 ? res.snapshot.sha256.slice(0, 8) : '—',
      })
      await loadBackups()
    } else {
      errorMessage.value = res.error || 'request_failed'
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

async function onDryRun(filename: string): Promise<void> {
  if (verifying.value) return
  verifying.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  confirmingFilename.value = null
  try {
    const res = await dashboardClient.restoreBackup({ filename, dryRun: true })
    if (res.ok && res.result) {
      restoreResult.value = res.result
      statusMessage.value = t('dsh.bk.dryRunOk', {
        file: filename,
        checksum: res.result.verifiedChecksum ? t('dsh.bk.checksumOk') : t('dsh.bk.checksumNone'),
      })
    } else {
      errorMessage.value = res.error || 'request_failed'
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    verifying.value = false
  }
}

async function onConfirmRestore(filename: string): Promise<void> {
  if (verifying.value) return
  verifying.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  confirmingFilename.value = null
  try {
    const res = await dashboardClient.restoreBackup({ filename, dryRun: false })
    if (res.ok && res.result) {
      restoreResult.value = res.result
      statusMessage.value = t('dsh.bk.restoreOk', { msg: res.result.message })
    } else {
      errorMessage.value = res.error || 'request_failed'
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    verifying.value = false
  }
}

onMounted(() => {
  if (isOnline.value) {
    void loadBackups()
  }
})
</script>

<template>
  <div class="db-page" data-page="backup">
    <DbHead :title="t('dsh.nav.backup')" :lead="t('dsh.bk.lead')" :read-only="ro" />

    <section class="db-panel" data-backup-facts>
      <header><h3>{{ t('dsh.bk.factsTitle') }}</h3><span class="db-hm"><code>docs-dev/BACKUP.md</code></span></header>
      <div class="db-pbody">
        <dl class="db-kv">
          <dt>{{ t('dsh.bk.what') }}</dt><dd>{{ t('dsh.bk.whatValue') }}</dd>
          <dt>{{ t('dsh.bk.when') }}</dt><dd>{{ t('dsh.bk.whenValue') }}</dd>
          <dt>{{ t('dsh.bk.commands') }}</dt><dd><code>npm run db:backup</code> · <code>npm run db:restore</code> <span class="db-muted">({{ t('dsh.bk.inServer') }})</span></dd>
          <dt>{{ t('dsh.bk.content') }}</dt><dd>{{ t('dsh.bk.contentValue') }}</dd>
        </dl>
      </div>
    </section>

    <template v-if="!isOnline">
      <DbUnavailable id="backup-list" :what="t('dsh.bk.listWhat')" :why="t('dsh.bk.listWhy')" />
      <DbUnavailable id="backup-drill" :what="t('dsh.bk.drillWhat')" :why="t('dsh.bk.drillWhy')" />
    </template>

    <template v-else>
      <div v-if="errorMessage" class="db-errbox" role="alert" data-backup-error>
        {{ errorMessage }}
      </div>

      <div v-if="statusMessage" class="db-banner" role="status" data-backup-status>
        <span class="db-info" aria-hidden="true"></span>
        <span>{{ statusMessage }}</span>
      </div>

      <section class="db-panel" data-backup-panel>
        <header>
          <h3>{{ t('dsh.bk.listTitle') }}</h3>
          <div class="db-btns">
            <button
              type="button"
              class="db-btn"
              :disabled="loading"
              @click="loadBackups"
            >
              {{ t('dsh.bk.refreshBtn') }}
            </button>
            <button
              type="button"
              class="db-btn primary"
              :disabled="creating"
              data-backup-create
              @click="onCreateBackup"
            >
              {{ creating ? t('dsh.bk.creating') : t('dsh.bk.createBtn') }}
            </button>
          </div>
        </header>

        <div class="db-pbody">
          <div v-if="backupDir" class="db-stat">
            <b>{{ t('dsh.bk.backupDir') }}</b>
            <code class="db-mono db-small">{{ backupDir }}</code>
          </div>

          <p v-if="loading && backups.length === 0" class="db-muted">{{ t('dsh.common.loading') }}</p>
          <p v-else-if="backups.length === 0" class="db-empty db-muted">{{ t('dsh.bk.empty') }}</p>

          <div v-else class="db-tw">
            <table class="db-t">
              <thead>
                <tr>
                  <th>{{ t('dsh.bk.colFile') }}</th>
                  <th>{{ t('dsh.bk.colSize') }}</th>
                  <th>{{ t('dsh.bk.colSha') }}</th>
                  <th>{{ t('dsh.bk.colCreated') }}</th>
                  <th>{{ t('dsh.bk.colActions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in backups" :key="b.filename" :data-backup-row="b.filename">
                  <td :data-l="t('dsh.bk.colFile')" class="db-mono db-small">
                    <code>{{ b.filename }}</code>
                  </td>
                  <td :data-l="t('dsh.bk.colSize')" class="db-mono db-small">
                    {{ formatBytes(b.sizeBytes) }}
                  </td>
                  <td :data-l="t('dsh.bk.colSha')" class="db-mono db-small">
                    {{ b.sha256 ? b.sha256.slice(0, 8) : '—' }}
                  </td>
                  <td :data-l="t('dsh.bk.colCreated')" class="db-mono db-small">
                    {{ b.createdAt ? shortDateTime(b.createdAt) : '—' }}
                  </td>
                  <td :data-l="t('dsh.bk.colActions')">
                    <div
                      v-if="confirmingFilename === b.filename"
                      class="db-btns"
                      data-backup-restore-confirm
                    >
                      <span class="db-small db-warn">{{ t('dsh.bk.restoreWarn', { file: b.filename }) }}</span>
                      <button
                        type="button"
                        class="db-btn sm danger"
                        :disabled="verifying"
                        :data-backup-confirm-restore="b.filename"
                        @click="onConfirmRestore(b.filename)"
                      >
                        {{ t('dsh.bk.confirmBtn') }}
                      </button>
                      <button
                        type="button"
                        class="db-btn sm"
                        :disabled="verifying"
                        @click="confirmingFilename = null"
                      >
                        {{ t('dsh.bk.cancelBtn') }}
                      </button>
                    </div>
                    <div v-else class="db-btns">
                      <button
                        type="button"
                        class="db-btn sm"
                        :disabled="verifying"
                        :data-backup-dryrun="b.filename"
                        @click="onDryRun(b.filename)"
                      >
                        {{ t('dsh.bk.dryRunBtn') }}
                      </button>
                      <button
                        type="button"
                        class="db-btn sm"
                        :disabled="verifying"
                        :data-backup-restore="b.filename"
                        @click="confirmingFilename = b.filename"
                      >
                        {{ t('dsh.bk.restoreBtn') }}
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section v-if="restoreResult" class="db-panel" data-backup-result>
        <header>
          <h3>{{ t('dsh.bk.resultTitle') }}</h3>
          <span class="db-stat">
            <span class="dm" :data-k="restoreResult.ok ? 'ok' : 'bad'" aria-hidden="true"></span>
            {{ restoreResult.ok ? t('dsh.chk.pass') : t('dsh.chk.fail') }}
          </span>
        </header>
        <div class="db-pbody">
          <dl class="db-kv">
            <dt>{{ t('dsh.bk.colFile') }}</dt>
            <dd><code class="db-mono">{{ restoreResult.filename }}</code></dd>
            <dt>{{ t('dsh.bk.resultChecksum') }}</dt>
            <dd>
              <span class="db-stat">
                <span class="dm" :data-k="restoreResult.verifiedChecksum ? 'ok' : 'warn'" aria-hidden="true"></span>
                {{ restoreResult.verifiedChecksum ? t('dsh.bk.checksumOk') : t('dsh.bk.checksumNone') }}
              </span>
            </dd>
            <dt>{{ t('dsh.bk.resultMode') }}</dt>
            <dd>{{ restoreResult.dryRun ? t('dsh.bk.statusDryRun') : t('dsh.bk.statusRestore') }}</dd>
            <dt>{{ t('dsh.bk.resultMessage') }}</dt>
            <dd>{{ restoreResult.message }}</dd>
            <dt>{{ t('dsh.bk.resultTables') }}</dt>
            <dd>
              <div class="db-mono db-small">
                <div v-for="(cnt, tbl) in restoreResult.tableCounts" :key="tbl">{{ tbl }}: {{ cnt }}</div>
              </div>
            </dd>
          </dl>
          <p class="db-muted db-small">{{ t('dsh.bk.resultHonestNote') }}</p>
        </div>
      </section>
    </template>
  </div>
</template>
