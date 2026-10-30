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
import {
  isBoardDemoUsername,
  isDemoCredentials,
  isDemoUsername,
  OPEN_WIREFRAME_ACCESS,
  previewAdminAuthResult,
  previewBoardAuthResult,
  previewResidentAuthResult,
} from '@/iam/application/localPreviewAuth.js'
import { loadAccessibleBuildings } from '@/iam/application/buildingWorkspace.js'
import { signInWithGoogle, refreshFirebaseIdToken } from '@/iam/infrastructure/googleIdentity.js'
import {
  createResidentPasswordAccount,
  deleteJustCreatedFirebaseUser,
  reloadVerifiedToken,
  sendPasswordReset,
} from '@/iam/infrastructure/firebaseAuth.js'
import { currentFirebaseIdToken, signOutFirebase } from '@/iam/infrastructure/firebaseSession.js'
import BuildingForm from '@/profiles/presentation/components/BuildingForm.vue'
import DashboardHeroArt from '@/shared/presentation/components/dashboard/DashboardHeroArt.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { setAdminSession, setResidentSession, setBoardSession } = useSession()

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

/** Left brand panel: short product benefits (decorative copy, same on every auth screen). */
const heroBenefits = [
  { key: 'auth.heroBenefitBilling', icon: 'pi pi-wallet' },
  { key: 'auth.heroBenefitQr', icon: 'pi pi-qrcode' },
  { key: 'auth.heroBenefitAi', icon: 'pi pi-sparkles' },
]

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
  if (error?.code === 'GOOGLE_POPUP_BLOCKED') return t('auth.googlePopupBlocked')
  if (error?.code === 'GOOGLE_BROWSER_UNSUPPORTED') return t('auth.googleBrowserUnsupported')
  if (error?.code === 'INVALID_ID_TOKEN') return t('auth.googleTokenInvalid')
  if (error?.code === 'INVALID_EMAIL') return t('auth.emailInvalid')
  if (error?.code === 'INVITE_EMAIL_UNVERIFIED') return t('auth.inviteVerifyStill')
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
    // Invite link without its token (cut off when copied): say so instead of an empty card.
    inviteFetchError.value = isResidentInvite.value ? t('auth.inviteNotFound') : ''
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
    void signOutFirebase()
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

/**
 * The invite is for a specific email and the API wants it verified: the Firebase account stays
 * signed in until the resident opens the verification link and confirms here.
 */
const inviteVerifyEmail = ref('')
const inviteVerifyNotice = ref('')

async function finishPasswordInvite(account) {
  const authResult = await residentsApi.completeInviteWithPassword({
    token: inviteToken.value,
    email: account.email,
    name: inviteName.value,
    idToken: account.token,
  })
  inviteVerifyEmail.value = ''
  const sessionToken = OPEN_WIREFRAME_ACCESS
    ? authResult.token
    : await resolveResidentToken({ token: null })
  await applyResidentSession(authResult.user, sessionToken)
}

async function onInviteVerifyRetry({ resend = false } = {}) {
  if (residentLoading.value) return
  residentError.value = ''
  inviteVerifyNotice.value = ''
  residentLoading.value = true
  try {
    const account = await reloadVerifiedToken({ resend })
    if (!account.verified) {
      if (resend) inviteVerifyNotice.value = t('auth.inviteVerifyResent')
      else residentError.value = t('auth.inviteVerifyStill')
      return
    }
    await finishPasswordInvite(account)
  } catch (error) {
    residentError.value = googleAuthMessage(error)
  } finally {
    residentLoading.value = false
  }
}

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
    try {
      await finishPasswordInvite(account)
    } catch (apiFailure) {
      if (apiFailure?.code === 'INVITE_EMAIL_UNVERIFIED') {
        // Right email, not verified yet: keep the account and wait for the verification link.
        // A reused account may never have received it, so send it (again) now.
        if (!account.created) await reloadVerifiedToken({ resend: true }).catch(() => {})
        inviteVerifyEmail.value = account.email
        return
      }
      // API rejected it (e.g. INVITE_EMAIL_MISMATCH): undo the account we just created.
      // Not on network / 5xx errors: the server may have linked it before the failure.
      const indeterminate =
        apiFailure?.code === 'NETWORK_ERROR' ||
        apiFailure?.code === 'TIMEOUT' ||
        Number(apiFailure?.status) >= 500
      if (account.created && !indeterminate) await deleteJustCreatedFirebaseUser(account.uid)
      else if (!indeterminate) void signOutFirebase()
      throw apiFailure
    }
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

/** "Session expired" is informational (blue notice); every other login message is an error. */
const LOGIN_INFO_KEYS = ['auth.sessionExpired', 'auth.resetSent']
const loginNoticeTone = computed(() =>
  loginEmailError.value && LOGIN_INFO_KEYS.some((key) => loginEmailError.value === t(key))
    ? 'info'
    : 'error',
)

function setLoginError(message, field = null) {
  loginEmailError.value = message
  loginErrorField.value = field
}

async function onForgotPassword() {
  if (loginLoading.value) return
  const email = loginEmail.value.trim()
  if (!EMAIL_PATTERN.test(email)) {
    setLoginError(t('auth.resetNeedsEmail'), 'email')
    return
  }
  loginLoading.value = true
  loginEmailError.value = ''
  try {
    if (!OPEN_WIREFRAME_ACCESS) await sendPasswordReset(email)
    loginEmailError.value = t('auth.resetSent')
  } catch (error) {
    if (error?.code === 'INVALID_EMAIL') setLoginError(t('auth.emailInvalid'), 'email')
    else if (error?.code === 'TOO_MANY_REQUESTS') loginEmailError.value = t('auth.tooManyRequests')
    else if (error?.code === 'NETWORK_ERROR') loginEmailError.value = t('auth.apiUnavailable')
    else loginEmailError.value = t('auth.genericError')
  } finally {
    loginLoading.value = false
  }
}

