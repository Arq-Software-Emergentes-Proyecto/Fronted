<script setup>
import { computed, ref, watch, watchEffect } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import SkipLink from '@/shared/presentation/components/SkipLink.vue'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import { authApi } from '@/iam/infrastructure/authApi.js'
import { residentsApi } from '@/residents/infrastructure/residentsApi.js'
import { useSession } from '@/iam/application/sessionStore.js'
import { signInWithGoogle } from '@/iam/infrastructure/googleIdentity.js'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { setAdminSession, setResidentSession } = useSession()

/** Internal app path from ?redirect= (rejects protocol-relative URLs). */
function navigateAfterAuth(fallback) {
  const raw = route.query.redirect
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) {
    return router.push(raw)
  }
  return router.push(fallback)
}

const isRegister = computed(() => route.name === AppRouteNames.REGISTER)
const isResidentLogin = computed(() => route.name === AppRouteNames.RESIDENT_LOGIN)
const isAdminLogin = computed(
  () => route.name === AppRouteNames.LOGIN && route.query.invite !== '1',
)
const authTab = computed(() => {
  if (isRegister.value) return 'register'
  if (isResidentLogin.value) return 'resident'
  return 'login'
})

const isResidentInvite = computed(
  () => route.name === AppRouteNames.LOGIN && route.query.invite === '1',
)
const inviteCode = computed(() => String(route.query.code ?? ''))

const inviteStep = ref('welcome') // 'welcome' | 'google'
const inviteResident = ref(null)
const inviteFetchError = ref('')
const inviteLoading = ref(false)
const residentError = ref('')
const residentLoading = ref(false)

const inviteName = computed(() => inviteResident.value?.name ?? '')
const inviteFloor = computed(() => inviteResident.value?.floor ?? '')
const inviteCodeDisplay = computed(() => inviteResident.value?.code ?? inviteCode.value)

function applyResidentSession(user, token) {
  setResidentSession(
    {
      id: user.id,
      name: user.name,
      floor: user.floor,
      code: user.code,
      email: user.email,
      ownerAdminId: user.ownerAdminId ?? null,
    },
    token,
  )
  return navigateAfterAuth({ name: AppRouteNames.APP_RESIDENT_DASHBOARD })
}

