<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LocaleSwitch from '@/shared/presentation/components/LocaleSwitch.vue'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import { membersApi } from '@/iam/infrastructure/membersApi.js'
import { createResidentPasswordAccount } from '@/iam/infrastructure/firebaseAuth.js'
import { signInWithGoogle } from '@/iam/infrastructure/googleIdentity.js'
import { signOutFirebase } from '@/iam/infrastructure/firebaseSession.js'
import { OPEN_WIREFRAME_ACCESS } from '@/iam/application/localPreviewAuth.js'
import { setActiveBuilding, useSession } from '@/iam/application/sessionStore.js'
import { loadAccessibleBuildings } from '@/iam/application/buildingWorkspace.js'

/**
 * Enlace de invitación al equipo de gestión de un condominio: un administrador asignado o un miembro de
 * la junta directiva. La persona entra con el correo invitado (contraseña o Google) y queda con acceso
 * a ese edificio con el rol de la invitación.
 */
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { setAdminSession, setBoardSession } = useSession()

const token = computed(() => String(route.params.token ?? ''))
const invitation = ref(null)
const loadError = ref('')
const isLoading = ref(true)

const name = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

const roleLabel = computed(() =>
  invitation.value?.role === 'admin' ? t('memberInvite.roleAdmin') : t('memberInvite.roleBoard'),
)

const ERROR_KEYS = {
  INVITATION_NOT_FOUND: 'memberInvite.errorNotFound',
  INVITATION_ALREADY_USED: 'memberInvite.errorUsed',
  INVITATION_EXPIRED: 'memberInvite.errorExpired',
  INVITATION_EMAIL_MISMATCH: 'memberInvite.errorEmailMismatch',
  RESIDENT_ACCOUNT: 'memberInvite.errorResident',
  ALREADY_OWNER: 'memberInvite.errorOwner',
  PASSWORD_TOO_SHORT: 'auth.passwordTooShort',
  EMAIL_ALREADY_EXISTS: 'memberInvite.errorWrongPassword',
  TOO_MANY_REQUESTS: 'auth.tooManyRequests',
  NETWORK_ERROR: 'auth.apiUnavailable',
  GOOGLE_CANCELLED: 'auth.inviteGoogleCancelled',
}

function messageFor(e) {
  return t(ERROR_KEYS[e?.code] ?? 'memberInvite.errorGeneric')
}

onMounted(async () => {
  try {
    invitation.value = await membersApi.getInvitation(token.value)
    name.value = invitation.value?.name ?? ''
  } catch (e) {
    loadError.value = messageFor(e)
  } finally {
    isLoading.value = false
  }
})

async function enter(idToken) {
  const result = await membersApi.acceptInvitation(token.value, { name: name.value.trim() || null }, idToken)
  // Demo / wireframes: la API simulada devuelve su propio token de vista previa.
  const sessionToken = result?.token ?? idToken
  const profile = { id: result.user.id, name: result.user.name, email: result.user.email }
  if (result.user.role === 'board_member') setBoardSession(profile, sessionToken)
  else setAdminSession(profile, sessionToken)
  await loadAccessibleBuildings(sessionToken)
  if (result.ownerAdminId) setActiveBuilding(result.ownerAdminId)
  router.push({ name: result.role === 'admin' ? AppRouteNames.APP_DASHBOARD : AppRouteNames.APP_BOARD })
}

async function onPasswordSubmit() {
  if (busy.value) return
  error.value = ''
  if (!OPEN_WIREFRAME_ACCESS && password.value.length < 6) {
    error.value = t('auth.passwordTooShort')
    return
  }
  busy.value = true
  try {
    const account = OPEN_WIREFRAME_ACCESS
      ? { token: null }
      : await createResidentPasswordAccount({ email: invitation.value.email, password: password.value, name: name.value })
    await enter(account.token)
  } catch (e) {
    error.value = messageFor(e)
    if (!OPEN_WIREFRAME_ACCESS) void signOutFirebase()
  } finally {
    busy.value = false
  }
}