const regName = ref('')
const regEmail = ref('')
const regPassword = ref('')
const regDni = ref('')
const regAddress = ref('')
const regCompany = ref('')
const regRuc = ref('')
/** Quién registra la cuenta del condominio: la junta directiva o la empresa administradora. */
const regAccountKind = ref('administrator')
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

/** Role pills only make sense on the sign-in / register / resident screens (not mid-onboarding). */
const showRoleTabs = computed(
  () => !isResidentInvite.value && !onboardingStep.value && !completeProfileMode.value,
)
const roleTab = computed(() => (isResidentLogin.value ? 'resident' : 'admin'))

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

async function finishAdminSession(user, token, { onboarding = false } = {}) {
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
  // Edificios de la cuenta (Portafolio) y los que le asignaron: el panel abre en el edificio activo.
  await loadAccessibleBuildings(token)
  navigateAfterAuth({ name: AppRouteNames.APP_DASHBOARD })
}

/** Junta directiva: vista de solo lectura del edificio (o de los edificios) que la invitó. */
async function finishBoardSession(user, token) {
  setBoardSession({ id: user.id, name: user.name, email: user.email }, token)
  completeProfileMode.value = false
  pendingAuthToken.value = null
  await loadAccessibleBuildings(token)
  navigateAfterAuth({ name: AppRouteNames.APP_BOARD })
}

