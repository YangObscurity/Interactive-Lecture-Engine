<script setup lang="ts">
/**
 * PageMyLearning.vue — Reader & user overview backed by /api/me/overview, /api/me/export,
 * and DELETE /api/db/sessions/:id.
 */
import { onMounted, ref } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import {
  ApiHttpError,
  deleteMyAiSession,
  downloadMyExport,
  fetchMyOverview,
  type MyOverview,
} from '../../api/auth'
import { shortDateTime } from '../dashboardData'

const { t } = useT()

const loading = ref(true)
const overview = ref<MyOverview | null>(null)
const errorMessage = ref('')
const statusMessage = ref('')
const exporting = ref(false)
const pendingDeleteId = ref<string | null>(null)
const deletingId = ref<string | null>(null)

function errText(err: unknown): string {
  if (err instanceof ApiHttpError) return err.message || err.error
  if (err instanceof Error) return err.message
  return String(err)
}

function authMethodLabel(method: string): string {
  if (method === 'password') return t('dsh.me.methodPassword')
  if (method === 'passkey') return t('dsh.me.methodPasskey')
  if (method === 'gateway') return t('dsh.me.methodGateway')
  if (method === 'anonymous') return t('dsh.me.methodAnonymous')
  return method
}

async function loadOverview(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    overview.value = await fetchMyOverview()
  } catch (err) {
    errorMessage.value = errText(err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    void loadOverview()
  } else {
    loading.value = false
  }
})

async function onExport(): Promise<void> {
  exporting.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const { data, filename } = await downloadMyExport()
    if (
      typeof window !== 'undefined' &&
      typeof document !== 'undefined' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function'
    ) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      try {
        document.body.appendChild(anchor)
        anchor.click()
      } finally {
        if (anchor.parentNode) {
          anchor.parentNode.removeChild(anchor)
        }
        setTimeout(() => {
          if (typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(url)
          }
        }, 1000)
      }
    }
    statusMessage.value = t('dsh.me.exportDone', { file: filename })
  } catch (err) {
    errorMessage.value = errText(err)
  } finally {
    exporting.value = false
  }
}

async function confirmDeleteSession(sessionId: string): Promise<void> {
  deletingId.value = sessionId
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    await deleteMyAiSession(sessionId)
    pendingDeleteId.value = null
    if (overview.value) {
      overview.value = {
        ...overview.value,
        recentSessions: overview.value.recentSessions.filter((s) => s.id !== sessionId),
      }
    }
    await loadOverview()
    statusMessage.value = t('dsh.me.sessionDeleted')
  } catch (err) {
    errorMessage.value = errText(err)
  } finally {
    deletingId.value = null
  }
}
</script>

