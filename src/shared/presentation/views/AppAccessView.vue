<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { membersApi } from '@/iam/infrastructure/membersApi.js'
import { useSession } from '@/iam/application/sessionStore.js'
import { AppPaths } from '@/shared/domain/appRoutes.js'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'

/**
 * Junta y accesos: quién gestiona el condominio activo.
 * - Si la cuenta la creó la junta, la junta asigna aquí a su administrador (persona o empresa).
 * - Si la cuenta es de una empresa administradora, la empresa invita aquí a la junta para que vea los datos.
 * Cada invitación es un enlace de un solo uso, ligado a un correo y válido 7 días.
 */
const { t, locale } = useI18n()
const { state: session } = useSession()

const isLoading = ref(true)
const loadFailed = ref(false)
const data = ref({ owner: null, myRole: null, canManage: false, members: [], invitations: [] })

const form = ref({ email: '', name: '', role: 'board' })
const formError = ref('')
const sending = ref(false)
const lastLink = ref('')
const copied = ref(false)
const busyId = ref('')

const activeBuilding = computed(
  () => (session.buildings ?? []).find((b) => String(b.ownerAdminId) === String(session.activeBuildingId)) ?? null,
)
/** Quién creó la cuenta decide a quién se invita primero (sugerencia del rol en el formulario). */
const ownerIsBoard = computed(() => data.value.owner?.accountKind === 'board')

const ERROR_KEYS = {
  INVALID_EMAIL: 'access.errorEmail',
  INVALID_MEMBER_ROLE: 'access.errorRole',
  ALREADY_MEMBER: 'access.errorAlreadyMember',
  EMAIL_USED_BY_RESIDENT: 'access.errorResident',
  MANAGE_REQUIRED: 'access.errorManage',
  BOARD_READ_ONLY: 'access.errorManage',
}

function inviteLink(token) {
  if (!token || typeof window === 'undefined') return ''
  return `${window.location.origin}${AppPaths.MEMBER_INVITE.replace(':token', token)}`
}

function roleLabel(role) {
  return role === 'admin' ? t('access.roleAdmin') : t('access.roleBoard')
}

function expiresLabel(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(locale.value === 'es' ? 'es-PE' : 'en-US', { day: 'numeric', month: 'short' }).format(d)
}

async function load() {
  isLoading.value = true
  loadFailed.value = false
  try {
    data.value = await membersApi.list()
    if (data.value.owner?.accountKind === 'board' && !data.value.members.some((m) => m.role === 'admin')) {
      form.value.role = 'admin'
    }
  } catch {
    loadFailed.value = true
  } finally {
    isLoading.value = false
  }
}

async function onInvite() {
  if (sending.value) return
  formError.value = ''
  copied.value = false
  const email = form.value.email.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    formError.value = t('access.errorEmail')
    return
  }
  sending.value = true
  try {
    const created = await membersApi.invite({ email, name: form.value.name.trim() || null, role: form.value.role })
    lastLink.value = inviteLink(created?.token)
    form.value = { email: '', name: '', role: form.value.role }
    await load()
  } catch (error) {
    formError.value = t(ERROR_KEYS[error?.code] ?? 'access.errorGeneric')
  } finally {
    sending.value = false
  }
}

async function copy(link) {
  try {
    await navigator.clipboard.writeText(link)
    copied.value = true
  } catch {
    copied.value = false
  }
}

async function revoke(invitation) {
  busyId.value = invitation.id
  try {
    await membersApi.revokeInvitation(invitation.id)
    await load()
  } finally {
    busyId.value = ''
  }
}

async function removeMember(member) {
  if (!window.confirm(t('access.removeConfirm', { name: member.name }))) return
  busyId.value = member.id
  try {
    await membersApi.remove(member.id)
    await load()
  } finally {
    busyId.value = ''
  }
}

onMounted(load)
</script>