function googleAuthMessage(error) {
  if (error?.code === 'GOOGLE_NOT_CONFIGURED') return t('auth.inviteGoogleNotConfigured')
  if (error?.code === 'GOOGLE_CANCELLED') return t('auth.inviteGoogleCancelled')
  if (error?.code === 'GOOGLE_SCRIPT' || error?.code === 'GOOGLE_UNAVAILABLE') {
    return t('auth.inviteGoogleError')
  }
  if (error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT') return t('auth.apiUnavailable')
  if (error?.code === 'EMAIL_ALREADY_EXISTS') return t('auth.emailAlreadyExists')
  if (error?.code === 'RESIDENT_NOT_FOUND') return t('auth.inviteNotFound')
  if (error?.code === 'EMAIL_NOT_FOUND') return t('auth.residentGoogleNotFound')
  if (error?.code === 'RESIDENT_ONLY') return t('auth.residentGoogleAdminBlocked')
  if (error?.code === 'RESIDENT_GOOGLE_REQUIRED') return t('auth.residentGoogleRequired')
  if (error?.code === 'RESIDENT_USE_GOOGLE') return t('auth.residentUseGoogle')
  return t('auth.inviteGoogleError')
}

watchEffect(async () => {
  if (!isResidentInvite.value || !inviteCode.value) {
    inviteResident.value = null
    return
  }
  inviteLoading.value = true
  inviteFetchError.value = ''
  try {
    inviteResident.value = await residentsApi.findByCode(inviteCode.value)
  } catch (error) {
    inviteResident.value = null
    if (error?.code === 'RESIDENT_NOT_FOUND') {
      inviteFetchError.value = t('auth.inviteNotFound')
    } else if (error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT') {
      inviteFetchError.value = t('auth.apiUnavailable')
    } else {
      inviteFetchError.value = t('auth.genericError')
    }
  } finally {
    inviteLoading.value = false
  }
})

function onResidentInviteAccept() {
  inviteStep.value = 'google'
  residentError.value = ''
}

async function onResidentGoogleSignUp() {
  if (residentLoading.value) return
  residentError.value = ''
  residentLoading.value = true
  try {
    const googleProfile = await signInWithGoogle()
    const { user, token } = await residentsApi.completeInviteWithGoogle({
      code: inviteCode.value,
      email: googleProfile.email,
      name: googleProfile.name,
      googleSub: googleProfile.googleSub,
      idToken: googleProfile.idToken,
    })
    await applyResidentSession(user, token)
  } catch (error) {
    residentError.value = googleAuthMessage(error)
  } finally {
    residentLoading.value = false
  }
}

const loginStep = ref(1)
const loginEmail = ref('')
const loginPassword = ref('')
const loginEmailError = ref('')
const loginLoading = ref(false)

const regName = ref('')
const regEmail = ref('')
const regPassword = ref('')
const regDni = ref('')
const regAddress = ref('')
const regCompany = ref('')
const regRuc = ref('')
const registerError = ref('')
const registerLoading = ref(false)

async function onLoginContinue() {
  loginEmailError.value = ''
  const raw = loginEmail.value.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    loginEmailError.value = t('auth.emailInvalid')
    return
  }
  loginLoading.value = true
  try {
    const exists = await authApi.isEmailRegistered(raw)
    if (!exists) {
      loginEmailError.value = t('auth.emailNotRegistered')
      return
    }
    loginStep.value = 2
  } catch (e) {
    if (e?.code === 'RESIDENT_USE_GOOGLE') {
      loginEmailError.value = t('auth.residentUseGoogle')
      return
    }
    loginStep.value = 2
  } finally {
    loginLoading.value = false
  }
}

async function onLoginWithGoogle() {
  if (loginLoading.value) return
  loginLoading.value = true
  loginEmailError.value = ''
  try {
    const googleProfile = await signInWithGoogle()
    const { user, token } = await authApi.loginWithGoogle({
      email: googleProfile.email,
      googleSub: googleProfile.googleSub,
      idToken: googleProfile.idToken,
    })
    if (user.role !== 'resident') {
      loginEmailError.value = t('auth.residentGoogleAdminBlocked')
      return
    }
    await applyResidentSession(user, token)
  } catch (error) {
    loginEmailError.value = googleAuthMessage(error)
  } finally {
    loginLoading.value = false
  }
}

async function handleLoginSubmit() {
  if (loginLoading.value) return
  try {
    if (loginStep.value === 1) {
      await onLoginContinue()
      return
    }
    await onLoginSubmit()
  } catch (e) {
    loginEmailError.value = e?.message || t('auth.genericError')
  }
}

async function onLoginSubmit() {
  loginLoading.value = true
  loginEmailError.value = ''
  try {
    const { user, token } = await authApi.login({
      email: loginEmail.value,
      password: loginPassword.value,
    })

    if (user.role === 'resident') {
      loginEmailError.value = t('auth.residentUseGoogle')
      return
    } else {
      setAdminSession(
        {
          id: user.id,
          name: user.name,
          email: user.email,
          dni: user.dni,
          address: user.address,
          company: user.company,
          ruc: user.ruc,
        },
        token,
      )
      navigateAfterAuth({ name: AppRouteNames.APP_DASHBOARD })
    }
  } catch (error) {
    if (error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT') {
      loginEmailError.value = t('auth.apiUnavailable')
      return
    }
    if (error?.code === 'INVALID_PASSWORD') {
      loginEmailError.value = t('auth.passwordInvalid')
      return
    }
    if (error?.code === 'RESIDENT_USE_GOOGLE') {
      loginEmailError.value = t('auth.residentUseGoogle')
      return
    }
    if (error?.code === 'EMAIL_NOT_FOUND') {
      loginStep.value = 1
      loginPassword.value = ''
      loginEmailError.value = t('auth.emailNotRegistered')
      return
    }
    loginEmailError.value = t('auth.genericError')
  } finally {
    loginLoading.value = false
  }
}

