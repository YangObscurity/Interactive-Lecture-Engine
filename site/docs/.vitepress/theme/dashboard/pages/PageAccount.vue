<script setup lang="ts">
/**
 * PageAccount.vue — Account & security workbench backed by /api/me/*:
 * change password, bind/delete Passkeys (WebAuthn), and inspect/revoke active sessions.
 */
import { onMounted, reactive, ref } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import {
  ApiHttpError,
  changeMyPassword,
  deleteMyCredential,
  fetchAuthStatus,
  fetchMyCredentials,
  fetchMySessions,
  isWebAuthnSupported,
  registerPasskey,
  revokeMySession,
  type AuthStatus,
  type MyAuthSession,
  type MyCredential,
} from '../../api/auth'
import { shortDateTime } from '../dashboardData'

const emit = defineEmits<{
  loggedOut: []
}>()

const { t } = useT()

const loading = ref(true)
const authStatus = ref<AuthStatus | null>(null)
const credentials = ref<MyCredential[]>([])
const sessions = ref<MyAuthSession[]>([])
const errorMessage = ref('')
const statusMessage = ref('')

const pwForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
})
const pwBusy = ref(false)
const passkeyLabel = ref('')
const passkeyBusy = ref(false)
const busyCredId = ref<string | null>(null)
const pendingDeleteCredId = ref<string | null>(null)
const busySessionId = ref<string | null>(null)
const pendingRevokeSessionId = ref<string | null>(null)

function errText(err: unknown, context: 'password' | 'passkey' | 'general' = 'general'): string {
  if (err instanceof ApiHttpError) {
    if (err.error === 'gateway_managed_account') {
      return context === 'passkey' ? t('dsh.acct.passkeyGatewayMsg') : t('dsh.acct.pwGatewayMsg')
    }
    if (err.error === 'cannot_remove_last_login_method') return t('dsh.acct.errLastLoginMethod')
    return err.message || err.error
  }
  if (err instanceof Error) return err.message
  return String(err)
}

function algName(alg: number): string {
  if (alg === -7) return 'ES256'
  if (alg === -257) return 'RS256'
  return `COSE(${alg})`
}

async function loadAll(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const [creds, sess, st] = await Promise.all([
      fetchMyCredentials(),
      fetchMySessions(),
      fetchAuthStatus().catch(() => null),
    ])
    credentials.value = creds
    sessions.value = sess
    if (st) {
      authStatus.value = st
    }
  } catch (err) {
    errorMessage.value = errText(err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    void loadAll()
  } else {
    loading.value = false
  }
})

async function onChangePassword(): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  if (pwForm.newPassword.length < 8) {
    errorMessage.value = t('dsh.login.errPasswordShort')
    return
  }
  if (pwForm.newPassword !== pwForm.confirmPassword) {
    errorMessage.value = t('dsh.acct.pwMismatch')
    return
  }

  pwBusy.value = true
  try {
    await changeMyPassword({
      ...(pwForm.currentPassword ? { currentPassword: pwForm.currentPassword } : {}),
      newPassword: pwForm.newPassword,
    })
    statusMessage.value = t('dsh.acct.pwChanged')
    sessions.value = await fetchMySessions()
  } catch (err) {
    errorMessage.value = errText(err, 'password')
  } finally {
    pwForm.currentPassword = ''
    pwForm.newPassword = ''
    pwForm.confirmPassword = ''
    pwBusy.value = false
  }
}

async function onBindPasskey(): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  if (!isWebAuthnSupported()) {
    errorMessage.value = t('dsh.login.passkeyUnsupported')
    return
  }
  passkeyBusy.value = true
  try {
    const res = await registerPasskey({
      ...(passkeyLabel.value.trim() ? { label: passkeyLabel.value.trim() } : {}),
    })
    passkeyLabel.value = ''
    statusMessage.value = t('dsh.acct.bindPasskeyOk', { label: res.label })
    credentials.value = await fetchMyCredentials()
  } catch (err) {
    errorMessage.value = errText(err, 'passkey')
  } finally {
    passkeyBusy.value = false
  }
}

async function onDeleteCredential(id: string): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  busyCredId.value = id
  try {
    await deleteMyCredential(id)
    pendingDeleteCredId.value = null
    credentials.value = credentials.value.filter((c) => c.id !== id)
    statusMessage.value = t('dsh.acct.credDeleted')
  } catch (err) {
    pendingDeleteCredId.value = null
    errorMessage.value = errText(err, 'passkey')
  } finally {
    busyCredId.value = null
  }
}