<template>
  <div class="app-view access">
    <header class="access-head">
      <p class="access-eyebrow">{{ activeBuilding?.name }}</p>
      <h1 class="access-title">{{ t('access.title') }}</h1>
      <p class="access-lead">{{ ownerIsBoard ? t('access.leadBoardAccount') : t('access.leadAdminAccount') }}</p>
    </header>

    <LoadErrorRetry v-if="!isLoading && loadFailed" :loading="isLoading" @retry="load" />

    <div class="access-grid">
      <section class="access-card" aria-labelledby="access-people">
        <h2 id="access-people" class="access-card__title">{{ t('access.peopleTitle') }}</h2>
        <ul class="access-list" role="list">
          <li v-if="data.owner" class="access-row">
            <span class="access-avatar" aria-hidden="true">{{ String(data.owner.name ?? '?').slice(0, 1).toUpperCase() }}</span>
            <div class="access-row__main">
              <strong>{{ data.owner.name }}</strong>
              <span>{{ data.owner.email }}</span>
            </div>
            <span class="access-chip access-chip--navy">
              {{ ownerIsBoard ? t('access.ownerBoard') : t('access.ownerAdministrator') }}
            </span>
          </li>
          <li v-for="m in data.members" :key="m.id" class="access-row">
            <span class="access-avatar" aria-hidden="true">{{ String(m.name ?? '?').slice(0, 1).toUpperCase() }}</span>
            <div class="access-row__main">
              <strong>{{ m.name }}</strong>
              <span>{{ m.email }}</span>
            </div>
            <span class="access-chip" :class="m.role === 'admin' ? 'access-chip--green' : ''">{{ roleLabel(m.role) }}</span>
            <button
              v-if="data.canManage"
              type="button"
              class="access-icon-btn"
              :disabled="busyId === m.id"
              :aria-label="t('access.remove', { name: m.name })"
              @click="removeMember(m)"
            >
              <i class="pi pi-times" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p v-if="!isLoading && !data.members.length" class="access-empty">
          {{ ownerIsBoard ? t('access.emptyBoardAccount') : t('access.emptyAdminAccount') }}
        </p>

        <template v-if="data.invitations.length">
          <h3 class="access-subtitle">{{ t('access.pendingTitle') }}</h3>
          <ul class="access-list" role="list">
            <li v-for="inv in data.invitations" :key="inv.id" class="access-row">
              <span class="access-avatar access-avatar--pending" aria-hidden="true"><i class="pi pi-envelope" /></span>
              <div class="access-row__main">
                <strong>{{ inv.name || inv.email }}</strong>
                <span>
                  {{ roleLabel(inv.role) }} ·
                  {{ inv.status === 'expired' ? t('access.expired') : t('access.expires', { date: expiresLabel(inv.expiresAt) }) }}
                </span>
              </div>
              <button
                v-if="inv.token"
                type="button"
                class="access-link-btn"
                @click="copy(inviteLink(inv.token))"
              >
                <i class="pi pi-copy" aria-hidden="true" />
                <span>{{ t('access.copyLink') }}</span>
              </button>
              <button
                v-if="data.canManage"
                type="button"
                class="access-icon-btn"
                :disabled="busyId === inv.id"
                :aria-label="t('access.revoke', { email: inv.email })"
                @click="revoke(inv)"
              >
                <i class="pi pi-times" aria-hidden="true" />
              </button>
            </li>
          </ul>
        </template>
      </section>

      <section v-if="data.canManage" class="access-card" aria-labelledby="access-invite">
        <h2 id="access-invite" class="access-card__title">{{ t('access.inviteTitle') }}</h2>
        <p class="access-card__hint">{{ t('access.inviteHint') }}</p>
        <form class="access-form" novalidate @submit.prevent="onInvite">
          <fieldset class="access-roles">
            <legend class="access-label">{{ t('access.roleLabel') }}</legend>
            <label class="access-role" :class="{ 'is-selected': form.role === 'admin' }">
              <input v-model="form.role" type="radio" name="member-role" value="admin" />
              <strong>{{ t('access.roleAdmin') }}</strong>
              <span>{{ t('access.roleAdminHint') }}</span>
            </label>
            <label class="access-role" :class="{ 'is-selected': form.role === 'board' }">
              <input v-model="form.role" type="radio" name="member-role" value="board" />
              <strong>{{ t('access.roleBoard') }}</strong>
              <span>{{ t('access.roleBoardHint') }}</span>
            </label>
          </fieldset>
          <div class="access-field">
            <label class="access-label" for="member-email">{{ t('access.email') }}</label>
            <input
              id="member-email"
              v-model="form.email"
              class="access-input"
              type="email"
              autocomplete="off"
              :aria-invalid="formError ? 'true' : 'false'"
              :aria-describedby="formError ? 'member-form-error' : undefined"
            />
          </div>
          <div class="access-field">
            <label class="access-label" for="member-name">
              {{ t('access.name') }} <span class="access-label__opt">{{ t('access.optional') }}</span>
            </label>
            <input id="member-name" v-model="form.name" class="access-input" type="text" autocomplete="off" />
          </div>
          <p v-if="formError" id="member-form-error" class="access-error" role="alert">{{ formError }}</p>
          <button type="submit" class="access-submit" :disabled="sending">
            <i class="pi pi-send" aria-hidden="true" />
            <span>{{ sending ? t('access.sending') : t('access.send') }}</span>
          </button>
        </form>

        <div v-if="lastLink" class="access-result" role="status">
          <p>{{ t('access.linkReady') }}</p>
          <div class="access-result__row">
            <input class="access-input" :value="lastLink" readonly :aria-label="t('access.linkLabel')" @focus="$event.target.select()" />
            <button type="button" class="access-link-btn" @click="copy(lastLink)">
              <i :class="copied ? 'pi pi-check' : 'pi pi-copy'" aria-hidden="true" />
              <span>{{ copied ? t('access.copied') : t('access.copyLink') }}</span>
            </button>
          </div>
        </div>
      </section>

      <section v-else-if="!isLoading" class="access-card access-card--note" aria-labelledby="access-readonly">
        <h2 id="access-readonly" class="access-card__title">{{ t('access.readOnlyTitle') }}</h2>
        <p class="access-card__hint">{{ t('access.readOnlyHint') }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.app-view {
  padding: 1.5rem 1.5rem 2.5rem;
  max-width: 72rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.access-eyebrow {
  margin: 0 0 0.25rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: #1e3a8a;
}

.access-title {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: #0f172a;
}

.access-lead {
  margin: 0.35rem 0 0;
  max-width: 46rem;
  font-size: 0.9rem;
  color: #475569;
}

.access-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: 0.9rem;
  align-items: start;
}

.access-card {
  padding: 1.2rem 1.25rem 1.3rem;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.07);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  min-width: 0;
}

