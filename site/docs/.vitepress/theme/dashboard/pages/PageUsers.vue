<script setup lang="ts">
/**
 * PageUsers.vue — Admin-only user & role manager backed by /api/admin/users*.
 * Preserves form state when surfacing 409 cannot_remove_last_admin or validation errors.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import DbUnavailable from '../DbUnavailable.vue'
import { canAccessPage, dashboardState } from '../useDashboard'
import {
  createAdminUser,
  deleteAdminUser,
  fetchAdminUsers,
  formatAdminError,
  isAdminError,
  isAdminOk,
  resetAdminUserPassword,
  updateAdminUserRoles,
  updateAdminUserStatus,
  type AdminApiError,
  type AdminUser,
  type UserRole,
} from '../../api/admin'
import { shortDateTime } from '../dashboardData'

const { t } = useT()
const blockedByRole = computed(() => dashboardState.mode === 'online' && !canAccessPage('users'))

const loading = ref(true)
const users = ref<AdminUser[]>([])
const errorMessage = ref('')
const statusMessage = ref('')

const showCreate = ref(false)
const creating = ref(false)
const createForm = reactive({
  username: '',
  displayName: '',
  email: '',
  password: '',
  passwordless: false,
  roleAuthor: false,
  roleAdmin: false,
})

const editingRolesUserId = ref<string | null>(null)
const roleDraft = reactive({ author: false, admin: false })

const resetPwUserId = ref<string | null>(null)
const resetPwValue = ref('')

const confirmDeleteId = ref<string | null>(null)
const busyUserId = ref<string | null>(null)

function mapAdminError(err: AdminApiError): string {
  if (err.code === 'cannot_remove_last_admin') return t('dsh.usr.errLastAdmin')
  return formatAdminError(err)
}

function closeCreatePanel(): void {
  showCreate.value = false
  createForm.password = ''
}

function closeResetPw(): void {
  resetPwUserId.value = null
  resetPwValue.value = ''
}

async function loadUsers(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  const res = await fetchAdminUsers()
  if (isAdminOk(res)) {
    users.value = res.data
  } else if (isAdminError(res)) {
    errorMessage.value = mapAdminError(res.error)
  }
  loading.value = false
}

onMounted(() => {
  if (typeof window !== 'undefined' && !blockedByRole.value) {
    void loadUsers()
  } else {
    loading.value = false
  }
})

async function onCreateUser(): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  const username = createForm.username.trim()
  if (!username) {
    errorMessage.value = t('dsh.login.errRequired')
    return
  }
  if (!createForm.passwordless && createForm.password.length < 8) {
    errorMessage.value = t('dsh.login.errPasswordShort')
    return
  }

  const roles: UserRole[] = ['reader']
  if (createForm.roleAuthor) roles.push('author')
  if (createForm.roleAdmin) roles.push('admin')

  creating.value = true
  try {
    const res = await createAdminUser({
      username,
      password: createForm.passwordless ? null : createForm.password,
      ...(createForm.displayName.trim() ? { displayName: createForm.displayName.trim() } : {}),
      ...(createForm.email.trim() ? { email: createForm.email.trim() } : {}),
      roles,
    })

    if (!isAdminOk(res)) {
      errorMessage.value = isAdminError(res) ? mapAdminError(res.error) : 'unknown_error'
      return
    }

    users.value = [...users.value, res.data]
    statusMessage.value = t('dsh.usr.createdOk', { name: res.data.username })
    createForm.username = ''
    createForm.displayName = ''
    createForm.email = ''
    createForm.passwordless = false
    createForm.roleAuthor = false
    createForm.roleAdmin = false
    showCreate.value = false
  } finally {
    createForm.password = ''
    creating.value = false
  }
}

async function onToggleStatus(u: AdminUser): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  busyUserId.value = u.id
  const nextDisabled = !u.disabled
  const res = await updateAdminUserStatus(u.id, nextDisabled)
  busyUserId.value = null

  if (!isAdminOk(res)) {
    errorMessage.value = isAdminError(res) ? mapAdminError(res.error) : 'unknown_error'
    return
  }
  const updatedDisabled = res.data.disabled
  users.value = users.value.map((row) =>
    row.id === u.id ? { ...row, disabled: updatedDisabled } : row,
  )
  statusMessage.value = t('dsh.usr.updatedOk', { name: u.username })
}

function openEditRoles(u: AdminUser): void {
  errorMessage.value = ''
  editingRolesUserId.value = u.id
  roleDraft.author = u.roles.includes('author')
  roleDraft.admin = u.roles.includes('admin')
}

async function onSaveRoles(u: AdminUser): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  const nextRoles: UserRole[] = ['reader']
  if (roleDraft.author) nextRoles.push('author')
  if (roleDraft.admin) nextRoles.push('admin')

  busyUserId.value = u.id
  const res = await updateAdminUserRoles(u.id, nextRoles)
  busyUserId.value = null

  if (!isAdminOk(res)) {
    errorMessage.value = isAdminError(res) ? mapAdminError(res.error) : 'unknown_error'
    return
  }
  const updatedRoles = res.data.roles
  users.value = users.value.map((row) =>
    row.id === u.id ? { ...row, roles: updatedRoles } : row,
  )
  editingRolesUserId.value = null
  statusMessage.value = t('dsh.usr.updatedOk', { name: u.username })
}

function openResetPw(u: AdminUser): void {
  errorMessage.value = ''
  resetPwUserId.value = u.id
  resetPwValue.value = ''
}

async function onResetPassword(u: AdminUser): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  if (resetPwValue.value.length < 8) {
    errorMessage.value = t('dsh.login.errPasswordShort')
    return
  }
  busyUserId.value = u.id
  try {
    const res = await resetAdminUserPassword(u.id, resetPwValue.value)
    if (!isAdminOk(res)) {
      errorMessage.value = isAdminError(res) ? mapAdminError(res.error) : 'unknown_error'
      return
    }
    resetPwUserId.value = null
    statusMessage.value = t('dsh.usr.passwordResetOk', { name: u.username })
  } finally {
    resetPwValue.value = ''
    busyUserId.value = null
  }
}

async function onDeleteUser(u: AdminUser): Promise<void> {
  errorMessage.value = ''
  statusMessage.value = ''
  busyUserId.value = u.id
  const res = await deleteAdminUser(u.id)
  busyUserId.value = null

  if (!isAdminOk(res)) {
    errorMessage.value = isAdminError(res) ? mapAdminError(res.error) : 'unknown_error'
    return
  }
  confirmDeleteId.value = null
  users.value = users.value.filter((row) => row.id !== u.id)
  statusMessage.value = t('dsh.usr.deletedOk', { name: u.username })
}
</script>

<template>
  <div class="db-page" data-page="users">
    <header class="db-ph">
      <h2>{{ t('dsh.usr.title') }}</h2>
      <p>{{ t('dsh.usr.lead') }}</p>
    </header>

    <DbUnavailable v-if="blockedByRole" id="users" :what="t('dsh.usr.title')" :why="t('dsh.ac.editOnlineWhy')" />

    <template v-else>
    <div v-if="errorMessage" class="db-errbox" role="alert" data-users-error>
      {{ errorMessage }}
    </div>

    <div v-if="statusMessage" class="db-banner" role="status" data-users-status>
      <span class="db-info" aria-hidden="true"></span>
      <span>{{ statusMessage }}</span>
    </div>

    <section v-if="showCreate" class="db-panel" :aria-label="t('dsh.usr.createTitle')" data-users-create-panel>
      <header>
        <h3>{{ t('dsh.usr.createTitle') }}</h3>
        <button type="button" class="db-btn sm" @click="closeCreatePanel">{{ t('dsh.common.cancel') }}</button>
      </header>
      <form class="db-grid" @submit.prevent="onCreateUser">
        <div class="db-frow one">
          <label class="db-fl" for="usr-new-username">{{ t('dsh.usr.username') }}</label>
          <div class="db-fld">
            <input id="usr-new-username" v-model="createForm.username" class="db-in" type="text" required data-usr-create-username />
          </div>
        </div>
        <div class="db-frow one">
          <label class="db-fl" for="usr-new-displayname">{{ t('dsh.usr.displayName') }}</label>
          <div class="db-fld">
            <input id="usr-new-displayname" v-model="createForm.displayName" class="db-in" type="text" data-usr-create-displayname />
          </div>
        </div>
        <div class="db-frow one">
          <label class="db-fl" for="usr-new-email">{{ t('dsh.usr.email') }}</label>
          <div class="db-fld">
            <input id="usr-new-email" v-model="createForm.email" class="db-in" type="email" data-usr-create-email />
          </div>
        </div>
        <div class="db-frow one">
          <label class="db-fl" for="usr-new-pw">{{ t('dsh.usr.password') }}</label>
          <div class="db-fld">
            <label class="db-ck">
              <input v-model="createForm.passwordless" type="checkbox" data-usr-create-passwordless />
              <span>{{ t('dsh.usr.passwordless') }}</span>
            </label>
            <input
              v-if="!createForm.passwordless"
              id="usr-new-pw"
              v-model="createForm.password"
              class="db-in"
              type="password"
              autocomplete="new-password"
              data-usr-create-password
            />
          </div>
        </div>
        <div class="db-frow one">
          <span class="db-fl">{{ t('dsh.usr.roles') }}</span>
          <div class="db-fld db-opts">
            <label class="db-ck">
              <input type="checkbox" checked disabled />
              <span>{{ t('dsh.usr.roleReaderFixed') }}</span>
            </label>
            <label class="db-ck">
              <input v-model="createForm.roleAuthor" type="checkbox" data-usr-create-role-author />
              <span>{{ t('dsh.usr.roleAuthor') }}</span>
            </label>
            <label class="db-ck">
              <input v-model="createForm.roleAdmin" type="checkbox" data-usr-create-role-admin />
              <span>{{ t('dsh.usr.roleAdmin') }}</span>
            </label>
          </div>
        </div>
        <div class="db-pbody db-sep db-btns">
          <button type="submit" class="db-btn primary" :disabled="creating" data-usr-create-submit>
            {{ t('dsh.usr.submitCreate') }}
          </button>
          <button type="button" class="db-btn" @click="closeCreatePanel">{{ t('dsh.common.cancel') }}</button>
        </div>
      </form>
    </section>

    <section class="db-panel" data-users-table-panel>
      <header>
        <h3>{{ t('dsh.usr.title') }}</h3>
        <div class="db-btns">
          <button type="button" class="db-btn sm" @click="loadUsers">{{ t('dsh.me.refresh') }}</button>
          <button
            type="button"
            class="db-btn sm primary"
            data-users-open-create
            @click="showCreate ? closeCreatePanel() : (showCreate = true)"
          >
            + {{ t('dsh.usr.createBtn') }}
          </button>
        </div>
      </header>

      <div v-if="loading" class="db-pbody db-muted">{{ t('dsh.common.loading') }}</div>
      <div v-else-if="users.length === 0" class="db-empty">
        <b>{{ t('dsh.usr.empty') }}</b>
      </div>
      <div v-else class="db-tw">
        <table class="db-t">
          <thead>
            <tr>
              <th>{{ t('dsh.usr.colUser') }}</th>
              <th>{{ t('dsh.usr.colEmail') }}</th>
              <th>{{ t('dsh.usr.colRoles') }}</th>
              <th>{{ t('dsh.usr.colStatus') }}</th>
              <th>{{ t('dsh.usr.colLastLogin') }}</th>
              <th>{{ t('dsh.usr.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="u in users" :key="u.id">
              <tr :data-user-row="u.id">
                <td :data-l="t('dsh.usr.colUser')">
                  <strong>{{ u.displayName }}</strong>
                  <div class="db-mono db-small db-muted">@{{ u.username }}</div>
                </td>
                <td :data-l="t('dsh.usr.colEmail')" class="db-small">{{ u.email || '—' }}</td>
                <td :data-l="t('dsh.usr.colRoles')">
                  <div class="db-btns">
                    <span v-for="r in u.roles" :key="r" class="db-tag db-mono">{{ r }}</span>
                  </div>
                </td>
                <td :data-l="t('dsh.usr.colStatus')">
                  <span class="db-stat">
                    <span class="dm" :data-k="u.disabled ? 'bad' : 'ok'" aria-hidden="true"></span>
                    {{ u.disabled ? t('dsh.usr.disabled') : t('dsh.usr.active') }}
                  </span>
                </td>
                <td :data-l="t('dsh.usr.colLastLogin')" class="db-mono db-small">
                  {{ u.lastLoginAt ? shortDateTime(u.lastLoginAt) : '—' }}
                </td>
                <td :data-l="t('dsh.usr.colActions')">
                  <div class="db-btns">
                    <button
                      type="button"
                      class="db-btn sm"
                      :disabled="busyUserId === u.id"
                      :data-user-toggle-status="u.id"
                      @click="onToggleStatus(u)"
                    >
                      {{ u.disabled ? t('dsh.usr.enable') : t('dsh.usr.disable') }}
                    </button>
                    <button
                      type="button"
                      class="db-btn sm"
                      :data-user-edit-roles="u.id"
                      @click="openEditRoles(u)"
                    >
                      {{ t('dsh.usr.editRoles') }}
                    </button>
                    <button
                      type="button"
                      class="db-btn sm"
                      :data-user-reset-pw="u.id"
                      @click="openResetPw(u)"
                    >
                      {{ t('dsh.usr.resetPw') }}
                    </button>
                    <button
                      type="button"
                      class="db-btn sm danger"
                      :data-user-delete="u.id"
                      @click="confirmDeleteId = u.id"
                    >
                      {{ t('dsh.common.delete') }}
                    </button>
                  </div>
                </td>
              </tr>

              <tr v-if="editingRolesUserId === u.id" class="sub" :data-user-roles-editor="u.id">
                <td colspan="6">
                  <div class="db-btns">
                    <label class="db-ck">
                      <input type="checkbox" checked disabled />
                      <span>reader</span>
                    </label>
                    <label class="db-ck">
                      <input v-model="roleDraft.author" type="checkbox" :data-role-author="u.id" />
                      <span>author</span>
                    </label>
                    <label class="db-ck">
                      <input v-model="roleDraft.admin" type="checkbox" :data-role-admin="u.id" />
                      <span>admin</span>
                    </label>
                    <button
                      type="button"
                      class="db-btn sm primary"
                      :disabled="busyUserId === u.id"
                      :data-save-roles="u.id"
                      @click="onSaveRoles(u)"
                    >
                      {{ t('dsh.usr.saveRoles') }}
                    </button>
                    <button type="button" class="db-btn sm" @click="editingRolesUserId = null">
                      {{ t('dsh.common.cancel') }}
                    </button>
                  </div>
                </td>
              </tr>

              <tr v-if="resetPwUserId === u.id" class="sub" :data-user-pw-editor="u.id">
                <td colspan="6">
                  <div class="db-btns">
                    <input
                      v-model="resetPwValue"
                      class="db-in db-in-sm"
                      type="password"
                      autocomplete="new-password"
                      :aria-label="t('dsh.usr.newPassword')"
                      :placeholder="t('dsh.usr.newPassword')"
                      :data-reset-pw-input="u.id"
                    />
                    <button
                      type="button"
                      class="db-btn sm primary"
                      :disabled="busyUserId === u.id"
                      :data-confirm-reset-pw="u.id"
                      @click="onResetPassword(u)"
                    >
                      {{ t('dsh.usr.confirmResetPw') }}
                    </button>
                    <button type="button" class="db-btn sm" @click="closeResetPw">
                      {{ t('dsh.common.cancel') }}
                    </button>
                  </div>
                </td>
              </tr>

              <tr v-if="confirmDeleteId === u.id" class="sub" :data-user-delete-confirm="u.id">
                <td colspan="6">
                  <div class="db-btns">
                    <span class="db-warn">{{ t('dsh.usr.confirmDeleteUser', { name: u.username }) }}</span>
                    <button
                      type="button"
                      class="db-btn sm danger"
                      :disabled="busyUserId === u.id"
                      :data-confirm-delete-user="u.id"
                      @click="onDeleteUser(u)"
                    >
                      {{ t('dsh.me.confirmYes') }}
                    </button>
                    <button type="button" class="db-btn sm" @click="confirmDeleteId = null">
                      {{ t('dsh.common.cancel') }}
                    </button>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>
    </template>
  </div>
</template>