<template>
  <div class="db-page" data-page="my-learning">
    <header class="db-ph">
      <h2>{{ t('dsh.me.title') }}</h2>
      <p>{{ t('dsh.me.lead') }}</p>
    </header>

    <div v-if="errorMessage" class="db-errbox" role="alert" data-me-error>
      {{ errorMessage }}
    </div>

    <div v-if="statusMessage" class="db-banner" role="status" data-me-status>
      <span class="db-info" aria-hidden="true"></span>
      <span>{{ statusMessage }}</span>
    </div>

    <div v-if="loading" class="db-panel">
      <div class="db-pbody db-muted">{{ t('dsh.common.loading') }}</div>
    </div>

    <template v-else-if="overview">
      <div class="db-figs" data-me-kpis>
        <div>
          <b>{{ overview.progress.completed }}</b>
          <span>{{ t('dsh.me.kpiCompleted') }}</span>
          <small>{{ t('dsh.me.kpiTotalProgress', { n: overview.progress.total }) }}</small>
        </div>
        <div>
          <b>{{ overview.progress.in_progress }}</b>
          <span>{{ t('dsh.me.kpiInProgress') }}</span>
          <small>{{ t('dsh.me.kpiTotalProgress', { n: overview.progress.total }) }}</small>
        </div>
        <div>
          <b>{{ overview.checklists.completed }} / {{ overview.checklists.total }}</b>
          <span>{{ t('dsh.me.kpiChecklists') }}</span>
          <small>{{ t('dsh.me.kpiChecklistsSub', { n: overview.checklists.total }) }}</small>
        </div>
        <div>
          <b>{{ overview.passkeyCount }}</b>
          <span>{{ t('dsh.me.kpiPasskeys') }}</span>
          <small>{{ t('dsh.me.kpiPasskeysSub') }}</small>
        </div>
      </div>

      <section class="db-panel" data-me-session-card>
        <header>
          <h3>{{ t('dsh.me.sessionCardTitle') }}</h3>
          <div class="db-btns">
            <button type="button" class="db-btn sm" @click="loadOverview">{{ t('dsh.me.refresh') }}</button>
            <button
              type="button"
              class="db-btn sm primary"
              :disabled="exporting"
              data-me-export
              @click="onExport"
            >
              {{ t('dsh.me.exportBtn') }}
            </button>
          </div>
        </header>
        <div class="db-pbody">
          <dl class="db-kv">
            <dt>{{ t('dsh.me.userLabel') }}</dt>
            <dd>
              <strong>{{ overview.user.displayName }}</strong>
              <span class="db-mono db-muted"> (@{{ overview.user.username }})</span>
              <span v-if="overview.user.email" class="db-muted"> · {{ overview.user.email }}</span>
            </dd>
            <dt>{{ t('dsh.me.authMethodLabel') }}</dt>
            <dd><span class="db-tag" data-me-auth-method>{{ authMethodLabel(overview.authMethod) }}</span></dd>
            <dt>{{ t('dsh.me.cookieModeLabel') }}</dt>
            <dd>
              <span class="db-tag" data-me-cookie-badge>
                {{ overview.rememberMe ? t('dsh.me.cookie30dBadge') : t('dsh.me.cookieSessionBadge') }}
              </span>
            </dd>
          </dl>
        </div>
      </section>

      <section class="db-panel" data-me-sessions>
        <header>
          <h3>{{ t('dsh.me.sessionsTitle') }}</h3>
          <span class="db-hm">{{ t('dsh.me.sessionsHint') }}</span>
        </header>
        <div v-if="overview.recentSessions.length === 0" class="db-empty">
          <b>{{ t('dsh.me.sessionsEmpty') }}</b>
        </div>
        <div v-else class="db-tw">
          <table class="db-t">
            <thead>
              <tr>
                <th>{{ t('dsh.me.colTitle') }}</th>
                <th>{{ t('dsh.me.colLecture') }}</th>
                <th>{{ t('dsh.me.colGroup') }}</th>
                <th>{{ t('dsh.me.colUpdated') }}</th>
                <th>{{ t('dsh.me.colActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in overview.recentSessions" :key="s.id" :data-me-session-row="s.id">
                <td :data-l="t('dsh.me.colTitle')">{{ s.title || s.id }}</td>
                <td :data-l="t('dsh.me.colLecture')" class="db-mono">{{ s.lecture_id }}</td>
                <td :data-l="t('dsh.me.colGroup')" class="db-mono">{{ s.group_id }}</td>
                <td :data-l="t('dsh.me.colUpdated')" class="db-mono">{{ shortDateTime(s.updated_at) }}</td>
                <td :data-l="t('dsh.me.colActions')">
                  <template v-if="pendingDeleteId === s.id">
                    <div class="db-btns">
                      <span class="db-small db-warn">{{ t('dsh.me.confirmDeleteSession') }}</span>
                      <button
                        type="button"
                        class="db-btn sm danger"
                        :disabled="deletingId === s.id"
                        :data-me-confirm-delete="s.id"
                        @click="confirmDeleteSession(s.id)"
                      >
                        {{ t('dsh.me.confirmYes') }}
                      </button>
                      <button type="button" class="db-btn sm" @click="pendingDeleteId = null">
                        {{ t('dsh.common.cancel') }}
                      </button>
                    </div>
                  </template>
                  <button
                    v-else
                    type="button"
                    class="db-btn sm danger"
                    :data-me-delete-session="s.id"
                    @click="pendingDeleteId = s.id"
                  >
                    {{ t('dsh.common.delete') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
