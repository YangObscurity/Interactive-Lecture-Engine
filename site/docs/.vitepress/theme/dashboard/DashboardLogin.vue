<script setup lang="ts">
/**
 * DashboardLogin.vue — Local password, Passkey/WebAuthn, first-time admin bootstrap,
 * 30-day Remember-Me cookie toggle, and extensible auth method slots.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useT } from '../../i18n/useT.ts'
import {
  ApiHttpError,
  bootstrapAdmin,
  fetchAuthMethods,
  fetchAuthStatus,
  isWebAuthnSupported,
  loginWithPasskey,
  loginWithPassword,
  type AuthLoginResult,
  type AuthMethodInfo,
  type AuthStatus,
} from '../api/auth'

const props = withDefaults(
  defineProps<{
    authStatus?: AuthStatus | null
    methods?: AuthMethodInfo[]
    gatewayLoginUrl?: string
  }>(),
  {
    authStatus: null,
    methods: undefined,
    gatewayLoginUrl: '',
  },
)

const emit = defineEmits<{
  authenticated: [result: AuthLoginResult]
}>()

const { t } = useT()

const fetchedStatus = ref<AuthStatus | null>(null)
const fetchedMethods = ref<AuthMethodInfo[]>([])
const probing = ref(typeof window !== 'undefined' && (!props.authStatus || props.methods === undefined))
const submitting = ref(false)
const showPassword = ref(false)
const errorMessage = ref('')

const form = reactive({
  username: '',
  displayName: '',
  email: '',
  setupToken: '',
  password: '',
  confirmPassword: '',
  rememberMe: true,
})

const useBootstrapToken = ref(false)
const effectiveStatus = computed(() => props.authStatus ?? fetchedStatus.value)
const bootstrapTokenRequired = computed(() => Boolean(effectiveStatus.value?.bootstrapTokenRequired))
const isBootstrap = computed(
  () =>
    Boolean(effectiveStatus.value?.needsBootstrap) ||
    (bootstrapTokenRequired.value && useBootstrapToken.value),
)
const effectiveMethods = computed<AuthMethodInfo[]>(() =>
  props.methods !== undefined ? props.methods : fetchedMethods.value,
)

const passwordMethod = computed(() =>
  effectiveMethods.value.find((m) => m.id === 'password'),
)
const passwordEnabled = computed(() =>
  passwordMethod.value ? passwordMethod.value.enabled : true,
)
const passkeyMethod = computed(() =>
  effectiveMethods.value.find((m) => m.id === 'passkey'),
)
const passkeyEnabled = computed(() =>
  passkeyMethod.value ? passkeyMethod.value.enabled : !isBootstrap.value,
)
const gatewayMethod = computed(() =>
  effectiveMethods.value.find((m) => m.id === 'gateway' && m.enabled),
)
const extensibleMethods = computed(() =>
  effectiveMethods.value.filter((m) => m.extensible),
)
const webAuthnAvailable = computed(() => isWebAuthnSupported())

const safeGatewayUrl = computed(() => {
  const raw = props.gatewayLoginUrl.trim()
  if (!raw) return ''
  if (!(/^\/(?!\/)/.test(raw) || /^https?:\/\//i.test(raw))) return ''
  if (!raw.includes('{rd}')) return raw
  const rd = typeof window !== 'undefined' ? encodeURIComponent(window.location.href) : encodeURIComponent('/')
  return raw.replace(/\{rd\}/g, rd)
})

const cookiePolicyHint = computed(() =>
  form.rememberMe ? t('dsh.login.cookie30d') : t('dsh.login.cookieSession'),
)

onMounted(async () => {
  if (typeof window === 'undefined') {
    probing.value = false
    return
  }
  const tasks: Promise<void>[] = []
  if (!props.authStatus) {
    tasks.push(
      fetchAuthStatus()
        .then((st) => {
          fetchedStatus.value = st
        })
        .catch(() => {
          // ignore probe error; parent may supply status
        }),
    )
  }
  if (props.methods === undefined) {
    tasks.push(
      fetchAuthMethods()
        .then((list) => {
          fetchedMethods.value = list
        })
        .catch(() => {
          // ignore method list probe error
        }),
    )
  }
  try {
    await Promise.all(tasks)
  } finally {
    probing.value = false
  }
})

function extractError(err: unknown): string {
  if (err instanceof ApiHttpError) return err.message || err.error
  if (err instanceof Error) return err.message
  return String(err)
}

async function onSubmit(): Promise<void> {
  errorMessage.value = ''
  const username = form.username.trim()
  if (!username || !form.password) {
    errorMessage.value = t('dsh.login.errRequired')
    return
  }

  if (isBootstrap.value) {
    if (bootstrapTokenRequired.value && !form.setupToken.trim()) {
      errorMessage.value = t('dsh.login.errSetupTokenRequired')
      return
    }
    if (form.password.length < 8) {
      errorMessage.value = t('dsh.login.errPasswordShort')
      return
    }
    if (form.password !== form.confirmPassword) {
      errorMessage.value = t('dsh.login.errPasswordMismatch')
      return
    }
  }

  submitting.value = true
  try {
    const result = isBootstrap.value
      ? await bootstrapAdmin({
          username,
          password: form.password,
          ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
          ...(form.email.trim() ? { email: form.email.trim() } : {}),
          ...(bootstrapTokenRequired.value ? { setupToken: form.setupToken.trim() } : {}),
          rememberMe: form.rememberMe,
        })
      : await loginWithPassword({
          username,
          password: form.password,
          rememberMe: form.rememberMe,
        })
    emit('authenticated', result)
  } catch (err) {
    errorMessage.value = extractError(err)
  } finally {
    form.password = ''
    form.confirmPassword = ''
    submitting.value = false
  }
}

async function onPasskeyLogin(): Promise<void> {
  errorMessage.value = ''
  if (!webAuthnAvailable.value) {
    errorMessage.value = t('dsh.login.passkeyUnsupported')
    return
  }
  submitting.value = true
  try {
    const result = await loginWithPasskey({
      ...(form.username.trim() ? { username: form.username.trim() } : {}),
      rememberMe: form.rememberMe,
    })
    emit('authenticated', result)
  } catch (err) {
    errorMessage.value = extractError(err)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="db-page db-gate" data-dashboard-login>
    <div v-if="probing" class="db-panel" data-login-probing>
      <div class="db-pbody db-muted">{{ t('dsh.common.loading') }}</div>
    </div>

    <template v-else>
      <header class="db-ph">
        <h2>{{ isBootstrap ? t('dsh.login.bootstrapTitle') : t('dsh.login.title') }}</h2>
        <p>{{ isBootstrap ? t('dsh.login.bootstrapLead') : t('dsh.login.lead') }}</p>
      </header>

      <div v-if="errorMessage" class="db-errbox" role="alert" data-login-error>
        {{ errorMessage }}
      </div>

      <section class="db-panel">
        <header>
          <h3>{{ isBootstrap ? t('dsh.login.submitBootstrap') : t('dsh.login.submitLogin') }}</h3>
          <span class="db-hm">{{ form.rememberMe ? t('dsh.me.cookie30dBadge') : t('dsh.me.cookieSessionBadge') }}</span>
        </header>

        <div v-if="!isBootstrap && !passwordEnabled" class="db-pbody db-grid" data-login-password-disabled>
          <div class="db-banner">
            <span class="db-info" aria-hidden="true"></span>
            <span>{{ t('dsh.login.passwordDisabledHint') }}</span>
          </div>
          <div v-if="passkeyEnabled" class="db-grid">
            <div class="db-frow one">
              <label class="db-fl" for="dsh-login-username-hint">{{ t('dsh.login.username') }}</label>
              <div class="db-fld">
                <input
                  id="dsh-login-username-hint"
                  v-model="form.username"
                  class="db-in"
                  type="text"
                  autocomplete="username"
                  :disabled="submitting"
                  data-login-username
                />
              </div>
            </div>
            <div class="db-frow one">
              <span class="db-fl">{{ t('dsh.me.cookieModeLabel') }}</span>
              <div class="db-fld">
                <label class="db-ck">
                  <input
                    v-model="form.rememberMe"
                    type="checkbox"
                    :disabled="submitting"
                    data-login-remember
                  />
                  <span>{{ t('dsh.login.rememberMe') }}</span>
                </label>
                <small class="db-muted" data-login-cookie-hint>{{ cookiePolicyHint }}</small>
              </div>
            </div>
            <div class="db-btns">
              <button
                type="button"
                class="db-btn primary"
                :disabled="submitting"
                data-login-passkey
                @click="onPasskeyLogin"
              >
                {{ t('dsh.login.passkeyBtn') }}
              </button>
            </div>
          </div>
        </div>

        <form v-else class="db-grid" data-login-form @submit.prevent="onSubmit">
          <div class="db-frow one">
            <label class="db-fl" for="dsh-login-username">
              {{ isBootstrap ? t('dsh.login.usernameNew') : t('dsh.login.username') }}
              <small v-if="isBootstrap">{{ t('dsh.login.usernameHint') }}</small>
            </label>
            <div class="db-fld">
              <input
                id="dsh-login-username"
                v-model="form.username"
                class="db-in"
                type="text"
                autocomplete="username"
                :disabled="submitting"
                required
                data-login-username
              />
            </div>
          </div>

          <template v-if="isBootstrap">
            <div v-if="bootstrapTokenRequired" class="db-frow one">
              <label class="db-fl" for="dsh-login-setup-token">
                {{ t('dsh.login.setupToken') }}
                <small>{{ t('dsh.login.setupTokenHint') }}</small>
              </label>
              <div class="db-fld">
                <input
                  id="dsh-login-setup-token"
                  v-model="form.setupToken"
                  class="db-in"
                  type="password"
                  autocomplete="one-time-code"
                  :disabled="submitting"
                  required
                  data-login-setup-token
                />
              </div>
            </div>

            <div class="db-frow one">
              <label class="db-fl" for="dsh-login-displayname">{{ t('dsh.login.displayName') }}</label>
              <div class="db-fld">
                <input
                  id="dsh-login-displayname"
                  v-model="form.displayName"
                  class="db-in"
                  type="text"
                  autocomplete="name"
                  :disabled="submitting"
                  data-login-displayname
                />
              </div>
            </div>

            <div class="db-frow one">
              <label class="db-fl" for="dsh-login-email">{{ t('dsh.login.email') }}</label>
              <div class="db-fld">
                <input
                  id="dsh-login-email"
                  v-model="form.email"
                  class="db-in"
                  type="email"
                  autocomplete="email"
                  :disabled="submitting"
                  data-login-email
                />
              </div>
            </div>
          </template>

          <div class="db-frow one">
            <label class="db-fl" for="dsh-login-password">{{ t('dsh.login.password') }}</label>
            <div class="db-fld">
              <div class="db-btns">
                <input
                  id="dsh-login-password"
                  v-model="form.password"
                  class="db-in db-grow"
                  :type="showPassword ? 'text' : 'password'"
                  :autocomplete="isBootstrap ? 'new-password' : 'current-password'"
                  :disabled="submitting"
                  required
                  data-login-password
                />
                <button
                  type="button"
                  class="db-btn sm"
                  :aria-pressed="showPassword"
                  data-login-toggle-pw
                  @click="showPassword = !showPassword"
                >
                  {{ showPassword ? t('dsh.login.hidePassword') : t('dsh.login.showPassword') }}
                </button>
              </div>
            </div>
          </div>

          <div v-if="isBootstrap" class="db-frow one">
            <label class="db-fl" for="dsh-login-confirm">{{ t('dsh.login.confirmPassword') }}</label>
            <div class="db-fld">
              <input
                id="dsh-login-confirm"
                v-model="form.confirmPassword"
                class="db-in"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="new-password"
                :disabled="submitting"
                required
                data-login-confirm
              />
            </div>
          </div>

          <div class="db-frow one">
            <span class="db-fl">{{ t('dsh.me.cookieModeLabel') }}</span>
            <div class="db-fld">
              <label class="db-ck">
                <input
                  v-model="form.rememberMe"
                  type="checkbox"
                  :disabled="submitting"
                  data-login-remember
                />
                <span>{{ t('dsh.login.rememberMe') }}</span>
              </label>
              <small class="db-muted" data-login-cookie-hint>{{ cookiePolicyHint }}</small>
            </div>
          </div>

          <div class="db-pbody db-sep db-btns">
            <button
              type="submit"
              class="db-btn primary"
              :disabled="submitting"
              data-login-submit
            >
              {{ submitting ? t('dsh.login.submitting') : (isBootstrap ? t('dsh.login.submitBootstrap') : t('dsh.login.submitLogin')) }}
            </button>

            <button
              v-if="!isBootstrap && passkeyEnabled"
              type="button"
              class="db-btn"
              :disabled="submitting"
              data-login-passkey
              @click="onPasskeyLogin"
            >
              {{ t('dsh.login.passkeyBtn') }}
            </button>

            <button
              v-if="bootstrapTokenRequired"
              type="button"
              class="db-btn sm"
              :disabled="submitting"
              data-login-bootstrap-token-toggle
              @click="useBootstrapToken = !useBootstrapToken; errorMessage = ''"
            >
              {{ isBootstrap ? t('dsh.login.backToLoginBtn') : t('dsh.login.bootstrapWithTokenBtn') }}
            </button>
          </div>
        </form>
      </section>

      <section v-if="gatewayMethod || extensibleMethods.length > 0" class="db-panel" data-login-methods>
        <header>
          <h3>{{ t('dsh.login.methodsTitle') }}</h3>
        </header>
        <div class="db-pbody db-grid">
          <div v-if="gatewayMethod" class="db-banner" data-login-gateway>
            <span class="db-info" aria-hidden="true"></span>
            <div class="db-grid">
              <span>{{ t('dsh.login.gatewayHint') }}</span>
              <div v-if="safeGatewayUrl" class="db-btns">
                <a class="db-btn sm" :href="safeGatewayUrl" data-login-gateway-link>{{ t('dsh.login.gatewayRedirect') }}</a>
              </div>
            </div>
          </div>

          <div
            v-for="m in extensibleMethods"
            :key="m.id"
            class="db-btns"
            :data-login-extensible="m.id"
          >
            <span class="db-tag">{{ t('dsh.login.extensibleSlot') }}</span>
            <strong>{{ m.name }}</strong>
            <span class="db-muted db-small">{{ m.description }}</span>
            <span class="db-tag">{{ m.enabled ? t('dsh.login.methodEnabled') : t('dsh.login.methodDisabled') }}</span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