async function onLoginContinue() {
  loginEmailError.value = ''
  const raw = loginEmail.value.trim()
  // Cuenta demo: no es un correo ni existe en Firebase.
  if (isDemoUsername(raw)) {
    loginStep.value = 2
    return
  }
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
      void signOutFirebase()
      return
    }
    const sessionToken = await resolveResidentToken(authResult)
    await applyResidentSession(authResult.user, sessionToken)
  } catch (error) {
    loginEmailError.value = googleAuthMessage(error)
    void signOutFirebase()
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

/**
 * Usuario "test" / "123456": sesión demo con los datos de ejemplo del navegador (se reinician en cada
 * ingreso). Admin desde la pestaña de administrador, residente desde la de residente.
 */
async function startDemoSession(role) {
  if (!isDemoCredentials(loginEmail.value, loginPassword.value)) {
    setLoginError(t('auth.passwordInvalid'), 'password')
    return
  }
  loginLoading.value = true
  loginEmailError.value = ''
  try {
    // La demo nunca debe heredar la sesión de Firebase de una cuenta real abierta en este navegador.
    void signOutFirebase()
    const { resetMockDb } = await import('@/shared/infrastructure/mock/mockDb.js')
    resetMockDb()
    if (role === 'resident') {
      const { user, token } = previewResidentAuthResult()
      await applyResidentSession(user, token)
    } else if (role === 'board') {
      const { user, token } = previewBoardAuthResult()
      await finishBoardSession(user, token)
    } else {
      const { user, token } = previewAdminAuthResult()
      await finishAdminSession(user, token)
    }
  } catch {
    loginEmailError.value = t('auth.genericError')
  } finally {
    loginLoading.value = false
  }
}

async function onLoginSubmit() {
  if (isDemoUsername(loginEmail.value)) {
    const demoRole = isBoardDemoUsername(loginEmail.value) ? 'board' : isResidentLogin.value ? 'resident' : 'admin'
    await startDemoSession(demoRole)
    return
  }
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

    if (user.role === 'board_member') {
      await finishBoardSession(user, token)
      return
    }

    if (profileIncomplete && isResidentLogin.value) {
      // Firebase account with no BuildingFex account: a resident joins only through an invite.
      setLoginError(t('auth.residentAccountNotFound'), 'email')
      void signOutFirebase()
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

    await finishAdminSession(user, token)
  } catch (error) {
    // Signed into Firebase but rejected by the API: do not leave that Firebase session behind.
    void signOutFirebase()
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
  if (!isDemoUsername(loginEmail.value) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail.value.trim())) {
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
    // The token saved when the form opened may be over an hour old: ask Firebase for a current one.
    const authToken = await currentFirebaseIdToken(pendingAuthToken.value)
    const { user, token } = await authApi.completeProfile(authToken, {
      name: regName.value,
      email: regEmail.value,
      dni: regDni.value,
      address: regAddress.value,
      company: regCompany.value,
      ruc: regRuc.value,
    })
    finishAdminSession(user, token, { onboarding: true })
  } catch (error) {
    if (error?.code === 'ADMIN_BOOTSTRAP_CLOSED') {
      completeProfileError.value = t('auth.adminBootstrapClosed')
      return
    }
    if (error?.code === 'EMAIL_ALREADY_EXISTS' || error?.status === 409) {
      completeProfileError.value = t('auth.emailAlreadyExists')
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
      accountKind: regAccountKind.value,
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
    if (error?.code === 'PASSWORD_TOO_SHORT') {
      registerError.value = t('auth.passwordTooShort')
      regErrors.value = { ...regErrors.value, password: 'auth.passwordTooShort' }
      return
    }
    if (error?.code === 'INVALID_EMAIL') {
      registerError.value = t('auth.emailInvalid')
      regErrors.value = { ...regErrors.value, email: 'auth.emailInvalid' }
      return
    }
    if (error?.code === 'TOO_MANY_REQUESTS') {
      registerError.value = t('auth.tooManyRequests')
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
  inviteVerifyEmail.value = ''
  inviteVerifyNotice.value = ''
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

    <div class="auth-panel">
      <header class="auth-topbar">
        <span class="auth-topbar__brand">
          <span class="auth-badge auth-badge--sm">
            <img
              src="/logo-buildingfex.png"
              :alt="t('brand')"
              class="auth-badge__logo"
              width="904"
              height="276"
              decoding="async"
            />
          </span>
        </span>
        <span class="auth-locale">
          <LocaleSwitch />
        </span>
      </header>

      <main id="main-content" class="auth-main" role="main" tabindex="-1">
        <div class="auth-shell" :class="{ 'auth-shell--wide': (isRegister && !onboardingStep) || completeProfileMode }">
          <nav v-if="showRoleTabs" v-bf-seg="'.auth-role--active'" class="auth-roles" :aria-label="t('auth.roleTabsAria')" role="tablist">
            <RouterLink
              class="auth-role"
              role="tab"
              :class="{ 'auth-role--active': roleTab === 'admin' }"
              :aria-selected="roleTab === 'admin'"
              :to="{ name: AppRouteNames.LOGIN }"
            >
              <i class="pi pi-briefcase" aria-hidden="true" />
              <span>{{ t('auth.roleAdmin') }}</span>
            </RouterLink>
            <RouterLink
              class="auth-role"
              role="tab"
              :class="{ 'auth-role--active': roleTab === 'resident' }"
              :aria-selected="roleTab === 'resident'"
              :to="{ name: AppRouteNames.RESIDENT_LOGIN }"
            >
              <i class="pi pi-home" aria-hidden="true" />
              <span>{{ t('auth.roleResident') }}</span>
            </RouterLink>
          </nav>

          <!-- Resident invite (/login?invite=1&token=…) -->
          <template v-if="isResidentInvite">
            <section v-if="inviteStep === 'welcome'" class="auth-card">
              <p class="auth-eyebrow">
                <i class="pi pi-envelope" aria-hidden="true" />
                {{ t('auth.inviteEyebrow') }}
              </p>

              <p v-if="inviteLoading" class="auth-notice auth-notice--info" role="status">
                <i class="pi pi-spin pi-spinner auth-notice__icon" aria-hidden="true" />
                <span>{{ t('auth.inviteLoading') }}</span>
              </p>
              <template v-else-if="inviteFetchError">
                <p class="auth-notice auth-notice--error" role="alert">
                  <i class="pi pi-exclamation-circle auth-notice__icon" aria-hidden="true" />
                  <span>{{ inviteFetchError }}</span>
                </p>
                <p class="auth-helper">
                  <RouterLink class="auth-link" :to="{ name: AppRouteNames.RESIDENT_LOGIN }">
                    {{ t('auth.residentLoginLink') }}
                  </RouterLink>
                </p>
              </template>

              <template v-else-if="inviteResident">
                <h1 class="auth-title">{{ t('auth.inviteTitle') }}</h1>
                <p class="auth-subtitle">{{ t('auth.inviteSubtitle') }}</p>

                <dl class="auth-invite" :aria-label="t('auth.inviteDetailsAria')">
                  <div class="auth-invite__row">
                    <dt>{{ t('app.residentNameLabel') }}</dt>
                    <dd>{{ inviteName }}</dd>
                  </div>
                  <div class="auth-invite__row">
                    <dt>{{ t('app.residentFloorLabel') }}</dt>
                    <dd>{{ inviteFloor }}</dd>
                  </div>
                  <div class="auth-invite__row">
                    <dt>{{ t('app.residentCodeLabel') }}</dt>
                    <dd>{{ inviteCodeDisplay }}</dd>
                  </div>
                </dl>

                <Button
                  type="button"
                  class="auth-submit"
                  rounded
                  :label="t('auth.inviteAccept')"
                  @click="onResidentInviteAccept"
                />
              </template>
            </section>

            <section v-else class="auth-card">
              <p class="auth-eyebrow">
                <i class="pi pi-envelope" aria-hidden="true" />
                {{ t('auth.inviteEyebrow') }}
              </p>
              <h1 class="auth-title">{{ t('auth.inviteGoogleTitle') }}</h1>
              <p class="auth-subtitle">{{ t('auth.inviteGoogleSubtitle') }}</p>

              <div class="auth-form" :aria-label="t('auth.inviteGoogleAria')">
                <p v-if="residentError" id="invite-error" class="auth-notice auth-notice--error" role="alert">
                  <i class="pi pi-exclamation-circle auth-notice__icon" aria-hidden="true" />
                  <span>{{ residentError }}</span>
                </p>
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

                <div v-if="inviteVerifyEmail" class="auth-form auth-verify">
                  <p class="auth-notice auth-notice--info" role="status">
                    <i class="pi pi-envelope auth-notice__icon" aria-hidden="true" />
                    <span>{{ inviteVerifyNotice || t('auth.inviteVerifyEmail', { email: inviteVerifyEmail }) }}</span>
                  </p>
                  <Button
                    type="button"
                    class="auth-submit"
                    rounded
                    :label="t('auth.inviteVerifyDone')"
                    :loading="residentLoading"
                    :disabled="residentLoading"
                    @click="onInviteVerifyRetry()"
                  />
                  <button
                    type="button"
                    class="auth-text-button"
                    :disabled="residentLoading"
                    @click="onInviteVerifyRetry({ resend: true })"
                  >
                    {{ t('auth.inviteVerifyResend') }}
                  </button>
                </div>

                <form
                  v-else
                  class="auth-form"
                  :aria-label="t('auth.invitePasswordAria')"
                  novalidate
                  @submit.prevent="onResidentPasswordSignUp"
                >
                  <p class="auth-hint">{{ t('auth.invitePasswordHint') }}</p>
                  <div class="auth-field">
                    <label class="auth-label" for="inv-email">{{ t('auth.email') }}</label>
                    <input
                      id="inv-email"
                      v-model="invitePwEmail"
                      class="auth-input"
                      type="email"
                      name="email"
                      autocomplete="email"
                      :disabled="residentLoading"
                      required
                      :placeholder="t('auth.emailExample')"
                      :aria-invalid="inviteErrorField === 'email' ? 'true' : 'false'"
                      :aria-describedby="inviteErrorField === 'email' ? 'invite-error' : undefined"
                    />
                  </div>
                  <div class="auth-field">
                    <label class="auth-label" for="inv-password">{{ t('auth.password') }}</label>
                    <input
                      id="inv-password"
                      v-model="invitePwPassword"
                      class="auth-input"
                      type="password"
                      name="new-password"
                      autocomplete="new-password"
                      minlength="6"
                      :disabled="residentLoading"
                      required
                      :placeholder="t('auth.passwordMinHint')"
                      :aria-invalid="inviteErrorField === 'password' ? 'true' : 'false'"
                      :aria-describedby="inviteErrorField === 'password' ? 'invite-error' : undefined"
                    />
                  </div>
                  <div class="auth-field">
                    <label class="auth-label" for="inv-confirm">{{ t('auth.passwordConfirmPlaceholder') }}</label>
                    <input
                      id="inv-confirm"
                      v-model="invitePwConfirm"
                      class="auth-input"
                      type="password"
                      name="confirm-password"
                      autocomplete="new-password"
                      minlength="6"
                      :disabled="residentLoading"
                      required
                      :aria-invalid="inviteErrorField === 'confirm' ? 'true' : 'false'"
                      :aria-describedby="inviteErrorField === 'confirm' ? 'invite-error' : undefined"
                    />
                  </div>
                  <Button
                    type="submit"
                    class="auth-submit"
                    rounded
                    :label="t('auth.invitePasswordSubmit')"
                    :loading="residentLoading"
                    :disabled="residentLoading"
                  />
                </form>
              </div>
            </section>
          </template>

          <!-- US015: building registration right after sign-up -->
          <section v-else-if="onboardingStep === 'building'" class="auth-card">
            <p class="auth-eyebrow">
              <i class="pi pi-building" aria-hidden="true" />
              {{ t('buildings.onboarding.step') }}
            </p>
            <h1 class="auth-title">{{ t('buildings.onboarding.title') }}</h1>
            <p class="auth-subtitle">{{ t('buildings.onboarding.subtitle') }}</p>
            <div class="auth-building">
              <BuildingForm
                :submit-label="t('buildings.onboarding.submit')"
                show-skip
                @saved="onOnboardingBuildingSaved"
                @skip="onOnboardingSkip"
              />
            </div>
          </section>

          <!-- Auth ok but no business profile on the server yet -->
          <section v-else-if="completeProfileMode" class="auth-card">
            <h1 class="auth-title">{{ t('auth.completeProfileTitle') }}</h1>
            <p class="auth-subtitle">{{ t('auth.completeProfileHint') }}</p>

            <form
              class="auth-form"
              :aria-label="t('auth.ariaCompleteProfile')"
              novalidate
              @submit.prevent="onCompleteProfileSubmit"
            >
              <div class="auth-grid">
                <div class="auth-field">
                  <label class="auth-label" for="reg-name">{{ t('auth.fullName') }}</label>
                  <input
                    id="reg-name"
                    v-model="regName"
                    class="auth-input"
                    type="text"
                    name="name"
                    autocomplete="name"
                    :disabled="completeProfileLoading"
                    required
                    v-bind="regFieldAttrs('name')"
                    @input="clearRegError('name')"
                  />
                  <p v-if="regErrors.name" id="reg-name-error" class="bf-field-error">{{ t(regErrors.name) }}</p>
                </div>
                <div class="auth-field">
                  <label class="auth-label" for="reg-email">{{ t('auth.email') }}</label>
                  <input
                    id="reg-email"
                    v-model="regEmail"
                    class="auth-input"
                    type="email"
                    name="email"
                    autocomplete="email"
                    :disabled="completeProfileLoading"
                    required
                    :placeholder="t('auth.emailExample')"
                    v-bind="regFieldAttrs('email')"
                    @input="clearRegError('email')"
                  />
                  <p v-if="regErrors.email" id="reg-email-error" class="bf-field-error">{{ t(regErrors.email) }}</p>
                </div>
                <div class="auth-field">
                  <label class="auth-label" for="reg-dni">
                    {{ t('auth.dniPlaceholder') }} <span class="auth-label__opt">({{ t('auth.optional') }})</span>
                  </label>
                  <input
                    id="reg-dni"
                    v-model="regDni"
                    class="auth-input"
                    type="text"
                    name="dni"
                    :disabled="completeProfileLoading"
                    v-bind="regFieldAttrs('dni')"
                    @input="clearRegError('dni')"
                  />
                  <p v-if="regErrors.dni" id="reg-dni-error" class="bf-field-error">{{ t(regErrors.dni) }}</p>
                </div>
                <div class="auth-field">
                  <label class="auth-label" for="reg-company">
                    {{ t('auth.companyPlaceholder') }} <span class="auth-label__opt">({{ t('auth.optional') }})</span>
                  </label>
                  <input
                    id="reg-company"
                    v-model="regCompany"
                    class="auth-input"
                    type="text"
                    name="company"
                    :disabled="completeProfileLoading"
                    v-bind="regFieldAttrs('company')"
                    @input="clearRegError('company')"
                  />
                  <p v-if="regErrors.company" id="reg-company-error" class="bf-field-error">{{ t(regErrors.company) }}</p>
                </div>
                <div class="auth-field">
                  <label class="auth-label" for="reg-ruc">
                    {{ t('auth.rucPlaceholder') }} <span class="auth-label__opt">({{ t('auth.optional') }})</span>
                  </label>
                  <input
                    id="reg-ruc"
                    v-model="regRuc"
                    class="auth-input"
                    type="text"
                    name="ruc"
                    :disabled="completeProfileLoading"
                    v-bind="regFieldAttrs('ruc')"
                    @input="clearRegError('ruc')"
                  />
                  <p v-if="regErrors.ruc" id="reg-ruc-error" class="bf-field-error">{{ t(regErrors.ruc) }}</p>
                </div>
                <div class="auth-field">
                  <label class="auth-label" for="reg-address">
                    {{ t('auth.addressPlaceholder') }} <span class="auth-label__opt">({{ t('auth.optional') }})</span>
                  </label>
                  <input
                    id="reg-address"
                    v-model="regAddress"
                    class="auth-input"
                    type="text"
                    name="address"
                    autocomplete="street-address"
                    :disabled="completeProfileLoading"
                    v-bind="regFieldAttrs('address')"
                    @input="clearRegError('address')"
                  />
                  <p v-if="regErrors.address" id="reg-address-error" class="bf-field-error">{{ t(regErrors.address) }}</p>
                </div>
              </div>
              <p v-if="completeProfileError" class="auth-notice auth-notice--error" role="alert">
                <i class="pi pi-exclamation-circle auth-notice__icon" aria-hidden="true" />
                <span>{{ completeProfileError }}</span>
              </p>
              <Button
                type="submit"
                class="auth-submit"
                rounded
                :label="t('auth.completeProfileSubmit')"
                :loading="completeProfileLoading"
                :disabled="completeProfileLoading"
              />
            </form>
          </section>

          <!-- Admin sign-in: two steps (email → password) -->
          <section v-else-if="isAdminLogin" class="auth-card">
            <h1 class="auth-title">{{ t('auth.loginTitle') }}</h1>
            <p class="auth-subtitle">{{ t('auth.loginFirebaseHint') }}</p>

            <form class="auth-form" :aria-label="t('auth.ariaLogin')" novalidate @submit.prevent="handleLoginSubmit">
              <div class="auth-field">
                <label class="auth-label" for="login-email">{{ t('auth.email') }}</label>
                <input
                  id="login-email"
                  v-model="loginEmail"
                  class="auth-input"
                  type="email"
                  name="email"
                  autocomplete="email"
                  :disabled="loginLoading"
                  required
                  :placeholder="t('auth.emailExample')"
                  :aria-invalid="loginErrorField === 'email' ? 'true' : 'false'"
                  :aria-describedby="loginErrorField === 'email' ? 'login-error' : undefined"
                />
              </div>
              <div v-if="loginStep === 2" class="auth-field auth-field--step2">
                <label class="auth-label" for="login-password">{{ t('auth.password') }}</label>
                <input
                  id="login-password"
                  v-model="loginPassword"
                  class="auth-input"
                  type="password"
                  name="password"
                  autocomplete="current-password"
                  :disabled="loginLoading"
                  required
                  :placeholder="t('auth.passwordEnter')"
                  :aria-invalid="loginErrorField === 'password' ? 'true' : 'false'"
                  :aria-describedby="loginErrorField === 'password' ? 'login-error' : undefined"
                />
                <button
                  type="button"
                  class="auth-text-button auth-forgot"
                  :disabled="loginLoading"
                  @click="onForgotPassword"
                >
                  {{ t('auth.forgotPassword') }}
                </button>
              </div>
              <p
                v-if="loginEmailError"
                id="login-error"
                class="auth-notice"
                :class="`auth-notice--${loginNoticeTone}`"
                role="alert"
              >
                <i
                  class="pi auth-notice__icon"
                  :class="loginNoticeTone === 'info' ? 'pi-info-circle' : 'pi-exclamation-circle'"
                  aria-hidden="true"
                />
                <span>{{ loginEmailError }}</span>
              </p>
              <Button
                type="submit"
                class="auth-submit"
                rounded
                :label="loginStep === 1 ? t('auth.continue') : t('auth.signIn')"
                :loading="loginLoading"
                :disabled="loginLoading"
              />
            </form>

            <p class="auth-helper">
              {{ t('auth.noAccountPrompt') }}
              <RouterLink class="auth-link" :to="{ name: AppRouteNames.REGISTER }">
                {{ t('auth.createAdminAccountLink') }}
              </RouterLink>
            </p>
          </section>

          <!-- Resident sign-in: Google or email + password -->
          <section v-else-if="isResidentLogin" class="auth-card">
            <h1 class="auth-title">{{ t('auth.residentLoginTitle') }}</h1>
            <p class="auth-subtitle">{{ t('auth.residentLoginSubtitle') }}</p>
            <div class="auth-form" :aria-label="t('auth.residentLoginAria')">
              <p
                v-if="loginEmailError"
                id="login-error"
                class="auth-notice"
                :class="`auth-notice--${loginNoticeTone}`"
                role="alert"
              >
                <i
                  class="pi auth-notice__icon"
                  :class="loginNoticeTone === 'info' ? 'pi-info-circle' : 'pi-exclamation-circle'"
                  aria-hidden="true"
                />
                <span>{{ loginEmailError }}</span>
              </p>
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
                class="auth-form"
                :aria-label="t('auth.residentPasswordLoginAria')"
                novalidate
                @submit.prevent="onResidentPasswordLogin"
              >
                <div class="auth-field">
                  <label class="auth-label" for="res-email">{{ t('auth.email') }}</label>
                  <input
                    id="res-email"
                    v-model="loginEmail"
                    class="auth-input"
                    type="email"
                    name="email"
                    autocomplete="email"
                    :disabled="loginLoading"
                    required
                    :placeholder="t('auth.emailExample')"
                    :aria-invalid="loginErrorField === 'email' ? 'true' : 'false'"
                    :aria-describedby="loginErrorField === 'email' ? 'login-error' : undefined"
                  />
                </div>
                <div class="auth-field">
                  <label class="auth-label" for="res-password">{{ t('auth.password') }}</label>
                  <input
                    id="res-password"
                    v-model="loginPassword"
                    class="auth-input"
                    type="password"
                    name="password"
                    autocomplete="current-password"
                    :disabled="loginLoading"
                    required
                    :placeholder="t('auth.passwordEnter')"
                    :aria-invalid="loginErrorField === 'password' ? 'true' : 'false'"
                    :aria-describedby="loginErrorField === 'password' ? 'login-error' : undefined"
                  />
                  <button
                    type="button"
                    class="auth-text-button auth-forgot"
                    :disabled="loginLoading"
                    @click="onForgotPassword"
                  >
                    {{ t('auth.forgotPassword') }}
                  </button>
                </div>
                <Button
                  type="submit"
                  class="auth-submit"
                  rounded
                  :label="t('auth.signIn')"
                  :loading="loginLoading"
                  :disabled="loginLoading"
                />
              </form>
            </div>

            <p class="auth-helper auth-helper--muted">
              <i class="pi pi-envelope" aria-hidden="true" />
              {{ t('auth.residentInviteHelp') }}
            </p>
          </section>

          <!-- Admin registration (7 fields) -->
          <section v-else class="auth-card">
            <h1 class="auth-title">{{ t('auth.registerTitle') }}</h1>
            <p class="auth-subtitle">{{ t('auth.registerFirebaseHint') }}</p>

            <form class="auth-form" :aria-label="t('auth.ariaRegister')" novalidate @submit.prevent="onRegisterSubmit">
              <fieldset class="auth-kind">
                <legend class="auth-label">{{ t('auth.accountKindLabel') }}</legend>
                <div class="auth-kind__options">
                  <label
                    v-for="kind in ['administrator', 'board']"
                    :key="kind"
                    class="auth-kind__option"
                    :class="{ 'is-selected': regAccountKind === kind }"
                  >
                    <input v-model="regAccountKind" type="radio" name="reg-account-kind" :value="kind" />
                    <span class="auth-kind__title">{{ t(`auth.accountKind.${kind}.title`) }}</span>
                    <span class="auth-kind__hint">{{ t(`auth.accountKind.${kind}.hint`) }}</span>
                  </label>
                </div>
              </fieldset>
              <div class="auth-grid">
                <div class="auth-field">
                  <label class="auth-label" for="reg-name">{{ t('auth.fullName') }}</label>
                  <input
                    id="reg-name"
                    v-model="regName"
                    class="auth-input"
                    type="text"
                    name="name"
                    autocomplete="name"
                    :disabled="registerLoading"
                    required
                    v-bind="regFieldAttrs('name')"
                    @input="clearRegError('name')"
                  />
                  <p v-if="regErrors.name" id="reg-name-error" class="bf-field-error">{{ t(regErrors.name) }}</p>
                </div>
                <div class="auth-field">
                  <label class="auth-label" for="reg-dni">{{ t('auth.dniPlaceholder') }}</label>
                  <input
                    id="reg-dni"
                    v-model="regDni"
                    class="auth-input"
                    type="text"
                    name="dni"
                    autocomplete="off"
                    inputmode="numeric"
                    :disabled="registerLoading"
                    required
                    v-bind="regFieldAttrs('dni')"
                    @input="clearRegError('dni')"
                  />
                  <p v-if="regErrors.dni" id="reg-dni-error" class="bf-field-error">{{ t(regErrors.dni) }}</p>
                </div>
                <div class="auth-field">
                  <label class="auth-label" for="reg-email">{{ t('auth.email') }}</label>
                  <input
                    id="reg-email"
                    v-model="regEmail"
                    class="auth-input"
                    type="email"
                    name="email"
                    autocomplete="email"
                    :disabled="registerLoading"
                    required
                    :placeholder="t('auth.emailExample')"
                    v-bind="regFieldAttrs('email')"
                    @input="clearRegError('email')"
                  />
                  <p v-if="regErrors.email" id="reg-email-error" class="bf-field-error">{{ t(regErrors.email) }}</p>
                </div>
                <div class="auth-field">
                  <label class="auth-label" for="reg-password">{{ t('auth.password') }}</label>
                  <input
                    id="reg-password"
                    v-model="regPassword"
                    class="auth-input"
                    type="password"
                    name="password"
                    autocomplete="new-password"
                    :disabled="registerLoading"
                    required
                    :placeholder="t('auth.passwordMinHint')"
                    v-bind="regFieldAttrs('password')"
                    @input="clearRegError('password')"
                  />
                  <p v-if="regErrors.password" id="reg-password-error" class="bf-field-error">{{ t(regErrors.password) }}</p>
                </div>
                <div class="auth-field">
                  <label class="auth-label" for="reg-company">{{ t('auth.companyPlaceholder') }}</label>
                  <input
                    id="reg-company"
                    v-model="regCompany"
                    class="auth-input"
                    type="text"
                    name="company"
                    autocomplete="organization"
                    :disabled="registerLoading"
                    required
                    v-bind="regFieldAttrs('company')"
                    @input="clearRegError('company')"
                  />
                  <p v-if="regErrors.company" id="reg-company-error" class="bf-field-error">{{ t(regErrors.company) }}</p>
                </div>
                <div class="auth-field">
                  <label class="auth-label" for="reg-ruc">{{ t('auth.rucPlaceholder') }}</label>
                  <input
                    id="reg-ruc"
                    v-model="regRuc"
                    class="auth-input"
                    type="text"
                    name="ruc"
                    autocomplete="off"
                    inputmode="numeric"
                    :disabled="registerLoading"
                    required
                    v-bind="regFieldAttrs('ruc')"
                    @input="clearRegError('ruc')"
                  />
                  <p v-if="regErrors.ruc" id="reg-ruc-error" class="bf-field-error">{{ t(regErrors.ruc) }}</p>
                </div>
                <div class="auth-field auth-field--full">
                  <label class="auth-label" for="reg-address">{{ t('auth.addressPlaceholder') }}</label>
                  <input
                    id="reg-address"
                    v-model="regAddress"
                    class="auth-input"
                    type="text"
                    name="address"
                    autocomplete="street-address"
                    :disabled="registerLoading"
                    required
                    v-bind="regFieldAttrs('address')"
                    @input="clearRegError('address')"
                  />
                  <p v-if="regErrors.address" id="reg-address-error" class="bf-field-error">{{ t(regErrors.address) }}</p>
                </div>
              </div>
              <p v-if="registerError" class="auth-notice auth-notice--error" role="alert">
                <i class="pi pi-exclamation-circle auth-notice__icon" aria-hidden="true" />
                <span>{{ registerError }}</span>
              </p>
              <Button
                type="submit"
                class="auth-submit"
                rounded
                :label="t('auth.createAccount')"
                :loading="registerLoading"
                :disabled="registerLoading"
              />
            </form>

            <p class="auth-helper">
              {{ t('auth.haveAccountPrompt') }}
              <RouterLink class="auth-link" :to="{ name: AppRouteNames.LOGIN }">
                {{ t('auth.signInLink') }}
              </RouterLink>
            </p>
          </section>
        </div>
      </main>
    </div>

    <!-- Brand panel (desktop only; after <main> in DOM so keyboard / SR users reach the form first) -->
    <aside class="auth-aside" :aria-label="t('auth.heroAria')">
      <span class="auth-badge">
        <img
          src="/logo-buildingfex.png"
          :alt="t('brand')"
          class="auth-badge__logo"
          width="904"
          height="276"
          decoding="async"
        />
      </span>
      <div class="auth-aside__body">
        <p class="auth-aside__title">{{ t('auth.heroTitle') }}</p>
        <p class="auth-aside__sub">{{ t('auth.heroSubtitle') }}</p>
        <ul class="auth-benefits" role="list">
          <li v-for="benefit in heroBenefits" :key="benefit.key" class="auth-benefits__item">
            <span class="auth-benefits__icon" aria-hidden="true"><i :class="benefit.icon" /></span>
            <span>{{ t(benefit.key) }}</span>
          </li>
        </ul>
      </div>
      <div class="auth-aside__art">
        <DashboardHeroArt />
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* ---------- Shell: form panel (right) + navy brand panel (left, desktop) ---------- */
.auth-page {
  --auth-navy: #1e3a8a;
  --auth-navy-hover: #172554;
  --auth-ink: #0f172a;
  --auth-muted: #64748b;
  --auth-line: rgba(15, 23, 42, 0.07);
  --auth-field-line: rgba(15, 23, 42, 0.16);

  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  background: #f5f7fb;
  color: var(--auth-ink);
  font-family: var(--bf-font-body, var(--apple-font, system-ui, sans-serif));
  -webkit-font-smoothing: antialiased;
}

.auth-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* Mobile: compact navy strip with the logo badge + language switch. */
.auth-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: calc(env(safe-area-inset-top, 0px) + 0.85rem) 1rem 2.6rem;
  background: var(--auth-navy);
}

.auth-locale {
  display: inline-flex;
  padding: 0.12rem;
  border-radius: 999px;
  background: #fff;
}

.auth-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.45rem 0.8rem;
  border-radius: 14px;
  background: #fff;
}

.auth-badge--sm {
  padding: 0.3rem 0.6rem;
  border-radius: 12px;
}

.auth-badge__logo {
  display: block;
  height: 34px;
  width: auto;
}

.auth-badge--sm .auth-badge__logo {
  height: 26px;
}

.auth-main {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 0 1rem 2.5rem;
  margin-top: -1.75rem;
}

.auth-main:focus {
  outline: none;
}

/* The white form card: role pills (when shown) + the active screen. */
.auth-shell {
  width: 100%;
  max-width: 460px;
  padding: 1.25rem 1.25rem 1.5rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid var(--auth-line);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.auth-shell--wide {
  max-width: 620px;
}

/* ---------- Brand panel ---------- */
.auth-aside {
  display: none;
}

/* ---------- Role pills ---------- */
.auth-roles {
  display: grid;
  margin: 0 0 1.35rem;
  grid-template-columns: 1fr 1fr;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.06);
}

.auth-role {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-height: 2.5rem;
  padding: 0.4rem 0.75rem;
  border-radius: 999px;
  color: #64748b;
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
  transition: color 0.28s ease;
}

.auth-role .pi {
  font-size: 0.85rem;
}

.auth-role:hover:not(.auth-role--active) {
  color: #0f172a;
}

.auth-role--active {
  color: #0f172a;
}

.auth-role:focus-visible,
.auth-link:focus-visible,
.auth-google:focus-visible {
  outline: 2px solid var(--auth-navy);
  outline-offset: 2px;
}

.auth-card {
  text-align: left;
}

/* ---------- Card content ---------- */
.auth-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0 0 0.85rem;
  padding: 0.28rem 0.7rem;
  border-radius: 999px;
  background: #e8eefc;
  color: var(--auth-navy);
  font-size: 0.75rem;
  font-weight: 600;
}

.auth-eyebrow .pi {
  font-size: 0.75rem;
}

.auth-title {
  margin: 0 0 0.4rem;
  font-family: var(--bf-font-heading, inherit);
  font-size: 1.45rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
  color: var(--auth-ink);
}

.auth-subtitle {
  margin: 0 0 1.35rem;
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--auth-muted);
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.auth-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.9rem;
}

.auth-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.auth-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: #334155;
}