async function onGoogle() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    const google = await signInWithGoogle()
    if (google.email.toLowerCase() !== String(invitation.value.email).toLowerCase()) {
      error.value = t('memberInvite.errorEmailMismatch')
      void signOutFirebase()
      return
    }
    if (!name.value.trim()) name.value = google.name
    await enter(google.idToken)
  } catch (e) {
    error.value = messageFor(e)
    void signOutFirebase()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="minv">
    <header class="minv__bar">
      <img src="/logo-buildingfex.png" :alt="t('brand')" width="132" height="32" decoding="async" />
      <LocaleSwitch />
    </header>

    <main id="main-content" class="minv__main">
      <section class="minv__card" aria-live="polite">
        <p v-if="isLoading" class="minv__muted">{{ t('memberInvite.loading') }}</p>

        <template v-else-if="loadError || !invitation">
          <h1 class="minv__title">{{ t('memberInvite.invalidTitle') }}</h1>
          <p class="minv__muted">{{ loadError }}</p>
        </template>

        <template v-else-if="invitation.status !== 'pending'">
          <h1 class="minv__title">{{ t('memberInvite.invalidTitle') }}</h1>
          <p class="minv__muted">
            {{ invitation.status === 'accepted' ? t('memberInvite.errorUsed') : t('memberInvite.errorExpired') }}
          </p>
          <RouterLink class="minv__link" :to="{ name: AppRouteNames.LOGIN }">{{ t('memberInvite.goLogin') }}</RouterLink>
        </template>

        <template v-else>
          <span class="minv__badge">{{ roleLabel }}</span>
          <h1 class="minv__title">{{ t('memberInvite.title', { building: invitation.buildingName }) }}</h1>
          <p v-if="invitation.buildingAddress" class="minv__muted">{{ invitation.buildingAddress }}</p>
          <p class="minv__lead">
            {{ invitation.role === 'admin' ? t('memberInvite.leadAdmin') : t('memberInvite.leadBoard') }}
          </p>

          <form class="minv__form" novalidate @submit.prevent="onPasswordSubmit">
            <div class="minv__field">
              <label for="minv-email">{{ t('memberInvite.email') }}</label>
              <input id="minv-email" class="minv__input" type="email" :value="invitation.email" readonly />
            </div>
            <div class="minv__field">
              <label for="minv-name">{{ t('memberInvite.name') }}</label>
              <input id="minv-name" v-model="name" class="minv__input" type="text" autocomplete="name" />
            </div>
            <div class="minv__field">
              <label for="minv-password">{{ t('memberInvite.password') }}</label>
              <input
                id="minv-password"
                v-model="password"
                class="minv__input"
                type="password"
                autocomplete="current-password"
                :aria-describedby="'minv-password-hint'"
              />
              <small id="minv-password-hint" class="minv__muted">{{ t('memberInvite.passwordHint') }}</small>
            </div>
            <p v-if="error" class="minv__error" role="alert">{{ error }}</p>
            <button type="submit" class="minv__primary" :disabled="busy">
              {{ busy ? t('memberInvite.entering') : t('memberInvite.accept') }}
            </button>
          </form>

          <div class="minv__divider" role="presentation"><span>{{ t('memberInvite.or') }}</span></div>
          <button type="button" class="minv__google" :disabled="busy" @click="onGoogle">
            <i class="pi pi-google" aria-hidden="true" />
            <span>{{ t('memberInvite.google') }}</span>
          </button>
          <p class="minv__muted minv__foot">{{ t('memberInvite.expires') }}</p>
        </template>
      </section>
    </main>
  </div>
</template>

<style scoped>
.minv {
  min-height: 100vh;
  min-height: 100dvh;
  background: #f5f7fb;
  color: #0f172a;
  font-family: var(--bf-font-body, var(--apple-font, system-ui, sans-serif));
}

.minv__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  background: #1e3a8a;
}

.minv__bar img {
  filter: brightness(0) invert(1);
}

.minv__main {
  display: flex;
  justify-content: center;
  padding: 2rem 1rem 3rem;
}

.minv__card {
  width: 100%;
  max-width: 28rem;
  padding: 1.6rem 1.5rem;
  border-radius: 20px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
}

.minv__badge {
  display: inline-flex;
  padding: 0.2rem 0.65rem;
  border-radius: 999px;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.74rem;
  font-weight: 700;
}

.minv__title {
  margin: 0.6rem 0 0.2rem;
  font-size: 1.35rem;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.minv__lead {
  margin: 0.6rem 0 1.1rem;
  font-size: 0.88rem;
  color: #334155;
}

.minv__muted {
  margin: 0;
  font-size: 0.8rem;
  color: #64748b;
}

.minv__form {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.minv__field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.minv__field label {
  font-size: 0.8rem;
  font-weight: 600;
  color: #334155;
}

.minv__input {
  min-height: 2.7rem;
  padding: 0.6rem 0.85rem;
  box-sizing: border-box;
  border: 1px solid rgba(15, 23, 42, 0.16);
  border-radius: 12px;
  font: inherit;
  font-size: 0.92rem;
}

.minv__input[readonly] {
  background: #f8fafc;
  color: #475569;
}

.minv__input:focus {
  outline: none;
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.14);
}

.minv__error {
  margin: 0;
  font-size: 0.8rem;
  color: #b42318;
}

.minv__primary,
.minv__google {
  min-height: 2.75rem;
  border-radius: 999px;
  font: inherit;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
}

.minv__primary {
  border: 0;
  background: #1e3a8a;
  color: #fff;
}

.minv__primary:hover {
  background: #172554;
}

.minv__google {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  border: 1px solid rgba(15, 23, 42, 0.16);
  background: #fff;
  color: #0f172a;
}

.minv__primary:disabled,
.minv__google:disabled {
  opacity: 0.6;
  cursor: progress;
}

.minv__primary:focus-visible,
.minv__google:focus-visible,
.minv__link:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.minv__divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1rem 0;
  font-size: 0.75rem;
  color: #94a3b8;
}

.minv__divider::before,
.minv__divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: rgba(15, 23, 42, 0.1);
}

.minv__foot {
  margin-top: 1rem;
  text-align: center;
}

.minv__link {
  display: inline-block;
  margin-top: 1rem;
  font-size: 0.86rem;
  font-weight: 600;
  color: #1e3a8a;
}
</style>