async function onRegisterSubmit() {
  if (registerLoading.value) return
  registerLoading.value = true
  registerError.value = ''
  try {
    if (String(regPassword.value).length < 6) {
      registerError.value = t('auth.passwordTooShort')
      return
    }
    const { user, token } = await authApi.registerAdmin({
      name: regName.value,
      email: regEmail.value,
      password: regPassword.value,
      dni: regDni.value,
      address: regAddress.value,
      company: regCompany.value,
      ruc: regRuc.value,
    })
    setAdminSession(
      {
        id: user.id,
        name: user.name,
        email: user.email,
        dni: user.dni,
        address: user.address,
        company: user.company,
        ruc: user.ruc,
      },
      token,
    )
    navigateAfterAuth({ name: AppRouteNames.APP_DASHBOARD })
  } catch (error) {
    if (error?.code === 'EMAIL_ALREADY_EXISTS') {
      registerError.value = t('auth.emailAlreadyExists')
      return
    }
    if (error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT') {
      registerError.value = t('auth.apiUnavailable')
      return
    }
    registerError.value = t('auth.genericError')
  } finally {
    registerLoading.value = false
  }
}

watch(inviteCode, () => {
  inviteStep.value = 'welcome'
  residentError.value = ''
})

watch(
  () => route.name,
  (name) => {
    if (name === AppRouteNames.LOGIN || name === AppRouteNames.RESIDENT_LOGIN) {
      loginStep.value = 1
      loginPassword.value = ''
      loginEmailError.value = ''
      loginLoading.value = false
    }
    if (name === AppRouteNames.REGISTER) {
      registerError.value = ''
      registerLoading.value = false
    }
  },
)

watch(loginEmail, () => {
  if (loginStep.value === 2) {
    loginStep.value = 1
    loginPassword.value = ''
    loginEmailError.value = ''
  }
})
</script>