.auth-kind {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}

.auth-kind .auth-label {
  display: block;
  margin-bottom: 0.4rem;
}

.auth-kind__options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 0.6rem;
}

.auth-kind__option {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.75rem 0.9rem;
  background: #fff;
  border: 1px solid var(--auth-field-line);
  border-radius: 12px;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.auth-kind__option input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.auth-kind__option.is-selected {
  border-color: var(--auth-navy);
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.12);
}

.auth-kind__option:has(input:focus-visible) {
  outline: 2px solid var(--auth-navy);
  outline-offset: 2px;
}

.auth-kind__title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--auth-ink);
}

.auth-kind__hint {
  font-size: 0.78rem;
  color: var(--auth-muted);
  line-height: 1.35;
}

.auth-label__opt {
  font-weight: 500;
  color: var(--auth-muted);
}

.auth-field .bf-field-error {
  margin-top: 0;
}

.auth-field--step2 {
  animation: auth-field-in 0.3s ease both;
}

@keyframes auth-field-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.auth-input {
  width: 100%;
  min-height: 2.75rem;
  padding: 0.65rem 0.9rem;
  font: inherit;
  font-size: 0.95rem;
  color: var(--auth-ink);
  background: #fff;
  border: 1px solid var(--auth-field-line);
  border-radius: 12px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.auth-input::placeholder {
  color: #94a3b8;
}

.auth-input:focus {
  outline: none;
  border-color: var(--auth-navy);
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.14);
}

