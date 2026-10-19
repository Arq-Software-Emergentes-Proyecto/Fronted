<script setup>
import { computed, ref, watch, watchEffect } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Button from 'primevue/button'
import SkipLink from '@/shared/presentation/components/SkipLink.vue'
import LocaleSwitch from '@/shared/presentation/components/LocaleSwitch.vue'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import { authApi } from '@/iam/infrastructure/authApi.js'
import { residentsApi } from '@/residents/infrastructure/residentsApi.js'
import { useSession } from '@/iam/application/sessionStore.js'
import { OPEN_WIREFRAME_ACCESS } from '@/iam/application/localPreviewAuth.js'
import { signInWithGoogle, refreshFirebaseIdToken } from '@/iam/infrastructure/googleIdentity.js'
import {
  createResidentPasswordAccount,
  deleteJustCreatedFirebaseUser,
} from '@/iam/infrastructure/firebaseAuth.js'
import BuildingForm from '@/profiles/presentation/components/BuildingForm.vue'

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
const inviteToken = computed(() =>
  String(route.query.token ?? route.query.code ?? '').trim(),
)

const inviteStep = ref('welcome') // 'welcome' | 'google' (Google or email + password)
const inviteResident = ref(null)
const inviteFetchError = ref('')
const inviteLoading = ref(false)
const residentError = ref('')
const residentLoading = ref(false)

const inviteName = computed(() => inviteResident.value?.name ?? '')
const inviteFloor = computed(() => inviteResident.value?.floor ?? '')
const inviteCodeDisplay = computed(() => inviteResident.value?.code ?? '')

async function resolveResidentToken(authResult) {
  if (authResult?.token) return authResult.token
  return refreshFirebaseIdToken()
}

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
  if (error?.code === 'INVITE_EXPIRED') return t('auth.inviteExpired')
  if (error?.code === 'INVITE_ALREADY_USED') return t('auth.inviteAlreadyUsed')
  if (error?.code === 'INVITE_EMAIL_MISMATCH') return t('auth.inviteEmailMismatch')
  if (error?.code === 'EMAIL_NOT_FOUND') return t('auth.residentGoogleNotFound')
  if (error?.code === 'RESIDENT_ONLY') return t('auth.residentGoogleAdminBlocked')
  if (error?.code === 'RESIDENT_GOOGLE_REQUIRED') return t('auth.residentGoogleRequired')
  if (error?.code === 'RESIDENT_USE_GOOGLE') return t('auth.residentUseGoogle')
  if (error?.code === 'PASSWORD_TOO_SHORT') return t('auth.passwordTooShort')
  if (error?.code === 'INVALID_PASSWORD') return t('auth.passwordInvalid')
  if (error?.code === 'TOO_MANY_REQUESTS') return t('auth.tooManyRequests')
  if (error?.code === 'ACCOUNT_DEACTIVATED') return t('auth.accountDeactivated')
  return t('auth.inviteGoogleError')
}