<template>
  <div class="auth-page">
    <SkipLink />
    <main id="main-content" class="auth-main" role="main" tabindex="-1">
      <div v-if="isResidentInvite" class="auth-shell">
        <div v-if="inviteStep === 'welcome'" class="auth-card auth-card--centered">
          <div class="auth-brand">
            <img
              src="/logo-buildingfex.png"
              :alt="t('brand')"
              class="auth-logo"
              width="200"
              height="48"
              decoding="async"
            />
          </div>

          <p v-if="inviteLoading" class="auth-subtitle">{{ t('auth.inviteLoading') }}</p>
          <p v-else-if="inviteFetchError" class="auth-error" role="alert">
            {{ inviteFetchError }}
          </p>

          <template v-else-if="inviteResident">
            <h1 class="auth-title auth-title--center">{{ t('auth.inviteTitle') }}</h1>
            <p class="auth-subtitle">{{ t('auth.inviteSubtitle') }}</p>

            <ul class="auth-invite-list" role="list">
              <li><strong>{{ t('app.residentNameLabel') }}:</strong> {{ inviteName }}</li>
              <li><strong>{{ t('app.residentFloorLabel') }}:</strong> {{ inviteFloor }}</li>
              <li><strong>{{ t('app.residentCodeLabel') }}:</strong> {{ inviteCodeDisplay }}</li>
            </ul>

            <Button
              type="button"
              class="auth-submit"
              rounded
              severity="info"
              :label="t('auth.inviteAccept')"
              @click="onResidentInviteAccept"
            />
          </template>
        </div>

        <div v-else class="auth-card auth-card--centered">
          <div class="auth-brand">
            <img
              src="/logo-buildingfex.png"
              :alt="t('brand')"
              class="auth-logo"
              width="200"
              height="48"
              decoding="async"
            />
          </div>
          <h1 class="auth-title auth-title--center">{{ t('auth.inviteGoogleTitle') }}</h1>
          <p class="auth-subtitle">{{ t('auth.inviteGoogleSubtitle') }}</p>

          <div class="auth-form auth-form--narrow" :aria-label="t('auth.inviteGoogleAria')">
            <p v-if="residentError" class="auth-error" role="alert">{{ residentError }}</p>
            <button
              type="button"
              class="auth-google"
              :disabled="residentLoading"
              @click="onResidentGoogleSignUp"
            >
              <span class="auth-google__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <path fill="#4285F4" d="M23.49 12.27c0-.82-.07-1.64-.23-2.43H12v4.6h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.55-5.17 3.55-8.79Z" />
                  <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.94l-3.88-3c-1.08.72-2.47 1.14-4.07 1.14-3.13 0-5.78-2.11-6.73-4.96H1.27v3.09A12 12 0 0 0 12 24Z" />
                  <path fill="#FBBC05" d="M5.27 14.24A7.2 7.2 0 0 1 4.89 12c0-.78.14-1.53.38-2.24V6.67H1.27A12 12 0 0 0 0 12c0 1.94.46 3.78 1.27 5.33l4-3.09Z" />
                  <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.6 4.59 1.79l3.44-3.44C17.95 1.14 15.23 0 12 0 7.31 0 3.23 2.69 1.27 6.67l4 3.09C6.22 6.86 8.87 4.75 12 4.75Z" />
                </svg>
              </span>
              <span>{{ residentLoading ? t('auth.inviteGoogleLoading') : t('auth.inviteGoogleButton') }}</span>
            </button>
          </div>
        </div>
      </div>
      <div v-else class="auth-shell">
        <nav class="auth-tabs" :aria-label="t('auth.tabsAria')" role="tablist">
          <div class="auth-tabs__track">
            <span
              class="auth-tabs__pill"
              :class="{
                'auth-tabs__pill--register': authTab === 'register',
                'auth-tabs__pill--resident': authTab === 'resident',
              }"
              aria-hidden="true"
            />
            <RouterLink
              class="auth-tab"
              role="tab"
              :class="{ 'auth-tab--active': authTab === 'login' }"
              :aria-selected="authTab === 'login'"
              :to="{ name: AppRouteNames.LOGIN }"
            >
              {{ t('auth.loginTab') }}
            </RouterLink>
            <RouterLink
              class="auth-tab"
              role="tab"
              :class="{ 'auth-tab--active': authTab === 'register' }"
              :aria-selected="authTab === 'register'"
              :to="{ name: AppRouteNames.REGISTER }"
            >
              {{ t('auth.registerTab') }}
            </RouterLink>
            <RouterLink
              class="auth-tab"
              role="tab"
              :class="{ 'auth-tab--active': authTab === 'resident' }"
              :aria-selected="authTab === 'resident'"
              :to="{ name: AppRouteNames.RESIDENT_LOGIN }"
            >
              {{ t('auth.residentLoginTab') }}
            </RouterLink>
          </div>
        </nav>

        <div v-if="isAdminLogin" class="auth-card auth-card--centered">
          <div class="auth-brand">
            <img
              src="/logo-buildingfex.png"
              :alt="t('brand')"
              class="auth-logo"
              width="200"
              height="48"
              decoding="async"
            />
          </div>
          <h1 class="auth-title auth-title--center">{{ t('auth.loginTitle') }}</h1>
          <p class="auth-subtitle">{{ t('auth.loginFirebaseHint') }}</p>

          <form class="auth-form auth-form--narrow" :aria-label="t('auth.ariaLogin')" @submit.prevent="handleLoginSubmit">
            <div class="auth-field">
              <input
                v-model="loginEmail"
                class="auth-input"
                type="email"
                name="email"
                autocomplete="email"
                :disabled="loginLoading"
                required
                :aria-label="t('auth.emailPlaceholder')"
                :placeholder="t('auth.emailPlaceholder')"
              />
            </div>
            <div v-if="loginStep === 2" class="auth-field auth-field--step2">
              <input
                v-model="loginPassword"
                class="auth-input"
                type="password"
                name="password"
                autocomplete="current-password"
                :disabled="loginLoading"
                required
                :aria-label="t('auth.passwordPlaceholder')"
                :placeholder="t('auth.passwordPlaceholder')"
              />
            </div>
            <p v-if="loginEmailError" class="auth-error" role="alert">{{ loginEmailError }}</p>
            <Button
              type="submit"
              class="auth-submit"
              rounded
              :label="loginStep === 1 ? t('auth.continue') : t('auth.signIn')"
              :loading="loginLoading"
              :disabled="loginLoading"
              severity="info"
            />
          </form>
        </div>

        <div v-else-if="isResidentLogin" class="auth-card auth-card--centered">
          <div class="auth-brand">
            <img
              src="/logo-buildingfex.png"
              :alt="t('brand')"
              class="auth-logo"
              width="200"
              height="48"
              decoding="async"
            />
          </div>
          <h1 class="auth-title auth-title--center">{{ t('auth.residentLoginTitle') }}</h1>
          <p class="auth-subtitle">{{ t('auth.residentLoginSubtitle') }}</p>
          <div class="auth-form auth-form--narrow" :aria-label="t('auth.residentLoginAria')">
            <p v-if="loginEmailError" class="auth-error" role="alert">{{ loginEmailError }}</p>
            <button
              type="button"
              class="auth-google"
              :disabled="loginLoading"
              @click="onLoginWithGoogle"
            >
              <span class="auth-google__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <path fill="#4285F4" d="M23.49 12.27c0-.82-.07-1.64-.23-2.43H12v4.6h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.55-5.17 3.55-8.79Z" />
                  <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.94l-3.88-3c-1.08.72-2.47 1.14-4.07 1.14-3.13 0-5.78-2.11-6.73-4.96H1.27v3.09A12 12 0 0 0 12 24Z" />
                  <path fill="#FBBC05" d="M5.27 14.24A7.2 7.2 0 0 1 4.89 12c0-.78.14-1.53.38-2.24V6.67H1.27A12 12 0 0 0 0 12c0 1.94.46 3.78 1.27 5.33l4-3.09Z" />
                  <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.6 4.59 1.79l3.44-3.44C17.95 1.14 15.23 0 12 0 7.31 0 3.23 2.69 1.27 6.67l4 3.09C6.22 6.86 8.87 4.75 12 4.75Z" />
                </svg>
              </span>
              <span>{{ loginLoading ? t('auth.inviteGoogleLoading') : t('auth.inviteGoogleButton') }}</span>
            </button>
          </div>
        </div>

        <div v-else class="auth-card auth-card--centered">
          <div class="auth-brand">
            <img
              src="/logo-buildingfex.png"
              :alt="t('brand')"
              class="auth-logo"
              width="200"
              height="48"
              decoding="async"
            />
          </div>
          <h1 class="auth-title auth-title--center">{{ t('auth.registerTitle') }}</h1>
          <p class="auth-subtitle">{{ t('auth.registerFirebaseHint') }}</p>

          <form class="auth-form auth-form--narrow" :aria-label="t('auth.ariaRegister')" @submit.prevent="onRegisterSubmit">
            <div class="auth-field">
              <input
                v-model="regName"
                class="auth-input"
                type="text"
                name="name"
                autocomplete="name"
                :disabled="registerLoading"
                required
                :aria-label="t('auth.fullNamePlaceholder')"
                :placeholder="t('auth.fullNamePlaceholder')"
              />
            </div>
            <div class="auth-field">
              <input
                v-model="regEmail"
                class="auth-input"
                type="email"
                name="email"
                autocomplete="email"
                :disabled="registerLoading"
                required
                :aria-label="t('auth.emailPlaceholder')"
                :placeholder="t('auth.emailPlaceholder')"
              />
            </div>
            <div class="auth-field">
              <input
                v-model="regPassword"
                class="auth-input"
                type="password"
                name="password"
                autocomplete="new-password"
                :disabled="registerLoading"
                required
                :aria-label="t('auth.passwordPlaceholder')"
                :placeholder="t('auth.passwordPlaceholder')"
              />
            </div>
            <div class="auth-field">
              <input
                v-model="regDni"
                class="auth-input"
                type="text"
                name="dni"
                autocomplete="off"
                :disabled="registerLoading"
                required
                :aria-label="t('auth.dniPlaceholder')"
                :placeholder="t('auth.dniPlaceholder')"
              />
            </div>
            <div class="auth-field">
              <input
                v-model="regAddress"
                class="auth-input"
                type="text"
                name="address"
                autocomplete="street-address"
                :disabled="registerLoading"
                required
                :aria-label="t('auth.addressPlaceholder')"
                :placeholder="t('auth.addressPlaceholder')"
              />
            </div>
            <div class="auth-field">
              <input
                v-model="regCompany"
                class="auth-input"
                type="text"
                name="company"
                autocomplete="organization"
                :disabled="registerLoading"
                required
                :aria-label="t('auth.companyPlaceholder')"
                :placeholder="t('auth.companyPlaceholder')"
              />
            </div>
            <div class="auth-field">
              <input
                v-model="regRuc"
                class="auth-input"
                type="text"
                name="ruc"
                autocomplete="off"
                :disabled="registerLoading"
                required
                :aria-label="t('auth.rucPlaceholder')"
                :placeholder="t('auth.rucPlaceholder')"
              />
            </div>
            <p v-if="registerError" class="auth-error" role="alert">{{ registerError }}</p>
            <Button
              type="submit"
              class="auth-submit"
              rounded
              :label="t('auth.createAccount')"
              :loading="registerLoading"
              :disabled="registerLoading"
              severity="info"
            />
          </form>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.auth-page {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--apple-bg-secondary, #f5f5f7);
  font-family: var(--apple-font, -apple-system, system-ui, sans-serif);
  -webkit-font-smoothing: antialiased;
}