.auth-input:disabled {
  background: #f8fafc;
  cursor: not-allowed;
}

.auth-hint {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: var(--auth-muted);
}

/* Inline notices (soft solid tints) */
.auth-text-button {
  align-self: center;
  padding: 0.2rem 0.35rem;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--auth-navy);
  font: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

.auth-text-button:hover:not(:disabled) {
  text-decoration: underline;
}

.auth-text-button:focus-visible {
  outline: 2px solid var(--auth-navy);
  outline-offset: 2px;
}

.auth-text-button:disabled {
  opacity: 0.6;
  cursor: default;
}

.auth-forgot {
  align-self: flex-end;
  margin-top: 0.15rem;
}

.auth-notice {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  margin: 0;
  padding: 0.7rem 0.85rem;
  border-radius: 12px;
  font-size: 0.8125rem;
  line-height: 1.45;
  font-weight: 500;
}

.auth-notice__icon {
  flex-shrink: 0;
  margin-top: 0.12rem;
  font-size: 0.875rem;
}

.auth-notice--error {
  background: #fde4e4;
  color: #9f1c1c;
}

.auth-notice--info {
  background: #e8eefc;
  color: var(--auth-navy);
}

/* Primary pill (PrimeVue Button keeps its loading state) */
.auth-submit.p-button {
  width: 100%;
  min-height: 2.5rem;
  margin-top: 0.25rem;
  justify-content: center;
  border: 1px solid var(--auth-navy);
  border-radius: 999px;
  background: var(--auth-navy);
  color: #fff;
  font-weight: 600;
}