watchEffect(async () => {
  if (!isResidentInvite.value || !inviteToken.value) {
    inviteResident.value = null
    return
  }
  inviteLoading.value = true
  inviteFetchError.value = ''
  try {
    inviteResident.value = await residentsApi.findByInviteToken(inviteToken.value)
  } catch (error) {
    inviteResident.value = null
    if (error?.code === 'RESIDENT_NOT_FOUND') {
      inviteFetchError.value = t('auth.inviteNotFound')
    } else if (error?.code === 'INVITE_EXPIRED') {
      inviteFetchError.value = t('auth.inviteExpired')
    } else if (error?.code === 'INVITE_ALREADY_USED') {
      inviteFetchError.value = t('auth.inviteAlreadyUsed')
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
    const authResult = await residentsApi.completeInviteWithGoogle({
      token: inviteToken.value,
      email: googleProfile.email,
      name: googleProfile.name,
      googleSub: googleProfile.googleSub,
      idToken: googleProfile.idToken,
    })
    const sessionToken = await resolveResidentToken(authResult)
    await applyResidentSession(authResult.user, sessionToken)
  } catch (error) {
    residentError.value = googleAuthMessage(error)
  } finally {
    residentLoading.value = false
  }
}

/** Invite completion with email + password instead of Google (US014: residents may use both). */
const invitePwEmail = ref('')
const invitePwPassword = ref('')
const invitePwConfirm = ref('')
/** RNF003: invite password control the current error refers to ('email' | 'password' | 'confirm'). */
const inviteErrorField = ref(null)
watch(residentError, (msg) => {
  if (!msg) inviteErrorField.value = null
}, { flush: 'sync' })

async function onResidentPasswordSignUp() {
  if (residentLoading.value) return
  residentError.value = ''
  const email = invitePwEmail.value.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    residentError.value = t('auth.emailInvalid')
    inviteErrorField.value = 'email'
    return
  }
  if (String(invitePwPassword.value).length < 6) {
    residentError.value = t('auth.passwordTooShort')
    inviteErrorField.value = 'password'
    return
  }
  if (invitePwPassword.value !== invitePwConfirm.value) {
    residentError.value = t('auth.passwordMismatch')
    inviteErrorField.value = 'confirm'
    return
  }
  residentLoading.value = true
  let account = null
  try {
    // Validate the invite (not found / used / expired) BEFORE creating the Firebase
    // account, so a rejected invite does not leave an orphan email/password account.
    await residentsApi.findByInviteToken(inviteToken.value)
    account = OPEN_WIREFRAME_ACCESS
      ? { email, token: 'preview-password', created: false }
      : await createResidentPasswordAccount({
          email,
          password: invitePwPassword.value,
          name: inviteName.value,
        })
    let authResult
    try {
      authResult = await residentsApi.completeInviteWithPassword({
        token: inviteToken.value,
        email: account.email,
        name: inviteName.value,
        idToken: account.token,
      })
    } catch (apiFailure) {
      // API rejected it (e.g. INVITE_EMAIL_MISMATCH): undo the account we just created.
      // Not on network / 5xx errors: the server may have linked it before the failure.
      const indeterminate =
        apiFailure?.code === 'NETWORK_ERROR' ||
        apiFailure?.code === 'TIMEOUT' ||
        Number(apiFailure?.status) >= 500
      if (account.created && !indeterminate) await deleteJustCreatedFirebaseUser(account.uid)
      throw apiFailure
    }
    const sessionToken = OPEN_WIREFRAME_ACCESS
      ? authResult.token
      : await resolveResidentToken({ token: null })
    await applyResidentSession(authResult.user, sessionToken)
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
/** RNF003: which login control the current error refers to ('email' | 'password' | null). */
const loginErrorField = ref(null)
watch(loginEmailError, (msg) => {
  if (!msg) loginErrorField.value = null
}, { flush: 'sync' })

function setLoginError(message, field = null) {
  loginEmailError.value = message
  loginErrorField.value = field
}

const regName = ref('')
const regEmail = ref('')
const regPassword = ref('')
const regDni = ref('')
const regAddress = ref('')
const regCompany = ref('')
const regRuc = ref('')
const registerError = ref('')
const registerLoading = ref(false)

/** RNF003: per-field errors (i18n keys) for the register / complete-profile forms. */
const regErrors = ref({})
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function clearRegError(field) {
  if (regErrors.value[field]) regErrors.value = { ...regErrors.value, [field]: '' }
}

function regFieldAttrs(field) {
  const invalid = Boolean(regErrors.value[field])
  return {
    'aria-invalid': invalid ? 'true' : 'false',
    'aria-describedby': invalid ? `reg-${field}-error` : undefined,
  }
}

/** @param {string[]} required */
function validateRegFields(required, { password = false } = {}) {
  const errors = {}
  const values = {
    name: regName.value,
    email: regEmail.value,
    password: regPassword.value,
    dni: regDni.value,
    address: regAddress.value,
    company: regCompany.value,
    ruc: regRuc.value,
  }
  for (const field of required) {
    if (!String(values[field] ?? '').trim()) errors[field] = 'common.fieldRequired'
  }
  if (!errors.email && !EMAIL_PATTERN.test(String(regEmail.value).trim())) errors.email = 'auth.emailInvalid'
  if (password && !errors.password && !OPEN_WIREFRAME_ACCESS && String(regPassword.value).length < 6) {
    errors.password = 'auth.passwordTooShort'
  }
  regErrors.value = errors
  return Object.keys(errors).length === 0
}

/** Auth ok sin fila en profiles → completar perfil antes de entrar. */
const completeProfileMode = ref(false)
const pendingAuthToken = ref(null)
const completeProfileError = ref('')
const completeProfileLoading = ref(false)

function enterCompleteProfile({ token, identity, draft }) {
  completeProfileMode.value = true
  pendingAuthToken.value = token
  regName.value = draft?.name || identity?.name || ''
  regEmail.value = draft?.email || identity?.email || loginEmail.value || ''
  regDni.value = draft?.dni || ''
  regAddress.value = draft?.address || ''
  regCompany.value = draft?.company || ''
  regRuc.value = draft?.ruc || ''
  completeProfileError.value = ''
}

/** US015: after a new admin registers, ask for the building, then go to plan selection. */
const onboardingStep = ref(null) // null | 'building'

function onOnboardingBuildingSaved(building) {
  onboardingStep.value = null
  router.push({
    name: AppRouteNames.APP_SETTINGS,
    query: { tab: 'plans', ...(building?.suggestedPlanId ? { suggestedPlan: building.suggestedPlanId } : {}) },
  })
}

function onOnboardingSkip() {
  onboardingStep.value = null
  navigateAfterAuth({ name: AppRouteNames.APP_DASHBOARD })
}

function finishAdminSession(user, token, { onboarding = false } = {}) {
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
  completeProfileMode.value = false
  pendingAuthToken.value = null
  if (onboarding) {
    onboardingStep.value = 'building'
    return
  }
  navigateAfterAuth({ name: AppRouteNames.APP_DASHBOARD })
}

async function onLoginContinue() {
  loginEmailError.value = ''
  const raw = loginEmail.value.trim()
  if (OPEN_WIREFRAME_ACCESS) {
    if (!raw) {
      setLoginError(t('auth.emailInvalid'), 'email')
      return
    }
    loginStep.value = 2
    return
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    setLoginError(t('auth.emailInvalid'), 'email')
    return
  }
  loginLoading.value = true
  try {
    const exists = await authApi.isEmailRegistered(raw)
    if (!exists) {
      setLoginError(t('auth.emailNotRegistered'), 'email')
      return
    }
    loginStep.value = 2
  } catch (e) {
    if (e?.code === 'RESIDENT_USE_GOOGLE') {
      setLoginError(t('auth.residentUseGoogle'), 'email')
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
    const authResult = await authApi.loginWithGoogle({
      email: googleProfile.email,
      googleSub: googleProfile.googleSub,
      idToken: googleProfile.idToken,
    })
    if (authResult.user.role !== 'resident') {
      loginEmailError.value = t('auth.residentGoogleAdminBlocked')
      return
    }
    const sessionToken = await resolveResidentToken(authResult)
    await applyResidentSession(authResult.user, sessionToken)
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
    if (!loginPassword.value) {
      setLoginError(t('common.fieldRequired'), 'password')
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
    const { user, token, profileIncomplete } = await authApi.login({
      email: loginEmail.value,
      password: loginPassword.value,
    })

    // US014: one form, routed by the role the API reports.
    if (user.role === 'resident') {
      await applyResidentSession(user, token)
      return
    }

    if (profileIncomplete) {
      enterCompleteProfile({
        token,
        identity: user,
        draft: { name: user.name, email: user.email },
      })
      return
    }

    finishAdminSession(user, token)
  } catch (error) {
    if (error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT') {
      loginEmailError.value = t('auth.apiUnavailable')
      return
    }
    if (error?.code === 'INVALID_PASSWORD') {
      setLoginError(t('auth.passwordInvalid'), 'password')
      return
    }
    if (error?.code === 'TOO_MANY_REQUESTS') {
      loginEmailError.value = t('auth.tooManyRequests')
      return
    }
    if (error?.code === 'ACCOUNT_DEACTIVATED') {
      loginEmailError.value = t('auth.accountDeactivated')
      return
    }
    if (error?.code === 'RESIDENT_USE_GOOGLE') {
      loginEmailError.value = t('auth.residentUseGoogle')
      return
    }
    if (error?.code === 'EMAIL_NOT_FOUND') {
      loginStep.value = 1
      loginPassword.value = ''
      setLoginError(t('auth.emailNotRegistered'), 'email')
      return
    }
    loginEmailError.value = t('auth.genericError')
  } finally {
    loginLoading.value = false
  }
}

/** Resident tab: email + password in a single step (Google stays available above). */
async function onResidentPasswordLogin() {
  if (loginLoading.value) return
  loginEmailError.value = ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail.value.trim())) {
    setLoginError(t('auth.emailInvalid'), 'email')
    return
  }
  if (!loginPassword.value) {
    setLoginError(t('common.fieldRequired'), 'password')
    return
  }
  await onLoginSubmit()
}

async function onCompleteProfileSubmit() {
  if (completeProfileLoading.value || !pendingAuthToken.value) return
  completeProfileError.value = ''
  if (!validateRegFields(['name', 'email'])) {
    completeProfileError.value = t('common.fieldsHighlighted')
    return
  }
  completeProfileLoading.value = true
  completeProfileError.value = ''
  try {
    const { user, token } = await authApi.completeProfile(pendingAuthToken.value, {
      name: regName.value,
      email: regEmail.value,
      dni: regDni.value,
      address: regAddress.value,
      company: regCompany.value,
      ruc: regRuc.value,
    })
    finishAdminSession(user, token, { onboarding: true })
  } catch (error) {
    if (error?.code === 'ADMIN_BOOTSTRAP_CLOSED' || error?.status === 409 || error?.code === 'HTTP_409') {
      completeProfileError.value = t('auth.adminBootstrapClosed')
      return
    }
    if (error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT') {
      completeProfileError.value = t('auth.apiUnavailable')
      return
    }
    completeProfileError.value = t('auth.completeProfileError')
  } finally {
    completeProfileLoading.value = false
  }
}

async function onRegisterSubmit() {
  if (registerLoading.value) return
  registerError.value = ''
  if (!validateRegFields(['name', 'email', 'password', 'dni', 'address', 'company', 'ruc'], { password: true })) {
    registerError.value = t('common.fieldsHighlighted')
    return
  }
  registerLoading.value = true
  try {
    const { user, token } = await authApi.registerAdmin({
      name: regName.value,
      email: regEmail.value,
      password: regPassword.value,
      dni: regDni.value,
      address: regAddress.value,
      company: regCompany.value,
      ruc: regRuc.value,
    })
    finishAdminSession(user, token, { onboarding: true })
  } catch (error) {
    if (error?.code === 'PROFILE_INCOMPLETE_AFTER_AUTH') {
      enterCompleteProfile({
        token: error.token,
        identity: error.identity,
        draft: error.profileDraft,
      })
      return
    }
    if (error?.code === 'ADMIN_BOOTSTRAP_CLOSED') {
      registerError.value = t('auth.adminBootstrapClosed')
      return
    }
    if (error?.code === 'EMAIL_ALREADY_EXISTS') {
      registerError.value = t('auth.emailAlreadyExists')
      regErrors.value = { ...regErrors.value, email: 'auth.emailAlreadyExists' }
      return
    }
    if (error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT') {
      registerError.value = t('auth.apiUnavailable')
      return
    }
    if (error?.code === 'PROFILE_SAVE_FAILED') {
      registerError.value = t('auth.completeProfileError')
      return
    }
    registerError.value = t('auth.genericError')
  } finally {
    registerLoading.value = false
  }
}

watch(inviteToken, () => {
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
      regErrors.value = {}
    }
  },
)

// apiClient / router guard send the user here with ?session=deactivated|expired: say why.
watch(
  () => route.query.session,
  (reason) => {
    if (reason === 'deactivated') loginEmailError.value = t('auth.accountDeactivated')
    else if (reason === 'expired') loginEmailError.value = t('auth.sessionExpired')
  },
  { immediate: true },
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
    <header class="auth-topbar">
      <LocaleSwitch />
    </header>
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
            <p v-if="residentError" id="invite-error" class="auth-error" role="alert">{{ residentError }}</p>
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

            <p class="auth-divider" role="separator">{{ t('auth.orPasswordDivider') }}</p>

            <form
              class="auth-form auth-form--nested"
              :aria-label="t('auth.invitePasswordAria')"
              novalidate
              @submit.prevent="onResidentPasswordSignUp"
            >
              <p class="auth-subtitle auth-subtitle--compact">{{ t('auth.invitePasswordHint') }}</p>
              <div class="auth-field">
                <input
                  v-model="invitePwEmail"
                  class="auth-input"
                  type="email"
                  name="email"
                  autocomplete="email"
                  :disabled="residentLoading"
                  required
                  :aria-label="t('auth.emailPlaceholder')"
                  :placeholder="t('auth.emailPlaceholder')"
                  :aria-invalid="inviteErrorField === 'email' ? 'true' : 'false'"
                  :aria-describedby="inviteErrorField === 'email' ? 'invite-error' : undefined"
                />
              </div>
              <div class="auth-field">
                <input
                  v-model="invitePwPassword"
                  class="auth-input"
                  type="password"
                  name="new-password"
                  autocomplete="new-password"
                  minlength="6"
                  :disabled="residentLoading"
                  required
                  :aria-label="t('auth.passwordPlaceholder')"
                  :placeholder="t('auth.passwordPlaceholder')"
                  :aria-invalid="inviteErrorField === 'password' ? 'true' : 'false'"
                  :aria-describedby="inviteErrorField === 'password' ? 'invite-error' : undefined"
                />
              </div>
              <div class="auth-field">
                <input
                  v-model="invitePwConfirm"
                  class="auth-input"
                  type="password"
                  name="confirm-password"
                  autocomplete="new-password"
                  minlength="6"
                  :disabled="residentLoading"
                  required
                  :aria-label="t('auth.passwordConfirmPlaceholder')"
                  :placeholder="t('auth.passwordConfirmPlaceholder')"
                  :aria-invalid="inviteErrorField === 'confirm' ? 'true' : 'false'"
                  :aria-describedby="inviteErrorField === 'confirm' ? 'invite-error' : undefined"
                />
              </div>
              <Button
                type="submit"
                class="auth-submit"
                rounded
                severity="info"
                :label="t('auth.invitePasswordSubmit')"
                :loading="residentLoading"
                :disabled="residentLoading"
              />
            </form>
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

        <div v-if="onboardingStep === 'building'" class="auth-card auth-card--centered">
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
          <p class="auth-onboarding-step">{{ t('buildings.onboarding.step') }}</p>
          <h1 class="auth-title auth-title--center">{{ t('buildings.onboarding.title') }}</h1>
          <p class="auth-subtitle">{{ t('buildings.onboarding.subtitle') }}</p>
          <div class="auth-form auth-form--narrow">
            <BuildingForm
              :submit-label="t('buildings.onboarding.submit')"
              show-skip
              @saved="onOnboardingBuildingSaved"
              @skip="onOnboardingSkip"
            />
          </div>
        </div>

        <div v-else-if="completeProfileMode" class="auth-card auth-card--centered">
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
          <h1 class="auth-title auth-title--center">{{ t('auth.completeProfileTitle') }}</h1>
          <p class="auth-subtitle">{{ t('auth.completeProfileHint') }}</p>

          <form
            class="auth-form auth-form--narrow"
            :aria-label="t('auth.ariaCompleteProfile')"
            novalidate
            @submit.prevent="onCompleteProfileSubmit"
          >
            <div class="auth-field">
              <input
                v-model="regName"
                class="auth-input"
                type="text"
                name="name"
                autocomplete="name"
                :disabled="completeProfileLoading"
                required
                :aria-label="t('auth.fullNamePlaceholder')"
                :placeholder="t('auth.fullNamePlaceholder')"
                v-bind="regFieldAttrs('name')"
                @input="clearRegError('name')"
              />
              <p v-if="regErrors.name" id="reg-name-error" class="bf-field-error">{{ t(regErrors.name) }}</p>
            </div>
            <div class="auth-field">
              <input
                v-model="regEmail"
                class="auth-input"
                type="email"
                name="email"
                autocomplete="email"
                :disabled="completeProfileLoading"
                required
                :aria-label="t('auth.emailPlaceholder')"
                :placeholder="t('auth.emailPlaceholder')"
                v-bind="regFieldAttrs('email')"
                @input="clearRegError('email')"
              />
              <p v-if="regErrors.email" id="reg-email-error" class="bf-field-error">{{ t(regErrors.email) }}</p>
            </div>
            <div class="auth-field">
              <input
                v-model="regDni"
                class="auth-input"
                type="text"
                name="dni"
                :disabled="completeProfileLoading"
                :aria-label="t('auth.dniPlaceholder')"
                :placeholder="t('auth.dniPlaceholder')"
                v-bind="regFieldAttrs('dni')"
                @input="clearRegError('dni')"
              />
              <p v-if="regErrors.dni" id="reg-dni-error" class="bf-field-error">{{ t(regErrors.dni) }}</p>
            </div>
            <div class="auth-field">
              <input
                v-model="regCompany"
                class="auth-input"
                type="text"
                name="company"
                :disabled="completeProfileLoading"
                :aria-label="t('auth.companyPlaceholder')"
                :placeholder="t('auth.companyPlaceholder')"
                v-bind="regFieldAttrs('company')"
                @input="clearRegError('company')"
              />
              <p v-if="regErrors.company" id="reg-company-error" class="bf-field-error">{{ t(regErrors.company) }}</p>
            </div>
            <div class="auth-field">
              <input
                v-model="regRuc"
                class="auth-input"
                type="text"
                name="ruc"
                :disabled="completeProfileLoading"
                :aria-label="t('auth.rucPlaceholder')"
                :placeholder="t('auth.rucPlaceholder')"
                v-bind="regFieldAttrs('ruc')"
                @input="clearRegError('ruc')"
              />
              <p v-if="regErrors.ruc" id="reg-ruc-error" class="bf-field-error">{{ t(regErrors.ruc) }}</p>
            </div>
            <div class="auth-field">
              <input
                v-model="regAddress"
                class="auth-input"
                type="text"
                name="address"
                autocomplete="street-address"
                :disabled="completeProfileLoading"
                :aria-label="t('auth.addressPlaceholder')"
                :placeholder="t('auth.addressPlaceholder')"
                v-bind="regFieldAttrs('address')"
                @input="clearRegError('address')"
              />
              <p v-if="regErrors.address" id="reg-address-error" class="bf-field-error">{{ t(regErrors.address) }}</p>
            </div>
            <p v-if="completeProfileError" class="auth-error" role="alert">{{ completeProfileError }}</p>
            <Button
              type="submit"
              class="auth-submit"
              :label="t('auth.completeProfileSubmit')"
              :loading="completeProfileLoading"
              :disabled="completeProfileLoading"
            />
          </form>
        </div>

        <div v-else-if="isAdminLogin" class="auth-card auth-card--centered">
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

          <form class="auth-form auth-form--narrow" :aria-label="t('auth.ariaLogin')" novalidate @submit.prevent="handleLoginSubmit">
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
                :aria-invalid="loginErrorField === 'email' ? 'true' : 'false'"
                :aria-describedby="loginErrorField === 'email' ? 'login-error' : undefined"
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
                :aria-invalid="loginErrorField === 'password' ? 'true' : 'false'"
                :aria-describedby="loginErrorField === 'password' ? 'login-error' : undefined"
              />
            </div>
            <p v-if="loginEmailError" id="login-error" class="auth-error" role="alert">{{ loginEmailError }}</p>
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
            <p v-if="loginEmailError" id="login-error" class="auth-error" role="alert">{{ loginEmailError }}</p>
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

            <p class="auth-divider" role="separator">{{ t('auth.orPasswordDivider') }}</p>

            <form
              class="auth-form auth-form--nested"
              :aria-label="t('auth.residentPasswordLoginAria')"
              novalidate
              @submit.prevent="onResidentPasswordLogin"
            >
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
                  :aria-invalid="loginErrorField === 'email' ? 'true' : 'false'"
                  :aria-describedby="loginErrorField === 'email' ? 'login-error' : undefined"
                />
              </div>
              <div class="auth-field">
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
                  :aria-invalid="loginErrorField === 'password' ? 'true' : 'false'"
                  :aria-describedby="loginErrorField === 'password' ? 'login-error' : undefined"
                />
              </div>
              <Button
                type="submit"
                class="auth-submit"
                rounded
                severity="info"
                :label="t('auth.signIn')"
                :loading="loginLoading"
                :disabled="loginLoading"
              />
            </form>
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

          <form class="auth-form auth-form--narrow" :aria-label="t('auth.ariaRegister')" novalidate @submit.prevent="onRegisterSubmit">
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
                v-bind="regFieldAttrs('name')"
                @input="clearRegError('name')"
              />
              <p v-if="regErrors.name" id="reg-name-error" class="bf-field-error">{{ t(regErrors.name) }}</p>
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
                v-bind="regFieldAttrs('email')"
                @input="clearRegError('email')"
              />
              <p v-if="regErrors.email" id="reg-email-error" class="bf-field-error">{{ t(regErrors.email) }}</p>
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
                v-bind="regFieldAttrs('password')"
                @input="clearRegError('password')"
              />
              <p v-if="regErrors.password" id="reg-password-error" class="bf-field-error">{{ t(regErrors.password) }}</p>
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
                v-bind="regFieldAttrs('dni')"
                @input="clearRegError('dni')"
              />
              <p v-if="regErrors.dni" id="reg-dni-error" class="bf-field-error">{{ t(regErrors.dni) }}</p>
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
                v-bind="regFieldAttrs('address')"
                @input="clearRegError('address')"
              />
              <p v-if="regErrors.address" id="reg-address-error" class="bf-field-error">{{ t(regErrors.address) }}</p>
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
                v-bind="regFieldAttrs('company')"
                @input="clearRegError('company')"
              />
              <p v-if="regErrors.company" id="reg-company-error" class="bf-field-error">{{ t(regErrors.company) }}</p>
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
                v-bind="regFieldAttrs('ruc')"
                @input="clearRegError('ruc')"
              />
              <p v-if="regErrors.ruc" id="reg-ruc-error" class="bf-field-error">{{ t(regErrors.ruc) }}</p>
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
.auth-onboarding-step {
  margin: 0 0 0.25rem;
  text-align: center;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #0a84ff;
}

.auth-page {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--apple-bg-secondary, #f5f5f7);
  font-family: var(--apple-font, -apple-system, system-ui, sans-serif);
  -webkit-font-smoothing: antialiased;
}

.auth-topbar {
  display: flex;
  justify-content: flex-end;
  padding: calc(env(safe-area-inset-top, 0px) + 0.85rem) 1.25rem 0;
}

.auth-main {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.25rem 1.25rem 2.5rem;
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

.auth-form--nested {
  gap: 0.75rem;
}

.auth-subtitle--compact {
  margin: 0;
  font-size: 0.8125rem;
}

.auth-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0.25rem 0;
  font-size: 0.8125rem;
  color: #6e6e73;
}

.auth-divider::before,
.auth-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: #d2d2d7;
}

.auth-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  text-align: left;
}

.auth-field .bf-field-error {
  margin-top: 0;
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