.auth-main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(env(safe-area-inset-top, 0px) + 2rem) 1.25rem 2.5rem;
}

.auth-shell {
  width: 100%;
  max-width: 460px;
}

.auth-tabs {
  margin-bottom: 1rem;
}

.auth-tabs__track {
  /* ~40% menos altura que antes (padding y gap escalados a 0.6) */
  --tab-p: 0.21rem;
  --tab-gap: 0.21rem;

  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: var(--tab-gap);
  padding: var(--tab-p);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.06);
}

.auth-tabs__pill {
  position: absolute;
  top: var(--tab-p);
  bottom: var(--tab-p);
  left: var(--tab-p);
  z-index: 0;
  width: calc((100% - 2 * var(--tab-p) - 2 * var(--tab-gap)) / 3);
  border-radius: 999px;
  background: #ffffff;
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.07);
  pointer-events: none;
  transition: transform 0.42s cubic-bezier(0.34, 1.2, 0.64, 1);
  will-change: transform;
}

.auth-tabs__pill--register {
  transform: translateX(calc(100% + var(--tab-gap)));
}

.auth-tabs__pill--resident {
  transform: translateX(calc(200% + 2 * var(--tab-gap)));
}

.auth-tab {
  position: relative;
  z-index: 1;
  margin: 0;
  text-align: center;
  padding: 0.33rem 0.4rem;
  font-size: 0.75rem;
  line-height: 1.25;
  font-weight: 500;
  letter-spacing: -0.02em;
  color: var(--apple-text-secondary);
  text-decoration: none;
  border-radius: 999px;
  transition:
    color 0.28s ease,
    font-weight 0.28s ease;
}