.auth-submit.p-button:not(:disabled):hover {
  border-color: var(--auth-navy-hover);
  background: var(--auth-navy-hover);
  color: #fff;
}

.auth-submit.p-button:focus-visible {
  outline: 2px solid var(--auth-navy);
  outline-offset: 2px;
  box-shadow: none;
}

.auth-submit :deep(.p-button-label) {
  font-weight: 600;
}

/* Secondary pill: Google */
.auth-google {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  width: 100%;
  min-height: 2.85rem;
  padding: 0.55rem 1rem;
  border: 1px solid var(--auth-field-line);
  border-radius: 999px;
  background: #fff;
  color: var(--auth-ink);
  font: inherit;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.auth-google:hover:not(:disabled) {
  background: #f5f7fb;
  border-color: rgba(15, 23, 42, 0.24);
}

.auth-google:disabled {
  opacity: 0.6;
  cursor: progress;
}

.auth-google__icon {
  display: inline-flex;
}

.auth-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0.1rem 0;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--auth-muted);
  text-align: center;
}

.auth-divider::before,
.auth-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--auth-line);
}

.auth-helper {
  margin: 1.25rem 0 0;
  padding-top: 1.1rem;
  border-top: 1px solid var(--auth-line);
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--auth-muted);
  text-align: center;
}