async function onRevokeSession(s: MyAuthSession): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  busySessionId.value = s.id
  try {
    await revokeMySession(s.id)
    pendingRevokeSessionId.value = null
    sessions.value = sessions.value.filter((row) => row.id !== s.id)
    if (s.is_current) {
      statusMessage.value = t('dsh.acct.sessionRevokedCurrent')
      emit('loggedOut')
    } else {
      statusMessage.value = t('dsh.acct.sessionRevoked')
    }
  } catch (err) {
    pendingRevokeSessionId.value = null
    errorMessage.value = errText(err)
  } finally {
    busySessionId.value = null
  }
}
</script>

<template>
  <div class="db-page" data-page="account">
    <header class="db-ph">
      <h2>{{ t('dsh.acct.title') }}</h2>
      <p>{{ t('dsh.acct.lead') }}</p>
    </header>

    <div v-if="errorMessage" class="db-errbox" role="alert" data-acct-error>
      {{ errorMessage }}
    </div>

    <div v-if="statusMessage" class="db-banner" role="status" data-acct-status>
      <span class="db-info" aria-hidden="true"></span>
      <span>{{ statusMessage }}</span>
    </div>

    <div v-if="authStatus?.authSource === 'gateway'" class="db-banner" data-acct-gateway-banner>
      <span class="db-info" aria-hidden="true"></span>
      <span>{{ t('dsh.acct.gatewayManagedHint') }}</span>
    </div>

    <section class="db-panel" data-acct-password-panel>
      <header>
        <h3>{{ t('dsh.acct.pwTitle') }}</h3>
        <span class="db-hm">{{ t('dsh.acct.pwHint') }}</span>
      </header>
      <form class="db-grid" @submit.prevent="onChangePassword">
        <div class="db-frow one">
          <label class="db-fl" for="acct-cur-pw">{{ t('dsh.acct.currentPw') }}</label>
          <div class="db-fld">
            <input
              id="acct-cur-pw"
              v-model="pwForm.currentPassword"
              class="db-in"
              type="password"
              autocomplete="current-password"
              :disabled="pwBusy"
              data-acct-current-pw
            />
          </div>
        </div>
        <div class="db-frow one">
          <label class="db-fl" for="acct-new-pw">{{ t('dsh.acct.newPw') }}</label>
          <div class="db-fld">
            <input
              id="acct-new-pw"
              v-model="pwForm.newPassword"
              class="db-in"
              type="password"
              autocomplete="new-password"
              :disabled="pwBusy"
              required
              data-acct-new-pw
            />
          </div>
        </div>
        <div class="db-frow one">
          <label class="db-fl" for="acct-confirm-pw">{{ t('dsh.acct.confirmNewPw') }}</label>
          <div class="db-fld">
            <input
              id="acct-confirm-pw"
              v-model="pwForm.confirmPassword"
              class="db-in"
              type="password"
              autocomplete="new-password"
              :disabled="pwBusy"
              required
              data-acct-confirm-pw
            />
          </div>
        </div>
        <div class="db-pbody db-sep db-btns">
          <button
            type="submit"
            class="db-btn primary"
            :disabled="pwBusy"
            data-acct-pw-submit
          >
            {{ t('dsh.acct.changePwBtn') }}
          </button>
        </div>
      </form>
    </section>

    <section class="db-panel" data-acct-passkeys-panel>
      <header>
        <h3>{{ t('dsh.acct.passkeysTitle') }}</h3>
        <span class="db-hm">{{ t('dsh.acct.passkeysHint') }}</span>
      </header>
      <div class="db-pbody db-btns">
        <input
          v-model="passkeyLabel"
          class="db-in db-grow"
          type="text"
          :placeholder="t('dsh.acct.passkeyLabelPh')"
          :aria-label="t('dsh.acct.passkeyLabel')"
          :disabled="passkeyBusy"
          data-acct-passkey-label
        />
        <button
          type="button"
          class="db-btn primary"
          :disabled="passkeyBusy"
          data-acct-bind-passkey
          @click="onBindPasskey"
        >
          {{ t('dsh.acct.bindPasskeyBtn') }}
        </button>
      </div>
      <div v-if="loading" class="db-pbody db-muted db-sep">{{ t('dsh.common.loading') }}</div>
      <div v-else-if="credentials.length === 0" class="db-empty db-sep">
        <b>{{ t('dsh.acct.noPasskeys') }}</b>
      </div>
      <div v-else class="db-tw db-sep">
        <table class="db-t">
          <thead>
            <tr>
              <th>{{ t('dsh.acct.colLabel') }}</th>
              <th>{{ t('dsh.acct.colAlg') }}</th>
              <th>{{ t('dsh.acct.colCreated') }}</th>
              <th>{{ t('dsh.acct.colLastUsed') }}</th>
              <th>{{ t('dsh.me.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in credentials" :key="c.id" :data-acct-cred="c.id">
              <td :data-l="t('dsh.acct.colLabel')">
                <strong>{{ c.label }}</strong>
              </td>
              <td :data-l="t('dsh.acct.colAlg')">
                <span class="db-tag db-mono">{{ algName(c.algorithm) }}</span>
              </td>
              <td :data-l="t('dsh.acct.colCreated')" class="db-mono">{{ shortDateTime(c.created_at) }}</td>
              <td :data-l="t('dsh.acct.colLastUsed')" class="db-mono">
                {{ c.last_used_at ? shortDateTime(c.last_used_at) : t('dsh.acct.neverUsed') }}
              </td>
              <td :data-l="t('dsh.me.colActions')">
                <template v-if="pendingDeleteCredId === c.id">
                  <div class="db-btns">
                    <span class="db-small db-warn">{{ t('dsh.acct.confirmDeleteCred', { label: c.label }) }}</span>
                    <button
                      type="button"
                      class="db-btn sm danger"
                      :disabled="busyCredId === c.id"
                      :data-acct-confirm-delete-cred="c.id"
                      @click="onDeleteCredential(c.id)"
                    >
                      {{ t('dsh.me.confirmYes') }}
                    </button>
                    <button
                      type="button"
                      class="db-btn sm"
                      :data-acct-cancel-delete-cred="c.id"
                      @click="pendingDeleteCredId = null"
                    >
                      {{ t('dsh.common.cancel') }}
                    </button>
                  </div>
                </template>
                <button
                  v-else
                  type="button"
                  class="db-btn sm danger"
                  :disabled="busyCredId === c.id"
                  :data-acct-delete-cred="c.id"
                  @click="pendingDeleteCredId = c.id; pendingRevokeSessionId = null"
                >
                  {{ t('dsh.common.delete') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="db-panel" data-acct-sessions-panel>
      <header>
        <h3>{{ t('dsh.acct.sessionsTitle') }}</h3>
        <span class="db-hm">{{ t('dsh.acct.sessionsHint') }}</span>
      </header>
      <div v-if="loading" class="db-pbody db-muted">{{ t('dsh.common.loading') }}</div>
      <div v-else-if="sessions.length === 0" class="db-empty">
        <b>{{ t('dsh.acct.noSessions') }}</b>
      </div>
      <div v-else class="db-tw">
        <table class="db-t">
          <thead>
            <tr>
              <th>{{ t('dsh.acct.colMethod') }}</th>
              <th>{{ t('dsh.acct.colPersistence') }}</th>
              <th>{{ t('dsh.acct.colAgent') }}</th>
              <th>{{ t('dsh.acct.colLastSeen') }}</th>
              <th>{{ t('dsh.acct.colExpires') }}</th>
              <th>{{ t('dsh.me.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="s in sessions"
              :key="s.id"
              :class="{ cur: s.is_current }"
              :data-acct-session="s.id"
            >
              <td :data-l="t('dsh.acct.colMethod')">
                <span class="db-tag db-mono">{{ s.auth_method }}</span>
                <span v-if="s.is_current" class="db-tag">{{ t('dsh.acct.currentSession') }}</span>
              </td>
              <td :data-l="t('dsh.acct.colPersistence')">
                <span class="db-tag">
                  {{ s.remember_me ? t('dsh.me.cookie30dBadge') : t('dsh.me.cookieSessionBadge') }}
                </span>
              </td>
              <td :data-l="t('dsh.acct.colAgent')" class="db-clip db-small db-muted">
                {{ s.user_agent || '—' }}
              </td>
              <td :data-l="t('dsh.acct.colLastSeen')" class="db-mono">{{ shortDateTime(s.last_seen_at) }}</td>
              <td :data-l="t('dsh.acct.colExpires')" class="db-mono">{{ shortDateTime(s.expires_at) }}</td>
              <td :data-l="t('dsh.me.colActions')">
                <template v-if="pendingRevokeSessionId === s.id">
                  <div class="db-btns">
                    <span class="db-small db-warn">
                      {{ s.is_current ? t('dsh.acct.confirmRevokeCurrentSession') : t('dsh.acct.confirmRevokeSession') }}
                    </span>
                    <button
                      type="button"
                      class="db-btn sm danger"
                      :disabled="busySessionId === s.id"
                      :data-acct-confirm-revoke-session="s.id"
                      @click="onRevokeSession(s)"
                    >
                      {{ t('dsh.acct.revokeBtn') }}
                    </button>
                    <button
                      type="button"
                      class="db-btn sm"
                      :data-acct-cancel-revoke-session="s.id"
                      @click="pendingRevokeSessionId = null"
                    >
                      {{ t('dsh.common.cancel') }}
                    </button>
                  </div>
                </template>
                <button
                  v-else
                  type="button"
                  class="db-btn sm danger"
                  :disabled="busySessionId === s.id"
                  :data-acct-revoke-session="s.id"
                  @click="pendingRevokeSessionId = s.id; pendingDeleteCredId = null"
                >
                  {{ t('dsh.acct.revokeBtn') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