.auth-tab:hover {
  color: var(--apple-text);
}

.auth-tab--active {
  color: var(--apple-text);
  font-weight: 700;
}

@media (prefers-reduced-motion: reduce) {
  .auth-tabs__pill {
    transition-duration: 0.01ms;
  }
}

.auth-card {
  padding: 1.75rem 1.5rem 1.5rem;
  border-radius: 20px;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.04),
    0 12px 28px rgba(0, 0, 0, 0.06);
}

.auth-card--centered {
  text-align: center;
}

.auth-brand {
  display: flex;
  justify-content: center;
  margin-bottom: 1.35rem;
}

.auth-logo {
  height: 44px;
  width: auto;
  max-width: min(220px, 72vw);
  object-fit: contain;
  object-position: center;
}

.auth-title {
  margin: 0 0 0.5rem;
  font-size: clamp(1.35rem, 3vw, 1.6rem);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: #000000;
}

.auth-title--center {
  text-align: center;
}

.auth-subtitle {
  margin: 0 0 1.5rem;
  font-size: 0.9375rem;
  line-height: 1.45;
  letter-spacing: -0.015em;
  color: #6e6e73;
  text-align: center;
}

.auth-preview-hint {
  margin: -1rem 0 1.25rem;
  font-size: 0.8125rem;
  line-height: 1.4;
  letter-spacing: -0.01em;
  color: #0071e3;
  text-align: center;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.auth-form--narrow {
  max-width: 100%;
  margin: 0 auto;
  width: 100%;
}

.auth-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  text-align: left;
}