.auth-helper--muted .pi {
  margin-right: 0.3rem;
  font-size: 0.8rem;
  vertical-align: -0.05em;
}

.auth-link {
  color: var(--auth-navy);
  font-weight: 600;
  text-decoration: none;
  border-radius: 4px;
}

.auth-link:hover {
  text-decoration: underline;
}

/* Invite details */
.auth-invite {
  margin: 0 0 1.25rem;
  padding: 0.35rem 1rem;
  border-radius: 14px;
  background: #e8eefc;
}

.auth-invite__row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  padding: 0.6rem 0;
}

.auth-invite__row + .auth-invite__row {
  border-top: 1px solid rgba(30, 58, 138, 0.12);
}

.auth-invite dt {
  font-size: 0.8125rem;
  color: #475569;
}

.auth-invite dd {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--auth-ink);
  text-align: right;
  overflow-wrap: anywhere;
}

/* ---------- ≥ 600px: roomier card, 2-column register grid ---------- */
@media (min-width: 600px) {
  .auth-shell {
    padding: 1.75rem 2rem 2rem;
  }

  .auth-title {
    font-size: 1.6rem;
  }

  .auth-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.9rem 1rem;
  }

  .auth-field--full {
    grid-column: 1 / -1;
  }
}

/* ---------- ≥ 960px: split layout ---------- */
@media (min-width: 960px) {
  .auth-page {
    grid-template-columns: clamp(400px, 40vw, 560px) minmax(0, 1fr);
  }

  .auth-aside {
    grid-column: 1;
    grid-row: 1;
    position: sticky;
    top: 0;
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    gap: 2rem;
    padding: 2.25rem 2.75rem 0;
    overflow: hidden;
    background: var(--auth-navy);
    color: #fff;
  }

  .auth-aside .auth-badge {
    align-self: flex-start;
  }

  .auth-aside__body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    max-width: 26rem;
  }

  .auth-aside__title {
    margin: 0 0 0.75rem;
    font-family: var(--bf-font-heading, inherit);
    font-size: clamp(1.9rem, 2.6vw, 2.4rem);
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.15;
    color: #fff;
  }

  .auth-aside__sub {
    margin: 0 0 1.75rem;
    font-size: 0.975rem;
    line-height: 1.55;
    color: rgba(255, 255, 255, 0.78);
  }

  .auth-benefits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .auth-benefits__item {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    font-size: 0.95rem;
    font-weight: 500;
    color: #fff;
  }

  .auth-benefits__icon {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    background: #fff;
    color: var(--auth-navy);
  }

  .auth-benefits__icon .pi {
    font-size: 0.95rem;
  }

  .auth-aside__art {
    width: 100%;
    max-width: 440px;
    aspect-ratio: 320 / 176;
    margin: 0 auto;
  }

  .auth-panel {
    grid-column: 2;
    grid-row: 1;
  }

  .auth-topbar {
    justify-content: flex-end;
    padding: 1.25rem 1.5rem 0;
    background: transparent;
  }

  .auth-topbar__brand {
    display: none;
  }

  .auth-locale {
    padding: 0;
    background: transparent;
  }

  .auth-main {
    align-items: center;
    margin-top: 0;
    padding: 1.5rem 2rem 3rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .auth-field--step2 {
    animation: none;
  }
}
</style>