.access-card--note {
  background: #f8fafc;
}

.access-card__title {
  margin: 0 0 0.75rem;
  font-size: 1rem;
  font-weight: 650;
  color: #0f172a;
}

.access-card__hint {
  margin: -0.45rem 0 0.9rem;
  font-size: 0.8rem;
  color: #64748b;
}

.access-subtitle {
  margin: 1.1rem 0 0.4rem;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #64748b;
}

.access-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.access-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.6rem 0;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}

.access-row:first-child {
  border-top: 0;
}

.access-avatar {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  background: #e8eefc;
  color: #1e3a8a;
  font-size: 0.85rem;
  font-weight: 700;
}

.access-avatar--pending {
  background: #f1f5f9;
  color: #64748b;
}

.access-row__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.access-row__main strong {
  font-size: 0.86rem;
  font-weight: 600;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
}

.access-row__main span {
  font-size: 0.76rem;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
}

.access-chip {
  flex-shrink: 0;
  padding: 0.18rem 0.55rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #334155;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.access-chip--navy {
  background: #e8eefc;
  color: #1e3a8a;
}

.access-chip--green {
  background: #e3f4e8;
  color: #15803d;
}

.access-icon-btn {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 1.9rem;
  height: 1.9rem;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
}

.access-icon-btn:hover {
  background: #fdecee;
  color: #b42318;
}

.access-icon-btn:focus-visible,
.access-link-btn:focus-visible,
.access-submit:focus-visible {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.access-empty {
  margin: 0.4rem 0 0;
  font-size: 0.82rem;
  color: #64748b;
}

.access-form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.access-roles {
  margin: 0;
  padding: 0;
  border: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.55rem;
}

.access-roles legend {
  margin-bottom: 0.4rem;
}

.access-role {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid rgba(15, 23, 42, 0.14);
  border-radius: 12px;
  cursor: pointer;
}

.access-role input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.access-role.is-selected {
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.12);
}

.access-role:has(input:focus-visible) {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.access-role strong {
  font-size: 0.86rem;
  color: #0f172a;
}

.access-role span {
  font-size: 0.75rem;
  line-height: 1.35;
  color: #64748b;
}

.access-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.access-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: #334155;
}

.access-label__opt {
  font-weight: 500;
  color: #94a3b8;
}

.access-input {
  width: 100%;
  min-height: 2.6rem;
  padding: 0.55rem 0.8rem;
  box-sizing: border-box;
  border: 1px solid rgba(15, 23, 42, 0.16);
  border-radius: 12px;
  font: inherit;
  font-size: 0.9rem;
  color: #0f172a;
  background: #fff;
}

.access-input:focus {
  outline: none;
  border-color: #1e3a8a;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.14);
}

.access-error {
  margin: 0;
  font-size: 0.8rem;
  color: #b42318;
}

.access-submit {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-height: 2.5rem;
  padding: 0.45rem 1.1rem;
  border: 0;
  border-radius: 999px;
  background: #1e3a8a;
  color: #fff;
  font: inherit;
  font-size: 0.86rem;
  font-weight: 600;
  cursor: pointer;
}

.access-submit:hover {
  background: #172554;
}

.access-submit:disabled {
  opacity: 0.6;
  cursor: progress;
}

.access-link-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.75rem;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 999px;
  background: #fff;
  color: #1e3a8a;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.access-link-btn:hover {
  background: #eef2ff;
}

.access-result {
  margin-top: 1rem;
  padding: 0.85rem;
  border-radius: 14px;
  background: #f0f5ff;
}

.access-result p {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  color: #1e3a8a;
  font-weight: 600;
}

.access-result__row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

@media (max-width: 900px) {
  .access-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 760px) {
  .app-view {
    padding: 1rem 1rem 2rem;
  }

  .access-roles {
    grid-template-columns: minmax(0, 1fr);
  }

  .access-result__row {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