.auth-field--step2 {
  animation: auth-field-in 0.35s cubic-bezier(0.25, 0.1, 0.25, 1) both;
}

@keyframes auth-field-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.auth-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.7rem 0.9rem;
  font-size: 1rem;
  font-family: inherit;
  letter-spacing: -0.02em;
  color: var(--apple-text);
  background: #ffffff;
  border: 1px solid #d2d2d7;
  border-radius: 10px;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.auth-input::placeholder {
  color: #86868b;
}

.auth-input:focus {
  outline: none;
  border-color: rgba(var(--apple-blue-rgb), 0.55);
  box-shadow: 0 0 0 3px rgba(var(--apple-blue-rgb), 0.15);
}

.auth-error {
  margin: -0.25rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: #b42318;
  text-align: center;
}

.auth-submit {
  margin-top: 0.35rem;
  width: 100%;
  justify-content: center;
}

.auth-submit :deep(.p-button) {
  width: 100%;
  justify-content: center;
  font-weight: 600 !important;
  padding-top: 0.7rem !important;
  padding-bottom: 0.7rem !important;
}

.auth-divider {
  margin: 0.15rem 0 0;
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #86868b;
  text-align: center;
}

.auth-google {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.65rem;
  width: 100%;
  min-height: 2.75rem;
  padding: 0.55rem 1rem;
  border: 1px solid #dadce0;
  border-radius: 999px;
  background: #fff;
  color: #1d1d1f;
  font: inherit;
  font-size: 0.9375rem;
  font-weight: 600;
  letter-spacing: -0.015em;
  cursor: pointer;
}

.auth-google:hover:not(:disabled) {
  background: #f8f9fa;
  border-color: #c6c6c6;
}

.auth-google:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.auth-google__icon {
  display: inline-flex;
}

.auth-invite-list {
  list-style: none;
  margin: 0 0 1.25rem;
  padding: 0.85rem 1rem;
  text-align: left;
  background: #f5f5f7;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.95rem;
  color: #1d1d1f;
}

@media (prefers-reduced-motion: reduce) {
  .auth-field--step2 {
    animation: none;
  }
}
</style>
